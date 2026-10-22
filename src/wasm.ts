import initializeWasm, {
  type InitInput,
  WasmNavigatorKernel,
  WasmPublication,
} from "../.generated/epub-navigator/epub_navigator.js";

let initialization: Promise<unknown> | undefined;

/** Initializes the one Navigator-owned WASM module shared by local and runtime adapters. */
export function initializeNavigatorWasm(
  moduleOrPath?: InitInput | Promise<InitInput>,
): Promise<unknown> {
  initialization ??= Promise.resolve().then(() =>
    moduleOrPath === undefined
      ? initializeWasm()
      : initializeWasm({ module_or_path: moduleOrPath }),
  );
  return initialization;
}

export { WasmNavigatorKernel, WasmPublication };
