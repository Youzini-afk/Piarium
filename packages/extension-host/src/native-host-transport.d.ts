import type { JsonValue } from "@piarium/extension-contract";
import type { BrokeredHostTransport } from "./broker-supervisor.js";
export interface NativeHostTransportOptions {
    requestFromExtension(method: string, params: unknown, signal: AbortSignal): Promise<JsonValue>;
}
export declare class NativeHostTransport implements BrokeredHostTransport {
    #private;
    constructor(options: NativeHostTransportOptions);
    request(method: string, paramsValue?: unknown): Promise<unknown>;
    terminate(): Promise<void>;
    forceTerminate(): void;
}
//# sourceMappingURL=native-host-transport.d.ts.map