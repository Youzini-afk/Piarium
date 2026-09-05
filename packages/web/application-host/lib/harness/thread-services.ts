import {
  HARNESS_MAX_REQUEST_TIMEOUT_MS,
  type Thread,
  type ThreadParent,
  type ThreadReadWhat,
  type ThreadRun,
  type ThreadViewCursor,
} from "@piarium/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { ROLE_DEFINITIONS } from "./roles.js";

interface ThreadSnapshot {
  thread: Thread;
  activeRun: ThreadRun | null;
}

const parentFor = (ctx: HarnessServiceContext): ThreadParent => ({ kind: "session", id: ctx.sessionId });

const workspaceFor = (ctx: HarnessServiceContext): string => {
  if (!ctx.workspaceId) throw new HarnessServiceError("unavailable", "Thread operations require a workspace");
  return ctx.workspaceId;
};

const threadState = ({ thread, activeRun }: ThreadSnapshot): string => {
  if (thread.lifecycle === "archived") return "archived";
  if (thread.integration === "merged") return "merged";
  if (thread.integration === "conflict") return "conflict";
  if (thread.lifecycle === "queued") return "queued";
  if (thread.attention === "user" || thread.attention === "permission") return "waiting-for-input";
  if (thread.attention === "stalled" || thread.attention === "looping") return thread.attention;
  if (thread.lifecycle === "settled") {
    if (thread.integration === "merge-ready" && activeRun?.outcome === "success") return "merge-ready";
    if (activeRun?.outcome === "success") return "done";
    return activeRun?.outcome ?? "settled";
  }
  if (activeRun?.workerState === "lost") return "worker-lost";
  if (activeRun?.workerState === "starting" || activeRun?.workerState === "running") return activeRun.workerState;
  return "idle";
};

const cursorChanged = ({ thread, activeRun }: ThreadSnapshot, cursor: ThreadViewCursor | null): boolean => (
  !cursor
  || cursor.eventSeq !== thread.eventSeq
  || cursor.lifecycle !== thread.lifecycle
  || cursor.attention !== thread.attention
  || cursor.integration !== thread.integration
  || cursor.activeRunId !== thread.activeRunId
  || cursor.workerState !== (activeRun?.workerState ?? null)
  || cursor.outcome !== (activeRun?.outcome ?? null)
);

const formatThreadLine = (snapshot: ThreadSnapshot, cursor: ThreadViewCursor | null, full: boolean): string => {
  const { thread, activeRun } = snapshot;
  const state = threadState(snapshot);
  const icon = state === "done" || state === "merged" ? "✔"
    : state === "failure" || state === "cancelled" || state === "lost" || state === "conflict" ? "✘"
    : state === "queued" || state === "starting" ? "⏳"
    : state === "waiting-for-input" ? "?"
    : state === "stalled" ? "!"
    : state === "looping" ? "↻"
    : "…";
  const steps = activeRun?.steps ?? 0;
  const lastActivityAt = activeRun?.lastActivityAt ?? thread.updatedAt;
  let line = `${icon} ${thread.id} (${thread.role ?? "user thread"}) ${state}`;
  if (cursor && cursorChanged(snapshot, cursor)) line += " (changed)";
  if (full || !cursor || steps > 0) line += ` · ${full || !cursor ? steps : `+${steps}`} steps`;
  line += ` · last activity ${lastActivityAt}`;
  if (thread.waitingFor) line += `\n  ? waiting for ${thread.waitingFor.kind}: ${thread.waitingFor.text}`;
  if (thread.diffStats && (full || !cursor || JSON.stringify(thread.diffStats) !== JSON.stringify(cursor.diffStats))) {
    line += `\n  Δ ${thread.diffStats.files} files (+${thread.diffStats.insertions} −${thread.diffStats.deletions})`;
  }
  return line;
};

