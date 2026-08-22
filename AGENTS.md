# Piarium contributor guide

## Product and source boundary

- Piarium is a Pi-native direct refactor of the maintainer's OpenChamber fork.
- A local read-only OpenChamber checkout outside this repository is source material only.
  Never edit, switch branches, commit, or push there for Piarium work.
- All imports, deletions, rewrites, commits, and pushes happen in this repository.
- The OpenCode cutover is complete. Do not reintroduce OpenCode contracts, dual implementations, or
  compatibility shims. There is one canonical set of Piarium-owned Pi types and services.
- Preserve the fork capabilities listed in `docs/openchamber-pi-migration.md` unless a reviewed
  Pi-native implementation is behaviorally and security-equivalent.

## Runtime boundaries

- `packages/ui`: shared React UI, Pi domain state/sync, the Document Registry, the Editor Workbench
  Kernel, and runtime contracts.
- `packages/web`: web/remote surfaces and the trusted application host. It owns the Pi runtime
  service plus the document, search, language, task, debug, and test authorities.
- `packages/electron`: native desktop shell and privileged Electron boundary. It reuses the Web
  application host in-process and must not grow a parallel backend.
- `packages/vscode`: companion extension host, webview, and runtime bridge. Not a second workbench.
- `packages/mobile`: Capacitor iOS/Android shell connected to a Piarium server.
- `packages/protocol`, `packages/pi-host`: versioned Pi worker protocol, worker lifecycle, and the
  extension bridge.
- `packages/runtime-broker`, `packages/runtime-client`: catalog/session worker orchestration and the
  browser-safe surface client.
- `packages/extension-contract`, `-surface`, `-sdk`, `-react`, `-cli`: published Piarium extension
  platform contracts and author tooling.
- `packages/extension-host`, `-loader`, `-builtins`: privileged application-host catalog, the
  authenticated renderer module loader, and built-in extension manifests.

Never execute Pi extensions in a renderer. Keep Electron preload APIs explicit and typed, validate
all process/network input, keep Pi session JSONL authoritative, and never log credentials, prompt
bodies, bearer/pairing data, or file contents.

## Workbench and document ownership

Piarium's UI is composable: Agent Workspace (`default` profile) and IDE Workbench (`piarium.ide`)
are ordinary built-in Piarium extensions selected through a Workbench Profile, not hard-coded modes.
See [docs/composable-workbench-execution-plan.md](docs/composable-workbench-execution-plan.md).

- Do not add an `ideMode`/`agentMode` global branch or a third ownership path beside profiles.
- `packages/extension-contract` is the only owner of workbench target, slot, and context-key
  constants. Do not redeclare them in a shell or in `packages/ui`.
- Shells own presentation and layout only. Documents, editor groups, terminals, Git, profile state,
  and runtime identity belong to the shared kernel.
- Commit a profile or shell selection only after the candidate is ready; a failed or superseded
  candidate must leave the previous generation active.
- DocumentsAPI is the single text content authority. `FilesAPI` stays browse/binary/CRUD and
  `WorkspaceAPI` stays project/tree/git/upload; do not reintroduce a duplicate text read/write path.
- All document and profile mutations are expected-revision checked. Keep missing, empty, binary,
  unsupported-encoding, deleted, failed, and conflicting states distinguishable from each other.
- The application host owns LSP, DAP, test, and task subprocesses. Renderers send typed requests and
  never start a process. Hidden views must do no background work.
- Agent file writes go through expected-revision document writes and must never silently overwrite a
  dirty buffer.
- CodeMirror 6 is the only editor engine. Do not add Monaco or fork Code OSS.

## Required project guidance

Before changing code, read the nearest package `README.md` and `DOCUMENTATION.md`, then load every
matching `.agents/skills/*/SKILL.md`. At minimum:

- any code/dependency/export/build change: `piarium-change-discipline`;
- shared runtime APIs/routes: `ui-api-decoupling`;
- session state/sync: `sync-state-invariants`;
- Electron/packaging/processes: `desktop-shell`;
- relay/SSE/WebSocket: `relay-transport`;
- interaction, render, event, polling, or synchronization cost: `performance-engineering`;
- UI styling/text/settings: `theme-system`, `locale-ui-patterns`, `settings-ui-patterns`;
- CLI commands and prompts: `clack-cli-patterns`;
- sortable/drag-to-reorder behavior: `drag-to-reorder`;
- iOS Simulator work without Xcode: `serve-sim`.

Package-local `DOCUMENTATION.md` files are authoritative for their module's invariants. The
document, editor-workbench, and agent-editor modules each carry one, and they record behavior that
is not restated here.

Keep authoritative failure distinct from successful empty state, preserve runtime parity, enforce
privilege at trusted boundaries, and make partial failure/rollback behavior explicit.

## Commands and commits

Use root/package `package.json` scripts as the command source of truth. The repository uses Bun
`1.3.14`. Run focused tests while iterating, workspace-wide checks for shared contracts, and
`bun run dead-code` after adding/deleting/renaming source or changing exports/import shapes.

There are two lockfiles. The workspace `bun.lock` covers development, and
`scripts/cloud-runtime.bun.lock` pins the production cloud runtime graph, which CI verifies frozen.
Changing a dependency that reaches that graph also needs `bun run update:cloud-runtime-lock`
committed, or the container and production-build jobs fail while every source check passes. The
`Cloud runtime lockfile` workflow does this for a Dependabot pull request on dispatch, because
Dependabot maintains only the first lockfile.

Two coverage gaps are real and must not be mistaken for passing verification. `@piarium/ui` runs
under Vitest and is collected by `bun run test:pi`, but `packages/ui/vitest.config.ts` excludes a
named list of suites that cannot pass yet; treat that list as the remaining gap, keep each entry's
recorded cause accurate, and shrink it rather than adding to it. `packages/electron` `type-check`
only runs `node --check` on its entry `.mjs` files and its `lint` is a no-op, so root
`type-check`/`lint` prove nothing about the desktop shell; verify it with the Electron tests and a
bundled or packaged smoke instead.

Each roadmap phase is independently tested, committed, and pushed after its acceptance checks pass.
Preserve unrelated user changes and report exactly which runtime/build checks were and were not run.
