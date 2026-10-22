import type {
  KernelTransition,
  NavigatorLocation,
  PublicationMount,
  ReadingOrderOccurrence,
} from "../../generated/kernel.js";
import {
  isNavigatorMediaOverlayDescription,
  isNavigatorMediaOverlayTimelineResult,
  mediaOverlayAudioUrl,
  mediaOverlayTimelineMatchesSummary,
  clipBeginMilliseconds,
  smilClockMilliseconds,
  type NavigatorMediaOverlayAssociation,
  type NavigatorMediaOverlayDescription,
  type NavigatorMediaOverlaySegment,
  type NavigatorMediaOverlayTimeline,
} from "../../media-overlays.js";
import { MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS } from "../agent-protocol/index.js";
import type { NavigatorRuntime } from "../navigator/api.js";
import type { PublicationMediaOverlayCapabilities } from "./capabilities.js";

import { isNavigatorMediaOverlayRate, type NavigatorMediaOverlayRate } from "./rates.js";

export {
  MEDIA_OVERLAY_RATES,
  isNavigatorMediaOverlayRate,
  type NavigatorMediaOverlayRate,
} from "./rates.js";

const DOCUMENT_COMMIT_TIMEOUT_MS = 10_000;
const SEEK_TOLERANCE_MS = 50;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export type NavigatorMediaOverlayState =
  | "unavailable"
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "failed";

export type NavigatorMediaOverlayReason =
  | "no-narration"
  | "no-narration-here"
  | "session-replaced"
  | "host-unavailable"
  | "invalid-description"
  | "timeline-unavailable"
  | "audio-failed"
  | "audio-unsupported"
  | "document-unavailable"
  | "ambiguous-continuation"
  | "unsupported-document";

export interface NavigatorMediaOverlaySnapshot {
  readonly state: NavigatorMediaOverlayState;
  readonly reason: NavigatorMediaOverlayReason | null;
  /** Whether narration can start from the current primary occurrence. */
  readonly playableHere: boolean;
  readonly occurrence: number | null;
  readonly overlayIndex: number | null;
  readonly segmentIndex: number | null;
  readonly escapable: boolean;
  readonly rate: NavigatorMediaOverlayRate;
  readonly skippedTypes: readonly string[];
  /** Skippable structure types declared by any loaded timeline. */
  readonly skippableTypes: readonly string[];
}

/** Minimal media element surface used by the controller. */
export interface NavigatorMediaOverlayAudio {
  src: string;
  currentTime: number;
  playbackRate: number;
  preservesPitch: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly error: { readonly code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: "src"): void;
  addEventListener(type: NavigatorMediaOverlayAudioEvent, listener: () => void): void;
  removeEventListener(type: NavigatorMediaOverlayAudioEvent, listener: () => void): void;
}

export type NavigatorMediaOverlayAudioEvent = "timeupdate" | "ended" | "error" | "pause" | "play";

export type NavigatorMediaOverlayRuntime = Pick<
  NavigatorRuntime,
  | "open"
  | "relocate"
  | "visibleOccurrenceRange"
  | "subscribe"
  | "subscribeLocations"
  | "subscribeInteractions"
  | "subscribePresentationActivity"
  | "setMediaOverlayActive"
  | "findMediaOverlayEntry"
>;

export interface CreateNavigatorMediaOverlayControllerOptions {
  readonly runtime: NavigatorMediaOverlayRuntime;
  readonly capabilities: PublicationMediaOverlayCapabilities;
  readonly mount: PublicationMount;
  readonly readingOrder: readonly ReadingOrderOccurrence[];
  readonly rate?: NavigatorMediaOverlayRate | undefined;
  readonly skippedTypes?: readonly string[] | undefined;
  readonly createAudio?: (() => NavigatorMediaOverlayAudio) | undefined;
}

/** Narration time within the active overlay timeline, from SMIL clip clocks. */
export interface NavigatorMediaOverlayTiming {
  readonly elapsedMs: number;
  readonly totalMs: number;
}

export interface NavigatorMediaOverlayController {
  snapshot(): NavigatorMediaOverlaySnapshot;
  /** Current timeline time, the time where narration was last stopped, or `null`. */
  timing(): NavigatorMediaOverlayTiming | null;
  subscribe(listener: (snapshot: NavigatorMediaOverlaySnapshot) => void): () => void;
  /** Starts from the rendered location, or resumes a paused segment. Requires a user action. */
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  nextSegment(): Promise<void>;
  previousSegment(): Promise<void>;
  escape(): Promise<void>;
  setRate(rate: NavigatorMediaOverlayRate): void;
  setSkippedTypes(types: readonly string[]): void;
  /** Reports intentional reader navigation that is not visible to the runtime subscriptions. */
  noteReaderNavigation(): void;
  close(): void;
}

