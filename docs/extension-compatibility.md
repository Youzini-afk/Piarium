# Maintained extension compatibility

Last verified: 2026-08-03

Piarium Phase 1 loads extensions through Pi `0.83.0` and its generic `ExtensionUIContext` bridge.
The smoke test creates an isolated agent directory and disposable workspace, loads one extension,
checks Pi diagnostics, lists its registered commands, disposes the runtime, and removes all test
state. It does not invoke network, model, recovery, or destructive commands.

| Extension | Version | Phase 1 load result | Registered commands observed |
| --- | --- | --- | --- |
| pi-wtf | 0.2.4 | Pass | `fuck`, `fuck?`, `fuck!` |
| pi-workspace-history | 0.2.2 | Pass | `undo`, `redo`, `checkpoint` |
| pi-subagents | 0.38.0 | Pass | 19 subagent and workflow commands |
| pi-mcp-adapter | 2.17.0 | Pass | `mcp`, `mcp-auth` |
| pi-web-access | 0.17.1 | Pass | `websearch`, `curator`, `google-account`, `search` |
| @cortexkit/pi-magic-context | 0.33.0 | Pass | 9 context, dream, and embedding commands |

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
- MCP consumes `pi-mcp-adapter/status/v1`, invokes the adapter's commands, and edits its native config
  sources without taking over merging, transports, OAuth, or the credential store;
- Web Access uses its native `web-search.json`; its current command catalog drives the Curator,
  Gemini Web account, and stored-result session actions, while search/fetch tools, plugin dialogs,
  widgets, and custom entries travel through the generic Pi extension bridge. Command discovery is
  not presented as provider health.

Packaged-runtime compatibility and richer extension-owned webviews still require release smoke
verification.
