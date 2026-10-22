import type { KernelEvent, KernelSnapshot, NavigatorLocation } from "epub-navigator";
import {
  createNavigatorRuntime,
  type NavigatorDiagnosticEvent,
  type NavigatorRuntime,
} from "epub-navigator/runtime";
import {
  currentDocument,
  currentFrame,
  currentObservation,
  pendingDocumentFrame,
} from "../../../src/runtime/kernel-view.js";
import {
  addRuntimeLifecycleOverlay,
  operationTimeoutResource,
  probeResource,
} from "./runtime-lifecycle-fixture";
import {
  aliceMount,
  animationFrames,
  delivered,
  openArchive,
  requiredElement,
  waitFor,
} from "../harness.js";

const output = requiredElement("#result");
const frameHost = requiredElement("#frame-host");
const publication = await openArchive();
addEventListener("pagehide", () => publication.close(), { once: true });
const overlay = addRuntimeLifecycleOverlay(publication.facts);
const mounted = { facts: overlay.facts, mount: aliceMount };
const selectedText = "Alice opened the tiny door";
const messages: Record<string, unknown>[] = [];
addEventListener("message", (event) => {
  if (isRecord(event.data)) messages.push(event.data);
});

let current: NavigatorRuntime | null = null;
const events: KernelEvent[] = [];
const diagnostics: NavigatorDiagnosticEvent[] = [];
const observedSelections: ReturnType<NavigatorRuntime["currentSelection"]>[] = [];
const pendingPhases: (string | null)[] = [];
let interactions = 0;

const pointLocator = {
  kind: "point",
  occurrence: overlay.probeOccurrence,
  resource: probeResource,
  evidence: [{ kind: "html-fragment", value: "locator-target" }],
  observation: { layoutProgression: null, renderedTextProgression: null },
} satisfies NavigatorLocation;
const timeoutLocator = {
  kind: "point",
  occurrence: overlay.operationTimeoutOccurrence,
  resource: operationTimeoutResource,
  evidence: [{ kind: "html-fragment", value: "operation-target" }],
  observation: { layoutProgression: null, renderedTextProgression: null },
} satisfies NavigatorLocation;

