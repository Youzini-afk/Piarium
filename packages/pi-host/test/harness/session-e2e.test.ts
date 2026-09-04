/**
 * Real Pi session e2e — the three in-process extensions that session-host
 * registers for every session, exercised inside an actual agent loop with a
 * faux provider:
 *
 *   - zone2-extension        (before_agent_start → <piarium-context>)
 *   - compaction-extension   (session_before_compact → { compaction })
 *   - permission-gate        (tool_call → ui.select → allow/deny)
 *
 * The tool-level e2e files (phase2/phase3/phase3b) drive `tool.execute`
 * directly, which never reaches a Pi hook. These tests wire a real
 * SessionHost to a real HarnessRouter + HarnessServiceHost, so the hook
 * path, the bridge round-trip and the UI answer flow are all covered.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { DEFAULT_MEMORY_AGENT_SETTINGS, type HostEvent, type HostEventData } from "@piarium/protocol";

import { createHarnessServiceHost, type HarnessServiceHostOptions } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../../../web/application-host/lib/knowledge/store.js";
import { createKnowledgeContextRuntime } from "../../../web/application-host/lib/knowledge/context-runtime.js";
import { createDocumentAuthority, type DocumentMutationObservation } from "../../../web/application-host/lib/documents/authority.js";
import { createDocumentAuthorityHarness } from "../../../web/application-host/lib/documents/contract-fixtures.js";
import { createLanguageSupervisor } from "../../../web/application-host/lib/lsp/supervisor.js";
import { PIARIUM_LSP_FIXTURE_SERVER_ARGS } from "../../../web/application-host/lib/lsp/servers.js";
import { createLanguageSupervisorDiagnosticsProvider } from "../../../web/application-host/lib/harness/diagnostics-adapter.js";
import { createWebSearchService } from "../../../web/application-host/lib/harness/web-search.js";
import { DEFAULT_COMPACTION_SETTINGS, type CompactionFacts, type CompactionHandlerDeps } from "../../../web/application-host/lib/harness/compaction.js";
import type { Zone2Material } from "../../../web/application-host/lib/harness/zone2.js";

import { SessionHost } from "../../src/session-host.js";

const WORKSPACE_ID = "session-e2e-workspace";

interface UiRequest {
  id: string;
  method: string;
  title: string;
}

/**
 * Build a SessionHost whose `harness.request` events are served by a real
 * router, and whose `extension.ui.request` dialogs are answered by
 * `answerDialog`. Returns the host plus the recorded dialog requests.
 */
