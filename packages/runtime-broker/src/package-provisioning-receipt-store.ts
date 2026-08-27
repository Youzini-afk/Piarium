import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  FOUNDATIONAL_PI_PACKAGE_IDS,
  FOUNDATIONAL_PI_PACKAGE_INTENTS,
  FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
  FOUNDATIONAL_PI_PACKAGE_PROVENANCES,
  type FoundationalPiPackageId,
  type FoundationalPiPackageIntent,
  type FoundationalPiPackageProvenance,
} from "@piarium/protocol";
import {
  createSettingsFileStore,
  type PiariumSettingsDocument,
  type SettingsFileStore,
} from "@piarium/settings-store";

export const PACKAGE_PROVISIONING_RECEIPT_FILE = "package-provisioning.json";
export const PACKAGE_PROVISIONING_RECEIPT_VERSION = 1 as const;

export interface PackageProvisioningReceiptEntry extends Record<string, unknown> {
  intent: FoundationalPiPackageIntent;
  lastObservedPresent: boolean;
  provenance: FoundationalPiPackageProvenance;
  /** Actual Pi package source last associated with this receipt. */
  source?: string;
}

export type PackageProvisioningReceiptEntries = Partial<
  Record<FoundationalPiPackageId, PackageProvisioningReceiptEntry>
> &
  Record<string, unknown>;

export interface PackageProvisioningReceiptDocument extends Record<string, unknown> {
  autoInstallNew: boolean;
  entries: PackageProvisioningReceiptEntries;
  manifestRevisionSeen: number;
  version: typeof PACKAGE_PROVISIONING_RECEIPT_VERSION;
}

export interface PackageProvisioningReceiptTransaction<Result> {
  document?: PackageProvisioningReceiptDocument;
  result: Result;
  write?: boolean;
}

export interface PackageProvisioningReceiptEntryCommit {
  id: FoundationalPiPackageId;
  intent: FoundationalPiPackageIntent;
  lastObservedPresent: boolean;
  provenance: FoundationalPiPackageProvenance;
  source?: string;
}

export interface PackageProvisioningReceiptCommitOptions {
  manifestRevisionSeen?: number;
}

const DEFAULT_RECEIPT: PackageProvisioningReceiptDocument = {
  autoInstallNew: true,
  entries: {},
  manifestRevisionSeen: 0,
  version: PACKAGE_PROVISIONING_RECEIPT_VERSION,
};

