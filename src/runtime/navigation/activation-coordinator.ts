import { FixedSpreadRuntime } from "../fixed-layout/spread-coordinator.js";
import { type ActivationRequest, type OwnedFrame } from "../navigator/runtime-types.js";
import type { ActiveDocumentParticipant, NavigatorLocation } from "../../generated/kernel.js";
import { decodePublicationRoute } from "../../mount.js";
import type { NavigatorFootnoteNavigation } from "../../footnotes.js";
import { adapterInput } from "../kernel.js";
import { occurrenceAliasesResource, occurrenceLoadableTarget } from "../kernel-view.js";

export abstract class ActivationCoordinatorRuntime extends FixedSpreadRuntime {
  protected _acceptActivationRequest(
    frame: OwnedFrame,
    participant: ActiveDocumentParticipant,
    activation: ActivationRequest,
  ): void {
    try {
      const internal = this._isInternalActivation(activation);
      this._accepted(
        this._dispatchAndApply(
          adapterInput({
            type: "link-activated",
            participant,
            generation: frame.frameGeneration,
            activation: {
              href: activation.href,
              resolvedUrl: activation.resolvedUrl,
              target: activation.target,
              download: activation.download,
            },
          }),
        ),
      );
      if (this._pendingFootnoteReturn !== null) {
        clearTimeout(this._pendingFootnoteReturn.timer);
        this._pendingFootnoteReturn.resolve({ status: "stale" });
        this._pendingFootnoteReturn = null;
      }
      let footnoteNavigation: NavigatorFootnoteNavigation | null = null;
      if (activation.footnote === null) {
        this._setActiveFootnote(null);
      } else {
        const source: Extract<NavigatorLocation, { kind: "point" }> = {
          kind: "point",
          occurrence: frame.occurrence,
          resource: frame.resource,
          evidence: activation.footnote.originEvidence,
          observation: { layoutProgression: null, renderedTextProgression: null },
        };
        const target = new URL(activation.resolvedUrl);
        const resource = decodePublicationRoute(this._publication.mount.baseUrl, target.pathname);
        const occurrence = this._kernel
          .snapshot()
          .readingOrder.find((candidate) =>
            occurrenceAliasesResource(this._publication.facts, candidate, resource),
          );
        if (activation.footnote.disposition === "reported") {
          // The page did not move, so there is nowhere to return from and nothing to retain.
        } else if (resource === frame.resource) {
          this._setActiveFootnote({
            activationId: activation.footnote.activationId,
            participant,
            source,
            destinationOccurrence: frame.occurrence,
            destinationResource: frame.resource,
            pendingGeneration: null,
          });
          footnoteNavigation = {
            activationId: activation.footnote.activationId,
            occurrence: frame.occurrence,
            resource: frame.resource,
          };
        } else if (
          internal &&
          occurrence !== undefined &&
          occurrenceLoadableTarget(occurrence)?.resource === resource &&
          target.hash.length > 1
        ) {
          const fragment = decodeURIComponent(target.hash.slice(1));
          const transition = this._command({
            type: "open-occurrence-at",
            occurrence: occurrence.ordinal,
            evidence: [{ kind: "html-fragment", value: fragment }],
          });
          const pendingGeneration = transition.events.find(
            (event) => event.type === "document-pending",
          )?.generation;
          if (pendingGeneration !== undefined) {
            this._activeFootnote = {
              activationId: activation.footnote.activationId,
              participant: null,
              source,
              destinationOccurrence: occurrence.ordinal,
              destinationResource: resource,
              pendingGeneration,
            };
          }
        }
      }
      for (const listener of this._activationListeners) {
        try {
          listener({
            participant,
            href: activation.href,
            resolvedUrl: activation.resolvedUrl,
            target: activation.target,
            download: activation.download,
            internal,
            footnote: footnoteNavigation,
            noteReference:
              activation.footnote?.disposition === "reported"
                ? {
                    referenceRect: activation.footnote.referenceRect,
                    referenceLabel: activation.footnote.referenceLabel,
                  }
                : null,
          });
        } catch {
          // Activation observers do not participate in runtime state transitions.
        }
      }
      if (activation.footnote === null) void this._applyActivationRequest(frame, activation);
    } catch (cause) {
      this._handlePublicationMessageFailure(cause);
    }
  }

