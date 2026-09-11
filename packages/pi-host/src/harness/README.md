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
| `read` | Pi-native paging/truncation/images with fixed editor-draft or working-branch source selection | `document.readSource` |
| `find` / `ls` | Pi-native glob/list rendering with fixed dirty-only or exclusive working-branch paths | `document.pathOverlay` |
| `grep` | Bounded rg plus fixed editor-draft overlay, or exclusive working-branch corpus | `search.content` |
| `apply_patch` | Codex-format multi-file patch (OpenAI only) | `fs.lock` + `lsp.diagnostics` |
| `get_output` | Retrieve stored/shell output by handle | `output.read` / `shell.read` |
| `write_to_process` | Write stdin to background shell | `shell.write` |
| `kill_shell` | Terminate a background shell | `shell.kill` |
| `diagnostics` | Get LSP diagnostics for a file, bound to its disk revision | `lsp.diagnosticsSnapshot` |
| `symbols`, `definition`, `references`, `hover` | Navigate a real language server with one-based positions, bound to this turn's fixed text | `lsp.*` |
| `explore` | Locate and read related context in one call; `question` plus optional literal `anchors` | `explore.query.*` (algorithm-only `explore.search` is the same engine) |
| `related` | File-level import topology and connection endpoints from the symbol graph | `related.query` |
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

- `createToolResultTruncationExtension` — truncates large non-shell tool results,
  stores full text via `output.store`, adds `[output: N bytes]` marker. `bash`
  and `get_output` keep Host-organized display and are not head/tail cut again.
- `createHarnessCounterTracker` — tracks `toolErrors`, `toolRetries`,
  `outputBytes`, `observationCalls`, and `cacheHitRatio`. Auxiliary per-model usage
  aggregation was removed in D-080; ordinary Pi session cost and token statistics remain unchanged.
- `createPermissionGateExtension` — Harness-tool fallback for sessions without
  `pi-permission-system`. It resolves the plugin's session-keyed service on every
  call and yields completely while that service is active, so there is one
  approval owner rather than two dialogs. Smart mode is part of this fallback.
- `createKnowledgeSuggestionExtension` — when `models.suggestions` is configured,
  drafts a workspace knowledge proposal from the current user message and stores
  it through Host `knowledge.suggest`. Unconfigured sessions keep user-mark and
  keeper paths only and never borrow the main model.
- `createMemoryAgentExtension` — background memory keeper. It captures the real
  session context at Pi hooks, calls the active model, and submits only
  `memory_edit` operations plus the active ancestor path and exact
  context-producing entry IDs to Host validation. Its tool call and response
  never enter the main conversation. The effective `off | assist | takeover`
  mode is read at every hook boundary; `off` also excludes stored blocks from
  Zone 2, while only `takeover` asks the Host for a compaction replacement.
  Host `memory.nudge` (`reason: "user-command"`) accelerates the same keeper
  after a material user-terminal event: off is zero calls, no prior turn is
  `no-session-context`, in-flight/cooldown merge into one follow-up run, and
  command facts appear only in the keeper instruction `<material>` block.
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
not merely rely on a prompt asking them not to write. `session.create/open`
receives the Documents workspace id for the current scratch or materialized
cwd (execution identity). Thread catalog, WorkingState, and parent/child
lifecycle stay on the original owning workspace; Host session bindings carry
that identity across register, dispatch, Zone 2, and lost resume. The role fragment and
scope stay in the first task message, keeping the base system prefix stable;
scope also travels in the broker-owned Actor envelope. Host path services,
including fixed-source read, enforce it. This is not an OS sandbox over shell
text, third-party tools, or the built-in read used when the Host override is
unavailable or disabled.

## Mutation Journal Integration

`createWorkspaceMutationJournalTools` accepts an optional
`HostServicesBridge`. Isolated Runs try `document.branchWrite` first. Root
sessions then call `document.surfaceWrite`: a snapshot-owned path edits the
Document Registry buffer and never journals a disk checkpoint; `{ status: "disk" }`
falls through to the existing `workspace.mutation.request` before/after loop.
After a disk edit/write, the wrapper fetches `lsp.diagnostics` and appends a
summary (unavailable, pending, or clean).

`apply_patch` uses the same shared plan. Mixed surface/disk batches return
per-path applied/conflict/compensated/needs-attention instead of a generic
failure after a partial write.
