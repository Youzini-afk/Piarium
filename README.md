# Piarium

> A native workspace for Pi agents.

Piarium is a Windows-first desktop workspace for the
[Pi coding agent](https://github.com/earendil-works/pi). It is designed around Pi's public
SDK and extension model rather than terminal scraping.

The product brings sessions, models, packages, subagents, memory, MCP, web research, and
message/file checkpoints into one local interface.

## Status

Piarium is under active development. Phase 2 is complete: the repository contains the architecture,
bounded protocol, isolated Pi `0.83.0` SDK workers, and a secure Electron/React desktop MVP for
projects, sessions, chat streaming, tools, models, providers, settings, packages, and generic
extension UI. See [the roadmap](docs/roadmap.md) for delivery phases.

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
  ui/             Shared product UI and domain components
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
Maintained extension compatibility evidence is recorded in
[docs/extension-compatibility.md](docs/extension-compatibility.md).
