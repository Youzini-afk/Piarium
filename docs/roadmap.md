# Delivery roadmap

Each phase is a separately tested, committed, and pushed recovery point.

## Phase 0 — Foundation

- Architecture, security, and contribution contracts.
- npm workspaces and TypeScript quality baseline.
- Versioned, bounded JSONL host protocol and tests.
- Windows and Linux CI for the platform-neutral packages.

Acceptance: clean install; formatting, typecheck, tests, and build pass; protocol rejects malformed
or oversized frames.

## Phase 1 — Pi host

- Runtime discovery for bundled/system/source/custom Pi.
- Direct SDK worker lifecycle and handshake.
- Sessions, prompt/steer/follow-up/abort, snapshots, and event streaming.
- Model/auth, settings, package, and command operations.
- Generic extension UI bridge.
- Smoke load against the maintained local extensions.

Acceptance: a headless integration test creates or opens a disposable session, completes a prompt
with a fake provider, exercises extension UI, and shuts down without a child process leak.

## Phase 2 — Desktop MVP

- Secure Electron main/preload boundary.
- React shell, onboarding, projects, session list, chat timeline, composer, and tool cards.
- Provider/model and Pi settings.
- Package/extension manager and diagnostics.
- Worker crash/restart and reconnect behavior.

Acceptance: local Windows development build can configure a model, create/switch/fork a session,
stream a response, answer an extension UI request, abort, and reopen after restart.

## Phase 3 — Recovery center

- Per-turn before/after workspace checkpoints.
- Conversation-only, files-only, combined restore, fork, undo, redo, and named checkpoints.
- Diff preview, safety checkpoint, retention, ignore policy, transaction journal, and leases.
- Compatibility command wrappers for workspace-history and pi-wtf workflows.

Acceptance: destructive and crash-injection tests prove rollback; two workers cannot write the same
session/workspace; ignored secrets are not captured; Windows Unicode paths pass.

## Phase 4 — Ecosystem integrations

- Subagent tree, controls, artifacts, and parent-session result projection.
- Magic Context configuration, memory/session views, and diagnostics.
- MCP server/config/OAuth/status/tools/resources/prompts UI.
- Web Access provider/config/activity/results and optional Curator flow.

Acceptance: each adapter has an unavailable/degraded state, version compatibility diagnostics, and
an integration smoke test without exposing credentials.

## Phase 5 — Windows release

- Bundled compatible Node/Pi worker runtime.
- Git/Git Bash/npm/Pi discovery and guided repair.
- NSIS installer, upgrade/uninstall behavior, logs, crash recovery, and update metadata.
- Packaged-app smoke tests and artifact checks.

Acceptance: install on a clean Windows user profile, run the Phase 2–4 smoke journey, restart with
active history intact, upgrade in place, and uninstall without deleting user projects or sessions.
