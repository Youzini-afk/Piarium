# Changelog

## 0.1.0

- Replaced the managed OpenCode process, SDK proxy, SSE bridge, and OpenCode configuration stack with the bundled Pi host and Piarium runtime broker.
- Migrated chat, sessions, agents, providers, packages, prompts, settings, agent groups, and editor-tab sessions to Pi-native contracts.
- Kept workspace files, Git, GitHub, worktrees, editor integration, theme adaptation, and multi-root workspace support behind the trusted VS Code extension boundary.
- Reduced the VS Code surface to a companion sidebar: Settings and session switching stay in that sidebar, while Agent groups, Fleet, and the official IDE Workbench remain on Piarium desktop or web.
- Moved generated worktrees and default branches to Piarium-owned paths and naming without writing OpenCode metadata into repositories.
- Renamed extension identity, commands, views, diagnostics, localization, and development configuration to Piarium.

Earlier OpenChamber history remains available in Git before the Piarium fork migration.
