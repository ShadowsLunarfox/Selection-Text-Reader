const HOST_ID = "selection-text-reader-overlay";
const TARGET_LANGUAGES = [
  ["en", "English"],
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["ms", "Malay"],
  ["pt", "Portuguese"],
  ["ru", "Russian"],
  ["th", "Thai"],
  ["vi", "Vietnamese"]
];

let selectedText = "";
let host;
let shadow;
let launcher;
let panel;
let statusElement;
let translationElement;
let selectionTimer;
let contextActive = true;
let selectedRange = null;
let highlightSearchOffset = 0;
let lastReadingIndex = -1;
let lastReadingStateSignature = "";
let ocrDragStart = null;
let uiLanguage = "en";

document.addEventListener("mousedown", handlePointerDown, true);
document.addEventListener("mouseup", handleSelectionChange);
document.addEventListener("keyup", handleSelectionChange);
document.addEventListener("keydown", handleReadingShortcut, true);
document.addEventListener("scroll", handleScroll, true);
loadInterfaceLanguage();

async function loadInterfaceLanguage() {
  const settings = await safeStorageGet({ uiLanguage: "en" });
  if (!settings) return;
  uiLanguage = ReaderI18n.normalizeLanguage(settings.uiLanguage);
  if (shadow) ReaderI18n.apply(shadow, uiLanguage);
}

function tr(key, values) {
  return ReaderI18n.t(key, uiLanguage, values);
}

function handleSelectionChange(event) {
  if (event.type === "keyup" && event.key.toLowerCase() === "r" && panel && !panel.hidden) {
    return;
  }

  if (event.target instanceof Node && host?.contains(event.target)) {
    return;
  }

  window.clearTimeout(selectionTimer);
  const delay = event.type === "mouseup" ? 400 : 0;
  selectionTimer = window.setTimeout(async () => {
    const settings = await safeStorageGet({ showSelectionButton: true });
    if (!settings || !settings.showSelectionButton) {
      hideOverlay();
      return;
    }

    const selectionDetails = getSelectionDetails();
    const text = selectionDetails.text;

    if (!text) {
      hideOverlay();
      return;
    }

    const rect = selectionDetails.rect;
    if (!rect.width && !rect.height) {
      return;
    }

    selectedText = text;
    clearReadingHighlight();
    selectedRange = selectionDetails.range;
    highlightSearchOffset = 0;
    lastReadingIndex = -1;
    ensureOverlay();
    positionLauncher(rect);
    panel.hidden = true;
    launcher.hidden = false;
  }, delay);
}

function getSelectionDetails() {
  const active = document.activeElement;
  if (
    active &&
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    active.selectionStart !== active.selectionEnd
  ) {
    return {
      text: active.value.slice(active.selectionStart, active.selectionEnd).trim(),
      rect: active.getBoundingClientRect(),
      range: null
    };
  }

  const selection = window.getSelection();
  if (!selection?.rangeCount) return { text: "", rect: null };
  return {
    text: selection.toString().trim(),
    rect: selection.getRangeAt(0).getBoundingClientRect(),
    range: selection.getRangeAt(0).cloneRange()
  };
}

function handlePointerDown(event) {
  if (event.composedPath().includes(host)) {
    return;
  }

  window.clearTimeout(selectionTimer);
  hideOverlay();
}

function handleReadingShortcut(event) {
  if (event.key === "Escape" && shadow && !shadow.querySelector(".ocr-overlay").hidden) {
    event.preventDefault();
    cancelOcrSelection();
    return;
  }

  if (
    event.key.toLowerCase() !== "r" ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.repeat
  ) {
    return;
  }

  if (!launcher || launcher.hidden) {
    const selectionDetails = getSelectionDetails();
    if (!selectionDetails.text || !selectionDetails.rect) return;

    selectedText = selectionDetails.text;
    selectedRange = selectionDetails.range;
    highlightSearchOffset = 0;
    lastReadingIndex = -1;
    clearReadingHighlight();
    ensureOverlay();
    positionLauncher(selectionDetails.rect);
    launcher.hidden = false;
  }

  event.preventDefault();
  event.stopPropagation();
  window.clearTimeout(selectionTimer);
  openPanel();
}

