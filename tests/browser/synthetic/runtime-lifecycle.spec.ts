import { expect, test as base, type Request } from "@playwright/test";

type Harness = Window["runtimeLifecycle"];
type Run = <K extends keyof Harness>(
  step: K,
  ...args: Parameters<Harness[K]>
) => Promise<Awaited<ReturnType<Harness[K]>>>;

const test = base.extend<{
  preparation: boolean;
  open: boolean;
  run: Run;
  opened: Awaited<ReturnType<Harness["openFirst"]>>;
}>({
  preparation: [false, { option: true }],
  open: [true, { option: true }],
  run: async ({ page }, provide) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.goto("/synthetic/runtime-lifecycle.html");
    await expect(page.locator("#result")).toHaveAttribute("data-state", "ready", {
      timeout: 45_000,
    });
    await provide(((step: keyof Harness, ...args: unknown[]) =>
      page.evaluate(
        ([name, values]) =>
          (window.runtimeLifecycle[name] as (...values: unknown[]) => unknown)(...values),
        [step, args] as const,
      )) as Run);
    expect(pageErrors).toEqual([]);
  },
  opened: [
    async ({ run, preparation, open }, provide) => {
      if (!open) return provide(null as never);
      await run("start", preparation);
      await provide(await run("openFirst"));
    },
    { auto: true },
  ],
});

const probe = "epub/text/milestone-1.xhtml";

test("commits the first document through an isolated pending frame", async ({ run, opened }) => {
  expect(opened.first).toMatchObject(committedDocument(1, 20, probe, 1));
  expect(opened.pendingFrameState).toEqual({
    hidden: false,
    position: "relative",
    width: 640,
    height: 480,
    opacity: "0",
    inert: true,
    tabIndex: -1,
    ariaHidden: "true",
  });
  expect(opened.committedFrameState).toEqual({
    title: "Publication content",
    sandbox: "allow-scripts allow-same-origin",
    allow: "",
    colorScheme: "light",
    position: "absolute",
    opacity: "",
    inert: false,
    tabIndexAttribute: null,
    ariaHidden: null,
  });
  expect(opened.sharedContentDocument).toBe(true);
  expect(opened.unrelatedAndWrongPhaseIgnored).toBe(true);
  expect(await run("close")).toEqual({ frames: 0, stacks: 0 });
});

test("runs publisher scripts against path-preserving resources", async ({ run }) => {
  expect(await run("publisher")).toMatchObject({
    authoredStylesheet: "../css/milestone-1.css",
    authoredImage: "../images/titlepage.svg",
    authoredMedia: "../media/milestone-2.mp3",
    resolvedMedia: "http://127.0.0.1:4174/publications/alice/epub/media/milestone-2.mp3",
    imageLoaded: true,
    fontLoaded: true,
    computedColor: "rgb(12, 34, 56)",
    externalScriptRan: true,
    readingSystem: true,
    durableStorageAvailable: true,
    remoteConnectionBlocked: true,
    unsafeRouteStatus: 400,
  });
});

test("resolves and relocates locators and annotation targets", async ({ run }) => {
  const value = await run("locators");
  const resolved = (operation: number) => ({
    outcome: "completed",
    status: { status: "resolved" },
    operation,
  });
  expect(value.point).toMatchObject(resolved(1));
  expect(value.range).toMatchObject(resolved(2));
  expect(value.relocation).toMatchObject(resolved(3));
  for (const annotation of [value.annotationResolution, value.annotationRelocation]) {
    expect(annotation).toMatchObject({
      occurrence: 20,
      resource: probe,
      result: {
        outcome: "resolved",
        reports: [
          {
            path: [0],
            kind: "css",
            outcome: "resolved",
            matchCount: 1,
            segment: { kind: "element", resource: probe },
          },
        ],
        segment: { kind: "element", resource: probe },
      },
    });
  }
});

