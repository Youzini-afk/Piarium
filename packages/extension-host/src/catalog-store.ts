import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
  PiariumExtensionContractError,
  parsePiariumExtensionCatalogDocument,
  parsePiariumExtensionHostIdentityDocument,
  parsePiariumExtensionInstallationRecord,
  type PiariumExtensionCatalogDocument,
  type PiariumExtensionCandidateRecord,
  type PiariumExtensionCapabilityGrant,
  type PiariumExtensionDiagnostic,
  type PiariumExtensionHostIdentityDocument,
  type PiariumExtensionInstallationRecord,
} from "@piarium/extension-contract";
import {
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
} from "./errors.js";

const LOCK_RETRY_MS = 25;

interface CatalogReadState {
  authoritative: boolean;
  diagnostics: PiariumExtensionDiagnostic[];
  document: PiariumExtensionCatalogDocument;
  storageState: "missing" | "ready" | "stale";
}

interface LastValidCatalog {
  document: PiariumExtensionCatalogDocument;
  fingerprint: string;
  storageState: "missing" | "ready";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (handle) {
      const token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
        await handle.sync();
        return async () => {
          await handle.close();
          try {
            const owner = JSON.parse(await readFile(path, "utf8")) as unknown;
            if (isRecord(owner) && owner.token === token) await rm(path, { force: true });
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    let removeAbandoned = false;
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as unknown;
      removeAbandoned = !isRecord(owner) || !processIsAlive(Number(owner.pid));
    } catch (readError) {
      if (errorCode(readError) === "ENOENT") continue;
      try {
        const info = await stat(path);
        removeAbandoned = Date.now() - info.mtimeMs > 2_000;
      } catch (statError) {
        if (errorCode(statError) === "ENOENT") continue;
        throw statError;
      }
    }
    if (removeAbandoned) {
      const abandoned = `${path}.abandoned.${process.pid}.${randomUUID()}`;
      try {
        await rename(path, abandoned);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      await rm(abandoned, { force: true });
      continue;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
  }
}

function emptyDocument(): PiariumExtensionCatalogDocument {
  return {
    extensions: {},
    revision: 0,
    schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
  };
}

function cloneDocument(document: PiariumExtensionCatalogDocument): PiariumExtensionCatalogDocument {
  return structuredClone(document);
}

function fingerprint(document: PiariumExtensionCatalogDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

function diagnostic(code: string, message: string): PiariumExtensionDiagnostic {
  return { code, message, severity: "error", timestamp: new Date().toISOString() };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ExtensionCatalogStore {
  readonly dataDir: string;
  readonly directory: string;
  readonly catalogPath: string;
  readonly identityPath: string;
  readonly #lockPath: string;
  #lastValid: LastValidCatalog | null = null;
  #identity: PiariumExtensionHostIdentityDocument | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.directory = join(this.dataDir, "extensions");
    this.catalogPath = join(this.directory, "catalog.json");
    this.identityPath = join(this.directory, "identity.json");
    this.#lockPath = join(this.directory, ".catalog.lock");
  }

  getHostIdentity(): Promise<PiariumExtensionHostIdentityDocument> {
    return this.#serialize(async () => this.#readOrCreateIdentity());
  }

  read(): Promise<CatalogReadState> {
    return this.#serialize(async () => {
      await this.#readOrCreateIdentity();
      return this.#readPreservingAuthority();
    });
  }

  upsert(recordValue: PiariumExtensionInstallationRecord, expectedRevision: number): Promise<CatalogReadState> {
    const record = parsePiariumExtensionInstallationRecord(recordValue);
    return this.#mutate(expectedRevision, (document) => {
      document.extensions[record.manifest.id] = record;
      return true;
    });
  }

