import { randomUUID } from "node:crypto";
import {
  DEFAULT_HARNESS_SETTINGS,
  formatRetrievalEvidenceText,
  HARNESS_MAX_REQUEST_TIMEOUT_MS,
  mergeHarnessSettings,
  normalizeFrozenHarnessPermissions,
  sliceUtf8ByBytes,
  type RetrievalArtifactRef,
  type RetrievalEvidence,
  type Thread,
  type ThreadMessagePeer,
  type ThreadMessageRecord,
  type ThreadParent,
  type ThreadReadWhat,
  type ThreadRun,
  type ThreadViewCursor,
} from "@piarium/protocol";
import { validateRetrievalEvidence } from "./retrieval-evidence.js";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import { EXECUTION_PRESETS } from "./presets.js";
import { resolveNestedThreadScope, type ThreadControlToolName } from "./thread-nesting.js";
import { ThreadRegistryError } from "./thread-registry.js";
import { ThreadRuntimeError } from "./thread-runtime.js";

interface ThreadSnapshot {
  thread: Thread;
  activeRun: ThreadRun | null;
}

const parentFor = (ctx: HarnessServiceContext): ThreadParent => ({ kind: "session", id: ctx.sessionId });

const resolveOwningContext = async (
  host: HarnessServiceHost,
  ctx: HarnessServiceContext,
): Promise<{ workspaceId: string; parent: ThreadParent; owner: Thread | null }> => {
  const registry = host.threadRegistry;
  let binding = null;
  try {
    binding = registry && typeof registry.getSessionBinding === "function"
      ? await registry.getSessionBinding(ctx.sessionId)
      : null;
  } catch (error) {
    if (error instanceof ThreadRegistryError && error.code === "stale-binding") {
      throw new HarnessServiceError("denied", error.message);
    }
    throw error;
  }
  if (binding) {
    const owner = typeof registry!.getThreadById === "function"
      ? await registry!.getThreadById(binding.owningWorkspaceId, binding.threadId)
      : null;
    if (!owner) {
      throw new HarnessServiceError("denied", "Thread session binding does not match a catalog Thread");
    }
    return {
      workspaceId: binding.owningWorkspaceId,
      parent: { kind: "thread", id: binding.threadId },
      owner,
    };
  }
  if (!ctx.workspaceId) throw new HarnessServiceError("unavailable", "Thread operations require a workspace");
  return { workspaceId: ctx.workspaceId, parent: parentFor(ctx), owner: null };
};

const assertOwnerTool = (owner: Thread | null, tool: ThreadControlToolName): void => {
  if (!owner) return;
  if (!owner.manifest.tools.includes(tool)) {
    throw new HarnessServiceError("denied", `Thread tool is not authorized: ${tool}`);
  }
};

