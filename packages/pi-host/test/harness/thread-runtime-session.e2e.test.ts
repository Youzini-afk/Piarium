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
  it("creates a persisted child session, runs it, and records its report", async () => {
    const root = await mkdtemp(join(tmpdir(), "thread-real-session-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(workspace, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const faux = registerFauxProvider();
    faux.setResponses([() => fauxAssistantMessage("Child session completed the assigned check.")]);
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

    const sessions: ThreadSessionAdapter = {
      create: async (input) => {
        childRuntimeWorkspaceId = input.workspaceId;
        childScope = input.scope;
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
        const created = await child.create(input.cwd, input.name, input.parentSession, input.tools, input.model);
        childHosts.set(created.sessionId, child);
        return created;
      },
      open: async (input) => hostFor(input.sessionId).open({
        cwd: input.cwd,
        sessionId: input.sessionId,
        tools: input.tools,
        ...(input.model ? { model: input.model } : {}),
      }),
      prompt: async (sessionId, text, instructions) => {
        childInitialPrompt = text;
        const result = await hostFor(sessionId).prompt(sessionId, text, undefined, instructions);
        if (!result.accepted) throw new Error("Child prompt was not accepted");
      },
      send: async (sessionId, text) => { await hostFor(sessionId).followUp(sessionId, text); },
      abort: async (sessionId) => { await hostFor(sessionId).abort(sessionId); },
      close: async (sessionId) => { await hostFor(sessionId).close(sessionId); },
      summary: (sessionId) => hostFor(sessionId).summary(sessionId),
      stats: async (sessionId) => hostFor(sessionId).stats(sessionId),
      entries: async (sessionId) => hostFor(sessionId).entries(sessionId, "branch"),
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
        prepare: async () => ({ cwd: workspace, worktree: null }),
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
