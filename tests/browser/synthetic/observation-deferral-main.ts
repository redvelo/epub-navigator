import { CONTENT_AGENT_PROTOCOL_VERSION } from "../../../src/runtime/agent-protocol/types.js";
import { animationFrames, delivered, waitFor } from "../harness.js";

declare global {
  interface Window {
    runAgentScenario(source: string): Promise<unknown>;
  }
}

const timeoutMessage = "timed out waiting for fixture state";

window.runAgentScenario = async (source) => {
  const frame = document.createElement("iframe");
  frame.src = "/publications/alice/epub/text/milestone-1.xhtml";
  document.body.append(frame);
  await new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  const view = frame.contentWindow;
  if (view === null || frame.contentDocument === null) {
    throw new Error("the content frame is unavailable");
  }
  const session = `settlement-${crypto.randomUUID()}`;
  const messages: Record<string, any>[] = [];
  const sentinels = new Map<number, () => void>();
  let nextSentinel = 1_000_000;
  addEventListener("message", (event) => {
    if (event.source !== view || event.data?.session !== session) return;
    const sentinel = sentinels.get(event.data.operation);
    if (event.data.type === "result" && sentinel !== undefined) sentinel();
    else messages.push(event.data);
  });
  const post = (message: Record<string, unknown>) =>
    view.postMessage({ namespace: "epub-navigator", session, ...message }, location.origin);
  const configuration = (rootScrollbar = "publisher", input = defaultInput()) => ({
    appearance: { rootScrollbar },
    input,
  });
  const request = (operation: number, type: string, target: string) =>
    post({
      type: "request",
      operation,
      request: {
        type,
        target: { kind: "point", evidence: [{ kind: "html-fragment", value: target }] },
      },
    });
  const gated = (kind: string, id: string) =>
    `/_epub-navigator/gated-resource?kind=${kind}&id=${id}-${session}`;
  post({
    type: "initialize",
    protocolVersion: CONTENT_AGENT_PROTOCOL_VERSION,
    adapter: "reflowable-xhtml",
    role: "foreground",
    diagnostics: true,
    configuration: configuration(),
  });
  await waitFor(() => messages.some((message) => message.type === "ready"), timeoutMessage);
  messages.length = 0;

  const controls: ScenarioControls = {
    frame,
    messages,
    gated,
    addFont(id) {
      const style = frame.contentDocument?.createElement("style");
      if (style === undefined) throw new Error("fixture document is unavailable");
      style.textContent = `@font-face { font-family: Gated; src: url("${gated("font", id)}"); } body { font-family: Gated, serif; }`;
      frame.contentDocument?.head.append(style);
    },
    addImage(id) {
      const image = frame.contentDocument?.createElement("img");
      if (image === undefined) throw new Error("fixture document is unavailable");
      image.src = gated("image", id);
      frame.contentDocument?.body.append(image);
    },
    addStylesheet(id) {
      const link = frame.contentDocument?.createElement("link");
      if (link === undefined) throw new Error("fixture document is unavailable");
      link.rel = "stylesheet";
      link.href = gated("stylesheet", id);
      frame.contentDocument?.head.append(link);
    },
    addMarkup(html, into = "body") {
      const parent = frame.contentDocument?.[into];
      if (parent === undefined || parent === null)
        throw new Error("fixture document is unavailable");
      parent.insertAdjacentHTML("beforeend", html);
    },
    async layout(operation, mode = "document-scroll", presentation = {}) {
      post({
        type: "request",
        operation,
        request: {
          type: "layout",
          adapter: "reflowable-xhtml",
          presentation: {
            mode,
            paginationColumns: "auto",
            theme: "original",
            colorScheme: "light",
            typeface: "original",
            fontScale: "100",
            lineHeight: "original",
            letterSpacing: "0",
            wordSpacing: "0",
            paragraphSpacing: "original",
            textIndent: "original",
            measure: "wide",
            alignment: "original",
            hyphenation: "original",
            rootScrollbar: "publisher",
            alignXCenter: false,
            ...presentation,
          },
          position: { kind: "unavailable" },
        },
      });
      const matches = (message: Record<string, any>) =>
        message.type === "result" && message.operation === operation;
      await waitFor(() => messages.some(matches), timeoutMessage);
      return messages.find(matches)!;
    },
    async release(id, failure = false) {
      await waitFor(async () => {
        const response = await fetch(
          `/_epub-navigator/release-resource?id=${id}-${session}&failure=${String(failure)}`,
        );
        return response.ok;
      }, timeoutMessage);
    },
    clearMessages() {
      messages.length = 0;
    },
    configure(input = defaultInput(), rootScrollbar = "publisher") {
      post({ type: "configure", configuration: configuration(rootScrollbar, input) });
    },
    request,
    requestToc(operation, evidence) {
      post({
        type: "request",
        operation,
        request: {
          type: "measure-toc-targets",
          targets: [{ listIndex: 0, pointPath: [0], evidence }],
        },
      });
    },
    requestAnnotation(operation, type, value) {
      post({
        type: "request",
        operation,
        request: {
          type,
          plan: {
            resource: "EPUB/chapter.xhtml",
            selectors: [{ kind: "css", path: [0], values: { value }, refinements: [] }],
          },
        },
      });
    },
    cancel(operation, operationType) {
      post({ type: "cancel-operation", operation, operationType });
    },
    waitFor: (predicate, timeout = 3_000) => waitFor(predicate, timeoutMessage, timeout),
    delivered: () => delivered(view),
    async quiesce() {
      const operation = nextSentinel++;
      const answered = new Promise<void>((resolve) => sentinels.set(operation, resolve));
      request(operation, "resolve-locator", "locator-target");
      await answered;
      await animationFrames(view, 3);
      await new Promise((resolve) => view.setTimeout(resolve));
      await delivered();
    },
  };
  // oxlint-disable-next-line typescript/no-implied-eval -- the harness ships the callback source into the page
  return Function("controls", `return (${source})(controls)`)(controls) as Promise<unknown>;

  function defaultInput() {
    return {
      keyboardMode: "off",
      touchZones: false,
      progressionDirection: "ltr",
      selectionMenu: "native",
    };
  }
};

export interface ScenarioControls {
  readonly frame: HTMLIFrameElement;
  readonly messages: Record<string, any>[];
  gated(kind: "font" | "image" | "stylesheet", id: string): string;
  addFont(id: string): void;
  addImage(id: string): void;
  addStylesheet(id: string): void;
  addMarkup(html: string, into?: "head" | "body"): void;
  layout(
    operation: number,
    mode?: "document-scroll" | "paginated",
    presentation?: Record<string, string>,
  ): Promise<Record<string, any>>;
  release(id: string, failure?: boolean): Promise<void>;
  clearMessages(): void;
  configure(
    input?: {
      keyboardMode: string;
      touchZones: boolean;
      progressionDirection: string;
      selectionMenu: string;
    },
    rootScrollbar?: string,
  ): void;
  request(operation: number, type: "resolve-locator" | "relocate", target: string): void;
  requestToc(operation: number, evidence: readonly Record<string, unknown>[]): void;
  requestAnnotation(
    operation: number,
    type: "resolve-annotation-target" | "relocate-annotation-target",
    value: string,
  ): void;
  cancel(
    operation: number,
    operationType:
      | "resolve-locator"
      | "relocate"
      | "resolve-annotation-target"
      | "relocate-annotation-target"
      | "layout"
      | "measure-toc-targets",
  ): void;
  waitFor(predicate: () => boolean | Promise<boolean>, timeout?: number): Promise<void>;
  delivered(): Promise<void>;
  quiesce(): Promise<void>;
}
