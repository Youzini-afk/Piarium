# Changelog

All notable changes to Piarium are recorded here. The project is pre-1.0; the
private runtime protocol and product surfaces still move together.

## Unreleased

- Show a locked “Restarting Piarium” transition while the desktop updater stops background services
  and hands off to the installer, with interaction restored if the restart request fails
- Keep Host-registered workspace identities valid across project-selection changes so background checkpoints
  and rollback cannot be rejected by stale settings; normalize Windows path identities consistently

## 0.9.7

Piarium 0.9.7 fixes packaged desktop Pi startup and makes the chat rendering modes behave as their
names describe.

- Resolve Electron's external Pi Host once for both Runtime Manager probes and live Broker generations;
  never hand an `app.asar` path to Node, and show a Piarium repair action when application Host files
  are missing instead of suggesting a Pi upgrade
- Launch the unpacked Host through a real Runtime Manager probe and live handshake during packaging,
  and require the Windows production application to activate a selected Pi before release
- Implement Sorted chat rendering as a live Activity group for thinking, tool calls, and tool-use
  justification, followed by the completed answer; Live mode keeps the original arrival order
- Preserve extension-owned message renderers, Activity expansion preferences, exact usage reporting,
  and complete locale parity across both rendering modes

## 0.9.6

Piarium 0.9.6 adds native Pi session-tree navigation and makes workspace recovery practical for
large, long-lived projects.

- Add a searchable `/tree` timeline with active-branch context, labels, keyboard navigation, and
  recovery or forking from any user or assistant message
- Move turn checkpoint capture out of prompt admission, serialize background capture per workspace,
  and reuse unchanged workspace heads instead of rescanning before every message
- Honor workspace Git ignore rules, stage only affected restore paths, and make no-file-change recovery
  complete without copying or advancing the workspace timeline
- Split the short filesystem restore transaction from retryable conversation navigation; make
  maintenance process-owned, release it on shutdown, reclaim it after process death, and migrate old
  ownerless locks without blocking new sessions
- Run the development Web Host on Node with crash-exit behavior so a Bun native panic cannot leave the
  renderer indefinitely sending against a dead backend

## 0.9.5

- Refresh distribution-owned Host artifacts by build fingerprint so upgrades cannot keep running stale
  recovery code; restore new-session workspace checkpoints and recovery-history inventory on existing installs

## 0.9.4

- Add a desktop About settings page with the current version, honest update status, automatic and manual
  update checks, release installation, and persistent update preferences
- Add compact Settings, shortcut help, About, and available-update actions to the conversation sidebar footer

## 0.9.3

Piarium 0.9.3 replaces plugin-backed workspace rollback with a Piarium-native recovery system and
makes its storage practical to manage across projects and platforms.

- Bind immutable workspace checkpoints to Pi conversation turns and offer verified conversation-only,
  coordinated in-place, or new-workspace recovery without resetting or cleaning the project Git repository
- Make native recovery a replaceable, versioned Piarium Host service with crash-safe operations, safety
  checkpoints, explicit review states, and recovery undo
- Add global recovery storage defaults plus higher-priority project overrides for application data,
  workspace-local, workspace-adjacent, and custom folders
- Migrate inherited histories through copy-and-verify switching, list histories by recent activity, clean
  unreachable objects in one action, and manage or delete individual workspace histories
- Keep workspace identities usable while roots are offline and unify Windows long, short, namespaced, and
  missing-child path identities without weakening write and restore boundaries
- Preserve portable symlink targets, support long Windows SQLite paths, and keep offline Host-owned recovery
  histories available for maintenance
- Fix Monaco find and replace controls rendering missing-glyph boxes by awaiting and protecting the Codicon font
- Remove the unimplemented anonymous usage-reporting setting and keep the selected recovery preference durable

## 0.9.2

Piarium 0.9.2 makes project navigation, Pi runtime isolation, custom providers, and the IDE editing
workflow substantially more dependable.

- Refine custom provider model capabilities with explicit image, tool-calling, reasoning, supported
  thinking-level, and custom thinking-level controls
