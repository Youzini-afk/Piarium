# Pi ecosystem GUI design

Status: implementation contract for Phase 6

Last updated: 2026-08-03

## 1. Purpose

Piarium gives frequently used Pi packages a first-class graphical experience without becoming a
second package runtime or configuration authority. This document fixes the page boundaries,
provider ownership, and acceptance criteria used to retire the imported OpenChamber pages.

The old Magic Context, OpenAgent, and Agent Orchestration pages are historical capability clues.
They are not interaction or data-model templates: they predate the current packages, omit current
settings, and encode OpenCode-era assumptions. New screens are derived from the installed Pi
package's current schema, commands, public events, and documented lifecycle.

## 2. Product rules

1. **Native files remain authoritative.** Pi settings, package manifests, extension JSON/JSONC,
   session JSONL, extension databases, and extension artifacts are not mirrored into a Piarium
   store.
2. **A GUI adapter is a view, not a reduced replacement schema.** It edits well-understood native
   keys and preserves every unknown key. A raw JSON/JSONC editor remains available for the complete
   document.
3. **Package configuration wins.** The Agents catalog may provide common discovery and lifecycle
   actions, but a provider-specific editor takes precedence over generic fields.
4. **Runtime actions require a public contract.** Piarium may call registered Pi commands, a
   documented event-bus bridge, or a versioned extension contract. It does not scrape terminal
   text, inspect private databases, or infer success from private files.
5. **Configured and active are different states.** A package can be present in user/project
   settings but not loaded in the current session. Every adapter shows scope, source, active state,
   and actionable diagnostics separately.
6. **No pre-release compatibility stack.** All Piarium surfaces use the single protocol v1 and
   change in lockstep. There are no legacy request aliases or version branches.
7. **Risk is explained where the action occurs.** Destructive repair, history navigation, remote
   bind, cookie access, executable configuration, and credential sources receive focused warnings;
   ordinary settings are not hidden behind blanket restrictions.

## 3. Information architecture

| Surface | Responsibility | Must not own |
| --- | --- | --- |
| Pi Packages | Install, update, remove, scope, source, version, reload state | Extension-specific configuration |
| Plugin Settings | First-class GUI adapters plus advanced native document editing | Package installation semantics or copied plugin state |
| Agents | Unified provider catalog and provider-advertised lifecycle actions | A universal agent schema that overrides providers |
| Fleet | Live and recent delegated work, task graph, controls, artifacts | Agent definitions or terminal-text parsing |
| Commands | Read-only live slash-command catalog and provenance | A second command registry |
| Prompts | Pi-native `.md` prompt templates through the resource loader | OpenCode command files or extension commands |
| Skills | Pi resource discovery/management when supported by the loader | An OpenCode skills store |
| Recovery sidebar | Current-session health, undo/redo/checkpoints/repair | Workspace snapshot storage |
| Recovery settings | Default rollback policy, package/configuration entry points | Per-message rollback itself |

An unknown package remains usable through Pi's generic extension UI bridge. If Piarium does not
have a specialized adapter, Plugin Settings opens its declared or user-selected native JSON/JSONC
document rather than fabricating common fields.

The current catalog surfaces follow those boundaries directly:

- Pi Packages distinguishes a configured source from a source that is actually present on disk,
  shows its resolved path and whether Pi stores a structured package entry, and links to Plugin
  Settings. Pi's update operation is
  truthfully described as source-wide across user and project scopes; the scope selector applies to
  installation and removal, not to a fictional scoped update implementation.
- Commands projects each extension, prompt, or skill command's native source path, scope, origin,
  source identifier, and prompt argument hint. It remains read-only and links resource commands to
  Prompts or Skills instead of editing them in place.
- Prompts renders the filename-derived `/command` invocation and native `argument-hint` while all
  Markdown/frontmatter parsing, collision decisions, package read-only state, and project trust
  remain owned by Pi's resource loader.
