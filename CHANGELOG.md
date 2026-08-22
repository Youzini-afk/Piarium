# Changelog

All notable changes to Piarium are recorded here. The project is pre-1.0; the
private runtime protocol and product surfaces still move together.

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