function startOcrSelection() {
  ensureOverlay();
  const overlay = shadow.querySelector(".ocr-overlay");
  const selectionBox = shadow.querySelector(".ocr-selection");
  shadow.querySelector(".ocr-result").hidden = true;
  panel.hidden = true;
  launcher.hidden = true;
  selectionBox.hidden = true;
  ocrDragStart = null;
  overlay.hidden = false;
}

function cancelOcrSelection() {
  if (!shadow) return;
  shadow.querySelector(".ocr-overlay").hidden = true;
  shadow.querySelector(".ocr-selection").hidden = true;
  ocrDragStart = null;
}

function beginOcrDrag(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  ocrDragStart = { x: event.clientX, y: event.clientY };
  event.currentTarget.setPointerCapture(event.pointerId);
  updateOcrSelectionBox(event.clientX, event.clientY);
}

function updateOcrDrag(event) {
  if (!ocrDragStart) return;
  event.preventDefault();
  updateOcrSelectionBox(event.clientX, event.clientY);
}

function updateOcrSelectionBox(x, y) {
  const box = shadow.querySelector(".ocr-selection");
  const left = Math.min(ocrDragStart.x, x);
  const top = Math.min(ocrDragStart.y, y);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${Math.abs(x - ocrDragStart.x)}px`;
  box.style.height = `${Math.abs(y - ocrDragStart.y)}px`;
  box.hidden = false;
}

async function finishOcrDrag(event) {
  if (!ocrDragStart) return;
  const rectangle = {
    left: Math.min(ocrDragStart.x, event.clientX),
    top: Math.min(ocrDragStart.y, event.clientY),
    width: Math.abs(event.clientX - ocrDragStart.x),
    height: Math.abs(event.clientY - ocrDragStart.y)
  };
  ocrDragStart = null;

  if (rectangle.width < 12 || rectangle.height < 12) {
    cancelOcrSelection();
    return;
  }

  cancelOcrSelection();
  showOcrResult("", tr("capturing"));
  host.style.visibility = "hidden";
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const response = await safeSendMessage({
    action: "capture-region",
    rectangle,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  });
  if (host) host.style.visibility = "visible";
  if (!response) return;
  if (response.error) {
    showOcrResult("", response.error);
    return;
  }
  showOcrResult(response.text, tr(response.text ? "recognitionComplete" : "noTextFound"));
}

function showOcrResult(text, status) {
  if (!shadow) return;
  const result = shadow.querySelector(".ocr-result");
  shadow.querySelector(".ocr-text").value = text;
  shadow.querySelector(".ocr-status").textContent = status;
  result.hidden = false;
}

function closeOcrResult() {
  if (shadow) shadow.querySelector(".ocr-result").hidden = true;
}

async function readOcrText() {
  const text = shadow.querySelector(".ocr-text").value.trim();
  const status = shadow.querySelector(".ocr-status");
  if (!text) {
    status.textContent = tr("noTextRead");
    return;
  }
  const response = await safeSendMessage({ action: "speak-text", text });
  if (response) status.textContent = tr(response.started ? "readingRecognized" : "unableRead");
}

async function copyOcrText() {
  const textArea = shadow.querySelector(".ocr-text");
  const status = shadow.querySelector(".ocr-status");
  if (!textArea.value.trim()) {
    status.textContent = tr("noTextCopy");
    return;
  }
  try {
    await navigator.clipboard.writeText(textArea.value);
  } catch {
    textArea.select();
    document.execCommand("copy");
  }
  status.textContent = tr("copied");
}

function handleScroll(event) {
  if (event.composedPath().includes(host)) {
    return;
  }

  hideOverlay();
}

function ensureOverlay() {
  if (host) {
    return;
  }

  const titleLogo = '<img class="brand-icon" src="' + chrome.runtime.getURL("assets/icons/icon-16.png") +
    '" srcset="' + chrome.runtime.getURL("assets/icons/icon-32.png") + ' 2x" width="16" height="16" alt="">';
  const launcherLogo = '<img src="' + chrome.runtime.getURL("assets/icons/icon-24.png") +
    '" srcset="' + chrome.runtime.getURL("assets/icons/icon-48.png") + ' 2x" width="24" height="24" alt="">';

  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0";
  shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      button, select { font: 12px Tahoma, "MS Sans Serif", Arial, sans-serif; letter-spacing: 0; }
      .launcher {
        position: fixed; width: 30px; height: 30px; padding: 0; color: #000080;
        background: #c0c0c0; border: 2px solid; border-color: #fff #000 #000 #fff;
        border-radius: 0; box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080;
        cursor: default; font-weight: 700;
      }
      .launcher:active {
        padding: 2px 0 0 2px; border-color: #000 #fff #fff #000;
        box-shadow: inset 1px 1px #808080;
      }
      .launcher img { display: block; width: 24px; height: 24px; margin: auto; object-fit: contain; pointer-events: none; }
      .panel {
        position: fixed; width: min(360px, calc(100vw - 24px)); padding: 3px 3px 11px;
        max-height: calc(100vh - 24px); overflow: auto;
        border: 2px solid; border-color: #fff #000 #000 #fff; border-radius: 0;
        color: #000; background: #c0c0c0;
        box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080, 2px 2px 0 rgba(0,0,0,.28);
        font: 12px Tahoma, "MS Sans Serif", Arial, sans-serif;
      }
      .header {
        display: flex; align-items: center; justify-content: space-between;
        min-height: 23px; margin-bottom: 8px; padding: 2px 3px 2px 5px;
        color: #fff; background: #000080;
      }
      .title-group { display: flex; align-items: center; gap: 6px; min-width: 0; margin-right: 6px; }
      .brand-icon { display: block; width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
      .title { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 700; white-space: nowrap; text-overflow: ellipsis; }
      .close {
        width: 18px; min-width: 18px; height: 18px; min-height: 18px; padding: 0;
        color: #000; background: #c0c0c0; border: 2px solid; border-color: #fff #000 #000 #fff;
        border-radius: 0; box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080;
        cursor: default; font-size: 12px; font-weight: 700; line-height: 12px;
      }
      .text, .translation, .current {
        overflow: auto; color: #000; background: #fff; border: 2px solid;
        border-color: #808080 #fff #fff #808080; line-height: 1.4;
      }
      .text { max-height: 78px; margin: 0 8px 10px; padding: 6px; }
      .label { display: grid; gap: 5px; margin: 11px 8px; font-weight: 400; }
      select {
        width: 100%; height: 25px; padding: 2px 5px; color: #000; background: #fff;
        border: 2px solid; border-color: #808080 #fff #fff #808080; border-radius: 0;
        outline: 1px solid #000; outline-offset: -2px;
      }
      .actions { display: flex; flex-wrap: wrap; gap: 7px; margin-right: 8px; margin-left: 8px; }
      .playback { margin-top: 8px; }
      .action {
        min-width: 72px; min-height: 25px; padding: 3px 9px; color: #000; background: #c0c0c0;
        border: 2px solid; border-color: #fff #000 #000 #fff; border-radius: 0;
        box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080; cursor: default;
      }
      .action.secondary { color: #000; background: #c0c0c0; }
      .action:active:not(:disabled) {
        padding: 4px 8px 2px 10px; border-color: #000 #fff #fff #000;
        box-shadow: inset 1px 1px #808080;
      }
      .close:active {
        padding: 1px 0 0 1px; border-color: #000 #fff #fff #000;
        box-shadow: inset 1px 1px #808080;
      }
      .action:disabled { color: #808080; text-shadow: 1px 1px #fff; }
      .translation { max-height: 96px; margin: 11px 8px 0; padding: 6px; }
      .current { max-height: 72px; margin: 9px 8px 0; padding: 6px; }
      .status { min-height: 20px; margin: 9px 8px 0; padding: 3px 5px; color: #000; background: #c0c0c0; border: 1px solid; border-color: #808080 #fff #fff #808080; font-size: 11px; }
      .mini-player {
        position: fixed; right: 12px; bottom: 12px; width: min(310px, calc(100vw - 24px));
        padding: 3px 3px 8px; color: #000; background: #c0c0c0; border: 2px solid;
        border-color: #fff #000 #000 #fff; box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080, 2px 2px 0 rgba(0,0,0,.28);
        font: 12px Tahoma, "MS Sans Serif", Arial, sans-serif;
      }
      .mini-header { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; padding: 3px 5px; color: #fff; background: #000080; font-weight: 700; }
      .mini-controls { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 0 6px; }
      .mini-controls .action { min-width: 0; padding-right: 4px; padding-left: 4px; }
      .mini-progress { margin: 7px 6px 0; padding: 3px 5px; overflow: hidden; background: #fff; border: 2px solid; border-color: #808080 #fff #fff #808080; white-space: nowrap; text-overflow: ellipsis; }
      .ocr-overlay { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.28); }
      .ocr-instruction { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 7px 12px; color: #fff; background: #000080; border: 2px solid; border-color: #fff #000 #000 #fff; font: 12px Tahoma, "MS Sans Serif", Arial, sans-serif; }
      .ocr-selection { position: fixed; border: 2px dashed #fff; outline: 1px solid #000; background: rgba(0,0,128,.16); }
      .ocr-result { position: fixed; top: 50%; left: 50%; width: min(520px, calc(100vw - 24px)); padding: 3px 3px 10px; transform: translate(-50%, -50%); color: #000; background: #c0c0c0; border: 2px solid; border-color: #fff #000 #000 #fff; box-shadow: inset 1px 1px #dfdfdf, inset -1px -1px #808080, 2px 2px 0 rgba(0,0,0,.28); font: 12px Tahoma, "MS Sans Serif", Arial, sans-serif; }
      .ocr-text { display: block; width: calc(100% - 16px); min-height: 180px; max-height: 50vh; margin: 8px; padding: 6px; resize: vertical; color: #000; background: #fff; border: 2px solid; border-color: #808080 #fff #fff #808080; border-radius: 0; font: 13px Tahoma, Arial, sans-serif; line-height: 1.4; }
      .ocr-status { min-height: 20px; margin: 8px 8px 0; padding: 3px 5px; background: #fff; border: 1px solid; border-color: #808080 #fff #fff #808080; }
    </style>
    <button class="launcher" type="button" data-i18n-title="openReadingPanel" data-i18n-aria-label="openReadingPanel" title="Open reading panel" aria-label="Open reading panel" hidden>${launcherLogo}</button>
    <section class="mini-player" hidden>
      <div class="mini-header">${titleLogo}<span class="title" data-i18n="appName">Selection Text Reader</span></div>
      <div class="mini-controls">
        <button class="action mini-previous" type="button" data-i18n="previous">Previous</button>
        <button class="action mini-pause" type="button" data-i18n="pause">Pause</button>
        <button class="action mini-next" type="button" data-i18n="next">Next</button>
        <button class="action mini-stop" type="button" data-i18n="stop">Stop</button>
      </div>
      <div class="mini-progress"></div>
    </section>
    <div class="ocr-overlay" hidden>
      <div class="ocr-instruction" data-i18n="dragToScan">Drag to select an area. Press Esc to cancel.</div>
      <div class="ocr-selection" hidden></div>
    </div>
    <section class="ocr-result" hidden>
      <div class="header"><span class="title-group">${titleLogo}<span class="title" data-i18n="screenScanner">Screen Text Scanner</span></span><button class="close ocr-close" type="button" data-i18n-title="close" title="Close">x</button></div>
      <textarea class="ocr-text" data-i18n-aria-label="recognizedText" aria-label="Recognized text"></textarea>
      <div class="actions">
        <button class="action ocr-read" type="button" data-i18n="readText">Read text</button>
        <button class="action ocr-copy" type="button" data-i18n="copyText">Copy text</button>
        <button class="action ocr-rescan" type="button" data-i18n="scanAgain">Scan again</button>
      </div>
      <div class="ocr-status" role="status" aria-live="polite"></div>
    </section>
    <section class="panel" hidden>
      <div class="header"><span class="title-group">${titleLogo}<span class="title" data-i18n="appName">Selection Text Reader</span></span><button class="close" type="button" data-i18n-title="close" title="Close">x</button></div>
      <p class="text"></p>
      <div class="actions">
        <button class="action read-original" type="button" data-i18n="readOriginal">Read original</button>
        <button class="action secondary stop" type="button" data-i18n="stop">Stop</button>
      </div>
      <div class="actions playback" hidden>
        <button class="action secondary previous" type="button" data-i18n="previous">Previous</button>
        <button class="action secondary pause" type="button" data-i18n="pause">Pause</button>
        <button class="action secondary next" type="button" data-i18n="next">Next</button>
      </div>
      <p class="current" hidden></p>
      <label class="label"><span data-i18n="translateTo">Translate to</span><select class="language"></select></label>
      <button class="action translate" type="button" data-i18n="translateRead">Translate and read</button>
      <p class="translation" hidden></p>
      <p class="status" role="status" aria-live="polite"></p>
    </section>
  `;

  document.documentElement.appendChild(host);
  launcher = shadow.querySelector(".launcher");
  panel = shadow.querySelector(".panel");
  statusElement = shadow.querySelector(".status");
  translationElement = shadow.querySelector(".translation");
  ReaderI18n.apply(shadow, uiLanguage);

  const languageSelect = shadow.querySelector(".language");
  let languageNames;
  try {
    languageNames = new Intl.DisplayNames([uiLanguage], { type: "language" });
  } catch {
    languageNames = null;
  }
  for (const [value, label] of TARGET_LANGUAGES) {
    languageSelect.add(new Option(languageNames?.of(value) || label, value));
  }
  safeStorageGet({ translationTarget: "en" }).then((settings) => {
    if (settings) languageSelect.value = settings.translationTarget;
  });
  languageSelect.addEventListener("change", () => {
    safeStorageSet({ translationTarget: languageSelect.value });
  });

  launcher.addEventListener("mousedown", preserveSelection);
  launcher.addEventListener("click", openPanel);
  shadow.querySelector(".close").addEventListener("click", hideOverlay);
  shadow.querySelector(".read-original").addEventListener("click", readOriginal);
  shadow.querySelector(".stop").addEventListener("click", stopReading);
  shadow.querySelector(".previous").addEventListener("click", () => skipReading(-1));
  shadow.querySelector(".pause").addEventListener("click", togglePause);
  shadow.querySelector(".next").addEventListener("click", () => skipReading(1));
  shadow.querySelector(".translate").addEventListener("click", translateAndRead);
  shadow.querySelector(".mini-previous").addEventListener("click", () => skipReading(-1));
  shadow.querySelector(".mini-pause").addEventListener("click", togglePause);
  shadow.querySelector(".mini-next").addEventListener("click", () => skipReading(1));
  shadow.querySelector(".mini-stop").addEventListener("click", stopReading);
  const ocrOverlay = shadow.querySelector(".ocr-overlay");
  ocrOverlay.addEventListener("pointerdown", beginOcrDrag);
  ocrOverlay.addEventListener("pointermove", updateOcrDrag);
  ocrOverlay.addEventListener("pointerup", finishOcrDrag);
  shadow.querySelector(".ocr-close").addEventListener("click", closeOcrResult);
  shadow.querySelector(".ocr-read").addEventListener("click", readOcrText);
  shadow.querySelector(".ocr-copy").addEventListener("click", copyOcrText);
  shadow.querySelector(".ocr-rescan").addEventListener("click", startOcrSelection);
}

