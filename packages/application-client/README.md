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
- `packages/ui` — shared React presentation (re-exports for backward compatibility)

Web and VS Code non-render code imports from `@piarium/application-client` directly rather than
reaching into `@piarium/ui/lib/api`.

## History

This package was extracted from `packages/ui/src/lib/api/types.ts` to clarify the boundary between
framework-neutral client contracts and React presentation. The UI's `types.ts` and error files are
now thin re-exports from this package.
