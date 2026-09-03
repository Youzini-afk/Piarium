# Piarium architecture

Status: Pi-native engine, composable workbench, and unified editor delivered; release hardening continues

Last updated: 2026-09-03

## 1. Context

Piarium is a graphical workspace for Pi built from the maintainer's OpenChamber fork. The fork's
product shell and custom capabilities are retained while its OpenCode engine, contracts, and
terminology are directly replaced with Pi-native domain types and services. The source fork is a
read-only input; all edits and history live in the Piarium repository.

Desktop was the first surface to ship, and Windows, Linux, and macOS packages are published from
matching runners. The same process and protocol boundaries carry the remote host, browser client, and
companion mobile client, so no surface moves extension execution into an untrusted renderer.

## 2. Goals

1. Discover and run a user-global, standalone, custom, or developer Pi runtime.
   Desktop loads the selected Pi package root through a Host bootstrap resolver
   instead of a permanently bundled SDK. Cloud images still ship a self-contained
   Pi runtime.
2. Provide first-class session, model, provider, settings, and package management.
3. Render streaming messages, tools, commands, queues, compaction, retries, and extension UI.
4. Make subagent work visible and controllable from its parent session.
5. Integrate Magic Context, MCP, and Web Access without forking their core algorithms.
6. Associate each user turn with a recoverable conversation and workspace checkpoint.
7. Produce signed-ready desktop installers with deterministic runtime diagnostics.

## 3. Non-goals

- Reimplementing Pi's model/provider stack.
- Parsing terminal escape sequences as an application protocol.
- Running third-party Pi extensions in Electron's renderer or treating arbitrary UI modules as Pi
  packages.
- Treating a tool allowlist or plan mode as an operating-system sandbox.
- Editing Pi session JSONL for ordinary navigation, rename, archive, or branching.
- Bundling arbitrary local extension working trees into a release without an explicit manifest.

## 4. Process model

