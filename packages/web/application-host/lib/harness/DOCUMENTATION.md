# Agent Harness — Host Side

The host-side harness provides workspace-scoped services that the pi-host
agent tools call via the `HostServicesBridge`. All services are registered
on the `HarnessRouter` and dispatched from the broker event stream.

## Architecture

```
broker event stream ──→ HarnessRouter.processEvent()
                           ├── shell.exec   → ShellSupervisor (per-session PTY)
                           ├── shell.read   → ShellSupervisor
                           ├── shell.write  → ShellSupervisor
                           ├── shell.kill   → ShellSupervisor
                           ├── output.store → OutputStore (global)
                           ├── output.read  → OutputStore
                           ├── search.content → HarnessSearchService
                           ├── document.readSource → fixed surface bytes or disk sentinel
                           ├── document.pathOverlay → fixed relative paths or disk sentinel
                           ├── explore.search → ExploreEngine + Documents snapshots + OutputStore + optional graph path recall
                           ├── related.query → already-open KnowledgeStore (file-level topology; not lsp.references)
                           ├── fs.lock      → PathLockService + Documents identity
                           ├── lsp.diagnostics → LspDiagnosticsService
                           ├── lsp.diagnosticsSnapshot → LspDiagnosticsService
                           ├── memory.blocks.* → KnowledgeStore block validator
                           ├── zone2.assemble → Knowledge material + ThreadRegistry projection
                           └── thread.*     → ThreadRegistry + ThreadRuntime + native working state
```

## Components

### HarnessServiceHost (`service-host.ts`)

Global singleton that owns:
- `OutputStore` — large output storage with per-session isolation
- `ObservationCursorStore` — per-observer shell/diagnostics/thread baselines with prepare/commit delivery CAS, reset by compaction
- `PathLockService` — owner-bound canonical-resource leases
- `HarnessSearchService` — wraps `createWorkspaceContentSearch`
- `DiagnosticsProvider` — LSP diagnostics (optional)
- Per-session `ShellSupervisor` registry

### HarnessRouter (`router.ts`)

Consumes `harness.request` events from the broker stream and dispatches
to registered services. Responds via `harness.respond` on the broker. The
broker-pinned Actor must match the Host session registry and carry the method's
frozen capability. Path-bearing methods are resolved through Documents and, for
a restricted child Run, must also remain inside its scope.

### ShellSupervisor (`shell-supervisor.ts`)

PTY-based persistent shell per session:
- One login shell (git-bash / bash / wsl / powershell) per session
- Commands separated by sentinel markers (`__PIARIUM_SENTINEL_`)
- cwd/env/venv maintained between commands
- Background shells keep PTY alive, stdin open
- Data and cwd/exit sentinels continue to be consumed after a command moves to the background
- `registerWriter` callback for `mode: 'process'` writer registration

### OutputStore (`output-store.ts`)

Stores large tool outputs (default 256 MiB per session) with handle-based
retrieval. Handles are `out_XXX` format.
These are authenticated session-local ephemeral references, not durable files or knowledge records.

### PathLockService (`path-lock.ts`)

The Host first resolves every input through Documents identity, deduplicates
aliases, and acquires the complete path batch in canonical order. The returned
opaque lease IDs are owner-bound. This coordinates Harness-managed writes in
one Application Host; it does not claim to lock terminals, Git, external
processes, or a second Host.

### ThreadRegistry / ThreadRuntime

The registry persists one versioned atomic catalog per workspace. `Thread` is
durable work; `ThreadRun` is one execution attempt, and
`ThreadLaunchManifest` freezes model-adjacent launch inputs. `dispatch` commits
the Thread plus a `starting` Run and returns immediately. The runtime then
creates a managed worktree when needed, opens a real persisted Pi child
session with the role's active-tool allowlist, and projects broker events into
progress, attention, report, durable transcript, and integration state.

