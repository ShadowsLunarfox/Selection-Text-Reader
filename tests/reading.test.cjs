const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

async function reader({ deferSpeech = false, localData = {}, settings = {}, voices = [], activeTab = null, pageUrl = "" } = {}) {
  const intervals = new Map();
  const spoken = [];
  let now = 0;
  let timerId = 0;
  let speaking = true;
  let lastApiCall = 0;
  let speakingResponse;
  let messageHandler;
  let menuClickHandler;
  let storageChangeHandler;
  let tabActivatedHandler;
  let tabUpdatedHandler;
  let currentTab = activeTab;
  let contentPageUrl = pageUrl || activeTab?.url;
  const menus = new Map();
  const listener = { addListener() {} };
  const apiCall = () => { lastApiCall = now; };
  const context = vm.createContext({
    console, Intl, URL,
    Date: { now: () => now },
    setInterval: (callback, delay) => {
      intervals.set(++timerId, { callback, delay, next: now + delay });
      return timerId;
    },
    clearInterval: (id) => intervals.delete(id),
    chrome: {
      runtime: {
        onInstalled: listener, onStartup: listener, onMessage: { addListener: (handler) => { messageHandler = handler; } },
        sendMessage: async () => { apiCall(); }
      },
      storage: {
        sync: {
          get: async (defaults) => { apiCall(); return { ...defaults, autoDetectLanguage: false, ...settings }; },
          set: async (values) => {
            apiCall();
            const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: settings[key], newValue }]));
            Object.assign(settings, values);
            storageChangeHandler?.(changes, "sync");
          }
        },
        local: {
          get: async (defaults) => ({ ...defaults, ...localData }),
          set: async (values) => { Object.assign(localData, structuredClone(values)); }
        },
        onChanged: { addListener: (handler) => { storageChangeHandler = handler; } }
      },
      contextMenus: {
        onClicked: { addListener: (handler) => { menuClickHandler = handler; } },
        removeAll: (callback) => { menus.clear(); callback(); },
        create: (properties) => { menus.set(properties.id, { ...properties }); return properties.id; },
        update: (id, values, callback) => { apiCall(); if (menus.has(id)) Object.assign(menus.get(id), values); callback?.(); }
      },
      commands: { onCommand: listener },
      tabs: {
        query: async () => currentTab ? [currentTab] : [],
        sendMessage: async (id, message) => { apiCall(); return message.action === "get-page-url" ? { url: contentPageUrl } : undefined; },
        onActivated: { addListener: (handler) => { tabActivatedHandler = handler; } },
        onUpdated: { addListener: (handler) => { tabUpdatedHandler = handler; } }
      },
      tts: {
        getVoices: async () => voices,
        stop: apiCall, pause: apiCall, resume: apiCall,
        isSpeaking: async () => {
          apiCall();
          return speakingResponse ? speakingResponse() : speaking;
        },
        speak: (text, options) => {
          apiCall();
          return new Promise((resolve, reject) => {
            spoken.push({ text, options, resolve, reject });
            if (!deferSpeech) resolve();
          });
        }
      }
    }
  });
  vm.runInContext(source, context, { filename: "background.js" });
  await Promise.resolve();
  return {
    spoken, intervals,
    start: (text, page) => context.speakText(text, "en-US", 1, { page }),
    state: () => context.publicReadingState(),
    event: (index, type) => spoken[index].options.onEvent({ type }),
    pause: () => context.togglePause(),
    stop: () => context.stopReading(),
    skip: (offset) => context.skipReading(offset),
    seek: (index) => context.seekReading(index),
    retry: () => context.restartCurrentReading(),
    changeVoice: () => context.changeReadingVoice(),
    setRate: (rate) => context.setReadingRate(rate),
    queue: (offset) => context.getReadingQueue(offset),
    bookmark: (url) => context.getReadingBookmark(url),
    resume: (url) => context.resumeSavedReading(url, 1),
    forget: (url) => context.forgetReadingBookmark(url),
    clear: () => context.clearReadingBookmarks(),
    menus,
    initMenus: async () => { context.createContextMenu(); await context.refreshActiveSiteMenu(); },
    refreshMenu: () => context.refreshActiveSiteMenu(),
    clickMenu: (info, tab = currentTab) => menuClickHandler(info, tab),
    changeSettings: (values) => context.chrome.storage.sync.set(values),
    activate: (tab, url = tab?.url) => { currentTab = tab; contentPageUrl = url; return tabActivatedHandler({ tabId: tab?.id }); },
    navigate: (tab) => { currentTab = tab; contentPageUrl = tab.url; return tabUpdatedHandler(tab.id, { url: tab.url, status: "complete" }, tab); },
    message: (payload) => new Promise((resolve) => {
      if (messageHandler(payload, { tab: { id: 1, url: "https://example.com/article" } }, resolve) !== true) resolve(undefined);
    }),
    setSpeaking: (value) => { speaking = value; },
    setSpeakingResponse: (value) => { speakingResponse = value; },
    idleTime: () => now - lastApiCall,
    tick: async (duration = 5000) => {
      const until = now + duration;
      while (intervals.size) {
        const next = Math.min(...[...intervals.values()].map((timer) => timer.next));
        if (next > until) break;
        now = next;
        for (const timer of [...intervals.values()]) {
          if (timer.next === next) {
            timer.next += timer.delay;
            await timer.callback();
          }
        }
      }
      now = until;
    }
  };
}