const advanceCursor = (
  observerSessionId: string,
  snapshot: ThreadSnapshot,
  registry: NonNullable<HarnessServiceHost["threadRegistry"]>,
  expectedEpoch?: number,
): void => {
  const { thread, activeRun } = snapshot;
  registry.setCursor(observerSessionId, thread.id, {
    eventSeq: thread.eventSeq,
    lifecycle: thread.lifecycle,
    attention: thread.attention,
    integration: thread.integration,
    activeRunId: thread.activeRunId,
    workerState: activeRun?.workerState ?? null,
    outcome: activeRun?.outcome ?? null,
    progressVersion: 0,
    decisionsCount: 0,
    diffStats: thread.diffStats,
    viewedAt: new Date().toISOString(),
  }, expectedEpoch);
};

const deferCursorAdvancement = (
  ctx: HarnessServiceContext,
  observerSessionId: string,
  snapshots: readonly ThreadSnapshot[],
  registry: NonNullable<HarnessServiceHost["threadRegistry"]>,
): void => {
  const expectedEpoch = registry.getCursorEpoch(observerSessionId);
  const commit = () => {
    for (const snapshot of snapshots) advanceCursor(observerSessionId, snapshot, registry, expectedEpoch);
  };
  if (ctx.deferResponseDelivery) ctx.deferResponseDelivery(commit, () => undefined);
  else commit();
};

const snapshotsFor = async (
  host: HarnessServiceHost,
  workspaceId: string,
  parent: ThreadParent,
  includeHidden = false,
): Promise<ThreadSnapshot[]> => {
  const registry = host.threadRegistry!;
  return registry.listThreadSnapshots(workspaceId, parent, includeHidden);
};

export function createThreadDispatchService(host: HarnessServiceHost): HarnessService<"thread.dispatch"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadSpawnSession) {
        throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      }
      const role = ROLE_DEFINITIONS[params.role as keyof typeof ROLE_DEFINITIONS];
      if (!role) {
        throw new HarnessServiceError("invalid-params", `Unknown role: ${params.role}. Available roles: ${Object.keys(ROLE_DEFINITIONS).join(", ")}`);
      }
      const workspaceId = workspaceFor(ctx);
      const parent = parentFor(ctx);
      const concurrency = params.concurrency ?? registry.maxConcurrency;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new HarnessServiceError("invalid-params", "Thread concurrency must be a positive integer");
      }
      const isQueued = await registry.countActive(workspaceId, parent) >= concurrency;
      const input = {
        workspaceId,
        parent,
        brief: params.task,
        role: params.role,
        kind: "implementation" as const,
        createdBy: "agent" as const,
        concurrency,
        autoRun: true,
        worktree: role.worktree === "none" ? "none" as const
          : role.worktree === "shared" ? "shared" as const
          : "isolated" as const,
        tools: role.tools,
        permissions: {},
        ...(params.model ? { model: params.model } : {}),
        systemPromptFragment: role.systemPromptFragment,
        ...(params.scope ? { scope: params.scope } : {}),
      };
      const thread = await registry.createThread(input);
      if (isQueued) {
        return {
          text: `queued as ${thread.id} (${params.role}) — concurrency is full`,
          threadId: thread.id,
          queued: true,
        };
      }
      const run = await registry.startRun(workspaceId, thread.id);
      void host.threadSpawnSession({ ...input, threadId: thread.id, runId: run.id }).catch(async (error) => {
        await registry.endRun(
          workspaceId,
          thread.id,
          run.id,
          "failure",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      });
      return { text: `dispatched ${thread.id} (${params.role})`, threadId: thread.id, queued: false };
    },
  };
}

