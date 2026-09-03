import type {
  ExtensionStateSnapshot,
  ExtensionUiRequest,
  JsonValue,
  ProjectTrustRequest,
  PiConfigWatchChangeReason,
  PiConfigWatchTarget,
  ProtocolErrorData,
  RecoveryStatus,
  RuntimeDescriptor,
  SessionSnapshot,
} from "./types.js";
import type {
  ProviderAuthEvent,
  ProviderAuthPromptRequest,
} from "./auth.js";
import type { PiAgentEvent } from "./session.js";
import type { ProviderConfigDeleteScope } from "./provider.js";
import type { HarnessRequestData } from "./harness.js";

interface WorkspaceMutationRequestBase {
  path: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: "write" | "edit" | "apply_patch";
}

export type WorkspaceMutationRequest = WorkspaceMutationRequestBase & (
  | { phase: "before"; succeeded?: never }
  | { phase: "after"; succeeded: boolean }
);

export interface HostEventMap {
  "agent.event": {
    event: PiAgentEvent;
    sessionId: string;
  };
  "config.changed": {
    reason: PiConfigWatchChangeReason;
    target: PiConfigWatchTarget;
    watchId: string;
  };
  "extension.ui.dismiss": {
    requestId: string;
    sessionId: string;
  };
  "extension.ui.request": ExtensionUiRequest;
  "extension.state": ExtensionStateSnapshot;
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
  "provider.auth.dismiss": {
    providerId: string;
    requestId: string;
    sessionId: string;
  };
  "provider.auth.event": {
    event: ProviderAuthEvent;
    providerId: string;
    sessionId: string;
  };
  "provider.auth.prompt": ProviderAuthPromptRequest;
  "provider.config.changed": {
    providerId: string;
    scope: ProviderConfigDeleteScope;
    sessionId: string;
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
  "session.worker.exited": {
    code: number | null;
    expected: boolean;
    sessionId: string;
    signal: string | null;
  };
  "workspace.mutation.request": WorkspaceMutationRequest;
  "harness.request": HarnessRequestData;
  "harness.thread.changed": {
    parentSessionId: string;
    thread: {
      id: string;
      status: import("./harness-threads.js").ThreadStatus;
      brief: string;
      role: string | null;
      steps: number;
      lastActivityAt: string;
      flags: { workerLost: boolean; stalled: boolean; looping: boolean };
      waitingFor: { kind: "user" | "permission" | "thread"; text: string } | null;
    };
  };
  "harness.thread.done": {
    parentSessionId: string;
    threadId: string;
    report: import("./harness-threads.js").ThreadReport;
  };
}

export const HOST_EVENTS = [
  "agent.event",
  "config.changed",
  "extension.ui.dismiss",
  "extension.ui.request",
  "extension.state",
  "harness.request",
  "harness.thread.changed",
  "harness.thread.done",
  "host.error",
  "host.log",
  "host.ready",
  "package.progress",
  "project.trust.request",
  "provider.auth.dismiss",
  "provider.auth.event",
  "provider.auth.prompt",
  "provider.config.changed",
  "recovery.changed",
  "recovery.status",
  "session.closed",
  "session.snapshot",
  "session.worker.exited",
  "workspace.mutation.request",
] as const satisfies readonly (keyof HostEventMap)[];

const HOST_EVENT_SET = new Set<string>(HOST_EVENTS);

export type HostEvent = keyof HostEventMap;

export type HostEventData<E extends HostEvent> = HostEventMap[E];

export function isHostEvent(value: unknown): value is HostEvent {
  return typeof value === "string" && HOST_EVENT_SET.has(value);
}
