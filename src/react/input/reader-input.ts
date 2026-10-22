import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { DocumentObservation, ReflowableLayoutMode } from "../../generated/kernel.js";
import type { NavigatorReaderPreferences } from "../public-types.js";
import { readerKeyCommand, type ReaderCommand } from "../../runtime/reader-commands.js";
import {
  editableKeyboardTarget,
  parentOwnedPublicationEvent,
  shellKeyDirection,
  shellOwnsKeyboardFocus,
  visiblePrimaryPublicationFrame,
} from "./focus.js";

interface ReaderInputOptions {
  readonly readerRoot: RefObject<HTMLElement | null>;
  readonly frameHost: RefObject<HTMLDivElement | null>;
  readonly keyboardMode: NavigatorReaderPreferences["keyboardMode"];
  readonly selectionActive: boolean;
  readonly touchZones: boolean;
  readonly clickZones: boolean;
  readonly onCommand: (command: ReaderCommand) => void;
  readonly changeSection: (direction: "previous" | "next") => void;
  readonly moveBoundary: (boundary: "start" | "end") => void;
  readonly writingMode: DocumentObservation["writingMode"] | undefined;
  readonly progressionDirection: "ltr" | "rtl";
  readonly advancePresentation: (direction: "forward" | "backward") => void;
  readonly presentationMode: ReflowableLayoutMode | "fixed" | "unavailable" | undefined;
}

/** Keys a focused control answers itself, which the reader therefore leaves to it. */
const controlReservedKeys = new Set([
  " ",
  "Enter",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

export function useReaderInput({
  readerRoot,
  frameHost,
  keyboardMode,
  selectionActive,
  touchZones,
  clickZones,
  onCommand,
  changeSection,
  moveBoundary,
  writingMode,
  progressionDirection,
  advancePresentation,
  presentationMode,
}: ReaderInputOptions): {
  readonly handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly handlePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly cancelPointer: () => void;
} {
  const pendingG = useRef<number | null>(null);
  const blankPress = useRef<{
    pointerId: number;
    x: number;
    y: number;
    time: number;
    target: EventTarget | null;
  } | null>(null);

  useEffect(() => {
    const root = readerRoot.current;
    const container = frameHost.current;
    if (root === null || container === null) return;
    const document = root.ownerDocument;
    const region = container.parentElement;
    if (region === null) return;
    const handleKey = (event: KeyboardEvent) => {
      const previousG = pendingG.current;
      pendingG.current = null;
      const ownsFocus = shellOwnsKeyboardFocus(
        document.activeElement,
        document,
        root,
        region,
        container,
      );
      // Closing a menu leaves focus on the control that opened it. A movement key that the
      // control has no use for still moves the reader, so the book answers the keyboard again
      // without a click back into it.
      const active = document.activeElement;
      const controlHoldsFocus =
        !ownsFocus &&
        active instanceof HTMLElement &&
        root.contains(active) &&
        !editableKeyboardTarget(active) &&
        !controlReservedKeys.has(event.key);
      const movesReader = ownsFocus || controlHoldsFocus;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        editableKeyboardTarget(event.target) ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        ) !== null
      )
        return;
      const command = readerKeyCommand(event, keyboardMode, selectionActive);
      if ((command === "highlight" || command === "note") && !event.isTrusted) return;
      if (
        command !== null &&
        (ownsFocus || (event.target instanceof Node && root.contains(event.target)))
      ) {
        event.preventDefault();
        onCommand(command);
        return;
      }
      if (
        movesReader &&
        keyboardMode === "vim" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === "h" || event.key === "l")
      ) {
        event.preventDefault();
        changeSection(event.key === "h" ? "previous" : "next");
        return;
      }
      if (
        movesReader &&
        keyboardMode === "vim" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        if (event.key === "G") {
          event.preventDefault();
          moveBoundary("end");
          return;
        }
        if (event.key === "g") {
          event.preventDefault();
          if (previousG !== null && performance.now() - previousG <= 750) moveBoundary("start");
          else pendingG.current = performance.now();
          return;
        }
      }
      if (
        keyboardMode === "off" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !movesReader
      )
        return;
      const movement = shellKeyDirection(
        event.key,
        event.shiftKey,
        keyboardMode,
        writingMode ?? "horizontal-tb",
        progressionDirection,
      );
      if (movement === null) return;
      event.preventDefault();
      // A key means the same thing wherever the focus happens to be, so this answers it the way
      // the content agent answers the keys that reach it first.
      if (
        movement.intent === "section" ||
        (movement.intent === "inline" && presentationMode === "document-scroll")
      ) {
        changeSection(movement.direction === "forward" ? "next" : "previous");
        return;
      }
      advancePresentation(movement.direction);
    };
    document.addEventListener("keydown", handleKey);
    const handleMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mouseup")
        onCommand(event.button === 3 ? "page-backward" : "page-forward");
    };
    for (const type of ["mousedown", "mouseup", "auxclick"] as const)
      document.addEventListener(type, handleMouse, true);
    return () => {
      document.removeEventListener("keydown", handleKey);
      for (const type of ["mousedown", "mouseup", "auxclick"] as const)
        document.removeEventListener(type, handleMouse, true);
    };
  });

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!parentOwnedPublicationEvent(event.target, event.currentTarget, frameHost.current)) return;
    if (!event.isPrimary || event.button !== 0) return;
    if (event.pointerType === "touch" && !touchZones) return;
    if (!event.currentTarget.ownerDocument.getSelection()?.isCollapsed) return;
    blankPress.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      target: event.target,
    };
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!parentOwnedPublicationEvent(event.target, event.currentTarget, frameHost.current)) {
      blankPress.current = null;
      return;
    }
    const press = blankPress.current;
    blankPress.current = null;
    const stationaryPress =
      event.isPrimary &&
      press !== null &&
      press.pointerId === event.pointerId &&
      press.target === event.target &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 12;
    if ((event.pointerType === "mouse" && !clickZones) || event.pointerType === "pen") {
      const container = frameHost.current;
      if (stationaryPress && event.button === 0 && container !== null) {
        visiblePrimaryPublicationFrame(container)?.focus({ preventScroll: true });
      }
      return;
    }
    if (
      !(event.pointerType === "touch" ? touchZones : event.pointerType === "mouse" && clickZones) ||
      !event.currentTarget.ownerDocument.getSelection()?.isCollapsed ||
      !stationaryPress ||
      press === null ||
      event.timeStamp - press.time > 500
    )
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    const vertical = writingMode !== undefined && writingMode !== "horizontal-tb";
    const extent = vertical ? rect.height : rect.width;
    let position = vertical ? event.clientY - rect.top : event.clientX - rect.left;
    if (progressionDirection === "rtl") position = extent - position;
    if (position < extent * 0.25) advancePresentation("backward");
    else if (position > extent * 0.75) advancePresentation("forward");
    else {
      const container = frameHost.current;
      if (container !== null)
        visiblePrimaryPublicationFrame(container)?.focus({ preventScroll: true });
    }
  };

  return { handlePointerDown, handlePointerUp, cancelPointer: () => (blankPress.current = null) };
}
