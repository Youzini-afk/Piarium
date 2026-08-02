import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost prompt streaming", () => {
  it("runs a complete prompt through a deterministic provider and settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-prompt-"));
    const agentDir = join(root, "agent");
    const events: Array<{ data: unknown; event: string }> = [];
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("hello from Piarium")]);
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
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key", {
        allowNetwork: false,
      });
      return { model };
    };
    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        events.push({ data, event });
      },
      projectTrustOverride: true,
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
      const entries = host.entries(snapshot.sessionId, "branch");
      assert.equal(entries.scope, "branch");
      const userEntry = entries.entries.find(
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
      const recovery = host.recoveryStatus(snapshot.sessionId);
      assert.equal(recovery.available, true);
      assert.ok(recovery.modes.includes("conversation"));
      assert.ok(recovery.providers.some((provider) => provider.id === "pi-native"));
      const recovered = await host.navigateRecovery(
        snapshot.sessionId,
        userEntryId,
        "conversation",
      );
      assert.equal(recovered.handledBy, "pi-native");
      assert.equal(recovered.outcome, "applied");
      assert.equal(recovered.editorText, "say hello");
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
