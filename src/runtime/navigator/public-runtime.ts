import { AgentMessageRouterRuntime } from "../agent/message-router.js";
import {
  type NavigatorLocationListener,
  type NavigatorTransitionListener,
  type NavigatorErrorListener,
  type ReaderConfiguration,
  type NavigatorInteractionListener,
  type NavigatorSelectionListener,
  type NavigatorDecorationListener,
  type NavigatorDecorationActivationListener,
  type NavigatorActivationListener,
  type NavigatorExternalFormAttemptListener,
  type NavigatorFootnoteListener,
} from "./api.js";
import type {
  KernelSnapshot,
  KernelTransition,
  PresentationPreferences,
} from "../../generated/kernel.js";
import { NavigatorError } from "../../runtime.js";
import { postFrameMessage } from "../agent/transport.js";
import { commandInput } from "../kernel.js";
import { buildAgentConfigure } from "../agent-protocol/index.js";
import { copyConfiguration } from "./runtime-support.js";
import type { NavigatorPresentationActivityListener } from "./api.js";

export abstract class PublicRuntime extends AgentMessageRouterRuntime {
  configure(configuration: ReaderConfiguration): void {
    this._assertOpen();
    this._configuration = copyConfiguration(configuration);
    for (const frame of this._frames.values()) {
      if (frame.window !== null) {
        postFrameMessage(
          frame.window,
          this._frameProfile,
          buildAgentConfigure(frame.session, this._agentConfiguration()),
        );
      }
    }
  }

  setPresentationPreferences(preferences: PresentationPreferences): KernelTransition {
    this._assertOpen();
    const dispatched = this._kernel.dispatch(
      commandInput({ type: "set-presentation-preferences", preferences }),
    );
    const transition = this._accepted(
      this._applyTransition(dispatched, () => {
        if (!dispatched.accepted) return;
        this._frameStack.style.colorScheme = preferences.colorScheme;
        for (const frame of this._frames.values()) {
          frame.iframe.style.colorScheme = preferences.colorScheme;
        }
      }),
    );
    this._paginationController?.setPreferences(preferences);
    return transition;
  }

  snapshot(): KernelSnapshot {
    this._assertOpen();
    return this._kernel.snapshot();
  }

  subscribe(listener: NavigatorTransitionListener): () => void {
    this._assertOpen();
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  subscribeErrors(listener: NavigatorErrorListener): () => void {
    this._assertOpen();
    this._errorListeners.add(listener);
    return () => this._errorListeners.delete(listener);
  }

  subscribeInteractions(listener: NavigatorInteractionListener): () => void {
    this._assertOpen();
    this._interactionListeners.add(listener);
    return () => this._interactionListeners.delete(listener);
  }

  subscribeSelections(listener: NavigatorSelectionListener): () => void {
    this._assertOpen();
    this._selectionListeners.add(listener);
    return () => this._selectionListeners.delete(listener);
  }

  subscribeLocations(listener: NavigatorLocationListener): () => void {
    this._assertOpen();
    this._locationListeners.add(listener);
    return () => this._locationListeners.delete(listener);
  }

  subscribeDecorations(listener: NavigatorDecorationListener): () => void {
    this._assertOpen();
    this._decorationListeners.add(listener);
    return () => this._decorationListeners.delete(listener);
  }

  subscribeDecorationActivations(listener: NavigatorDecorationActivationListener): () => void {
    this._assertOpen();
    this._decorationActivationListeners.add(listener);
    return () => this._decorationActivationListeners.delete(listener);
  }

  subscribeActivations(listener: NavigatorActivationListener): () => void {
    this._assertOpen();
    this._activationListeners.add(listener);
    return () => this._activationListeners.delete(listener);
  }

  subscribeExternalFormAttempts(listener: NavigatorExternalFormAttemptListener): () => void {
    this._assertOpen();
    this._externalFormAttemptListeners.add(listener);
    return () => this._externalFormAttemptListeners.delete(listener);
  }

  subscribeFootnotes(listener: NavigatorFootnoteListener): () => void {
    this._assertOpen();
    this._footnoteListeners.add(listener);
    return () => this._footnoteListeners.delete(listener);
  }

  subscribePresentationActivity(listener: NavigatorPresentationActivityListener): () => void {
    this._assertOpen();
    this._presentationActivityListeners.add(listener);
    return () => this._presentationActivityListeners.delete(listener);
  }

  close(): KernelTransition {
    if (this._terminalError !== undefined) throw this._terminalError;
    if (this._closed) return this._kernel.close();
    this._cancelRestore("close");
    this._activeFootnote = null;
    if (this._pendingFootnoteReturn !== null) {
      clearTimeout(this._pendingFootnoteReturn.timer);
      this._pendingFootnoteReturn.resolve({ status: "stale" });
      this._pendingFootnoteReturn = null;
    }
    this._cancelMediaOverlayCommands();
    this._publishCurrentLocation(true);
    this._closed = true;
    this._disposePagination();
    try {
      const transition = this._kernel.close((closing) => {
        this._accepted(this._applyTransition(closing));
      });
      return this._accepted(transition);
    } finally {
      this._removeAllFrames();
    }
  }

  protected _agentConfiguration(): ReaderConfiguration {
    return {
      appearance: {
        ...this._configuration.appearance,
        rootScrollbar: this._kernel.snapshot().layout.preferences.rootScrollbar,
      },
      input: { ...this._configuration.input },
    };
  }

  protected _noteForegroundActivity(turn?: "presentation" | "command"): void {
    if (this._closed || this._role !== "foreground") return;
    this._paginationController?.noteForegroundActivity(turn);
  }

  protected _assertOpen(): void {
    if (this._terminalError !== undefined) throw this._terminalError;
    if (this._closed) {
      throw new NavigatorError({
        code: "kernel-closed",
        message: "the Navigator runtime is closed",
      });
    }
  }
}
