import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const check = process.argv.includes("--check");
const source = new URL("../tests/fixtures/host-conformance-src/", import.meta.url);
const output = new URL("../tests/fixtures/host-conformance.epub", import.meta.url);
const notice = new URL("../tests/fixtures/host-conformance.NOTICE.md", import.meta.url);
// ZIP timestamps use local time; preserve the committed archive's wall-clock time.
const fixedDate = new Date(2026, 7, 1, 2, 0, 0);
const entries = [
  "META-INF/container.xml",
  "EPUB/package.opf",
  "EPUB/nav.xhtml",
  "EPUB/text/conformance.xhtml",
  "EPUB/styles/conformance.css",
  "EPUB/images/probe.svg",
  "EPUB/js/classic.js",
  "EPUB/js/module.js",
  "EPUB/js/module-dependency.js",
  "EPUB/js/dynamic-module.js",
  "EPUB/js/dedicated-worker.js",
  "EPUB/js/service-worker.js",
  "EPUB/data/same-origin.json",
  "EPUB/data/root-relative.json",
];

const archiveEntries = {
  mimetype: [strToU8("application/epub+zip"), { level: 0, mtime: fixedDate }],
};
for (const path of entries) {
  archiveEntries[path] = [
    new Uint8Array(await readFile(new URL(path, source))),
    { mtime: fixedDate },
  ];
}
const audioSource = await readFile(new URL("EPUB/media/silence.wav.base64", source), "utf8");
archiveEntries["EPUB/media/silence.wav"] = [
  new Uint8Array(Buffer.from(audioSource.trim(), "base64")),
  { level: 0, mtime: fixedDate },
];

const bytes = zipSync(archiveEntries, { level: 9, mtime: fixedDate });
const digest = createHash("sha256").update(bytes).digest("hex");
assertEpubMimetype(bytes);
if (check) {
  const committed = new Uint8Array(await readFile(output));
  if (!Buffer.from(committed).equals(Buffer.from(bytes))) {
    throw new Error("host-conformance.epub does not match its deterministic source");
  }
  const noticeText = await readFile(notice, "utf8");
  if (!noticeText.includes(`Generated size: ${bytes.byteLength.toLocaleString("en-US")} bytes`)) {
    throw new Error("host-conformance.NOTICE.md has a stale generated size");
  }
  if (!noticeText.includes(`SHA-256: \`${digest}\``)) {
    throw new Error("host-conformance.NOTICE.md has a stale SHA-256");
  }
} else {
  await writeFile(output, bytes);
}

console.log(`${fileURLToPath(output)} ${bytes.byteLength} bytes sha256:${digest}`);

function assertEpubMimetype(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50 || view.getUint16(8, true) !== 0) {
    throw new Error("EPUB mimetype must be the first uncompressed ZIP entry");
  }
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
  const dataStart = 30 + nameLength + extraLength;
  const data = new TextDecoder().decode(bytes.subarray(dataStart, dataStart + 20));
  if (name !== "mimetype" || data !== "application/epub+zip") {
    throw new Error("EPUB mimetype entry is invalid");
  }
}
