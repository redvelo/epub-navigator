export const tocEnrichmentDeadlineMs = 2_000;
export const tocEnrichmentSliceMs = 8;
export const cacheRestoreStallDeadlineMs = 3_000;
export const pageMeasurementDeadlineMs = 10_000;
export const idleCallbackTimeoutMs = 100;
export const idleCallbackWatchdogMs = 150;
export const inputPendingRetryMs = 50;
export const auxiliaryQuietPeriodMs = 250;
export const auxiliaryMaximumDeferralMs = 1_000;
// Page turns closer together than this are a flip-through, not reading: measurement waits for
// the longer quiet period and adjacent preparation follows only the direction of travel.
export const rapidTurnIntervalMs = 2_000;
export const auxiliaryFlipQuietPeriodMs = 2_000;
export const auxiliaryFlipMaximumDeferralMs = 10_000;
export const turnEchoMs = 100;
export const maximumPageMeasurementAttempts = 2;

export type PaginationPacing = "normal" | "conservative";

// A burst measures up to `burstLength` chapters back to back, then rests for `restMs` before the
// next idle-callback pickup. Any burst also yields to the quiet period after foreground activity
// (a page turn) so measurement never queues behind the reader's own work.
export const pacingProfiles: Record<
  PaginationPacing,
  { readonly burstLength: number; readonly restMs: number }
> = {
  normal: { burstLength: 32, restMs: 100 },
  conservative: { burstLength: 6, restMs: 750 },
};
