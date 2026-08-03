# OpenChamber-to-Pi migration contract

## Authoritative source and workspace boundary

Piarium adopts the maintainer's OpenChamber fork, not a pristine upstream checkout:

- repository: `https://github.com/Youzini-afk/openchamber`;
- reviewed clean source commit: `f551150e57de87858383dd62f45462189adf4125`;
- that commit includes the maintainer's custom history and the reviewed upstream merge;
- copied OpenChamber material remains subject to its MIT license and copyright notice.

Every OpenChamber source worktree is read-only for this project. Imports are produced from the
specified commit tree; all copies, deletions, rewrites, branches, commits, and pushes happen only in
`D:\project\opencr\Piarium`. Tracked `.env`, tool-specific agent directories, stale CI/release
identity, and OpenChamber/OpenCode branding are not blindly copied into release artifacts.

## Non-regression contract

The following fork capabilities are product requirements, not incidental patches:

- custom provider configuration, model discovery, API-key and OAuth flows;
- remote/cloud connection, pairing, relay, notifications, tray behavior, and client permissions;
- workspace files, Git, terminal containment, external-access auditing, and allowed directories;
- session queues, delayed child-session materialization, parent/subagent visibility, archive restore,
  revert/fork/timeline, and workspace checkpoints;
- Magic Context, orchestration/OpenAgent surfaces, voice settings, and extension management;
- Electron, web/PWA, mobile, and VS Code surfaces where the fork supports them.

An upstream or Pi implementation may replace a fork implementation only after focused review shows
equivalent user behavior, persistence, security boundaries, platform support, and tests. Partial
equivalence is supplemented; a materially divergent implementation is not adopted.

## Direct Pi-native refactor

OpenChamber currently exposes platform capabilities through `RuntimeAPIs`, while its conversation
sync, server lifecycle, session features, provider pages, scheduled tasks, and control service use
OpenCode SDK/HTTP types directly. Piarium does not preserve those contracts as a second permanent
layer. Inside the copied Piarium tree it will:

1. define one canonical set of Piarium-owned Pi domain types;
2. rewrite session/message/event synchronization and UI stores to consume those types;
3. rewrite provider/model/auth, agent, command, tool, permission, question, scheduling, and control
   flows against the existing Pi host protocol;
4. retain the fork's platform and product services while changing their engine data source;
5. delete OpenCode lifecycle/proxy/watcher/configuration/downloaded CLI and dead SDK-dependent code;
6. remove `@opencode-ai/sdk` after the last real consumer is migrated.

There is one runtime boundary between trusted application services and isolated Pi workers. There
is no OpenCode-shaped compatibility server layered on top of another Pi adapter.

Recovery attaches directly to Pi timeline entries. A user-message rollback targets the stable Pi
entry ID, restores that prompt into the Piarium composer, and delegates file restoration through
the versioned recovery bridge. The default policy is conversation only, conversation + files, or
always ask; detailed recovery management lives in the right sidebar and settings. Piarium ships
recommended controls for `pi-workspace-history` and `pi-wtf`, while accepting any package source
and displaying any provider that implements the bridge contract.

The primary Web/Desktop layout now reads the Pi catalog and Pi branch entries directly. Its
session tree, search, project grouping, streaming assistant state, tool executions, image prompts,
steering/follow-up queue, abort, rename, archive, restore, delete, and message rollback do not
project Pi data into OpenCode `Session`, `Message`, or `Part` objects. Remaining legacy surfaces
stay migration work, not a supported compatibility layer, and are deleted as their direct Pi
replacements land.

## Pi-native session features

Protocol version 14 owns Goal, Assist, pinned-context state, parent-session creation, and scoped Pi
package lifecycle operations as Piarium's native runtime ABI. Goal, Assist, and pinned-context state use
`PiSessionFeatureState`. The Pi
host persists each change as a versioned, append-only custom entry in the session JSONL and reads
the newest state visible from the active branch. Feature state is therefore branch-aware, travels
with the Pi session, and does not depend on OpenCode metadata, sidecar goal files, or projected
messages. A goal records its native cumulative token baseline so budget accounting remains stable
across restarts and compaction.