const threadState = ({ thread, activeRun }: ThreadSnapshot): string => {
  if (thread.lifecycle === "archived") return "archived";
  if (thread.integration === "merged") return "merged";
  if (thread.integration === "conflict") return "conflict";
  if (thread.lifecycle === "queued") return "queued";
  if (thread.attention === "user" || thread.attention === "permission" || thread.attention === "thread") return "waiting-for-input";
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
  let line = `${icon} ${thread.id} (${thread.preset ?? "user thread"}) ${state}`;
  if (cursor && cursorChanged(snapshot, cursor)) line += " (changed)";
  if (full || !cursor || steps > 0) line += ` · ${full || !cursor ? steps : `+${steps}`} steps`;
  line += ` · last activity ${lastActivityAt}`;
  if (thread.waitingFor) line += `\n  ? waiting for ${thread.waitingFor.kind}: ${thread.waitingFor.text}`;
  if (thread.diffStats && (full || !cursor || JSON.stringify(thread.diffStats) !== JSON.stringify(cursor.diffStats))) {
    line += `\n  Δ ${thread.diffStats.files} files (+${thread.diffStats.insertions} −${thread.diffStats.deletions})`;
  }
  if (thread.integrationBinding) {
    line += `\n  merge applicability: ${thread.integrationBinding.valid === false ? "stale" : thread.integrationBinding.mergeReady ? "ready" : "not ready"}`;
  }
  const childChecks = thread.verification?.childChecks;
  if (childChecks) {
    const exits = childChecks.commands.map((command) => command.exitCode ?? "pending").join(",");
    line += `\n  child checks r${childChecks.resultRevision}: ${childChecks.commands.length} commands exits ${exits || "none"} (${childChecks.binding})`;
  }
  const parentChecks = thread.verification?.parentChecks;
  if (parentChecks) {
    line += `\n  parent checks r${parentChecks.mergedResultRevision}: ${parentChecks.binding}`;
  }
  const review = thread.verification?.review;
  if (review && review.status !== "none") {
    line += `\n  review r${review.resultRevision}: ${review.status}${review.conclusion ? ` — ${review.conclusion}` : ""}`;
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
      // Task-centered dispatch (D-285): `preset` is optional. Without one the
      // child runs on the caller's model and the tools the worker resolved
      // from its own active set — clamped below to the owning Thread's frozen
      // allowlist. A preset freezes its declared tools; retrieval still
      // requires its configured slot (never the main model silently).
      const preset = params.preset === undefined
        ? null
        : EXECUTION_PRESETS[params.preset as keyof typeof EXECUTION_PRESETS] ?? null;
      if (params.preset !== undefined && !preset) {
        throw new HarnessServiceError("invalid-params", `Unknown preset: ${params.preset}. Available presets: ${Object.keys(EXECUTION_PRESETS).join(", ")}`);
      }
      if (preset?.id === "retrieval" && !params.model) {
        throw new HarnessServiceError("unavailable", "retrieval is not configured; models.retrievalAgent is empty");
      }
      if (!preset && !params.model) {
        throw new HarnessServiceError("invalid-params", "A preset-less dispatch must resolve the caller's current model");
      }
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "dispatch");
      // The execution budget is shared per root task (3.18C): a nested
      // dispatch inherits the owning Thread's frozen budget rather than
      // multiplying capacity by parent level.
      const concurrency = owner?.manifest.concurrency ?? params.concurrency ?? registry.maxConcurrency;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new HarnessServiceError("invalid-params", "Thread concurrency must be a positive integer");
      }
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      let captured: Awaited<ReturnType<NonNullable<HarnessServiceHost["threadCaptureDraftBaseline"]>>> = {
        draftBaselineId: null,
        cleanup: async () => undefined,
      };
      if (inputContext.source === "surface") {
        if (!host.threadCaptureDraftBaseline) {
          if (inputContext.snapshot.status === "unavailable" && inputContext.dirtyPaths.length === 0) {
            captured = { draftBaselineId: null, cleanup: async () => undefined };
          } else {
            throw new HarnessServiceError("unavailable", "Thread draft capture is not configured");
          }
        } else {
          try {
            captured = await host.threadCaptureDraftBaseline(ctx.sessionId, workspaceId, inputContext);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new HarnessServiceError("unavailable", message);
          }
        }
      }
      let isQueued: boolean;
      try {
        isQueued = await registry.countActiveInRoot(workspaceId, parent) >= concurrency;
      } catch (error) {
        await captured.cleanup().catch(() => undefined);
        throw error;
      }
      const nestedScope = resolveNestedThreadScope(owner?.manifest.scope ?? [], params.scope);
      if (!nestedScope.ok) {
        await captured.cleanup().catch(() => undefined);
        throw new HarnessServiceError(
          "denied",
          `Thread scope cannot expand the parent Run authorization: ${nestedScope.expanded.join(", ")}`,
        );
      }
      // A preset's declared tool set is its fixed contract; the Host validates
      // and freezes it wholesale (§9.2.2). A preset-less dispatch instead
      // inherits the caller's ordinary capabilities, so its claimed set must
      // stay inside the owning Run's frozen allowlist; a root session's
      // worker-resolved set is its own tools, which it already holds.
      const tools = preset?.tools ?? params.tools ?? [];
      if (owner && !preset) {
        const denied = tools.filter((tool) => !owner.manifest.tools.includes(tool));
        if (denied.length > 0) {
          await captured.cleanup().catch(() => undefined);
          throw new HarnessServiceError(
            "denied",
            `Thread tools cannot exceed the parent Run authorization: ${denied.join(", ")}`,
          );
        }
      }
      // `shared` is an explicit opt-in only; write-capable work defaults to an
      // isolated WorkingState materialized on demand (D-285).
      const worktree = params.worktree === "shared"
        ? "shared" as const
        : captured.draftBaselineId || (preset?.id === "retrieval" && parent.kind === "thread")
          ? "isolated" as const
          : preset?.worktree === "none" ? "none" as const : "isolated" as const;
      // `inherit` fixes the parent's committed input at dispatch time; a queued
      // Thread never re-reads later parent state (D-285.4 / 3.18B).
      let inheritedContext: import("@piarium/protocol").ThreadInheritedContext | undefined;
      if (params.input === "inherit") {
        const parentSessionId = parent.kind === "session"
          ? parent.id
          : (await registry.getActiveRun(workspaceId, parent.id))?.sessionId;
        if (!parentSessionId || !host.threadCaptureInputContext) {
          await captured.cleanup().catch(() => undefined);
          throw new HarnessServiceError("unavailable", "Parent input capture is not available for an inherit dispatch");
        }
        const material = await host.threadCaptureInputContext({ sessionId: parentSessionId });
        if (material) {
          inheritedContext = {
            fromSessionId: parentSessionId,
            capturedAt: new Date().toISOString(),
            text: material.text,
            anchors: material.anchors,
          };
        }
      }
      const input = {
        workspaceId,
        parent,
        brief: params.task,
        ...(preset ? { preset: preset.id } : {}),
        ...(params.input === "inherit" ? { inputOrigin: "inherit" as const } : {}),
        ...(inheritedContext ? { inheritedContext } : {}),
        kind: "implementation" as const,
        createdBy: "agent" as const,
        concurrency,
        autoRun: true,
        worktree,
        ...(captured.draftBaselineId ? { draftBaselineId: captured.draftBaselineId } : {}),
        tools,
        permissions: normalizeFrozenHarnessPermissions(owner?.manifest.permissions),
        ...(params.model ? { model: params.model } : {}),
        ...(preset?.systemPromptFragment ? { systemPromptFragment: preset.systemPromptFragment } : {}),
        ...(preset?.id === "retrieval" ? { carryBlocks: false } : {}),
        ...(nestedScope.scope.length > 0 ? { scope: nestedScope.scope } : {}),
      };
      let thread: Thread;
      try {
        thread = await registry.createThread(input);
      } catch (error) {
        await captured.cleanup().catch(() => undefined);
        throw error;
      }
      if (input.worktree === "isolated") {
        if (!host.threadPrepareIsolatedBranch) {
          await captured.cleanup().catch(() => undefined);
          await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
          throw new HarnessServiceError("unavailable", "Isolated thread baseline capture is not configured");
        }
        try {
          await host.threadPrepareIsolatedBranch({
            workspaceId,
            parent,
            threadId: thread.id,
            draftBaselineId: captured.draftBaselineId,
            signal: ctx.signal,
          });
        } catch (error) {
          await captured.cleanup().catch(() => undefined);
          await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
          if (error instanceof ThreadRuntimeError) {
            const code = error.code === "not-found"
              ? "not-found"
              : error.code === "invalid-request"
                ? "invalid-params"
                : "unavailable";
            throw new HarnessServiceError(code, error.message, error.retryable);
          }
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new HarnessServiceError("unavailable", error.message, true);
          }
          throw new HarnessServiceError(
            "unavailable",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        if (typeof registry.assertDispatchAllowed === "function") {
          await registry.assertDispatchAllowed(workspaceId, thread.id);
        }
      } catch (error) {
        await captured.cleanup().catch(() => undefined);
        await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
        throw error;
      }
      if (isQueued) {
        return {
          text: `queued as ${thread.id}${preset ? ` (${preset.id})` : ""} — concurrency is full`,
          threadId: thread.id,
          queued: true,
        };
      }
      let run: ThreadRun;
      try {
        run = await registry.startRun(workspaceId, thread.id);
      } catch (error) {
        await captured.cleanup().catch(() => undefined);
        await registry.deleteThread(workspaceId, parent, thread.id).catch(() => undefined);
        throw error;
      }
      void host.threadSpawnSession({ ...input, threadId: thread.id, runId: run.id }).catch(async (error) => {
        await registry.endRun(
          workspaceId,
          thread.id,
          run.id,
          "failure",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      });
      return { text: `dispatched ${thread.id}${preset ? ` (${preset.id})` : ""}`, threadId: thread.id, queued: false };
    },
  };
}

