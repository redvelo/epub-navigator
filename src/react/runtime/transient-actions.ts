import { useSetAtom } from "jotai";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import type { FixedViewPoint, NavigatorRuntime } from "../../runtime/navigator/api.js";
import { footnoteReturnAtom, type AnnotationState } from "../annotations/state.js";
import { fixedViewAtom } from "../fixed-layout/state.js";

export function useTransientReaderActions(
  runtime: RefObject<NavigatorRuntime | null>,
  annotations: AnnotationState,
) {
  const setFootnoteReturn = useSetAtom(footnoteReturnAtom);
  const setFixedView = useSetAtom(fixedViewAtom);
  const setZoom = (zoom: number, focalPoint?: FixedViewPoint) => {
    const current = runtime.current;
    if (current !== null) setFixedView(current.setFixedZoom(zoom, focalPoint));
  };
  const returnFromFootnote = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!event.nativeEvent.isTrusted || annotations.footnoteReturn === null) return;
    const current = runtime.current;
    if (current === null || annotations.footnoteReturn.status === "returning") return;
    const activationId = annotations.footnoteReturn.activationId;
    setFootnoteReturn({ activationId, status: "returning" });
    try {
      const result = await current.returnFromFootnote(activationId);
      if (runtime.current !== current) return;
      if (result.status === "returned") {
        setFootnoteReturn((value) => (value?.activationId === activationId ? null : value));
      } else {
        setFootnoteReturn((value) =>
          value?.activationId === activationId
            ? {
                activationId,
                status: "failed",
                message:
                  result.status === "stale"
                    ? "The note reference is no longer available."
                    : "The note reference could not be restored.",
              }
            : value,
        );
      }
    } catch {
      if (runtime.current !== current) return;
      setFootnoteReturn((value) =>
        value?.activationId === activationId
          ? {
              activationId,
              status: "failed",
              message: "The note reference could not be restored.",
            }
          : value,
      );
    }
  };
  const dismissFootnoteReturn = () => {
    setFootnoteReturn((value) => (value?.status === "returning" ? value : null));
  };
  return { setZoom, returnFromFootnote, dismissFootnoteReturn };
}
