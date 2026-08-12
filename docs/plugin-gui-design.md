# Pi ecosystem GUI design

Status: implementation contract for Phase 6

Last updated: 2026-08-12

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
| Pi Packages | Install, enable, disable, update, remove, scope, source, version, reload state | Extension-specific configuration |
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
  Settings. Its package switch disables every Pi resource type from that source while retaining the
  installed files, native configuration, and any existing resource filters for exact restoration.
  Pi's update operation is
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
- observation: package installation and current-session evidence are separate; `no session`,
  `not observed`, `available`, and probe failure are not collapsed into a guessed health state;
- scope: user and project documents are visibly distinct, including precedence and conflicts;
- changes: dirty state, validation diagnostics, reload requirement, atomic save, and revision
  conflict handling;
- navigation: focused sections for common settings and an Advanced section for the complete native
  document;
- runtime actions: enabled only when the active provider advertises them;
- provenance: inherited/effective values show their source when the extension exposes it.

The shell never writes a default just because a form rendered it. Unchanged native keys remain
absent, so future plugin defaults and migrations continue to work.

### 4.1 Quick configuration and native-document editing

The default adapter view is a task-oriented quick configuration layer, not a schema dump. A native
property path may appear as secondary provenance or in the Advanced editor, but it is never the
primary label of an ordinary control. Controls use user outcomes such as “Default model”, “Search
strategy”, and “Sessions kept per workspace”. Low-level tuning is not promoted merely because its
schema is known.

Structured controls and Advanced editing of the same source share one draft, revision, validation
state, and Save action. An adapter must not load a second raw draft that can overwrite unsaved form
changes. Text-backed JSONC documents retain comments, trailing commas, formatting outside the
edited path, and unknown keys. Object-scoped settings retain unknown values through their native
host update API; the renderer does not claim to preserve comment syntax that API does not expose.
Invalid raw content disables structured controls while leaving Advanced available for repair.
Switching plugin, scope, or source keeps an independent mounted draft or requires the current draft
to be explicitly saved or discarded first.

Every selected adapter shows the package observation separately from its configuration authority:
the package source/version, active session or workspace target, current native document and scope,
dirty/invalid state, and the exact evidence for runtime availability. “Not observed” is not reported
as unhealthy, and an absent key in one layer is “not set in this source”, not a guessed effective
value.

| Adapter | Quick tasks | Native authority shown in the quick view | Advanced-only by default | Local warnings that remain visible |
| --- | --- | --- | --- | --- |
| pi-subagents | Agents and workflows; definition actions; per-scope model/thinking/fallback overrides; delegation; review; limits | Provider actions/Agent Markdown, user/project `settings.json#subagents`, and global runtime `config.json` are three distinct save owners | worktree/storage paths, Intercom, notification batching, detailed LSP/retry tuning, complex prompts and future runtime fields | definition versus override precedence, project trust, hard budgets and destructive provider actions |
| Magic Context | Context; memory; internal models; maintenance schedules and session operations | Independent user/project JSONC drafts with ignored project keys reported | per-model maps, prompts/permissions, sampling fine-tuning, SQLite/Synapse details and experimental fields | fail-closed behavior, lossy compression, project-ignored keys, model-cost maintenance actions |
| pi-web-access | Search; providers and credential sources; Browser/Curator; content; safety | Agent-root `web-search.json`; command presence is only loaded-state evidence | custom tool names, provider-specific fine tuning and future fields | executable credential sources, browser-cookie access, remote bind, fresh scraping and SSRF exceptions |
| pi-mcp-adapter | Runtime servers and actions; selected-source server overrides; behavior and interaction policy | One visibly selected source from the documented six-layer precedence; the dedicated MCP page remains canonical | bearer/OAuth details, complex output guards, tracing/filter details and future fields | URL credential reset, sampling auto-approval, socket trust and source-local versus effective state |
| pi-workspace-history | Protection and retention | Independent user/project `settings.json#workspaceHistory` drafts | scan budgets, Git timeout and future storage-engine tuning | lowering retention deletes old history; changing the storage directory does not migrate old history; home-directory capture |
| pi-wtf | Command words and the three generated command behaviors | Global `wtf.json`; previews are distinguished from commands currently loaded in a session | future plugin-owned fields | `!` rewrites session history and never restores file or external side effects |
| pi-openai-codex-compat | Codex request, reasoning, remote-compaction and tool options | Independent global `openai-codex-compat.json` and trusted project `.pi/openai-codex-compat.json` drafts | unknown future plugin fields | absent keys stay unset; environment overrides remain plugin-owned |
| pi-observational-memory | Observation, reflection, compaction, pool and worker settings | Independent user/project `settings.json#observational-memory` drafts | unknown future plugin fields | invalid thresholds and incomplete worker models block save without rewriting the draft |

Agent definitions and settings overrides are deliberately not one transaction. A definition action
may succeed while an unsaved override draft remains, or vice versa; the UI presents and reports
those operations separately. The same rule applies to immediate plugin commands versus saved
configuration: session actions never imply that a draft was persisted.

## 5. Adapter contracts

### 5.0 Context and memory package boundaries

`pi-openai-codex-compat` and `pi-observational-memory` are adapted only through their current native
configuration authorities. Piarium does not assign compaction ownership, infer cross-plugin
priority, or add coexistence policy in this phase. `context-mode` remains available through the
generic installed-package editor because it does not expose one canonical user configuration
document suitable for a dedicated form. `pi-memory` is not a maintained adapter target.

### 5.1 pi-subagents

Authority:

- user/project Pi `settings.json` under `subagents`;
- `<agentDir>/extensions/subagent/config.json` for runtime behavior;
- `piarium.agent-provider.discover/v1` and `subagents:rpc:v1:*` for definitions and actions;
- public lifecycle status/events/artifacts for active and recoverable tasks.