export function createThreadFactsSetService(host: HarnessServiceHost): HarnessService<"thread.facts.set"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || typeof registry.setPendingEvidence !== "function") {
        throw new HarnessServiceError("unavailable", "Thread registry is not configured");
      }
      const binding = await registry.getSessionBinding(ctx.sessionId).catch((error: unknown) => {
        if (error instanceof ThreadRegistryError && error.code === "stale-binding") {
          throw new HarnessServiceError("denied", error.message);
        }
        throw error;
      });
      if (!binding) {
        throw new HarnessServiceError("denied", "submit_facts is only available on a retrieval thread session");
      }
      const thread = typeof registry.getThreadById === "function"
        ? await registry.getThreadById(binding.owningWorkspaceId, binding.threadId)
        : null;
      if (!thread) {
        throw new HarnessServiceError("denied", "Thread session binding does not match a catalog Thread");
      }
      if (thread.preset !== "retrieval") {
        throw new HarnessServiceError("denied", "submit_facts is only available on a retrieval thread");
      }
      if (!thread.manifest.tools.includes("submit_facts")) {
        throw new HarnessServiceError("denied", "Thread tool is not authorized: submit_facts");
      }
      if (typeof params.question !== "string" || !params.question.trim()) {
        throw new HarnessServiceError("invalid-params", "submit_facts requires a question");
      }
      if (!Array.isArray(params.facts)) {
        throw new HarnessServiceError("invalid-params", "submit_facts requires a facts array");
      }
      const runId = binding.runId;
      const receiptAuthority = {
        owningWorkspaceId: binding.owningWorkspaceId,
        sessionId: ctx.sessionId,
        threadId: thread.id,
        runId,
      };
      let catalogCommitted = false;
      try {
        const evidence = await validateRetrievalEvidence({
          question: params.question,
          facts: params.facts,
          ...(params.unknowns ? { unknowns: params.unknowns } : {}),
          ...(params.attempted ? { attempted: params.attempted } : {}),
          frozenScope: thread.manifest.scope,
          ...(ctx.actor.workspaceScope ? { actorScope: ctx.actor.workspaceScope } : {}),
          brief: thread.brief,
          ...(host.readExploreFile ? { readFile: host.readExploreFile } : {}),
          actor: ctx.actor,
          signal: ctx.signal,
          ...(ctx.inputContext ? { inputContext: ctx.inputContext } : {}),
          outputStore: host.outputStore,
          sessionId: ctx.sessionId,
          receiptAuthority,
          ...(host.storeRetrievalArtifact
            ? { storeArtifact: (bytes) => host.storeRetrievalArtifact!(binding.owningWorkspaceId, bytes, receiptAuthority) }
            : {}),
          ...(host.lookupWebFetchReceipt
            ? { lookupReceipt: (receiptId, authority) => host.lookupWebFetchReceipt!(binding.owningWorkspaceId, authority, receiptId) }
            : {}),
        });
        try {
          await registry.setPendingEvidence(binding.owningWorkspaceId, thread.id, runId, evidence);
          catalogCommitted = true;
        } catch (error) {
          throw new HarnessServiceError(
            "denied",
            error instanceof Error ? error.message : String(error),
          );
        }
        await host.protectRetrievalEvidence?.({
          workspaceId: binding.owningWorkspaceId,
          threadId: thread.id,
          runId,
          evidence,
          receiptAuthority,
        });
        return { text: formatRetrievalEvidenceText(evidence), evidence };
      } finally {
        if (!catalogCommitted) {
          await host.releaseRetrievalTemporaryArtifacts?.(
            binding.owningWorkspaceId,
            receiptAuthority,
          ).catch(() => undefined);
        }
      }
    },
  };
}