  protected _isInternalActivation(activation: ActivationRequest): boolean {
    if (activation.download !== null) return false;
    try {
      const target = new URL(activation.resolvedUrl);
      const mount = new URL(this._publication.mount.baseUrl);
      return (
        target.username.length === 0 &&
        target.password.length === 0 &&
        target.origin === mount.origin &&
        target.pathname.startsWith(mount.pathname) &&
        target.search.length === 0
      );
    } catch {
      return false;
    }
  }

  protected async _applyActivationRequest(
    frame: OwnedFrame,
    activation: ActivationRequest,
  ): Promise<void> {
    if (activation.download !== null) return;
    try {
      const target = new URL(activation.resolvedUrl);
      const mount = new URL(this._publication.mount.baseUrl);
      if (
        target.username.length > 0 ||
        target.password.length > 0 ||
        target.origin !== mount.origin ||
        !target.pathname.startsWith(mount.pathname) ||
        target.search.length > 0
      ) {
        return;
      }
      const resource = decodePublicationRoute(this._publication.mount.baseUrl, target.pathname);
      const occurrences = this._kernel
        .snapshot()
        .readingOrder.filter((candidate) =>
          occurrenceAliasesResource(this._publication.facts, candidate, resource),
        );
      // Authored hyperlinks select the first linear instance, not the source context.
      // Nonlinear-only resources remain reachable through their first spine instance.
      const occurrence =
        occurrences.find((candidate) => candidate.linear === "yes") ?? occurrences[0];
      if (occurrence === undefined) return;
      if (resource === frame.resource && occurrence.ordinal === frame.occurrence) {
        const fragment = target.hash.length === 0 ? null : decodeURIComponent(target.hash.slice(1));
        await this.relocate({
          kind: "point",
          occurrence: frame.occurrence,
          resource,
          evidence:
            fragment === null || fragment.length === 0
              ? [{ kind: "document-boundary", boundary: "start" }]
              : [{ kind: "html-fragment", value: fragment }],
          observation: { layoutProgression: null, renderedTextProgression: null },
        });
        return;
      }
      const effectiveResource = occurrenceLoadableTarget(occurrence)?.resource;
      if (effectiveResource === undefined) return;
      const fragment = target.hash.length === 0 ? null : decodeURIComponent(target.hash.slice(1));
      if (fragment === null || fragment.length === 0 || effectiveResource !== resource) {
        this.open(occurrence.ordinal);
      } else {
        const transition = this._command({
          type: "open-occurrence-at",
          occurrence: occurrence.ordinal,
          evidence: [{ kind: "html-fragment", value: fragment }],
        });
        const generation = transition.events.find(
          (event) => event.type === "document-pending",
        )?.generation;
        if (generation === undefined) return;
        const committed = await new Promise<boolean>((resolve) => {
          const unsubscribe = this.subscribe((next) => {
            for (const event of next.events) {
              if (event.type === "document-committed" && event.generation === generation) {
                unsubscribe();
                resolve(true);
                return;
              }
              if (
                (event.type === "document-cancelled" ||
                  event.type === "document-load-failed" ||
                  event.type === "document-invalidated") &&
                event.generation === generation
              ) {
                unsubscribe();
                resolve(false);
                return;
              }
            }
          });
        });
        if (!committed) return;
        await this.relocate({
          kind: "point",
          occurrence: occurrence.ordinal,
          resource: effectiveResource,
          evidence: [{ kind: "html-fragment", value: fragment }],
          observation: { layoutProgression: null, renderedTextProgression: null },
        });
      }
    } catch {
      // Raw activation evidence remains observable when policy parsing or navigation is stale.
    }
  }
}
