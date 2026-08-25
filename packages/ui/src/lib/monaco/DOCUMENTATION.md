# Monaco runtime foundation

The official desktop/Web file editor loads Monaco through this directory. Importing these modules
must not make Monaco eager: `runtime.ts` owns one lazy runtime promise and installs one editor-worker
factory only when `loadMonacoRuntime()` is called.

- `runtime.ts` imports `monaco-editor/editor` and editor features through public 0.56 entrypoints.
  It rejects non-editor worker labels so Monaco's TS/JS/JSON/CSS/HTML language services cannot become
  a second language authority beside the Application Host.
- `theme.ts` projects Piarium semantic theme tokens into Monaco. It owns no theme preference.
- `model-registry.ts` projects one Document Registry record into one Monaco model. Workbench tabs own
  models; React views only own layout/listeners. The model URI contains a runtime key and internal
  document instance ID, never a workspace path.
- `language-bridge.ts` keeps the existing Host language service authoritative. It projects accepted
  diagnostics into markers and registers baseline completion/hover providers without enabling Monaco's
  built-in semantic workers.
- `view-state.ts` owns the v2 Monaco payload and a framework-neutral cursor/selection summary.
- `vim-adapter.ts` consumes the persisted Vim setting through Monaco 0.56 public APIs. It deliberately
  does not import `monaco-vim` private `vs/*` modules; advanced mappings remain a Phase 3 behavior layer.
- `performance.ts` emits privacy-safe marks for runtime import, worker creation, model readiness, and
  first paint.
- `fixture.ts` is used by the conditional Web/Electron smoke entry. It is not the production file
  adapter; the Document Registry binding is Phase 2. Its 50,000-line CodeMirror/Monaco comparison is
  a diagnostic sample, not an editor file-size or line-count limit.

Do not import the `monaco-editor` root entrypoint, `editor.main`, or
`monaco-editor/languages/features/*`. Language definitions used for tokenization are distinct from
language features; semantic language capability remains behind `RuntimeAPIs.language`.
