import type { ComponentProps, ReactNode } from "react";
import { ArrowLeft, Search as SearchIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { AuthoredNavigation } from "./authored-navigation.js";

export interface ReaderNavigationContentProps {
  readonly variant: "workspace" | "compact";
  readonly mode: "navigation" | "search";
  readonly projection: ComponentProps<typeof AuthoredNavigation>["projection"];
  readonly current: ComponentProps<typeof AuthoredNavigation>["current"];
  readonly pagination: ComponentProps<typeof AuthoredNavigation>["pagination"];
  readonly onNavigate: ComponentProps<typeof AuthoredNavigation>["onNavigate"];
  readonly search: ReactNode;
}

export function ReaderNavigationContent({
  variant,
  mode,
  projection,
  current,
  pagination,
  onNavigate,
  search,
}: ReaderNavigationContentProps) {
  return variant === "workspace" ? (
    <div className="epub-navigator-reader__navigation-surface">
      <div className="min-h-0 flex-1" hidden={mode !== "navigation"}>
        <AuthoredNavigation
          projection={projection}
          current={current}
          pagination={pagination}
          onNavigate={onNavigate}
          paginated
        />
      </div>
      {mode === "search" ? search : null}
    </div>
  ) : (
    <>
      <div className="h-full min-h-0" hidden={mode !== "navigation"}>
        <AuthoredNavigation
          projection={projection}
          current={current}
          pagination={pagination}
          onNavigate={onNavigate}
          tabsAtBottom
          paginated
        />
      </div>
      {mode === "search" ? search : null}
    </>
  );
}

export interface NavigationTitleActionProps {
  readonly mode: "navigation" | "search";
  readonly searchAvailable: boolean;
  readonly onOpenSearch: () => void;
  readonly onCloseSearch: () => void;
}

export function NavigationTitleAction({
  mode,
  searchAvailable,
  onOpenSearch,
  onCloseSearch,
}: NavigationTitleActionProps) {
  return mode === "search" ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-rhea-local-action="compact"
      aria-label="Back to navigation"
      onClick={onCloseSearch}
    >
      <ArrowLeft aria-hidden="true" />
    </Button>
  ) : searchAvailable ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-rhea-local-action="compact"
      aria-label="Search publication"
      title="Search publication (/)"
      aria-keyshortcuts="/ Control+f Meta+f"
      onClick={onOpenSearch}
    >
      <SearchIcon aria-hidden="true" />
    </Button>
  ) : null;
}
