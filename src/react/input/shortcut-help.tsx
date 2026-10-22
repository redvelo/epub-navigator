import { Dialog, DialogClose, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { Button } from "../components/ui/button.js";
import {
  BookOpen,
  Highlighter,
  MessageSquarePlus,
  PanelsTopLeft,
  Scan,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { PaginatedOverflow } from "../paginated-overflow.js";
import { visiblePrimaryPublicationFrame } from "./focus.js";
import type { ReflowableLayoutMode } from "../../generated/kernel.js";
import type { NavigatorReaderPreferences } from "../public-types.js";

type Shortcut = readonly [action: string, keys: readonly string[]];

// A scrolled book separates two movements a paginated one performs with the same key: the page
// keys move the text, and the arrows that follow the reading direction leave the section, since
// a scrolled document has no pages along that direction to move through first.
const reading = (scrolled: boolean): readonly Shortcut[] => [
  [scrolled ? "Next screen" : "Next page", ["PgDn", "Space"]],
  [scrolled ? "Previous screen" : "Previous page", ["PgUp", "Shift Space"]],
  [scrolled ? "Next / previous section" : "Follow reading direction", ["Arrows"]],
  ["Play / pause narration", ["n"]],
  ["Focus controls", ["Tab", "Shift Tab"]],
  ["Dismiss active surface", ["Esc"]],
];
const panels: readonly Shortcut[] = [
  ["Search", ["/", "Ctrl/Cmd F"]],
  ["Contents", ["t"]],
  ["Annotations", ["a"]],
  ["Quick menu", ["q"]],
  ["Reader settings", [","]],
  ["Return to library", ["Shift B"]],
  ["Shortcut help", ["?"]],
];
const vim = (scrolled: boolean): readonly Shortcut[] => [
  [scrolled ? "Next / previous screen" : "Next / previous page", ["j", "k"]],
  ["Previous / next section", ["h", "l"]],
  ["Document start / end", ["gg", "G"]],
];
const fixedLayout: readonly Shortcut[] = [
  ["Zoom in / out", ["+", "−"]],
  ["Reset zoom", ["0"]],
  ["Pan", ["Shift Arrows"]],
];

function Keycaps({ keys }: { readonly keys: Shortcut[1] }) {
  "use no memo";
  return (
    <span className="shortcut-keys">
      {keys.map((chord, index) => (
        <span key={chord}>
          {index > 0 ? <span>/</span> : null}
          {chord.split(" ").map((key, keyIndex) => (
            <span key={key}>
              {keyIndex > 0 ? <span>+</span> : null}
              <kbd>{key}</kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function ShortcutGroup({
  title,
  icon: Icon,
  shortcuts,
}: {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly shortcuts: readonly Shortcut[];
}) {
  "use no memo";
  return (
    <section className="shortcut-group" aria-label={title}>
      <h3>
        <Icon className="size-4" aria-hidden="true" />
        {title}
      </h3>
      <dl>
        {shortcuts.map(([action, keys]) => (
          <div key={action}>
            <dt>{action}</dt>
            <dd>
              <Keycaps keys={keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutHelp({
  open,
  onOpenChange,
  root,
  frameHost,
  keyboardMode,
  presentationMode,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly root: HTMLElement | null;
  readonly frameHost: HTMLElement | null;
  readonly keyboardMode: NavigatorReaderPreferences["keyboardMode"];
  readonly presentationMode: ReflowableLayoutMode | "fixed" | "unavailable" | undefined;
}) {
  "use no memo";
  const scrolled = presentationMode === "document-scroll";
  return (
    <Dialog modal="trap-focus" open={open} onOpenChange={onOpenChange}>
      <DialogContent
        contained
        backdropClassName="bg-transparent transition-none"
        portalContainer={root ?? undefined}
        finalFocus={() => visiblePrimaryPublicationFrame(frameHost)}
        className="shortcut-help transition-none"
      >
        <header className="flex min-h-11 items-center border-b p-1 ps-4">
          <DialogTitle className="min-w-0 flex-1 font-medium">Keyboard shortcuts</DialogTitle>
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-rhea-local-action="compact"
                aria-label="Close keyboard shortcuts"
              />
            }
          >
            <X aria-hidden="true" />
          </DialogClose>
        </header>
        <PaginatedOverflow pageLabel="Keyboard shortcuts">
          <div className="space-y-4 p-4">
            {keyboardMode === "off" ? (
              <p className="max-w-sm text-sm text-muted-foreground">
                Reader shortcuts are disabled. Enable Standard or Vim in Interaction settings to use
                them. Tab and Enter still work with reader controls.
              </p>
            ) : null}
            <section aria-label="Selection & notes" className="shortcut-notes">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
                <h3 className="text-xs font-semibold tracking-wide text-primary uppercase">
                  Selection & notes
                </h3>
                <p className="text-xs text-muted-foreground">With text selected</p>
              </div>
              <dl>
                <div>
                  <dt>
                    <Highlighter className="size-4 text-primary" aria-hidden="true" />
                    Highlight
                  </dt>
                  <dd>
                    <Keycaps keys={["f"]} />
                  </dd>
                </div>
                <div>
                  <dt>
                    <MessageSquarePlus className="size-4 text-primary" aria-hidden="true" />
                    Add note
                  </dt>
                  <dd>
                    <Keycaps keys={["d"]} />
                  </dd>
                </div>
              </dl>
            </section>
            <div className="shortcut-grid">
              <ShortcutGroup title="Reading" icon={BookOpen} shortcuts={reading(scrolled)} />
              <ShortcutGroup title="Panels & search" icon={PanelsTopLeft} shortcuts={panels} />
              {keyboardMode === "vim" ? (
                <ShortcutGroup title="Vim navigation" icon={Terminal} shortcuts={vim(scrolled)} />
              ) : null}
              <ShortcutGroup title="Fixed-layout books" icon={Scan} shortcuts={fixedLayout} />
            </div>
            <p className="text-xs text-muted-foreground">
              Mouse Back / Forward {scrolled ? "moves by screen" : "turns pages"} independently of
              keyboard mode.
            </p>
          </div>
        </PaginatedOverflow>
      </DialogContent>
    </Dialog>
  );
}