async function setupSession(options: {
  root: string;
  faux: ReturnType<typeof registerFauxProvider>;
  workspaceId?: string;
  harnessWebRead?: boolean;
  harnessWebSearch?: boolean;
  serviceHostOptions?: Partial<HarnessServiceHostOptions>;
  authorizeWorkspacePath?: NonNullable<Parameters<typeof createHarnessRouter>[0]["authorizeWorkspacePath"]>;
  /** Answer for a `ui.select` dialog; undefined = dismiss. */
  answerDialog?: (request: UiRequest, index: number) => string | undefined;
}) {
  const { root, faux } = options;
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });

  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => root,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
    },
    ...options.serviceHostOptions,
  });

  const uiRequests: UiRequest[] = [];

  const router = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => {
      host.respondHarness(sessionId, requestId, outcome);
    },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    ...(options.authorizeWorkspacePath ? { authorizeWorkspacePath: options.authorizeWorkspacePath } : {}),
  });
  registerHarnessServices(router, harnessServiceHost);

  const emit = (<E extends HostEvent>(event: E, data: HostEventData<E>): void => {
    if (event === "harness.request") {
      const payload = data as HostEventData<"harness.request">;
      const actor = {
        authorityInstanceId: "session-e2e-authority",
        sessionId: host.session.sessionManager.getSessionId(),
        workerId: "session-e2e-worker",
        workerGeneration: 1,
      } as const;
      if (!harnessServiceHost.hasActor(actor)) {
        harnessServiceHost.registerSession({
          actor,
          grantedCapabilities: ["context.session", "process.shell", "read.lsp", "read.output", "read.search", "read.web", "write.document"],
          workspaceId,
          workspaceRoot: root,
        });
      }
      void router.processEvent({
        actor,
        kind: "host",
        envelope: { kind: "event", event: "harness.request", data: payload },
      });
      return;
    }
    if (event === "extension.ui.request") {
      const payload = data as { id?: string; method?: string; payload?: { title?: string } };
      // `fire()` emits status/notify updates without an id; only dialogs
      // (select/confirm/input) carry one and expect an answer.
      if (!payload.id || payload.method !== "select") return;
      const request: UiRequest = {
        id: payload.id,
        method: payload.method,
        title: payload.payload?.title ?? "",
      };
      const index = uiRequests.length;
      uiRequests.push(request);
      const answer = options.answerDialog?.(request, index);
      host.ui.respond(
        answer === undefined
          ? { cancelled: true, requestId: payload.id }
          : { requestId: payload.id, value: answer },
      );
    }
  }) as <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

  const model = faux.getModel();
  const configureServices = async (services: AgentSessionServices) => {
    services.modelRuntime.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      models: [
        {
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          cost: model.cost,
          id: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          name: model.name,
          reasoning: model.reasoning,
        },
      ],
    });
    await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
    return { model };
  };

  const host = new SessionHost({
    agentDir,
    configureServices,
    emit,
    projectTrustOverride: true,
  });
  if (options.harnessWebRead || options.harnessWebSearch) {
    host.setHarnessWebCapabilities({
      read: options.harnessWebRead === true,
      search: options.harnessWebSearch === true,
    });
  }

  return {
    host,
    harnessServiceHost,
    router,
    uiRequests,
    dispose: async () => {
      await host.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
    },
  };
}

async function withTempRoot(prefix: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    try { await rm(root, { force: true, recursive: true }); } catch { /* Windows EBUSY */ }
  }
}

const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for background session work");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

// ── Zone 2 ─────────────────────────────────────────────────────────

