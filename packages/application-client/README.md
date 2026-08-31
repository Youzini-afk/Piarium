# @piarium/application-client

Framework-neutral Piarium application client boundary.

## Purpose

This package owns the `RuntimeAPIs` aggregate interface, all 24 API interfaces (Terminal, Git,
Files, Documents, Settings, Permissions, Notifications, Extensions, Language, Tasks, Debug, Tests,
etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
`RunServicesError`, `WorkspaceSearchError`), and pure DTO types (`WorktreeMetadata`,
`DraftStarterRef`, `FileEditorSettingsPatch`).

It has no React, Zustand, or UI component dependencies. It depends only on `@piarium/protocol` and
`@piarium/extension-contract`.

## Consumers

- `packages/web` — Web/remote surface API implementations
- `packages/vscode` — VS Code webview API implementations
- `packages/ui` — shared React presentation and client-side kernels

All three consumers import contracts and transport primitives directly from
`@piarium/application-client`; the former UI forwarding modules have been removed. Relay is injected
through `registerRelayTunnelProvider` and `registerRelayTunnelLifecycle`, so this package never imports
the UI tunnel implementation. Selecting Relay without a registered lifecycle fails explicitly.

## History

This package was extracted from the former UI-owned API and transport modules to clarify the boundary
between framework-neutral client behavior and React presentation.