const harness = {
  facts() {
    const facts = JSON.parse(JSON.stringify(mounted.facts)) as typeof mounted.facts;
    return {
      packagePath: facts.resources.packagePath,
      resources: facts.resources.resources.length,
      readingOrder: facts.resources.readingOrder.length,
    };
  },

  async start(preparation = false) {
    const created = await createNavigatorRuntime({
      session: { id: "runtime-lifecycle", publication: mounted },
      container: frameHost,
      diagnostics: { level: "trace", record: (event) => diagnostics.push(event) },
      ...(preparation ? { pagination: preparationCapability([probeResource]) } : {}),
    });
    current = created;
    created.subscribe((transition) => {
      events.push(...transition.events);
      if (transition.events.some((event) => event.type === "document-pending")) {
        pendingPhases.push(created.snapshot().document.pending?.state.state ?? null);
      }
    });
    created.subscribeInteractions(() => (interactions += 1));
    created.subscribeSelections((snapshot) => observedSelections.push(snapshot));
    return { publicPrepareAvailable: "prepare" in created };
  },

  close() {
    runtime().close();
    return {
      frames: frameHost.querySelectorAll("iframe").length,
      stacks: frameHost.querySelectorAll("[data-epub-navigator-frame-stack]").length,
    };
  },

  events: () => events,
  diagnostics: () => diagnostics,
  document: () => currentDocument(runtime().snapshot()),

  async openFirst() {
    const opened = runtime().open(overlay.probeOccurrence);
    const pending = frameHost.querySelector("iframe");
    if (pending === null) throw new Error("the pending publication frame is missing");
    const pendingRect = pending.getBoundingClientRect();
    const pendingFrameState = {
      hidden: pending.hidden,
      position: pending.style.position,
      width: pendingRect.width,
      height: pendingRect.height,
      opacity: pending.style.opacity,
      inert: pending.inert,
      tabIndex: pending.tabIndex,
      ariaHidden: pending.getAttribute("aria-hidden"),
    };
    const first = currentDocument(await committed(generationOf(opened)));
    const frame = committedFrame();
    const before = JSON.stringify(runtime().snapshot().document);
    postMessage({ namespace: "epub-navigator", type: "ready", supportedOperations: [] }, "*");
    frame.contentWindow!.postMessage({ fixtureAgentNoise: true }, "*");
    await delivered(frame.contentWindow!);
    await delivered();
    return {
      first,
      pendingFrameState,
      committedFrameState: {
        title: frame.title,
        sandbox: frame.getAttribute("sandbox"),
        allow: frame.getAttribute("allow"),
        colorScheme: frame.style.colorScheme,
        position: frame.style.position,
        opacity: frame.style.opacity,
        inert: frame.inert,
        tabIndexAttribute: frame.getAttribute("tabindex"),
        ariaHidden: frame.getAttribute("aria-hidden"),
      },
      sharedContentDocument: frame.contentDocument !== null,
      unrelatedAndWrongPhaseIgnored: JSON.stringify(runtime().snapshot().document) === before,
    };
  },

  async publisher() {
    const report = await until(
      () => messages.find((message) => message.type === "publisher-script-ran"),
      "the publisher script did not report",
    );
    const unsafeRoute = await fetch("/publications/alice/epub/%2Fsecret");
    return {
      ...(report as unknown as PublisherScriptReport),
      unsafeRouteStatus: unsafeRoute.status,
    };
  },

  async locators() {
    const annotationTarget = JSON.stringify({
      source: "text/milestone-1.xhtml",
      selector: [{ type: "CssSelector", value: "#locator-target" }],
    });
    return {
      point: await runtime().resolve(pointLocator),
      range: await runtime().resolve({
        kind: "range",
        occurrence: overlay.probeOccurrence,
        resource: probeResource,
        evidence: [
          {
            kind: "rendered-text-quote",
            exact: selectedText,
            prefix: "Before ",
            suffix: " after.",
          },
        ],
        startObservation: { layoutProgression: null, renderedTextProgression: null },
        endObservation: { layoutProgression: null, renderedTextProgression: null },
      }),
      relocation: await runtime().relocate(pointLocator),
      annotationResolution: await runtime().resolveAnnotationTarget(annotationTarget),
      annotationRelocation: await runtime().relocateAnnotationTarget(annotationTarget),
    };
  },

  async selection() {
    selectFixtureText(committedFrame(), selectedText);
    const selectionCapture = await runtime().captureSelection();
    if (
      selectionCapture.outcome !== "completed" ||
      selectionCapture.selection.status !== "captured"
    ) {
      throw new Error("the fixture selection was not captured");
    }
    const selectionResolution = await runtime().resolve(selectionCapture.selection.location);
    const selectionRelocation = await runtime().relocate(selectionCapture.selection.location);
    await animationFrames();
    const capturedSelection = runtime().currentSelection();
    const annotationTargetGeneration = await runtime().generateSelectionAnnotationTarget(
      capturedSelection.revision,
      { textFragment: "include" },
    );
    let staleSelectionGenerationError: string | null = null;
    try {
      await runtime().generateSelectionAnnotationTarget(capturedSelection.revision + 1);
    } catch (cause) {
      staleSelectionGenerationError = cause instanceof Error ? cause.message : String(cause);
    }
    const duplicateSelectionCapture = await runtime().captureSelection();
    const selection = capturedSelection.selection;
    return {
      selectionCapture,
      selectionResolution,
      selectionRelocation,
      capturedSelection,
      annotationTargetGeneration,
      staleSelectionGenerationError,
      duplicateSelectionCapture,
      duplicateSelection: runtime().currentSelection(),
      selectionSnapshotFrozen:
        Object.isFrozen(capturedSelection) &&
        Object.isFrozen(selection) &&
        (selection?.status !== "captured" ||
          (Object.isFrozen(selection.location) && Object.isFrozen(selection.location.evidence))),
      observedSelections,
    };
  },

  async selectionReplacement() {
    selectFixtureText(committedFrame(), selectedText);
    const selectionBeforeReplacement = await runtime().captureSelection();
    const transition = runtime().previous();
    const selectionAtReplacement = runtime().currentSelection();
    const previous = currentDocument(await committed(generationOf(transition)));
    return { selectionBeforeReplacement, selectionAtReplacement, previous };
  },

  async annotationGeneration() {
    const host = document.createElement("div");
    host.style.width = "640px";
    host.style.height = "480px";
    document.body.append(host);
    const generation = await createNavigatorRuntime({
      session: { id: "runtime-lifecycle-annotation-generation", publication: mounted },
      container: host,
    });
    try {
      const opened = generationOf(generation.open(overlay.annotationGenerationOccurrence));
      await until(
        () => currentDocument(generation.snapshot())?.generation === opened,
        "the annotation generation document did not commit",
      );
      const frame = committedFrame(host);
      selectFixtureText(frame, "Exact 😀 annotation range", "#generation-target");
      const capture = await generation.captureSelection();
      if (capture.outcome !== "completed" || capture.selection.status !== "captured") {
        throw new Error("the annotation generation fixture selection was not captured");
      }
      await animationFrames();
      const verified = await generation.generateSelectionAnnotationTarget(
        generation.currentSelection().revision,
        { textFragment: "include" },
      );
      if (verified.outcome !== "completed" || verified.result.status !== "generated") {
        throw new Error("the scriptless annotation target was not generated");
      }
      const resolution = await generation.resolveAnnotationTarget(verified.result.targetJson);
      const decoration = (revision: number) =>
        until(
          () =>
            generation
              .snapshot()
              .decorations.participantOutcomes.find(
                (outcome) => outcome.projectionRevision === revision,
              ),
          `decoration revision ${revision} did not settle`,
        );
      generation.setDecorationProjection({
        revision: 1,
        records: [
          {
            id: "generated-highlight",
            targetJson: verified.result.targetJson,
            occurrence: overlay.annotationGenerationOccurrence,
            appearance: "annotation-highlight",
          },
        ],
      });
      const generatedDecoration = await decoration(1);
      const generatedDecorationHighlightCount = highlightRegistrySize(frame);
      generation.setDecorationProjection({ revision: 2, records: [] });
      await decoration(2);
      return {
        verifiedAnnotationTargetGeneration: verified,
        generatedAnnotationResolution: resolution,
        generatedDecoration,
        generatedDecorationHighlightCount,
        clearedDecorationHighlightCount: highlightRegistrySize(frame),
      };
    } finally {
      generation.close();
      host.remove();
    }
  },

  async observations() {
    const documentObservation = await until(
      () => currentObservation(runtime().snapshot()),
      "the committed document produced no coherent observation",
    );
    const documentObservationGeneration = currentDocument(runtime().snapshot())?.generation;
    const flow = async (
      message: Record<string, boolean>,
      matches: (event: KernelEvent) => boolean,
    ) => {
      const start = events.length;
      committedFrame().contentWindow!.postMessage(message, "*");
      await event(start, matches);
      const snapshot = runtime().snapshot();
      return {
        observation: currentObservation(snapshot),
        generation: currentDocument(snapshot)?.generation,
      };
    };
    const bodyFlow = await flow(
      { fixtureBodyFlow: true },
      (event) =>
        event.type === "document-observed" &&
        event.observation.writingMode === "horizontal-tb" &&
        event.observation.direction === "rtl",
    );
    const vertical = await flow(
      { fixtureVertical: true },
      (event) =>
        event.type === "document-observed" && event.observation.writingMode === "vertical-rl",
    );
    return { documentObservation, documentObservationGeneration, bodyFlow, vertical };
  },

  async activations() {
    const click = async (id: string, matches: (event: KernelEvent) => boolean) => {
      const start = events.length;
      committedFrame().contentWindow!.postMessage({ fixtureClick: id }, "*");
      return event(start, matches);
    };
    await click(
      "current-fragment",
      (event) => event.type === "agent-operation-reported" && event.result.type === "relocate",
    );
    const afterFragmentActivation = currentDocument(runtime().snapshot());
    await click(
      "svg-fragment",
      (event) => event.type === "link-activated" && event.activation.href === "#locator-target",
    );
    const topUrlBeforeExternalActivation = location.href;
    await click(
      "external-link",
      (event) =>
        event.type === "link-activated" &&
        event.activation.resolvedUrl === "https://example.invalid/outside",
    );
    const topUrlAfterExternalActivation = location.href;
    const crossStart = events.length;
    committedFrame().contentWindow!.postMessage({ fixtureClick: "cross-document-fragment" }, "*");
    const crossDocumentCommitted = currentDocument(
      await committedOccurrence(overlay.crossDocumentOccurrence),
    );
    await event(
      crossStart,
      (event) =>
        event.type === "agent-operation-reported" &&
        event.generation === crossDocumentCommitted?.generation &&
        event.result.type === "relocate" &&
        event.result.status.status === "resolved",
    );
    committedFrame().contentWindow!.postMessage({ fixtureMeasureCross: true }, "*");
    const crossTargetTop = await until(
      () => messages.find((message) => message.type === "cross-target-position")?.top as number,
      "the cross-document target was not measured",
    );
    committedFrame().contentWindow!.postMessage({ fixtureClick: "duplicate-resource" }, "*");
    const duplicateTargetCommitted = currentDocument(
      await committedOccurrence(overlay.probeOccurrence),
    );
    return {
      afterFragmentActivation,
      topUrlBeforeExternalActivation,
      topUrlAfterExternalActivation,
      crossDocumentCommitted,
      crossTargetTop,
      duplicateTargetCommitted,
    };
  },

  async prepareNeighbors() {
    const ineligibleNeighborSnapshot = (await prepared([overlay.duplicateOccurrence]))
      .preparedFrames;
    runtime().setPaginationCapabilities(preparationCapability([probeResource, previousResource()]));
    const preparationOrder = (
      await prepared([overlay.duplicateOccurrence, overlay.probeOccurrence - 1])
    ).preparedFrames;
    return { ineligibleNeighborSnapshot, preparationOrder };
  },

  async hiddenPreparation() {
    const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await preparedRemoval();
    const hiddenPreparationState = {
      preparedFrames: runtime().snapshot().preparedFrames.length,
      ...frameCounts(),
    };
    if (hidden === undefined) delete (document as { hidden?: boolean }).hidden;
    else Object.defineProperty(document, "hidden", hidden);
    document.dispatchEvent(new Event("visibilitychange"));
    const preparedSnapshot = (
      await prepared([overlay.duplicateOccurrence, overlay.probeOccurrence - 1])
    ).preparedFrames;
    const frame = preparedProbeFrame();
    const rect = frame.getBoundingClientRect();
    return {
      hiddenPreparationState,
      preparedSnapshot,
      preparedFrameState: {
        ...frameCounts(),
        inert: frame.inert,
        opacity: frame.style.opacity,
        pointerEvents: frame.style.pointerEvents,
        width: rect.width,
        height: rect.height,
      },
      preparedCatalog: runtime().paginationSnapshot(),
    };
  },

  async promotion() {
    const preparedFrame = preparedProbeFrame();
    const preparedGeneration = runtime()
      .snapshot()
      .preparedFrames.find((frame) => frame.frame.occurrence === overlay.duplicateOccurrence)
      ?.frame.generation;
    const preparedWindow = preparedFrame.contentWindow as unknown as {
      postMessage(message: unknown, targetOrigin: string): void;
    };
    const originalPost = preparedWindow.postMessage.bind(preparedWindow);
    let heldRoleChange: [unknown, string] | null = null;
    preparedWindow.postMessage = (message, targetOrigin) => {
      if (isRoleChange(message)) heldRoleChange = [message, targetOrigin];
      else originalPost(message, targetOrigin);
    };
    const promotion = runtime().next();
    const eventStart = events.length;
    const interactionStart = interactions;
    const repeated = [
      runtime().next(),
      runtime().previous(),
      runtime().open(overlay.probeOccurrence),
      runtime().reload(),
    ];
    const committedWindow = committedFrame().contentWindow!;
    committedWindow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    committedWindow.postMessage({ fixtureClick: "external-link" }, "*");
    const immediate = committedFrame();
    const promotionImmediate = {
      reused: immediate === preparedFrame,
      frameCount: frameCounts().frameCount,
      accessibleFrames: frameCounts().accessibleFrames,
      targetHidden: preparedFrame.getAttribute("aria-hidden"),
      targetInert: preparedFrame.inert,
    };
    await delivered(committedWindow);
    await delivered();
    await animationFrames();
    const snapshot = runtime().snapshot();
    const pending = snapshot.document.pending;
    const promotionSuppression = {
      commandsReturnedPromotion: repeated.every((transition) => transition === promotion),
      emittedEvents: events.length - eventStart,
      emittedInteractions: interactions - interactionStart,
      pendingOccurrence: pending === null ? undefined : pendingDocumentFrame(pending).occurrence,
      pendingPhase: pending?.state.state,
    };
    const promotionDelayed = {
      oldStillAccessible: committedFrame() === immediate,
      committedOccurrence: currentFrame(snapshot)?.occurrence,
      pendingPhase: pending?.state.state,
    };
    const held = heldRoleChange as [unknown, string] | null;
    if (held === null) throw new Error("the role change message was not held");
    originalPost(...held);
    const duplicate = currentDocument(await committed(generationOf(promotion)));
    preparedWindow.postMessage = originalPost;
    return {
      preparedGeneration,
      promotionImmediate,
      promotionSuppression,
      promotionDelayed,
      duplicate,
      promotionState: {
        reused: committedFrame() === preparedFrame,
        ...frameCounts(),
        preparedFrames: runtime().snapshot().preparedFrames.length,
      },
      promotedCatalog: runtime().paginationSnapshot(),
      exactPromotionCommitCount: events.filter(
        (event) =>
          event.type === "document-committed" && event.generation === duplicate?.generation,
      ).length,
      observablePendingPhases: pendingPhases,
    };
  },

  async invalidatePrepared() {
    const snapshot = await prepared([overlay.duplicateOccurrence]);
    const frame = preparedProbeFrame();
    const oldFrameGeneration = snapshot.preparedFrames.find(
      (prepared) => prepared.frame.occurrence === overlay.duplicateOccurrence,
    )!.frame.generation;
    frame.contentWindow!.postMessage({ fixtureVertical: true }, "*");
    const reprepared = await until(
      () =>
        runtime()
          .snapshot()
          .preparedFrames.find(
            (prepared) =>
              prepared.frame.occurrence === overlay.duplicateOccurrence &&
              prepared.frame.generation !== oldFrameGeneration &&
              prepared.state.state === "prepared",
          ),
      "the invalidated prepared frame was not reprepared",
    );
    const preparedInvalidation = {
      oldRemoved: !frame.isConnected,
      oldFrameGeneration,
      newFrameGeneration: reprepared.frame.generation,
      newPhase: reprepared.state.state,
    };
    runtime().setPaginationCapabilities(undefined);
    await preparedRemoval();
    return {
      preparedInvalidation,
      preparedFailureRetention: {
        committed: currentDocument(runtime().snapshot()),
        frameCount: frameCounts().frameCount,
        accessibleFrames: frameCounts().accessibleFrames,
      },
    };
  },

  async replaceDelayed() {
    const delayedGeneration = generationOf(runtime().open(overlay.delayedOccurrence));
    const frames = [...frameHost.querySelectorAll("iframe")];
    const committedReplacement = frames.find((frame) => !hiddenFrame(frame));
    const pendingReplacement = frames.find(hiddenFrame);
    if (committedReplacement === undefined || pendingReplacement === undefined) {
      throw new Error("the overlaid replacement frames are missing");
    }
    const committedRect = committedReplacement.getBoundingClientRect();
    const pendingRect = pendingReplacement.getBoundingClientRect();
    const replacementFrameGeometry = {
      frameCount: frames.length,
      committed: { width: committedRect.width, height: committedRect.height },
      pending: { width: pendingRect.width, height: pendingRect.height },
      pendingStyle: {
        position: pendingReplacement.style.position,
        width: pendingReplacement.style.width,
        height: pendingReplacement.style.height,
      },
    };
    const replaced = currentDocument(
      await committed(generationOf(runtime().open(overlay.probeOccurrence))),
    );
    return { delayedGeneration, replacementFrameGeometry, replaced };
  },

  async failMissing() {
    const snapshot = await settled(generationOf(runtime().open(overlay.missingOccurrence)));
    return currentDocument(snapshot);
  },

  async cancellation() {
    const cancelledOperationPromise = runtime().resolve(pointLocator);
    const reloaded = currentDocument(await committed(generationOf(runtime().reload())));
    const cancelledOperation = await cancelledOperationPromise;
    const cancelledGeneration = generationOf(runtime().open(overlay.delayedOccurrence));
    runtime().cancel();
    const afterCancel = runtime().snapshot().document;
    const afterRejectedReady = (
      await settled(generationOf(runtime().open(overlay.delayedOccurrence)))
    ).document;
    return {
      cancelledOperation,
      reloaded,
      cancelledGeneration,
      afterCancel,
      afterRejectedReady,
      rejectedReadyFrames: frameHost.querySelectorAll("iframe").length,
    };
  },

  async operationTimeout() {
    const timeoutCommitted = currentDocument(await openTimeoutDocument());
    const timeoutInitialLayout = diagnostics.find(
      (event) =>
        event.type === "layout" &&
        event.action === "settle" &&
        event.phase === "initial" &&
        event.documentGeneration === timeoutCommitted?.generation,
    );
    const frame = committedFrame();
    const domBefore = frame.contentDocument?.documentElement.outerHTML;
    const lateResults = () =>
      messages.filter(
        (message) =>
          message.type === "result" &&
          message.resultType === "resolve-locator" &&
          message.session !== "wrong-session",
      ).length;
    const lateBefore = lateResults();
    const startedAt = performance.now();
    const operationTimeout = await runtime().resolve(timeoutLocator);
    const operationTimeoutElapsedMs = performance.now() - startedAt;
    await waitFor(() => lateResults() > lateBefore, "the late operation result did not arrive");
    const after = runtime().snapshot();
    return {
      timeoutCommitted,
      timeoutInitialLayout,
      operationTimeout,
      operationTimeoutElapsedMs,
      afterLateTimeoutResult: {
        committed: currentDocument(after),
        pendingAgentOperations: after.pendingAgentOperations,
      },
      lateTimeoutDomUnchanged: frame.contentDocument?.documentElement.outerHTML === domBefore,
      operationCancellations: messages.filter(
        (message) => message.type === "fixture-operation-cancelled",
      ),
    };
  },

  async supersededOperation() {
    await openTimeoutDocument();
    const pendingOperation = runtime().resolve(timeoutLocator);
    const cancellationReplacement = currentDocument(
      await committed(generationOf(runtime().open(overlay.probeOccurrence))),
    );
    return { cancellationReplacement, lifecycleCancellation: await pendingOperation };
  },

  async pendingNavigation() {
    const before = currentDocument(runtime().snapshot())?.generation;
    const snapshot = await settled(
      generationOf(runtime().open(overlay.pendingNavigationOccurrence)),
    );
    return {
      afterPendingNavigation: snapshot.document,
      pendingObservationIgnored:
        currentObservation(snapshot) !== null && currentDocument(snapshot)?.generation === before,
    };
  },

  async queuedInvalidation() {
    const target = await prepareDuplicate();
    const retained = currentDocument(runtime().snapshot());
    const eventStart = events.length;
    target.contentWindow!.postMessage({ fixtureVertical: true }, "*");
    const generation = generationOf(runtime().next());
    const queuedInvalidationImmediate = {
      oldAccessible: committedFrame() !== target,
      targetHidden: target.getAttribute("aria-hidden"),
      targetInert: target.inert,
    };
    await settled(generation);
    return {
      queuedInvalidationImmediate,
      queuedInvalidationRetention: {
        committed: currentDocument(runtime().snapshot()),
        retained,
        targetRemoved: !target.isConnected,
        failure: events
          .slice(eventStart)
          .find(
            (event) => event.type === "document-load-failed" && event.generation === generation,
          ),
      },
    };
  },

  async missingAck() {
    const target = await prepareDuplicate();
    const targetWindow = target.contentWindow as unknown as {
      postMessage(message: unknown, targetOrigin: string): void;
    };
    const originalPost = targetWindow.postMessage.bind(targetWindow);
    targetWindow.postMessage = (message, targetOrigin) => {
      if (!isRoleChange(message)) originalPost(message, targetOrigin);
    };
    const retained = currentDocument(runtime().snapshot());
    const promotion = runtime().next();
    const missingAckImmediate = {
      oldAccessible: committedFrame() !== target,
      targetHidden: target.getAttribute("aria-hidden"),
      targetInert: target.inert,
    };
    await settled(generationOf(promotion));
    return {
      missingAckImmediate,
      missingAckRetention: {
        committed: currentDocument(runtime().snapshot()),
        retained,
        targetRemoved: !target.isConnected,
        accessibleFrames: frameCounts().accessibleFrames,
      },
    };
  },

  async adoptInFlight() {
    let held: (() => void) | null = null;
    let target: HTMLIFrameElement | null = null;
    const holdLayout = (event: Event) => {
      const frame = event.target;
      if (!(frame instanceof HTMLIFrameElement) || !frame.src.endsWith(probeResource)) return;
      const view = frame.contentWindow as unknown as {
        postMessage(message: unknown, targetOrigin: string): void;
      };
      const originalPost = view.postMessage.bind(view);
      view.postMessage = (message, targetOrigin) => {
        if (held === null && isLayoutRequest(message)) {
          target = frame;
          held = () => originalPost(message, targetOrigin);
        } else originalPost(message, targetOrigin);
      };
    };
    frameHost.addEventListener("load", holdLayout, true);
    runtime().setPaginationCapabilities(preparationCapability([probeResource, previousResource()]));
    const preparedGeneration = await until(
      () =>
        held !== null &&
        runtime()
          .snapshot()
          .preparedFrames.find(
            (frame) =>
              frame.frame.occurrence === overlay.duplicateOccurrence &&
              frame.state.state === "layout-initializing",
          )?.frame.generation,
      "the probe preparation did not reach layout",
    );
    frameHost.removeEventListener("load", holdLayout, true);
    const framesBefore = frameCounts().frameCount;
    const adoption = runtime().next();
    const pending = runtime().snapshot().document.pending;
    const adopted = {
      effects: adoption.effects.map((effect) => effect.type),
      pendingState: pending?.state.state,
      pendingFrame: pending === null ? undefined : pendingDocumentFrame(pending).generation,
      frameCountUnchanged: frameCounts().frameCount === framesBefore,
    };
    (held as unknown as () => void)();
    const snapshot = await committed(generationOf(adoption));
    return {
      preparedGeneration,
      adopted,
      committedFrameGeneration: currentFrame(snapshot)?.generation,
      committedOccurrence: currentFrame(snapshot)?.occurrence,
      reused: committedFrame() === target,
      accessibleFrames: frameCounts().accessibleFrames,
    };
  },

  async unexpectedNavigation() {
    committedFrame().src = `${location.origin}/outside-publication`;
    await waitFor(
      () => frameHost.querySelector("iframe") === null,
      "unexpected publication navigation was not invalidated",
    );
    const snapshot = runtime().snapshot();
    return {
      afterUnexpectedNavigation: snapshot.document,
      pendingAgentOperations: snapshot.pendingAgentOperations,
      framesAfterUnexpectedNavigation: frameHost.querySelectorAll("iframe").length,
    };
  },

  reentrantClose() {
    const unsubscribe = runtime().subscribe((transition) => {
      if (transition.events.some((event) => event.type === "document-pending")) runtime().close();
    });
    runtime().open(overlay.probeOccurrence);
    unsubscribe();
    let reentrantCloseFailure: string | null = null;
    try {
      runtime().snapshot();
    } catch (cause) {
      reentrantCloseFailure = (cause as { failure?: { code?: string } }).failure?.code ?? null;
    }
    return {
      framesAfterReentrantClose: frameHost.querySelectorAll("iframe").length,
      reentrantCloseFailure,
    };
  },
};