function preserveSelection(event) {
  event.preventDefault();
}

function positionLauncher(rect) {
  const left = Math.max(6, Math.min(window.innerWidth - 36, rect.right - 30));
  const top = Math.max(6, Math.min(window.innerHeight - 36, rect.bottom - 30));
  launcher.style.left = `${left}px`;
  launcher.style.top = `${top}px`;
}

function openPanel() {
  const launcherRect = launcher.getBoundingClientRect();
  const panelWidth = Math.min(360, window.innerWidth - 24);
  const left = Math.max(12, Math.min(window.innerWidth - panelWidth - 12, launcherRect.left));
  const top = launcherRect.bottom + 8 + 330 <= window.innerHeight
    ? launcherRect.bottom + 8
    : Math.max(12, launcherRect.top - 338);

  shadow.querySelector(".text").textContent = selectedText;
  translationElement.hidden = true;
  translationElement.textContent = "";
  statusElement.textContent = "";
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.hidden = false;
  launcher.hidden = true;
}

async function readOriginal() {
  const response = await safeSendMessage({ action: "speak-text", text: selectedText });
  if (!response) return;
  statusElement.textContent = tr(response?.started ? "readingOriginal" : "unableRead");
}

async function stopReading() {
  const response = await safeSendMessage({ action: "stop-reading" });
  if (!response) return;
  statusElement.textContent = tr("readingStopped");
}

