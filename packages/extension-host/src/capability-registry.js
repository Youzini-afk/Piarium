import { isPiariumExtensionId, } from "@piarium/extension-contract";
export class HostCapabilityRegistry {
    #handlers = new Map();
    register(capability, handler) {
        if (!isPiariumExtensionId(capability))
            throw new Error(`Invalid Host capability ID: ${capability}`);
        if (this.#handlers.has(capability))
            throw new Error(`Host capability is already registered: ${capability}`);
        this.#handlers.set(capability, handler);
        return () => { if (this.#handlers.get(capability) === handler)
            this.#handlers.delete(capability); };
    }
    invoke(owner, grants, capability, method, params, signal) {
        const granted = grants.some((grant) => (grant.realm === "host"
            && grant.granted
            && grant.capability === capability
            && grant.manifestVersion === owner.extensionVersion));
        if (!granted)
            throw new Error(`Host capability is not granted: ${capability}`);
        const handler = this.#handlers.get(capability);
        if (!handler)
            throw new Error(`Host capability is unavailable: ${capability}`);
        return Promise.resolve(handler(method, params, { owner, signal }));
    }
}
//# sourceMappingURL=capability-registry.js.map