- Isolate catalog, workspace, package, and session workers so a stalled extension cannot block the
  session list, another workspace, or recovery through Pi package management
- Rework the session navigator around project-first conversation groups, compact actions, search,
  batch selection, project sorting, tree/flat display, and a quieter context rail
- Make current-file find/replace and related Monaco shortcuts target the editor that received the key,
  remove conflicting desktop accelerators, and open IDE workspace search with `Ctrl/Cmd+Shift+F`
- Jump workspace text results to the exact match, including lines containing Chinese, emoji, or other
  multibyte text
- Make English the default community documentation language and keep the contributor guides and code
  of conduct available in five languages

## 0.9.1

- Provision MCP, permission management, workspace history, and prompt repair for new Pi runtime
  environments while keeping each integration removable and independently configurable
- Use the Piarium-maintained MCP adapter package and preserve existing compatible installations
- Improve foundational package recovery, concurrent package operations, and native desktop release
  packaging across Windows, macOS, and Linux

## 0.9.0

Piarium 0.9.0 turns the Agent Workspace and IDE Workbench into a more cohesive daily workspace,
with a unified editor platform and a substantially refined Pi-native conversation experience.

- Fix packaged desktop language services by resolving built-in ASAR assets to their physical unpacked
  directory, launching Electron-backed language processes in Node mode, and shipping self-contained
  TypeScript runtime metadata
- Use one Monaco-backed file editing platform across desktop/Web Agent and IDE Workbench while keeping
  mobile and embedded CodeMirror views on the same revisioned document authority
- Complete rich Host-owned language features, atomic multi-file edits, file/Git diffs, debug/test
  projections, Agent attachments, conflict recovery, and Profile-safe model reuse
- Publish the framework-neutral editor controller and optional owner-scoped Monaco augmentation service
  through the Piarium extension tooling contract
- Keep Monaco lazy from ordinary Web, mobile, and mini-chat entrypoints and verify cold/warm editor,
  worker, bundle, and owner cleanup behavior in production artifacts
- Make sends transactional, switch and preview sessions without blocking navigation, virtualize long
  conversations, preserve reading position, and keep session actions responsive
- Rework the composer around Pi's real model, thinking, Agent, and permission capabilities; show an
  honest assistant working state and provider-reported input, output, reasoning, cache, and total token
  usage only when those fields are available
- Group conversations by product workspace while retaining explicit general chats, and let the IDE
  select nested Git repositories without creating another workspace authority
- Update the supported Pi runtime to 0.84.3, improve global runtime discovery and Windows upgrades, and
  make packaged TypeScript language services start from their real distribution assets
- Unify Piarium branding around the startup cube and refine the adaptive splash and Workbench transition
  lifecycle across desktop and Web

## 0.8.0

Piarium 0.8.0 focuses on making the existing desktop, Web, IDE, and extension experience more
reliable before broader community use.

- Make remote authentication, passkeys, mobile credentials, notification registration, and
  application settings durable under concurrent updates and partial failure
- Establish one settings, project-configuration, and theme persistence contract across hosts
- Reduce startup work by deferring optional browser capabilities until the UI can use them
- Harden trusted desktop document writes and remove obsolete compatibility and duplicate ownership
  paths left from the OpenChamber product base
- Apply Piarium's Bun patches consistently in clean installs and container builds
- Update the maintained Pi extension integrations for `pi-subagents` 0.55, Magic Context 0.39,
  `pi-web-access` 0.24, `pi-openai-codex-compat` 0.0.9, AFT 0.52, Permission System 27, and
  the maintained `pi-mcp-adapter` 2.27 fork
- Keep Magic Context's published flat configuration and new harness-scoped Pi model configuration
  visible through one version-aware editor without overwriting complex model entries

## 0.7.0

Piarium's Workbench transitions are now extension-owned visual scenes instead of fixed Core UI.

- Refine the full-screen lattice and Pi cube transition used when moving between Agent, IDE, and
  custom Workbench Profiles
