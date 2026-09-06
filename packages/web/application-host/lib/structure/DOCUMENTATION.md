# Structure sources

Application Host module for syntax-shaped facts used by explore (and later by
hit classification, connection edges, and the knowledge graph). It does not run
in a renderer and is not a language-server replacement.

## Ownership

- Language identity is `languageIdForPath` from `@piarium/protocol`. This module
  does not keep a third extension table.
- Text binding for the LSP provider reuses `createLanguageViewBinder`. Explore
  calls it with `text: "input-context"` (this turn's fixed draft, otherwise disk).
  A dirty path whose draft is unavailable does not fall back to disk.
- Revisions are hard: every request names a revision, every result names the
  revision it used. A mismatch is `stale`, never a silent reuse of an older
  outline on newer text.

## Provider contract

`StructureProvider` exposes four operations. Capability flags say which ones a
provider can actually answer for a language:

| Operation | Meaning | First providers |
| --- | --- | --- |
| `outline` | Named units with signature and full span | LSP `documentSymbol`; later tree-sitter |
| `classifyHits` | Hit line → name / body / string / comment | tree-sitter (not LSP) |
| `literalCalls` | Call + string-literal shapes | later (step 4) |
| `imports` | Import sources | later (step 4) |

Statuses stay distinct: `ready`, `empty`, `unavailable` (cold or missing
runtime), `unsupported` (no language, or no `documentSymbolProvider`), `stale`,
`failed`, `cancelled`. They must not collapse into one successful empty list.

`createStructureSource` tries configured providers in order. The first `ready`
or `empty` outline wins. An earlier `unavailable` does not hide a later provider
that can still answer.

## Slice

`sliceStructureWindows` turns an outline plus hit lines into explore windows:

- Inclusive span ≤ `SMALL_STRUCTURE_SPAN_LINES` (24; one typical editor
  viewport, D-093) → the whole unit.
- Larger → signature + hit block (±3 clipped to the unit) + explicit omission
  markers that include a full-unit `read path:start-end` entry.
- Missing, empty, unsupported, unavailable, failed, cancelled, or stale
  outlines → the existing ±3 line window. Stale outlines are not applied to the
  current text.

That ±3 fallback is a runtime degradation, not a compatibility layer for old
callers.

## Wiring

`createHarnessServiceHost({ structureSource })` is optional, same shape as
`lspNavigationServices`. Production `index.ts` installs the LSP provider.
Explore consumes the interface only; it does not call `documentSymbols` itself.

A repeatable agent-view cold-start measurement lives in
`packages/web/scripts/structure-cold-start.ts` (`bun run --cwd packages/web structure:cold-start`).
It is not in the default test suite. Numbers go in `docs/agent-harness-status.md`;
do not turn them into speedup claims.
