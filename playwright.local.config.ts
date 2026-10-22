import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { reuseExistingServer } from "./playwright.config.js";

// A separate configuration rather than an environment switch: `VAR=value command` only works in
// a POSIX shell, so the package script could not run on Windows.
const localHost: PlaywrightTestConfig = {
  testDir: "./tests/local-browser",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4176" },
  webServer: {
    command:
      "pnpm run build:wasm && pnpm run build:package && pnpm run build:reader && pnpm --dir reader exec vite preview --host 127.0.0.1 --port 4176",
    url: "http://127.0.0.1:4176",
    timeout: 120_000,
    reuseExistingServer,
  },
  projects: [{ name: "local", use: { browserName: "chromium" } }],
};

export default defineConfig(localHost);
