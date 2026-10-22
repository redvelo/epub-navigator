import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import dts from "vite-plugin-dts";

const wasmBindings = [
  {
    source: "./.generated/epub-navigator/",
    module: "epub_navigator.js",
    files: ["epub_navigator.js", "epub_navigator.d.ts", "epub_navigator_bg.wasm"],
  },
] as const;

const reactExternals = [
  "react-dom",
  "@base-ui/react",
  "class-variance-authority",
  "clsx",
  "jotai",
  "jotai-effect",
  "lucide-react",
  "tailwind-merge",
] as const;

/**
 * Publishes the Tailwind theme source. `dist/react.css` is compiled output, so a host that runs
 * its own Tailwind cannot read the tokens or the dark variant from it.
 */
function copyThemeSource(): Plugin {
  return {
    name: "copy-theme-source",
    async closeBundle() {
      await copyFile(
        fileURLToPath(new URL("./src/react/theme.css", import.meta.url)),
        fileURLToPath(new URL("./dist/theme.css", import.meta.url)),
      );
    },
  };
}

function copyWasmBinding(): Plugin {
  return {
    name: "copy-wasm-bindings",
    async closeBundle() {
      const outputDirectory = fileURLToPath(new URL("./dist/wasm/", import.meta.url));
      await mkdir(outputDirectory, { recursive: true });
      await Promise.all(
        wasmBindings.flatMap(({ source, files }) => {
          const sourceDirectory = fileURLToPath(new URL(source, import.meta.url));
          return files.map((file) =>
            copyFile(`${sourceDirectory}${file}`, `${outputDirectory}${file}`),
          );
        }),
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react({ compiler: { logDiagnostics: true } }),
    tailwindcss(),
    dts({ include: ["src"] }),
    copyWasmBinding(),
    copyThemeSource(),
  ],
  build: {
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        local: fileURLToPath(new URL("./src/local/index.ts", import.meta.url)),
        runtime: fileURLToPath(new URL("./src/runtime/index.ts", import.meta.url)),
        react: fileURLToPath(new URL("./src/react/index.ts", import.meta.url)),
        "react-debug": fileURLToPath(new URL("./src/react/debug.ts", import.meta.url)),
        ui: fileURLToPath(new URL("./src/ui/index.ts", import.meta.url)),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: "react",
    },
    rollupOptions: {
      external: (id) =>
        id === "react" ||
        id.startsWith("react/") ||
        reactExternals.some((dependency) => id === dependency || id.startsWith(`${dependency}/`)) ||
        wasmBindings.some(({ module }) => id.includes(module)),
      output: {
        paths: (id) => {
          const binding = wasmBindings.find(({ module }) => id.includes(module));
          return binding === undefined ? id : `./wasm/${binding.module}`;
        },
      },
    },
  },
});
