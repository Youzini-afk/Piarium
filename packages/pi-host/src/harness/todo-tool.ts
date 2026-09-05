import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { DEFAULT_TODO_CONFIRM_BELOW, type TodoUpsertResult } from "@piarium/protocol";

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

export function createTodoTool(bridge: HostServicesBridge): ToolDefinition {
  let sessionConfirmed = false;
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        if (!sessionConfirmed && params.confidence !== undefined && params.confidence < DEFAULT_TODO_CONFIRM_BELOW) {
          const choice = await ctx.ui.select(
            `The proposed plan has low confidence (${params.confidence}). Use it?`,
            ["Use plan", "Cancel"],
          );
          if (choice !== "Use plan") {
            return {
              content: [{ type: "text", text: "plan update cancelled by user" }],
              details: { askedConfirmation: true, confirmed: false },
            };
          }
          sessionConfirmed = true;
        }
        const result = await bridge.request<"todo.upsert">("todo.upsert", {
          items: params.items,
          branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
          ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
          ...(sessionConfirmed ? { confirmed: true } : {}),
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