One unexpected worker exit is resumed in the same session/worktree as a new
Run; a second consecutive crash becomes `stalled` instead of entering a crash
loop. Interactive child prompts, event silence, and six identical tool
signatures project to `permission`/`user`, `stalled`, and `looping`. The Web UI
reads the same registry through `/api/harness/threads` and SSE; the Pi Fleet
registry exposes it through the `piarium-harness` provider.

### HarnessSearchService (`search-service.ts`)

Wraps `createWorkspaceContentSearch` with hit grouping, scoring, and
formatting. It intersects an explicit request path with the child scope before
launching ripgrep, passes those canonical workspace-contained roots to the
search process, and validates returned resource IDs again. Returns
`SearchContentResult` with files, hits, and totals. For a surface input it reads
all in-scope dirty snapshots first, removes their disk hits before the backend
result cap, applies the same regex/fixed/case/glob semantics to the frozen text,
and ranks the combined set. Context lines come from the same source revision;
source drift makes that context partial instead of attaching unrelated lines.

### Native read source (`document.readSource`, pi-host `read-tool.ts`)

The Router authorizes the requested path with `allowMissing` so an unsaved new
document can be read. Documents returns either a disk sentinel or fixed surface
text with encoding, BOM, and revision. The Host serializes only fixed draft bytes;
pi-host delegates both branches to Pi's `createReadToolDefinition`, preserving
native offset/limit truncation and disk image attachments. The wrapper is
registered only when the Host handshake advertises `harnessDocumentRead`.

The fixed draft is one turn's input, not a standing authority. Once Piarium
observes a write to a path — a Documents write or the Pi mutation journal's
successful `after` phase, which is awaited before the tool is acknowledged —
every snapshot captured before that write stops answering for it, so read,
search, enumeration, navigation, and the dispatch baseline all return to disk and
an agent reads back its own write (D-088). A snapshot captured after the write
keeps its draft. `agentInputDraftPaths` reports the dirty paths the fixed source
still owns; an expired capture keeps every dirty path there and never degrades
into a silent disk read. Shell and external writes stay unobserved, the same
boundary the recovery journal reports.

### Native find/ls path overlay (`document.pathOverlay`)

The Router authorizes the requested root with `allowMissing`, so a dirty-only
directory can be traversed. Documents validates the same session, workspace,
and ready surface snapshot before returning content-free entries relative to
that root. Each fixed file carries its surface revision; nested files also
produce virtual directory ancestors. `find` filters those entries with the
same picomatch basename/path semantics as `grep`, merges them with native fd
results before applying the user limit, and reuses Pi's own formatting and
50KB truncation. `ls` merges immediate disk and virtual children through Pi's
native definition. A covered disk path keeps the fixed snapshot's file or
directory type. Unrelated roots return the disk sentinel; an expired related
snapshot returns unavailable and never substitutes disk output. The snapshot
currently represents dirty text file existence only, so it has no deletion or
rename tombstones.

### Explore (`explore-service.ts`, `explore.ts`, `explore-file-reader.ts`)

The Pi tool sends the question, optional literal `anchors`, and optional roots through the
normal actor-scoped router. `limit` is the excerpt count only. Candidate fetch uses a separate
working budget (and an independent budget for anchors). Candidate mode assigns that budget
breadth-first: one hit per matching file, then another round, until `hitsPerFile` or the budget
is exhausted. A file with hits keeps at least one hit unless the file count itself exceeds the
budget; those omitted files are `filesDropped`, distinct from a hit-level `partial`. That count is
a floor: query terms and search roots match overlapping file sets, so the distinct union cannot be
recovered from per-query counts. Explore carries the largest single-query drop and the body says
"at least", rather than summing and claiming more files than were dropped. The tool schema accepts
blank anchors because the Host filters them and reports them in `details.anchors`; a stricter
schema would reject the whole call. Grep still
depth-first-truncates with `fileScore`. Term groups keep identifier variants, quoted literals,
and anchors together: variants expand matching, co-occurrence across groups raises rank, and
anchors/literals stay the most distinctive seeds without becoming a hard filter.
Search goes through `search-service` with `actor` and `inputContext` so dirty paths are excluded
before the backend counts hits; explore does not match drafts itself. Candidates are ranked from
hit metadata, then materialized on demand with bounded parallelism. Unread files are
`not-requested`, never `empty`. Packing prefers complementary windows across files, then applies
an explore byte budget below the generic 32 KiB truncation, including any `get_output` hint.
Provenance stays in `details`; the model-visible body is `path:start-end`, code, and actionable
gaps. OutputStore keeps the full pack plus unread-candidate refs, and the tool text mentions the
handle only when more content remains. Symbol expansion and optional model enrichment remain
separate planned sources.

