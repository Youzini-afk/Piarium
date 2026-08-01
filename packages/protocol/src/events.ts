import type {
  ExtensionUiRequest,
  JsonValue,
  ProjectTrustRequest,
  ProtocolErrorData,
  RecoveryStatus,
  RuntimeDescriptor,
  SessionSnapshot,
} from "./types.js";

export interface HostEventMap {
  "agent.event": {
    event: JsonValue;
    sessionId: string;
  };
  "extension.ui.dismiss": {
    requestId: string;
    sessionId: string;
  };
  "extension.ui.request": ExtensionUiRequest;
  "host.error": ProtocolErrorData;
  "host.log": {
    fields?: JsonValue;
    level: "debug" | "info" | "warn" | "error";
    message: string;
  };
  "host.ready": {
    runtime: RuntimeDescriptor;
  };
  "project.trust.request": ProjectTrustRequest;
  "provider.auth.event": {
    event: JsonValue;
    providerId: string;
  };
  "recovery.changed": {
    sessionId: string;
  };
  "recovery.status": RecoveryStatus & {
    sessionId: string;
  };
  "package.progress": {
    message: string;
    operation: "install" | "remove" | "update";
    percent?: number;
    source?: string;
  };
  "session.closed": {
    sessionId: string;
  };
  "session.snapshot": SessionSnapshot;
}

export const HOST_EVENTS = [
  "agent.event",
  "extension.ui.dismiss",
  "extension.ui.request",
  "host.error",
  "host.log",
  "host.ready",
  "package.progress",
  "project.trust.request",
  "provider.auth.event",
  "recovery.changed",
  "recovery.status",
  "session.closed",
  "session.snapshot",
] as const satisfies readonly (keyof HostEventMap)[];

const HOST_EVENT_SET = new Set<string>(HOST_EVENTS);

export type HostEvent = keyof HostEventMap;

export type HostEventData<E extends HostEvent> = HostEventMap[E];

export function isHostEvent(value: unknown): value is HostEvent {
  return typeof value === "string" && HOST_EVENT_SET.has(value);
}
