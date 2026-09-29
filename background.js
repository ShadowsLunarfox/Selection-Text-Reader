const READING_MENU_ID = "toggle-reading";
const TERMINAL_TTS_EVENTS = new Set(["end", "interrupted", "cancelled", "error"]);
const BACKGROUND_MESSAGES = {
  en: { startReading: "Start reading", stopReading: "Stop reading" },
  "zh-CN": { startReading: "开始朗读", stopReading: "停止朗读" },
  "zh-TW": { startReading: "開始朗讀", stopReading: "停止朗讀" },
  ja: { startReading: "読み上げ開始", stopReading: "読み上げ停止" },
  ko: { startReading: "읽기 시작", stopReading: "읽기 중지" },
  th: { startReading: "เริ่มอ่าน", stopReading: "หยุดอ่าน" },
  ms: { startReading: "Mula membaca", stopReading: "Henti membaca" }
};
const DEFAULT_SETTINGS = {
  uiLanguage: "en",
  rate: 1, pitch: 1, volume: 1, lang: "zh-CN", voiceName: "", languageVoices: {},
  autoDetectLanguage: true, showSelectionButton: true, translationTarget: "en",
  ocrLanguage: "eng+chi_sim"
};
const LANGUAGE_LOCALES = {
  ar: "ar-SA", de: "de-DE", en: "en-US", es: "es-ES", fr: "fr-FR",
  hi: "hi-IN", id: "id-ID", it: "it-IT", ja: "ja-JP", ko: "ko-KR",
  ms: "ms-MY", nl: "nl-NL", pl: "pl-PL", pt: "pt-BR", ru: "ru-RU",
  th: "th-TH", tr: "tr-TR", vi: "vi-VN", zh: "zh-CN"
};
const reading = {
  active: false, paused: false, chunks: [], index: 0, language: "",
  options: null, session: 0, tabId: null
};
const pendingOcrRequests = new Map();
let creatingOffscreenDocument = null;
let activeOcrPromise = null;
let uiLanguage = "en";

chrome.storage.sync.get({ uiLanguage: "en" }).then((settings) => {
  uiLanguage = normalizeUiLanguage(settings.uiLanguage);
  updateContextMenuTitle();
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await ensureDefaultSettings();
  uiLanguage = normalizeUiLanguage(settings.uiLanguage);
  createContextMenu();
});
chrome.runtime.onStartup.addListener(refreshLanguageAndMenu);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.uiLanguage) {
    uiLanguage = normalizeUiLanguage(changes.uiLanguage.newValue);
    updateContextMenuTitle();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== READING_MENU_ID) return;
  if (reading.active || await chrome.tts.isSpeaking()) {
    stopReading();
    return;
  }
  await speakText(info.selectionText, null, tab?.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "stop-reading") {
    stopReading();
    return;
  }
  if (command === "toggle-pause") {
    togglePause();
    return;
  }
  if (command === "read-selection") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const active = document.activeElement;
          if (
            active &&
            (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
            active.selectionStart !== active.selectionEnd
          ) return active.value.slice(active.selectionStart, active.selectionEnd);
          return window.getSelection()?.toString() || "";
        }
      });
      await speakText(result, null, tab.id);
    } catch {
      // Browser-internal pages do not allow script injection.
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "background" && message.action === "ocr-progress") {
    const request = pendingOcrRequests.get(message.requestId);
    if (request?.tabId) {
      chrome.tabs.sendMessage(request.tabId, {
        action: "ocr-progress",
        status: message.status,
        progress: message.progress
      }).catch(() => {});
    }
    return;
  }
  if (message.target === "background" && message.action === "ocr-result") {
    const request = pendingOcrRequests.get(message.requestId);
    if (request) {
      clearTimeout(request.timeout);
      pendingOcrRequests.delete(message.requestId);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.text || "");
    }
    return;
  }
  if (message.action === "capture-region") {
    runOcrRequest(message, sender)
      .then((text) => sendResponse({ text }))
      .catch((error) => sendResponse({ error: error.message || "OCR failed." }));
    return true;
  }
  if (message.action === "speak-text") {
    speakText(message.text, message.lang, message.tabId || sender.tab?.id)
      .then((started) => sendResponse({ started }));
    return true;
  }
  if (message.action === "stop-reading") {
    stopReading();
    sendResponse({ stopped: true });
    return;
  }
  if (message.action === "toggle-pause") {
    togglePause();
    sendResponse(publicReadingState());
    return;
  }
  if (message.action === "skip-reading") {
    skipReading(Number(message.offset) || 0);
    sendResponse(publicReadingState());
    return;
  }
  if (message.action === "get-reading-state") {
    sendResponse(publicReadingState());
    return;
  }
  if (message.action === "translate-text") {
    translateText(message.text, message.targetLanguage)
      .then((translatedText) => sendResponse({ translatedText }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

async function runOcrRequest(message, sender) {
  if (activeOcrPromise) throw new Error("Text recognition is already running.");
  activeOcrPromise = captureAndRecognizeRegion(message, sender);
  try {
    return await activeOcrPromise;
  } finally {
    activeOcrPromise = null;
  }
}

async function captureAndRecognizeRegion(message, sender) {
  if (!sender.tab?.windowId || !sender.tab?.id) throw new Error("No active tab is available.");
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const imageDataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  chrome.tabs.sendMessage(sender.tab.id, { action: "ocr-captured" }).catch(() => {});
  await ensureOffscreenDocument();

  const requestId = crypto.randomUUID();
  const languages = String(settings.ocrLanguage || "eng+chi_sim")
    .split("+")
    .filter((language) => ["eng", "chi_sim", "chi_tra", "jpn", "kor"].includes(language));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOcrRequests.delete(requestId);
      reject(new Error("OCR timed out. Please try a smaller area."));
    }, 180000);
    pendingOcrRequests.set(requestId, { resolve, reject, timeout, tabId: sender.tab.id });
    chrome.runtime.sendMessage({
      target: "offscreen",
      action: "ocr-recognize",
      requestId,
      imageDataUrl,
      rectangle: message.rectangle,
      viewport: message.viewport,
      languages: languages.length ? languages : ["eng"]
    }).catch((error) => {
      clearTimeout(timeout);
      pendingOcrRequests.delete(requestId);
      reject(error);
    });
  });
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run local OCR on a user-selected screenshot region."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function ensureDefaultSettings() {
  const savedSettings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(savedSettings);
  return savedSettings;
}

