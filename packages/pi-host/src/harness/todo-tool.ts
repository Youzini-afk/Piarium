import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { TodoUpsertResult } from "@piarium/protocol";

const TodoParams = Type.Object({
  items: Type.Array(
    Type.Object({
      text: Type.String(),
      status: Type.Union([
        Type.Literal("open"),
        Type.Literal("done"),
        Type.Literal("blocked"),
      ]),
    }),
  ),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export function createTodoTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "todo",
    label: "Todo",
    description: "Update the session plan with a list of todo items and their statuses",
    promptSnippet: "todo: update the session plan with a list of todo items and their statuses",
    promptGuidelines: [
      "For non-trivial tasks, write a short plan with todo before acting, and state your confidence.",
    ],
    parameters: TodoParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"todo.upsert">("todo.upsert", {
          sessionId,
          items: params.items,
          ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
        });
        const typed = result as TodoUpsertResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: {
            askedConfirmation: typed.askedConfirmation,
            ...(typed.confirmed !== undefined ? { confirmed: typed.confirmed } : {}),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `todo failed: ${message}` }],
          details: { askedConfirmation: false },
        };
      }
    },
  });
}