- Agents displays provider/source/package/invocation facts and calls only provider-advertised
  actions. A missing model is labelled as a provider default or unreported value, never guessed to
  be an inherited common setting.
- The composer, command picker, inline skill picker, sent-message links, and skill activity rows
  share one runtime/session/workspace-keyed Pi catalog. Callable skills use Pi's native
  `/skill:name` invocation; the editable resource catalog enriches them with file and scope data
  but never creates a second command registry. Successful skill/package/plugin-configuration
  mutations and `/reload` invalidate that catalog at their host-success boundary.

### 3.1 Retired-page capability disposition

The removed screens are represented here by capability, rather than kept as dormant source code
that can accidentally become a second configuration system.

| Retired surface | Useful capability clue | Piarium disposition |
| --- | --- | --- |
| Magic Context | Compression thresholds, memory/search, embeddings, SQLite, internal agents, fallbacks, and Dreamer schedules | Implemented in the current schema-driven Magic Context adapter with separate user/project documents and Advanced JSONC. |
| Magic Context | Runtime status, diagnostics, memory inspection, recompression, wrap-up, dream, augmentation, and embedding actions | Current registered `ctx-*` commands are integrated as provider-owned session operations, including focused cost/maintenance confirmation and persisted public result entries. Private database inspection still waits for an explicit public contract. |
| Magic Context | OpenCode plugin registration, OpenCode TUI sidebar, and Oh My OpenAgent hook-conflict diagnostics | Rejected as OpenCode-only behavior. Pi package health is derived from Pi package/runtime contracts instead. |
| OpenAgent | Agent/category model routing, fallback chains, hook toggles, team/background task, Tmux, skills, MCP, and experimental settings | Rejected as a generic Piarium schema because these were fields of the unrelated Oh My OpenAgent OpenCode plugin. A future Pi package receives its own adapter only from its current native schema. |
| OpenAgent | Discovering agents, showing defaults/source, and invoking lifecycle actions | Implemented by the provider-owned Agents catalog. Provider configuration remains higher priority than generic catalog presentation. |
| OpenCode agent editor | Generic agent create/rename/duplicate controls and a shared OpenCode permission-map editor | Rejected from the Pi catalog. Definitions and permissions are mutated only through provider-advertised actions, a specialized package adapter, or that package's native configuration document. |
| OpenCode Commands, Skills, and external Skills Catalog stores | Slash completion, inline skill links, command dispatch, resource editing, supporting files, and catalog installation | Callable/resource behavior is replaced by Pi `command.list`, `resource.list/get/create/update/delete/copy`, and Pi Packages. The client accepts only native `/skill:name`; old `/name` aliases, OpenCode CRUD/catalog endpoints, duplicate persisted selections, and browser debug globals are retired. The unused private supporting-file editor is not carried forward: Piarium will add it only through a native Pi resource contract, not by restoring OpenCode HTTP paths. |
| Agent Orchestration | Switching among native OpenCode, oh-my-opencode-slim, and oh-my-openagent modes | Rejected. Piarium has one Pi runtime and does not retain an OpenCode orchestration-mode compatibility layer. |
| Agent Orchestration | Provider discovery, presets, model policy, fallback, runtime limits, and feature controls | Discovery/actions live in Agents; settings belong to the contributing Pi package adapter or its native JSON/JSONC document. No shared form fabricates unsupported fields. |

The cleanup removes only the unreachable OpenCode pages, their private HTTP stores, their schema
normalizers, and tests/translations that existed solely for those pages. It deliberately retains
the Pi-native Agents provider registry, Plugin Settings adapters, Prompts and Skills resource
pages, generic extension UI bridge, and the target-keyed Pi runtime catalog used by chat.

## 4. Shared adapter shell

Every first-class adapter uses the same frame:

- identity: display name, package source, installed version, configured scope, and active session;
- health: `unavailable`, `configured`, `active`, `degraded`, or `incompatible`, with the evidence
  that produced the state;
