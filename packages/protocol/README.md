# @piarium/protocol

Piarium protocol types, schemas, and event/method definitions.

## Harness Events and Methods

### Broker Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `harness.request` | pi-host → host | Request a harness service |
| `harness.respond` | host → pi-host | Response to a harness request |
| `workspace.mutation.request` | pi-host → host | Request a file mutation (before/after) |
| `workspace.mutation.respond` | host → pi-host | Accept/reject a mutation request |

### Harness Service Methods

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `shell.exec` | `{ command, cwd?, waitMs?, runMs? }` | `ShellExecResult` | Execute a shell command |
| `shell.read` | `{ id, offset?, length? }` | `OutputSlice & { running, exitCode? }` | Read background shell output |
| `shell.write` | `{ id, text }` | `{ accepted }` | Write to background shell stdin |
| `shell.kill` | `{ id }` | `{ killed }` | Kill a background shell |
| `output.store` | `{ text, label? }` | `{ handle, total }` | Store large output |
| `output.read` | `{ handle, offset?, length? }` | `OutputSlice` | Read stored output |
| `search.content` | `{ pattern, limit?, contextLines? }` | `SearchContentResult` | Content search |
| `fs.lock` | `{ path, action, timeoutMs? }` | `{ held }` | Acquire/release path lock |
| `lsp.diagnostics` | `{ path, afterSnapshot?, waitMs? }` | `DiagnosticsResult` | Get diagnostics (sync + wait) |
| `lsp.diagnosticsSnapshot` | `{ path }` | `DiagnosticsResult` | Get diagnostics snapshot |

### ShellExecResult Variants

| Kind | Fields | Description |
|------|--------|-------------|
| `completed` | `exitCode, durationMs, cwd, stdout, stderr, handle?, shown?` | Command finished |
| `background` | `id, waitedMs, cwd, outputSoFar` | Command backgrounded after waitMs |
| `spawn-failed` | `reason, interpreter, hint` | Shell could not start |

### HarnessSettings

```typescript
interface HarnessSettings {
  shell: {
    setting: "auto" | "git-bash" | "powershell" | "wsl";
    discovered: { gitBashPath?, wslDistros?, hasBash?, hasPowerShell? };
  };
  output: {
    maxBytesPerSession: number; // default 256 MiB
    visibleBytes: number; // default 32768
  };
  tools: {
    grep: { enabled: boolean }; // default true
    bash: { enabled: boolean }; // default true
    applyPatch: { enabled: boolean }; // default true (OpenAI only)
  };
}
```

## Exports

- `harness.ts` — `HarnessServiceMap`, `HarnessMethod`, `HarnessError`, `ShellExecResult`, `OutputSlice`, `DiagnosticsResult`
- `harness-settings.ts` — `HarnessSettings` schema
- `harness-tools.ts` — Tool-specific protocol types
- `types.ts` — `SessionStats` (includes `toolErrors`, `toolRetries`, `outputBytes`, `cacheHitRatio`)
