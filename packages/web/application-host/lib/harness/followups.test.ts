import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it as vitestIt } from "vitest";
import type { ExperimentAttemptView } from "@piarium/protocol";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import { createFollowUpService, type FollowUpCaller, type FollowUpServiceDeps } from "./followups.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.PIARIUM_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "piarium-kernel.exe" : "piarium-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.PIARIUM_REQUIRE_RELEASE_KERNEL === "1") {
  throw new Error("Follow-up acceptance requires the release kernel");
}
const it = vitestIt.skipIf(!available);

const clients: KernelClient[] = [];
const roots: string[] = [];
const pause = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

interface ThreadStub {
  id: string;
  lifecycle: string;
  parent: { kind: "session"; id: string };
  activeRunId: string | null;
}

interface Harness {
  threads: Map<string, ThreadStub>;
  runs: Map<string, { id: string; workerState: string }>;
  continued: Array<{ threadId: string; task: string; requestId: string }>;
  parked: Array<{ threadId: string; requestId: string }>;
  informs: Array<{ sessionId: string; messageId: string; text: string }>;
  sessionRequests: Array<{ sessionId: string; messageId: string; text: string }>;
  ledger: Array<{ id: string; status: string }>;
  attention: Array<{ threadId: string; waitingFor: { kind: string; text: string } | null }>;
  goals: Map<string, { id: string; status: string; statusReason?: string | undefined }>;
  busy: Set<string>;
  attempts: Map<string, ExperimentAttemptView | null>;
  attemptListeners: Array<(workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void>;
  errors: Error[];
}

const attemptView = (overrides: Partial<ExperimentAttemptView> = {}): ExperimentAttemptView => ({
  attemptId: "attempt-1",
  specId: "spec-1",
  backend: "local",
  collection: "none",
  createdAt: Date.now(),
  state: "running",
  ...overrides,
});

async function fixture(options: { seed?: (harness: Harness) => void } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-followup-"));
  roots.push(root);
  const client = createKernelClient({
    hostId: "followup-test",
    storageRoot: path.join(root, "storage"),
    kernelPath,
    buildVersion,
    allowCargoDevRunner: false,
  });
  clients.push(client);
  await client.start();

  const harness: Harness = {
    threads: new Map(),
    runs: new Map(),
    continued: [],
    parked: [],
    informs: [],
    sessionRequests: [],
    ledger: [],
    attention: [],
    goals: new Map(),
    busy: new Set(),
    attempts: new Map(),
    attemptListeners: [],
    errors: [],
  };
  options.seed?.(harness);

  const deps: FollowUpServiceDeps = {
    client,
    getThread: async (_ws, threadId) => harness.threads.get(threadId) ?? null,
    getActiveRun: async (_ws, threadId) => {
      const thread = harness.threads.get(threadId);
      return thread?.activeRunId ? harness.runs.get(thread.activeRunId) ?? null : null;
    },
    continueRun: async (input) => {
      harness.continued.push({ requestId: input.requestId, task: input.task, threadId: input.threadId });
      return { runId: `run-${harness.continued.length}` };
    },
    enqueueContinuation: async (_ws, threadId, continuation) => {
      harness.parked.push({ requestId: continuation.requestId, threadId });
      return {};
    },
    notifySession: async (sessionId, text, messageId) => {
      harness.informs.push({ messageId, sessionId, text });
    },
    sessionRequest: async (sessionId, text, messageId) => {
      harness.sessionRequests.push({ messageId, sessionId, text });
    },
    sessionBusy: async (sessionId) => harness.busy.has(sessionId),
    recordDirectedMessage: async (_ws, message) => {
      harness.ledger.push({ id: message.id, status: message.status });
      return {};
    },
    setFollowUpAttention: async (_ws, threadId, waitingFor) => {
      harness.attention.push({ threadId, waitingFor });
      return {};
    },
    requestForSession: async (sessionId, method, params) => {
      if (method === "session.features.get") {
        const goal = harness.goals.get(sessionId);
        return goal ? { goal: { ...goal } } : {};
      }
      if (method === "session.features.mutate") {
        const mutation = (params as { mutation?: { goalId?: string; status?: string; statusReason?: string } }).mutation;
        const goal = harness.goals.get(sessionId);
        if (goal && mutation?.goalId === goal.id && mutation.status) {
          goal.status = mutation.status;
          goal.statusReason = mutation.statusReason;
        }
        return { applied: true };
      }
      return {};
    },
    subscribeAttempts: (listener) => {
      harness.attemptListeners.push(listener);
      return () => {
        const index = harness.attemptListeners.indexOf(listener);
        if (index >= 0) harness.attemptListeners.splice(index, 1);
      };
    },
    getAttempt: async (_ws, attemptId) => harness.attempts.get(attemptId) ?? null,
    onError: (error) => harness.errors.push(error),
  };
  const service = createFollowUpService(deps);
  return { client, harness, service };
}

const caller = (overrides: Partial<FollowUpCaller> = {}): FollowUpCaller => ({
  workspaceId: "ws",
  sessionId: "s-1",
  threadId: "t-1",
  runId: "r-1",
  ...overrides,
});
/** Session-scoped caller — no thread binding (root session). */
const sessionCaller = (): FollowUpCaller => ({ sessionId: "s-1", workspaceId: "ws" });

const settledThread = (): ThreadStub => ({
  activeRunId: null,
  id: "t-1",
  lifecycle: "settled",
  parent: { kind: "session", id: "s-1" },
});

const until = async (check: () => boolean | Promise<boolean>, ms = 4_000, errors?: Error[]): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  assert.ok(await check(), `condition did not hold; service errors: ${JSON.stringify(errors?.map((e) => e.message) ?? [])}`);
};