```text
React renderer: Workbench Profile selects a shell extension
    |- shared kernel: Document Registry, Editor Workbench, Pi session state
    |
    | authenticated HTTP + SSE to the application host (documents, search,
    | language, tasks, debug, tests)
    | authenticated Piarium v1 WebSocket/postMessage surface protocol (Pi runtime)
    v
Application host: web/Electron shell + Piarium broker + extension host
    |- LSP, DAP, test, and task supervisors
    |- revisioned document authority and recovery journals
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

Electron does not add a parallel backend. It hosts the Web application host in-process, so the
desktop renderer reaches the same HTTP/SSE/WebSocket surfaces over loopback rather than through a
separate Electron IPC protocol. Only genuinely native capability — windows, menus, dialogs,
notifications, updater — crosses the Electron preload boundary.

### 4.1 Renderer

The renderer contains presentation, local view state, and the shared client-side kernel. It never
imports Pi packages, reads credential files, or spawns commands. Production roots now mount a
Workbench Profile whose shell is a Piarium extension, and the extension platform supports
declarative, managed, isolated, and explicitly trusted-native Surface entrypoints. None of those
modes authorize loading Pi extension code or private plugin state in the renderer. Every native
operation crosses a typed preload or runtime capability. OpenCode SDK types are removed from feature
code rather than preserved behind a compatibility facade. The former SDK client, sync stores,
optimistic session graph, old chat composer/turn projection, and old session sidebar have no parallel
copy: their unreachable source and tests were deleted after all four production roots passed type,
lint, test, and bundle validation.

Composer drafts are keyed by Pi runtime and session. Workspace surfaces may seed visible text and
hidden instructions in that draft; if there is no active session they create one in the relevant
cwd first. A Pi session's snapshot/catalog cwd is authoritative, including for worktrees, so Git,
terminal, and pull-request views do not maintain a second session-to-directory or
session-to-worktree map. Piarium separately records the product workspace binding selected when it
creates a session: either one registered workspace ID or an explicit unbound/general-chat marker.
That metadata controls navigation grouping only and never replaces the Pi cwd. Native Pi sessions
without Piarium metadata are grouped by their cwd, while an explicitly unbound session remains in
Recent even when its runtime cwd happens to sit below a registered workspace. The same workspace
picker, grouping rules, and navigation path are used by Web, Electron, mobile, the IDE shell, and
the VS Code companion instead of keeping platform-specific workspace state.

The composer keeps three different controls semantically separate. Model and thinking mutate the Pi
session or seed its creation. An Agent target applies only to the next draft and is rendered through
that Agent Provider's declared invocation contract; `Pi` remains the ordinary main-session target.
File and Agent `@` mentions use the shared provider/file catalog rather than a hard-coded role list.
Tool permission is not a cosmetic Piarium mode: an enforcing Pi extension must own the `tool_call`
gate, while its Piarium adapter may contribute status or controls through the composer action seam.
No shield control is shown when no enforcing plugin is installed.

The conversation renderer follows the Pi-native interaction contract in
[chat-experience.md](chat-experience.md): one session record owns preview/live/optimistic/view projections,
messages project into stable turns, the timeline has one virtual-list and scroll owner, and Queue/Steer
state comes only from the Pi runtime. OpenChamber's current chat is reference evidence rather than a
second renderer or state layer.

VS Code active-editor state is transient Piarium view state, not an OpenCode attachment contract.
The Pi composer turns an accepted selection into the same session-scoped structured context used by
file/diff comments, preserving the relative path and line range; accepting the whole file adds an
explicit path context for Pi to read. Session completion/error attention is likewise owned by the Pi
session store, derived from routed `agent.event`/`host.error` envelopes, cleared when the session is
viewed, and shared by the sidebar, switcher, and mobile widget snapshot.

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
signals, and startup failure. Electron resolves that external Host entry once and gives the same
absolute path to Runtime Manager probes and live Broker generations. A path inside `app.asar` is never
an executable fallback for an external Node process. Packaging launches the unpacked Host and completes
a real handshake; the Windows unpacked-app smoke also activates a seeded Pi package root instead of
accepting the runtime-setup screen as proof that the Host works.

`@piarium/runtime-client` is the browser-safe surface client. The Web server exposes the same
Pi-native method names through `/api/piarium/runtime/ws`; it validates every untrusted parameter,
removes worker-only shutdown/trust methods, authenticates UI cookies/client or short-lived URL
tokens, checks Origin, and forwards worker events with explicit
`{workerId, role, sessionId}` routing. The private relay explicitly allowlists this socket and
continues to carry it through the existing encrypted tunnel without injecting credentials.
Piarium does not impose renderer payload, pending-request, or buffered-output ceilings by default;
deployments may opt into them with `PIARIUM_RUNTIME_MAX_PAYLOAD_BYTES`,
`PIARIUM_RUNTIME_MAX_PENDING_REQUESTS`, and `PIARIUM_RUNTIME_MAX_BUFFERED_BYTES`.

`@piarium/application-client` is the framework-neutral application client boundary. It owns the
`RuntimeAPIs` aggregate interface, all 24 API interfaces (Terminal, Git, Files, Documents, Settings,
Permissions, Notifications, Extensions, Language, Tasks, Debug, Tests, etc.), typed failures
(DocumentsError, FilesystemError, LanguageServicesError, RunServicesError, WorkspaceSearchError),
pure DTO types (WorktreeMetadata, DraftStarterRef, FileEditorSettingsPatch), and the single desktop
IPC contract (`desktop.ts`, exported as `@piarium/application-client/desktop`): the
`PiariumDesktopCommandMap` for all 58 `desktop_*` commands, the `PiariumDesktopBridge` interface, the
`PreloadBootstrapPayload` discriminated union, exhaustive runtime command/event catalogs, and the
remote-safe command catalog. It has no React, Zustand, or UI component dependencies —
only `@piarium/protocol` and `@piarium/extension-contract`. Web, VS Code, Electron main/preload, and
UI non-render code import from it directly rather than reaching into `@piarium/ui/lib/api`.

Privileged runtime source and deployable artifacts are intentionally separate. Application Host source
lives in `packages/web/application-host` and emits the stable `packages/web/server` Node ESM runtime;
CLI source lives in `packages/web/cli` and emits the published `packages/web/bin/cli.js`; Electron's
package-root TypeScript modules emit `dist-bundle/main.mjs` and `preload.mjs`. The generated directories
are not tracked, and production does not load TypeScript through `tsx`, `ts-node`, or a loader hook.
Electron type-checking consumes a freshly emitted, type-only Application Host declaration tree so it
does not have to replace a `server/` generation that a running development process may be using.

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

Application settings have one file authority, `@piarium/settings-store`, shared by the Web host,
Electron, the VS Code companion, and the CLI. Reads distinguish a missing file from malformed or
unreadable state. Every mutation re-reads under an owner lock and replaces the document through a
complete temporary file; interrupted Windows replacement retains a complete `.previous` document.
No surface may independently perform a whole-file read-modify-write or treat invalid JSON as an empty
first run. This also serializes first-use identity material such as Relay, APNs, and VAPID keys.

### 4.3 Session workers

Each hot top-level session runs in its own Node worker process and loads the public Pi SDK from the
selected installation. The Host process stays Piarium-owned; only
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai` are
resolved from the chosen package root. This matches the single-active-session assumptions made by
several Pi extensions while allowing multiple background sessions. Idle sessions are persisted by Pi
and need no live worker.

