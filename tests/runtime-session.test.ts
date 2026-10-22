import { describe, expect, it } from "vitest";
import type { NavigatorReaderSession } from "../src/publication.js";
import { createNavigatorRuntime } from "../src/runtime/navigator/browser-runtime.js";

describe("Navigator reader sessions", () => {
  it("rejects an empty host-issued session ID before runtime setup", async () => {
    const session = { id: "" } as NavigatorReaderSession;

    await expect(
      createNavigatorRuntime({
        session,
        container: null as unknown as HTMLElement,
      }),
    ).rejects.toThrow("the Navigator reader session ID must be a non-empty string");
  });
});
