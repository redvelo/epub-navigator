import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The agent runs unprivileged in a publication realm, so what matters is that nothing large or
// privileged has been pulled into it. The build already asserts its own single output and copies
// it, and an `iife` bundle cannot emit module syntax, so neither is rechecked here.
const source = readFileSync(
  fileURLToPath(new URL("../dist/content-agent.js", import.meta.url)),
  "utf8",
);
const forbidden = [
  [/\bReact\b/u, "React"],
  [/\bWebAssembly\b/u, "WebAssembly runtime"],
  [/\.wasm\b/u, "WebAssembly asset"],
];
for (const [pattern, description] of forbidden) {
  if (pattern.test(source)) throw new Error(`content-agent.js contains ${description}`);
}
