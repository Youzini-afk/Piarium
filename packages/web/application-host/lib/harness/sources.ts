/**
 * research.source records: durable shared research inputs (7C, D-300).
 *
 * A source is a named, provenance-carrying input that experiments and threads
 * can pin by identity — a dataset URI, a paper, a code snapshot or an object in
 * the workspace store. Registering a source does not fetch or copy it; the
 * locator records where the material actually lives.
 */
import { randomUUID } from "node:crypto";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type { ResearchSourceView, SourceListParams, SourceListResult, SourceRegisterParams } from "@piarium/protocol";
import { HarnessServiceError } from "./service-error.js";

const SOURCE_PREFIX = "research.source:";
const SOURCE_KINDS = new Set(["dataset", "paper", "code", "artifact", "collection", "other"]);

interface SourceServiceDeps {
  client: KernelClient;
  now?: () => number;
}

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const str = (value: unknown): string | undefined => (
  typeof value === "string" && value ? value : undefined
);

const view = (record: KernelRecordResult): ResearchSourceView | null => {
  const payload = payloadOf(record);
  const sourceId = str(payload.id);
  const kind = str(payload.kind);
  if (!sourceId || !kind) return null;
  const label = str(payload.label);
  const uri = str(payload.uri);
  const sourcePath = str(payload.path);
  const objectHash = str(payload.objectHash);
  const note = str(payload.note);
  return {
    sourceId,
    kind,
    ...(label ? { label } : {}),
    ...(uri ? { uri } : {}),
    ...(sourcePath ? { path: sourcePath } : {}),
    ...(objectHash ? { objectHash } : {}),
    ...(note ? { note } : {}),
    state: record.state === "retired" ? "retired" : "available",
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    createdAt: record.createdAt,
  };
};

export function createSourceService(deps: SourceServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const contexts = new Map<string, Promise<KernelScopedClient>>();

  const context = (workspaceId: string): Promise<KernelScopedClient> => {
    const existing = contexts.get(workspaceId);
    if (existing) return existing;
    const creating = (async () => {
      const grant = await deps.client.issueGrant({
        grantId: `source:${randomUUID()}`,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return deps.client.scoped(grant);
    })();
    contexts.set(workspaceId, creating);
    void creating.catch(() => { if (contexts.get(workspaceId) === creating) contexts.delete(workspaceId); });
    return creating;
  };

  const register = async (
    workspaceId: string,
    params: SourceRegisterParams,
    actor: { sessionId?: string; threadId?: string; runId?: string },
  ): Promise<ResearchSourceView> => {
    const kind = typeof params.kind === "string" ? params.kind.trim() : "";
    if (!SOURCE_KINDS.has(kind)) {
      throw new HarnessServiceError("invalid-params", `source kind must be one of ${[...SOURCE_KINDS].join(", ")}`);
    }
    const uri = typeof params.uri === "string" && params.uri.trim() ? params.uri.trim() : undefined;
    const path = typeof params.path === "string" && params.path.trim() ? params.path.trim() : undefined;
    const objectHash = typeof params.objectHash === "string" && params.objectHash.startsWith("sha256-")
      ? params.objectHash
      : undefined;
    if (!uri && !path && !objectHash) {
      throw new HarnessServiceError("invalid-params", "source requires a uri, path or objectHash locator");
    }
    const sourceId = `source-${randomUUID()}`;
    const scoped = await context(workspaceId);
    const record = await scoped.putRecord({
      operationId: `research.source:${randomUUID()}`,
      recordId: `${SOURCE_PREFIX}${sourceId}`,
      workspaceId,
      recordType: "research.source",
      state: "available",
      payloadJson: JSON.stringify({
        id: sourceId,
        workspaceId,
        kind,
        ...(params.label?.trim() ? { label: params.label.trim() } : {}),
        ...(uri ? { uri } : {}),
        ...(path ? { path } : {}),
        ...(objectHash ? { objectHash } : {}),
        ...(params.note?.trim() ? { note: params.note.trim() } : {}),
        createdAt: now(),
      }),
      ownerIds: [],
      references: [],
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
      ...(actor.threadId ? { threadId: actor.threadId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
    });
    const result = view(record);
    if (!result) throw new HarnessServiceError("failed", "registered source record is unreadable");
    return result;
  };

  const get = async (workspaceId: string, sourceId: string): Promise<ResearchSourceView | null> => {
    const scoped = await context(workspaceId);
    const record = await scoped.getRecord(workspaceId, `${SOURCE_PREFIX}${sourceId}`);
    return record ? view(record) : null;
  };

  const list = async (workspaceId: string, params: SourceListParams): Promise<SourceListResult> => {
    const scoped = await context(workspaceId);
    const all: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId, recordType: "research.source", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    const sources = all
      .map(view)
      .filter((entry): entry is ResearchSourceView => entry !== null)
      .filter((entry) => params.kind === undefined || entry.kind === params.kind);
    const text = sources.length === 0
      ? "No research sources registered."
      : sources.map((entry) => {
          const locator = entry.uri ?? entry.path ?? entry.objectHash ?? "?";
          return `${entry.sourceId} · ${entry.kind}${entry.label ? ` · ${entry.label}` : ""} · ${locator}${entry.state === "retired" ? " (retired)" : ""}`;
        }).join("\n");
    return { sources, text };
  };

  return { register, get, list };
}

export type SourceService = ReturnType<typeof createSourceService>;
