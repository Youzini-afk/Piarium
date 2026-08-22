# Community extension adaptation execution plan

Status: delivered; kept as the per-adapter ownership record

Last updated: 2026-08-22

## 1. Objective

Finish the remaining community-extension work as independent, reviewable phases without changing
the ownership model already established in Piarium:

- Pi packages remain Pi packages. Installing, enabling, disabling, updating, and removing them stays
  on **Pi Packages**.
- Piarium adapters remain separately disableable Piarium extensions. Disabling a GUI adapter must
  not disable or uninstall the Pi package.
- Native plugin files and public plugin runtime contracts are authoritative. Piarium must not copy a
  plugin's state into a second settings store, infer state from terminal text, or read private
  SQLite/artifact directories.
- A missing source key stays absent. Rendering a control must not write the plugin's default value.
- Unknown and future native fields round-trip unchanged. A plugin-specific Quick form and the raw
  Advanced editor are two views over one draft, one revision, and one save.

Each phase is delivered against the existing worktree and preserves unrelated or parallel changes.

## 2. Delivery record

The adapters were delivered as separate phases, each one commit:

| Phase | Result |
| --- | --- |
| Compatibility baseline | Package-entry smoke evidence against the then-bundled Pi |
| Native config synchronization | Revisioned drafts, external-change watches, dirty preservation |
| `pi-lens` | Native global/ancestor-project authorities and command observation |
| `@gotgenes/pi-permission-system` | Scoped native JSONC policy adapter |
| `@cortexkit/aft-pi` | Native CortexKit authorities and session-worker cwd correctness |
| `pi-hermes-memory` | Agent-root native authority, settings and runtime panels, all locales |

The integration surface each adapter consumes is recorded in
[extension-compatibility.md](extension-compatibility.md). The sections below keep the per-adapter
native-authority reasoning, because that is what a future adapter has to match.

## 3. Constraints that hold for every adapter

- Adapters do not import a sibling package's `src` directory; they consume its public export.
- An extension schema is not duplicated in the renderer.
- Peer-dependency evidence is reported, not suppressed.
- No compatibility branch is added for an old plugin protocol.
- Full packaging, Docker, and Electron smoke belong to release convergence, not to an adapter change.

## 4. `pi-hermes-memory`

### 4.1 Native authority

Hermes 0.9.6 reads exactly:

```text
<active Pi agent directory>/hermes-memory-config.json
```

Its `AGENT_ROOT` is derived from `PI_CODING_AGENT_DIR`; Piarium already propagates the selected
agent directory through that variable. Make the Host resolve this authority rather than asking the
renderer to guess the root.

How the authority is wired:

- Add `hermes-memory-user` to `PiConfigTextAuthorityId` in
  `packages/protocol/src/types.ts`.
- Accept only that literal in the closed validators in:
  - `packages/pi-host/src/host-controller.ts`;
  - `packages/runtime-broker/src/runtime-dispatcher.ts`.
- Extend `resolveConfigTextAuthority` so it receives the active `agentDir` as an explicit input.
  Resolve `hermes-memory-user` to `join(agentDir, "hermes-memory-config.json")`, format `json`, with
  that exact path as the watch target. Do not derive the directory again from `HOME`.
- Pass `this.#agentDir` from every SessionHost authority read, update, and watch call.
- The Hermes authority is global and must not use the project-trust gate.
- Add Host coverage proving the returned path uses a custom agent directory, JSONC is rejected,
  revision conflicts preserve the newer file, external writes emit `config.changed`, and a symlink
  target is rejected by the existing authority boundary.
- Extend the runtime-dispatcher authority test to prove the new closed literal routes and an arbitrary
  renderer-provided path still fails.

Do not add a project Hermes authority. Its project Markdown directories and SQLite search store are
data, not settings.

### 4.2 `projectsMemoryDir` parity

Switch `HermesMemorySettings` from generic `root: "agent"` plus a guessed path to:

```ts
{ authority: "hermes-memory-user", format: "json" }
```

The authority snapshot returns the absolute config path, so its directory is the active agent root.
Pass that path into Hermes draft validation.

