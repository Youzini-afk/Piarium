import type {
  ExtensionUiRequest,
  JsonValue,
  ProjectTrustRequest,
  ProtocolErrorData,
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

export type HostEvent = keyof HostEventMap;

export type HostEventData<E extends HostEvent> = HostEventMap[E];
