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
let pageSettings = { enableSingleKeyShortcut: true, disabledSites: [], skipCodeBlocks: true };
let readingSourceRanges = null;
let readingMode = "selection";
let readingHighlightSource = null;
let lastReadingState = null;
let savedBookmark = null;
let paragraphPickerActive = false;
let sentencePageOffset = 0;
let sentencePageSession = -1;

document.addEventListener("mousedown", handlePointerDown, true);
document.addEventListener("mouseup", handleSelectionChange);
document.addEventListener("keyup", handleSelectionChange);
document.addEventListener("keydown", handleReadingShortcut, true);
document.addEventListener("scroll", handleScroll, true);
document.addEventListener("toggle", handlePageOverlayToggle, true);
document.addEventListener("click", handleParagraphPick, true);
document.addEventListener("contextmenu", () => { safeSendMessage({ action: "refresh-site-menu", url: location.href }); }, true);
loadInterfaceLanguage();

async function loadInterfaceLanguage() {
  const settings = await safeStorageGet({ uiLanguage: "en", enableSingleKeyShortcut: true, disabledSites: [], skipCodeBlocks: true });
  if (!settings) return;
  uiLanguage = ReaderI18n.normalizeLanguage(settings.uiLanguage);
  pageSettings = settings;
  if (shadow) ReaderI18n.apply(shadow, uiLanguage);
  await restorePageReading();
}

function tr(key, values) {
  return ReaderI18n.t(key, uiLanguage, values);
}