async function togglePause() {
  renderReadingState(await safeSendMessage({ action: "toggle-pause" }));
}

async function skipReading(offset) {
  renderReadingState(await safeSendMessage({ action: "skip-reading", offset }));
}

function renderReadingState(state) {
  const signature = state
    ? `${state.active}|${state.paused}|${state.index}|${state.total}|${state.currentText}`
    : "none";
  if (signature === lastReadingStateSignature) return;
  lastReadingStateSignature = signature;

  if (!shadow && state?.active) ensureOverlay();
  if (!shadow) return;
  const playback = shadow.querySelector(".playback");
  const current = shadow.querySelector(".current");
  const pause = shadow.querySelector(".pause");
  const miniPlayer = shadow.querySelector(".mini-player");
  const miniPause = shadow.querySelector(".mini-pause");
  const miniProgress = shadow.querySelector(".mini-progress");
  playback.hidden = !state?.active;
  current.hidden = !state?.active;
  miniPlayer.hidden = !state?.active;
  pause.textContent = tr(state?.paused ? "resume" : "pause");
  miniPause.textContent = tr(state?.paused ? "resume" : "pause");
  current.textContent = state?.active
    ? `${state.index + 1} / ${state.total}: ${state.currentText}`
    : "";
  miniProgress.textContent = state?.active
    ? `${state.index + 1} / ${state.total}: ${state.currentText}`
    : "";

  if (state?.active) {
    highlightCurrentSentence(state);
  } else {
    clearReadingHighlight();
  }
}

