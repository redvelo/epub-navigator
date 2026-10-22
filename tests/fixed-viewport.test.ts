// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFixedViewport } from "../src/runtime/content-agent/fixed-viewport.js";
import { layoutSettlementDeadlineMs } from "../src/runtime/content-agent/layout/constants.js";
import { waitForFixedViewport } from "../src/runtime/content-agent/layout/fixed-transaction.js";
import { OperationCancelled } from "../src/runtime/content-agent/operation-queue.js";

const meta = (content: string, name = "viewport") => `<meta name="${name}" content="${content}">`;

describe("fixed XHTML viewport resolution", () => {
  it("resolves representable viewport declarations", () => {
    for (const [head, viewport] of [
      [meta("width=1200, height=1577", "VIEWPORT"), { width: 1200, height: 1577 }],
      [meta(" HEIGHT = 697 , WIDTH = 1024 "), { width: 1024, height: 697 }],
      [meta("initial-scale=1,width=.5,height=10.25"), { width: 0.5, height: 10.25 }],
      [meta("width=1000px,height=600mm"), { width: 1000, height: 600 }],
      [meta("width=600; height=800"), { width: 600, height: 800 }],
      [meta("width=600 height=800"), { width: 600, height: 800 }],
      [meta("width=1200,, height=1577"), { width: 1200, height: 1577 }],
      [meta("width=600,width=700,height=800,height=900"), { width: 600, height: 800 }],
      [meta("width=600,height=800") + meta("width=1200,height=1600"), { width: 600, height: 800 }],
    ] as const) {
      expect(resolveFixedViewport(fixedDocument(head)), head).toEqual({
        status: "resolved",
        viewport,
      });
    }
  });

  it("reports typed unavailability", () => {
    for (const [head, issue] of [
      ["", "intrinsic-viewport-missing"],
      [meta("width=600,height=800", "description"), "intrinsic-viewport-missing"],
      [meta("width=600"), "intrinsic-viewport-invalid"],
      [meta("width=0,height=800"), "intrinsic-viewport-invalid"],
      [meta("width=device-width,height=800"), "intrinsic-viewport-unsupported"],
      [meta("width=device-width,width=600,height=800"), "intrinsic-viewport-unsupported"],
      [
        meta("width=device-width,height=800") + meta("width=1200,height=1600"),
        "intrinsic-viewport-unsupported",
      ],
    ] as const) {
      expect(resolveFixedViewport(fixedDocument(head)), head).toEqual({
        status: "unavailable",
        issue,
      });
    }
  });
});

describe("fixed viewport delivery", () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
  const originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")!;
  const viewport = { width: 1674, height: 1378 };
  const size = (width: number, height: number) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  };
  const wait = (controller = new AbortController()) =>
    waitForFixedViewport(viewport, { key: "layout:1", controller });

  beforeEach(() => {
    vi.useFakeTimers();
    size(1385, 1140);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "innerWidth", originalWidth);
    Object.defineProperty(window, "innerHeight", originalHeight);
  });

  it("waits for both remote viewport dimensions after the host acknowledgement", async () => {
    const result = wait();
    size(1674, 1140);
    window.dispatchEvent(new Event("resize"));
    expect(vi.getTimerCount()).toBe(1);
    size(1674, 1378);
    window.dispatchEvent(new Event("resize"));
    await expect(result).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not manufacture a matching viewport when delivery times out", async () => {
    const result = wait();
    await vi.advanceTimersByTimeAsync(layoutSettlementDeadlineMs);
    await expect(result).resolves.toBe(false);
    expect([window.innerWidth, window.innerHeight]).toEqual([1385, 1140]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending resize delivery without leaving a timeout", async () => {
    const controller = new AbortController();
    const result = wait(controller);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(OperationCancelled);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an already applied viewport without adding an asynchronous wait", async () => {
    size(1674, 1378);
    await expect(wait()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function fixedDocument(head: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head>${head}</head><body></body></html>`,
    "text/html",
  );
}
