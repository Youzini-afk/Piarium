# @piarium/application-client

Framework-neutral Piarium application client boundary.

## Purpose

This package owns the `RuntimeAPIs` aggregate interface, all 24 API interfaces (Terminal, Git,
Files, Documents, Settings, Permissions, Notifications, Extensions, Language, Tasks, Debug, Tests,
etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
`RunServicesError`, `WorkspaceSearchError`), pure DTO types (`WorktreeMetadata`,
`DraftStarterRef`, `FileEditorSettingsPatch`), and the single desktop IPC contract (`desktop.ts`).

The desktop contract defines:

- `PiariumDesktopCommandMap` — typed `{ args, result }` for all 58 `desktop_*` commands
- `PiariumDesktopBridge` — the typed bridge interface implemented by Electron preload and consumed by the UI
- `PreloadBootstrapPayload` — discriminated union carrying credentials only for local pages
- `PiariumDesktopEventMap` — typed desktop events (update progress, SSH status, menu actions, etc.)
- exhaustive command/event catalogs and runtime guards, plus `PIARIUM_REMOTE_SAFE_DESKTOP_COMMANDS`

It has no React, Zustand, or UI component dependencies. It depends only on `@piarium/protocol` and
`@piarium/extension-contract`.

## Consumers

- `packages/web` — Web/remote surface API implementations
- `packages/vscode` — VS Code webview API implementations
- `packages/ui` — shared React presentation and client-side kernels
- `packages/electron` — Electron main/preload import the focused `@piarium/application-client/desktop`
  subpath so bundling the native bridge does not pull in unrelated HTTP/relay transport modules

All four consumers import contracts and transport primitives directly from
`@piarium/application-client`; the former UI forwarding modules have been removed. Relay is injected
through `registerRelayTunnelProvider` and `registerRelayTunnelLifecycle`, so this package never imports
the UI tunnel implementation. Selecting Relay without a registered lifecycle fails explicitly.

## History

This package was extracted from the former UI-owned API and transport modules to clarify the boundary
between framework-neutral client behavior and React presentation.
