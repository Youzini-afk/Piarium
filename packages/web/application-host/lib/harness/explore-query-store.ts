import { randomUUID } from "node:crypto";
import type { AgentInputContext } from "@piarium/protocol";
import {
  createExploreQueryRun,
  type ExploreDeps,
  type ExploreInput,
  type ExploreQueryRun,
} from "./explore.js";

export interface StoredExploreQuery {
  id: string;
  sessionId: string;
  workspaceId: string | null;
  inputContext: AgentInputContext;
  paths?: string[];
  startedAt: number;
  deadlineAt: number;
  controller: AbortController;
  run: ExploreQueryRun;
}

export interface ExploreQueryStoreStart {
  sessionId: string;
  workspaceId: string | null;
  inputContext: AgentInputContext;
  input: ExploreInput;
  deps: ExploreDeps;
  deadlineAt: number;
  reserveForJudgeMs?: number;
  signal?: AbortSignal;
}

export interface ExploreQueryStore {
  start(request: ExploreQueryStoreStart): StoredExploreQuery;
  get(sessionId: string, queryId: string): StoredExploreQuery | undefined;
  cancel(sessionId: string, queryId: string): boolean;
  release(sessionId: string, queryId: string): boolean;
  dropSession(sessionId: string): void;
  dispose(): void;
}

export function createExploreQueryStore(): ExploreQueryStore {
  const queries = new Map<string, StoredExploreQuery>();

  const keyOf = (sessionId: string, queryId: string): string => `${sessionId}:${queryId}`;

  const start = (request: ExploreQueryStoreStart): StoredExploreQuery => {
    const id = `eq_${randomUUID()}`;
    const controller = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const run = createExploreQueryRun(request.input, request.deps, {
      deadlineAt: request.deadlineAt,
      ...(request.reserveForJudgeMs !== undefined ? { reserveForJudgeMs: request.reserveForJudgeMs } : {}),
      signal: controller.signal,
    });
    const stored: StoredExploreQuery = {
      id,
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      inputContext: request.inputContext,
      ...(request.input.paths ? { paths: request.input.paths } : {}),
      startedAt: Date.now(),
      deadlineAt: request.deadlineAt,
      controller,
      run,
    };
    queries.set(keyOf(request.sessionId, id), stored);
    run.start();
    return stored;
  };

  const get = (sessionId: string, queryId: string): StoredExploreQuery | undefined => (
    queries.get(keyOf(sessionId, queryId))
  );

  const cancel = (sessionId: string, queryId: string): boolean => {
    const stored = get(sessionId, queryId);
    if (!stored) return false;
    stored.run.cancel();
    return true;
  };

  const release = (sessionId: string, queryId: string): boolean => {
    const stored = get(sessionId, queryId);
    if (!stored) return false;
    if (stored.run.terminal() === "active") stored.run.cancel();
    queries.delete(keyOf(sessionId, queryId));
    return true;
  };

  const dropSession = (sessionId: string): void => {
    for (const [key, stored] of queries) {
      if (stored.sessionId !== sessionId) continue;
      stored.run.cancel();
      queries.delete(key);
    }
  };

  const dispose = (): void => {
    for (const stored of queries.values()) stored.run.cancel();
    queries.clear();
  };

  return { start, get, cancel, release, dropSession, dispose };
}