describe("follow-up service on the real kernel", () => {
  it("registers a durable wait, lists it, and fires a due time source on check", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "summarise what finished",
      source: { at: Date.now() + 60_000, kind: "time" },
    });
    assert.equal(registered.followUp.status, "waiting");
    assert.equal(registered.firedImmediately, false);
    assert.match(registered.followUp.id, /^fu-/);
    assert.equal(registered.followUp.threadId, "t-1");

    const listed = await f.service.list(caller(), {});
    assert.equal(listed.followUps.length, 1);
    assert.equal(listed.followUps[0]!.instruction, "summarise what finished");

    // Program check on a not-yet-due source stays waiting and calls nothing.
    const early = await f.service.check(caller(), { id: registered.followUp.id });
    assert.equal(early.fired, false);
    assert.equal(early.followUp.status, "waiting");
    assert.equal(f.harness.continued.length, 0);

    // Move the due time into the past via update, then check fires once.
    const updated = await f.service.update(caller(), {
      expectedRevision: registered.followUp.revision,
      id: registered.followUp.id,
      source: { at: Date.now() - 1_000, kind: "time" },
    });
    assert.equal(updated.followUp.status, "waiting");
    const fired = await f.service.check(caller(), { id: registered.followUp.id });
    assert.equal(fired.fired, true);

    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    // Settled thread → the normal continuation admission ran with the
    // occurrence id as the idempotent request identity.
    assert.equal(f.harness.continued.length, 1);
    assert.match(f.harness.continued[0]!.requestId, /^followup\.occurrence:occ-/);
    assert.match(f.harness.continued[0]!.task, /summarise what finished/);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 1);
    assert.equal(detail.occurrences[0]!.delivery, "continued");
    assert.equal(detail.occurrences[0]!.reason, "time-due");
  });

  it("armed timer fires once without a model call and replays idempotently", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "check in",
      source: { at: Date.now() + 60, kind: "time" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 1);

    // A second check after delivery must not fire again — the wait is spent.
    const again = await f.service.check(caller(), { id: registered.followUp.id });
    assert.equal(again.fired, false);
    assert.equal(f.harness.continued.length, 1);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 1);
  });

  it("experiment source: terminal at registration fires immediately; running attempt fires on the subscription", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.attempts.set("attempt-done", attemptView({ attemptId: "attempt-done", endedAt: Date.now(), exitCode: 0, state: "completed" }));
      h.attempts.set("attempt-live", attemptView({ attemptId: "attempt-live", state: "running" }));
    } });

    const done = await f.service.register(caller(), {
      instruction: "read results",
      source: { attemptId: "attempt-done", kind: "experiment" },
    });
    assert.equal(done.firedImmediately, true);
    await pause(200);
    assert.deepEqual(f.harness.errors.map((e) => e.message), []);
    await until(async () => (await f.service.get(caller(), { id: done.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);

    const live = await f.service.register(caller(), {
      instruction: "diagnose on failure",
      source: { attemptId: "attempt-live", kind: "experiment" },
    });
    assert.equal(live.firedImmediately, false);
    assert.equal(live.followUp.status, "waiting");

    for (const listener of [...f.harness.attemptListeners]) {
      listener("ws", "attempt-live", attemptView({ attemptId: "attempt-live", exitCode: 1, state: "failed" }));
    }
    await until(async () => (await f.service.get(caller(), { id: live.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 2);
    assert.match(f.harness.continued[1]!.task, /attempt-live/);
    assert.match(f.harness.continued[1]!.task, /failed/);
  });

  it("deadline fallback fires once and keeps the terminal wait armed", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.attempts.set("attempt-slow", attemptView({ attemptId: "attempt-slow", state: "running" }));
    } });
    const registered = await f.service.register(caller(), {
      instruction: "if still running, check progress",
      source: { attemptId: "attempt-slow", fallbackAt: Date.now() + 40, kind: "experiment" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).occurrences.length === 1);
    const afterDeadline = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(afterDeadline.followUp.status, "waiting"); // deadline does not finish the wait
    assert.equal(afterDeadline.occurrences[0]!.reason, "deadline");
    assert.equal(f.harness.continued.length, 1);

    // The attempt terminating afterwards still delivers the terminal fact.
    for (const listener of [...f.harness.attemptListeners]) {
      listener("ws", "attempt-slow", attemptView({ attemptId: "attempt-slow", exitCode: 0, state: "completed" }));
    }
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 2);
    assert.match(f.harness.continued[1]!.task, /experiment-terminal/);
  });

  it("cancel stops the wait; a late callback cannot revive it", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.attempts.set("attempt-x", attemptView({ attemptId: "attempt-x", state: "running" }));
    } });
    const registered = await f.service.register(caller(), {
      instruction: "follow up",
      source: { attemptId: "attempt-x", kind: "experiment" },
    });
    const cancelled = await f.service.cancel(caller(), { id: registered.followUp.id });
    assert.equal(cancelled.followUp.status, "cancelled");
    for (const listener of [...f.harness.attemptListeners]) {
      listener("ws", "attempt-x", attemptView({ attemptId: "attempt-x", state: "completed" }));
    }
    await pause(150);
    assert.equal(f.harness.continued.length, 0);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 0);
  });

  it("update enforces the CAS revision", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "original",
      source: { kind: "manual", note: "hold" },
    });
    await assert.rejects(
      f.service.update(caller(), {
        expectedRevision: "999",
        id: registered.followUp.id,
        instruction: "hijacked",
      }),
      /revision conflict/,
    );
    const updated = await f.service.update(caller(), {
      expectedRevision: registered.followUp.revision,
      id: registered.followUp.id,
      instruction: "revised",
    });
    assert.equal(updated.followUp.instruction, "revised");
  });

  it("routes delivery by lifecycle: active informs, queued parks, archived drops", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-active", {
        activeRunId: "r-live",
        id: "t-active",
        lifecycle: "active",
        parent: { kind: "session", id: "s-1" },
      });
      h.runs.set("r-live", { id: "r-live", workerState: "running" });
      h.threads.set("t-queued", {
        activeRunId: null,
        id: "t-queued",
        lifecycle: "queued",
        parent: { kind: "session", id: "s-1" },
      });
      h.threads.set("t-gone", {
        activeRunId: null,
        id: "t-gone",
        lifecycle: "archived",
        parent: { kind: "session", id: "s-1" },
      });
    } });

    const register = (threadId: string) => f.service.register(caller({ threadId }), {
      instruction: `resume ${threadId}`,
      source: { kind: "manual" },
    });
    const fire = async (id: string) => {
      await f.service.fire(caller(), { id });
      await until(async () => {
        const detail = await f.service.get(caller(), { id });
        return detail.occurrences.length === 1 && detail.occurrences[0]!.delivery !== undefined;
      });
      return f.service.get(caller(), { id });
    };

    const active = await fire((await register("t-active")).followUp.id);
    assert.equal(active.occurrences[0]!.delivery, "active-inform");
    assert.equal(f.harness.informs.length, 1);
    assert.equal(f.harness.ledger.length, 1);
    assert.equal(f.harness.ledger[0]!.id, active.occurrences[0]!.id);

    const queued = await fire((await register("t-queued")).followUp.id);
    assert.equal(queued.occurrences[0]!.delivery, "parked");
    assert.equal(f.harness.parked.length, 1);
    assert.match(f.harness.parked[0]!.requestId, /^followup\.occurrence:/);

    const gone = await fire((await register("t-gone")).followUp.id);
    assert.equal(gone.occurrences[0]!.delivery, "dropped");
    assert.equal(gone.followUp.status, "triggered");
  });

  it("root-session registrations deliver through the session request path", async () => {
    const f = await fixture(); // no thread binding at all
    const registered = await f.service.register(sessionCaller(), {
      instruction: "report back",
      source: { kind: "manual" },
    });
    assert.equal(registered.followUp.threadId, undefined);
    await f.service.fire(sessionCaller(), { id: registered.followUp.id });
    await until(async () => (await f.service.get(sessionCaller(), { id: registered.followUp.id })).followUp.status === "delivered");
    assert.equal(f.harness.sessionRequests.length, 1);
    assert.match(f.harness.sessionRequests[0]!.text, /report back/);
    assert.equal(f.harness.continued.length, 0);
  });

  it("a busy root session receives the trigger as an inform instead of a new run", async () => {
    const f = await fixture({ seed: (h) => h.busy.add("s-1") });
    const registered = await f.service.register(sessionCaller(), {
      instruction: "note this",
      source: { kind: "manual" },
    });
    await f.service.fire(sessionCaller(), { id: registered.followUp.id });
    await until(() => f.harness.informs.length === 1);
    assert.equal(f.harness.sessionRequests.length, 0);
  });

  it("pause marks follow-up attention and pauses the goal; delivery resumes it", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.goals.set("s-1", { id: "goal-1", status: "active" });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "continue the goal",
      pause: true,
      source: { kind: "manual" },
    });
    assert.equal(registered.followUp.pausedGoal, true);
    assert.equal(f.harness.goals.get("s-1")?.status, "paused");
    assert.equal(f.harness.goals.get("s-1")?.statusReason, "waiting");
    assert.ok(f.harness.attention.some((entry) => entry.waitingFor?.kind === "followup"));

    await f.service.fire(caller(), { id: registered.followUp.id });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.goals.get("s-1")?.status, "active");
    assert.ok(f.harness.attention.some((entry) => entry.waitingFor === null));
  });

  it("reconcile after restart fires an overdue wait once and redelivers a stuck triggered record", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "after restart",
      source: { at: Date.now() + 60_000, kind: "time" },
    });

    // Simulate a host that died: a second service over the same kernel store.
    const f2 = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    // Rewire the second harness onto the SAME kernel client storage.
    const service2 = createFollowUpService({
      client: f.client,
      getThread: async (_ws, threadId) => f2.harness.threads.get(threadId) ?? null,
      getActiveRun: async () => null,
      continueRun: async (input) => {
        f2.harness.continued.push({ requestId: input.requestId, task: input.task, threadId: input.threadId });
        return { runId: "run-restarted" };
      },
      enqueueContinuation: async () => ({}),
      notifySession: async () => {},
      sessionRequest: async () => {},
      sessionBusy: async () => false,
      recordDirectedMessage: async () => ({}),
      setFollowUpAttention: async () => ({}),
      requestForSession: async () => ({}),
      onError: (error) => f2.harness.errors.push(error),
    });
    // First reconcile while the wait is not yet due: re-arms, does not fire.
    await service2.reconcile("ws");
    await pause(80);
    assert.equal(f2.harness.continued.length, 0);

    // Push the due time into the past by rewriting the durable record directly
    // — a service update would re-arm this host's timer and fire it here, which
    // is not the restart path under test.
    const grant = await f.client.issueGrant({
      capabilities: ["storage.read", "storage.write", "storage.maintenance"],
      executionWorkspace: "ws",
      grantId: `test-rewrite-${Date.now()}`,
      owningWorkspace: "ws",
      pathScopes: [""],
    });
    const scoped = f.client.scoped(grant);
    const recordId = `followup.definition:${registered.followUp.id}`;
    const existing = await scoped.getRecord("ws", recordId);
    assert.ok(existing, "durable definition must exist");
    const payload = JSON.parse(existing.payloadJson) as { source: { at: number } };
    payload.source.at = Date.now() - 5_000;
    await scoped.putRecord({
      expectedRecordRevision: existing.recordRevision,
      operationId: `test-rewrite-${Date.now()}`,
      ownerIds: [],
      payloadJson: JSON.stringify(payload),
      recordId,
      recordType: "followup.definition",
      references: [],
      state: "waiting",
      workspaceId: "ws",
      ...(existing.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing.threadId ? { threadId: existing.threadId } : {}),
      ...(existing.runId ? { runId: existing.runId } : {}),
    });
    const service3 = createFollowUpService({
      client: f.client,
      getThread: async (_ws, threadId) => f2.harness.threads.get(threadId) ?? null,
      getActiveRun: async () => null,
      continueRun: async (input) => {
        f2.harness.continued.push({ requestId: input.requestId, task: input.task, threadId: input.threadId });
        return { runId: "run-restarted" };
      },
      enqueueContinuation: async () => ({}),
      notifySession: async () => {},
      sessionRequest: async () => {},
      sessionBusy: async () => false,
      recordDirectedMessage: async () => ({}),
      setFollowUpAttention: async () => ({}),
      requestForSession: async () => ({}),
      onError: (error) => f2.harness.errors.push(error),
    });
    await service3.reconcile("ws");
    await until(() => f2.harness.continued.length === 1, 4_000, f2.harness.errors);
    assert.match(f2.harness.continued[0]!.task, /after restart/);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.followUp.status, "delivered");
    assert.equal(detail.occurrences.length, 1);
    service2.dispose();
    service3.dispose();
  });
});
