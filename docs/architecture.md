# Piarium architecture

Status: Pi host, plugin recovery bridge, runtime broker, and Electron worker lifecycle implemented; product engine migration in progress

Last updated: 2026-08-03

## 1. Context

Piarium is a graphical workspace for Pi built from the maintainer's OpenChamber fork. The fork's
product shell and custom capabilities are retained while its OpenCode engine, contracts, and
terminology are directly replaced with Pi-native domain types and services. The source fork is a
read-only input; all edits and history live in the Piarium repository.

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
OpenChamber-derived React renderer
    |
    | authenticated Piarium v1 WebSocket/postMessage surface protocol
    v
OpenChamber-derived Electron/web shell + Piarium broker
    |
    | Piarium protocol v1 over a private child-process IPC pipe
    v
Pi session worker (Node >=22.19)
    |- Pi SDK session runtime
    |- Pi resource and package loader
    |- extension UI bridge
    |- extension-specific structured adapters
    `- recovery capability adapter
```

### 4.1 Renderer

The renderer contains presentation and local view state only. It never imports Pi packages, reads
credential files, spawns commands, or loads extension code. Every native operation crosses a
typed preload or Pi runtime capability. OpenCode SDK types are removed from feature code rather
than preserved behind a compatibility facade.

Composer drafts are keyed by Pi runtime and session. Workspace surfaces may seed visible text and
hidden instructions in that draft; if there is no active session they create one in the relevant
cwd first. A Pi session's snapshot/catalog cwd is authoritative, including for worktrees, so Git,
terminal, and pull-request views do not maintain a second session-to-directory or
session-to-worktree map.

### 4.2 Electron/web shell and broker

The retained shell owns windows, web/mobile/remote bootstrap, packaging, and native dialogs. The
Piarium broker owns Pi workers and maps one live worker to each opened top-level session, with a
separate catalog worker for discovery. A worker crash
cannot crash the renderer, and a renderer reload does not terminate an active task.

`@piarium/runtime-broker` is now the single process client for the worker boundary. It validates protocol
frames and event sequence numbers, correlates concurrent requests, denies project trust by default,
owns catalog/per-session workers, and performs graceful then process-tree shutdown. Electron starts
and handshakes the catalog worker whenever the local runtime is available, verifies that packaged
worker files are unpacked, and awaits broker disposal during ordinary quit, update, relaunch, hard
signals, and startup failure.

`@piarium/runtime-client` is the browser-safe surface client. The Web server exposes the same
Pi-native method names through `/api/piarium/runtime/ws`; it validates every untrusted parameter,
removes worker-only shutdown/trust methods, authenticates UI cookies/client or short-lived URL
tokens, checks Origin, and forwards worker events with explicit
`{workerId, role, sessionId}` routing. The private relay explicitly allowlists this socket and
continues to carry it through the existing encrypted tunnel without injecting credentials.
Piarium does not impose renderer payload, pending-request, or buffered-output ceilings by default;
deployments may opt into them with `PIARIUM_RUNTIME_MAX_PAYLOAD_BYTES`,
`PIARIUM_RUNTIME_MAX_PENDING_REQUESTS`, and `PIARIUM_RUNTIME_MAX_BUFFERED_BYTES`.

Desktop first-launch and local recovery use this same authenticated connection and require a
successful Pi host handshake. The surface shows the negotiated Pi, host, Node, and runtime-source
versions; it does not probe OpenCode health, ask for an OpenCode binary, or run an installation
script. Remote host selection remains a separate retained transport choice.

Protocol v1 does not forward Pi SDK objects verbatim. The host projects the append-only session
tree, messages, tool calls/results, streaming updates, compaction, retry state, model metadata, and
provider authentication interactions into Piarium-owned discriminated DTOs. Provider response IDs,
thinking/text signatures, callback functions, `AbortSignal`, and credential objects remain inside
the worker. Arbitrary extension/tool details cross only through the JSON-safe protocol projector.

