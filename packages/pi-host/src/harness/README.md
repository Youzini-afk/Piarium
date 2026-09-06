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
| `read` | Pi-native paging/truncation/images with fixed editor-draft source selection | `document.readSource` |
| `find` / `ls` | Pi-native glob/list rendering with fixed dirty-only paths and virtual ancestors | `document.pathOverlay` |
| `grep` | Bounded rg plus fixed editor-draft overlay and context lines | `search.content` |
| `apply_patch` | Codex-format multi-file patch (OpenAI only) | `fs.lock` + `lsp.diagnostics` |
| `get_output` | Retrieve stored/shell output by handle | `output.read` / `shell.read` |
| `write_to_process` | Write stdin to background shell | `shell.write` |
| `kill_shell` | Terminate a background shell | `shell.kill` |
| `diagnostics` | Get LSP diagnostics for a file, bound to its disk revision | `lsp.diagnosticsSnapshot` |
| `symbols`, `definition`, `references`, `hover` | Navigate a real language server with one-based positions, bound to this turn's fixed text | `lsp.*` |
| `explore` | Search versioned disk and latest accepted surface-draft excerpts | `explore.search` |
| `dispatch`, `threads`, `wait`, `send`, `read_thread`, `merge`, `kill` | Operate Host-owned durable child threads | `thread.*` |

## Registration

Tools are selected by `selectHarnessTools()` during `SessionHost.#createRuntimeFactory()`.
The read override is included only after the Host handshake advertises
`harnessDocumentRead`; otherwise Pi's built-in read remains registered. The
same-name `find` and `ls` overrides require `harnessDocumentPathOverlay` and
are independently disabled by `settings.tools.find` / `settings.tools.ls`.

```typescript
const customTools = selectHarnessTools(settings, {
  bridge: hostServicesBridge,
  sessionId,
  cwd,
  documentReadAvailable: harnessDocumentReadEnabled,
  documentPathOverlayAvailable: harnessDocumentPathOverlayEnabled,
  // other negotiated capabilities and runtime dependencies
});
```

## Extensions

- `createToolResultTruncationExtension` — truncates large tool results,
  stores full text via `output.store`, adds `[output: N bytes]` marker.
- `createHarnessCounterTracker` — tracks `toolErrors`, `toolRetries`,
  `outputBytes`, `observationCalls`, and `cacheHitRatio`. Auxiliary per-model usage
  aggregation was removed in D-080; ordinary Pi session cost and token statistics remain unchanged.
- `createPermissionGateExtension` — Harness-tool fallback for sessions without
  `pi-permission-system`. It resolves the plugin's session-keyed service on every
  call and yields completely while that service is active, so there is one
  approval owner rather than two dialogs. Smart mode is part of this fallback.
- `createMemoryAgentExtension` — background memory keeper. It captures the real
  session context at Pi hooks, calls the active model, and submits only
  `memory_edit` operations plus the active ancestor path and exact
  context-producing entry IDs to Host validation. Its tool call and response
  never enter the main conversation. The effective `off | assist | takeover`
  mode is read at every hook boundary; `off` also excludes stored blocks from
  Zone 2, while only `takeover` asks the Host for a compaction replacement.
- `createCompactionExtension` — derives Pi's actual removed context entries and
  accepts a Host replacement only in `takeover` mode. Missing coverage, branch
  drift, block-revision drift, or Host unavailability leaves that compaction to
  Pi and reports the failure through the session memory runtime state.

## HostServicesBridge

The `HostServicesBridge` sends `harness.request` events to the host via
the broker. The host's `HarnessRouter` dispatches to the appropriate
service and responds via `harness.respond`. Worker payloads do not carry a
session identity; the broker pins identity after `session.create/open` and
adds the trusted Actor envelope consumed by the Host.

SessionHost also gives the bridge the latest accepted `AgentInputContext`.
That object contains only disk/source state, dirty paths, and an opaque Host
snapshot reference; editor text never enters the worker request. Prompt,
steer, and follow-up temporarily select a new context, commit it after Pi
accepts the input, and restore/release it when delivery fails. Snapshot
bookkeeping failure after `agent_start` degrades the source to unavailable and
cannot turn an already-running prompt into a failed submission.
`grep`, `explore`, the Host-advertised same-name read/find/ls overrides, and the `lsp.*` navigation
tools consume this same fixed source. An expired related dirty source is unavailable, never a disk
fallback. Writing a path ends the draft's authority for it: after the journal acknowledges a
successful `write` / `edit` / `apply_patch`, every one of those tools reads that path from disk again,
so an agent reads back its own write. Navigation answers report the revision and source they were
computed from; positions in files the language server read itself are marked unpinned. `diagnostics`
is deliberately different: it describes the file as written to disk, because it is feedback about
what an agent just wrote.

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
scope also travels in the broker-owned Actor envelope. Host path services,
including fixed-source read, enforce it. This is not an OS sandbox over shell
text, third-party tools, or the built-in read used when the Host override is
unavailable or disabled.

## Mutation Journal Integration

`createWorkspaceMutationJournalTools` accepts an optional
`HostServicesBridge`. After each edit/write, it fetches `lsp.diagnostics`,
which binds the file's new disk revision and waits for the publication computed
from it, and appends a summary to the tool result (three states: unavailable,
pending, clean).

`apply_patch` also goes through `workspace.mutation.request` before/after
each file operation, ensuring all changes are journaled.
