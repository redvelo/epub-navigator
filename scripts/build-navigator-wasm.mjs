import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rustc = (...args) => execFileSync("rustc", args, { encoding: "utf8" }).trim();
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const sysroot = rustc("--print", "sysroot");
const commit = rustc("--version", "--verbose").match(/^commit-hash: (\S+)$/mu)?.[1];
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");

// rustc records panic locations in the binary, so the published wasm would otherwise carry the
// build machine's home directory and differ between a developer checkout and CI. A `rust-src`
// installation also rewrites the standard library prefix, which the last remap undoes. Cargo's
// `trim-paths` profile option does this natively but is still unstable as of Cargo 1.98.1.
const remaps = [
  `--remap-path-prefix=${root}=/epub-navigator`,
  `--remap-path-prefix=${join(cargoHome, "registry/src")}=/cargo/registry/src`,
  `--remap-path-prefix=${join(sysroot, "lib/rustlib/src/rust")}=/rustc/${commit}`,
];

execFileSync(
  "wasm-pack",
  [
    "build",
    "crates/epub-navigator",
    "--target",
    "web",
    "--out-dir",
    "../../.generated/epub-navigator",
    "--release",
    ...process.argv.slice(2),
    "--",
    "--locked",
  ],
  { cwd: root, stdio: "inherit", env: { ...process.env, CARGO_BUILD_RUSTFLAGS: remaps.join(" ") } },
);