  remove(extensionId: string, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document) => {
      if (!(extensionId in document.extensions)) return false;
      delete document.extensions[extensionId];
      return true;
    });
  }

  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Piarium extension is not installed: ${extensionId}`);
      if (record.desired.enabled === enabled) return false;
      record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
      record.updatedAt = now;
      return true;
    });
  }

  setAllEnabled(enabled: boolean, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      let changed = false;
      for (const record of Object.values(document.extensions)) {
        if (record.desired.enabled === enabled) continue;
        record.desired = { enabled, revision: record.desired.revision + 1, updatedAt: now };
        record.updatedAt = now;
        changed = true;
      }
      return changed;
    });
  }

  setCapabilityGrant(
    extensionId: string,
    grant: PiariumExtensionCapabilityGrant,
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Piarium extension is not installed: ${extensionId}`);
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
      const index = record.capabilityGrants.findIndex((item) => (
        item.capability === grant.capability && item.realm === grant.realm
      ));
      if (index >= 0) record.capabilityGrants[index] = next;
      else record.capabilityGrants.push(next);
      record.updatedAt = now;
      return true;
    });
  }

  stageCandidate(candidate: PiariumExtensionCandidateRecord, expectedRevision: number): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[candidate.manifest.id];
      if (!record) throw new Error(`Piarium extension is not installed: ${candidate.manifest.id}`);
      if (record.candidate?.integrity === candidate.integrity) return false;
      record.candidate = structuredClone(candidate);
      record.updatedAt = now;
      return true;
    });
  }

  selectCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Piarium extension is not installed: ${extensionId}`);
      const candidate = record.candidate;
      if (!candidate || candidate.integrity !== candidateIntegrity) {
        throw new Error(`Piarium extension candidate is no longer current: ${extensionId}`);
      }
      record.manifest = structuredClone(candidate.manifest);
      record.source = structuredClone(candidate.source);
      record.integrity = candidate.integrity;
      record.resolvedPath = candidate.resolvedPath;
      record.resolvedVersion = candidate.resolvedVersion;
      record.selectedVersion = candidate.resolvedVersion;
      record.capabilityGrants = record.capabilityGrants.filter((grant) => (
        grant.manifestVersion === candidate.manifest.version
        && (candidate.manifest.capabilities?.[grant.realm] ?? []).includes(grant.capability)
      ));
      delete record.candidate;
      record.updatedAt = now;
      return true;
    });
  }

  discardCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<CatalogReadState> {
    return this.#mutate(expectedRevision, (document, now) => {
      const record = document.extensions[extensionId];
      if (!record) throw new Error(`Piarium extension is not installed: ${extensionId}`);
      if (!record.candidate || record.candidate.integrity !== candidateIntegrity) return false;
      delete record.candidate;
      record.updatedAt = now;
      return true;
    });
  }

  async #mutate(
    expectedRevision: number,
    mutator: (document: PiariumExtensionCatalogDocument, now: string) => boolean,
  ): Promise<CatalogReadState> {
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
      } finally {
        await release();
      }
    });
  }

  async #readOrCreateIdentity(): Promise<PiariumExtensionHostIdentityDocument> {
    if (this.#identity) return this.#identity;
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    try {
      this.#identity = parsePiariumExtensionHostIdentityDocument(JSON.parse(await readFile(this.identityPath, "utf8")) as unknown);
      return this.#identity;
    } catch (error) {
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
        this.#identity = parsePiariumExtensionHostIdentityDocument(JSON.parse(await readFile(this.identityPath, "utf8")) as unknown);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        this.#identity = {
          createdAt: new Date().toISOString(),
          hostId: randomUUID(),
          schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
        };
        await atomicWrite(this.identityPath, this.#identity);
      }
      return this.#identity;
    } catch (error) {
      throw new ExtensionCatalogStorageError("identity_read_failed", "Failed to create Piarium extension host identity", { cause: error });
    } finally {
      await release();
    }
  }

  async #readStrictForMutation(): Promise<{
    document: PiariumExtensionCatalogDocument;
    storageState: "missing" | "ready";
  }> {
    try {
      return {
        document: parsePiariumExtensionCatalogDocument(JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown),
        storageState: "ready",
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { document: emptyDocument(), storageState: "missing" };
      throw new ExtensionCatalogStorageError(
        error instanceof SyntaxError || error instanceof PiariumExtensionContractError
          ? "catalog_invalid"
          : "catalog_read_failed",
        "Cannot mutate an unreadable Piarium extension catalog",
        { cause: error },
      );
    }
  }

  async #readPreservingAuthority(): Promise<CatalogReadState> {
    try {
      const document = parsePiariumExtensionCatalogDocument(JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown);
      const nextFingerprint = fingerprint(document);
      if (this.#lastValid && document.revision < this.#lastValid.document.revision) {
        return this.#stale("catalog_revision_regressed", `Catalog revision regressed from ${this.#lastValid.document.revision} to ${document.revision}`);
      }
      if (
        this.#lastValid
        && document.revision === this.#lastValid.document.revision
        && nextFingerprint !== this.#lastValid.fingerprint
      ) {
        return this.#stale("catalog_revision_reused", `Catalog content changed without advancing revision ${document.revision}`);
      }
      this.#lastValid = { document: cloneDocument(document), fingerprint: nextFingerprint, storageState: "ready" };
      return this.#stateFromLastValid();
    } catch (error) {
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
      throw new ExtensionCatalogStorageError(
        error instanceof SyntaxError || error instanceof PiariumExtensionContractError
          ? "catalog_invalid"
          : "catalog_read_failed",
        "Failed to read Piarium extension catalog",
        { cause: error },
      );
    }
  }

  #stateFromLastValid(): CatalogReadState {
    if (!this.#lastValid) throw new Error("Piarium extension catalog has no valid state");
    return {
      authoritative: true,
      diagnostics: [],
      document: cloneDocument(this.#lastValid.document),
      storageState: this.#lastValid.storageState,
    };
  }

  #stale(code: string, message: string): CatalogReadState {
    if (!this.#lastValid) throw new Error("Piarium extension catalog has no state to preserve");
    return {
      authoritative: false,
      diagnostics: [diagnostic(code, message)],
      document: cloneDocument(this.#lastValid.document),
      storageState: "stale",
    };
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export type { CatalogReadState };
