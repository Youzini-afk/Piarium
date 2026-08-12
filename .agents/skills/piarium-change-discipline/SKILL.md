---
name: piarium-change-discipline
description: Use when implementing, fixing, refactoring, or otherwise modifying Piarium source code, dependencies, exports, build configuration, generated assets, package contracts, persisted data, or module ownership.
---

# Piarium Change Discipline

## Before editing

1. Read `AGENTS.md`, the nearest package `README.md`/`DOCUMENTATION.md` that exists, and every other matching skill.
2. Inspect nearby implementation, callers, and tests before introducing a new pattern.
3. Identify the owning package, affected runtimes, persisted data, public contracts, and failure behavior.
4. Treat `D:\project\opencr\openchamber*` as read-only reference material, never as current authority.

## Product boundary

- Piarium is Pi-native. Do not restore OpenCode protocols, compatibility layers, dual implementations, or dead migration paths.
- Preserve user changes and existing Piarium behavior unless the task explicitly replaces it.
- Keep Pi session JSONL, Pi settings/packages, and plugin-native configuration as their documented authorities.
- Do not add dependencies or speculative restrictions without a concrete requirement or failure mode.
- Keep privilege and trust enforcement in the host/runtime boundary, not only in UI controls.

## Change scope

| Change | Required reasoning |
|---|---|
| Local implementation | Preserve observable behavior; validate the owning package. |
| Module/public contract | Inspect consumers; update contract tests and owning docs. |
| Shared runtime contract | Trace Web, Electron, VS Code, mobile, broker, host, and protocol consumers that actually apply. |
| Persisted/external behavior | Define missing, empty, malformed, stale, conversion, and failed-write behavior. |
| Platform behavior | Run the relevant build or integration test; static checks are insufficient. |

Make the smallest complete change. Avoid drive-by refactors, guessed payloads, silent failure-to-empty conversion, and UI-only enforcement of correctness.

## Validation

- Executable source: focused regression tests plus owning-package type-check and lint.
- Shared contracts: workspace type-check/lint plus affected runtime tests/builds.
- Added/deleted/renamed source or export shape: also run `bun run dead-code`.
- Persisted/external contracts: test missing versus empty, malformed input, stale completion, mutation during load, and failure preservation as applicable.
- Platform behavior: run the applicable Web, Electron, VS Code, mobile, cloud, or packaged-runtime check.

Use root/package `package.json` scripts as the command source of truth. Report exactly what ran and what did not. Each complete phase must be committed and pushed only after its acceptance checks pass.