Target settings sections:

1. Agents & workflows: the real provider catalog, immediate create/edit definition actions, and a
   visibly separate user/project `agentOverrides` editor.
2. Delegation: scoped model defaults and allowlist plus separately saved global spawn/wait behavior.
3. Review: watchdog activation, main/child review models, severity, and blocker follow-up.
4. Limits: global depth, spawn, concurrency, parallelism, and budget guardrails.
5. Advanced within each save owner: the complete scoped settings object or global runtime document,
   sharing the visible form's draft and Save action.

The current settings adapter also discovers agents and workflows from the live `pi-subagents`
catalog, exposes provider-advertised create/update actions, and uses
the descriptor's runtime `name`—never Piarium's opaque descriptor id—as the `agentOverrides` key.
The definition dialog's Advanced JSON is specifically the plugin's management-action config, not a
raw editor for Agent Markdown or `.chain.md` files. It exposes only top-level fields accepted by the
installed 0.37.2 management `create`/`update` contract. Unknown native frontmatter remains
plugin-owned and is not shown as editable JSON; normal updates preserve it through the plugin's
serializer. Manually adding an unsupported action key is rejected before dispatch instead of being
silently ignored. Removing a supported advanced key sends that field's plugin-defined clear or
default value, so a JSON edit cannot degrade into a misleading “no changes” response.

Saved workflow steps expose the complete 0.37.2 management/Markdown contract as task-oriented
controls: agent and task, phase and label, named output (`as`), output schema path and return mode,
model, saved output, reads, skills, progress tracking, and tool-call budget. Each supported value can
be created, loaded, changed, or cleared. Unknown step keys are not offered as editable Advanced JSON
because the 0.37.2 management parser rebuilds a whitelist step and cannot round-trip them. The host
still projects such native keys as preservation evidence, and the dialog refuses a lossy workflow
update rather than erasing them. It applies the same guard to non-string unknown root values in a
`.chain.json` file, which that version's serializer also cannot retain. Future thinking tokens
likewise render as an unsupported value and remain unchanged until the user chooses a supported
level.

It supports the complete current override contract, including a structured three-state
`toolBudget`, while preserving arbitrary future agent names and unknown future keys. Fields known
to belong to agent Markdown or an individual run contract are diagnosed instead of being saved to
a location the plugin ignores. `false` is rendered as the plugin's
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

Implemented configuration slice: the native settings page now separates Context, Memory, Models,
and Maintenance. It keeps independent unsaved
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

The runtime surface groups those operations by intent: Context health contains the newest public
status entry and lightweight refresh/flush actions; session maintenance owns wrap-up,
recompression, upgrade, and Sidekick augmentation; Dreamer and embedding workers are kept in their
own long-running section. It does not synthesize progress that the extension has not published.

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

The dedicated MCP page is visible only while `package.list` reports an installed and enabled
`pi-mcp-adapter`. Its split view uses the adapter's read-only `configCatalog/v1` RPC as the left-hand
catalog: one row per deduplicated effective server, with runtime state joined by server name. The
right pane shows the selected server, its runtime actions, and the highest-precedence native source
that directly defines it. New-server and adapter-settings actions choose an explicit native source;
source-local edits still use the revisioned `config.text` contract and preserve the raw JSON/JSONC
draft. Piarium never folds the six files in the renderer.

The public catalog contains only server identity, disabled state, transport kind and sanitized
command/URL/socket display data, plus direct native-source membership. It does not expose arguments,
environment, headers, bearer material, OAuth data, URL user information, query strings, or
fragments. Imported or programmatic effective servers may therefore have no editable source. The
adapter remains the sole owner of merge order, imports, URL credential binding, and effective
transport selection. Piarium edits one selected native document and re-reads the adapter-owned
catalog after save.

Saving a changed existing server URL clears URL-bound credentials present in that selected source,
matching the adapter's cross-source credential binding instead of carrying old endpoint secrets
forward. The cleanup happens at the revisioned Save boundary, so temporary typing is reversible and
restoring the loaded URL preserves its credentials. Switching transport clears fields owned by the
previous transport while preserving unrelated and unknown server fields. Partial server overrides
remain valid, so the GUI does not require a transport when a lower-precedence source supplies it.
Host-config discovery stays explicit and defaults off. Socket configuration keeps a local trust
warning beside the path. OpenCode is available only as an explicit compatibility import supported
by the adapter; it is never an authoritative Piarium source.

The public `status/v1` snapshot remains the runtime authority and does not expose config provenance
or failure text. The separate `configCatalog/v1` projection supplies effective identity and direct
source membership, computed inside the adapter with the same loader used at runtime. Server actions
remain command-backed; names containing whitespace are shown but their per-server buttons stay
disabled because the adapter's current command parser has no quoting contract. The extension panel
remains available for those servers.

Acceptance:

- all status and actions use public adapter contracts;
- the effective catalog and runtime snapshots never add credential material to renderer state or logs;
- each effective server appears once and native source selection never requires a renderer-side merge;
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
`searchProvider` as independent choices. Its quick view is organized as Search, Providers &
credentials, Browser & Curator, Content, and Safety. Stable high-frequency controls include masked
credential sources, provider endpoints/models, Curator bind modes, Chromium-cookie opt-in,
GitHub/video feature switches, domain policy, and SSRF exceptions. Tool-name aliases, shortcuts,
size/time budgets, and provider-specific tuning remain in the same draft's Advanced editor while
unknown native keys are preserved. Piarium propagates its selected Pi agent directory through
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

Secrets use masked inputs and are never tested, summarized, or reported as provider health. The
advanced editor preserves native credential source references. A remote Curator bind explains
plain-HTTP/token-in-URL exposure and highlights
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
