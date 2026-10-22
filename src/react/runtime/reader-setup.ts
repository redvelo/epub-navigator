import { useRef, useState } from "react";
import { useStore } from "jotai";
import { frameHostElementAtom, readerRootElementAtom } from "./projection-state.js";
import type { MountedPublication } from "../../publication.js";
import type { NavigatorReaderProps } from "../public-types.js";

interface FrameSandbox {
  readonly allowForms: boolean;
  readonly allowModals: boolean;
}

/** A session's publication and frame sandbox are fixed for its lifetime; render must not drift. */
export function useImmutableSession(
  session: NavigatorReaderProps["session"],
  frameSandbox: NavigatorReaderProps["frameSandbox"],
): { readonly publication: MountedPublication; readonly frameSandbox: FrameSandbox } {
  const [publication] = useState(() => session.publication);
  if (
    session.publication.facts !== publication.facts ||
    session.publication.mount.baseUrl !== publication.mount.baseUrl ||
    session.publication.mount.remoteResources !== publication.mount.remoteResources ||
    session.publication.mount.contentOrigin !== publication.mount.contentOrigin
  ) {
    throw new TypeError("NavigatorReader session publication must remain immutable.");
  }
  const [initialFrameSandbox] = useState(() => ({
    allowForms: frameSandbox?.allowForms === true,
    allowModals: frameSandbox?.allowModals === true,
  }));
  if (
    initialFrameSandbox.allowForms !== (frameSandbox?.allowForms === true) ||
    initialFrameSandbox.allowModals !== (frameSandbox?.allowModals === true)
  ) {
    throw new TypeError(
      "NavigatorReader publication frame sandbox capabilities must remain immutable within a session.",
    );
  }
  return { publication, frameSandbox: initialFrameSandbox };
}

export interface ReaderElements {
  readonly readerRoot: { current: HTMLElement | null };
  readonly readerRootElement: HTMLElement | null;
  readonly attachReaderRoot: (element: HTMLElement | null) => void;
  readonly frameHost: { current: HTMLDivElement | null };
  readonly frameHostElement: HTMLDivElement | null;
  readonly attachFrameHost: (element: HTMLDivElement | null) => void;
}

/** Publishes the reader's two host elements as both refs, render state, and store values. */
export function useReaderElements(): ReaderElements {
  const store = useStore();
  const readerRoot = useRef<HTMLElement | null>(null);
  const [readerRootElement, setReaderRootElement] = useState<HTMLElement | null>(null);
  const frameHost = useRef<HTMLDivElement | null>(null);
  const [frameHostElement, setFrameHostElement] = useState<HTMLDivElement | null>(null);
  return {
    readerRoot,
    readerRootElement,
    attachReaderRoot: (element) => {
      readerRoot.current = element;
      setReaderRootElement(element);
      store.set(readerRootElementAtom, element);
    },
    frameHost,
    frameHostElement,
    attachFrameHost: (element) => {
      frameHost.current = element;
      setFrameHostElement(element);
      store.set(frameHostElementAtom, element);
    },
  };
}