declare global {
  interface Window {
    runtimeLifecycle: typeof harness;
  }
}

window.runtimeLifecycle = harness;
output.dataset.state = "ready";

function runtime(): NavigatorRuntime {
  if (current === null) throw new Error("the lifecycle runtime has not started");
  return current;
}

async function until<T>(read: () => T | null | undefined | false, message: string): Promise<T> {
  let value: T | null | undefined | false;
  await waitFor(() => {
    value = read();
    return value !== null && value !== undefined && value !== false;
  }, message);
  return value as T;
}

function generationOf(transition: {
  events: readonly { readonly type: string; readonly generation?: number }[];
}): number {
  const pending = transition.events.find((event) => event.type === "document-pending");
  if (pending?.generation === undefined)
    throw new Error("document command emitted no pending event");
  return pending.generation;
}

function committed(generation: number): Promise<KernelSnapshot> {
  return until(() => {
    const snapshot = runtime().snapshot();
    return currentDocument(snapshot)?.generation === generation && snapshot;
  }, `document generation ${generation} did not commit`);
}

function committedOccurrence(occurrence: number): Promise<KernelSnapshot> {
  return until(() => {
    const snapshot = runtime().snapshot();
    return currentFrame(snapshot)?.occurrence === occurrence && snapshot;
  }, `reading-order occurrence ${occurrence} did not commit`);
}