Provider configuration is also Pi-native. The user layer is Pi's canonical
`<agentDir>/models.json`; the trusted project layer is `<workspace>/.pi/models.json`; an operator may
add a `PIARIUM_MODELS_CONFIG` layer. Project and operator definitions are applied through
`ModelRuntime.registerProvider()` in `user → project → operator` order, without translating through
an OpenCode schema. UI-added API keys use Pi's locked `AuthStorage` flow and are never returned with
provider metadata. Existing literal/env/command keys in native configuration layers remain intact
and usable but are redacted from the surface protocol.

Remote model discovery is a separate privileged operation. It uses the provider's host-owned auth
when present and also supports anonymous endpoints. HTTP, HTTPS, localhost, LAN, and URL basic
authentication remain available for explicitly configured providers. Authentication headers are
removed on cross-origin redirects. Discovery has no product-imposed redirect, duration, response,
or model-count ceiling. Deployments may opt into budgets with
`PIARIUM_PROVIDER_DISCOVERY_MAX_REDIRECTS`, `PIARIUM_PROVIDER_DISCOVERY_TIMEOUT_MS`, and
`PIARIUM_PROVIDER_DISCOVERY_MAX_BYTES`; `0` keeps a budget disabled. Exact redirect loops are still
rejected. Google keys are sent in `x-goog-api-key`, not in the URL.

The settings editor may send a credential-free draft provider definition for discovery without
writing it to `models.json`. If the draft includes a one-shot API key, the key travels only through
the typed auth-prompt response and is neither embedded in the discovery request nor persisted.

Concurrent provider-config writes use an atomic owner lock without a product-imposed wait cutoff.
Dead owners are reclaimed by process identity; deployments may opt into a wait budget with
`PIARIUM_PROVIDER_CONFIG_LOCK_TIMEOUT_MS`, while `0` keeps the budget disabled.

### 4.3 Session workers

Each hot top-level session runs in its own Node worker process and embeds the public Pi SDK. This
matches the single-active-session assumptions made by several Pi extensions while allowing
multiple background sessions. Idle sessions are persisted by Pi and need no live worker.

Opened sessions stay live until explicitly closed or the application exits. An optional hot-worker
budget and idle eviction remain a later deployment optimization; eviction must be graceful: stop
accepting requests, wait for idle or require explicit abort, dispose the SDK runtime, flush
settings, and then stop the process. Subagents remain owned by their supervising extension and are
observed through structured events and lifecycle artifacts.

### 4.4 Why direct SDK workers

Pi's JSON RPC mode is a useful compatibility and diagnostic backend, but direct SDK workers expose
the complete settings, package, model, extension event-bus, and custom UI surfaces needed by the
product. Pi's newer transport-neutral protocol is intentionally tracked, but its experimental
server backend and current command set are not yet sufficient as the sole product foundation.

## 5. Versioned host protocol

`@piarium/protocol` defines the private worker JSONL envelopes and the message-oriented surface
envelopes:

- request: `{v, kind:"request", id, method, params}`
- response: `{v, kind:"response", id, ok, result|error}`
- worker event: `{v, kind:"event", seq, event, data}`
- surface event: `{v, kind:"event", seq, source:{workerId,role,sessionId?}, event, data}`

Unknown methods and malformed routed events are protocol errors, not silently ignored. Request IDs
are unique within a connection. Event sequence numbers are monotonic within each worker lifetime
and clients track them independently by worker ID. Large binary/file payloads use a separate
bounded stream or file grant rather than JSONL.

`session.entries` returns the complete requested scope as `{sessionId, scope, leafId, entries}` with
no implicit pagination or truncation. The leaf and every entry's
`id/parentId` preserve Pi's branch graph; `scope:"branch"` is the active path and `scope:"all"`
contains the complete append-only tree. Streaming `agent.event` messages contain one canonical
message plus a compact typed delta instead of duplicating Pi's mutable `partial` object.