The validator must mirror `normalizeProjectsMemoryDir` from Hermes 0.9.6 rather than enforce a
Piarium-only rule:

- accept a non-empty one-level relative directory name;
- accept equivalent normalized relative spellings such as `./team` and `nested/../team` when they
  normalize to one safe segment;
- accept an absolute path whose normalized location is exactly one child directory of the active
  agent root;
- accept either Windows or POSIX path style according to the authority path;
- reject the agent root itself, a directory outside it, a nested two-level child, an unresolved
  leading `..`, an empty value, and NUL-containing input;
- do not reject a `~` spelling merely because the browser cannot independently recover the remote
  Host's home directory. It may be left to the native loader unless the Host supplies enough
  information to decide it exactly.

Required focused examples:

```text
relative: projects-memory                         -> valid
relative: ./team                                  -> valid
relative: nested/../team                          -> valid
POSIX:    /home/u/.pi/agent/team                  -> valid for /home/u/.pi/agent
Windows:  C:\Users\u\.pi\agent\team               -> valid for C:\Users\u\.pi\agent
root:     /home/u/.pi/agent                       -> invalid
outside:  /home/u/team                            -> invalid
nested:   /home/u/.pi/agent/team/nested           -> invalid
escape:   ../team                                 -> invalid
```

Update `projectsMemoryDirInfo` in all ten settings dictionaries so it says that the value is one
directory under the active Pi agent directory and may be a relative name or an absolute path inside
that root. Preserve technical tokens and placeholders.

### 4.3 Public package boundary

Restore this import in `packages/ui/src/lib/extensions/pi-integration-registry.test.ts`:

```ts
import { PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS } from '@piarium/extension-builtins';
```

Build `packages/extension-builtins` before the registry test. The test must fail when the package's
published build omits the Hermes manifest; it must not bypass that signal with a sibling `src`
import. Build output remains generated output and is committed only if the repository already tracks
it.

### 4.4 Phase 6 acceptance

- The only Hermes settings authority is the selected agent directory's
  `hermes-memory-config.json`.
- Direct edits made by an agent or user refresh a clean draft; a dirty draft remains intact; stale
  save returns a revision conflict.
- Missing keys remain absent and unknown keys remain byte-preserved by JSON path edits.
- Native-valid absolute `projectsMemoryDir` values no longer block unrelated saves.
- Modern `memoryOverflowStrategy` wins without deleting legacy `autoConsolidate`.
- Runtime availability means only that `memory-insights` is registered in the active session; it does
  not claim database or review-worker health.
- The built-in adapter is discoverable through the public `@piarium/extension-builtins` package.
- All ten locales have the complete Hermes key set, matching placeholders, and no ordinary English
  fallback.

Focused verification:

```powershell
bun test packages/ui/src/components/sections/plugin-settings/hermes-memory-config-model.test.ts `
  packages/ui/src/components/sections/plugin-settings/hermes-memory-runtime.test.ts `
  packages/ui/src/components/sections/plugin-settings/plugin-runtime-status.test.ts `
  packages/ui/src/components/sections/plugins/recommended-packages.test.ts `
  packages/ui/src/lib/settings/plugin-settings-navigation.test.ts `
  packages/ui/src/lib/i18n/messages/i18nParity.test.ts

bun run --cwd packages/extension-builtins build
bun test packages/ui/src/lib/extensions/pi-integration-registry.test.ts
bun test packages/pi-host/test/config-text-authority.test.ts
bun test packages/runtime-broker/test/runtime-dispatcher-config-authority.test.ts

