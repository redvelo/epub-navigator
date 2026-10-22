import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import initializeWasm, { WasmPublication } from "../.generated/epub-navigator/epub_navigator.js";

const corpusDirectory = new URL("../tests/fixtures/epub3-samples/", import.meta.url);
const corpus = (await readdir(corpusDirectory)).filter((entry) => entry.endsWith(".epub")).sort();
const target = new URL("media-types.json", corpusDirectory);
const check = process.argv.includes("--check");
const wasm = await readFile(
  new URL("../.generated/epub-navigator/epub_navigator_bg.wasm", import.meta.url),
);
await initializeWasm({ module_or_path: wasm });

const result = {};
for (const fileName of corpus) {
  const bytes = await readFile(new URL(fileName, corpusDirectory));
  const publication = WasmPublication.open(bytes);
  try {
    const facts = JSON.parse(publication.publicationFactsJson);
    const mediaTypes = {};
    for (const resource of facts.resources.resources) {
      if (resource.address.kind !== "local") continue;
      const declared = resource.declarations
        .map((ordinal) => facts.package.manifest.items[ordinal]?.mediaType)
        .find((value) => typeof value === "string" && value.trim().length > 0);
      if (declared !== undefined) mediaTypes[resource.address.value] = declared;
    }
    result[fileName] = Object.fromEntries(
      Object.entries(mediaTypes).sort(([left], [right]) => left.localeCompare(right)),
    );
  } finally {
    publication.free();
  }
}

const output = `${JSON.stringify(result, null, 2)}\n`;
if (check) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== output) throw new Error(`${fileURLToPath(target)} is out of date`);
} else {
  await writeFile(target, output);
}
