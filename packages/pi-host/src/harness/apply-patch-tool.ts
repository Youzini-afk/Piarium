import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { WorkspaceMutationJournalBridge } from "../workspace-mutation-journal.js";
import { withPathLock } from "./path-lock.js";

const ApplyPatchParams = Type.Object({
  patch: Type.String({
    description: "Codex-format patch: *** Begin Patch / *** Update File: path / *** Add File: path / *** Delete File: path / @@ context / *** End Patch",
  }),
});

// ── Codex patch parser ─────────────────────────────────────────────

type PatchOperation =
  | { kind: "update"; path: string; hunks: CodexHunk[] }
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string };

interface CodexHunk {
  context: string[];   // lines starting with space or @@ (unchanged context)
  changes: Array<{ type: "add" | "remove"; line: string }>;
}

function parseCodexPatch(patchText: string): { operations: PatchOperation[] } | { error: string } {
  const lines = patchText.split("\n");
  const operations: PatchOperation[] = [];
  let i = 0;

  // Expect *** Begin Patch
  if (lines[i]?.trim() !== "*** Begin Patch") {
    return { error: "Patch must start with *** Begin Patch" };
  }
  i++;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "*** End Patch") break;

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i++;
      const hunks: CodexHunk[] = [];
      let currentHunk: CodexHunk | null = null;

      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const hunkLine = lines[i]!;
        if (hunkLine.startsWith("@@")) {
          if (currentHunk) hunks.push(currentHunk);
          // @@ marker: the rest of the line after "@@ " is context
          const ctxAfterMarker = hunkLine.slice(2);
          // Strip leading space (the separator between @@ and context)
          const ctx = ctxAfterMarker.startsWith(" ") ? ctxAfterMarker.slice(1) : ctxAfterMarker;
          currentHunk = {
            context: ctx.length > 0 ? [ctx] : [],
            changes: [],
          };
        } else if (hunkLine.startsWith("+")) {
          if (!currentHunk) return { error: "Change line outside hunk" };
          currentHunk.changes.push({ type: "add", line: hunkLine.slice(1) });
        } else if (hunkLine.startsWith("-")) {
          if (!currentHunk) return { error: "Change line outside hunk" };
          currentHunk.changes.push({ type: "remove", line: hunkLine.slice(1) });
        } else if (hunkLine.startsWith(" ")) {
          if (!currentHunk) return { error: "Context line outside hunk" };
          currentHunk.context.push(hunkLine.slice(1));
        } else if (hunkLine === "") {
          // Empty line is context
          if (currentHunk) currentHunk.context.push("");
        }
        i++;
      }
      if (currentHunk) hunks.push(currentHunk);
      operations.push({ kind: "update", path, hunks });
    } else if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        contentLines.push(lines[i]!);
        i++;
      }
      operations.push({ kind: "add", path, content: contentLines.join("\n") });
    } else if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      operations.push({ kind: "delete", path });
      i++;
    } else {
      i++;
    }
  }

  if (operations.length === 0) {
    return { error: "No file operations found in patch" };
  }

  return { operations };
}

// ── Apply a single update hunk ──────────────────────────────────────