### Knowledge context runtime (`../knowledge/context-runtime.ts`)

Fans committed Documents mutations out to the active sessions in that
workspace, keeps agent-authored changes out of Zone 2, correlates LSP
diagnostics only with pending user edits, and projects event-cursor deltas,
blocks, context usage, and prompt-relevant accepted knowledge. The cursor is
also embedded in the durable hidden Pi message so a worker reload can resume.
Successful Git status reads from both workbench APIs pass through Documents
workspace resolution and a per-session deduplicating observer; this reuses the
existing SCM refresh boundary and does not add a second Git poller.
The same Documents post-commit boundary drives an event-based symbol graph:
known languages bind the file's disk text in the Host language view and replace
one file's real `file -> defines -> symbol` graph together with the document
revision the ranges were computed from, unavailable servers preserve the last
graph, and deletes remove it. Ranges derived from an editor buffer are never
stored, so a consumer can check a range against a named text. There is no
startup repository scan.
Model-produced memory block operations return through `memory.blocks.apply` and
are validated and applied in order here; model scheduling remains in pi-host.
Blocks are branch revisions: readers choose the closest ancestor revision for
each label, descendant writes copy on write, and deletes create branch-local
tombstones. UI routes resolve the active Pi branch on the Host rather than
accepting branch identity from the renderer. Keeper coverage records only the
context-producing session entries used by a fully accepted material update,
together with that update's complete branch path and visible block revisions.
Compaction rechecks Pi's actual removal boundary, branch, and block revisions;
any mismatch falls back to Pi for that request. Coverage remains an in-memory
observation, is cleared after compaction, and is rebuilt by the next material
keeper update rather than pretending to survive a Host restart. Compaction
facts currently expose only reliably recorded touched files; diagnostics
without resolution events and recovery checkpoints without a session query
are omitted.
Active child threads are added to every parent Zone 2 turn, while settled
threads use a separate observer cursor and appear only after their event
sequence changes. Nested child sessions resolve their owning Thread from the
durable Run record before listing children.
Run launch includes a tagged snapshot of the parent's then-current blocks. At
settlement the runtime combines explicitly headed report sections, tagged
decision deviations, the child block snapshot, metrics, transcript bounds, and
worktree facts before the registry commits the terminal Run and report together.
An isolated child captures its execution baseline into the Host working-state
store before the Pi session starts. Settlement publishes an immutable native
result revision before the Thread catalog points at it; Git commits and immutable
copy snapshots remain migration/reconstruction sources. Merge reads the selected
native revision, never the live child directory, and applies only baseline-to-result
paths through the recovery store's selected location, SQLite journal, object store,
and workspace lease. Reopen materializes the recorded result at the same path.
When dispatch carries dirty editor input, the runtime first clones the complete
fixed surface snapshot into a persistent WorkingState draft baseline. Its id is
frozen in the Thread launch manifest; queued or restarted Runs overlay the exact
draft bytes into the execution directory and use that effective state as branch
revision zero. Result publication reads the live materialization even when an
older fixed result exists, while merge and migration continue to read the selected
fixed result. Draft-derived paths are checked even when Git ignores them.
Configured `copyIgnored` roots are stored as branch `captureScopes`; narrowed
publication scans only those roots plus known changed paths, so ignored additions,
updates, and deletions enter the native result and survive reclaim/materialize.
Until surface-buffer mutation is connected, integration reports those paths as
`surfaceTargetPaths` and performs no disk write or marker insertion when the
parent disk has diverged from both the draft base and child result.
Idle reclaim runs only after the session closes, a durable result exists, and the
Documents authority confirms that no related controlled writer or user remains.
The session-state sidebar reads/updates blocks through authenticated context
routes. Block writes broadcast only an invalidation identity over SSE, never
the block body. Thread metadata routes use the same UI-auth middleware.
Blocks can be explicitly promoted into workspace or user knowledge suggestions.
The authenticated review API keeps `(scope, id)` identities distinct, uses
opened-value conflict checks for edits, validates same-scope supersedes before
mutation, and broadcasts only invalidation identities over SSE.
Committed `memory-agent` changes to a `decisions` block also feed a mechanical
suggestion runtime: only new structured list entries are proposed, and any
content previously suggested, accepted, or dismissed for that session is not
proposed again. This path never invokes a model or auto-accepts.