test("long articles advance through every speech chunk without losing text", async () => {
  const r = await reader();
  const text = Array.from({ length: 500 }, (_, index) =>
    `Paragraph ${index}. ` + "A long section without sentence punctuation ".repeat(10)
  ).join("\n\n");
  await r.start(text);
  const total = r.state().total;
  assert.ok(total > 1000);
  for (let index = 0; index < total; index++) {
    assert.equal(r.state().index, index);
    assert.equal(r.spoken.length, index + 1);
    r.event(index, "end");
  }
  assert.equal(r.state().active, false);
  assert.equal(r.spoken.map((chunk) => chunk.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  assert.equal(r.intervals.size, 0);
});

test("a finished utterance without an end event still advances", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  r.event(0, "start");
  r.setSpeaking(false);
  await r.tick(10000);
  assert.equal(r.spoken.length, 2);
  assert.equal(r.spoken[1].text, "Second sentence.");
  r.event(1, "end");
  assert.equal(r.state().active, false);
  assert.equal(r.intervals.size, 0);
});

test("a long utterance keeps its worker active and is never skipped while speaking", async () => {
  const r = await reader();
  await r.start("A long sentence. Next sentence.");
  for (let time = 0; time < 120000; time += 5000) {
    await r.tick();
    assert.ok(r.idleTime() < 30000, "Worker could expire while waiting for the engine");
    assert.equal(r.spoken.length, 1);
    assert.equal(r.state().index, 0);
  }
  r.event(0, "end");
  assert.equal(r.spoken.length, 2);
  r.stop();
  assert.equal(r.intervals.size, 0);
});

test("late terminal callbacks and promise failures cannot change the next chunk", async () => {
  const r = await reader({ deferSpeech: true });
  await r.start("First sentence. Second sentence. Third sentence.");
  r.event(0, "end");
  r.event(0, "end");
  r.event(0, "interrupted");
  r.spoken[0].reject(new Error("Late failure from the previous utterance"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(r.state().active, true);
  assert.equal(r.state().index, 1);
  assert.equal(r.spoken.length, 2);
  r.stop();
});

test("paused reading is preserved, including an end event arriving during pause", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  r.event(0, "start");
  r.pause();
  r.setSpeaking(false);
  await r.tick(60000);
  assert.equal(r.state().paused, true);
  assert.equal(r.state().index, 0);
  assert.equal(r.spoken.length, 1);
  assert.ok(r.idleTime() < 30000);
  r.event(0, "end");
  assert.equal(r.spoken.length, 1, "Next chunk started while paused");
  r.pause();
  assert.equal(r.spoken.length, 2);
  assert.equal(r.spoken[1].text, "Second sentence.");
  r.event(1, "end");
  assert.equal(r.intervals.size, 0);
});

test("a transient engine failure retries the same chunk once without skipping text", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  r.event(0, "error");
  assert.equal(r.spoken.length, 2);
  assert.equal(r.spoken[1].text, "First sentence.");
  r.event(1, "end");
  assert.equal(r.spoken[2].text, "Second sentence.");
  r.event(2, "error");
  r.event(3, "error");
  assert.equal(r.state().active, false, "Repeated errors must terminate rather than loop indefinitely");
  assert.equal(r.intervals.size, 0);
});

test("stopping or replacing reading invalidates pending engine state checks", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  r.event(0, "start");
  let resolve;
  r.setSpeakingResponse(() => new Promise((done) => { resolve = done; }));
  const pending = r.tick();
  r.stop();
  resolve(false);
  await pending;
  assert.equal(r.state().active, false);
  assert.equal(r.spoken.length, 1);
  assert.equal(r.intervals.size, 0);
  r.setSpeakingResponse(null);
  await r.start("New reading. New next sentence.");
  r.event(0, "end");
  assert.equal(r.state().index, 0);
  assert.equal(r.spoken.at(-1).text, "New reading.");
  r.stop();
});