export function createThreadListService(host: HarnessServiceHost): HarnessService<"thread.list"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "threads");
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
          preset: thread.preset,
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
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "wait");
      const observer = ctx.sessionId;
      const timeoutMs = Math.min(
        params.timeoutMs ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000),
        HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000,
      );
      // A Thread caller also watches its own record: inbound replies and
      // messages land on it and complete dependency waits (3.18C).
      const selfSnapshot = async (): Promise<ThreadSnapshot | null> => {
        if (!owner) return null;
        const self = await registry.getThreadById(workspaceId, owner.id);
        if (!self) return null;
        return { thread: self, activeRun: await registry.getActiveRun(workspaceId, self.id) };
      };
      // The caller's own record changes count too — but only relative to this
      // wait's start, so a first-time wait does not return instantly.
      const selfCursorFor = (snapshot: ThreadSnapshot): ThreadViewCursor => ({
        eventSeq: snapshot.thread.eventSeq,
        lifecycle: snapshot.thread.lifecycle,
        attention: snapshot.thread.attention,
        integration: snapshot.thread.integration,
        activeRunId: snapshot.thread.activeRunId,
        workerState: snapshot.activeRun?.workerState ?? null,
        outcome: snapshot.activeRun?.outcome ?? null,
        progressVersion: 0,
        decisionsCount: 0,
        diffStats: snapshot.thread.diffStats,
        viewedAt: snapshot.thread.updatedAt,
      });
      const selfBaseline = await selfSnapshot();
      let selfCursor: ThreadViewCursor | null = selfBaseline === null ? null : selfCursorFor(selfBaseline);
      const hasChanges = async (): Promise<boolean> => {
        const snapshots = await snapshotsFor(host, workspaceId, parent, true);
        const ids = params.ids ?? snapshots.map(({ thread }) => thread.id);
        if (snapshots.some((snapshot) => (
          ids.includes(snapshot.thread.id)
          && cursorChanged(snapshot, registry.getCursor(observer, snapshot.thread.id))
        ))) return true;
        const self = await selfSnapshot();
        return self !== null && selfCursor !== null && cursorChanged(self, selfCursor);
      };
      let timedOut = false;
      if (!await hasChanges()) {
        // A Thread blocked here waits on real dependencies — it relinquishes
        // its model execution slot so queued work in the same root can run
        // (3.18C). The mark precedes the subscription: it publishes a registry
        // change itself, so the self baseline is refreshed and the wait never
        // wakes on its own yield mark.
        let markedYield = false;
        if (owner) {
          const current = await registry.getThreadById(workspaceId, owner.id).catch(() => null);
          if (current?.attention === "none") {
            const marked = await registry.setAttention(workspaceId, owner.id, "thread", {
              kind: "thread",
              text: params.ids?.length ? `Waiting on ${params.ids.join(", ")}` : "Waiting for thread changes",
            }).catch(() => null);
            if (marked?.waitingFor?.kind === "thread") {
              markedYield = true;
              const self = await selfSnapshot();
              if (self) selfCursor = selfCursorFor(self);
            }
          }
        }
        let wake!: (reason: "change") => void;
        const changed = new Promise<"change">((resolve) => { wake = resolve; });
        // Children changes wake through the caller-as-parent scope; replies,
        // sibling activity, and self-marks wake through the caller's own
        // parent scope.
        const unsubscribers = [registry.subscribeToChanges(workspaceId, parent, () => wake("change"))];
        if (owner) unsubscribers.push(registry.subscribeToChanges(workspaceId, owner.parent, () => wake("change")));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const elapsed = new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const aborted = new Promise<"abort">((resolve) => {
          if (ctx.signal.aborted) resolve("abort");
          else ctx.signal.addEventListener("abort", () => resolve("abort"), { once: true });
        });
        try {
          // The re-check covers anything that landed between the first check
          // and the subscription, including during the yield mark itself.
          if (!await hasChanges()) {
            const reason = await Promise.race([changed, elapsed, aborted]);
            if (reason === "abort") throw new DOMException("Thread wait aborted", "AbortError");
            timedOut = reason === "timeout" && !await hasChanges();
          }
        } finally {
          if (timeout) clearTimeout(timeout);
          for (const unsubscribe of unsubscribers) unsubscribe();
          // Re-admit the slot only if our yield mark is still the wait in
          // force — a review gate or request wake placed meanwhile survives.
          if (markedYield && owner) {
            const current = await registry.getThreadById(workspaceId, owner.id).catch(() => null);
            if (current?.waitingFor?.kind === "thread" && current.waitingFor.review === undefined) {
              await registry.setAttention(workspaceId, owner.id, "none").catch(() => undefined);
            }
          }
        }
      }
      // Messages held while the caller waited flush at this normal boundary.
      if (owner && host.threadSendToSession) {
        const held = await registry.takePendingThreadMessages(workspaceId, owner.id).catch(() => []);
        for (const heldMessage of held) {
          await host.threadSendToSession(ctx.sessionId, heldMessage.text, {
            from: messagePeerLabel(heldMessage.from),
            ...(heldMessage.kind === "request" ? { requestId: heldMessage.id } : {}),
          }).catch(() => undefined);
        }
      }
      const all = await snapshotsFor(host, workspaceId, parent, true);
      const ids = params.ids ?? all.map(({ thread }) => thread.id);
      const targets = all.filter(({ thread }) => ids.includes(thread.id));
      const self = await selfSnapshot();
      if (self && cursorChanged(self, registry.getCursor(observer, self.thread.id))) targets.push(self);
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
          lines.push(`✔ ${thread.id} (${thread.preset ?? "unknown"}) — ${thread.report.conclusion.split("\n")[0] ?? "completed"}`);
          lines.push(`  files: ${thread.report.changedFiles.join(", ") || "(none)"} · confidence ${thread.report.confidence}`);
          lines.push(`  deviations from brief: ${thread.report.deviations.join("; ") || "none"}`);
          lines.push(`  unresolved: ${thread.report.unresolved.join("; ") || "none"} · notes: read_thread("${thread.id}") · trace: read_thread("${thread.id}", "steps")`);
        } else {
          lines.push(`✔ ${thread.id} (${thread.preset ?? "unknown"}) — ${threadState(snapshot)}`);
        }
      }
      for (const snapshot of [...running, ...waiting]) {
        lines.push(formatThreadLine(snapshot, registry.getCursor(observer, snapshot.thread.id), false));
      }
      for (const snapshot of queued) {
        lines.push(`⏳ ${snapshot.thread.id} (${snapshot.thread.preset ?? "unknown"}) · queued`);
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

const messagePeerLabel = (peer: ThreadMessagePeer): string => (
  peer.kind === "thread" ? `thread ${peer.id}`
    : peer.kind === "user" ? "the user"
      : "the parent agent"
);

const peerEquals = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

const continueError = (error: unknown): never => {
  if (error instanceof ThreadRuntimeError) {
    const code = error.code === "not-found"
      ? "not-found"
      : error.code === "conflict" || error.code === "invalid-request"
        ? "invalid-params"
        : "unavailable";
    throw new HarnessServiceError(code, error.message, error.retryable);
  }
  throw error;
};

export function createThreadSendService(host: HarnessServiceHost): HarnessService<"thread.send"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry || !host.threadSendToSession) throw new HarnessServiceError("unavailable", "Thread runtime is not configured");
      const { workspaceId, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "send");
      const kind = params.kind ?? "inform";
      if (params.context !== undefined && kind !== "request") {
        throw new HarnessServiceError(
          "invalid-params",
          "context only applies to an execution request (kind: \"request\")",
        );
      }
      if (params.to === "parent" && params.threadId !== undefined) {
        throw new HarnessServiceError("invalid-params", "to: \"parent\" and threadId are mutually exclusive");
      }
      if (params.to !== "parent" && params.threadId === undefined) {
        throw new HarnessServiceError("invalid-params", "send requires a threadId or to: \"parent\"");
      }
      // Sender identity is Host-derived from the session binding — a caller
      // can never claim to be the user or another Thread (3.18C).
      const fromPeer: ThreadMessagePeer = owner
        ? { kind: "thread", id: owner.id }
        : params.from === "user"
          ? { kind: "user", id: ctx.sessionId }
          : { kind: "session", id: ctx.sessionId };
      const fromLabel = messagePeerLabel(fromPeer);

      // Resolve the target: own parent, or a relationship-bound Thread.
      let targetSessionId: string | null = null;
      let target: Thread | null = null;
      if (params.to === "parent") {
        if (!owner) throw new HarnessServiceError("invalid-params", "A root session has no parent to send to");
        if (owner.parent.kind === "session") targetSessionId = owner.parent.id;
        else {
          target = await registry.getThreadById(workspaceId, owner.parent.id);
          if (!target) throw new HarnessServiceError("not-found", `Thread not found: ${owner.parent.id}`);
        }
      } else {
        const candidate = await registry.getThreadById(workspaceId, params.threadId!);
        if (!candidate) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
        // Reachability follows actual root-task relationships, not shared
        // workspace membership: children, the parent, and same-parent
        // siblings for a Thread caller; direct children for a session.
        const related = owner
          ? (candidate.parent.kind === "thread" && candidate.parent.id === owner.id)
            || (owner.parent.kind === "thread" && owner.parent.id === candidate.id)
            || peerEquals(candidate.parent, owner.parent)
          : candidate.parent.kind === "session" && candidate.parent.id === ctx.sessionId;
        if (!related) {
          throw new HarnessServiceError("denied", `Thread is outside the caller's root-task relationships: ${candidate.id}`);
        }
        target = candidate;
      }

      const requestId = params.requestId ?? `msg-${randomUUID().slice(0, 8)}`;
      const recordedAt = new Date().toISOString();
      const deliveryOf = (status: ThreadMessageRecord["status"]): "delivered" | "held" | "scheduled" => (
        status === "pending" ? "scheduled" : status === "held" ? "held" : "delivered"
      );

      // Idempotent retry: a recorded request returns its outcome instead of
      // delivering or scheduling again (3.18C).
      if (params.requestId !== undefined) {
        const priorIn = target?.messages?.find((m) => m.direction === "in" && m.id === params.requestId);
        const priorOut = owner?.messages?.find((m) => m.direction === "out" && m.id === params.requestId);
        const prior = priorIn ?? priorOut;
        if (prior) {
          return {
            accepted: true,
            lifecycle: target?.lifecycle ?? "active",
            attention: target?.attention ?? "none",
            messageId: prior.id,
            delivery: deliveryOf(prior.status),
            ...(prior.runId ? { runId: prior.runId } : {}),
          };
        }
      }

      const recordInbound = (status: ThreadMessageRecord["status"], runId?: string) => (
        registry.recordThreadMessage(workspaceId, target!.id, {
          id: requestId,
          direction: "in",
          from: fromPeer,
          to: { kind: "thread", id: target!.id },
          kind,
          text: params.message,
          ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
          status,
          ...(runId !== undefined ? { runId } : {}),
          at: recordedAt,
        })
      );
      const recordOutbound = (status: ThreadMessageRecord["status"], runId?: string) => (
        owner
          ? registry.recordThreadMessage(workspaceId, owner.id, {
              id: requestId,
              direction: "out",
              from: fromPeer,
              to: target ? { kind: "thread", id: target.id } : { kind: "session", id: targetSessionId! },
              kind,
              text: params.message,
              ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
              status,
              ...(runId !== undefined ? { runId } : {}),
              at: recordedAt,
            })
          : Promise.resolve(null)
      );
      // A replyTo resolves the matching request on both ledgers: the caller's
      // inbound copy and the target's outstanding dependency.
      const resolveReply = async (): Promise<boolean> => {
        if (params.replyTo === undefined) return false;
        let satisfied = false;
        if (owner) {
          const mine = owner.messages?.find((m) => m.direction === "in" && m.id === params.replyTo && m.status !== "resolved");
          if (mine) await registry.patchThreadMessage(workspaceId, owner.id, params.replyTo, { status: "resolved" });
        }
        const theirs = target?.messages?.find((m) => m.direction === "out" && m.id === params.replyTo && m.status !== "resolved");
        if (theirs) {
          await registry.patchThreadMessage(workspaceId, target!.id, params.replyTo, { status: "resolved" });
          satisfied = true;
        }
        return satisfied;
      };

      // Session target — the caller Thread's parent session. Sessions carry
      // no message ledger; delivery goes straight to the input boundary.
      if (targetSessionId !== null) {
        await host.threadSendToSession(targetSessionId, params.message, {
          from: fromLabel,
          ...(kind === "request" ? { requestId } : {}),
        });
        await recordOutbound("delivered");
        return { accepted: true, lifecycle: "active", attention: "none", messageId: requestId, delivery: "delivered" };
      }
      const thread = target!;
      if (thread.lifecycle === "archived") {
        throw new HarnessServiceError("unavailable", `Thread is archived: ${thread.id}`);
      }
      if (thread.deletion) {
        throw new HarnessServiceError("unavailable", `Thread is being deleted: ${thread.id}`);
      }
      const dependencySatisfied = await resolveReply();

      if (thread.lifecycle === "queued") {
        // Held messages flush into the first Run's prompt at dequeue.
        await recordInbound("pending");
        await recordOutbound(kind === "request" ? "pending" : "delivered");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "scheduled" };
      }

      const run = await registry.getActiveRun(workspaceId, thread.id);
      const lostWorker = thread.lifecycle === "active"
        && (run?.outcome === "lost" || run?.workerState === "lost");

      if (thread.lifecycle === "settled" || lostWorker) {
        if (kind === "inform") {
          // Notifications never resurrect finished work; they ride the next
          // Run's input when one is requested (3.18C).
          await recordInbound("held");
          await recordOutbound("delivered");
          return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "held" };
        }
        if (!host.threadContinueRun) {
          throw new HarnessServiceError("unavailable", "Thread runtime is not configured for continuation");
        }
        // Record first so a retry cannot double-schedule while the Run starts.
        await recordInbound("pending");
        await recordOutbound("pending");
        let continued: { runId?: string };
        try {
          continued = await host.threadContinueRun({
            workspaceId,
            parent: thread.parent,
            threadId: thread.id,
            mode: params.context ?? "continue",
            task: params.message,
            requestId,
            from: fromPeer,
          });
        } catch (error) {
          return continueError(error);
        }
        if (continued.runId === undefined) {
          return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "scheduled" };
        }
        await registry.patchThreadMessage(workspaceId, thread.id, requestId, { status: "delivered", runId: continued.runId });
        if (owner) {
          await registry.patchThreadMessage(workspaceId, owner.id, requestId, { status: "delivered", runId: continued.runId }).catch(() => undefined);
        }
        return { accepted: true, lifecycle: "active", attention: "none", runId: continued.runId, messageId: requestId, delivery: "delivered" };
      }

      // lifecycle === "active" with a live or starting Run.
      if (!run || run.workerState === "exited" || (run.workerState === "running" && !run.sessionId)) {
        // Mid-settle or pre-bind: hold until the next normal input boundary.
        await recordInbound("held");
        await recordOutbound("delivered");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "held" };
      }
      if (run.workerState === "starting" && !run.sessionId) {
        // The Run's prompt is still being built; the message flushes into it.
        await recordInbound("pending");
        await recordOutbound("delivered");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "scheduled" };
      }

      const waiting = thread.waitingFor;
      const deliver = async (): Promise<void> => {
        // Held messages flush first so the session sees them in order.
        const held = await registry.takePendingThreadMessages(workspaceId, thread.id, requestId);
        for (const heldMessage of held) {
          await host.threadSendToSession!(run.sessionId!, heldMessage.text, {
            from: messagePeerLabel(heldMessage.from),
            ...(heldMessage.kind === "request" ? { requestId: heldMessage.id } : {}),
          });
        }
        await host.threadSendToSession!(run.sessionId!, params.message, {
          from: fromLabel,
          ...(kind === "request" ? { requestId } : {}),
        });
      };

      if (kind === "inform" && !dependencySatisfied && waiting !== null) {
        // A waiting Thread keeps waiting: ordinary notifications record for
        // the next boundary instead of waking the model (3.18C).
        await recordInbound("held");
        await recordOutbound("delivered");
        return { accepted: true, lifecycle: thread.lifecycle, attention: thread.attention, messageId: requestId, delivery: "held" };
      }
      await deliver();
      await recordInbound("delivered");
      await recordOutbound("delivered");
      // A request supersedes a dependency wait; a satisfying reply completes
      // the wait it was bound to. User/permission waits stay — a person is
      // still owed an answer.
      let attention = thread.attention;
      if (waiting?.kind === "thread" && (kind === "request" || dependencySatisfied)) {
        const updated = await registry.setAttention(workspaceId, thread.id, "none");
        attention = updated?.attention ?? "none";
      }
      return {
        accepted: true,
        lifecycle: "active",
        attention,
        runId: run.id,
        messageId: requestId,
        delivery: "delivered",
      };
    },
  };
}

