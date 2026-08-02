import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionSummary } from "@piarium/protocol";

interface SessionMetadata {
  archivedAt?: string;
}

interface SessionMetadataDocument {
  sessions: Record<string, SessionMetadata>;
  version: 1;
}

const EMPTY_DOCUMENT: SessionMetadataDocument = { sessions: {}, version: 1 };
const LOCK_RETRY_MS = 25;

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
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }),
        );
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
    } else {
      let removeAbandoned = false;
      try {
        const content = await readFile(path, "utf8");
        const owner = JSON.parse(content) as unknown;
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
        const abandonedPath = `${path}.abandoned.${process.pid}.${randomUUID()}`;
        try {
          await rename(path, abandonedPath);
        } catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          throw error;
        }
        await rm(abandonedPath, { force: true });
        continue;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
}

function parseDocument(content: string, path: string): SessionMetadataDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid Piarium session metadata JSON: ${path}`, { cause: error });
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions)) {
    throw new Error(`Unsupported Piarium session metadata document: ${path}`);
  }
  const sessions: Record<string, SessionMetadata> = {};
  for (const [sessionId, raw] of Object.entries(value.sessions)) {
    if (!isRecord(raw)) continue;
    sessions[sessionId] = {
      ...(typeof raw.archivedAt === "string" ? { archivedAt: raw.archivedAt } : {}),
    };
  }
  return { sessions, version: 1 };
}

async function atomicWrite(path: string, document: SessionMetadataDocument): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
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

export class SessionMetadataStore {
  readonly agentDir: string;
  readonly #directory: string;
  readonly #lockPath: string;
  readonly #path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(agentDir: string) {
    this.agentDir = resolve(agentDir);
    this.#directory = join(this.agentDir, "piarium");
    this.#path = join(this.#directory, "session-metadata.json");
    this.#lockPath = `${this.#path}.lock`;
  }

  async enrich(summaries: SessionSummary[]): Promise<SessionSummary[]> {
    const document = await this.#serialize(() => this.#read());
    return summaries.map((summary) => {
      const metadata = document.sessions[summary.id];
      const enriched = { ...summary };
      if (metadata?.archivedAt) enriched.archivedAt = metadata.archivedAt;
      else delete enriched.archivedAt;
      return enriched;
    });
  }

  async setArchived(sessionId: string, archived: boolean): Promise<string | undefined> {
    return this.#mutate((document) => {
      const archivedAt = archived ? new Date().toISOString() : undefined;
      const existing = document.sessions[sessionId] ?? {};
      if (archivedAt === undefined) {
        const remaining = { ...existing };
        delete remaining.archivedAt;
        if (Object.keys(remaining).length === 0) delete document.sessions[sessionId];
        else document.sessions[sessionId] = remaining;
      } else {
        document.sessions[sessionId] = { ...existing, archivedAt };
      }
      return archivedAt;
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.#mutate((document) => {
      delete document.sessions[sessionId];
    });
  }

  async #mutate<T>(mutator: (document: SessionMetadataDocument) => T): Promise<T> {
    return this.#serialize(async () => {
      await mkdir(this.#directory, { mode: 0o700, recursive: true });
      const release = await acquireLock(this.#lockPath);
      try {
        const document = await this.#read();
        const result = mutator(document);
        await atomicWrite(this.#path, document);
        return result;
      } finally {
        await release();
      }
    });
  }

  async #read(): Promise<SessionMetadataDocument> {
    try {
      return parseDocument(await readFile(this.#path, "utf8"), this.#path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { sessions: { ...EMPTY_DOCUMENT.sessions }, version: 1 };
      }
      throw error;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
