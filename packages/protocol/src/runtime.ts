import type { HostEvent, HostEventData } from "./events.js";
import type { HostMethodMap } from "./methods.js";
import {
  createErrorResponse,
  type ErrorResponseEnvelope,
} from "./envelopes.js";
import {
  PIARIUM_PROTOCOL_VERSION,
  type ExtensionUiResponse,
  type HostHandshakeParams,
  type HostHandshakeResult,
  type ProtocolErrorData,
  type ProtocolVersion,
} from "./types.js";

type DirectRuntimeMethod =
  | "agent.abort"
  | "agent.followUp"
  | "agent.prompt"
  | "agent.steer"
  | "command.execute"
  | "command.list"
  | "recovery.apply"
  | "recovery.checkpoint.create"
  | "recovery.list"
  | "recovery.preview"
  | "recovery.redo"
  | "recovery.undo"
  | "session.close"
  | "session.create"
  | "session.entries"
  | "session.fork"
  | "session.list"
  | "session.navigate"
  | "session.open"
  | "session.snapshot";

type SessionScopedRuntimeMethod =
  | "model.list"
  | "package.install"
  | "package.list"
  | "package.remove"
  | "package.update"
  | "provider.list"
  | "provider.login"
  | "provider.logout"
  | "settings.get"
  | "settings.update";

type SessionScopedMethodMap = {
  [M in SessionScopedRuntimeMethod]: {
    params: M extends
      | "model.list"
      | "package.list"
      | "provider.list"
      | "settings.get"
      ? { sessionId: string }
      : HostMethodMap[M]["params"] & { sessionId: string };
    result: HostMethodMap[M]["result"];
  };
};

/**
 * Public Piarium runtime contract used by renderer, web, mobile, and editor
 * surfaces. Worker-only lifecycle and trust-response methods are deliberately
 * absent. Catalog operations are session scoped because Pi resources and
 * provider registrations can vary by workspace.
 */
export type RuntimeMethodMap = Pick<HostMethodMap, DirectRuntimeMethod> &
  SessionScopedMethodMap & {
    "extension.ui.respond": {
      params: { response: ExtensionUiResponse; sessionId: string };
      result: HostMethodMap["extension.ui.respond"]["result"];
    };
    "host.handshake": {
      params: HostHandshakeParams;
      result: HostHandshakeResult;
    };
    "model.select": HostMethodMap["model.select"];
  };

export const RUNTIME_METHODS = [
  "agent.abort",
  "agent.followUp",
  "agent.prompt",
  "agent.steer",
  "command.execute",
  "command.list",
  "extension.ui.respond",
  "host.handshake",
  "model.list",
  "model.select",
  "package.install",
  "package.list",
  "package.remove",
  "package.update",
  "provider.list",
  "provider.login",
  "provider.logout",
  "recovery.apply",
  "recovery.checkpoint.create",
  "recovery.list",
  "recovery.preview",
  "recovery.redo",
  "recovery.undo",
  "session.close",
  "session.create",
  "session.entries",
  "session.fork",
  "session.list",
  "session.navigate",
  "session.open",
  "session.snapshot",
  "settings.get",
  "settings.update",
] as const satisfies readonly (keyof RuntimeMethodMap)[];

const RUNTIME_METHOD_SET = new Set<string>(RUNTIME_METHODS);

export type RuntimeMethod = keyof RuntimeMethodMap;

export type RuntimeMethodParams<M extends RuntimeMethod> = RuntimeMethodMap[M]["params"];

export type RuntimeMethodResult<M extends RuntimeMethod> = RuntimeMethodMap[M]["result"];

export function isRuntimeMethod(value: unknown): value is RuntimeMethod {
  return typeof value === "string" && RUNTIME_METHOD_SET.has(value);
}

export type RuntimeWorkerRole = "catalog" | "session";

export interface RuntimeEventSource {
  role: RuntimeWorkerRole;
  sessionId?: string;
  workerId: string;
}

export type RuntimeRequestEnvelope<M extends RuntimeMethod = RuntimeMethod> =
  M extends RuntimeMethod
    ? {
        id: string;
        kind: "request";
        method: M;
        params: RuntimeMethodParams<M>;
        v: ProtocolVersion;
      }
    : never;

export type RuntimeSuccessResponseEnvelope<M extends RuntimeMethod = RuntimeMethod> =
  M extends RuntimeMethod
    ? {
        id: string;
        kind: "response";
        ok: true;
        result: RuntimeMethodResult<M>;
        v: ProtocolVersion;
      }
    : never;

export type RuntimeResponseEnvelope<M extends RuntimeMethod = RuntimeMethod> =
  | RuntimeSuccessResponseEnvelope<M>
  | ErrorResponseEnvelope;

export type RuntimeEventEnvelope<E extends HostEvent = HostEvent> = E extends HostEvent
  ? {
      data: HostEventData<E>;
      event: E;
      kind: "event";
      seq: number;
      source: RuntimeEventSource;
      v: ProtocolVersion;
    }
  : never;

export type RuntimeWireEnvelope =
  | RuntimeRequestEnvelope
  | RuntimeResponseEnvelope
  | RuntimeEventEnvelope;

export function createRuntimeRequest<M extends RuntimeMethod>(
  id: string,
  method: M,
  params: RuntimeMethodParams<M>,
): RuntimeRequestEnvelope<M> {
  return {
    id,
    kind: "request",
    method,
    params,
    v: PIARIUM_PROTOCOL_VERSION,
  } as RuntimeRequestEnvelope<M>;
}

export function createRuntimeSuccessResponse<M extends RuntimeMethod>(
  id: string,
  result: RuntimeMethodResult<M>,
): RuntimeSuccessResponseEnvelope<M> {
  return {
    id,
    kind: "response",
    ok: true,
    result,
    v: PIARIUM_PROTOCOL_VERSION,
  } as RuntimeSuccessResponseEnvelope<M>;
}

export function createRuntimeErrorResponse(
  id: string,
  error: ProtocolErrorData,
): ErrorResponseEnvelope {
  return createErrorResponse(id, error);
}

export function createRuntimeEvent<E extends HostEvent>(
  source: RuntimeEventSource,
  seq: number,
  event: E,
  data: HostEventData<E>,
): RuntimeEventEnvelope<E> {
  return {
    data,
    event,
    kind: "event",
    seq,
    source,
    v: PIARIUM_PROTOCOL_VERSION,
  } as RuntimeEventEnvelope<E>;
}

export function isRuntimeEventEnvelope(
  envelope: { kind: string; [key: string]: unknown },
): envelope is RuntimeEventEnvelope {
  if (envelope.kind !== "event") return false;
  const source = envelope.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const record = source as Record<string, unknown>;
  return (
    (record.role === "catalog" || record.role === "session") &&
    typeof record.workerId === "string" &&
    record.workerId.length > 0 &&
    (record.sessionId === undefined ||
      (typeof record.sessionId === "string" && record.sessionId.length > 0))
  );
}
