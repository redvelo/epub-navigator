export const readerCommands = [
  "search",
  "navigation",
  "annotations",
  "quick-menu",
  "settings",
  "library",
  "help",
  "highlight",
  "note",
  "narration",
  "page-backward",
  "page-forward",
  "dismiss",
] as const;

export type ReaderCommand = (typeof readerCommands)[number];

export function readerKeyCommand(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  mode: "off" | "standard" | "vim",
  selectionActive: boolean,
): ReaderCommand | null {
  if (mode === "off" || event.altKey) return null;
  if (event.ctrlKey || event.metaKey) {
    return !event.shiftKey && event.key.toLowerCase() === "f" ? "search" : null;
  }
  switch (event.key) {
    case "Escape":
      return "dismiss";
    case "/":
      return "search";
    case "t":
      return "navigation";
    case "a":
      return "annotations";
    case "q":
      return "quick-menu";
    case ",":
      return "settings";
    case "B":
      return "library";
    case "?":
      return "help";
    case "f":
      return selectionActive ? "highlight" : null;
    case "d":
      return selectionActive ? "note" : null;
    case "n":
      return "narration";
    default:
      return null;
  }
}
