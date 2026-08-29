import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData, PiAgentEvent } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost prompt streaming", () => {
  it("runs a complete prompt through a deterministic provider and settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-prompt-"));
    const agentDir = join(root, "agent");
    const agentStartedMarker = join(root, "agent-started.txt");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });
    await writeFile(
      join(projectExtensions, "delayed-agent-start.ts"),
      `import { writeFile } from "node:fs/promises";
      export default function extension(pi: any) {
        pi.on("agent_start", async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await writeFile(${JSON.stringify(agentStartedMarker)}, "started", "utf8");
        });
      }\n`,
      "utf8",
    );
    const events: Array<{ data: unknown; event: string }> = [];
    const faux = registerFauxProvider();
    let observedContext: unknown;
    faux.setResponses([(context) => {
      observedContext = context;
      return fauxAssistantMessage("hello from Piarium");
    }]);
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
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        events.push({ data, event });
      },
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(root);
      assert.equal(snapshot.model?.provider, model.provider);
      assert.deepEqual(host.clearQueue(snapshot.sessionId), {
        cleared: false,
        followUp: [],
        steering: [],
      });
      assert.deepEqual(
        await host.prompt(
          snapshot.sessionId,
          "say hello",
          undefined,
          "Answer with the hidden Piarium instruction.",
        ),
        { accepted: true },
      );
      assert.equal(
        await readFile(agentStartedMarker, "utf8"),
        "started",
        "accepted prompt responses must not precede the projected agent_start lifecycle",
      );
      await host.session.waitForIdle();

      const serialized = JSON.stringify(events);
      assert.match(serialized, /hello from Piarium/);
      assert.match(JSON.stringify(observedContext), /hidden Piarium instruction/);
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
      const projectedAgentEvents = events
        .filter((entry) => entry.event === "agent.event")
        .map((entry) => (entry.data as { event: PiAgentEvent }).event);
      const appended = projectedAgentEvents.filter((event) => event.type === "entry_appended");
      assert.ok(appended.some((event) => event.entry.type === "message" && event.entry.message.role === "user"));
      assert.ok(appended.some((event) => event.entry.type === "message" && event.entry.message.role === "assistant"));
      for (const event of projectedAgentEvents) {
        if (event.type === "agent_start"
          || event.type === "agent_end"
          || event.type === "agent_settled"
          || event.type === "turn_start"
          || event.type === "turn_end"
          || event.type === "entry_appended") {
          assert.equal(Number.isSafeInteger(event.turnIndex), true);
          assert.equal(event.leafId === null || typeof event.leafId === "string", true);
        }
      }
      const instructionsEntry = entries.entries.find(
        (entry) => entry.type === "custom_message" && entry.customType === "piarium.instructions",
      );
      assert.ok(instructionsEntry && instructionsEntry.type === "custom_message");
      assert.equal(instructionsEntry.display, false);
      assert.match(JSON.stringify(instructionsEntry.content), /hidden Piarium instruction/);
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
      assert.equal(
        host.entries(snapshot.sessionId, "branch").entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === "piarium.instructions",
        ),
        false,
      );
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