export function createThreadReadService(host: HarnessServiceHost): HarnessService<"thread.read"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "read_thread");
      const thread = await registry.getThread(workspaceId, parent, params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      const run = await registry.getActiveRun(workspaceId, thread.id);
      const what: ThreadReadWhat = params.what ?? "blocks";
      const lines: string[] = [];
      if (what === "blocks") {
        lines.push(`Thread ${thread.id} (${thread.preset ?? "unknown"}) — ${threadState({ thread, activeRun: run })}`);
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
        const report = thread.report;
        if (report.evidence) {
          let visibleBytes = DEFAULT_HARNESS_SETTINGS.output.visibleBytes;
          try {
            const settings = await host.harnessSettings?.(workspaceId);
            const asRecord = (value: unknown): Record<string, unknown> => (
              value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
            );
            if (settings) {
              visibleBytes = mergeHarnessSettings(
                asRecord(asRecord(settings.global).harness),
                settings.projectTrusted ? asRecord(asRecord(settings.project).harness) : {},
              ).output.visibleBytes;
            }
          } catch {
            // The established default remains the display budget when settings are unavailable.
          }
          const page = await readRetrievalReportPage({
            host,
            workspaceId,
            heading: `Thread ${thread.id} (${thread.preset ?? "unknown"}) — Report`,
            evidence: report.evidence,
            offset: params.offset ?? 0,
            length: params.length ?? visibleBytes,
          });
          return {
            text: page.text,
            report,
            transcriptRef: report.transcriptRef,
            nextOffset: page.nextOffset,
            eof: page.eof,
          };
        } else {
          lines.push(`Thread ${thread.id} (${thread.preset ?? "unknown"}) — Report`);
          lines.push(`Conclusion: ${report.conclusion}`);
          lines.push(`Changed files: ${report.changedFiles.join(", ") || "(none)"}`);
          lines.push(`Deviations from brief: ${report.deviations.join("; ") || "none"}`);
          lines.push(`Unresolved: ${report.unresolved.join("; ") || "none"}`);
          lines.push(`Confidence: ${report.confidence}`);
        }
        const full = lines.join("\n");
        if (params.offset !== undefined || params.length !== undefined) {
          const slice = sliceUtf8ByBytes(full, params.offset ?? 0, params.length ?? 32_768);
          return {
            text: slice.text,
            report,
            transcriptRef: report.transcriptRef,
            nextOffset: slice.nextOffset,
            eof: slice.eof,
          };
        }
        return { text: full, report, transcriptRef: report.transcriptRef, eof: true };
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
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "merge");
      const thread = await registry.getThread(workspaceId, parent, params.threadId);
      if (!thread) throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      const selectedRevision = params.resultRevision ?? thread.resultRevision;
      const alreadyMerged = selectedRevision !== undefined
        ? thread.mergedResultRevision === selectedRevision
        : Boolean(thread.worktree?.resultCommit && thread.mergedCommit === thread.worktree.resultCommit);
      if (thread.integration === "merged" && alreadyMerged) {
        return {
          text: `thread ${thread.id} is already merged`,
          merged: 0,
          conflicts: [],
          ...(selectedRevision === undefined ? {} : { resultRevision: selectedRevision }),
        };
      }
      const run = await registry.getActiveRun(workspaceId, thread.id);
      // A native WorkingBranch owns the default merge source.  A legacy Git
      // resultCommit is only importable before that branch exists; it must not
      // mask a failed native publish or an old Run's revision.
      const hasPublishedResult = thread.workBranchId
        ? selectedRevision !== undefined
        : Boolean(thread.worktree?.resultCommit);
      if (thread.lifecycle !== "settled" || !run?.outcome) {
        return { text: `thread ${thread.id} is not complete (state: ${thread.lifecycle}/${run?.outcome ?? "none"})`, merged: 0, conflicts: [] };
      }
      if (!hasPublishedResult) throw new HarnessServiceError("unavailable", `Thread ${thread.id} has no published result to merge`);
      if (host.requireThreadMergeJournal && !ctx.actor.runId) {
        throw new HarnessServiceError("unavailable", "Thread integration requires an active parent turn recovery binding");
      }
      let sourceOwner: { ownerId: string; generation: number } | undefined;
      if (ctx.inputContext?.source === "surface") {
        const resolved = host.agentInputSurfaceOwner?.(ctx.sessionId, ctx.inputContext);
        if (!resolved) {
          throw new HarnessServiceError("unavailable", "The originating document surface for this turn is no longer available");
        }
        sourceOwner = { ownerId: resolved.ownerId, generation: resolved.generation };
      }
      const result = await host.threadApplyWorktreeDiff(
        workspaceId,
        parent,
        thread.id,
        params.resultRevision,
        ctx.actor.runId,
        {
          ...(sourceOwner ? { sourceOwner } : {}),
          ...(params.expectedBindingFingerprint ? { expectedBindingFingerprint: params.expectedBindingFingerprint } : {}),
          ...(params.resolutions ? { resolutions: params.resolutions } : {}),
          signal: ctx.signal,
        },
      );
      const appliedRevision = result.resultRevision ?? selectedRevision;
      const appliedDraftPaths = result.preview?.paths.filter((path) => (
        path.target === "surface" && path.phase === "surface-applied"
      )).map((path) => path.path) ?? [];
      const pendingSurfaceTargetPaths = result.preview
        ? result.preview.paths.filter((path) => (
            path.target === "surface" && path.phase !== "surface-applied" && path.phase !== "skipped-identical"
          )).map((path) => path.path)
        : result.surfaceTargetPaths ?? [];
      const surfacePending = pendingSurfaceTargetPaths.length > 0;
      if (result.conflicts.length > 0 || result.status === "conflict" || result.status === "compensated" || result.status === "needs-attention" || surfacePending) {
        if (!result.preview) {
          await registry.setIntegration(workspaceId, thread.id, "conflict", result.diffStats);
        }
        const surfaceTargetPaths = result.surfaceTargetPaths ?? [];
        const resolution: string[] = [];
        if (pendingSurfaceTargetPaths.length > 0) {
          resolution.push(`Editor draft paths still require attention: ${pendingSurfaceTargetPaths.join(", ")}. Reopen the originating surface or resolve those paths before retrying.`);
        }
        if (result.status === "needs-attention") {
          resolution.push("Some paths could not be restored automatically. Inspect the integration operation and resolve them before retrying.");
        } else if (result.status === "compensated") {
          resolution.push("Merge failed unexpectedly; changes were safely compensated.");
        } else if (result.conflictState === "markers") {
          resolution.push("Conflict markers placed in the parent. Resolve those paths; no further merge step is needed.");
        } else if (surfaceTargetPaths.length === 0) {
          resolution.push(result.appliedPaths?.length
            ? "The listed paths were written; conflicting paths require a version choice. The published child result is retained."
            : "The parent was left unchanged. The published child result is retained; resolve conflicting paths, then retry merge.");
        }
        const lines = [
          result.conflicts.length > 0
            ? `merge could not apply ${result.conflicts.length} files cleanly:`
            : `merge encountered failure (${result.status}):`,
          ...result.conflicts,
        ];
        if (result.appliedPaths && result.appliedPaths.length > 0) {
          lines.push(`written paths (${result.appliedPaths.length}): ${result.appliedPaths.join(", ")}`);
        }
        if (appliedDraftPaths.length > 0) lines.push(`Editor drafts updated without saving: ${appliedDraftPaths.join(", ")}. Disk-based commands still read the saved files.`);
        lines.push(...resolution);
        return {
          text: lines.join("\n"),
          merged: result.appliedPaths?.length ?? 0,
          conflicts: result.conflicts,
          status: result.status ?? "conflict",
          ...(result.appliedPaths ? { appliedPaths: result.appliedPaths } : {}),
          ...(surfaceTargetPaths.length > 0 ? { surfaceTargetPaths } : {}),
          ...(result.preview ? { preview: result.preview } : {}),
          ...(appliedRevision === undefined ? {} : { resultRevision: appliedRevision }),
          ...(result.operationId ? { operationId: result.operationId } : {}),
        };
      }
      if (!result.preview) {
        await registry.setIntegration(
          workspaceId,
          thread.id,
          "merged",
          result.diffStats,
          appliedRevision === undefined ? thread.worktree?.resultCommit : undefined,
          appliedRevision,
        );
      }
      return {
        text: [
          `merged ${result.merged} files from ${appliedRevision === undefined ? "the fixed Git result" : `result revision ${appliedRevision}`}: ${result.changedFiles?.join(", ") ?? ""}`,
          ...(appliedDraftPaths.length > 0 ? [`Editor drafts updated without saving: ${appliedDraftPaths.join(", ")}. Disk-based commands still read the saved files.`] : []),
        ].join("\n"),
        merged: result.merged,
        conflicts: [],
        status: "applied",
        ...(result.appliedPaths ? { appliedPaths: result.appliedPaths } : {}),
        ...(appliedDraftPaths.length > 0 ? { surfaceTargetPaths: appliedDraftPaths } : {}),
        ...(appliedRevision === undefined ? {} : { resultRevision: appliedRevision }),
        ...(result.operationId ? { operationId: result.operationId } : {}),
      };
    },
  };
}

