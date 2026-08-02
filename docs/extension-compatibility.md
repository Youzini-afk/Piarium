# Maintained extension compatibility

Last verified: 2026-08-02

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
npm run smoke:extension -- D:\path\to\extension\index.ts
```

The local plugin repositories must have their own locked dependencies installed. Magic Context
must build `packages/pi-plugin/dist/index.js` first. Its current `bun run build` cleanup glob fails
on Windows when `dist/*-*.js` has no match; invoking the documented `bun build` portion directly
produces the same split ESM output without changing that upstream repository.

This table proves generic loading and command registration only. Phase 4 owns feature-level
adapters, credentials, MCP OAuth/keyring behavior, web-provider workflows, subagent projection,
Magic Context native assets, degraded states, and packaged-runtime compatibility. Recovery now
preserves plugin ownership: Piarium discovers the current workspace-history and pi-wtf command/tree
capabilities, delegates operations to them, and accepts richer capabilities through recovery bridge
v1 without reading either plugin's private state.
