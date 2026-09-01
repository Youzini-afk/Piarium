import { isPiariumExtensionId, parsePiariumExtensionServiceInvocationRequest, } from "@piarium/extension-contract";
const ownerKey = (owner) => `${owner.extensionId}\0${owner.entrypointId}`;
const exactOwnerKey = (owner) => `${ownerKey(owner)}\0${owner.generation}`;
const serviceKey = (id, version) => `${id}@${version}`;
const validateDescriptor = (descriptor) => {
    if (!isPiariumExtensionId(descriptor.id))
        throw new Error(`Invalid Host service ID: ${descriptor.id}`);
    if (!Number.isSafeInteger(descriptor.version) || descriptor.version <= 0)
        throw new Error(`Invalid Host service version: ${descriptor.id}`);
    if (descriptor.multiple !== undefined && typeof descriptor.multiple !== "boolean")
        throw new Error(`Invalid Host service multiplicity: ${descriptor.id}`);
    return {
        id: descriptor.id,
        version: descriptor.version,
        ...(descriptor.multiple !== undefined ? { multiple: descriptor.multiple } : {}),
    };
};
const assertJsonValue = (value, path = "result") => {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (Array.isArray(value))
        return value.map((item, index) => assertJsonValue(item, `${path}[${index}]`));
    if (typeof value === "object" && value !== null) {
        const result = {};
        for (const [key, item] of Object.entries(value))
            result[key] = assertJsonValue(item, `${path}.${key}`);
        return result;
    }
    throw new Error(`${path} is not JSON-safe`);
};
export class HostServiceRegistry {
    hostId;
    #listeners = new Set();
    #providers = new Map();
    #selections = new Map();
    #revision = 0;
    constructor(hostId) {
        this.hostId = hostId;
    }
    getSnapshot = () => ({
        hostId: this.hostId,
        providers: [...this.#providers.values()]
            .map((provider) => ({
            descriptor: { ...provider.descriptor },
            entrypointId: provider.owner.entrypointId,
            extensionId: provider.owner.extensionId,
            extensionVersion: provider.owner.extensionVersion,
            generation: provider.owner.generation,
            providerId: provider.providerId,
            providerKey: provider.providerKey,
            status: provider.status,
        }))
            .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id)
            || left.descriptor.version - right.descriptor.version
            || left.providerId.localeCompare(right.providerId)),
        revision: this.#revision,
        selections: Object.fromEntries(this.#selections),
    });
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    prepareOwnerReplacement(owner, provisions) {
        const normalized = this.#normalizeProvisions(provisions);
        this.#validateReplacement(owner, normalized);
        let committed = false;
        let finalized = false;
        let previousProviders = [];
        let nextProviders = [];
        let previousSelections = new Map();
        return {
            commit: () => {
                if (committed)
                    return;
                this.#validateReplacement(owner, normalized);
                previousProviders = [...this.#providers.values()].filter((provider) => ownerKey(provider.owner) === ownerKey(owner));
                previousSelections = new Map(this.#selections);
                for (const provider of previousProviders)
                    provider.status = "draining";
                nextProviders = normalized.map((provision) => this.#createProvider(owner, provision));
                for (const provider of nextProviders)
                    this.#providers.set(provider.providerId, provider);
                for (const previous of previousProviders) {
                    const key = serviceKey(previous.descriptor.id, previous.descriptor.version);
                    if (this.#selections.get(key) !== previous.providerId)
                        continue;
                    const replacement = nextProviders.find((provider) => serviceKey(provider.descriptor.id, provider.descriptor.version) === key);
                    if (replacement)
                        this.#selections.set(key, replacement.providerId);
                    else
                        this.#selections.delete(key);
                }
                committed = true;
                this.#publish();
            },
            finalize: async () => {
                if (!committed || finalized)
                    return;
                await this.#waitForProviders(previousProviders);
                for (const provider of previousProviders)
                    this.#providers.delete(provider.providerId);
                finalized = true;
                if (previousProviders.length > 0)
                    this.#publish();
            },
            rollback: async () => {
                if (!committed || finalized)
                    return;
                for (const provider of nextProviders)
                    provider.status = "draining";
                this.#publish();
                await this.#waitForProviders(nextProviders);
                for (const provider of nextProviders)
                    this.#providers.delete(provider.providerId);
                for (const provider of previousProviders) {
                    provider.status = "active";
                    this.#providers.set(provider.providerId, provider);
                }
                this.#selections.clear();
                for (const [key, providerId] of previousSelections)
                    this.#selections.set(key, providerId);
                committed = false;
                this.#publish();
            },
        };
    }
    async replaceOwner(owner, provisions) {
        const replacement = this.prepareOwnerReplacement(owner, provisions);
        replacement.commit();
        await replacement.finalize();
    }
    #normalizeProvisions(provisions) {
        const normalized = provisions.map((provision) => ({
            descriptor: validateDescriptor(provision.descriptor),
            handler: provision.handler,
        }));
        const ownKeys = new Set();
        for (const provision of normalized) {
            const key = serviceKey(provision.descriptor.id, provision.descriptor.version);
            if (ownKeys.has(key))
                throw new Error(`Host owner provides a service more than once: ${key}`);
            ownKeys.add(key);
        }
        return normalized;
    }
    #validateReplacement(owner, provisions) {
        const otherProviders = [...this.#providers.values()].filter((provider) => (ownerKey(provider.owner) !== ownerKey(owner) && provider.status === "active"));
        for (const provision of provisions) {
            const key = serviceKey(provision.descriptor.id, provision.descriptor.version);
            const existing = otherProviders.filter((provider) => serviceKey(provider.descriptor.id, provider.descriptor.version) === key);
            if (existing.length > 0 && (provision.descriptor.multiple !== true || existing.some((provider) => provider.descriptor.multiple !== true))) {
                throw new Error(`Host service ${key} does not allow multiple providers`);
            }
        }
    }
    #createProvider(owner, provision) {
        const providerId = `${owner.extensionId}:${owner.entrypointId}:${owner.generation}:${serviceKey(provision.descriptor.id, provision.descriptor.version)}`;
        const providerKey = `${owner.extensionId}:${owner.entrypointId}:${serviceKey(provision.descriptor.id, provision.descriptor.version)}`;
        return {
            descriptor: provision.descriptor,
            handler: provision.handler,
            inFlight: 0,
            onDrained: [],
            owner: { ...owner },
            providerId,
            providerKey,
            status: "active",
        };
    }
    async #waitForProviders(providers) {
        await Promise.all(providers.map((provider) => provider.inFlight === 0
            ? Promise.resolve()
            : new Promise((resolveDrain) => provider.onDrained.push(resolveDrain))));
    }
    async drainOwner(owner) {
        const providers = [...this.#providers.values()].filter((provider) => exactOwnerKey(provider.owner) === exactOwnerKey(owner));
        let changed = false;
        for (const provider of providers) {
            if (provider.status !== "draining") {
                provider.status = "draining";
                changed = true;
            }
        }
        if (changed)
            this.#publish();
        await this.#waitForProviders(providers);
    }
    removeOwner(owner) {
        let changed = false;
        const removed = new Set();
        for (const [providerId, provider] of [...this.#providers]) {
            if (exactOwnerKey(provider.owner) !== exactOwnerKey(owner))
                continue;
            this.#providers.delete(providerId);
            removed.add(providerId);
            changed = true;
        }
        for (const [key, providerId] of [...this.#selections]) {
            if (removed.has(providerId))
                this.#selections.delete(key);
        }
        if (changed)
            this.#publish();
    }
    setSelection(id, version, providerId) {
        if (!isPiariumExtensionId(id) || !Number.isSafeInteger(version) || version <= 0) {
            throw new Error(`Invalid Host service selection: ${id}@${version}`);
        }
        const key = serviceKey(id, version);
        if (providerId === null)
            this.#selections.delete(key);
        else {
            const provider = this.#providers.get(providerId);
            if (!provider || serviceKey(provider.descriptor.id, provider.descriptor.version) !== key) {
                throw new Error(`Selected Host service provider is unavailable: ${providerId}`);
            }
            this.#selections.set(key, providerId);
        }
        this.#publish();
    }
    providersFor(requirement) {
        const matches = this.getSnapshot().providers.filter((provider) => (provider.status === "active"
            && provider.descriptor.id === requirement.id
            && provider.descriptor.version === requirement.version));
        if (requirement.binding === "all")
            return matches;
        if (requirement.binding === "selected") {
            const selected = this.#selections.get(serviceKey(requirement.id, requirement.version));
            return selected ? matches.filter((provider) => provider.providerId === selected) : [];
        }
        return matches.length === 1 ? matches : [];
    }
    async invoke(requestValue, signal) {
        const request = parsePiariumExtensionServiceInvocationRequest(requestValue);
        const matches = [...this.#providers.values()].filter((provider) => (provider.status === "active"
            && provider.descriptor.id === request.serviceId
            && provider.descriptor.version === request.version
            && (!request.providerId || provider.providerId === request.providerId)));
        let provider;
        if (request.providerId)
            provider = matches[0];
        else {
            const selected = this.#selections.get(serviceKey(request.serviceId, request.version));
            provider = selected ? matches.find((candidate) => candidate.providerId === selected) : matches.length === 1 ? matches[0] : undefined;
        }
        if (!provider)
            throw new Error(`Host service provider is unavailable or ambiguous: ${serviceKey(request.serviceId, request.version)}`);
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        if (signal?.aborted)
            abort();
        else
            signal?.addEventListener("abort", abort, { once: true });
        provider.inFlight += 1;
        try {
            return assertJsonValue(await provider.handler(request.method, request.args, { signal: controller.signal }));
        }
        finally {
            signal?.removeEventListener("abort", abort);
            provider.inFlight -= 1;
            if (provider.inFlight === 0) {
                for (const resolveDrain of provider.onDrained.splice(0))
                    resolveDrain();
            }
        }
    }
    #publish() {
        this.#revision += 1;
        for (const listener of this.#listeners)
            listener();
    }
}
//# sourceMappingURL=service-registry.js.map