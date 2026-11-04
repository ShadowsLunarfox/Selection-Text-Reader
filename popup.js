const statusElement = document.getElementById("popupStatus");
const progressElement = document.getElementById("readingProgress");
const pauseButton = document.getElementById("pauseButton");
let uiLanguage = "en";
let activeTab = null;

initializePopup().catch(() => showStatus(ReaderI18n.t("pageAccessDenied", uiLanguage)));

async function initializePopup() {
  const settings = await chrome.storage.sync.get({ uiLanguage: "en", disabledSites: [], skipCodeBlocks: true });
  uiLanguage = ReaderI18n.normalizeLanguage(settings.uiLanguage);
  document.documentElement.lang = uiLanguage;
  document.title = ReaderI18n.t("appName", uiLanguage);
  ReaderI18n.apply(document, uiLanguage);
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  document.getElementById("skipCodeBlocks").checked = settings.skipCodeBlocks;
  const site = document.getElementById("siteEnabled");
  const hostname = ReaderPage.domain(activeTab?.url || "");
  site.disabled = !hostname || !/^https?:/.test(activeTab?.url || "");
  site.checked = !ReaderPage.siteDisabled(hostname, settings.disabledSites);
  await Promise.all([refreshReadingState(), refreshBookmark()]);
}

async function pageAction(action, close = false) {
  try {
    if (!activeTab?.id) { showStatus(ReaderI18n.t("noActivePage", uiLanguage)); return; }
    const response = await chrome.tabs.sendMessage(activeTab.id, { action });
    if (response?.errorCode || response?.error) {
      showStatus(ReaderI18n.t(response.errorCode || "unableRead", uiLanguage));
      return;
    }
    if (response?.state) renderReadingState(response.state);
    else if (response?.total) renderReadingState(response);
    if (close) window.close();
    else await refreshBookmark();
  } catch { showStatus(ReaderI18n.t("refreshBeforeScan", uiLanguage)); }
}

async function readingAction(action, values = {}) {
  try {
    const state = await chrome.runtime.sendMessage({ action, ...values });
    if (state?.notice) showStatus(ReaderI18n.t(state.notice, uiLanguage));
    else if (state?.errorCode && !state?.total) showStatus(ReaderI18n.t(state.errorCode, uiLanguage));
    else renderReadingState(state);
    return state;
  } catch { showStatus(ReaderI18n.t("unableRead", uiLanguage)); }
}

document.getElementById("readButton").addEventListener("click", () => pageAction("read-page-selection"));
document.getElementById("articleButton").addEventListener("click", () => pageAction("read-article"));
document.getElementById("paragraphButton").addEventListener("click", () => pageAction("pick-reading-paragraph", true));
document.getElementById("scanButton").addEventListener("click", () => pageAction("start-ocr-selection", true));
document.getElementById("continueButton").addEventListener("click", () => pageAction("resume-page-reading"));
document.getElementById("repeatButton").addEventListener("click", () => readingAction("retry-reading"));
document.getElementById("changeVoiceButton").addEventListener("click", () => readingAction("change-reading-voice"));
pauseButton.addEventListener("click", () => readingAction("toggle-pause"));
document.getElementById("stopButton").addEventListener("click", async () => {
  await readingAction("stop-reading");
  await refreshBookmark();
});
document.getElementById("readingRate").addEventListener("change", (event) => readingAction("set-reading-rate", { rate: Number(event.target.value) }));
document.getElementById("readingSeek").addEventListener("change", (event) => readingAction("seek-reading", { index: Number(event.target.value) }));
document.getElementById("forgetButton").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "forget-reading", url: activeTab?.url });
  await refreshBookmark();
});
document.getElementById("skipCodeBlocks").addEventListener("change", (event) => chrome.storage.sync.set({ skipCodeBlocks: event.target.checked }));
document.getElementById("siteEnabled").addEventListener("change", async (event) => {
  const hostname = ReaderPage.domain(activeTab?.url || "");
  const { disabledSites = [] } = await chrome.storage.sync.get({ disabledSites: [] });
  const sites = disabledSites.filter((site) => !ReaderPage.siteDisabled(hostname, [site]));
  if (!event.target.checked) sites.push(hostname);
  await chrome.storage.sync.set({ disabledSites: sites });
});

function showStatus(message) { statusElement.textContent = message; }
async function refreshReadingState() {
  renderReadingState(await chrome.runtime.sendMessage({ action: "get-reading-state" }));
}
async function refreshBookmark() {
  const bookmark = await chrome.runtime.sendMessage({ action: "get-reading-bookmark", url: activeTab?.url });
  document.getElementById("savedReading").hidden = !bookmark?.text;
  document.getElementById("savedReadingProgress").textContent = bookmark?.text
    ? ReaderI18n.t("savedReadingAt", uiLanguage, { current: bookmark.index + 1, total: bookmark.total }) : "";
}
function renderReadingState(state) {
  pauseButton.disabled = !state?.active;
  pauseButton.textContent = ReaderI18n.t(state?.paused ? "resume" : "pause", uiLanguage);
  const visible = Boolean(state?.total);
  document.getElementById("playerTools").hidden = !visible;
  progressElement.textContent = visible
    ? ReaderI18n.t("sentenceProgress", uiLanguage, { current: state.index + 1, total: state.total }) : "";
  if (visible) {
    const seek = document.getElementById("readingSeek");
    seek.max = state.total - 1;
    if (document.activeElement !== seek) seek.value = state.index;
    seek.setAttribute("aria-valuetext", progressElement.textContent);
    const rate = document.getElementById("readingRate");
    if (![...rate.options].some((option) => Number(option.value) === state.rate)) rate.add(new Option(`${state.rate}×`, state.rate));
    rate.value = state.rate;
  }
  showStatus(ReaderI18n.readingStatus(state, uiLanguage));
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "reading-state") renderReadingState(message.state);
});