async function refreshLanguageAndMenu() {
  const settings = await chrome.storage.sync.get({ uiLanguage: "en" });
  uiLanguage = normalizeUiLanguage(settings.uiLanguage);
  createContextMenu();
}

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: READING_MENU_ID, title: backgroundMessage("startReading"), contexts: ["all"] });
  });
}

async function speakText(rawText, requestedLanguage, tabId) {
  const text = normalizeText(rawText);
  if (!text) return false;

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const language = requestedLanguage || (settings.autoDetectLanguage
    ? await detectSpeechLanguage(text, settings.lang)
    : settings.lang);
  const languageRoot = language.toLowerCase().split("-")[0];
  const preferredVoice = settings.languageVoices?.[languageRoot] || settings.voiceName;
  const voiceName = await getCompatibleVoiceName(preferredVoice, language);

  reading.session += 1;
  chrome.tts.stop();
  reading.active = true;
  reading.paused = false;
  reading.chunks = splitIntoSpeechChunks(text, language);
  reading.index = 0;
  reading.language = language;
  reading.tabId = tabId || null;
  reading.options = {
    lang: language,
    rate: Number(settings.rate),
    pitch: Number(settings.pitch),
    volume: Number(settings.volume),
    requiredEventTypes: ["end"],
    ...(voiceName ? { voiceName } : {})
  };
  updateReadingState();
  speakCurrentChunk(reading.session);
  return true;
}

function speakCurrentChunk(session) {
  if (!reading.active || session !== reading.session) return;
  const chunk = reading.chunks[reading.index];
  if (!chunk) {
    finishReading();
    return;
  }

  updateReadingState();
  chrome.tts.speak(chunk, {
    ...reading.options,
    enqueue: false,
    onEvent: (event) => {
      if (session !== reading.session || !TERMINAL_TTS_EVENTS.has(event.type)) return;
      if (event.type === "end") {
        reading.index += 1;
        speakCurrentChunk(session);
      } else if (reading.active && !reading.paused) {
        finishReading();
      }
    }
  }).catch(() => {
    if (session === reading.session) finishReading();
  });
}

function togglePause() {
  if (!reading.active) return;
  if (reading.paused) {
    chrome.tts.resume();
    reading.paused = false;
  } else {
    chrome.tts.pause();
    reading.paused = true;
  }
  updateReadingState();
}

function skipReading(offset) {
  if (!reading.active || !offset) return;
  reading.session += 1;
  chrome.tts.stop();
  reading.index = Math.max(0, Math.min(reading.chunks.length - 1, reading.index + offset));
  reading.paused = false;
  updateReadingState();
  speakCurrentChunk(reading.session);
}

