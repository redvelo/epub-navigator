import type { AgentOperationFailure } from "../../generated/kernel.js";
import { NavigatorError } from "../../runtime.js";

export interface ReaderError {
  readonly code: string;
  readonly message: string;
  readonly terminal: boolean;
  readonly recoveryOccurrence?: number | undefined;
}

export function operationError(failure: AgentOperationFailure): ReaderError {
  const message =
    failure.code === "operation-cancelled"
      ? "The requested location was superseded by another navigation."
      : failure.message;
  return { code: failure.code, message, terminal: false };
}

export function normalizeError(cause: unknown, terminal: boolean): ReaderError {
  if (cause instanceof NavigatorError) {
    if (cause.failure.code === "occurrence-unavailable") {
      const message = fallbackFailureMessage(cause.failure.reason);
      if (message !== null) {
        return { code: cause.failure.reason, message, terminal: true };
      }
    }
    return {
      code: cause.failure.code,
      message: cause.failure.message,
      terminal,
    };
  }
  return {
    code: "reader-boundary-failed",
    message:
      cause instanceof Error ? cause.message : "The reader encountered an unexpected failure.",
    terminal,
  };
}

function fallbackFailureMessage(reason: string): string | null {
  if (reason === "manifest-fallback-exhausted") {
    return "This section has no XHTML or SVG document in its manifest fallback chain.";
  }
  if (reason === "manifest-fallback-unresolved") {
    return "This section's manifest fallback reference cannot be resolved.";
  }
  if (reason === "manifest-fallback-cycle") {
    return "This section's manifest fallback chain contains a cycle.";
  }
  return null;
}
