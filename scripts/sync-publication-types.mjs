import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
// The package's Node entry, not the `.bin` shim: Node refuses to spawn the
// Windows `.cmd` shim without a shell.
const formatter = resolve(projectDirectory, "node_modules", "oxfmt", "bin", "oxfmt");
const contracts = [
  {
    generated: fileURLToPath(new URL("../target/publication.generated.ts", import.meta.url)),
    checkedIn: fileURLToPath(new URL("../src/generated/publication.ts", import.meta.url)),
  },
  {
    generated: fileURLToPath(new URL("../target/kernel.generated.ts", import.meta.url)),
    checkedIn: fileURLToPath(new URL("../src/generated/kernel.ts", import.meta.url)),
  },
];
const formatting = spawnSync(
  process.execPath,
  [formatter, "--write", ...contracts.map(({ generated }) => generated)],
  { stdio: "inherit" },
);

if (formatting.error) {
  throw formatting.error;
}
if (formatting.status !== 0) {
  process.exit(formatting.status ?? 1);
}

if (mode === "--write") {
  for (const { generated, checkedIn } of contracts) {
    copyFileSync(generated, checkedIn);
  }
} else if (mode === "--check") {
  for (const { generated, checkedIn } of contracts) {
    if (!readFileSync(generated).equals(readFileSync(checkedIn))) {
      console.error(`Generated contracts are stale: ${checkedIn}. Run \`pnpm types:generate\`.`);
      process.exitCode = 1;
    }
  }
} else {
  console.error("Usage: node scripts/sync-publication-types.mjs --check|--write");
  process.exitCode = 2;
}
