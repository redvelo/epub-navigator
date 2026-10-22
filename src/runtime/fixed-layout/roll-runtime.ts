import type {
  CreateNavigatorRuntimeOptions,
  NavigatorRuntime,
  NavigatorTransitionListener,
  NavigatorLocationListener,
  NavigatorSelectionListener,
  NavigatorFootnoteListener,
  NavigatorErrorListener,
  NavigatorReadingPosition,
  FixedViewPoint,
  ReaderConfiguration,
  RestoreAnnotationTargetResult,
  AgentOperationContext,
  AnnotationTargetOperationResult,
} from "../navigator/api.js";
import type {
  DecorationProjection,
  FixedIntrinsicViewport,
  KernelTransition,
  NavigatorLocationSnapshot,
  PresentationPreferences,
  KernelEvent,
} from "../../generated/kernel.js";
import type { CreateRuntime } from "../navigator/runtime-state.js";
import { createInitializedNavigatorKernel, type NavigatorKernelAccess } from "../kernel.js";
import { resolveFrameProfile } from "../frame-profile.js";
import {
  currentDocument,
  occurrenceLoadableTarget,
  occurrenceAliasesResource,
} from "../kernel-view.js";
import { decodePublicationRoute, publicationResourceUrl } from "../../mount.js";
import { RollChildRuntime, type RollTargetPoint } from "./roll-child.js";
import { rollKernel } from "./roll-kernel.js";
import {
  rollAnchor,
  rollBoxes,
  rollPreviewWindow,
  rollReachableSpan,
  rollWindow,
  ROLL_MAX_LIVE_CHILDREN,
  ROLL_WINDOW_BUDGET,
  ROLL_MAX_LOADING_CHILDREN,
  type RollBox,
} from "./roll-geometry.js";
import {
  parseRollTarget,
  qualifyRollEvidence,
  rollExtensions,
  rollEvidencePosition,
  kernelRollEvidence,
  rollProgressionsAgree,
  type RollPosition,
} from "./roll-target.js";

type RollFailure = Exclude<RestoreAnnotationTargetResult, { status: "restored" }>;
interface RollWork {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly deadline: number;
  finish(): void;
}

interface Child {
  readonly runtime: RollChildRuntime;
  readonly host: HTMLDivElement;
  readonly unsubscribe: (() => void)[];
  viewport: FixedIntrinsicViewport | null;
  occurrence: number;
  loading: boolean;
}

