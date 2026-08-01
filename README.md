# Piarium

> A native workspace for Pi agents.

Piarium is a Windows-first desktop workspace for the
[Pi coding agent](https://github.com/earendil-works/pi). It is designed around Pi's public
SDK and extension model rather than terminal scraping.

The product brings sessions, models, packages, subagents, memory, MCP, web research, and
message/file checkpoints into one local interface.

## Status

Piarium is under active development. Its bounded protocol, isolated Pi `0.83.0` SDK host, secure
desktop broker, and transactional conversation/workspace recovery core are implemented and tested.
The complete OpenChamber-derived product shell is now imported and builds from this repository;
direct replacement of its OpenCode engine paths with the Pi host is the active phase.

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
  recovery/       Message and workspace checkpoint engine
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
