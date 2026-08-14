import {
  isPiariumExtensionId,
  type JsonValue,
  type PiariumExtensionCapabilityGrant,
} from "@piarium/extension-contract";
import type { HostServiceOwnerIdentity } from "./service-registry.js";

export interface HostCapabilityCallContext {
  owner: HostServiceOwnerIdentity;
  signal: AbortSignal;
}

export type HostCapabilityHandler = (
  method: string,
  params: JsonValue,
  context: HostCapabilityCallContext,
) => JsonValue | Promise<JsonValue>;

export class HostCapabilityRegistry {
  readonly #handlers = new Map<string, HostCapabilityHandler>();

  register(capability: string, handler: HostCapabilityHandler): () => void {
    if (!isPiariumExtensionId(capability)) throw new Error(`Invalid Host capability ID: ${capability}`);
    if (this.#handlers.has(capability)) throw new Error(`Host capability is already registered: ${capability}`);
    this.#handlers.set(capability, handler);
    return () => { if (this.#handlers.get(capability) === handler) this.#handlers.delete(capability); };
  }

  invoke(
    owner: HostServiceOwnerIdentity,
    grants: readonly PiariumExtensionCapabilityGrant[],
    capability: string,
    method: string,
    params: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const granted = grants.some((grant) => (
      grant.realm === "host"
      && grant.granted
      && grant.capability === capability
      && grant.manifestVersion === owner.extensionVersion
    ));
    if (!granted) throw new Error(`Host capability is not granted: ${capability}`);
    const handler = this.#handlers.get(capability);
    if (!handler) throw new Error(`Host capability is unavailable: ${capability}`);
    return Promise.resolve(handler(method, params, { owner, signal }));
  }
}
