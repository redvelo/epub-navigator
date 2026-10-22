// @vitest-environment jsdom

import { renderReader, FakeRuntime } from "./reader-harness.js";
import { act } from "@testing-library/react";
import { createStore } from "jotai";
import { expect, it } from "vitest";
import { annotationProjectionAtom } from "../../src/react/annotations/state.js";
import { workspaceStateAtom } from "../../src/react/workspace/state.js";

it("does not notify subscribers when an unstable host prop is equivalent", async () => {
  const runtime = new FakeRuntime();
  runtime.locate(0, 7);
  const store = createStore();
  let notifications = 0;
  store.sub(annotationProjectionAtom, () => void notifications++);
  store.sub(workspaceStateAtom, () => void notifications++);
  const props = () => ({
    store,
    annotations: { revision: 1, records: [] },
    workspaceState: {
      navigation: { open: false, pinned: false, width: 320 },
      annotations: { open: false, pinned: false, width: 320 },
    },
  });
  const { rerender } = await renderReader(props(), runtime);
  notifications = 0;
  for (let i = 0; i < 5; i++) await act(async () => rerender(props()));
  expect(notifications).toBe(0);
});
