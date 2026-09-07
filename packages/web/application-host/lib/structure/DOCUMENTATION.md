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

| Operation | Meaning | Providers |
| --- | --- | --- |
| `outline` | Named units with signature and full span | tree-sitter (TS/TSX), then LSP `documentSymbol` |
| `classifyHits` | Hit line → name / body / string / comment | tree-sitter (not LSP) |
| `literalCalls` | Call + string-literal shapes | tree-sitter extracts; `StructureSource` fans out like outline (D-106); graph write classifies `connects` vs `associates` |
| `imports` | Import sources | tree-sitter extracts; same fan-out; specifier strings are written as `imports` edges |

Statuses stay distinct: `ready`, `empty`, `unavailable` (cold or missing
runtime), `unsupported` (no language, or no `documentSymbolProvider`), `stale`,
`failed`, `cancelled`. They must not collapse into one successful empty list.

`createStructureSource` tries configured providers in order. The first `ready`
outline that covers every supplied hit line wins immediately. `empty`, or a
`ready` outline that misses a hit, does not hide a later provider: the next
call is `warmOnly` so a cold language server is not started (D-099). The first
provider's `unavailable` still allows a cold start on the next one. A later
`ready` outline replaces the earlier one; results are not merged.
`literalCalls` and `imports` use the same cancelled / empty / warmOnly /
unavailable rules without hit-line coverage. When no configured provider
declares the capability, the facade status is `unsupported`, not `failed`
(D-106). LSP still reports `unsupported` for those two operations.

## Slice

Slice units are **containers**: function, method, constructor, class, interface,
enum, module/namespace, type, struct, package (D-098). Ordinary value bindings,
fields, method signatures, and enum members are names inside a container, not
the unit. A hit on `const needle = 1` inside `function big` selects `big`.
`const foo = () => {}` / `const C = class {}` stay their own units because the
tree-sitter provider emits them as `function` / `class` after inspecting the
initializer.

`sliceStructureWindows` turns an outline plus hit lines into explore windows:

- Inclusive span ≤ `SMALL_STRUCTURE_SPAN_LINES` (24; one typical editor
  viewport, D-093) → the whole unit.
- A unit whose signature spans the whole unit carries no body of its own, so it
  is padded to at least the ±3 window around each hit (D-102). Container kinds
  alone do not prevent this: `documentSymbol` types an interface call signature
  as `method`, so the smallest container can be one line. Units that do have a
  body stay exact.
- Larger → signature + hit block (±3 clipped to the unit) + explicit omission
  markers that include a full-unit `read path:start-end` entry.
- Missing, empty, unsupported, unavailable, failed, cancelled, or stale
  outlines → the existing ±3 line window. Stale outlines are not applied to the
  current text. A value-binding hit inside a container is never a one-line
  unit.

That ±3 fallback is a runtime degradation, not a compatibility layer for old
callers.

## Tree-sitter coverage (TS/TSX)

Wired language ids are `typescript` and `typescriptreact` only.

Covered as outline units: function / generator / class / abstract class
(including named `export default` and anonymous `export default class {}`),
interface, type alias, enum, `method_definition` (class and object-literal
methods), `function_signature` (`declare function`), `internal_module` /
`module` (`namespace`, `declare namespace`, `module`), and lexical / `var` /
public-field bindings whose initializer is a function, arrow, or class.

Covered as names only (classification, not slice units): ordinary
`const` / `let` / `var` value bindings, `method_signature` /
`abstract_method_signature`, and public fields with a non-definition
initializer.

Not covered: JS/JSX language ids, import aliases, enum members as units,
interface members as units, parameters, decorators, unnamed
`export default abstract class {}` (the grammar emits an error node), and a
full grammar-node census. Arrow bindings (`const beta = () => {}`,
`export const gamma = () => {}`) and `export default function` outline
normally; they are not a coverage gap.

The parse cache pins in-use trees so LRU eviction cannot `tree.delete()` a
wasm object a caller still holds after `await`.

## Wiring

`createHarnessServiceHost({ structureSource })` is optional, same shape as
`lspNavigationServices`. Production `index.ts` installs tree-sitter first, then
the LSP provider (D-097). Explore consumes the interface only; it does not call
`documentSymbols` itself.

Runtime wasm lives in `lib/structure/runtime/` (`web-tree-sitter.wasm` plus the
TS/TSX grammars from `tree-sitter-typescript@0.23.2`). Paths go through the same
asar / asar.unpacked remap as `extension-builtins` (D-096). A missing or
unloadable wasm is `unavailable`; explore then tries LSP or the ±3 window.

`STRUCTURE_PARSE_BUDGET_MS` bounds parse plus query after the wasm is loaded.
It is a wall clock and a runaway guard, not a latency target: a value near an
ordinary file's parse time makes a busy Host report `failed` and silently drop
to ±3 windows. Tests that assert a real parse pin their own budget rather than
inheriting the production value (D-102).

Hit classification (D-095) runs only after a file is materialized. Candidate
ranking before `readFile` is unchanged. `windowScore` then adds
`STRUCTURE_HIT_CLASS_SCORE` so a declaration name outranks the same token in a
comment or string.

A repeatable agent-view cold-start measurement lives in
`packages/web/scripts/structure-cold-start.ts` (`bun run --cwd packages/web structure:cold-start`).
It is not in the default test suite. Numbers go in `docs/agent-harness-status.md`;
do not turn them into speedup claims.
