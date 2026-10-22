import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmDirectory = fileURLToPath(new URL("../dist/wasm/", import.meta.url));
const expectedWasm = ["epub_navigator.d.ts", "epub_navigator.js", "epub_navigator_bg.wasm"];
const actualWasm = readdirSync(wasmDirectory).sort();

if (JSON.stringify(actualWasm) !== JSON.stringify(expectedWasm)) {
  throw new Error(`unexpected packaged WASM files: ${actualWasm.join(", ")}`);
}

const declarations = readFileSync(`${wasmDirectory}epub_navigator.d.ts`, "utf8");
for (const exportName of ["WasmNavigatorKernel", "WasmPublication"]) {
  if (!declarations.includes(`export class ${exportName}`)) {
    throw new Error(`packaged WASM declarations do not export ${exportName}`);
  }
}

const workerDirectory = fileURLToPath(new URL("../dist/local/", import.meta.url));
const expectedWorkers = ["chunks", "import-worker.js", "service-worker.js"];
const actualWorkers = readdirSync(workerDirectory)
  .filter((entry) => statSync(`${workerDirectory}${entry}`).isDirectory() || entry.endsWith(".js"))
  .sort();

if (JSON.stringify(actualWorkers) !== JSON.stringify(expectedWorkers)) {
  throw new Error(`unexpected local worker outputs: ${actualWorkers.join(", ")}`);
}

// rustc records panic locations, so a wasm built without the remaps in build-navigator-wasm.mjs
// ships the build machine's home directory.
const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const buildPathMarkers = [
  "/home/",
  "/Users/",
  "/root/",
  "\\Users\\",
  ".cargo/registry",
  ".rustup/",
];

function* packagedFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) yield* packagedFiles(`${path}/`);
    else yield path;
  }
}

for (const path of packagedFiles(distDirectory)) {
  const contents = readFileSync(path, "latin1");
  for (const marker of buildPathMarkers) {
    if (contents.includes(marker)) {
      throw new Error(
        `packaged ${path.slice(distDirectory.length)} leaks the build path ${marker}`,
      );
    }
  }
}