test("captures frozen selection snapshots and resolves them", async ({ run, opened }) => {
  const value = await run("selection");
  const first = opened.first!;
  expect(value.selectionCapture).toMatchObject({
    outcome: "completed",
    occurrence: 20,
    resource: probe,
    selection: {
      status: "captured",
      direction: "forward",
      location: {
        kind: "range",
        occurrence: 20,
        resource: probe,
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "browser-text-position" }),
          expect.objectContaining({
            kind: "rendered-text-quote",
            exact: "Alice opened the tiny door",
          }),
        ]),
      },
      basis: {
        participant: { kind: "primary", documentGeneration: 1 },
        frameGeneration: first.frame.generation,
        layoutGeneration:
          first.layout.state === "settled" ? first.layout.layout.layoutGeneration : -1,
      },
    },
  });
  const captured = value.selectionCapture.outcome === "completed" ? value.selectionCapture : null;
  expect(value.capturedSelection.selection).toEqual(captured?.selection);
  expect(value.annotationTargetGeneration).toMatchObject({
    outcome: "completed",
    occurrence: 20,
    resource: probe,
    result: { status: "unavailable", reason: "not-authored" },
  });
  expect(value.staleSelectionGenerationError).toContain("exact current captured selection");
  for (const result of [value.selectionResolution, value.selectionRelocation]) {
    expect(result).toMatchObject({ outcome: "completed", status: { status: "resolved" } });
  }
  expect(value.selectionSnapshotFrozen).toBe(true);
  const anchor =
    value.capturedSelection.selection?.status === "captured"
      ? value.capturedSelection.selection.anchor
      : null;
  expect(anchor?.rect.width).toBeGreaterThan(0);
  expect(anchor?.rect.height).toBeGreaterThan(0);
  expect(anchor?.clippingRect?.width).toBeLessThanOrEqual(640);
  expect(anchor?.clippingRect?.height).toBeLessThanOrEqual(480);
  expect(value.duplicateSelectionCapture).toMatchObject({ selection: captured?.selection });
  expect(value.duplicateSelection.revision).toBe(value.capturedSelection.revision);
  expect(value.observedSelections).toContainEqual(
    expect.objectContaining({ selection: expect.objectContaining({ status: "captured" }) }),
  );
});

test("clears the captured selection when the document is replaced", async ({ run }) => {
  const value = await run("selectionReplacement");
  expect(value.selectionBeforeReplacement).toMatchObject({
    outcome: "completed",
    selection: { status: "captured" },
  });
  expect(value.selectionAtReplacement.selection).toBeNull();
  expect(value.previous).toMatchObject({ generation: 2, frame: { occurrence: 19 } });
});

test("observes root, body, and vertical writing flow", async ({ run }) => {
  const value = await run("observations");
  expect(value.documentObservationGeneration).toBe(1);
  expect(value.documentObservation).toMatchObject({
    writingMode: "horizontal-tb",
    direction: "ltr",
    visibleStart: { state: "located", evidence: expect.any(Array) },
  });
  expect(value.documentObservation.viewport.width).toBeGreaterThan(0);
  expect(value.documentObservation.viewport.height).toBeGreaterThan(0);
  expect(value.bodyFlow).toMatchObject({
    generation: 1,
    observation: { writingMode: "horizontal-tb", direction: "rtl" },
  });
  expect(value.vertical).toMatchObject({
    generation: 1,
    observation: { writingMode: "vertical-rl" },
  });
});

