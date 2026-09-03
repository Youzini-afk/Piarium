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
                           ├── fs.lock      → PathLockService (global)
                           ├── lsp.diagnostics → LspDiagnosticsService
                           └── lsp.diagnosticsSnapshot → LspDiagnosticsService
```

## Components

### HarnessServiceHost (`service-host.ts`)

Global singleton that owns:
- `OutputStore` — large output storage with per-session isolation
- `PathLockService` — per-path edit locks
- `HarnessSearchService` — wraps `createWorkspaceContentSearch`
- `DiagnosticsProvider` — LSP diagnostics (optional)
- Per-session `ShellSupervisor` registry

### HarnessRouter (`router.ts`)

Consumes `harness.request` events from the broker stream and dispatches
to registered services. Responds via `harness.respond` on the broker.

### ShellSupervisor (`shell-supervisor.ts`)

PTY-based persistent shell per session:
- One login shell (git-bash / bash / wsl / powershell) per session
- Commands separated by sentinel markers (`__PIARIUM_SENTINEL_`)
- cwd/env/venv maintained between commands
- Background shells keep PTY alive, stdin open
- `registerWriter` callback for `mode: 'process'` writer registration

### OutputStore (`output-store.ts`)

Stores large tool outputs (default 256 MiB per session) with handle-based
retrieval. Handles are `out_XXX` format.

### PathLockService (`path-lock.ts`)

Per-path mutex locks with configurable timeout. Prevents concurrent
edits to the same file.

### HarnessSearchService (`search-service.ts`)

Wraps `createWorkspaceContentSearch` with hit grouping, scoring, and
formatting. Returns `SearchContentResult` with files, hits, and totals.

### LspDiagnosticsService (`diagnostics-service.ts`)

Provides `lsp.diagnostics` (sync document + wait) and
`lsp.diagnosticsSnapshot` (immediate snapshot). Uses `DiagnosticsProvider`
interface to abstract the LSP supervisor.

## Wiring (index.ts)

The harness is wired in `packages/web/application-host/index.ts`:

1. `HarnessServiceHost` instantiated after `workspaceContentSearch` and
   `languageSupervisor` are created.
2. `HarnessRouter` created after `recoveryTurnCoordinator`, with
   `respond` and `resolveWorkspace` callbacks.
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
  and clears session-scoped output store entries.
- **Dispose**: `harnessServiceHost.dispose()` disposes all sessions and
  global services.
