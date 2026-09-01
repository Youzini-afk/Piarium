import type { HostEvent, HostEventData } from "./events.js";
import type { HostMethod, HostMethodParams, HostMethodResult } from "./methods.js";
import { type ProtocolErrorData, type ProtocolVersion } from "./types.js";
export type RequestEnvelope<M extends HostMethod = HostMethod> = M extends HostMethod ? {
    id: string;
    kind: "request";
    method: M;
    params: HostMethodParams<M>;
    v: ProtocolVersion;
} : never;
export type SuccessResponseEnvelope<M extends HostMethod = HostMethod> = M extends HostMethod ? {
    id: string;
    kind: "response";
    ok: true;
    result: HostMethodResult<M>;
    v: ProtocolVersion;
} : never;
export interface ErrorResponseEnvelope {
    error: ProtocolErrorData;
    id: string;
    kind: "response";
    ok: false;
    v: ProtocolVersion;
}
export type ResponseEnvelope<M extends HostMethod = HostMethod> = SuccessResponseEnvelope<M> | ErrorResponseEnvelope;
export type EventEnvelope<E extends HostEvent = HostEvent> = E extends HostEvent ? {
    data: HostEventData<E>;
    event: E;
    kind: "event";
    seq: number;
    v: ProtocolVersion;
} : never;
export type WireEnvelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;
export declare function createRequest<M extends HostMethod>(id: string, method: M, params: HostMethodParams<M>): RequestEnvelope<M>;
export declare function createSuccessResponse<M extends HostMethod>(id: string, result: HostMethodResult<M>): SuccessResponseEnvelope<M>;
export declare function createErrorResponse(id: string, error: ProtocolErrorData): ErrorResponseEnvelope;
export declare function createEvent<E extends HostEvent>(seq: number, event: E, data: HostEventData<E>): EventEnvelope<E>;
//# sourceMappingURL=envelopes.d.ts.map