The broker starts each session worker with the session project's absolute `cwd` as the operating-system
working directory before Pi loads extensions. New sessions already provide that directory; reopened
sessions without an explicit override are resolved from the session header by the selected Pi SDK
before the child process is created. This keeps extensions that read `process.cwd()` during their
factory phase aligned with Pi's session snapshot, project trust, worktrees, and project configuration.
The reusable catalog worker deliberately retains the broker's fixed discovery directory and switches
workspace context through the Host protocol instead of changing process-wide state.

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

Direct workers are also where Piarium's own agent harness lives. The session worker overrides Pi's
built-in `bash`, `edit`, `write`, and `grep` tools by name through the same `customTools` path the
recovery journal already uses, and mounts in-process extension hooks for tail-appended turn context,
post-tool feedback, and Piarium-owned compaction. The heavy services behind those tools — shell
supervision, ranked search, diagnostics, output storage, and the TriviumDB workspace knowledge
store — run in the application host and are reached over typed worker-to-host requests, never by
handing the worker host credentials. The harness contract, its cache rules, and the profile model
are specified in [agent-harness.md](agent-harness.md).

### 4.5 Composable workbench and document authority

The product UI is not a fixed shell. A Workbench Profile selects which extension provides
`workbench.shell` and which contributions fill the activity bar, sidebars, editor area, panel, and
status bar. Two profiles ship: `default` (Agent Workspace, labelled `Agent`) and `piarium.ide` (IDE
Workbench). Both shells are ordinary built-in Piarium extensions —
`piarium.builtin.agent-workspace` and `piarium.builtin.ide-workbench` — so a community extension can
replace either one, or any individual seam, without a product build. There is no global `ideMode`
branch. `@piarium/extension-contract` is the single owner of the target, slot, and context-key
constants, and the profile document is revisioned so every mutation is expected-revision checked.

Each shell contribution declares a **shell seam contract** (`PiariumWorkbenchShellContributionDataV1`)
that lists which replacement targets and slots the shell supports per surface (`web`, `desktop`,
`mobile`). The contract is validated at manifest parse time and surfaced in the Extensions settings
page via a pure seam projection. Targets the shell does not declare are hidden from the settings UI;
existing selections for those targets are preserved as **dormant** and can be cleared explicitly. The
six IDE structural targets (activity, primary sidebar, editor, secondary sidebar, panel, status) are
real `WorkbenchReplacement` hosts in the IDE shell, not hardcoded layout. Agent Mobile keeps the
session Sheet/sidebar chrome, safe-area and dismissal behavior in the Shell while replacing only its
navigator content; Settings follows the same Shell-owned-frame rule. `workspace.explorer` is not
declared on mobile. The
`editorActions` and `panelViews` slots receive JSON-safe props (workspaceId, groupId, resourceId,
activePanelId) defined in `@piarium/extension-contract`. Managed shells can compose sub-regions via
the `PiariumWorkbenchCompositionHost` API in `@piarium/extension-sdk`; the React binding provides
`useWorkbenchCompositionHost` and `WorkbenchCompositionHostProvider`. The composition host follows
replacement selection and child owner generations, attributes each mount to the child owner, and
disposes all child mounts when the Shell retires. Isolated Shells remain self-contained in v1 and do
not receive a parent-realm DOM composition bridge.

Contribution `when` expressions read the shared context-key projection. Extension writers are
owner-scoped activation resources: managed candidates stage values locally, isolated candidates use the
same semantics over their MessagePort, and values publish only when the generation commits. A retired
writer cannot mutate or clean up a newer generation. Built-in Settings metadata remains below the
workbench layer, while React page composition and official Shell registration live under
`packages/ui/src/workbenches`.

