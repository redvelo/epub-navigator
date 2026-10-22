import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function copyLocalHostArtifacts(): Plugin {
  return {
    name: "copy-local-host-artifacts",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        const file = pathname === undefined ? undefined : localArtifactPath(pathname);
        if (file === undefined) {
          next();
          return;
        }
        void readFile(file).then(
          (bytes) => {
            response.statusCode = 200;
            response.setHeader("Cache-Control", "no-store");
            response.setHeader(
              "Content-Type",
              file.endsWith(".wasm")
                ? "application/wasm"
                : file.endsWith(".css")
                  ? "text/css; charset=utf-8"
                  : file.endsWith(".woff2")
                    ? "font/woff2"
                    : "text/javascript; charset=utf-8",
            );
            response.setHeader("Content-Length", bytes.byteLength);
            response.end(bytes);
          },
          () => next(),
        );
      });
    },
    async closeBundle() {
      const source = fileURLToPath(new URL("../dist/", import.meta.url));
      const target = fileURLToPath(new URL("./dist/", import.meta.url));
      await mkdir(`${target}chunks/`, { recursive: true });
      await copyFile(`${source}content-agent.js`, `${target}content-agent.js`);
      await copyFile(`${source}local/import-worker.js`, `${target}import-worker.js`);
      await copyFile(`${source}local/service-worker.js`, `${target}service-worker.js`);
      await cp(`${source}local/chunks/`, `${target}chunks/`, { recursive: true });
      await cp(`${source}wasm/`, `${target}wasm/`, { recursive: true });
      await cp(`${source}reader-fonts/`, `${target}reader-fonts/`, { recursive: true });
      await writeMeasurementArtifactManifest(target);
    },
  };
}

async function writeMeasurementArtifactManifest(root: string): Promise<void> {
  const files = (await measurementArtifactFiles(root)).sort();
  const artifacts = await Promise.all(
    files.map(async (file) => [file, sha256(await readFile(`${root}${file}`))] as const),
  );
  const measurementArtifactDigest = sha256(Buffer.from(JSON.stringify(artifacts)));
  await writeFile(
    `${root}measurement-artifacts.json`,
    JSON.stringify({ measurementArtifactDigest, artifacts }),
  );
}

async function measurementArtifactFiles(directory: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(`${directory}${relative}`, { withFileTypes: true })) {
    const path = `${relative}${entry.name}`;
    if (entry.isDirectory()) files.push(...(await measurementArtifactFiles(directory, `${path}/`)));
    else if (/\.(?:css|js|wasm|woff2)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function localArtifactPath(pathname: string): string | undefined {
  const source = fileURLToPath(new URL("../dist/", import.meta.url));
  if (pathname === "/content-agent.js") return `${source}content-agent.js`;
  if (pathname === "/import-worker.js") return `${source}local/import-worker.js`;
  if (pathname === "/service-worker.js") return `${source}local/service-worker.js`;
  if (pathname.startsWith("/chunks/")) {
    const file = pathname.slice("/chunks/".length);
    if (isSafeArtifactName(file)) return `${source}local/chunks/${file}`;
  }
  if (pathname.startsWith("/wasm/")) {
    const file = pathname.slice("/wasm/".length);
    if (isSafeArtifactName(file)) return `${source}wasm/${file}`;
  }
  if (pathname.startsWith("/reader-fonts/")) {
    const file = pathname.slice("/reader-fonts/".length);
    if (isSafeReaderFontPath(file)) return `${source}reader-fonts/${file}`;
  }
  return undefined;
}

function isSafeArtifactName(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function isSafeReaderFontPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("..") &&
    (value === "reader-serif.css" || (value.startsWith("files/") && value.endsWith(".woff2")))
  );
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
  plugins: [react({ compiler: { logDiagnostics: true } }), tailwindcss(), copyLocalHostArtifacts()],
  resolve: {
    alias: [
      {
        find: "epub-navigator/react.css",
        replacement: fileURLToPath(new URL("../src/react/styles.css", import.meta.url)),
      },
      {
        find: "epub-navigator/react/debug",
        replacement: fileURLToPath(new URL("../src/react/debug.ts", import.meta.url)),
      },
      {
        find: "epub-navigator/react",
        replacement: fileURLToPath(new URL("../src/react/index.ts", import.meta.url)),
      },
      {
        find: "epub-navigator/runtime",
        replacement: fileURLToPath(new URL("../src/runtime/index.ts", import.meta.url)),
      },
      {
        find: "epub-navigator/local",
        replacement: fileURLToPath(new URL("../src/local/index.ts", import.meta.url)),
      },
      {
        find: "epub-navigator",
        replacement: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
});
