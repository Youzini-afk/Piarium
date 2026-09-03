import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

export interface CapturedPayload {
  system: string;
  tools: unknown;
  messages: unknown[];
}

/**
 * Capture provider payloads by intercepting the faux provider's response
 * callbacks. Each callback receives the full provider `Context` which
 * contains `systemPrompt`, `tools`, and `messages`.
 *
 * Usage: call `registerFauxProvider()`, set responses via `faux.setResponses()`
 * with callbacks that push to `capturedContexts`, then run the session.
 * After the session, call `extractPayloads(capturedContexts)` to get
 * the normalized payloads.
 */
export function extractPayloads(contexts: Context[]): CapturedPayload[] {
  return contexts.map((ctx) => ({
    system: ctx.systemPrompt ?? "",
    tools: ctx.tools,
    messages: ctx.messages,
  }));
}

describe("Zone 0 stability contract (1.2)", () => {
  it("system and tools are byte-identical across 5 steps; messages are prefix-growing; goal activation does not change Zone 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-zone0-"));
    const agentDir = join(root, "agent");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });

    // Goal extension: uses message (Zone 2), NOT systemPrompt (Zone 0 violation)
    await writeFile(
      join(projectExtensions, "goal-ext.ts"),
      `export default function extension(pi: any) {
        pi.on("before_agent_start", (_event: any, ctx: any) => {
          const branch = ctx.sessionManager.getBranch();
          for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry && entry.type === "custom" && entry.customType === "piarium.session-features/v1" && entry.data?.goal?.status === "active") {
              return {
                message: {
                  customType: "piarium-goal",
                  content: "<piarium-active-goal>test goal</piarium-active-goal>",
                  display: false,
                },
              };
            }
          }
          return undefined;
        });
      }\n`,
      "utf8",
    );

    // Create a file for the read tool to succeed in tool-call steps
    await writeFile(join(root, "test.txt"), "hello world\n", "utf8");

    const faux = registerFauxProvider();
    const capturedContexts: Context[] = [];

    // 5 responses: steps 2 and 4 (0-indexed 1, 3) include tool calls
    faux.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage("step 1 done");
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "test.txt" }),
        ]);
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage("step 3 done");
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "test.txt" }),
        ]);
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage("step 5 done");
      },
    ]);

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
      emit: (() => {}) as <E extends HostEvent>(event: E, data: HostEventData<E>) => void,
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(root);

      // Step 1: plain prompt
      await host.prompt(snapshot.sessionId, "step 1");
      await host.session.waitForIdle();

      // Step 2: tool call
      await host.prompt(snapshot.sessionId, "step 2");
      await host.session.waitForIdle();

      // Activate goal before step 3
      host.mutateFeatures(snapshot.sessionId, {
        type: "goal.start",
        objective: "Zone 0 stability test goal",
      });

      // Step 3: after goal activation
      await host.prompt(snapshot.sessionId, "step 3");
      await host.session.waitForIdle();

      // Step 4: tool call
      await host.prompt(snapshot.sessionId, "step 4");
      await host.session.waitForIdle();

      // Step 5: plain
      await host.prompt(snapshot.sessionId, "step 5");
      await host.session.waitForIdle();

      assert.equal(capturedContexts.length, 5, "5 provider calls expected");
      const payloads = extractPayloads(capturedContexts);

      // Zone 0: system prompt must be byte-identical across all 5 steps
      const system0 = payloads[0]!.system;
      for (let i = 1; i < 5; i++) {
        assert.equal(payloads[i]!.system, system0, `system prompt must be byte-identical at step ${i + 1}`);
      }

      // Zone 0: tools must be byte-identical across all 5 steps
      const tools0 = JSON.stringify(payloads[0]!.tools);
      for (let i = 1; i < 5; i++) {
        assert.equal(JSON.stringify(payloads[i]!.tools), tools0, `tools must be byte-identical at step ${i + 1}`);
      }

      // Prefix property: step k messages must be a prefix of step k+1 messages
      for (let i = 0; i < 4; i++) {
        const msgs1 = payloads[i]!.messages;
        const msgs2 = payloads[i + 1]!.messages;
        assert.ok(msgs2.length >= msgs1.length, `step ${i + 2} must have >= messages than step ${i + 1}`);
        for (let j = 0; j < msgs1.length; j++) {
          assert.deepEqual(msgs2[j], msgs1[j], `step ${i + 2} message ${j} must equal step ${i + 1} message ${j}`);
        }
      }

      await host.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