Profile and layout resolution is layered. Layout layers merge `distribution → user → workspace`, and
profile selection resolves `workspace → user → active`. Shell state is reported truthfully as
`builtin`, `disabled`, `failed`, `missing`, or `ready`. A shell transition stages the candidate and
commits the selection only after it mounts, so a failed, superseded, or revision-conflicting
candidate leaves the previous generation active instead of producing a blank window. When no shell is
active the fixed recovery path stays reachable. The IDE's own layout is a separate versioned
split/stack/editor-area document held by the `piarium.workbench.layout` v1 host service in profile-
and workspace-scoped extension storage; missing and empty documents fall back to the distribution
default without writing it, while malformed or failed reads keep the last valid in-memory document
and raise a diagnostic rather than overwriting host state.

Text content has one authority. The application host owns a revisioned document service with
workspace resolve, read, write, move, delete, an SSE watch, and crash-recovery journals, exposed
through authenticated routes and a resource-scoped `workspace.documents` capability. Revisions are
opaque and writes are expected-revision checked. Workspace identities and journals are scoped per
application host, so another host never inherits a same-path selection. Watch events carry resource
metadata only; file bodies never reach logs, event payloads, or URLs. `FilesAPI` remains
browse/binary/CRUD and `WorkspaceAPI` remains project/tree/git/upload — the duplicate text
read/write shapes were deleted rather than kept as alternates.

On the client, a per-document registry keyed by `{workspaceId, resourceId}` holds buffers. It keeps
`missing`, `binary`, `unsupported-encoding`, `deleted`, `error`, and `conflict` distinguishable from a
successful empty read, models a real three-way conflict of ancestor plus disk against the live
buffer, attributes external change to `agent` or `disk`, preserves edits typed while a save is in
flight, and preserves encoding, BOM, and line endings. Editor groups, tabs, providers, commands,
context keys, and the panel container live in a shared Editor Workbench Kernel that any shell mounts;
high-frequency cursor and scroll state stays in memory rather than in broad shared state or
per-keystroke persistence.

Session navigation likewise separates presentation readiness from execution readiness. A cold open
asks the already-running catalog Host to read the persisted branch through Pi's `SessionManager` while
the broker activates the session worker in parallel. The read-only preview can populate the timeline
but cannot accept prompts, mutate the tree, or become a second session authority; the live worker's
snapshot and entry stream take over when ready. Already-open sessions switch without another runtime
request, and failed activation restores the previous selection.

The standard desktop/Web text renderer is one shared Monaco path for both Agent and IDE;
mobile and embedded editors retain a lightweight CodeMirror adapter because Monaco does not support
mobile browsers. Monaco models are high-frequency projections of Document Registry records, never a
second content, dirty, conflict, or save authority. A stable internal document-instance identity lets
multiple views share one model across shell changes and resource moves, while runtime/workspace
generation still bounds every model and asynchronous result. Full custom `editor` contributions stay
engine-neutral and may replace the official renderer. Agent/IDE presentation presets only change live
editor options; user settings override them without changing model identity. Monaco basic language
definitions provide syntax tokenization, while semantic language features remain Host-owned. The
shared language contract preserves rich edits, snippets, untrusted Markdown, navigation, symbols,
formatting and semantic presentation without exposing the language-server process to the renderer.
Monaco registrations and markers are owned by provider generation; a provider restart clears the old
projection and resynchronizes every open document from the current in-memory buffer. Internal language
links route through the Workbench resource opener and external links through Piarium's HTTP(S) opener.
Rename and code actions prepare an all-or-nothing Document Registry transaction, review cross-file or
annotated changes, and retain one grouped undo action without writing disk. The bundled TypeScript/
JavaScript service is an ordinary disableable brokered Piarium extension: its immutable server asset is
materialized and registered lazily by the Application Host, and the server process exits when its last
document closes.
File diffs use Monaco on desktop/Web without creating another content authority: original and staged
models are immutable, reference-counted snapshots, while a working diff binds its modified side to the
live Document Registry model. A nested Git repository is stored as a workspace-relative view identity,
not as another workspace. Chat/PR patch renderers remain specialized read-only surfaces.
The complete model, language, worker,
extension, and migration contract is
[unified-file-editor-platform.md](unified-file-editor-platform.md).

