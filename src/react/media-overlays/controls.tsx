import { useEffect, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import {
  AudioLines,
  CornerUpRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import {
  MEDIA_OVERLAY_RATES,
  type NavigatorMediaOverlayReason,
  type NavigatorMediaOverlaySnapshot,
  type NavigatorMediaOverlayTiming,
} from "../../runtime/media-overlays/controller.js";
import { Button } from "../components/ui/button.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover.js";
import { Switch } from "../components/ui/switch.js";
import { titleCase } from "../lib/utils.js";
import type { PreferencesSetter } from "../runtime/preferences.js";
import { narrationControlsVisible } from "./use-media-overlay-controller.js";
import { mediaOverlayControllerAtom } from "./state.js";
import {
  escapeNarrationAtom,
  nextNarrationSegmentAtom,
  pauseNarrationAtom,
  playNarrationAtom,
  previousNarrationSegmentAtom,
  stopNarrationAtom,
} from "./dispatch.js";

export function NarrationControls({
  snapshot,
  setPreferences,
  root,
}: {
  readonly snapshot: NavigatorMediaOverlaySnapshot | null;
  readonly setPreferences: PreferencesSetter;
  readonly root: HTMLElement | null;
}) {
  const store = useStore();
  const controllerReady = useAtomValue(mediaOverlayControllerAtom) !== null;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [timing, setTiming] = useState<NavigatorMediaOverlayTiming | null>(null);
  // Playback position is pulled, not pushed, and only while the popover is open.
  useEffect(() => {
    if (!optionsOpen || !controllerReady) return;
    const refresh = () => setTiming(store.get(mediaOverlayControllerAtom)?.timing() ?? null);
    refresh();
    const interval = setInterval(refresh, TIMING_REFRESH_MS);
    return () => clearInterval(interval);
  }, [optionsOpen, controllerReady, store, snapshot?.segmentIndex, snapshot?.overlayIndex]);
  useEffect(() => {
    if (!optionsOpen || root === null) return;
    const document = root.ownerDocument;
    const view = document.defaultView;
    if (view === null) return;
    // Presses inside the publication frame never reach the popover's outside-press handling.
    const dismissForPublicationFocus = () => {
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && root.contains(active)) setOptionsOpen(false);
      });
    };
    view.addEventListener("blur", dismissForPublicationFocus);
    return () => view.removeEventListener("blur", dismissForPublicationFocus);
  }, [optionsOpen, root]);
  const status = snapshot === null ? null : narrationStatus(snapshot.state, snapshot.reason);
  if (!narrationControlsVisible(snapshot) || snapshot === null || !controllerReady) {
    return status === null ? null : (
      <span className="sr-only" role="status">
        {status}
      </span>
    );
  }
  const playing = snapshot.state === "playing" || snapshot.state === "loading";
  const active = snapshot.segmentIndex !== null;
  const rateIndex = MEDIA_OVERLAY_RATES.indexOf(snapshot.rate);
  const setRate = (index: number) => {
    const narrationRate = MEDIA_OVERLAY_RATES[index];
    if (narrationRate !== undefined) setPreferences((current) => ({ ...current, narrationRate }));
  };
  return (
    <span className="epub-navigator-reader__narration" role="group" aria-label="Narration">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-5"
        data-rhea-local-action="compact"
        aria-label={playing ? "Pause narration" : "Play narration"}
        aria-pressed={playing}
        onClick={() => store.set(playing ? pauseNarrationAtom : playNarrationAtom)}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </Button>
      <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-5"
              data-rhea-local-action="compact"
              aria-label="Narration options"
            />
          }
        >
          <AudioLines aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          className="w-[min(18rem,calc(100cqw-1rem))]"
          portalContainer={root ?? undefined}
          positionerProps={{ side: "top", align: "center" }}
        >
          <div className="grid gap-3 p-3">
            <PopoverTitle className="text-center text-sm font-medium">Narration</PopoverTitle>
            <div
              className="flex items-center justify-center gap-2"
              role="group"
              aria-label="Narration position"
            >
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label="Previous narration segment"
                disabled={!active}
                onClick={() => store.set(previousNarrationSegmentAtom)}
              >
                <SkipBack aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label="Next narration segment"
                disabled={!active}
                onClick={() => store.set(nextNarrationSegmentAtom)}
              >
                <SkipForward aria-hidden="true" />
              </Button>
              {snapshot.escapable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  aria-label="Skip to end of structure"
                  onClick={() => store.set(escapeNarrationAtom)}
                >
                  <CornerUpRight aria-hidden="true" />
                </Button>
              ) : null}
              {active ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  aria-label="Stop narration"
                  onClick={() => store.set(stopNarrationAtom)}
                >
                  <Square aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  aria-label="Play narration"
                  onClick={() => store.set(playNarrationAtom)}
                >
                  <Play aria-hidden="true" />
                </Button>
              )}
            </div>
            <SectionTime timing={timing} />
            <div
              className="flex items-center justify-center gap-3"
              role="group"
              aria-label="Narration speed"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rateIndex <= 0}
                onClick={() => setRate(rateIndex - 1)}
              >
                Slower
              </Button>
              <output className="min-w-10 text-center tabular-nums" aria-live="polite">
                {`${snapshot.rate}×`}
              </output>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rateIndex >= MEDIA_OVERLAY_RATES.length - 1}
                onClick={() => setRate(rateIndex + 1)}
              >
                Faster
              </Button>
            </div>
            {snapshot.skippableTypes.length === 0 ? null : (
              <div className="grid gap-2 border-t border-border pt-3">
                {snapshot.skippableTypes.map((type) => {
                  const id = `narration-skip-${type}`;
                  return (
                    <div key={type} className="flex items-center justify-between gap-3">
                      <span id={id}>{`Skip ${titleCase(type.replaceAll("-", " "))}`}</span>
                      <Switch
                        checked={snapshot.skippedTypes.includes(type)}
                        aria-labelledby={id}
                        onCheckedChange={(checked) =>
                          setPreferences((current) => ({
                            ...current,
                            narrationSkippedTypes: checked
                              ? [...new Set([...current.narrationSkippedTypes, type])]
                              : current.narrationSkippedTypes.filter((item) => item !== type),
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <span className="sr-only" role="status">
        {status}
      </span>
    </span>
  );
}

const TIMING_REFRESH_MS = 250;

function SectionTime({ timing }: { readonly timing: NavigatorMediaOverlayTiming | null }) {
  const elapsed = timing === null ? null : formatDuration(timing.elapsedMs);
  const total = timing === null ? null : formatDuration(timing.totalMs);
  const fraction =
    timing === null || timing.totalMs <= 0 ? 0 : Math.min(1, timing.elapsedMs / timing.totalMs);
  return (
    <div className="grid gap-1.5">
      <div
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Section narration"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={timing === null ? undefined : `${elapsed} of ${total}`}
      >
        <div className="h-full bg-primary" style={{ inlineSize: `${fraction * 100}%` }} />
      </div>
      <p className="text-center text-xs tabular-nums text-muted-foreground">
        {timing === null ? "–:–– / –:––" : `${elapsed} / ${total}`}
      </p>
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function narrationStatus(
  state: NavigatorMediaOverlaySnapshot["state"],
  reason: NavigatorMediaOverlayReason | null,
): string | null {
  switch (state) {
    case "playing":
      return "Narration playing";
    case "paused":
      return "Narration paused";
    case "ended":
      return reason === "ambiguous-continuation"
        ? "Narration stopped: the next narrated section could not be determined"
        : "Narration finished";
    case "failed":
      return reason === "audio-failed"
        ? "Narration audio could not be played"
        : reason === "audio-unsupported"
          ? "Narration audio format is not supported"
          : "Narration is unavailable";
    default:
      return null;
  }
}
