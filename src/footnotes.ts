/** Session-local state for one positively classified footnote or endnote navigation. */
export interface NavigatorFootnoteNavigation {
  readonly activationId: number;
  readonly occurrence: number;
  readonly resource: string;
}

/** Outcome of returning from a footnote to its retained note reference. */
export type NavigatorFootnoteReturnResult =
  | { readonly status: "returned" }
  | { readonly status: "unavailable" | "stale" | "failed" };
