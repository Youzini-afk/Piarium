import {
  PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
  defaultPiariumExtensionServiceRoutingDocument,
  parsePiariumExtensionServiceRoutingRuleRemoveRequest,
  parsePiariumExtensionServiceRoutingRuleUpdateRequest,
  serviceRoutingDocumentFromStorage,
  serviceRoutingRuleKey,
  type JsonObject,
  type PiariumExtensionServiceRoutingDocument,
  type PiariumExtensionServiceRoutingRuleRemoveRequest,
  type PiariumExtensionServiceRoutingRuleUpdateRequest,
  type PiariumExtensionServiceRoutingSnapshot,
} from "@piarium/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";

const ADDRESS = {
  extensionId: "piarium.core.service-routing",
  key: "rules",
  scope: "application",
} as const;

const dataFromDocument = (document: PiariumExtensionServiceRoutingDocument): JsonObject => ({
  rules: structuredClone(document.rules) as unknown as JsonObject["rules"],
});

export class ServiceRoutingStore {
  readonly hostId: string;
  readonly storage: ExtensionStorageStore;
  #lastValid: PiariumExtensionServiceRoutingDocument | null = null;

  constructor(options: { hostId: string; storage: ExtensionStorageStore }) {
    this.hostId = options.hostId;
    this.storage = options.storage;
  }

  async read(): Promise<PiariumExtensionServiceRoutingSnapshot> {
    try {
      const storage = await this.storage.read(ADDRESS);
      const document = serviceRoutingDocumentFromStorage(storage);
      if (storage.authoritative) this.#lastValid = structuredClone(document);
      return {
        authoritative: storage.authoritative,
        diagnostics: storage.diagnostics,
        document,
        hostId: this.hostId,
        storageState: storage.storageState,
      };
    } catch (error) {
      return {
        authoritative: false,
        diagnostics: [{
          code: "service_routing_read_failed",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          timestamp: new Date().toISOString(),
        }],
        document: structuredClone(this.#lastValid ?? defaultPiariumExtensionServiceRoutingDocument()),
        hostId: this.hostId,
        storageState: "stale",
      };
    }
  }

  upsertRule(
    requestValue: PiariumExtensionServiceRoutingRuleUpdateRequest | unknown,
  ): Promise<PiariumExtensionServiceRoutingSnapshot> {
    const request = parsePiariumExtensionServiceRoutingRuleUpdateRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      const key = serviceRoutingRuleKey(request.rule);
      const index = document.rules.findIndex((rule) => serviceRoutingRuleKey(rule) === key);
      if (index === -1) document.rules.push(request.rule);
      else document.rules[index] = request.rule;
    });
  }

  removeRule(
    requestValue: PiariumExtensionServiceRoutingRuleRemoveRequest | unknown,
  ): Promise<PiariumExtensionServiceRoutingSnapshot> {
    const request = parsePiariumExtensionServiceRoutingRuleRemoveRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      const key = serviceRoutingRuleKey(request);
      document.rules = document.rules.filter((rule) => serviceRoutingRuleKey(rule) !== key);
    });
  }

  async #mutate(
    expectedRevision: number,
    mutate: (document: PiariumExtensionServiceRoutingDocument) => void,
  ): Promise<PiariumExtensionServiceRoutingSnapshot> {
    const current = await this.read();
    if (!current.authoritative) throw new Error("Cannot update stale service routing state");
    const document = structuredClone(current.document);
    mutate(document);
    const storage = await this.storage.update(
      ADDRESS,
      expectedRevision,
      PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION,
      dataFromDocument(document),
    );
    const next = {
      authoritative: storage.authoritative,
      diagnostics: storage.diagnostics,
      document: serviceRoutingDocumentFromStorage(storage),
      hostId: this.hostId,
      storageState: storage.storageState,
    } satisfies PiariumExtensionServiceRoutingSnapshot;
    if (next.authoritative) this.#lastValid = structuredClone(next.document);
    return next;
  }
}

export const emptyServiceRoutingDocument = defaultPiariumExtensionServiceRoutingDocument;
