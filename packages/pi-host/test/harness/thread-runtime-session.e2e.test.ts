import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createThreadRegistry } from "../../../web/application-host/lib/harness/thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../../../web/application-host/lib/harness/thread-runtime.js";
import { createThreadWorktreeRuntime } from "../../../web/application-host/lib/harness/thread-worktree.js";
import { IntegrationCoordinator } from "../../../web/application-host/lib/harness/working-state/integration-coordinator.js";
import { createWorkspaceWorkingStateAccess } from "../../../web/application-host/lib/harness/working-state/working-state-store.js";
import { createWorkspaceRecoveryEngine } from "../../../web/application-host/lib/recovery/engine.js";
import { SessionHost } from "../../src/session-host.js";

describe("thread runtime with real Pi sessions", () => {
  it("runs a persisted child and continues a user discussion through implementation conversion", async () => {
    const root = await mkdtemp(join(tmpdir(), "thread-real-session-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(workspace, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const faux = registerFauxProvider();
    faux.setResponses([
      () => fauxAssistantMessage("Child session completed the assigned check."),
      () => fauxAssistantMessage("The parent agrees that the existing seam should stay."),
      () => fauxAssistantMessage("Let's examine the seam tradeoffs before changing code."),
      () => fauxAssistantMessage("Implemented the approach agreed in the discussion."),
    ]);
    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        models: [{
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          cost: model.cost,
          id: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          name: model.name,
          reasoning: model.reasoning,
        }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };

    const parentHost = new SessionHost({ agentDir, configureServices, emit: () => {}, projectTrustOverride: true });
    const parent = await parentHost.create(workspace, "Parent");
    assert.ok(parent.sessionFile);
    const registry = createThreadRegistry({ dataDir: join(root, "data"), hostId: "host-1" });
    const childHosts = new Map<string, SessionHost>();
    const childSessionFiles = new Map<string, string>();
    let childRuntimeWorkspaceId: string | null = null;
    let childScope: string[] | undefined;
    let childInitialPrompt = "";
    const hostFor = (sessionId: string): SessionHost => {
      if (sessionId === parent.sessionId) return parentHost;
      const host = childHosts.get(sessionId);
      if (!host) throw new Error(`Unknown test session: ${sessionId}`);
      return host;
    };

    const createChildHost = (): SessionHost => {
      const emit = <E extends HostEvent>(event: E, data: HostEventData<E>): void => {
        const sessionId = child.sessionId;
        if (!sessionId) return;
        runtime.processEvent({
          kind: "host",
          sessionId,
          envelope: { kind: "event", event, data },
        });
      };
      const child = new SessionHost({ agentDir, configureServices, emit, projectTrustOverride: true });
      return child;
    };

    const sessions: ThreadSessionAdapter = {
      create: async (input) => {
        childRuntimeWorkspaceId = input.workspaceId;
        childScope = input.scope;
        const child = createChildHost();
        const created = await child.create(input.cwd, input.name, input.parentSession, input.tools, input.model);
        childHosts.set(created.sessionId, child);
        if (created.sessionFile) childSessionFiles.set(created.sessionId, created.sessionFile);
        return created;
      },
      open: async (input) => {
        const sessionFile = childSessionFiles.get(input.sessionId);
        if (!sessionFile) throw new Error(`Missing persisted child session file: ${input.sessionId}`);
        const child = createChildHost();
        const opened = await child.open({
          cwd: input.cwd,
          sessionFile,
          tools: input.tools,
          ...(input.model ? { model: input.model } : {}),
        });
        childHosts.set(opened.sessionId, child);
        if (opened.sessionFile) childSessionFiles.set(opened.sessionId, opened.sessionFile);
        return opened;
      },
      prompt: async (sessionId, text, instructions) => {
        childInitialPrompt = text;
        const result = await hostFor(sessionId).prompt(sessionId, text, undefined, instructions);
        if (!result.accepted) throw new Error("Child prompt was not accepted");
      },
      send: async (sessionId, text) => { await hostFor(sessionId).followUp(sessionId, text); },
      abort: async (sessionId) => { await hostFor(sessionId).abort(sessionId); },
      close: async (sessionId) => { await hostFor(sessionId).close(sessionId); },
      snapshot: async (sessionId) => ({
        ...hostFor(sessionId).snapshot(),
        workspace: { authorityId: "workspace-1", id: "workspace-1", kind: "workspace" },
      }),
      summary: (sessionId) => hostFor(sessionId).summary(sessionId),
      stats: async (sessionId) => hostFor(sessionId).stats(sessionId),
      entries: async (sessionId, scope = "branch") => hostFor(sessionId).entries(sessionId, scope),
    };

    const runtime = createThreadRuntime({
      registry,
      sessions,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => "runtime-workspace-1",
      readBlocks: async (sessionId) => sessionId === parent.sessionId
        ? [{ label: "plan", content: "- [ ] inspect the runtime" }]
        : [
            { label: "progress", content: "Focused check completed" },
            { label: "decisions", content: "Deviation: used the existing session adapter" },
          ],
      worktrees: {
        prepare: async ({ mode }) => mode === "isolated"
          ? { cwd: workspace, worktree: { path: workspace, base: "test-base" } }
          : { cwd: workspace, worktree: null },
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });

    try {
      const input = {
        workspaceId: "workspace-1",
        parent: { kind: "session" as const, id: parent.sessionId },
        brief: "Check the implementation",
        role: "check",
        kind: "implementation" as const,
        createdBy: "agent" as const,
        concurrency: 12,
        autoRun: true,
        worktree: "none" as const,
        model: { providerId: model.provider, modelId: model.id },
        tools: ["read"],
        scope: ["src"],
        permissions: {},
        systemPromptFragment: "Run a focused check.",
      };
      const thread = await registry.createThread(input);
      const run = await registry.startRun("workspace-1", thread.id);
      const child = await runtime.spawn({ ...input, threadId: thread.id, runId: run.id });
      assert.equal(childRuntimeWorkspaceId, "runtime-workspace-1");
      assert.deepEqual(childScope, ["src"]);
      assert.equal(hostFor(child.sessionId).header(child.sessionId)?.parentSession, parent.sessionFile);
      assert.deepEqual(hostFor(child.sessionId).snapshot().activeTools, ["read"]);
      assert.equal(hostFor(child.sessionId).snapshot().model?.id, model.id);
      assert.match(childInitialPrompt, /<parent-blocks/);
      assert.match(childInitialPrompt, /inspect the runtime/);
      await hostFor(child.sessionId).session.waitForIdle();
      await runtime.drain();

      const completed = await registry.getThread("workspace-1", input.parent, thread.id);
      assert.equal(completed?.lifecycle, "settled");
      assert.match(completed?.report?.conclusion ?? "", /completed the assigned check/);
      assert.deepEqual(completed?.report?.deviations, ["used the existing session adapter"]);
      assert.deepEqual(completed?.report?.blocksSnapshot, {
        progress: "Focused check completed",
        decisions: "Deviation: used the existing session adapter",
      });
      assert.equal(completed?.report?.transcriptRef.sessionId, child.sessionId);
      assert.equal((await registry.getActiveRun("workspace-1", thread.id))?.outcome, "success");

      const parentPrompt = await parentHost.prompt(parent.sessionId, "Should we keep the existing seam?");
      assert.equal(parentPrompt.accepted, true);
      await parentHost.session.waitForIdle();
      const parentEntries = parentHost.entries(parent.sessionId, "branch");
      const forkPoint = parentEntries.entries.findLast((entry) => (
        entry.type === "message" && entry.message.role === "assistant"
      ));
      assert.ok(forkPoint);

      const discussion = await runtime.createDiscussion({
        parentSessionId: parent.sessionId,
        entryId: forkPoint.id,
      });
      assert.equal(discussion.thread.kind, "discussion");
      assert.equal(discussion.thread.forkPoint?.entryId, forkPoint.id);
      assert.equal(discussion.thread.manifest.worktree, "none");
      assert.equal(discussion.thread.manifest.carryBlocks, true);
      assert.ok(discussion.activeRun.sessionId);
      assert.equal(hostFor(discussion.activeRun.sessionId).header(discussion.activeRun.sessionId)?.parentSession, parent.sessionFile);
      assert.ok(hostFor(discussion.activeRun.sessionId).snapshot().activeTools.every((tool) => (
        ["read", "grep", "find", "ls", "glob", "explore", "related", "recall", "webfetch", "websearch"].includes(tool)
      )));
      await hostFor(discussion.activeRun.sessionId).session.waitForIdle();
      await runtime.drain();
      const retainedDiscussion = await registry.getThread(
        "workspace-1",
        { kind: "session", id: parent.sessionId },
        discussion.thread.id,
      );
      assert.equal(retainedDiscussion?.lifecycle, "active");
      assert.equal(retainedDiscussion?.attention, "user");
      assert.equal(retainedDiscussion?.report, null);

      const converted = await runtime.convertDiscussion({
        parentSessionId: parent.sessionId,
        threadId: discussion.thread.id,
      });
      assert.equal(converted.thread.kind, "implementation");
      assert.equal(converted.activeRun.sessionId, discussion.activeRun.sessionId);
      assert.equal(converted.thread.manifest.worktree, "isolated");
      assert.ok(converted.thread.manifest.tools.includes("edit"));
      assert.ok(!converted.thread.manifest.tools.includes("dispatch"));
      assert.ok(converted.activeRun.sessionId);
      await hostFor(converted.activeRun.sessionId).session.waitForIdle();
      await runtime.drain();

      const implemented = await registry.getThread(
        "workspace-1",
        { kind: "session", id: parent.sessionId },
        discussion.thread.id,
      );
      const discussionRuns = await registry.listRuns("workspace-1", discussion.thread.id);
      assert.equal(implemented?.kind, "implementation");
      assert.equal(implemented?.lifecycle, "settled");
      assert.match(implemented?.report?.conclusion ?? "", /Implemented the approach agreed/);
      assert.equal(discussionRuns.length, 2);
      assert.equal(discussionRuns[0]?.exitReason, "converted to implementation");
      assert.equal(discussionRuns[1]?.outcome, "success");
      const continuedSessionFile = childSessionFiles.get(converted.activeRun.sessionId);
      assert.ok(continuedSessionFile);
      const continuedTranscript = hostFor(converted.activeRun.sessionId).readEntries(
        converted.activeRun.sessionId,
        continuedSessionFile,
        workspace,
        "branch",
      );
      const transcriptText = continuedTranscript.entries
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
        .flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
          ? entry.message.content.filter((part) => part.type === "text").map((part) => part.text)
          : [])
        .join("\n");
      assert.match(transcriptText, /examine the seam tradeoffs/);
      assert.match(transcriptText, /Implemented the approach agreed/);
    } finally {
      await runtime.dispose();
      for (const child of childHosts.values()) await child.dispose();
      await parentHost.dispose();
      await registry.dispose();
      faux.unregister();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("thread runtime with native working-state integration", () => {
  it("merges an explicitly selected old native result through a real parent Pi turn and undoes that turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "thread-native-integration-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const worktreeRoot = join(root, "thread-worktrees");
    const dataDir = join(root, "recovery-data");
    const workspaceId = "native-thread-workspace";
    const authorityInstanceId = "native-thread-authority";
    await mkdir(workspace, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ harness: { permissions: { mode: "bypass" } } }),
      "utf8",
    );

    const faux = registerFauxProvider();
    let parentHost: SessionHost | null = null;
    let router: ReturnType<typeof createHarnessRouter> | null = null;
    let parentExecutionId: string | undefined;
    let parentUserEntryId: string | undefined;
    let parentAssistantEntryId: string | undefined;
    let mergeToolResult: unknown;
    let mergeOperationId: string | undefined;
    const mergeExecutionIds: string[] = [];
    let turnStartSeen = false;
    let resolveTurnStart: (() => void) | undefined;
    let rejectTurnStart: ((error: unknown) => void) | undefined;
    let turnStartGate: Promise<void> = Promise.resolve();
    const childHosts = new Map<string, SessionHost>();
    const childSessionFiles = new Map<string, string>();
    const childRunIds = new Map<string, string>();
    let spawningRunId: string | undefined;

    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        models: [{
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          cost: model.cost,
          id: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          name: model.name,
          reasoning: model.reasoning,
        }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };

    const documents = {
      inspectWorkspace: async () => ({ root: workspace, workspaceId }),
      listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
      beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
      inspectDirtyBuffers: async () => [],
    };
    const recoveryEngine = createWorkspaceRecoveryEngine({
      authorityId: authorityInstanceId,
      dataDir,
      documents,
      sessionNavigation: {
        prepare: async (input) => {
          const entries = parentHost!.entries(input.sessionId, "branch").entries;
          const targetIndex = entries.findIndex((entry) => entry.id === input.entryId);
          return {
            expectedLeafId: entries.at(-1)?.id ?? null,
            removedEntryIds: entries.slice(targetIndex < 0 ? 0 : targetIndex).map((entry) => entry.id),
            targetLeafId: null,
          };
        },
        prepareLeaf: async () => ({ expectedLeafId: null, removedEntryIds: [], targetLeafId: null }),
        commit: async () => ({ alreadyApplied: false, markerId: "native-undo-marker", snapshot: {} }),
        commitLeaf: async () => ({ alreadyApplied: false, markerId: "native-undo-leaf-marker", snapshot: {} }),
      },
    });
    const workingStates = createWorkspaceWorkingStateAccess(recoveryEngine);
    const integrationCoordinator = new IntegrationCoordinator({ workingStates });
    const worktrees = createThreadWorktreeRuntime({
      createWorktree: async (_source, input) => {
        const target = join(worktreeRoot, String(input.worktreeName));
        await mkdir(target, { recursive: true });
        return { path: target };
      },
      getWorktreeBootstrapStatus: async () => ({
        status: "ready",
        phase: "setup-ready",
        error: null,
        updatedAt: Date.now(),
      }),
    });
    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "native-thread-host" });

    const hostFor = (sessionId: string): SessionHost => {
      if (sessionId === parentHost?.sessionId) return parentHost!;
      const host = childHosts.get(sessionId);
      if (!host) throw new Error(`Unknown native integration session: ${sessionId}`);
      return host;
    };

    const actorFor = (sessionId: string) => {
      if (sessionId === parentHost?.sessionId) {
        return {
          authorityInstanceId,
          sessionId,
          workerId: "native-parent-worker",
          workerGeneration: 1,
          ...(parentExecutionId ? { runId: parentExecutionId } : {}),
        } as const;
      }
      const runId = childRunIds.get(sessionId);
      if (!runId) return null;
      return {
        authorityInstanceId,
        sessionId,
        runId,
        workerId: `native-child-worker-${runId}`,
        workerGeneration: 1,
      } as const;
    };

    const configureParentRecoveryTurn = (executionId: string): void => {
      parentExecutionId = executionId;
      parentUserEntryId = undefined;
      parentAssistantEntryId = undefined;
      mergeToolResult = undefined;
      turnStartSeen = false;
      turnStartGate = new Promise<void>((resolve, reject) => {
        resolveTurnStart = resolve;
        rejectTurnStart = reject;
      });
    };

    const emitFrom = (sessionId: string, event: HostEvent, data: unknown): void => {
      if (event === "harness.request") {
        const actor = actorFor(sessionId);
        if (!actor) throw new Error(`Harness request has no registered actor: ${sessionId}`);
        void router!.processEvent({
          actor,
          kind: "host",
          envelope: { kind: "event", event: "harness.request", data },
        });
        return;
      }
      if (event === "agent.event") {
        const projected = (data as HostEventData<"agent.event">).event;
        if (sessionId === parentHost?.sessionId) {
          if (projected.type === "entry_appended" && projected.entry.type === "message") {
            if (projected.entry.message.role === "user" && parentExecutionId && !turnStartSeen) {
              turnStartSeen = true;
              parentUserEntryId = projected.entry.id;
              void recoveryEngine.recordTurnStart({
                activeWriterScopes: [],
                executionId: parentExecutionId,
                provenance: "caused-by",
                runtimeGeneration: 1,
                sessionId,
                userEntryId: projected.entry.id,
                workerId: "native-parent-worker",
                workspaceId,
              }).then((result) => {
                assert.equal(result.status, "ready");
                resolveTurnStart?.();
              }, (error) => rejectTurnStart?.(error));
            } else if (projected.entry.message.role === "assistant" && parentExecutionId) {
              parentAssistantEntryId = projected.entry.id;
            }
          }
          if (projected.type === "tool_execution_end" && projected.toolName === "merge") {
            mergeToolResult = projected.result;
          }
        } else {
          runtime!.processEvent({
            kind: "host",
            sessionId,
            envelope: { kind: "event", event: "agent.event", data },
          });
        }
      }
    };

    const createChildHost = (): SessionHost => {
      const child = new SessionHost({
        agentDir,
        configureServices,
        emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
          const sessionId = child.sessionId;
          if (!sessionId) return;
          emitFrom(sessionId, event, data);
        },
        projectTrustOverride: true,
      });
      return child;
    };

    const sessions: ThreadSessionAdapter = {
      create: async (input) => {
        if (!spawningRunId) throw new Error("Native child session was created without a Run id");
        const child = createChildHost();
        const created = await child.create(input.cwd, input.name, input.parentSession, input.tools, input.model);
        childHosts.set(created.sessionId, child);
        childRunIds.set(created.sessionId, spawningRunId);
        if (created.sessionFile) childSessionFiles.set(created.sessionId, created.sessionFile);
        return created;
      },
      open: async (input) => {
        const sessionFile = childSessionFiles.get(input.sessionId);
        if (!sessionFile) throw new Error(`Missing native child session file: ${input.sessionId}`);
        const child = createChildHost();
        const opened = await child.open({
          cwd: input.cwd,
          sessionFile,
          tools: input.tools,
          ...(input.model ? { model: input.model } : {}),
        });
        childHosts.set(opened.sessionId, child);
        if (opened.sessionFile) childSessionFiles.set(opened.sessionId, opened.sessionFile);
        return opened;
      },
      prompt: async (sessionId, text, instructions) => {
        const result = await hostFor(sessionId).prompt(sessionId, text, undefined, instructions);
        if (!result.accepted) throw new Error(`Native child prompt was not accepted: ${sessionId}`);
      },
      send: async (sessionId, text) => { await hostFor(sessionId).followUp(sessionId, text); },
      abort: async (sessionId) => { await hostFor(sessionId).abort(sessionId); },
      close: async (sessionId) => { await hostFor(sessionId).close(sessionId); },
      snapshot: async (sessionId) => hostFor(sessionId).snapshot(),
      summary: async (sessionId) => hostFor(sessionId).summary(sessionId),
      stats: async (sessionId) => hostFor(sessionId).stats(sessionId),
      entries: async (sessionId, scope = "branch") => hostFor(sessionId).entries(sessionId, scope),
    };

    const runtime = createThreadRuntime({
      registry,
      sessions,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => workspaceId,
      readBlocks: async () => [],
      workingStates,
      resolveIntegrationCoordinator: async () => integrationCoordinator,
      worktrees,
    });

    const harnessServiceHost = createHarnessServiceHost({
      search: async () => ({ status: "empty" as const, generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      discoveredShells: {
        hasBash: process.platform !== "win32",
        hasPowerShell: process.platform === "win32",
      },
      threadRegistry: registry,
      threadSpawnSession: async (input) => {
        spawningRunId = input.runId;
        try {
          return await runtime!.spawn(input);
        } finally {
          spawningRunId = undefined;
        }
      },
      threadKillSession: async (threadId, keepWorktree) => { await runtime!.kill(threadId, keepWorktree); },
      threadApplyWorktreeDiff: async (workspaceIdForMerge, parent, threadId, resultRevision, executionId) => {
        mergeExecutionIds.push(executionId ?? "");
        await turnStartGate;
        const result = await runtime!.merge(workspaceIdForMerge, parent, threadId, resultRevision, executionId);
        mergeOperationId = "operationId" in result ? result.operationId : undefined;
        return result;
      },
      requireThreadMergeJournal: true,
    });

    router = createHarnessRouter({
      respond: async (sessionId, requestId, outcome) => {
        hostFor(sessionId).respondHarness(sessionId, requestId, outcome);
      },
      resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    });
    registerHarnessServices(router, harnessServiceHost);

    parentHost = new SessionHost({
      agentDir,
      configureServices,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        const sessionId = parentHost?.sessionId;
        if (!sessionId) return;
        emitFrom(sessionId, event, data);
      },
      projectTrustOverride: true,
    });
    parentHost!.setHarnessThreadRuntimeEnabled(true);
    await writeFile(join(workspace, "parent.txt"), "parent baseline\n", "utf8");

    let parentFirstRoundTools = 0;
    let childRoundTools = 0;
    const firstRoundResponse = (context: { messages: unknown[] }) => {
      const serialized = JSON.stringify(context.messages);
      if (serialized.includes("You are working as the hard-implement thread")) {
        childRoundTools += 1;
        return childRoundTools === 1
          ? fauxAssistantMessage([fauxToolCall("write", { path: "child-result.txt", content: "first child result\n" })])
          : fauxAssistantMessage("Conclusion\nFirst child result is ready.\n\nDeviations from brief\n- none\n\nUnresolved issues\n- none");
      }
      parentFirstRoundTools += 1;
      if (parentFirstRoundTools === 1) {
        return fauxAssistantMessage([fauxToolCall("dispatch", {
          role: "hard-implement",
          task: "Write child-result.txt with the first child result.",
        })]);
      }
      if (parentFirstRoundTools === 2) {
        return fauxAssistantMessage([fauxToolCall("threads", {})]);
      }
      if (/"done":1/.test(serialized)) {
        return fauxAssistantMessage("Conclusion\nThe child result is ready to revise.");
      }
      return fauxAssistantMessage([fauxToolCall("wait", { timeout_ms: 5_000 })]);
    };
    faux.setResponses(Array.from({ length: 24 }, () => firstRoundResponse));

    try {
      const parent = await parentHost!.create(workspace, "Native parent");
      const parentActor = {
        authorityInstanceId,
        sessionId: parent.sessionId,
        workerId: "native-parent-worker",
        workerGeneration: 1,
      } as const;
      harnessServiceHost.registerSession({
        actor: parentActor,
        grantedCapabilities: ["context.session", "control.thread", "process.shell", "read.search", "read.output", "write.document"],
        workspaceId,
        workspaceRoot: workspace,
      });

      await parentHost!.prompt(parent.sessionId, "Delegate the child result and wait for it.");
      await parentHost!.session.waitForIdle();
      await runtime!.drain();

      const created = (await registry.listThreads(workspaceId, { kind: "session", id: parent.sessionId }))[0];
      assert.ok(created);
      assert.equal(created.lifecycle, "settled");
      assert.equal(created.integration, "merge-ready");
      assert.equal(created.resultRevision, 1);
      assert.ok(created.workBranchId);
      assert.ok(created.worktree?.path);
      const firstRevision = created.resultRevision;
      const firstPath = join(created.worktree!.path, "child-result.txt");
      assert.equal(await readFile(firstPath, "utf8"), "first child result\n");

      await writeFile(firstPath, "live child result\n", "utf8");
      const second = await workingStates.withStore(workspaceId, "native-live-result", (store) => (
        store.publishDirectoryResult(created.workBranchId!, created.worktree!.path)
      ));
      assert.equal(second.resultRevision, 2);
      await registry.setWorkingState(workspaceId, created.id, {
        branchId: created.workBranchId,
        resultRevision: second.resultRevision,
        worktree: created.worktree,
        diffStats: second.diffStats,
      });

      const refreshed = await registry.getThread(workspaceId, { kind: "session", id: parent.sessionId }, created.id);
      assert.equal(refreshed?.resultRevision, 2);
      assert.equal(await readFile(firstPath, "utf8"), "live child result\n");

      const mergeResponse = faux.state.callCount;
      configureParentRecoveryTurn("native-parent-merge-execution");
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("merge", { threadId: created.id, resultRevision: firstRevision })]),
        () => fauxAssistantMessage("Conclusion\nThe selected old result was merged."),
      ]);
      await parentHost!.prompt(parent.sessionId, "Merge the first child result revision.");
      await parentHost!.session.waitForIdle();
      await runtime!.drain();

      assert.equal(faux.state.callCount - mergeResponse, 2);
      assert.deepEqual(mergeExecutionIds, ["native-parent-merge-execution"]);
      assert.equal(await readFile(join(workspace, "child-result.txt"), "utf8"), "first child result\n");
      assert.match(JSON.stringify(mergeToolResult), /operationId/);
      assert.match(JSON.stringify(mergeToolResult), /resultRevision/);
      assert.match(JSON.stringify(mergeToolResult), /applied/);
      assert.ok(mergeOperationId);
      assert.ok(parentUserEntryId);
      assert.ok(parentAssistantEntryId);

      const settled = await recoveryEngine.recordTurnSettled({
        activeWriterScopes: [],
        assistantEntryId: parentAssistantEntryId,
        executionId: "native-parent-merge-execution",
        mutationObserved: true,
        observationComplete: true,
        observedResourceIds: ["child-result.txt"],
        provenance: "caused-by",
        workspaceId,
      });
      assert.equal(settled.status, "ready");
      assert.equal(settled.binding?.status, "ready");

      await recoveryEngine.withWorkspaceStorage(workspaceId, { mode: "shared", purpose: "assert-native-merge", create: false }, ({ database }) => {
        const integration = database.prepare("SELECT id, state FROM operations WHERE id = ? AND kind = 'integration'").get(mergeOperationId) as { id: string; state: string } | undefined;
        assert.deepEqual(integration, { id: mergeOperationId, state: "complete" });
        const change = database.prepare("SELECT tool_name, mutation_id FROM checkpoint_changes WHERE checkpoint_id = (SELECT checkpoint_id FROM turn_bindings WHERE execution_id = ?) AND path = 'child-result.txt'").get("native-parent-merge-execution") as { tool_name: string; mutation_id: string } | undefined;
        assert.deepEqual(change, { tool_name: "thread.merge", mutation_id: mergeOperationId });
      });

      const prepared = await recoveryEngine.prepareCombinedRecovery({
        entryId: parentUserEntryId,
        sessionId: parent.sessionId,
        workspaceId,
      });
      assert.equal(prepared.status, "ready");
      if (prepared.status !== "ready") throw new Error("Native undo plan was not ready");
      assert.equal(prepared.plan.coverage, "ready");
      assert.deepEqual(prepared.plan.affectedPaths, ["child-result.txt"]);
      const undone = await recoveryEngine.applyCombinedRecovery({
        confirmedConflicts: [],
        conflictPolicy: "abort",
        expectedRevision: prepared.plan.revision,
        operationId: prepared.plan.id,
      });
      assert.equal(undone.status, "ready");
      if (undone.status !== "ready") throw new Error("Native undo did not complete");
      assert.equal(undone.operation.state, "complete");
      await assert.rejects(readFile(join(workspace, "child-result.txt"), "utf8"), { code: "ENOENT" });
    } finally {
      await runtime!.dispose();
      for (const child of childHosts.values()) await child.dispose();
      await parentHost!.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
      await registry.dispose();
      await recoveryEngine.dispose();
      faux.unregister();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
