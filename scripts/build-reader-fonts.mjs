import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = `${root}dist/reader-fonts`;
const packages = /** @type {[string, string | null, string[]][]} */ ([
  ["@fontsource-variable/literata", "Navigator Reader Serif", ["index.css", "wght-italic.css"]],
  [
    "@fontsource-variable/atkinson-hyperlegible-next",
    "Navigator Reader Sans",
    ["index.css", "wght-italic.css"],
  ],
  ["@fontsource-variable/noto-naskh-arabic", null, ["index.css"]],
  ["@fontsource-variable/noto-serif-hebrew", null, ["index.css"]],
  ["@fontsource-variable/noto-serif-devanagari", null, ["index.css"]],
  ["@fontsource-variable/noto-serif-bengali", null, ["index.css"]],
  ["@fontsource-variable/noto-serif-tamil", null, ["index.css"]],
  ["@fontsource-variable/noto-serif-telugu", null, ["index.css"]],
]);

await rm(output, { recursive: true, force: true });
await mkdir(`${output}/files`, { recursive: true });

const styles = [];
for (const [name, alias, stylesheets] of packages) {
  const directory = `${root}node_modules/${name}`;
  const { family } = JSON.parse(await readFile(`${directory}/metadata.json`, "utf8"));
  for (const stylesheet of stylesheets) {
    let css = await readFile(`${directory}/${stylesheet}`, "utf8");
    if (alias !== null) css = css.replaceAll(`${family} Variable`, alias);
    styles.push(css);
    for (const match of css.matchAll(/\.\/files\/([^)'"\s]+)/gu)) {
      const file = match[1];
      if (file !== undefined)
        await copyFile(`${directory}/files/${file}`, `${output}/files/${file}`);
    }
  }
}

styles.push(`
:lang(ja) { font-family: "Yu Mincho", "Hiragino Mincho ProN", serif !important; }
:lang(zh-Hans) { font-family: "Songti SC", "Noto Serif CJK SC", serif !important; }
:lang(zh-Hant) { font-family: "Songti TC", "Noto Serif CJK TC", serif !important; }
:lang(ko) { font-family: "Batang", "Noto Serif CJK KR", serif !important; }
`);

await writeFile(`${output}/reader-serif.css`, styles.join("\n"));
