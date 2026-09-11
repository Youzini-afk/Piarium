# Agent Harness — Host Side

The host-side harness provides workspace-scoped services that the pi-host
agent tools call via the `HostServicesBridge`. All services are registered
on the `HarnessRouter` and dispatched from the broker event stream.

## Architecture

```
broker event stream ──→ HarnessRouter.processEvent()
                           ├── shell.exec   → ShellSupervisor (per-session framing over terminal runtime) + verification start/end
                           ├── shell.read   → ShellSupervisor observation (never a completion trigger)
                           ├── shell.write  → ShellSupervisor
                           ├── shell.kill   → ShellSupervisor
                           ├── output.store → OutputStore (global)
                           ├── output.read  → OutputStore
                           ├── search.content → HarnessSearchService (surface overlay or exclusive WorkingState corpus)
                           ├── document.readSource → fixed surface bytes, working-branch bytes, or disk sentinel
                           ├── document.pathOverlay → surface merge paths or exclusive working-branch overlay
                           ├── explore.search → same query engine, algorithm-only facade
                           ├── explore.query.* → Host-owned short-lived query (start/plan/views/select/followup/finish/cancel/release)
                           ├── related.query → already-open KnowledgeStore (file-level topology; not lsp.references)
                           ├── fs.lock      → PathLockService + Documents identity
                           ├── lsp.diagnostics → LspDiagnosticsService
                           ├── lsp.diagnosticsSnapshot → LspDiagnosticsService
                           ├── memory.blocks.* → KnowledgeStore block validator
                           ├── knowledge.suggest → workspace/user .tdb via existing suggestion accept policy
                           ├── zone2.assemble → Knowledge material + ThreadRegistry projection + source-thread <review>
                           └── thread.*     → ThreadRegistry + ThreadRuntime + native working state + verification bind / auto review
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

### Shell discovery (`shell-discovery.ts`)

Host-owned, machine-level discovery. Production `index.ts` calls `discoverShells()`
once when constructing `HarnessServiceHost`. The same Windows program roots used
by Git binary resolution (`ProgramFiles`, `ProgramFiles(x86)`, `LocalAppData`)
plus PATH and an already-resolved `git.exe` home are searched. When both
`Git\bin\bash.exe` and `Git\usr\bin\bash.exe` exist, the Host records the
`usr\bin` executable so the `bin` launcher is not spawned. Missing Git Bash is
reported as such; a present install is not.

`harness.shell` is not a Host-wide freeze. `index.ts` reads the session's Pi
`settings.get` snapshot (user file + trusted project) at session register and
passes that workspace's setting into `registerSession`. A running PTY is not
hot-swapped; a later session or worker generation registers again. Two
workspaces therefore cannot inherit each other's interpreter.
`session-registration.ts` coalesces initialization by broker actor generation.
The Router waits for its generation; close/replacement cancels old initialization,
and late settings cannot restore an obsolete actor. Missing settings produce an
unavailable interpreter rather than silently selecting `auto`.

### ShellSupervisor (`shell-supervisor.ts`)

PTY-based persistent shell per session. Production creates those PTYs through
the terminal runtime (`createTerminalSession`); tests may inject a `ptyProvider`
seam that wraps the same handle contract. There is not a second production
process manager.

- One login shell (git-bash / bash / wsl / powershell) per session
- Commands separated by sentinel markers (`__PIARIUM_SENTINEL_`)
- cwd/env/venv maintained between commands
- A command that exceeds `wait_ms` keeps its current terminal session as the
  public `sh_N` identity allocated by the global terminal runtime; the next
  foreground command starts a new session shell
- User attach and agent `get_output` / `write_to_process` use that same session
- Owner, creation source, cwd, shell/spawn, writer, and retain identity must all
  match before an existing running handle can be reused. HTTP cannot claim a
  programmatic Harness id, and exited ids require explicit close before reuse.
- Closing a terminal tab detaches only; `kill_shell` / force-kill / dispose
  still wait for real process exit before releasing writers (D-204 / D-205 / D-206 / D-209)
- `registerWriter` callback for `mode: 'process'` writer registration
- Interpreter command is the discovered executable path, including spaces
- PowerShell starts interactively under ConPTY with its own readiness/command wrappers.
- Interrupt delivery does not mark a command exited. Shutdown waits for PTY exit
  and writer release; a failed stop remains observable and retryable. ServiceHost
  retains retiring supervisors after a session drop, and thread close awaits them.
- Background completion is emitted once by PTY exit even when no caller reads
  output. A failed writer release keeps directory protection and is retried by
  disposal instead of being treated as a completed cleanup.

### OutputStore (`output-store.ts`)

Stores large tool outputs (default 256 MiB per session) with handle-based
retrieval. Handles are `out_XXX` format.
These are authenticated session-local ephemeral references, not durable files or knowledge records.

### Shell output organization (`output-organize/`)

Default `bash` / incremental `get_output` display for vitest, tsc, eslint, and
git (D-197). Full UTF-8 bytes stay in the supervisor buffer or OutputStore.
Explicit `offset`/`length` remains raw. The generic `tool_result` head/tail cut
does not run on `bash` or `get_output`.

### PathLockService (`path-lock.ts`)

The Host first resolves every input through Documents identity, deduplicates
aliases, and acquires the complete path batch in canonical order. The returned
opaque lease IDs are owner-bound. This coordinates Harness-managed writes in
one Application Host; it does not claim to lock terminals, Git, external
processes, or a second Host.

### ThreadRegistry / ThreadRuntime

The registry persists one versioned atomic catalog per workspace. `Thread` is
durable work; `ThreadRun` is one execution attempt, and
`ThreadLaunchManifest` freezes model-adjacent launch inputs. Isolated `dispatch`
creates the Thread, then captures the disk baseline and WorkingBranch before it
returns — including queued threads. Capture failure or cancellation deletes the
Thread. `dispatch` then commits a `starting` Run and returns immediately. The
runtime later opens a real persisted Pi child session with the role's
active-tool allowlist, and projects broker events into
progress, attention, report, durable transcript, integration, and verification
state. A child session whose frozen allowlist includes nest tools can dispatch
again: the Host resolves `parent.kind: "thread"`, narrows scope/permissions, and
copies the parent branch view (or materialized directory) as the grandchild
baseline. Nested merge writes the grandchild result onto that parent authority
before the parent result reaches the workspace. Sibling threads do not talk;
the root session list and Zone 2 projection stay on direct children. After a successful publish, only same-Run observations whose start/end
identity matches the fixed result are bound to that `resultRevision`. A hidden
review thread is then created with `startRun` + `spawn` (not `autoRun` alone).
Draft merge records that disk commands cannot verify unsaved buffers.

One unexpected worker exit is resumed in the same session/worktree as a new
Run; a second consecutive crash becomes `stalled` instead of entering a crash
loop. Interactive child prompts, event silence, and six identical tool
signatures project to `permission`/`user`, `stalled`, and `looping`. The Web UI
reads the same registry through `/api/harness/threads` and SSE; the Pi Fleet
registry exposes it through the `piarium-harness` provider.

### VerificationCoordinator (`verification-coordinator.ts`)

Session-scoped command observations bind the authority instance, worker
generation, Run, and binding generation at start and recheck them at completion.
Production `shell.exec` records both boundaries; PTY exit completes background
commands independently of `shell.read`. Git inputs use a base/HEAD seed plus the
states of changed and explicitly captured paths, avoiding a per-command full-tree
scan; non-Git inputs remain `uncertain`. Publication consumes eligible observations
once. A fully applied parent merge opens a persisted window keyed by operation,
result revision, and exact parent session; draft-unsaved and incomplete merge
states do not. Review records additionally bind review thread and review Run.

### Review sensor (`review-sensor.ts`)

`onPublishedResult` opens a hidden review thread for one published revision.
`createAndStart` must `startRun` and `spawn`. There is no parent
journaled-change review entry point; fixed result publication is the only
automatic trigger.

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
An isolated Thread Run bound to a WorkingBranch never returns the disk sentinel
for these tools: `read` / `grep` / `find` / `ls` / `explore` consume
`effectiveState = base ∪ delta` with tombstones hidden, and provenance names
the branch, revision, and origin. Missing branch content stays unavailable.

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
rename tombstones. A working-branch overlay is exclusive: find/ls do not merge
native disk, and tombstones hide files plus virtual ancestors.

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
Host session binding (`sessionId → owning workspace / thread / run`), not from
the execution workspace Documents assigns to scratch or materialized cwd.
Run launch includes a tagged snapshot of the parent's then-current blocks. At
settlement the runtime combines explicitly headed report sections, tagged
decision deviations, the child block snapshot, metrics, transcript bounds, and
worktree facts before the registry commits the terminal Run and report together.
An isolated child fixes its execution baseline when dispatch creates the
WorkingBranch, not when the Pi session later starts. Git inventories HEAD plus
staged, unstaged, tracked, deleted, and non-ignored untracked paths and stores
workdir bytes; non-Git and unborn repositories do one cancellable directory
scan. Spawn recaptures only when no `workBranchId` exists. The child stays on a
virtual scratch until a path-binding tool runs. Same-name `edit` / `write` / `apply_patch` call `document.branchWrite`,
which commits text into the unpublished WorkingState delta with `writeRevision` CAS
and never writes the parent directory. Directory, binary, symlink, and unsupported
states are rejected. The first `bash` or LSP navigation tool asks
`workingBranch.ensureMaterialized`: the Host freezes the current revision, waits for
in-flight virtual writes, materializes into a staging directory, then atomically
replaces the scratch. A Git parent then receives an isolated context via
`git worktree add --detach` (this writes `.git/worktrees` and does not create a
user-visible branch) or `git init` when HEAD is unborn or the directory would
otherwise inherit another worktree. Failure deletes staging and keeps the virtual branch readable.
Settlement publishes `publishHeadResult` while virtual, or inspects the directory and
publishes that fold after the switch. Git commits and immutable copy snapshots remain
migration/reconstruction sources. Merge reads the selected native revision, never the
live child directory, and applies only baseline-to-result paths through the recovery
store's selected location, SQLite journal, object store, and workspace lease. Reopen
of a materialized result rebuilds that directory at the same path; a still-virtual
branch reopens on scratch and reads the branch view.
Nested children reuse the same registry, Run, review, archive, and lost-resume
path. Host restart resumes lost Runs for the snapshot session's owning Thread
parent from the persisted session binding, so an execution-workspace snapshot
cannot look up the wrong catalog.
When dispatch carries dirty editor input, the runtime first clones the complete
fixed surface snapshot into a persistent WorkingState draft baseline. Its id is
frozen in the Thread launch manifest; queued or restarted Runs overlay the exact
draft bytes into the branch base (and into a materialized directory only after a
path-binding tool switches the Run) and use that effective state as branch
revision zero. Virtual publication reads the live branch head; materialized
publication reads the directory. Merge and migration continue to read the selected
fixed result. Draft-derived paths are checked even when Git ignores them.
Configured `copyIgnored` roots are stored as branch `captureScopes`; narrowed
publication scans only those roots plus known changed paths, so ignored additions,
updates, and deletions enter the native result and survive reclaim/materialize.
Draft targets use the originating surface owner and its live Documents registration,
document instance, content hash, revision and format. Agent calls resolve that owner
from their fixed inputContext. Documents directs capture/apply/undo to the owning
Registry; events carry metadata and authenticated requests carry body/receipts.
The durable Integration records both disk and buffer targets before dispatch and
does not complete before confirmation. Conditional compensation/undo preserves
subsequent edits; reconnect or restart cannot reinterpret a surface target as disk.
`merge-ready` comes from a bound preview; resolution submissions must consume that
binding. Preview reads and identical projections do not create event feedback loops.
Idle reclaim runs only after the session closes, a durable result exists, and the
Documents authority confirms that no related controlled writer or user remains.
User archive keeps the report, transcript reference, native results, and original
Pi session file; it does not use the session-delete path that clears `report`.
Restore rematerializes the published result at the same path. If that path is
occupied by other content, Host reports `path-occupied` and does not delete it.
Occupancy distinguishes materialized logical size, allocated blocks when the
platform reports them, and shared content-addressed objects. Reclaim stays
blocked for `keep_worktree`, unfinished Integration, active writers, editor
surfaces, background commands, or unverified/uncollected content. Budget uses
only the user-configured `harness.worktree.budget`, across all parent sessions in
the workspace, including known costs of first materialization and restore. Archive
waits for preparation/setup and real session shutdown. Restore binds the original
session to a new Run; a failed restore stays archived and cannot open an occupied
path. The Documents reclaim guard remains held through deletion. Thread panel routes
`GET /space` and archive/restore/reclaim share this Host projection.
The session-state sidebar reads/updates blocks through authenticated context
routes. Block writes broadcast only an invalidation identity over SSE, never
the block body. Thread metadata routes use the same UI-auth middleware.
Blocks can be explicitly promoted into workspace or user knowledge suggestions.
The authenticated review API keeps `(scope, id)` identities distinct, uses the
complete opened content/trigger/status/invalidAt revision for every mutation, validates same-scope supersedes before
mutation, and broadcasts only invalidation identities over SSE.
Settings catalog routes list/edit/retire the same workspace and user `.tdb`
rows after Documents workspace resolution. Delete sets `invalidAt` on one id;
it does not cascade to other scopes or supersede neighbors. Derived vectors
are notified through the existing knowledge-change hook.
Committed `memory-agent` changes to a `decisions` block also feed a mechanical
suggestion runtime: only new structured list entries are proposed, and any
content previously suggested, accepted, or dismissed for that session is not
proposed again. This path never invokes a model or auto-accepts.
When `models.suggestions` is configured, pi-host drafts from the current user
message and Host `knowledge.suggest` stores the proposal in the authenticated
actor's workspace with source `user-message`; scope and source kind are not
worker inputs. Normalized-content lookup and insert share the store write queue
and cover dismissed/retired history. Catalog mutations send the complete opened
content/trigger/status/invalidAt revision; workspace/scope changes retire the UI
request generation so late responses cannot replace the active catalog.
User-mark, memory-decision, and model proposal creation all resolve the session's
effective auto-accept setting; an unreadable setting keeps the new row suggested.
Unconfigured sessions do not borrow the main model. Suggested, dismissed, and
superseded identities do not enter public recall.

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
outrank comments and strings in unit-local ranking; unread candidates are not
parsed. It does not call `documentSymbols` itself. `windowScore` is gone.

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
window that verified, not the file. Evidence units carry `arrival` / `assessment`
/ `purpose` instead of a single grade; `connects` and `associates` stay different
graph arrivals. `details.graph` reports
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
  resolves that workspace's `harness.shell` from Pi settings, then
  `harnessServiceHost.registerSession()` creates a `ShellSupervisor` from the
  Host's discovered interpreters. Unreadable settings and an invalid
  `harness.shell` value are reported as unavailable.
- **Drop**: `harnessServiceHost.dropSession()` retires the shell supervisor
  and clears session-scoped output entries, observation cursors, and the
  in-memory keeper coverage evidence. Its commands remain visible to reclamation
  until `closeSessionShell()` confirms shutdown and writer release.
- **Dispose**: `harnessServiceHost.dispose()` disposes all sessions and
  global services.
