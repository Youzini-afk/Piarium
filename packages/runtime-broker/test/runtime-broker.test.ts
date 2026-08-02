import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PIARIUM_PROTOCOL_VERSION } from "@piarium/protocol";
import type { PiRuntimeBrokerEvent } from "../src/index.js";
import {
  dispatchRuntimeRequest,
  PiRuntimeBroker,
  RuntimeDispatchError,
} from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

test("broker owns catalog and per-session Pi workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-runtime-broker-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "broker-smoke.ts"),
    `export default function extension(pi: any) {
      pi.registerCommand("broker-seed", {
        description: "Create a deterministic broker integration entry",
        handler: async () => pi.appendEntry("piarium.broker.smoke", { ready: true }),
      });
    }\n`,
  );
  const events: PiRuntimeBrokerEvent[] = [];
  const subscribedEvents: PiRuntimeBrokerEvent[] = [];
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-broker-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    emit: (event) => {
      events.push(event);
      if (event.kind === "host" && event.envelope.event === "project.trust.request") {
        throw new Error("observer failure must not block trust resolution");
      }
    },
    execArgv: ["--import", "tsx"],
    hostEntry: HOST_ENTRY,
    promptForProjectTrust: async () => ({ remember: false, trusted: true }),
  });
  const unsubscribe = broker.subscribe((event) => subscribedEvents.push(event));

  try {
    const handshake = await dispatchRuntimeRequest(broker, "host.handshake", {
      clientName: "surface-test",
      clientVersion: "0.1.0",
      mode: "test",
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    });
    assert.equal(handshake.protocolVersion, PIARIUM_PROTOCOL_VERSION);
    assert.equal(broker.catalogStarted, true);
    assert.deepEqual(await broker.listSessions(workspace), []);
    const workspaceProvider = await dispatchRuntimeRequest(
      broker,
      "provider.config.upsert",
      {
        config: {
          api: "openai-completions",
          baseUrl: "https://workspace-provider.example.test/v1",
          id: "workspace-provider",
          models: [{ id: "workspace-model", name: "Workspace model" }],
        },
        cwd: workspace,
        scope: "project",
      },
    );
    assert.equal(workspaceProvider.effectiveScope, "project");
    assert.ok(
      (await dispatchRuntimeRequest(broker, "provider.list", { cwd: workspace })).some(
        (provider) => provider.id === "workspace-provider",
      ),
    );
    const updatedSettings = await dispatchRuntimeRequest(broker, "settings.update", {
      cwd: workspace,
      remove: [],
      scope: "project",
      set: {
        workspaceHistory: {
          enabled: true,
          maxSessionsPerWorkspace: 12,
        },
      },
    });
    assert.deepEqual(updatedSettings.project.workspaceHistory, {
      enabled: true,
      maxSessionsPerWorkspace: 12,
    });
    assert.deepEqual(
      (await dispatchRuntimeRequest(broker, "settings.get", { cwd: workspace })).project,
      updatedSettings.project,
    );
    const updatedWtfConfig = await dispatchRuntimeRequest(
      broker,
      "config.document.update",
      {
        cwd: workspace,
        path: "wtf.json",
        remove: [],
        scope: "global",
        set: { words: ["oops"] },
      },
    );
    assert.deepEqual(updatedWtfConfig.document, { words: ["oops"] });
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "config.document.get", {
        cwd: workspace,
        path: "wtf.json",
        scope: "global",
      }),
      updatedWtfConfig,
    );
    assert.deepEqual(broker.activeSessionIds, []);
    let stopAuthPromptListener = () => {};
    const authPrompt = new Promise<{ requestId: string; sessionId: string }>((resolvePrompt) => {
      stopAuthPromptListener = broker.subscribe((event) => {
        if (event.kind !== "host" || event.envelope.event !== "provider.auth.prompt") return;
        if (event.envelope.data.providerId !== "workspace-provider") return;
        resolvePrompt({
          requestId: event.envelope.data.prompt.requestId,
          sessionId: event.envelope.data.sessionId,
        });
      });
    });
    const login = dispatchRuntimeRequest(broker, "provider.login", {
      cwd: workspace,
      providerId: "workspace-provider",
      type: "api_key",
    });
    const prompt = await authPrompt;
    stopAuthPromptListener();
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "provider.auth.respond", {
        response: { requestId: prompt.requestId, value: "workspace-test-key" },
        sessionId: prompt.sessionId,
      }),
      { accepted: true },
    );
    assert.deepEqual(await login, { authenticated: true });

    const created = await broker.createSession(workspace, "Broker smoke");
    assert.deepEqual(broker.activeSessionIds, [created.sessionId]);
    const recoveryStatus = await dispatchRuntimeRequest(broker, "recovery.status", {
      sessionId: created.sessionId,
    });
    assert.ok(recoveryStatus.modes.includes("conversation"));
    assert.ok(recoveryStatus.providers.some((provider) => provider.id === "pi-native"));
    const models = await dispatchRuntimeRequest(broker, "model.list", {
      sessionId: created.sessionId,
    });
    assert.ok(Array.isArray(models));
    const providerDetails = await dispatchRuntimeRequest(broker, "provider.config.upsert", {
      config: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        id: "broker-provider",
        models: [{ id: "broker-model", name: "Broker model" }],
        name: "Broker provider",
      },
      scope: "user",
      sessionId: created.sessionId,
    });
    assert.equal(providerDetails.effectiveScope, "user");
    assert.ok(
      (await dispatchRuntimeRequest(broker, "provider.list", {
        sessionId: created.sessionId,
      })).some((provider) => provider.id === "broker-provider"),
    );
    await assert.rejects(
      dispatchRuntimeRequest(broker, "provider.config.upsert", {
        config: {
          api: "openai-completions",
          baseUrl: "file:///tmp/provider",
          id: "invalid-provider",
          models: [],
        },
        scope: "user",
        sessionId: created.sessionId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        return true;
      },
    );
    const commands = await broker.requestForSession(created.sessionId, "command.list", {
      sessionId: created.sessionId,
    });
    assert.ok(commands.some((command) => command.name === "broker-seed"));
    await broker.requestForSession(created.sessionId, "command.execute", {
      command: "/broker-seed",
      sessionId: created.sessionId,
    });
    const entries = await broker.requestForSession(created.sessionId, "session.entries", {
      scope: "branch",
      sessionId: created.sessionId,
    });
    assert.equal(entries.scope, "branch");
    assert.ok(
      entries.entries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry.type === "custom" &&
          entry.customType === "piarium.broker.smoke",
      ),
    );

    const tree = await dispatchRuntimeRequest(broker, "session.tree", {
      sessionId: created.sessionId,
    });
    assert.equal(tree.sessionId, created.sessionId);
    assert.match(JSON.stringify(tree.tree), /piarium\.broker\.smoke/);

    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "session.rename", {
        name: "Broker renamed",
        sessionId: created.sessionId,
      }),
      { name: "Broker renamed", sessionId: created.sessionId },
    );
    assert.equal(
      (await dispatchRuntimeRequest(broker, "session.archive", {
        sessionId: created.sessionId,
      })).id,
      created.sessionId,
    );
    assert.ok((await broker.listSessions(workspace))[0]?.archivedAt);
    const restored = await dispatchRuntimeRequest(broker, "session.unarchive", {
      sessionId: created.sessionId,
    });
    assert.equal(restored.archivedAt, undefined);
    assert.equal((await broker.listSessions(workspace))[0]?.archivedAt, undefined);

    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "session.delete", {
        sessionId: created.sessionId,
      }),
      { deleted: true, sessionId: created.sessionId },
    );
    assert.deepEqual(broker.activeSessionIds, []);
    assert.deepEqual(await broker.listSessions(workspace), []);
    assert.ok(events.some((event) => event.kind === "host"));
    assert.ok(subscribedEvents.some((event) => event.kind === "host"));
    await assert.rejects(
      dispatchRuntimeRequest(broker, "session.open", {}),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        return true;
      },
    );
  } finally {
    unsubscribe();
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("surface explicitly resolves project trust without a broker-owned deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-runtime-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "trusted.ts"),
    `export default function extension(pi: any) {
      pi.registerCommand("trusted-command", { handler: async () => undefined });
    }\n`,
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-trust-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", "tsx"],
    hostEntry: HOST_ENTRY,
  });

  try {
    let stop = () => {};
    const trustRequest = new Promise<{ requestId: string; workerId: string }>((resolveRequest) => {
      stop = broker.subscribe((event) => {
        if (event.kind !== "host" || event.envelope.event !== "project.trust.request") return;
        resolveRequest({
          requestId: event.envelope.data.id,
          workerId: event.workerId,
        });
      });
    });
    const creating = broker.createSession(workspace, "Trust from surface");
    const request = await trustRequest;
    stop();

    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "project.trust.respond", {
        remember: false,
        requestId: request.requestId,
        trusted: true,
        workerId: request.workerId,
      }),
      { accepted: true },
    );
    const created = await creating;
    const commands = await broker.requestForSession(created.sessionId, "command.list", {
      sessionId: created.sessionId,
    });
    assert.ok(commands.some((command) => command.name === "trusted-command"));
    assert.deepEqual(
      await dispatchRuntimeRequest(broker, "project.trust.respond", {
        remember: false,
        requestId: request.requestId,
        trusted: true,
        workerId: request.workerId,
      }),
      { accepted: false },
    );
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
