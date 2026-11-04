const READING_MENU_ID = "toggle-reading";
const SITE_BLOCK_MENU_ID = "toggle-site-block";
const TERMINAL_TTS_EVENTS = new Set(["end", "interrupted", "cancelled", "error"]);
const READING_CHECK_INTERVAL = 5000;
const SPEECH_START_GRACE = 30000;
const BACKGROUND_MESSAGES = {
  en: { startReading: "Start reading", stopReading: "Stop reading", blockSite: "Block this site", unblockSite: "Unblock this site" },
  "zh-CN": { startReading: "开始朗读", stopReading: "停止朗读", blockSite: "屏蔽此网站", unblockSite: "解除屏蔽此网站" },
  "zh-TW": { startReading: "開始朗讀", stopReading: "停止朗讀", blockSite: "封鎖此網站", unblockSite: "解除封鎖此網站" },
  ja: { startReading: "読み上げ開始", stopReading: "読み上げ停止", blockSite: "このサイトをブロック", unblockSite: "このサイトのブロックを解除" },
  ko: { startReading: "읽기 시작", stopReading: "읽기 중지", blockSite: "이 사이트 차단", unblockSite: "이 사이트 차단 해제" },
  th: { startReading: "เริ่มอ่าน", stopReading: "หยุดอ่าน", blockSite: "บล็อกเว็บไซต์นี้", unblockSite: "เลิกบล็อกเว็บไซต์นี้" },
  ms: { startReading: "Mula membaca", stopReading: "Henti membaca", blockSite: "Sekat laman ini", unblockSite: "Nyahsekat laman ini" }
};
const DEFAULT_SETTINGS = {
  uiLanguage: "en",
  rate: 1, pitch: 1, volume: 1, lang: "zh-CN", voiceName: "", languageVoices: {},
  autoDetectLanguage: true, showSelectionButton: true, translationTarget: "en",
  enableSingleKeyShortcut: true, disabledSites: [], rememberReading: true, skipCodeBlocks: true,
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
  options: null, session: 0, tabId: null, utterance: null,
  status: "idle", error: "", errorCode: "", text: "", offsets: [], sourceLength: 0, page: null
};
let readingMonitor = null;
let readingMonitorCheck = null;
let bookmarkWrites = Promise.resolve();
let bookmarkSignature = "";
let rememberReading = true;
let pendingSpeechRequest = 0;
let siteMenuRevision = 0;
const pendingOcrRequests = new Map();
let creatingOffscreenDocument = null;
let activeOcrPromise = null;
let uiLanguage = "en";

chrome.storage.sync.get({ uiLanguage: "en" }).then((settings) => {
  uiLanguage = normalizeUiLanguage(settings.uiLanguage);
  updateContextMenuTitle();
  refreshActiveSiteMenu();
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
    refreshActiveSiteMenu();
  }
  if (areaName === "sync" && changes.disabledSites) refreshActiveSiteMenu();
  if (areaName === "sync" && changes.rate && reading.options) {
    const rate = Number(changes.rate.newValue);
    if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) {
      reading.options.rate = rate;
      updateReadingState();
    }
  }
  if (areaName === "sync" && changes.rememberReading) {
    rememberReading = changes.rememberReading.newValue !== false;
    if (!rememberReading) clearReadingBookmarks();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === SITE_BLOCK_MENU_ID) {
    await toggleSiteBlocking(info.pageUrl || tab?.url);
    return;
  }
  if (info.menuItemId !== READING_MENU_ID) return;
  if (reading.active || await chrome.tts.isSpeaking()) {
    stopReading();
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "read-page-selection" });
    if (response?.started) return;
  } catch { /* Fall back when the page has no content script yet. */ }
  await speakText(info.selectionText, null, tab?.id, { page: { url: tab?.url, title: tab?.title, source: "selection" } });
});