Interactive UI inputs carry a content-free `AgentInputContext`. The Documents
authority has already validated and frozen any dirty buffers behind its opaque
reference. `HostServicesBridge` attaches the current context to every Harness
request; Router still derives session/workspace/scope from the broker actor.
`explore.search` and `search.content` remove disk hits for dirty paths and match
the fixed snapshot; the same-name `read` override obtains save-compatible bytes
from `document.readSource`. Expired or unavailable dirty sources never fall back
to disk. Other files retain the existing disk path. Thread dispatch copies the
fixed content into persistent WorkingState before the temporary surface reference
can be released.

Language support status (`LanguageSupportAPI`) is computed when the settings
page asks, not at boot: `searchFilesystemFiles` + `languageIdForPath`, cap
8000 files, `partial` when truncated, 30s per-workspace cache (D-120). A
structure request for an installable-but-missing language records an in-memory
wanted id and still returns `unsupported` (D-121).

`explore.search` asks an optional `structureSource` (see
`lib/structure/DOCUMENTATION.md`) for a revision-bound outline after a file is
materialized. Production tries tree-sitter, then the agent-view LSP outline.
Slice units are containers (function/class/interface/…); a hit on an ordinary
value binding stays inside the enclosing function or class (D-098). Small
containers are emitted in full; large ones keep the signature, the hit block,
omission markers, and a full-unit read entry. An earlier `empty` outline or a
ready outline that misses a hit does not hide a later provider; that later call
is `warmOnly` and will not start a cold language server (D-099). When the source
is missing, cold, unsupported, stale, or failed, explore falls back to the ±3
line window and records that status on the snippet and in `details.structure`.
After materialize, tree-sitter may classify hit lines so declaration names
outrank comments and strings in `windowScore`; unread candidates are not
parsed. It does not call `documentSymbols` itself.

After excerpts are chosen, an optional `fileRelations` callback may attach
outbound graph facts for those paths only (`details.relations` and a compact
English block in the visible/stored body). Confirmed `connections` stay
distinct from unverified `associations`. That annotation does not change
byte/candidate budgets (D-108 / D-112).

Query parse is object-first (D-144): technical literals, quotes, and anchors
are objects; ordinary sentence words are content and do not drive graph
queries. Relation words are a closed table (register / import / define).