test("routes fragment, SVG, external, and cross-document link activations", async ({ run }) => {
  const value = await run("activations");
  expect(value.afterFragmentActivation).toMatchObject({
    generation: 1,
    frame: { occurrence: 20, resource: probe },
  });
  expect(value.topUrlAfterExternalActivation).toBe(value.topUrlBeforeExternalActivation);
  expect(value.crossDocumentCommitted).toMatchObject({
    generation: 2,
    frame: { occurrence: 24, resource: "epub/text/milestone-1-cross.xhtml" },
  });
  expect(value.crossTargetTop).toBeGreaterThanOrEqual(0);
  expect(value.crossTargetTop).toBeLessThan(900);
  expect(value.duplicateTargetCommitted).toMatchObject({
    generation: 3,
    frame: { occurrence: 20, resource: probe },
  });
  expect(await run("events")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "document-observed", generation: 1 }),
      expect.objectContaining({
        type: "link-activated",
        activation: expect.objectContaining({ href: "#locator-target" }),
      }),
      expect.objectContaining({
        type: "link-activated",
        activation: expect.objectContaining({ href: "milestone-1-cross.xhtml#cross-target" }),
      }),
      expect.objectContaining({
        type: "link-activated",
        activation: expect.objectContaining({ resolvedUrl: "https://example.invalid/outside" }),
      }),
      expect.objectContaining({
        type: "agent-operation-reported",
        generation: 2,
        result: { type: "relocate", status: { status: "resolved" } },
      }),
    ]),
  );
});

test.describe("with foreground preparation", () => {
  test.use({ preparation: true });

  test("prepares eligible neighbors as inert frames and pauses while hidden", async ({ run }) => {
    const neighbors = await run("prepareNeighbors");
    expect(neighbors.ineligibleNeighborSnapshot).toEqual([
      expect.objectContaining({
        frame: expect.objectContaining({ occurrence: 21 }),
        state: expect.objectContaining({ state: "prepared" }),
      }),
    ]);
    expect(neighbors.preparationOrder).toHaveLength(2);
    expect(neighbors.preparationOrder).toEqual(
      expect.arrayContaining([prepared(21), prepared(19)]),
    );
    const value = await run("hiddenPreparation");
    expect(value.hiddenPreparationState).toEqual({
      preparedFrames: 0,
      frameCount: 1,
      accessibleFrames: 1,
    });
    expect(value.preparedSnapshot).toHaveLength(2);
    expect(value.preparedSnapshot).toEqual(expect.arrayContaining([prepared(21), prepared(19)]));
    expect(value.preparedFrameState).toEqual({
      frameCount: 3,
      accessibleFrames: 1,
      inert: true,
      opacity: "0",
      pointerEvents: "none",
      width: 640,
      height: 480,
    });
    expect(value.preparedCatalog.foreground).toMatchObject({ state: "current", occurrence: 20 });
    for (const occurrence of [19, 21]) {
      expect(value.preparedCatalog.occurrences[occurrence]).toMatchObject({
        state: "measured",
        source: "foreground",
      });
    }
    expect(value.preparedCatalog.pageCountCoverage.measuredOccurrences).toBe(3);
  });

  test("promotes a prepared frame only after its role change is acknowledged", async ({ run }) => {
    await run("prepareNeighbors");
    const value = await run("promotion");
    expect(value.promotionImmediate).toEqual({
      reused: false,
      frameCount: 3,
      accessibleFrames: 1,
      targetHidden: "true",
      targetInert: true,
    });
    expect(value.promotionSuppression).toEqual({
      commandsReturnedPromotion: true,
      emittedEvents: 0,
      emittedInteractions: 0,
      pendingOccurrence: 21,
      pendingPhase: "promotion-acknowledging",
    });
    expect(value.promotionDelayed).toEqual({
      oldStillAccessible: true,
      committedOccurrence: 20,
      pendingPhase: "promotion-acknowledging",
    });
    expect(value.duplicate).toMatchObject(
      committedDocument(2, 21, probe, value.preparedGeneration),
    );
    // Adjacent preparation waits for the promoted document's first observation, so nothing is
    // prepared at the instant of promotion; the fixture waits for the next prepared frame after.
    expect(value.promotionState).toEqual({
      reused: true,
      frameCount: 1,
      accessibleFrames: 1,
      preparedFrames: 0,
    });
    expect(value.promotedCatalog.foreground).toMatchObject({ state: "current", occurrence: 21 });
    expect(value.promotedCatalog.pageCountCoverage.measuredOccurrences).toBeGreaterThanOrEqual(2);
    expect(value.exactPromotionCommitCount).toBe(1);
    expect(value.observablePendingPhases).not.toContain("promotion-acknowledging");
  });

  test("reprepares an invalidated prepared frame and drops preparation without capabilities", async ({
    run,
    opened,
  }) => {
    const value = await run("invalidatePrepared");
    expect(value.preparedInvalidation).toMatchObject({ oldRemoved: true, newPhase: "prepared" });
    expect(value.preparedInvalidation.newFrameGeneration).toBeGreaterThan(
      value.preparedInvalidation.oldFrameGeneration,
    );
    expect(value.preparedFailureRetention).toEqual({
      committed: opened.first,
      frameCount: 1,
      accessibleFrames: 1,
    });
  });
});

