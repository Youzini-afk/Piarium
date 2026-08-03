# Pi ecosystem GUI design

Status: implementation contract for Phase 6

Last updated: 2026-08-03

## 1. Purpose

Piarium gives frequently used Pi packages a first-class graphical experience without becoming a
second package runtime or configuration authority. This document fixes the page boundaries,
provider ownership, and acceptance criteria before the imported OpenChamber pages are retired.

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

Agents consumes every provider action currently advertised by the extension: create, edit/inspect,
update, delete, eject, enable, disable, and reset. It does not stop at displaying action badges.

Fleet is a separate live-work surface. It projects task state, steps, workflow graph, parent/child
relationships, timing, artifacts, and errors from the stable public contract. It provides only
advertised controls such as steer, append, interrupt, stop, resume, and checkpoint decisions.

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
flattening them into scalar controls. Health, database inspection, and `ctx-*` session operations
remain a later public-contract slice rather than being inferred from configuration.

Acceptance:

- every field shown by the GUI maps to the current package schema and correct scope;
- unknown JSONC content and comments survive a GUI edit;
- commands are invoked through the active extension and report cancellation/failure honestly;
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
   capability parity is documented and tested.

Each step is independently type-checked, linted, tested, committed, and pushed. File deletion occurs
only after its capability has a Pi-native home or is explicitly rejected as obsolete.
