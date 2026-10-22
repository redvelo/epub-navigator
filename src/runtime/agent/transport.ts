import {
  isExpectedFrameMessage,
  postFrameMessage,
  type resolveFrameProfile,
} from "../frame-profile.js";

export type AgentFrameProfile = ReturnType<typeof resolveFrameProfile>;

export { isExpectedFrameMessage, postFrameMessage };

export function installAgentMessageTransport(
  runtimeWindow: Window,
  signal: AbortSignal,
  receive: (event: MessageEvent<unknown>) => void,
): void {
  runtimeWindow.addEventListener("message", receive, { signal });
}

export function createProtocolSession(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
