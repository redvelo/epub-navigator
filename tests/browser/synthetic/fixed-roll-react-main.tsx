import { createRoot } from "react-dom/client";
import { openArchive } from "../harness.js";
import { NavigatorReader } from "epub-navigator/react";
import "epub-navigator/react.css";

const publication = await openArchive("/roll.epub");
createRoot(document.querySelector("#root")!).render(
  <NavigatorReader
    session={{
      id: "official-roll-react",
      publication: {
        facts: publication.facts,
        mount: {
          baseUrl: `${location.origin}/roll-publication/`,
          contentOrigin: "shared-reader-origin",
          remoteResources: "blocked",
        },
      },
    }}
  />,
);