test("overlays replacement frames and ignores superseded and failed documents", async ({
  page,
  run,
}) => {
  const delayedTerminal = new Promise<void>((resolve) => {
    const settle = (request: Request) => {
      if (request.url().endsWith("/milestone-1-delayed.xhtml")) resolve();
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
  });
  const value = await run("replaceDelayed");
  expect(value.delayedGeneration).toBe(2);
  expect(value.replacementFrameGeometry).toEqual({
    frameCount: 2,
    committed: { width: 640, height: 480 },
    pending: { width: 640, height: 480 },
    pendingStyle: { position: "absolute", width: "100%", height: "100%" },
  });
  expect(value.replaced).toMatchObject(committedDocument(3, 20, probe));
  await delayedTerminal;
  expect(await run("document")).toEqual(value.replaced);
  expect(await run("failMissing")).toEqual(value.replaced);
  expect(await run("events")).toContainEqual(
    expect.objectContaining({
      type: "document-load-failed",
      reason: { reason: "readiness-timeout" },
    }),
  );
  const lifecycle = (await run("diagnostics")).filter((event) => event.type === "frame-lifecycle");
  expect(lifecycle.length).toBeGreaterThan(0);
  for (const event of lifecycle) {
    expect(event).toMatchObject({
      type: "frame-lifecycle",
      action: "terminal",
      frameGeneration: expect.any(Number),
      occurrence: expect.any(Number),
      role: expect.stringMatching(/^(foreground|auxiliary|prepared)$/),
      outcome: expect.stringMatching(/^(committed|prepared|failed|cancelled)$/),
      createToTerminalMs: expect.any(Number),
    });
    expect(event.createToTerminalMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(event)).not.toContain("runtime-lifecycle");
  }
});

test("cancels operations on reload and pending documents on cancel or rejected readiness", async ({
  run,
}) => {
  const value = await run("cancellation");
  expect(value.cancelledOperation).toMatchObject({
    outcome: "completed",
    status: { status: "resolved" },
  });
  expect(value.reloaded).toMatchObject(committedDocument(2, 20, probe));
  expect(value.cancelledGeneration).toBe(3);
  const retained = { pending: null, committed: value.reloaded, fixedCompanion: null };
  expect(value.afterCancel).toEqual(retained);
  expect(value.afterRejectedReady).toEqual(retained);
  expect(value.rejectedReadyFrames).toBe(1);
  expect(await run("events")).toContainEqual(
    expect.objectContaining({ type: "document-cancelled" }),
  );
});

test("ignores observations from a document that navigates before readiness", async ({
  run,
  opened,
}) => {
  const value = await run("pendingNavigation");
  expect(value.afterPendingNavigation).toEqual({
    pending: null,
    committed: opened.first,
    fixedCompanion: null,
  });
  expect(value.pendingObservationIgnored).toBe(true);
  expect(await run("events")).toContainEqual(
    expect.objectContaining({
      type: "document-load-failed",
      reason: { reason: "unexpected-navigation" },
    }),
  );
});

test("fails a promotion whose prepared frame is invalidated before acknowledgment", async ({
  run,
}) => {
  const value = await run("queuedInvalidation");
  expect(value.queuedInvalidationImmediate).toEqual({
    oldAccessible: true,
    targetHidden: "true",
    targetInert: true,
  });
  expect(value.queuedInvalidationRetention).toMatchObject({
    committed: value.queuedInvalidationRetention.retained,
    targetRemoved: true,
    failure: {
      type: "document-load-failed",
      reason: {
        reason: "effect-execution-failed",
        message: "the prepared frame was invalidated before promotion acknowledgment",
      },
    },
  });
});

test("adopts an in-flight prepared frame and promotes it once laid out", async ({ run }) => {
  const value = await run("adoptInFlight");
  expect(value.adopted).toEqual({
    effects: [],
    pendingState: "preparing",
    pendingFrame: value.preparedGeneration,
    frameCountUnchanged: true,
  });
  expect(value).toMatchObject({
    committedFrameGeneration: value.preparedGeneration,
    committedOccurrence: 21,
    reused: true,
    accessibleFrames: 1,
  });
});

test("retains the committed document when promotion acknowledgment never arrives", async ({
  run,
}) => {
  const value = await run("missingAck");
  expect(value.missingAckImmediate).toEqual({
    oldAccessible: true,
    targetHidden: "true",
    targetInert: true,
  });
  expect(value.missingAckRetention).toMatchObject({
    committed: value.missingAckRetention.retained,
    targetRemoved: true,
    accessibleFrames: 1,
  });
});

test("invalidates the committed document on unexpected navigation", async ({ run }) => {
  expect(await run("unexpectedNavigation")).toEqual({
    afterUnexpectedNavigation: { pending: null, committed: null, fixedCompanion: null },
    pendingAgentOperations: [],
    framesAfterUnexpectedNavigation: 0,
  });
  expect(await run("events")).toContainEqual(
    expect.objectContaining({ type: "document-invalidated", reason: "unexpected-navigation" }),
  );
});

test("closes reentrantly from a transition subscriber", async ({ run }) => {
  expect(await run("reentrantClose")).toEqual({
    framesAfterReentrantClose: 0,
    reentrantCloseFailure: "kernel-closed",
  });
});

test.describe("before the first document", () => {
  test.use({ open: false });

  test("mounts coherent overlay facts without public preparation", async ({ run }) => {
    expect(await run("facts")).toEqual({
      packagePath: "epub/content.opf",
      resources: 82,
      readingOrder: 28,
    });
    expect(await run("start")).toEqual({ publicPrepareAvailable: false });
  });

  test("generates, resolves, and decorates a scriptless annotation target", async ({ run }) => {
    const value = await run("annotationGeneration");
    const resource = "epub/text/milestone-3-generation.xhtml";
    expect(value.verifiedAnnotationTargetGeneration).toMatchObject({
      outcome: "completed",
      resource,
      result: { status: "generated", targetJson: expect.any(String) },
    });
    const generation = value.verifiedAnnotationTargetGeneration;
    const targetJson =
      generation.outcome === "completed" && generation.result.status === "generated"
        ? generation.result.targetJson
        : "null";
    expect(JSON.parse(targetJson)).toEqual({
      source: "text/milestone-3-generation.xhtml",
      selector: [
        {
          type: "CssSelector",
          value: "#generation-target",
          refinedBy: {
            type: "TextPositionSelector",
            start: expect.any(Number),
            end: expect.any(Number),
          },
        },
        { type: "TextPositionSelector", start: expect.any(Number), end: expect.any(Number) },
        {
          type: "FragmentSelector",
          value: expect.stringContaining("text=Exact"),
          conformsTo: "https://wicg.github.io/scroll-to-text-fragment/",
        },
      ],
    });
    expect(value.generatedAnnotationResolution).toMatchObject({
      outcome: "completed",
      resource,
      result: { outcome: "resolved", segment: { kind: "range" } },
    });
    expect(value.generatedDecoration).toMatchObject({
      projectionRevision: 1,
      outcomes: [{ id: "generated-highlight", outcome: { status: "rendered" } }],
    });
    expect(value.generatedDecorationHighlightCount).toBe(1);
    expect(value.clearedDecorationHighlightCount).toBe(0);
  });

  test("times out silent operations without applying their late results", async ({ run }) => {
    await run("start");
    const value = await run("operationTimeout");
    expect(value.timeoutCommitted).toMatchObject({
      generation: 1,
      frame: { occurrence: 25, resource: "epub/text/milestone-2-operation-timeout.xhtml" },
    });
    expect(value.timeoutInitialLayout).toMatchObject({
      type: "layout",
      action: "settle",
      phase: "initial",
    });
    const initialLayout = value.timeoutInitialLayout;
    const durationMs = initialLayout?.type === "layout" ? initialLayout.durationMs : undefined;
    expect(durationMs).toBeGreaterThanOrEqual(2_000);
    expect(durationMs).toBeLessThan(10_000);
    expect(value.operationTimeout).toMatchObject({
      outcome: "failed",
      failure: { code: "operation-timeout" },
    });
    expect(value.operationTimeoutElapsedMs).toBeGreaterThanOrEqual(1_800);
    expect(value.operationTimeoutElapsedMs).toBeLessThan(3_000);
    expect(value.afterLateTimeoutResult).toEqual({
      committed: value.timeoutCommitted,
      pendingAgentOperations: [],
    });
    expect(value.lateTimeoutDomUnchanged).toBe(true);
    const operation = value.operationTimeout.operation;
    expect(value.operationCancellations).toEqual([
      expect.objectContaining({ operation, operationType: "resolve-locator", exactSession: true }),
    ]);
    expect(
      (await run("diagnostics")).filter(
        (event) =>
          event.type === "operation-owner" &&
          event.action === "cancel" &&
          event.operation === operation,
      ),
    ).toEqual([expect.objectContaining({ operationKind: "locator", reason: "timeout" })]);
    expect(await run("events")).toContainEqual(
      expect.objectContaining({
        type: "agent-operation-failed",
        failure: expect.objectContaining({ code: "operation-timeout" }),
      }),
    );
  });

  test("re-requests a decoration reconciliation lost in flight", async ({ run }) => {
    await run("start");
    await run("openFirst");
    const value = await run("lostDecorationReconciliation");
    expect(value.afterLoss.failedDeliveries).toBe(1);
    // The failed delivery leaves no reconciliation pending; the retry re-requests it.
    expect(value.afterLoss.pendingReconciliations).toBe(0);
    expect(value.rendered).toBe(true);
  });

  test("cancels operations superseded by document replacement", async ({ run }) => {
    await run("start");
    const value = await run("supersededOperation");
    expect(value.cancellationReplacement).toMatchObject({
      generation: 2,
      frame: { occurrence: 20, resource: probe },
    });
    expect(value.lifecycleCancellation).toMatchObject({
      outcome: "failed",
      failure: { code: "operation-cancelled", reason: "replacement" },
    });
    expect(
      (await run("diagnostics")).filter(
        (event) =>
          event.type === "operation-owner" &&
          event.action === "cancel" &&
          event.operation === value.lifecycleCancellation.operation,
      ),
    ).toEqual([expect.objectContaining({ operationKind: "locator", reason: "owner-superseded" })]);
  });
});

function committedDocument(
  generation: number,
  occurrence: number,
  resource: string,
  frameGeneration?: number,
) {
  return {
    generation,
    frame: {
      ...(frameGeneration === undefined ? {} : { generation: frameGeneration }),
      occurrence,
      resource,
      adapter: "reflowable-xhtml",
    },
    supportedOperations: [
      "resolve-locator",
      "relocate",
      "resolve-annotation-target",
      "relocate-annotation-target",
      "capture-selection",
      "capture-current-location",
      "generate-annotation-target",
      "generate-current-location-annotation-target",
      "advance-presentation",
      "reconcile-decorations",
      "adjust-annotation-range",
      "find-media-overlay-entry",
    ],
    layout: { state: "settled" },
  };
}

function prepared(occurrence: number) {
  return expect.objectContaining({
    frame: expect.objectContaining({ occurrence, adapter: "reflowable-xhtml" }),
    state: expect.objectContaining({ state: "prepared" }),
  });
}
