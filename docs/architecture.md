# Piarium architecture

Status: implemented through Phase 1

Last updated: 2026-08-02

## 1. Context

Piarium is a graphical workspace for Pi. It borrows interaction ideas and selected presentation
components from OpenChamber, but it does not emulate the OpenCode SDK. Pi sessions, models,
packages, tools, commands, and extension UI are represented as Pi-native domain concepts.

The first release targets a local Windows desktop. The process and protocol boundaries must also
support a future remote host, browser client, and companion mobile client without moving extension
execution into an untrusted renderer.

## 2. Goals

1. Discover and run a bundled, system-installed, or developer Pi runtime.
2. Provide first-class session, model, provider, settings, and package management.
3. Render streaming messages, tools, commands, queues, compaction, retries, and extension UI.
4. Make subagent work visible and controllable from its parent session.
5. Integrate Magic Context, MCP, and Web Access without forking their core algorithms.
6. Associate each user turn with a recoverable conversation and workspace checkpoint.
7. Produce a signed-ready Windows installer with deterministic runtime diagnostics.

## 3. Non-goals

- Reimplementing Pi's model/provider stack.
- Parsing terminal escape sequences as an application protocol.
- Running third-party extensions in Electron's renderer.
- Treating a tool allowlist or plan mode as an operating-system sandbox.
- Editing Pi session JSONL for ordinary navigation, rename, archive, or branching.
- Bundling arbitrary local extension working trees into a release without an explicit manifest.

## 4. Process model

```text
React renderer
    |
    | narrow context-isolated preload API
    v
Electron main / runtime broker
    |
    | Piarium protocol v1 over authenticated local IPC
    v
Pi session worker (Node >=22.19)
    |- Pi SDK session runtime
    |- Pi resource and package loader
    |- extension UI bridge
    |- extension-specific structured adapters
    `- recovery transaction coordinator
```

### 4.1 Renderer

The renderer contains presentation and local view state only. It never imports Pi packages, reads
credential files, spawns commands, or loads extension code. Every native operation crosses a
typed preload capability.

### 4.2 Electron main and broker

The broker owns windows, lifecycle, native dialogs, notifications, updates, and workers. It
enforces one writer lease per Pi session file and one recovery lease per workspace. A worker crash
cannot crash the renderer, and a renderer reload does not terminate an active task.

### 4.3 Session workers

Each hot top-level session runs in its own Node worker process and embeds the public Pi SDK. This
matches the single-active-session assumptions made by several Pi extensions while allowing
multiple background sessions. Idle sessions are persisted by Pi and need no live worker.

The broker maintains a bounded hot-worker pool. Eviction is graceful: stop accepting requests,
wait for idle or require explicit abort, dispose the SDK runtime, flush settings, and then stop the
process. Subagents remain owned by their supervising extension and are observed through structured
events and lifecycle artifacts.

### 4.4 Why direct SDK workers

Pi's JSON RPC mode is a useful compatibility and diagnostic backend, but direct SDK workers expose
the complete settings, package, model, extension event-bus, and custom UI surfaces needed by the
product. Pi's newer transport-neutral protocol is intentionally tracked, but its experimental
server backend and current command set are not yet sufficient as the sole product foundation.

## 5. Versioned host protocol

`@piarium/protocol` defines newline-delimited JSON envelopes:

- request: `{v, kind:"request", id, method, params}`
- response: `{v, kind:"response", id, ok, result|error}`
- event: `{v, kind:"event", seq, event, data}`

Unknown methods and events are preserved as protocol errors, not silently ignored. Request IDs are
unique within a connection. Event sequence numbers are monotonic within a worker lifetime. Large
binary/file payloads use a separate bounded stream or file grant rather than JSONL.

An initial handshake negotiates protocol version and capabilities. UI disables unavailable
actions instead of guessing from runtime versions.

## 6. Data ownership

| Data | Authority | Piarium behavior |
| --- | --- | --- |
| Pi session tree/messages | Pi SessionManager JSONL | Read/navigate via SDK; destructive edits only in recovery transactions |
| Models/auth | Pi ModelRuntime/AuthStorage | Never mirror secrets into renderer storage |
| Pi settings/packages | Pi SettingsManager/PackageManager | Typed operations with source/provenance shown |
| App metadata | Piarium SQLite | Archive, pin, tags, recent projects, view preferences |
| Workspace checkpoints | Recovery store + shadow Git | Per real workspace and Pi session; separate from project `.git` |
| Magic Context | Its shared SQLite/config | Read through a maintained adapter; do not duplicate memory state |
| Subagent lifecycle | Extension event bus + artifacts | Normalize into parent/child task projections |
| MCP | Adapter config/status events | Preserve source precedence and credential store |
| Web Access | Extension config/custom entries | Provider settings and safe workflow defaults |

## 7. Extension architecture

### 7.1 Generic bridge

The host implements Pi's standard extension UI primitives: select, confirm, input, editor,
notifications, status, text widgets, title, and editor text. Requests with responses are abortable
and tied to the originating worker. TUI-only custom components receive a clear unsupported fallback.

Commands, custom session entries, tool details, and extension errors have generic renderers so an
unknown package remains usable before a first-class adapter exists.

### 7.2 First-class adapters

- **pi-subagents:** task tree and controls from its event bus; lifecycle artifacts for restart and
  cross-process reconciliation.
- **Magic Context:** configuration, memories, compartments, historian/dreamer/sidekick status, and
  diagnostics from its native Pi plugin and shared database.
- **pi-mcp-adapter:** server status, tools/resources/prompts, OAuth, and config provenance.
- **pi-web-access:** provider routing, safe fetch settings, custom result entries, activity, and
  optional Curator flow.

PiDeck-installed local extensions are not product dependencies. A conforming generic UI bridge may
still allow them to work when a user installs them independently.

## 8. Recovery model

Every user turn may own a checkpoint pair:

```text
turn id
  |- user entry id / branch parent
  |- prompt metadata (not duplicated unless required for recovery)
  |- before workspace commit
  |- after workspace commit
  |- resulting assistant leaf id
  `- transaction and retention metadata
```