Mobile and embedded CodeMirror views submit offset edits against the same captured Document Registry
revision and consume the applicable subset of the shared language DTO. They are separate Surface
adapters, not a desktop compatibility renderer. The VS Code companion keeps the host editor and does
not mount Piarium's file editor. Public custom editors use the framework-neutral document controller;
extensions that only augment the official desktop/Web editor can request the optional, owner-scoped
`piarium.editor.monaco` v1 service. That service exposes serialized view state and declarative actions
or decorations, never a raw model, DOM node, file authority, or process capability.

Search, language, task, debug, and test capability is host-owned. The application host runs the LSP
supervisor and a standard Debug Adapter Protocol implementation with its adapters, test providers,
and task processes under workspace trust and owner generations; renderers send typed requests and
never start a process. Language failures are typed and distinguishable — including
`stale-completion`, `untrusted`, and `unsupported` — stale results are rejected, and hidden views
perform no background work. Agent file changes reconcile with open editors explicitly: attachments
are runtime- and session-scoped, unsaved buffers become explicit prompt text rather than implicit
context, and patch accept/reject uses expected-revision writes so an agent edit cannot silently
overwrite a dirty buffer. An agent attachment may quote a test failure or stack frame but never
confers process, debug, or test-runner capability.
Breakpoint mutations are conditional on the observed debug owner, stack/test decorations are scoped to
workspace plus session/run generation, and delayed results from a retired owner are discarded. The
visible editor view is also the sole active Agent context owner; file, selection, diff, inline-comment,
and patch-review paths therefore follow one document identity instead of competing projections.

Surface parity is explicit rather than assumed. Agent Workspace declares web, desktop, and mobile;
the official IDE Workbench declares web and desktop only. VS Code is a companion that opens Piarium,
sends editor context, and bridges the workspace; run, debug, and test stay truthfully
`absent`/`unsupported` there and the official IDE chrome is not loaded into its webview. See
[vscode-companion.md](vscode-companion.md). The full workbench contract, performance requirements,
and per-slice acceptance criteria are in
[composable-workbench.md](composable-workbench.md).

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

### 5.1 Agent harness protocol

The agent harness extends the host protocol with worker→host service
requests. Two out-of-band methods ride on the same broker transport as
`workspace.mutation.request`/`respond`:

- `harness.request` — pi-host sends `{ method, params, requestId, sessionId }`
  to invoke a host-side harness service.
- `harness.respond` — host replies with `{ requestId, result | error }`.

The `HarnessServiceMap` defines ten methods: `shell.exec`, `shell.read`,
`shell.write`, `shell.kill`, `output.store`, `output.read`,
`search.content`, `fs.lock`, `lsp.diagnostics`, and
`lsp.diagnosticsSnapshot`. Each has typed params and result in
`@piarium/protocol`. The host's `HarnessRouter` dispatches requests to
registered services and the `HostServicesBridge` on the pi-host side
resolves the response promise.

`HarnessSettings` (in `harness-settings.ts`) configures shell
interpreter selection, output truncation budgets, and per-tool enable
flags. The Settings page contribution lets users toggle tools like grep;
when disabled, the next session does not register the tool and Pi falls
back to its built-in equivalent.

## 6. Data ownership

