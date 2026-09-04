import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { OutputSlice, DiagnosticsResult } from "@piarium/protocol";

// ── get_output ──────────────────────────────────────────────────────
const GetOutputParams = Type.Object({
  handle: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  length: Type.Optional(Type.Integer({ minimum: 1 })),
});

export function createGetOutputTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "get_output",
    label: "Get Output",
    description: "Retrieve stored or background shell output by handle or shell ID. Paginate with offset/length.",
    promptSnippet: "get_output: retrieve stored/shell output by handle, paginate with offset/length",
    promptGuidelines: [
      "Use get_output to retrieve large outputs that were truncated or backgrounded.",
      "The handle is shown in the original tool result as out_XXX (stored) or sh_N (background shell).",
    ],
    parameters: GetOutputParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        // Try output.read first (for out_ handles), fall back to shell.read (for sh_ IDs)
        let result: OutputSlice & { running?: boolean; exitCode?: number };
        if (params.handle.startsWith("out_")) {
          const slice = await bridge.request("output.read", {
            handle: params.handle,
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.length !== undefined ? { length: params.length } : {}),
          });
          result = { ...slice, running: false };
        } else {
          result = await bridge.request("shell.read", {
            id: params.handle,
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.length !== undefined ? { length: params.length } : {}),
          });
        }
        const lines: string[] = [result.text];
        if (result.running) lines.push("\n[still running]");
        if (result.exitCode !== undefined) lines.push(`\n[exit ${result.exitCode}]`);
        const shown = `${result.nextOffset}/${result.total} bytes${result.eof ? " · eof" : ""}`;
        lines.push(`\n[${shown}]`);
        return {
          content: [{ type: "text", text: lines.join("") }],
          details: {
            handle: params.handle,
            offset: result.offset,
            length: result.length,
            nextOffset: result.nextOffset,
            total: result.total,
            eof: result.eof,
            running: result.running ?? false,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `get_output failed: ${message}` }],
          details: { handle: params.handle, error: message },
        };
      }
    },
  });
}

// ── write_to_process ────────────────────────────────────────────────
const WriteToProcessParams = Type.Object({
  shellId: Type.String(),
  text: Type.String(),
});

export function createWriteToProcessTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "write_to_process",
    label: "Write to Process",
    description: "Write text to the stdin of a background shell. Use after a bash command goes background and needs input.",
    promptSnippet: "write_to_process: send stdin to a background shell",
    promptGuidelines: [
      "Use write_to_process to send input to a background shell that is waiting for stdin.",
      "The shellId is shown in the bash result as sh_N.",
    ],
    parameters: WriteToProcessParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("shell.write", {
          id: params.shellId,
          text: params.text,
        });
        return {
          content: [{ type: "text", text: result.accepted ? `wrote ${Buffer.byteLength(params.text, "utf8")} bytes to ${params.shellId}` : `shell ${params.shellId} not found or not writable` }],
          details: { shellId: params.shellId, accepted: result.accepted },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `write_to_process failed: ${message}` }],
          details: { shellId: params.shellId, accepted: false, error: message },
        };
      }
    },
  });
}

// ── kill_shell ──────────────────────────────────────────────────────
const KillShellParams = Type.Object({
  shellId: Type.String(),
});

export function createKillShellTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "kill_shell",
    label: "Kill Shell",
    description: "Terminate a background shell by its shell ID.",
    promptSnippet: "kill_shell: terminate a background shell",
    promptGuidelines: [
      "Use kill_shell to stop a background shell that is no longer needed.",
    ],
    parameters: KillShellParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("shell.kill", { id: params.shellId });
        return {
          content: [{ type: "text", text: result.killed ? `killed ${params.shellId}` : `shell ${params.shellId} not found or already exited` }],
          details: { shellId: params.shellId, killed: result.killed },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `kill_shell failed: ${message}` }],
          details: { shellId: params.shellId, killed: false, error: message },
        };
      }
    },
  });
}

// ── diagnostics ────────────────────────────────────────────────────
const DiagnosticsParams = Type.Object({
  path: Type.String(),
});

export function createDiagnosticsTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "diagnostics",
    label: "Diagnostics",
    description: "Get LSP diagnostics for a file. Returns errors, warnings, and hints from the language server.",
    promptSnippet: "diagnostics: get LSP diagnostics for a file (errors, warnings, hints)",
    promptGuidelines: [
      "Use diagnostics after editing a file to check for type errors or lint issues.",
      "An empty result means the file is clean, not that the server is unavailable.",
    ],
    parameters: DiagnosticsParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("lsp.diagnosticsSnapshot", { path: params.path });
        return formatDiagnosticsResult(result, params.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `diagnostics failed: ${message}` }],
          details: { path: params.path, status: "unavailable", diagnostics: [] },
        };
      }
    },
  });
}

function formatDiagnosticsResult(result: DiagnosticsResult, path: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  if (result.status === "unavailable") {
    return {
      content: [{ type: "text", text: `diagnostics unavailable for ${path}` }],
      details: { path, status: "unavailable", diagnostics: [] },
    };
  }
  if (result.diagnostics.length === 0) {
    return {
      content: [{ type: "text", text: `${path}: clean (0 diagnostics)` }],
      details: { path, status: result.status, diagnostics: [] },
    };
  }
  const lines: string[] = [`${path}: ${result.diagnostics.length} diagnostic(s)`];
  for (const d of result.diagnostics) {
    lines.push(`  ${d.severity} [${d.source}${d.code ? `:${d.code}` : ""}] line ${d.line}: ${d.message}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { path, status: result.status, diagnostics: result.diagnostics },
  };
}
