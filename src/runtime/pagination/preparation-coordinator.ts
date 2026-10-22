import { PaginationBridgeRuntime } from "./runtime-bridge.js";
import { isFixedAdapter } from "../navigator/runtime-support.js";
import { NavigatorError } from "../../runtime.js";
import { commandInput } from "../kernel.js";
import {
  currentDocument,
  currentFixedSettlement,
  currentFrame,
  currentReflowSettlement,
  fixedCompanionDocument,
  occurrenceLoadableTarget,
  pendingDocumentFrame,
  preparedSettledLayout,
} from "../kernel-view.js";

const maximumPreparationDrops = 2;

export abstract class PreparationCoordinatorRuntime extends PaginationBridgeRuntime {
  protected _lastCoordinatedOccurrence: number | null = null;
  protected _lastTravelDirection: 1 | -1 = 1;

  protected _scheduleAdjacentPreparation(): void {
    if (this._preparationScheduled || this._closed || this._role !== "foreground") return;
    this._preparationScheduled = true;
    queueMicrotask(() => {
      this._preparationScheduled = false;
      this._coordinateAdjacentPreparation();
    });
  }

  protected _coordinateAdjacentPreparation(): void {
    if (this._closed || this._role !== "foreground") return;
    if (this._coordinateFixedSpread()) return;
    const controller = this._paginationController;
    const eligible = this._foregroundPreparationPaths;
    if (
      this._closed ||
      controller === null ||
      eligible === null ||
      this._container.ownerDocument.hidden
    ) {
      return;
    }
    const snapshot = this._kernel.snapshot();
    const committed = currentDocument(snapshot);
    const committedFrame = currentFrame(snapshot);
    const companion = fixedCompanionDocument(snapshot);
    const firstVisible = Math.min(
      committed?.frame.occurrence ?? 0,
      companion?.frame.occurrence ?? committed?.frame.occurrence ?? 0,
    );
    const lastVisible = Math.max(
      committed?.frame.occurrence ?? 0,
      companion?.frame.occurrence ?? committed?.frame.occurrence ?? 0,
    );
    const hasManagedLayout =
      currentReflowSettlement(snapshot) !== null || currentFixedSettlement(snapshot) !== null;
    const layoutKey =
      committed === null
        ? null
        : `${committed.generation}:${committed.layout.layout.layoutGeneration}`;
    for (const [occurrence, failed] of this._failedPreparations) {
      if (failed.layoutKey !== layoutKey) this._failedPreparations.delete(occurrence);
    }

    if (
      committed !== null &&
      snapshot.preparedFrames.some(
        (prepared) =>
          prepared.frame.occurrence !== firstVisible - 1 &&
          prepared.frame.occurrence !== lastVisible + 1,
      )
    ) {
      for (const claim of this._preparationClaims.values()) {
        controller.releaseForegroundPreparation(claim, true);
      }
      this._preparationClaims.clear();
      this._evictPreparedFramesFromKernel();
      return;
    }

    for (const [occurrence, claim] of this._preparationClaims) {
      const prepared = snapshot.preparedFrames.find(
        (candidate) => candidate.frame.occurrence === occurrence,
      );
      const settled = prepared === undefined ? null : preparedSettledLayout(prepared);
      if (prepared !== undefined && settled !== null) {
        const accepted = controller.acceptPreparedLayout(
          claim,
          prepared.frame.resource,
          prepared.frame.generation,
          settled.layoutGeneration,
          settled.settlement,
        );
        if (!accepted) this._releasePreparationClaim(occurrence, true);
        continue;
      }
      if (prepared !== undefined) continue;
      const pendingFrame =
        snapshot.document.pending === null ? null : pendingDocumentFrame(snapshot.document.pending);
      if (pendingFrame?.occurrence === occurrence || committedFrame?.occurrence === occurrence) {
        controller.releaseForegroundPreparation(claim, true);
        this._preparationClaims.delete(occurrence);
        continue;
      }
      // The kernel dropped the prepared frame without promoting it. One retry covers a
      // transient drop; repeating beyond that for the same foreground layout (a publisher CSS
      // conflict, say) would only loop.
      if (layoutKey !== null) {
        const drops = (this._failedPreparations.get(occurrence)?.drops ?? 0) + 1;
        this._failedPreparations.set(occurrence, { layoutKey, drops });
      }
      controller.releaseForegroundPreparation(claim, true);
      this._preparationClaims.delete(occurrence);
    }

    if (
      committed === null ||
      !hasManagedLayout ||
      snapshot.document.pending !== null ||
      snapshot.layout.pending !== null ||
      snapshot.preparedFrames.some((prepared) => prepared.state.state !== "prepared")
    ) {
      return;
    }

    if (this._preparationGate !== null) return;

    if (
      this._lastCoordinatedOccurrence !== null &&
      firstVisible !== this._lastCoordinatedOccurrence
    ) {
      this._lastTravelDirection = firstVisible > this._lastCoordinatedOccurrence ? 1 : -1;
    }
    this._lastCoordinatedOccurrence = firstVisible;
    const candidates = controller.foregroundFlipping()
      ? [this._lastTravelDirection > 0 ? lastVisible + 1 : firstVisible - 1]
      : [lastVisible + 1, firstVisible - 1];
    for (const occurrence of candidates) {
      const adjacent = snapshot.readingOrder[occurrence];
      const target = occurrenceLoadableTarget(adjacent);
      if (
        adjacent === undefined ||
        adjacent.ordinal !== occurrence ||
        target === null ||
        (target.adapter !== "reflowable-xhtml" && !isFixedAdapter(target.adapter)) ||
        !eligible.has(target.resource) ||
        (target.adapter === "fixed-svg" &&
          !this._fixedSvgPreparationEligible(occurrence, target.resource)) ||
        snapshot.preparedFrames.some((prepared) => prepared.frame.occurrence === occurrence) ||
        this._preparationClaims.has(occurrence) ||
        (this._failedPreparations.get(occurrence)?.drops ?? 0) >= maximumPreparationDrops
      ) {
        continue;
      }
      const claim = controller.claimForegroundPreparation(occurrence);
      if (claim === null) continue;
      this._preparationClaims.set(occurrence, claim);
      try {
        this._accepted(
          this._dispatchAndApply(commandInput({ type: "prepare-occurrence", occurrence })),
        );
      } catch (cause) {
        this._preparationClaims.delete(occurrence);
        controller.releaseForegroundPreparation(claim);
        if (!(cause instanceof NavigatorError)) this._handleBoundaryFailure(cause);
      }
      return;
    }
  }