interface Position {
  readonly occurrence: number;
  readonly overlayIndex: number;
  readonly segmentIndex: number;
}

export function createNavigatorMediaOverlayController(
  options: CreateNavigatorMediaOverlayControllerOptions,
): NavigatorMediaOverlayController {
  return new MediaOverlayController(options);
}

class MediaOverlayController implements NavigatorMediaOverlayController {
  readonly #runtime: NavigatorMediaOverlayRuntime;
  readonly #capabilities: PublicationMediaOverlayCapabilities;
  readonly #mount: PublicationMount;
  readonly #readingOrder: readonly ReadingOrderOccurrence[];
  readonly #createAudio: () => NavigatorMediaOverlayAudio;
  readonly #listeners = new Set<(snapshot: NavigatorMediaOverlaySnapshot) => void>();
  readonly #unsubscribers: (() => void)[] = [];
  readonly #requests = new AbortController();
  readonly #timelines = new Map<number, Promise<NavigatorMediaOverlayTimeline | null>>();
  readonly #loadedTimelines = new Map<number, NavigatorMediaOverlayTimeline>();
  #description: Promise<NavigatorMediaOverlayDescription | null> | null = null;
  #audio: NavigatorMediaOverlayAudio | null = null;
  #position: Position | null = null;
  #clipEnd: number | null = null;
  #clipTimer: ReturnType<typeof setTimeout> | null = null;
  #stoppedTiming: NavigatorMediaOverlayTiming | null = null;
  #run = 0;
  #following = 0;
  #pausePending = false;
  #closed = false;
  #snapshot: NavigatorMediaOverlaySnapshot;