/** One public reader over independently owned fixed documents. No child owns a sibling frame. */
export function createFixedRollRuntime(
  options: CreateNavigatorRuntimeOptions,
  kernel: NavigatorKernelAccess,
  createRuntime: CreateRuntime,
): NavigatorRuntime {
  const document = options.container.ownerDocument;
  const view = document.defaultView!;
  const containerPosition = options.container.style.position;
  if (view.getComputedStyle(options.container).position === "static")
    options.container.style.position = "relative";
  const scroller = document.createElement("div");
  scroller.dataset.epubNavigatorRoll = "";
  Object.assign(scroller.style, {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "auto",
    overflowAnchor: "none",
    overscrollBehavior: "contain",
  });
  const stack = document.createElement("div");
  Object.assign(stack.style, { position: "relative", width: "100%", overflowAnchor: "none" });
  scroller.append(stack);
  options.container.append(scroller);
  const order = kernel.snapshot().readingOrder;
  const packageDirectory = kernel.snapshot().packagePath.split("/").slice(0, -1);
  const resourceTarget = (resource: string) => {
    const parts = resource.split("/");
    let shared = 0;
    while (shared < packageDirectory.length && packageDirectory[shared] === parts[shared]) shared++;
    return JSON.stringify({
      source: [...packageDirectory.slice(shared).map(() => ".."), ...parts.slice(shared)]
        .map(encodeURIComponent)
        .join("/"),
    });
  };
  const pages = order
    .filter((item) => {
      const target = occurrenceLoadableTarget(item);
      return (
        target?.adapter === "fixed-xhtml" ||
        target?.adapter === "fixed-svg" ||
        target?.adapter === "fixed-image"
      );
    })
    .map((item) => ({ occurrence: item.ordinal, ratio: 1 }));
  if (pages.length !== order.length || pages.length === 0) {
    scroller.remove();
    options.container.style.position = containerPosition;
    kernel.close();
    throw new Error(
      "fixed roll requires a loadable fixed document or image at every spine occurrence",
    );
  }
  const children = new Map<number, Child>();
  const loadingSlots = new Map<number, HTMLDivElement>();
  const previews = new Map<number, HTMLImageElement>();
  const failures = new Map<
    number,
    Extract<KernelEvent, { type: "document-load-failed" | "document-invalidated" }>
  >();
  let pinned: Child | null = null;
  const capacityNotice = document.createElement("div");
  capacityNotice.dataset.epubNavigatorRollCapacity = "";
  capacityNotice.setAttribute("role", "alert");
  Object.assign(capacityNotice.style, {
    position: "absolute",
    inset: "0",
    zIndex: "5",
    background: "Canvas",
    color: "CanvasText",
    padding: "24px",
    overflow: "auto",
  });
  capacityNotice.hidden = true;
  capacityNotice.append(
    "Too many fixed pages are visible at this zoom. Zoom in or navigate to another page to continue. ",
  );
  const capacityZoom = document.createElement("button");
  capacityZoom.textContent = "Zoom in to display pages";
  capacityZoom.addEventListener("click", () => api.setFixedZoom(zoom * 2));
  capacityNotice.append(capacityZoom);
  options.container.append(capacityNotice);
  const transitions = new Set<NavigatorTransitionListener>();
  const errors = new Set<NavigatorErrorListener>();
  const locations = new Set<NavigatorLocationListener>();
  const selections = new Set<NavigatorSelectionListener>();
  const footnotes = new Set<NavigatorFootnoteListener>();
  let footnote: { id: number; position: NavigatorReadingPosition } | null = null;
  let footnoteId = 0;
  const eventSubscriptions = new Set<(child: Child) => () => void>();
  let preferences: PresentationPreferences =
    options.presentationPreferences ?? kernel.snapshot().layout.preferences;
  let pagination = options.pagination;
  let configuration: ReaderConfiguration | undefined;
  let projection: DecorationProjection | undefined;
  let zoom = 1;
  let closed = false;
  let scheduled = 0;
  let boxes: RollBox[] = [];
  let active: Child;
  let location: NavigatorLocationSnapshot = {
    revision: 0,
    location: null,
    basis: null,
    visibleOccurrences: null,
  };
  let selectionRevision = 0;
  let stateRevision = 0;
  // Compositor operations are separate from child-kernel and TOC/page-list operation IDs.
  let presentationOperation = 0x6000_0000;
  let navigationEpoch = 0;
  let navigationWork: RollWork | null = null;
  const navigationChanged = (reason: "superseded" | "replacement" | "close" = "superseded") => {
    navigationEpoch++;
    navigationWork?.controller.abort(reason);
  };
  const beginWork = (signal?: AbortSignal, deadline = performance.now() + 10_000): RollWork => {
    const controller = new AbortController();
    const abort = () => controller.abort("abort");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort("timeout"),
      Math.max(0, deadline - performance.now()),
    );
    const work: RollWork = {
      controller,
      deadline,
      epoch: navigationEpoch,
      finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (navigationWork === work) {
          navigationWork = null;
          if (!closed) schedule();
        }
      },
    };
    navigationWork = work;
    return work;
  };
  const workFailure = (child: Child, work: RollWork): RollFailure | null => {
    const reason: unknown = work.controller.signal.reason;
    if (
      reason === "timeout" ||
      (!work.controller.signal.aborted && performance.now() >= work.deadline)
    )
      return { status: "failed", reason: "timeout", message: "fixed roll restoration timed out" };
    if (
      closed ||
      work.controller.signal.aborted ||
      navigationEpoch !== work.epoch ||
      active !== child ||
      children.get(child.occurrence) !== child
    )
      return {
        status: "cancelled",
        reason:
          closed || reason === "close"
            ? "close"
            : reason === "abort"
              ? "abort"
              : reason === "replacement"
                ? "replacement"
                : "superseded",
      };
    return null;
  };
  const failedOperation = (context: AgentOperationContext, failure: RollFailure) => ({
    operation: context.operation,
    generation: context.generation,
    occurrence: context.occurrence,
    resource: context.resource,
    outcome: "failed" as const,
    failure:
      failure.status === "cancelled"
        ? {
            code: "operation-cancelled" as const,
            reason: failure.reason === "close" ? ("close" as const) : ("replacement" as const),
          }
        : {
            code:
              failure.reason === "timeout"
                ? ("operation-timeout" as const)
                : ("operation-delivery-failed" as const),
            message: failure.message,
          },
  });
  let selection = { revision: 0, selection: null } as ReturnType<
    NavigatorRuntime["currentSelection"]
  >;
  let lastTransition: KernelTransition;
  const emit = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        /* Observers do not own the compositor. */
      }
    }
  };
  const assertOpen = () => {
    if (closed) throw new Error("the Navigator roll runtime is closed");
  };
  const state = () => ({
    zoom,
    minimumZoom: 1,
    maximumZoom: 4,
    panX: -scroller.scrollLeft,
    panY: -scroller.scrollTop,
  });
  const visibleRange = () => {
    const visible = boxes.filter(
      (box) =>
        box.top + box.height > scroller.scrollTop &&
        box.top < scroller.scrollTop + scroller.clientHeight,
    );
    if (active.occurrence < 0 || currentDocument(active.runtime.snapshot()) === null) return null;
    return {
      primaryOccurrence: active.occurrence,
      firstOccurrence: visible[0]?.occurrence ?? active.occurrence,
      lastOccurrence: visible.at(-1)?.occurrence ?? active.occurrence,
      companion: null,
    };
  };
  const publishLocation = () => {
    const next = active.runtime.currentLocation();
    const point =
      next.location?.kind === "point"
        ? {
            ...next.location,
            evidence: qualifyRollEvidence(next.location.evidence, currentRollPosition()),
            observation: { ...next.location.observation, layoutProgression: progression() },
          }
        : next.location;
    const value = { location: point, basis: next.basis, visibleOccurrences: visibleRange() };
    if (
      JSON.stringify(value) ===
      JSON.stringify({
        location: location.location,
        basis: location.basis,
        visibleOccurrences: location.visibleOccurrences,
      })
    )
      return;
    location = { ...value, revision: location.revision + 1 };
    emit(locations, location);
  };
  const publishSelection = () => {
    selection = { ...active.runtime.currentSelection(), revision: ++selectionRevision };
    emit(selections, selection);
  };
  const publish = (transition: KernelTransition) => {
    lastTransition = { ...transition, stateRevision: ++stateRevision };
    publishLocation();
    emit(transitions, lastTransition);
  };
  let lastViewKey = "";
  const viewKey = () =>
    JSON.stringify([
      scroller.scrollTop,
      scroller.scrollLeft,
      scroller.clientWidth,
      scroller.clientHeight,
      zoom,
      active.occurrence,
    ]);
  const viewChanged = () => {
    lastViewKey = viewKey();
    publish({ accepted: true, failure: null, stateRevision, effects: [], events: [] });
  };
  const publicTransition = (transition: KernelTransition): KernelTransition => ({
    ...transition,
    stateRevision,
  });
  const showFailure = (child: Child) => {
    child.loading = false;
    if (child.host.querySelector("[data-epub-navigator-roll-failure]")) return;
    const notice = document.createElement("div");
    notice.dataset.epubNavigatorRollFailure = "";
    notice.setAttribute("role", "alert");
    Object.assign(notice.style, {
      position: "absolute",
      inset: "0",
      zIndex: "2",
      background: "Canvas",
      color: "CanvasText",
      padding: "12px",
      overflow: "auto",
    });
    notice.append(`Page ${child.occurrence + 1} could not be displayed. `);
    const retry = document.createElement("button");
    retry.textContent = "Retry page";
    retry.addEventListener("click", () => {
      if (active !== child) api.open(child.occurrence);
      api.reload();
    });
    notice.append(retry);
    child.host.append(notice);
  };
  const failureEvents = (child: Child): KernelEvent[] => {
    const failure = failures.get(child.occurrence);
    const resource = occurrenceLoadableTarget(order[child.occurrence])?.resource;
    if (failure === undefined || resource === undefined) return [];
    // Activating a cached failure must carry its occurrence to the existing reader Retry flow.
    return [
      {
        type: "document-pending",
        generation: failure.generation,
        occurrence: child.occurrence,
        resource,
      },
      failure.type === "document-load-failed"
        ? failure
        : {
            type: "document-load-failed",
            generation: failure.generation,
            reason: { reason: "unexpected-navigation" },
          },
    ];
  };
  const layout = (preserve = true) => {
    const anchor = preserve ? rollAnchor(boxes, scroller.scrollTop, scroller.clientHeight) : null;
    const width = scroller.clientWidth * zoom;
    boxes = rollBoxes(pages, width);
    stack.style.width = `${width}px`;
    stack.style.height = `${(boxes.at(-1)?.top ?? 0) + (boxes.at(-1)?.height ?? 0)}px`;
    for (const box of boxes) {
      const slot = loadingSlots.get(box.occurrence);
      if (slot !== undefined)
        Object.assign(slot.style, {
          top: `${box.top}px`,
          width: `${width}px`,
          height: `${box.height}px`,
        });
      const preview = previews.get(box.occurrence);
      if (preview !== undefined)
        Object.assign(preview.style, {
          top: `${box.top}px`,
          width: `${width}px`,
          height: `${box.height}px`,
        });
      const child = children.get(box.occurrence);
      if (child === undefined) continue;
      child.host.style.top = `${box.top}px`;
      child.host.style.width = `${width}px`;
      child.host.style.height = `${box.height}px`;
    }
    if (anchor !== null) {
      const box = boxes.find((item) => item.occurrence === anchor.occurrence);
      if (box !== undefined) scroller.scrollTop = box.top + box.height * anchor.fraction;
    }
  };
  const dispose = (child: Child) => {
    if (pinned === child) pinned = null;
    for (const unsubscribe of child.unsubscribe) unsubscribe();
    try {
      child.runtime.close();
    } catch {
      /* A terminal child may already have freed its kernel. */
    } finally {
      child.host.remove();
      children.delete(child.occurrence);
    }
  };
  const select = (child: Child, notify: boolean) => {
    if (active === child) return;
    if (navigationWork !== null) navigationChanged();
    const previous = active;
    active?.runtime.clearSelection();
    active = child;
    if (previous !== undefined && pagination !== undefined)
      previous.runtime.setPaginationCapabilities(undefined);
    child.runtime.setPaginationCapabilities(pagination);
    for (const item of children.values())
      item.host.dataset.epubNavigatorRollCurrent = String(item === child);
    publishSelection();
    if (notify) {
      const committed = currentDocument(child.runtime.snapshot());
      publish({
        stateRevision: child.runtime.snapshot().stateRevision,
        accepted: true,
        failure: null,
        effects: [],
        events: failures.has(child.occurrence)
          ? failureEvents(child)
          : committed === null
            ? []
            : [
                {
                  type: "document-committed",
                  generation: committed.generation,
                  occurrence: committed.frame.occurrence,
                  resource: committed.frame.resource,
                },
              ],
      });
    }
  };
  const makeChild = (occurrence: number, childKernel?: NavigatorKernelAccess): Child => {
    if (children.size >= ROLL_MAX_LIVE_CHILDREN)
      throw new Error("fixed roll child budget exceeded");
    childKernel ??= createInitializedNavigatorKernel(options.session.publication);
    const host = document.createElement("div");
    host.dataset.epubNavigatorRollOccurrence = String(occurrence);
    Object.assign(host.style, {
      position: "absolute",
      left: "0",
      overflow: "hidden",
      width: `${scroller.clientWidth * zoom}px`,
      height: `${scroller.clientWidth * zoom}px`,
      // A composited frame covers the page's stand-in image beneath it.
      zIndex: "1",
    });
    stack.append(host);
    const runtime = new RollChildRuntime(
      rollKernel(childKernel),
      options.session,
      host,
      options.frameTitle ?? "Publication content",
      resolveFrameProfile(options.session.publication.mount, document, options.frameSandbox),
      "foreground",
      options.diagnostics ?? null,
      createRuntime,
      options.documentObservation === true,
    );
    const child: Child = {
      runtime,
      host,
      occurrence,
      viewport: null,
      unsubscribe: [],
      loading: false,
    };
    children.set(occurrence, child);
    runtime.onViewport = (viewport) => {
      if (closed || children.get(child.occurrence) !== child) return;
      child.viewport = viewport;
      const page = pages.find((item) => item.occurrence === child.occurrence);
      if (page !== undefined && page.ratio !== viewport.height / viewport.width) {
        page.ratio = viewport.height / viewport.width;
        layout();
        schedule();
      }
    };
    runtime.onActivation = async (activation) => {
      if (activation.download !== null) return;
      const url = new URL(activation.resolvedUrl);
      const mount = new URL(options.session.publication.mount.baseUrl);
      if (
        url.origin !== mount.origin ||
        !url.pathname.startsWith(mount.pathname) ||
        url.search ||
        url.username ||
        url.password
      )
        return;
      const resource = decodePublicationRoute(mount.href, url.pathname);
      const occurrences = order.filter((item) =>
        occurrenceAliasesResource(options.session.publication.facts, item, resource),
      );
      const occurrence = occurrences.find((item) => item.linear === "yes") ?? occurrences[0];
      if (occurrence === undefined) return;
      const effectiveResource = occurrenceLoadableTarget(occurrence)?.resource;
      if (effectiveResource === undefined) return;
      const source = occurrenceLoadableTarget(order[child.occurrence]);
      const sourceBox = boxes.find((item) => item.occurrence === child.occurrence);
      const returnPosition =
        source === null
          ? null
          : {
              targetJson: resourceTarget(source.resource),
              occurrenceHint: { occurrence: child.occurrence, resource: source.resource },
              rollProgression:
                sourceBox === undefined
                  ? 0
                  : Math.max(
                      0,
                      Math.min(1, (scroller.scrollTop - sourceBox.top) / sourceBox.height),
                    ),
            };
      const targetJson = resourceTarget(effectiveResource);
      const result = await api.restoreAnnotationTarget({
        targetJson,
        occurrenceHint: { occurrence: occurrence.ordinal, resource: effectiveResource },
      });
      if (result.status === "restored" && url.hash && effectiveResource === resource)
        await api.relocate({
          kind: "point",
          occurrence: occurrence.ordinal,
          resource,
          evidence: [{ kind: "html-fragment", value: decodeURIComponent(url.hash.slice(1)) }],
          observation: { layoutProgression: null, renderedTextProgression: null },
        });
      footnote =
        result.status === "restored" && activation.footnote !== null && returnPosition !== null
          ? { id: ++footnoteId, position: returnPosition }
          : null;
      emit(
        footnotes,
        footnote === null
          ? null
          : { activationId: footnote.id, occurrence: occurrence.ordinal, resource },
      );
    };
    runtime.onScroll = (delta) => {
      navigationChanged();
      scroller.scrollLeft += delta.x;
      scroller.scrollTop += delta.y;
      schedule();
    };
    runtime.onGesture = (engaged) => {
      if (engaged) {
        pinned = child;
        select(child, true);
      } else if (
        pinned === child &&
        child.runtime.currentSelection().selection?.status !== "captured"
      ) {
        pinned = null;
        schedule();
      }
    };
    runtime.setPresentationPreferences(preferences);
    runtime.setPaginationCapabilities(undefined);
    if (configuration !== undefined) runtime.configure(configuration);
    if (projection !== undefined) runtime.setDecorationProjection(projection);
    let lastGeneration = 0;
    child.unsubscribe.push(
      runtime.subscribeErrors((error) => {
        if (closed || children.get(occurrence) !== child) return;
        const wasActive = active === child;
        if (wasActive && navigationWork !== null) navigationChanged("replacement");
        dispose(child);
        const replacement = makeChild(occurrence);
        const failure = {
          type: "document-load-failed" as const,
          generation: lastGeneration,
          reason: { reason: "effect-execution-failed" as const, message: error.message },
        };
        failures.set(occurrence, failure);
        showFailure(replacement);
        if (wasActive) {
          active = replacement;
          replacement.host.dataset.epubNavigatorRollCurrent = "true";
          publishSelection();
          publish({
            accepted: true,
            failure: null,
            stateRevision,
            effects: [],
            events: failureEvents(replacement),
          });
        }
        layout();
        schedule();
      }),
      runtime.subscribe((transition) => {
        if (closed || children.get(occurrence) !== child) return;
        for (const event of transition.events) {
          if (event.type === "document-pending") {
            child.loading = true;
            lastGeneration = event.generation;
          }
          if (event.type === "document-committed" || event.type === "document-cancelled")
            child.loading = false;
          if (event.type === "document-load-failed" || event.type === "document-invalidated") {
            failures.set(child.occurrence, event);
            showFailure(child);
          }
        }
        if (active === child) publish(transition);
        schedule();
      }),
      runtime.subscribeLocations(() => {
        if (!closed && children.get(occurrence) === child && active === child) publishLocation();
      }),
      runtime.subscribeSelections((snapshot) => {
        if (closed || children.get(occurrence) !== child) return;
        if (snapshot.selection?.status === "captured") {
          pinned = child;
          if (active !== child) select(child, true);
          else publishSelection();
        } else if (active === child) publishSelection();
      }),
    );
    for (const subscribe of eventSubscriptions) child.unsubscribe.push(subscribe(child));
    if (failures.has(occurrence)) showFailure(child);
    return child;
  };
  const reconcile = () => {
    if (closed || active.occurrence < 0) return;
    const window = rollWindow(boxes, scroller.scrollTop, scroller.clientHeight);
    let visibleCount = 0;
    for (const box of boxes)
      if (
        box.top + box.height > scroller.scrollTop &&
        box.top < scroller.scrollTop + scroller.clientHeight &&
        ++visibleCount > ROLL_WINDOW_BUDGET
      )
        break;
    capacityNotice.hidden = visibleCount <= ROLL_WINDOW_BUDGET;
    capacityZoom.disabled = zoom >= 4;
    // Stand-in images lead the mounted window: an entering frame is not composited until it
    // is exposed, so the page's own bytes have to be painted here well before it arrives.
    const previewed = new Set(
      rollPreviewWindow(boxes, scroller.scrollTop, scroller.clientHeight).map((box) => {
        if (!previews.has(box.occurrence)) {
          const target = occurrenceLoadableTarget(order[box.occurrence]);
          if (target?.adapter === "fixed-image") {
            const preview = document.createElement("img");
            preview.dataset.epubNavigatorRollPreview = String(box.occurrence);
            preview.crossOrigin = "anonymous";
            preview.decoding = "async";
            preview.alt = "";
            preview.setAttribute("aria-hidden", "true");
            preview.src = publicationResourceUrl(
              options.session.publication.mount,
              target.resource,
            );
            Object.assign(preview.style, {
              position: "absolute",
              left: "0",
              top: `${box.top}px`,
              width: `${scroller.clientWidth * zoom}px`,
              height: `${box.height}px`,
              objectFit: "contain",
              pointerEvents: "none",
              zIndex: "0",
              display: zoom === 1 ? "" : "none",
            });
            stack.append(preview);
            previews.set(box.occurrence, preview);
          }
        }
        return box.occurrence;
      }),
    );
    for (const [occurrence, preview] of previews)
      if (!previewed.has(occurrence)) {
        preview.remove();
        previews.delete(occurrence);
      }
    const desired = new Set(window.map((box) => box.occurrence));
    for (const [occurrence, slot] of loadingSlots)
      if (!desired.has(occurrence)) {
        slot.remove();
        loadingSlots.delete(occurrence);
      }
    for (const box of window) {
      const child = children.get(box.occurrence);
      if (
        failures.has(box.occurrence) ||
        (child !== undefined && currentDocument(child.runtime.snapshot()) !== null)
      ) {
        loadingSlots.get(box.occurrence)?.remove();
        loadingSlots.delete(box.occurrence);
      } else if (!loadingSlots.has(box.occurrence)) {
        const slot = document.createElement("div");
        slot.dataset.epubNavigatorRollLoading = String(box.occurrence);
        slot.textContent = `Loading page ${box.occurrence + 1}...`;
        Object.assign(slot.style, {
          position: "absolute",
          top: `${box.top}px`,
          left: "0",
          width: `${scroller.clientWidth * zoom}px`,
          height: `${box.height}px`,
          overflow: "hidden",
          pointerEvents: "none",
        });
        stack.append(slot);
        loadingSlots.set(box.occurrence, slot);
      }
    }
    desired.add(active.occurrence);
    for (const child of [...children.values()]) if (!desired.has(child.occurrence)) dispose(child);
    const loading = [...children.values()].filter((child) => child.loading).length;
    // A page entering the viewport must load before overscan the reader has already passed.
    const gap = (box: RollBox) =>
      Math.max(
        0,
        scroller.scrollTop - (box.top + box.height),
        box.top - (scroller.scrollTop + scroller.clientHeight),
      );
    const queue =
      capacityNotice.hidden && loading < ROLL_MAX_LOADING_CHILDREN
        ? [...window].sort((a, b) => gap(a) - gap(b) || a.top - b.top)
        : [];
    for (const box of queue) {
      if (children.has(box.occurrence)) continue;
      const child = makeChild(box.occurrence);
      layout();
      if (!failures.has(box.occurrence)) child.runtime.open(box.occurrence);
      else schedule();
      break;
    }
    const owner = rollAnchor(boxes, scroller.scrollTop, scroller.clientHeight)?.occurrence;
    const child = owner === undefined ? undefined : children.get(owner);
    if (
      pinned !== null &&
      !window.some(
        (box) =>
          box.occurrence === pinned!.occurrence &&
          box.top + box.height > scroller.scrollTop &&
          box.top < scroller.scrollTop + scroller.clientHeight,
      )
    )
      pinned = null;
    // A page that has not committed is not a better current page than one that has: promoting
    // it republishes an uncommitted snapshot and blanks a book that is already being read.
    const promotable =
      child !== undefined &&
      (currentDocument(child.runtime.snapshot()) !== null ||
        failures.has(child.occurrence) ||
        currentDocument(active.runtime.snapshot()) === null);
    if (child !== undefined && promotable && pinned === null && navigationWork === null)
      select(child, true);
    active.runtime.refreshRollSelectionGeometry();
    if (lastViewKey !== viewKey()) viewChanged();
    else publishLocation();
  };
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = view.requestAnimationFrame(() => {
      scheduled = 0;
      reconcile();
    });
  };
  const progression = () => {
    const box = boxes.find((item) => item.occurrence === active.occurrence);
    if (box === undefined || box.height <= 0) return null;
    // Offsets the scroller cannot reach cannot express a position, so the page's own span is
    // measured over what is reachable: the last page ends at one, not short of it.
    const span = rollReachableSpan(boxes, box, scroller.clientHeight);
    return span.end > span.start
      ? Math.max(0, Math.min(1, (scroller.scrollTop - span.start) / (span.end - span.start)))
      : 1;
  };
  const currentRollPosition = (): RollPosition => ({
    y: progression() ?? 0,
    x: Math.max(0, Math.min(1, scroller.scrollLeft / Math.max(1, scroller.clientWidth * zoom))),
    zoom,
    occurrence: active.occurrence,
  });
  const waitGeometry = (child: Child, work: RollWork): Promise<boolean> =>
    new Promise((resolve) => {
      if (workFailure(child, work) !== null || failures.has(child.occurrence)) {
        resolve(false);
        return;
      }
      let unsubscribe = () => {};
      let finished = false;
      const finish = (ready: boolean) => {
        if (finished) return;
        finished = true;
        unsubscribe();
        work.controller.signal.removeEventListener("abort", check);
        resolve(ready);
      };
      const check = () => {
        if (workFailure(child, work) !== null || failures.has(child.occurrence)) finish(false);
        else if (child.runtime.rollGeometryReady()) finish(true);
      };
      unsubscribe = child.runtime.subscribe(check);
      work.controller.signal.addEventListener("abort", check, { once: true });
      check();
    });
  const queryGeometry = async (
    child: Child,
    target: Parameters<RollChildRuntime["targetPoint"]>[0],
    work: RollWork,
  ): Promise<RollTargetPoint | null> => {
    while (await waitGeometry(child, work)) {
      const generation =
        child.runtime.snapshot().document.committed?.layout.layout.layoutGeneration;
      const point = await new Promise<RollTargetPoint | null>((resolve) => {
        const aborted = () => {
          work.controller.signal.removeEventListener("abort", aborted);
          resolve(null);
        };
        work.controller.signal.addEventListener("abort", aborted, { once: true });
        if (work.controller.signal.aborted) {
          aborted();
          return;
        }
        void child.runtime
          .targetPoint(target, {
            signal: work.controller.signal,
            timeoutMs: Math.max(0, work.deadline - performance.now()),
          })
          .then(
            (point) => {
              work.controller.signal.removeEventListener("abort", aborted);
              resolve(point);
            },
            () => {
              work.controller.signal.removeEventListener("abort", aborted);
              resolve(null);
            },
          );
      });
      if (point !== null || workFailure(child, work) !== null) return point;
      const layout = child.runtime.snapshot().document.committed?.layout;
      if (layout?.state === "settled" && layout.layout.layoutGeneration === generation) return null;
    }
    return null;
  };
  const reveal = async (
    child: Child,
    target: Parameters<RollChildRuntime["targetPoint"]>[0],
    work: RollWork,
    move = true,
    resolved?: RollTargetPoint,
  ): Promise<RollFailure | null> => {
    const initialFailure = workFailure(child, work);
    if (initialFailure !== null) return initialFailure;
    const generation = currentDocument(child.runtime.snapshot())?.generation;
    const point = resolved ?? (await queryGeometry(child, target, work));
    const failure = workFailure(child, work);
    if (failure !== null) return failure;
    if (
      generation !== currentDocument(child.runtime.snapshot())?.generation ||
      point === null ||
      child.viewport === null
    )
      return {
        status: "failed",
        reason: "unavailable",
        message: "the fixed roll target geometry became unavailable",
      };
    const box = boxes.find((item) => item.occurrence === child.occurrence);
    if (box === undefined)
      return {
        status: "failed",
        reason: "unavailable",
        message: "the fixed roll page is unavailable",
      };
    if (!move) return null;
    const scale = (scroller.clientWidth * zoom) / child.viewport.width;
    const x = Math.max(0, Math.min(child.viewport.width, point.x)) * scale;
    if (x < scroller.scrollLeft || x >= scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
    scroller.scrollTop = box.top + Math.max(0, Math.min(child.viewport.height, point.y)) * scale;
    schedule();
    active.runtime.refreshRollSelectionGeometry();
    viewChanged();
    return null;
  };
  const applyPosition = async (
    child: Child,
    position: RollPosition,
    work: RollWork,
  ): Promise<RollFailure | null> => {
    const failure = workFailure(child, work);
    if (failure !== null) return failure;
    const resized = position.zoom !== zoom;
    if (resized) api.setFixedZoom(position.zoom);
    const box = boxes.find((item) => item.occurrence === child.occurrence);
    if (box === undefined)
      return {
        status: "failed",
        reason: "unavailable",
        message: "the fixed roll page is unavailable",
      };
    const span = rollReachableSpan(boxes, box, scroller.clientHeight);
    scroller.scrollTop =
      span.end > span.start ? span.start + (span.end - span.start) * position.y : span.start;
    scroller.scrollLeft = position.x * scroller.clientWidth * zoom;
    schedule();
    active.runtime.refreshRollSelectionGeometry();
    viewChanged();
    if (resized && !(await waitGeometry(child, work)))
      return (
        workFailure(child, work) ?? {
          status: "failed",
          reason: "unavailable",
          message: "the fixed roll layout is unavailable",
        }
      );
    return workFailure(child, work);
  };
  const annotationOperation = async (
    targetJson: string,
    move: boolean,
  ): Promise<AnnotationTargetOperationResult> => {
    assertOpen();
    navigationChanged();
    const child = active;
    const { position } = parseRollTarget(targetJson);
    const plan = child.runtime.annotationPlan(targetJson);
    const committed = currentDocument(child.runtime.snapshot());
    if (
      committed === null ||
      plan.resource !== committed.frame.resource ||
      (position?.occurrence !== undefined && position.occurrence !== child.occurrence)
    )
      throw new TypeError("annotation target does not identify the current roll occurrence");
    const context = {
      operation: ++presentationOperation,
      generation: committed.generation,
      occurrence: child.occurrence,
      resource: plan.resource,
    };
    const work = beginWork();
    try {
      const point = await queryGeometry(child, { plan }, work);
      let failure = workFailure(child, work);
      if (failure === null && point?.annotation?.outcome !== "resolved")
        failure = {
          status: "failed",
          reason: "unavailable",
          message: "the fixed roll annotation geometry is unavailable",
        };
      if (failure !== null) return failedOperation(context, failure);
      if (move) {
        const resourceOnly =
          plan.selectors.length === 1 &&
          plan.selectors[0]?.kind === "resource" &&
          plan.selectors[0].refinements.length === 0;
        failure =
          position !== null || resourceOnly
            ? await applyPosition(child, position ?? { y: 0, x: 0, zoom }, work)
            : await reveal(child, { plan }, work, true, point!);
        if (failure !== null) return failedOperation(context, failure);
      }
      return { ...context, outcome: "completed", result: point!.annotation! };
    } finally {
      work.finish();
    }
  };
  active = makeChild(-1, kernel);
  if (pagination !== undefined) active.runtime.setPaginationCapabilities(pagination);
  layout(false);
  const subscribeEvent = <
    K extends
      | "subscribeInteractions"
      | "subscribePresentationActivity"
      | "subscribeDecorations"
      | "subscribeDecorationActivations"
      | "subscribeActivations"
      | "subscribeExternalFormAttempts"
      | "subscribePagination",
  >(
    method: K,
    listener: Parameters<NavigatorRuntime[K]>[0],
  ) => {
    const installed = new Map<Child, () => void>();
    const subscribe = (child: Child) => {
      const fn = child.runtime[method] as (listener: (value: never) => void) => () => void;
      const unsubscribe = fn.call(child.runtime, (value) => {
        if (closed || children.get(child.occurrence) !== child) return;
        if (method === "subscribeInteractions" || method === "subscribeDecorationActivations") {
          pinned = child;
          select(child, true);
        }
        if (
          method === "subscribeActivations" ||
          method === "subscribeExternalFormAttempts" ||
          active === child
        )
          (listener as (value: never) => void)(value);
      });
      installed.set(child, unsubscribe);
      return () => {
        unsubscribe();
        installed.delete(child);
      };
    };
    eventSubscriptions.add(subscribe);
    for (const child of children.values()) child.unsubscribe.push(subscribe(child));
    return () => {
      eventSubscriptions.delete(subscribe);
      for (const unsubscribe of installed.values()) unsubscribe();
      installed.clear();
    };
  };
  const api: NavigatorRuntime = {
    open(occurrence) {
      assertOpen();
      navigationChanged();
      pinned = null;
      // React's existing Try again action reopens an uncommitted current occurrence.
      if (active.occurrence === occurrence && failures.has(occurrence)) {
        failures.delete(occurrence);
        active.host.querySelector("[data-epub-navigator-roll-failure]")?.remove();
      }
      const box = boxes.find((item) => item.occurrence === occurrence);
      if (box === undefined)
        throw new RangeError("roll navigation requires a fixed reading-order occurrence");
      let child = children.get(occurrence);
      // Explicit navigation can replace pending work; it must not accumulate it.
      for (const other of [...children.values()])
        if (other !== active && other !== child && other.loading) dispose(other);
      if (child === undefined && children.size >= ROLL_MAX_LIVE_CHILDREN) {
        const victim = [...children.values()].find((item) => item !== active);
        if (victim !== undefined) dispose(victim);
      }
      if (child === undefined) child = makeChild(occurrence);
      const initial = children.get(-1);
      select(child, false);
      for (const other of [...children.values()])
        if (other !== child && other.loading) dispose(other);
      if (initial !== undefined) dispose(initial);
      layout(false);
      scroller.scrollTop = boxes.find((item) => item.occurrence === occurrence)!.top;
      const retained = new Set(
        rollWindow(boxes, scroller.scrollTop, scroller.clientHeight).map((item) => item.occurrence),
      );
      retained.add(occurrence);
      for (const mounted of [...children.values()])
        if (!retained.has(mounted.occurrence)) dispose(mounted);
      schedule();
      const failure = failures.get(occurrence);
      if (failure !== undefined) {
        showFailure(child);
        publish({
          accepted: true,
          failure: null,
          stateRevision,
          effects: [],
          events: failureEvents(child),
        });
        return lastTransition;
      }
      if (currentDocument(child.runtime.snapshot()) !== null) {
        select(child, false);
        const committed = currentDocument(child.runtime.snapshot())!;
        const transition: KernelTransition = {
          stateRevision: child.runtime.snapshot().stateRevision,
          accepted: true,
          failure: null,
          effects: [],
          events: [
            {
              type: "document-committed",
              generation: committed.generation,
              occurrence,
              resource: committed.frame.resource,
            },
          ],
        };
        publish(transition);
        return lastTransition;
      }
      if (!child.loading) child.runtime.open(occurrence);
      return lastTransition;
    },
    previousOccurrence() {
      const index = pages.findIndex((item) => item.occurrence === active.occurrence);
      return index > 0 ? pages[index - 1]!.occurrence : active.runtime.previousOccurrence();
    },
    nextOccurrence() {
      const index = pages.findIndex((item) => item.occurrence === active.occurrence);
      return index < pages.length - 1
        ? pages[index + 1]!.occurrence
        : active.runtime.nextOccurrence();
    },
    previous() {
      const index = pages.findIndex((item) => item.occurrence === active.occurrence);
      return index > 0
        ? api.open(pages[index - 1]!.occurrence)
        : publicTransition(active.runtime.previous());
    },
    next() {
      const index = pages.findIndex((item) => item.occurrence === active.occurrence);
      return index < pages.length - 1
        ? api.open(pages[index + 1]!.occurrence)
        : publicTransition(active.runtime.next());
    },
    reload() {
      assertOpen();
      navigationChanged("replacement");
      failures.delete(active.occurrence);
      active.host.querySelector("[data-epub-navigator-roll-failure]")?.remove();
      for (const child of [...children.values()])
        if (child !== active && child.loading) dispose(child);
      if (children.size >= ROLL_MAX_LIVE_CHILDREN) {
        const victim = [...children.values()].find((child) => child !== active);
        if (victim !== undefined) dispose(victim);
      }
      return publicTransition(
        currentDocument(active.runtime.snapshot()) === null
          ? active.runtime.open(active.occurrence)
          : active.runtime.reload(),
      );
    },
    cancel() {
      navigationChanged("replacement");
      return publicTransition(active.runtime.cancel());
    },
    attachFixedCompanion: () => {
      throw new Error("roll children do not admit spread companions");
    },
    detachFixedCompanion: () => {
      throw new Error("roll children do not admit spread companions");
    },
    evictPreparedFrames: () => publicTransition(active.runtime.evictPreparedFrames()),
    resolve(locator) {
      if (locator.kind === "point") {
        const position = rollEvidencePosition(locator.evidence);
        if (position?.occurrence !== undefined && position.occurrence !== locator.occurrence)
          throw new TypeError("roll point occurrence conflicts with its locator");
        return active.runtime.resolve({
          ...locator,
          evidence: kernelRollEvidence(locator.evidence),
        });
      }
      return active.runtime.resolve(locator);
    },
    async relocate(locator) {
      navigationChanged();
      const child = active;
      if (
        locator.occurrence !== child.occurrence ||
        occurrenceLoadableTarget(order[child.occurrence])?.resource !== locator.resource
      )
        throw new TypeError("locator does not identify the current roll occurrence");
      const position = locator.kind === "point" ? rollEvidencePosition(locator.evidence) : null;
      if (position?.occurrence !== undefined && position.occurrence !== locator.occurrence)
        throw new TypeError("roll point occurrence conflicts with its locator");
      const generation = child.runtime.snapshot().document.committed?.generation ?? 0;
      const work = beginWork();
      try {
        if (!(await waitGeometry(child, work)))
          return failedOperation(
            {
              operation: ++presentationOperation,
              generation,
              occurrence: locator.occurrence,
              resource: locator.resource,
            },
            workFailure(child, work) ?? {
              status: "failed",
              reason: "unavailable",
              message: "the fixed roll layout is unavailable",
            },
          );
        const result = await child.runtime.relocate(
          locator.kind === "point"
            ? { ...locator, evidence: kernelRollEvidence(locator.evidence) }
            : locator,
        );
        let failure = workFailure(child, work);
        if (
          failure === null &&
          result.outcome === "completed" &&
          result.status.status === "resolved"
        )
          failure =
            position === null
              ? await reveal(child, { locator }, work)
              : await applyPosition(child, position, work);
        return failure === null ? result : failedOperation(result, failure);
      } finally {
        work.finish();
      }
    },
    resolveAnnotationTarget: (target) => annotationOperation(target, false),
    relocateAnnotationTarget: (target) => annotationOperation(target, true),
    async restoreAnnotationTarget(position, settings) {
      navigationChanged();
      const deadline = performance.now() + (settings?.timeoutMs ?? 10_000);
      if (closed) return { status: "cancelled", reason: "close" };
      if (
        position === null ||
        typeof position !== "object" ||
        typeof position.targetJson !== "string"
      )
        return {
          status: "failed",
          reason: "invalid-position",
          message: "reading position is invalid",
        };
      if (settings?.signal?.aborted) return { status: "cancelled", reason: "abort" };
      if (
        settings?.timeoutMs !== undefined &&
        (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0)
      )
        return {
          status: "failed",
          reason: "invalid-position",
          message: "timeoutMs must be positive",
        };
      if (
        position.rollProgression !== undefined &&
        (!Number.isFinite(position.rollProgression) ||
          position.rollProgression < 0 ||
          position.rollProgression > 1)
      )
        return {
          status: "failed",
          reason: "invalid-position",
          message: "roll progression must be between zero and one",
        };
      let plan;
      let embedded: RollPosition | null;
      try {
        embedded = parseRollTarget(position.targetJson).position;
        if (
          embedded !== null &&
          position.rollProgression !== undefined &&
          !rollProgressionsAgree(embedded.y, position.rollProgression)
        )
          throw new TypeError(
            "embedded roll progression conflicts with the reading-position sidecar",
          );
        if (
          embedded?.occurrence !== undefined &&
          position.occurrenceHint !== null &&
          position.occurrenceHint?.occurrence !== embedded.occurrence
        )
          throw new TypeError("embedded roll occurrence conflicts with the occurrence hint");
        plan = active.runtime.annotationPlan(position.targetJson);
      } catch (cause) {
        return {
          status: "failed",
          reason: "invalid-position",
          message: cause instanceof Error ? cause.message : "invalid reading position",
        };
      }
      const occurrence =
        embedded?.occurrence ??
        position.occurrenceHint?.occurrence ??
        order.find((item) => occurrenceLoadableTarget(item)?.resource === plan.resource)?.ordinal;
      if (
        occurrence === undefined ||
        !Number.isSafeInteger(occurrence) ||
        occurrenceLoadableTarget(order[occurrence])?.resource !== plan.resource ||
        (position.occurrenceHint !== null &&
          (typeof position.occurrenceHint !== "object" ||
            position.occurrenceHint.resource !== plan.resource))
      )
        return {
          status: "failed",
          reason: "invalid-position",
          message: "reading position occurrence does not match its target",
        };
      if (occurrence !== undefined && occurrence !== active.occurrence) {
        try {
          api.open(occurrence);
        } catch {
          return {
            status: "failed",
            reason: "invalid-position",
            message: "reading position does not identify a fixed roll occurrence",
          };
        }
      }
      const child = active;
      if (failures.has(child.occurrence))
        return {
          status: "failed",
          reason: "unavailable",
          message: "the fixed roll page failed; retry the page before restoring its target",
        };
      const work = beginWork(settings?.signal, deadline);
      try {
        // The kernel owns source activation; the roll DOM agent resolves selector geometry.
        const result = await child.runtime.restoreAnnotationTarget(
          {
            targetJson: resourceTarget(plan.resource),
            occurrenceHint: { occurrence, resource: plan.resource },
          },
          { signal: work.controller.signal, timeoutMs: Math.max(1, deadline - performance.now()) },
        );
        let failure = workFailure(child, work);
        if (failure !== null) return failure;
        if (result.status === "restored") {
          const resourceOnly =
            plan.selectors.length === 1 &&
            plan.selectors[0]?.kind === "resource" &&
            plan.selectors[0].refinements.length === 0;
          const explicitPosition = embedded !== null || position.rollProgression !== undefined;
          if (!resourceOnly) {
            failure = await reveal(child, { plan }, work, !explicitPosition);
            if (failure !== null) return failure;
          }
          if ((resourceOnly || explicitPosition) && !closed && active === child) {
            failure = await applyPosition(
              child,
              embedded ?? { y: position.rollProgression ?? 0, x: 0, zoom },
              work,
            );
            if (failure !== null) return failure;
          }
        }
        failure = workFailure(child, work);
        if (failure !== null) return failure;
        return result;
      } finally {
        work.finish();
      }
    },
    async advancePresentation(direction) {
      assertOpen();
      navigationChanged();
      pinned = null;
      const committed = currentDocument(active.runtime.snapshot());
      if (committed === null) return active.runtime.advancePresentation(direction);
      const before = scroller.scrollTop;
      scroller.scrollTop += (direction === "forward" ? 1 : -1) * scroller.clientHeight * 0.9;
      schedule();
      return {
        operation: ++presentationOperation,
        generation: committed.generation,
        occurrence: committed.frame.occurrence,
        resource: committed.frame.resource,
        outcome: "completed",
        status: { status: before === scroller.scrollTop ? "boundary" : "advanced" },
      };
    },
    currentSelection: () => selection,
    captureSelection() {
      pinned = active;
      return active.runtime.captureSelection();
    },
    currentLocation: () => location,
    async captureCurrentLocation() {
      const child = active;
      const result = await child.runtime.captureCurrentLocation();
      if (closed || child !== active) return { status: "unavailable", basis: null };
      publishLocation();
      const visibleOccurrences = visibleRange();
      return result.status === "captured" &&
        visibleOccurrences !== null &&
        location.location !== null
        ? { ...result, location: location.location, visibleOccurrences }
        : result;
    },
    subscribeLocations(listener) {
      locations.add(listener);
      return () => locations.delete(listener);
    },
    clearSelection() {
      pinned = null;
      active.runtime.clearSelection();
      schedule();
    },
    generateSelectionAnnotationTarget(revision, settings) {
      pinned = active;
      return active.runtime.generateSelectionAnnotationTarget(
        revision === selection.revision ? active.runtime.currentSelection().revision : -1,
        settings,
      );
    },
    async generateCurrentLocationAnnotationTarget(revision) {
      publishLocation();
      const child = active;
      const captured = location;
      const position = currentRollPosition();
      const result = await child.runtime.generateCurrentLocationAnnotationTarget(
        revision === location.revision ? active.runtime.currentLocation().revision : -1,
      );
      if (!closed) publishLocation();
      if (result.outcome !== "completed" || result.result.status !== "generated") return result;
      if (
        closed ||
        child !== active ||
        revision !== captured.revision ||
        location.revision !== captured.revision
      )
        return { ...result, result: { status: "stale" } };
      const target = parseRollTarget(result.result.targetJson).target;
      const targetJson = JSON.stringify({ ...target, ...rollExtensions(position) });
      try {
        parseRollTarget(targetJson);
      } catch {
        return failedOperation(result, {
          status: "failed",
          reason: "unavailable",
          message: "generated roll target exceeds supported limits",
        });
      }
      return {
        ...result,
        result: {
          ...result.result,
          targetJson,
        },
      };
    },
    adjustAnnotationRange: (...args) => active.runtime.adjustAnnotationRange(...args),
    cancelSelectionAnnotationTargetGeneration: () =>
      publicTransition(active.runtime.cancelSelectionAnnotationTargetGeneration()),
    setDecorationProjection(value) {
      projection = value;
      for (const child of children.values()) child.runtime.setDecorationProjection(value);
    },
    decorationSnapshot: () => active.runtime.decorationSnapshot(),
    measureTocTargets: (...args) => active.runtime.measureTocTargets(...args),
    observeDocument: (...args) => active.runtime.observeDocument(...args),
    configure(value) {
      configuration = value;
      for (const child of children.values()) child.runtime.configure(value);
    },
    setPresentationPreferences(value) {
      preferences = value;
      let result: KernelTransition | undefined;
      for (const child of children.values()) {
        const transition = child.runtime.setPresentationPreferences(value);
        if (child === active) result = transition;
      }
      return publicTransition(result!);
    },
    snapshot: () => ({ ...active.runtime.snapshot(), stateRevision }),
    subscribe(listener) {
      transitions.add(listener);
      return () => transitions.delete(listener);
    },
    subscribeErrors(listener) {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    subscribeInteractions: (listener) => subscribeEvent("subscribeInteractions", listener),
    subscribePresentationActivity: (listener) =>
      subscribeEvent("subscribePresentationActivity", listener),
    subscribeSelections(listener) {
      selections.add(listener);
      return () => selections.delete(listener);
    },
    subscribeDecorations: (listener) => subscribeEvent("subscribeDecorations", listener),
    subscribeDecorationActivations: (listener) =>
      subscribeEvent("subscribeDecorationActivations", listener),
    subscribeActivations: (listener) => subscribeEvent("subscribeActivations", listener),
    subscribeExternalFormAttempts: (listener) =>
      subscribeEvent("subscribeExternalFormAttempts", listener),
    subscribeFootnotes(listener) {
      footnotes.add(listener);
      return () => footnotes.delete(listener);
    },
    async returnFromFootnote(id) {
      if (footnote === null) return { status: "unavailable" };
      if (footnote.id !== id) return { status: "stale" };
      const position = footnote.position;
      footnote = null;
      emit(footnotes, null);
      const result = await api.restoreAnnotationTarget(position);
      return {
        status:
          result.status === "restored"
            ? "returned"
            : result.status === "cancelled"
              ? "stale"
              : "failed",
      };
    },
    setActiveDecoration(...args) {
      for (const child of children.values()) child.runtime.setActiveDecoration(...args);
    },
    activateDecorationLink(activation) {
      const participant = activation.participant;
      if (participant.kind !== "primary") return;
      const child = [...children.values()].find(
        (item) =>
          currentDocument(item.runtime.snapshot())?.generation === participant.documentGeneration,
      );
      child?.runtime.activateDecorationLink(activation);
    },
    setMediaOverlayActive: async () => ({ status: "unsupported" }),
    findMediaOverlayEntry: async () => ({ status: "unsupported" }),
    paginationSnapshot: () => active.runtime.paginationSnapshot(),
    subscribePagination: (listener) => subscribeEvent("subscribePagination", listener),
    setPaginationCapabilities(value) {
      assertOpen();
      pagination = value;
      active.runtime.setPaginationCapabilities(value);
    },
    fixedViewState: () => (active.occurrence < 0 ? null : state()),
    fixedRollProgression: progression,
    visibleOccurrenceRange: visibleRange,
    // A roll presents one occurrence per view, so no spread closes the book.
    finalSpreadLeadingOccurrence: () => null,
    setFixedZoom(value, focal) {
      assertOpen();
      if (!Number.isFinite(value)) return null;
      const old = zoom;
      const childBox = boxes.find((box) => box.occurrence === active.occurrence);
      const scale =
        active.viewport === null ? 1 : (scroller.clientWidth * zoom) / active.viewport.width;
      const point =
        focal === undefined || !Number.isFinite(focal.x) || !Number.isFinite(focal.y)
          ? { x: scroller.clientWidth / 2, y: scroller.clientHeight / 2 }
          : {
              x: focal.x * scale - scroller.scrollLeft,
              y: (childBox?.top ?? 0) + focal.y * scale - scroller.scrollTop,
            };
      const anchor = {
        x: (scroller.scrollLeft + point.x) / old,
        y: (scroller.scrollTop + point.y) / old,
      };
      zoom = Math.max(1, Math.min(4, value));
      // A stand-in only matches the frame at intrinsic scale; zoom pans the frame alone.
      for (const preview of previews.values()) preview.style.display = zoom === 1 ? "" : "none";
      layout(false);
      scroller.scrollLeft = anchor.x * zoom - point.x;
      scroller.scrollTop = anchor.y * zoom - point.y;
      schedule();
      active.runtime.refreshRollSelectionGeometry();
      viewChanged();
      return state();
    },
    panFixedBy(delta: FixedViewPoint, intrinsic = false) {
      assertOpen();
      navigationChanged();
      if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return null;
      const scale =
        intrinsic && active.viewport !== null
          ? (scroller.clientWidth * zoom) / active.viewport.width
          : 1;
      scroller.scrollLeft -= delta.x * scale;
      scroller.scrollTop -= delta.y * scale;
      schedule();
      active.runtime.refreshRollSelectionGeometry();
      viewChanged();
      return state();
    },
    close() {
      if (closed) return lastTransition;
      closed = true;
      navigationChanged("close");
      lastTransition = {
        accepted: true,
        failure: null,
        stateRevision: ++stateRevision,
        effects: [],
        events: [{ type: "closed" }],
      };
      emit(transitions, lastTransition);
      view.cancelAnimationFrame(scheduled);
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      for (const child of [...children.values()]) {
        dispose(child);
      }
      scroller.remove();
      capacityNotice.remove();
      loadingSlots.clear();
      previews.clear();
      options.container.style.position = containerPosition;
      transitions.clear();
      errors.clear();
      locations.clear();
      selections.clear();
      footnotes.clear();
      eventSubscriptions.clear();
      return lastTransition;
    },
  };
  const observer = new ResizeObserver(() => {
    if (!closed) {
      layout();
      schedule();
    }
  });
  observer.observe(scroller);
  scroller.addEventListener("scroll", schedule, { passive: true });
  return api;
}
