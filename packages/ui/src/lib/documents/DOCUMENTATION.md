# Document Registry

Per-document editing state for Piarium workspace text files. High-frequency buffers live in this
external registry, not in Zustand or Local Storage.

- `registry.ts` — load/save/watch, dirty/conflict, in-flight save, recovery journals, Agent/disk source hints
- Three-way conflict stores ancestor, buffer, and disk candidate; writes still use expected revision
- `session.ts` — one registry per bound `DocumentsAPI`
- `hooks.ts` — per-document React subscriptions
- `path.ts` — workspace-relative resource IDs
- `workspace-text.ts` — non-editor text read/write through DocumentsAPI

Files UI still owns tree and Agent tab navigation. Split groups, preview/pinned tabs, and per-view
cursor restore live in the Editor Workbench Kernel. Document records survive Profile/Settings
remounts until application-host endpoint switch. `FilesAPI` and `WorkspaceAPI` no longer expose
text read/write; editors and helpers use DocumentsAPI only.
