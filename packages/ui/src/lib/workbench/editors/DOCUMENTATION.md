# Editor Workbench Kernel

Shared editor groups, resource providers, commands, context keys, and panel model. Shells mount
this kernel; they do not own document buffers, disk revisions, or layout schema.

- `groups.ts` — split tree, tabs, preview/pinned, move, close. Moving the last tab out of a group
  collapses that group.
- `snapshot.ts` — workspace-scoped restore: missing, empty, malformed, failure, ready
- `persist.ts` — runtime+workspace local snapshot, 400ms structural debounce, pagehide/freeze flush,
  in-memory last-good. Cursor/scroll patches update last-good without scheduling a write.
- `session.ts` — Map by workspaceId. `peekEditorWorkbench` never creates. Persist failure/malformed
  keeps last-good and does not write empty over the failed snapshot. Runtime switch resets the map.
- `providers.ts` — enabled provider selection, user association, text fallback, and disable without
  background work
- `commands.ts` / `context-keys.ts` / `menus.ts` — owner-scoped commands, per-key context subscribe,
  `when` menu projection
- `panels.ts` — terminal/problems/output container; empty is distinct from failure
- `view-state.ts` — per-view cursor/scroll capture and restore

High-frequency cursor/scroll state stays on the tab `viewState` in memory. Snapshots are explicit,
not per keystroke. Document dirty buffers remain in the Document Registry.

The Agent Files surface and the official IDE Workbench both mount this kernel. `FilesView` is now
only a composition of `SidebarFilesTree` and `EditorWorkbenchArea`; it owns no second document or
tab model. `useFilesExplorerStore` persists expanded directories and performs a one-time migration
of legacy open paths into Editor Workbench.

The official IDE layout is a versioned split/stack/editor-area document stored by the
`piarium.workbench.layout` v1 Host service in profile/workspace-scoped extension storage. Missing
and empty documents use the distribution default without writing it; malformed/read failures keep
the last valid in-memory document and surface a diagnostic instead of replacing Host state.

Language diagnostics publish into the Problems panel through the language-services registry.
Stale diagnostic versions are dropped. Hidden search views do not start language servers.

Run, debug, and test live in `lib/run-debug`. The Application Host owns DAP adapters, test
providers, and task processes; renderers never start a debugger. `acquireRunDebugView` opens
SSE subscriptions only while a Run view is visible. Hidden views drop those listeners and
do not keep refreshing. Agent attachments may cite a test failure or stack frame as prompt
text; they never grant process, debug, or test-runner capability.

Agent/editor coordination lives in `lib/agent-editor`: attachments are runtime+session scoped,
unsaved snapshots are explicit prompt text, tool path hints never override DocumentsAPI watches,
and patch accept/reject writes use expected revision.
