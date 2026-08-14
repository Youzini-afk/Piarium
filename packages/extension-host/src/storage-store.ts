import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  PiariumExtensionContractError,
  parsePiariumExtensionStorageAddress,
  parsePiariumExtensionStorageSnapshot,
  type JsonObject,
  type PiariumExtensionDiagnostic,
  type PiariumExtensionStorageAddress,
  type PiariumExtensionStorageDocument,
  type PiariumExtensionStorageSnapshot,
} from "@piarium/extension-contract";
import { ExtensionStorageError, ExtensionStorageRevisionConflictError } from "./errors.js";

const LOCK_RETRY_MS = 25;

interface StoredExtensionDocument extends PiariumExtensionStorageDocument {
  address: PiariumExtensionStorageAddress;
}

interface LastValidStorage {
  document: PiariumExtensionStorageDocument;
  exists: boolean;
  fingerprint: string;
}

const errorCode = (error: unknown): string | undefined => (
  typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined
);

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
};

const acquireLock = async (path: string): Promise<() => Promise<void>> => {
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    if (handle) {
      const token = randomUUID();
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
      await handle.sync();
      return async () => {
        await handle.close();
        try {
          const owner = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (owner.token === token) await rm(path, { force: true });
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    }
    let abandoned = false;
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      abandoned = !processIsAlive(Number(owner.pid));
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      try { abandoned = Date.now() - (await stat(path)).mtimeMs > 2_000; }
      catch (statError) { if (errorCode(statError) === "ENOENT") continue; throw statError; }
    }
    if (abandoned) {
      const moved = `${path}.abandoned.${process.pid}.${randomUUID()}`;
      try { await rename(path, moved); }
      catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
      await rm(moved, { force: true });
      continue;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
  }
};

const atomicWrite = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
};

const emptyDocument = (): PiariumExtensionStorageDocument => ({
  data: {},
  revision: 0,
  schemaVersion: 0,
  updatedAt: new Date(0).toISOString(),
});

const fingerprint = (document: PiariumExtensionStorageDocument): string => (
  createHash("sha256").update(JSON.stringify(document)).digest("hex")
);

const diagnostic = (address: PiariumExtensionStorageAddress, code: string, message: string): PiariumExtensionDiagnostic => ({
  code,
  extensionId: address.extensionId,
  message,
  severity: "error",
  timestamp: new Date().toISOString(),
});

const assertJsonObject = (value: JsonObject): JsonObject => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Piarium extension storage data is not JSON-safe");
  return JSON.parse(serialized) as JsonObject;
};

export interface ExtensionStorageMigrationInput {
  data: JsonObject;
  fromSchemaVersion: number;
  toSchemaVersion: number;
}

export type ExtensionStorageMigrator = (input: ExtensionStorageMigrationInput) => JsonObject | Promise<JsonObject>;

export class ExtensionStorageMigrationTransaction {
  readonly address: PiariumExtensionStorageAddress;
  readonly previous: PiariumExtensionStorageSnapshot;
  readonly targetSchemaVersion: number;
  readonly #store: ExtensionStorageStore;
  #targetData: JsonObject;
  #committed: PiariumExtensionStorageSnapshot | null = null;

  constructor(options: {
    address: PiariumExtensionStorageAddress;
    previous: PiariumExtensionStorageSnapshot;
    store: ExtensionStorageStore;
    targetData: JsonObject;
    targetSchemaVersion: number;
  }) {
    this.address = options.address;
    this.previous = options.previous;
    this.#store = options.store;
    this.#targetData = options.targetData;
    this.targetSchemaVersion = options.targetSchemaVersion;
  }

