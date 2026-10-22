import type { NavigatorKernelAccess } from "../kernel.js";

let nextIdentity = 0;
const generationKeys = new Set([
  "generation",
  "documentGeneration",
  "frameGeneration",
  "ownerDocumentGeneration",
  "layoutGeneration",
]);

/** Namespace independent kernels at the trusted boundary, including reverse command translation. */
export function rollKernel(kernel: NavigatorKernelAccess): NavigatorKernelAccess {
  const outward = new Map<number, number>();
  const inward = new Map<number, number>();
  function translate<T>(value: T, outgoing: boolean, key = ""): T {
    if (typeof value === "number" && generationKeys.has(key)) {
      if (!outgoing) return (inward.get(value) ?? Number.MAX_SAFE_INTEGER) as T;
      let identity = outward.get(value);
      if (identity === undefined) {
        identity = ++nextIdentity;
        outward.set(value, identity);
        inward.set(identity, value);
      }
      return identity as T;
    }
    if (Array.isArray(value)) return value.map((item) => translate(item, outgoing)) as T;
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, translate(item, outgoing, name)]),
      ) as T;
    return value;
  }
  return {
    get stateRevision() {
      return kernel.stateRevision;
    },
    snapshot: () => translate(kernel.snapshot(), true),
    dispatch: (input) => translate(kernel.dispatch(translate(input, false)), true),
    projectAnnotationTarget: (target) => kernel.projectAnnotationTarget(target),
    close: (beforeFree) =>
      translate(
        kernel.close(
          beforeFree === undefined
            ? undefined
            : (transition) => beforeFree(translate(transition, true)),
        ),
        true,
      ),
  };
}
