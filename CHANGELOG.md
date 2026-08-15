# Changelog

All notable changes to Piarium are recorded here. The project is pre-1.0; the
private runtime protocol and product surfaces still move together.

## 0.1.0

First public source snapshot of the Pi-native workspace.

- Pi host, broker, and protocol v1 for sessions, models, packages, and extensions
- Shared UI on Web, Electron, VS Code, and Capacitor
- Maintained adapters for Pi packages such as `pi-subagents`, Magic Context,
  `pi-workspace-history`, `pi-wtf`, `pi-mcp-adapter`, and `pi-web-access`
- Cloud image and Compose path with digest-linked promotion
- Slim and toolbelt container images: Compose defaults to `piarium-slim`; overlay
  `docker-compose.toolbelt.yml` for the language toolbox
- Community files and Renovate config live under `.github/`; install-time patches
  and shadcn config sit with their owners
- Piarium extension platform (contract, host, surface, SDK, CLI)
- OpenChamber upstream capability absorption, including Work Status,
  walkthroughs, and Markdown task loops

Known gaps for this release:

- npm packages under `@piarium/*` are not published yet
- GitHub Releases and signed desktop installers are not published yet
- Native mobile bundle IDs still use the inherited OpenChamber application id
