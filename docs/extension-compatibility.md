# Maintained extension compatibility

Last verified: 2026-08-19

Piarium Phase 1 loads extensions through Pi `0.84.1` and its generic `ExtensionUIContext` bridge.
The smoke test creates an isolated agent directory and disposable workspace, loads one extension,
checks Pi diagnostics, lists its registered commands and public read-only MCP catalog when present,
disposes the runtime, and removes all test state. It does not invoke network, model, recovery, or
destructive commands.

| Extension | Version | 2026-08-19 npm-pack load | Registered commands observed |
| --- | --- | --- | --- |
| pi-wtf | 0.2.4 | Pass | `fuck`, `fuck?`, `fuck!` |
| pi-workspace-history | 0.2.2 | Pass | `undo`, `redo`, `checkpoint` |
| pi-subagents | 0.51.0 | Pass; Fleet provider `active` | 17 subagent and workflow commands, including `subagents-fleet` |
| pi-mcp-adapter | 2.26.1 | Pass | `mcp`, `mcp-auth` |
| pi-web-access | 0.24.0 | Pass | `websearch`, `curator`, `google-account`, `search` |
| @cortexkit/pi-magic-context | 0.38.0 | Pass | 10 commands: the previous `ctx-*` set plus `todos` |
| pi-openai-codex-compat | 0.0.7-alpha.0 | Pass | `codex-settings` |
| pi-observational-memory | 3.0.4 | Pass | `om:status`, `om:view` |
| context-mode | 1.0.169 | Pass | `ctx-stats`, `ctx-doctor` |
| pi-lens | 4.0.1 | Pass | 9 Lens commands plus four packaged skill commands |
| @gotgenes/pi-permission-system | 26.3.0 | Pass | `permission-system` |
| pi-hermes-memory | 0.9.6 | Pass | 10 memory, search, skill, and maintenance commands |
| pi-background-tasks | 2.4.2 | Pass; EventBus provider `active` on `extensions/background-tasks.ts` | 10 background/Fusion/log commands on the work entry; `claude-cache` on `extensions/anthropic-attribution.ts` |
| @cortexkit/aft-pi | 0.51.2 | Pass | `aft-status` |
| pi-rtk-optimizer | 0.9.0 | Pass | `rtk` |

`pi-openai-codex-compat@0.0.7-alpha.0` declares Pi `>=0.84.0 <0.85.0`; Piarium's Pi `0.84.1`
runtime now satisfies that contract. The npm-pack smoke above still proves entry-point loading and
command registration only. Codex provider transport and remote compaction require an authenticated,
provider-specific integration check before Piarium claims that network path as verified.

On 2026-08-19 the published `pi-rtk-optimizer@0.9.0` peer range was rechecked on npm
(`registry.npmjs.org/pi-rtk-optimizer/latest`) and GitHub `MasuRii/pi-rtk-optimizer` `main`
`package.json`. Both still declare:

```text
@earendil-works/pi-coding-agent: ^0.74.0 || ^0.75.0 || ^0.78.0 || ^0.79.0 || ^0.80.0
@earendil-works/pi-tui:          ^0.74.0 || ^0.75.0 || ^0.78.0 || ^0.79.0 || ^0.80.0
```

Piarium's bundled Pi is `0.84.1`. The package has been verified to load its entry point and register
`rtk` on that runtime, so the older peer declaration is recorded as upstream metadata rather than a
Piarium recommendation or adapter blocker. Piarium integrates the published
`npm:pi-rtk-optimizer` package directly; it does not maintain an RTK fork or a Pi 0.80 compatibility
layer.

On 2026-08-19 Phase 9 reran `node scripts/smoke-extension.mjs` against npm-packed published
tarballs (production dependencies installed with `--ignore-scripts`) through Piarium's bundled Pi
`0.84.1`. Local plugin working trees were not required. The RTK entry-point verification proves
extension loading and `rtk` command registration only; it does not prove that an external `rtk`
binary is installed. The generic smoke still does not invoke models, network calls, permission
decisions, memory search, or mutating tools.

A separate real `pi-background-tasks@2.4.2` Fleet lifecycle on the same Host exercised EventBus v1
`run` → `status` → bounded `logs` → `kill` for a Windows `ping` task. The public DTO stayed free of
`command`, `cwd`, `pid`, `outputPath`, and `logs.path`. Bounded log text is plugin-owned and may
include a relative `.pi/tasks/...` footer; Piarium does not parse that footer or open the file. The
kill confirmation is Host-owned (`Stopped <name>`). After kill, `fleet.status` reported `stopped`
while the provider remained `active`. Host EventBus fixtures covering capabilities, mixed status,
run-before-terminal, duplicate terminals, session isolation, malformed-frame degrade, and privacy
projection remain in `packages/pi-host/test`.

Earlier adapter-contract evidence that is still authoritative, and not replaced by the npm-pack
rerun:

- `pi-subagents@0.38.0` previously proved the live `subagents:rpc:v1` Fleet path; `0.51.0` now loads
  and still reports Fleet provider `active`.
- MCP `configCatalog/v1` / `status/v1` contract verification remains the Piarium-maintained plugin
  commit `62255b394e10c2d1ced621cd95abc457bec2a7f1`. Published `2.26.1` was entry-smoke only.
- Magic Context session operations still target the public `ctx-*` command set. `0.38.0` also
  registers `todos`; that command is not a first-class Piarium adapter action.