Protocol v1 also exposes native `session.header`, `session.summary`, `session.tree`,
`session.entry`, `session.stats`, `session.rename`, `session.archive`, `session.unarchive`,
`session.delete`, and `thinking.select` operations. It adds surface-owned project trust responses,
the full extension UI request/state bridge, locked global/project JSON changes for arbitrary
extension settings, path-contained extension-owned JSON documents, and conflict-checked JSONC
documents rooted in the agent directory, trusted project, or standard user configuration directory.
Runtime snapshots carry Pi's actual streaming,
compaction, retry, steering, follow-up, queue, model, and thinking state. Archive state is broker-owned
atomic Piarium metadata; renames remain native append-only Pi session-info entries.

An initial handshake requires the single Piarium v1 contract and reports capabilities. During
pre-release development every product surface changes in lockstep; no historical Piarium ABI is
accepted. UI disables unavailable actions instead of guessing from runtime versions.

## 6. Data ownership

| Data | Authority | Piarium behavior |
| --- | --- | --- |
| Pi session tree/messages | Pi SessionManager JSONL | Read and navigate through the SDK; conversation-only rollback stays Pi-native |
| Models/auth | Pi ModelRuntime/AuthStorage + layered native `models.json` | Never mirror secrets into renderer storage; preserve source provenance |
| Pi settings/packages | Pi SettingsManager/PackageManager | Scope-aware JSON settings, extension-owned config documents, and native package updates with source/provenance shown |
| App metadata | Atomic Piarium JSON | Archive state now; recovery preference, pin, tags, and view preferences are application-owned additions |
| Workspace checkpoints | `pi-workspace-history` | Access through tree hooks, commands, and recovery bridge v1; never mirror private snapshot state |
| Prompt repair | `pi-wtf` | Invoke the plugin's registered command capabilities and preserve its configuration |
| Magic Context | Its shared SQLite/config | Read through a maintained adapter; do not duplicate memory state |
| Subagent lifecycle | Extension event bus + artifacts | Normalize into parent/child task projections |
| MCP | `pi-mcp-adapter` config/status events | Project its public `status/v1` snapshot, invoke its commands, and edit each native source without reproducing merge or credential logic |
| Web Access | `pi-web-access` config/custom entries | Edit its native `web-search.json`; tools, activity widgets, and custom result entries continue through the generic extension bridge |

## 7. Extension architecture

### 7.1 Generic bridge

The host implements Pi's standard extension UI primitives: select, confirm, input, editor,
notifications, status, text widgets, title, and editor text. Requests with responses are abortable
and tied to the originating worker. TUI-only custom components are rendered by their own extension
into a surface-owned read-only panel, so Piarium does not copy the component's private view model.

Commands, custom session entries, tool details, and extension errors have generic renderers so an
unknown package remains usable before a first-class adapter exists.

The Plugins settings page is a direct client of Pi's typed `package.list/install/update/remove`
operations. It does not maintain an OpenCode registry, copy extension files, or restrict package
sources: recommended cards are only shortcuts, while any source accepted by Pi's `PackageManager`
can be passed through unchanged. Package mutations target the current live session when one exists,
so Pi reloads the real extension instance; otherwise they use the current workspace catalog context.

### 7.2 First-class adapters

- **pi-subagents:** task tree and controls from its event bus; lifecycle artifacts for restart and
  cross-process reconciliation. The first native Fleet surface consumes its public in-process RPC
  `fleetStatus/v1` projection; private run identifiers and artifact paths remain host-side, while
  the plugin's own inspector/stop/doctor commands retain their validation and selectors.
- **Magic Context:** plugin-owned user/project JSONC configuration, registered `ctx-*` session
  operations, native Pi status component, and persisted public custom entries. Memory,
  compartment, historian/dreamer/sidekick, and diagnostic views read only future public
  plugin/database contracts rather than copied or privately inspected state.
- **pi-mcp-adapter:** protocol v1 carries the adapter's public `pi-mcp-adapter/status/v1`
  snapshot. Settings, the desktop header, and mobile surfaces invoke the adapter's public commands,
  manage the normal Pi package, and edit all six adapter-owned JSON/JSONC sources in their documented
  precedence order. Piarium has no parallel MCP store, generated OpenCode configuration draft, or
  OAuth callback route; the adapter owns merging, host imports, transports, OAuth/keyring data, and
  connection state.
