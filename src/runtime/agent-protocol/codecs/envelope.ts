import type { AgentEnvelope } from "../types.js";
import { isRecord } from "./primitives.js";

export const CONTENT_AGENT_NAMESPACE = "epub-navigator" as const;

export function hasEnvelope(
  value: unknown,
  type: string,
): value is Record<string, unknown> & AgentEnvelope {
  return (
    isRecord(value) &&
    value.namespace === CONTENT_AGENT_NAMESPACE &&
    value.type === type &&
    isSession(value.session)
  );
}

export function envelope<const T extends object>(session: string, value: T): T & AgentEnvelope {
  return { namespace: CONTENT_AGENT_NAMESPACE, session, ...value };
}

export function isSession(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function assertSession(session: string): void {
  if (!isSession(session)) throw new TypeError("content-agent session must be a bounded string");
}

export function withExpectedSession<T extends AgentEnvelope>(
  message: T | null,
  expectedSession: string | undefined,
): T | null {
  return message !== null && (expectedSession === undefined || message.session === expectedSession)
    ? message
    : null;
}
