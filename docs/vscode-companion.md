# VS Code Companion migration

Status: Phase 11 authority

The official IDE Workbench now lives in Piarium Web and Electron (`piarium.ide`). The VS Code
extension is a companion: it opens Piarium beside the editor, sends editor context, and keeps the
workspace bridge. It is not a second full workbench.

## User data

| Data | Authority | Companion behavior |
| --- | --- | --- |
| Pi sessions, providers, packages, prompts | Pi configuration and session JSONL | Unchanged. The bundled Pi host still reads the same locations. |
| Piarium Settings documents | Piarium settings storage | Open Settings inside the sidebar companion. Do not use a separate Settings editor panel. |
| Worktrees | Piarium data directory | Unchanged. Worktree Git operations stay in the extension host. |
| VS Code `piarium.nodePath` | VS Code user/workspace settings | Kept. It only selects the Node executable for the bundled Pi host. |
| Sidebar auto-move attempt flag | Extension `globalState` | Kept as local UI glue. Not a product Settings store. |

No conversion job is required. Missing Piarium Settings remain missing; empty remain empty; a failed
settings read stays a failure and does not become a blank document.

## Deep links

Register `vscode.window.registerUriHandler` for this extension.

- `vscode://youzini-afk.piarium/chat` focuses the companion sidebar.
- `vscode://youzini-afk.piarium/chat?session=<id>` focuses the sidebar and opens that session.
- Unknown paths show an error and do not spawn a second workbench.

Web/Electron continue to own `piarium:` product deep links. The VS Code handler does not mint those
URLs and does not proxy them through the webview.

## Session open path

| Old VS Code path | Companion path |
| --- | --- |
| Session editor tab | Sidebar chat (`piarium.openSidebar` / `openSession`) |
| `Piarium: Open Session in Editor` | Opens the session in the sidebar |
| Editor-title new session | `Piarium: New Session` in the sidebar |
| Add to Context / Attach file targeting an editor tab | Always targets the sidebar chat |

If the sidebar webview is not ready, commands fail visibly. They do not open a fallback editor panel.

## Keep, migrate, refuse

### Keep

- Open/focus the Piarium sidebar.
- New session, active session status, and session switcher in the sidebar.
- Send file, selection, and editor prompts (Explain / Improve) into the current Pi session.
- Workspace filesystem, Git, GitHub, documents, search, and language bridges in the extension host.
- Bundled Pi host, restart, and runtime status output.
- Theme adaptation and `piarium.nodePath`.

### Migrate

- Settings: use the in-sidebar Settings view. The separate Settings editor panel is removed.
- Session editor tabs: use the sidebar. Commands that opened editor tabs now focus the sidebar.
- Agents / Fleet: use the Piarium Agent Profile on desktop or web. The companion shows that
  instruction instead of opening a second management surface. The obsolete Agent Groups workbench
  was removed; the maintained Agents catalog and Fleet runtime pages remain the product authorities.

### Refuse

- A second Settings, Agent Manager, or session-editor product shell in VS Code.
- Host-side DAP, test runners, or task processes in the VS Code webview. Run/debug/test stay
  `absent` / `unsupported` here; the official loop is Web/Electron Application Host.
- Official IDE Workbench chrome (`piarium.ide`) inside the VS Code webview.
- Copying Pi plugin private state into the companion.
- A `piarium://` handler that pretends VS Code is the product host.
