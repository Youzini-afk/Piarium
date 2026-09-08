# Semantic index

Local MiniLM index for explore’s third recall path (design 6.1 / 3.16 first slice).
Host-only writer. Not the authoritative workspace `.tdb`.

- Identities: `identity.ts` — vector space, index recipe, `{ scopeKind, scopeId }`.
- Chunking: `chunker.ts` — tree-sitter containers, tokenizer length, fallback overlap.
- Storage: `store.ts` — one TriviumDB generation per scope/space; `searchExact` then cosine.
- Runtime: `runtime.ts` — Documents-revision incremental scan, same batch/debounce lessons as the symbol catalog.
- Model pack: `model-store.ts` — content-addressed like structure grammars; `minilm.ts` loads `@huggingface/transformers` only when weights exist.
