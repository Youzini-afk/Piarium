/**
 * Subsession worker runtime — dispatch/wait/merge/kill.
 *
 * Design: agent-harness.md §9.2.1, §9.2.5b, §9.2.6
 * Plan: agent-harness-plan.md §3.4, §3.5
 *
 * spawnChild: create child session with role, task, worktree.
 * dispatch: enqueue or spawn child.
 * wait: block until any child completes or timeout (TTL-based).
 * merge: apply child worktree diff to parent with git apply --3way.
 * kill: terminate child.
 */

import type { ResolvedRole } from "./roles.js";

// ── Types ──────────────────────────────────────────────────────────

export type ChildStatus = "queued" | "running" | "done" | "failed" | "killed";

export interface ChildResult {
  changedFiles: string[];
  conclusion: string;
  unresolved: string[];
  confidence: number;
  traceHandle: string;
  worktree?: { path: string; base: string };
}

export interface ChildSession {
  childId: string;
  sessionId: string;
  parentSessionId: string;
  role: string;
  status: ChildStatus;
  turnIndex: number;
  lastToolAt: number;
  startedAt: number;
  result?: ChildResult;
  error?: string;
  worktreePath?: string;
  base?: string;
}

export interface SpawnChildInput {
  parentSessionId: string;
  role: string;
  task: string;
  scope?: string[];
  worktree: { mode: "shared" | "isolated" };
  model: { providerId: string; modelId: string };
  tools: string[];
  permissions: unknown;
  systemPromptFragment: string;
  budget: { maxTurns: number; maxTokens: number };
}

export interface DispatchSettings {
  concurrency: number; // default 12
  staleAfterMs: number; // default 5 * 60 * 1000
  askBefore: Partial<Record<string, boolean>>;
}

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  concurrency: 12,
  staleAfterMs: 5 * 60 * 1000,
  askBefore: {},
};

// ── TTL table ──────────────────────────────────────────────────────

export const TTL_TABLE: Record<string, number> = {
  anthropic: 240_000, // 240s
  "anthropic-1h": 3_300_000, // 55min
  openai: 240_000,
  gemini: 240_000,
};
export const DEFAULT_TTL = 240_000;

export function getTtl(providerId: string, has1hCache = false): number {
  if (has1hCache && providerId === "anthropic") return TTL_TABLE["anthropic-1h"]!;
  return TTL_TABLE[providerId] ?? DEFAULT_TTL;
}

// ── Worker runtime ─────────────────────────────────────────────────

export interface WorkerRuntimeDeps {
  settings: DispatchSettings;
  spawnSession: (input: SpawnChildInput) => Promise<{ childId: string; sessionId: string }>;
  killSession: (childId: string) => Promise<void>;
  /** Apply child worktree diff to parent */
  applyWorktreeDiff: (childId: string) => Promise<{ merged: number; conflicts: string[] }>;
  /** Get current time */
  now: () => number;
}

