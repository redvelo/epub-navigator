import type {
  AdapterObservation,
  FrameObservation,
  KernelInput,
  KernelSnapshot,
  KernelTransition,
  NavigatorCommand,
  AnnotationTargetResolutionPlan,
} from "../generated/kernel.js";
import type { MountedPublication } from "../publication.js";
import { NavigatorError } from "../runtime.js";
import { initializeNavigatorWasm, WasmNavigatorKernel } from "../wasm.js";

/** Creates the mandatory deterministic kernel for one complete Navigator runtime. */
export async function createNavigatorKernel(
  publication: MountedPublication,
): Promise<NavigatorKernelAccess> {
  await initializeNavigatorWasm().catch((cause: unknown) => {
    throw new NavigatorError(
      {
        code: "kernel-runtime-initialization-failed",
        message: errorMessage(cause, "the Navigator kernel could not be initialized"),
      },
      { cause },
    );
  });

  return createInitializedNavigatorKernel(publication);
}

/** Internal synchronous allocation after the runtime factory has initialized WASM. */
export function createInitializedNavigatorKernel(
  publication: MountedPublication,
): NavigatorKernelAccess {
  let kernel: WasmNavigatorKernel;
  try {
    kernel = WasmNavigatorKernel.create(stringifyJson(publication));
  } catch (cause) {
    throw new NavigatorError(
      {
        code: "kernel-create-failed",
        message: errorMessage(cause, "the Navigator kernel could not be created"),
      },
      { cause },
    );
  }
  return new WasmNavigatorKernelAccess(kernel);
}

/** Explicitly owned browser facade over one Rust Navigator kernel allocation. */
export interface NavigatorKernelAccess {
  readonly stateRevision: number;
  snapshot(): KernelSnapshot;
  dispatch(input: KernelInput): KernelTransition;
  projectAnnotationTarget(targetJson: string): AnnotationTargetResolutionPlan;
  close(beforeFree?: (transition: KernelTransition) => void): KernelTransition;
}

export function commandInput(command: NavigatorCommand): KernelInput {
  return { type: "command", command };
}

export function frameInput(frame: FrameObservation): KernelInput {
  return { type: "frame", frame };
}

export function adapterInput(adapter: AdapterObservation): KernelInput {
  return { type: "adapter", adapter };
}

class WasmNavigatorKernelAccess implements NavigatorKernelAccess {
  readonly #kernel: WasmNavigatorKernel;
  #closed = false;
  #closeTransition: KernelTransition | undefined;
  #closeError: NavigatorError | undefined;

  constructor(kernel: WasmNavigatorKernel) {
    this.#kernel = kernel;
  }

  get stateRevision(): number {
    this.#assertOpen();
    return this.#kernel.stateRevision;
  }

  snapshot(): KernelSnapshot {
    this.#assertOpen();
    return this.#parseResponse(this.#kernel.snapshotJson) as KernelSnapshot;
  }

  dispatch(input: KernelInput): KernelTransition {
    if (input.type === "command" && input.command.type === "close") return this.close();
    this.#assertOpen();
    let inputJson: string;
    try {
      inputJson = stringifyJson(input);
    } catch (cause) {
      throw new NavigatorError(
        {
          code: "invalid-command",
          message: errorMessage(cause, "the Navigator input is invalid"),
        },
        { cause },
      );
    }
    try {
      return this.#parseResponse(this.#kernel.dispatchJson(inputJson)) as KernelTransition;
    } catch (cause) {
      if (cause instanceof NavigatorError) throw cause;
      throw new NavigatorError(
        {
          code: "invalid-command",
          message: errorMessage(cause, "the Navigator kernel rejected the serialized input"),
        },
        { cause },
      );
    }
  }

  projectAnnotationTarget(targetJson: string): AnnotationTargetResolutionPlan {
    this.#assertOpen();
    if (typeof targetJson !== "string") {
      throw new TypeError("annotation target JSON must be a string");
    }
    try {
      return this.#parseResponse(
        this.#kernel.projectAnnotationTargetJson(targetJson),
      ) as AnnotationTargetResolutionPlan;
    } catch (cause) {
      if (cause instanceof NavigatorError) throw cause;
      throw new NavigatorError(
        {
          code: "invalid-command",
          message: errorMessage(cause, "the annotation target is invalid"),
        },
        { cause },
      );
    }
  }

  close(beforeFree?: (transition: KernelTransition) => void): KernelTransition {
    if (this.#closeError !== undefined) throw this.#closeError;
    if (this.#closeTransition !== undefined) return this.#closeTransition;
    this.#assertOpen();
    let transition: KernelTransition;
    try {
      transition = this.#parseResponse(
        this.#kernel.dispatchJson(JSON.stringify(commandInput({ type: "close" }))),
      ) as KernelTransition;
    } catch (cause) {
      if (cause instanceof NavigatorError) throw cause;
      throw new NavigatorError(
        {
          code: "kernel-command-failed",
          message: errorMessage(cause, "the Navigator kernel could not close the session"),
        },
        { cause },
      );
    }
    this.#closed = true;
    this.#closeTransition = transition;
    let beforeFreeError: unknown;
    try {
      beforeFree?.(transition);
    } catch (cause) {
      beforeFreeError = cause;
    }
    try {
      this.#kernel.free();
    } catch (cause) {
      this.#closeError = new NavigatorError(
        {
          code: "kernel-close-failed",
          message: errorMessage(cause, "the Navigator kernel could not be disposed cleanly"),
        },
        { cause },
      );
      throw this.#closeError;
    }
    if (beforeFreeError !== undefined) throw beforeFreeError;
    return transition;
  }

  #parseResponse(json: string): unknown {
    try {
      return JSON.parse(json);
    } catch (cause) {
      throw new NavigatorError(
        {
          code: "kernel-response-parse-failed",
          message: errorMessage(cause, "the Navigator kernel returned invalid JSON"),
        },
        { cause },
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new NavigatorError({
        code: "kernel-closed",
        message: "the Navigator kernel is closed",
      });
    }
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) => {
    if (typeof member === "number" && !Number.isFinite(member)) {
      throw new TypeError("Navigator JSON values must contain only finite numbers");
    }
    return member;
  });
}
