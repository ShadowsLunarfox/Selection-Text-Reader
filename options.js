const DEFAULT_SETTINGS = {
  uiLanguage: "en",
  rate: 1,
  pitch: 1,
  volume: 1,
  lang: "zh-CN",
  voiceName: "",
  languageVoices: {},
  autoDetectLanguage: true,
  showSelectionButton: true,
  enableSingleKeyShortcut: true, disabledSites: [], rememberReading: true, skipCodeBlocks: true,
  ocrLanguage: "eng+chi_sim"
};

const form = document.getElementById("settingsForm");
const statusElement = document.getElementById("status");
const controls = {
  uiLanguage: document.getElementById("uiLanguage"),
  autoDetectLanguage: document.getElementById("autoDetectLanguage"),
  showSelectionButton: document.getElementById("showSelectionButton"),
  enableSingleKeyShortcut: document.getElementById("enableSingleKeyShortcut"),
  disabledSites: document.getElementById("disabledSites"),
  rememberReading: document.getElementById("rememberReading"),
  skipCodeBlocks: document.getElementById("skipCodeBlocks"),
  lang: document.getElementById("lang"),
  voiceName: document.getElementById("voiceName"),
  ocrLanguage: document.getElementById("ocrLanguage"),
  rate: document.getElementById("rate"),
  pitch: document.getElementById("pitch"),
  volume: document.getElementById("volume")
};
const valueLabels = {
  rate: document.getElementById("rateValue"),
  pitch: document.getElementById("pitchValue"),
  volume: document.getElementById("volumeValue")
};
const languageVoiceControls = [...document.querySelectorAll(".language-voice")];
const isPopupView = new URLSearchParams(window.location.search).get("popup") === "1";
let currentPlatformOs = "";

if (isPopupView) {
  document.documentElement.classList.add("options-popup-root");
  document.body.classList.add("options-popup");
  document.getElementById("backButton").hidden = false;
}

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const platform = await chrome.runtime.getPlatformInfo();
  currentPlatformOs = platform.os;

  controls.uiLanguage.value = settings.uiLanguage;
  applyInterfaceLanguage(settings.uiLanguage);
  document.getElementById("systemEngine").textContent = getSystemEngineName(platform.os);
  await populateVoices(platform.os);

  controls.autoDetectLanguage.checked = settings.autoDetectLanguage;
  controls.showSelectionButton.checked = settings.showSelectionButton;
  controls.enableSingleKeyShortcut.checked = settings.enableSingleKeyShortcut;
  controls.rememberReading.checked = settings.rememberReading;
  controls.skipCodeBlocks.checked = settings.skipCodeBlocks;
  controls.disabledSites.value = settings.disabledSites.join("\n");
  controls.lang.value = settings.lang;
  controls.voiceName.value = settings.voiceName;
  controls.ocrLanguage.value = settings.ocrLanguage;
  for (const control of languageVoiceControls) {
    control.value = settings.languageVoices?.[control.dataset.language] || "";
  }
  controls.rate.value = settings.rate;
  controls.pitch.value = settings.pitch;
  controls.volume.value = settings.volume;

  updateValueLabels();
}

form.addEventListener("input", updateValueLabels);

controls.uiLanguage.addEventListener("change", async () => {
  await chrome.storage.sync.set({ uiLanguage: controls.uiLanguage.value });
  applyInterfaceLanguage(controls.uiLanguage.value);
  localizeVoiceSources();
});

document.getElementById("backButton").addEventListener("click", () => {
  window.location.href = "popup.html";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await saveSettings()) showStatus(ReaderI18n.t("settingsSaved", controls.uiLanguage.value));
});

document.getElementById("testButton").addEventListener("click", async () => {
  const settings = await saveSettings();
  if (!settings) return;
  const languageRoot = settings.lang.toLowerCase().split("-")[0];
  const testVoice = settings.languageVoices[languageRoot] || settings.voiceName;

  chrome.tts.stop();
  chrome.tts.speak("This is a text-to-speech test.", {
    enqueue: false,
    lang: settings.lang,
    rate: settings.rate,
    pitch: settings.pitch,
    volume: settings.volume,
    ...(testVoice ? { voiceName: testVoice } : {})
  });
});

