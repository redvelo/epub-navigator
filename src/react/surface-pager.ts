import { useEffect, useEffectEvent, type RefObject } from "react";

interface SurfacePager {
  readonly viewport: HTMLElement;
  readonly deviceTurns: boolean;
  readonly turn: (delta: number) => void;
}

const surfacePagers: SurfacePager[] = [];

function ownsDeviceTurns(pager: SurfacePager): boolean {
  const { viewport } = pager;
  if (!viewport.isConnected || viewport.closest("[hidden]") !== null) return false;
  return pager.deviceTurns || viewport.closest('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * Turns the pages of the surface a device's page buttons belong to: the innermost one laid over
 * what is behind it, or a host's own page that claims them. Such buttons reach no focused
 * element, so the surface is found here rather than through the key handling of one. Reports
 * whether a surface took the turn, so what is behind it does not move as well.
 */
export function turnPaginatedSurface(delta: number): boolean {
  for (let index = surfacePagers.length - 1; index >= 0; index -= 1) {
    const pager = surfacePagers[index];
    if (pager === undefined || !ownsDeviceTurns(pager)) continue;
    pager.turn(delta);
    return true;
  }
  return false;
}

/** Publishes a pager for page buttons the browser hears as neither a key nor a press. */
export function useSurfacePager(
  viewport: RefObject<HTMLElement | null>,
  deviceTurns: boolean,
  changePage: (delta: number) => void,
): void {
  const turn = useEffectEvent(changePage);
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const pager: SurfacePager = { viewport: element, deviceTurns, turn };
    surfacePagers.push(pager);
    return () => {
      const index = surfacePagers.indexOf(pager);
      if (index >= 0) surfacePagers.splice(index, 1);
    };
  }, [viewport, deviceTurns]);
}
