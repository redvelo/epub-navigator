import { describe, expect, it, vi } from "vitest";
import type { MountedPublication, PublicationFacts } from "../src/index.js";

const facts = {
  package: {},
  navigation: null,
  resources: {
    packagePath: "EPUB/package.opf",
    resources: [],
    declarations: [],
    readingOrder: [],
    selections: {},
  },
  navigationLoading: {},
  navigationTargets: [],
} as unknown as PublicationFacts;

const publication = {
  facts,
  mount: {
    baseUrl: "https://reader.example/publications/book/",
    remoteResources: "blocked",
    contentOrigin: "shared-reader-origin",
  },
} satisfies MountedPublication;

const snapshot = { stateRevision: 0, session: "open", readingOrder: [] };
const closed = { accepted: true, stateRevision: 1, events: [{ type: "closed" }], effects: [] };
const invalidCommand = expect.objectContaining({
  failure: expect.objectContaining({ code: "invalid-command" }),
});

async function load() {
  vi.resetModules();
  const wasm = await import("./fixtures/epub-navigator");
  const [{ openLocalPublication }, { createNavigatorKernel }] = await Promise.all([
    import("../src/local/publication.js"),
    import("../src/runtime/kernel.js"),
  ]);
  return { ...wasm, openLocalPublication, createNavigatorKernel };
}

describe("Navigator WASM kernel boundary", () => {
  it("initializes the shared module once for concurrent local and kernel allocations", async () => {
    const wasm = await load();
    const freePublication = vi.fn();
    const freeKernel = vi.fn();
    wasm.initializeWasm.mockResolvedValue(undefined);
    wasm.openWasmPublication.mockReturnValue({
      publicationFactsJson: JSON.stringify(facts),
      readResource: vi.fn(),
      free: freePublication,
    });
    wasm.createWasmNavigatorKernel.mockReturnValue({
      snapshotJson: JSON.stringify(snapshot),
      dispatchJson: vi.fn(() => JSON.stringify(closed)),
      free: freeKernel,
    });

    const [local, first, second] = await Promise.all([
      wasm.openLocalPublication(new Uint8Array()),
      wasm.createNavigatorKernel(publication),
      wasm.createNavigatorKernel(publication),
    ]);

    expect(wasm.initializeWasm).toHaveBeenCalledOnce();
    expect(wasm.openWasmPublication).toHaveBeenCalledOnce();
    expect(wasm.createWasmNavigatorKernel).toHaveBeenCalledTimes(2);
    expect(JSON.parse(wasm.createWasmNavigatorKernel.mock.calls[0]![0])).toEqual(publication);
    expect(first.snapshot()).toEqual(snapshot);
    first.close();
    second.close();
    expect(() => local.readResource("EPUB/chapter.xhtml")).not.toThrow();
    local.close();
    expect(freeKernel).toHaveBeenCalledTimes(2);
    expect(freePublication).toHaveBeenCalledOnce();
  });

  it("serializes commands and closes exactly once", async () => {
    const wasm = await load();
    const dispatchJson = vi.fn((inputJson: string) => {
      const { type } = JSON.parse(inputJson).command;
      if (type === "unknown") throw new Error("unknown variant");
      return JSON.stringify(
        type === "close"
          ? closed
          : { accepted: true, stateRevision: 0, events: [], effects: [], failure: null },
      );
    });
    const free = vi.fn();
    wasm.initializeWasm.mockResolvedValue(undefined);
    wasm.createWasmNavigatorKernel.mockReturnValue({
      snapshotJson: JSON.stringify(snapshot),
      dispatchJson,
      free,
    });
    const kernel = await wasm.createNavigatorKernel(publication);
    const locator = {
      kind: "point" as const,
      occurrence: 0,
      resource: "EPUB/chapter.xhtml",
      evidence: [{ kind: "document-boundary" as const, boundary: "start" as const }],
      observation: { layoutProgression: 0, renderedTextProgression: null },
    };
    const validate = { type: "command", command: { type: "validate-locator", locator } } as const;

    expect(kernel.dispatch(validate).accepted).toBe(true);
    expect(JSON.parse(dispatchJson.mock.calls[0]![0])).toEqual(validate);
    expect(() =>
      kernel.dispatch({
        type: "command",
        command: {
          type: "validate-locator",
          locator: { ...locator, observation: { ...locator.observation, layoutProgression: NaN } },
        },
      }),
    ).toThrowError(invalidCommand);
    expect(() =>
      kernel.dispatch({ type: "command", command: { type: "unknown" } } as never),
    ).toThrowError(invalidCommand);

    expect(kernel.close()).toMatchObject(closed);
    expect(kernel.close()).toMatchObject(closed);
    expect(dispatchJson).toHaveBeenCalledTimes(3);
    expect(free).toHaveBeenCalledOnce();
    expect(() => kernel.snapshot()).toThrowError(
      expect.objectContaining({ failure: expect.objectContaining({ code: "kernel-closed" }) }),
    );
  });

  it("shares and retains one terminal initialization failure across both adapters", async () => {
    const wasm = await load();
    wasm.initializeWasm.mockRejectedValue(new Error("combined module failed"));

    const [local, kernel] = await Promise.allSettled([
      wasm.openLocalPublication(new Uint8Array()),
      wasm.createNavigatorKernel(publication),
    ]);

    expect(local).toMatchObject({
      status: "rejected",
      reason: {
        failure: { code: "local-runtime-initialization-failed", message: "combined module failed" },
      },
    });
    expect(kernel).toMatchObject({
      status: "rejected",
      reason: {
        failure: {
          code: "kernel-runtime-initialization-failed",
          message: "combined module failed",
        },
      },
    });
    await expect(wasm.createNavigatorKernel(publication)).rejects.toMatchObject({
      failure: { code: "kernel-runtime-initialization-failed" },
    });
    await expect(wasm.openLocalPublication(new Uint8Array())).rejects.toMatchObject({
      failure: { code: "local-runtime-initialization-failed" },
    });
    expect(wasm.initializeWasm).toHaveBeenCalledOnce();
    expect(wasm.openWasmPublication).not.toHaveBeenCalled();
    expect(wasm.createWasmNavigatorKernel).not.toHaveBeenCalled();
  });
});
