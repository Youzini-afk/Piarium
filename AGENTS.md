# Piarium contributor guide

## Product and source boundary

- Piarium is a Pi-native direct refactor of the maintainer's OpenChamber fork.
- `D:\project\opencr\openchamber*` is read-only source material. Never edit, switch branches,
  commit, or push there for Piarium work.
- All imports, deletions, rewrites, commits, and pushes happen in this repository.
- Do not preserve OpenCode contracts as a permanent compatibility layer. Replace them with one
  canonical set of Piarium-owned Pi types and services, then delete obsolete code.
- Preserve the fork capabilities listed in `docs/openchamber-pi-migration.md` unless a reviewed
  Pi-native implementation is behaviorally and security-equivalent.

## Runtime boundaries

- `packages/ui`: shared React UI, Pi domain state/sync, and runtime contracts.
- `packages/web`: web/remote surfaces and the trusted Pi runtime service.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/vscode`: extension host, webview, and runtime bridge.
- `packages/mobile`: Capacitor iOS/Android shell connected to a Piarium server.
- `packages/protocol`, `packages/pi-host`, `packages/recovery`: isolated Pi worker protocol,
  lifecycle, extension bridge, and transactional recovery.

Never execute Pi extensions in a renderer. Keep Electron preload APIs explicit and typed, validate
all process/network input, keep Pi session JSONL authoritative, and never log credentials, prompt
bodies, bearer/pairing data, or file contents.

## Required project guidance

Before changing imported OpenChamber code, read the nearest package `README.md` and
`DOCUMENTATION.md`, then load every matching `.agents/skills/*/SKILL.md`. At minimum:

- any code/dependency/export/build change: `piarium-change-discipline`;
- shared runtime APIs/routes: `ui-api-decoupling`;
- session state/sync: `sync-state-invariants`;
- Electron/packaging/processes: `desktop-shell`;
- relay/SSE/WebSocket: `relay-transport`;
- UI styling/text/settings: `theme-system`, `locale-ui-patterns`, `settings-ui-patterns` as relevant.

Keep authoritative failure distinct from successful empty state, preserve runtime parity, enforce
privilege at trusted boundaries, and make partial failure/rollback behavior explicit.

## Commands and commits

Use root/package `package.json` scripts as the command source of truth. The repository uses Bun
`1.3.14`. Run focused tests while iterating, workspace-wide checks for shared contracts, and
`bun run dead-code` after adding/deleting/renaming source or changing exports/import shapes.

Each roadmap phase is independently tested, committed, and pushed after its acceptance checks pass.
Preserve unrelated user changes and report exactly which runtime/build checks were and were not run.