function applyCodexHunks(content: string, hunks: CodexHunk[]): { result: string; applied: number } | { error: string } {
  const contentLines = content.split("\n");
  const result: string[] = [];
  let contentIdx = 0;
  let applied = 0;

  for (const hunk of hunks) {
    // Context lines are the search anchor — used to find position but
    // NOT output to result (they remain in the file, copied from content).
    const plainContext = hunk.context;

    // Find the context block in remaining content
    let foundIdx = -1;
    if (plainContext.length === 0 && hunk.changes.length > 0) {
      // No context — search for the first remove line as anchor
      const firstRemove = hunk.changes.find((c) => c.type === "remove");
      if (firstRemove) {
        for (let j = contentIdx; j < contentLines.length; j++) {
          if (contentLines[j] === firstRemove.line) {
            foundIdx = j;
            break;
          }
        }
        if (foundIdx === -1) {
          return { error: `Line not found for removal: ${firstRemove.line}` };
        }
      } else {
        // Only additions — apply at current position
        foundIdx = contentIdx;
      }
    } else {
      for (let j = contentIdx; j <= contentLines.length - plainContext.length; j++) {
        let match = true;
        for (let k = 0; k < plainContext.length; k++) {
          if (contentLines[j + k] !== plainContext[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundIdx = j;
          break;
        }
      }
    }

    if (foundIdx === -1) {
      const ctxPreview = plainContext.slice(0, 3).join(" | ");
      return { error: `Context not found for hunk: ${ctxPreview}` };
    }

    // Copy lines before context (or before the found remove position)
    while (contentIdx < foundIdx) {
      result.push(contentLines[contentIdx]!);
      contentIdx++;
    }

    // Copy context lines from content (they stay in the file)
    for (let k = 0; k < plainContext.length; k++) {
      result.push(contentLines[contentIdx]!);
      contentIdx++;
    }

    // Apply changes after context
    for (const change of hunk.changes) {
      if (change.type === "remove") {
        // Verify the line matches
        if (contentLines[contentIdx] !== change.line) {
          return { error: `Remove mismatch: expected "${change.line}", got "${contentLines[contentIdx] ?? "<EOF>"}"` };
        }
        contentIdx++;
      } else {
        result.push(change.line);
      }
    }
    applied++;
  }

  // Copy remaining lines
  while (contentIdx < contentLines.length) {
    result.push(contentLines[contentIdx]!);
    contentIdx++;
  }

  return { result: result.join("\n"), applied };
}

// ── Tool factory ────────────────────────────────────────────────────

export function createApplyPatchTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  cwd: string,
  mutationJournal?: WorkspaceMutationJournalBridge,
): ToolDefinition {
  return defineTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply a Codex-format multi-file patch. Supports *** Update File / *** Add File / *** Delete File with @@ context hunks.",
    promptSnippet: "apply_patch: apply Codex-format multi-file patches (Update/Add/Delete File)",
    promptGuidelines: [
      "Use apply_patch for multi-file edits with Codex patch syntax.",
      "Format: *** Begin Patch / *** Update File: path / @@ context / +added / -removed / *** End Patch",
    ],
    parameters: ApplyPatchParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, _signal, _onUpdate, _ctx) => {
      const parsed = parseCodexPatch(params.patch);
      if ("error" in parsed) {
        return {
          content: [{ type: "text", text: `patch parse error: ${parsed.error}` }],
          details: { applied: false, error: parsed.error },
        };
      }

      const results: string[] = [];
      let allOk = true;
      let totalHunks = 0;
      const filePaths = parsed.operations.map((operation) => resolve(cwd, operation.path));
      const diagnosticPaths: string[] = [];

      const patchResult = await withPathLock(bridge, filePaths, async () => {
        for (const [index, op] of parsed.operations.entries()) {
          const filePath = filePaths[index]!;
          const opResult = await (async () => {
            if (op.kind === "delete") {
              // before/after mutation journal
              if (mutationJournal) {
                await mutationJournal.request({ path: filePath, phase: "before", toolCallId, toolName: "apply_patch" });
              }
              try {
                rmSync(filePath);
                if (mutationJournal) {
                  await mutationJournal.request({ path: filePath, phase: "after", succeeded: true, toolCallId, toolName: "apply_patch" });
                }
                return { ok: true, message: `deleted ${op.path}` };
              } catch (error) {
                if (mutationJournal) {
                  await mutationJournal.request({ path: filePath, phase: "after", succeeded: false, toolCallId, toolName: "apply_patch" });
                }
                return { ok: false, message: `delete failed: ${(error as Error).message}` };
              }
            }

            if (op.kind === "add") {
              if (mutationJournal) {
                await mutationJournal.request({ path: filePath, phase: "before", toolCallId, toolName: "apply_patch" });
              }
              try {
                mkdirSync(dirname(filePath), { recursive: true });
                writeFileSync(filePath, op.content, "utf8");
                if (mutationJournal) {
                  await mutationJournal.request({ path: filePath, phase: "after", succeeded: true, toolCallId, toolName: "apply_patch" });
                }
                return { ok: true, message: `added ${op.path} (${op.content.length} bytes)` };
              } catch (error) {
                if (mutationJournal) {
                  await mutationJournal.request({ path: filePath, phase: "after", succeeded: false, toolCallId, toolName: "apply_patch" });
                }
                return { ok: false, message: `add failed: ${(error as Error).message}` };
              }
            }

            // Update
            if (!existsSync(filePath)) {
              return { ok: false, message: `file not found: ${op.path}` };
            }
            const oldContent = readFileSync(filePath, "utf8");

            if (mutationJournal) {
              await mutationJournal.request({ path: filePath, phase: "before", toolCallId, toolName: "apply_patch" });
            }

            const applyResult = applyCodexHunks(oldContent, op.hunks);
            if ("error" in applyResult) {
              if (mutationJournal) {
                await mutationJournal.request({ path: filePath, phase: "after", succeeded: false, toolCallId, toolName: "apply_patch" });
              }
              return { ok: false, message: `patch error in ${op.path}: ${applyResult.error}` };
            }

            writeFileSync(filePath, applyResult.result, "utf8");
            if (mutationJournal) {
              await mutationJournal.request({ path: filePath, phase: "after", succeeded: true, toolCallId, toolName: "apply_patch" });
            }

            diagnosticPaths.push(filePath);
            return { ok: true, message: `updated ${op.path}: ${applyResult.applied} hunk(s)`, hunks: applyResult.applied };
          })();

          if (opResult.ok) {
            results.push(`  ✓ ${opResult.message}`);
            totalHunks += opResult.hunks ?? 0;
          } else {
            results.push(`  ✗ ${opResult.message}`);
            allOk = false;
          }
        }

        const summary = allOk
          ? `patch applied successfully (${parsed.operations.length} file(s), ${totalHunks} hunk(s))`
          : `patch partially applied (${results.join("\n")})`;
        return {
          content: [{ type: "text" as const, text: allOk ? summary : `${summary}\n${results.join("\n")}` }],
          details: { applied: allOk, operations: parsed.operations.length, hunks: totalHunks },
        };
      });
      const diagnostics: string[] = [];
      for (const filePath of diagnosticPaths) {
        try {
          const result = await bridge.request("lsp.diagnostics", { path: filePath, waitMs: 500 });
          if (result.diagnostics.length > 0) diagnostics.push(`${filePath}: ${result.diagnostics.length}`);
        } catch { /* Best-effort feedback runs outside the mutation leases. */ }
      }
      if (diagnostics.length > 0) {
        patchResult.content[0]!.text += `\n\n[diagnostics: ${diagnostics.join("; ")}]`;
      }
      return patchResult;
    },
  });
}
