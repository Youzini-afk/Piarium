import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { createThreadRegistry } from "../../../web/application-host/lib/harness/thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../../../web/application-host/lib/harness/thread-runtime.js";
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
    let runtime!: ReturnType<typeof createThreadRuntime>;

    const hostFor = (sessionId: string): SessionHost => {
      if (sessionId === parent.sessionId) return parentHost;
      const host = childHosts.get(sessionId);
      if (!host) throw new Error(`Unknown test session: ${sessionId}`);
      return host;
    };

    const createChildHost = (): SessionHost => {
      let child!: SessionHost;
      const emit = <E extends HostEvent>(event: E, data: HostEventData<E>): void => {
        const sessionId = child?.sessionId;
        if (!sessionId) return;
        runtime.processEvent({
          kind: "host",
          sessionId,
          envelope: { kind: "event", event, data },
        });
      };
      child = new SessionHost({ agentDir, configureServices, emit, projectTrustOverride: true });
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

    runtime = createThreadRuntime({
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