describe("session e2e — zone2 extension", () => {
  it("carries a committed editor mutation through the Host store into the next real Pi turn", async () => {
    await withTempRoot("piarium-s-zone2-documents-", async (root) => {
      const dataDir = join(root, "data");
      let observeMutation = (_event: DocumentMutationObservation): void => {};
      const documents = createDocumentAuthority({
        hostId: "zone2-host",
        dataDir,
        isAllowedRoot: async () => true,
        isTrusted: async () => true,
        onMutation: (event) => observeMutation(event),
      });
      const identity = await documents.resolveWorkspace({ path: root });
      const store = await openWorkspaceKnowledge({
        dataDir,
        hostId: "zone2-host",
        workspaceId: identity.workspaceId,
        embedding: null,
      });
      const knowledge = createKnowledgeContextRuntime({ getStore: async () => store });
      observeMutation = (event) => knowledge.observeDocumentMutation(event);
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("first done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("second done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("third done"); },
      ]);
      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: { zone2Provider: (request) => knowledge.zone2Material(request) },
      });

      try {
        const snapshot = await session.host.create(root);
        knowledge.bindSession(snapshot.sessionId, identity.workspaceId);
        await session.host.prompt(snapshot.sessionId, "first turn");
        await session.host.session.waitForIdle();

        const write = await documents.write({
          resource: { workspaceId: identity.workspaceId, resourceId: "edited-between-turns.ts" },
          token: { workspaceId: identity.workspaceId, epoch: identity.epoch, owner: { kind: "web-route", id: "editor" } },
          expectedRevision: null,
          content: "export const changedByUser = true;\n",
          encoding: "utf-8",
          bom: false,
          operationId: randomUUID(),
        });
        assert.equal(write.status, "written");
        await knowledge.drain();

        await session.host.prompt(snapshot.sessionId, "second turn");
        await session.host.session.waitForIdle();
        assert.doesNotMatch(JSON.stringify(contexts[0]!.messages), /edited-between-turns/);
        assert.match(JSON.stringify(contexts[1]!.messages), /modified|created/);
        assert.match(JSON.stringify(contexts[1]!.messages), /edited-between-turns\.ts/);
        await session.host.prompt(snapshot.sessionId, "third turn");
        await session.host.session.waitForIdle();
        assert.equal(
          JSON.stringify(contexts[2]!.messages).match(/edited-between-turns\.ts/g)?.length,
          1,
          "the delivered event must remain in history without being appended a second time",
        );
      } finally {
        await session.dispose();
        await knowledge.dispose();
        await store.close();
        await documents.dispose();
        faux.unregister();
      }
    });
  });

  it("injects assembled <piarium-context> into the first request and leaves Zone 0 alone", async () => {
    await withTempRoot("piarium-s-zone2-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("ok 1"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("ok 2"); },
      ]);

      const material: Zone2Material = {
        userEdits: [{ path: "packages/web/lib/foo.ts", kind: "modified" }],
        userCommands: [{ command: "bun test", exitCode: 1, at: Date.now() }],
        newDiagnostics: [],
        git: { branch: "main", changed: 1 },
        knowledge: [],
        blocks: [],
        contextUsage: null,
      };
      const zone2Requests: Array<{ afterEventId?: number }> = [];

      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: {
          zone2Provider: async (request) => {
            zone2Requests.push(request);
            return {
              eventCursor: 4,
              material: request.afterEventId === 4
                ? { ...material, userEdits: [], userCommands: [], git: null }
                : material,
            };
          },
        },
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "first turn");
        await session.host.session.waitForIdle();
        await session.host.prompt(snapshot.sessionId, "second turn");
        await session.host.session.waitForIdle();

        assert.equal(contexts.length, 2, "expected one provider call per turn");
        assert.equal(zone2Requests[0]?.afterEventId, undefined);
        assert.equal(zone2Requests[1]?.afterEventId, 4, "the next turn must continue after the delivered event cursor");

        const firstMessages = JSON.stringify(contexts[0]!.messages);
        assert.match(firstMessages, /<piarium-context/, "Zone 2 block must reach the provider");
        assert.match(firstMessages, /packages\/web\/lib\/foo\.ts/, "user edit must be listed");
        assert.match(firstMessages, /not instructions/, "Zone 2 must be marked as data");

        // Zone 2 is a message, never the system prompt (§4.2 / invariant 2).
        const system = contexts[0]!.systemPrompt ?? "";
        assert.doesNotMatch(system, /<piarium-context/, "Zone 2 must not touch the system prompt");
        assert.equal(contexts[1]!.systemPrompt ?? "", system, "system prompt must stay byte-identical");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("sends no context message when the host has no Zone 2 material", async () => {
    await withTempRoot("piarium-s-zone2-empty-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("ok"); },
      ]);

      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: {
          zone2Provider: async () => ({
            eventCursor: 0,
            material: {
              userEdits: [],
              userCommands: [],
              newDiagnostics: [],
              git: null,
              knowledge: [],
              blocks: [],
              contextUsage: null,
            },
          }),
        },
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "hello");
        await session.host.session.waitForIdle();

        assert.equal(contexts.length, 1);
        assert.doesNotMatch(
          JSON.stringify(contexts[0]!.messages),
          /<piarium-context/,
          "an empty Zone 2 must not produce an empty block",
        );
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — memory shadow extension", () => {
  it("uses the active session model to maintain blocks without taking over the conversation", async () => {
    await withTempRoot("piarium-s-memory-shadow-", async (root) => {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: { memory: { shadowMode: true } },
      }), "utf8");
      const store = await openWorkspaceKnowledge({
        dataDir: join(root, "data"),
        hostId: "memory-host",
        workspaceId: WORKSPACE_ID,
        embedding: null,
      });
      const faux = registerFauxProvider();
      const keeperContexts: Context[] = [];
      faux.setResponses([
        () => fauxAssistantMessage("x".repeat(50_000)),
        (context) => {
          keeperContexts.push(context);
          return fauxAssistantMessage([fauxToolCall("memory_edit", {
            ops: [{ op: "create", block: "progress", content: "The first long turn is complete." }],
          })]);
        },
      ]);
      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: {
          memoryDepsProvider: async () => ({ store, settings: DEFAULT_MEMORY_AGENT_SETTINGS }),
        },
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "produce a long answer");
        await session.host.session.waitForIdle();
        await waitUntil(async () => (await store.getBlocks(snapshot.sessionId)).length > 0);
        assert.equal(keeperContexts.length, 1);
        assert.equal(keeperContexts[0]!.tools?.[0]?.name, "memory_edit");
        assert.match((await store.getBlocks(snapshot.sessionId))[0]!.content, /long turn is complete/);
        assert.doesNotMatch(JSON.stringify(session.host.session.messages), /memory_edit/);
      } finally {
        await session.dispose();
        await store.close();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — durable output handles", () => {
  it("lets a real Pi turn read a large file and page the truncated result with get_output", async () => {
    await withTempRoot("piarium-s-large-read-", async (root) => {
      await writeFile(
        join(root, "large.txt"),
        Array.from({ length: 8_000 }, (_, index) => `line ${index + 1} — 大文件`).join("\n"),
        "utf8",
      );
      const faux = registerFauxProvider();
      let handle = "";
      let pagedContext = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "large.txt" })]),
        (context) => {
          const serialized = JSON.stringify(context.messages.at(-1));
          const match = serialized.match(/out_(?!XXX)[A-Za-z0-9_-]+/);
          assert.ok(match, "the model-visible read result should contain an output handle");
          handle = match[0];
          assert.ok(!serialized.includes("line 8000 — 大文件"), "the full file must not leak into the model context");
          return fauxAssistantMessage([fauxToolCall("get_output", { handle, offset: 0, length: 1024 })]);
        },
        (context) => {
          pagedContext = JSON.stringify(context.messages.at(-1));
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "inspect the large file");
        await session.host.session.waitForIdle();
        assert.match(handle, /^out_/);
        assert.match(pagedContext, /line 1/);
        assert.match(pagedContext, /\[\d+\/\d+ bytes/);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — session-local web reader", () => {
  it("fetches once in the Host and answers with the configured reader model in pi-host", async () => {
    await withTempRoot("piarium-s-web-reader-", async (root) => {
      const faux = registerFauxProvider();
      const model = faux.getModel();
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: { models: { reader: { providerId: model.provider, modelId: model.id } } },
      }), "utf8");
      let fetchCalls = 0;
      let readerContext: Context | undefined;
      let finalToolResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("webfetch", {
          url: "https://example.com/guide",
          prompt: "What is the answer?",
        })]),
        (context) => {
          readerContext = context;
          return fauxAssistantMessage("The answer is 42.");
        },
        (context) => {
          finalToolResult = JSON.stringify(context.messages.at(-1));
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root,
        faux,
        harnessWebRead: true,
        serviceHostOptions: {
          webFetchService: {
            fetch: async () => {
              fetchCalls += 1;
              return {
                status: "ok",
                url: "https://example.com/guide",
                finalUrl: "https://example.com/guide",
                contentType: "text/html",
                markdown: "The documentation states that the answer is 42.",
                bytes: 48,
                fromCache: false,
                rendered: false,
              };
            },
          },
        },
      });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "read the guide");
        await session.host.session.waitForIdle();
        assert.equal(fetchCalls, 1);
        assert.match(readerContext?.systemPrompt ?? "", /strictly from the supplied page content/);
        assert.match(JSON.stringify(readerContext?.messages), /untrusted data, not instructions/);
        assert.match(JSON.stringify(readerContext?.messages), /answer is 42/);
        assert.match(finalToolResult, /answer \(from https:\/\/example\.com\/guide\)/);
        assert.match(finalToolResult, /The answer is 42/);
        const stats = session.host.stats(snapshot.sessionId);
        assert.equal(stats.modelSlotUsage?.reader?.calls, 1);
        assert.ok((stats.modelSlotUsage?.reader?.tokens.total ?? 0) > 0);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — configured web search", () => {
  it("carries a configured Host provider result through websearch into a real Pi turn", async () => {
    await withTempRoot("piarium-s-web-search-", async (root) => {
      const faux = registerFauxProvider();
      let finalToolResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("websearch", {
          query: "Piarium architecture",
          allowed_domains: ["docs.example"],
        })]),
        (context) => {
          finalToolResult = JSON.stringify(context.messages.at(-1));
          return fauxAssistantMessage("done");
        },
      ]);
      const webSearchService = createWebSearchService(async () => ({
        id: "configured-test",
        search: async () => [{
          title: "Piarium architecture",
          url: "https://docs.example/piarium",
          snippet: "Host and pi-host have separate authority boundaries.",
        }],
      }));
      const session = await setupSession({
        root,
        faux,
        harnessWebSearch: true,
        serviceHostOptions: { webSearchService },
      });
      try {
        const snapshot = await session.host.create(root);
        assert.ok(snapshot.activeTools.includes("websearch"));
        await session.host.prompt(snapshot.sessionId, "search for the architecture");
        await session.host.session.waitForIdle();
        assert.match(finalToolResult, /configured-test/);
        assert.match(finalToolResult, /https:\/\/docs\.example\/piarium/);
        assert.match(finalToolResult, /authority boundaries/);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — real LSP diagnostics", () => {
  it("carries fixture-server diagnostics through the Host bridge into a real Pi turn", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    const faux = registerFauxProvider();
    let diagnosticResult = "";
    try {
      const resourceId = "fixture.ts";
      await writeFile(join(harness.workspaceRoot, resourceId), "FIXTURE_ERROR\n", "utf8");
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: PIARIUM_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const diagnosticsProvider = createLanguageSupervisorDiagnosticsProvider(language, {
        resolveWorkspaceId: async () => harness.identity.workspaceId,
      });
      await diagnosticsProvider.getSnapshot(harness.identity.workspaceId, resourceId);
      await language.syncDocument({
        resource: { workspaceId: harness.identity.workspaceId, resourceId },
        languageId: "typescript",
        documentVersion: 1,
        reason: "open",
        content: "FIXTURE_ERROR\n",
      });
      await waitUntil(async () => (
        (await diagnosticsProvider.getDiagnostics(harness.identity.workspaceId, resourceId))
          .some((diagnostic) => diagnostic.message === "fixture error")
      ));

      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("diagnostics", { path: resourceId, full: true })]),
        (context) => {
          diagnosticResult = JSON.stringify(context.messages.at(-1));
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root: harness.workspaceRoot,
        faux,
        workspaceId: harness.identity.workspaceId,
        serviceHostOptions: { diagnosticsProvider },
        authorizeWorkspacePath: async (_actor, inputPath) => ({
          authorityId: "session-e2e-authority",
          workspaceId: harness.identity.workspaceId,
          canonicalResourceId: path.resolve(harness.workspaceRoot, inputPath),
          inputPath,
          resourceId: inputPath,
        }),
      });
      try {
        const snapshot = await session.host.create(harness.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "check the fixture diagnostics");
        await session.host.session.waitForIdle();
        assert.match(diagnosticResult, /fixture error/);
        assert.match(diagnosticResult, /diagnostics/);
      } finally {
        await session.dispose();
      }
    } finally {
      faux.unregister();
      await language.dispose();
      await harness.cleanup();
    }
  });
});

