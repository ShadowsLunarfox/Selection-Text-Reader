const uiTestMessages = [];
let uiTestClosed = 0;
window.close = () => { uiTestClosed += 1; };
const uiTestSettings = { uiLanguage: "zh-CN", enableSingleKeyShortcut: true, disabledSites: [], rememberReading: true, skipCodeBlocks: true };
let uiTestBookmark = { text: "First. Second. Third.", index: 1, total: 3, url: "https://example.com/article" };
let uiTestState = { active: false, status: "error", errorCode: "speechFailed", error: "", index: 1, total: 3, rate: 1, session: 1, currentText: "Second." };
globalThis.chrome = {
  runtime: {
    getPlatformInfo: async () => ({ os: "win" }),
    onMessage: { addListener() {} },
    sendMessage: async (message) => {
      uiTestMessages.push(message);
      if (message.action === "get-reading-state") return uiTestState;
      if (message.action === "get-reading-bookmark") return uiTestBookmark;
      if (message.action === "forget-reading" || message.action === "clear-reading-history") { uiTestBookmark = null; return { cleared: true }; }
      if (message.action === "set-reading-rate") uiTestState.rate = message.rate;
      if (message.action === "seek-reading") uiTestState.index = message.index;
      if (message.action === "retry-reading" || message.action === "change-reading-voice") uiTestState = { ...uiTestState, active: true, status: "waiting", errorCode: "" };
      return uiTestState;
    }
  },
  tabs: {
    query: async () => [{ id: 1, url: "https://example.com/article" }],
    sendMessage: async (id, message) => { uiTestMessages.push(message); return { started: true, state: uiTestState }; }
  },
  storage: { sync: {
    get: async (defaults) => ({ ...defaults, ...uiTestSettings }),
    set: async (values) => { Object.assign(uiTestSettings, values); }
  } },
  tts: {
    getVoices: async () => [{ voiceName: "Test voice", lang: "en-US" }],
    stop() {}, speak: async () => {}
  }
};
