import type { ContentAgentOutboundMessage } from "../agent-protocol/index.js";
import type { ContentAgentState } from "./state.js";

export type OutboundMessageInput<T extends ContentAgentOutboundMessage> = T extends unknown
  ? Omit<T, "session">
  : never;

export function post(
  state: ContentAgentState,
  message: OutboundMessageInput<ContentAgentOutboundMessage>,
): void {
  const { reader, readerOrigin, protocolSession } = state.transport;
  if (reader === null || readerOrigin === null || protocolSession === null) return;
  // Session correlates one frame lifecycle; publisher scripts share this realm.
  reader.postMessage({ ...message, session: protocolSession }, readerOrigin);
}