test("slow engine startup is not mistaken for the end of an utterance", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  r.setSpeaking(false);
  await r.tick(15000);
  assert.equal(r.spoken.length, 1);
  r.setSpeaking(true);
  await r.tick();
  r.setSpeaking(false);
  await r.tick(10000);
  assert.equal(r.spoken.length, 2);
  r.stop();
});

test("an engine that never starts retries the current text rather than skipping it", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  r.setSpeaking(false);
  await r.tick(35000);
  assert.equal(r.spoken.length, 2);
  assert.equal(r.spoken[1].text, "First sentence.");
  assert.equal(r.state().index, 0);
  await r.tick(35000);
  assert.equal(r.state().active, false);
  assert.equal(r.spoken.length, 2, "A broken engine must not retry indefinitely");
  assert.equal(r.intervals.size, 0);
});

test("skipping between chunks ignores old callbacks and keeps missing-end recovery", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence. Third sentence.");
  r.skip(1);
  r.event(0, "end");
  assert.equal(r.spoken[1].text, "Second sentence.");
  assert.equal(r.state().index, 1);
  r.skip(-1);
  r.event(1, "interrupted");
  assert.equal(r.state().active, true);
  assert.equal(r.spoken[2].text, "First sentence.");
  r.event(2, "start");
  r.setSpeaking(false);
  await r.tick(10000);
  assert.equal(r.spoken[3].text, "Second sentence.");
  assert.equal(r.intervals.size, 1, "Skipping must not start duplicate monitors");
  r.stop();
  assert.equal(r.intervals.size, 0);
});

test("speech failures retain the failed sentence and allow manual retry or a compatible voice", async () => {
  const r = await reader({ voices: [
    { voiceName: "English A", lang: "en-US", eventTypes: ["end"] },
    { voiceName: "Chinese", lang: "zh-CN", eventTypes: ["end"] },
    { voiceName: "English B", lang: "en-GB", eventTypes: ["end"] }
  ] });
  await r.start("First sentence. Second sentence. Third sentence.");
  r.event(0, "end");
  r.event(1, "error");
  assert.equal(r.state().status, "retrying");
  r.event(2, "error");
  assert.equal(r.state().index, 1);
  assert.equal(r.state().status, "error");
  r.retry();
  assert.equal(r.spoken.at(-1).text, "Second sentence.");
  assert.equal(r.state().status, "waiting");
  await r.changeVoice();
  assert.equal(r.spoken.at(-1).options.voiceName, "English A");
  await r.changeVoice();
  assert.equal(r.spoken.at(-1).options.voiceName, "English B");
  r.stop();
});

test("speed changes apply to the next sentence without interrupting the current one", async () => {
  const r = await reader();
  await r.start("First sentence. Second sentence.");
  await r.setRate(1.5);
  assert.equal(r.spoken.length, 1);
  assert.equal(r.spoken[0].options.rate, 1);
  assert.equal(r.state().rate, 1.5);
  r.event(0, "end");
  assert.equal(r.spoken[1].options.rate, 1.5);
  r.stop();
});

