export const AGENT_READINESS_TIMEOUT_MS = 2_000;
export const AGENT_OPERATION_TIMEOUT_MS = 2_000;
// Decoration reconciliation resolves every projected record against the whole document behind
// the agent's own work meter, so on slow hardware a large section legitimately needs far more
// than a point lookup's deadline. The deadline here is liveness insurance against a dead frame,
// not the bound on the work; the meter is.
export const RECONCILE_DECORATIONS_TIMEOUT_MS = 30_000;
export const AGENT_LAYOUT_OPERATION_TIMEOUT_MS = 10_000;
export const AGENT_ROLE_CHANGE_TIMEOUT_MS = 2_000;
export const FIXED_SPREAD_STAGING_TIMEOUT_MS = 5_000;
export const FRAME_RELEASE_TIMEOUT_MS = 10_000;
