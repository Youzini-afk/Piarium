# Monaco runtime foundation

The official desktop/Web file editor loads Monaco through this directory. Importing these modules
must not make Monaco eager: `runtime.ts` owns one lazy runtime promise and installs one editor-worker
factory only when `loadMonacoRuntime()` is called.

- `runtime.ts` imports `monaco-editor/editor`, editor features, and lazy basic-language definitions
  through public 0.56 entrypoints.
  It rejects non-editor worker labels so Monaco's TS/JS/JSON/CSS/HTML language services cannot become
  a second language authority beside the Application Host.
- `theme.ts` projects Piarium semantic theme tokens into Monaco. It owns no theme preference.
- `editor-options.ts` projects the active Workbench Profile and validated user settings. `default`
  uses `agent-compact`; `piarium.ide` uses `ide-full`; user settings override either without replacing
  the model.
- `editor-command-service.ts` tracks the focused view and projects one command table into Piarium
  commands, workbench menus/context keys, toolbar actions, and user shortcut overrides. It exposes no
  raw editor/model handle.
- `model-registry.ts` projects one Document Registry record into one Monaco model. Workbench tabs own
  models; React views only own layout/listeners. The model URI contains a runtime key and internal
  document instance ID, never a workspace path.
- `language-bridge.ts` keeps the existing Host language service authoritative. It projects generation-
  scoped diagnostics and rich language features, including rename and code actions. Cross-file edits go
  through the Document Registry preview/transaction path, completion additional edits stay in Monaco's
  single-model transaction, and server commands return to the Host only after document sync. Monaco's
  built-in semantic workers remain disabled.
- `view-state.ts` owns the v2 Monaco payload and a framework-neutral cursor/selection summary.
- `vim-adapter.ts` consumes the persisted Vim setting through Monaco 0.56 public APIs. It deliberately
  does not import `monaco-vim` private `vs/*` modules; mode cursors, counted motions/edits, search,
  save, composition handling, dispose, and re-enable remain a behavior adapter, never document state.
- `performance.ts` emits privacy-safe marks for runtime import, worker creation, model readiness, and
  first paint.
- `fixture.ts` is used by the conditional Web/Electron smoke entry. It is not the production file
  adapter. Its 50,000-line CodeMirror/Monaco comparison is
  a diagnostic sample, not an editor file-size or line-count limit.

Do not import the `monaco-editor` root entrypoint, `editor.main`, or
`monaco-editor/languages/features/*`. Language definitions used for tokenization are distinct from
language features; semantic language capability remains behind `RuntimeAPIs.language`.
