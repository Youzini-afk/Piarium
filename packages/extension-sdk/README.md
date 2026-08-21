# @piarium/extension-sdk

Framework-neutral authoring API for managed, isolated, and brokered-Host Piarium extensions.
Extensions export an `activate` function or use `defineSurfaceExtension`, `defineIsolatedExtension`,
or `defineHostExtension`. Activation contexts own contributions, services, disposers, authenticated
assets, styles, revisioned storage, and capability clients without importing Piarium's product UI.

Host extensions open independent namespaced documents with
`await context.storage.open({ scope, key, schemaVersion? })`. Each document client exposes its own
snapshot, refresh, revision-checked update, and schema version. Piarium injects the extension ID, so
an extension cannot address another extension's namespace. `context.storage.snapshot/update` remains
the compatibility client for `application/state`; new code should use `storage.open(...)` explicitly.

`defineSurfaceMount` creates a framework-neutral contribution implementation. Its `mount(container,
context)` callback receives an ordinary `HTMLElement`, contribution props, owner metadata, a
mount-scoped `AbortSignal`, and `reportError`; it may return a synchronous or asynchronous disposer.
Piarium aborts and disposes that mounted instance when its props or owner change, the extension is
disabled, or the host unmounts it. DOM, Canvas, Web Components, and framework-owned roots can all use
the same contract without importing Piarium's React or private UI.

`@piarium/extension-sdk/testing` exports managed Surface, isolated Surface, and Host conformance
harnesses with real owner cleanup semantics. See the complete
[authoring guide](https://github.com/Youzini-afk/Piarium/blob/main/docs/piarium-extension-authoring.md).

Granted Host extensions can call `workspace.documents` through `callWorkspaceDocuments` or
`createWorkspaceDocumentsClient` for resource-scoped, revisioned document access. The capability never
returns file bodies in watch events, and it cannot escape the workspace the application host resolved.

`callWorkspaceSearch` / `callWorkspaceLanguage` and `createWorkspaceLanguageClient` reach the
host-owned search and language services. `defineLanguageProvider` registers a Host language server.
Language servers are spawned only in the application host; untrusted workspaces cannot execute
project-provided server commands. Search failures are distinct from zero matches.

`callWorkspaceDebug` / `createWorkspaceDebugClient` / `defineDebugAdapter` and
`callWorkspaceTest` / `createWorkspaceTestClient` / `defineTestProvider` register Host-side
debug adapters and test providers. Those processes are spawned only in the application host.
`defineDebugAdapter` and `defineTestProvider` unregister on dispose through `context.effect`.
Renderers never start a debugger, test runner, or task process.

Public workbench constants (`PIARIUM_WORKBENCH_REPLACEMENT_TARGETS`, `PIARIUM_WORKBENCH_SLOTS`,
`PIARIUM_WORKBENCH_CONTEXT_KEYS`) are re-exported from this package. `defineShellMount`,
and `defineViewMount` share the generic mount contract. `defineEditorMount` additionally types
`mount.props.resource`, `viewId`, and the stable document controller used to subscribe, update with an
expected `documentVersion`, and save. Editor contributions declare `data.languageIds` or
`data.filenames`; they are mounted as resource providers rather than in an action slot.
