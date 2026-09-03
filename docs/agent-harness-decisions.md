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

### D-008 · 2026-09-03 · 1.4
类型：默认值调整
决定：output-store 默认 `maxBytesPerSession = 256 MiB`，tool-result-truncation 默认 `visibleBytes = 32768`，bash 工具使用 0.375 head/tail 比率（其他工具 0.5）。截断时回退到最近的换行符（最多 512 字节）。
原因：256 MiB 足够存储一个典型长会话的所有大输出；32768 字节可见窗口在 4K 终端上约 200 行，足够上下文判断；bash 输出通常头部更重要（命令回显、错误信息），所以给头部更多空间。
考虑过的替代：(1) 128 MiB / 16384——太小，常见构建输出会频繁截断。(2) 512 MiB / 65536——浪费内存，大多数会话用不到。
影响：`packages/web/application-host/lib/harness/output-store.ts`；`packages/pi-host/src/harness/tool-result-truncation.ts`。
状态：已实施

### D-009 · 2026-09-03 · 1.8
类型：问题与解法
决定：`cacheHitRatio` 不在 extension 事件中实时追踪，而是在 `stats()` 查询时从 `getSessionStats().tokens.cacheRead` 和 `.input` 计算。`toolErrors`、`toolRetries`、`outputBytes` 通过 extension 事件实时累积。
原因：Pi 的 `AfterProviderResponseEvent` 不包含 `usage` 字段（只有 `status` 和 `headers`），无法在事件中捕获模型 usage。但 `getSessionStats()` 已经聚合了 `cacheRead` 和 `input`，所以在查询时计算比率是唯一可行的方式。tool 相关计数器没有这个问题，`tool_result` 事件包含所有需要的信息。
考虑过的替代：(1) 从 `TurnEndEvent.message` 中提取 usage——依赖 AgentMessage 内部结构，不稳定。(2) 不提供 cacheHitRatio——丢失重要指标。
影响：`packages/pi-host/src/harness/counter-tracker.ts`；`packages/protocol/src/types.ts`（`SessionStats` 新增可选字段）。
状态：已实施

### D-010 · 2026-09-03 · 1.3
类型：偏离（已回退）
决定：~~shell-supervisor 使用 `child_process.spawn` 而非 PTY 进行命令执行。~~
原因：~~PTY 交互需要 `node-pty` 或 `bun-pty` 原生模块，增加了部署复杂度。~~
状态：已回退——见 D-013。

### D-013 · 2026-09-03 · 1.3
类型：偏离
决定：shell-supervisor 回到决策表形状：复用 terminal runtime 的 PTY provider（`bun-pty` / `node-pty`），每个会话一个持久 login shell，命令用哨兵分隔，cwd/env/venv 在命令之间保持。后台 shell 保持 PTY 存活，stdin 开放，`write_to_process` 直接写入 PTY。每条命令执行期间通过 `registerWriter` 注册 `mode: 'process'` 的 writer。
原因：决策表要求 shell 形态是边界——持久 shell 保持了 cwd/env/venv 状态，避免了每条命令重新初始化的开销。PTY 支持交互式命令和后台进程的 stdin 写入，这是 `child_process.spawn` 无法做到的。`node-pty` 和 `bun-pty` 已经是 Piarium 的现有依赖（terminal runtime 使用），不增加新的部署复杂度。
考虑过的替代：(1) `child_process.spawn` + pipe——无法保持 shell 状态，无法写入后台进程 stdin（D-010，已回退）。(2) 每条命令创建新 shell——丢失 cwd/env 持续性。
影响：`packages/web/application-host/lib/harness/shell-supervisor.ts`（完全重写）；`packages/web/application-host/lib/harness/service-host.ts`（`registerWriter` 选项）。
状态：已实施

### D-011 · 2026-09-03 · 1.3
类型：默认值调整
决定：`typebox@1.3.7` 作为 pi-host 的直接依赖添加（与 pi-coding-agent 使用的版本一致）。tool schema 使用 `import { Type } from "typebox"` 而非 `@sinclair/typebox`。
原因：pi-coding-agent 依赖 `typebox`（非 `@sinclair/typebox`），两者是不同的包。pi-host 的 harness 工具需要直接引用 TypeBox 构建参数 schema，但之前没有直接依赖。添加与 pi-coding-agent 相同版本避免兼容性问题。
考虑过的替代：(1) 从 pi-coding-agent re-export TypeBox——修改上游包，不可控。(2) 使用 `@sinclair/typebox@0.34.x`——API 不兼容，schema 构建方式不同。
影响：`packages/pi-host/package.json`；`packages/pi-host/src/harness/bash-tool.ts`；`packages/pi-host/src/harness/grep-tool.ts`。
状态：已实施

### D-012 · 2026-09-03 · 1.6
类型：偏离（已回退）
决定：~~apply_patch 使用 unified diff 语法（--- / +++ / @@ -n,+m @@），单文件。~~
状态：已回退——见 D-014。

### D-014 · 2026-09-03 · 1.6
类型：偏离
决定：apply_patch 回到决策表形状：使用 Codex 语法（*** Begin Patch / *** Update File: / *** Add File: / *** Delete File: / @@ 上下文 / *** End Patch），支持多文件。每个文件的写入经与 edit / write 相同的 workspace.mutation.request before/after。只在会话模型为 OpenAI 家族（provider === "openai" || api === "openai"）时注册。
原因：决策表要求 apply_patch 使用 Codex 语法以与 OpenAI 模型的训练数据对齐。多文件支持减少了工具调用次数。workspace.mutation 集成确保所有文件变更都经过 journal，与 edit/write 工具一致。OpenAI-only 限制避免了在不支持该语法的模型上注册无用工具。
考虑过的替代：(1) unified diff 语法（D-012，已回退）——不匹配 OpenAI 训练数据。(2) 不经过 mutation journal——绕过了 recovery 系统。(3) 所有模型都注册——浪费非 OpenAI 模型的工具槽位。
影响：`packages/pi-host/src/harness/apply-patch-tool.ts`（完全重写）；`packages/pi-host/src/session-host.ts`（OpenAI-only 条件注册 + 传入 mutationJournal）。
状态：已实施
