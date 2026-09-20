import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  FollowUpCheckResult,
  FollowUpGetResult,
  FollowUpListResult,
  FollowUpRegisterResult,
  FollowUpUpdateResult,
  HarnessMethod,
  HarnessServiceMap,
} from "@piarium/protocol";

/**
 * Follow-up tool (D-307 / Stage W): register a durable wait + continuation on
 * this thread. The host watches the source (clock, experiment terminal state,
 * or an explicit trigger) and resumes THIS thread through the normal
 * Thread/Run lifecycle — no polling loop, no second session.
 *
 * Registration is non-blocking by default: the agent keeps working and the
 * trigger lands as an inform in the next request. `pause: true` is the
 * explicit "wait" — it marks the thread as waiting on the follow-up and
 * pauses the goal so automation stops auditing until the trigger resumes it.
 */

const errorResult = (toolName: string, error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error instanceof HarnessRequestError || (error as { code?: string }).code !== undefined)
    ? (error as { code: string }).code
    : "failed";
  return {
    content: [{ type: "text" as const, text: `${toolName} failed (${code}): ${message}` }],
    isError: true as const,
    details: { code },
  };
};

const invalidParams = (toolName: string, message: string): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } => ({
  content: [{ type: "text" as const, text: `${toolName} failed (invalid-params): ${message}` }],
  isError: true as const,
  details: { code: "invalid-params" },
});

const describeSource = (source: Record<string, unknown>): string => {
  switch (source.kind) {
    case "time":
      return `at ${new Date(source.at as number).toISOString()}${typeof source.timezone === "string" ? ` (${source.timezone})` : ""}`;
    case "experiment":
      return `experiment attempt ${source.attemptId}${typeof source.fallbackAt === "number" ? `; check by ${new Date(source.fallbackAt).toISOString()} if still running` : ""}`;
    case "manual":
      return typeof source.note === "string" ? source.note : "explicit trigger only";
    default:
      return String(source.kind ?? "unknown");
  }
};

const describeView = (view: { id: string; status: string; waitingSummary?: string; revision: string }): string =>
  `${view.id} [${view.status}]${view.waitingSummary ? ` — ${view.waitingSummary}` : ""} (rev ${view.revision})`;

const sourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("time"),
    at: Type.Number({ description: "Absolute due time in epoch milliseconds (compute it — the host stores the instant, not the text)" }),
    timezone: Type.Optional(Type.String({ description: "IANA timezone the user meant, kept for display" })),
  }, { description: "Fire at a point in time" }),
  Type.Object({
    kind: Type.Literal("experiment"),
    attemptId: Type.String({ description: "Attempt id returned by the experiment tool's submit action" }),
    states: Type.Optional(Type.Array(Type.String(), { description: "Terminal states that satisfy the wait (default: completed/failed/cancelled/lost)" })),
    fallbackAt: Type.Optional(Type.Number({ description: "Epoch ms deadline — if the attempt is still running then, fire a 'deadline' occurrence instead of waiting silently forever" })),
  }, { description: "Fire when an experiment attempt reaches a terminal state" }),
  Type.Object({
    kind: Type.Literal("manual"),
    note: Type.Optional(Type.String({ description: "What is being awaited, for the audit trail" })),
  }, { description: "Fire only via check/fire — e.g. a signal the program cannot observe" }),
]);

