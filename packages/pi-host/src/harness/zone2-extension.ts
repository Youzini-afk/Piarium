import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { Zone2AssembleResult } from "@piarium/protocol";

/**
 * Zone 2 extension — hooks before_agent_start to request assembled
 * piarium-context content from the host.
 *
 * Design: agent-harness.md §8.1, §8.3
 * Plan: agent-harness-plan.md §2.2
 *
 * The host assembles Zone 2 material (user edits, commands, diagnostics,
 * git, knowledge, blocks, context usage) and returns a formatted string.
 * If the content is null (all sections empty), no message is appended.
 *
 * The message is appended as a custom message with display: false, so it
 * is visible to the model but not rendered as a chat bubble.
 */
export interface Zone2ExtensionOptions {
  bridge: HostServicesBridge;
  sessionId: string;
}

export function createZone2Extension(options: Zone2ExtensionOptions): ExtensionFactory {
  const { bridge, sessionId } = options;

  return (pi) => {
    pi.on("before_agent_start", async (_event, ctx) => {
      // Determine the turn index for sinceTurn — use the current turn count
      // from the session manager. The host uses this to filter events
      // that occurred since the last turn.
      const turnIndex = ctx.sessionManager.getBranch().filter(
        (e: { type: string; message?: { role?: string } }) =>
          e.type === "message" && e.message?.role === "user",
      ).length;

      try {
        const result = await bridge.request<"zone2.assemble">("zone2.assemble", {
          sinceTurn: Math.max(0, turnIndex - 1),
        }, { timeoutMs: 1_000 });
        const content = (result as Zone2AssembleResult).content;
        if (!content) return undefined;

        return {
          message: {
            customType: "piarium-context",
            content,
            display: false,
          },
        };
      } catch {
        // If the host doesn't support zone2.assemble (not configured),
        // silently skip — the agent proceeds without Zone 2 context.
        return undefined;
      }
    });
  };
}