function settled(failedGeneration: number): Promise<KernelSnapshot> {
  return until(() => {
    const snapshot = runtime().snapshot();
    if (snapshot.document.pending !== null) return null;
    if (currentDocument(snapshot)?.generation === failedGeneration) {
      throw new Error(`failed document generation ${failedGeneration} was committed`);
    }
    return snapshot;
  }, `document generation ${failedGeneration} did not settle`);
}

function prepared(occurrences: readonly number[]): Promise<KernelSnapshot> {
  return until(
    () => {
      const snapshot = runtime().snapshot();
      return (
        occurrences.every((occurrence) =>
          snapshot.preparedFrames.some(
            (frame) => frame.frame.occurrence === occurrence && frame.state.state === "prepared",
          ),
        ) && snapshot
      );
    },
    `occurrences ${occurrences.join(", ")} were not prepared`,
  );
}

function preparedRemoval(): Promise<void> {
  return waitFor(
    () => runtime().snapshot().preparedFrames.length === 0,
    "the prepared frames were not removed",
  );
}

function event(start: number, matches: (event: KernelEvent) => boolean): Promise<KernelEvent> {
  return until(
    () => events.slice(start).find(matches),
    "the expected kernel event was not observed",
  );
}

function openTimeoutDocument(): Promise<KernelSnapshot> {
  return committed(generationOf(runtime().open(overlay.operationTimeoutOccurrence)));
}

