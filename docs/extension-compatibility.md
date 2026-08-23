# Maintained extension integration

Status: integration contract, not a per-release certification

Last updated: 2026-08-22

## What this document is

This records **what Piarium depends on from each maintained Pi extension**: the commands, events,
RPC versions, and native configuration files an adapter reads or invokes. That is the surface that
breaks when a plugin changes, and it is the surface Piarium can be held to.

## What this document is not

It is not a certification that each plugin version works on each Pi version.

Piarium previously kept a dated table of plugin versions with pass/fail load results against one
exact Pi release. That does not scale: the plugins and Pi both move independently, so the table
becomes a claim nobody re-establishes, and a stale claim of verification is worse than no claim.
Piarium therefore does not assert per-release plugin compatibility, and a Pi upgrade is not gated on
re-smoking every plugin.

What is maintained instead:

- Adapters observe availability through a plugin's own public surface, so an incompatible or missing
  plugin degrades to an unavailable state rather than a broken page.
- Piarium never reads a plugin's private state, so a plugin's internal changes cannot silently
  corrupt Piarium behavior.
- Contract expectations that matter are asserted in code, under `packages/pi-host/test`, rather than
  written down as prose evidence.

If you want a load check for one extension, the harness is still there:

```sh
node scripts/smoke-extension.mjs <path-to-extension-entry>
```

It creates an isolated agent directory and disposable workspace, loads one extension, lists its
registered commands and public read-only MCP catalog when present, then disposes and removes all
test state. It invokes no network, model, recovery, or destructive commands, so it proves entry-point
loading and command registration and nothing more. Published tarballs work when their `pi.extensions`
entries and production dependencies are present.

## Integration surface per extension

Each row is the public contract Piarium consumes. Piarium owns none of these files or commands.

| Extension | Piarium consumes | Native authority |
| --- | --- | --- |
| `pi-wtf` | Registered prompt-repair commands | Plugin-owned `wtf.json` |
| `pi-workspace-history` | `session_before_tree` hook plus registered undo/redo/checkpoint commands | Plugin-owned history store |
| `pi-subagents` | Public `subagents:rpc:v1` with advertised `fleetStatus: { version: 1 }`; provider-owned agent management tool | Scoped Pi `settings.json`, Agent Markdown, and global runtime JSON |
| `pi-background-tasks` | Public EventBus v1 `request`/`response`/`terminal` for Fleet run, bounded logs, kill | Plugin-owned task store |
| `pi-mcp-adapter` | Public `status/v1` snapshots and read-only `configCatalog/v1`; adapter commands | Adapter-reported JSON/JSONC sources (six in normal mode, one in exclusive mode) |
| `pi-web-access` | Registered command catalog for Curator, account diagnostics, stored results | Agent-level `web-search.json` |
| `@cortexkit/pi-magic-context` | Registered `ctx-*` commands; native Pi status component; public custom entries | CortexKit user/project JSONC |
| `pi-openai-codex-compat` | Registered settings command | Global and project `openai-codex-compat.json` |
| `pi-observational-memory` | Registered status/view commands | Native `settings.json#observational-memory` |
| `context-mode` | Generic plugin configuration surface | No single authoritative settings file |
| `pi-lens` | Registered Lens commands and packaged skill commands | Plugin-owned user/recent-project config |
| `@gotgenes/pi-permission-system` | Registered permission command; run-surface controls | Global and project policy files |
| `pi-hermes-memory` | Presence of `memory-insights` in `command.list` | Agent-root `hermes-memory-config.json` |
| `@cortexkit/aft-pi` | Presence of `aft-status` in `command.list` | CortexKit user `aft.jsonc`, project `.cortexkit/aft.jsonc` |
| `pi-rtk-optimizer` | Presence of the exact `rtk` command | `<agentDir>/extensions/pi-rtk-optimizer/config.json` |

## Ownership rules the adapters keep

- **Recovery** discovers the current `pi-workspace-history` and `pi-wtf` capabilities, delegates to
  them, and accepts richer capabilities through recovery bridge v1 without reading private state.
- **Fleet** is a registry of Host adapters keyed by `providerId + key`. One degraded provider does
  not hide another. The public DTO carries kind, state, name, and advertised actions only; private
  paths, PIDs, output files, and plugin kill messages never reach the renderer, and Piarium does not
  read `.pi/tasks` or parse terminal text.
- **MCP** consumes the adapter's status and effective-server projection and edits one revisioned
  native source at a time. Piarium never merges the sources in the renderer and never handles
  transports, OAuth, or the credential store. The catalog excludes arguments, environment, headers,
  tokens, OAuth data, and URL credentials.
- **Magic Context** invokes registered `ctx-*` commands and renders only their public entries or UI.
  No private database is inspected.
- **Web Access**, **Codex Compat**, **Observational Memory**, **AFT**, **Hermes Memory**, and **RTK
  Optimizer** each edit only their own native configuration, preserving unknown and future fields.
  Runtime observation is command presence only; command presence proves the extension loaded, not
  that an external binary, provider, or background subsystem is healthy.
- **Availability is reported truthfully.** Transport failure, no active session, an unavailable
  provider, and a successful-but-empty observation stay distinct. No generic loaded or
  reload-needed state is invented where Pi exposes no such contract.

## Version relationships worth knowing

Some upstream metadata does not match Piarium's bundled runtime, and that is recorded rather than
worked around:

- `pi-rtk-optimizer` declares peer support that stops well below Piarium's bundled Pi. Piarium
  integrates the published `npm:pi-rtk-optimizer` package directly and maintains neither a fork nor
  an old-Pi compatibility layer, so the narrower peer range is upstream metadata, not a blocker.
- `pi-openai-codex-compat` declares a Pi range that Piarium's bundled runtime satisfies. Its
  provider transport and remote compaction are network paths that entry-point loading does not
  exercise, so Piarium does not describe them as verified.

The bundled Pi version is declared once, in `packages/pi-host/package.json`, and read from there by
the handshake tests. Do not copy it into new assertions or documents.
