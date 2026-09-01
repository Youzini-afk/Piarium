import { PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION, } from "@piarium/extension-contract";
import { ExtensionCatalogStaleStateError } from "./errors.js";
import { ExtensionCatalogStore } from "./catalog-store.js";
function actualKey(extensionId, state) {
    return `${extensionId}\0${state.realmKind}\0${state.realmId}\0${state.entrypointId}`;
}
export class ApplicationExtensionCatalog {
    store;
    #actual = new Map();
    constructor(options) {
        this.store = options.store ?? new ExtensionCatalogStore(options.dataDir);
    }
    async snapshot() {
        const [identity, read] = await Promise.all([this.store.getHostIdentity(), this.store.read()]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async upsert(record, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.upsert(record, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async remove(extensionId, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.remove(extensionId, expectedRevision),
        ]);
        for (const [key, value] of this.#actual)
            if (value.extensionId === extensionId)
                this.#actual.delete(key);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async setEnabled(extensionId, enabled, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.setEnabled(extensionId, enabled, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async setAllEnabled(enabled, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.setAllEnabled(enabled, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async setEnabledSet(extensionIds, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.setEnabledSet(extensionIds, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async reconcileBuiltins(definitions, ownedPrefix) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.reconcileBuiltins(definitions, ownedPrefix),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async setCapabilityGrant(extensionId, grant, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.setCapabilityGrant(extensionId, grant, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async reviewCapabilities(request) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.reviewCapabilities(request.extensionId, request.decisions, request.expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async stageCandidate(candidate, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.stageCandidate(candidate, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async selectBuiltinArtifact(candidate) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.selectBuiltinArtifact(candidate),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async reviewCandidateCapabilities(request) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.reviewCandidateCapabilities(request.extensionId, request.candidateIntegrity, request.decisions, request.expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async selectCandidate(extensionId, candidateIntegrity, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.selectCandidate(extensionId, candidateIntegrity, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async requestCandidateApplication(extensionId, candidateIntegrity, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.requestCandidateApplication(extensionId, candidateIntegrity, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async discardCandidate(extensionId, candidateIntegrity, expectedRevision) {
        const [identity, read] = await Promise.all([
            this.store.getHostIdentity(),
            this.store.discardCandidate(extensionId, candidateIntegrity, expectedRevision),
        ]);
        return this.#publicSnapshot(identity.hostId, read);
    }
    async reportActualState(extensionId, state) {
        const snapshot = await this.snapshot();
        if (state.hostId !== snapshot.hostId)
            throw new ExtensionCatalogStaleStateError("Actual state belongs to another application host");
        const entry = snapshot.extensions.find((item) => item.manifest.id === extensionId);
        if (!entry)
            throw new ExtensionCatalogStaleStateError(`Actual state belongs to an uninstalled extension: ${extensionId}`);
        if (state.desiredRevision !== entry.desired.revision) {
            throw new ExtensionCatalogStaleStateError(`Actual state desired revision ${state.desiredRevision} is stale; current revision is ${entry.desired.revision}`);
        }
        const key = actualKey(extensionId, state);
        const previous = this.#actual.get(key)?.state;
        if (previous && state.generation < previous.generation) {
            throw new ExtensionCatalogStaleStateError(`Actual state generation ${state.generation} is stale; current generation is ${previous.generation}`);
        }
        this.#actual.set(key, { extensionId, state: structuredClone(state) });
    }
    #publicSnapshot(hostId, read) {
        const extensions = Object.values(read.document.extensions)
            .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
            .map((record) => {
            const actual = [...this.#actual.values()]
                .filter((value) => (value.extensionId === record.manifest.id
                && value.state.hostId === hostId
                && value.state.desiredRevision === record.desired.revision))
                .map((value) => structuredClone(value.state))
                .sort((left, right) => left.realmId.localeCompare(right.realmId) || left.entrypointId.localeCompare(right.entrypointId));
            return {
                actual,
                ...(record.candidate ? {
                    candidate: {
                        applyRequested: record.candidate.applyRequested,
                        capabilitiesReviewed: record.candidate.capabilitiesReviewed,
                        capabilityDelta: structuredClone(record.candidate.capabilityDelta),
                        capabilityGrants: structuredClone(record.candidate.capabilityGrants),
                        integrity: record.candidate.integrity,
                        manifest: structuredClone(record.candidate.manifest),
                        preparedAt: record.candidate.preparedAt,
                        resolvedVersion: record.candidate.resolvedVersion,
                        source: {
                            display: record.candidate.source.display,
                            kind: record.candidate.source.kind,
                        },
                    },
                } : {}),
                capabilityGrants: structuredClone(record.capabilityGrants),
                desired: structuredClone(record.desired),
                installedAt: record.installedAt,
                manifest: structuredClone(record.manifest),
                resolvedVersion: record.resolvedVersion,
                selectedVersion: record.selectedVersion,
                source: { display: record.source.display, kind: record.source.kind },
                updatedAt: record.updatedAt,
                ...(record.integrity ? { integrity: record.integrity } : {}),
            };
        });
        return {
            authoritative: read.authoritative,
            diagnostics: structuredClone(read.diagnostics),
            extensions,
            hostId,
            loadedAt: new Date().toISOString(),
            revision: read.document.revision,
            schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
            storageState: read.storageState,
        };
    }
}
//# sourceMappingURL=application-catalog.js.map