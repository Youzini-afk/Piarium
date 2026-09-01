import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
const packageAssetPath = (packageRoot, logicalPath) => {
    if (!packageRoot || !isAbsolute(packageRoot)) {
        throw new Error("Host package root is unavailable");
    }
    if (!logicalPath || logicalPath.includes("\\") || logicalPath.includes("\0") || isAbsolute(logicalPath)) {
        throw new Error("Host asset path must be a non-empty package-relative path");
    }
    const target = resolve(packageRoot, ...logicalPath.split("/"));
    const fromRoot = relative(packageRoot, target);
    if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        throw new Error(`Host asset path escapes the extension package: ${logicalPath}`);
    }
    return target;
};
const storageKey = (address) => (`${address.scope}\0${address.key}`);
const resolveExtension = (moduleValue) => {
    const module = moduleValue;
    const candidate = module?.default ?? module;
    if (typeof candidate === "function") {
        const extension = { activate: candidate };
        if (typeof module.migrate === "function")
            extension.migrate = module.migrate;
        return extension;
    }
    if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
        const extension = candidate;
        return {
            activate: extension.activate.bind(extension),
            ...(typeof extension.migrate === "function" ? { migrate: extension.migrate.bind(extension) } : {}),
        };
    }
    if (typeof module?.activate === "function") {
        const extension = { activate: module.activate };
        if (typeof module.migrate === "function")
            extension.migrate = module.migrate;
        return extension;
    }
    throw new Error("Trusted-native Piarium Host module must export activate or a default extension definition");
};
export class NativeHostTransport {
    #disposers = [];
    #requestFromExtension;
    #serviceHandlers = new Map();
    #controller = null;
    #modulePath = "";
    #moduleValue;
    #storages = new Map();
    #terminated = false;
    constructor(options) {
        this.#requestFromExtension = options.requestFromExtension;
    }
    async request(method, paramsValue) {
        if (this.#terminated && method !== "deactivate")
            throw new Error("Trusted-native Host entrypoint is inactive");
        const params = paramsValue && typeof paramsValue === "object" && !Array.isArray(paramsValue)
            ? paramsValue
            : {};
        switch (method) {
            case "migrate": {
                const extension = this.#load(String(params.modulePath ?? ""));
                if (!extension.migrate) {
                    const input = params.input;
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
                this.#storages.clear();
                const stagedHandlers = new Map();
                const provisions = [];
                const createStorageClient = (request, initialSnapshot) => {
                    const state = { snapshot: initialSnapshot };
                    const key = storageKey(request);
                    const clients = this.#storages.get(key) ?? new Set();
                    clients.add(state);
                    this.#storages.set(key, clients);
                    return {
                        get snapshot() { return state.snapshot; },
                        refresh: async () => {
                            state.snapshot = await this.#requestFromExtension("storage.refresh", request, this.#controller?.signal ?? new AbortController().signal);
                            return state.snapshot;
                        },
                        update: async (data, expectedRevision = state.snapshot.document.revision) => {
                            state.snapshot = await this.#requestFromExtension("storage.update", { data, expectedRevision, key: request.key, scope: request.scope }, this.#controller?.signal ?? new AbortController().signal);
                            return state.snapshot;
                        },
                    };
                };
                const defaultStorage = createStorageClient({ key: "state", scope: "application" }, params.storage);
                const packageRoot = String(params.packageRoot ?? "");
                const context = {
                    assets: {
                        path: (logicalPath) => packageAssetPath(packageRoot, logicalPath),
                    },
                    capabilities: {
                        call: (capability, capabilityMethod, capabilityParams) => this.#requestFromExtension("capability.call", { capability, method: capabilityMethod, params: capabilityParams }, this.#controller?.signal ?? new AbortController().signal),
                    },
                    effect: (disposer) => {
                        if (typeof disposer !== "function")
                            throw new Error("Trusted-native Host effect disposer must be a function");
                        this.#disposers.push(disposer);
                    },
                    services: {
                        provide: (descriptorValue, handler) => {
                            const descriptor = descriptorValue;
                            const key = `${String(descriptor.id ?? "")}@${Number(descriptor.version)}`;
                            if (!descriptor.id || !Number.isSafeInteger(descriptor.version) || Number(descriptor.version) <= 0) {
                                throw new Error("Trusted-native Host service descriptor is invalid");
                            }
                            if (!handler || typeof handler !== "object")
                                throw new Error(`Trusted-native Host service handler is invalid: ${key}`);
                            if (stagedHandlers.has(key))
                                throw new Error(`Trusted-native Host service provided more than once: ${key}`);
                            stagedHandlers.set(key, handler);
                            provisions.push(descriptorValue);
                        },
                        use: (id, version, providerId) => ({
                            call: (serviceMethod, ...args) => this.#requestFromExtension("service.invoke", { args, method: serviceMethod, providerId, serviceId: id, version }, this.#controller?.signal ?? new AbortController().signal),
                        }),
                    },
                    signal: this.#controller.signal,
                    storage: {
                        get snapshot() {
                            return defaultStorage.snapshot;
                        },
                        open: async (request) => createStorageClient(request, await this.#requestFromExtension("storage.open", request, this.#controller?.signal ?? new AbortController().signal)),
                        refresh: () => defaultStorage.refresh(),
                        update: (data, expectedRevision) => defaultStorage.update(data, expectedRevision),
                    },
                };
                try {
                    const returned = await extension.activate(context);
                    if (typeof returned === "function")
                        this.#disposers.push(returned);
                    for (const [key, handler] of stagedHandlers)
                        this.#serviceHandlers.set(key, handler);
                    return { provisions };
                }
                catch (error) {
                    await this.#deactivate().catch(() => undefined);
                    throw error;
                }
            }
            case "service.invoke": {
                const key = `${String(params.serviceId ?? "")}@${Number(params.version)}`;
                const methodHandler = this.#serviceHandlers.get(key)?.[String(params.method ?? "")];
                if (typeof methodHandler !== "function")
                    throw new Error(`Trusted-native Host service method is unavailable: ${key}.${String(params.method ?? "")}`);
                return methodHandler(...(Array.isArray(params.args) ? params.args : []));
            }
            case "storage.sync":
                for (const snapshot of Array.isArray(params.storages)
                    ? params.storages
                    : params.storage ? [params.storage] : []) {
                    for (const state of this.#storages.get(storageKey(snapshot.address)) ?? [])
                        state.snapshot = snapshot;
                }
                return null;
            case "deactivate":
                await this.#deactivate();
                this.#terminated = true;
                return null;
            default:
                throw new Error(`Unknown trusted-native Host request method: ${method}`);
        }
    }
    async terminate() {
        await this.request("deactivate");
    }
    forceTerminate() {
        this.#controller?.abort("Trusted-native Host entrypoint force-disabled");
        this.#terminated = true;
    }
    #load(modulePath) {
        if (!modulePath)
            throw new Error("Trusted-native Host module path is required");
        if (this.#moduleValue === undefined || this.#modulePath !== modulePath) {
            this.#modulePath = modulePath;
            this.#moduleValue = createRequire(modulePath)(modulePath);
        }
        return resolveExtension(this.#moduleValue);
    }
    async #deactivate() {
        this.#controller?.abort("Trusted-native Host entrypoint deactivated");
        this.#controller = null;
        this.#serviceHandlers.clear();
        const errors = [];
        while (this.#disposers.length > 0) {
            const disposer = this.#disposers.pop();
            try {
                await disposer?.();
            }
            catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (errors.length > 0)
            throw new Error(`Trusted-native Host cleanup failed: ${errors.join("; ")}`);
    }
}
//# sourceMappingURL=native-host-transport.js.map