export function createFollowUpTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "follow_up",
    label: "Follow-up",
    description:
      "Register a durable follow-up on this conversation: what to wait for (time, an experiment attempt finishing, or an explicit trigger) and what to do when it happens. The host watches the source — you do not poll. When it fires, this thread resumes with the trigger facts. Actions: register, list, get, update, cancel, check, fire.",
    promptSnippet: "follow_up: durable wait + continuation (register/list/get/update/cancel/check/fire)",
    promptGuidelines: [
      "Register AFTER the work exists: an experiment source needs the real attemptId from experiment submit, a time source needs a concrete epoch-ms instant you computed.",
      "Registration is non-blocking — keep working unless the user asked you to wait. With pause=true the thread is marked waiting, the goal pauses, and the trigger resumes the run; without it the trigger arrives as a message while you work.",
      "check is a program-side evaluation of the source (is the attempt done yet?) — it fires the follow-up if satisfied but never calls the model. fire invokes you now.",
      "Only a successful register result means the follow-up exists — never promise a trigger for a failed or unconfirmed registration.",
      "cancel stops the waiting, not the underlying work — cancelling a follow-up never kills the experiment it watches.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("register"), Type.Literal("list"), Type.Literal("get"),
        Type.Literal("update"), Type.Literal("cancel"), Type.Literal("check"),
        Type.Literal("fire"),
      ]),
      id: Type.Optional(Type.String({ description: "Follow-up id (get/update/cancel/check/fire)" })),
      instruction: Type.Optional(Type.String({
        description: "register/update: what to do when the source fires — natural language, e.g. \"if the run failed, diagnose and retry the data step\"",
      })),
      source: Type.Optional(sourceSchema),
      pause: Type.Optional(Type.Boolean({
        description: "register: explicitly end the turn and wait — pauses the goal and marks the thread waiting until the source fires (default false)",
      })),
      expectedRevision: Type.Optional(Type.String({ description: "CAS guard for update/cancel/fire — the revision returned by get" })),
      includeInactive: Type.Optional(Type.Boolean({ description: "list: include delivered/cancelled follow-ups (default false)" })),
      reason: Type.Optional(Type.String({ description: "fire: reason recorded on the forced occurrence" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const request = <M extends HarnessMethod>(method: M, body: HarnessServiceMap[M]["params"]) =>
        bridge.request(method, body, signal ? { signal } : undefined);
      try {
        switch (params.action) {
          case "register": {
            if (!params.instruction?.trim()) {
              return invalidParams("follow_up", "register requires instruction — what to do when the source fires");
            }
            if (!params.source) {
              return invalidParams("follow_up", "register requires source — what to wait for");
            }
            const result = await request("followup.register", {
              source: params.source,
              instruction: params.instruction,
              ...(params.pause !== undefined ? { pause: params.pause } : {}),
            }) as FollowUpRegisterResult;
            const lines = [
              `Follow-up registered: ${describeView(result.followUp)}`,
              `Waiting for ${describeSource(result.followUp.source as unknown as Record<string, unknown>)}.`,
              result.followUp.pausedGoal
                ? "Goal paused — this thread resumes when the source fires."
                : "You can keep working; the trigger arrives in this thread.",
            ];
            if (result.firedImmediately) {
              lines.push("The source was already satisfied — the follow-up fired during registration.");
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "list": {
            const result = await request("followup.list", {
              ...(params.includeInactive !== undefined ? { includeInactive: params.includeInactive } : {}),
            }) as FollowUpListResult;
            if (result.followUps.length === 0) {
              return {
                content: [{ type: "text", text: "No follow-ups registered on this thread." }],
                details: { total: 0 },
              };
            }
            return {
              content: [{ type: "text", text: result.followUps.map(describeView).join("\n") }],
              details: { total: result.followUps.length, followUps: result.followUps as unknown as Record<string, unknown>[] },
            };
          }
          case "get": {
            if (!params.id) return invalidParams("follow_up", "get requires id");
            const result = await request("followup.get", { id: params.id }) as FollowUpGetResult;
            const lines = [describeView(result.followUp), `instruction: ${result.followUp.instruction}`];
            for (const occurrence of result.occurrences) {
              lines.push(`  occurrence ${occurrence.id} [${occurrence.delivery}] ${occurrence.reason} at ${new Date(occurrence.at).toISOString()}`);
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "update": {
            if (!params.id) return invalidParams("follow_up", "update requires id");
            if (params.instruction === undefined && params.source === undefined) {
              return invalidParams("follow_up", "update requires instruction and/or source");
            }
            const result = await request("followup.update", {
              id: params.id,
              ...(params.instruction !== undefined ? { instruction: params.instruction } : {}),
              ...(params.source !== undefined ? { source: params.source } : {}),
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as FollowUpUpdateResult;
            return {
              content: [{ type: "text", text: `Updated: ${describeView(result.followUp)}` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "cancel": {
            if (!params.id) return invalidParams("follow_up", "cancel requires id");
            const result = await request("followup.cancel", {
              id: params.id,
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as FollowUpGetResult;
            return {
              content: [{ type: "text", text: `Cancelled: ${describeView(result.followUp)} — the watched work itself is unaffected.` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "check": {
            if (!params.id) return invalidParams("follow_up", "check requires id");
            const result = await request("followup.check", { id: params.id }) as FollowUpCheckResult;
            const observed = result.observed
              ? Object.entries(result.observed).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")
              : "";
            return {
              content: [{
                type: "text",
                text: `${describeView(result.followUp)}${result.fired ? " — condition held; follow-up fired" : ""}${observed ? `\nobserved: ${observed}` : ""}`,
              }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          case "fire": {
            if (!params.id) return invalidParams("follow_up", "fire requires id");
            const result = await request("followup.fire", {
              id: params.id,
              ...(params.reason !== undefined ? { reason: params.reason } : {}),
              ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
            }) as FollowUpGetResult;
            return {
              content: [{ type: "text", text: `Fired: ${describeView(result.followUp)}` }],
              details: { result: result as unknown as Record<string, unknown> },
            };
          }
          default:
            return invalidParams("follow_up", `unknown action "${String(params.action)}"`);
        }
      } catch (error) {
        return errorResult("follow_up", error);
      }
    },
  });
}
