import { PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION, defaultPiariumWorkbenchProfileDocument, migratePiariumWorkbenchProfileDocument, parsePiariumWorkbenchLayoutUpdateRequest, parsePiariumWorkbenchProfileRemoveRequest, parsePiariumWorkbenchProfileSelectionRequest, parsePiariumWorkbenchProfileUpsertRequest, workbenchDocumentFromStorage, } from "@piarium/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";
const ADDRESS = {
    extensionId: "piarium.core.workbench",
    key: "profiles",
    scope: "application",
};
const layerKey = (layer) => (`${layer.profileId}\0${layer.surface}\0${layer.scope}\0${layer.scopeId}`);
const dataFromDocument = (document) => ({
    activeProfileId: document.activeProfileId,
    layouts: structuredClone(document.layouts),
    profileSelections: structuredClone(document.profileSelections),
    profiles: structuredClone(document.profiles),
});
export class WorkbenchProfileStore {
    hostId;
    storage;
    #lastValid = null;
    #resolveWorkspaceScopeId = null;
    constructor(options) {
        this.hostId = options.hostId;
        this.storage = options.storage;
    }
    setWorkspaceScopeResolver(resolver) {
        this.#resolveWorkspaceScopeId = resolver;
    }
    async read() {
        const snapshot = await this.#load();
        if (!snapshot.authoritative)
            return snapshot;
        const document = structuredClone(snapshot.document);
        const workspaceChanged = await this.#migrateWorkspaceScopes(document);
        const agentChanged = migratePiariumWorkbenchProfileDocument(document);
        if (!workspaceChanged && !agentChanged)
            return snapshot;
        return this.#persist(document, snapshot.document.revision);
    }
    async #load() {
        try {
            const storage = await this.storage.read(ADDRESS);
            const document = workbenchDocumentFromStorage(storage);
            if (storage.authoritative)
                this.#lastValid = structuredClone(document);
            return {
                authoritative: storage.authoritative,
                diagnostics: storage.diagnostics,
                document,
                hostId: this.hostId,
                storageState: storage.storageState,
            };
        }
        catch (error) {
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
    updateLayout(requestValue) {
        const request = parsePiariumWorkbenchLayoutUpdateRequest(requestValue);
        return this.#mutate(request.expectedRevision, async (document) => {
            if (!document.profiles.some((profile) => profile.id === request.layer.profileId)) {
                throw new Error(`Workbench profile is not installed: ${request.layer.profileId}`);
            }
            const layer = request.layer.scope === "workspace"
                ? { ...request.layer, scopeId: await this.#canonicalScopeId(request.layer.scopeId) }
                : request.layer;
            const key = layerKey(layer);
            const index = document.layouts.findIndex((candidate) => layerKey(candidate) === key);
            if (index === -1)
                document.layouts.push(layer);
            else
                document.layouts[index] = layer;
        });
    }
    selectProfile(requestValue) {
        const request = parsePiariumWorkbenchProfileSelectionRequest(requestValue);
        return this.#mutate(request.expectedRevision, async (document) => {
            if (!document.profiles.some((profile) => profile.id === request.profileId)) {
                throw new Error(`Workbench profile is not installed: ${request.profileId}`);
            }
            if (request.scope === "application")
                document.activeProfileId = request.profileId;
            else if (request.scope === "user")
                document.profileSelections.users[request.scopeId] = request.profileId;
            else {
                const scopeId = await this.#canonicalScopeId(request.scopeId);
                document.profileSelections.workspaces[scopeId] = request.profileId;
            }
        });
    }
    upsertProfile(requestValue) {
        const request = parsePiariumWorkbenchProfileUpsertRequest(requestValue);
        return this.#mutate(request.expectedRevision, (document) => {
            const index = document.profiles.findIndex((profile) => profile.id === request.profile.id);
            if (index === -1)
                document.profiles.push(request.profile);
            else
                document.profiles[index] = request.profile;
        });
    }
    removeProfile(requestValue) {
        const request = parsePiariumWorkbenchProfileRemoveRequest(requestValue);
        return this.#mutate(request.expectedRevision, (document) => {
            if (document.profiles.length === 1)
                throw new Error("The last workbench profile cannot be removed");
            if (!document.profiles.some((profile) => profile.id === request.profileId))
                return;
            document.profiles = document.profiles.filter((profile) => profile.id !== request.profileId);
            document.layouts = document.layouts.filter((layer) => layer.profileId !== request.profileId);
            if (document.activeProfileId === request.profileId)
                document.activeProfileId = document.profiles[0]?.id ?? "default";
            for (const [scopeId, selected] of Object.entries(document.profileSelections.users)) {
                if (selected === request.profileId)
                    delete document.profileSelections.users[scopeId];
            }
            for (const [scopeId, selected] of Object.entries(document.profileSelections.workspaces)) {
                if (selected === request.profileId)
                    delete document.profileSelections.workspaces[scopeId];
            }
        });
    }
    async #canonicalScopeId(scopeId) {
        if (!this.#resolveWorkspaceScopeId)
            return scopeId;
        return await this.#resolveWorkspaceScopeId(scopeId) ?? scopeId;
    }
    async #migrateWorkspaceScopes(document) {
        if (!this.#resolveWorkspaceScopeId)
            return false;
        let changed = false;
        const workspaces = {};
        for (const [scopeId, profileId] of Object.entries(document.profileSelections.workspaces)) {
            const canonical = await this.#canonicalScopeId(scopeId);
            if (canonical !== scopeId)
                changed = true;
            workspaces[canonical] = profileId;
        }
        document.profileSelections.workspaces = workspaces;
        const layouts = [];
        for (const layer of document.layouts) {
            if (layer.scope !== "workspace") {
                layouts.push(layer);
                continue;
            }
            const scopeId = await this.#canonicalScopeId(layer.scopeId);
            if (scopeId !== layer.scopeId)
                changed = true;
            layouts.push(scopeId === layer.scopeId ? layer : { ...layer, scopeId });
        }
        document.layouts = layouts;
        return changed;
    }
    async #persist(document, expectedRevision) {
        const storage = await this.storage.update(ADDRESS, expectedRevision, PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION, dataFromDocument(document));
        const next = {
            authoritative: storage.authoritative,
            diagnostics: storage.diagnostics,
            document: workbenchDocumentFromStorage(storage),
            hostId: this.hostId,
            storageState: storage.storageState,
        };
        if (next.authoritative)
            this.#lastValid = structuredClone(next.document);
        return next;
    }
    async #mutate(expectedRevision, mutate) {
        const current = await this.#load();
        if (!current.authoritative)
            throw new Error("Cannot update stale workbench profile state");
        const document = structuredClone(current.document);
        await this.#migrateWorkspaceScopes(document);
        migratePiariumWorkbenchProfileDocument(document);
        await mutate(document);
        return this.#persist(document, expectedRevision);
    }
}
export const emptyWorkbenchProfileDocument = defaultPiariumWorkbenchProfileDocument;
//# sourceMappingURL=workbench-profile-store.js.map