function stopReading() {
  reading.session += 1;
  chrome.tts.stop();
  reading.active = false;
  reading.paused = false;
  updateReadingState();
}

function finishReading() {
  reading.active = false;
  reading.paused = false;
  reading.index = Math.max(0, reading.chunks.length - 1);
  updateReadingState();
}

function publicReadingState() {
  return {
    active: reading.active, paused: reading.paused, index: reading.index,
    total: reading.chunks.length, currentText: reading.chunks[reading.index] || ""
  };
}

function updateReadingState() {
  chrome.contextMenus.update(
    READING_MENU_ID,
    { title: backgroundMessage(reading.active ? "stopReading" : "startReading") },
    () => void chrome.runtime.lastError
  );
  const message = { action: "reading-state", state: publicReadingState() };
  chrome.runtime.sendMessage(message).catch(() => {});
  if (reading.tabId) chrome.tabs.sendMessage(reading.tabId, message).catch(() => {});
}

function updateContextMenuTitle() {
  chrome.contextMenus.update(
    READING_MENU_ID,
    { title: backgroundMessage(reading.active ? "stopReading" : "startReading") },
    () => void chrome.runtime.lastError
  );
}

function normalizeUiLanguage(language) {
  return Object.hasOwn(BACKGROUND_MESSAGES, language) ? language : "en";
}

function backgroundMessage(key) {
  return BACKGROUND_MESSAGES[uiLanguage][key] || BACKGROUND_MESSAGES.en[key] || key;
}

function splitIntoSpeechChunks(text, language) {
  let sentences;
  try {
    sentences = [...new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)]
      .map((item) => item.segment.trim()).filter(Boolean);
  } catch {
    sentences = text.split(/(?<=[.!?。！？])\s*/u).filter(Boolean);
  }
  return sentences.flatMap((sentence) => splitLongChunk(sentence, 240));
}

function splitLongChunk(text, maximumLength) {
  if (text.length <= maximumLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maximumLength) {
    const candidate = remaining.slice(0, maximumLength + 1);
    const boundary = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf(","), candidate.lastIndexOf("，"));
    const splitAt = boundary > maximumLength * 0.55 ? boundary + 1 : maximumLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function getCompatibleVoiceName(preferredVoiceName, language) {
  if (!preferredVoiceName) return "";
  const voices = await chrome.tts.getVoices();
  const voice = voices.find((item) => item.voiceName === preferredVoiceName);
  if (!voice) return "";
  if (voice.eventTypes && !voice.eventTypes.includes("end")) return "";
  const languageRoot = language.toLowerCase().split("-")[0];
  return !voice.lang || voice.lang.toLowerCase().startsWith(languageRoot) ? voice.voiceName : "";
}

async function translateText(text, targetLanguage) {
  const normalizedText = normalizeText(text);
  if (!normalizedText || !targetLanguage) throw new Error("Text and target language are required.");

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const parameters = new URLSearchParams({ client: "gtx", sl: "auto", tl: targetLanguage, dt: "t", q: normalizedText });
      const response = await fetch(
        `https://translate.googleapis.com/translate_a/single?${parameters.toString()}`,
        { signal: controller.signal }
      );
      if (!response.ok) throw new Error("Translation service is unavailable.");
      const data = await response.json();
      const translatedText = data[0]?.map((segment) => segment[0]).filter(Boolean).join("");
      if (!translatedText) throw new Error("No translation was returned.");
      return translatedText;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError?.name === "AbortError" ? "Translation timed out." : lastError?.message || "Translation failed.");
}

async function detectSpeechLanguage(text, fallbackLanguage) {
  const scriptLanguage = detectScriptLanguage(text);
  if (scriptLanguage) return scriptLanguage;
  try {
    const result = await chrome.i18n.detectLanguage(text);
    const detected = result.languages?.[0];
    if (!result.isReliable || !detected || detected.percentage < 50) return fallbackLanguage;
    const languageCode = detected.language.toLowerCase();
    return LANGUAGE_LOCALES[languageCode] || languageCode || fallbackLanguage;
  } catch {
    return fallbackLanguage;
  }
}

function detectScriptLanguage(text) {
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/[體萬與專業東絲兩嚴喪個豐臨為麗舉麼義烏樂喬習鄉書買亂爭於虧雲亞產畝親億僅從侖倉儀們價眾優會傘偉傳傷倫偽佇佈]/u.test(text)) return "zh-TW";
  return null;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}
