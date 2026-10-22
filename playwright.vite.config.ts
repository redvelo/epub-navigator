import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { publicationFixtures } from "./tests/browser/fixture-server.js";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: source("./tests/browser/"),
  plugins: [react({ compiler: { logDiagnostics: true } }), tailwindcss(), publicationFixtures()],
  resolve: {
    alias: [
      { find: "epub-navigator/react.css", replacement: source("./src/react/styles.css") },
      { find: "epub-navigator/react", replacement: source("./src/react/index.ts") },
      { find: "epub-navigator/runtime", replacement: source("./src/runtime/index.ts") },
      { find: "epub-navigator/local", replacement: source("./src/local/index.ts") },
      { find: "epub-navigator", replacement: source("./src/index.ts") },
    ],
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: true,
    port: 4174,
    strictPort: true,
    fs: { allow: [source("./")] },
  },
});
