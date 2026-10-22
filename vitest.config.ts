import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react({ compiler: { logDiagnostics: true } })],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/corpus-projection.integration.test.ts"],
  },
  resolve: {
    alias: [
      {
        find: "../.generated/epub-navigator/epub_navigator.js",
        replacement: source("./tests/fixtures/epub-navigator.ts"),
      },
      // The reader app under test imports the package by its published specifiers, which resolve
      // through `dist`. Reading them from source instead keeps a unit test from requiring a build,
      // and the matches are anchored so that `epub-navigator/react` cannot swallow its subpaths.
      { find: /^epub-navigator\/react\.css$/u, replacement: source("./src/react/styles.css") },
      { find: /^epub-navigator\/react\/debug$/u, replacement: source("./src/react/debug.ts") },
      { find: /^epub-navigator\/react$/u, replacement: source("./src/react/index.ts") },
      { find: /^epub-navigator\/runtime$/u, replacement: source("./src/runtime/index.ts") },
      { find: /^epub-navigator\/local$/u, replacement: source("./src/local/index.ts") },
      { find: /^epub-navigator$/u, replacement: source("./src/index.ts") },
    ],
  },
});