bun run --cwd packages/protocol type-check
bun run --cwd packages/pi-host type-check
bun run --cwd packages/runtime-broker type-check
bun run --cwd packages/extension-builtins type-check
bun run --cwd packages/ui type-check
```

Changed-file ESLint is enough here; the whole workspace is not.

## 5. Provider-neutral Fleet and `pi-background-tasks`

### 5.1 Product result

`pi-background-tasks@2.4.2` is not primarily a settings-file plugin. Its valuable stable integration
surface is the public EventBus v1 service. Adapt it into **Fleet**, not into a fabricated Plugin
Settings schema.

Fleet must become a provider-neutral work surface that can show:

- active delegated agents from `pi-subagents`;
- running and recent background agents and shell tasks from `pi-background-tasks`;
- provider state independently for each source;
- task detail, bounded logs on explicit request, and stop for a running background task;
- a provider-level “new background task” action using the plugin's public `run` operation.

Do not read `.pi/tasks`, delegate artifacts, Fusion artifacts, task metadata JSON, or output files
directly. Do not parse `/jobs`, `/logs`, `/kill`, the footer widget, or rendered terminal-notification
text. The structured EventBus terminal frame below is the authoritative completion signal.

### 5.2 Authoritative EventBus contract

Use the extension's published v1 channels and exact closed schemas:

```text
request:  pi-background-tasks:request:v1
response: pi-background-tasks:response:v1
terminal: pi-background-tasks:terminal:v1
```

Supported operations are `capabilities`, `run`, `status`, `logs`, and `kill`.

Important invariants the bridge must preserve:

- request IDs are unique within a session generation;
- responses are correlated by `request_id` on the shared response channel;
- a run/kill response is observed before an immediate terminal publication is released;
- terminal frames are published only after task output is closed and terminal metadata is durable;
- terminal delivery is at least once if an EventBus listener throws, so deduplicate by `task.id`;
- session change or shutdown rejects every pending request and removes listeners;
- no request is sent before the session has started;
- closed schemas reject unknown fields rather than silently projecting them.

The plugin has no ready event. Discover it by issuing `capabilities` after session start. A no-listener
request otherwise never settles, so the bridge needs a liveness deadline. Use separate constants and
document their basis: capabilities/status/logs are in-process and bounded operations; kill's own
registry stop path is 4.5 seconds. A five-second discovery/read deadline and ten-second kill deadline
are acceptable defaults because they prevent an absent extension from hanging Fleet while leaving
headroom over the plugin's own stop contract. Do not reuse these values as task execution limits.

### 5.3 Host architecture

Replace the one-provider ownership hidden inside `PiSubagentsFleetBridge` with a registry of Host-side
Fleet adapters. Suggested contract:

```ts
interface FleetProviderAdapter {
  readonly id: string;
  attach(events: ExtensionAPI['events']): () => void;
  startSession(sessionId: string): void;
  endSession(): void;
  status(sessionId: string): Promise<PiFleetProviderResult>;
  action?(request: PiFleetProviderActionRequest): Promise<PiFleetProviderActionResult>;
}
```

The registry, not an individual provider, owns aggregation:

- run providers independently so one degraded provider does not hide another;
- merge entries with a composite identity of `providerId + key`;
- sum visible/omitted counts only after each adapter validates its own reply;
- preserve `active`, `degraded`, `incompatible`, and `unavailable` per provider;
- dispatch an action only to the named provider and current session generation.

Keep the existing `pi-subagents` wire parser and tests, but move it behind this adapter interface.
Do not weaken its `fleetStatus v1` handshake or expose the private run ID/status text it currently
drops.

Add a `pi-background-tasks` adapter that validates EventBus v1 itself. Do not import the community
package as a Piarium runtime dependency. The protocol implementation belongs in Piarium and is
tested against fixtures matching the public contract.

Expected write map:

- shared contract owner: `packages/protocol/src/types.ts`, `methods.ts`, and `runtime.ts`;
- Fleet provider ownership: replace or split
  `packages/pi-host/src/pi-subagents-fleet-bridge.ts`, add the registry and background-task adapter,
  and integrate them only through `packages/pi-host/src/session-host.ts`;
- untrusted renderer request validation: `packages/runtime-broker/src/runtime-dispatcher.ts`;
- renderer transport: `packages/ui/src/lib/pi-runtime/fleet.ts`;
- workbench: `packages/ui/src/components/sections/fleet/FleetPage.tsx` and focused presentation/form
  helpers in the same directory;
- built-in ownership and recommendation: `packages/extension-builtins/src/index.ts`,
  `packages/ui/src/lib/extensions/builtin-pi-integrations.tsx`, and
  `packages/ui/src/components/sections/plugins/recommended-packages.ts`;
- locale/search/documentation updates remain in their existing registries.

Do not create a second Fleet store in the UI. `fleet.status`, action results, and the existing active
session identity remain the authority. Do not put plugin wire parsing in `FleetPage.tsx`.

### 5.4 Piarium Fleet protocol

Evolve `PiFleetEntry` so it represents work rather than assuming every item is an active subagent.
The public DTO should contain only presentation/action data:

```ts
type PiFleetEntryKind = 'delegated-agent' | 'background-agent' | 'background-task';
type PiFleetEntryState = 'running' | 'completed' | 'failed' | 'stopped';

