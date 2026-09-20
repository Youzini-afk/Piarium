import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  SettingsReadResult,
  SettingsSearchResult,
  SettingsUpdateResult,
} from "@piarium/protocol";

/**
 * Conversational settings tools (D-306 / Stage S).
 *
 * Three stable entry points over the shared settings catalog — search by
 * text/category, read one stable id for the owner-backed value + effective
 * state + revision, and update/reset with CAS. The catalog is the same
 * descriptor list the settings UI searches, and every write goes through the
 * owning authority (app settings store or Pi settings.json) — there is no
 * agent-only settings copy.
 */

const invalidParams = (toolName: string, message: string): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } => ({
  content: [{ type: "text" as const, text: `${toolName} failed (invalid-params): ${message}` }],
  isError: true as const,
  details: { code: "invalid-params" },
});

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

export function createSettingsSearchTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_search",
    label: "Settings Search",
    description: "Find settings by question, keyword, category, or stable id. Returns catalog rows with the paths they control, who owns them (app host settings, Pi settings, device-local, or a domain action), and whether the agent can write them.",
    promptSnippet: "settings_search: locate a setting by keyword, category, or id",
    promptGuidelines: [
      "Search is scoped: pass a category (appearance, chat, sessions, model, harness, retrieval, web, notifications, git, extensions, agents, …) or free text. Results carry stable ids for settings_read.",
      "owner \"client\" means a device-local preference the agent can describe but not change; owner \"action\" means the row is a real operation (install, login, connect), not a stored value.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Free-text AND match over ids, paths, and keywords" })),
      category: Type.Optional(Type.String({ description: "Limit to one category" })),
      owner: Type.Optional(Type.Union([
        Type.Literal("app"), Type.Literal("pi-settings"),
        Type.Literal("client"), Type.Literal("action"),
      ])),
      id: Type.Optional(Type.String({ description: "Exact stable id lookup" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      offset: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      try {
        const result = await bridge.request<"settings.search">("settings.search", params, signal ? { signal } : undefined) as SettingsSearchResult;
        if (result.items.length === 0) {
          return {
            content: [{ type: "text", text: `No settings matched${params.query ? ` "${params.query}"` : ""}. Total catalog coverage is browsable by category — try a broader term or a category name.` }],
            details: { total: 0, categories: result.categories },
          };
        }
        const lines = result.items.map((item) => {
          const paths = item.paths.length > 0 ? ` → ${item.paths.join(", ")}` : "";
          const writable = item.writable ? "" : " (read-only)";
          return `- ${item.id} [${item.owner}${writable}]${item.apply ? ` apply:${item.apply}` : ""}${paths}${item.note ? ` — ${item.note}` : ""}`;
        });
        return {
          content: [{ type: "text", text: `${result.total} match(es):\n${lines.join("\n")}` }],
          details: { total: result.total, categories: result.categories, items: result.items },
        };
      } catch (error) {
        return errorResult("settings_search", error);
      }
    },
  });
}

