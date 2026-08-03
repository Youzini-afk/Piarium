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

## Phase 3 — Recovery semantics prototype (superseded)

- The prototype validated conversation-only, files-only, combined restore, checkpoint, undo/redo,
  transaction, and crash-safety semantics.
- The duplicate shadow-Git implementation was removed after ownership review. Maintained
  `pi-workspace-history` and `pi-wtf` now remain authoritative, avoiding a permanent fork and
  allowing their package updates to flow into Piarium.

Acceptance: the prototype evidence informed the retained UX and safety contract; production
acceptance is now the plugin-backed Phase 6 contract below.

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

- Implemented foundation: reusable Pi protocol client, browser-safe surface client, and
  catalog/per-session worker broker; Electron owns its handshake, packaged entry verification,
  and bounded shutdown lifecycle. The authenticated WebSocket gateway now shares that broker with
  web/desktop/mobile, validates every public method, routes per-worker event sequences, and works
  through the existing encrypted relay allowlist. Protocol v1 now projects Pi session trees,
  messages, stream deltas, models, and provider-owned auth prompts/events into stable Piarium DTOs;
  SDK callbacks, signatures, and credentials remain worker-private. Pi-native user/project/operator
  provider configuration, scoped deletion, credential provenance, and credential-safe model discovery
  are implemented behind the same runtime boundary.
- Implemented native session contract: complete branch/all entry reads, tree/header/entry/summary/stats,
  real runtime/queue state, model thinking selection, native rename, atomic archive/restore metadata,
  and safe deletion. Product-level queue, transport-frame, gateway concurrency, and discovery ceilings
  are absent by default; deployment budgets are opt-in.
- Implemented protocol v1 recovery capability discovery, unrestricted scoped plugin settings,
  extension-owned JSON/JSONC configuration documents, and Pi custom-component snapshots. Pi-native conversation rollback preserves
  text/images; workspace-history owns combined restore/undo/redo/checkpoints; pi-wtf owns prompt
  repair; recovery bridge v1 accepts future structured/files-only capabilities. The parallel
  `@piarium/recovery` shadow-Git engine was deleted.
- Implemented Pi-native desktop first-launch and local recovery readiness. Both negotiate the real
  runtime WebSocket handshake and show Pi/host/Node/source versions; the former OpenCode installer,
  binary-path picker, and `/health` polling are removed while remote connection selection remains.
- Implemented the Pi-native main header session path: title, working directory, runtime activity,
  context statistics, rename, full-history Markdown export, subtree archive, and subtree deletion
  now use Pi protocol/store data. The old sync cache, OpenCode message exporter, session worktree
  attachment, share actions, and legacy mini-chat launch path are no longer loaded by the header.
- Implemented Pi-native root launch and desktop navigation: URL/deep-link parsing, native
  open/new-session events, previous/next navigation, keyboard/menu/command-palette actions,
  global catalog bootstrap, and native tray projection now use Pi summaries, snapshots, and session operations.
  Worktree actions create the Git worktree first and then a Pi session in its directory; failures
  roll back a newly-created worktree when session creation cannot complete. The tray keeps the
  platform IPC contract but no longer polls OpenCode or imposes an arbitrary session-count cap;
  native menu/tray actions no longer route Pi session IDs into the legacy mini-chat renderer.
- Implemented Pi-native root effects and interaction controls: PWA shortcuts and retention now
  consume the global Pi catalog, the window title follows the active Pi working directory, and
  Escape abort, runtime status, model favorites, thinking levels, timeline focus, expanded input,
  attachments, and dictation all target the active Pi session. OpenCode optimistic/queued-message
  effects remain confined to explicitly named legacy embedded surfaces while those surfaces are
  migrated or removed.
- Implemented the Pi-native main application root: context panels, plans, project notes/todos,
  inline comments, drafts, archive management, project actions, worktree management, and command
  discovery no longer require the OpenCode SyncProvider. The provider remains isolated to explicit
  embedded legacy routes only. Pi commands are discovered from live sessions or an in-memory
  workspace catalog, so extension, prompt-template, skill, and recovery-plugin updates appear
  without Piarium-owned copies.
- Implemented a coherent Piarium product identity across the Windows installer, Electron AUMID,
  native/PWA titles, updater feed, `piarium://` deep links, `piarium-ui://` packaged origin,
  authentication device labels, translations, and generated icon assets. The retained cube motif
  now carries Piarium's own π mark rather than the upstream OpenCode mark.
- Implemented Pi-native scheduled execution end to end: the scheduler creates a Pi session,
  selects its Pi provider/model/thinking level, and dispatches either a Pi extension command or
  agent prompt. The editor and run-now navigation use the same Pi catalog/session contract; legacy
  OpenCode agent variants, permission policy, goal token ceiling, and session IDs were removed.
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

- Implemented: persist the conversation-only, conversation+files, or always-ask policy across
  application settings; manage `pi-workspace-history` and `pi-wtf` through Pi's native package
  operations with truthful configured-versus-active status.
- Implemented: replace the imported OpenCode plugin registry/file editor with a single Pi-native
  package manager. It lists configured sources, updates one or all packages, removes packages, and
  passes arbitrary npm, Git, local-path, or future Pi sources directly to `PackageManager`. The
  recommended integration cards are convenience entries, not an allowlist.
- Implemented: connect timeline recovery to the selected policy with Pi entry IDs. Conversation
  navigation remains Pi-native; combined/files recovery, checkpoint, undo/redo, and repair are
  delegated to the installed `pi-workspace-history` / `pi-wtf` providers through their public
  bridge and commands, so package updates remain authoritative.
- Put provider status/checkpoint/history management in the right sidebar/settings while retaining
  the existing timeline, reverted-message dock, undo/redo, and fork UX. Enable files-only/preview
  controls only when a plugin advertises them through recovery bridge v1.

- Implemented: native package installation/update and unrestricted configuration documents for
  `pi-subagents` and Magic Context. Subagent tree controls and Magic Context memory/session
  diagnostics remain dependent on their public event/data contracts.
- Implemented: Pi-native `pi-mcp-adapter` package management, public `status/v1` server snapshots,
  reconnect/auth/logout/enable/disable command orchestration, and direct editing of all six native
  config sources. Desktop header and mobile controls now consume that same snapshot/command path;
  the old OpenCode MCP stores, draft editor, and OAuth callback route are removed. Tools/resources/results
  already use the generic Pi tool projection; richer MCP Apps rendering remains dependent on an
  explicit public webview contract from the adapter.
- Implemented: direct editing of `pi-web-access`'s native `web-search.json`; its search/fetch tools,
  activity widgets, and custom entries use the generic extension projection. Optional Curator
  embedding remains dependent on a public embedding contract from the extension.

Acceptance: each adapter has an unavailable/degraded state, version compatibility diagnostics, and
an integration smoke test without exposing credentials.

## Phase 7 — Windows release

- Implemented: Electron's Node mode directly hosts the compiled Pi worker/broker; no separate Node
  download is required. Windows product/installer identity and GitHub updater metadata now target
  `Youzini-afk/Piarium`.
- Git/Git Bash/npm/Pi discovery and guided repair.
- NSIS installer, upgrade/uninstall behavior, logs, crash recovery, and update metadata.
- Packaged-app smoke tests and artifact checks.

Acceptance: install on a clean Windows user profile, run the Phase 5–6 smoke journey, restart with
active history intact, upgrade in place, and uninstall without deleting user projects or sessions.
