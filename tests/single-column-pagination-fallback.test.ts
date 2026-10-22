import { expect, it } from "vitest";
import { singleColumnPaginationFallbackRequired } from "../src/runtime/content-agent/layout/pagination-geometry.js";

const horizontal = { writingMode: "horizontal-tb", direction: "ltr" } as const;
const inaccessible = {
  flow: horizontal,
  columnsPerView: 1 as 1 | 2,
  pageCount: 1,
  hasUnpaginatedTextBlockOverflow: true,
};

it("retries only inaccessible ordinary text that did not form overflow columns", () => {
  expect(singleColumnPaginationFallbackRequired(inaccessible)).toBe(true);
  for (const healthy of [
    { hasUnpaginatedTextBlockOverflow: false },
    { columnsPerView: 2 as const },
    { pageCount: 2 },
    { flow: { writingMode: "vertical-rl", direction: "rtl" } as const },
  ]) {
    expect(singleColumnPaginationFallbackRequired({ ...inaccessible, ...healthy })).toBe(false);
  }
});
