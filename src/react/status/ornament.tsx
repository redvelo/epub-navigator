import { CircleAlert, CircleDashed, Globe } from "lucide-react";
import { titleCase } from "../lib/utils.js";

export type ReaderStatus = "ready" | "network" | "loading" | "issue";

// Page measurement is routine background work, not a status: a quiet mark outside the live
// region, so it is neither announced nor styled as a problem.
export function MeasuringIndicator({ measuring }: { readonly measuring: boolean }) {
  if (!measuring) return null;
  return (
    <span
      className="epub-navigator-reader__measuring-indicator"
      title="Measuring pages"
      aria-hidden="true"
    >
      <CircleDashed />
    </span>
  );
}

export function ReaderStatusOrnament({
  status,
  compact = false,
}: {
  readonly status: ReaderStatus;
  readonly compact?: boolean | undefined;
}) {
  if (status === "ready") return null;
  const label = status === "network" ? "Recent network activity" : titleCase(status);
  return (
    <span className="epub-navigator-reader__status-ornament" role="status" title={label}>
      {status === "issue" ? (
        <CircleAlert aria-hidden="true" />
      ) : status === "network" ? (
        <Globe aria-hidden="true" />
      ) : (
        <CircleDashed aria-hidden="true" />
      )}
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}
