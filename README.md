# Piarium

> A native workspace for Pi agents.

Piarium is a Windows-first desktop workspace for the
[Pi coding agent](https://github.com/earendil-works/pi). It is designed around Pi's public
SDK and extension model rather than terminal scraping.

The product brings sessions, models, packages, subagents, memory, MCP, web research, and
message/file checkpoints into one local interface.

## Status

Piarium is under active development. Its versioned protocol, isolated Pi `0.83.0` SDK host, secure
desktop broker, and plugin-backed conversation/workspace recovery bridge are implemented and tested.
The complete OpenChamber-derived product shell is now imported and builds from this repository.
Its Electron lifecycle owns the Pi worker broker directly, and an authenticated Pi-native
WebSocket surface plus browser client now carries that broker across desktop/web/mobile and the
encrypted relay. Protocol v1 exposes Pi's complete branch graph, tree/header/entry/summary/stats,
real streaming/compaction/queue state, native rename/archive/restore/delete, model and thinking
selection, provider-owned authentication, and recovery-provider capabilities as Piarium DTOs without
leaking SDK-only callbacks or Pi credential objects. It also carries explicit project-trust responses,
the complete Pi extension UI surface, scope-aware arbitrary plugin settings, custom-component
snapshots, and extension-owned JSON/JSONC configuration documents such as `pi-wtf`'s `wtf.json`
and Magic Context's native files. Conversation rollback uses Pi directly;
workspace history and repair delegate to `pi-workspace-history` and `pi-wtf`, so their independent
package updates remain usable. The duplicate Piarium shadow-Git engine has been removed. Product
limits are absent by default; deployment resource budgets are explicit opt-ins. Replacement of the
remaining OpenCode UI state paths is the active phase.

The product base is the maintainer's OpenChamber fork at commit `f551150e5`. That fork is imported
into this repository and is being directly refactored from OpenCode to Pi; the source fork remains read-only.
Custom providers, remote/cloud access, workspace tools, settings, session UX, and multi-surface
support remain product requirements. See [the migration contract](docs/openchamber-pi-migration.md)
and [the roadmap](docs/roadmap.md).

## Product principles

- **Pi-native:** use public Pi SDK contracts and preserve extension behavior.
- **Local-first:** projects, sessions, credentials, and recovery data stay local by default.
- **Recoverable:** every destructive action has an explicit boundary and a recovery path.
- **Inspectable:** background agents and extensions expose structured state rather than opaque
  terminal output.
- **Capability-based:** desktop, web, and future mobile clients consume explicit host
  capabilities.
- **Windows-first, cross-platform by design:** Windows is the first packaged target without
  baking platform assumptions into the protocol or UI domain.

## Repository layout

```text
packages/
  ui/             Shared OpenChamber-derived product UI, being refactored to Pi domain types
  web/            Web/remote surface and trusted runtime service
  electron/       Windows/macOS/Linux desktop shell and packaging
  mobile/         Capacitor mobile shell
  vscode/         VS Code extension and runtime bridge
  protocol/       Versioned desktop-to-Pi-host wire protocol
  pi-host/        Isolated Node worker that embeds the Pi SDK
  runtime-broker/ Trusted catalog/per-session Pi worker owner shared by product surfaces
  runtime-client/ Browser-safe request/event client for WebSocket and editor transports
```

The Pi runtime and maintained extensions remain independent projects. Development checkouts live
next to this repository; release builds resolve pinned packages instead of silently bundling local
working trees.

## Development

Requirements:

- Node.js 22.19 or newer (Node 24 is the supported development baseline)
- Bun 1.3.14
- Git for Windows
- Git Bash for Pi shell tools on Windows

```powershell
bun install --frozen-lockfile
bun run check:pi
bun run build
bun run test:pi:dist
```

Architecture decisions are recorded in [docs/architecture.md](docs/architecture.md).
Recovery guarantees are recorded in [docs/recovery.md](docs/recovery.md).
Maintained extension compatibility evidence is recorded in
[docs/extension-compatibility.md](docs/extension-compatibility.md).