function handleSelectionChange(event) {
  if (
    event.type === "keyup" &&
    !ReaderPage.editable(event) &&
    typeof event.key === "string" &&
    event.key.toLowerCase() === "r" &&
    panel && !panel.hidden
  ) {
    return;
  }

  if (event.target instanceof Node && host?.contains(event.target)) {
    return;
  }

  window.clearTimeout(selectionTimer);
  const delay = event.type === "mouseup" ? 400 : 0;
  selectionTimer = window.setTimeout(async () => {
    const settings = await safeStorageGet({ showSelectionButton: true, disabledSites: [] });
    if (!settings || !settings.showSelectionButton || ReaderPage.siteDisabled(location.hostname, settings.disabledSites)) {
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
    readingSourceRanges = null;
    readingMode = "selection";
    selectedRange = selectionDetails.range;
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
  if (event.key === "Escape" && paragraphPickerActive) {
    event.preventDefault();
    cancelParagraphPicker();
    return;
  }
  if (event.key === "Escape" && shadow && !shadow.querySelector(".ocr-overlay").hidden) {
    event.preventDefault();
    cancelOcrSelection();
    return;
  }

  if (
    !pageSettings.enableSingleKeyShortcut ||
    ReaderPage.siteDisabled(location.hostname, pageSettings.disabledSites) ||
    ReaderPage.editable(event) ||
    event.composedPath().includes(host) ||
    typeof event.key !== "string" ||
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
    readingSourceRanges = null;
    readingMode = "selection";
    selectedRange = selectionDetails.range;
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
  cancelParagraphPicker();
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
  host.style.setProperty("visibility", "hidden", "important");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const response = await safeSendMessage({
    action: "capture-region",
    rectangle,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  });
  if (host) host.style.setProperty("visibility", "visible", "important");
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
  raiseOverlay();
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
  const response = await safeSendMessage({ action: "speak-text", text, page: currentPageContext("ocr") });
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

function handlePageOverlayToggle(event) {
  if (!host || event.target === host || !(event.target instanceof HTMLElement)) return;
  const opened = event.newState === "open" && event.target.matches(":popover-open, dialog:modal");
  const closedParent = event.newState === "closed" && event.target.contains(host);
  if ((opened || closedParent) && shadow.querySelector(
    ".launcher:not([hidden]), .panel:not([hidden]), .mini-player:not([hidden]), .ocr-overlay:not([hidden]), .ocr-result:not([hidden])"
  )) {
    raiseOverlay();
  }
}

function raiseOverlay() {
  if (!host) return;

  // A modal makes nodes outside it inert, even when they are in the top layer.
  const modals = [...document.querySelectorAll("dialog:modal")];
  const modal = document.activeElement?.closest("dialog:modal") || modals.at(-1);
  const parent = modal || document.fullscreenElement || document.documentElement;
  if (host.parentNode !== parent) parent.appendChild(host);

  // z-index alone cannot put the reader above page dialogs and popovers.
  if (typeof host.showPopover === "function") {
    if (host.matches(":popover-open")) host.hidePopover();
    host.showPopover();
  }
}

function ensureOverlay() {
  if (host) {
    raiseOverlay();
    return;
  }

  const titleLogo = '<img class="brand-icon" src="' + chrome.runtime.getURL("assets/icons/icon-16.png") +
    '" srcset="' + chrome.runtime.getURL("assets/icons/icon-32.png") + ' 2x" width="16" height="16" alt="">';
  const launcherLogo = '<img src="' + chrome.runtime.getURL("assets/icons/icon-24.png") +
    '" srcset="' + chrome.runtime.getURL("assets/icons/icon-48.png") + ' 2x" width="24" height="24" alt="">';

  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("popover", "manual");
  host.style.cssText = "all:initial!important;position:fixed!important;z-index:2147483647!important;inset:0 auto auto 0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;pointer-events:none!important";
  shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host::backdrop { background: transparent !important; pointer-events: none !important; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .launcher, .panel, .mini-player, .ocr-overlay, .ocr-result { pointer-events: auto; }
      .launcher, .mini-player { z-index: 1; }
      .panel { z-index: 2; }
      .ocr-overlay { z-index: 3; }
      .ocr-result { z-index: 4; max-height: calc(100vh - 24px); overflow: auto; }
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
        max-height: calc(100vh - 24px); overflow: auto;
      }
      .mini-header { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; padding: 3px 5px; color: #fff; background: #000080; font-weight: 700; }
      .mini-controls { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 0 6px; }
      .mini-controls .action { min-width: 0; padding-right: 4px; padding-left: 4px; }
      .mini-progress { margin: 7px 6px 0; padding: 3px 5px; overflow: hidden; background: #fff; border: 2px solid; border-color: #808080 #fff #fff #808080; white-space: nowrap; text-overflow: ellipsis; }
      .reader-tools, .bookmark-offer { margin: 7px 6px 0; }
      .reader-tools label { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px; margin-top: 7px; }
      .reader-tools input, .reader-tools select { min-width: 0; width: 100%; }
      .reader-tools select { outline: none; }
      .reader-status { margin: 7px 0; overflow-wrap: anywhere; }
      .reader-recovery { display: flex; flex-wrap: wrap; gap: 5px; }
      .reader-recovery .action { min-width: 0; flex: 1; }
      .sentence-picker { margin-top: 8px; }
      .sentence-picker summary { cursor: pointer; }
      .sentence-items { max-height: 150px; overflow: auto; margin: 6px 0; padding: 0; list-style: none; }
      .sentence-items button { width: 100%; min-width: 0; padding: 5px; text-align: start; overflow-wrap: anywhere; white-space: normal; }
      .sentence-items button[aria-current=step] { background: #000080; color: #fff; }
      .paragraph-instruction { position: fixed; top: 12px; left: 12px; max-width: calc(100vw - 24px); padding: 8px; background: #000080; color: #fff; font: 13px Tahoma, Arial, sans-serif; pointer-events: none; }
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
      <div class="mini-session">
      <div class="mini-controls">
        <button class="action mini-previous" type="button" data-i18n="previous">Previous</button>
        <button class="action mini-pause" type="button" data-i18n="pause">Pause</button>
        <button class="action mini-next" type="button" data-i18n="next">Next</button>
        <button class="action mini-stop" type="button" data-i18n="stop">Stop</button>
      </div>
      <div class="mini-progress"></div>
      <div class="reader-tools">
        <label><span data-i18n="readingProgress">Reading progress</span><input class="reading-seek" type="range" min="0" max="0" value="0" data-i18n-aria-label="readingProgress"></label>
        <label><span data-i18n="speed">Speed</span><select class="reading-rate" data-i18n-aria-label="speed" data-i18n-title="rateNextSentence">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => `<option value="${rate}">${rate}×</option>`).join("")}</select></label>
        <p class="reader-status" role="status" aria-live="polite"></p>
        <div class="reader-recovery"><button class="action repeat-current" type="button" data-i18n="repeatCurrent"></button><button class="action change-voice" type="button" data-i18n="changeVoice"></button></div>
        <details class="sentence-picker"><summary data-i18n="sentenceList"></summary><ol class="sentence-items"></ol><div class="reader-recovery"><button class="action sentence-previous" type="button" data-i18n="previousPage"></button><button class="action sentence-next" type="button" data-i18n="nextPage"></button></div></details>
      </div>
      </div>
      <div class="bookmark-offer" hidden><p class="bookmark-progress"></p><div class="reader-recovery"><button class="action resume-bookmark" type="button" data-i18n="continueReading"></button><button class="action forget-bookmark" type="button" data-i18n="forgetReading"></button></div></div>
    </section>
    <div class="paragraph-instruction" data-i18n="pickParagraph" hidden></div>
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

  raiseOverlay();
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
  shadow.querySelector(".repeat-current").addEventListener("click", () => readingAction("retry-reading"));
  shadow.querySelector(".change-voice").addEventListener("click", () => readingAction("change-reading-voice"));
  shadow.querySelector(".reading-rate").addEventListener("change", (event) => readingAction("set-reading-rate", { rate: Number(event.target.value) }));
  shadow.querySelector(".reading-seek").addEventListener("change", (event) => readingAction("seek-reading", { index: Number(event.target.value) }));
  shadow.querySelector(".sentence-picker").addEventListener("toggle", (event) => { if (event.target.open) loadSentencePage(); });
  shadow.querySelector(".sentence-previous").addEventListener("click", () => loadSentencePage(Math.max(0, sentencePageOffset - 40)));
  shadow.querySelector(".sentence-next").addEventListener("click", () => loadSentencePage(sentencePageOffset + 40));
  shadow.querySelector(".resume-bookmark").addEventListener("click", resumePageReading);
  shadow.querySelector(".forget-bookmark").addEventListener("click", forgetPageReading);
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
  raiseOverlay();
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
  panel.style.maxHeight = `calc(100vh - ${top + 12}px)`;
  panel.hidden = false;
  launcher.hidden = true;
}

async function readOriginal() {
  prepareReadingHighlight();
  const response = await safeSendMessage({ action: "speak-text", text: selectedText, page: currentPageContext(readingMode) });
  if (!response) return;
  if (response.state) renderReadingState(response.state);
  statusElement.textContent = response.state?.status ? ReaderI18n.readingStatus(response.state, uiLanguage) : tr(response?.started ? "readingOriginal" : "unableRead");
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

function currentPageContext(source = "selection") {
  return { url: location.href, title: document.title, source, skipCode: pageSettings.skipCodeBlocks };
}

async function readingAction(action, values = {}) {
  const state = await safeSendMessage({ action, ...values });
  if (state?.notice && shadow) {
    shadow.querySelector(".reader-status").textContent = tr(state.notice);
  } else if (state?.total) {
    renderReadingState(state);
  }
  return state;
}

async function loadSentencePage(offset = Math.floor((lastReadingState?.index || 0) / 40) * 40) {
  const expectedSession = lastReadingState?.session;
  const queue = await safeSendMessage({ action: "get-reading-queue", offset });
  if (!shadow || !Array.isArray(queue?.chunks) || queue.session !== expectedSession || lastReadingState?.session !== expectedSession) return;
  sentencePageOffset = queue.offset;
  sentencePageSession = queue.session;
  const list = shadow.querySelector(".sentence-items");
  list.replaceChildren();
  queue.chunks.forEach((text, offset) => {
    const index = queue.offset + offset;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${index + 1}. ${text}`;
    button.dataset.index = index;
    if (index === lastReadingState.index) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => readingAction("seek-reading", { index }));
    item.appendChild(button);
    list.appendChild(item);
  });
  shadow.querySelector(".sentence-previous").disabled = queue.offset === 0;
  shadow.querySelector(".sentence-next").disabled = queue.offset + queue.chunks.length >= queue.total;
}

function prepareReadingHighlight() {
  clearReadingHighlight();
  // Page clicks and new selections can update the panel while speech continues.
  readingHighlightSource = {
    range: selectedRange?.cloneRange() || null,
    ranges: readingSourceRanges?.map((range) => range.cloneRange()) || null,
    mode: readingMode,
    skipCode: pageSettings.skipCodeBlocks
  };
}

function getReadingRangeMap() {
  const source = readingHighlightSource || {
    range: selectedRange, ranges: readingSourceRanges, mode: readingMode, skipCode: pageSettings.skipCodeBlocks
  };
  const maps = (source.ranges || [source.range])
    .filter((range) => range?.startContainer.isConnected)
    .map((range) => buildNormalizedRangeMap(range, source.mode, source.skipCode));
  return { text: maps.map((map) => map.text).join(""), positions: maps.flatMap((map) => map.positions) };
}

async function restorePageReading() {
  const state = await safeSendMessage({ action: "get-reading-state" });
  if (state?.pageUrl === location.href && (state.active || state.status === "error")) {
    const bookmark = await safeSendMessage({ action: "get-reading-bookmark", url: location.href });
    if (bookmark?.text) restoreReadingSource(bookmark);
    renderReadingState(state);
    return;
  }
  const bookmark = await safeSendMessage({ action: "get-reading-bookmark", url: location.href });
  if (!bookmark?.text || lastReadingState?.active) return;
  savedBookmark = bookmark;
  ensureOverlay();
  shadow.querySelector(".mini-player").hidden = false;
  shadow.querySelector(".mini-session").hidden = true;
  shadow.querySelector(".bookmark-offer").hidden = false;
  shadow.querySelector(".bookmark-progress").textContent = tr("savedReadingAt", { current: bookmark.index + 1, total: bookmark.total });
}

function restoreReadingSource(bookmark) {
  selectedText = bookmark.text;
  readingMode = bookmark.source;
  readingSourceRanges = null;
  selectedRange = null;
  if (bookmark.source === "article") {
    pageSettings.skipCodeBlocks = bookmark.skipCode;
    const article = ReaderPage.extract({ skipCode: bookmark.skipCode });
    const prefix = normalizeForHighlight(bookmark.text).slice(0, 120);
    const offset = normalizeForHighlight(article.text).indexOf(prefix);
    let length = 0;
    let firstBlock = 0;
    for (let index = 0; offset >= 0 && index < article.blocks.length; index++) {
      if (length >= offset) { firstBlock = index; break; }
      length += normalizeForHighlight(article.blocks[index].text).length;
    }
    readingSourceRanges = article.blocks.slice(firstBlock).map((block) => block.range);
    selectedRange = readingSourceRanges[0] || null;
  } else if (bookmark.source === "selection" && document.body) {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const map = buildNormalizedRangeMap(range);
    const text = normalizeForHighlight(bookmark.text);
    const index = map.text.indexOf(text);
    if (index >= 0 && text.length) {
      const start = map.positions[index];
      const end = map.positions[index + text.length - 1];
      range.setStart(start.startNode, start.startOffset);
      range.setEnd(end.endNode, end.endOffset);
      selectedRange = range;
    }
  }
  prepareReadingHighlight();
}

async function resumePageReading() {
  const bookmark = await safeSendMessage({ action: "get-reading-bookmark", url: location.href });
  if (!bookmark?.text) { await forgetPageReading(); return { errorCode: "noSavedReading" }; }
  restoreReadingSource(bookmark);
  const state = await safeSendMessage({ action: "resume-reading", url: location.href });
  if (state?.total) renderReadingState(state);
  savedBookmark = null;
  return state;
}

async function forgetPageReading() {
  await safeSendMessage({ action: "forget-reading", url: location.href });
  savedBookmark = null;
  if (shadow) {
    shadow.querySelector(".bookmark-offer").hidden = true;
    if (!lastReadingState?.active && lastReadingState?.status !== "error") shadow.querySelector(".mini-player").hidden = true;
  }
}

async function readPageSelection() {
  const selection = getSelectionDetails();
  if (!selection.text) return { errorCode: "selectTextFirst" };
  selectedText = selection.text;
  selectedRange = selection.range;
  readingSourceRanges = null;
  readingMode = "selection";
  prepareReadingHighlight();
  const response = await safeSendMessage({ action: "speak-text", text: selectedText, page: currentPageContext() });
  if (response?.state) renderReadingState(response.state);
  return response;
}

async function readPageArticle(startElement = null) {
  const article = ReaderPage.extract({ skipCode: pageSettings.skipCodeBlocks, startElement });
  if (!article.text) return { errorCode: "noArticle" };
  selectedText = article.text;
  readingMode = "article";
  readingSourceRanges = article.blocks.map((block) => block.range);
  selectedRange = readingSourceRanges[0];
  prepareReadingHighlight();
  const response = await safeSendMessage({ action: "speak-text", text: article.text, page: currentPageContext("article") });
  if (response?.state) renderReadingState(response.state);
  return response;
}

function startParagraphPicker() {
  cancelOcrSelection();
  ensureOverlay();
  paragraphPickerActive = true;
  shadow.querySelector(".paragraph-instruction").hidden = false;
  shadow.querySelector(".paragraph-instruction").textContent = tr("pickParagraph");
}

function cancelParagraphPicker() {
  paragraphPickerActive = false;
  if (shadow) shadow.querySelector(".paragraph-instruction").hidden = true;
}

function handleParagraphPick(event) {
  if (!paragraphPickerActive || event.composedPath().includes(host) || ReaderPage.editable(event) || !(event.target instanceof Element)) return;
  const paragraph = event.target.closest("p,li,blockquote,pre,h1,h2,h3,h4,h5,h6,td,div");
  if (!paragraph || ReaderPage.ignored(paragraph, pageSettings.skipCodeBlocks)) return;
  event.preventDefault();
  event.stopPropagation();
  cancelParagraphPicker();
  readPageArticle(paragraph).then((response) => {
    if (response?.errorCode && shadow) {
      shadow.querySelector(".paragraph-instruction").textContent = tr(response.errorCode);
      shadow.querySelector(".paragraph-instruction").hidden = false;
      window.setTimeout(() => { if (!paragraphPickerActive && shadow) shadow.querySelector(".paragraph-instruction").hidden = true; }, 3500);
    }
  });
}

function renderReadingState(state) {
  const signature = state
    ? JSON.stringify([state.session, state.active, state.paused, state.index, state.total, state.currentText, state.status, state.error, state.rate, state.voiceName])
    : "none";
  if (signature === lastReadingStateSignature) return;
  lastReadingStateSignature = signature;
  lastReadingState = state;

  const visible = state?.active || state?.status === "error";
  if (!shadow && visible) ensureOverlay();
  if (!shadow) return;
  const playback = shadow.querySelector(".playback");
  const current = shadow.querySelector(".current");
  const pause = shadow.querySelector(".pause");
  const miniPlayer = shadow.querySelector(".mini-player");
  const miniPause = shadow.querySelector(".mini-pause");
  const miniProgress = shadow.querySelector(".mini-progress");
  if (visible && miniPlayer.hidden) raiseOverlay();
  playback.hidden = !state?.active;
  current.hidden = !state?.active;
  miniPlayer.hidden = !visible;
  shadow.querySelector(".mini-session").hidden = !visible;
  shadow.querySelector(".bookmark-offer").hidden = true;
  pause.textContent = tr(state?.paused ? "resume" : "pause");
  miniPause.textContent = tr(state?.paused ? "resume" : "pause");
  current.textContent = state?.active
    ? `${state.index + 1} / ${state.total}: ${state.currentText}`
    : "";
  miniProgress.textContent = visible
    ? `${state.index + 1} / ${state.total}: ${state.currentText}`
    : "";
  if (visible) {
    const seek = shadow.querySelector(".reading-seek");
    seek.max = Math.max(0, state.total - 1);
    if (shadow.activeElement !== seek) seek.value = state.index;
    seek.setAttribute("aria-valuetext", tr("sentenceProgress", { current: state.index + 1, total: state.total }));
    const rate = shadow.querySelector(".reading-rate");
    const value = state.rate || 1;
    if (![...rate.options].some((option) => Number(option.value) === value)) rate.add(new Option(`${value}×`, value));
    rate.value = value;
    shadow.querySelector(".reader-status").textContent = ReaderI18n.readingStatus(state, uiLanguage);
    miniPause.disabled = !state.active;
    if (statusElement && state.status) statusElement.textContent = ReaderI18n.readingStatus(state, uiLanguage);
    if (shadow.querySelector(".sentence-picker").open && sentencePageSession !== state.session) loadSentencePage(Math.floor(state.index / 40) * 40);
    shadow.querySelectorAll(".sentence-items button").forEach((button) => {
      if (Number(button.dataset.index) === state.index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  }

  if (state?.active) {
    highlightCurrentSentence(state);
  } else {
    clearReadingHighlight();
  }
}

function highlightCurrentSentence(state) {
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;

  if (!readingHighlightSource && !selectedRange) {
    selectedRange = getSelectionDetails().range;
  }

  try {
    if (state.source === "translation" || state.source === "ocr") { clearReadingHighlight(); return; }
    const selectionMap = getReadingRangeMap();
    const sentence = normalizeForHighlight(state.currentText);
    if (!sentence || !selectionMap.text) {
      clearReadingHighlight();
      return;
    }

    if (state.index <= lastReadingIndex) highlightSearchOffset = 0;
    const exactOffset = state.sourceLength === selectionMap.text.length && Number.isInteger(state.sourceOffset) &&
      selectionMap.text.slice(state.sourceOffset, state.sourceOffset + sentence.length) === sentence;
    let startIndex = exactOffset ? state.sourceOffset : selectionMap.text.indexOf(sentence, highlightSearchOffset);
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

function buildNormalizedRangeMap(range, mode = readingMode, skipCode = pageSettings.skipCodeBlocks) {
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
    if (mode === "article" && ReaderPage.ignored(node.parentElement, skipCode)) continue;
    const visibility = getComputedStyle(node.parentElement).visibility;
    if (visibility === "hidden" || visibility === "collapse") continue;
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    if (!nodeRange.getClientRects().length) continue;

    const startOffset = node === range.startContainer ? range.startOffset : 0;
    const endOffset = node === range.endContainer ? range.endOffset : node.data.length;
    for (let offset = startOffset; offset < endOffset; offset += 1) {
      const character = node.data[offset];
      if (!normalizeForHighlight(character)) continue;
      text += character;
      positions.push({
        startNode: node,
        startOffset: offset,
        endNode: node,
        endOffset: offset + 1
      });
    }
  }

  return { text, positions };
}

function normalizeForHighlight(text) {
  // Rendered selections add line/block separators that have no DOM text node.
  // Ignore spacing and discretionary breaks while keeping original DOM offsets.
  return (text || "").replace(/[\s\u00ad\u200b]+/gu, "");
}

function ensureHighlightStyle() {
  if (document.getElementById(`${HOST_ID}-highlight-style`)) return;
  const style = document.createElement("style");
  style.id = `${HOST_ID}-highlight-style`;
  style.textContent = "::highlight(selection-reader-current){background:#000080;color:#fff}";
  document.documentElement.appendChild(style);
}

function scrollHighlightIntoView(range) {
  // Scroll from the innermost container outward, measuring again after each move.
  let element = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement;
  while (element && element !== document.documentElement) {
    if (element !== document.scrollingElement) {
      const style = getComputedStyle(element);
      const scrollX = /^(auto|scroll|hidden|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
      const scrollY = /^(auto|scroll|hidden|overlay)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
      if (scrollX || scrollY) {
        const bounds = element.getBoundingClientRect();
        const scaleX = bounds.width / element.offsetWidth || 1;
        const scaleY = bounds.height / element.offsetHeight || 1;
        const left = bounds.left + element.clientLeft * scaleX;
        const top = bounds.top + element.clientTop * scaleY;
        const width = element.clientWidth * scaleX;
        const height = element.clientHeight * scaleY;
        const delta = getHighlightScrollDelta(range, {
          left: left + Math.min(12, width / 4),
          right: left + width - Math.min(12, width / 4),
          top: top + Math.min(12, height / 4),
          bottom: top + height - Math.min(12, height / 4)
        });
        if ((scrollX && delta.left) || (scrollY && delta.top)) {
          element.scrollBy({ left: scrollX ? delta.left / scaleX : 0, top: scrollY ? delta.top / scaleY : 0, behavior: "instant" });
        }
      }
    }
    element = element.parentElement || element.getRootNode().host;
  }

  const delta = getHighlightScrollDelta(range, {
    left: 20,
    right: window.innerWidth - 20,
    top: Math.min(72, window.innerHeight * 0.2),
    bottom: window.innerHeight - Math.min(90, window.innerHeight * 0.25)
  });
  if (delta.left || delta.top) window.scrollBy({ ...delta, behavior: "instant" });
}

function getHighlightScrollDelta(range, viewport) {
  const first = [...range.getClientRects()].find((rect) => rect.width && rect.height);
  if (!first) return { left: 0, top: 0 };
  const bounds = range.getBoundingClientRect();
  // A long sentence can exceed the viewport; reveal its beginning instead of
  // jumping to its bottom and leaving the first lines behind the clipping edge.
  const horizontal = bounds.width <= viewport.right - viewport.left ? bounds : first;
  const vertical = bounds.height <= viewport.bottom - viewport.top ? bounds : first;
  const offset = (start, end, minimum, maximum) => {
    if (start < minimum || end - start > maximum - minimum) return start - minimum;
    return end > maximum ? end - maximum : 0;
  };
  return {
    left: offset(horizontal.left, horizontal.right, viewport.left, viewport.right),
    top: offset(vertical.top, vertical.bottom, viewport.top, viewport.bottom)
  };
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
    raiseOverlay();
    const readingResponse = await safeSendMessage({
      action: "speak-text",
      text: response.translatedText,
      lang: targetLanguage,
      page: currentPageContext("translation")
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
  if (areaName === "local" && changes.readingBookmarks && savedBookmark &&
    !changes.readingBookmarks.newValue?.some((bookmark) => bookmark.url === location.href)) {
    savedBookmark = null;
    if (shadow) {
      shadow.querySelector(".bookmark-offer").hidden = true;
      if (!lastReadingState?.active && lastReadingState?.status !== "error") shadow.querySelector(".mini-player").hidden = true;
    }
  }
  if (areaName !== "sync") return;
  for (const key of ["enableSingleKeyShortcut", "disabledSites", "skipCodeBlocks"]) {
    if (changes[key]) pageSettings[key] = changes[key].newValue;
  }
  if (ReaderPage.siteDisabled(location.hostname, pageSettings.disabledSites)) hideOverlay();
  if (changes.rememberReading?.newValue === false) forgetPageReading();
  if (changes.uiLanguage) {
    uiLanguage = ReaderI18n.normalizeLanguage(changes.uiLanguage.newValue);
    if (shadow) ReaderI18n.apply(shadow, uiLanguage);
    if (lastReadingState) { lastReadingStateSignature = ""; renderReadingState(lastReadingState); }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get-page-url") {
    sendResponse({ url: location.href });
    return;
  }
  const actions = { "read-page-selection": readPageSelection, "read-article": () => readPageArticle(), "resume-page-reading": resumePageReading };
  if (Object.hasOwn(actions, message.action)) {
    Promise.resolve().then(actions[message.action]).then(sendResponse, (error) => sendResponse({ error: error.message, errorCode: "unableRead" }));
    return true;
  }
  if (message.action === "pick-reading-paragraph") {
    startParagraphPicker();
    sendResponse({ picking: true });
    return;
  }
  if (message.action === "reading-state") {
    renderReadingState(message.state);
    return;
  }
  if (message.action === "start-ocr-selection") {
    startOcrSelection();
    sendResponse({ started: true });
    return;
  }
  if (message.action === "ocr-captured") {
    if (host) host.style.setProperty("visibility", "visible", "important");
    showOcrResult("", tr("loadingOcr"));
    return;
  }
  if (message.action === "ocr-progress" && shadow) {
    const percentage = Math.round((message.progress || 0) * 100);
    const label = String(message.status || "Recognizing text").replace(/^./, (character) => character.toUpperCase());
    shadow.querySelector(".ocr-status").textContent = `${label} ${percentage}%`;
  }
});