export function createWorkerRuntime(deps: WorkerRuntimeDeps) {
  const { settings, spawnSession, killSession, applyWorktreeDiff, now } = deps;
  const children = new Map<string, ChildSession>();
  const queue: string[] = []; // childIds waiting
  let running = 0;
  let childCounter = 0;

  async function spawnChild(input: SpawnChildInput): Promise<{ childId: string; sessionId: string }> {
    const childId = `child-${++childCounter}`;
    const result = await spawnSession({ ...input });
    const child: ChildSession = {
      childId: result.childId,
      sessionId: result.sessionId,
      parentSessionId: input.parentSessionId,
      role: input.role,
      status: "running",
      turnIndex: 0,
      lastToolAt: now(),
      startedAt: now(),
    };
    children.set(childId, child);
    running++;
    return { childId, sessionId: result.sessionId };
  }

  async function dispatch(
    role: string,
    task: string,
    options: { scope?: string[]; resolvedRole: ResolvedRole; parentSessionId: string },
  ): Promise<string> {
    const { resolvedRole } = options;
    const input: SpawnChildInput = {
      parentSessionId: options.parentSessionId,
      role,
      task,
      ...(options.scope ? { scope: options.scope } : {}),
      worktree: { mode: resolvedRole.definition.worktree === "none" ? "shared" : "isolated" },
      model: resolvedRole.model,
      tools: resolvedRole.definition.tools,
      permissions: {},
      systemPromptFragment: resolvedRole.definition.systemPromptFragment,
      budget: resolvedRole.definition.budget,
    };

    if (running >= settings.concurrency) {
      // Queue
      const childId = `child-${++childCounter}`;
      queue.push(childId);
      children.set(childId, {
        childId,
        sessionId: "",
        parentSessionId: options.parentSessionId,
        role,
        status: "queued",
        turnIndex: 0,
        lastToolAt: now(),
        startedAt: now(),
      });
      return `queued as ${childId}`;
    }

    const result = await spawnChild(input);
    return `dispatched ${result.childId} (${role})`;
  }

  async function wait(
    ids: string[] | undefined,
    timeoutMs: number | undefined,
  ): Promise<string> {
    const targetIds = ids ?? [...children.keys()];
    const ttl = timeoutMs ?? DEFAULT_TTL;
    const deadline = now() + ttl;

    // Check which are done
    const done: ChildSession[] = [];
    const runningChildren: ChildSession[] = [];
    const queuedChildren: ChildSession[] = [];

    for (const id of targetIds) {
      const child = children.get(id);
      if (!child) continue;
      if (child.status === "done" || child.status === "failed" || child.status === "killed") {
        done.push(child);
      } else if (child.status === "running") {
        runningChildren.push(child);
      } else if (child.status === "queued") {
        queuedChildren.push(child);
      }
    }

    // Wait for running ones (simplified — in real impl would poll or use events)
    const remaining = deadline - now();
    if (remaining > 0 && runningChildren.length > 0) {
      // In a real implementation, we'd wait for events
      // For now, just format the current state
    }

    return formatWaitResult(done, runningChildren, queuedChildren);
  }

  function formatWaitResult(
    done: ChildSession[],
    runningChildren: ChildSession[],
    queuedChildren: ChildSession[],
  ): string {
    const lines: string[] = [];
    lines.push(`${done.length} done · ${runningChildren.length} running · ${queuedChildren.length} queued`);

    for (const c of done) {
      const conclusion = c.result?.conclusion.split("\n")[0] ?? "completed";
      const files = c.result?.changedFiles.length ?? 0;
      const confidence = c.result?.confidence ?? 0;
      lines.push(`✔ ${c.childId} (${c.role}) — ${conclusion} · files: ${files} · confidence ${confidence} · trace get_output("${c.result?.traceHandle ?? c.childId}")`);
    }

    for (const c of runningChildren) {
      const ago = Math.floor((now() - c.lastToolAt) / 60_000);
      const stale = ago >= Math.floor(settings.staleAfterMs / 60_000);
      const staleNote = stale ? ` ⚠ no activity for ${ago} min` : "";
      lines.push(`… ${c.childId} (${c.role}) · ${c.turnIndex} steps · last activity ${ago} min ago${staleNote}`);
    }

    for (const c of queuedChildren) {
      lines.push(`⏳ ${c.childId} (${c.role}) · queued`);
    }

    return lines.join("\n");
  }

  async function merge(childId: string): Promise<string> {
    const child = children.get(childId);
    if (!child) return `unknown child: ${childId}`;
    if (child.status !== "done") return `child ${childId} is not done (status: ${child.status})`;

    const result = await applyWorktreeDiff(childId);
    if (result.conflicts.length > 0) {
      return `merge has conflicts in ${result.conflicts.length} files (markers left in place):\n${result.conflicts.join("\n")}\nResolve them with edit; no further merge step is needed.`;
    }
    return `merged ${result.merged} files`;
  }

  async function kill(childId: string): Promise<string> {
    const child = children.get(childId);
    if (!child) return `unknown child: ${childId}`;
    if (child.status === "queued") {
      // Remove from queue
      const idx = queue.indexOf(childId);
      if (idx >= 0) queue.splice(idx, 1);
      child.status = "killed";
      return `killed ${childId} (was queued)`;
    }
    await killSession(childId);
    child.status = "killed";
    running--;
    return `killed ${childId}`;
  }

  function getChildren(): ChildSession[] {
    return [...children.values()];
  }

  function updateChildProgress(childId: string, update: Partial<ChildSession>): void {
    const child = children.get(childId);
    if (child) {
      Object.assign(child, update);
      child.lastToolAt = now();
    }
  }

  function completeChild(childId: string, result: ChildResult): void {
    const child = children.get(childId);
    if (child) {
      child.status = "done";
      child.result = result;
      running--;
      // Promote next queued
      if (queue.length > 0 && running < settings.concurrency) {
        const nextId = queue.shift()!;
        const next = children.get(nextId);
        if (next) {
          next.status = "running";
          running++;
        }
      }
    }
  }

  async function killAllForParent(parentSessionId: string): Promise<void> {
    for (const child of children.values()) {
      if (child.parentSessionId === parentSessionId && child.status === "running") {
        await kill(child.childId);
      }
    }
  }

  return {
    spawnChild,
    dispatch,
    wait,
    merge,
    kill,
    getChildren,
    updateChildProgress,
    completeChild,
    killAllForParent,
  };
}

export type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;
