// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { centredBlockGeometry } from "../src/runtime/content-agent/layout/pagination-geometry.js";
import { createContentAgentState } from "../src/runtime/content-agent/state.js";

const page = { flowBlockSize: 900 };

describe("rendition:align-x-center geometry", () => {
  it("leaves the page alone until a centred extent is measured", () => {
    expect(centredBlockGeometry(createContentAgentState(), page)).toEqual({
      blockSize: 900,
      blockStart: 0,
      blockEnd: 0,
    });
  });

  it("keeps the page's block extent while centring the content inside it", () => {
    const state = createContentAgentState();
    state.layout.alignXCenterBlockExtent = 170;
    const centred = centredBlockGeometry(state, page);
    expect(centred).toEqual({ blockSize: 170, blockStart: 365, blockEnd: 365 });
    expect(centred.blockStart + centred.blockSize + centred.blockEnd).toBe(page.flowBlockSize);
  });
});
