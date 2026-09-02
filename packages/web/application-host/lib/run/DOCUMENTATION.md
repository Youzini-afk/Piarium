# Run, debug, and test

Application-host supervisors for workspace tasks, DAP adapters, and test providers.
Spawn, JSON-RPC, process lifetime, and stdout stay in this module. Renderers never
start a debugger, test runner, or task process.

## Entrypoints

- `runtime.ts`: `createRunRuntime({ documents, spawn, pathModule, env, isTrusted })`
- `tasks.ts`: `piarium.tasks.tson` configurations; host-owned `node` scripts use `process.execPath`
- `debug-supervisor.ts`: DAP session per workspace, generation, breakpoints, watch
- `test-supervisor.ts`: discovery/run tree; builtin Node test runner plus extension adapters
- `routes.ts`: authenticated `/api/tasks/*`, `/api/debug/*`, `/api/tests/*` and SSE events
- `capability.ts`: `workspace.tasks`, `workspace.debug`, `workspace.test`
- `fixture-adapter.ts` / `fixture-tests.ts` / `node-adapter.ts`: test and builtin adapters

## Status

Each workspace debug/test/task owner is `absent`, `starting`/`running`/`paused`, `stopped`,
`failed`, or `empty`. A crash or failure affects only that owner. Stale UI results whose
`generation` does not match the current owner are dropped.

Project-provided (`source: 'workspace'`) commands run only when `isTrusted(root)` is true.
Production Web sets `isTrusted` to false. There is no HTTP route that registers adapters
or providers.

Breakpoint mutation always sends the observed owner as `expectedSessionId` plus `expectedGeneration`,
or sends both as `null` when it authoritatively observed no active session and is preconfiguring. The
supervisor applies a mutation only to that owner state; `ready` and `stale` both return the current owner
identity (when active) and authoritative breakpoint list.

## Routes

- `POST /api/tasks/list|run|cancel|dispose-workspace`
- `GET /api/tasks/events?workspaceId=` SSE
- `POST /api/debug/status|breakpoints|start|stop|control|dispose-workspace`
- `GET /api/debug/events?workspaceId=` SSE
- `POST /api/tests/discover|run|cancel|status|dispose-workspace`
- `GET /api/tests/events?workspaceId=` SSE

Credentials stay in headers. Payloads must not include file bodies.

Application-host endpoint/workspace switch disposes owners. Electron reuses this Web host.
VS Code webviews report run/debug/test as `absent`/`unsupported` and do not spawn.
The official IDE Run view unsubscribes when hidden and does not keep refreshing.
