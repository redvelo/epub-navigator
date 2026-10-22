addEventListener(
  "message",
  (event) => {
    if (event.data?.namespace === "epub-navigator" && event.data?.type === "initialize") {
      parent.postMessage(
        {
          namespace: "epub-navigator",
          session: event.data.session,
          type: "ready",
          protocolVersion: event.data.protocolVersion,
          supportedOperations: ["resolve-locator"],
        },
        event.origin,
      );
    }
  },
  { once: true },
);
