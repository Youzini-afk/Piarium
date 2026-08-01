import type { HostEvent, HostEventData } from "./events.js";
import type { HostMethod, HostMethodParams, HostMethodResult } from "./methods.js";
import { PIARIUM_PROTOCOL_VERSION, type ProtocolErrorData, type ProtocolVersion } from "./types.js";

export type RequestEnvelope<M extends HostMethod = HostMethod> = M extends HostMethod
  ? {
      id: string;
      kind: "request";
      method: M;
      params: HostMethodParams<M>;
      v: ProtocolVersion;
    }
  : never;

export type SuccessResponseEnvelope<M extends HostMethod = HostMethod> = M extends HostMethod
  ? {
      id: string;
      kind: "response";
      ok: true;
      result: HostMethodResult<M>;
      v: ProtocolVersion;
    }
  : never;

export interface ErrorResponseEnvelope {
  error: ProtocolErrorData;
  id: string;
  kind: "response";
  ok: false;
  v: ProtocolVersion;
}

export type ResponseEnvelope<M extends HostMethod = HostMethod> =
  | SuccessResponseEnvelope<M>
  | ErrorResponseEnvelope;

export type EventEnvelope<E extends HostEvent = HostEvent> = E extends HostEvent
  ? {
      data: HostEventData<E>;
      event: E;
      kind: "event";
      seq: number;
      v: ProtocolVersion;
    }
  : never;

export type WireEnvelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export function createRequest<M extends HostMethod>(
  id: string,
  method: M,
  params: HostMethodParams<M>,
): RequestEnvelope<M> {
  return { id, kind: "request", method, params, v: PIARIUM_PROTOCOL_VERSION } as RequestEnvelope<M>;
}

export function createSuccessResponse<M extends HostMethod>(
  id: string,
  result: HostMethodResult<M>,
): SuccessResponseEnvelope<M> {
  return {
    id,
    kind: "response",
    ok: true,
    result,
    v: PIARIUM_PROTOCOL_VERSION,
  } as SuccessResponseEnvelope<M>;
}

export function createErrorResponse(id: string, error: ProtocolErrorData): ErrorResponseEnvelope {
  return { error, id, kind: "response", ok: false, v: PIARIUM_PROTOCOL_VERSION };
}

export function createEvent<E extends HostEvent>(
  seq: number,
  event: E,
  data: HostEventData<E>,
): EventEnvelope<E> {
  return { data, event, kind: "event", seq, v: PIARIUM_PROTOCOL_VERSION } as EventEnvelope<E>;
}