| Data | Authority | Piarium behavior |
| --- | --- | --- |
| Pi session tree/messages | Pi SessionManager JSONL | Read and navigate through the SDK; conversation-only rollback stays Pi-native |
| Models/auth | Pi ModelRuntime/AuthStorage + layered native `models.json` | Never mirror secrets into renderer storage; preserve source provenance |
| Pi settings/packages | Pi SettingsManager/PackageManager | Scope-aware JSON settings, extension-owned config documents, and native package updates with source/provenance shown |
| App metadata | Atomic Piarium JSON | Archive state and optional session workspace binding now; recovery preference, pin, tags, and view preferences are application-owned additions |
| Project workspace preferences | `~/.config/piarium/projects/<path-id>.json` | One Piarium-owned, path-derived authority for worktree setup, notes, todos, plans, draft starters, and project actions; writes preserve unknown fields, reject malformed JSON, and fail on external revision conflicts instead of overwriting them |
| Conversation and file rollback | Pi session tree + selected `piarium.workspace-recovery@5` Host service | Pi owns branch navigation; the recovery provider journals only affected paths and coordinates the two operations |
| Optional Pi recovery commands | User-installed `pi-workspace-history` / `pi-wtf` packages | Remain ordinary Pi CLI extensions and are not provisioned or treated as Piarium recovery authorities |
| Magic Context | Its shared SQLite/config | Read through a maintained adapter; do not duplicate memory state |
| Subagent lifecycle | Extension event bus + artifacts | Normalize into parent/child task projections |
| MCP | `pi-mcp-adapter` config/status events | Show the adapter-owned effective server catalog, project its public `status/v1` snapshot, invoke its commands, and edit one native source at a time without reproducing merge or credential logic |
| Web Access | `pi-web-access` config/custom entries | Edit its native `web-search.json`; tools, activity widgets, and custom result entries continue through the generic extension bridge |
| Piarium extensions | Piarium Extension Manager below `PIARIUM_DATA_DIR` | Keep installation, desired state, grants, layout, and extension-owned storage separate from Pi packages and plugin-native data |
| Workspace text documents | Application-host document authority; the file on disk | One revisioned read/write/watch path with opaque revisions; never a second text shape in `FilesAPI`/`WorkspaceAPI` |
| Workspace identity and document recovery journals | Per-host records below `PIARIUM_DATA_DIR` | Scoped to the owning application host; another host never inherits a same-path selection |
| Workbench profiles and layout layers | Revisioned profile document in extension host storage | Expected-revision mutations; distribution/user/workspace layering; profile selection never silently changes the desired extension set |
| IDE editor layout | `piarium.workbench.layout` v1 service, profile- and workspace-scoped | Missing/empty use the distribution default without writing it; malformed keeps the last valid document and raises a diagnostic |
| Open editors and unsaved buffers | Client Document Registry and Editor Workbench Kernel | Dirty buffers and view state are client-owned; disk revisions stay host-owned |

## 7. Pi extension integration architecture

### 7.1 Generic bridge

The host implements Pi's standard extension UI primitives: select, confirm, input, editor,
notifications, status, text widgets, title, and editor text. Requests with responses are abortable
and tied to the originating worker. TUI-only custom components are rendered by their own extension
into a surface-owned read-only panel, so Piarium does not copy the component's private view model.

Commands, custom session entries, tool details, and extension errors have generic renderers so an
unknown package remains usable before a first-class adapter exists.

The Plugins settings page is a direct client of Pi's typed
`package.list/install/setEnabled/update/remove`
operations. It does not maintain an OpenCode registry, copy extension files, or restrict package
sources: recommended cards are only shortcuts, while any source accepted by Pi's `PackageManager`
can be passed through unchanged. Package mutations target the current live session when one exists,
so Pi reloads the real extension instance; otherwise they use the current workspace catalog context.
Disabling a package keeps its installation and native configuration intact, filters all Pi resource
types from that package, and restores the package's previous native filters when enabled again.

Piarium provisions two global foundational Pi packages when a runtime generation first becomes
available: the maintained `pi-mcp-adapter` and `@gotgenes/pi-permission-system`. This is a broker-owned bootstrap layered on top of the same Pi
package operations, not a second package manager. It does not block the Host handshake or cloud
health endpoint; the first newly created session waits for the bootstrap, while sessions already
bound to a worker keep running. Existing enabled or disabled packages are adopted as-is. A configured
source whose artifact is missing is reported as broken rather than silently repaired. Explicit
disable remains ordinary Pi package state, and explicit removal records user intent before removal so
later starts do not reinstall it. Settings can explicitly restore an item or opt out of automatically
adding integrations introduced by a future manifest revision. Piarium does not auto-update these
packages or materialize plugin configuration defaults.

The provisioning receipt is Piarium application policy stored under the canonical agent directory at
`piarium/package-provisioning.json`. It records only integration identity, intent, and observation;
plugin versions, configuration, credentials, and private state remain Pi-owned. All package writes
for one agent directory share the same cross-process lock and reconcile the receipt after Pi reports
the resulting package catalog.

### 7.2 First-class adapters

- **pi-subagents:** task tree and controls from its event bus; lifecycle artifacts for restart and
  cross-process reconciliation. Fleet consumes its public in-process RPC `fleetStatus/v1`
  projection as the `delegated-agent` provider; private run identifiers and artifact paths remain
  host-side, while the plugin's own inspector/stop/doctor commands retain their validation and
  selectors.
