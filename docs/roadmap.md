# Delivery roadmap

Each phase is a separately tested, committed, and pushed recovery point.

## Phase 0 — Foundation (complete)

- Architecture, security, and contribution contracts.
- npm workspaces and TypeScript quality baseline.
- Versioned, bounded JSONL host protocol and tests.
- Windows and Linux CI for the platform-neutral packages.

Acceptance: clean install; formatting, typecheck, tests, and build pass; protocol rejects malformed
or oversized frames.

## Phase 1 — Pi host (complete)

- Runtime discovery for bundled/system/source/custom Pi.
- Direct SDK worker lifecycle and handshake.
- Sessions, prompt/steer/follow-up/abort, snapshots, and event streaming.
- Model/auth, settings, package, and command operations.
- Generic extension UI bridge.
- Smoke load against the maintained local extensions.

Acceptance: a headless integration test creates or opens a disposable session, completes a prompt
with a fake provider, exercises extension UI, and shuts down without a child process leak.

## Phase 2 — Desktop integration prototype (complete, superseded)

- Secure Electron main/preload boundary.
- React shell, onboarding, projects, session list, chat timeline, composer, and tool cards.
- Provider/model and Pi settings.
- Package/extension manager and diagnostics.
- Worker crash/restart and reconnect behavior.

Acceptance: the prototype proved the broker/preload/session path before its temporary shell was
removed in favor of the imported OpenChamber product base. Its protocol and host work continue in
the maintained packages rather than a parallel desktop application.

## Phase 3 — Recovery core (complete)

- Per-turn before/after workspace checkpoints.
- Conversation-only, files-only, combined restore, fork, undo, redo, and named checkpoints.
- Diff preview, safety checkpoint, retention, ignore policy, transaction journal, and leases.
- Conflict detection and migration path for workspace-history and pi-wtf recovery ownership.

Acceptance: destructive and crash-injection tests prove rollback; two workers cannot write the same
session/workspace; ignored secrets are not captured; Windows Unicode paths pass.

## Phase 4 — OpenChamber fork product base (complete)

- Import the clean `Youzini-afk/openchamber` fork snapshot into Piarium with provenance and MIT
  attribution; keep every source fork worktree read-only.
- Preserve custom providers, remote/cloud access, workspace security, archive restore, delayed child
  sessions, session UX, Electron/web/mobile/VS Code surfaces, and reviewed fork customizations.
- Adopt the mature build and product shell without copying tracked secrets, obsolete release
  identities, or OpenCode branding into Piarium artifacts.
- Keep the connected Capacitor iOS/Android implementation and remove the unused parallel Expo/React
  Native tree and dependencies.

Acceptance: the imported product shell builds in Piarium and fork-specific regression coverage is
retained before engine surgery begins.

## Phase 5 — Direct Pi-native engine migration

- Replace OpenCode SDK domain types with Piarium-owned Pi session, message, event, provider, model,
  command, permission, and question contracts.
- Rewrite sync, lifecycle, provider, scheduling, control, and notification flows against the Pi host.
- Delete the OpenCode child lifecycle, proxy, watcher, downloaded CLI, provider persistence, and
  obsolete code after each Pi-native replacement passes focused tests.
- Preserve local/remote authentication, workspace containment, audit, reconnect, materialization,
  queue, parent/child session, revert, fork, and archive behavior.

Acceptance: the OpenChamber-derived product runs its complete chat/session/provider journey on Pi
without starting or bundling OpenCode and without a permanent OpenCode compatibility facade.

## Phase 6 — Recovery UX and ecosystem integrations

- Connect message rollback to conversation-only, conversation+files, or always-ask policy.
- Put diff/checkpoint/history management in the right sidebar/settings while retaining the existing
  timeline, reverted-message dock, undo/redo, and fork UX.

- Subagent tree, controls, artifacts, and parent-session result projection.
- Magic Context configuration, memory/session views, and diagnostics.
- MCP server/config/OAuth/status/tools/resources/prompts UI.
- Web Access provider/config/activity/results and optional Curator flow.

Acceptance: each adapter has an unavailable/degraded state, version compatibility diagnostics, and
an integration smoke test without exposing credentials.

## Phase 7 — Windows release

- Bundled compatible Node/Pi worker runtime.
- Git/Git Bash/npm/Pi discovery and guided repair.
- NSIS installer, upgrade/uninstall behavior, logs, crash recovery, and update metadata.
- Packaged-app smoke tests and artifact checks.

Acceptance: install on a clean Windows user profile, run the Phase 5–6 smoke journey, restart with
active history intact, upgrade in place, and uninstall without deleting user projects or sessions.