The file engine uses a shadow Git repository and never mutates the project's `.git`. The session
engine uses official tree navigation/fork APIs for non-destructive operations. Deleting future
conversation entries is an explicit advanced action performed under a session writer lease with a
backup, compare-before-swap check, atomic replacement, reload verification, and rollback.

User-facing actions:

- restore conversation only;
- restore files only;
- restore both;
- fork from a turn;
- undo/redo;
- create a named checkpoint;
- preview affected files before applying.

A restore first captures a safety checkpoint. Dirty state, ignored files, symlink boundaries,
untracked files, and failed rollback are visible outcomes. `.env` and common secret files are
excluded by default, with project-specific review before enabling broad capture.

## 9. Trust and security

Project-local Pi resources, MCP commands, and credential command sources can execute code. Project
trust is therefore a host gate, not a decorative preference. The UI shows source, command, cwd,
environment key names, and capability changes before activation.

See [security.md](security.md) for the threat model and release gates.

## 10. Runtime selection

Development and diagnostics support:

1. bundled and pinned Pi runtime;
2. system-installed Pi runtime;
3. explicit developer source checkout;
4. explicit custom Node/module path.

The selected source, Pi version, Node version, package root, agent directory, and Git Bash path are
always visible. A source mismatch is a diagnostic state, never silently repaired.

## 11. Failure semantics

- Protocol parse errors close only the offending connection after a bounded diagnostic.
- Worker crashes retain the session and expose restart/recovery actions.
- Extension failures are attributed to package/source and do not become anonymous chat errors.
- Writes use explicit leases, temporary files, fsync where meaningful, atomic same-volume replace,
  and post-write verification.
- Shutdown is asynchronous and bounded; Pi runtime disposal and active recovery transactions are
  awaited before force termination.

## 12. UI direction

OpenChamber informs density, navigation, split views, composer behavior, terminal, files, and Git
presentation. Piarium owns its domain model and data flow. Selected MIT components may be migrated
with attribution after removing OpenCode assumptions; the OpenChamber sync/session/provider stack
is not copied.
