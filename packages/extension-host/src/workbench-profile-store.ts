import {
  PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
  defaultPiariumWorkbenchProfileDocument,
  parsePiariumWorkbenchLayoutUpdateRequest,
  parsePiariumWorkbenchProfileRemoveRequest,
  parsePiariumWorkbenchProfileSelectionRequest,
  parsePiariumWorkbenchProfileUpsertRequest,
  type JsonObject,
  type PiariumWorkbenchLayoutLayer,
  type PiariumWorkbenchLayoutUpdateRequest,
  type PiariumWorkbenchProfileDocument,
  type PiariumWorkbenchProfileRemoveRequest,
  type PiariumWorkbenchProfileSelectionRequest,
  type PiariumWorkbenchProfileSnapshot,
  type PiariumWorkbenchProfileUpsertRequest,
  workbenchDocumentFromStorage,
} from "@piarium/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";

const ADDRESS = {
  extensionId: "piarium.core.workbench",
  key: "profiles",
  scope: "application",
} as const;

const layerKey = (layer: PiariumWorkbenchLayoutLayer): string => (
  `${layer.profileId}\0${layer.surface}\0${layer.scope}\0${layer.scopeId}`
);

const dataFromDocument = (document: PiariumWorkbenchProfileDocument): JsonObject => ({
  activeProfileId: document.activeProfileId,
  layouts: structuredClone(document.layouts) as unknown as JsonObject["layouts"],
  profileSelections: structuredClone(document.profileSelections) as unknown as JsonObject["profileSelections"],
  profiles: structuredClone(document.profiles) as unknown as JsonObject["profiles"],
});

export class WorkbenchProfileStore {
  readonly hostId: string;
  readonly storage: ExtensionStorageStore;
  #lastValid: PiariumWorkbenchProfileDocument | null = null;

  constructor(options: { hostId: string; storage: ExtensionStorageStore }) {
    this.hostId = options.hostId;
    this.storage = options.storage;
  }

  async read(): Promise<PiariumWorkbenchProfileSnapshot> {
    try {
      const storage = await this.storage.read(ADDRESS);
      const document = workbenchDocumentFromStorage(storage);
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
          code: "workbench_profile_read_failed",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          timestamp: new Date().toISOString(),
        }],
        document: structuredClone(this.#lastValid ?? defaultPiariumWorkbenchProfileDocument()),
        hostId: this.hostId,
        storageState: "stale",
      };
    }
  }

  updateLayout(requestValue: PiariumWorkbenchLayoutUpdateRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot> {
    const request = parsePiariumWorkbenchLayoutUpdateRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      if (!document.profiles.some((profile) => profile.id === request.layer.profileId)) {
        throw new Error(`Workbench profile is not installed: ${request.layer.profileId}`);
      }
      const key = layerKey(request.layer);
      const index = document.layouts.findIndex((layer) => layerKey(layer) === key);
      if (index === -1) document.layouts.push(request.layer);
      else document.layouts[index] = request.layer;
    });
  }

  selectProfile(requestValue: PiariumWorkbenchProfileSelectionRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot> {
    const request = parsePiariumWorkbenchProfileSelectionRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      if (!document.profiles.some((profile) => profile.id === request.profileId)) {
        throw new Error(`Workbench profile is not installed: ${request.profileId}`);
      }
      if (request.scope === "application") document.activeProfileId = request.profileId;
      else if (request.scope === "user") document.profileSelections.users[request.scopeId as string] = request.profileId;
      else document.profileSelections.workspaces[request.scopeId as string] = request.profileId;
    });
  }

  upsertProfile(requestValue: PiariumWorkbenchProfileUpsertRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot> {
    const request = parsePiariumWorkbenchProfileUpsertRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      const index = document.profiles.findIndex((profile) => profile.id === request.profile.id);
      if (index === -1) document.profiles.push(request.profile);
      else document.profiles[index] = request.profile;
    });
  }

  removeProfile(requestValue: PiariumWorkbenchProfileRemoveRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot> {
    const request = parsePiariumWorkbenchProfileRemoveRequest(requestValue);
    return this.#mutate(request.expectedRevision, (document) => {
      if (document.profiles.length === 1) throw new Error("The last workbench profile cannot be removed");
      if (!document.profiles.some((profile) => profile.id === request.profileId)) return;
      document.profiles = document.profiles.filter((profile) => profile.id !== request.profileId);
      document.layouts = document.layouts.filter((layer) => layer.profileId !== request.profileId);
      if (document.activeProfileId === request.profileId) document.activeProfileId = document.profiles[0]?.id ?? "default";
      for (const [scopeId, selected] of Object.entries(document.profileSelections.users)) {
        if (selected === request.profileId) delete document.profileSelections.users[scopeId];
      }
      for (const [scopeId, selected] of Object.entries(document.profileSelections.workspaces)) {
        if (selected === request.profileId) delete document.profileSelections.workspaces[scopeId];
      }
    });
  }

  async #mutate(
    expectedRevision: number,
    mutate: (document: PiariumWorkbenchProfileDocument) => void,
  ): Promise<PiariumWorkbenchProfileSnapshot> {
    const current = await this.read();
    if (!current.authoritative) throw new Error("Cannot update stale workbench profile state");
    const document = structuredClone(current.document);
    mutate(document);
    const storage = await this.storage.update(
      ADDRESS,
      expectedRevision,
      PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
      dataFromDocument(document),
    );
    const next = {
      authoritative: storage.authoritative,
      diagnostics: storage.diagnostics,
      document: workbenchDocumentFromStorage(storage),
      hostId: this.hostId,
      storageState: storage.storageState,
    } satisfies PiariumWorkbenchProfileSnapshot;
    if (next.authoritative) this.#lastValid = structuredClone(next.document);
    return next;
  }
}

export const emptyWorkbenchProfileDocument = defaultPiariumWorkbenchProfileDocument;