chrome.tabs.onActivated.addListener(refreshActiveSiteMenu);
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && (change.url || change.status === "complete")) return refreshActiveSiteMenu();
});
chrome.windows?.onFocusChanged.addListener(refreshActiveSiteMenu);

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
      const response = await chrome.tabs.sendMessage(tab.id, { action: "read-page-selection" });
      if (response?.started || response?.errorCode) return;
    } catch { /* Older tabs can still use the direct selection fallback below. */ }
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
      await speakText(result, null, tab.id, { page: { url: tab.url, title: tab.title, source: "selection" } });
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
    speakText(message.text, message.lang, message.tabId || sender.tab?.id, {
      page: message.page || (sender.tab?.url ? { url: sender.tab.url, title: sender.tab.title, source: "selection" } : null)
    }).then((started) => sendResponse({ started, state: publicReadingState() }))
      .catch((error) => sendResponse({ error: error.message, errorCode: "unableRead" }));
    return true;
  }
  const readingActions = {
    "refresh-site-menu": () => updateSiteMenu(message.url || sender.tab?.url || sender.url),
    "retry-reading": () => restartCurrentReading(),
    "change-reading-voice": () => changeReadingVoice(),
    "set-reading-rate": () => setReadingRate(message.rate),
    "seek-reading": () => seekReading(message.index),
    "get-reading-queue": () => getReadingQueue(message.offset),
    "get-reading-bookmark": () => getReadingBookmark(message.url),
    "resume-reading": () => resumeSavedReading(message.url, message.tabId || sender.tab?.id),
    "forget-reading": () => forgetReadingBookmark(message.url),
    "clear-reading-history": () => clearReadingBookmarks()
  };
  if (Object.hasOwn(readingActions, message.action)) {
    Promise.resolve().then(readingActions[message.action]).then(sendResponse, (error) =>
      sendResponse({ error: error.message, errorCode: error.code || "unableRead" })
    );
    return true;
  }
  if (message.action === "stop-reading") {
    stopReading();
    sendResponse({ ...publicReadingState(), stopped: true });
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
    chrome.contextMenus.create({ id: SITE_BLOCK_MENU_ID, title: backgroundMessage("blockSite"), contexts: ["all"],
      documentUrlPatterns: ["http://*/*", "https://*/*"] });
    refreshActiveSiteMenu();
  });
}

function siteHostname(value) {
  try {
    const text = String(value || "").trim().replace(/^\*\./, "");
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : "";
  } catch { return ""; }
}

function matchesBlockedSite(hostname, rule) {
  const domain = siteHostname(rule);
  return Boolean(domain && (hostname === domain || hostname.endsWith(`.${domain}`)));
}

async function updateSiteMenu(url) {
  const revision = ++siteMenuRevision;
  const hostname = siteHostname(url);
  const { disabledSites = [] } = await chrome.storage.sync.get({ disabledSites: [] });
  const blocked = disabledSites.some((rule) => matchesBlockedSite(hostname, rule));
  if (revision === siteMenuRevision) chrome.contextMenus.update(SITE_BLOCK_MENU_ID, {
    title: backgroundMessage(blocked ? "unblockSite" : "blockSite"), enabled: Boolean(hostname)
  }, () => void chrome.runtime.lastError);
  return { blocked };
}

async function refreshActiveSiteMenu() {
  try {
    const revision = ++siteMenuRevision;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (revision !== siteMenuRevision) return { blocked: false };
    let url = tab?.url;
    // An active tab's URL is not always exposed without the tabs permission.
    if (!url && tab?.id !== undefined) {
      try { url = (await chrome.tabs.sendMessage(tab.id, { action: "get-page-url" }))?.url; }
      catch { /* Restricted pages have no content script. */ }
    }
    if (revision !== siteMenuRevision) return { blocked: false };
    return await updateSiteMenu(url);
  } catch { return { blocked: false }; }
}

async function toggleSiteBlocking(url) {
  const hostname = siteHostname(url);
  if (!hostname) return { blocked: false };
  const { disabledSites = [] } = await chrome.storage.sync.get({ disabledSites: [] });
  const blocked = disabledSites.some((rule) => matchesBlockedSite(hostname, rule));
  const sites = blocked ? disabledSites.filter((rule) => !matchesBlockedSite(hostname, rule)) : [...disabledSites, hostname];
  await chrome.storage.sync.set({ disabledSites: sites });
  await updateSiteMenu(url);
  return { blocked: !blocked };
}

