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
  attachments, and dictation all target the active Pi session. The orphaned OpenCode
  session-retention hook and stale sync documentation were removed after the Pi-native retention
  hook became the sole production implementation.
- Implemented the Pi-native main application root: context panels, plans, project notes/todos,
  inline comments, drafts, archive management, project actions, worktree management, and command
  discovery no longer require the OpenCode SyncProvider. No production application root mounts that
  provider. Pi commands are discovered from live sessions or an in-memory
  workspace catalog, so extension, prompt-template, skill, and recovery-plugin updates appear
  without Piarium-owned copies.
- Implemented: terminal selections, pull-request comments/check failures, merge conflicts, and
  worktree-integration conflicts now seed the active Pi composer or create a Pi session in the
  required directory. Visible text and hidden instructions travel through Pi's native prompt
  contract; the old global new-session draft, synthetic OpenCode parts, and externally-viewed sync
  marker are no longer loaded by terminal, Git, pull-request, or context-panel surfaces. Git
  worktree bootstrap status is tracked by path instead of mutating the legacy session UI store.
- Implemented: VS Code active-editor suggestions now target the Pi composer instead of writing to
  the detached OpenCode input store. Accepted selections preserve relative path and line range in
  session-scoped Pi context; whole files become explicit readable path context. Pi session events
  now drive one completion/error attention state shared by background-session indicators, session
  switchers, and mobile widget snapshots, and opening a session clears that state.
- Implemented a coherent Piarium product identity across the Windows installer, Electron AUMID,
  native/PWA titles, updater feed, `piarium://` deep links, `piarium-ui://` packaged origin,
  authentication device labels, translations, and generated icon assets. The retained cube motif
  now carries Piarium's own π mark rather than the upstream OpenCode mark.
- Implemented Pi-native scheduled execution end to end: the scheduler creates a Pi session,
  selects its Pi provider/model/thinking level, and dispatches either a Pi extension command or
  agent prompt. The editor and run-now navigation use the same Pi catalog/session contract; legacy
  OpenCode agent variants, permission policy, goal token ceiling, and session IDs were removed.
- Implemented: all four production UI roots now use Piarium protocol DTOs without importing the
  OpenCode SDK. The unreachable SDK client, complete sync/optimistic state graph, old chat composer,
  turn projector, session sidebar, compiled test remnants, Vite aliases, dependency entries, and
  lockfile package were removed together. Pi Skills autocomplete was reattached to the live Pi
  command/resource catalog rather than discarded with the old composer.
- Implemented: sync, lifecycle, provider, scheduling, control, and notification flows now use the
  Pi host/broker contracts. The OpenCode child lifecycle, proxy, watcher, downloaded CLI, provider
  persistence, and obsolete UI code are no longer part of the production graph.
- Implemented: cloud delivery now builds one canonical production workspace containing Web,
  protocol, runtime broker, and the bundled Pi host. The application image installs native
  dependencies on its target architecture and runs on a Piarium-owned multi-architecture runtime
  base with the fork's complete development toolbelt. CI publishes digest-linked base/application
  images and performs a real bundled-host health smoke. Compose uses Piarium-owned paths and state.
  SSH deployment verifies a content-addressed archive, installs into an immutable release, switches
  `current` atomically, waits for a ready bundled Pi runtime, and automatically restores the last
  healthy release on failure. No cloud path installs, configures, or probes an OpenCode runtime.
- Implemented: About now reads the server's real `piariumVersion`, links to the Piarium repository,
  and no longer probes or displays a nonexistent OpenCode upgrade endpoint. The unreachable
  OpenCode upgrade toast, its persisted preferences, and its Web settings API shim were removed;
  Piarium application updates and the independent PWA install prompt remain intact.
- Implemented: managed Git worktrees now live below Piarium's own data directory and use the
  canonical Piarium path-based project ID plus `piarium/<name>` default branches. Worktree setup
  no longer writes `.git/opencode`, OpenCode project JSON, or `opencode.db`; Git itself is the
  authoritative registry and the Piarium UI passes the configured setup command explicitly.
