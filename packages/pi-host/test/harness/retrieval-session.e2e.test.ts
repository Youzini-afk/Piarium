import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { createDocumentAuthority } from "../../../web/application-host/lib/documents/authority.js";
import { createHarnessPathAuthority } from "../../../web/application-host/lib/harness/path-authority.js";
import { createWorkspaceContentSearch } from "../../../web/application-host/lib/search/content.js";
import { createExploreFileReader } from "../../../web/application-host/lib/harness/explore-file-reader.js";
import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createThreadRegistry } from "../../../web/application-host/lib/harness/thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../../../web/application-host/lib/harness/thread-runtime.js";
import { projectZone2Threads } from "../../../web/application-host/lib/harness/zone2-threads.js";
import { SessionHost } from "../../src/session-host.js";

const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for retrieval session work");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("retrieval thread public slice", () => {
  it("dispatches a retrieval child that explores, reads, and submits Host-validated facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrieval-session-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const authBody = [
      "export const ignored = 1;",
      "export function login(user: string) {",
      "  return user;",
      "}",
      "export const after = 2;",
    ].join("\n");
    await writeFile(join(workspace, "src", "auth.ts"), authBody, "utf8");
    await writeFile(join(workspace, "outside.ts"), "export const secret = true;\n", "utf8");

    const documents = createDocumentAuthority({
      hostId: "retrieval-e2e-host",
      dataDir: join(root, "documents"),
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const identity = await documents.resolveWorkspace({ path: workspace });
    const paths = createHarnessPathAuthority({
      authorityId: "retrieval-e2e-authority",
      documents,
    });
    const search = createWorkspaceContentSearch({ documents, pathModule: path, spawn });

    const faux = registerFauxProvider();
    const model = faux.getModel();
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: {
        models: {
          retrievalAgent: { providerId: model.provider, modelId: model.id },
        },
      },
    }), "utf8");

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

    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "retrieval-e2e" });
    const childHosts = new Map<string, SessionHost>();
    const childSessionFiles = new Map<string, string>();
    const childRunIds = new Map<string, string>();
    let spawningRunId: string | undefined;
    let childInitialPrompt = "";
    let childTranscript = "";
    let childTools: string[] = [];
    let childModelId: string | undefined;
    let childScope: string[] | undefined;
    let parentHost: SessionHost | null = null;
    let router: ReturnType<typeof createHarnessRouter> | null = null;
    let harnessServiceHost: ReturnType<typeof createHarnessServiceHost> | null = null;
    let runtime: ReturnType<typeof createThreadRuntime> | null = null;
    const parentUserText = "SECRET_PARENT_ONLY locate the login helper";

    const hostFor = (sessionId: string): SessionHost => {
      if (sessionId === parentHost?.sessionId) return parentHost;
      const host = childHosts.get(sessionId);
      if (!host) throw new Error(`Unknown retrieval session: ${sessionId}`);
      return host;
    };

    const actorFor = (sessionId: string) => {
      if (sessionId === parentHost?.sessionId) {
        return {
          authorityInstanceId: "retrieval-e2e-authority",
          sessionId,
          workerId: "parent-worker",
          workerGeneration: 1,
        } as const;
      }
      const runId = childRunIds.get(sessionId);
      return {
        authorityInstanceId: "retrieval-e2e-authority",
        sessionId,
        workerId: `child-worker-${sessionId}`,
        workerGeneration: 1,
        ...(runId ? { runId } : {}),
        workspaceScope: ["src"],
      } as const;
    };

    const ensureRegistered = (sessionId: string): void => {
      const actor = actorFor(sessionId);
      if (harnessServiceHost!.hasActor(actor)) return;
      const isParent = sessionId === parentHost?.sessionId;
      harnessServiceHost!.registerSession({
        actor,
        grantedCapabilities: isParent
          ? ["context.session", "control.thread", "read.output", "read.lsp"]
          : ["context.session", "control.thread", "read.document", "read.search", "read.output", "read.lsp"],
        workspaceId: identity.workspaceId,
        workspaceRoot: workspace,
      });
    };

    const emitFrom = (sessionId: string, event: HostEvent, data: unknown): void => {
      if (event === "harness.request") {
        ensureRegistered(sessionId);
        void router!.processEvent({
          actor: actorFor(sessionId),
          kind: "host",
          envelope: { kind: "event", event: "harness.request", data },
        });
        return;
      }
      if (event === "agent.event" && sessionId !== parentHost?.sessionId) {
        runtime!.processEvent({
          kind: "host",
          sessionId,
          envelope: { kind: "event", event: "agent.event", data },
        });
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
      child.setHarnessDocumentReadEnabled(true);
      child.setHarnessDocumentPathOverlayEnabled(true);
      return child;
    };

    const sessions: ThreadSessionAdapter = {
      create: async (input) => {
        if (!spawningRunId) throw new Error("retrieval child created without a Run id");
        childScope = input.scope;
        const child = createChildHost();
        const created = await child.create(input.cwd, input.name, input.parentSession, input.tools, input.model, input.permissions);
        childHosts.set(created.sessionId, child);
        childRunIds.set(created.sessionId, spawningRunId);
        childTools = [...created.activeTools];
        childModelId = created.model?.id;
        if (created.sessionFile) childSessionFiles.set(created.sessionId, created.sessionFile);
        return created;
      },
      open: async (input) => {
        const sessionFile = childSessionFiles.get(input.sessionId);
        if (!sessionFile) throw new Error(`Missing retrieval child session: ${input.sessionId}`);
        const child = createChildHost();
        const opened = await child.open({
          cwd: input.cwd,
          sessionFile,
          tools: input.tools,
          ...(input.model ? { model: input.model } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
        });
        childHosts.set(opened.sessionId, child);
        if (opened.sessionFile) childSessionFiles.set(opened.sessionId, opened.sessionFile);
        return opened;
      },
      prompt: async (sessionId, text, instructions) => {
        childInitialPrompt = text;
        const result = await hostFor(sessionId).prompt(sessionId, text, undefined, instructions);
        if (!result.accepted) throw new Error("Retrieval child prompt was not accepted");
      },
      send: async (sessionId, text) => { await hostFor(sessionId).followUp(sessionId, text); },
      abort: async (sessionId) => { await hostFor(sessionId).abort(sessionId); },
      close: async (sessionId) => {
        try {
          childTranscript = JSON.stringify(hostFor(sessionId).entries(sessionId, "branch").entries);
        } catch {
          // Session may already be inactive after settle.
        }
        await hostFor(sessionId).close(sessionId);
      },
      snapshot: async (sessionId) => hostFor(sessionId).snapshot(),
      summary: async (sessionId) => hostFor(sessionId).summary(sessionId),
      stats: async (sessionId) => hostFor(sessionId).stats(sessionId),
      entries: async (sessionId, scope = "branch") => hostFor(sessionId).entries(sessionId, scope),
    };

    runtime = createThreadRuntime({
      registry,
      sessions,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => identity.workspaceId,
      readBlocks: async () => [{ label: "plan", content: "parent-only block that must not copy the conversation" }],
      worktrees: {
        prepare: async () => ({ cwd: workspace, worktree: null }),
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });

    harnessServiceHost = createHarnessServiceHost({
      search: (request, options) => search.searchContent(request, options),
      resolveWorkspaceRoot: async () => workspace,
      readExploreFile: createExploreFileReader(documents, paths),
      threadRegistry: registry,
      threadSpawnSession: async (input) => {
        spawningRunId = input.runId;
        return runtime!.spawn(input);
      },
    });
    router = createHarnessRouter({
      resolveActor: async (identityActor) => {
        const registered = harnessServiceHost!.resolveActor(identityActor);
        if (registered) return registered;
        return {
          ...identityActor,
          workspaceId: identity.workspaceId,
          grantedCapabilities: ["control.thread", "read.document", "read.search", "read.output", "context.session", "read.lsp"],
        };
      },
      respond: async (sessionId, requestId, outcome) => {
        hostFor(sessionId).respondHarness(sessionId, requestId, outcome);
      },
      authorizeWorkspacePath: (actor, inputPath, options) => paths.resolve(actor, inputPath, options),
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
    parentHost.setHarnessThreadRuntimeEnabled(true);

    let parentPhase = 0;
    let childPhase = 0;
    let followPhase = 0;
    const respond = (context: { messages: unknown }) => {
      const blob = JSON.stringify(context.messages);
      if (blob.includes("Read the retrieval report")) {
        followPhase += 1;
        const match = blob.match(/thread-[0-9a-f]{8}/i);
        if (followPhase === 1) {
          return fauxAssistantMessage([fauxToolCall("wait", match ? { ids: [match[0]] } : {})]);
        }
        if (followPhase === 2) {
          return fauxAssistantMessage([fauxToolCall("read_thread", {
            threadId: match?.[0] ?? "missing",
            what: "report",
          })]);
        }
        return fauxAssistantMessage("Parent read the retrieval report.");
      }
      if (
        blob.includes("You are working as the retrieval thread")
        || blob.includes("Deliver facts only through submit_facts")
      ) {
        childPhase += 1;
        if (childPhase === 1) {
          return fauxAssistantMessage([fauxToolCall("explore", { question: "login helper", anchors: ["login"] })]);
        }
        if (childPhase === 2) {
          return fauxAssistantMessage([fauxToolCall("read", { path: "src/auth.ts" })]);
        }
        if (childPhase === 3) {
          return fauxAssistantMessage([fauxToolCall("related", { anchor: "src/auth.ts" })]);
        }
        if (childPhase === 4) {
          return fauxAssistantMessage([fauxToolCall("submit_facts", {
            question: "Where is login implemented?",
            facts: [
              { claim: "login is exported from src/auth.ts", sources: [{ kind: "local", path: "src/auth.ts", startLine: 2, endLine: 4 }] },
              { claim: "secret outside scope", sources: [{ kind: "local", path: "outside.ts", startLine: 1, endLine: 1 }] },
              { claim: "invented range", sources: [{ kind: "local", path: "src/auth.ts", startLine: 80, endLine: 90 }] },
            ],
            unknowns: ["who calls login"],
            attempted: [{ action: "related src/auth.ts", outcome: "unavailable" }],
          })]);
        }
        return fauxAssistantMessage("Fact report submitted.");
      }
      parentPhase += 1;
      if (parentPhase === 1) {
        return fauxAssistantMessage([fauxToolCall("dispatch", {
          role: "retrieval",
          task: "Where is login implemented?",
          scope: ["src"],
        })]);
      }
      return fauxAssistantMessage("dispatched retrieval");
    };
    faux.setResponses(Array.from({ length: 16 }, () => respond));

    try {
      const parent = await parentHost.create(workspace, "Parent");
      const first = await parentHost.prompt(parent.sessionId, parentUserText);
      assert.equal(first.accepted, true);
      await parentHost.session.waitForIdle();

      await waitUntil(async () => {
        const childId = [...childHosts.keys()][0];
        if (childId) {
          try {
            childTranscript = JSON.stringify(hostFor(childId).entries(childId, "branch").entries);
          } catch {
            // Child may already be closing while the Run settles.
          }
        }
        const threads = await registry.listThreads(identity.workspaceId, { kind: "session", id: parent.sessionId });
        const retrieval = threads.find((thread) => thread.role === "retrieval");
        return retrieval?.lifecycle === "settled";
      });

      const threads = await registry.listThreads(identity.workspaceId, { kind: "session", id: parent.sessionId });
      const retrieval = threads.find((thread) => thread.role === "retrieval");
      assert.ok(retrieval);
      assert.equal(retrieval.manifest.carryBlocks, false);
      assert.deepEqual(childScope, ["src"]);
      assert.equal(childModelId, model.id);
      assert.ok(childTools.includes("submit_facts"));
      assert.ok(childTools.includes("explore"));
      assert.ok(!childTools.includes("bash"));
      assert.ok(!childTools.includes("edit"));
      assert.ok(!childInitialPrompt.includes(parentUserText));
      assert.ok(!childInitialPrompt.includes("<parent-blocks"));
      assert.match(childInitialPrompt, /submit_facts/);

      assert.ok(childTranscript.length > 0);
      assert.equal(childTranscript.includes(parentUserText), false);

      assert.equal(retrieval.report?.evidence?.facts.some((fact) => fact.status === "source-checked" && fact.claim.includes("login")), true);
      assert.equal(retrieval.report?.evidence?.facts.some((fact) => fact.claim.includes("secret outside")), false);
      assert.equal(retrieval.report?.evidence?.facts.some((fact) => fact.claim === "invented range" && fact.status === "source-checked"), false);
      assert.equal(retrieval.report?.changedFiles.length, 0);
      assert.equal(JSON.stringify(retrieval.report).includes("priority"), false);
      assert.equal(await readFile(join(workspace, "src", "auth.ts"), "utf8"), authBody);

      const zone2 = await projectZone2Threads(
        { registry, cursors: harnessServiceHost.observationCursors },
        { sessionId: parent.sessionId, workspaceId: identity.workspaceId },
      );
      assert.equal(zone2.status, "ready");
      if (zone2.status === "ready") {
        assert.ok(zone2.items.some((item) => item.id === retrieval.id && (item.evidenceSummary ?? item.conclusion ?? "").includes("source-checked")));
      }

      const second = await parentHost.prompt(parent.sessionId, "Read the retrieval report");
      assert.equal(second.accepted, true);
      await parentHost.session.waitForIdle();
    } finally {
      await runtime?.dispose();
      for (const child of childHosts.values()) await child.dispose();
      await parentHost?.dispose();
      router?.dispose();
      await harnessServiceHost?.dispose();
      await registry.dispose();
      await documents.dispose();
      faux.unregister();
      await rm(root, { recursive: true, force: true });
    }
  });
});