test("absolute seeking and paginated sentence lists preserve repeated sentence offsets", async () => {
  const r = await reader();
  await r.start(Array.from({ length: 90 }, () => "Same sentence.").join(" "));
  assert.equal(r.queue(40).chunks.length, 40);
  assert.equal(r.queue(80).chunks.length, 10);
  r.seek(61);
  assert.equal(r.state().index, 61);
  assert.equal(r.state().sourceOffset, "Samesentence.".length * 61);
  r.event(0, "end");
  assert.equal(r.state().index, 61);
  r.stop();
});

test("bookmarks survive worker restart and resume only after an explicit request", async () => {
  const localData = {};
  const url = "https://example.com/article#one";
  const r = await reader({ localData });
  await r.start("First sentence. Second sentence. Third sentence.", { url, title: "Article", source: "selection" });
  r.event(0, "end");
  r.stop();
  assert.equal((await r.bookmark(url)).index, 1);
  assert.equal(await r.bookmark("https://example.com/article#two"), null);
  const restarted = await reader({ localData });
  assert.equal(restarted.spoken.length, 0);
  assert.equal((await restarted.bookmark(url)).index, 1);
  await restarted.resume(url);
  assert.equal(restarted.spoken[0].text, "Second sentence.");
  restarted.event(0, "end");
  restarted.event(1, "end");
  assert.equal(await restarted.bookmark(url), null, "Completed articles must not keep stale progress");
});

test("saved reading can be cleared, forgotten, and disabled", async () => {
  const localData = {};
  const r = await reader({ localData });
  await r.start("First sentence. Second sentence.", { url: "https://example.com/a" });
  r.stop();
  assert.ok(await r.bookmark("https://example.com/a"));
  await r.forget("https://example.com/a");
  assert.equal(await r.bookmark("https://example.com/a"), null);
  await r.start("Another sentence.", { url: "https://example.com/b" });
  r.stop();
  await r.clear();
  assert.equal(await r.bookmark("https://example.com/b"), null);
  const disabled = await reader({ localData, settings: { rememberReading: false } });
  await disabled.start("Do not save this.", { url: "https://example.com/private" });
  disabled.stop();
  assert.equal(await disabled.bookmark("https://example.com/private"), null);
});

test("bookmark storage keeps the most recent twenty pages", async () => {
  const r = await reader();
  for (let index = 0; index < 22; index++) {
    await r.start("Unfinished article.", { url: `https://example.com/${index}` });
    r.stop();
  }
  assert.equal(await r.bookmark("https://example.com/0"), null);
  assert.ok(await r.bookmark("https://example.com/21"));
});

test("stop cancels speech that is still preparing and a pending bookmark resume", async () => {
  const localData = {};
  const r = await reader({ localData });
  const preparing = r.start("Do not start after stopping.");
  r.stop();
  await preparing;
  assert.equal(r.spoken.length, 0);
  assert.equal(r.state().active, false);
  await r.start("Saved sentence. Next sentence.", { url: "https://example.com/saved" });
  r.stop();
  await r.bookmark("https://example.com/saved");
  const resuming = r.resume("https://example.com/saved");
  r.stop();
  await resuming;
  assert.equal(r.spoken.length, 1);
  assert.equal(r.state().active, false);
});

test("player message actions reach speech control, queues, and persisted reading", async () => {
  const r = await reader();
  const response = await r.message({ action: "speak-text", text: "First sentence. Second sentence." });
  assert.equal(response.started, true);
  assert.equal((await r.message({ action: "set-reading-rate", rate: 1.25 })).rate, 1.25);
  assert.equal((await r.message({ action: "seek-reading", index: 1 })).index, 1);
  assert.equal((await r.message({ action: "get-reading-queue", offset: 0 })).chunks.length, 2);
  const stopped = await r.message({ action: "stop-reading" });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.status, "stopped");
  assert.equal((await r.message({ action: "get-reading-bookmark", url: "https://example.com/article" })).index, 1);
  assert.equal((await r.message({ action: "resume-reading", url: "https://example.com/article" })).active, true);
  r.stop();
});

