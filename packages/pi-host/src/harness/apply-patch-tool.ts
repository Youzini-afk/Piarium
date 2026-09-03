import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { withPathLock } from "./path-lock.js";

const ApplyPatchParams = Type.Object({
  path: Type.String(),
  patch: Type.String(),
});

interface PatchHunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

function parsePatch(patchText: string): { oldPath: string; newPath: string; hunks: PatchHunk[] } | { error: string } {
  const lines = patchText.split("\n");
  let oldPath = "";
  let newPath = "";
  const hunks: PatchHunk[] = [];
  let i = 0;

  // Parse header
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).trim();
    } else if (line.startsWith("+++ ")) {
      newPath = line.slice(4).trim();
    } else if (line.startsWith("@@")) {
      break;
    }
    i++;
  }

  if (!oldPath || !newPath) {
    return { error: "Missing --- or +++ header in patch" };
  }

  // Parse hunks
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }

    const match = line.match(/^@@ -(\d+)/);
    if (!match) {
      return { error: `Invalid hunk header: ${line}` };
    }
    const oldStart = parseInt(match[1]!, 10);
    i++;

    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      const hunkLine = lines[i]!;
      if (hunkLine.startsWith("-")) {
        oldLines.push(hunkLine.slice(1));
      } else if (hunkLine.startsWith("+")) {
        newLines.push(hunkLine.slice(1));
      } else if (hunkLine.startsWith(" ")) {
        oldLines.push(hunkLine.slice(1));
        newLines.push(hunkLine.slice(1));
      } else if (hunkLine === "") {
        // Empty line in patch is context
        oldLines.push("");
        newLines.push("");
      }
      i++;
    }
    hunks.push({ oldStart, oldLines, newLines });
  }

  if (hunks.length === 0) {
    return { error: "No hunks found in patch" };
  }

  return { oldPath, newPath, hunks };
}

function applyHunks(content: string, hunks: PatchHunk[]): { result: string; applied: number } | { error: string } {
  const contentLines = content.split("\n");
  const result: string[] = [];
  let contentIdx = 0;
  let applied = 0;

  for (const hunk of hunks) {
    // Copy lines before the hunk
    const targetIdx = hunk.oldStart - 1; // 0-indexed
    while (contentIdx < targetIdx && contentIdx < contentLines.length) {
      result.push(contentLines[contentIdx]!);
      contentIdx++;
    }

    if (contentIdx !== targetIdx) {
      return { error: `Hunk at line ${hunk.oldStart} does not match: expected to be at index ${targetIdx}, but at ${contentIdx}` };
    }

    // Verify old lines match
    for (let j = 0; j < hunk.oldLines.length; j++) {
      const contentLine = contentLines[contentIdx + j];
      const oldLine = hunk.oldLines[j];
      if (contentLine !== oldLine) {
        return { error: `Context mismatch at line ${hunk.oldStart + j}: expected "${oldLine}", got "${contentLine}"` };
      }
    }

    // Apply new lines
    result.push(...hunk.newLines);
    contentIdx += hunk.oldLines.length;
    applied++;
  }

  // Copy remaining lines
  while (contentIdx < contentLines.length) {
    result.push(contentLines[contentIdx]!);
    contentIdx++;
  }

  return { result: result.join("\n"), applied };
}

export function createApplyPatchTool(bridge: HostServicesBridge, sessionId: string, cwd: string): ToolDefinition {
  return defineTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply a unified diff patch to a file. Uses standard --- /+++ / @@ -n,+m @@ format.",
    promptSnippet: "apply_patch: apply unified diff patches to files",
    promptGuidelines: [
      "Use apply_patch for multi-line edits or when you have a diff ready.",
      "The patch must include --- and +++ headers and at least one @@ hunk.",
    ],
    parameters: ApplyPatchParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const filePath = resolve(cwd, params.path);

      return withPathLock(
        bridge,
        sessionId,
        [filePath],
        async () => {
          const parsed = parsePatch(params.patch);
          if ("error" in parsed) {
            return {
              content: [{ type: "text", text: `patch parse error: ${parsed.error}` }],
              details: { applied: false, error: parsed.error },
            };
          }

          let oldContent: string;
          try {
            oldContent = readFileSync(filePath, "utf8");
          } catch {
            return {
              content: [{ type: "text", text: `file not found: ${params.path}` }],
              details: { applied: false, error: "file not found" },
            };
          }

          const applyResult = applyHunks(oldContent, parsed.hunks);
          if ("error" in applyResult) {
            return {
              content: [{ type: "text", text: `patch apply error: ${applyResult.error}` }],
              details: { applied: false, error: applyResult.error },
            };
          }

          writeFileSync(filePath, applyResult.result, "utf8");

          // Request diagnostics after the change
          let diagnosticsText = "";
          try {
            const diagResult = await bridge.request("lsp.diagnostics", {
              path: filePath,
              afterSnapshot: applyResult.result,
              waitMs: 500,
            });
            if (diagResult.diagnostics.length > 0) {
              diagnosticsText = `\n\nDiagnostics (${diagResult.diagnostics.length}):\n`;
              for (const d of diagResult.diagnostics.slice(0, 10)) {
                diagnosticsText += `  ${d.severity} [${d.source}]: ${d.message} (line ${d.line})\n`;
              }
              if (diagResult.diagnostics.length > 10) {
                diagnosticsText += `  ... and ${diagResult.diagnostics.length - 10} more\n`;
              }
            }
          } catch {
            // Diagnostics are best-effort
          }

          return {
            content: [{ type: "text", text: `patch applied: ${applyResult.applied} hunk(s) to ${params.path}${diagnosticsText}` }],
            details: { applied: true, hunks: applyResult.applied },
          };
        },
      );
    },
  });
}
