import { RuntimeBase } from "../navigator/runtime-base.js";
import { type PresentationAdvanceResult } from "../navigator/api.js";
import type {
  FixedSpreadPlacement,
  KernelTransition,
  NavigatorCommand,
  PresentationAdvanceDirection,
  PresentationAdvanceTarget,
} from "../../generated/kernel.js";
import { commandInput } from "../kernel.js";
import { currentDocument, fixedCompanionDocument } from "../kernel-view.js";

const PRESENTATION_SETTLE_WAIT_MS = 3_000;

export abstract class NavigationCommandsRuntime extends RuntimeBase {
  open(occurrence: number): KernelTransition {
    this._noteForegroundActivity();
    this._cancelRestore("superseded");
    const promotion = this._pendingPromotion?.queued?.transition;
    if (promotion !== undefined) return promotion;
    return this._command({ type: "open-occurrence", occurrence });
  }

  attachFixedCompanion(
    ownerDocumentGeneration: number,
    frameGeneration: number,
    placement: FixedSpreadPlacement,
  ): KernelTransition {
    return this._command({
      type: "attach-fixed-companion",
      ownerDocumentGeneration,
      frameGeneration,
      placement,
    });
  }

  detachFixedCompanion(ownerDocumentGeneration: number, frameGeneration: number): KernelTransition {
    return this._command({
      type: "detach-fixed-companion",
      ownerDocumentGeneration,
      frameGeneration,
    });
  }

  evictPreparedFrames(): KernelTransition {
    this._releasePreparationClaims();
    return this._command({ type: "evict-prepared-frames" });
  }

  previousOccurrence(): number | null {
    this._assertOpen();
    const range = this._visibleOccurrenceRange();
    if (range === null) return null;
    const occurrence = range.firstOccurrence - 1;
    return occurrence >= 0 ? occurrence : null;
  }

  nextOccurrence(): number | null {
    this._assertOpen();
    const range = this._visibleOccurrenceRange();
    if (range === null) return null;
    const occurrence = range.lastOccurrence + 1;
    return occurrence < this._kernel.snapshot().readingOrderLength ? occurrence : null;
  }

  previous(): KernelTransition {
    this._noteForegroundActivity("command");
    this._cancelRestore("superseded");
    const promotion = this._pendingPromotion?.queued?.transition;
    if (promotion !== undefined) return promotion;
    return this._command({ type: "previous" });
  }

  next(): KernelTransition {
    this._noteForegroundActivity("command");
    this._cancelRestore("superseded");
    const promotion = this._pendingPromotion?.queued?.transition;
    if (promotion !== undefined) return promotion;
    return this._command({ type: "next" });
  }

  reload(): KernelTransition {
    this._cancelRestore("replacement");
    const promotion = this._pendingPromotion?.queued?.transition;
    if (promotion !== undefined) return promotion;
    return this._command({ type: "reload" });
  }

  cancel(): KernelTransition {
    this._cancelRestore("replacement");
    return this._command({ type: "cancel-document" });
  }

  /**
   * A spread's members are read in order: the leading page, then the trailing one. A member that
   * can turn its own pages does so while the other stays; the view moves on only when the last
   * member in that direction reports its boundary.
   */
  async advancePresentation(
    direction: PresentationAdvanceDirection,
  ): Promise<PresentationAdvanceResult> {
    this._noteForegroundActivity("command");
    this._cancelRestore("superseded");
    const advance = (target: PresentationAdvanceTarget) =>
      this._runPresentationOperation({ type: "advance-presentation", direction, target });
    // A turn that lands while the view is re-laying out, as after a resize, waits for the
    // layout rather than failing against it.
    await this._awaitSettledPresentation(PRESENTATION_SETTLE_WAIT_MS);
    const primary = this._committed;
    const companion = this._companion;
    const companionDocument = fixedCompanionDocument(this._kernel.snapshot());
    // A companion still laying out cannot turn a page; the turn then reaches only the primary.
    if (
      primary?.phase !== "committed" ||
      companion?.phase !== "committed" ||
      companion.adapter !== "reflowable-xhtml" ||
      companionDocument?.frame.generation !== companion.frameGeneration ||
      companionDocument.layout.state !== "settled"
    ) {
      return advance("primary");
    }
    const companionTrailing = companion.occurrence > primary.occurrence;
    const order: readonly PresentationAdvanceTarget[] =
      (direction === "forward") === companionTrailing
        ? ["primary", "fixed-companion"]
        : ["fixed-companion", "primary"];
    let result = await advance(order[0]!);
    if (result.outcome !== "completed" || result.status.status !== "boundary") return result;
    if (
      this._companion !== companion ||
      this._committed !== primary ||
      fixedCompanionDocument(this._kernel.snapshot())?.layout.state !== "settled"
    ) {
      return result;
    }
    result = await advance(order[1]!);
    return result;
  }

  private _presentationSettled(): boolean {
    const snapshot = this._kernel.snapshot();
    return (
      snapshot.document.pending === null &&
      currentDocument(snapshot)?.layout.state === "settled" &&
      (fixedCompanionDocument(snapshot)?.layout.state ?? "settled") === "settled"
    );
  }

  private _awaitSettledPresentation(timeoutMs: number): Promise<void> {
    if (this._presentationSettled()) return Promise.resolve();
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const finish = () => {
        unsubscribe();
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      unsubscribe = this.subscribe(() => {
        if (this._presentationSettled() || this._closed) finish();
      });
    });
  }

  protected _command(command: NavigatorCommand): KernelTransition {
    this._assertOpen();
    return this._accepted(this._dispatchAndApply(commandInput(command)));
  }
}
