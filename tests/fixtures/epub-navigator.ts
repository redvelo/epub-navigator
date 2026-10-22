import { vi } from "vitest";

export const initializeWasm = vi.fn<() => Promise<unknown>>();
export const createWasmNavigatorKernel = vi.fn<(initializationJson: string) => unknown>();
export const openWasmPublication = vi.fn();

export class WasmNavigatorKernel {
  static create = createWasmNavigatorKernel;
}

export class WasmPublication {
  static open = openWasmPublication;
}

export default initializeWasm;
