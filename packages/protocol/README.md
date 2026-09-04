# @piarium/protocol

Piarium protocol types, schemas, and event/method definitions.

## Harness Events and Methods

### Broker Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `harness.request` | pi-host → host | Request a harness service; session identity comes from the broker actor, never this payload |
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
| `web.fetch` | `{ url, render? }` | `WebFetchResult` | Fetch a URL (SSRF-guarded) |
| `web.read` | `{ url }` | `WebReadResult` | Read a URL with reader model |
| `web.search` | `{ query }` | `WebSearchResult` | Web search |
| `zone2.assemble` | `{ sinceTurn }` | `{ content }` | Assemble Zone 2 context |
| `compaction.before` | `{ sessionId, firstKeptEntryId, tokensBefore }` | `CompactionBeforeResult` | Pre-compaction hook |
| `compaction.after` | `{ sessionId, summary, firstKeptEntryId, tokensBefore }` | `{ acknowledged }` | Post-compaction hook |
| `todo.upsert` | `{ items, confidence? }` | `{ text, confirmed?, askedConfirmation }` | Upsert todo items |
| `recall.search` | `{ query, k? }` | `{ text, results[] }` | Recall search |
| `thread.dispatch` | `{ role, task, scope? }` | `ThreadDispatchResult` | Dispatch a sub-agent thread |
| `thread.list` | `{ ids?, full? }` | `ThreadListResult` | List threads (incremental) |
| `thread.wait` | `{ ids?, timeoutMs? }` | `ThreadWaitResult` | Block until thread state change |
| `thread.send` | `{ threadId, message, from }` | `ThreadSendResult` | Send message to a thread |
| `thread.read` | `{ threadId, what?, since? }` | `ThreadReadResult` | Read thread notes/report/steps |
| `thread.merge` | `{ threadId }` | `ThreadMergeResult` | Merge completed thread's diff |
| `thread.kill` | `{ threadId, keepWorktree? }` | `ThreadKillResult` | Kill a thread |

### Thread Events

Two host events, both carrying state only — never message bodies.

| Event | Direction | Description |
|-------|-----------|-------------|
| `harness.thread.changed` | host → clients | Thread projection changed (`Thread` plus its current `ThreadRun`) |
| `harness.thread.done` | host → clients | Thread completed; carries the `ThreadReport` |

The registry raises them through its `onThreadChanged` / `onThreadDone`
callbacks. `onThreadDequeued` is a registry callback only, not a protocol
event: it asks the host to spawn a child session for a thread that was
waiting on a concurrency slot.

### Thread Lifecycle

```
queued → running → idle → waiting-for-input → done → merged → archived
                 ↘ failed                    ↘ cancelled
```

State transitions are validated by the registry; an invalid transition
throws. Reaching any terminal state frees a concurrency slot and may
promote the oldest queued thread.

### ShellExecResult Variants

| Kind | Fields | Description |
|------|--------|-------------|
| `completed` | `exitCode, durationMs, cwd, stdout, stderr, handle?, shown?` | Command finished |
| `background` | `id, waitedMs, cwd, outputSoFar` | Command backgrounded after waitMs |
| `spawn-failed` | `reason, interpreter, hint` | Shell could not start |

### HarnessSettings

Read once at session creation and frozen into the session snapshot, so a
settings change takes effect in the next session (plan §1.9).

```typescript
interface HarnessSettings {
  tools: Partial<Record<string, boolean>>;   // per-tool switch, default true
  shell: "auto" | "git-bash" | "powershell" | "wsl";
  output: { visibleBytes: number };          // default 32768
  bash: { waitMs: number };                  // default 60000
  models: Partial<Record<HarnessModelRole, ModelSelection>>;
  dispatch: { concurrency: number; askBefore: Partial<Record<string, boolean>> };
  knowledge: {
    eventRetentionDays: number;
    autoAcceptSuggestions: { workspace: boolean; user: boolean };
  };
  web?: { maxFetchesPerTurn?: number; render?: boolean };
  permissions?: { mode?: PermissionMode };   // default "normal"
  threadRuntime?: boolean;                   // default false — see harness-settings.ts
}
```

## Exports

- `harness.ts` — `HarnessServiceMap`, `HarnessMethod`, `HarnessError`, `HarnessRequestData` (no session identity; carries only the optional per-request `timeoutMs`), `HarnessActorIdentity`, `HarnessActorContext`, `HarnessCapability`, `HARNESS_METHOD_CAPABILITY`, `HARNESS_MAX_REQUEST_TIMEOUT_MS`, `ShellExecResult`, `OutputSlice`, `DiagnosticsResult`
- `harness-settings.ts` — `HarnessSettings`, `HarnessModelRole`, `ModelSelection`, `mergeHarnessSettings`
- `harness-roles.ts` — Role catalog: `RoleId`, `RoleDefinition`, `ROLE_DEFINITIONS`, `resolveRoles`, `buildTeamPrompt`. Shared because pi-host builds the `dispatch` team prompt from the resolved roles while the host builds threads from the same definitions
- `harness-threads.ts` — orthogonal `Thread` / `ThreadRun` protocol types, observer cursor, seven thread service DTOs, and `DEFAULT_TTL_TABLE` telemetry for the opt-in keepalive experiment (not a default wait schedule)
- `harness-tools.ts` — Tool-specific protocol types, `HARNESS_TOOL_META`
- `permission-gate.ts` — `PermissionPolicy`, `PermissionRule`, `evaluateGate`, `isHighRisk`, `HIGH_RISK_PATTERNS`, `defaultRules`, `mergePolicies`
- `types.ts` — `SessionStats` (includes `toolErrors`, `toolRetries`, `outputBytes`, `cacheHitRatio`)
