import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

const outputDirectory = fileURLToPath(new URL("./.generated/content-agent/", import.meta.url));
const distributionDirectory = fileURLToPath(new URL("./dist/", import.meta.url));

function copyContentAgent(): Plugin {
  return {
    name: "copy-content-agent",
    async closeBundle() {
      const outputs = await readdir(outputDirectory);
      if (outputs.length !== 1 || outputs[0] !== "content-agent.js") {
        throw new Error(`unexpected content-agent outputs: ${outputs.join(", ")}`);
      }
      await mkdir(distributionDirectory, { recursive: true });
      await copyFile(
        `${outputDirectory}content-agent.js`,
        `${distributionDirectory}content-agent.js`,
      );
    },
  };
}

export default defineConfig({
  plugins: [copyContentAgent()],
  build: {
    emptyOutDir: true,
    outDir: outputDirectory,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/runtime/content-agent.ts", import.meta.url)),
      output: {
        entryFileNames: "content-agent.js",
        format: "iife",
      },
    },
  },
});