export function createThreadListService(host: HarnessServiceHost): HarnessService<"thread.list"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const workspaceId = workspaceFor(ctx);
      const parent = parentFor(ctx);
      const observer = ctx.sessionId;
      let snapshots = await snapshotsFor(host, workspaceId, parent);
      if (params.ids) snapshots = snapshots.filter(({ thread }) => params.ids!.includes(thread.id));
      const full = params.full ?? false;
      let changed = 0;
      const cursorUpdates: ThreadSnapshot[] = [];
      const lines = snapshots.map((snapshot) => {
        const cursor = registry.getCursor(observer, snapshot.thread.id);
        if (full || cursorChanged(snapshot, cursor)) {
          changed += 1;
          const line = formatThreadLine(snapshot, cursor, full);
          if (!full) cursorUpdates.push(snapshot);
          return line;
        }
        return `${snapshot.thread.id} — no change since last view; still ${threadState(snapshot)}, last activity ${snapshot.activeRun?.lastActivityAt ?? snapshot.thread.updatedAt}`;
      });
      const header = changed === 0 && snapshots.length > 0
        ? "no changes since last view; use wait to block instead of polling"
        : `${snapshots.length} threads · ${changed} changed since last view`;
      deferCursorAdvancement(ctx, observer, cursorUpdates, registry);
      return {
        text: snapshots.length === 0 ? "no threads" : `${header}\n${lines.join("\n")}`,
        threads: snapshots.map(({ thread, activeRun }) => ({
          id: thread.id,
          lifecycle: thread.lifecycle,
          attention: thread.attention,
          integration: thread.integration,
          brief: thread.brief,
          createdAt: thread.createdAt,
          role: thread.role,
          updatedAt: thread.updatedAt,
          activeRun,
          waitingFor: thread.waitingFor,
          diffStats: thread.diffStats,
        })),
      };
    },
  };
}