async function saveSettings() {
  const sites = controls.disabledSites.value.split(/\s+/u).filter(Boolean);
  if (sites.some((site) => !ReaderPage.domain(site))) {
    controls.disabledSites.setCustomValidity(ReaderI18n.t("invalidDomain", controls.uiLanguage.value));
    controls.disabledSites.reportValidity();
    return null;
  }
  const settings = {
    uiLanguage: controls.uiLanguage.value,
    autoDetectLanguage: controls.autoDetectLanguage.checked,
    showSelectionButton: controls.showSelectionButton.checked,
    enableSingleKeyShortcut: controls.enableSingleKeyShortcut.checked,
    disabledSites: [...new Set(sites.map(ReaderPage.domain))],
    rememberReading: controls.rememberReading.checked,
    skipCodeBlocks: controls.skipCodeBlocks.checked,
    lang: controls.lang.value,
    voiceName: controls.voiceName.value,
    ocrLanguage: controls.ocrLanguage.value,
    languageVoices: Object.fromEntries(
      languageVoiceControls.map((control) => [control.dataset.language, control.value])
    ),
    rate: Number(controls.rate.value),
    pitch: Number(controls.pitch.value),
    volume: Number(controls.volume.value)
  };

  await chrome.storage.sync.set(settings);
  return settings;
}

controls.disabledSites.addEventListener("input", () => controls.disabledSites.setCustomValidity(""));
document.getElementById("clearReadingHistory").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "clear-reading-history" });
  showStatus(ReaderI18n.t("historyCleared", controls.uiLanguage.value));
});

function applyInterfaceLanguage(language) {
  document.documentElement.lang = language;
  document.title = ReaderI18n.t("settingsTitle", language);
  ReaderI18n.apply(document, language);
}

async function populateVoices(platformOs) {
  const voices = await chrome.tts.getVoices();
  const sortedVoices = voices.sort((a, b) => (a.lang || "").localeCompare(b.lang || ""));
  for (const voice of sortedVoices) {
    const option = document.createElement("option");
    option.value = voice.voiceName;
    option.dataset.voiceSource = voice.extensionId ? "extension" : "system";
    option.dataset.voiceLabel = `${voice.voiceName}${voice.lang ? ` (${voice.lang})` : ""}`;
    option.textContent = option.dataset.voiceLabel;
    controls.voiceName.appendChild(option);

    for (const control of languageVoiceControls) {
      if (!voice.lang || voice.lang.toLowerCase().startsWith(control.dataset.language)) {
        control.appendChild(option.cloneNode(true));
      }
    }
  }
  localizeVoiceSources();
}

function localizeVoiceSources() {
  document.getElementById("systemEngine").textContent = getSystemEngineName(currentPlatformOs);
  document.querySelectorAll("option[data-voice-label]").forEach((option) => {
    const source = option.dataset.voiceSource === "extension"
      ? ReaderI18n.t("extensionVoice", controls.uiLanguage.value)
      : getSystemEngineName(currentPlatformOs);
    option.textContent = `[${source}] ${option.dataset.voiceLabel}`;
  });
}

function getSystemEngineName(platformOs) {
  if (platformOs === "win") return ReaderI18n.t("windowsSystemVoices", controls.uiLanguage.value);
  if (platformOs === "mac") return ReaderI18n.t("macosSystemVoices", controls.uiLanguage.value);
  return ReaderI18n.t("systemVoices", controls.uiLanguage.value);
}

function updateValueLabels() {
  valueLabels.rate.textContent = `${controls.rate.value}x`;
  valueLabels.pitch.textContent = controls.pitch.value;
  valueLabels.volume.textContent = `${Math.round(Number(controls.volume.value) * 100)}%`;
}

function showStatus(message) {
  statusElement.textContent = message;
  window.setTimeout(() => {
    statusElement.textContent = "";
  }, 1800);
}
