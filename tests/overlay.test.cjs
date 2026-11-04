const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, mkdtemp, readFile, rm } = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { test } = require("node:test");

const run = promisify(execFile);
const browser = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome"
].find((candidate) => candidate && existsSync(candidate));

test("reader overlays and highlights work across page layouts", async () => {
  assert.ok(browser, "Install Chrome/Chromium/Edge or set CHROME_PATH to its executable.");
  const root = path.resolve(__dirname, "..");
  const scripts = await Promise.all(["i18n.js", "reader-page.js", "content.js", "popup.js", "options.js"].map(async (name) =>
    [name, await readFile(path.join(root, name), "utf8")]
  ));
  const [bootstrap, uiChecks] = await Promise.all(["ui-bootstrap.js", "ui-checks.js"].map((name) => readFile(path.join(__dirname, name), "utf8")));
  const files = new Map([
    ["/", ["tests/overlay.html", "text/html"]],
    ["/highlight", ["tests/highlight.html", "text/html"]],
    ["/reader", ["tests/reader.html", "text/html"]],
    ["/popup-test", ["popup.html", "text/html"]],
    ["/options-test", ["options.html", "text/html"]],
    ["/styles.css", ["styles.css", "text/css"]],
    ["/content.js", ["content.js", "text/javascript"]],
    ["/reader-page.js", ["reader-page.js", "text/javascript"]],
    ["/i18n.js", ["i18n.js", "text/javascript"]],
    ...[16, 24, 32, 48, 64, 128].map((size) => [
      `/assets/icons/icon-${size}.png`, [`assets/icons/icon-${size}.png`, "image/png"]
    ])
  ]);
  const server = http.createServer(async (request, response) => {
    const file = files.get(request.url);
    if (!file) return response.writeHead(404).end();
    try {
      let content = await readFile(path.join(root, file[0]));
      if (file[1] === "text/html") {
        // dump-dom's virtual clock can exhaust its budget while external test
        // scripts are still loading. Keep the actual scripts in document order.
        content = content.toString("utf8");
        if (request.url === "/popup-test" || request.url === "/options-test") {
          content = content.replace("<head>", () => `<head><script>${bootstrap}</script>`);
          content = content.replace("</body>", () => `<script>${uiChecks}</script></body>`);
        }
        for (const [name, source] of scripts) {
          content = content.replace(`<script src="/${name}"></script>`, () => `<script>${source}</script>`);
          content = content.replace(`<script src="${name}"></script>`, () => `<script>${source}</script>`);
        }
      }
      response.writeHead(200, { "Content-Type": file[1] }).end(content);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const previewDirectory = path.join(root, ".test-previews");
    if (process.env.READER_TEST_SCREENSHOTS === "1") await mkdir(previewDirectory, { recursive: true });
    for (const [page, size] of ["/popup-test", "/options-test", "/reader", "/highlight", "/"].flatMap((page) =>
      ["960,720", "540,360"].map((size) => [page, size])
    )) {
      const profilePrefix = path.join(os.tmpdir(), "selection-reader-overlay-test-");
      const profile = await mkdtemp(profilePrefix);
      try {
        const { stdout } = await run(browser, [
          "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
          "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
          `--user-data-dir=${profile}`, `--window-size=${size}`,
          "--dump-dom", "--virtual-time-budget=15000",
          ...(process.env.READER_TEST_SCREENSHOTS === "1" && ["/reader", "/popup-test", "/options-test"].includes(page)
            ? [`--screenshot=${path.join(previewDirectory, `${page.slice(1)}-${size.replace(",", "x")}.png`)}`] : []),
          `http://127.0.0.1:${server.address().port}${page}`
        ], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
        const report = stdout.match(/<pre id="test-results"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
        assert.ok(stdout.includes('data-test-status="passed"'), `${page} ${size}: ${report || stdout}`);
        console.log(`${page} ${size}: ${report}`);
      } finally {
        // Delete only the unique temporary profile created by this test.
        assert.ok(path.resolve(profile).startsWith(path.resolve(profilePrefix)));
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
