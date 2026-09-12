# Semantic index

Code-semantic index for explore’s third recall path (design 6.1 / 3.16, D-166–D-193).
Host-only writer. Not the authoritative workspace `.tdb`. Knowledge-base vectors are a sibling
derived store (`../vectors/`); they reuse `harness.embed` but never this MiniLM fallback.

- Identities: `identity.ts` — vector space, index recipe, `{ scopeKind, scopeId }`. Remote spaces use
  `remoteEmbeddingSpaceId` from protocol parts (no credentials).
- Embedder: `backend.ts` — unconfigured → local MiniLM; `harness.embedding` set → `remote-embedder.ts`
  via workspace `harness.embed`. Configured remote never falls back to MiniLM in the same query.
- Chunking: `chunker.ts` — tree-sitter containers, backend input length, continue-split of long lines.
- Cache / schedule: `vector-cache.ts` (space + purpose + embedText, byte soft budget);
  `embed-scheduler.ts` (current batch finishes, then foreground before the next background batch).
- Overlay: `query-view.ts` pins surface/thread drafts at query start; masked disk paths cannot leak
  old vectors. Thread view is fixed baseline + this branch’s delta.
- Storage: `store.ts` — one TriviumDB generation per scope/space; scoped Top-K (D-189); `publishToken`.
- Runtime: `runtime.ts` — Documents-revision incremental scan, first-publish wait, overlay extras.
- Production assembly: `workspace-runtime.ts` owns per-workspace Settings/describe resolution, remote
  transport, config watches, backend refresh, query view selection and shutdown. Application Host uses
  its `semanticRecall` / `harnessSettings` / `rerankExploreViews` directly; tests consume those same methods.
  A virtual Thread uses its pinned WorkingBranch files. A materialized Thread indexes its execution
  Documents workspace, never the owning workspace's current files. Both Documents mutations and successful
  native-tool journal completions notify this runtime. Open indexes mask an observed path before the tool
  is acknowledged; embedding runs in the background. Metadata resolution obeys query cancellation, and a
  retired workspace worker or closed Host cannot publish a late binding/watch as current.
- Model pack: `model-store.ts`; `minilm.ts` loads `@huggingface/transformers` when weights exist and
  sets Node ORT session threads.
