import { PIARIUM_PROTOCOL_VERSION } from "./types.js";
export function createRequest(id, method, params) {
    return { id, kind: "request", method, params, v: PIARIUM_PROTOCOL_VERSION };
}
export function createSuccessResponse(id, result) {
    return {
        id,
        kind: "response",
        ok: true,
        result,
        v: PIARIUM_PROTOCOL_VERSION,
    };
}
export function createErrorResponse(id, error) {
    return { error, id, kind: "response", ok: false, v: PIARIUM_PROTOCOL_VERSION };
}
export function createEvent(seq, event, data) {
    return { data, event, kind: "event", seq, v: PIARIUM_PROTOCOL_VERSION };
}
//# sourceMappingURL=envelopes.js.map