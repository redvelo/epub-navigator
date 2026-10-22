import { useEffect, useRef, type ReactNode, useLayoutEffect } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Drawer, DrawerContent, DrawerTitle } from "../components/ui/drawer.js";
import { Popover, PopoverClose, PopoverContent, PopoverTitle } from "../components/ui/popover.js";
import { PaginatedOverflow } from "../paginated-overflow.js";
import type { SelectionToolbarRect } from "../selection-toolbar.js";
import { DictionaryContent, type DictionaryContentProps } from "./content.js";
import { dictionaryTitle } from "./model.js";

export interface DictionarySurfaceProps extends DictionaryContentProps {
  readonly root: HTMLElement | null;
  readonly finalFocus: () => HTMLElement | null;
  readonly onBack: () => void;
  readonly onClose: () => void;
}

function resultKey(props: DictionaryContentProps): string {
  const lookup = props.snapshot.lookup;
  return lookup.state === "ready"
    ? lookup.result.request.requestId
    : lookup.state === "looking-up" || lookup.state === "failed"
      ? lookup.request.requestId
      : lookup.state;
}

function DictionaryHeader({
  props,
  title,
  close,
  dismissal,
}: {
  readonly props: DictionarySurfaceProps;
  readonly title: ReactNode;
  readonly close: ReactNode;
  readonly dismissal?: ReactNode | undefined;
}) {
  return (
    <header className="grid min-h-12 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center border-b p-1">
      {props.snapshot.history.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          data-rhea-local-action
          aria-label="Back to previous word"
          onClick={props.onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
      ) : (
        (dismissal ?? <span />)
      )}
      {title}
      {close}
    </header>
  );
}

function DictionaryBody({ props }: { readonly props: DictionaryContentProps }) {
  return (
    <PaginatedOverflow key={resultKey(props)} pageLabel="Dictionary">
      <div
        className="epub-navigator-reader__dictionary-body"
        aria-busy={props.snapshot.lookup.state === "looking-up"}
      >
        <DictionaryContent {...props} />
      </div>
    </PaginatedOverflow>
  );
}

export function DictionarySheet(props: DictionarySurfaceProps) {
  const title = dictionaryTitle(props.snapshot);
  return (
    <Drawer modal="trap-focus" open onOpenChange={(open) => !open && props.onClose()}>
      <DrawerContent
        contained
        // Transparent, but present: a press on the publication behind reaches its own frame
        // rather than the reader, so the dismissal needs something of the reader's to land on.
        backdropClassName="bg-transparent"
        onBackdropPress={props.onClose}
        portalContainer={props.root ?? undefined}
        finalFocus={props.finalFocus}
        className="epub-navigator-reader__compact-sheet [--bleed:0px] [--drawer-inset:0px] data-[swipe-axis=y]:[--drawer-content-height:100%] data-[swipe-axis=y]:[--drawer-content-max-height:none] rounded-none border-x-0 border-t-2 border-b-0 border-border shadow-none"
      >
        <DictionaryHeader
          props={props}
          dismissal={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-rhea-local-action
              aria-label="Close dictionary"
              onClick={props.onClose}
            >
              <X aria-hidden="true" />
            </Button>
          }
          title={
            <DrawerTitle className="min-w-0 truncate text-center font-medium" dir="auto">
              {title}
            </DrawerTitle>
          }
          close={<span />}
        />
        <DictionaryBody props={props} />
      </DrawerContent>
    </Drawer>
  );
}

export function DictionaryPopover({
  anchor,
  ...props
}: DictionarySurfaceProps & { readonly anchor: SelectionToolbarRect }) {
  const title = dictionaryTitle(props.snapshot);
  const onClose = useRef(props.onClose);
  useLayoutEffect(() => {
    onClose.current = props.onClose;
  });
  const root = props.root;
  useEffect(() => {
    const view = root?.ownerDocument.defaultView;
    if (root === null || view === null || view === undefined) return;
    const dismissForPublicationFocus = () => {
      queueMicrotask(() => {
        const active = root.ownerDocument.activeElement;
        if (active instanceof HTMLIFrameElement && root.contains(active)) onClose.current();
      });
    };
    view.addEventListener("blur", dismissForPublicationFocus);
    return () => view.removeEventListener("blur", dismissForPublicationFocus);
  }, [root]);
  const virtualAnchor = {
    getBoundingClientRect: () =>
      DOMRect.fromRect({
        x: anchor.left,
        y: anchor.top,
        width: anchor.right - anchor.left,
        height: anchor.bottom - anchor.top,
      }),
  };
  return (
    <Popover open onOpenChange={(open) => !open && props.onClose()}>
      <PopoverContent
        portalContainer={root ?? undefined}
        finalFocus={props.finalFocus}
        className="epub-navigator-reader__dictionary-popover flex w-[min(26rem,calc(100cqw-1rem))] flex-col"
        positionerProps={{
          anchor: virtualAnchor,
          side: "bottom",
          align: "center",
        }}
      >
        <DictionaryHeader
          props={props}
          title={
            <PopoverTitle
              className="m-0 min-w-0 truncate text-center text-sm font-medium"
              dir="auto"
            >
              {title}
            </PopoverTitle>
          }
          close={
            <PopoverClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  data-rhea-local-action
                  aria-label="Close dictionary"
                />
              }
            >
              <X aria-hidden="true" />
            </PopoverClose>
          }
        />
        <DictionaryBody props={props} />
      </PopoverContent>
    </Popover>
  );
}