- **pi-background-tasks:** Fleet, not Plugin Settings. The Host speaks the published EventBus v1
  channels (`request`/`response`/`terminal`) and projects running and recent background agents or
  shell tasks. `command`, `cwd`, output paths, PIDs, and delegate/Fusion artifacts never cross to
  the renderer. New-task, bounded logs, and stop use `fleet.action`; Piarium does not read `.pi/tasks`
  or parse terminal text.
- **pi-hermes-memory:** one Host-resolved global JSON authority,
  `<active Pi agent directory>/hermes-memory-config.json`. Project Markdown and SQLite stores are
  data, not settings. Runtime observation is the registered `memory-insights` command only.
- **Magic Context:** plugin-owned user/project JSONC configuration, registered `ctx-*` session
  operations, native Pi status component, and persisted public custom entries. Memory,
  compartment, historian/dreamer/sidekick, and diagnostic views read only future public
  plugin/database contracts rather than copied or privately inspected state.
- **pi-mcp-adapter:** protocol v1 carries the adapter's public `pi-mcp-adapter/status/v1` runtime
  snapshot and its read-only `configCatalog/v1` RPC projection. The latter is the adapter-computed,
  deduplicated effective server list plus direct native-source membership; it excludes arguments,
  environment, headers, tokens, OAuth data, and URL query/user information. Settings, desktop, and
  mobile surfaces manage the normal Pi package, select an effective server in the left pane, and
  edit one of the adapter-owned JSON/JSONC sources through revision-checked native document APIs.
  Piarium has no parallel MCP store, generated OpenCode configuration draft, or OAuth callback
  route; the adapter owns merging, host imports, transports, OAuth/keyring data, and connection state.
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

### 7.3 Separate Piarium extension platform

Piarium product/workbench extensions are not Pi packages. They have a separate application-
host manager, manifest, lifecycle, state, asset, contribution, and service model. Pi integration
adapters consume the existing typed Piarium protocol while leaving the Pi package independently
installable, configurable, enabled, and usable from the Pi CLI.

The first platform slice is implemented by `@piarium/extension-contract` and
`@piarium/extension-host`: the application host owns a revisioned catalog and stable identity below
`PIARIUM_DATA_DIR/extensions`, every applicable Web-derived surface exposes that application-host
catalog rather than the selected Pi Runtime through its Runtime API, and `/extensions/recovery`
remains usable without the main renderer. This slice stores desired and reported actual state but
deliberately executes no third-party code.

The second slice is implemented by `@piarium/extension-surface` and the shared UI Surface Registry.
Activations stage owner-scoped contributions and services before one atomic publication; a failed or
superseded candidate leaves the prior generation active, and deactivation withdraws visible records
before asynchronous cleanup. Retained layout references, replacement selection, ordering, and
per-realm actual state live in the registry. Settings pages/sidebars/search and primary Command
Palette commands are now statically linked built-in extensions using that same lifecycle rather than
hard-coded render switches.

The third slice adds `@piarium/extension-sdk`, `@piarium/extension-react`,
`@piarium/extension-loader`, and the content-addressed artifact layer in
`@piarium/extension-host`. npm, Git, local, and built-in sources produce immutable browser bundles;
the application host returns authenticated bytes rather than credential-bearing module URLs. A
Surface verifies those bytes, stages every compatible entrypoint plus its styles and object URLs, and
uses one revision-checked candidate-selection transaction. Activation or catalog-commit failure keeps
the previous selected version and active generation. Web, bundled Electron, and VS Code use the same
loader contract; VS Code owns its catalog in extension global storage and retains its no-blob-script
CSP.

The platform makes built-in pages and workflows replaceable above a narrow recovery kernel, supports
declarative, managed, isolated, and explicitly trusted-native Surface entrypoints, and defines
truthful dynamic-disable guarantees for each mode. Its target architecture is specified in
[piarium-extension-platform.md](piarium-extension-platform.md). None of those entrypoints authorize
loading Pi extension code or private plugin state in the renderer.

The workbench shell itself is now the largest consumer of this platform: both first-party working
shapes are built-in extensions selected by profile, and the public authoring surface ships through
`@piarium/extension-sdk`, `@piarium/extension-react`, and `@piarium/extension-cli` templates. See
section 4.5 and [piarium-extension-authoring.md](piarium-extension-authoring.md).

## 8. Recovery model