- Implemented: both reachable file trees now use the required cross-runtime `FilesAPI` directly;
  the unreachable OpenCode directory-list fallback and the server's `.opencode/plans` missing-path
  exception were removed. Web list mapping and the server directory-list contract are tested.
- Implemented: project onboarding and directory selection now use Piarium runtime capabilities end
  to end. `FilesAPI` resolves the active host home, lists directories, and explicitly creates new
  project directories outside the current workspace; `GitAPI` clones with the selected identity on
  Web/Electron/mobile and VS Code. The reachable directory dialog no longer calls `opencodeClient`
  or assembles private filesystem routes.
- Implemented: About, the desktop Help menu, and the runtime-status shortcut now open one production
  Piarium diagnostics surface. It reports the negotiated Pi handshake, `/health`, package/resource/
  agent-provider diagnostics, fleet/recovery availability, and project/session state without reading
  OpenCode SDK endpoints or copying provider settings, package source URLs, message bodies, or fleet
  goals. The old invisible OpenCode status dialog and `window.__opencodeDebug` entry point were removed.
- Preserve local/remote authentication, workspace containment, audit, reconnect, materialization,
  queue, parent/child session, revert, fork, and archive behavior.

Acceptance: the OpenChamber-derived product runs its complete chat/session/provider journey on Pi
without starting or bundling OpenCode and without a permanent OpenCode compatibility facade.

## Phase 6 — Recovery UX and ecosystem integrations

Implementation follows the native-ownership and per-adapter acceptance contract in
[plugin-gui-design.md](plugin-gui-design.md).

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
- Implemented: put provider status/checkpoint/history management in the right sidebar/settings while retaining
  the Pi timeline's normal rollback flow, undo/redo, and branch UX. Enable files-only/preview
  controls only when a plugin advertises them through recovery bridge v1; no detached legacy
  reverted-message dock is retained.

- Implemented: native package installation/update and unrestricted configuration documents for
  `pi-subagents` and Magic Context. Subagent tree controls and Magic Context memory/session
  diagnostics remain dependent on their public event/data contracts.
- Implemented: the first-class `pi-subagents` settings surface now edits scoped defaults and model
  policy, the current Watchdog review/LSP schema, Fleet and async behavior, delegation limits,
  sessions/artifacts/worktrees, Intercom, scheduled runs, completion/control notifications, and
  turn/tool/usage budgets in the plugin's native documents. Unknown keys remain intact and the raw
  documents remain authoritative. Per-agent overrides now use the live provider catalog's runtime
  names while still accepting arbitrary future/package names; all current scalar/list/clear
  sentinels and per-agent tool budgets are structured, and custom/package frontmatter precedence is
  explained rather than flattened into the generic Agents page. Fields owned by Agent Markdown or
  individual runs are diagnosed at their invalid override path, while unknown future keys remain
  round-trippable. Current notification channels/events and proactive skill delegation are also
  covered.
- Implemented: the first-class Magic Context settings surface now follows the current Pi Zod loader
  rather than the retired OpenCode-era page. Separate user/project drafts, six focused capability
  areas, project security filtering, Pi-only runtime controls, context/compression budgets, memory
  and Git indexing, embedding/SQLite/Synapse, internal-agent tuning, and all current Dreamer tasks
  write the canonical CortexKit JSONC files without losing comments or unknown fields. Polymorphic
  per-model maps remain explicitly visible and editable through the authoritative Advanced document.
- Implemented: Magic Context session operations now discover and invoke its current registered
  `ctx-*` commands in a live session. Status stays in the plugin-owned dialog; flush, embedding
  status/start/pause, Sidekick augmentation, wrap-up, full/ranged recompression, session upgrade,
  and selected Dreamer tasks preserve provider validation and confirmations. The newest public
  `ctx-status` branch entry is rendered in settings without reading SQLite, and augmentation is
  presented truthfully as a new user turn. The runtime UI separates Context health, session
  maintenance, Sidekick augmentation, and long-running Dreamer/embedding work.