- An earlier AFT Windows smoke built `@cortexkit/aft-bridge` before `@cortexkit/aft-pi@0.51.2`,
  downloaded and SHA-256 verified `aft.exe`, and started the native bridge. The Phase 9 npm-pack
  rerun omitted install scripts, so it only reconfirmed `aft-status` registration.
- Hermes Memory startup still treats SQLite initialization as best effort; packaged-runtime ABI
  verification remains separate from this entry-point smoke.

Run the reusable smoke harness after building Piarium:

```powershell
node scripts/smoke-extension.mjs D:\path\to\extension\index.ts
```

Published tarballs work when their `pi.extensions` entries and production dependencies are present.
Local plugin repositories still need their own locked dependencies installed if you smoke a checkout
instead of a pack. Magic Context's published `0.38.0` tarball already includes `dist/index.js`.

The table proves generic loading and command registration. Current feature integration also keeps
plugin ownership intact:

- recovery discovers the current workspace-history and pi-wtf command/tree capabilities, delegates
  operations to them, and accepts richer capabilities through recovery bridge v1 without reading
  either plugin's private state;
- Fleet is a registry of Host adapters. `pi-subagents` still handshakes on public `subagents:rpc:v1`
  and requires advertised `fleetStatus: { version: 1 }`. `pi-background-tasks@2.4.2` is adapted only
  through EventBus v1 (`request`/`response`/`terminal`); Piarium never reads `.pi/tasks`, output
  files, or private SQLite. Host fixtures plus one real 2.4.2 run/status/logs/kill lifecycle prove
  that path. `pi-subagents@0.51.0` still returns an active Fleet provider through the real RPC path;
- the Magic Context `0.38.0` smoke exposes the current `ctx-*` command set plus `todos`. Session
  operations invoke the registered `ctx-*` commands and render only their public custom entries or UI;
  no private database is inspected;
- MCP consumes `pi-mcp-adapter/status/v1` and the adapter-owned read-only `configCatalog/v1`, invokes
  adapter commands, and edits one revisioned native config source without taking over merging,
  transports, OAuth, or the credential store. The Piarium-maintained plugin commit
  `62255b394e10c2d1ced621cd95abc457bec2a7f1` is the verified contract implementation;
- Web Access uses its native `web-search.json`; its current command catalog drives the Curator,
  Gemini Web account, and stored-result session actions, while search/fetch tools, plugin dialogs,
  widgets, and custom entries travel through the generic Pi extension bridge. Command discovery is
  not presented as provider health.
- OpenAI Codex Compat preserves separate global and trusted-project
  `openai-codex-compat.json` drafts, including explicit `null` compaction lifecycle state and unknown
  fields; Piarium does not infer environment overrides or assign cross-plugin compaction ownership;
- Observational Memory edits only the native user/project `settings.json#observational-memory`
  object. Threshold, pool, and worker-model validation blocks invalid saves without reading or
  rewriting the plugin-owned session ledger.
- AFT edits the Host-resolved CortexKit user `aft.jsonc` authority and the trusted project
  `.cortexkit/aft.jsonc` directly as revisioned JSONC. Project-only diagnostics mirror AFT's native
  strip and one-way sandbox rules; unknown fields and custom `bash` objects are preserved. Runtime
  observation checks only whether `command.list` contains `aft-status`. Piarium does not execute its
  `ctx.ui.custom` command, parse status output, read native indexes, or claim subsystem hot reload.
- Hermes Memory edits only the Host-resolved global `hermes-memory-config.json` under the active Pi agent
  directory. Unknown loader-ignored fields are preserved; complex and future fields remain in
  Advanced. Project memory directories, Markdown, and SQLite are data rather than configuration
  authorities. Runtime observation checks only for `memory-insights` in `command.list` and does not
  execute commands or infer memory-store or background-review health.
- RTK Optimizer edits only strict JSON at
  `<agentDir>/extensions/pi-rtk-optimizer/config.json`. Quick controls project the raw native draft,
  so absent values stay absent while unknown and legacy fields remain in Advanced. Runtime
  observation checks only for the exact `rtk` command. `/rtk show`, `verify`, `stats`, and
  `clear-stats` remain plugin-owned actions; Piarium does not parse their notifications or claim the
  external RTK binary is available.

Packaged-runtime compatibility and richer extension-owned webviews still require release smoke
verification. Phase 9 recorded a local production Web build (`bun run build:web`, exit 0). CI run
`32239724870` for `feat: integrate background tasks with Fleet` passed Ubuntu Source quality
(including `test:pi`) and Production build; Docker Images `32239724866` succeeded. The Windows
runtime job failed at `bun run test:pi`: libuv `fs-event.c` assertion
(`!_wcsnicmp(filename, dir, dirlen)`) aborted `packages/pi-host/test/config-text-authority.test.ts`,
and `runtime-broker` failed
`workspace configuration watches survive catalog context switches and cancel explicitly`. The same
Windows job also failed on the earlier docs-only `cc5b3e8` commit, so it is treated as a pre-existing
runner flake rather than a Fleet or Hermes regression.

`bun run electron:build:win` produced the unsigned Windows x64 NSIS installer and
`packages/electron/dist/win-unpacked`. `bun run electron:smoke:win` reached a healthy in-process
`/health` endpoint and completed one terminal create/close cycle, then twice failed waiting for
`window.__piariumAppReady`: the packaged renderer stayed on the localized startup-recovery screen
(`startup.initRecovery`). That renderer-ready failure is recorded as desktop bootstrap evidence, not
as a community-adapter regression, and was not turned into a bootstrap rewrite in this phase.