async function speakText(rawText, requestedLanguage, tabId, context = {}) {
  const text = normalizeText(rawText);
  if (!text) return false;
  const request = context.request ?? ++pendingSpeechRequest;

  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  rememberReading = settings.rememberReading !== false;
  const language = requestedLanguage || (settings.autoDetectLanguage
    ? await detectSpeechLanguage(text, settings.lang)
    : settings.lang);
  const languageRoot = language.toLowerCase().split("-")[0];
  const preferredVoice = context.voiceName || settings.languageVoices?.[languageRoot] || settings.voiceName;
  const voiceName = await getCompatibleVoiceName(preferredVoice, language);
  if (request !== pendingSpeechRequest) return false;

  reading.session += 1;
  reading.utterance = null;
  chrome.tts.stop();
  reading.active = true;
  reading.paused = false;
  reading.chunks = splitIntoSpeechChunks(text, language);
  reading.text = text;
  reading.offsets = [];
  let searchOffset = 0;
  let compactOffset = 0;
  for (const chunk of reading.chunks) {
    const offset = text.indexOf(chunk, searchOffset);
    compactOffset += normalizeHighlightText(text.slice(searchOffset, offset)).length;
    reading.offsets.push(compactOffset);
    compactOffset += normalizeHighlightText(chunk).length;
    searchOffset = offset + chunk.length;
  }
  reading.sourceLength = compactOffset;
  reading.index = Math.max(0, Math.min(reading.chunks.length - 1, Number(context.index) || 0));
  reading.page = context.page?.url ? { ...context.page, url: readingPageUrl(context.page.url) } : null;
  reading.error = "";
  reading.errorCode = "";
  reading.language = language;
  reading.tabId = tabId || null;
  reading.options = {
    lang: language,
    rate: Number(context.rate) >= 0.5 && Number(context.rate) <= 2 ? Number(context.rate) : Number(settings.rate),
    pitch: Number(settings.pitch),
    volume: Number(settings.volume),
    requiredEventTypes: ["end"],
    ...(voiceName ? { voiceName } : {})
  };
  startReadingMonitor();
  speakCurrentChunk(reading.session);
  return true;
}

function speakCurrentChunk(session, retry = 0) {
  if (!reading.active || reading.paused || session !== reading.session) return;
  const chunk = reading.chunks[reading.index];
  if (!chunk) {
    finishReading();
    return;
  }

  const utterance = { session, retry, accepted: false, acceptedAt: 0, started: false, idleChecks: 0 };
  reading.utterance = utterance;
  reading.status = retry ? "retrying" : "waiting";
  if (!retry) { reading.error = ""; reading.errorCode = ""; }
  updateReadingState();
  try {
    chrome.tts.speak(chunk, {
      ...reading.options,
      enqueue: false,
      onEvent: (event) => {
        if (!isCurrentUtterance(utterance)) return;
        if (event.type === "start" || event.type === "word" || event.type === "sentence") {
          utterance.started = true;
          utterance.idleChecks = 0;
          if (reading.status !== "speaking" && !reading.paused) {
            reading.status = "speaking";
            updateReadingState();
          }
          return;
        }
        if (!TERMINAL_TTS_EVENTS.has(event.type)) return;
        if (event.type === "end") {
          completeCurrentChunk(utterance);
        } else if (event.type === "error") {
          retryCurrentChunk(utterance, event.errorMessage);
        } else {
          failReading("", "speechInterrupted");
        }
      }
    }).then(() => {
      if (!isCurrentUtterance(utterance)) return;
      utterance.accepted = true;
      utterance.acceptedAt = Date.now();
    }, (error) => retryCurrentChunk(utterance, error.message));
  } catch (error) {
    retryCurrentChunk(utterance, error.message);
  }
}

function isCurrentUtterance(utterance) {
  return Boolean(utterance && reading.active && reading.session === utterance.session && reading.utterance === utterance);
}

function completeCurrentChunk(utterance) {
  if (!isCurrentUtterance(utterance)) return;
  reading.utterance = null;
  reading.index += 1;
  if (reading.index >= reading.chunks.length) {
    finishReading();
  } else if (reading.paused) {
    updateReadingState();
  } else {
    speakCurrentChunk(utterance.session);
  }
}

function retryCurrentChunk(utterance, error = "", errorCode = "speechFailed") {
  if (!isCurrentUtterance(utterance)) return;
  reading.error = error;
  reading.errorCode = errorCode;
  if (utterance.retry < 1 && !reading.paused) {
    speakCurrentChunk(utterance.session, utterance.retry + 1);
  } else {
    failReading(error, errorCode);
  }
}

function startReadingMonitor() {
  if (readingMonitor !== null) return;
  // An active utterance can last beyond the MV3 worker's idle timeout.
  // Poll only during a reading session, also recovering a missing end event.
  readingMonitor = setInterval(checkReadingProgress, READING_CHECK_INTERVAL);
}

function stopReadingMonitor() {
  if (readingMonitor !== null) clearInterval(readingMonitor);
  readingMonitor = null;
  readingMonitorCheck = null;
}

