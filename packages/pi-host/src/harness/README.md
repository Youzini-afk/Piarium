# Agent Harness — pi-host Side

The pi-host harness tools are custom tools registered in the Pi session's
`customTools` array. They call host-side services via `HostServicesBridge`.

## Tools

| Tool | Description | Host Service |
|------|-------------|--------------|
| `bash` | Execute shell commands (PTY, persistent shell) | `shell.exec` |
| `grep` | Content search with hit grouping | `search.content` |
| `apply_patch` | Codex-format multi-file patch (OpenAI only) | `fs.lock` + `lsp.diagnostics` |
| `get_output` | Retrieve stored/shell output by handle | `output.read` / `shell.read` |
| `write_to_process` | Write stdin to background shell | `shell.write` |
| `kill_shell` | Terminate a background shell | `shell.kill` |
| `diagnostics` | Get LSP diagnostics for a file | `lsp.diagnosticsSnapshot` |

## Registration

Tools are registered in `session-host.ts` `#createRuntimeFactory()`:

```typescript
const customTools: ToolDefinition[] = [];
if (workspaceMutationJournal !== undefined) {
  customTools.push(...createWorkspaceMutationJournalTools(
    cwd, workspaceMutationJournal, hostServicesBridge, sessionId,
  ));
}
customTools.push(
  createBashTool(hostServicesBridge, sessionId, cwd),
  createGrepTool(hostServicesBridge, sessionId),
  createGetOutputTool(hostServicesBridge, sessionId),
  createWriteToProcessTool(hostServicesBridge, sessionId),
  createKillShellTool(hostServicesBridge, sessionId),
  createDiagnosticsTool(hostServicesBridge, sessionId),
);
// apply_patch: OpenAI family only
if (isOpenAIFamily) {
  customTools.push(createApplyPatchTool(
    hostServicesBridge, sessionId, cwd, workspaceMutationJournal,
  ));
}
```

## Extensions

- `createToolResultTruncationExtension` — truncates large tool results,
  stores full text via `output.store`, adds `[output: N bytes]` marker.
- `createHarnessCounterTracker` — tracks `toolErrors`, `toolRetries`,
  `outputBytes`, `cacheHitRatio`.

## HostServicesBridge

The `HostServicesBridge` sends `harness.request` events to the host via
the broker. The host's `HarnessRouter` dispatches to the appropriate
service and responds via `harness.respond`.

```
pi-host: bridge.request("shell.exec", { command, cwd, waitMs })
   → emit("harness.request", { method, params, requestId, sessionId })
   → host: HarnessRouter.processEvent() → ShellSupervisor.exec()
   → emit("harness.respond", { requestId, result/error })
   → pi-host: bridge resolves promise
```

## Path Locking

`withPathLock(bridge, sessionId, paths, fn)` acquires `fs.lock` for each
path, executes `fn`, then releases. Used by `apply_patch` to prevent
concurrent edits.

## Mutation Journal Integration

`createWorkspaceMutationJournalTools` accepts an optional
`HostServicesBridge`. After each edit/write, it fetches `lsp.diagnostics`
and appends a summary to the tool result (three states: unavailable,
pending, clean).

`apply_patch` also goes through `workspace.mutation.request` before/after
each file operation, ensuring all changes are journaled.