Conversation-only rollback remains Pi-native: it branches Pi's append-only session tree and restores
editable user text/images without touching files. Combined rollback uses the selected
`piarium.workspace-recovery@5` Host service, whose distribution default is the statically shipped,
replaceable `piarium.builtin.recovery` extension.

The provider records a lightweight checkpoint for a bound user turn. Pi's built-in `write` and `edit`
tools negotiate a blocking mutation boundary with the Application Host: the old state of the one target
path is durable before the original tool writes, and the final state is recorded afterward. New
sessions and ordinary turns never establish a complete workspace baseline.

Pi recovery navigation reports which entries leave the active branch. The provider folds only the
change sets attached to those entries and restores their affected paths. Matching paths execute
directly from the message action. Later user edits, dirty buffers, incomplete shell/external coverage,
or the always-ask preference produce the small recovery chooser. There is no normal full-manifest
planner, global maintenance mode, safety archive, or new-workspace fallback.

Before applying an inverse, Piarium stores the current versions of affected paths for compensation and
redo. A Host restart resolves an interrupted operation from that small set. Generic native processes do
not expose a portable pre-write file list; watcher-only `bash`, terminal, Git, extension, or unrelated
process changes are marked incomplete instead of causing a full-workspace scan.

Storage location, verified transfer, cleanup, and explicit deletion remain provider-owned and
replaceable. Conversation-only fallback remains available when no provider is selected. The complete
contract is documented in [native-workspace-recovery-design.md](native-workspace-recovery-design.md).

The v5 provider coordinates dirty buffers across connected document surfaces before affected-path
inspection, uses a durable shared/exclusive lease for cross-process workspace-local storage, and maintains
workspace-scoped object references for configurable retention. Retention has no guessed default ceiling;
configured limits preserve named checkpoints and nonterminal or attention-required operations.

## 9. Trust and security

Project-local Pi resources, MCP commands, and credential command sources can execute code. Project
trust is therefore a host gate, not a decorative preference. The UI shows source, command, cwd,
environment key names, and capability changes before activation.

Workspace containment treats the configured root's `realpath` as the canonical boundary. The
configured spelling may be a symlink, junction, or Windows 8.3 alias and therefore does not need to
be textually nested inside its canonical spelling. Requested paths still pass lexical traversal
checks first, and every existing target or nearest existing parent must resolve inside that one
canonical root before it can be read or written.

See [security.md](security.md) for the threat model and release gates.

## 10. Runtime selection

Desktop and the local Web UI start without forcing a Pi warmup. The Runtime Manager discovers PATH
`pi` first and then probes that install: Node starts, the three Pi SDK packages resolve, and the
Host handshake must succeed. A newer Pi is used as-is. An older Pi is upgrade-required only. There
is no version ceiling, downgrade action, or silent upgrade. Cloud and headless Web still require a
ready runtime before the server finishes starting.

Onboarding and Settings activate or install through `RuntimeAPIs.piRuntime`. After a successful
probe the lifecycle creates a broker without restarting the app and publishes `ready` only after
that broker completes its Host handshake. Runtime snapshots carry a monotonic revision so a delayed
HTTP snapshot cannot overwrite a newer live event. HTTP and WebSocket surfaces use the lifecycle
facade: existing sessions and interactive worker replies stay on their owning generation while new
catalog and session work uses the current generation. Workers that use the user-global install are
stopped before that install is overwritten.

When PATH has no usable Pi, the same manager plans a one-click user-global install. It prefers the
owning package manager of an existing install, otherwise the first detected npm, bun, or pnpm, and
otherwise a verified standalone payload that lands in the user-level Pi program directory
(`%LOCALAPPDATA%\Pi` on Windows, `~/.local/share/pi/runtime` plus a user `bin` entry on
macOS/Linux). Runtime code stays out of `~/.pi/agent`; plugins, configuration, and sessions keep
using that data directory.

Development and diagnostics still enumerate:

1. a workspace or cloud-bundled Pi runtime when those packages are present;
2. system-installed Pi on PATH;
3. a standalone user-global payload;
4. an explicit developer source checkout;
5. an explicit custom Node/module path.

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
- A missing or inaccessible application Host is reported as `host-entry-unavailable`, separately from
  Pi installation/version failures; onboarding offers Piarium reinstallation and does not suggest that
  upgrading or selecting a different Pi can repair application files.
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
