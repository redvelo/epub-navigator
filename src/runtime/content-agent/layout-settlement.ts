import type { RequiredAssetSettlement } from "../../generated/kernel.js";

export interface LayoutEffectSettlement {
  readonly requiredFonts: RequiredAssetSettlement;
  readonly requiredResources: RequiredAssetSettlement;
}

export interface LayoutSettlementVersion {
  readonly fonts: number;
  readonly fontStatus: FontFaceSetLoadStatus | null;
  readonly resources: number;
}

export function createLayoutSettlementTracker(document: Document): {
  settleLayoutEffects(deadline: number): Promise<LayoutEffectSettlement>;
  captureVersion(): LayoutSettlementVersion;
  versionChanged(version: LayoutSettlementVersion): boolean;
  recordFontSettlement(): void;
  recordResourceSettlement(event: Event): void;
} {
  let fontSettlementVersion = 0;
  let resourceSettlementVersion = 0;
  const failedFonts = new WeakSet<FontFace>();
  const terminalResourceSettlements = new WeakMap<
    Element,
    { readonly source: string; readonly settlement: RequiredAssetSettlement }
  >();

  const resourceSourceKey = (element: Element): string => {
    if (element instanceof HTMLLinkElement) return element.href;
    if (element instanceof HTMLImageElement) return element.currentSrc || element.src;
    if (element instanceof HTMLMediaElement) return element.currentSrc || element.src;
    if (element instanceof HTMLObjectElement) return element.data;
    return "";
  };
  const terminalResourceSettlement = (element: Element): RequiredAssetSettlement | null => {
    const terminal = terminalResourceSettlements.get(element);
    return terminal?.source === resourceSourceKey(element) ? terminal.settlement : null;
  };
  const settleImage = async (
    image: HTMLImageElement,
    deadline: number,
  ): Promise<RequiredAssetSettlement> => {
    const terminal = terminalResourceSettlement(image);
    if (terminal === "failed") {
      return "failed";
    } else if (image.complete) {
      return image.naturalWidth > 0 ? "loaded" : "failed";
    } else if (terminal === "loaded") {
      return "loaded";
    }
    return waitForElementEvent(image, ["load", "error"], deadline);
  };
  const settlePendingStyles = async (deadline: number): Promise<RequiredAssetSettlement> => {
    const settlements = await Promise.all(
      [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].map((link) => {
        if (link.sheet !== null || !stylesheetLinkWillLoad(link)) {
          return Promise.resolve<RequiredAssetSettlement>("loaded");
        }
        const terminal = terminalResourceSettlement(link);
        return terminal === null
          ? waitForElementEvent(link, ["load", "error"], deadline)
          : Promise.resolve(terminal);
      }),
    );
    return mergeSettlements(...settlements);
  };
  const settlePendingReplacedContent = async (
    deadline: number,
  ): Promise<RequiredAssetSettlement> => {
    const pending: Promise<RequiredAssetSettlement>[] = [];
    for (const image of document.images) {
      if (image.loading === "lazy") {
        // Offscreen lazy images never load in a hidden frame. Unsized ones change layout when
        // they do load, so fetch them now; sized ones keep their box and can stay lazy.
        if (image.hasAttribute("width") && image.hasAttribute("height")) continue;
        image.loading = "eager";
      }
      pending.push(settleImage(image, deadline));
    }
    for (const media of document.querySelectorAll<HTMLVideoElement>("video")) {
      if (media.readyState >= HTMLMediaElement.HAVE_METADATA) continue;
      if (media.preload === "none") continue;
      if (media.error !== null || media.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
        pending.push(Promise.resolve<RequiredAssetSettlement>("failed"));
        continue;
      }
      const terminal = terminalResourceSettlement(media);
      pending.push(
        terminal === null ? waitForMediaSettlement(media, deadline) : Promise.resolve(terminal),
      );
    }
    for (const object of document.querySelectorAll<HTMLObjectElement>("object")) {
      if (object.contentDocument !== null) continue;
      const terminal = terminalResourceSettlement(object);
      pending.push(
        terminal === null
          ? waitForElementEvent(object, ["load", "error"], deadline)
          : Promise.resolve(terminal),
      );
    }
    return mergeSettlements(...(await Promise.all(pending)));
  };
  const settleRequiredFonts = async (deadline: number): Promise<RequiredAssetSettlement> => {
    const fonts = document.fonts;
    if (fonts === undefined) return "loaded";
    let settlement: RequiredAssetSettlement = "loaded";
    if (fonts.status === "loading") {
      const remaining = Math.max(0, deadline - performance.now());
      if (remaining === 0) {
        settlement = "timed-out";
      } else {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          settlement = await Promise.race([
            Promise.resolve(fonts.ready).then<RequiredAssetSettlement, RequiredAssetSettlement>(
              () => "loaded",
              () => "failed",
            ),
            new Promise<RequiredAssetSettlement>((resolve) => {
              timer = setTimeout(() => resolve("timed-out"), remaining);
            }),
          ]);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }
    }
    let failed = false;
    fonts.forEach((font) => {
      // A failed face is remembered for the document's lifetime: WebKit resets a CSS-connected
      // face from `error` back to `unloaded` at the next style resolution, and a font that never
      // arrived must not be reported as loaded by a later layout of the same document.
      if (font.status === "error") failedFonts.add(font);
      if (failedFonts.has(font)) failed = true;
    });
    return failed ? "failed" : settlement;
  };

  return {
    async settleLayoutEffects(deadline): Promise<LayoutEffectSettlement> {
      const replacedContent = settlePendingReplacedContent(deadline);
      const stylesheetSettlement = await settlePendingStyles(deadline);
      const [requiredFonts, replacedContentSettlement] = await Promise.all([
        settleRequiredFonts(deadline),
        replacedContent,
      ]);
      await nextFrame();
      await nextFrame();
      return {
        requiredFonts,
        requiredResources: mergeSettlements(stylesheetSettlement, replacedContentSettlement),
      };
    },
    captureVersion(): LayoutSettlementVersion {
      return {
        fonts: fontSettlementVersion,
        fontStatus: document.fonts?.status ?? null,
        resources: resourceSettlementVersion,
      };
    },
    versionChanged(version): boolean {
      return (
        version.fonts !== fontSettlementVersion ||
        version.fontStatus !== (document.fonts?.status ?? null) ||
        version.resources !== resourceSettlementVersion
      );
    },
    recordFontSettlement(): void {
      fontSettlementVersion += 1;
    },
    recordResourceSettlement(event): void {
      if (!(event.target instanceof Element)) return;
      terminalResourceSettlements.set(event.target, {
        source: resourceSourceKey(event.target),
        settlement: event.type === "error" ? "failed" : "loaded",
      });
      resourceSettlementVersion += 1;
    },
  };
}