async function checkReadingProgress() {
  if (!reading.active || readingMonitorCheck?.session === reading.session) return;
  const check = { session: reading.session, utterance: reading.utterance };
  readingMonitorCheck = check;
  try {
    const speaking = await chrome.tts.isSpeaking();
    const utterance = check.utterance;
    if (!isCurrentUtterance(utterance) || reading.paused || !utterance.accepted) return;
    if (speaking) {
      utterance.started = true;
      utterance.idleChecks = 0;
      if (reading.status !== "speaking") {
        reading.status = "speaking";
        updateReadingState();
      }
    } else if (utterance.started || Date.now() - utterance.acceptedAt >= SPEECH_START_GRACE) {
      // Confirm idle twice so an engine transition is not treated as completion.
      if (++utterance.idleChecks >= 2) {
        if (utterance.started) completeCurrentChunk(utterance);
        else retryCurrentChunk(utterance, "", "speechDidNotStart");
      }
    }
  } catch {
    // An unavailable status check does not mean the utterance has finished.
  } finally {
    if (readingMonitorCheck === check) readingMonitorCheck = null;
  }
}

function togglePause() {
  if (!reading.active) return;
  if (reading.paused) {
    reading.paused = false;
    reading.status = "waiting";
    if (reading.utterance) {
      reading.utterance.idleChecks = 0;
      chrome.tts.resume();
    } else {
      speakCurrentChunk(reading.session);
    }
  } else {
    reading.paused = true;
    reading.status = "paused";
    chrome.tts.pause();
  }
  updateReadingState();
}

function skipReading(offset) {
  if (!reading.active || !offset) return;
  pendingSpeechRequest += 1;
  reading.session += 1;
  reading.utterance = null;
  chrome.tts.stop();
  reading.index = Math.max(0, Math.min(reading.chunks.length - 1, reading.index + offset));
  reading.paused = false;
  updateReadingState();
  speakCurrentChunk(reading.session);
}

function stopReading() {
  pendingSpeechRequest += 1;
  reading.session += 1;
  reading.utterance = null;
  stopReadingMonitor();
  chrome.tts.stop();
  reading.active = false;
  reading.paused = false;
  reading.status = "stopped";
  updateReadingState();
}

function finishReading() {
  reading.utterance = null;
  stopReadingMonitor();
  reading.active = false;
  reading.paused = false;
  reading.status = "completed";
  reading.index = Math.max(0, reading.chunks.length - 1);
  updateReadingState();
}

function publicReadingState() {
  return {
    active: reading.active, paused: reading.paused, index: reading.index,
    total: reading.chunks.length, currentText: reading.chunks[reading.index] || "",
    session: reading.session, status: reading.status, error: reading.error, errorCode: reading.errorCode,
    rate: reading.options?.rate || 1, voiceName: reading.options?.voiceName || "",
    pageUrl: reading.page?.url || "", source: reading.page?.source || "selection",
    sourceOffset: reading.offsets[reading.index] || 0, sourceLength: reading.sourceLength
  };
}

function failReading(error = "", code = "speechFailed") {
  reading.utterance = null;
  stopReadingMonitor();
  reading.active = false;
  reading.paused = false;
  reading.status = "error";
  reading.error = String(error || "");
  reading.errorCode = code;
  updateReadingState();
}

function restartCurrentReading() {
  if (!reading.chunks.length) return publicReadingState();
  pendingSpeechRequest += 1;
  reading.session += 1;
  reading.utterance = null;
  chrome.tts.stop();
  reading.active = true;
  reading.paused = false;
  reading.error = "";
  reading.errorCode = "";
  startReadingMonitor();
  speakCurrentChunk(reading.session);
  return publicReadingState();
}

function seekReading(index) {
  const target = Number(index);
  if (!Number.isInteger(target) || target < 0 || target >= reading.chunks.length) {
    return publicReadingState();
  }
  reading.index = target;
  return restartCurrentReading();
}

async function setReadingRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) return publicReadingState();
  if (reading.options) reading.options.rate = rate;
  await chrome.storage.sync.set({ rate });
  updateReadingState();
  return publicReadingState();
}

