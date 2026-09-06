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
| `output.store` | `{ text, label? }` | `{ ref: OutputRef, total }` | Store large output for the current Host generation |
| `output.read` | `{ handle, offset?, length? }` | `OutputSlice` | Read stored output |
| `search.content` | `{ pattern, limit?, contextLines? }` | `SearchContentResult` | Content search |
| `fs.lock` | acquire `{ paths[], timeoutMs? }`; release `{ leaseId }` | `{ held, leaseIds[] }` / `{ held: false, released }` | Acquire an ordered canonical path batch or release one owner-bound lease |
| `lsp.diagnostics` | `{ path, afterSnapshot?, waitMs? }` | `DiagnosticsResult` | Get diagnostics (sync + wait) |
| `lsp.diagnosticsSnapshot` | `{ path }` | `DiagnosticsResult` | Get diagnostics snapshot |
| `lsp.symbols` | `{ path, query }` | `LspNavigationResult` | Find workspace symbols using the path's language provider |
| `lsp.definition` | `{ path, line, character? }` | `LspNavigationResult` | Find a definition at a one-based position |
| `lsp.references` | `{ path, line, character? }` | `LspNavigationResult` | Find references at a one-based position |
| `lsp.hover` | `{ path, line, character? }` | `LspNavigationResult` | Read type/signature documentation at a one-based position |
| `web.fetch` | `{ url, render? }` | `WebFetchResult` | Fetch a URL (SSRF-guarded) |
| `web.search` | `{ query }` | `WebSearchResult` | Web search |
| `zone2.assemble` | `{ sinceTurn, branchEntryIds, memoryMode, afterEventId?, query?, contextUsage? }` | `{ content, eventCursor }` | Assemble branch-aware, cursor-based Zone 2 context |
| `compaction.before` | `{ firstKeptEntryId, tokensBefore, branchEntryIds, removedEntryIds, mode }` | `CompactionBeforeResult` | Verify keeper coverage before optional takeover |
| `compaction.after` | `{ summary, firstKeptEntryId, tokensBefore }` | `{ acknowledged }` | Post-compaction hook |
| `todo.upsert` | `{ items, branchEntryIds, confidence?, confirmed? }` | `{ text, confirmed?, askedConfirmation }` | Upsert the active branch plan after pi-host confirmation when needed |
| `recall.search` | `{ query, k? }` | `{ text, results[] }` | Recall search |
| `memory.blocks.get` | `{ branchEntryIds }` | `{ blocks[] }` | Resolve the closest visible block revision on the active branch |
| `memory.blocks.apply` | `{ cursorTurn, branchEntryIds, coveredEntryIds, ops[] }` | `MemoryApplyResult` | Atomically validate branch-local keeper operations and update coverage after full acceptance |
| `explore.search` | `{ question, paths?, limit? }` | versioned snippets + source issues + OutputRef | Search disk and the current fixed surface draft |
| `surface.snapshot.commit/release` | content-free `AgentInputContext` | lifecycle acknowledgement | Bind or release an opaque Documents snapshot after input delivery |
| `thread.dispatch` | `{ role, task, scope? }` | `ThreadDispatchResult` | Dispatch a sub-agent thread |
| `thread.list` | `{ ids?, full? }` | `ThreadListResult` | List threads (incremental) |
| `thread.wait` | `{ ids?, timeoutMs? }` | `ThreadWaitResult` | Block until thread state change |
| `thread.send` | `{ threadId, message, from }` | `ThreadSendResult` | Send message to a thread |
| `thread.read` | `{ threadId, what?, since? }` | `ThreadReadResult` | Read thread notes/report/steps |
| `thread.merge` | `{ threadId, resultRevision? }` | `ThreadMergeResult` | Integrate a fixed native result and identify disk, marker, or editor-surface conflicts |
| `thread.kill` | `{ threadId, keepWorktree? }` | `ThreadKillResult` | Kill a thread |

