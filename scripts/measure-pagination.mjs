// Measures background pagination for EPUB files against the standalone reader's dev server.
//
//   node scripts/measure-pagination.mjs [--url http://127.0.0.1:4190] [--timeout 180]
//     [--out results.jsonl] <file.epub | directory>...
//
// Start the server first: `pnpm --dir reader exec vite --port 4190 --host 127.0.0.1`.
// The dev server records trace diagnostics on `window.__EPUB_NAVIGATOR_DIAGNOSTICS__`, which is
// where the per-run counters come from. One JSON line per book is written to stdout or --out.
// Set MEASURE_DEBUG=1 to include each book's pagination-run event log.

import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const options = { url: "http://127.0.0.1:4190", timeout: 180, out: null, inputs: [] };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--url") options.url = args[++index];
  else if (argument === "--timeout") options.timeout = Number(args[++index]);
  else if (argument === "--out") options.out = args[++index];
  else options.inputs.push(argument);
}
if (options.inputs.length === 0) {
  console.error(
    "usage: measure-pagination.mjs [--url URL] [--timeout SECONDS] [--out FILE] <epub|dir>...",
  );
  process.exit(2);
}

const files = [];
for (const input of options.inputs) {
  if ((await stat(input)).isDirectory()) {
    for (const entry of (await readdir(input)).sort()) {
      if (entry.toLowerCase().endsWith(".epub")) files.push(path.join(input, entry));
    }
  } else {
    files.push(input);
  }
}

const browser = await chromium.launch();
const lines = [];
for (const file of files) {
  const result = await measure(browser, file);
  const line = JSON.stringify(result);
  lines.push(line);
  console.log(line);
}
await browser.close();
if (options.out !== null) await writeFile(options.out, `${lines.join("\n")}\n`);

async function measure(browser, file) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const result = { file: path.basename(file), outcome: "timeout" };
  const started = Date.now();
  try {
    await page.goto(options.url);
    await page.locator('input[type="file"]').setInputFiles(file);
    const reader = page.locator("[data-pagination-coverage]").first();
    await reader.waitFor({ timeout: 60_000 });
    result.firstPageMs = Date.now() - started;
    const deadline = started + options.timeout * 1_000;
    let attributes = {};
    while (Date.now() < deadline) {
      attributes = await reader.evaluate((element) =>
        Object.fromEntries(
          [...element.attributes]
            .filter((attribute) => attribute.name.startsWith("data-pagination-"))
            .map((attribute) => [attribute.name.slice("data-pagination-".length), attribute.value]),
        ),
      );
      const coverage = attributes.coverage;
      if (coverage === "exact" || (coverage === "unavailable" && attributes.activity === "idle")) {
        result.outcome = coverage;
        break;
      }
      await page.waitForTimeout(500);
    }
    result.totalMs = Date.now() - started;
    result.measured = Number(attributes.measured ?? 0);
    result.total = Number(attributes.total ?? 0);
    Object.assign(result, await runCounters(page));
    if (process.env.MEASURE_DEBUG) {
      result.runLog = await page.evaluate(() =>
        (window.__EPUB_NAVIGATOR_DIAGNOSTICS__ ?? [])
          .filter((entry) => entry.event.type === "pagination-run")
          .map((entry) => `${Math.round(entry.at)}:${entry.event.action}:${entry.event.outcome}`),
      );
    }
  } catch (error) {
    result.outcome = "error";
    result.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  } finally {
    await context.close();
  }
  return result;
}

async function runCounters(page) {
  return page.evaluate(() => {
    const entries = window.__EPUB_NAVIGATOR_DIAGNOSTICS__ ?? [];
    const runs = entries.filter((entry) => entry.event.type === "pagination-run");
    const latest = runs.at(-1);
    const terminal = latest?.event.action === "terminal" ? latest.event : undefined;
    if (terminal !== undefined) {
      return {
        runs: runs.filter((entry) => entry.event.action === "start").length,
        pageCountAttempts: terminal.pageCountAttempts,
        timedOutOccurrences: terminal.timedOutOccurrences,
        measurementMs: Math.round(terminal.measurementMs),
        lastRunOutcome: terminal.outcome,
      };
    }
    // The run is still going: reconstruct its counters from the retained task events.
    const runStartedAt = latest?.at ?? 0;
    const tasks = entries.filter(
      (entry) =>
        entry.event.type === "controller-task" &&
        entry.event.task === "page-count" &&
        entry.at >= runStartedAt,
    );
    let attempts = 0;
    let measurementMs = 0;
    let startedAt = null;
    const timedOut = new Set();
    for (const { at, event } of tasks) {
      if (event.action === "start") {
        attempts += 1;
        startedAt = at;
      } else if (event.action !== "schedule" && startedAt !== null) {
        measurementMs += at - startedAt;
        startedAt = null;
      }
      if (event.reason === "timeout") timedOut.add(event.occurrence);
    }
    return {
      runs: runs.filter((entry) => entry.event.action === "start").length,
      pageCountAttempts: attempts,
      timedOutOccurrences: timedOut.size,
      measurementMs: Math.round(measurementMs),
      lastRunOutcome: "running",
      partial: entries.length >= 2_000,
    };
  });
}
