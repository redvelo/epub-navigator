import { useState } from "react";
import { BookOpen } from "lucide-react";
import { Button } from "./components/ui/button.js";

export function PublicationDetailsTrigger({
  coverUrl,
  onClick,
}: {
  readonly coverUrl: string | null;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      data-rhea-local-action
      className="epub-navigator-reader__publication-details-trigger size-14 justify-self-center p-0.5"
      aria-label="Publication details"
      onClick={onClick}
    >
      <PublicationCover key={coverUrl} coverUrl={coverUrl} />
    </Button>
  );
}

function PublicationCover({ coverUrl }: { readonly coverUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  if (coverUrl === null || failed) {
    return <BookOpen className="size-[1.125rem]" aria-hidden="true" />;
  }
  return (
    <img
      className="h-auto max-h-[3.25rem] w-auto max-w-10 rounded-[1px] border border-border bg-background"
      src={coverUrl}
      crossOrigin="anonymous"
      alt=""
      aria-hidden="true"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