`agent.prompt`, `agent.steer`, and `agent.followUp` accept an optional
content-free `inputContext`. UI surfaces capture dirty document bodies through
the authenticated Documents API first; the runtime method carries only the
opaque Host reference or an unavailable dirty-path set. Omission means disk.

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
Thread.lifecycle: queued → active → settled → archived
Thread.attention: none | user | permission | stalled | looping
Thread.integration: none | dirty | merge-ready | conflict | merged
ThreadRun.workerState: starting → running → exited | lost
ThreadRun.outcome: success | failure | cancelled | lost
```

These axes are intentionally independent: a successful Run may leave its
Thread `merge-ready` or `conflict`, while a lost Run leaves durable work and
attention intact. `ThreadLaunchManifest` freezes the role's tool allowlist,
worktree mode, scope, prompt fragment, parent-block snapshot choice, parent
concurrency, and the Host-owned persistent editor-draft baseline identity.
The baseline body remains in WorkingState rather than the catalog or model
arguments, so queued and restarted Runs do not depend on the ephemeral surface
snapshot. Reaching a terminal Run frees a concurrency slot and may promote the
oldest queued Thread.

### ShellExecResult Variants

| Kind | Fields | Description |
|------|--------|-------------|
| `completed` | `exitCode, durationMs, cwd, stdout, stderr, handle?, shown?` | Command finished |
| `background` | `id, waitedMs, cwd, outputSoFar` | Command backgrounded after waitMs |
| `spawn-failed` | `reason, interpreter, hint` | Shell could not start |

### HarnessSettings

Most fields are resolved while the session runtime is assembled. Memory is the
intentional live exception: the user-owned global default is read on each hook
boundary and a durable session-wide override can select a mode or inherit again.

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
  memory: { mode: "off" | "assist" | "takeover" }; // user-only, default takeover
  web?: {
    maxFetchesPerTurn?: number;
    render?: boolean;
    search?: { provider: "brave" | "exa" | "tavily" | "jina" | "searxng"; endpoint?: string; credentialRef?: string };
  };
  permissions?: { mode?: PermissionMode };   // default "normal"
}
```

Legacy persisted `memory.shadowMode` values remain readable (`false` → `off`,
`true` → `assist`); new writes use `memory.mode`. `SessionSnapshot.harness.memory`
reports configured/effective mode, a session override, and the latest keeper or
compaction failure when the runtime supports the Harness.

Thread-runtime availability is not a user setting. The Application Host
advertises `capabilities.harnessThreads` in the private Host handshake; only
then does pi-host register the seven thread tools. Child sessions receive their
frozen role model and active tool list in `session.create/open`.
The same handshake owns `harnessLspNavigation`, `harnessWebRead`, and
`harnessWebSearch`. `harnessWebRead` means the Host permits a configured
session-local reader model to consume its guarded `web.fetch` result; model and
credential execution remains in pi-host. `harnessWebSearch` is advertised only
for a real search provider. A configured slot or dormant provider module alone
does not make those paths available.

## Exports

- `harness.ts` — `HarnessServiceMap`, `HarnessMethod`, `HarnessError`, `HarnessRequestData` (no session identity; carries only the optional per-request `timeoutMs`), `HarnessActorIdentity`, `HarnessActorContext`, `HarnessCapability`, `HARNESS_METHOD_CAPABILITY`, `HARNESS_MAX_REQUEST_TIMEOUT_MS`, `OutputRef`, `OutputSlice`, `ShellExecResult`, `DiagnosticsResult`
- `harness-settings.ts` — `HarnessSettings`, `HarnessModelRole`, `ModelSelection`, `mergeHarnessSettings`
- `harness-roles.ts` — Role catalog: `RoleId`, `RoleDefinition`, `ROLE_DEFINITIONS`, `resolveRoles`, `buildTeamPrompt`. Shared because pi-host builds the `dispatch` team prompt from the resolved roles while the host builds threads from the same definitions
- `harness-threads.ts` — orthogonal `Thread` / `ThreadRun` types, immutable `ThreadLaunchManifest`, observer cursor, seven thread service DTOs, and `DEFAULT_TTL_TABLE` telemetry for the opt-in keepalive experiment (not a default wait schedule)
- `harness-tools.ts` — Tool-specific protocol types, `HARNESS_TOOL_META`
- `utf8.ts` — browser-safe UTF-8 byte slicing used by Host output stores and pi-host truncation; returns `nextOffset` / `eof`
- `permission-gate.ts` — `PermissionPolicy`, `PermissionRule`, `evaluateGate`, `isHighRisk`, `HIGH_RISK_PATTERNS`, `defaultRules`, `mergePolicies`
- `memory-agent.ts` — shared memory-keeper settings, scheduler state/gate, operation DTOs, and strict model-output parser
- `types.ts` — `AgentInputContext` (disk or content-free surface snapshot reference), `SessionStats` (includes `toolErrors`, `toolRetries`, `outputBytes`, `cacheHitRatio`)
