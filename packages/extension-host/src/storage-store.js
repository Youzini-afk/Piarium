import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isPiariumExtensionId, PiariumExtensionContractError, parsePiariumExtensionStorageAddress, parsePiariumExtensionStorageSnapshot, } from "@piarium/extension-contract";
import { ExtensionStorageError, ExtensionStorageRevisionConflictError } from "./errors.js";
const LOCK_RETRY_MS = 25;
const transactionState = Symbol("extensionStorageTransactionState");
const transactionSetCommitted = Symbol("extensionStorageTransactionSetCommitted");
const errorCode = (error) => (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined);
const processIsAlive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errorCode(error) === "EPERM";
    }
};
const acquireLock = async (path) => {
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
            await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
            await handle.sync();
            return async () => {
                await handle.close();
                try {
                    const owner = JSON.parse(await readFile(path, "utf8"));
                    if (owner.token === token)
                        await rm(path, { force: true });
                }
                catch (error) {
                    if (errorCode(error) !== "ENOENT")
                        throw error;
                }
            };
        }
        let abandoned = false;
        try {
            const owner = JSON.parse(await readFile(path, "utf8"));
            abandoned = !processIsAlive(Number(owner.pid));
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                continue;
            try {
                abandoned = Date.now() - (await stat(path)).mtimeMs > 2_000;
            }
            catch (statError) {
                if (errorCode(statError) === "ENOENT")
                    continue;
                throw statError;
            }
        }
        if (abandoned) {
            const moved = `${path}.abandoned.${process.pid}.${randomUUID()}`;
            try {
                await rename(path, moved);
            }
            catch (error) {
                if (errorCode(error) === "ENOENT")
                    continue;
                throw error;
            }
            await rm(moved, { force: true });
            continue;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
};
const atomicWrite = async (path, value) => {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
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
        await rename(temporary, path);
    }
    finally {
        await rm(temporary, { force: true });
    }
};
const emptyDocument = () => ({
    data: {},
    revision: 0,
    schemaVersion: 0,
    updatedAt: new Date(0).toISOString(),
});
const fingerprint = (document) => (createHash("sha256").update(JSON.stringify(document)).digest("hex"));
const diagnostic = (address, code, message) => ({
    code,
    extensionId: address.extensionId,
    message,
    severity: "error",
    timestamp: new Date().toISOString(),
});
const assertJsonObject = (value) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        throw new Error("Piarium extension storage data is not JSON-safe");
    return JSON.parse(serialized);
};
export class ExtensionStorageMigrationTransaction {
    address;
    previous;
    targetSchemaVersion;
    #store;
    #targetData;
    #committed = null;
    constructor(options) {
        this.address = options.address;
        this.previous = options.previous;
        this.#store = options.store;
        this.#targetData = options.targetData;
        this.targetSchemaVersion = options.targetSchemaVersion;
    }
    get targetData() {
        return structuredClone(this.#targetData);
    }
    stageData(data) {
        if (this.#committed)
            throw new Error("Cannot stage extension storage after commit");
        this.#targetData = assertJsonObject(data);
    }
    async commit() {
        this.#committed ??= (await this.#store.commitPrepared([this]))[0];
        return this.#committed;
    }
    async rollbackCommitted() {
        if (!this.#committed)
            return;
        await this.#store.rollbackPrepared([this]);
    }
    [transactionState]() {
        return {
            address: this.address,
            committed: this.#committed,
            data: structuredClone(this.#targetData),
            previous: this.previous,
            schemaVersion: this.targetSchemaVersion,
            store: this.#store,
        };
    }
    [transactionSetCommitted](snapshot) {
        this.#committed = snapshot;
    }
}
export class ExtensionStorageStore {
    dataDir;
    directory;
    #lastValid = new Map();
    #queues = new Map();
    constructor(dataDir) {
        this.dataDir = resolve(dataDir);
        this.directory = join(this.dataDir, "extensions", "storage");
    }
    read(addressValue) {
        const address = parsePiariumExtensionStorageAddress(addressValue);
        return this.#serialize(this.#path(address), () => this.#readPreserving(address));
    }
    update(addressValue, expectedRevision, schemaVersion, dataValue) {
        const address = parsePiariumExtensionStorageAddress(addressValue);
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0)
            throw new Error("Extension storage schemaVersion must be non-negative");
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
            throw new Error("Extension storage expectedRevision must be non-negative");
        const data = assertJsonObject(dataValue);
        const path = this.#path(address);
        return this.#serialize(path, async () => {
            await mkdir(dirname(path), { mode: 0o700, recursive: true });
            const release = await acquireLock(`${path}.lock`);
            try {
                const current = await this.#readStrict(address);
                if (current.document.revision !== expectedRevision) {
                    throw new ExtensionStorageRevisionConflictError(expectedRevision, current.document.revision);
                }
                const document = {
                    data,
                    revision: current.document.revision + 1,
                    schemaVersion,
                    updatedAt: new Date().toISOString(),
                };
                await atomicWrite(path, { address, ...document });
                this.#lastValid.set(path, { document: structuredClone(document), exists: true, fingerprint: fingerprint(document) });
                return this.#snapshot(address, document, true, true, "ready", []);
            }
            finally {
                await release();
            }
        });
    }
    async deleteExtensionData(extensionId) {
        if (!isPiariumExtensionId(extensionId))
            throw new Error(`Invalid Piarium extension ID: ${extensionId}`);
        const namespace = join(this.directory, extensionId);
        const namespacePrefix = `${namespace}${sep}`;
        const belongsToNamespace = (path) => path === namespace || path.startsWith(namespacePrefix);
        const pending = [...this.#queues]
            .filter(([path]) => belongsToNamespace(path))
            .map(([, operation]) => operation);
        await Promise.all(pending);
        await rm(namespace, { force: true, recursive: true });
        for (const path of [...this.#lastValid.keys()]) {
            if (belongsToNamespace(path))
                this.#lastValid.delete(path);
        }
        for (const path of [...this.#queues.keys()]) {
            if (belongsToNamespace(path))
                this.#queues.delete(path);
        }
    }
    commitPrepared(transactions) {
        if (transactions.length === 0)
            return Promise.resolve([]);
        const states = transactions.map((transaction) => transaction[transactionState]());
        if (states.some((state) => state.store !== this))
            throw new Error("Extension storage transaction belongs to another store");
        if (states.every((state) => state.committed !== null)) {
            return Promise.resolve(states.map((state) => structuredClone(state.committed)));
        }
        if (states.some((state) => state.committed !== null))
            throw new Error("Cannot commit a partially committed storage transaction group");
        const entries = states.map((state, index) => ({ index, path: this.#path(state.address), state }))
            .sort((left, right) => left.path.localeCompare(right.path));
        if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
            throw new Error("Extension storage transaction group contains a duplicate address");
        }
        return this.#serializeMany(entries.map((entry) => entry.path), async () => {
            const releases = [];
            try {
                for (const entry of entries) {
                    await mkdir(dirname(entry.path), { mode: 0o700, recursive: true });
                    releases.push(await acquireLock(`${entry.path}.lock`));
                }
                const current = await Promise.all(entries.map((entry) => this.#readStrict(entry.state.address)));
                current.forEach((value, index) => {
                    const expectedRevision = entries[index]?.state.previous.document.revision ?? -1;
                    if (value.document.revision !== expectedRevision) {
                        throw new ExtensionStorageRevisionConflictError(expectedRevision, value.document.revision);
                    }
                });
                const documents = entries.map((entry, index) => ({
                    data: structuredClone(entry.state.data),
                    revision: (current[index]?.document.revision ?? 0) + 1,
                    schemaVersion: entry.state.schemaVersion,
                    updatedAt: new Date().toISOString(),
                }));
                let written = 0;
                try {
                    for (; written < entries.length; written += 1) {
                        const entry = entries[written];
                        await atomicWrite(entry.path, { address: entry.state.address, ...documents[written] });
                    }
                }
                catch (error) {
                    const rollbackErrors = [];
                    for (let index = written - 1; index >= 0; index -= 1) {
                        const entry = entries[index];
                        try {
                            if (entry.state.previous.exists) {
                                await atomicWrite(entry.path, { address: entry.state.address, ...entry.state.previous.document });
                            }
                            else
                                await rm(entry.path, { force: true });
                        }
                        catch (rollbackError) {
                            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
                        }
                    }
                    if (rollbackErrors.length > 0) {
                        throw new ExtensionStorageError("storage_write_failed", `Failed to commit and fully roll back Piarium extension storage: ${rollbackErrors.join("; ")}`, { cause: error });
                    }
                    throw error;
                }
                const snapshots = new Array(entries.length);
                entries.forEach((entry, index) => {
                    const document = documents[index];
                    const snapshot = this.#snapshot(entry.state.address, document, true, true, "ready", []);
                    this.#lastValid.set(entry.path, { document: structuredClone(document), exists: true, fingerprint: fingerprint(document) });
                    transactions[entry.index]?.[transactionSetCommitted](snapshot);
                    snapshots[entry.index] = snapshot;
                });
                return snapshots;
            }
            finally {
                for (const release of releases.reverse())
                    await release();
            }
        });
    }
    rollbackPrepared(transactions) {
        const states = transactions.map((transaction) => transaction[transactionState]());
        const committed = states.map((state, index) => ({ index, state })).filter((entry) => entry.state.committed !== null);
        if (committed.length === 0)
            return Promise.resolve();
        if (committed.length !== states.length)
            throw new Error("Cannot roll back a partially committed storage transaction group");
        if (states.some((state) => state.store !== this))
            throw new Error("Extension storage transaction belongs to another store");
        const entries = committed.map((entry) => ({ ...entry, path: this.#path(entry.state.address) }))
            .sort((left, right) => left.path.localeCompare(right.path));
        return this.#serializeMany(entries.map((entry) => entry.path), async () => {
            const releases = [];
            try {
                for (const entry of entries)
                    releases.push(await acquireLock(`${entry.path}.lock`));
                const current = await Promise.all(entries.map((entry) => this.#readStrict(entry.state.address)));
                current.forEach((value, index) => {
                    const expectedRevision = entries[index]?.state.committed?.document.revision ?? -1;
                    if (value.document.revision !== expectedRevision) {
                        throw new ExtensionStorageRevisionConflictError(expectedRevision, value.document.revision);
                    }
                });
                for (const entry of entries) {
                    if (entry.state.previous.exists) {
                        await atomicWrite(entry.path, { address: entry.state.address, ...entry.state.previous.document });
                    }
                    else
                        await rm(entry.path, { force: true });
                    const document = structuredClone(entry.state.previous.document);
                    this.#lastValid.set(entry.path, {
                        document,
                        exists: entry.state.previous.exists,
                        fingerprint: fingerprint(document),
                    });
                    transactions[entry.index]?.[transactionSetCommitted](null);
                }
            }
            finally {
                for (const release of releases.reverse())
                    await release();
            }
        });
    }
    restore(addressValue, expectedRevision, previousValue) {
        const address = parsePiariumExtensionStorageAddress(addressValue);
        const previous = parsePiariumExtensionStorageSnapshot(previousValue);
        if (JSON.stringify(previous.address) !== JSON.stringify(address))
            throw new Error("Extension storage rollback address does not match");
        if (!previous.authoritative)
            throw new ExtensionStorageError("storage_read_failed", "Cannot restore non-authoritative extension storage");
        const path = this.#path(address);
        return this.#serialize(path, async () => {
            await mkdir(dirname(path), { mode: 0o700, recursive: true });
            const release = await acquireLock(`${path}.lock`);
            try {
                const current = await this.#readStrict(address);
                if (current.document.revision !== expectedRevision) {
                    throw new ExtensionStorageRevisionConflictError(expectedRevision, current.document.revision);
                }
                if (previous.exists)
                    await atomicWrite(path, { address, ...previous.document });
                else
                    await rm(path, { force: true });
                const restored = structuredClone(previous.document);
                this.#lastValid.set(path, { document: restored, exists: previous.exists, fingerprint: fingerprint(restored) });
                return this.#snapshot(address, restored, previous.exists, true, previous.exists ? "ready" : "missing", []);
            }
            finally {
                await release();
            }
        });
    }
    async prepareMigration(addressValue, targetSchemaVersion, migrate) {
        const address = parsePiariumExtensionStorageAddress(addressValue);
        if (!Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 0)
            throw new Error("Extension storage schemaVersion must be non-negative");
        const previous = await this.read(address);
        if (!previous.authoritative)
            throw new ExtensionStorageError("storage_read_failed", "Cannot migrate stale extension storage");
        if (previous.document.schemaVersion === targetSchemaVersion)
            return null;
        const targetData = assertJsonObject(await migrate({
            data: structuredClone(previous.document.data),
            fromSchemaVersion: previous.document.schemaVersion,
            toSchemaVersion: targetSchemaVersion,
        }));
        return new ExtensionStorageMigrationTransaction({ address, previous, store: this, targetData, targetSchemaVersion });
    }
    async prepareWrite(addressValue, schemaVersion, dataValue) {
        const address = parsePiariumExtensionStorageAddress(addressValue);
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0)
            throw new Error("Extension storage schemaVersion must be non-negative");
        const previous = await this.read(address);
        if (!previous.authoritative)
            throw new ExtensionStorageError("storage_read_failed", "Cannot write stale extension storage");
        return new ExtensionStorageMigrationTransaction({
            address,
            previous,
            store: this,
            targetData: assertJsonObject(dataValue),
            targetSchemaVersion: schemaVersion,
        });
    }
    #path(address) {
        const keyHash = createHash("sha256").update(address.key).digest("hex");
        return join(this.directory, address.extensionId, address.scope, `${keyHash}.json`);
    }
    async #readStrict(address) {
        const path = this.#path(address);
        try {
            const raw = JSON.parse(await readFile(path, "utf8"));
            const parsed = parsePiariumExtensionStorageSnapshot({
                address: raw.address,
                authoritative: true,
                diagnostics: [],
                document: raw,
                exists: true,
                storageState: "ready",
            });
            if (JSON.stringify(parsed.address) !== JSON.stringify(address))
                throw new Error("Extension storage address does not match its namespace");
            return { document: parsed.document, exists: true };
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                return { document: emptyDocument(), exists: false };
            throw new ExtensionStorageError(error instanceof SyntaxError || error instanceof PiariumExtensionContractError
                || (error instanceof Error && error.message.includes("does not match its namespace"))
                ? "storage_invalid"
                : "storage_read_failed", "Failed to read Piarium extension storage", { cause: error });
        }
    }
    async #readPreserving(address) {
        const path = this.#path(address);
        try {
            const current = await this.#readStrict(address);
            const currentFingerprint = fingerprint(current.document);
            const previous = this.#lastValid.get(path);
            if (previous && current.document.revision < previous.document.revision) {
                return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
                    diagnostic(address, "storage_revision_regressed", "Extension storage revision regressed"),
                ]);
            }
            if (previous && current.document.revision === previous.document.revision && currentFingerprint !== previous.fingerprint) {
                return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
                    diagnostic(address, "storage_revision_reused", "Extension storage changed without advancing its revision"),
                ]);
            }
            this.#lastValid.set(path, { document: structuredClone(current.document), exists: current.exists, fingerprint: currentFingerprint });
            return this.#snapshot(address, current.document, current.exists, true, current.exists ? "ready" : "missing", []);
        }
        catch (error) {
            const previous = this.#lastValid.get(path);
            if (previous)
                return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
                    diagnostic(address, "storage_read_failed", "Current extension storage is unreadable; the last valid state is preserved"),
                ]);
            throw error;
        }
    }
    #snapshot(address, document, exists, authoritative, storageState, diagnostics) {
        return { address: structuredClone(address), authoritative, diagnostics, document: structuredClone(document), exists, storageState };
    }
    #serialize(key, operation) {
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tracked = result.then(() => undefined, () => undefined);
        this.#queues.set(key, tracked);
        void tracked.finally(() => { if (this.#queues.get(key) === tracked)
            this.#queues.delete(key); }).catch(() => undefined);
        return result;
    }
    #serializeMany(keys, operation) {
        const uniqueKeys = [...new Set(keys)].sort();
        const previous = Promise.all(uniqueKeys.map((key) => this.#queues.get(key) ?? Promise.resolve()));
        const result = previous.then(operation, operation);
        const tracked = result.then(() => undefined, () => undefined);
        for (const key of uniqueKeys)
            this.#queues.set(key, tracked);
        void tracked.finally(() => {
            for (const key of uniqueKeys)
                if (this.#queues.get(key) === tracked)
                    this.#queues.delete(key);
        }).catch(() => undefined);
        return result;
    }
}
//# sourceMappingURL=storage-store.js.map