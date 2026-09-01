import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION, PiariumExtensionContractError, parsePiariumExtensionManifest, parsePiariumExtensionCatalogDocument, parsePiariumExtensionHostIdentityDocument, parsePiariumExtensionInstallationRecord, } from "@piarium/extension-contract";
import { ExtensionCatalogRevisionConflictError, ExtensionCatalogStorageError, } from "./errors.js";
const LOCK_RETRY_MS = 25;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorCode(error) {
    return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
function processIsAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errorCode(error) === "EPERM";
    }
}
async function acquireLock(path) {
    for (;;) {
        let handle;
        try {
            handle = await open(path, "wx", 0o600);
        }
        catch (error) {
            if (errorCode(error) !== "EEXIST")
                throw error;
        }
        if (handle) {
            const token = randomUUID();
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
                await handle.sync();
                return async () => {
                    await handle.close();
                    try {
                        const owner = JSON.parse(await readFile(path, "utf8"));
                        if (isRecord(owner) && owner.token === token)
                            await rm(path, { force: true });
                    }
                    catch (error) {
                        if (errorCode(error) !== "ENOENT")
                            throw error;
                    }
                };
            }
            catch (error) {
                await handle.close().catch(() => undefined);
                await rm(path, { force: true }).catch(() => undefined);
                throw error;
            }
        }
        let removeAbandoned = false;
        try {
            const owner = JSON.parse(await readFile(path, "utf8"));
            removeAbandoned = !isRecord(owner) || !processIsAlive(Number(owner.pid));
        }
        catch (readError) {
            if (errorCode(readError) === "ENOENT")
                continue;
            try {
                const info = await stat(path);
                removeAbandoned = Date.now() - info.mtimeMs > 2_000;
            }
            catch (statError) {
                if (errorCode(statError) === "ENOENT")
                    continue;
                throw statError;
            }
        }
        if (removeAbandoned) {
            const abandoned = `${path}.abandoned.${process.pid}.${randomUUID()}`;
            try {
                await rename(path, abandoned);
            }
            catch (error) {
                if (errorCode(error) === "ENOENT")
                    continue;
                throw error;
            }
            await rm(abandoned, { force: true });
            continue;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
}
function emptyDocument() {
    return {
        extensions: {},
        revision: 0,
        schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
        updatedAt: new Date(0).toISOString(),
    };
}
function cloneDocument(document) {
    return structuredClone(document);
}
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        return `{${Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
            .join(",")}}`;
    }
    throw new Error("Piarium extension catalog contains a non-JSON value");
}
function fingerprint(document) {
    return createHash("sha256").update(canonicalJson(document)).digest("hex");
}
function diagnostic(code, message) {
    return { code, message, severity: "error", timestamp: new Date().toISOString() };
}
const capabilityKey = (value) => `${value.realm}:${value.capability}`;
function manifestCapabilities(manifest) {
    return ["host", "surface"].flatMap((realm) => ((manifest.capabilities?.[realm] ?? []).map((capability) => ({ capability, realm }))));
}
function builtinCapabilityGrants(manifest, updatedAt) {
    return manifestCapabilities(manifest).map((reference) => ({
        ...reference,
        granted: true,
        manifestVersion: manifest.version,
        updatedAt,
    }));
}
function sameCapabilityGrants(left, right) {
    const project = (values) => values
        .map(({ capability, granted, manifestVersion, realm }) => ({ capability, granted, manifestVersion, realm }))
        .sort((first, second) => capabilityKey(first).localeCompare(capabilityKey(second)));
    return JSON.stringify(project(left)) === JSON.stringify(project(right));
}
function rawCapabilityGrantsMatch(value, expected) {
    if (!Array.isArray(value))
        return false;
    const parsed = [];
    for (const item of value) {
        if (!isRecord(item)
            || typeof item.capability !== "string"
            || typeof item.granted !== "boolean"
            || typeof item.manifestVersion !== "string"
            || (item.realm !== "host" && item.realm !== "surface")
            || typeof item.updatedAt !== "string")
            return false;
        parsed.push({
            capability: item.capability,
            granted: item.granted,
            manifestVersion: item.manifestVersion,
            realm: item.realm,
            updatedAt: item.updatedAt,
        });
    }
    return sameCapabilityGrants(parsed, expected);
}
function repairKnownBuiltinRecords(value, manifests, ownedPrefix, now) {
    if (!isRecord(value) || !isRecord(value.extensions))
        return { changed: false, value };
    const extensions = { ...value.extensions };
    const desiredIds = new Set(manifests.map(({ manifest }) => manifest.id));
    let changed = false;
    for (const [extensionId, rawRecord] of Object.entries(extensions)) {
        if (!isRecord(rawRecord) || !isRecord(rawRecord.source))
            continue;
        if (rawRecord.source.kind === "builtin"
            && typeof rawRecord.source.specifier === "string"
            && rawRecord.source.specifier.startsWith(ownedPrefix)
            && !desiredIds.has(extensionId)) {
            delete extensions[extensionId];
            changed = true;
        }
    }
    for (const { manifest } of manifests) {
        const rawRecord = extensions[manifest.id];
        if (!isRecord(rawRecord) || !isRecord(rawRecord.source))
            continue;
        if (rawRecord.source.kind !== "builtin" || rawRecord.source.specifier !== manifest.id)
            continue;
        const nextRecord = structuredClone(rawRecord);
        const manifestChanged = rawRecord.manifest === undefined
            || canonicalJson(rawRecord.manifest) !== canonicalJson(manifest);
        const artifactVersionChanged = rawRecord.resolvedVersion !== manifest.version
            || rawRecord.selectedVersion !== manifest.version;
        nextRecord.manifest = structuredClone(manifest);
        nextRecord.resolvedVersion = manifest.version;
        nextRecord.selectedVersion = manifest.version;
        nextRecord.source = { display: "Piarium", kind: "builtin", specifier: manifest.id };
        const desiredGrants = builtinCapabilityGrants(manifest, typeof rawRecord.updatedAt === "string" ? rawRecord.updatedAt : now);
        if (!rawCapabilityGrantsMatch(rawRecord.capabilityGrants, desiredGrants)) {
            nextRecord.capabilityGrants = desiredGrants;
        }
        delete nextRecord.candidate;
        if (manifestChanged || artifactVersionChanged) {
            delete nextRecord.integrity;
            delete nextRecord.resolvedPath;
        }
        if (canonicalJson(rawRecord) === canonicalJson(nextRecord))
            continue;
        nextRecord.updatedAt = now;
        extensions[manifest.id] = nextRecord;
        changed = true;
    }
    return changed
        ? { changed, value: { ...value, extensions } }
        : { changed, value };
}
function capabilitiesReviewed(record) {
    if (record.source.kind === "builtin")
        return true;
    const decided = new Set(record.capabilityGrants
        .filter((grant) => grant.manifestVersion === record.manifest.version)
        .map(capabilityKey));
    return manifestCapabilities(record.manifest).every((reference) => decided.has(capabilityKey(reference)));
}
function assertCanEnable(record) {
    if (!capabilitiesReviewed(record)) {
        throw new Error(`Piarium extension capabilities require review before activation: ${record.manifest.id}`);
    }
}
async function atomicWrite(path, value) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
export class ExtensionCatalogStore {
    dataDir;
    directory;
    catalogPath;
    identityPath;
    #lockPath;
    #lastValid = null;
    #identity = null;
    #queue = Promise.resolve();
    constructor(dataDir) {
        this.dataDir = resolve(dataDir);
        this.directory = join(this.dataDir, "extensions");
        this.catalogPath = join(this.directory, "catalog.json");
        this.identityPath = join(this.directory, "identity.json");
        this.#lockPath = join(this.directory, ".catalog.lock");
    }
    getHostIdentity() {
        return this.#serialize(async () => this.#readOrCreateIdentity());
    }
    read() {
        return this.#serialize(async () => {
            await this.#readOrCreateIdentity();
            return this.#readPreservingAuthority();
        });
    }
    upsert(recordValue, expectedRevision) {
        const record = parsePiariumExtensionInstallationRecord(recordValue);
        return this.#mutate(expectedRevision, (document) => {
            document.extensions[record.manifest.id] = record;
            return true;
        });
    }
    remove(extensionId, expectedRevision) {
        return this.#mutate(expectedRevision, (document) => {
            if (!(extensionId in document.extensions))
                return false;
            delete document.extensions[extensionId];
            return true;
        });
    }
    setEnabled(extensionId, enabled, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            if (record.desired.enabled === enabled)
                return false;
            if (enabled)
                assertCanEnable(record);
            record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
            record.updatedAt = now;
            return true;
        });
    }
    setAllEnabled(enabled, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            let changed = false;
            for (const record of Object.values(document.extensions)) {
                if (record.desired.enabled === enabled)
                    continue;
                if (enabled)
                    assertCanEnable(record);
                record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
                record.updatedAt = now;
                changed = true;
            }
            return changed;
        });
    }
    setEnabledSet(extensionIds, expectedRevision) {
        const selected = new Set(extensionIds);
        return this.#mutate(expectedRevision, (document, now) => {
            let changed = false;
            for (const [extensionId, record] of Object.entries(document.extensions)) {
                const enabled = selected.has(extensionId);
                if (record.desired.enabled === enabled)
                    continue;
                if (enabled)
                    assertCanEnable(record);
                record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
                record.updatedAt = now;
                changed = true;
            }
            return changed;
        });
    }
    reconcileBuiltins(definitions, ownedPrefix) {
        const manifests = definitions.map((definition) => ({
            definition,
            manifest: parsePiariumExtensionManifest(definition.manifest),
        }));
        const desiredIds = new Set(manifests.map(({ manifest }) => manifest.id));
        return this.#mutateCurrent((document, now) => {
            let changed = false;
            for (const [extensionId, record] of Object.entries(document.extensions)) {
                if (record.source.kind === "builtin"
                    && record.source.specifier.startsWith(ownedPrefix)
                    && !desiredIds.has(extensionId)) {
                    delete document.extensions[extensionId];
                    changed = true;
                }
            }
            for (const { definition, manifest } of manifests) {
                const existing = document.extensions[manifest.id];
                if (!existing) {
                    document.extensions[manifest.id] = {
                        capabilityGrants: builtinCapabilityGrants(manifest, now),
                        desired: { enabled: definition.enabledByDefault, revision: 1, updatedAt: now },
                        installedAt: now,
                        manifest: structuredClone(manifest),
                        resolvedVersion: manifest.version,
                        selectedVersion: manifest.version,
                        source: { display: "Piarium", kind: "builtin", specifier: manifest.id },
                        updatedAt: now,
                    };
                    changed = true;
                    continue;
                }
                if (existing.source.kind !== "builtin" || existing.source.specifier !== manifest.id) {
                    throw new Error(`Piarium built-in extension ID is already owned by another source: ${manifest.id}`);
                }
                const nextManifest = JSON.stringify(manifest);
                const desiredGrants = builtinCapabilityGrants(manifest, now);
                if (JSON.stringify(existing.manifest) === nextManifest
                    && existing.resolvedVersion === manifest.version
                    && existing.selectedVersion === manifest.version
                    && existing.source.display === "Piarium"
                    && existing.candidate === undefined
                    && sameCapabilityGrants(existing.capabilityGrants, desiredGrants))
                    continue;
                const artifactVersionChanged = existing.resolvedVersion !== manifest.version
                    || existing.selectedVersion !== manifest.version;
                const manifestChanged = JSON.stringify(existing.manifest) !== nextManifest;
                existing.manifest = structuredClone(manifest);
                existing.resolvedVersion = manifest.version;
                existing.selectedVersion = manifest.version;
                existing.source = { display: "Piarium", kind: "builtin", specifier: manifest.id };
                existing.capabilityGrants = desiredGrants;
                delete existing.candidate;
                if (manifestChanged || artifactVersionChanged) {
                    delete existing.integrity;
                    delete existing.resolvedPath;
                }
                existing.updatedAt = now;
                changed = true;
            }
            return changed;
        }, (now) => this.#readForBuiltinReconciliation(manifests, ownedPrefix, now));
    }
    selectBuiltinArtifact(candidate) {
        return this.#mutateCurrent((document, now) => {
            const record = document.extensions[candidate.manifest.id];
            if (!record || record.source.kind !== "builtin" || record.source.specifier !== candidate.manifest.id) {
                throw new Error(`Piarium built-in extension is not reconciled: ${candidate.manifest.id}`);
            }
            if (candidate.source.kind !== "builtin" || candidate.source.specifier !== candidate.manifest.id) {
                throw new Error(`Piarium built-in artifact source is invalid: ${candidate.manifest.id}`);
            }
            if (JSON.stringify(record.manifest) !== JSON.stringify(candidate.manifest)) {
                throw new Error(`Piarium built-in artifact manifest does not match the distribution: ${candidate.manifest.id}`);
            }
            if (record.integrity === candidate.integrity
                && record.resolvedPath === candidate.resolvedPath
                && record.resolvedVersion === candidate.resolvedVersion
                && record.selectedVersion === candidate.resolvedVersion)
                return false;
            record.integrity = candidate.integrity;
            record.resolvedPath = candidate.resolvedPath;
            record.resolvedVersion = candidate.resolvedVersion;
            record.selectedVersion = candidate.resolvedVersion;
            record.updatedAt = now;
            return true;
        });
    }
    setCapabilityGrant(extensionId, grant, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            if ((grant.realm !== "host" && grant.realm !== "surface") || typeof grant.granted !== "boolean") {
                throw new Error("Capability grant realm and granted state are invalid");
            }
            if (grant.manifestVersion !== record.manifest.version) {
                throw new Error(`Capability grant version ${grant.manifestVersion} does not match installed manifest ${record.manifest.version}`);
            }
            const requested = record.manifest.capabilities?.[grant.realm] ?? [];
            if (!requested.includes(grant.capability)) {
                throw new Error(`Capability was not requested by ${extensionId}: ${grant.realm}:${grant.capability}`);
            }
            const next = { ...grant, updatedAt: now };
            const index = record.capabilityGrants.findIndex((item) => (item.capability === grant.capability && item.realm === grant.realm));
            if (index >= 0)
                record.capabilityGrants[index] = next;
            else
                record.capabilityGrants.push(next);
            record.updatedAt = now;
            return true;
        });
    }
    reviewCapabilities(extensionId, decisions, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            if (record.source.kind === "builtin") {
                throw new Error(`Built-in Piarium extensions are managed by the distribution: ${extensionId}`);
            }
            const requested = new Set(manifestCapabilities(record.manifest).map(capabilityKey));
            for (const decision of decisions) {
                const key = capabilityKey(decision);
                if (!requested.has(key))
                    throw new Error(`Capability was not requested by ${extensionId}: ${key}`);
                const next = {
                    ...decision,
                    manifestVersion: record.manifest.version,
                    updatedAt: now,
                };
                const index = record.capabilityGrants.findIndex((grant) => capabilityKey(grant) === key);
                if (index >= 0)
                    record.capabilityGrants[index] = next;
                else
                    record.capabilityGrants.push(next);
            }
            if (decisions.length > 0)
                record.updatedAt = now;
            return decisions.length > 0;
        });
    }
    stageCandidate(candidate, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[candidate.manifest.id];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${candidate.manifest.id}`);
            if (record.candidate?.integrity === candidate.integrity)
                return false;
            const selectedCapabilities = new Set(manifestCapabilities(record.manifest).map(capabilityKey));
            const candidateCapabilities = manifestCapabilities(candidate.manifest);
            const candidateKeys = new Set(candidateCapabilities.map(capabilityKey));
            const added = candidateCapabilities.filter((reference) => !selectedCapabilities.has(capabilityKey(reference)));
            const removed = manifestCapabilities(record.manifest).filter((reference) => !candidateKeys.has(capabilityKey(reference)));
            const capabilityGrants = record.capabilityGrants
                .filter((grant) => candidateKeys.has(capabilityKey(grant)))
                .map((grant) => ({ ...grant, manifestVersion: candidate.manifest.version, updatedAt: now }));
            record.candidate = {
                ...structuredClone(candidate),
                applyRequested: false,
                capabilitiesReviewed: added.length === 0,
                capabilityDelta: { added, removed },
                capabilityGrants,
            };
            record.updatedAt = now;
            return true;
        });
    }
    reviewCandidateCapabilities(extensionId, candidateIntegrity, decisions, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            const candidate = record.candidate;
            if (!candidate || candidate.integrity !== candidateIntegrity) {
                throw new Error(`Piarium extension candidate is no longer current: ${extensionId}`);
            }
            const added = new Set(candidate.capabilityDelta.added.map(capabilityKey));
            for (const decision of decisions) {
                const key = capabilityKey(decision);
                if (!added.has(key))
                    throw new Error(`Capability is not newly requested by the candidate: ${key}`);
                const next = {
                    capability: decision.capability,
                    granted: decision.granted,
                    manifestVersion: candidate.manifest.version,
                    realm: decision.realm,
                    updatedAt: now,
                };
                const index = candidate.capabilityGrants.findIndex((grant) => capabilityKey(grant) === key);
                if (index >= 0)
                    candidate.capabilityGrants[index] = next;
                else
                    candidate.capabilityGrants.push(next);
            }
            const decided = new Set(candidate.capabilityGrants.map(capabilityKey));
            candidate.capabilitiesReviewed = [...added].every((key) => decided.has(key));
            record.updatedAt = now;
            return decisions.length > 0;
        });
    }
    selectCandidate(extensionId, candidateIntegrity, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            const candidate = record.candidate;
            if (!candidate || candidate.integrity !== candidateIntegrity) {
                throw new Error(`Piarium extension candidate is no longer current: ${extensionId}`);
            }
            if (!candidate.capabilitiesReviewed) {
                throw new Error(`Piarium extension candidate capability changes require review: ${extensionId}`);
            }
            if (!candidate.applyRequested) {
                throw new Error(`Piarium extension candidate application was not requested: ${extensionId}`);
            }
            record.manifest = structuredClone(candidate.manifest);
            record.source = structuredClone(candidate.source);
            record.integrity = candidate.integrity;
            record.resolvedPath = candidate.resolvedPath;
            record.resolvedVersion = candidate.resolvedVersion;
            record.selectedVersion = candidate.resolvedVersion;
            record.capabilityGrants = structuredClone(candidate.capabilityGrants);
            delete record.candidate;
            record.updatedAt = now;
            return true;
        });
    }
    requestCandidateApplication(extensionId, candidateIntegrity, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            const candidate = record.candidate;
            if (!candidate || candidate.integrity !== candidateIntegrity) {
                throw new Error(`Piarium extension candidate is no longer current: ${extensionId}`);
            }
            if (!candidate.capabilitiesReviewed) {
                throw new Error(`Piarium extension candidate capability changes require review: ${extensionId}`);
            }
            if (candidate.applyRequested)
                return false;
            candidate.applyRequested = true;
            record.updatedAt = now;
            return true;
        });
    }
    discardCandidate(extensionId, candidateIntegrity, expectedRevision) {
        return this.#mutate(expectedRevision, (document, now) => {
            const record = document.extensions[extensionId];
            if (!record)
                throw new Error(`Piarium extension is not installed: ${extensionId}`);
            if (!record.candidate || record.candidate.integrity !== candidateIntegrity)
                return false;
            delete record.candidate;
            record.updatedAt = now;
            return true;
        });
    }
    async #mutate(expectedRevision, mutator) {
        return this.#serialize(async () => {
            await mkdir(this.directory, { mode: 0o700, recursive: true });
            await this.#readOrCreateIdentity();
            const release = await acquireLock(this.#lockPath);
            try {
                const strictRead = await this.#readStrictForMutation();
                const document = strictRead.document;
                if (document.revision !== expectedRevision) {
                    throw new ExtensionCatalogRevisionConflictError(expectedRevision, document.revision);
                }
                const now = new Date().toISOString();
                const changed = mutator(document, now);
                if (changed) {
                    document.revision += 1;
                    document.updatedAt = now;
                    await atomicWrite(this.catalogPath, document);
                }
                this.#lastValid = {
                    document: cloneDocument(document),
                    fingerprint: fingerprint(document),
                    storageState: strictRead.storageState === "ready" || changed ? "ready" : "missing",
                };
                return this.#stateFromLastValid();
            }
            finally {
                await release();
            }
        });
    }
    async #mutateCurrent(mutator, reader = () => this.#readStrictForMutation()) {
        return this.#serialize(async () => {
            await mkdir(this.directory, { mode: 0o700, recursive: true });
            await this.#readOrCreateIdentity();
            const release = await acquireLock(this.#lockPath);
            try {
                const now = new Date().toISOString();
                const strictRead = await reader(now);
                const document = strictRead.document;
                const mutated = mutator(document, now);
                const changed = strictRead.repaired === true || mutated;
                if (changed) {
                    document.revision += 1;
                    document.updatedAt = now;
                    await atomicWrite(this.catalogPath, document);
                }
                this.#lastValid = {
                    document: cloneDocument(document),
                    fingerprint: fingerprint(document),
                    storageState: strictRead.storageState === "ready" || changed ? "ready" : "missing",
                };
                return this.#stateFromLastValid();
            }
            finally {
                await release();
            }
        });
    }
    async #readOrCreateIdentity() {
        if (this.#identity)
            return this.#identity;
        await mkdir(this.directory, { mode: 0o700, recursive: true });
        try {
            this.#identity = parsePiariumExtensionHostIdentityDocument(JSON.parse(await readFile(this.identityPath, "utf8")));
            return this.#identity;
        }
        catch (error) {
            if (errorCode(error) !== "ENOENT") {
                const code = error instanceof SyntaxError || error instanceof PiariumExtensionContractError
                    ? "identity_invalid"
                    : "identity_read_failed";
                throw new ExtensionCatalogStorageError(code, "Failed to read Piarium extension host identity", { cause: error });
            }
        }
        const release = await acquireLock(this.#lockPath);
        try {
            try {
                this.#identity = parsePiariumExtensionHostIdentityDocument(JSON.parse(await readFile(this.identityPath, "utf8")));
            }
            catch (error) {
                if (errorCode(error) !== "ENOENT")
                    throw error;
                this.#identity = {
                    createdAt: new Date().toISOString(),
                    hostId: randomUUID(),
                    schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
                };
                await atomicWrite(this.identityPath, this.#identity);
            }
            return this.#identity;
        }
        catch (error) {
            throw new ExtensionCatalogStorageError("identity_read_failed", "Failed to create Piarium extension host identity", { cause: error });
        }
        finally {
            await release();
        }
    }
    async #readStrictForMutation() {
        try {
            return {
                document: parsePiariumExtensionCatalogDocument(JSON.parse(await readFile(this.catalogPath, "utf8"))),
                storageState: "ready",
            };
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                return { document: emptyDocument(), storageState: "missing" };
            throw new ExtensionCatalogStorageError(error instanceof SyntaxError || error instanceof PiariumExtensionContractError
                ? "catalog_invalid"
                : "catalog_read_failed", "Cannot mutate an unreadable Piarium extension catalog", { cause: error });
        }
    }
    async #readForBuiltinReconciliation(manifests, ownedPrefix, now) {
        try {
            const raw = JSON.parse(await readFile(this.catalogPath, "utf8"));
            const repaired = repairKnownBuiltinRecords(raw, manifests, ownedPrefix, now);
            return {
                document: parsePiariumExtensionCatalogDocument(repaired.value),
                repaired: repaired.changed,
                storageState: "ready",
            };
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                return { document: emptyDocument(), storageState: "missing" };
            throw new ExtensionCatalogStorageError(error instanceof SyntaxError || error instanceof PiariumExtensionContractError
                ? "catalog_invalid"
                : "catalog_read_failed", "Cannot reconcile built-ins in an unreadable Piarium extension catalog", { cause: error });
        }
    }
    async #readPreservingAuthority() {
        try {
            const document = parsePiariumExtensionCatalogDocument(JSON.parse(await readFile(this.catalogPath, "utf8")));
            const nextFingerprint = fingerprint(document);
            if (this.#lastValid && document.revision < this.#lastValid.document.revision) {
                return this.#stale("catalog_revision_regressed", `Catalog revision regressed from ${this.#lastValid.document.revision} to ${document.revision}`);
            }
            if (this.#lastValid
                && document.revision === this.#lastValid.document.revision
                && nextFingerprint !== this.#lastValid.fingerprint) {
                return this.#stale("catalog_revision_reused", `Catalog content changed without advancing revision ${document.revision}`);
            }
            this.#lastValid = { document: cloneDocument(document), fingerprint: nextFingerprint, storageState: "ready" };
            return this.#stateFromLastValid();
        }
        catch (error) {
            if (errorCode(error) === "ENOENT") {
                if (this.#lastValid?.storageState === "ready") {
                    return this.#stale("catalog_disappeared", "The catalog file disappeared after a valid catalog was loaded");
                }
                const document = emptyDocument();
                this.#lastValid = { document, fingerprint: fingerprint(document), storageState: "missing" };
                return this.#stateFromLastValid();
            }
            if (this.#lastValid) {
                return this.#stale("catalog_read_failed", "Current catalog storage could not be read; the last valid catalog is preserved");
            }
            throw new ExtensionCatalogStorageError(error instanceof SyntaxError || error instanceof PiariumExtensionContractError
                ? "catalog_invalid"
                : "catalog_read_failed", "Failed to read Piarium extension catalog", { cause: error });
        }
    }
    #stateFromLastValid() {
        if (!this.#lastValid)
            throw new Error("Piarium extension catalog has no valid state");
        return {
            authoritative: true,
            diagnostics: [],
            document: cloneDocument(this.#lastValid.document),
            storageState: this.#lastValid.storageState,
        };
    }
    #stale(code, message) {
        if (!this.#lastValid)
            throw new Error("Piarium extension catalog has no state to preserve");
        return {
            authoritative: false,
            diagnostics: [diagnostic(code, message)],
            document: cloneDocument(this.#lastValid.document),
            storageState: "stale",
        };
    }
    #serialize(operation) {
        const result = this.#queue.then(operation, operation);
        this.#queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
//# sourceMappingURL=catalog-store.js.map