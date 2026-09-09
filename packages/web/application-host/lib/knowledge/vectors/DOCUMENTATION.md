# Knowledge vectors

Derived semantic index for accepted knowledge (plan 2.8 / D-196).
Host-only writer. Not the authoritative workspace or user `.tdb`.

- Authority content, status, source, and supersedes stay in `store.ts`.
- Vectors live under `knowledge/{hostId}/knowledge-vectors/{scope}/{scopeId}/{spaceId}/`.
- Embedding uses the same user-owned `harness.embedding` → `harness.embed` path as code semantic. Unconfigured knowledge recall stays text-only and never claims `via:vector` or falls back to MiniLM.
- Search builds Top-K inside the accepted, valid, in-scope id set, then re-checks authority revision. Text and vector ranks merge with RRF.
