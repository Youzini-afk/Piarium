# Piarium for VS Code

Piarium brings the project's Pi-native sessions, agents, providers, packages, and workspace tools into VS Code, Cursor, and compatible editors.

The extension starts the bundled Pi host and runtime broker in the extension host. It does not download, discover, or proxy an OpenCode CLI. The webview talks to the Pi runtime through a typed VS Code message bridge, while filesystem, Git, GitHub, editor, settings, and revisioned document operations stay in the trusted extension host.

## Features

- Pi session tree and streaming chat beside the editor.
- Pi agents from built-ins, user/project configuration, and installed packages.
- Provider, model, package, prompt, and resource settings shared with Piarium.
- Parallel agent groups with isolated Git worktrees.
- File mentions, attachments, click-to-open paths, and diff views.
- Git and GitHub pull request or issue workflows.
- Sidebar, editor-tab session, Settings, and Agent Manager surfaces.
- VS Code light, dark, and high-contrast theme adaptation.

## Commands

| Command | Purpose |
| --- | --- |
| `Piarium: Focus Chat` | Focus the chat view. |
| `Piarium: New Session` | Start a Pi session in the selected workspace. |
| `Piarium: Open Sidebar` | Reveal the Piarium view container. |
| `Piarium: Open Agent Manager` | Run and compare an agent group. |
| `Piarium: Open Session in Editor` | Open the active or a new session in an editor tab. |
| `Piarium: Settings` | Open Piarium Settings. |
| `Piarium: Restart Pi Runtime` | Dispose and restart the bundled Pi runtime. |
| `Piarium: Show Pi Runtime Status` | Show runtime diagnostics in the output channel. |

Editor and Explorer context menus also provide Add to Context, Explain, Improve Code, and Attach to Piarium Chat actions.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `piarium.nodePath` | empty | Optional absolute Node.js executable used to start the bundled Pi host. Leave empty to use the extension host executable. |

No separate Pi or OpenCode installation is required. Piarium packages and user configuration are still read from Pi's normal configuration locations by the bundled host.

## Development

From the repository root:

```bash
bun install
bun run vscode:dev
```

Optional development overrides:

```bash
PIARIUM_VSCODE_BIN=cursor bun run vscode:dev
PIARIUM_VSCODE_DEV_WORKSPACE=D:\\path\\to\\workspace bun run vscode:dev
PIARIUM_VSCODE_WEBVIEW_URL=http://localhost:5173 bun run vscode:dev
```

Build and package:

```bash
bun run --cwd packages/vscode build
bun run --cwd packages/vscode package
```

The VSIX is written under `packages/vscode` by `vsce`.

## Data and worktrees

Extension settings are stored in Piarium's configuration directory. Generated worktrees live below the Piarium data directory (`PIARIUM_DATA_DIR` when set, otherwise the platform data location) and use `piarium/<name>` branches by default. Piarium does not write engine-specific metadata into the repository.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Incorporated permissive
material retains the notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
