import { createElement, type MouseEvent, type ReactNode } from "react";
import type { TextDirection } from "../generated/publication.js";
import type { NavigatorReaderProps } from "./public-types.js";

const formatting = new Set([
  "p",
  "div",
  "span",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const omitted = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "template",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "link",
  "meta",
  "base",
  "img",
  "audio",
  "video",
  "source",
]);

export function PublicationDescription({
  markup,
  direction,
  onLinkActivation,
}: {
  readonly markup: string;
  readonly direction: TextDirection | null;
  readonly onLinkActivation: NavigatorReaderProps["onLinkActivation"];
}) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const renderNode = (node: Node, index: number): ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (!(node instanceof HTMLElement)) return null;
    const tag = node.localName;
    if (omitted.has(tag)) return null;
    const children = Array.from(node.childNodes, renderNode);
    if (tag === "a") {
      const href = node.getAttribute("href") ?? "";
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return children;
      }
      if (!onLinkActivation || !["http:", "https:"].includes(url.protocol)) return children;
      const activate = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (event.isTrusted && (event.button === 0 || event.button === 1)) {
          onLinkActivation({
            href,
            resolvedUrl: url.href,
            internal: false,
            target: null,
            download: null,
            note: null,
          });
        }
      };
      return (
        <a key={index} href={url.href} onClick={activate} onAuxClick={activate}>
          {children}
        </a>
      );
    }
    if (!formatting.has(tag)) return children;
    return createElement(/^h[1-6]$/.test(tag) ? "h4" : tag, { key: index }, ...children);
  };
  return (
    <div className="epub-navigator-reader__description" dir={direction ?? "auto"}>
      {Array.from(template.content.childNodes, renderNode)}
    </div>
  );
}