- Implemented: first-class plugin cards now report package configuration/presence separately from
  current-session observations. Subagents and Magic Context use agent-provider availability,
  Web Access uses its registered command, recovery plugins use recovery-provider status, and MCP
  uses its public status channel. Transport failures, no active session, unavailable providers,
  and successful-but-absent observations remain distinct; no generic loaded or reload-needed state
  is fabricated where Pi exposes no such contract.
- Implemented: Agents executes every action advertised by the `pi-subagents` provider instead of
  rendering inert badges. Provider-level creation and model-resolution actions, structured agent
  and workflow editors, scope selection, inspect/update/eject/enable/disable/reset/delete, focused
  destructive confirmation, project-trust gating, result reporting, and catalog refresh all route
  through the plugin-owned management tool.
- Implemented: a separate Fleet page now consumes pi-subagents' public `subagents:rpc:v1`
  `fleetStatus` projection for active foreground/background children. Piarium validates and
  projects only the opaque display key, role/agent, goal, model/effort, timing, and token counts;
  private run IDs, paths, and raw status details never cross to the renderer. The plugin-owned
  inspector, stop selector, and doctor stay command-backed. Per-task controls wait for stable
  provider-advertised action targets instead of inferring identifiers from private artifacts.
- Implemented: Agents, Commands, Prompts, Skills, Pi Packages, and Plugin Settings now observe one
  ownership model. Agents exposes provider-owned source/package/invocation facts without inventing
  a universal override schema; Commands is a read-only live catalog with native source provenance;
  Prompts shows its filename-derived slash invocation and `argument-hint`; package rows distinguish
  configured sources from missing local installations, expose resolved/structured-entry state, explain Pi's
  cross-scope update semantics, and route configuration to the matching specialized or Advanced
  plugin surface.
- Implemented: retire the unreachable OpenCode-era Magic Context, OpenAgent, and Agent
  Orchestration pages after recording their capability disposition. Their private `/api/*`
  stores, stale schema normalizers, layout assertions, and dedicated translations are removed;
  Pi-native provider catalogs, plugin adapters, resource pages, and still-live chat dependencies
  remain intact.
- Implemented: remove the unreachable OpenCode agent CRUD sidebar and generic permission-map
  editor. Pi provider actions and plugin-native configuration remain authoritative for agent
  definitions, model policy, and permissions.
- Implemented: Pi-native `pi-mcp-adapter` package management, public `status/v1` runtime snapshots,
  reconnect/auth/logout/enable/disable command orchestration, and the plugin-owned read-only
  `configCatalog/v1` effective server projection. MCP settings appear only for an installed adapter;
  the split page lists each effective server once on the left and edits an explicit revisioned native
  source on the right. Piarium never merges the six sources in the renderer, and the catalog excludes
  arguments, environment, headers, tokens, OAuth, and URL credential material. Desktop header and
  mobile controls consume the same public status/command path; the old OpenCode MCP stores, draft
  editor, and OAuth callback route are removed. Each native source keeps a structured,
  comment-preserving editor plus its complete raw JSON/JSONC draft. Partial overrides stay valid,
  transport changes remove obsolete fields, and URL changes clear local URL-bound credentials rather
  than carrying them to another endpoint. Tools/resources/results already use the generic Pi tool
  projection; richer MCP Apps rendering remains dependent on an explicit public webview contract.
- Implemented: the first-class `pi-web-access` adapter now edits its native `web-search.json`
  through focused routing, provider/credential, Curator/browser, content, and security areas. It
  models the plugin's current single/concurrent/all/ordered-fallback semantics, every documented
  credential source and provider endpoint, public tool names, remote bind risks, Chromium-cookie
  opt-in, GitHub/video/PDF behavior, domain policy, and SSRF exceptions without dropping unknown
  fields. Custom Pi agent directories are propagated through `PI_CODING_AGENT_DIR`, keeping the
  GUI and extension on the same file. The live-session panel now discovers the registered command
  catalog, opens the native Search Curator with optional initial queries, invokes Gemini Web account
  diagnostics, opens the plugin-owned stored-result selector, and invokes the public
  `/curator on|off|summary-review` modes while leaving persistence and immediate effects with the
  plugin. Search/fetch tools, widgets, dialogs, and custom entries use the generic extension
  projection; provider health and activity still require a public versioned contract from the
  extension.