interface PiFleetEntry {
  key: string;
  providerId: string;
  kind: PiFleetEntryKind;
  state: PiFleetEntryState;
  name: string;
  description?: string;
  agent?: string;
  role?: string;
  model?: string;
  effort?: string;
  startedAt: number;
  endedAt?: number;
  bytesWritten?: number;
  tokens?: { input: number; output: number; total: number };
  error?: string;
  actions: PiFleetActionDescriptor[];
}
```

The exact final spelling may follow existing protocol conventions, but these semantics are required:

- subagents remain `delegated-agent`, `running`, with their current token data;
- `isAgent:true` background tasks become `background-agent`;
- ordinary background commands become `background-task`;
- `killed` maps to `stopped`, not `failed`;
- absent telemetry remains absent, never zero;
- do not expose `command`, `cwd`, `outputPath`, attestation paths, delegate/Fusion artifact paths,
  raw tool-name maps, PIDs, or plugin-private run IDs to the renderer;
- an error from the plugin's public snapshot may be displayed, but Piarium must not enrich it by
  reading private files.

Add one provider-neutral runtime method:

```text
fleet.action
```

Its request names `sessionId`, `providerId`, `action`, optional `entryKey`, and provider-owned JSON
input. The Host registry validates provider/session ownership, then the selected adapter validates
the action-specific payload. The result contains success/message, optional bounded display data, and
the refreshed Fleet snapshot. Unknown providers, entries, actions, and fields fail explicitly.

Required `pi-background-tasks` actions:

- provider `run`: exact native fields `name`, `command`, `isAgent`, `notifyOnCompletion`,
  `triggerOnCompletion`, optional positive-integer `timeoutSeconds`;
- entry `logs`: use the plugin default bounded tail read; return only `text`, byte count, truncation,
  tail/head state, and the refreshed entry—never the full output path;
- entry `kill`: only while running; map the returned terminal task back into the refreshed snapshot.

Do not add a second Piarium limit to log text: the plugin owns its 50 KiB model-visible cap. The Host
should merely omit the private path.

### 5.5 Fleet UI

Keep Fleet as a master/detail workbench:

- left: provider filter, state/kind filter, search, and work list;
- right: selected work details and actions;
- mobile: list stage, then detail stage with a clear back action;
- provider status is visible but is not the left-hand primary list;
- new background task opens a focused form only when the active provider advertises `run`;
- logs load only after the user asks and are not retained as a global status cache;
- stop is a destructive confirmation tied to the selected running entry;
- terminal or action completion refreshes the selected entry without remounting the page;
- `pi-subagents` inspector/stop/doctor commands remain available where they are the only public
  operation, but background-task actions use EventBus v1 directly.

Add all new labels to all ten locales and add the same non-English exact-copy/placeholder audit used
by recent adapters.

### 5.6 Package recommendation and runtime observation

Add:

```text
npm:pi-background-tasks
```

to Recommended Integrations only after the EventBus adapter is active in the same commit. Do not add
a fake native configuration form. Its Pi Package card may navigate to Fleet when installed and active;
the generic raw editor remains available if a user deliberately selects a native document.

Runtime state must distinguish:

- package installed but no live session;
- live session without EventBus v1;
- compatible and active EventBus;
- a valid provider whose latest request failed;
- another Fleet provider remaining healthy while this one is degraded.

### 5.7 Phase 7 acceptance

- A real EventBus fixture returns capabilities and mixed running/recent tasks through `fleet.status`.
- An immediate-exit run response is visible before its terminal update.
- Repeated terminal frames for one task do not duplicate the Fleet row.
- Session replacement rejects stale requests and a late response cannot update the new session.
- Malformed/unknown-key frames degrade only `pi-background-tasks`.
- pi-subagents behavior and privacy projection remain unchanged.
- Explicit logs return plugin-bounded text without exposing its local file path.
- Stop and new-task actions use EventBus v1, not commands or filesystem access.
- The Fleet page works with either provider alone and both providers together.

Focused verification should cover the protocol types, both provider parsers, registry aggregation,
Host session lifecycle, runtime-dispatch validation, Fleet presentation/actions, recommendation, and
i18n. Then type-check/lint only protocol, pi-host, runtime-broker, extension-builtins, and UI.

## 6. `pi-rtk-optimizer`

`pi-rtk-optimizer@0.9.0` still publishes a peer range ending at Pi 0.80:

```text
@earendil-works/pi-coding-agent: ^0.74 ... ^0.80
@earendil-works/pi-tui:          ^0.74 ... ^0.80
```

Piarium now treats that declaration as upstream metadata rather than an adapter/recommendation
blocker because the package entry point and exact `rtk` command registration were verified on the
Pi bundled at the time (`0.84.1`). The adaptation consumes `npm:pi-rtk-optimizer` directly. It does
not suppress the recorded peer evidence, pin an old Pi SDK, maintain a fork, or add a v0.80
compatibility branch.

The native adapter provides:

- closed authority `<agentDir>/extensions/pi-rtk-optimizer/config.json`;
- strict JSON, revision/watch semantics, no project authority invented;
- Quick controls for master enable, rewrite/suggest mode, missing-binary guard, notifications, and the
  current output-compaction tree;
- exact native ranges only: smart truncation 40–4000 lines and hard truncation 1000–200000 chars;
- preserve unknown keys and legacy config shapes in Advanced;
- observe only the registered `rtk` command for runtime availability;
- use `/rtk show`, `/rtk verify`, `/rtk stats`, and `/rtk clear-stats` as immediate actions, without
  parsing notifications into authoritative state;
- do not claim the external `rtk` binary is available until the plugin reports it through a stable
  public contract; command presence proves only that the extension loaded.

## 7. Convergence before a community release

Convergence is documentation and release evidence, not another feature expansion. What it covers:

- update `docs/extension-compatibility.md` with the exact versions and what was actually exercised;
- update `docs/plugin-gui-design.md`, `docs/architecture.md`, and `docs/roadmap.md` so Fleet is no
  longer described as pi-subagents-only and Hermes is marked complete;
- list both `pi-background-tasks` and the verified `npm:pi-rtk-optimizer` source in recommendations;
- ensure every built-in adapter manifest is exported by the built `@piarium/extension-builtins`
  artifact and survives disable/enable without disabling the Pi package;
- rerun the reusable selected-runtime package-entry smoke for all recommended community packages;
- exercise one real background task lifecycle: run, status, bounded logs, terminal delivery, and kill;
- run one production Web build and one Windows desktop package/smoke only after all commits are on
  `main`;
- run the high-value CI workflow once and inspect its actual failing step rather than repeating local
  suites already covered by focused tests.

Publishing a GitHub Release is a separate decision that needs the release version, changelog,
installer set, checksums, and rollback tag in hand. Convergence produces a release candidate on
`main` with truthful evidence, nothing more.

## 8. The invariants worth re-checking

Reviewing this work is best spent on the three boundaries where a regression would be silent, rather
than on re-running suites that focused tests already cover:

- Hermes native authority and path parity between local and remote hosts;
- Fleet EventBus ordering and session isolation;
- the public-package build boundary, so an adapter manifest that exists only in `src` cannot appear
  to work.

No private plugin database or artifact directory is a Piarium authority. That is the property most
easily lost to a convenience shortcut, and it is asserted in the adapter tests rather than here.
