import type { WireEnvelope } from "./envelopes.js";
import { type RuntimeWireEnvelope } from "./runtime.js";
import { type JsonValue } from "./types.js";
export declare class ProtocolDecodeError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function decodeEnvelope(frame: string): WireEnvelope;
export declare function encodeEnvelope(envelope: WireEnvelope): string;
/** Decode one frame received from a Piarium surface transport. */
export declare function decodeRuntimeEnvelope(frame: string): RuntimeWireEnvelope;
/** Encode one message-oriented surface frame (WebSocket/postMessage). */
export declare function encodeRuntimeEnvelope(envelope: RuntimeWireEnvelope): string;
export interface JsonLineDecoderOptions {
    /** Set a positive byte count to cap frames. Omit, null, or 0 for no artificial cap. */
    maxFrameBytes?: number | null;
}
export declare class JsonLineDecoder {
    #private;
    constructor(options?: JsonLineDecoderOptions);
    push(chunk: string | Uint8Array): WireEnvelope[];
    finish(): WireEnvelope[];
}
export declare function asJsonValue(value: unknown): JsonValue;
//# sourceMappingURL=codec.d.ts.map