- Cover the previous Workbench, commit the new Profile only while fully covered, and then reveal the
  authoritative result with the same captured scene
- Ship the default cube as an enabled-by-default Piarium extension that can be selected, disabled, or
  replaced through `workbench.transition`
- Keep complete scene ownership outside both Shells so a Shell can replace its entire interface
  without inheriting Piarium's official page structure
- Fall back to an opaque Core handoff when a selected scene is missing, malformed, disabled, withdrawn,
  or fails to mount, while preserving the previous authoritative Shell on commit failure
- Publish the Transition Scene contract, framework-neutral SDK mount helper, and React adapter in the
  coordinated `@piarium/*` public tooling release 0.2.0

## 0.6.0

Piarium's IDE Workbench release is now available as native desktop packages across Windows, macOS,
and Linux.

- Switch directly between the Agent Workspace and IDE Workbench from the application header
- Work with the multi-group editor, files, search, source control, run/debug/test, sessions, context,
  and MCP surfaces in one composable workspace
- Download native x64 and ARM64 packages for Windows and Linux, plus Intel and Apple Silicon packages
  for macOS
- Validate every release on its matching native runner, including application startup, renderer
  readiness, health checks, and a real terminal create/close cycle
- Keep separate Windows and Linux architecture channels while merging both macOS architectures into
  the standard macOS updater feed

## 0.5.0

Piarium now includes an optional IDE Workbench alongside the original Agent Workspace.

- Switch directly between Agent and IDE workbench profiles from the application header
- Edit files in a multi-group CodeMirror workbench backed by revisioned document authority
- Browse and search workspaces, use language services, and run, debug, or test projects without
  leaving Piarium
- Keep Agent conversations beside the editor with dedicated Sessions and Context views
- Inspect MCP servers from a compact IDE toolbar panel, with full configuration still available
  from Settings
- Coordinate Agent file changes with dirty editor buffers instead of silently overwriting them
- Extend workbench shells, views, editors, language services, tasks, debug adapters, and tests through
  the Piarium extension platform
- Use VS Code as a focused Piarium companion for chat, session switching, Settings, and sending files
  or selections into the active Pi session
- Faster cloud authentication startup and more reliable restoration of the selected workspace
- Windows installers for x64 and ARM64

## 0.1.0

First public source snapshot of the Pi-native workspace.

- Pi host, broker, and protocol v1 for sessions, models, packages, and extensions
- Shared UI on Web, Electron, VS Code, and Capacitor
- Maintained adapters for Pi packages such as `pi-subagents`, Magic Context,
  `pi-workspace-history`, `pi-wtf`, `pi-mcp-adapter`, and `pi-web-access`
- Cloud image and Compose path with digest-linked promotion
- Pi host loads the selected Pi installation through a bootstrap resolver instead
  of a permanently bundled SDK; cloud images still stage those packages
- Runtime Manager discovers user-global Pi installs, plans upgrade-only package
  manager or standalone installs, and never silently upgrades or downgrades Pi
- Desktop starts without a bundled Pi warmup; onboarding and Settings activate,
  install, or upgrade the user-global runtime without restarting the app; runtime
  state is published monotonically, and sessions already running stay routed to
  the Pi generation that owns them while a newly selected runtime takes over
- Slim and toolbelt container images: Compose defaults to `piarium-slim`; overlay
  `docker-compose.toolbelt.yml` for the language toolbox
- Community files and Renovate config live under `.github/`; install-time patches
  and shadcn config sit with their owners
- Safe Dependabot updates: GitHub Actions majors and `concurrently` /
  `cross-env` / `globals` dev tools
- Piarium extension platform (contract, host, surface, SDK, CLI)
- OpenChamber upstream capability absorption, including Work Status,
  walkthroughs, and Markdown task loops
- Piarium-owned Android/iOS application IDs, `piarium://` deep links, Widget/notification-service
  targets, App Group, launcher/splash assets, and external release credential boundaries

Known gaps for this release:

- npm packages under `@piarium/*` are not published yet
- optional offline installers and other desktop-platform release assets are not published yet
