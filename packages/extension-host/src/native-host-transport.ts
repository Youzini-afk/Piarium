import { createRequire } from "node:module";
import type { JsonObject, JsonValue, PiariumExtensionStorageSnapshot } from "@piarium/extension-contract";
import type { BrokeredHostTransport } from "./broker-supervisor.js";

interface NativeHostExtension {
  activate(context: NativeHostContext): unknown | Promise<unknown>;
  migrate?(input: unknown): JsonObject | Promise<JsonObject>;
}

interface NativeHostContext {
  capabilities: { call(capability: string, method: string, params: JsonValue): Promise<JsonValue> };
  effect(disposer: () => void | Promise<void>): void;
  services: {
    provide(descriptor: unknown, handler: Record<string, (...args: JsonValue[]) => unknown>): void;
    use(id: string, version: number, providerId?: string): { call(method: string, ...args: JsonValue[]): Promise<JsonValue> };
  };
  signal: AbortSignal;
  storage: {
    readonly snapshot: PiariumExtensionStorageSnapshot;
    update(data: JsonObject, expectedRevision?: number): Promise<PiariumExtensionStorageSnapshot>;
  };
}

export interface NativeHostTransportOptions {
  requestFromExtension(method: string, params: unknown, signal: AbortSignal): Promise<JsonValue>;
}

const resolveExtension = (moduleValue: unknown): NativeHostExtension => {
  const module = moduleValue as { activate?: unknown; default?: unknown; migrate?: unknown };
  const candidate = module?.default ?? module;
  if (typeof candidate === "function") {
    const extension: NativeHostExtension = { activate: candidate as NativeHostExtension["activate"] };
    if (typeof module.migrate === "function") extension.migrate = module.migrate as NonNullable<NativeHostExtension["migrate"]>;
    return extension;
  }
  if (candidate && typeof candidate === "object" && typeof (candidate as { activate?: unknown }).activate === "function") {
    const extension = candidate as NativeHostExtension;
    return {
      activate: extension.activate.bind(extension),
      ...(typeof extension.migrate === "function" ? { migrate: extension.migrate.bind(extension) } : {}),
    };
  }
  if (typeof module?.activate === "function") {
    const extension: NativeHostExtension = { activate: module.activate as NativeHostExtension["activate"] };
    if (typeof module.migrate === "function") extension.migrate = module.migrate as NonNullable<NativeHostExtension["migrate"]>;
    return extension;
  }
  throw new Error("Trusted-native Piarium Host module must export activate or a default extension definition");
};

export class NativeHostTransport implements BrokeredHostTransport {
  readonly #disposers: Array<() => void | Promise<void>> = [];
  readonly #requestFromExtension: NativeHostTransportOptions["requestFromExtension"];
  readonly #serviceHandlers = new Map<string, Record<string, (...args: JsonValue[]) => unknown>>();
  #controller: AbortController | null = null;
  #modulePath = "";
  #moduleValue: unknown;
  #storage: PiariumExtensionStorageSnapshot | null = null;
  #terminated = false;

  constructor(options: NativeHostTransportOptions) {
    this.#requestFromExtension = options.requestFromExtension;
  }

