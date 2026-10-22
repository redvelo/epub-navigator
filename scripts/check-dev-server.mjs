// The reader's development server is the only place Vite's dependency optimizer and
// jotai-devtools run; production builds compile the inspector out, so every other gate is blind
// to breakage there. Boot the server, load the page, and fail on anything it reports.
//
// Pass --full (implied by CI) to clear the optimizer cache first and check the page in a browser.
// Without it the run is a fetch-only smoke test, which still catches an optimizer failure.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const full = process.argv.includes("--full") || process.env.CI !== undefined;
const readerRoot = fileURLToPath(new URL("../reader", import.meta.url));
const READY_TIMEOUT_MS = 90_000;

const port = await freePort();
// A warm cache skips optimization entirely, which is the step that regressed, so a cached run
// could pass over a real break. CI always starts cold, so only clear it when asked.
if (full) {
  await rm(new URL("../reader/node_modules/.vite", import.meta.url), {
    recursive: true,
    force: true,
  });
}

const log = [];
// Spawned directly rather than through pnpm: a package-manager shim does not forward the
// termination signal, which leaves the server running after this process exits.
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const server = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
  cwd: readerRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => log.push(chunk));
}

let failure = null;
try {
  await waitForReady();
  await expectOk("/src/main.tsx");
  await expectOptimized("jotai-devtools");
  if (full) await checkInBrowser();
  const optimizerError = log.join("").match(/MISSING_EXPORT|Error during dependency optimization/u);
  if (optimizerError !== null) fail(`dependency optimization failed: ${optimizerError[0]}`);
} catch (cause) {
  failure = cause;
} finally {
  server.kill("SIGTERM");
}

if (failure === null) {
  process.stdout.write(`reader dev server ${full ? "served and mounted" : "served"}\n`);
} else {
  process.stderr.write(`${failure instanceof Error ? failure.message : "check failed"}\n`);
  process.stderr.write(`\n--- dev server output ---\n${log.join("")}\n`);
  process.exitCode = 1;
}

function fail(message) {
  throw new Error(message);
}

function url(path) {
  return `http://127.0.0.1:${String(port)}${path}`;
}

/** Vite holds module requests open while it optimizes, so no request may wait indefinitely. */
async function get(path, timeoutMs = 30_000) {
  try {
    return await fetch(url(path), { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not reserve a port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      fail(`dev server exited early with code ${String(server.exitCode)}`);
    }
    try {
      if ((await get("/", 5_000))?.ok === true) return;
    } catch {
      // The server is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("dev server did not become ready");
}

async function expectOk(path) {
  const response = await get(path);
  if (response === null) fail(`${path} did not respond`);
  if (!response.ok) fail(`${path} responded ${String(response.status)}`);
}

/** The optimizer writes a dependency's bundle only once it has processed it without error. */
async function expectOptimized(dependency) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await get(`/node_modules/.vite/deps/${dependency}.js`, 10_000))?.ok === true) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail(`${dependency} was never optimized`);
}

async function checkInBrowser() {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console error: ${message.text()}`);
    });
    await page.goto(url("/"), { waitUntil: "domcontentloaded" });
    // The inspector is imported lazily, so its shell appears only once that chunk resolves.
    await page
      .locator('[class*="jotai-devtools"]')
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => fail("the development atom inspector did not mount"));
    if (problems.length > 0) fail(`development page reported:\n  ${problems.join("\n  ")}`);
  } finally {
    await browser.close();
  }
}