  readonly #onTimeUpdate = () => this.#checkClipEnd();
  readonly #onEnded = () => {
    if (this.#snapshot.state === "playing") void this.#advance(this.#run);
  };
  readonly #onError = () => {
    if (this.#snapshot.state === "playing" || this.#snapshot.state === "loading") {
      this.#fail(
        this.#audio?.error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED
          ? "audio-unsupported"
          : "audio-failed",
      );
    }
  };
  // Media keys, the OS, or the WebView can pause or resume the element directly.
  readonly #onPause = () => {
    const audio = this.#audio;
    if (this.#pausePending) {
      this.#pausePending = false;
      return;
    }
    if (this.#snapshot.state === "playing" && audio !== null && audio.paused && !audio.ended) {
      this.pause();
    }
  };
  readonly #onPlay = () => {
    if (this.#snapshot.state === "paused" && this.#audio !== null && !this.#audio.paused) {
      void this.play();
    }
  };
  readonly #onCapabilityAbort = () => this.#becomeUnavailable("session-replaced");

  constructor(options: CreateNavigatorMediaOverlayControllerOptions) {
    this.#runtime = options.runtime;
    this.#capabilities = options.capabilities;
    this.#mount = options.mount;
    this.#readingOrder = options.readingOrder;
    this.#createAudio = options.createAudio ?? (() => new Audio());
    const available = options.capabilities.availability.status === "available";
    this.#snapshot = {
      state: available ? "idle" : "unavailable",
      reason: available ? null : "no-narration",
      playableHere: false,
      occurrence: null,
      overlayIndex: null,
      segmentIndex: null,
      escapable: false,
      rate: options.rate ?? "1",
      skippedTypes: [...(options.skippedTypes ?? [])],
      skippableTypes: [],
    };
    this.#snapshot = { ...this.#snapshot, playableHere: this.#playableAtPrimary() };
    if (this.#capabilities.signal.aborted) {
      this.#becomeUnavailable("session-replaced");
    } else {
      this.#capabilities.signal.addEventListener("abort", this.#onCapabilityAbort, { once: true });
    }
    this.#unsubscribers.push(
      this.#runtime.subscribeLocations((location) => {
        const primary = location.visibleOccurrences?.primaryOccurrence ?? null;
        const active = this.#position?.occurrence ?? null;
        if (
          this.#following === 0 &&
          this.#snapshot.state === "playing" &&
          active !== null &&
          primary !== null &&
          primary !== active
        ) {
          void this.#followNavigation(primary);
        }
        this.#publish({ playableHere: this.#playableAtPrimary() });
      }),
      this.#runtime.subscribeInteractions((interaction) => {
        // The narration command reaches the controller before the reader has acted on it, and
        // `play` from a standstill sets the loading state synchronously, so pausing here would
        // undo the very playback this keypress is asking for.
        if (interaction.command !== "narration") this.noteReaderNavigation();
      }),
      this.#runtime.subscribePresentationActivity(() => this.noteReaderNavigation()),
    );
  }

  snapshot(): NavigatorMediaOverlaySnapshot {
    return this.#snapshot;
  }

  timing(): NavigatorMediaOverlayTiming | null {
    const position = this.#position;
    const timeline =
      position === null ? undefined : this.#loadedTimelines.get(position.overlayIndex);
    if (position === null) return this.#stoppedTiming;
    if (timeline === undefined) return null;
    let totalMs = 0;
    let elapsedMs = 0;
    for (const [index, segment] of timeline.segments.entries()) {
      const begin = clipBeginMilliseconds(segment.clipBegin);
      const end = smilClockMilliseconds(segment.clipEnd);
      if (begin === null || end === null || end <= begin) continue;
      const duration = end - begin;
      totalMs += duration;
      if (index < position.segmentIndex) {
        elapsedMs += duration;
      } else if (index === position.segmentIndex) {
        const played = (this.#audio?.currentTime ?? 0) * 1000 - begin;
        elapsedMs += Math.min(duration, Math.max(0, played));
      }
    }
    return { elapsedMs, totalMs };
  }

  subscribe(listener: (snapshot: NavigatorMediaOverlaySnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async play(): Promise<void> {
    if (this.#closed || this.#snapshot.state === "unavailable") return;
    if (this.#snapshot.state === "playing" || this.#snapshot.state === "loading") return;
    const primary = this.#runtime.visibleOccurrenceRange()?.primaryOccurrence ?? null;
    const paused = this.#snapshot.state === "paused" ? this.#position : null;
    const run = ++this.#run;
    if (paused !== null && paused.occurrence === primary) {
      const visible = await this.#segmentVisible(paused);
      if (run !== this.#run) return;
      if (visible) {
        await this.#playSegment(paused, run, false);
        return;
      }
    }
    if (primary === null || !this.#playableAtPrimary()) {
      this.#publish({ state: "idle", reason: "no-narration-here" });
      return;
    }
    this.#publish({ state: "loading", reason: null });
    const position = await this.#entryPosition(primary, run, true);
    if (position === null || run !== this.#run) return;
    await this.#playSegment(position, run, true);
  }

  pause(): void {
    if (this.#snapshot.state !== "playing" && this.#snapshot.state !== "loading") return;
    this.#run += 1;
    this.#clearClipTimer();
    this.#pauseAudio();
    this.#publish({ state: this.#position === null ? "idle" : "paused", reason: null });
  }

  stop(): void {
    this.#stoppedTiming = this.timing();
    this.#run += 1;
    this.#clearClipTimer();
    this.#pauseAudio();
    this.#clearActive();
    this.#position = null;
    this.#clipEnd = null;
    if (this.#snapshot.state !== "unavailable") {
      this.#publish({ state: "idle", reason: null, ...emptyPosition() });
    }
  }

  async nextSegment(): Promise<void> {
    const position = this.#position;
    if (position === null) return;
    const timeline = this.#loadedTimelines.get(position.overlayIndex);
    if (timeline === undefined) return;
    const next = this.#nextPlayable(timeline, position.segmentIndex + 1);
    if (next === null) return;
    const run = ++this.#run;
    await this.#playSegment({ ...position, segmentIndex: next }, run, true);
  }

  async previousSegment(): Promise<void> {
    const position = this.#position;
    if (position === null) return;
    const timeline = this.#loadedTimelines.get(position.overlayIndex);
    if (timeline === undefined) return;
    let previous: number | null = null;
    for (let index = position.segmentIndex - 1; index >= 0; index -= 1) {
      if (this.#isPlayable(timeline, index)) {
        previous = index;
        break;
      }
    }
    const run = ++this.#run;
    if (previous === null) {
      await this.#continueBeforeTimeline(position, run);
      return;
    }
    await this.#playSegment({ ...position, segmentIndex: previous }, run, true);
  }

  async escape(): Promise<void> {
    const position = this.#position;
    if (position === null) return;
    const timeline = this.#loadedTimelines.get(position.overlayIndex);
    const current = timeline?.segments[position.segmentIndex];
    if (timeline === undefined || current === undefined) return;
    const depth = escapableDepth(timeline, current);
    if (depth === null) return;
    let target: number | null = null;
    for (let index = position.segmentIndex + 1; index < timeline.segments.length; index += 1) {
      if (
        !sharesContainer(timeline.segments[index]!, current, depth) &&
        this.#isPlayable(timeline, index)
      ) {
        target = index;
        break;
      }
    }
    const run = ++this.#run;
    if (target === null) {
      await this.#continueAfterTimeline(position, run);
      return;
    }
    await this.#playSegment({ ...position, segmentIndex: target }, run, true);
  }

  setRate(rate: NavigatorMediaOverlayRate): void {
    if (!isNavigatorMediaOverlayRate(rate)) throw new RangeError("unsupported narration rate");
    if (this.#audio !== null) this.#audio.playbackRate = Number(rate);
    this.#publish({ rate });
    this.#checkClipEnd();
  }

  setSkippedTypes(types: readonly string[]): void {
    this.#publish({ skippedTypes: [...new Set(types)] });
  }

  noteReaderNavigation(): void {
    if (this.#following === 0) this.pause();
  }

  // A page turn pauses through noteReaderNavigation, so a section that changes under live
  // narration was reached some other way: a table of contents entry, a link, a bookmark.
  // That is a request to be somewhere else, and narration goes there rather than stopping.
  async #followNavigation(occurrence: number): Promise<void> {
    const run = ++this.#run;
    this.#clearClipTimer();
    this.#pauseAudio();
    this.#publish({ state: "loading", reason: null });
    const position = await this.#entryPosition(occurrence, run, true);
    if (position === null || run !== this.#run) return;
    await this.#playSegment(position, run, true);
  }

  close(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
    this.#requests.abort();
    this.#capabilities.signal.removeEventListener("abort", this.#onCapabilityAbort);
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#detachAudio();
    this.#listeners.clear();
  }

  #playableAtPrimary(): boolean {
    const availability = this.#capabilities.availability;
    const primary = this.#runtime.visibleOccurrenceRange()?.primaryOccurrence;
    return (
      availability.status === "available" &&
      primary !== undefined &&
      availability.playableOccurrenceIndexes.includes(primary)
    );
  }

  async #segmentVisible(position: Position): Promise<boolean> {
    const description = await this.#loadDescription();
    const segment = this.#loadedTimelines.get(position.overlayIndex)?.segments[
      position.segmentIndex
    ];
    const fragment = segment === undefined ? null : textFragment(segment);
    if (description === null || fragment === null) return false;
    const metadata = packageClasses(description);
    const applied = await this.#runtime.setMediaOverlayActive({
      occurrence: position.occurrence,
      fragment,
      activeClasses: metadata.active,
      playbackActiveClasses: metadata.playback,
    });
    return applied.status === "applied" && applied.visible;
  }

  async #entryPosition(
    occurrence: number,
    run: number,
    useRenderedLocation: boolean,
  ): Promise<Position | null> {
    const description = await this.#loadDescription();
    if (description === null || run !== this.#run) return null;
    const association = playableAssociation(description, occurrence);
    if (association === null || association.overlay.state !== "resolved") {
      this.#publish({ state: "idle", reason: "no-narration-here" });
      return null;
    }
    const overlayIndex = association.overlay.overlayIndex;
    const timeline = await this.#loadTimeline(description, overlayIndex);
    if (run !== this.#run) return null;
    if (timeline === null) {
      this.#fail("timeline-unavailable");
      return null;
    }
    const candidates = association.entrySegmentIndexes.filter((index) =>
      this.#isPlayable(timeline, index),
    );
    if (candidates.length === 0) {
      this.#publish({ state: "idle", reason: "no-narration-here" });
      return null;
    }
    let chosen = candidates[0]!;
    if (useRenderedLocation) {
      const fragments = candidates
        .slice(0, MAX_MEDIA_OVERLAY_ENTRY_FRAGMENTS)
        .map((index) => textFragment(timeline.segments[index]!));
      if (fragments.every((fragment) => fragment !== null)) {
        const entry = await this.#runtime.findMediaOverlayEntry(occurrence, fragments);
        if (run !== this.#run) return null;
        if (entry.status === "found") chosen = candidates[entry.index] ?? chosen;
        if (entry.status === "unsupported") {
          this.#fail("unsupported-document");
          return null;
        }
      }
    }
    return { occurrence, overlayIndex, segmentIndex: chosen };
  }

  async #playSegment(position: Position, run: number, seek: boolean): Promise<void> {
    const description = await this.#loadDescription();
    if (description === null || run !== this.#run) return;
    const timeline = await this.#loadTimeline(description, position.overlayIndex);
    if (run !== this.#run) return;
    if (timeline === null) {
      this.#fail("timeline-unavailable");
      return;
    }
    const segment = timeline.segments[position.segmentIndex];
    const fragment = segment === undefined ? null : textFragment(segment);
    const resource = segment === undefined ? null : textResource(segment);
    if (segment === undefined || fragment === null || resource === null) {
      this.#fail("timeline-unavailable");
      return;
    }
    let occurrence = position.occurrence;
    if (occurrenceResource(this.#readingOrder, occurrence) !== resource) {
      const mapped = continuationOccurrence(
        description,
        this.#readingOrder,
        occurrence,
        position.overlayIndex,
        resource,
        this.#position !== null &&
          this.#position.overlayIndex === position.overlayIndex &&
          position.segmentIndex < this.#position.segmentIndex
          ? "backward"
          : "forward",
      );
      if (mapped === null) {
        this.#stopWith("ambiguous-continuation");
        return;
      }
      occurrence = mapped;
    }
    const current: Position = {
      occurrence,
      overlayIndex: position.overlayIndex,
      segmentIndex: position.segmentIndex,
    };
    this.#position = current;
    this.#stoppedTiming = null;
    this.#publish({
      state: "loading",
      reason: null,
      occurrence,
      overlayIndex: current.overlayIndex,
      segmentIndex: current.segmentIndex,
      escapable: escapableDepth(timeline, segment) !== null,
    });
    if (!(await this.#ensureOccurrence(occurrence, run))) {
      if (run === this.#run) this.#fail("document-unavailable");
      return;
    }
    const metadata = packageClasses(description);
    const applied = await this.#runtime.setMediaOverlayActive({
      occurrence,
      fragment,
      activeClasses: metadata.active,
      playbackActiveClasses: metadata.playback,
    });
    if (run !== this.#run) return;
    if (applied.status === "unsupported") {
      this.#fail("unsupported-document");
      return;
    }
    if (applied.status === "applied" && !applied.visible) {
      await this.#follow(occurrence, resource, fragment);
      if (run !== this.#run) return;
    }
    const url = mediaOverlayAudioUrl(this.#mount, segment.audio.reference);
    const begin = clipBeginMilliseconds(segment.clipBegin);
    if (url === null || begin === null) {
      this.#fail("audio-failed");
      return;
    }
    this.#clipEnd = smilClockMilliseconds(segment.clipEnd);
    const audio = this.#attachAudio();
    const sourceChanged = audio.src !== url;
    if (sourceChanged) audio.src = url;
    // Contiguous audio keeps running through the text follow; seeking back would replay it.
    if (sourceChanged || seek || audio.currentTime * 1000 < begin - SEEK_TOLERANCE_MS) {
      audio.currentTime = begin / 1000;
    }
    audio.playbackRate = Number(this.#snapshot.rate);
    audio.preservesPitch = true;
    try {
      await audio.play();
    } catch (error) {
      if (run === this.#run) {
        this.#fail(
          error instanceof DOMException && error.name === "NotSupportedError"
            ? "audio-unsupported"
            : "audio-failed",
        );
      }
      return;
    }
    if (run !== this.#run) {
      this.#pauseAudio();
      return;
    }
    this.#publish({ state: "playing", reason: null });
    this.#checkClipEnd();
  }

  // timeupdate fires only every ~250 ms; a timer ends each clip on time.
  #checkClipEnd(): void {
    this.#clearClipTimer();
    if (this.#snapshot.state !== "playing" || this.#clipEnd === null || this.#audio === null)
      return;
    const remaining = this.#clipEnd - this.#audio.currentTime * 1000;
    if (remaining <= 0) {
      void this.#advance(this.#run);
      return;
    }
    const rate = this.#audio.playbackRate > 0 ? this.#audio.playbackRate : 1;
    this.#clipTimer = setTimeout(() => {
      this.#clipTimer = null;
      this.#checkClipEnd();
    }, remaining / rate);
  }

  #clearClipTimer(): void {
    if (this.#clipTimer === null) return;
    clearTimeout(this.#clipTimer);
    this.#clipTimer = null;
  }

  async #advance(run: number): Promise<void> {
    const position = this.#position;
    if (position === null || run !== this.#run) return;
    const next = ++this.#run;
    this.#clearClipTimer();
    const timeline = this.#loadedTimelines.get(position.overlayIndex);
    const following =
      timeline === undefined ? null : this.#nextPlayable(timeline, position.segmentIndex + 1);
    if (following !== null) {
      const current = timeline!.segments[position.segmentIndex]!;
      const upcoming = timeline!.segments[following]!;
      const currentEnd = smilClockMilliseconds(current.clipEnd);
      const contiguous =
        following === position.segmentIndex + 1 &&
        sameAudio(current, upcoming) &&
        currentEnd !== null &&
        currentEnd === clipBeginMilliseconds(upcoming.clipBegin);
      if (!contiguous) this.#pauseAudio();
      await this.#playSegment({ ...position, segmentIndex: following }, next, !contiguous);
      return;
    }
    this.#pauseAudio();
    await this.#continueAfterTimeline(position, next);
  }

  async #continueAfterTimeline(position: Position, run: number): Promise<void> {
    const description = await this.#loadDescription();
    if (description === null || run !== this.#run) return;
    for (
      let occurrence = position.occurrence + 1;
      occurrence < this.#readingOrder.length;
      occurrence += 1
    ) {
      const association =
        description.playback.state === "available"
          ? description.playback.associations.find((item) => item.occurrenceIndex === occurrence)
          : undefined;
      if (association?.effectiveLinear === "no") continue;
      if (
        association === undefined ||
        association.overlay.state !== "resolved" ||
        this.#capabilities.availability.status !== "available" ||
        !this.#capabilities.availability.playableOccurrenceIndexes.includes(occurrence)
      ) {
        break;
      }
      const entry = await this.#entryPosition(occurrence, run, false);
      if (entry === null || run !== this.#run) return;
      await this.#playSegment(entry, run, true);
      return;
    }
    this.#pauseAudio();
    this.#clearActive();
    this.#position = null;
    this.#publish({ state: "ended", reason: null, ...emptyPosition() });
  }

  async #continueBeforeTimeline(position: Position, run: number): Promise<void> {
    this.#pauseAudio();
    const description = await this.#loadDescription();
    if (description === null || run !== this.#run) return;
    for (let occurrence = position.occurrence - 1; occurrence >= 0; occurrence -= 1) {
      const association = playableAssociation(description, occurrence);
      if (association?.effectiveLinear === "no") continue;
      if (
        association === null ||
        association.overlay.state !== "resolved" ||
        this.#capabilities.availability.status !== "available" ||
        !this.#capabilities.availability.playableOccurrenceIndexes.includes(occurrence)
      ) {
        break;
      }
      const overlayIndex = association.overlay.overlayIndex;
      const timeline = await this.#loadTimeline(description, overlayIndex);
      if (run !== this.#run) return;
      if (timeline === null) continue;
      const resource = occurrenceResource(this.#readingOrder, occurrence);
      for (let index = timeline.segments.length - 1; index >= 0; index -= 1) {
        if (
          this.#isPlayable(timeline, index) &&
          textResource(timeline.segments[index]!) === resource
        ) {
          await this.#playSegment({ occurrence, overlayIndex, segmentIndex: index }, run, true);
          return;
        }
      }
    }
    await this.#playSegment(position, run, true);
  }

  async #ensureOccurrence(occurrence: number, run: number): Promise<boolean> {
    if (this.#runtime.visibleOccurrenceRange()?.primaryOccurrence === occurrence) return true;
    this.#following += 1;
    try {
      const committed = this.#waitForCommit(occurrence);
      const transition = this.#runtime.open(occurrence);
      if (!transition.accepted) {
        committed.cancel();
        return false;
      }
      if (committedIn(transition, occurrence)) {
        committed.cancel();
        return run === this.#run;
      }
      return (await committed.promise) && run === this.#run;
    } finally {
      this.#following -= 1;
    }
  }

  #waitForCommit(occurrence: number): { promise: Promise<boolean>; cancel: () => void } {
    let finish: (value: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => done(false), DOCUMENT_COMMIT_TIMEOUT_MS);
    const unsubscribe = this.#runtime.subscribe((transition) => {
      if (committedIn(transition, occurrence)) done(true);
    });
    const done = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      finish(value);
    };
    return { promise, cancel: () => done(false) };
  }

  async #follow(occurrence: number, resource: string, fragment: string): Promise<void> {
    const locator: NavigatorLocation = {
      kind: "point",
      occurrence,
      resource,
      evidence: [{ kind: "html-fragment", value: fragment }],
      observation: { layoutProgression: null, renderedTextProgression: null },
    };
    this.#following += 1;
    try {
      await this.#runtime.relocate(locator);
    } catch {
      // Following is best effort; playback continues when the target cannot be revealed.
    } finally {
      this.#following -= 1;
    }
  }

  async #loadDescription(): Promise<NavigatorMediaOverlayDescription | null> {
    this.#description ??= this.#capabilities
      .description({ signal: this.#requests.signal })
      .then((outcome) => {
        if (outcome.status !== "ok") {
          this.#becomeUnavailable(
            outcome.reason === "session-replaced" ? "session-replaced" : "host-unavailable",
          );
          return null;
        }
        if (!isNavigatorMediaOverlayDescription(outcome.description)) {
          this.#fail("invalid-description");
          return null;
        }
        return outcome.description;
      })
      .catch(() => {
        if (!this.#closed) this.#becomeUnavailable("host-unavailable");
        return null;
      });
    const description = await this.#description;
    if (description === null) this.#description = null;
    return description;
  }

  async #loadTimeline(
    description: NavigatorMediaOverlayDescription,
    overlayIndex: number,
  ): Promise<NavigatorMediaOverlayTimeline | null> {
    if (description.playback.state !== "available") return null;
    const summary = description.playback.overlays[overlayIndex];
    if (summary === undefined || summary.availability.state !== "available") return null;
    let pending = this.#timelines.get(overlayIndex);
    if (pending === undefined) {
      pending = this.#capabilities
        .timeline(overlayIndex, { signal: this.#requests.signal })
        .then((outcome) => {
          if (outcome.status !== "ok") {
            if (outcome.reason === "session-replaced") this.#becomeUnavailable("session-replaced");
            return null;
          }
          const result = outcome.result;
          if (
            !isNavigatorMediaOverlayTimelineResult(result) ||
            !mediaOverlayTimelineMatchesSummary(result, summary) ||
            result.state !== "available"
          ) {
            return null;
          }
          this.#loadedTimelines.set(overlayIndex, result.timeline);
          this.#publish({ skippableTypes: this.#skippableTypes() });
          return result.timeline;
        })
        .catch(() => null);
      this.#timelines.set(overlayIndex, pending);
    }
    const timeline = await pending;
    if (timeline === null) this.#timelines.delete(overlayIndex);
    return timeline;
  }

  #isPlayable(timeline: NavigatorMediaOverlayTimeline, index: number): boolean {
    const segment = timeline.segments[index];
    if (segment === undefined || segment.playability.state !== "playable") return false;
    if (textFragment(segment) === null) return false;
    const skipped = this.#snapshot.skippedTypes.filter((type) => timeline.skippable.includes(type));
    return !segment.semanticPath.some((node) =>
      node.epubTypes.some((type) => skipped.includes(type)),
    );
  }

  #nextPlayable(timeline: NavigatorMediaOverlayTimeline, from: number): number | null {
    for (let index = from; index < timeline.segments.length; index += 1) {
      if (this.#isPlayable(timeline, index)) return index;
    }
    return null;
  }

  #skippableTypes(): string[] {
    return [
      ...new Set([...this.#loadedTimelines.values()].flatMap((timeline) => timeline.skippable)),
    ];
  }

  #attachAudio(): NavigatorMediaOverlayAudio {
    if (this.#audio === null) {
      this.#audio = this.#createAudio();
      this.#audio.addEventListener("timeupdate", this.#onTimeUpdate);
      this.#audio.addEventListener("ended", this.#onEnded);
      this.#audio.addEventListener("error", this.#onError);
      this.#audio.addEventListener("pause", this.#onPause);
      this.#audio.addEventListener("play", this.#onPlay);
    }
    return this.#audio;
  }

  #pauseAudio(): void {
    if (this.#audio === null || this.#audio.paused) return;
    this.#pausePending = true;
    this.#audio.pause();
  }

  #detachAudio(): void {
    if (this.#audio === null) return;
    this.#audio.pause();
    this.#audio.removeEventListener("timeupdate", this.#onTimeUpdate);
    this.#audio.removeEventListener("ended", this.#onEnded);
    this.#audio.removeEventListener("error", this.#onError);
    this.#audio.removeEventListener("pause", this.#onPause);
    this.#audio.removeEventListener("play", this.#onPlay);
    this.#audio.removeAttribute("src");
    this.#audio.load();
    this.#audio = null;
    this.#pausePending = false;
  }

  #clearActive(): void {
    void this.#runtime.setMediaOverlayActive(null).catch(() => undefined);
  }

  #stopWith(reason: NavigatorMediaOverlayReason): void {
    this.#run += 1;
    this.#clearClipTimer();
    this.#pauseAudio();
    this.#clearActive();
    this.#position = null;
    this.#publish({ state: "ended", reason, ...emptyPosition() });
  }

  #fail(reason: NavigatorMediaOverlayReason): void {
    this.#run += 1;
    this.#clearClipTimer();
    // A failed media element keeps its error state for the same src; the next Play needs a new one.
    if (reason === "audio-failed" || reason === "audio-unsupported") this.#detachAudio();
    else this.#pauseAudio();
    this.#clearActive();
    this.#position = null;
    this.#publish({ state: "failed", reason, ...emptyPosition() });
  }

  #becomeUnavailable(reason: NavigatorMediaOverlayReason): void {
    this.#run += 1;
    this.#clearClipTimer();
    this.#pauseAudio();
    if (!this.#closed) this.#clearActive();
    this.#position = null;
    this.#publish({ state: "unavailable", reason, playableHere: false, ...emptyPosition() });
  }

  #publish(change: Partial<NavigatorMediaOverlaySnapshot>): void {
    if (this.#closed) return;
    const next = { ...this.#snapshot, ...change };
    if (next.state === "unavailable") next.playableHere = false;
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = Object.freeze(next);
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#snapshot);
      } catch {
        // Narration observers cannot alter playback ownership or other observers.
      }
    }
  }
}

function emptyPosition() {
  return { occurrence: null, overlayIndex: null, segmentIndex: null, escapable: false } as const;
}

function playableAssociation(
  description: NavigatorMediaOverlayDescription,
  occurrence: number,
): NavigatorMediaOverlayAssociation | null {
  if (description.playback.state !== "available") return null;
  return (
    description.playback.associations.find(
      (association) =>
        association.occurrenceIndex === occurrence && association.overlay.state === "resolved",
    ) ?? null
  );
}

function packageClasses(description: NavigatorMediaOverlayDescription) {
  if (description.package.state !== "available") return { active: [], playback: [] };
  const tokens = (values: readonly string[]) =>
    [
      ...new Set(values.flatMap((value) => value.split(/\s+/)).filter((token) => token.length > 0)),
    ].slice(0, 32);
  return {
    active: tokens(description.package.metadata.activeClasses),
    playback: tokens(description.package.metadata.playbackActiveClasses),
  };
}

function textFragment(segment: NavigatorMediaOverlaySegment): string | null {
  const reference = segment.text.reference;
  return reference.state === "local-fragment" ? reference.fragment : null;
}

function textResource(segment: NavigatorMediaOverlaySegment): string | null {
  const reference = segment.text.reference;
  return reference.state === "local-fragment" || reference.state === "local-resource"
    ? reference.canonicalPath
    : null;
}

function occurrenceResource(
  readingOrder: readonly ReadingOrderOccurrence[],
  occurrence: number,
): string | null {
  const document = readingOrder[occurrence]?.document;
  return document?.state === "loadable" ? document.resource : null;
}

function continuationOccurrence(
  description: NavigatorMediaOverlayDescription,
  readingOrder: readonly ReadingOrderOccurrence[],
  from: number,
  overlayIndex: number,
  resource: string,
  direction: "forward" | "backward",
): number | null {
  if (description.playback.state !== "available") return null;
  const candidates = description.playback.associations.filter(
    (association) =>
      (direction === "forward"
        ? association.occurrenceIndex > from
        : association.occurrenceIndex < from) &&
      association.overlay.state === "resolved" &&
      association.overlay.overlayIndex === overlayIndex &&
      occurrenceResource(readingOrder, association.occurrenceIndex) === resource,
  );
  return (direction === "forward" ? candidates[0] : candidates.at(-1))?.occurrenceIndex ?? null;
}

function escapableDepth(
  timeline: NavigatorMediaOverlayTimeline,
  segment: NavigatorMediaOverlaySegment,
): number | null {
  for (let depth = segment.semanticPath.length - 1; depth >= 0; depth -= 1) {
    if (segment.semanticPath[depth]!.epubTypes.some((type) => timeline.escapable.includes(type))) {
      return depth;
    }
  }
  return null;
}

function sharesContainer(
  candidate: NavigatorMediaOverlaySegment,
  current: NavigatorMediaOverlaySegment,
  depth: number,
): boolean {
  if (candidate.semanticPath.length <= depth) return false;
  for (let level = 0; level <= depth; level += 1) {
    if (
      JSON.stringify(candidate.semanticPath[level]) !== JSON.stringify(current.semanticPath[level])
    ) {
      return false;
    }
  }
  return true;
}

function sameAudio(
  left: NavigatorMediaOverlaySegment,
  right: NavigatorMediaOverlaySegment,
): boolean {
  return JSON.stringify(left.audio.reference) === JSON.stringify(right.audio.reference);
}

function committedIn(transition: KernelTransition, occurrence: number): boolean {
  return transition.events.some(
    (event) => event.type === "document-committed" && event.occurrence === occurrence,
  );
}