export function createSettingsReadTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_read",
    label: "Settings Read",
    description: "Read one catalog setting by stable id: saved value, effective value and its source, document revision for safe updates, dynamic options, and related settings. detail=true adds options/related/help for complex entries.",
    promptSnippet: "settings_read: current value, effective source, and revision for one setting id",
    promptGuidelines: [
      "Read before writing when the value may have changed — the returned revision enables conflict-safe updates.",
      "state distinguishes ok / denied / malformed / unavailable / action / no-value; unavailable device-local rows are still describable but never writable.",
      "Credential fields report set/unset status only — secret material is never returned.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable catalog id from settings_search" }),
      scope: Type.Optional(Type.Union([
        Type.Literal("global"), Type.Literal("project"), Type.Literal("effective"),
      ], { description: "Pi settings only: which layer to read (default effective)" })),
      detail: Type.Optional(Type.Boolean({ description: "Resolve dynamic options, related ids, and help pointers" })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      if (!params.id?.trim()) return invalidParams("settings_read", "id is required");
      try {
        const result = await bridge.request<"settings.read">("settings.read", params, signal ? { signal } : undefined) as SettingsReadResult;
        const parts: string[] = [`${result.entry.id} — state: ${result.state}`];
        if (result.reason) parts.push(`reason: ${result.reason}`);
        if (result.fields) {
          for (const field of result.fields) {
            const shown = field.kind === "secret"
              ? (field.isSet ? "(set)" : "(unset)")
              : (field.isSet ? JSON.stringify(field.saved) : "(unset)");
            parts.push(`  ${field.path}: ${shown}`);
          }
        }
        if (result.effective) {
          parts.push(`effective: ${JSON.stringify(result.effective.value)} (source: ${result.effective.source})`);
        }
        if (result.revision) parts.push(`revision: ${result.revision}`);
        if (result.revisions) {
          parts.push(`revisions: global=${result.revisions.global ?? "-"} project=${result.revisions.project ?? "-"}`);
        }
        if (result.options?.length) {
          parts.push(`options: ${result.options.map((option) => option.label ? `${option.value} (${option.label})` : option.value).join(", ")}`);
        }
        if (result.related?.length) parts.push(`related: ${result.related.join(", ")}`);
        if (result.action) {
          parts.push(`action domain: ${result.action.domain}${result.action.verbs?.length ? ` verbs: ${result.action.verbs.join(", ")}` : ""}${result.action.note ? ` — ${result.action.note}` : ""}`);
        }
        if (result.help) parts.push(`help: ${result.help}`);
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: { result: result as unknown as Record<string, unknown> },
        };
      } catch (error) {
        return errorResult("settings_read", error);
      }
    },
  });
}

export function createSettingsUpdateTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "settings_update",
    label: "Settings Update",
    description: "Change or reset settings by stable id. set maps field paths to values; reset removes overrides at that scope. All declared fields are validated against the owner contract — invalid fields fail loudly instead of being dropped. Pass expectedRevision from settings_read to guard against concurrent user edits.",
    promptSnippet: "settings_update: set or reset fields on a catalog id (CAS via expectedRevision)",
    promptGuidelines: [
      "Pi settings accept scope \"global\" (default) or \"project\" — project writes require a trusted workspace and cannot carry user-owned fields like harness.models or web credentials.",
      "appliedAt reports when the change takes effect: immediate, next-run (frozen session/tool config), restart, or manual. Never claim a restarted or applied effect the owner did not perform.",
      "status \"partial\" means some fields failed — report exactly which and why.",
      "Action entries (install, connect, login) cannot be faked with a config write; the update call returns the real action target.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable catalog id" }),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")],
        { description: "Pi settings only: which file to write (default global)" })),
      set: Type.Optional(Type.Record(Type.String(), Type.Unknown(),
        { description: "field path → value; every path must belong to the entry" })),
      reset: Type.Optional(Type.Array(Type.String(),
        { description: "field paths to clear back to default" })),
      expectedRevision: Type.Optional(Type.String(
        { description: "revision from settings_read; conflicting writes are rejected" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      if (!params.id?.trim()) return invalidParams("settings_update", "id is required");
      if (!params.set && !params.reset?.length) {
        return invalidParams("settings_update", "provide set and/or reset");
      }
      try {
        const result = await bridge.request<"settings.update">("settings.update", params, signal ? { signal } : undefined) as SettingsUpdateResult;
        const lines = result.fields.map((field) =>
          `  ${field.path}: ${field.status}${field.error ? ` — ${field.error}` : ""}`);
        const parts = [
          `${result.entry.id} — ${result.status} (scope: ${result.scope}, applies: ${result.appliedAt})`,
          ...lines,
        ];
        if (result.revision) parts.push(`revision: ${result.revision}`);
        if (result.effective) {
          parts.push(`effective now: ${JSON.stringify(result.effective)}`);
        }
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: result.status === "failed",
          details: { result: result as unknown as Record<string, unknown> },
        };
      } catch (error) {
        return errorResult("settings_update", error);
      }
    },
  });
}
