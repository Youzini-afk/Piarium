# Agent Harness — Host Side

The host-side harness provides workspace-scoped services that the pi-host
agent tools call via the `HostServicesBridge`. All services are registered
on the `HarnessRouter` and dispatched from the broker event stream.

## Architecture

```
broker event stream ──→ HarnessRouter.processEvent()
                           ├── shell.exec   → ShellSupervisor (per-session PTY)
                           ├── shell.read   → ShellSupervisor
                           ├── shell.write  → ShellSupervisor
                           ├── shell.kill   → ShellSupervisor
                           ├── output.store → OutputStore (global)
                           ├── output.read  → OutputStore
                           ├── search.content → HarnessSearchService
                           ├── fs.lock      → PathLockService + Documents identity
                           ├── lsp.diagnostics → LspDiagnosticsService
                           ├── lsp.diagnosticsSnapshot → LspDiagnosticsService
                           ├── memory.blocks.* → KnowledgeStore block validator
                           ├── zone2.assemble → Knowledge material + ThreadRegistry projection
                           └── thread.*     → ThreadRegistry + ThreadRuntime + Git worktree
```

## Components

### HarnessServiceHost (`service-host.ts`)

Global singleton that owns:
- `OutputStore` — large output storage with per-session isolation
- `ObservationCursorStore` — atomic per-observer shell/diagnostics baselines, reset by compaction
- `PathLockService` — owner-bound canonical-resource leases
- `HarnessSearchService` — wraps `createWorkspaceContentSearch`
- `DiagnosticsProvider` — LSP diagnostics (optional)
- Per-session `ShellSupervisor` registry

### HarnessRouter (`router.ts`)

Consumes `harness.request` events from the broker stream and dispatches
to registered services. Responds via `harness.respond` on the broker. The
broker-pinned Actor must match the Host session registry and carry the method's
frozen capability. Path-bearing methods are resolved through Documents and, for
a restricted child Run, must also remain inside its scope.

### ShellSupervisor (`shell-supervisor.ts`)

PTY-based persistent shell per session:
- One login shell (git-bash / bash / wsl / powershell) per session
- Commands separated by sentinel markers (`__PIARIUM_SENTINEL_`)
- cwd/env/venv maintained between commands
- Background shells keep PTY alive, stdin open
- Data and cwd/exit sentinels continue to be consumed after a command moves to the background
- `registerWriter` callback for `mode: 'process'` writer registration

### OutputStore (`output-store.ts`)

Stores large tool outputs (default 256 MiB per session) with handle-based
retrieval. Handles are `out_XXX` format.

### PathLockService (`path-lock.ts`)

The Host first resolves every input through Documents identity, deduplicates
aliases, and acquires the complete path batch in canonical order. The returned
opaque lease IDs are owner-bound. This coordinates Harness-managed writes in
one Application Host; it does not claim to lock terminals, Git, external
processes, or a second Host.

### ThreadRegistry / ThreadRuntime

The registry persists one versioned atomic catalog per workspace. `Thread` is
durable work; `ThreadRun` is one execution attempt, and
`ThreadLaunchManifest` freezes model-adjacent launch inputs. `dispatch` commits
the Thread plus a `starting` Run and returns immediately. The runtime then
creates a managed worktree when needed, opens a real persisted Pi child
session with the role's active-tool allowlist, and projects broker events into
progress, attention, report, durable transcript, and integration state.

One unexpected worker exit is resumed in the same session/worktree as a new
Run; a second consecutive crash becomes `stalled` instead of entering a crash
loop. Interactive child prompts, event silence, and six identical tool
signatures project to `permission`/`user`, `stalled`, and `looping`. The Web UI
reads the same registry through `/api/harness/threads` and SSE; the Pi Fleet
registry exposes it through the `piarium-harness` provider.

### HarnessSearchService (`search-service.ts`)

Wraps `createWorkspaceContentSearch` with hit grouping, scoring, and
formatting. It intersects an explicit request path with the child scope before
launching ripgrep, passes those canonical workspace-contained roots to the
search process, and validates returned resource IDs again. Returns
`SearchContentResult` with files, hits, and totals.

### Knowledge context runtime (`../knowledge/context-runtime.ts`)

Fans committed Documents mutations out to the active sessions in that
workspace, keeps agent-authored changes out of Zone 2, correlates LSP
diagnostics only with pending user edits, and projects event-cursor deltas,
blocks, context usage, and prompt-relevant accepted knowledge. The cursor is
also embedded in the durable hidden Pi message so a worker reload can resume.
Model-produced memory block operations return through `memory.blocks.apply` and
are validated and applied in order here; model scheduling remains in pi-host.
Active child threads are added to every parent Zone 2 turn, while settled
threads use a separate observer cursor and appear only after their event
sequence changes. Nested child sessions resolve their owning Thread from the
durable Run record before listing children.
The session-state sidebar reads/updates blocks through authenticated context
routes. Block writes broadcast only an invalidation identity over SSE, never
the block body. Thread metadata routes use the same UI-auth middleware.

### LspDiagnosticsService (`diagnostics-service.ts`)

Provides `lsp.diagnostics` (sync document + wait) and
`lsp.diagnosticsSnapshot` (immediate snapshot). Uses `DiagnosticsProvider`
interface to abstract the LSP supervisor.
Snapshot calls are incremental per observer and canonical resource by default;
`full: true` is a non-mutating full view. `shell.read` follows the same rule when
neither `offset` nor `length` is supplied, while static `out_*` handles remain
explicit UTF-8 byte slices.

## Wiring (index.ts)

The harness is wired in `packages/web/application-host/index.ts`:

1. `HarnessServiceHost` instantiated after `workspaceContentSearch` and
   `languageSupervisor` are created.
2. `HarnessRouter` created after `recoveryTurnCoordinator`, with broker response,
   Actor resolution, and Documents-backed path authorization callbacks.
3. `registerHarnessServices()` registers all services on the router.
4. `harnessRouter.processEvent(event)` added to the broker subscription,
   aligned with `recoveryTurnCoordinator.processEvent`.
5. Session registration on `session.snapshot` event with bound workspace.
6. Disposal in `stop()`.

## Session Lifecycle

- **Register**: `session.snapshot` event with `workspace.kind === 'workspace'`
  triggers `harnessServiceHost.registerSession()` which creates a
  `ShellSupervisor` for the session.
- **Drop**: `harnessServiceHost.dropSession()` disposes the shell supervisor
  and clears session-scoped output entries and observation cursors.
- **Dispose**: `harnessServiceHost.dispose()` disposes all sessions and
  global services.