type RetrievalReportSegment =
  | { kind: "text"; bytes: Buffer; byteLength: number }
  | { kind: "artifact"; artifact: RetrievalArtifactRef; byteLength: number };

const retrievalReportSegments = (heading: string, evidence: RetrievalEvidence): RetrievalReportSegment[] => {
  const segments: RetrievalReportSegment[] = [];
  const includedArtifacts = new Set<string>();
  const text = (value: string): void => {
    const bytes = Buffer.from(value, "utf8");
    segments.push({ kind: "text", bytes, byteLength: bytes.byteLength });
  };
  const artifact = (ref: RetrievalArtifactRef): void => {
    if (includedArtifacts.has(ref.hash)) {
      text(`\n    [artifact ${ref.hash} already included]`);
      return;
    }
    includedArtifacts.add(ref.hash);
    text(`\n    <evidence-artifact hash="${ref.hash}" bytes="${ref.byteLength}">\n`);
    segments.push({ kind: "artifact", artifact: ref, byteLength: ref.byteLength });
    text("\n    </evidence-artifact>");
  };

  text(`${heading}\nQuestion: ${evidence.question}\nScope: ${evidence.scope.join(", ") || "(workspace)"}\nCompletion: ${evidence.completion}\nFacts (${evidence.facts.length}):`);
  for (const fact of evidence.facts) {
    text(`\n- [${fact.status}] ${fact.claim}`);
    for (const source of fact.sources) {
      if (source.kind === "local") {
        const range = source.startLine !== undefined && source.endLine !== undefined
          ? `:${source.startLine}-${source.endLine}`
          : "";
        const revision = source.revision ? ` @${source.revision}` : "";
        const origin = source.origin ? ` (${source.origin})` : "";
        const check = source.check ? ` ${source.check}` : "";
        text(`\n  ${source.path ?? "?"}${range}${revision}${origin}${check}`);
      } else if (source.kind === "url") {
        text(`\n  ${source.url ?? "?"}${source.receiptId ? ` receipt ${source.receiptId}` : ""}`);
      } else {
        text(`\n  ${source.artifact ? `output artifact ${source.artifact.hash}` : `output ${source.outputRef?.handle ?? "?"}`}`);
      }
      if (source.excerpt !== undefined) {
        text(`\n${source.excerpt.split("\n").map((line) => `    ${line}`).join("\n")}`);
      } else if (source.artifact) {
        artifact(source.artifact);
      }
    }
  }
  if (evidence.unknowns.length > 0) {
    text(`\nUnknowns:${evidence.unknowns.map((item) => `\n- ${item}`).join("")}`);
  }
  if (evidence.attempted.length > 0) {
    text(`\nAttempted:${evidence.attempted.map((item) => (
      `\n- ${item.action}: ${item.outcome}${item.detail ? ` (${item.detail})` : ""}`
    )).join("")}`);
  }
  return segments;
};

