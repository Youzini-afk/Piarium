import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type * as PiAiCompat from "@earendil-works/pi-ai/compat";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost prompt streaming", () => {
  it("runs a complete prompt through a deterministic provider and settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-prompt-"));
    const agentDir = join(root, "agent");
    const events: Array<{ data: unknown; event: string }> = [];
    const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const compatEntry = new URL(
      "../node_modules/@earendil-works/pi-ai/dist/compat.js",
      codingAgentEntry,
    ).href;
    const { fauxAssistantMessage, registerFauxProvider } = (await import(
      compatEntry
    )) as typeof PiAiCompat;
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("hello from Piarium")]);
    const model = faux.getModel();
    const runtimeFactory: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ agentDir, cwd });
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
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key", {
        allowNetwork: false,
      });
      const created = await createAgentSessionFromServices({
        model,
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      });
      return { ...created, diagnostics: services.diagnostics, services };
    };
    const host = new SessionHost({
      agentDir,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        events.push({ data, event });
      },
      projectTrustOverride: true,
      runtimeFactory,
    });

    try {
      const snapshot = await host.create(root);
      assert.equal(snapshot.model?.provider, model.provider);
      assert.deepEqual(await host.prompt(snapshot.sessionId, "say hello"), { accepted: true });
      await host.session.waitForIdle();

      const serialized = JSON.stringify(events);
      assert.match(serialized, /hello from Piarium/);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "agent.event" &&
            typeof entry.data === "object" &&
            entry.data !== null &&
            JSON.stringify(entry.data).includes("agent_settled"),
        ),
      );
      const entries = host.entries(snapshot.sessionId, true);
      assert.ok(Array.isArray(entries));
      const userEntry = entries.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry.type === "message" &&
          typeof entry.message === "object" &&
          entry.message !== null &&
          !Array.isArray(entry.message) &&
          entry.message.role === "user",
      );
      const userEntryId =
        typeof userEntry === "object" &&
        userEntry !== null &&
        !Array.isArray(userEntry) &&
        typeof userEntry.id === "string"
          ? userEntry.id
          : undefined;
      assert.ok(userEntryId);
      const forked = await host.fork(snapshot.sessionId, userEntryId, "at");
      assert.equal(forked.cancelled, false);
      assert.notEqual(forked.snapshot.sessionId, snapshot.sessionId);
    } finally {
      await host.dispose();
      faux.unregister();
      await rm(root, { force: true, recursive: true });
    }
  });
});