- scope: user and project documents are visibly distinct, including precedence and conflicts;
- changes: dirty state, validation diagnostics, reload requirement, atomic save, and revision
  conflict handling;
- navigation: focused sections for common settings and an Advanced section for the complete native
  document;
- runtime actions: enabled only when the active provider advertises them;
- provenance: inherited/effective values show their source when the extension exposes it.

The shell never writes a default just because a form rendered it. Unchanged native keys remain
absent, so future plugin defaults and migrations continue to work.

## 5. Adapter contracts

### 5.1 pi-subagents

Authority:

- user/project Pi `settings.json` under `subagents`;
- `<agentDir>/extensions/subagent/config.json` for runtime behavior;
- `piarium.agent-provider.discover/v1` and `subagents:rpc:v1:*` for definitions and actions;
- public lifecycle status/events/artifacts for active and recoverable tasks.

Target settings sections:

1. Overview: installation, active version, provider health, effective scope, and diagnostics.
2. Defaults: default model, thinking, extension list, model scope, built-in agents, and project-root
   resolution.
3. Runtime and limits: asynchronous mode, placement/depth/spawn/concurrency, budgets, wait/control,
   completion batching, artifact directory, worktrees, scheduled runs, and intercom.
4. Watchdog: the complete current watchdog schema with native defaults and validation.
5. Agent overrides: provider-owned per-agent overrides without flattening them into the generic
   Agents model.
6. Advanced: the full native JSON documents with scope and conflict information.

The current settings adapter also discovers the live `pi-subagents` catalog by provider id and uses
the descriptor's runtime `name`—never Piarium's opaque descriptor id—as the `agentOverrides` key.
It supports every currently parsed scalar/list override, preserves arbitrary future agent names,
and leaves `toolBudget` plus unknown fields in Advanced. `false` is rendered as the plugin's
“clear resolved value” sentinel, which is distinct from an absent override and, for list fields,
from an explicit empty array. Runtime configuration includes the current control notification
event/channel lists and proactive skill-delegation settings. The one-value watchdog delivery and
late-warning enums remain in Advanced until the plugin exposes an actual user choice.

Agents consumes every provider action currently advertised by the extension: create, edit/inspect,
update, delete, eject, enable, disable, and reset. It does not stop at displaying action badges.

Fleet is a separate live-work surface. It projects task state, steps, workflow graph, parent/child
relationships, timing, artifacts, and errors from the stable public contract. It provides only
advertised controls such as steer, append, interrupt, stop, resume, and checkpoint decisions.

Implemented Fleet slice: the dedicated Fleet page consumes `subagents:rpc:v1` only after the
extension advertises `fleetStatus: { version: 1 }`. It renders the bounded, current-session public
entries with agent/role, caller-facing goal, model, effort, elapsed time, and token totals. The host
revalidates that DTO and deliberately drops the RPC's text, tool details, run IDs, async paths, and
other private status data before crossing the renderer boundary. The native Fleet inspector, stop
selector, and doctor remain available through the plugin's registered commands. The public Fleet
DTO intentionally withholds actionable run IDs, so Piarium does not attach guessed per-entry
controls; those land only when a provider advertises stable action targets. Recent/completed task
projection and richer workflow graphs remain a later public-contract slice.

Acceptance:

- settings round-trip unknown keys at both scopes;
- provider-owned actions update the catalog without a renderer refresh;
- an async child task appears in its parent session and Fleet with structured state;
- unavailable RPC/lifecycle capabilities produce a truthful degraded state, not parsed output.

### 5.2 Magic Context

Authority:

- the package's current Zod schema and generated JSON schema;
- user/project `magic-context.jsonc`, preserving comments and trailing commas;
- registered `ctx-*` commands and public custom entries/components;
- public database or status contracts only when the package exposes them.

Target sections:

