# Agent harness 决策日志

Status: append-only log kept by the executing agent during agent-harness-plan.md; delete together with the plan

执行 [agent-harness-plan.md](agent-harness-plan.md) 时的判断记录。**做出判断的当下就追加一条**，不要等工作项结束——上下文
压缩后细节会丢，这个文件是压缩之后重新定位的依据。条目只追加，不改写旧条目；要更正就追加一条新的并引用旧编号。

## 条目格式

```text
### D-<编号> · <日期> · <工作项 id>
类型：偏离 | 实验结果 | 问题与解法 | 默认值调整 | 待问
决定：一句话说清做了什么。
原因：为什么这样，而不是参考形状那样。
考虑过的替代：列出并说明为何不选。
影响：动到的文件 / 契约 / 文档 / 其他工作项；需要回写到 agent-harness.md 或 plan 的位置。
状态：已实施 | 待验收 | 待回答
```

`类型：待问` 的条目对应 plan 0.1 里"停下来问"的三类情况；其余类型不需要等待回答，继续工作。

## 条目

### D-001 · 2026-09-03 · 0.1
类型：实验结果
决定：Pi 版本已对齐在 0.84.3，无需变更；计划中"node_modules 为 0.83.0"的描述是写作时的旧状态。
原因：`packages/pi-host/package.json`、`scripts/cloud-runtime.bun.lock`、`docs/security.md` 三处均为 0.84.3，`node_modules` 中 0.84.3 已安装且可用。
考虑过的替代：无。
影响：0.1 的版本对齐步骤直接通过，进入钩子形状复核。所有钩子形状（`before_agent_start` 可返回 `{ message, systemPrompt }`、`session_before_compact` 含 `preparation/branchEntries/reason` 且可返回 `{ compaction, cancel }`、`session_compact` 含 `compactionEntry`、`tool_result` 可替换 `content/details/isError`、`tool_call` 可返回 `{ block, reason }`、`turn_end` 含 `turnIndex/message/toolResults`、`before_provider_request` 含 `payload`、`ToolDefinition` 含 `promptSnippet/promptGuidelines/executionMode`）在 0.84.3 的 `types.d.ts` 中核实成立。`customTools` 同名覆盖由 `workspace-mutation-journal.ts` 的既有实现验证。`SessionBeforeCompactResult` 和 `ToolResultEventResult` 未从顶层包导出，编译期断言改用 `SessionBeforeCompactEvent` / `ToolResultEvent` 的事件形状验证。
状态：已实施

### D-002 · 2026-09-03 · 0.2
类型：问题与解法
决定：`changesForEntries` 从所有 checkpoint（包括 incomplete）收集 journaled 变更，而非只从 `status === 'ready'` 的 checkpoint 收集。
原因：一个 turn 可能同时有 journaled 写入（`write`/`edit`）和 unjournaled shell 变更。原实现只从 ready checkpoint 收集变更，导致 incomplete checkpoint 中的 journaled 路径被丢弃，coverage 错误地降为 `none`。正确行为是：incomplete checkpoint 中的 journaled 路径仍然可恢复，只有 unrecorded 路径不可恢复。因此 coverage 应为 `partial` 而非 `none`。
考虑过的替代：(1) 只从 ready checkpoint 收集，incomplete checkpoint 的所有路径都视为不可恢复——错误地丢弃了可恢复的 journaled 路径。(2) 把 incomplete checkpoint 拆成两个虚拟 checkpoint——过度复杂且无存储支撑。
影响：`packages/web/application-host/lib/recovery/journal-engine.ts` `changesForEntries`；`engine.test.ts` 新增 `partial` coverage 测试用例。
状态：已实施

### D-003 · 2026-09-03 · 0.2
类型：问题与解法
决定：范围内存在任何非 ready checkpoint 时 coverage 不能是 `ready`，即使 `uncoveredPaths` 为空。新增 `uncoveredReasons: string[]` 字段到 `WorkspaceCombinedRecoveryPlan`。
原因：worker 退出 / host 停止 / `observationComplete=false` 等情况下 `unrecorded_resource_ids` 可能为空，但 checkpoint 仍为 incomplete。此时声明 `ready` 是过度声明——journal 无法证明它捕获了一切。`uncoveredReasons` 从 binding 的 `failure_json.message` 收集，向用户展示 incomplete 的原因。
考虑过的替代：只在 `uncoveredPaths.length > 0` 时降级——无法覆盖空路径的 incomplete 场景。
影响：`packages/extension-contract/src/recovery.ts`（`uncoveredReasons` 字段 + parser）；`packages/web/application-host/lib/recovery/journal-engine.ts`（`hasIncompleteCheckpoint` + `uncoveredReasons` 收集 + coverage 计算）；`packages/ui/src/components/pi-session/PiRecoveryDialog.tsx`（显示 reasons）；`engine.test.ts` 两个新测试。
状态：已实施