const readRetrievalReportPage = async (input: {
  host: HarnessServiceHost;
  workspaceId: string;
  heading: string;
  evidence: RetrievalEvidence;
  offset: number;
  length: number;
}): Promise<{ text: string; nextOffset: number; eof: boolean }> => {
  const segments = retrievalReportSegments(input.heading, input.evidence);
  const total = segments.reduce((sum, segment) => sum + segment.byteLength, 0);
  const requestedOffset = Math.min(Math.max(0, Math.floor(input.offset)), total);
  const requestedLength = Number.isFinite(input.length)
    ? Math.max(1, Math.floor(input.length))
    : total;
  const windowStart = Math.max(0, requestedOffset - 3);
  const windowEnd = Math.min(total, requestedOffset + requestedLength + 3);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const segmentStart = cursor;
    const segmentEnd = cursor + segment.byteLength;
    cursor = segmentEnd;
    if (segmentEnd <= windowStart || segmentStart >= windowEnd) continue;
    const start = Math.max(0, windowStart - segmentStart);
    const end = Math.min(segment.byteLength, windowEnd - segmentStart);
    if (segment.kind === "text") {
      chunks.push(segment.bytes.subarray(start, end));
      continue;
    }
    if (!input.host.readRetrievalArtifactSlice) {
      throw new HarnessServiceError("unavailable", "Retrieval artifact paging is not configured");
    }
    const bytes = await input.host.readRetrievalArtifactSlice(
      input.workspaceId,
      segment.artifact,
      start,
      end - start,
    );
    if (!bytes || bytes.byteLength !== end - start) {
      throw new HarnessServiceError("unavailable", `Retrieval evidence artifact is unavailable: ${segment.artifact.hash}`);
    }
    chunks.push(bytes);
  }
  const window = Buffer.concat(chunks);
  const sliced = sliceUtf8ByBytes(window, requestedOffset - windowStart, requestedLength);
  const nextOffset = windowStart + sliced.nextOffset;
  return { text: sliced.text, nextOffset, eof: nextOffset >= total };
};