  get targetData(): JsonObject {
    return structuredClone(this.#targetData);
  }

  stageData(data: JsonObject): void {
    if (this.#committed) throw new Error("Cannot stage extension storage after commit");
    this.#targetData = assertJsonObject(data);
  }

  async commit(): Promise<PiariumExtensionStorageSnapshot> {
    this.#committed ??= await this.#store.update(
      this.address,
      this.previous.document.revision,
      this.targetSchemaVersion,
      this.#targetData,
    );
    return this.#committed;
  }

  async rollbackCommitted(): Promise<void> {
    if (!this.#committed) return;
    await this.#store.restore(this.address, this.#committed.document.revision, this.previous);
    this.#committed = null;
  }
}

export class ExtensionStorageStore {
  readonly dataDir: string;
  readonly directory: string;
  readonly #lastValid = new Map<string, LastValidStorage>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.directory = join(this.dataDir, "extensions", "storage");
  }

  read(addressValue: PiariumExtensionStorageAddress | unknown): Promise<PiariumExtensionStorageSnapshot> {
    const address = parsePiariumExtensionStorageAddress(addressValue);
    return this.#serialize(this.#path(address), () => this.#readPreserving(address));
  }

  update(
    addressValue: PiariumExtensionStorageAddress | unknown,
    expectedRevision: number,
    schemaVersion: number,
    dataValue: JsonObject,
  ): Promise<PiariumExtensionStorageSnapshot> {
    const address = parsePiariumExtensionStorageAddress(addressValue);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new Error("Extension storage schemaVersion must be non-negative");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Extension storage expectedRevision must be non-negative");
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
        const document: PiariumExtensionStorageDocument = {
          data,
          revision: current.document.revision + 1,
          schemaVersion,
          updatedAt: new Date().toISOString(),
        };
        await atomicWrite(path, { address, ...document });
        this.#lastValid.set(path, { document: structuredClone(document), exists: true, fingerprint: fingerprint(document) });
        return this.#snapshot(address, document, true, true, "ready", []);
      } finally {
        await release();
      }
    });
  }

  restore(
    addressValue: PiariumExtensionStorageAddress | unknown,
    expectedRevision: number,
    previousValue: PiariumExtensionStorageSnapshot | unknown,
  ): Promise<PiariumExtensionStorageSnapshot> {
    const address = parsePiariumExtensionStorageAddress(addressValue);
    const previous = parsePiariumExtensionStorageSnapshot(previousValue);
    if (JSON.stringify(previous.address) !== JSON.stringify(address)) throw new Error("Extension storage rollback address does not match");
    if (!previous.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot restore non-authoritative extension storage");
    const path = this.#path(address);
    return this.#serialize(path, async () => {
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      const release = await acquireLock(`${path}.lock`);
      try {
        const current = await this.#readStrict(address);
        if (current.document.revision !== expectedRevision) {
          throw new ExtensionStorageRevisionConflictError(expectedRevision, current.document.revision);
        }
        if (previous.exists) await atomicWrite(path, { address, ...previous.document });
        else await rm(path, { force: true });
        const restored = structuredClone(previous.document);
        this.#lastValid.set(path, { document: restored, exists: previous.exists, fingerprint: fingerprint(restored) });
        return this.#snapshot(
          address,
          restored,
          previous.exists,
          true,
          previous.exists ? "ready" : "missing",
          [],
        );
      } finally {
        await release();
      }
    });
  }

  async prepareMigration(
    addressValue: PiariumExtensionStorageAddress | unknown,
    targetSchemaVersion: number,
    migrate: ExtensionStorageMigrator,
  ): Promise<ExtensionStorageMigrationTransaction | null> {
    const address = parsePiariumExtensionStorageAddress(addressValue);
    if (!Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 0) throw new Error("Extension storage schemaVersion must be non-negative");
    const previous = await this.read(address);
    if (!previous.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot migrate stale extension storage");
    if (previous.document.schemaVersion === targetSchemaVersion) return null;
    const targetData = assertJsonObject(await migrate({
      data: structuredClone(previous.document.data),
      fromSchemaVersion: previous.document.schemaVersion,
      toSchemaVersion: targetSchemaVersion,
    }));
    return new ExtensionStorageMigrationTransaction({ address, previous, store: this, targetData, targetSchemaVersion });
  }

  async prepareWrite(
    addressValue: PiariumExtensionStorageAddress | unknown,
    schemaVersion: number,
    dataValue: JsonObject,
  ): Promise<ExtensionStorageMigrationTransaction> {
    const address = parsePiariumExtensionStorageAddress(addressValue);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new Error("Extension storage schemaVersion must be non-negative");
    const previous = await this.read(address);
    if (!previous.authoritative) throw new ExtensionStorageError("storage_read_failed", "Cannot write stale extension storage");
    return new ExtensionStorageMigrationTransaction({
      address,
      previous,
      store: this,
      targetData: assertJsonObject(dataValue),
      targetSchemaVersion: schemaVersion,
    });
  }

  #path(address: PiariumExtensionStorageAddress): string {
    const keyHash = createHash("sha256").update(address.key).digest("hex");
    return join(this.directory, address.extensionId, address.scope, `${keyHash}.json`);
  }

  async #readStrict(address: PiariumExtensionStorageAddress): Promise<{ document: PiariumExtensionStorageDocument; exists: boolean }> {
    const path = this.#path(address);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as StoredExtensionDocument;
      const parsed = parsePiariumExtensionStorageSnapshot({
        address: raw.address,
        authoritative: true,
        diagnostics: [],
        document: raw,
        exists: true,
        storageState: "ready",
      });
      if (JSON.stringify(parsed.address) !== JSON.stringify(address)) throw new Error("Extension storage address does not match its namespace");
      return { document: parsed.document, exists: true };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { document: emptyDocument(), exists: false };
      throw new ExtensionStorageError(
        error instanceof SyntaxError || error instanceof PiariumExtensionContractError
          || (error instanceof Error && error.message.includes("does not match its namespace"))
          ? "storage_invalid"
          : "storage_read_failed",
        "Failed to read Piarium extension storage",
        { cause: error },
      );
    }
  }

  async #readPreserving(address: PiariumExtensionStorageAddress): Promise<PiariumExtensionStorageSnapshot> {
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
    } catch (error) {
      const previous = this.#lastValid.get(path);
      if (previous) return this.#snapshot(address, previous.document, previous.exists, false, "stale", [
        diagnostic(address, "storage_read_failed", "Current extension storage is unreadable; the last valid state is preserved"),
      ]);
      throw error;
    }
  }

  #snapshot(
    address: PiariumExtensionStorageAddress,
    document: PiariumExtensionStorageDocument,
    exists: boolean,
    authoritative: boolean,
    storageState: "missing" | "ready" | "stale",
    diagnostics: PiariumExtensionDiagnostic[],
  ): PiariumExtensionStorageSnapshot {
    return { address: structuredClone(address), authoritative, diagnostics, document: structuredClone(document), exists, storageState };
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tracked = result.then(() => undefined, () => undefined);
    this.#queues.set(key, tracked);
    void tracked.finally(() => { if (this.#queues.get(key) === tracked) this.#queues.delete(key); }).catch(() => undefined);
    return result;
  }
}