export function mergeLayoutEffectSettlements(
  left: LayoutEffectSettlement,
  right: LayoutEffectSettlement,
): LayoutEffectSettlement {
  return {
    requiredFonts: mergeSettlements(left.requiredFonts, right.requiredFonts),
    requiredResources: mergeSettlements(left.requiredResources, right.requiredResources),
  };
}

export function reconcileLayoutEffectSettlements(
  previous: LayoutEffectSettlement,
  current: LayoutEffectSettlement,
): LayoutEffectSettlement {
  return {
    requiredFonts:
      previous.requiredFonts === "failed" || current.requiredFonts === "failed"
        ? "failed"
        : current.requiredFonts,
    requiredResources:
      previous.requiredResources === "failed" || current.requiredResources === "failed"
        ? "failed"
        : current.requiredResources,
  };
}

export function layoutEffectSettlementTimedOut(settlement: LayoutEffectSettlement): boolean {
  return settlement.requiredFonts === "timed-out" || settlement.requiredResources === "timed-out";
}

export function nextFrame(): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ]);
}

function mergeSettlements(
  ...settlements: readonly RequiredAssetSettlement[]
): RequiredAssetSettlement {
  if (settlements.includes("failed")) return "failed";
  if (settlements.includes("timed-out")) return "timed-out";
  return "loaded";
}

/** Browsers only fetch enabled CSS stylesheet links with a target; the rest never settle. */
export function stylesheetLinkWillLoad(link: HTMLLinkElement): boolean {
  if (link.hasAttribute("disabled")) return false;
  if ((link.getAttribute("href") ?? "").trim() === "") return false;
  const type = link.getAttribute("type");
  if (type === null) return true;
  const essence = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence === "" || essence === "text/css";
}

/** A media element only reports `error` on its `<source>` children once every source fails. */
function waitForMediaSettlement(
  media: HTMLMediaElement,
  deadline: number,
): Promise<RequiredAssetSettlement> {
  const remaining = Math.max(0, deadline - performance.now());
  if (remaining === 0) return Promise.resolve("timed-out");
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sources = [...media.querySelectorAll("source")];
    const finish = (settlement: RequiredAssetSettlement): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      media.removeEventListener("loadedmetadata", onLoaded);
      media.removeEventListener("error", onError);
      for (const source of sources) source.removeEventListener("error", onSourceError);
      resolve(settlement);
    };
    const onLoaded = (): void => finish("loaded");
    const onError = (): void => finish("failed");
    const onSourceError = (): void => {
      if (media.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) finish("failed");
    };
    media.addEventListener("loadedmetadata", onLoaded, { once: true });
    media.addEventListener("error", onError, { once: true });
    for (const source of sources) source.addEventListener("error", onSourceError);
    timer = setTimeout(() => finish("timed-out"), remaining);
  });
}

function waitForElementEvent(
  element: Element,
  types: readonly string[],
  deadline: number,
): Promise<RequiredAssetSettlement> {
  const remaining = Math.max(0, deadline - performance.now());
  if (remaining === 0) return Promise.resolve("timed-out");
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (settlement: RequiredAssetSettlement): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const type of types) element.removeEventListener(type, onEvent);
      resolve(settlement);
    };
    const onEvent = (event: Event): void => finish(event.type === "error" ? "failed" : "loaded");
    for (const type of types) element.addEventListener(type, onEvent, { once: true });
    timer = setTimeout(() => finish("timed-out"), remaining);
  });
}
