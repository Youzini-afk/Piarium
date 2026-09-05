# Agent Harness — pi-host Side

The pi-host harness tools are custom tools registered in the Pi session's
`customTools` array. They call host-side services via `HostServicesBridge`.

## Tools

| Tool | Description | Host Service |
|------|-------------|--------------|
| `bash` | Execute shell commands (PTY, persistent shell) | `shell.exec` |

> **Note**: Under PTY-based shells (git-bash, wsl, bash), stdout and stderr
> are merged into a single stream. The `stderr` field in `ShellExecResult`
> will be empty; all output appears in `stdout`. PowerShell is the only
> interpreter that separates the streams (but it is not yet wired).
| `grep` | Content search with hit grouping | `search.content` |
| `apply_patch` | Codex-format multi-file patch (OpenAI only) | `fs.lock` + `lsp.diagnostics` |
| `get_output` | Retrieve stored/shell output by handle | `output.read` / `shell.read` |
| `write_to_process` | Write stdin to background shell | `shell.write` |
| `kill_shell` | Terminate a background shell | `shell.kill` |
| `diagnostics` | Get LSP diagnostics for a file | `lsp.diagnosticsSnapshot` |
| `symbols`, `definition`, `references`, `hover` | Navigate a real language server with one-based positions | `lsp.*` |
| `dispatch`, `threads`, `wait`, `send`, `read_thread`, `merge`, `kill` | Operate Host-owned durable child threads | `thread.*` |

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
- `createPermissionGateExtension` — Harness-tool fallback for sessions without
  `pi-permission-system`. It resolves the plugin's session-keyed service on every
  call and yields completely while that service is active, so there is one
  approval owner rather than two dialogs. Smart mode is part of this fallback.
- `createMemoryAgentExtension` — user-enabled shadow observer. It captures the
  real session context at Pi hooks, calls the active model in the background,
  and submits only `memory_edit` operations plus the active ancestor path and
  exact context-producing entry IDs to Host validation. Its tool call
  and response never enter the main conversation, and it does not enable
  compaction takeover.

## HostServicesBridge

The `HostServicesBridge` sends `harness.request` events to the host via
the broker. The host's `HarnessRouter` dispatches to the appropriate
service and responds via `harness.respond`. Worker payloads do not carry a
session identity; the broker pins identity after `session.create/open` and
adds the trusted Actor envelope consumed by the Host.

```
pi-host: bridge.request("shell.exec", { command, cwd, waitMs })
   → emit("harness.request", { method, params, requestId })
   → host: HarnessRouter.processEvent() → ShellSupervisor.exec()
   → emit("harness.respond", { requestId, result/error })
   → pi-host: bridge resolves promise
```

## Path Locking

`withPathLock(bridge, sessionId, paths, fn)` submits one path batch. The Host
canonicalizes and orders it, returns owner-bound lease IDs, then the wrapper
releases those IDs after `fn`. `apply_patch` therefore acquires every file
before applying the first change and cannot deadlock with another reversed
multi-file patch in the same Host.

## Child Session Launch

The Application Host advertises `harnessThreads` in the private Host
handshake. Thread tools are absent when that capability is missing. A real
child launch supplies its resolved role model and tool allowlist to
`session.create/open` before Pi constructs the AgentSession; read-only roles do
not merely rely on a prompt asking them not to write. The role fragment and
scope stay in the first task message, keeping the base system prefix stable;
scope also travels in the broker-owned Actor envelope. Host path services
enforce it, but it is not an OS sandbox over shell text or Pi tools that access
the filesystem directly inside the worker.

## Mutation Journal Integration

`createWorkspaceMutationJournalTools` accepts an optional
`HostServicesBridge`. After each edit/write, it fetches `lsp.diagnostics`
and appends a summary to the tool result (three states: unavailable,
pending, clean).

`apply_patch` also goes through `workspace.mutation.request` before/after
each file operation, ensuring all changes are journaled.