- **pi-web-access:** Piarium edits the extension's agent-level `web-search.json` and discovers its
  current registered commands in the active session. The GUI can open the native Curator, invoke
  Gemini Web account diagnostics, and browse the plugin's stored results, while provider routing,
  credentials, SSRF policy, health/activity state, search/fetch tools, dialogs, follow-up messages,
  persisted results, and the optional Curator server remain extension-owned.

PiDeck-installed local extensions are not product dependencies. Local working trees and other Pi
package sources remain installable directly, and the generic UI bridge allows unknown packages to
work without a Piarium-specific adapter.

The page boundaries, native authorities, risk treatment, and adapter acceptance criteria are
defined in [plugin-gui-design.md](plugin-gui-design.md). The imported Magic Context, OpenAgent, and
Agent Orchestration screens have been retired; their capability disposition remains documented
there rather than leaving an OpenCode compatibility surface in production code.

## 8. Recovery model

Piarium owns one recovery interaction model, not one recovery storage engine. Conversation-only
rollback branches Pi's append-only session tree and restores editable user text/images without
touching files. Combined rollback calls the same Pi tree navigation API and lets
`pi-workspace-history` restore files through its standard `session_before_tree` hook. Undo, redo,
and checkpoints call that plugin's registered commands. Prompt repair calls `pi-wtf`.

Recovery providers advertise explicit modes and actions. Current command/tree integration works
without a plugin fork; recovery bridge v1 lets future versions add structured results, files-only
restore, preview, and richer history. Piarium does not parse `turn-snapshots.json`, copy shadow Git,
or silently substitute an internal file engine when a provider lacks a capability.

The normal per-message action follows the user's conversation-only, conversation+files, or
always-ask preference. Detailed provider status, checkpoints, history, and diagnostics live in the
right sidebar/settings. Provider notifications and dirty-workspace safeguards remain authoritative.

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

The production diagnostics surface is Pi-native and shared by About, the desktop Help menu, the
keyboard shortcut, and `window.__piariumDebug`. It combines the negotiated host handshake, the
server `/health` snapshot, package/resource/agent-provider diagnostics, fleet and recovery status,
and bounded project/session metadata. It never probes OpenCode endpoints or serializes provider
settings, package source URLs, message content, fleet goals, or unknown health fields.

## 11. Failure semantics

- Protocol parse errors close only the offending connection after a bounded diagnostic.
- Worker crashes retain the session and expose restart/recovery actions.
- Extension failures are attributed to package/source and do not become anonymous chat errors.
- Writes use explicit leases, temporary files, fsync where meaningful, atomic same-volume replace,
  and post-write verification.
- Shutdown is asynchronous and bounded; Pi runtime disposal and active delegated recovery calls are
  awaited before force termination.

## 12. OpenChamber product-base migration

The maintainer's OpenChamber fork is copied into Piarium as the authoritative application base.
Its UI, session UX, desktop/web/mobile/VS Code surfaces, custom providers, remote/cloud access,
workspace operations, terminal, Git, settings, archive restore, and security customizations are
preserved unless a reviewed Pi-native implementation is demonstrably equivalent.

This is a direct migration, not a permanent compatibility stack:

1. copy only from the reviewed clean fork commit without modifying the source worktree;
2. replace OpenCode SDK domain types with Piarium-owned Pi session/message/event/provider types;
3. rewrite the sync, lifecycle, provider, command, permission, and question paths against Pi;
4. delete the OpenCode child process, proxy, watcher, downloaded CLI, configuration, and dead code;
5. retain platform services and fork features, adapting each to the new Pi-native data flow;
6. connect Piarium recovery at OpenChamber's unified per-message revert action and expose detailed
   history in the right sidebar/settings.

The exact source and non-regression contract are recorded in
[openchamber-pi-migration.md](openchamber-pi-migration.md). Copied MIT material retains its license
notice and will be rebranded before public release.