describe("session e2e — Harness counters", () => {
  it("publishes real tool failures, retries, output bytes, observations, and cache ratio through session stats", async () => {
    await withTempRoot("piarium-s-counters-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "missing-counter-file.txt" })]),
        () => fauxAssistantMessage([fauxToolCall("read", { path: "missing-counter-file.txt" })]),
        () => fauxAssistantMessage([fauxToolCall("diagnostics", { path: "missing-counter-file.txt" })]),
        () => fauxAssistantMessage("done"),
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "try the same missing file twice");
        await session.host.session.waitForIdle();
        const stats = session.host.stats(snapshot.sessionId);
        assert.ok((stats.toolErrors ?? 0) >= 2);
        assert.ok((stats.toolRetries ?? 0) >= 1);
        assert.ok((stats.outputBytes ?? 0) > 0);
        assert.ok((stats.observationCalls ?? 0) >= 1);
        assert.equal(typeof stats.cacheHitRatio, "number");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

// ── Compaction ─────────────────────────────────────────────────────

/**
 * Drive four large turns so the session exceeds `keepRecentTokens`, then
 * compact. Returns the provider call count before and after compaction.
 */
async function runCompactionCase(options: {
  root: string;
  compactionDepsProvider: (sessionId: string) => Promise<CompactionHandlerDeps>;
}): Promise<{ callsBefore: number; callsAfter: number; messagesJson: string }> {
  const faux = registerFauxProvider();
  const largeText = "x".repeat(30000); // ~7500 tokens per response
  faux.setResponses([
    () => fauxAssistantMessage(`${largeText} turn 1`),
    () => fauxAssistantMessage(`${largeText} turn 2`),
    () => fauxAssistantMessage(`${largeText} turn 3`),
    () => fauxAssistantMessage("done"),
    // Spare responses: when the harness declines to take compaction over,
    // Pi summarizes with the model and consumes one of these.
    () => fauxAssistantMessage("pi-generated summary"),
    () => fauxAssistantMessage("pi-generated summary 2"),
  ]);

  const session = await setupSession({
    root: options.root,
    faux,
    serviceHostOptions: { compactionDepsProvider: options.compactionDepsProvider },
  });

  try {
    const snapshot = await session.host.create(options.root);
    for (const prompt of ["turn 1", "turn 2", "turn 3", "say done"]) {
      await session.host.prompt(snapshot.sessionId, prompt);
      await session.host.session.waitForIdle();
    }
    const callsBefore = faux.state.callCount;
    await session.host.session.compact();
    const callsAfter = faux.state.callCount;
    return {
      callsBefore,
      callsAfter,
      messagesJson: JSON.stringify(session.host.session.messages),
    };
  } finally {
    await session.dispose();
    faux.unregister();
  }
}

describe("session e2e — compaction extension", () => {
  it("takes compaction over with zero model calls once the memory keeper has blocks", async () => {
    await withTempRoot("piarium-s-compact-", async (root) => {
      let store: KnowledgeStore | undefined;
      try {
        store = await openWorkspaceKnowledge({
          dataDir: join(root, "data"),
          hostId: "test-host",
          workspaceId: WORKSPACE_ID,
          embedding: null,
        });
        await store.upsertBlock({
          sessionId: "unused",
          label: "progress",
          content: "keeper-written-progress-marker",
          updatedBy: "memory-agent",
        });
        const openStore = store;

        const result = await runCompactionCase({
          root,
          compactionDepsProvider: async (sessionId) => {
            // The keeper block is written under the real session id once it
            // is known; mirror it here so getBlocks(sessionId) finds it.
            await openStore.upsertBlock({
              sessionId,
              label: "progress",
              content: "keeper-written-progress-marker",
              updatedBy: "memory-agent",
            });
            return {
              store: openStore,
              settings: { ...DEFAULT_COMPACTION_SETTINGS, takeoverEnabled: true },
              getFacts: async (): Promise<CompactionFacts> => ({
                touchedFiles: ["a.ts"],
                unresolvedDiagnostics: [],
                checkpoints: [],
              }),
            };
          },
        });

        assert.match(
          result.messagesJson,
          /<piarium-compaction/,
          "the harness summary must replace the cut-off history",
        );
        assert.match(
          result.messagesJson,
          /keeper-written-progress-marker/,
          "the keeper's block must be carried across compaction",
        );
        assert.equal(
          result.callsAfter,
          result.callsBefore,
          "taking compaction over must cost zero model calls",
        );
      } finally {
        await store?.close();
      }
    });
  });

  it("leaves compaction to Pi when only the agent's plan block exists", async () => {
    await withTempRoot("piarium-s-compact-plan-", async (root) => {
      let store: KnowledgeStore | undefined;
      try {
        store = await openWorkspaceKnowledge({
          dataDir: join(root, "data"),
          hostId: "test-host",
          workspaceId: WORKSPACE_ID,
          embedding: null,
        });
        const openStore = store;

        const result = await runCompactionCase({
          root,
          compactionDepsProvider: async (sessionId) => {
            await openStore.upsertBlock({
              sessionId,
              label: "plan",
              content: "- [ ] a task",
              updatedBy: "agent",
            });
            return {
              store: openStore,
              settings: { ...DEFAULT_COMPACTION_SETTINGS, takeoverEnabled: true },
              getFacts: async (): Promise<CompactionFacts> => ({
                touchedFiles: ["a.ts"],
                unresolvedDiagnostics: [],
                checkpoints: [],
              }),
            };
          },
        });

        // A todo checklist is not a summary: replacing the conversation with
        // it would lose the work, so the host reports `unavailable` and Pi
        // summarizes with the model instead.
        assert.doesNotMatch(
          result.messagesJson,
          /<piarium-compaction/,
          "the harness must not take compaction over without keeper blocks",
        );
        assert.ok(
          result.callsAfter > result.callsBefore,
          `Pi must run its own summarization (calls ${result.callsBefore} → ${result.callsAfter})`,
        );
      } finally {
        await store?.close();
      }
    });
  });
});

// ── Permission gate ────────────────────────────────────────────────

describe("session e2e — permission gate extension", () => {
  it("asks before a write and performs it when the user allows once", async () => {
    await withTempRoot("piarium-s-perm-allow-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "allowed.txt", content: "hi" })]),
        () => fauxAssistantMessage("done"),
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: () => "Allow once",
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write allowed.txt");
        await session.host.session.waitForIdle();

        assert.equal(session.uiRequests.length, 1, "a write in normal mode must ask exactly once");
        assert.match(
          session.uiRequests[0]!.title,
          /allowed\.txt/,
          "the dialog must name the path being written",
        );
        assert.ok(existsSync(join(root, "allowed.txt")), "allowing once must let the write through");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("blocks the tool and leaves the file alone when the user denies", async () => {
    await withTempRoot("piarium-s-perm-deny-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "denied.txt", content: "hi" })]),
        (context) => { contexts.push(context); return fauxAssistantMessage("understood"); },
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: () => "Deny",
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write denied.txt");
        await session.host.session.waitForIdle();

        assert.equal(session.uiRequests.length, 1);
        assert.ok(!existsSync(join(root, "denied.txt")), "a denied write must not touch the disk");
        // The model has to learn it was blocked, and why.
        assert.ok(contexts.length >= 1, "the agent loop must continue after a block");
        assert.match(JSON.stringify(contexts[0]!.messages), /denied/i, "the block reason must reach the model");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("remembers 'allow for this session' but still asks for a high-risk path", async () => {
    await withTempRoot("piarium-s-perm-session-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "one.txt", content: "1" })]),
        () => fauxAssistantMessage([fauxToolCall("write", { path: "two.txt", content: "2" })]),
        () => fauxAssistantMessage([fauxToolCall("write", { path: ".env", content: "SECRET=1" })]),
        () => fauxAssistantMessage("done"),
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: (_request, index) => (index === 0 ? "Allow for this session" : "Deny"),
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write three files");
        await session.host.session.waitForIdle();

        // First write asks and is granted for the session; the second write
        // must not ask again; the third targets `.env`, which is high-risk
        // and therefore asks despite the session grant (§3b.2).
        assert.equal(
          session.uiRequests.length,
          2,
          `expected 2 dialogs (first write + high-risk .env), got ${session.uiRequests.length}: ${session.uiRequests.map((r) => r.title).join(" | ")}`,
        );
        assert.match(session.uiRequests[1]!.title, /\.env/, "the second dialog must be the .env write");
        assert.ok(existsSync(join(root, "one.txt")), "first write was allowed");
        assert.ok(existsSync(join(root, "two.txt")), "second write rode the session grant");
        assert.ok(!existsSync(join(root, ".env")), "the high-risk write was denied");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("does not ask for a read-only tool", async () => {
    await withTempRoot("piarium-s-perm-read-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })]),
        () => fauxAssistantMessage("done"),
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: () => "Deny",
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "read a file");
        await session.host.session.waitForIdle();

        assert.equal(
          session.uiRequests.length,
          0,
          "mutation:none tools are allowed without a prompt",
        );
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("uses the configured Smart judge for an ordinary edit without prompting", async () => {
    await withTempRoot("piarium-s-perm-smart-", async (root) => {
      const faux = registerFauxProvider();
      const model = faux.getModel();
      const judgeContexts: Context[] = [];
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "smart.txt", content: "ok" })]),
        (context) => { judgeContexts.push(context); return fauxAssistantMessage("allow"); },
        () => fauxAssistantMessage("done"),
      ]);
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: {
          models: { permissionJudge: { providerId: model.provider, modelId: model.id } },
          permissions: { mode: "smart", rules: [] },
        },
      }), "utf8");
      const session = await setupSession({ root, faux, answerDialog: () => "Deny" });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write smart.txt");
        await session.host.session.waitForIdle();
        assert.equal(session.uiRequests.length, 0);
        assert.ok(existsSync(join(root, "smart.txt")));
        assert.equal(judgeContexts.length, 1);
        assert.match(judgeContexts[0]!.systemPrompt ?? "", /permission judge/i);
        const stats = session.host.stats(snapshot.sessionId);
        assert.equal(stats.modelSlotUsage?.permissionJudge?.calls, 1);
        assert.ok((stats.modelSlotUsage?.permissionJudge?.tokens.total ?? 0) > 0);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("gives a session-published permission service sole prompt ownership", async () => {
    await withTempRoot("piarium-s-perm-plugin-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "plugin-owned.txt", content: "ok" })]),
        () => fauxAssistantMessage("done"),
      ]);
      const extensions = join(root, "agent", "extensions");
      await mkdir(extensions, { recursive: true });
      await writeFile(join(extensions, "permission-owner.ts"), `
const servicesKey = Symbol.for("@gotgenes/pi-permission-system:session-services");
let ownedSessionId: string | undefined;
export default function permissionOwner(pi: any) {
  pi.on("session_start", (_event: unknown, ctx: any) => {
    ownedSessionId = ctx.sessionManager.getSessionId();
    const root = globalThis as any;
    const services = root[servicesKey] instanceof Map ? root[servicesKey] : new Map();
    root[servicesKey] = services;
    services.set(ownedSessionId, {});
    pi.events.emit("permissions:ready", { adjudicatesLocally: true, sessionId: ownedSessionId });
  });
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "write") return undefined;
    const choice = await ctx.ui.select("Plugin permission: " + String(event.input?.path ?? "write"), ["Allow once", "Deny"]);
    return choice === "Allow once" ? undefined : { block: true, reason: "Plugin denied write" };
  });
  pi.on("session_shutdown", () => {
    const services = (globalThis as any)[servicesKey];
    if (services instanceof Map && ownedSessionId) services.delete(ownedSessionId);
  });
}
`, "utf8");
      const session = await setupSession({ root, faux, answerDialog: () => "Allow once" });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write plugin-owned.txt");
        await session.host.session.waitForIdle();
        assert.equal(session.uiRequests.length, 1, "the plugin and fallback must not both prompt");
        assert.match(session.uiRequests[0]!.title, /^Plugin permission:/);
        assert.ok(existsSync(join(root, "plugin-owned.txt")));
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});
