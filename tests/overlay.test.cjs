const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
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

test("reader windows stay visible and interactive above page overlays", async () => {
  assert.ok(browser, "Install Chrome/Chromium/Edge or set CHROME_PATH to its executable.");
  const root = path.resolve(__dirname, "..");
  const files = new Map([
    ["/", ["tests/overlay.html", "text/html"]],
    ["/content.js", ["content.js", "text/javascript"]],
    ["/i18n.js", ["i18n.js", "text/javascript"]],
    ...[16, 24, 32, 48].map((size) => [
      `/assets/icons/icon-${size}.png`, [`assets/icons/icon-${size}.png`, "image/png"]
    ])
  ]);
  const server = http.createServer(async (request, response) => {
    const file = files.get(request.url);
    if (!file) return response.writeHead(404).end();
    try {
      const content = await readFile(path.join(root, file[0]));
      response.writeHead(200, { "Content-Type": file[1] }).end(content);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const size of ["960,720", "540,360"]) {
      const profilePrefix = path.join(os.tmpdir(), "selection-reader-overlay-test-");
      const profile = await mkdtemp(profilePrefix);
      try {
        const { stdout } = await run(browser, [
          "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
          `--user-data-dir=${profile}`, `--window-size=${size}`,
          "--dump-dom", "--virtual-time-budget=5000",
          `http://127.0.0.1:${server.address().port}/`
        ], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
        const report = stdout.match(/<pre id="test-results">([\s\S]*?)<\/pre>/)?.[1];
        assert.ok(stdout.includes('data-test-status="passed"'), `${size}: ${report || stdout}`);
        console.log(`${size}: ${report}`);
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
