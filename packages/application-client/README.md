# @varin/application-client

Framework-neutral Varin application client boundary.

## Purpose

This package owns the `RuntimeAPIs` aggregate interface and the API interfaces (Terminal, Git,
Files, Documents, Settings, Permissions, Notifications, Extensions, Language, LanguageSupport, Tasks, Debug, Tests,
etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
`LanguageSupportError`, `RunServicesError`, `WorkspaceSearchError`), pure DTO types (`WorktreeMetadata`,
`DraftStarterRef`, `FileEditorSettingsPatch`, `ThreadResultHistory`), and the single desktop IPC contract (`desktop.ts`).

`thread-history.ts` describes the user-only Thread history list and release response. The Host owns
selection validation and object cleanup; the UI sends a frozen branch/revision selection. Logical bytes
referenced by a version and bytes actually removed by cleanup are distinct fields. These DTOs do not
add an Agent tool or a second state store.

The desktop contract defines:

- `VarinDesktopCommandMap` — typed `{ args, result }` for all 58 `desktop_*` commands
- `VarinDesktopBridge` — the typed bridge interface implemented by Electron preload and consumed by the UI
- `PreloadBootstrapPayload` — discriminated union carrying credentials only for local pages
- `VarinDesktopEventMap` — typed desktop events (update progress, SSH status, menu actions, etc.)
- exhaustive command/event catalogs and runtime guards, plus `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS`

It has no React, Zustand, or UI component dependencies. It depends only on `@varin/protocol` and
`@varin/extension-contract`.

## Consumers

- `packages/web` — Web/remote surface API implementations
- `packages/ui` — shared React presentation and client-side kernels
- `packages/electron` — Electron main/preload import the focused `@varin/application-client/desktop`
  subpath so bundling the native bridge does not pull in unrelated HTTP/relay transport modules

All three product consumers import contracts and transport primitives directly from
`@varin/application-client`; the former UI forwarding modules have been removed. Relay is injected
through `registerRelayTunnelProvider` and `registerRelayTunnelLifecycle`, so this package never imports
the UI tunnel implementation. Selecting Relay without a registered lifecycle fails explicitly.

## History

This package was extracted from the former UI-owned API and transport modules to clarify the boundary
between framework-neutral client behavior and React presentation.
