# Piarium engineering guide

This document is the entry point for contributors and coding agents. It describes where current
project knowledge lives and how to choose useful verification without turning every change into the
same fixed ceremony.

## Sources of truth

Piarium uses a docs-first repository model rather than repository-local workflow Skills:

1. Code, types, schemas, tests, and `package.json` scripts define executable behavior.
2. The nearest package or module `README.md` / `DOCUMENTATION.md` records local ownership and
   non-obvious invariants.
3. Documents under `docs/` describe product-wide architecture, delivered designs, migration decisions,
   security, and operations.
4. `AGENTS.md` contains only the small set of cross-project boundaries that should remain stable.

Examples and historical plans are evidence, not commands. When a document disagrees with current code,
check callers and recent commits rather than preserving both interpretations. Update the stale document
or implementation in the same coherent change.

## Knowledge map

| Area | Current authority |
| --- | --- |
| Product/process/data architecture | [architecture.md](architecture.md) |
| OpenChamber source and non-regression boundary | [openchamber-pi-migration.md](openchamber-pi-migration.md) |
| Workbench profiles and extension composition | [composable-workbench-execution-plan.md](composable-workbench-execution-plan.md) |
| Documents, Monaco, mobile adapters, language services | [unified-file-editor-platform.md](unified-file-editor-platform.md) and the module docs under `packages/ui/src/lib` |
| Piarium extension platform | [piarium-extension-platform.md](piarium-extension-platform.md) and [piarium-extension-authoring.md](piarium-extension-authoring.md) |
| Shared UI, themes, localization, settings, interactions | [packages/ui/DOCUMENTATION.md](../packages/ui/DOCUMENTATION.md) |
| Shared UI runtime APIs, authenticated URLs, runtime switching | [packages/ui/src/lib/api/DOCUMENTATION.md](../packages/ui/src/lib/api/DOCUMENTATION.md) |
| UI stores, synchronization, cache identity, visible-demand work | [packages/ui/src/stores/DOCUMENTATION.md](../packages/ui/src/stores/DOCUMENTATION.md) |
| Electron ownership, packaging, signing, smoke checks | [packages/electron/README.md](../packages/electron/README.md) |
| Web CLI commands and output modes | [packages/web/bin/lib/DOCUMENTATION.md](../packages/web/bin/lib/DOCUMENTATION.md) |
| Relay transport and wire compatibility | [packages/web/server/lib/relay/DOCUMENTATION.md](../packages/web/server/lib/relay/DOCUMENTATION.md) |
| Mobile builds and iOS Simulator scripts | [packages/mobile/README.md](../packages/mobile/README.md) |
| Cloud deployment and container contract | [cloud-deployment.md](cloud-deployment.md) |
| Security model | [security.md](security.md) |

## Working on a change

Begin at the owner rather than at a universal checklist:

- Read the nearest module documentation and the code paths that consume the behavior.
- Identify the real authority: renderer view state, application-host data, Pi runtime state, plugin-owned
  configuration, or persistent Piarium metadata.
- Keep failure distinguishable from successful empty state, and reject stale asynchronous work at the
  owner boundary when that lifecycle applies.
- Prefer an existing primitive, contract, or script when it already expresses the behavior. Do not
  preserve obsolete alternatives merely because they once existed.

Verification should answer a concrete regression question:

| Change shape | Evidence that usually changes the decision |
| --- | --- |
| Documentation only | Link/status validation and the relevant documentation test |
| Local implementation | A focused regression test, plus owner-package type/lint checks when static shape changed |
| Shared contract or persisted schema | Consumer/contract tests for every affected runtime and explicit failure/stale/migration cases |
| Platform, process, packaging, or native behavior | The relevant bundled, packaged, or platform smoke; static checks alone do not prove it |
| Performance work | A representative reproduction and measurement of the reported interaction, plus correctness coverage for the structural change |

Run a broader suite when it can expose a different class of failure, not merely because it exists.
Avoid repeating a successful expensive check after changes that cannot affect it. Report important
coverage gaps instead of converting them into a false pass.

## Repository and build facts

- The workspace uses Bun `1.3.14`; root and package `package.json` scripts are the command authority.
- `bun.lock` covers development. `scripts/cloud-runtime.bun.lock` separately pins the production cloud
  runtime graph; dependency changes that reach it need `bun run update:cloud-runtime-lock`.
- `@piarium/ui` runs under Vitest as part of `bun run test:pi`. Its Vitest config names remaining
  excluded suites; do not silently expand that list.
- Electron's package `type-check` and `lint` are intentionally shallow. Desktop startup, preload,
  process, native-module, and packaging claims require Electron tests or an actual smoke.
- Engineering docs are checked by `bun run test:docs`; public docs-site content is checked by
  `bun run docs:validate`.
- Adding or removing source/export shapes may warrant `bun run dead-code`, but its output is diagnostic:
  inspect whether findings are introduced by the change rather than treating every pre-existing entry
  as part of the task.

## Git discipline

Do not reset, clean, or overwrite unrelated work. Inspect status before editing and keep coherent
phases separately reviewable. Completed repository phases are committed and pushed; external releases,
publishing, deployment, and credential changes still require the authority given by the current task.