export function createThreadWaitService(host: HarnessServiceHost): HarnessService<"thread.wait"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const workspaceId = workspaceFor(ctx);
      const parent = parentFor(ctx);
      const observer = ctx.sessionId;
      const timeoutMs = Math.min(
        params.timeoutMs ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000),
        HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000,
      );
      const hasChanges = async (): Promise<boolean> => {
        const snapshots = await snapshotsFor(host, workspaceId, parent, true);
        const ids = params.ids ?? snapshots.map(({ thread }) => thread.id);
        return snapshots.some((snapshot) => (
          ids.includes(snapshot.thread.id)
          && cursorChanged(snapshot, registry.getCursor(observer, snapshot.thread.id))
        ));
      };
      let timedOut = false;
      if (!await hasChanges()) {
        let wake!: (reason: "change") => void;
        const changed = new Promise<"change">((resolve) => { wake = resolve; });
        const unsubscribe = registry.subscribeToChanges(workspaceId, parent, () => wake("change"));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const elapsed = new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const aborted = new Promise<"abort">((resolve) => {
          if (ctx.signal.aborted) resolve("abort");
          else ctx.signal.addEventListener("abort", () => resolve("abort"), { once: true });
        });
        try {
          const reason = await Promise.race([changed, elapsed, aborted]);
          if (reason === "abort") throw new DOMException("Thread wait aborted", "AbortError");
          timedOut = reason === "timeout" && !await hasChanges();
        } finally {
          if (timeout) clearTimeout(timeout);
          unsubscribe();
        }
      }
      const all = await snapshotsFor(host, workspaceId, parent, true);
      const ids = params.ids ?? all.map(({ thread }) => thread.id);
      const targets = all.filter(({ thread }) => ids.includes(thread.id));
      const done = targets.filter(({ thread }) => thread.lifecycle === "settled" || thread.lifecycle === "archived");
      const queued = targets.filter(({ thread }) => thread.lifecycle === "queued");
      const running = targets.filter(({ thread, activeRun }) => (
        thread.lifecycle === "active"
        && thread.attention !== "user"
        && thread.attention !== "permission"
        && (activeRun?.workerState === "starting" || activeRun?.workerState === "running")
      ));
      const occupied = new Set([...done, ...queued, ...running].map(({ thread }) => thread.id));
      const waiting = targets.filter(({ thread }) => !occupied.has(thread.id));
      const counts = `${done.length} done · ${running.length} running · ${waiting.length} waiting · ${queued.length} queued`;
      const lines = [timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s — ${counts}` : counts];
      for (const snapshot of done) {
        const { thread } = snapshot;
        if (thread.report) {
          lines.push(`✔ ${thread.id} (${thread.role ?? "unknown"}) — ${thread.report.conclusion.split("\n")[0] ?? "completed"}`);
          lines.push(`  files: ${thread.report.changedFiles.join(", ") || "(none)"} · confidence ${thread.report.confidence}`);
          lines.push(`  deviations from brief: ${thread.report.deviations.join("; ") || "none"}`);
          lines.push(`  unresolved: ${thread.report.unresolved.join("; ") || "none"} · notes: read_thread("${thread.id}") · trace: read_thread("${thread.id}", "steps")`);
        } else {
          lines.push(`✔ ${thread.id} (${thread.role ?? "unknown"}) — ${threadState(snapshot)}`);
        }
      }
      for (const snapshot of [...running, ...waiting]) {
        lines.push(formatThreadLine(snapshot, registry.getCursor(observer, snapshot.thread.id), false));
      }
      for (const snapshot of queued) {
        lines.push(`⏳ ${snapshot.thread.id} (${snapshot.thread.role ?? "unknown"}) · queued`);
      }
      deferCursorAdvancement(ctx, observer, targets, registry);
      return {
        text: lines.join("\n"),
        done: done.length,
        running: running.length,
        waiting: waiting.length,
        queued: queued.length,
        timedOut,
      };
    },
  };
}

export function createThreadSendService(host: HarnessServiceHost): HarnessService<"thread.send"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadSendToSession) throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      const workspaceId = workspaceFor(ctx);
      const thread = await registry.getThread(workspaceId, parentFor(ctx), params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      if (thread.lifecycle !== "active") {
        throw new HarnessServiceError("unavailable", `Thread is not active: ${params.threadId}`);
      }
      const run = await registry.getActiveRun(workspaceId, thread.id);
      if (!run?.sessionId || run.workerState !== "running") {
        throw new HarnessServiceError("unavailable", `Thread has no running session: ${params.threadId}`);
      }
      await host.threadSendToSession(run.sessionId, params.message, params.from);
      const updated = thread.attention === "user" || thread.attention === "permission"
        ? await registry.setAttention(workspaceId, thread.id, "none")
        : thread;
      return {
        accepted: true,
        lifecycle: updated?.lifecycle ?? thread.lifecycle,
        attention: updated?.attention ?? thread.attention,
      };
    },
  };
}

export function createThreadReadService(host: HarnessServiceHost): HarnessService<"thread.read"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const workspaceId = workspaceFor(ctx);
      const thread = await registry.getThread(workspaceId, parentFor(ctx), params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      const run = await registry.getActiveRun(workspaceId, thread.id);
      const what: ThreadReadWhat = params.what ?? "blocks";
      const lines: string[] = [];
      if (what === "blocks") {
        lines.push(`Thread ${thread.id} (${thread.role ?? "unknown"}) — ${threadState({ thread, activeRun: run })}`);
        lines.push(`Brief: ${thread.brief}`);
        lines.push(`Steps: ${run?.steps ?? 0} · Last activity: ${run?.lastActivityAt ?? thread.updatedAt}`);
        if (run?.lastToolCall) lines.push(`Last tool: ${run.lastToolCall.name} at ${run.lastToolCall.at}`);
        if (thread.waitingFor) lines.push(`Waiting for: ${thread.waitingFor.kind} — ${thread.waitingFor.text}`);
        if (thread.attention !== "none") lines.push(`Attention: ${thread.attention}`);
        if (run?.workerState === "lost") lines.push("Run: worker-lost");
        if (thread.report?.blocksSnapshot) {
          for (const [label, content] of Object.entries(thread.report.blocksSnapshot)) {
            lines.push(`\n[${label}]`);
            lines.push(content);
          }
        }
        return { text: lines.join("\n"), report: null, transcriptRef: null };
      }
      if (what === "report") {
        if (!thread.report) {
          return {
            text: `Thread ${thread.id} has no report yet (state: ${thread.lifecycle}/${thread.attention}/${thread.integration})`,
            report: null,
            transcriptRef: null,
          };
        }
        lines.push(`Thread ${thread.id} (${thread.role ?? "unknown"}) — Report`);
        lines.push(`Conclusion: ${thread.report.conclusion}`);
        lines.push(`Changed files: ${thread.report.changedFiles.join(", ") || "(none)"}`);
        lines.push(`Deviations from brief: ${thread.report.deviations.join("; ") || "none"}`);
        lines.push(`Unresolved: ${thread.report.unresolved.join("; ") || "none"}`);
        lines.push(`Confidence: ${thread.report.confidence}`);
        return { text: lines.join("\n"), report: thread.report, transcriptRef: thread.report.transcriptRef };
      }
      const since = params.since ?? 0;
      if (!thread.report) {
        return { text: `Thread ${thread.id} has no durable transcript reference yet`, report: null, transcriptRef: null };
      }
      if (!host.threadTranscriptReader) {
        throw new HarnessServiceError("unavailable", "Thread transcript reader is not configured");
      }
      return {
        text: await host.threadTranscriptReader.read(thread.report.transcriptRef, since),
        report: null,
        transcriptRef: thread.report.transcriptRef,
      };
    },
  };
}

export function createThreadMergeService(host: HarnessServiceHost): HarnessService<"thread.merge"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadApplyWorktreeDiff) throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      const workspaceId = workspaceFor(ctx);
      const thread = await registry.getThread(workspaceId, parentFor(ctx), params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      if (thread.integration === "merged" && (!thread.worktree?.resultCommit || thread.mergedCommit === thread.worktree.resultCommit)) {
        return { text: `thread ${thread.id} is already merged`, merged: 0, conflicts: [] };
      }
      const run = await registry.getActiveRun(workspaceId, thread.id);
      if (thread.lifecycle !== "settled" || run?.outcome !== "success") {
        return { text: `thread ${thread.id} is not complete (state: ${thread.lifecycle}/${run?.outcome ?? "none"})`, merged: 0, conflicts: [] };
      }
      const result = await host.threadApplyWorktreeDiff(workspaceId, parentFor(ctx), thread.id);
      if (result.conflicts.length > 0 || result.status === "compensated" || result.status === "needs-attention") {
        await registry.setIntegration(workspaceId, thread.id, "conflict", result.diffStats);
        const resolution = result.status === "needs-attention"
          ? "Merge failed and subsequent user edits were preserved; manual resolution required."
          : result.status === "compensated"
            ? "Merge failed unexpectedly; changes were safely compensated."
            : result.conflictState === "markers"
              ? "Conflict markers placed in the parent. Resolve those paths; no further merge step is needed."
              : "The parent was left unchanged and the child worktree was preserved. Resolve the parent changes, then retry merge.";
        const lines = [
          result.conflicts.length > 0
            ? `merge could not apply ${result.conflicts.length} files cleanly:`
            : `merge encountered failure (${result.status}):`,
          ...result.conflicts,
        ];
        if (result.appliedPaths && result.appliedPaths.length > 0) {
          lines.push(`applied cleanly (${result.appliedPaths.length}): ${result.appliedPaths.join(", ")}`);
        }
        lines.push(resolution);
        return {
          text: lines.join("\n"),
          merged: result.appliedPaths?.length ?? 0,
          conflicts: result.conflicts,
          status: result.status ?? "conflict",
          ...(result.appliedPaths ? { appliedPaths: result.appliedPaths } : {}),
        };
      }
      await registry.setIntegration(workspaceId, thread.id, "merged", result.diffStats, thread.worktree?.resultCommit);
      return {
        text: `merged ${result.merged} files: ${thread.report?.changedFiles.join(", ") ?? ""}`,
        merged: result.merged,
        conflicts: [],
        status: "applied",
        ...(result.appliedPaths ? { appliedPaths: result.appliedPaths } : {}),
      };
    },
  };
}

export function createThreadKillService(host: HarnessServiceHost): HarnessService<"thread.kill"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const workspaceId = workspaceFor(ctx);
      const thread = await registry.getThread(workspaceId, parentFor(ctx), params.threadId);
      if (!thread) return { text: `unknown thread: ${params.threadId}` };
      const keepWorktree = params.keepWorktree ?? true;
      if (!keepWorktree && thread.worktree) {
        throw new HarnessServiceError(
          "unavailable",
          "Stopping a thread without preserving its worktree is not implemented; retry with keep_worktree enabled",
        );
      }
      if (thread.lifecycle !== "queued" && host.threadKillSession) await host.threadKillSession(thread.id);
      await registry.cancelThread(workspaceId, thread.id, "killed by parent");
      return { text: `killed ${thread.id}${keepWorktree ? " (worktree kept)" : ""}` };
    },
  };
}
