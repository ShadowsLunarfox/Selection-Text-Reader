(async () => {
  const results = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const check = async (name, action) => {
    try { await action(); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${error.stack || error}`); }
  };
  await pause();
  if (location.pathname === "/popup-test") {
    await check("popup shows localized errors and saved progress", () => {
      assert(document.querySelector("#popupStatus").textContent.includes("语音失败"), "Speech error is missing");
      assert(!document.querySelector("#savedReading").hidden, "Bookmark offer is missing");
      assert(document.querySelector("#continueButton").textContent === "继续朗读", "Bookmark action is not localized");
    });
    await check("popup routes article, paragraph, recovery, speed, and seek actions", async () => {
      for (const [id, action] of [["articleButton", "read-article"], ["paragraphButton", "pick-reading-paragraph"], ["continueButton", "resume-page-reading"], ["repeatButton", "retry-reading"], ["changeVoiceButton", "change-reading-voice"]]) {
        document.getElementById(id).click();
        await pause();
        assert(uiTestMessages.some((message) => message.action === action), `${id} did not send ${action}`);
      }
      assert(uiTestClosed === 1, "Paragraph picking did not return to the page");
      const rate = document.querySelector("#readingRate");
      rate.value = "1.5";
      rate.dispatchEvent(new Event("change"));
      await pause();
      assert(uiTestState.rate === 1.5, "Popup speed is not connected");
      const seek = document.querySelector("#readingSeek");
      seek.value = "2";
      seek.dispatchEvent(new Event("change"));
      await pause();
      assert(uiTestState.index === 2, "Popup seek is not connected");
    });
    await check("popup saves per-site and code preferences and forgets progress", async () => {
      const site = document.querySelector("#siteEnabled");
      site.checked = false;
      site.dispatchEvent(new Event("change"));
      await pause();
      assert(uiTestSettings.disabledSites.includes("example.com"), "Site preference was not saved");
      document.querySelector("#forgetButton").click();
      await pause();
      assert(document.querySelector("#savedReading").hidden, "Forgotten bookmark remains visible");
    });
  } else {
    await check("settings save shortcut, site, bookmark and code preferences", async () => {
      document.querySelector("#enableSingleKeyShortcut").checked = false;
      document.querySelector("#rememberReading").checked = false;
      document.querySelector("#skipCodeBlocks").checked = false;
      document.querySelector("#disabledSites").value = "*.facebook.com\nhttps://github.com/";
      document.querySelector("#settingsForm").requestSubmit();
      await pause();
      assert(uiTestSettings.enableSingleKeyShortcut === false, "Single-key preference was not saved");
      assert(uiTestSettings.rememberReading === false && uiTestSettings.skipCodeBlocks === false, "Reading preferences were not saved");
      assert(uiTestSettings.disabledSites.join(",") === "facebook.com,github.com", "Site list was not normalized");
    });
    await check("saved reading can be cleared from settings", async () => {
      document.querySelector("#clearReadingHistory").click();
      await pause();
      assert(uiTestMessages.some((message) => message.action === "clear-reading-history"), "Clear action was not connected");
      assert(document.querySelector("#status").textContent.includes("清除"), "Clear status is missing");
    });
  }
  const report = document.createElement("pre");
  report.id = "test-results";
  report.textContent = results.join("\n");
  report.style.cssText = "font-size:10px;white-space:pre-wrap";
  document.body.appendChild(report);
  document.documentElement.dataset.testStatus = results.some((result) => result.startsWith("FAIL")) ? "failed" : "passed";
})().catch((error) => {
  const report = document.createElement("pre");
  report.id = "test-results";
  report.textContent = error.stack;
  document.body.appendChild(report);
  document.documentElement.dataset.testStatus = "failed";
});