const INTENTS: ReadonlySet<string> = new Set(FOUNDATIONAL_PI_PACKAGE_INTENTS);
const PROVENANCES: ReadonlySet<string> = new Set(FOUNDATIONAL_PI_PACKAGE_PROVENANCES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertManifestRevision(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Package provisioning receipt manifestRevisionSeen is invalid: ${path}`);
  }
}

function assertKnownEntry(
  value: unknown,
  id: FoundationalPiPackageId,
  path: string,
): asserts value is PackageProvisioningReceiptEntry {
  if (!isRecord(value)) {
    throw new Error(`Package provisioning receipt entry ${id} must be an object: ${path}`);
  }
  if (typeof value.intent !== "string" || !INTENTS.has(value.intent)) {
    throw new Error(`Package provisioning receipt entry ${id} has invalid intent: ${path}`);
  }
  if (typeof value.provenance !== "string" || !PROVENANCES.has(value.provenance)) {
    throw new Error(`Package provisioning receipt entry ${id} has invalid provenance: ${path}`);
  }
  if (typeof value.lastObservedPresent !== "boolean") {
    throw new Error(
      `Package provisioning receipt entry ${id} has invalid lastObservedPresent: ${path}`,
    );
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new Error(`Package provisioning receipt entry ${id} has invalid source: ${path}`);
  }
}

function parseReceiptDocument(
  value: PiariumSettingsDocument,
  path: string,
): PackageProvisioningReceiptDocument {
  if (
    value.version !== PACKAGE_PROVISIONING_RECEIPT_VERSION ||
    typeof value.autoInstallNew !== "boolean" ||
    !isRecord(value.entries)
  ) {
    throw new Error(`Unsupported or malformed package provisioning receipt: ${path}`);
  }
  assertManifestRevision(value.manifestRevisionSeen, path);
  for (const id of FOUNDATIONAL_PI_PACKAGE_IDS) {
    if (Object.hasOwn(value.entries, id)) assertKnownEntry(value.entries[id], id, path);
  }
  return value as PackageProvisioningReceiptDocument;
}

function mergeEntry(
  existing: unknown,
  commit: PackageProvisioningReceiptEntryCommit,
): PackageProvisioningReceiptEntry {
  const next: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  next.intent = commit.intent;
  next.lastObservedPresent = commit.lastObservedPresent;
  next.provenance = commit.provenance;
  delete next.source;
  if (commit.source !== undefined) next.source = commit.source;
  return next as PackageProvisioningReceiptEntry;
}

export function packageProvisioningReceiptPath(canonicalAgentDir: string): string {
  return join(canonicalAgentDir, "piarium", PACKAGE_PROVISIONING_RECEIPT_FILE);
}

export class PackageProvisioningReceiptStore {
  readonly agentDir: string;
  readonly filePath: string;
  readonly #store: SettingsFileStore;

  private constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.filePath = packageProvisioningReceiptPath(agentDir);
    this.#store = createSettingsFileStore({
      defaultValue: DEFAULT_RECEIPT,
      filePath: this.filePath,
    });
  }

  static async create(agentDir: string): Promise<PackageProvisioningReceiptStore> {
    const canonicalAgentDir = await realpath(resolve(agentDir));
    const info = await stat(canonicalAgentDir);
    if (!info.isDirectory()) {
      throw new Error(`Pi agent directory is not a directory: ${canonicalAgentDir}`);
    }
    return new PackageProvisioningReceiptStore(canonicalAgentDir);
  }

  async read(): Promise<PackageProvisioningReceiptDocument> {
    return parseReceiptDocument(await this.#store.read(), this.filePath);
  }

  /**
   * Runs while settings-store holds its filesystem lock. The callback may await a
   * PackageManager operation when a later provisioning phase needs one exclusive
   * read/operate/commit sequence.
   */
  async transact<Result>(
    mutator: (
      current: PackageProvisioningReceiptDocument,
    ) =>
      | PackageProvisioningReceiptTransaction<Result>
      | Promise<PackageProvisioningReceiptTransaction<Result>>,
  ): Promise<Result> {
    return this.#store.transact(async (raw) => {
      const current = parseReceiptDocument(raw, this.filePath);
      const transaction = await mutator(current);
      if (!isRecord(transaction) || !("result" in transaction)) {
        throw new Error("Package provisioning receipt transaction must return a result object");
      }
      const document = parseReceiptDocument(
        (transaction.document ?? current) as PiariumSettingsDocument,
        this.filePath,
      );
      return {
        document,
        result: transaction.result,
        ...(transaction.write === undefined ? {} : { write: transaction.write }),
      };
    });
  }

  async markSuppressed(id: FoundationalPiPackageId): Promise<PackageProvisioningReceiptDocument> {
    return this.transact((current) => {
      const existing = current.entries[id];
      const prior = isRecord(existing) ? existing : undefined;
      const entry = mergeEntry(existing, {
        id,
        intent: "suppressed",
        lastObservedPresent:
          typeof prior?.lastObservedPresent === "boolean" ? prior.lastObservedPresent : false,
        provenance: PROVENANCES.has(String(prior?.provenance))
          ? (prior?.provenance as FoundationalPiPackageProvenance)
          : "none",
        ...(typeof prior?.source === "string" ? { source: prior.source } : {}),
      });
      const document: PackageProvisioningReceiptDocument = {
        ...current,
        entries: { ...current.entries, [id]: entry },
      };
      return { document, result: document };
    });
  }

  async setAutoInstallNew(
    autoInstallNew: boolean,
  ): Promise<PackageProvisioningReceiptDocument> {
    return this.transact((current) => {
      const document: PackageProvisioningReceiptDocument = {
        ...current,
        autoInstallNew,
        manifestRevisionSeen: Math.max(
          current.manifestRevisionSeen,
          FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
        ),
      };
      return { document, result: document };
    });
  }

  async commitEntries(
    entries: readonly PackageProvisioningReceiptEntryCommit[],
    options: PackageProvisioningReceiptCommitOptions = {},
  ): Promise<PackageProvisioningReceiptDocument> {
    if (options.manifestRevisionSeen !== undefined) {
      assertManifestRevision(options.manifestRevisionSeen, this.filePath);
    }
    return this.transact((current) => {
      const nextEntries: PackageProvisioningReceiptEntries = { ...current.entries };
      for (const entry of entries) {
        nextEntries[entry.id] = mergeEntry(nextEntries[entry.id], entry);
      }
      const document: PackageProvisioningReceiptDocument = {
        ...current,
        entries: nextEntries,
        manifestRevisionSeen: Math.max(
          current.manifestRevisionSeen,
          options.manifestRevisionSeen ?? FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
        ),
      };
      return { document, result: document };
    });
  }
}

export async function createPackageProvisioningReceiptStore(
  agentDir: string,
): Promise<PackageProvisioningReceiptStore> {
  return PackageProvisioningReceiptStore.create(agentDir);
}
