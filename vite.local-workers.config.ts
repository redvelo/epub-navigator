import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const wasmModule = fileURLToPath(
  new URL("./.generated/epub-navigator/epub_navigator.js", import.meta.url),
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