const compareThreadsStable = (
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number => {
  const byCreated = left.createdAt.localeCompare(right.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
};

const cascadeStopDescendants = async (
  host: HarnessServiceHost,
  workspaceId: string,
  threadId: string,
  keepWorktree: boolean,
  reason: string,
): Promise<void> => {
  const registry = host.threadRegistry!;
  const children = (await registry.listThreads(workspaceId, { kind: "thread", id: threadId }, true))
    .toSorted(compareThreadsStable);
  for (const child of children) {
    await cascadeStopDescendants(host, workspaceId, child.id, keepWorktree, reason);
    if (host.threadKillSession) await host.threadKillSession(child.id, keepWorktree, workspaceId);
    await registry.cancelThread(workspaceId, child.id, reason);
  }
};

export function createThreadKillService(host: HarnessServiceHost): HarnessService<"thread.kill"> {
  return {
    handle: async (params, ctx) => {
      const registry = host.threadRegistry;
      if (!registry) throw new HarnessServiceError("unavailable", "Thread registry not configured");
      const { workspaceId, parent, owner } = await resolveOwningContext(host, ctx);
      assertOwnerTool(owner, "kill");
      const thread = await registry.getThread(workspaceId, parent, params.threadId);
      if (!thread) return { text: `unknown thread: ${params.threadId}` };
      const keepWorktree = params.keepWorktree ?? false;
      const releaseCascade = !host.threadKillSession && typeof registry.beginCascade === "function"
        ? await registry.beginCascade(workspaceId, thread.id)
        : () => undefined;
      try {
        if (host.threadKillSession) {
          await host.threadKillSession(thread.id, keepWorktree, workspaceId);
        } else {
          await cascadeStopDescendants(host, workspaceId, thread.id, keepWorktree, "killed by parent");
        }
        await registry.cancelThread(workspaceId, thread.id, "killed by parent");
      } finally {
        releaseCascade();
      }
      return { text: `killed ${thread.id}${keepWorktree ? " (worktree kept)" : ""}` };
    },
  };
}
