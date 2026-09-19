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
import {
  isWorkFocusId,
  isWorkFocusSource,
  productDefaultWorkFocus,
  type SessionSummary,
  type SessionWorkspaceBinding,
  type SessionWorkFocusSnapshot,
  type WorkFocusSelection,
} from "@piarium/protocol";

interface SessionMetadata {
  archivedAt?: string;
  workspace?: SessionWorkspaceBinding;
  workFocus?: SessionWorkFocusSnapshot;
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

function parseWorkspaceBinding(value: unknown): SessionWorkspaceBinding | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "unbound") return { kind: "unbound" };
  if (value.kind === "workspace" && typeof value.id === "string" && value.id.trim()) {
    const authorityId = typeof value.authorityId === "string" && value.authorityId.trim()
      ? value.authorityId.trim()
      : undefined;
    return {
      id: value.id.trim(),
      kind: "workspace",
      ...(authorityId === undefined ? {} : { authorityId }),
    };
  }
  return undefined;
}

function parseWorkFocusSelection(value: unknown): WorkFocusSelection | null {
  if (!isRecord(value) || !isWorkFocusId(value.id) || !isWorkFocusSource(value.source)) return null;
  return { id: value.id, source: value.source };
}

function parseWorkFocus(value: unknown): SessionWorkFocusSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const active = parseWorkFocusSelection(value.active);
  const selected = parseWorkFocusSelection(value.selected);
  if (!active || !selected || !isRecord(value.active)
    || !Number.isSafeInteger(value.active.generation) || Number(value.active.generation) < 1
    || (value.status !== "applied" && value.status !== "pending" && value.status !== "failed")) return undefined;
  const failure = isRecord(value.failure)
    && typeof value.failure.message === "string"
    && Number.isFinite(value.failure.at)
    ? { at: Number(value.failure.at), message: value.failure.message }
    : undefined;
  if (value.status === "failed" && !failure) return undefined;
  return {
    active: { ...active, generation: Number(value.active.generation) },
    selected,
    status: value.status,
    ...(failure ? { failure } : {}),
  };
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
    const workspace = parseWorkspaceBinding(raw.workspace);
    const workFocus = parseWorkFocus(raw.workFocus);
    sessions[sessionId] = {
      ...(typeof raw.archivedAt === "string" ? { archivedAt: raw.archivedAt } : {}),
      ...(workspace === undefined ? {} : { workspace }),
      ...(workFocus === undefined ? {} : { workFocus }),
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
      if (metadata?.workspace) enriched.workspace = metadata.workspace;
      else delete enriched.workspace;
      enriched.workFocus = structuredClone(metadata?.workFocus ?? productDefaultWorkFocus());
      return enriched;
    });
  }

  async setWorkspace(sessionId: string, workspace: SessionWorkspaceBinding): Promise<void> {
    await this.#mutate((document) => {
      const existing = document.sessions[sessionId] ?? {};
      document.sessions[sessionId] = { ...existing, workspace };
    });
  }

  async getWorkFocus(sessionId: string): Promise<SessionWorkFocusSnapshot> {
    const document = await this.#serialize(() => this.#read());
    return structuredClone(document.sessions[sessionId]?.workFocus ?? productDefaultWorkFocus());
  }

  async ensureWorkFocus(
    sessionId: string,
    selection: WorkFocusSelection,
  ): Promise<SessionWorkFocusSnapshot> {
    return this.#mutate((document) => {
      const existing = document.sessions[sessionId] ?? {};
      if (existing.workFocus) return structuredClone(existing.workFocus);
      const workFocus: SessionWorkFocusSnapshot = {
        active: { ...selection, generation: 1 },
        selected: { ...selection },
        status: "applied",
      };
      document.sessions[sessionId] = { ...existing, workFocus };
      return structuredClone(workFocus);
    });
  }

  async selectWorkFocus(
    sessionId: string,
    selection: WorkFocusSelection,
  ): Promise<SessionWorkFocusSnapshot> {
    return this.#mutate((document) => {
      const existing = document.sessions[sessionId] ?? {};
      const current = existing.workFocus ?? productDefaultWorkFocus();
      const alreadyApplied = current.active.id === selection.id
        && current.active.source === selection.source;
      const workFocus: SessionWorkFocusSnapshot = {
        active: { ...current.active },
        selected: { ...selection },
        status: alreadyApplied ? "applied" : "pending",
      };
      document.sessions[sessionId] = { ...existing, workFocus };
      return structuredClone(workFocus);
    });
  }

  async applySelectedWorkFocus(
    sessionId: string,
    expected: WorkFocusSelection,
  ): Promise<SessionWorkFocusSnapshot> {
    return this.#mutate((document) => {
      const existing = document.sessions[sessionId] ?? {};
      const current = existing.workFocus ?? productDefaultWorkFocus();
      if (current.selected.id !== expected.id || current.selected.source !== expected.source) {
        throw new Error("Work focus selection changed while it was being applied");
      }
      const changed = current.active.id !== expected.id || current.active.source !== expected.source;
      const workFocus: SessionWorkFocusSnapshot = {
        active: {
          ...expected,
          generation: changed ? current.active.generation + 1 : current.active.generation,
        },
        selected: { ...expected },
        status: "applied",
      };
      document.sessions[sessionId] = { ...existing, workFocus };
      return structuredClone(workFocus);
    });
  }

  async failSelectedWorkFocus(
    sessionId: string,
    expected: WorkFocusSelection,
    message: string,
  ): Promise<SessionWorkFocusSnapshot> {
    return this.#mutate((document) => {
      const existing = document.sessions[sessionId] ?? {};
      const current = existing.workFocus ?? productDefaultWorkFocus();
      if (current.selected.id !== expected.id || current.selected.source !== expected.source) {
        return structuredClone(current);
      }
      const workFocus: SessionWorkFocusSnapshot = {
        active: { ...current.active },
        selected: { ...current.selected },
        status: "failed",
        failure: { at: Date.now(), message },
      };
      document.sessions[sessionId] = { ...existing, workFocus };
      return structuredClone(workFocus);
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

  async remove(sessionId: string): Promise<boolean> {
    return this.#mutate((document) => {
      const existed = Object.hasOwn(document.sessions, sessionId);
      delete document.sessions[sessionId];
      return existed;
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