A second, independent graph path (`graphRecall`, already-open store only) may
add **path** candidates. Objects from the question run `findLinks` /
`searchDefinitions` before the first pack (D-146, revising D-137). Seeds
discovered after a read still expand. The graph never supplies line numbers
for excerpts. After `readFile`, explore relocates the symbol name or literal
in the current text and only then writes `hits`; if the name is gone, that
window is omitted — it does not become line 1. Graph why/boost bind to the
window that verified, not the file. `connects` and `associates` are different
evidence grades. `details.graph` reports
`not-requested | ready | empty | unavailable | failed`, with unique-file
`definitions` / `connections` / `associates`. An unusable graph leaves the rg
excerpts in place. Graph `filesDropped` is a unique-path floor and is combined
with rg by taking the maximum, not the sum (D-092). Direct clues get priority
reads inside the existing `maxMaterializeReads` budget; a path already in the
rg pool but not yet read can still be materialized. Ranking is by task-match
tier (D-145); path order is only a tie-break. `limit` is a cap. Content-word
rg skipped because a direct clue verified is `details.skippedQueries`
`direct-verified`, distinct from unread `not-requested` (D-147).

Relations are an annotation, so they never make a successful search fail
(D-112). `fileRelations` throwing — a corrupt store, or no store open for that
workspace — sets `details.relations.status` to `partial` / `unavailable` and
prints one line saying the graph could not answer, without leaking the
underlying error. That is a different result from an absent `relations`, which
means no excerpt path had an edge. A graph revision that differs from the
excerpt is reported as `stale` and printed **without** line numbers, since a
moved line number is worse than none. Relation lines are pushed last in the
visible budget — after omitted supports, unread candidates and issues — and are
capped per file, because the annotation must not crowd out the channels that
tell the agent what the result does not contain.

`related.query` answers file-level topology for one path or symbol name:
definitions, imports (resolved and visibly unresolved), reverse importers, and
connection endpoints. It is not `lsp.references`. A missing open store is
`unavailable`; the read path does not open a database. The text caps each
section and a name anchor's walked paths, saying how many it left out, so a hub
file cannot hand the generic tool-result truncation the choice of which section
disappears; `details` still carries every item (D-139).

### LspNavigationServices (`lsp-nav.ts`)

`symbols` / `definition` / `references` / `hover` bind the queried document in
the Host language view through `createLanguageViewBinder`, following the same
fixed source as `read`/`grep` for this turn, and assert that revision on the
request. A `stale` answer re-binds once and retries. Results carry `revision` and
`source`; positions in other files are marked `[unpinned]` because the language
server read those files itself and LSP does not report the version it used.

### LspDiagnosticsService (`diagnostics-service.ts`)

`lsp.diagnostics` binds the path to its current disk text — the text an agent
just wrote, never the editor buffer — and waits for the publication computed from
that exact revision, returning `pending` on timeout. `lsp.diagnosticsSnapshot`
binds without waiting and stays incremental. Both report `revision` and `source`.
Cache lookups use the exact normalized resource identity.
Snapshot calls are incremental per observer and canonical resource by default;
`full: true` is a non-mutating full view. `shell.read` follows the same rule when
neither `offset` nor `length` is supplied, while static `out_*` handles remain
explicit UTF-8 byte slices.

## Wiring (index.ts)

The harness is wired in `packages/web/application-host/index.ts`:

1. `HarnessServiceHost` instantiated after `workspaceContentSearch` and
   `languageSupervisor` are created.
2. `HarnessRouter` created after `recoveryTurnCoordinator`, with broker response,
   Actor resolution, and Documents-backed path authorization callbacks.
3. `registerHarnessServices()` registers all services on the router.
4. `harnessRouter.processEvent(event)` added to the broker subscription,
   aligned with `recoveryTurnCoordinator.processEvent`.
5. Session registration on `session.snapshot` event with bound workspace.
6. Disposal in `stop()`.

## Session Lifecycle

- **Register**: `session.snapshot` event with `workspace.kind === 'workspace'`
  triggers `harnessServiceHost.registerSession()` which creates a
  `ShellSupervisor` for the session.
- **Drop**: `harnessServiceHost.dropSession()` disposes the shell supervisor
  and clears session-scoped output entries, observation cursors, and the
  in-memory keeper coverage evidence.
- **Dispose**: `harnessServiceHost.dispose()` disposes all sessions and
  global services.