  async request(method: string, paramsValue?: unknown): Promise<unknown> {
    if (this.#terminated && method !== "deactivate") throw new Error("Trusted-native Host entrypoint is inactive");
    const params = paramsValue && typeof paramsValue === "object" && !Array.isArray(paramsValue)
      ? paramsValue as Record<string, unknown>
      : {};
    switch (method) {
      case "migrate": {
        const extension = this.#load(String(params.modulePath ?? ""));
        if (!extension.migrate) {
          const input = params.input as { fromSchemaVersion?: unknown; toSchemaVersion?: unknown; data?: unknown } | undefined;
          if (input?.fromSchemaVersion !== input?.toSchemaVersion) {
            throw new Error("Extension storage requires migration but the trusted-native Host module exports no migrate function");
          }
          return input?.data ?? {};
        }
        return extension.migrate(params.input);
      }
      case "activate": {
        await this.#deactivate().catch(() => undefined);
        this.#terminated = false;
        const extension = this.#load(String(params.modulePath ?? ""));
        this.#controller = new AbortController();
        this.#storage = params.storage as PiariumExtensionStorageSnapshot;
        const stagedHandlers = new Map<string, Record<string, (...args: JsonValue[]) => unknown>>();
        const provisions: unknown[] = [];
        const readStorage = (): PiariumExtensionStorageSnapshot => {
          if (!this.#storage) throw new Error("Trusted-native Host storage is unavailable");
          return this.#storage;
        };
        const updateStorage = async (data: JsonObject, expectedRevision = this.#storage?.document.revision) => {
          this.#storage = await this.#requestFromExtension(
            "storage.update",
            { data, expectedRevision },
            this.#controller?.signal ?? new AbortController().signal,
          ) as unknown as PiariumExtensionStorageSnapshot;
          return this.#storage;
        };
        const context: NativeHostContext = {
          capabilities: {
            call: (capability, capabilityMethod, capabilityParams) => this.#requestFromExtension(
              "capability.call",
              { capability, method: capabilityMethod, params: capabilityParams },
              this.#controller?.signal ?? new AbortController().signal,
            ),
          },
          effect: (disposer) => {
            if (typeof disposer !== "function") throw new Error("Trusted-native Host effect disposer must be a function");
            this.#disposers.push(disposer);
          },
          services: {
            provide: (descriptorValue, handler) => {
              const descriptor = descriptorValue as { id?: unknown; version?: unknown };
              const key = `${String(descriptor.id ?? "")}@${Number(descriptor.version)}`;
              if (!descriptor.id || !Number.isSafeInteger(descriptor.version) || Number(descriptor.version) <= 0) {
                throw new Error("Trusted-native Host service descriptor is invalid");
              }
              if (!handler || typeof handler !== "object") throw new Error(`Trusted-native Host service handler is invalid: ${key}`);
              if (stagedHandlers.has(key)) throw new Error(`Trusted-native Host service provided more than once: ${key}`);
              stagedHandlers.set(key, handler);
              provisions.push(descriptorValue);
            },
            use: (id, version, providerId) => ({
              call: (serviceMethod, ...args) => this.#requestFromExtension(
                "service.invoke",
                { args, method: serviceMethod, providerId, serviceId: id, version },
                this.#controller?.signal ?? new AbortController().signal,
              ),
            }),
          },
          signal: this.#controller.signal,
          storage: {
            get snapshot() {
              return readStorage();
            },
            update: updateStorage,
          },
        };
        try {
          const returned = await extension.activate(context);
          if (typeof returned === "function") this.#disposers.push(returned as () => void | Promise<void>);
          for (const [key, handler] of stagedHandlers) this.#serviceHandlers.set(key, handler);
          return { provisions };
        } catch (error) {
          await this.#deactivate().catch(() => undefined);
          throw error;
        }
      }
      case "service.invoke": {
        const key = `${String(params.serviceId ?? "")}@${Number(params.version)}`;
        const methodHandler = this.#serviceHandlers.get(key)?.[String(params.method ?? "")];
        if (typeof methodHandler !== "function") throw new Error(`Trusted-native Host service method is unavailable: ${key}.${String(params.method ?? "")}`);
        return methodHandler(...(Array.isArray(params.args) ? params.args as JsonValue[] : []));
      }
      case "storage.sync":
        this.#storage = params.storage as PiariumExtensionStorageSnapshot;
        return null;
      case "deactivate":
        await this.#deactivate();
        this.#terminated = true;
        return null;
      default:
        throw new Error(`Unknown trusted-native Host request method: ${method}`);
    }
  }

  async terminate(): Promise<void> {
    await this.request("deactivate");
  }

  forceTerminate(): void {
    this.#controller?.abort("Trusted-native Host entrypoint force-disabled");
    this.#terminated = true;
  }

  #load(modulePath: string): NativeHostExtension {
    if (!modulePath) throw new Error("Trusted-native Host module path is required");
    if (this.#moduleValue === undefined || this.#modulePath !== modulePath) {
      this.#modulePath = modulePath;
      this.#moduleValue = createRequire(modulePath)(modulePath);
    }
    return resolveExtension(this.#moduleValue);
  }

  async #deactivate(): Promise<void> {
    this.#controller?.abort("Trusted-native Host entrypoint deactivated");
    this.#controller = null;
    this.#serviceHandlers.clear();
    const errors: string[] = [];
    while (this.#disposers.length > 0) {
      const disposer = this.#disposers.pop();
      try { await disposer?.(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (errors.length > 0) throw new Error(`Trusted-native Host cleanup failed: ${errors.join("; ")}`);
  }
}
