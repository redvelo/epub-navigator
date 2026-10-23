import { fileURLToPath, URL } from "node:url";
import { defineConfig, normalizePath } from "vite";

// Module ids use forward slashes on every platform, so the `external` and
// `paths` matches need the same or Windows bundles the wasm instead.
const wasmModule = normalizePath(
  fileURLToPath(new URL("./.generated/epub-navigator/epub_navigator.js", import.meta.url)),
);

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./dist/local/", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        "import-worker": fileURLToPath(new URL("./src/local/import-worker.ts", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./src/local/service-worker.ts", import.meta.url)),
      },
      external: [wasmModule],
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        paths: {
          [wasmModule]: "../wasm/epub_navigator.js",
        },
      },
    },
  },
});
