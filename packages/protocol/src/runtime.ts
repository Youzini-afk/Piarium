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
import type { ProviderAuthResponse } from "./auth.js";

type DirectRuntimeMethod =
  | "agent.abort"
  | "agent.followUp"
  | "agent.prompt"
  | "agent.steer"
  | "command.execute"
  | "fleet.status"
  | "recovery.checkpoint.create"
  | "recovery.navigate"
  | "recovery.repair"
  | "recovery.redo"
  | "recovery.status"
  | "recovery.undo"
  | "session.close"
  | "session.create"
  | "session.entry"
  | "session.entries"
  | "session.features.get"
  | "session.features.mutate"
  | "session.fork"
  | "session.header"
  | "session.list"
  | "session.navigate"
  | "session.open"
  | "session.rename"
  | "session.snapshot"
  | "session.stats"
  | "session.summary"
  | "session.tree"
  | "thinking.select";

type SessionScopedRuntimeMethod =
  | "agentProvider.action"
  | "agentProvider.list"
  | "config.document.get"
  | "config.document.update"
  | "config.text.get"
  | "config.text.update"
  | "model.list"
  | "package.install"
  | "package.list"
  | "package.remove"
  | "package.update"
  | "provider.list"
  | "provider.config.delete"
  | "provider.config.get"
  | "provider.config.upsert"
  | "provider.models.discover"
  | "provider.login"
  | "provider.logout"
  | "resource.copy"
  | "resource.create"
  | "resource.delete"
  | "resource.get"
  | "resource.list"
  | "resource.update"
  | "settings.get"
  | "settings.update";

export type RuntimeContextTarget =
  | { cwd: string; sessionId?: never }
  | { cwd?: never; sessionId: string };

type SessionScopedMethodMap = {
  [M in SessionScopedRuntimeMethod]: {
    params: M extends
      | "model.list"
      | "agentProvider.list"
      | "package.list"
      | "provider.list"
      | "settings.get"
      ? RuntimeContextTarget
      : HostMethodMap[M]["params"] & RuntimeContextTarget;
    result: HostMethodMap[M]["result"];
  };
};

/**
 * Public Piarium runtime contract used by renderer, web, mobile, and editor
 * surfaces. Worker-only lifecycle and trust-response methods are deliberately
 * absent. Catalog operations target either a live session or a broker-owned in-memory workspace
 * context because Pi resources and provider registrations can vary by workspace.
 */
export type RuntimeMethodMap = Omit<Pick<HostMethodMap, DirectRuntimeMethod>, "session.rename"> &
  SessionScopedMethodMap & {
    "command.list": {
      params: RuntimeContextTarget;
      result: HostMethodMap["command.list"]["result"];
    };
    "extension.ui.respond": {
      params: { response: ExtensionUiResponse; sessionId: string };
      result: HostMethodMap["extension.ui.respond"]["result"];
    };
    "host.handshake": {
      params: HostHandshakeParams;
      result: HostHandshakeResult;
    };
    "model.select": HostMethodMap["model.select"];
    "project.trust.respond": {
      params: {
        remember: boolean;
        requestId: string;
        trusted: boolean;
        workerId: string;
      };
      result: HostMethodMap["project.trust.respond"]["result"];
    };
    "session.archive": {
      params: { sessionId: string };
      result: HostMethodMap["session.list"]["result"][number];
    };
    "session.delete": {
      params: { sessionId: string };
      result: { deleted: boolean; sessionId: string };
    };
    "session.rename": {
      params: { name: string; sessionId: string };
      result: HostMethodMap["session.rename"]["result"];
    };
    "session.unarchive": {
      params: { sessionId: string };
      result: HostMethodMap["session.list"]["result"][number];
    };
    "provider.auth.respond": {
      params: { response: ProviderAuthResponse; sessionId: string };
      result: HostMethodMap["provider.auth.respond"]["result"];
    };
  };

export const RUNTIME_METHODS = [
  "agent.abort",
  "agent.followUp",
  "agent.prompt",
  "agent.steer",
  "agentProvider.action",
  "agentProvider.list",
  "command.execute",
  "command.list",
  "config.document.get",
  "config.document.update",
  "config.text.get",
  "config.text.update",
  "extension.ui.respond",
  "fleet.status",
  "host.handshake",
  "model.list",
  "model.select",
  "thinking.select",
  "package.install",
  "package.list",
  "package.remove",
  "package.update",
  "project.trust.respond",
  "provider.list",
  "provider.config.delete",
  "provider.config.get",
  "provider.config.upsert",
  "provider.models.discover",
  "provider.auth.respond",
  "provider.login",
  "provider.logout",
  "resource.copy",
  "resource.create",
  "resource.delete",
  "resource.get",
  "resource.list",
  "resource.update",
  "recovery.checkpoint.create",
  "recovery.navigate",
  "recovery.repair",
  "recovery.redo",
  "recovery.status",
  "recovery.undo",
  "session.close",
  "session.create",
  "session.delete",
  "session.entry",
  "session.entries",
  "session.features.get",
  "session.features.mutate",
  "session.fork",
  "session.header",
  "session.list",
  "session.navigate",
  "session.open",
  "session.rename",
  "session.snapshot",
  "session.stats",
  "session.summary",
  "session.tree",
  "session.archive",
  "session.unarchive",
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