async function prepareDuplicate(): Promise<HTMLIFrameElement> {
  runtime().setPaginationCapabilities(preparationCapability([probeResource, previousResource()]));
  await prepared([overlay.duplicateOccurrence]);
  return preparedProbeFrame();
}

function preparationCapability(eligibleResourcePaths: readonly string[]) {
  return {
    foregroundPreparation: { eligibleResourcePaths },
    signal: new AbortController().signal,
    close() {},
  };
}

function previousResource(): string {
  const previous = runtime().snapshot().readingOrder[overlay.probeOccurrence - 1];
  if (previous?.document.state !== "loadable") {
    throw new Error("the preparation fixture has no previous canonical resource");
  }
  return previous.document.resource;
}

function hiddenFrame(frame: HTMLIFrameElement): boolean {
  return frame.getAttribute("aria-hidden") === "true";
}

function frameCounts() {
  const frames = [...frameHost.querySelectorAll("iframe")];
  return {
    frameCount: frames.length,
    accessibleFrames: frames.filter((frame) => !hiddenFrame(frame)).length,
  };
}

function committedFrame(container = frameHost): HTMLIFrameElement {
  const frame = [...container.querySelectorAll("iframe")].find((frame) => !hiddenFrame(frame));
  if (frame === undefined) throw new Error("the committed publication frame is missing");
  return frame;
}

