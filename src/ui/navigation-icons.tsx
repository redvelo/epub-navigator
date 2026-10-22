import { ChevronLeft, ChevronRight, Lamp, Plus, X } from "lucide-react";

export function PreviousPageIcon() {
  return <ChevronLeft aria-hidden="true" />;
}

export function NextPageIcon() {
  return <ChevronRight aria-hidden="true" />;
}

export function AddIcon() {
  return <Plus aria-hidden="true" />;
}

export function CloseIcon() {
  return <X aria-hidden="true" />;
}

/** Named for the fixture, not a use: a host decides what its own lamp control means. */
export function LampIcon() {
  return <Lamp aria-hidden="true" />;
}