test("the same context menu item blocks and unblocks the current site", async () => {
  const settings = { disabledSites: ["unrelated.net"], uiLanguage: "zh-CN" };
  const r = await reader({ settings, activeTab: { id: 1, url: "https://example.com/article", active: true } });
  await r.initMenus();
  assert.ok(r.menus.has("toggle-reading"));
  assert.equal(r.menus.get("toggle-site-block").title, "屏蔽此网站");
  await r.start("Reading is still allowed.");
  await r.clickMenu({ menuItemId: "toggle-site-block", pageUrl: "https://example.com/article" });
  assert.equal(settings.disabledSites.join(","), "unrelated.net,example.com");
  assert.equal(r.menus.get("toggle-site-block").title, "解除屏蔽此网站");
  assert.equal(r.state().active, true, "Blocking automatic activation must not toggle the reading menu action");
  await r.clickMenu({ menuItemId: "toggle-site-block", pageUrl: "https://example.com/article" });
  assert.equal(settings.disabledSites.join(","), "unrelated.net");
  assert.equal(r.menus.get("toggle-site-block").title, "屏蔽此网站");
  r.stop();
});

test("unblocking removes matching inherited rules and preserves unrelated domains", async () => {
  const settings = { disabledSites: ["*.example.com", "https://www.example.com/", "other.net"] };
  const r = await reader({ settings, activeTab: { id: 1, url: "https://www.example.com/post", active: true } });
  await r.initMenus();
  assert.equal(r.menus.get("toggle-site-block").title, "Unblock this site");
  await r.clickMenu({ menuItemId: "toggle-site-block", pageUrl: "https://www.example.com/post", linkUrl: "https://linked-site.net", frameUrl: "https://frame.net" });
  assert.equal(settings.disabledSites.join(","), "other.net");
  assert.equal(r.menus.get("toggle-site-block").title, "Block this site");
});

test("site menu follows tab activation, navigation, settings, and interface language", async () => {
  const r = await reader({ settings: { disabledSites: ["example.com"] }, activeTab: { id: 1, url: "https://example.com", active: true } });
  await r.initMenus();
  assert.equal(r.menus.get("toggle-site-block").title, "Unblock this site");
  await r.activate({ id: 2, url: "https://other.net", active: true });
  assert.equal(r.menus.get("toggle-site-block").title, "Block this site");
  await r.changeSettings({ disabledSites: ["example.com", "other.net"], uiLanguage: "zh-CN" });
  await r.refreshMenu();
  assert.equal(r.menus.get("toggle-site-block").title, "解除屏蔽此网站");
  await r.navigate({ id: 2, url: "https://new.net/article", active: true });
  assert.equal(r.menus.get("toggle-site-block").title, "屏蔽此网站");
});

test("site menu can read the current URL from the page without the tabs permission", async () => {
  const settings = { disabledSites: ["example.com"] };
  const r = await reader({ settings, activeTab: { id: 1, active: true }, pageUrl: "https://example.com/article" });
  await r.initMenus();
  assert.equal(r.menus.get("toggle-site-block").title, "Unblock this site");
  await r.clickMenu({ menuItemId: "toggle-site-block", pageUrl: "https://example.com/article" });
  assert.equal(settings.disabledSites.length, 0);
  assert.equal(r.menus.get("toggle-site-block").title, "Block this site");
});

test("restricted page URLs cannot be added to the site block list", async () => {
  const settings = { disabledSites: ["example.com"] };
  const r = await reader({ settings, activeTab: { id: 1, url: "chrome://settings", active: true } });
  await r.initMenus();
  assert.equal(r.menus.get("toggle-site-block").enabled, false);
  await r.clickMenu({ menuItemId: "toggle-site-block", pageUrl: "chrome://settings" });
  assert.equal(settings.disabledSites.join(","), "example.com");
});