async function changeReadingVoice() {
  if (!reading.chunks.length) return publicReadingState();
  const session = reading.session;
  const root = reading.language.toLowerCase().split("-")[0];
  const voices = (await chrome.tts.getVoices()).filter((voice) =>
    (!voice.lang || voice.lang.toLowerCase().split("-")[0] === root) &&
    (!voice.eventTypes || voice.eventTypes.includes("end"))
  );
  if (session !== reading.session) return publicReadingState();
  const index = voices.findIndex((voice) => voice.voiceName === reading.options.voiceName);
  const next = voices.find((voice, offset) => offset > index && voice.voiceName !== reading.options.voiceName) ||
    voices.find((voice) => voice.voiceName !== reading.options.voiceName);
  if (!next) return { ...publicReadingState(), notice: "noOtherVoice" };
  reading.options.voiceName = next.voiceName;
  return restartCurrentReading();
}

function getReadingQueue(offset = 0) {
  const start = Math.max(0, Math.min(reading.chunks.length, Math.floor(Number(offset) || 0)));
  return { session: reading.session, index: reading.index, offset: start, total: reading.chunks.length,
    chunks: reading.chunks.slice(start, start + 40) };
}

function normalizeHighlightText(text) {
  return text.replace(/[\s\u00ad\u200b]+/gu, "");
}

function readingPageUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    // Fragments can identify different documents in hash-based applications.
    return url.href;
  } catch { return ""; }
}

function saveReadingBookmark() {
  const url = readingPageUrl(reading.page?.url);
  if (!rememberReading || !url || !reading.text || !chrome.storage.local) return;
  const signature = `${reading.session}|${reading.index}|${reading.options?.rate}|${reading.options?.voiceName}|${reading.status === "completed"}`;
  if (signature === bookmarkSignature) return;
  bookmarkSignature = signature;
  const completed = reading.status === "completed";
  const snapshot = {
    url, title: String(reading.page.title || "").slice(0, 300), source: reading.page.source || "selection",
    skipCode: reading.page.skipCode !== false, text: reading.text, index: reading.index,
    total: reading.chunks.length, language: reading.language, rate: reading.options.rate,
    voiceName: reading.options.voiceName || "", updatedAt: Date.now()
  };
  bookmarkWrites = bookmarkWrites.then(async () => {
    const { readingBookmarks = [] } = await chrome.storage.local.get({ readingBookmarks: [] });
    const entries = readingBookmarks.filter((entry) => entry.url !== url);
    if (!completed && snapshot.text.length <= 2000000) entries.unshift(snapshot);
    let size = 0;
    const kept = entries.slice(0, 20).filter((entry) => {
      size += entry.text.length;
      return size <= 2000000;
    });
    await chrome.storage.local.set({ readingBookmarks: kept });
  }).catch(() => { bookmarkSignature = ""; });
}

async function getReadingBookmark(value) {
  const url = readingPageUrl(value);
  if (!url || !chrome.storage.local) return null;
  const settings = await chrome.storage.sync.get({ rememberReading: true });
  if (!settings.rememberReading) return null;
  await bookmarkWrites;
  const { readingBookmarks = [] } = await chrome.storage.local.get({ readingBookmarks: [] });
  return readingBookmarks.find((entry) => entry.url === url) || null;
}

async function resumeSavedReading(url, tabId) {
  const request = ++pendingSpeechRequest;
  const bookmark = await getReadingBookmark(url);
  if (request !== pendingSpeechRequest) return publicReadingState();
  if (!bookmark) return { errorCode: "noSavedReading" };
  await speakText(bookmark.text, bookmark.language, tabId, {
    page: { url: bookmark.url, title: bookmark.title, source: bookmark.source, skipCode: bookmark.skipCode },
    index: bookmark.index, rate: bookmark.rate, voiceName: bookmark.voiceName, request
  });
  return publicReadingState();
}

function forgetReadingBookmark(value) {
  const url = readingPageUrl(value);
  bookmarkWrites = bookmarkWrites.then(async () => {
    if (!chrome.storage.local) return;
    const { readingBookmarks = [] } = await chrome.storage.local.get({ readingBookmarks: [] });
    await chrome.storage.local.set({ readingBookmarks: readingBookmarks.filter((entry) => entry.url !== url) });
    bookmarkSignature = "";
  }).catch(() => {});
  return bookmarkWrites.then(() => ({ cleared: true }));
}

function clearReadingBookmarks() {
  bookmarkWrites = bookmarkWrites.then(async () => {
    if (chrome.storage.local) await chrome.storage.local.set({ readingBookmarks: [] });
    bookmarkSignature = "";
  }).catch(() => {});
  return bookmarkWrites.then(() => ({ cleared: true }));
}

function updateReadingState() {
  saveReadingBookmark();
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