Acceptance: each adapter has an unavailable/degraded state, version compatibility diagnostics, and
an integration smoke test without exposing credentials.

## Phase 7 — Windows release

- Implemented: Electron's Node mode directly hosts the compiled Pi worker/broker; no separate Node
  download is required. Windows product/installer identity and GitHub updater metadata now target
  `Youzini-afk/Piarium`.
- Implemented: the Windows x64 pipeline produces the unsigned NSIS installer, blockmap, and
  `latest.yml`. Packaging rebuilds `better-sqlite3`, verifies the published `node-pty` N-API
  prebuild by starting a PTY under Electron 41, and unpacks one coherent production dependency tree
  for the ordinary Node Pi worker. A clean-profile unpacked-app smoke reaches Pi host protocol v1,
  Pi 0.84.1, the local health endpoint, renderer app-ready state, and a create/close terminal
  session; the same smoke can copy persisted settings plus Chromium Local/Session Storage into an
  isolated profile to catch profile-dependent renderer regressions without modifying the source.
- Git/Git Bash/npm/Pi discovery and guided repair.
- NSIS installer, upgrade/uninstall behavior, logs, crash recovery, and update metadata.
- Packaged-app smoke tests and artifact checks.

Acceptance: install on a clean Windows user profile, run the Phase 5–6 smoke journey, restart with
active history intact, upgrade in place, and uninstall without deleting user projects or sessions.

## Phase 8 — OpenChamber upstream capability absorption (active)

The reviewed fork/upstream reconciliation and capability-by-capability disposition live in
[openchamber-upstream-20260813.md](openchamber-upstream-20260813.md). The merge is used as an audit
source rather than copied over the Pi-native engine.

- In progress: directly portable Markdown, terminal-output, and layout fixes.
- Implemented: retained relay request-body integrity and mobile transient reconnect behavior.
- Planned as Pi-native features: Work Status, guided code walkthroughs, and Markdown loop discovery
  for the existing scheduler.
- OpenCode session sync, provider routes, MCP ownership, and lifecycle code remain excluded; only a
  reproducible underlying invariant may be reimplemented at its Pi owner.

Acceptance: every adopted capability names its authoritative owner, preserves fork behavior where
it is still required, and has no production dependency on OpenCode or a duplicate compatibility
implementation.

## Phase 9 — Piarium extension platform (active)

The complete target architecture is specified in
[piarium-extension-platform.md](piarium-extension-platform.md). Piarium extensions are a separate
product/runtime from Pi packages: the former extend the workbench and application host, while the
latter continue to extend Pi through Pi's own `PackageManager` and extension runner.

Delivery is split into complete platform slices without reducing the target customization model:

1. Implemented foundation: extension contract, application-host identity/catalog,
   desired/actual-state and capability-grant records, package-source abstraction, read-only catalog
   Runtime API, revision-checked recovery mutations, and a protected renderer-independent fallback
   manager. This slice does not execute extension code;
2. owner-scoped Surface lifecycle, contribution/service registries, layout references, and the
   first statically linked built-ins migrated from hard-coded switches;
3. authenticated external Surface artifacts, managed dynamic activation, candidate update, and
   rollback;
4. brokered Host entrypoints, extension storage/migrations, versioned dependencies, and
   multi-window coordination;
5. isolated iframe/Worker and explicitly trusted-native modes with truthful physical-unload and
   restart semantics;
6. maintained Pi integration adapters migrated into separate built-in Piarium extensions while Pi
   Packages and Pi Plugin Settings remain independent;
7. replaceable navigator, chat, panel, layout, and workbench shell contributions plus distribution
   profiles;
8. later workspace/session/agent/model/invocation service routing, followed by ecosystem authoring
   and distribution tooling.

Acceptance: managed or isolated extensions enable and disable without a document reload; failed
activation/update leaves no partial effects and preserves the previous generation; Pi package and
Piarium extension lifecycle/configuration remain independent; every shared contract has explicit
Web, Electron, VS Code, hosted-mobile, Capacitor, and headless behavior; the recovery kernel can
always enter safe mode with non-kernel extensions disabled.
