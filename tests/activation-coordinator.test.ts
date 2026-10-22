import { expect, it, vi } from "vitest";
import type { KernelSnapshot, KernelTransition } from "../src/generated/kernel.js";
import { ActivationCoordinatorRuntime } from "../src/runtime/navigation/activation-coordinator.js";
import type { ActivationRequest, OwnedFrame } from "../src/runtime/navigator/runtime-types.js";

it.each([
  { source: 0, linear: ["no", "yes", "yes"], expected: 2 },
  { source: 1, linear: ["no", "yes", "yes"], expected: 2 },
  { source: 3, linear: ["no", "yes", "yes"], expected: 2 },
  { source: 2, linear: ["no", "yes", "yes"], expected: 2 },
  { source: 3, linear: ["no", "no", "no"], expected: 1 },
] as const)(
  "selects hyperlink destination $expected from source $source ($linear)",
  async ({ source, linear, expected }) => {
    const resource = "EPUB/chapter.xhtml";
    const relocate = vi.fn(async () => ({}));
    const open = vi.fn();
    const command = vi.fn(
      (): KernelTransition => ({
        accepted: true,
        stateRevision: 1,
        effects: [],
        failure: null,
        events: [{ type: "document-pending", generation: 9, occurrence: expected, resource }],
      }),
    );
    const runtime = Object.assign(Object.create(ActivationCoordinatorRuntime.prototype), {
      _publication: {
        mount: { baseUrl: "https://reader.invalid/book/" },
        facts: { resources: { resources: [] } },
      },
      _kernel: {
        snapshot: () =>
          ({
            readingOrder: linear.map((linear, index) => ({
              ordinal: index + 1,
              linear,
              document: { state: "loadable", resource, adapter: "reflowable-xhtml" },
            })),
          }) as KernelSnapshot,
      },
      relocate,
      open,
      _command: command,
      subscribe: (listener: (transition: KernelTransition) => void) => {
        queueMicrotask(() =>
          listener({
            accepted: true,
            stateRevision: 2,
            effects: [],
            failure: null,
            events: [{ type: "document-committed", generation: 9, occurrence: expected, resource }],
          }),
        );
        return vi.fn();
      },
    }) as {
      _applyActivationRequest(frame: OwnedFrame, activation: ActivationRequest): Promise<void>;
    };
    const frame = {
      occurrence: source,
      resource: source === 0 ? "EPUB/start.xhtml" : resource,
    } as OwnedFrame;
    const original = { ...frame };
    await runtime._applyActivationRequest(frame, {
      href: "chapter.xhtml#repeat",
      resolvedUrl: `https://reader.invalid/book/${resource}#repeat`,
      target: null,
      download: null,
      footnote: null,
    });
    if (source === expected) expect(command).not.toHaveBeenCalled();
    else
      expect(command).toHaveBeenCalledWith({
        type: "open-occurrence-at",
        occurrence: expected,
        evidence: [{ kind: "html-fragment", value: "repeat" }],
      });
    expect(relocate).toHaveBeenCalledWith(
      expect.objectContaining({ occurrence: expected, resource }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(frame).toEqual(original);
  },
);
