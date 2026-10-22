import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

const crossEngineSpecs = [
  "synthetic/pagination-engines.spec.ts",
  "synthetic/resource-settlement.spec.ts",
];
const corpus = {
  testMatch: "corpus/*.spec.ts",
  timeout: 60_000,
  use: { viewport: { width: 1280, height: 900 } },
};
export const reuseExistingServer = !process.env.CI;

const fixtureHost: PlaywrightTestConfig = {
  testDir: "./tests/browser",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm run fixtures:host-conformance:check && pnpm run build:content-agent && pnpm exec vite --config playwright.vite.config.ts",
    url: "http://127.0.0.1:4174/reader/reader.html",
    // The command builds the fixture and the content agent before it serves anything, which a
    // cold or loaded machine does not finish inside the default minute.
    timeout: 180_000,
    reuseExistingServer,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ["corpus/**", "performance/**"],
      use: { browserName: "chromium" },
    },
    {
      name: "pagination-webkit",
      testMatch: crossEngineSpecs,
      use: { browserName: "webkit" },
    },
    {
      name: "pagination-performance",
      testMatch: "performance/*.spec.ts",
      // One worker, so a measurement never shares a core with another test. Serialising the file
      // through `mode: "serial"` would do that too, but then one failed budget skips the rest.
      fullyParallel: false,
      use: { browserName: "chromium" },
    },
    { name: "corpus-chromium", ...corpus, use: { ...corpus.use, browserName: "chromium" } },
    {
      name: "corpus-mobile-chromium",
      ...corpus,
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    { name: "corpus-webkit", ...corpus, use: { ...corpus.use, browserName: "webkit" } },
  ],
};

export default defineConfig(fixtureHost);
