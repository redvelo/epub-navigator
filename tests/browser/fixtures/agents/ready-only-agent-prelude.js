let blockedRequest = null;
addEventListener(
  "message",
  (event) => {
    if (
      event.data?.namespace === "epub-navigator" &&
      event.data?.type === "request" &&
      event.data?.request?.type !== "layout"
    ) {
      blockedRequest = event.data;
      const result = (session) => ({
        namespace: "epub-navigator",
        session,
        type: "result",
        operation: event.data.operation,
        resultType: event.data.request.type,
        status: { status: "resolved" },
      });
      parent.postMessage(result("wrong-session"), "*");
      setTimeout(() => parent.postMessage(result(event.data.session), "*"), 2100);
      event.stopImmediatePropagation();
      return;
    }
    if (event.data?.namespace === "epub-navigator" && event.data?.type === "cancel-operation") {
      parent.postMessage(
        {
          type: "fixture-operation-cancelled",
          operation: event.data.operation,
          operationType: event.data.operationType,
          exactSession: event.data.session === blockedRequest?.session,
        },
        "*",
      );
    }
  },
  true,
);
const nativeAddEventListener = window.addEventListener.bind(window);
let agentMessageListenerWrapped = false;
window.addEventListener = (type, listener, options) => {
  if (type !== "message" || agentMessageListenerWrapped) {
    return nativeAddEventListener(type, listener, options);
  }
  agentMessageListenerWrapped = true;
  const delayedListener = (event) => {
    const invoke = () =>
      typeof listener === "function" ? listener.call(window, event) : listener.handleEvent(event);
    if (
      event.data?.namespace === "epub-navigator" &&
      event.data?.type === "request" &&
      event.data?.request?.type === "layout"
    ) {
      setTimeout(invoke, 2500);
    } else {
      invoke();
    }
  };
  return nativeAddEventListener(type, delayedListener, options);
};