function preparedProbeFrame(): HTMLIFrameElement {
  const frame = [...frameHost.querySelectorAll("iframe")].find(
    (frame) => hiddenFrame(frame) && frame.src.endsWith(probeResource),
  );
  if (frame?.contentWindow == null) throw new Error("the prepared probe frame is unavailable");
  return frame;
}

function highlightRegistrySize(frame: HTMLIFrameElement): number {
  const view:
    | (Window & { readonly CSS?: { readonly highlights?: { readonly size?: number } } })
    | null = frame.contentWindow;
  return view?.CSS?.highlights?.size ?? 0;
}

function selectFixtureText(
  frame: HTMLIFrameElement,
  text: string,
  selector = "#locator-target",
): void {
  const content = frame.contentDocument;
  const target = content?.querySelector(selector)?.firstChild;
  const selection = frame.contentWindow?.getSelection();
  const start = target?.nodeValue?.indexOf(text) ?? -1;
  if (content == null || target == null || selection == null || start < 0) {
    throw new Error("the selection fixture target is unavailable");
  }
  const range = content.createRange();
  range.setStart(target, start);
  range.setEnd(target, start + text.length);
  selection.removeAllRanges();
  selection.addRange(range);
  content.dispatchEvent(new Event("selectionchange"));
}

function isLayoutRequest(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.namespace === "epub-navigator" &&
    message.type === "request" &&
    isRecord(message.request) &&
    message.request.type === "layout"
  );
}

function isRoleChange(message: unknown): boolean {
  return isRecord(message) && message.namespace === "epub-navigator" && message.type === "set-role";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface PublisherScriptReport {
  readonly type: "publisher-script-ran";
  readonly externalScriptRan: boolean;
  readonly readingSystem: boolean;
  readonly authoredStylesheet: string | null;
  readonly authoredImage: string | null;
  readonly authoredMedia: string | null;
  readonly resolvedMedia: string | null;
  readonly imageLoaded: boolean;
  readonly fontLoaded: boolean;
  readonly computedColor: string | null;
  readonly durableStorageAvailable: boolean;
  readonly remoteConnectionBlocked: boolean;
}