function highlightCurrentSentence(state) {
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;

  if (!selectedRange) {
    selectedRange = getSelectionDetails().range;
  }
  if (!selectedRange) return;

  try {
    const selectionMap = buildNormalizedRangeMap(selectedRange);
    const sentence = normalizeForHighlight(state.currentText);
    if (!sentence || !selectionMap.text) return;

    if (state.index <= lastReadingIndex) highlightSearchOffset = 0;
    let startIndex = selectionMap.text.indexOf(sentence, highlightSearchOffset);
    if (startIndex < 0) startIndex = selectionMap.text.indexOf(sentence);
    if (startIndex < 0) {
      clearReadingHighlight();
      return;
    }

    const start = selectionMap.positions[startIndex];
    const end = selectionMap.positions[startIndex + sentence.length - 1];
    const range = document.createRange();
    range.setStart(start.startNode, start.startOffset);
    range.setEnd(end.endNode, end.endOffset);

    ensureHighlightStyle();
    CSS.highlights.set("selection-reader-current", new Highlight(range));
    highlightSearchOffset = startIndex + sentence.length;
    lastReadingIndex = state.index;
    scrollHighlightIntoView(range);
  } catch {
    clearReadingHighlight();
  }
}

function buildNormalizedRangeMap(range) {
  const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentNode
    : range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
    nodes.push(range.commonAncestorContainer);
  } else {
    while (walker.nextNode()) {
      if (range.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode);
    }
  }

  let text = "";
  const positions = [];
  for (const node of nodes) {
    const startOffset = node === range.startContainer ? range.startOffset : 0;
    const endOffset = node === range.endContainer ? range.endOffset : node.data.length;
    for (let offset = startOffset; offset < endOffset; offset += 1) {
      const character = node.data[offset];
      if (/\s/u.test(character)) {
        if (!text || text.endsWith(" ")) {
          if (text.endsWith(" ")) {
            positions[positions.length - 1].endNode = node;
            positions[positions.length - 1].endOffset = offset + 1;
          }
          continue;
        }
        text += " ";
      } else {
        text += character;
      }
      positions.push({
        startNode: node,
        startOffset: offset,
        endNode: node,
        endOffset: offset + 1
      });
    }
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    positions.pop();
  }
  return { text, positions };
}