1. Overview and health: active scope, context state, diagnostics, and available session operations.
2. Session operations: status, flush, augmentation, wrap-up, session upgrade, dream, and embeddings.
3. Core and compression: TTL, thresholds, tags, history budget, commit trigger, system injection,
   transforms, sub-context behavior, and lossy/experimental controls.
4. Memory and embeddings: memory, automatic search, Git indexing, embedding, and SQLite settings.
5. Agents and schedules: historian, dreamer, sidekick, model/thinking/timeout, fallbacks, schedules,
   and promotion thresholds.
6. Safety and advanced: safety-sensitive flags and the complete native JSONC document.

Project configuration is not rendered as an identical user form. Keys stripped or disallowed by
the package's project override rules are explained and remain user-only. Expensive recompression
requires a focused confirmation that explains range and model cost; routine operations do not.

Implemented configuration slice: the native settings page now separates Overview, Context pipeline,
Memory, Embedding and storage, Internal agents, and Dreamer tasks. It keeps independent unsaved
user/project drafts, hides fields the real project loader strips, reports ignored fields already
present in a project document, validates the plugin's numeric five-field cron and embedding
requirements, and preserves polymorphic per-model maps for Advanced JSONC editing instead of
flattening them into scalar controls.

Implemented session-operations slice: when a live session advertises the current command set, the
adapter opens the plugin-owned status dialog, flushes pending context, queries embedding status,
starts or pauses embedding, submits Sidekick augmentation, and invokes wrap-up, full or ranged
recompression, session upgrade, or a selected Dreamer task. Augmentation is labelled as a real new
user turn rather than a preview. Wrap-up, upgrade, and Dreamer receive focused explanations of
model cost/state effects. Full and ranged recompression deliberately keep Magic Context's native
two-invocation, 60-second confirmation instead of trying to infer its armed state from output
prose. The adapter renders the newest persisted public `ctx-status` entry from the current Pi
branch with the same renderer used by chat. It never reads SQLite or copies status into Piarium
storage.

Acceptance:

- every field shown by the GUI maps to the current package schema and correct scope;
- unknown JSONC content and comments survive a GUI edit;
- commands are invoked through the active extension and transport failures remain distinct from
  provider-reported status entries;
- no memory or SQLite content is copied into Piarium storage.

### 5.3 pi-mcp-adapter

Authority:

- the adapter's six documented config sources and merge order;
- `pi-mcp-adapter/status/v1` for effective runtime state;
- its registered panel, reconnect, authentication, logout, enable, and disable commands;
- the adapter's OS keyring/OAuth implementation for credentials.

The existing status-first MCP page remains the primary design. It shows servers, tools, resources,
connection errors, active/configured distinction, and runtime actions. Native setup/panel flows own
server creation and detailed editing. Piarium adds source provenance and precedence diagnostics
when exposed; it does not reproduce merge, OAuth, transport, or credential logic.

Changing a server URL must not silently carry inherited credentials to the new origin. Host-config
discovery stays explicit and defaults off. OpenCode config is never an authoritative source.

The current public `status/v1` snapshot intentionally does not expose config provenance, transport,
or failure text, so Piarium does not reverse-engineer an effective configuration from the six raw
files. Server actions remain command-backed; names containing whitespace are shown but their
per-server buttons stay disabled because the adapter's current command parser has no quoting
contract. The extension panel remains available for those servers.

Acceptance:

- all status and actions use public adapter contracts;
- credentials never cross into renderer state or logs;
- source conflicts are visible without Piarium computing a parallel effective configuration;
- absent status support yields configuration-only/degraded UI.

### 5.4 pi-web-access

Authority:

- the agent-root `web-search.json` document;
- registered search, curator, Google-account, and shortcut commands;
- public extension widgets/custom entries and any future versioned activity contract.

Target sections:

