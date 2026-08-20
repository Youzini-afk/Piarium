# VS Code runtime architecture

## Boundary

The extension host is the trusted boundary. It owns the bundled Pi runtime, workspace filesystem access, Git processes, GitHub credentials, editor commands, and persisted extension settings. The React webview owns presentation and sends typed requests through the VS Code bridge. Pi extensions never execute in the webview.

## Startup and Pi runtime

- `extension.ts` registers the companion sidebar, commands, URI handler, and owns activation and disposal.
- `piRuntime.ts` resolves the Node executable and staged Pi host, starts one runtime broker, serializes restart/dispose, and exposes connection state.
- `piRuntimeWebviewBridge.ts` connects an individual webview to the broker protocol and forwards only protocol messages.
- `webviewHtml.ts` produces the CSP-constrained bootstrap document and injects non-secret workspace/runtime presentation state.
- `webview/main.tsx` registers VS Code `RuntimeAPIs`, configures the Pi runtime client, synchronizes workspace candidates, and mounts the shared Piarium UI.

The packaged runtime is prepared by `scripts/prepare-pi-runtime.mjs`. `scripts/test-pi-runtime.mjs` verifies the staged host can start and answer through the broker.

## Native bridge

`bridge.ts` is the thin dispatcher for platform capabilities that do not belong in the Pi protocol:

- `bridge-fs-runtime.ts` and `bridge-fs-helpers-runtime.ts`: bounded workspace file listing, search, reads, and attachment ingestion.
- `bridge-git-runtime.ts`, `bridge-git-conflict-runtime.ts`, `bridge-git-process-runtime.ts`, and `gitService.ts`: Git status, mutations, conflicts, worktrees, and process environment.
- `bridge-settings-runtime.ts`: atomic Piarium settings persistence plus editor-derived fields.
- `bridge-vscode-runtime.ts`: open-file, diff, external-URL, and explicitly requested VS Code commands.
- `githubAuth.ts`, `githubPr.ts`, `githubPulls.ts`, and `githubIssues.ts`: GitHub device authentication and repository workflows.

Unknown requests fail explicitly. Filesystem and shell-like operations remain in the extension host; the webview receives only operation results.

## Worktrees

Worktree creation has three observable phases: `directory-created`, `git-ready`, and `setup-ready`. Fast creation may return after the directory exists while the tracked bootstrap task populates Git with long-path support, restores Git's `post-checkout` hook semantics, applies upstream configuration, and runs the explicit Piarium setup command. Removal waits for an active bootstrap task so the directory cannot be recreated after deletion.

Generated worktrees use the Piarium data directory and default `piarium/<name>` branches. The project key is derived from the canonical repository path. The service does not write `.git/opencode`, consume OpenCode project storage, or mirror sandbox metadata into another engine's schema.

## Companion surface

- `ChatViewProvider.ts`: sidebar chat, Settings, session switching, and workspace/editor context synchronization.
- `companion-uri.ts`: `vscode://youzini-afk.piarium/chat` deep-link parsing. Unknown paths fail visibly and do not open a second workbench.

The official IDE Workbench and Agent Profile Fleet UI are not hosted in VS Code. Settings, session switching, and chat all use this single sidebar webview. The extension host still owns filesystem, Git, documents, search, language, and the bundled Pi runtime.

Settings updates are broadcast back into the sidebar webview after the authoritative write succeeds.

## Validation

Use the package scripts as the source of truth:

```bash
bun run --cwd packages/vscode type-check
bun test packages/vscode/src packages/vscode/webview
bun run --cwd packages/vscode build
bun run --cwd packages/vscode verify:pi-runtime
```

For release packaging, run `bun run --cwd packages/vscode package` after the build.
