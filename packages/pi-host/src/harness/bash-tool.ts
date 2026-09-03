import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { ShellExecResult } from "@piarium/protocol";

const BashParams = Type.Object({
  command: Type.String(),
  waitMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  runMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  description: Type.Optional(Type.String()),
});

function formatShellResult(result: ShellExecResult): string {
  switch (result.kind) {
    case "completed": {
      const lines: string[] = [];
      if (result.stdout) lines.push(result.stdout);
      if (result.stderr) lines.push(`[stderr]\n${result.stderr}`);
      lines.push(`\n[exit ${result.exitCode}]`);
      if (result.handle) {
        lines.push(`[full output: get_output("${result.handle}")]`);
      }
      return lines.join("\n");
    }
    case "background": {
      return `[Command is still running. waited ${result.waitedMs}ms]\n${result.outputSoFar}\n\n[Continue: get_output("${result.id}") or write_output("${result.id}", "...")]`;
    }
    case "spawn-failed": {
      return `[spawn failed: ${result.reason}]\n${result.hint ?? ""}`;
    }
    default:
      return `[unknown result kind]`;
  }
}

export function createBashTool(bridge: HostServicesBridge, sessionId: string): ToolDefinition {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: "Execute a bash command and return stdout, stderr, and exit code. Long-running commands are backgrounded after waitMs.",
    promptSnippet: "bash: execute shell commands (bash family)",
    promptGuidelines: [
      "Use bash for shell commands. The tool handles timeouts and backgrounding automatically.",
      "A non-zero exit code is a result, not an error. Only use bash when no specialized tool fits.",
      "Prefer grep, edit, read, write, and find tools over bash equivalents.",
    ],
    parameters: BashParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request("shell.exec", {
          command: params.command,
          ...(params.waitMs !== undefined ? { waitMs: params.waitMs } : {}),
          ...(params.runMs !== undefined ? { runMs: params.runMs } : {}),
        });
        const text = formatShellResult(result);
        return {
          content: [{ type: "text", text }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `bash failed: ${message}` }],
          details: { kind: "spawn-failed", reason: "bridge-error", interpreter: "", hint: message } as ShellExecResult,
        };
      }
    },
  });
}