  protected _fixedSvgPreparationEligible(occurrence: number, resourcePath: string): boolean {
    if (this._foregroundPreparationPaths?.has(resourcePath) !== true) return false;
    const target = occurrenceLoadableTarget(this._kernel.snapshot().readingOrder[occurrence]);
    if (target?.adapter !== "fixed-svg" || target.resource !== resourcePath) return false;
    const resource = this._publication.facts.resources.resources.find(
      (candidate) => candidate.address.kind === "local" && candidate.address.value === resourcePath,
    );
    return (
      resource?.presence.state === "present" &&
      resource.address.kind === "local" &&
      resource.address.value === resourcePath &&
      resource.hasSvgDeclaration &&
      !resource.scripted
    );
  }

  protected _releasePreparationClaims(): void {
    const controller = this._paginationController;
    if (controller !== null) {
      for (const claim of this._preparationClaims.values()) {
        controller.releaseForegroundPreparation(claim, true);
      }
    }
    this._preparationClaims.clear();
  }

  protected _releasePreparationClaim(occurrence: number, preserveAccepted: boolean): void {
    const claim = this._preparationClaims.get(occurrence);
    if (claim === undefined) return;
    this._paginationController?.releaseForegroundPreparation(claim, preserveAccepted);
    this._preparationClaims.delete(occurrence);
  }

  protected _evictAutomaticPreparation(): void {
    this._releasePreparationClaims();
    this._evictPreparedFramesFromKernel();
  }

  protected _evictPreparedFramesFromKernel(): void {
    if (this._closed || this._role !== "foreground") return;
    try {
      this._accepted(this._dispatchAndApply(commandInput({ type: "evict-prepared-frames" })));
    } catch (cause) {
      this._handleBoundaryFailure(cause);
    }
  }
}
