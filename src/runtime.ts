import type { NavigatorFailure } from "./generated/kernel.js";

/** Throwable wrapper around a serializable Navigator failure. */
export class NavigatorError extends Error {
  readonly failure: NavigatorFailure;

  constructor(failure: NavigatorFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "NavigatorError";
    this.failure = failure;
  }

  toJSON(): NavigatorFailure {
    return this.failure;
  }
}