function normalizeForHighlight(text) {
  return (text || "").replace(/\s+/gu, " ").trim();
}

function ensureHighlightStyle() {
  if (document.getElementById(`${HOST_ID}-highlight-style`)) return;
  const style = document.createElement("style");
  style.id = `${HOST_ID}-highlight-style`;
  style.textContent = "::highlight(selection-reader-current){background:#000080;color:#fff}";
  document.documentElement.appendChild(style);
}

function scrollHighlightIntoView(range) {
  const rect = range.getBoundingClientRect();
  if (rect.top < 20 || rect.bottom > window.innerHeight - 90) {
    window.scrollBy({ top: rect.top - window.innerHeight * 0.35, behavior: "smooth" });
  }
}

function clearReadingHighlight() {
  globalThis.CSS?.highlights?.delete("selection-reader-current");
  highlightSearchOffset = 0;
  lastReadingIndex = -1;
}

async function translateAndRead() {
  const button = shadow.querySelector(".translate");
  const targetLanguage = shadow.querySelector(".language").value;
  button.disabled = true;
  statusElement.textContent = tr("translating");

  try {
    const response = await safeSendMessage({
      action: "translate-text",
      text: selectedText,
      targetLanguage
    });

    if (response?.error || !response?.translatedText) {
      throw new Error(response?.error || tr("translationFailed"));
    }

    translationElement.textContent = response.translatedText;
    translationElement.hidden = false;
    const readingResponse = await safeSendMessage({
      action: "speak-text",
      text: response.translatedText,
      lang: targetLanguage
    });
    if (!readingResponse) return;
    statusElement.textContent = tr("readingTranslation");
  } catch (error) {
    if (statusElement) statusElement.textContent = error.message || tr("translationFailed");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function hideOverlay() {
  window.clearTimeout(selectionTimer);

  if (!host) {
    return;
  }

  launcher.hidden = true;
  panel.hidden = true;
}

async function safeStorageGet(defaults) {
  if (!extensionContextAvailable()) return null;
  try {
    return await chrome.storage.sync.get(defaults);
  } catch {
    invalidateExtensionContext();
    return null;
  }
}

async function safeStorageSet(values) {
  if (!extensionContextAvailable()) return false;
  try {
    await chrome.storage.sync.set(values);
    return true;
  } catch {
    invalidateExtensionContext();
    return false;
  }
}

async function safeSendMessage(message) {
  if (!extensionContextAvailable()) return null;
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    invalidateExtensionContext();
    return null;
  }
}

function extensionContextAvailable() {
  return contextActive && Boolean(chrome.runtime?.id);
}

function invalidateExtensionContext() {
  contextActive = false;
  window.clearTimeout(selectionTimer);
  clearReadingHighlight();
  document.getElementById(`${HOST_ID}-highlight-style`)?.remove();
  host?.remove();
  host = null;
  shadow = null;
  launcher = null;
  panel = null;
  statusElement = null;
  translationElement = null;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.uiLanguage) return;
  uiLanguage = ReaderI18n.normalizeLanguage(changes.uiLanguage.newValue);
  if (shadow) ReaderI18n.apply(shadow, uiLanguage);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "reading-state") {
    renderReadingState(message.state);
    return;
  }
  if (message.action === "start-ocr-selection") {
    startOcrSelection();
    return;
  }
  if (message.action === "ocr-captured") {
    if (host) host.style.visibility = "visible";
    showOcrResult("", tr("loadingOcr"));
    return;
  }
  if (message.action === "ocr-progress" && shadow) {
    const percentage = Math.round((message.progress || 0) * 100);
    const label = String(message.status || "Recognizing text").replace(/^./, (character) => character.toUpperCase());
    shadow.querySelector(".ocr-status").textContent = `${label} ${percentage}%`;
  }
});
