import { isHostEvent } from "./events.js";
import { isRuntimeEventEnvelope, isRuntimeMethod, } from "./runtime.js";
import { PIARIUM_PROTOCOL_VERSION } from "./types.js";
export class ProtocolDecodeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ProtocolDecodeError";
        this.code = code;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireNonEmptyString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new ProtocolDecodeError("invalid_envelope", `${field} must be a non-empty string`);
    }
}
export function decodeEnvelope(frame) {
    let value;
    try {
        value = JSON.parse(frame);
    }
    catch {
        throw new ProtocolDecodeError("invalid_json", "Protocol frame is not valid JSON");
    }
    if (!isRecord(value)) {
        throw new ProtocolDecodeError("invalid_envelope", "Protocol frame must be a JSON object");
    }
    if (value.v !== PIARIUM_PROTOCOL_VERSION) {
        throw new ProtocolDecodeError("unsupported_version", `Unsupported protocol version: ${String(value.v)}`);
    }
    switch (value.kind) {
        case "request":
            requireNonEmptyString(value.id, "id");
            requireNonEmptyString(value.method, "method");
            if (!("params" in value)) {
                throw new ProtocolDecodeError("invalid_envelope", "request.params is required");
            }
            break;
        case "response":
            requireNonEmptyString(value.id, "id");
            if (typeof value.ok !== "boolean") {
                throw new ProtocolDecodeError("invalid_envelope", "response.ok must be a boolean");
            }
            if (value.ok && !("result" in value)) {
                throw new ProtocolDecodeError("invalid_envelope", "successful response.result is required");
            }
            if (!value.ok && !isRecord(value.error)) {
                throw new ProtocolDecodeError("invalid_envelope", "failed response.error is required");
            }
            break;
        case "event":
            requireNonEmptyString(value.event, "event");
            if (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0) {
                throw new ProtocolDecodeError("invalid_envelope", "event.seq must be a non-negative integer");
            }
            if (!("data" in value)) {
                throw new ProtocolDecodeError("invalid_envelope", "event.data is required");
            }
            break;
        default:
            throw new ProtocolDecodeError("invalid_envelope", "Unknown protocol envelope kind");
    }
    return value;
}
export function encodeEnvelope(envelope) {
    return `${JSON.stringify(envelope)}\n`;
}
/** Decode one frame received from a Piarium surface transport. */
export function decodeRuntimeEnvelope(frame) {
    const envelope = decodeEnvelope(frame);
    if (envelope.kind === "request" && !isRuntimeMethod(envelope.method)) {
        throw new ProtocolDecodeError("unsupported_method", `Unsupported runtime method: ${String(envelope.method)}`);
    }
    if (envelope.kind === "event" && !isRuntimeEventEnvelope(envelope)) {
        throw new ProtocolDecodeError("invalid_envelope", "runtime event.source is required");
    }
    if (envelope.kind === "event" && !isHostEvent(envelope.event)) {
        throw new ProtocolDecodeError("unsupported_event", `Unsupported runtime event: ${String(envelope.event)}`);
    }
    return envelope;
}
/** Encode one message-oriented surface frame (WebSocket/postMessage). */
export function encodeRuntimeEnvelope(envelope) {
    return JSON.stringify(envelope);
}
export class JsonLineDecoder {
    #decoder = new TextDecoder();
    #encoder = new TextEncoder();
    #maxFrameBytes;
    #buffer = "";
    constructor(options = {}) {
        const configured = options.maxFrameBytes;
        this.#maxFrameBytes = configured === undefined || configured === null || configured === 0
            ? undefined
            : configured;
        if (this.#maxFrameBytes !== undefined &&
            (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 0)) {
            throw new RangeError("maxFrameBytes must be a non-negative integer, null, or undefined");
        }
    }
    push(chunk) {
        this.#buffer +=
            typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
        this.#assertWithinLimit();
        const envelopes = [];
        let newline = this.#buffer.indexOf("\n");
        while (newline !== -1) {
            let frame = this.#buffer.slice(0, newline);
            this.#buffer = this.#buffer.slice(newline + 1);
            if (frame.endsWith("\r"))
                frame = frame.slice(0, -1);
            if (frame.length > 0)
                envelopes.push(decodeEnvelope(frame));
            this.#assertWithinLimit();
            newline = this.#buffer.indexOf("\n");
        }
        return envelopes;
    }
    finish() {
        this.#buffer += this.#decoder.decode();
        if (this.#buffer.length === 0)
            return [];
        this.#assertWithinLimit();
        const frame = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
        this.#buffer = "";
        return frame.length === 0 ? [] : [decodeEnvelope(frame)];
    }
    #assertWithinLimit() {
        if (this.#maxFrameBytes !== undefined &&
            this.#encoder.encode(this.#buffer).byteLength > this.#maxFrameBytes) {
            this.#buffer = "";
            throw new ProtocolDecodeError("frame_too_large", "Protocol frame exceeds the configured limit");
        }
    }
}
export function asJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}
//# sourceMappingURL=codec.js.map