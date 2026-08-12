# Maintained extension compatibility

Last verified: 2026-08-12

Piarium Phase 1 loads extensions through Pi `0.84.1` and its generic `ExtensionUIContext` bridge.
The smoke test creates an isolated agent directory and disposable workspace, loads one extension,
checks Pi diagnostics, lists its registered commands and public read-only MCP catalog when present,
disposes the runtime, and removes all test state. It does not invoke network, model, recovery, or
destructive commands.

| Extension | Version | Phase 1 load result | Registered commands observed |
| --- | --- | --- | --- |
| pi-wtf | 0.2.4 | Pass | `fuck`, `fuck?`, `fuck!` |
| pi-workspace-history | 0.2.2 | Pass | `undo`, `redo`, `checkpoint` |
| pi-subagents | 0.38.0 | Pass | 19 subagent and workflow commands |
| pi-mcp-adapter | 2.23.0 + Piarium `62255b3` | Pass | `mcp`, `mcp-auth`; read-only `configCatalog/v1` RPC |
| pi-web-access | 0.17.1 | Pass | `websearch`, `curator`, `google-account`, `search` |
| @cortexkit/pi-magic-context | 0.33.0 | Pass | 9 context, dream, and embedding commands |
| pi-openai-codex-compat | 0.0.7-alpha.0 | Pass | `codex-settings` |
| pi-observational-memory | 3.0.4 | Pass | `om:status`, `om:view` |

`pi-openai-codex-compat@0.0.7-alpha.0` declares Pi `>=0.84.0 <0.85.0`; Piarium's Pi `0.84.1`
runtime now satisfies that contract. The Phase 1 smoke above still proves entry-point loading and
command registration only. Codex provider transport and remote compaction require an authenticated,
provider-specific integration check before Piarium claims that network path as verified.

Run the reusable smoke harness after building Piarium:

```powershell
node scripts/smoke-extension.mjs D:\path\to\extension\index.ts
```

The local plugin repositories must have their own locked dependencies installed. Magic Context
must build `packages/pi-plugin/dist/index.js` first. Its current `bun run build` cleanup glob fails
on Windows when `dist/*-*.js` has no match; invoking the documented `bun build` portion directly
produces the same split ESM output without changing that upstream repository.

The table proves generic loading and command registration. Current feature integration also keeps
plugin ownership intact:

- recovery discovers the current workspace-history and pi-wtf command/tree capabilities, delegates
  operations to them, and accepts richer capabilities through recovery bridge v1 without reading
  either plugin's private state;
- Fleet handshakes with pi-subagents' public `subagents:rpc:v1`, requires its advertised
  `fleetStatus: { version: 1 }`, and projects only the bounded public display entries. The local
  `0.38.0` smoke returned an active provider through this real RPC path;
- the Magic Context `0.33.0` smoke exposes all nine current Pi commands used by the adapter. Session
  operations invoke those registered commands and render only their public custom entries or UI;
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

Packaged-runtime compatibility and richer extension-owned webviews still require release smoke
verification.