1. Overview: installed/active state and provider availability when publicly reported.
2. Routing: provider, search provider, workflow, summarization model, and tool names.
3. Browser and Curator: browser opening, cookie opt-in/profile, validation action, curator lifecycle,
   bind, and timeout.
4. Provider options: provider-specific non-secret settings.
5. Security and advanced: SSRF policy, remote Curator warnings, credential-source syntax, shortcuts,
   and the full native JSON document.

Implemented configuration slice: the first-class adapter now models automatic, named, concurrent,
all-provider, and typed ordered-fallback routing without presenting `provider` and
`searchProvider` as independent choices. It covers current public tool names, every documented
credential source, provider endpoints/models, Curator bind modes, Chromium-cookie opt-in,
shortcuts, GitHub/video/PDF behavior, domain policy, and SSRF exceptions while preserving unknown
native keys. Piarium propagates its selected Pi agent directory through
`PI_CODING_AGENT_DIR`, so the file edited by the GUI is the file loaded by extensions even when a
custom agent directory is used.

Implemented session-operations slice: the adapter discovers the live session's registered command
catalog, opens `/websearch` with an optional native comma-separated query list, invokes the
plugin-owned Gemini Web account diagnostic, opens the plugin's persisted-result browser, and calls
the public `/curator on|off|summary-review` modes. Those runtime actions intentionally remain
separate from the saved `workflow` draft: the plugin owns persistence and immediate session
effects, while the settings form remains a revision-safe view of `web-search.json`. Command
discovery proves only that an operation is loaded; provider health, search activity, and richer
Curator state remain unreported until the extension publishes a versioned runtime contract. The
plugin continues to own every dialog, follow-up message, browser server, stored result, and delete
action.

Secrets are not surfaced as ordinary text fields. The advanced editor preserves native credential
source references. A remote Curator bind explains plain-HTTP/token-in-URL exposure and highlights
`0.0.0.0`; it is allowed after an explicit choice rather than prohibited by a product allowlist.

Acceptance:

- common settings preserve every unknown native key;
- browser/cookie validation and runtime activity appear only through public contracts;
- high-risk remote configuration is explicit and still configurable;
- search/fetch tools and results continue through the generic Pi extension bridge.

### 5.5 pi-workspace-history and pi-wtf

Authority and detailed semantics are defined in [recovery.md](recovery.md). The normal rollback
entry point remains attached to a user message. The right sidebar adds current-session recovery
health, undo, redo, checkpoint, and repair actions. Settings contains policy and plugin-specific
configuration, not a second history browser.

`pi-workspace-history` owns snapshot lifecycle and dirty-workspace safeguards. `pi-wtf` owns prompt
repair and command-word behavior. Piarium reports only advertised modes: `both` is not presented as
a `pi-wtf` capability, and `files` remains hidden until a provider explicitly advertises it.

Acceptance:

- the `conversation`, `both`, and `ask` policy is honored at every message rollback;
- a default `both` rollback is capability-gated just like the ask dialog;
- sidebar actions invoke public provider commands/bridge operations and refresh authoritative state;
- cancellation, unknown command-only outcomes, and provider failures remain distinguishable.

## 6. Implementation order

1. Recovery correctness and sidebar controls, because the host operations already exist and the
   message-level contract is user-facing today.
2. Shared adapter shell and capability states.
3. Subagents settings, provider lifecycle actions, and Fleet projection.
4. Magic Context schema-complete settings and command operations.
5. Web Access advanced routing/security and public runtime status when available.
6. MCP provenance improvements without replacing its native panel.
7. Cross-page navigation, unknown-plugin discovery, and final removal of superseded pages after
   capability parity or an explicit rejection is documented and tested. This retirement is now
   complete for the imported Magic Context, OpenAgent, and Agent Orchestration pages.

Each step is independently type-checked, linted, tested, committed, and pushed. File deletion occurs
only after its capability has a Pi-native home or is explicitly rejected as obsolete.
