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

The product base is the maintainer's OpenChamber fork at commit `f551150e5`. That fork is imported
into this repository and directly refactored from OpenCode to Pi; the source fork remains read-only.
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
apps/
  desktop/        Electron main, preload, and React renderer
packages/
  protocol/       Versioned desktop-to-host wire protocol
  pi-host/        Isolated Node worker that embeds the Pi SDK
  recovery/       Message and workspace checkpoint engine
docs/
  architecture.md
  phase-2-desktop.md
  roadmap.md
  security.md
```

The Pi runtime and maintained extensions remain independent projects. Development checkouts live
next to this repository; release builds resolve pinned packages instead of silently bundling local
working trees.

## Development

Requirements:

- Node.js 22.19 or newer (Node 24 is the supported development baseline)
- npm 11
- Git for Windows
- Git Bash for Pi shell tools on Windows

```powershell
npm install
npm run check
npm run build
npm run test:dist
```

Architecture decisions are recorded in [docs/architecture.md](docs/architecture.md).
Recovery guarantees are recorded in [docs/recovery.md](docs/recovery.md).
Maintained extension compatibility evidence is recorded in
[docs/extension-compatibility.md](docs/extension-compatibility.md).