The host installs a hidden Pi extension for the two model-facing behaviors. `before_agent_start`
adds an active goal's objective to the effective system prompt, while the `context` hook restores
only pinned user or assistant entries that Pi compaction has removed. Pinned entries already in the
native context are not duplicated, and bookkeeping entries never enter model context or the visible
timeline.

The Web/Desktop server subscribes to the Pi runtime broker and implements one event-driven
automation loop. It audits quiet goal turns, persists progress before continuing, stops on errors,
aborts, token budgets, audit failures, or turn limits, and requires three consecutive blocked
verdicts before accepting a blocked outcome. Assist generation runs only after a settled latest
exchange. Scheduled tasks start a goal through the same protocol mutation, and completion
notifications are emitted from the settled goal result instead of from generic intermediate turns.
The former OpenCode-shaped `session-goal`, `session-assist`, `context-obligatory`, and
`permission-auto-accept` server implementations are deleted.

Pi executes tools through its extension runtime rather than OpenCode's permission-request stream.
Piarium therefore does not add an automatic approval policy for unrelated extension confirmation
UIs. Individual tools and packages keep their own explicit safety and confirmation behavior; if a
future Pi permission contract is introduced, it must be integrated as a Pi-native capability with
an independently reviewable policy.

## Pi agents, commands, prompts, and skills

Agents are a catalog, not a second universal configuration format. Piarium includes fallback
adapters for `pi-subagents` and Magic Context, and exposes the versioned
`piarium.agent-provider.discover/v1` event contract so any loaded Pi extension can register its own
provider. A provider-owned bridge takes precedence over Piarium's fallback adapter with the same
ID. Provider-specific configuration remains authoritative and opens the matching GUI adapter when
one exists; otherwise Piarium opens the native JSON/JSONC editor without projecting the plugin into
a reduced common schema.

Commands are the live slash-command catalog of the current Pi session or workspace. The host
combines extension commands, native `.md` prompt templates, and active skills; the settings page is
therefore read-only discovery and explanation, while invocation stays in chat. Prompts and skills
are managed through Pi's resource loader and their native roots. Piarium preserves loader ownership,
collision diagnostics, read-only package resources, complete skill directories, and project trust
instead of restoring the former OpenCode command/skill stores.

Pi Packages delegates install, update, removal, source normalization, and session reload to Pi's
native package manager. The UI exposes both user and project scopes, reports the installed manifest
version when available, and keeps local working copies linked instead of copying them. Local sources
are not presented as remotely updatable; their removal uses Pi's resolved package path so a
project-relative entry is removed from the same settings scope that created it.

## Mobile and embedded session surfaces

The dedicated mobile application and the context-panel iframe now mount the same `PiChatView`, Pi
interaction host, and endpoint-aware session store as the primary desktop surface. Neither root
creates an OpenCode `SyncProvider`. Mobile session grouping, parent/child expansion, search, pin
ordering, create/open/archive, edge-swipe navigation, deep links, widget snapshots, and worktree
deletion all operate on `SessionSummary` and Pi runtime methods. The worktree creation flow creates
Pi sessions directly and submits linked GitHub issue or pull-request context through Pi's native
prompt/instructions contract.

The iframe URL ABI is Piarium-owned: `piPanel`, `piSessionId`, `piDirectory`, and `piReadOnly`.
Legacy `ocPanel`/OpenCode-shaped aliases are deliberately not accepted. The parent still supplies
the authenticated runtime bootstrap through the same-origin message handshake, while the child
opens the target Pi session directly and keeps in-panel navigation stable.

## Server event and notification transport

The Web server no longer opens or exposes OpenCode `/event` or `/global/event` streams. Their SSE
readers, WebSocket bridges, replay hub, proxy/auth/relay allowlist entries, and orphaned
OpenCode-session notification trigger/template runtimes are removed. Pi session notifications are
derived from runtime-broker `session.snapshot` and `agent.event` envelopes.

The remaining transports have separate product ownership: `/api/piarium/runtime/ws` carries the Pi
runtime protocol, `/api/piarium/events` carries scheduled-task events, and
`/api/notifications/stream` carries UI notifications. Desktop relay proxying explicitly permits
those Pi-native endpoints and does not retain an OpenCode event alias.