### D-004 · 2026-09-03 · 0.2
类型：问题与解法
决定：`Writer` 接口加 `mode` 字段，`writerScope` 格式从 `${kind}:${id}@gen` 改为 `${mode}/${kind}:${id}@gen`。source 归因按 `process/` → shell、`external/` → external、其他/旧格式 → unknown。
原因：原实现用 `scope.startsWith('process:')` 做归因，但 `writerScope` 实际格式是 `${kind}:${id}@gen`，`kind` 是 `pi-worker` 等而非 `process`。`mode` 字段（`controlled`/`process`/`external`）已在 `mutation-authority.ts` 的 `ActiveWriter` 和 `publicState` 中存在，只是 `turn-coordinator` 的 `Writer` 接口没有声明它。把 `mode` 编码进 `writerScope` 前缀让归因在真实数据中成立。
考虑过的替代：(1) 在 binding 里单独存 `active_writer_modes` 数组——冗余且需要额外存储字段。(2) 用 `kind === 'pi-worker'` 推断 shell——不准确，`kind` 标识 owner 类型而非 writer mode。
影响：`packages/web/application-host/lib/recovery/turn-coordinator.ts`（`Writer.mode` + `writerScope` 格式）；`packages/web/application-host/lib/recovery/journal-engine.ts`（归因逻辑改为 `process/` / `external/` 前缀）；`engine.test.ts` 新增 process writer 注册后断言 `source: 'shell'` 的测试。
状态：已实施

### D-005 · 2026-09-03 · 0.2
类型：问题与解法
决定：pi-worker 运行期 lease 的 `mode` 是 `controlled`，不是 `process`。bash 命令级 process writer 是独立注册的第二个 writer，与 pi-worker lease 分开。source 归因只看 `writerScope` 前缀中的 `mode`，不看 `kind`。
原因：`mutation-authority.ts` 的 `registerWriter` 默认 `mode: 'controlled'`，pi-worker 的 lease 走的就是这条路径。bash 命令执行时 shell 监督器会额外注册一个 `mode: 'process'` 的 writer，其 owner kind 可能也是 `pi-worker` 但 mode 不同。如果用 `kind` 做归因（如 `kind === 'pi-worker'` → shell），会把 pi-worker 自身的 controlled lease 错误地归因为 shell。用 `mode` 前缀做归因精确区分了"谁在写"（owner kind）和"怎么写"（writer mode）。
考虑过的替代：(1) 用 `kind` 做归因——无法区分 pi-worker controlled lease 和 bash process writer。(2) 给 bash process writer 用不同的 `kind`（如 `bash`）——破坏了 owner 语义（owner 标识谁拥有这个写操作，mode 标识写的方式）。(3) 在 binding 里单独存 `active_writer_modes`——冗余，`writerScope` 前缀已编码了 mode。
影响：阶段 1.3 的 bash 命令级 process writer 注册必须确保 `mode: 'process'`，不能复用 pi-worker 的 controlled lease。`turn-coordinator.test.ts` 的 writerScope 格式测试验证了三种 mode（process / external / controlled）各自产出正确的前缀。
状态：已实施

### D-006 · 2026-09-03 · 1.1
类型：偏离
决定：`HostServicesBridge` 的 `respond` 方法接受 `{ ok: true; result } | { ok: false; error: HarnessError }` 联合类型，而非 `workspace.mutation.respond` 的 `accepted: boolean`。`session-host.respondHarness` 在 host-controller 层将扁平的 params（`{ ok, result?, error? }`）转换为联合类型再传给 bridge。
原因：harness 服务的返回值是结构化数据（shell 输出、搜索结果、诊断），不是布尔值。`HarnessError` 有 `code` / `message` / `retryable` 三字段，需要完整传递给 worker 侧的 `HarnessRequestError`。host-controller 的 `readString` / `readBoolean` 风格不适用于嵌套的 error 对象，因此在 `respondHarness` 里做一次形状转换。
考虑过的替代：(1) 让 host-controller 直接解析联合类型——需要新的 params 解析器，与现有 `readString` / `readBoolean` 风格不一致。(2) 把 error 展平为三个顶层字段（`error_code` / `error_message` / `error_retryable`）——污染方法签名且与 `HarnessError` 类型不一致。
影响：`packages/protocol/src/harness.ts`（`HarnessRespondParams` 联合类型）；`packages/pi-host/src/host-controller.ts`（`harness.respond` case 传 params 对象）；`packages/pi-host/src/session-host.ts`（`respondHarness` 形状转换）。
状态：已实施

### D-007 · 2026-09-03 · 1.1
决定：`HostServicesBridge` 在 pi-host 进程内构造，与 `WorkspaceMutationJournalBridge` 在同一位置（`#createRuntimeFactory`），共享 `emit` 和 `sessionId`。`harness.respond` 加入 `OUT_OF_BAND_METHODS`，与 `workspace.mutation.respond` 并列。
原因：harness 请求通道与 mutation 请求通道是同一类问题（worker→host 回调），复用已有的 broker 传输路径和 out-of-band 方法处理逻辑。bridge 的生命周期与 session 一致：构造在 runtime factory，dispose 在 `beforeSessionInvalidate` 和 `#disposeRuntime`。
考虑过的替代：(1) 在 host 层（application-host）构造 bridge——破坏了"worker 持有 bridge、host 持有 router"的对称性。(2) 用独立的事件名和 method 名——增加传输层适配成本，无收益。
影响：`packages/pi-host/src/session-host.ts`（`#hostServicesBridge` 字段 + 构造/dispose + `respondHarness`）；`packages/pi-host/src/host-controller.ts`（`OUT_OF_BAND_METHODS` + `harness.respond` case）。
状态：已实施
