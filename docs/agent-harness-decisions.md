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

### D-005 · 2026-09-03 · 0.2（已修正）
类型：问题与解法
决定：pi-worker 运行期 lease 的 `mode` 是 `process`（见 `pi-writer-tracker.ts:273`），不是 `controlled`。source 归因按命令窗口进行：pi-worker 自身的 lease scope 在归因时排除，只有 bash 命令执行期间额外注册的 `mode: 'process'` writer 才归因为 shell 写入。
原因：`pi-writer-tracker.ts:273` 明确使用 `mode: 'process'` 注册 pi-worker lease，不是 `controlled`。原 D-005 条目错误地声称 mode 是 `controlled`。归因方案改为按命令窗口：在 bash 命令执行期间注册的 process writer 是 shell 写入，pi-worker 自身的 lease scope 在归因时排除（不归因为 shell）。
考虑过的替代：(1) 用 `kind` 做归因——无法区分 pi-worker lease 和 bash process writer（都是 kind: 'pi-worker'）。(2) 按 mode 归因但包含 pi-worker 自身 lease——会把 pi-worker 的非 shell 写入错误归因为 shell。
影响：阶段 1.3 的 bash 命令级 process writer 注册确保 `mode: 'process'`。归因时排除 pi-worker 自身 lease 的 scope，只归因命令窗口内的 process writer。
状态：已实施（修正）

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

#### D-013 偏离记录 · 2026-09-03
**诚实偏离**：D-013 说"复用 terminal runtime 的 PTY provider"，但实际实现复用的是 PTY 模块（`node-pty` / `bun-pty` 的 `spawn` 函数），而非 terminal runtime 本身。具体来说：
- shell-supervisor 直接调用 `loadPtyProvider()` 加载 `node-pty` 或 `bun-pty`，然后 `ptyProvider.spawn()` 创建 PTY 进程。
- 这与 terminal runtime（`lib/terminal/runtime.ts`）是平行的实现，不是通过 terminal runtime 的 API 创建的。
- **后果**：harness 的后台 shell 不是终端 tab。用户无法在 UI 的终端面板中看到或附着到 harness 创建的 shell。这是决策表"边界"要求的缺口。

**修正方案**（进入阶段 2 之前完成）：
1. 在 `lib/terminal/runtime.ts` 暴露程序化创建/附着入口：`createTerminalSession(options) → TerminalHandle` 和 `attachTerminalSession(id) → TerminalHandle`。
2. harness shell-supervisor 经 `createTerminalSession` 创建 PTY，获得 `TerminalHandle`。
3. `TerminalHandle` 暴露 `write`、`onData`、`onExit`、`kill`、`resize` 方法（与当前 PTY provider 接口一致）。
4. UI 终端面板可通过 `attachTerminalSession(id)` 附着到 harness shell，实现"后台 shell 变成终端 tab"。
5. 在此之前，harness shell 与终端面板保持独立。

状态：已实施（PTY 模块复用）；终端 runtime 集成待完成（阶段 2 前置）

### D-015 · 2026-09-03 · 1.9
类型：决策
决定：HarnessSettings 存储在 Pi settings 的 `harness` 键下，用户级（scope: `global`），不使用项目级覆盖。
原因：harness 工具配置是用户偏好（shell 选择、输出截断大小、命令超时），不是项目协作约定。用户级存储确保同一用户在不同项目中有一致的 harness 行为。工具开关也放在用户级——如果某用户不想用 grep override，这个偏好应跨项目生效。
考虑过的替代：(1) 项目级存储——harness 行为会随项目变化，造成困惑。(2) 混合（工具开关用户级，shell/output 项目级）——增加复杂度，没有实际用例驱动。
影响：`packages/ui/src/components/sections/harness/HarnessSettingsPage.tsx`（写入 `scope: 'global'` 的 `harness` 键）；`packages/pi-host/src/session-host.ts`（从 Pi settings 读取 `harness` 键并 mergeHarnessSettings）。
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

## 阶段小结 · 阶段 1

本节原为阶段 1 的状态快照（模块 / 接线 / e2e 断言表），按 D-030 已整体迁入 [agent-harness-status.md](agent-harness-status.md)「历史快照：阶段 1 小结」。它曾存在于 1.11 交付点（提交 `9494a195` 前后）。

### D-016 · 2026-09-03 · 1b.1
类型：决策
决定：HTML 正文提取用 `@mozilla/readability@0.6.0` + `linkedom@0.18.13`（提供 DOM），HTML→Markdown 用 `turndown@7.2.4`。PDF 用 `pdfjs-dist`（动态 import，未加为直接依赖，运行时按需加载）。
原因：`@mozilla/readability` 是 Firefox 阅读模式的实现，业界标准。`linkedom` 比 `jsdom` 轻量得多（无浏览器模拟），足以支撑 Readability 的 DOM 需求。turndown 是 HTML→Markdown 的事实标准。三者均在依赖树中不存在，新加。
考虑过的替代：(1) jsdom——太重，会拉入大量浏览器 API，测试中导致 OOM。(2) cheerio——不支持 Readability 需要的 DOM API。(3) 手写提取——不可靠，无法处理真实页面的复杂性。
影响：`packages/web/package.json`（+3 依赖）；`lib/harness/web-fetch.ts`（动态 import linkedom/readability/turndown）。
状态：已实施

### D-017 · 2026-09-03 · 1b.6
类型：决策
决定：webfetch/websearch 工具在 `selectHarnessTools` 中默认注册，但当 `pi-web-access` Pi 包已加载且启用时让出（yield），由该包提供同名工具。检测方式：从 `settingsManager` 直接读取全局+项目 packages 列表（不调用 `listPackages()`，因为会话创建时尚无活跃会话）。
原因：避免工具名冲突和重复执行。`pi-web-access` 是一等公民 Pi 包，其实现可能比 harness 内置版本更丰富（Curator/browser、GitHub/video/PDF 特殊处理等）。harness 内置版本是后备。
考虑过的替代：(1) 始终注册 harness 版本，忽略 pi-web-access——会导致工具名冲突。(2) 用 MCP 工具名前缀避免冲突——破坏了"让出"语义，用户期望一个 webfetch 而非两个。
影响：`packages/pi-host/src/harness/select-tools.ts`（`computeYieldedTools` + `yieldedTools` 参数）；`packages/pi-host/src/session-host.ts`（从 settingsManager 读取包列表）。

### D-018 · 2026-09-03 · 1.11
类型：决策
决定：工具卡片紧凑渲染的摘要从 `details`（非 `content`）生成，遵循 agent-harness.md 5.1 原则 2。分组逻辑：连续的只读工具调用（grep/read/find/ls/diagnostics/webfetch/websearch）折叠为一组，头部显示"首个摘要 + and N other queries"。写工具和 bash 打断分组且自身永不分组。
原因：`content` 是给模型的（可能被截断/格式化为模型消费），`details` 是给渲染的（结构化、完整）。分组减少了视觉噪音——连续 5 次 grep 调用折叠为一行比 5 个独立卡片更易扫描。
考虑过的替代：(1) 从 content 生成摘要——违反 5.1 原则 2，且 content 可能被截断。(2) 所有工具都分组——写工具需要独立展示 diff 和确认。(3) 不分组——噪音过大。
影响：`packages/ui/src/components/chat/message/parts/toolSummary.ts`（`getToolSummary` + `groupToolCalls`）；`packages/ui/src/components/chat/message/parts/toolSummary.test.ts`（17 测试）。
状态：已实施（纯逻辑模块，尚未接入 PiTimelineEntries.tsx 渲染路径——待阶段 2 UI 集成）

### D-019 · 2026-09-03 · 2.1
类型：偏离
决定：TriviumDB TQL 查询语法在 v0.8.5 上不稳定（FIND 语法对字符串/数字字面量处理不一致，WHERE 子句报类型转换错误）。知识库 store.ts 改用 `allNodeIds()` + `getPayload()` 在 JS 层过滤，不使用 TQL。
原因：TQL 的 `FIND {type: "block", sessionId: "s1"} RETURN *` 报 "Failed to convert napi value String into rust type `f64`" 错误，说明 TQL 解析器对 payload 字段类型推断有 bug。JS 层过滤虽然在大数据集上较慢，但阶段 2 的数据规模（单会话数百 event）完全可接受。
考虑过的替代：(1) 修复 TriviumDB 的 TQL 解析器——是同一维护者的项目，但优先级低于推进阶段 2；(2) 用 `tql` 的 MATCH 语法——同样不稳定。
影响：`packages/web/application-host/lib/knowledge/store.ts`（scanNodes 辅助函数替代所有 TQL 查询）。索引（createIndex/createOrderedIndex）仍创建但不被 JS 层使用，保留供未来 TQL 修复后启用。
状态：已实施（模块已写，尚未接进会话生命周期——待阶段 2 接线）

### D-020 · 2026-09-03 · 2.1
类型：偏离
决定：占位向量模式下 `recall` 不使用 `searchHybrid`，改为 JS 层扫描 accepted knowledge 节点 + 简单词项匹配评分。`searchHybrid` 的全零向量在 v0.8.5 上返回空结果（余弦相似度为 0/NaN）。
原因：计划要求"实施前先在 TriviumDB 上验证全零向量的 search 不报错"——验证发现不报错但返回空结果，无法用于召回。JS 层词项匹配虽然粗糙，但满足阶段 2 的基本需求（按 trigger/content 匹配）。
考虑过的替代：(1) 用单位向量占位——会引入虚假相似度；(2) 只走 TQL 文本查询——TQL 不稳定（见 D-019）。
影响：`packages/web/application-host/lib/knowledge/store.ts`（recall 方法在 `!embedding` 分支改为 JS 扫描）。embedding 模式仍使用 `searchHybrid`。
状态：已实施（模块已写，尚未接进会话生命周期——待阶段 2 接线）

### D-021 · 2026-09-03 · 3b.3
类型：偏离（已回退）
决定：~~从 `FOUNDATIONAL_PI_PACKAGE_MANIFEST` 移除 `@gotgenes/pi-permission-system`（revision 2→3）。~~
原因：~~计划要求"已安装实例不删不迁"。保留类型字面量让 protocol 消费方仍能处理旧快照中的 permission-system 条目，但不再自动 provision。~~
状态：已回退。原生 tool_call 门控尚未接进 Pi 会话生命周期，移除既有权限边界留下未覆盖的安全缺口。在 3b.1/3b.2 e2e 通过之前保持 revision 2 不变。

### D-022 · 2026-09-03 · 2.6
类型：实验结果
决定：Pi 0.84.3 按预期消费 `session_before_compact` 钩子返回的 `{ compaction: CompactionResult }`。当扩展返回此字段时，Pi 跳过自身的 LLM 摘要生成，直接使用扩展提供的 `summary` / `firstKeptEntryId` / `tokensBefore`。`session_compact` 事件随后触发，`fromExtension` 标记为 `true`。
原因：plan 2.6 要求"实施前先验证"。通过 `pi-hooks-contract.test.ts` 新增 e2e 测试验证：(1) 扩展注册 `session_before_compact` 处理器并返回 `{ compaction: { summary: "piarium-custom-compaction-summary-marker", firstKeptEntryId, tokensBefore } }`；(2) 4 轮 agent 对话构建足够上下文（每轮 ~7500 tokens，总计 >20000 tokens 超过 `keepRecentTokens`）；(3) 调用 `host.session.compact()` 触发手动压缩；(4) 断言自定义摘要文本出现在会话消息中；(5) 断言 faux provider 调用次数仍为 4（压缩未触发额外 LLM 调用）。源码核实：`agent-session.js` 第 1435-1451 行（手动压缩路径）和第 1709-1725 行（自动压缩路径）均检查 `extensionResult?.compaction` 并跳过 `_runDefaultCompaction`。
考虑过的替代：如果 Pi 不消费此返回值，plan 2.6 的替代路径是在 `session_compact` 事件后追加自定义摘要消息（非接管压缩，而是追加）。实验证明主路径可行，无需走替代路径。
影响：`packages/pi-host/test/pi-hooks-contract.test.ts`（新增 e2e 测试，2/2 pass）。阶段 2 接线可安全使用 `session_before_compact` 返回 `{ compaction }` 实现接管压缩。
状态：已验收

### D-023 · 2026-09-03 · 2.1–2.10
类型：偏离
决定：Phase 2 模块接线采用"provider 注入"模式而非硬编码。`HarnessServiceHost` 新增 `zone2Provider` / `compactionDepsProvider` / `todoDepsProvider` / `recallDepsProvider` 四个可选 provider 函数，由 `index.ts` 在创建 service host 时注入。当 provider 不存在时，对应的 harness service 不注册（router 无 handler → bridge.request 报错 → pi-host extension catch 后返回 undefined → Pi 回退到默认行为）。
原因：(1) 知识库是 per-workspace 的，需要在运行时根据 sessionId 解析 workspaceId 再打开/复用 store，不能在 service host 构造时确定。(2) memory agent 需要 model 访问权限，当前阶段尚未配置，设为 null 不阻塞其他服务。(3) compaction/todo/recall 的 deps 都需要 knowledgeStore + sessionId，通过 provider 函数延迟绑定。(4) zone2 的 material 收集逻辑（events/git/diagnostics/blocks）需要从多个 host 子系统聚合，当前返回空 material（assembler 返回 null → 不发消息），后续逐步填充。
考虑过的替代：(1) 在 service host 构造时打开所有 workspace 的 store——无法知道有哪些 workspace，且浪费资源。(2) 让 pi-host extension 直接访问 knowledge store——破坏了 worker/host 边界（worker 不持有 store 引用）。(3) 不用 provider，直接在 harness-services.ts 里 import knowledge store——循环依赖且无法测试。
影响：`packages/protocol/src/harness.ts`（5 新 HarnessServiceMap 方法）；`packages/web/application-host/lib/harness/service-host.ts`（8 新字段 + 8 新 options）；`packages/web/application-host/lib/harness/harness-services.ts`（5 新 service factory + 注册）；`packages/web/application-host/index.ts`（knowledge store 懒加载 + 4 provider 函数）；`packages/pi-host/src/harness/zone2-extension.ts`（新文件）；`packages/pi-host/src/harness/compaction-extension.ts`（新文件）；`packages/pi-host/src/harness/todo-tool.ts`（新文件）；`packages/pi-host/src/harness/recall-tool.ts`（新文件）；`packages/pi-host/src/harness/select-tools.ts`（注册 todo/recall）；`packages/pi-host/src/session-host.ts`（注册 zone2/compaction extension）；`packages/pi-host/test/harness/phase2-e2e.test.ts`（5 e2e 测试，5/5 pass）。
状态：已实施（zone2 material 和 compaction facts 收集逻辑为 TODO，当前返回空值；memory agent 未接线 model 访问；user knowledge store 未打开。这些在后续阶段逐步填充。）

### D-024 · 2026-09-03 · 3.4–3.5
类型：偏离
决定：ThreadRecord 重设计 3.4/3.5 采用"host 持久化注册表 + protocol 事件 + bridge 服务方法"三层架构。(1) `ThreadRegistry`（`thread-registry.ts`）是唯一真相，JSON 持久化到 `PIARIUM_DATA_DIR/threads/<hostId>/<parentSessionId>.json`，内存缓存按 parentSessionId 分组。(2) Protocol 层新增 `harness.thread.changed` / `harness.thread.done` 两个 host 事件（只带状态子集，不带正文），以及 7 个 `HarnessServiceMap` 方法（`thread.dispatch` / `thread.list` / `thread.wait` / `thread.send` / `thread.read` / `thread.merge` / `thread.kill`）。(3) pi-host 的 7 个工具定义通过 `bridge.request` 调用这些服务方法，与 Phase 2 的 todo/recall 模式一致。
原因：(1) 线程状态必须归 host 而非任何一方的上下文——worker 退出后线程仍在跑，状态不能丢。(2) JSON 持久化比知识库 `session` 节点简单，且线程注册表是 per-parent 而非 per-workspace，知识库的 workspace 索引不适合。(3) `completeThread` 幂等设计（已 done 则返回同一记录）确保 `wait` / `read_thread` 多次读取报告字节相同。(4) hidden 线程（review 传感器、记忆 agent）不进父的 `threads` 列表但状态仍在注册表里。(5) `cancelAllForParent` 在父会话删除时批量取消所有运行中线程。
考虑过的替代：(1) 用知识库 `session` 节点存线程——查询复杂，且 `session` 节点是 per-session 而线程是 per-parent。(2) 在 worker-runtime.ts 里直接加 ThreadRecord——worker-runtime 是纯算法模块，不应承担持久化职责。(3) 让 pi-host 直接访问注册表——破坏 worker/host 边界。
影响：`packages/protocol/src/harness-threads.ts`（新文件，ThreadRecord + 7 服务方法类型）；`packages/protocol/src/harness.ts`（7 新 HarnessServiceMap 方法）；`packages/protocol/src/events.ts`（2 新 host 事件）；`packages/protocol/src/harness-tools.ts`（3 新 HARNESS_TOOL_META 条目）；`packages/web/application-host/lib/harness/thread-registry.ts`（新文件，405 行）；`packages/web/application-host/lib/harness/thread-registry.test.ts`（新文件，20 测试）；`packages/web/application-host/lib/harness/service-host.ts`（5 新字段）；`packages/web/application-host/lib/harness/harness-services.ts`（7 新 service factory）；`packages/pi-host/src/harness/thread-tools.ts`（新文件，7 工具定义）；`packages/pi-host/src/harness/select-tools.ts`（注册 7 线程工具）；`packages/pi-host/test/harness/phase3-e2e.test.ts`（新文件，6 e2e 测试）。
状态：已实施（worktree 管理、活性传感器 stalled/looping、观察游标、Zone 2 threads 段、Fleet provider 为 TODO。spawnSession/killSession/applyWorktreeDiff/sendToSession 当前为 mock，需接线到 broker 的 child session 机制。）

### D-025 · 2026-09-03 · 3b.1
类型：偏离
决定：权限门控的纯类型和评估函数（`evaluateGate`、`defaultRules`、`isHighRisk`、`mergePolicies`）从 web application-host 移到 `@piarium/protocol/permission-gate.ts`，使 pi-host 和 web host 都能 import 而不产生跨包依赖。web 的 `permission-gate.ts` 改为 re-export（保留本地 `isHighRisk` 扩展版，覆盖 write/edit 工具和 path 参数）。pi-host 新增 `permission-gate-extension.ts`，在 `tool_call` 钩子里调用 `evaluateGate`，返回 `{ block: true, reason }` 阻止 ask/deny 决策。
原因：(1) 权限评估是纯函数，不需要 host 上下文，放在 protocol 层让两包共享。(2) pi-host 的 `tool_call` 钩子是 Pi 的原生扩展点，在工具执行前拦截，不需要 bridge round-trip。(3) policy 在 session 创建时从 `harnessSettings` 解析并冻结，避免每回合解析。(4) mode 当前硬编码为 "normal"——TODO 从 settings 解析实际 mode。
考虑过的替代：(1) 通过 bridge.request("permission.gate", ...) 让 host 评估——增加每工具调用的 round-trip 延迟。(2) 在 host 侧用 Pi 的 permission_system 包——已移除（3b.3），用原生实现。(3) 在 protocol 里只放类型，评估函数留在 web——pi-host 需要复制评估逻辑。
影响：`packages/protocol/src/permission-gate.ts`（新文件，类型 + evaluateGate + defaultRules + isHighRisk + mergePolicies）；`packages/web/application-host/lib/harness/permission-gate.ts`（改为 re-export + 本地 isHighRisk）；`packages/pi-host/src/harness/permission-gate-extension.ts`（新文件，tool_call 钩子）；`packages/pi-host/src/session-host.ts`（注册权限门控扩展，提前解析 harnessSettings）；`packages/pi-host/test/harness/phase3b-e2e.test.ts`（新文件，12 测试）。
状态：已实施（smart mode 未接线 permissionJudge model slot；mode 硬编码为 normal；accept-edits/bypass 模式未从 settings 解析。这些在后续阶段填充。）

### D-026 · 2026-09-03 · 3.4–3.5（§9.3 redo）
类型：偏离
决定：3.4/3.5 线程系统按 §9.3 设计语义重做。D-024 的三层架构（host 持久化注册表 + protocol 事件 + bridge 服务方法）保留，但服务语义全面更新：
(1) **阻塞 wait**：`thread.wait` 不再是瞬时快照，而是通过 `subscribeToChanges` 订阅状态变更，阻塞直到有线程状态变化或超时。超时是正常结果（`timedOut: true`），不是错误。done 线程在 wait 结果中包含完整报告（conclusion / deviations / unresolved / confidence / traceHandle 引用）。
(2) **增量 threads**：`thread.list` 默认增量视图——只显示自上次观察游标以来有变化的线程。`full: true` 参数返回完整快照。无变化时返回 "no changes since last view; use wait to block instead of polling"。
(3) **观察游标**：`ThreadViewCursor`（eventSeq / status / progressVersion / decisionsCount / diffStats / viewedAt）存储在注册表中，按 `(observerSessionId, threadId)` 索引。`threads` / `wait` / `read_thread` 在返回前推进游标。`clearCursorsForSession` 在观察者会话结束时清理。
(4) **read_thread what 参数**：`what: "blocks"|"report"|"steps"` 替代旧的 `steps?` 布尔语义。"blocks"（默认）= 进度/决策/错误结构化摘要；"report" = 完整 ThreadReport；"steps" = 带 `since` 游标的 transcript 切片。`traceHandle` 在结果中返回供 get_output 拉取完整 trace。
(5) **dispatch 并发限制**：`maxConcurrency`（默认 12）限制每父会话的运行+排队线程数。超限时 `dispatch` 返回 `queued: true`，线程状态为 "queued"，不立即 spawn。`tryDequeue` 在运行线程完成时取出最旧的排队线程。
(6) **send 唤醒**：`thread.send` 在线程为 idle 或 waiting-for-input 时自动将状态改为 running 并清除 waitingFor。结果包含 `status` 字段。
(7) **eventSeq**：每个 ThreadRecord 有单调递增的 `eventSeq`，每次 `updateThread` 递增。用于增量视图判断是否有变化。
(8) **TTL 表**：`TtlTable` / `DEFAULT_TTL_TABLE` / `DEFAULT_WAIT_TIMEOUT_MS`（240s）定义在 protocol 层，供 wait 超时和未来 cache TTL 使用。
(9) **kill keepWorktree**：`thread.kill` 新增 `keepWorktree` 参数（默认 true）——半成品工作永不丢失。
原因：D-024 的实现是瞬时快照语义（wait 立即返回、threads 总是全量、read_thread 只有 report），不满足 §9.3 的"阻塞 wait + 增量视图 + 结构化 read"要求。重做后 wait 是真正的阻塞调用（减少轮询），threads 是增量视图（减少噪音），read_thread 按需返回 blocks/report/steps（减少上下文消耗）。
考虑过的替代：(1) 用 SSE/WebSocket 推送代替阻塞 wait——Pi 的 bridge 是请求-响应模型，不支持推送；阻塞 wait 是最接近的语义。(2) 在 worker 侧维护游标——破坏 worker/host 边界，worker 退出后游标丢失。(3) 用时间戳代替 eventSeq——时钟漂移可能导致增量视图漏判。
影响：`packages/protocol/src/harness-threads.ts`（ThreadListParams +ids/full、ThreadListResult +text/diffStats、ThreadWaitResult +timedOut、ThreadSendResult +status、ThreadReadParams what/since、ThreadReadResult +traceHandle、ThreadKillParams +keepWorktree、ThreadDispatchResult +queued、ThreadViewCursor、TtlTable、DEFAULT_TTL_TABLE、DEFAULT_WAIT_TIMEOUT_MS）；`packages/web/application-host/lib/harness/thread-registry.ts`（ThreadRecord +eventSeq、observer cursor store、subscribeToChanges、tryDequeue、maxConcurrency）；`packages/web/application-host/lib/harness/harness-services.ts`（dispatch 并发检查、threads 增量视图、wait 阻塞+订阅、send 唤醒、read_thread what、kill keepWorktree）；`packages/pi-host/src/harness/thread-tools.ts`（全部工具用 ctx.sessionManager.getSessionId()、新参数名 timeout_ms/keep_worktree/what/since/full/ids、promptGuidelines 按 §3.5 spec）；`packages/protocol/test/harness-threads.test.ts`（新文件，15 契约测试）；`packages/web/application-host/lib/harness/thread-registry.test.ts`（+7 新测试）；`packages/pi-host/test/harness/phase3-e2e.test.ts`（更新 3 测试）。
状态：已实施（transcript slice "steps" 当前返回占位文本——需要接线到 thread session 的 memory agent blocksSnapshot；progress/decisions/errors blocks 提取需要 memory agent 接线；spawnSession/killSession/applyWorktreeDiff/sendToSession 仍为 mock。这些在后续阶段填充。）

### D-027 · 2026-09-04 · 2.1–2.10 / 3.4–3.5 / 3b.1（更正 D-023、D-024、D-025、D-026）
类型：问题与解法
决定：把前四条记录里混在"状态"字段中的**未完成**与**偏离**分开，并更正三处与代码不符的描述。本条只追加，不改写被引用的条目。

**更正 1（D-026 (5)）**：原文写"`tryDequeue` 在运行线程完成时取出最旧的排队线程"，但当时代码里 `tryDequeue` 没有任何调用点，排队线程永远不会启动。现已成立：`updateThread` 检测到进入终态（done/failed/cancelled/merged/archived）时调用 `maybeDequeue`，由它比较 `countActive` 与 `maxConcurrency` 后调 `tryDequeue`，再经 `onThreadDequeued` 回调让 host spawn。放在 `updateThread` 而不是各调用点，是因为每条结束线程的路径都要让出槽位，分散实现必然漏（当时 `failed` 就没接）。

**更正 2（D-026 (8)）**：原文写 TTL 表"供 wait 超时使用"，实际 `wait` 只用常量 `DEFAULT_WAIT_TIMEOUT_MS`，`DEFAULT_TTL_TABLE` 定义了但零引用。现状不变（表仍未被消费），按 plan 3.5 判断要点保留 240s 保守默认；`getTtl` 的接线留到能从 provider 元数据拿到缓存 TTL 时再做。

**更正 3（D-025）**：原文称"mode 硬编码为 normal"为待办，现已从 `harnessSettings.permissions.mode` 解析。另外 D-025 说 web 侧"保留本地 `isHighRisk` 扩展版"，这导致 pi-host（用 protocol 版，只认 bash）与 web（用本地版，认 write/edit 的 path）判定不一致——同一个 `.env` 写入在门控里不算高风险、在 smart mode 里算。已统一，见 D-028。

**未完成项（不是偏离，是尚未做的工作，按阶段推进）**：

| 来源 | 未完成 |
| --- | --- |
| D-023 | Zone 2 material 收集（观察者未订阅事件源）；记忆 agent 无 model 访问；user 知识库未打开；todo 的确认通道与"只问一次"未接 |
| D-024/D-026 | worktree 创建与回收；活性传感器 stalled/looping；Zone 2 threads 段；Fleet provider；broker child session（spawn/kill/send/applyWorktreeDiff 仍为 mock）；`read_thread(steps)` 转录切片；progress/decisions/errors 块提取 |
| D-025 | smart mode 未接 permissionJudge 槽位 |
| 3b.3 | 见下条：插件未移除，原生门控与插件并存 |

**3b.3 的真实状态**：D-021 已把 `@gotgenes/pi-permission-system` 的移除回退，插件仍在 `FOUNDATIONAL_PI_PACKAGE_MANIFEST`（revision 2）。roadmap 曾连续三版写成 "Removed (revision 2→3)"，已更正。plan 3b.1 要求的"与插件同时启用时原生优先并在诊断面板提示重复"仍未实现。
影响：`docs/roadmap.md`（3b.3 条目与测试计数更正）。
状态：已实施

### D-028 · 2026-09-04 · 3.6 / 3.7 / 3b.1 / 2.6
类型：偏离
决定：验收整改，七项：

(1) **角色目录移到 protocol**。`roles.ts` 的静态部分（`RoleId` / `RoleDefinition` / `ROLE_DEFINITIONS` / `resolveRoles` / `buildTeamPrompt`）移入 `@piarium/protocol/harness-roles.ts`，web 的 `roles.ts` 改为 re-export。原因：`dispatch` 的团队提示与槽位校验必须发生在 worker 侧（冻结的会话设置在那里），而角色目录原先在 web 包里拿不到——上一轮因此把 `TEAM_PROMPT_GUIDELINES = ["team"]` 这个占位常量当成提示塞进了 `promptGuidelines`，真实会话的系统提示里会出现一行只写着 "team"。现在 `dispatch` 的 guidelines 由 `buildTeamPrompt(resolveRoles(...))` 生成，未配置槽位的角色既不出现在提示里也被工具拒绝（返回 `isError` + `unknown role`），不静默回退主模型（不变量 6）。`RoleDefinition` 新增 `teamDescription` 字段，让团队提示的措辞与 plan 3.6 的模板一致而不是从 `systemPromptFragment` 截句子。

(2) **`frontend` 角色回到自己的槽位**。原实现让 `frontend` 复用 `hardImplement` 槽位（因此未配置 `models.frontend` 也会出现在目录里），与设计 9.2.2 的表不符。改为 `slot: "frontend"`，未配置即不注册。`ModelSlotsSettings` 与 `SlotId` 改为复用 protocol 的 `HarnessModelRole`，两处槽位定义不再各写一份。

(3) **`isHighRisk` 统一**。protocol 版原先只认 `bash.command`，web 本地版认 write/edit 的 `path`。合并为一张表，每条带 `tools` 列表，覆盖 `bash`/`write_to_process` 的 command 与 `write`/`edit`/`apply_patch` 的 `path`/`file_path`；`defaultRules` 按同一张表生成 ask 规则。web 的 `permission-gate.ts` 改为纯 re-export。

(4) **高风险与 session-allow 的关系收紧，与 bypass 的关系放开**。判定顺序改为：`deny` → 阻断；`allow` → 放行（含 bypass 与用户显式写的规则）；`ask` → 若非高风险且已有本会话授权则放行，否则弹窗。这样"允许 bash 一整个会话"不会连带批准 `rm -rf`（高风险永不记入 session-allow），而 `bypass` 仍然是"别再问我"。上一轮的实现让 bypass 下的高风险也弹窗，比 plan 3b.1 的"bypass 全 allow"更保守，现已改回。

(5) **压缩接管的条件改为"存在记忆 keeper 写的块"**。原条件是"有任意块或任意 fact"，而生产里记忆 agent 为 null，唯一可能存在的块是 `todo` 写的 `plan`——只凭一张清单就跳过 Pi 的摘要，等于把整段对话换成待办列表。改为要求 `updatedBy === "memory-agent"` 的块；在 2.4 接线之前这等价于"永不接管，由 Pi 摘要"，这是安全的一侧。

(6) **`wait` 的超时进入契约，并加上限**。`HarnessRequestData` 新增 `timeoutMs?`（上一轮靠 spread 塞进事件、router 靠本地 cast 读出来，契约层看不见），router 用 `HARNESS_MAX_REQUEST_TIMEOUT_MS`（1 小时）夹住 worker 传来的值——worker 不该能把 host 的 handler 无限期钉住。同时发现并修了 `wait` 结果的一个缺口：`waiting-for-input` 的线程既不计入 done/running/queued 也不打印，"最常见的卡死其实是在等一个没人看见的确认"（设计 9.3.5）在结果里是隐形的。新增 `waiting` 计数与行渲染（`ThreadWaitResult.waiting`）。

(7) **review 传感器（3.7）移植而非删除**。上一轮因为它 import 了被删的 `WorkerRuntime` 就把模块和 5 个测试一起删了，理由记作"被 thread registry 取代"——不成立：传感器是 host 侧的触发器，注册表是它要调用的东西。已改为 `registry.createThread({ role: 'review', hidden: true, worktree: 'none', carryBlocks: false })`，并补一条测试断言它对父的 `threads` 列表不可见（设计 9.2.3）。`worker-runtime.ts` 的删除保留。

原因：以上除 (7) 外都是"参考形状在真实运行路径上不成立"的修正；(7) 是纠正一次误删。四条边界在这里被守住：未配置槽位不注册、高风险永远问、压缩不能凭清单接管、worker 不能支配 host 的时限。
考虑过的替代：(a) 角色目录留在 web、pi-host 复制一份——两处定义必然漂移，上一轮的 "team" 字面量就是这么来的。(b) 压缩接管条件按"块数 ≥ 2"之类的启发式——阈值没有依据，且 plan 明确记忆块归记忆 agent，按 `updatedBy` 判定是唯一有语义的条件。(c) `wait` 的 `waiting` 只在文本里体现、不进结果类型——工具的 details 是给 UI 渲染的，计数缺失会让面板也漏掉这一状态。
影响：`packages/protocol/src/harness-roles.ts`（新文件）；`packages/protocol/src/{index,harness,harness-settings,harness-threads,permission-gate}.ts`；`packages/pi-host/src/harness/{thread-tools,select-tools,permission-gate-extension}.ts`；`packages/pi-host/src/session-host.ts`（解析 resolvedRoles）；`packages/web/application-host/lib/harness/{roles,model-slots,permission-gate,review-sensor,thread-registry,harness-services,compaction,router}.ts`；测试：`packages/pi-host/test/harness/session-e2e.test.ts`（新文件，8 真 Pi 会话测试）、`phase3-e2e.test.ts`（+3 wait 测试）、`review-sensor.test.ts`（重写，6 测试）、`roles.test.ts`、`compaction.test.ts`（+2）。
状态：已实施

### D-029 · 2026-09-04 · 交叉（测试卫生与流程）
类型：问题与解法
决定：(1) 六个测试文件（recall / compaction / memory-agent / knowledge-suggestions / todo / store / embedding / observers）把临时知识库建在 `import.meta.dirname` 下，即 `application-host/lib/**` 源码树内；`architecture.test.ts` 会遍历该目录做"源码全是 TypeScript"检查，于是全量 vitest 随机报 `ENOENT: scandir '.test-recall/store-1'`——上一轮报告的 "0 fail" 是碰巧跑过的一次。全部改为 `join(tmpdir(), "piarium-test-*")`。(2) `thread-registry` 的 `persist` 改为按 parent 串行的 promise 链，临时文件名带 pid+序号：`cancelAllForParent` 会并发取消多条线程，各自触发一次 temp+rename，撞同一路径会丢写或直接失败。(3) `cancelAllForParent` 期间置 draining 标记抑制出队——父会话正在删除时把排队线程提升成新的子会话，等于复活用户刚删掉的工作。(4) `test:node-smoke` 加进 CI（`.github/workflows/ci.yml`），否则那个专门用来暴露 CJS/ESM 互操作问题的 Node smoke 只能靠人手跑，而它要防的正是"vitest 能过、`node server/index.js` 起不来"。
原因：前三条都是"测试和实现里的并发/路径假设在真实运行时不成立"，第四条是让上一轮加的防护真正生效。
影响：上述六个测试文件；`packages/web/application-host/lib/harness/thread-registry.ts`；`.github/workflows/ci.yml`。
状态：已实施

### D-030 · 2026-09-04 · 交叉（决策日志治理）
类型：默认值调整
决定：本日志的治理规则改为四条。(1) **条目只追加，永不改写、重排或删除**，编号乱序（D-013、D-015 早于 D-011、D-012）与 D-005、D-013 的原地修订作为历史保留。(2) 新增"决策索引"一节（见文末），每条记录 `Current status`（active / implementation / experiment-result / superseded / reverted / contradicted / open-question / folded-in）、`Superseded by`、`Folded into`；索引可以随时更新，它不是条目。(3) 分类为 active-design 的条目**必须回写**到 `agent-harness.md` 或 `agent-harness-plan.md`，回写完成后索引标 `folded-in`；日志不是现行规格，执行 agent 以设计文档与 plan 为准，日志只解释"为什么"。(4) 状态快照（测试数、接线表、e2e 断言表）不属于日志，原"阶段小结 · 阶段 1"迁入 `agent-harness-status.md`，原位置保留一行链接。plan 交付完成后本日志**归档为交付历史**，不删除。
原因：三轮验收发现设计漂移的主要来源就是这份日志：D-013、D-014、D-023、D-028 等已成为现行契约的决定只存在于此处，设计与 plan 仍写着旧形状，执行 agent 每次压缩后重读 plan 就会再走一遍旧路径。另一方面，D-026 被原地改写、D-005 被原地修订，说明"只追加"没有被当成硬规则。
考虑过的替代：(a) 把日志直接改写成现行规格——历史消失，之后没人能回答"当时为什么这么定"。(b) 不加索引、靠阅读全文判断哪条还有效——每条的"状态"字段混着未完成与偏离，读不出来（D-027 已经证明这一点）。
影响：本文件（索引节、阶段小结迁出）；`docs/agent-harness-status.md`（新文件）。
状态：已实施

### D-031 · 2026-09-04 · 1.9（取代 D-015）
类型：偏离
决定：`HarnessSettings` 不再作为一个整体决定"用户级"还是"用户级 + 工作区覆盖"，改为**按字段的所有权矩阵**：

| 字段 | 所有权与合并规则 |
| --- | --- |
| `models.*`（模型槽位）、provider 凭据 | user-only；工作区无权设置 |
| `knowledge.autoAcceptSuggestions.user` | user-only；工作区无权设置 |
| `knowledge.autoAcceptSuggestions.workspace`、`knowledge.eventRetentionDays` | 工作区可设置 |
| `tools.*`、`shell`、检索策略、`dispatch.concurrency` | user 默认 + 工作区覆盖 |
| `permissions.mode`、`permissions.rules` | 工作区**只能收紧**：mode 的严格度全序为 `bypass < accept-edits < normal`，工作区只能向右移；工作区可追加 `ask` / `deny` 规则，不能追加 `allow` 规则覆盖用户的 `ask` / `deny`；`smart` 需用户显式开启，工作区不能开 |
| `web.*`（域名策略等） | user 与工作区取更严格的组合 |
| `output.*`、UI 偏好 | user 默认 + 工作区覆盖 |
| `dispatch.askBefore` | 工作区只能增加需要询问的角色，不能取消 |
| `threadRuntime` 及一切能力可用性 | **不是设置**；来自 host / RunManifest 的注入，只读。现有的 `threadRuntime` 设置键是过渡方案，RunManifest 落地后删除 |

工作区级覆盖**只在项目已 trusted 时生效**（复用 Pi 的 project trust；未 trusted 的项目设置整体忽略）。
原因：D-015 说"仅用户级"，plan 1.9 与代码（`session-host.ts:2678` 合并 `getProjectSettings().harness`）却是"用户级 + 工作区覆盖"，两者都不对：`autoAcceptSuggestions` 作为一个对象被工作区整体覆盖，意味着一个仓库的项目配置可以替用户打开"自动写入用户级长期记忆"；`permissions` 被工作区放宽则是仓库替用户降低安全等级。不同字段的 authority 不同，不能用一条规则。
考虑过的替代：(a) 全用户级（D-015 原文）——"这个仓库只能用 PowerShell"这类项目事实无处放。(b) 全部允许覆盖（现代码）——见上。
影响：`packages/protocol/src/harness-settings.ts`（`mergeHarnessSettings` 按矩阵实现，deep-merge 改为字段级）；`packages/pi-host/src/session-host.ts`（trust 门控）；`packages/ui` 设置页需按所有权显示哪些项来自工作区；设计文档 5.10 规则第 2 条与 plan 1.9 回写。D-015 在索引中标 superseded。
状态：待实施（P0 之后的首个设置项工作；实施前 `autoAcceptSuggestions.user` 至少先改为 user-only，因为这是安全侧）

### D-032 · 2026-09-04 · 3.4–3.5（取代 D-024 与 D-026 的对象模型部分）
类型：偏离
决定：线程对象模型改为 **Thread + ThreadRun**，状态改为**正交维度**：

```ts
Thread {
  id; parent: { kind: "session" | "thread"; id: string }; workspaceId; brief; kind;
  lifecycle: "queued" | "active" | "settled" | "archived";
  attention: "none" | "user" | "permission" | "stalled" | "looping";   // 归 Thread：Run 崩了问题还在等
  integration: "none" | "dirty" | "merge-ready" | "conflict" | "merged"; // 归 Thread：worktree 比 Run 活得久
  worktree; report; activeRunId?; hidden; createdAt; updatedAt; eventSeq;
}
ThreadRun {
  id; threadId; attempt; runtimeId /* "pi" */; sessionId;
  workerState: "starting" | "running" | "lost" | "exited";
  outcome?: "success" | "failure" | "cancelled" | "lost"; exitReason?;
  tokens; costUsd; steps; lastToolCall; startedAt; endedAt?;
}
```

worker 崩溃 = 当前 Run 以 `outcome: lost` 结束，恢复 = 新建 `attempt + 1` 的 Run 并更新 `activeRunId`；不再在同一条记录上清 `workerLost` 改回 `running`。`resumeThread` / `markWorkerLost` 因此废弃。存储改为按工作区一个目录：`PIARIUM_DATA_DIR/threads/<hostId>/<workspaceId>/{threads,runs}.json`，带 `schemaVersion`；父会话只是 `parent` 边，不再是目录所有者。读取只吞 `ENOENT`，其余（JSON 损坏、EACCES、未来 schema 版本）抛出且不缓存，绝不用空表覆盖。host 启动时对账：所有 `workerState ∈ {starting, running}` 的 Run 标 `lost`（host 重启后 worker 一定不在），线程 `attention` 按是否有未答问题恢复。
原因：设计 9.3.1 原文把 worker-lost / stalled / looping 描述为横切标志、merged / archived 描述为终态之后，是实现把它们拍进一个 `status` 枚举；`sessionId` / `workerLost` / `tokens` / `exitReason` / `report` 已经是一次执行尝试的全部字段，只是没起名字。这个形状已落盘、已进 protocol 事件，等接真 child session 再拆，改的是有数据的持久格式。JSON catch-all 吞掉一切读取失败并在下次写入时用空表覆盖，直接违反不变量 3。
考虑过的替代：(a) 保持单一 ThreadRecord，接通 child session 后再迁移——持久格式、UI、事件、恢复路径都会先依赖错误结构。(b) 完整 Work Graph（Artifact / Relations / Checkout 对象）——没有消费者之前不建，留在设计 12.2 作目标形态。(c) SQLite——几十条记录单写者，版本化 JSON + 原子写 + 对账足够。
影响：`packages/protocol/src/harness-threads.ts`（`Thread` / `ThreadRun` 替代 `ThreadRecord`，事件载荷同步）；`packages/web/application-host/lib/harness/thread-registry.ts`（重写存储与 API）；`harness-services.ts`、`thread-tools.ts`、所有线程测试；设计 9.3.1 / 9.3.4 回写。
状态：待实施（P0 第 4 项）

### D-033 · 2026-09-04 · 3.5 / 9.2.6（取代 D-026 (8) 的默认超时部分）
类型：偏离
决定：`wait` **只因三种事件返回**：目标线程的状态变化（含 `attention` 翻转、Run 结束、报告就绪）、用户输入或中止（abort signal）、调用方显式给的 `timeout_ms`。不再有按 provider 缓存 TTL 推导的默认唤醒；`DEFAULT_WAIT_TIMEOUT_MS = 240_000` 废弃，默认上限即 router 的 `HARNESS_MAX_REQUEST_TIMEOUT_MS`。"按 TTL 唤醒以续缓存"降级为**默认关的实验开关** `harness.wait.cacheKeepaliveWake`，`DEFAULT_TTL_TABLE` 只作 telemetry。是否启用由回放集数据决定（D-037）。
原因：设计 9.2.6 的 0.7× 对 1.0× 只在 30 分钟任务、5 分钟 TTL、每次唤醒完全续上缓存时成立，超过约 10 个 TTL 周期就比一次冷启动贵；更重要的是每次唤醒都是一次行动机会，防轮询只靠一句提示词，而设计 9.1 自己的原则是"传感器优先于指南"。TTL 唤醒的第二个理由——顺便看到 stalled / looping——不需要 TTL：这两个标志由 host 传感器翻转，翻转就是真实状态变化，`wait` 本来就在那里醒。
考虑过的替代：保留 240s 默认——那事实上就是 TTL 唤醒，只是数字写死了。
影响：`packages/protocol/src/harness-threads.ts`（常量废弃）；`thread-tools.ts` / `harness-services.ts`（wait 默认超时）；设计 2 节决策表"长时间委派"行、9.2.6、12.2 回写。
状态：待实施（P0 第 4 项内一并改）

### D-034 · 2026-09-04 · 1.4 / 3.5（输出引用的耐久契约）
类型：偏离
决定：两种引用，两种耐久级别，不再混用。

`TranscriptRef { runtimeId; sessionId; fromEntryId; toEntryId; branchLeafId? }`：**耐久**，指向 Pi 会话文件（每步落盘，就是原始 trace）；`ThreadReport.traceHandle` 改名 `transcriptRef` 并改为此类型；`read_thread(steps)` 经 host 的 `session.entries` 读它。

`OutputRef { handle; durability: "ephemeral"; generation }`：工具结果截断产生的 `out_` 句柄**临时**，不得写入任何持久记录。句柄编码 `out_<hostEpoch>_<sequence>_<mac>`，MAC 用 host 进程内每 epoch 随机密钥；store 按 session 保存 `{ nextSequence, evictedThrough }`，淘汰**必须是 FIFO**（水位方案的前提，写进契约）。判定：epoch 不同 → `expired`；MAC 无效 → `not-found`；`sequence ≤ evictedThrough` → `expired`；在表中 → `ready`；同 epoch、MAC 合法、`sequence ≥ nextSequence` → `not-found`。`dropSession` 后该 session 记入一张"已丢弃"表，其所有句柄判 `expired`。`expired` 与 `not-found` 是不同的错误码（不变量 3）。

偏移单位统一为 **UTF-8 字节**（设计 5.1 与所有 `[output: N bytes]` 文本已经是字节）；切片在字节边界处向最近的字符边界回退；分页结果返回 `nextOffset` 与 `eof`，调用方不得假设 `next = offset + length`。
原因：`OutputStore.total` 用 `Buffer.byteLength`、分页用 `text.slice` 字符索引，中文与 emoji 下两个字段单位不同；`ThreadReport` 落盘却引用 host 重启即消失的内存句柄，两个耐久承诺互相矛盾；淘汰后返回 `not-found` 把"曾经存在"折叠进"从未存在"。
考虑过的替代：(a) 落盘 blob spool——为工具输出建内容寻址存储超出需要，而线程的原始 trace 已经在 Pi 会话文件里。(b) 有限墓碑集合——墓碑被淘汰后旧句柄退化回 `not-found`，三态不稳定，上限也没有依据；FIFO 水位只要一个整数。
影响：`packages/web/application-host/lib/harness/output-store.ts`；`packages/protocol/src/harness.ts`（`OutputSlice` 加 `nextOffset` / `eof`；`HarnessError.code` 加 `expired`）；`harness-threads.ts`（`ThreadReport.transcriptRef`）；`output-tools.ts`、`tool-result-truncation.ts`；设计 5.1 原则 3 回写。
状态：待实施（P0 第 5 项）

### D-035 · 2026-09-04 · 3b.1 / 1.1（权限三层与 Host 静态授权）
类型：偏离
决定：权限不再寻找"唯一安全边界"，明确为三层，各有能管与不能管的范围：

1. **pi-host `tool_call` gate**：唯一做 allow / ask / deny 与 UI 交互的层；也是 `edit` / `write` / `apply_patch` 这类在 worker 进程内直接写文件的工具**目前唯一可阻断的门**。
2. **Host service authorization**：不弹窗、不重算用户策略，只验证 `ActorContext`、RunManifest 里的静态 capability、workspace / path 包含。覆盖 `shell.* / output.* / search.* / thread.* / fs.lock / lsp.*` 等经 host 中介的能力。用户关掉 `bash` 后本次 Run 的 capability 不含 `process.shell`，直接到达的 `shell.exec` 必须被拒——这不是第二套策略，是防绕过工具入口。
3. **OS containment**：将来限制 worker 绕过工具直接访问文件与网络（设计 9.1.1）；当前不具备，设计文档必须明说：**host 对 worker 本地文件写入只能观察，不能阻止**。

威胁模型写明：worker 是 host 自己 spawn 的同 OS 用户子进程，本来就有整个文件系统；Host 授权防的是**跨会话串线、陈旧 worker 污染、第三方 Pi 扩展借 host 能力越权**，不是防同权限下完全恶意的 worker。

`ActorContext { authorityInstanceId; sessionId; runId; workerId; workerGeneration; workspaceId; grantedCapabilities }` 只能由 broker 信封与 host 注册表生成。broker 规则：`session.open` / `session.create` 的**方法响应**成功后写入 `{ sessionId, workerGeneration }` 作为 pin；`session.snapshot` 只能验证与更新状态，不能重绑身份，不一致视为协议违规（诊断 + 忽略）；`session.closed` 不能仅凭 worker 自报清空 pin，关闭必须是 broker 发起成功或连接确认终止；未 pin 的 worker 发出的 harness 请求一律拒绝（catalog worker 没有会话，本就不该发）。Router 从信封取 ActorContext，`HarnessRequestData` 删除 `sessionId`。Host 授权按风险类别：`read`（search / output / lsp）、`process`（shell）、`control`（thread send / kill / merge）、`write`（未来经 host 中介的文档写入）。

过渡：RunManifest 落地前，host 从 broker 验证后的首次 `session.snapshot.activeTools` 与 Host 实际服务可用性推导 capability 并随会话注册冻结；不二次读取可能已变化的设置。RunManifest 下发后收敛为显式单一来源。

真值表（pi-host gate，进设计 9.1.2）：

| 规则匹配 | 高风险 | 本会话已授权 | 结果 |
| --- | --- | --- | --- |
| deny | — | — | 阻断 |
| allow（含 bypass、用户显式 allow 规则） | — | — | 放行 |
| ask | 否 | 是 | 放行 |
| ask | 否 | 否 | 弹窗；"Allow for this session" 记入授权 |
| ask | 是 | 任意 | 弹窗；"Allow for this session" **不**记入授权 |

工作区提供的 regex 规则须做 ReDoS 防护（长度上限 + 简单模式检查或线性时间引擎）。
原因：router 从 `envelope.data.sessionId`（worker 自报）取身份；broker 信封的 `sessionId` 又来自 worker 自己发出的 `session.snapshot`（`host-client.ts:340`），两层都不可信——worker 发一条伪造 snapshot 就能把自己重绑到别的会话，在别人的 shell 里执行命令。上一轮把 `parentSessionId` 从 params 挪到 `ctx.sessionId` 只是把信任下移了一层。
考虑过的替代：(a) 只改 router 用信封字段——信封本身不可信，改了没用。(b) Host 也做 allow / ask / deny——与 pi-host gate 双重门控，两次弹窗或两处不一致，正是插件共存时出过的问题。
影响：`packages/runtime-broker/src/{host-client,runtime-broker}.ts`（pin）；`packages/protocol/src/harness.ts`（删 `sessionId`，加 `ActorContext`）；`packages/web/application-host/lib/harness/{router,harness-services}.ts`；设计 9.1.2、architecture §5.1 回写。D-025 在索引中标 superseded。
状态：已实施（P0 第 1、2 项）

### D-036 · 2026-09-04 · 1.7（工作区级规范路径锁）
类型：偏离
决定：编辑锁的键从 `sessionId → path` 改为 `{ authorityId, workspaceId, canonicalResourceId }`；`acquire` 返回 `leaseId`，`release` 只凭 `leaseId`；路径身份规范化（realpath、Windows 大小写与 alias、符号链接）**复用 Documents authority**，harness 不再自行处理。锁只做进程内实现，其保证写明为："同一 Application Host authority 内，所有 Harness 管理的写操作按 workspace / resource 互斥"，不声称阻止其他 Piarium host、终端、Git 或外部进程写文件。
原因：plan 1.7 参考形状原文就是 `Map<sessionId, Map<path, queue>>`，两个会话写同一文件互相看不见；`release(sessionId, path)` 没有所有权 token，同会话内另一个请求可以误释放。所有会话的 harness 服务都在同一个 host 进程内，双 host 共用工作区的情形由 plan 2.1 的"复用运行中的 host"处理，跨进程 lease 不在需要范围内。
考虑过的替代：把锁做成 Documents 的 writer lease——Documents 的 lease 是按 scope 的写者模式，不是按文件互斥，形状不对；只借它的身份规范化。
影响：`packages/web/application-host/lib/harness/path-lock.ts`；`packages/protocol/src/harness.ts`（`fs.lock` 参数与结果）；`packages/pi-host/src/harness/path-lock.ts`（`withPathLock` 持 leaseId）；plan 1.7 回写。
状态：待实施（P0 第 6 项）

### D-037 · 2026-09-04 · 2.4 / 2.6 / 8.6（记忆 agent shadow mode 与回放门禁）
类型：偏离
决定：(1) 记忆 agent 以 **shadow mode** 接入：维护块、进 Zone 2、进 UI 面板，但**不接管压缩**；Pi 默认摘要保留。(2) 压缩接管、`explore` 默认开启、TTL 唤醒等**影响模型行为**的能力，`default-on` 的前提是通过**回放集**对比；基础设施类能力（bash / grep 覆盖、截断、权限门）`proven` 即可默认开启。(3) 回放集第一版：5–8 个来自 Piarium 自身历史的真实任务（跨多文件修改、测试失败到修复、长上下文后回忆早前决定、编辑器有未保存改动时的恢复），固定起点（commit + 工作区状态）与判定标准；三个指标：任务是否成功、总 token、人工介入次数；每次失败附一个类别（`retrieval miss` / `lost context` / `wrong edit` / `permission interruption` / `tool-runtime failure` / `coordination failure`）。对比必须同模型、同 provider、同起点。Recovery、安全、崩溃等确定性行为由 E2E 与故障注入验证，不进回放集。(4) 设计 8.6 "不建立独立评测集"改为上述最小回放集。(5) 设计 8.4.1 关于记忆 agent "前缀逐字节相同、整段缓存命中"的论证标为**未验证假设**：记忆 agent 必须带 `memory_edit` 工具才能 `tool_choice`，而不变量 8 禁止主 agent 有此工具，两者的 tools 块必然不同；Anthropic 的缓存层级为 tools → system → messages，tools 变则整段前缀失效。按 provider 实测分段命中后再定记忆 agent 的模型与成本模型。
原因：四个计数器只能回答"贵不贵、吵不吵"，回答不了"任务做对没有"；没有 baseline 就无法判断 explore 是否优于 grep、压缩接管是否丢关键事实、多线程是提速还是制造合并工作。记忆 agent 的成本论证有一个设计层面的洞（tools 不同），在它成立之前不能让压缩正确性依赖它。当前代码的接管条件（D-028 (5)：需存在 keeper 块）在记忆 agent 未接线时等价于 shadow mode，与本条一致。
考虑过的替代：(a) 大 benchmark——超出需要，且会腐烂。(b) 只看计数器——见上。
影响：设计 8.4.1、8.4.2、8.6 回写；`agent-harness-status.md` 的 `Default-on` 列以回放证据为门禁；回放集放 `packages/pi-host/test/replay/`（或独立脚本），与单测分开。
状态：待实施（P0 之后、线程纵切之前建立第一版回放集）

### D-038 · 2026-09-04 · 交叉（执行规则）
类型：默认值调整
决定：plan 0.1 的工作规则改为：

(1) **暂停规则**。以下五类偏离**暂停该工作项**、提交设计差异待验收，不阻塞其他独立工作项：持久格式 / 数据 authority / 破坏性迁移；身份、安全默认值、能力边界；删除、重命名或不兼容修改公共协议；不改签名但改变已有方法核心语义（例：`wait` 从快照改为阻塞）；新增不可逆外部副作用。新增可选字段、可选方法、内部重构照常推进并记日志。

(2) **交付单位**从"一个工作项一个提交"改为"一个可运行纵切一个交付组"：协议 → host → worker → 一条真实 E2E 全部到位才算交付，缺任何一段标 `implemented`（休眠）。

(3) **四级能力状态**：`implemented`（模块存在且单测通过）→ `wired`（进入真实生产调用链）→ `proven`（E2E、崩溃、平台行为验证，证据链接到具体测试或 smoke）→ `default-on`（对普通用户默认启用；影响模型行为的能力需回放对比）。只有 `proven` 算纵切完成。状态矩阵在 `agent-harness-status.md`，由执行 agent 随交付维护，roadmap 只引用它。

(4) **P0 integrity 纵切**的固定边界，七项做完立即进入真实 child session 的线程纵切，不顺手清其他债务：① broker 身份 pin；② Router `ActorContext` + Host 静态授权；③ 注册表错误分类、schema 版本、启动对账；④ 最小 Thread + ThreadRun 与正交状态；⑤ `OutputRef` / `TranscriptRef` 与 UTF-8 偏移；⑥ 工作区级规范路径锁；⑦ 对应的故障注入（崩溃、损坏、跨会话、Unicode）与契约测试。

(5) **范围**：Phase 4（默认 runtime）与 harness 内核正交，继续；Phase 5（外部 agent）、Phase 6（research profile）暂停，等 harness 内核与线程纵切 `proven` 后再开始——是顺序，不是取消。

(6) 报告规则：每条"已实施"附代码位置；"定义了但无调用点"不算已实施；推迟必须说明为什么现有骨架不可用。不做历史重写、不 force-push；误提交用正向删除提交处理。
原因："不停下来问"让权限插件被提前移除又恢复、权限门上线即锁死所有会话；"一个工作项一个提交"产生了 90 个模块测试全绿而生产链路没接通的"完成品"；设计头、plan、日志、roadmap 对"完成"定义不同，执行 agent 才会把单测等同于阶段完成。
考虑过的替代：暂停范围定义为"一切公共协议变更"——每加一个可选字段都要等人，执行会瘫。
影响：`agent-harness-plan.md` 0.1 / 0.4 / 验收节重写；`agent-harness-status.md` 新建。
状态：已实施（文档）

### D-039 · 2026-09-04 · P0.3–P0.4（线程 catalog 的原子存储形状）

类型：实现澄清

决定：D-032 的 `{threads,runs}.json` 概念形状落为**每 workspace 一个原子 catalog**：
`PIARIUM_DATA_DIR/threads/<hostId>/<sha256(workspaceId)>.json`，正文为
`{ schemaVersion, workspaceId, threads, runs }`。文件名用 workspace identity 的哈希，避免把外部 identity 当路径片段；Thread 与
ThreadRun 在同一次 temp-file + rename 中提交，避免两文件提交窗口。无版本的旧 parent 数组只有在 Host 已知
`(workspaceId, parentSessionId)` 关系时才导入，新 catalog 提交后保留旧文件，不猜 workspace、不静默删除。启动对账逐 catalog
报告 `corrupt / read-failed / future-schema`，健康 workspace 继续收敛；观察回调失败不能把已经落盘的提交伪装成失败。

原因：Thread 与 active Run 的变化是同一个逻辑提交；拆成两个文件需要额外 journal 或补偿协议，却没有带来读取或规模收益。
workspace id 当前通常是 UUID，但协议未来允许其他 runtime，持久路径不应依赖这一偶然格式。

考虑过的替代：(a) 两个 JSON 文件——存在一边 rename 成功、另一边失败的窗口。(b) SQLite——当前是单 Host、几十条记录，成本
高于收益。(c) 原样使用 workspaceId 作为文件名——把未来 adapter 提供的 identity 直接变成路径，不必要。

影响：`packages/web/application-host/lib/harness/thread-registry.ts`、`packages/protocol/src/harness-threads.ts`、设计 9.3.1、
architecture §5.1、plan P0.3–P0.4。

状态：已实施

### D-040 · 2026-09-04 · P0.5（输出句柄强度与旧报告迁移）

类型：实现澄清

决定：`OutputRef` 的 Host generation 与 HMAC 均采用 128 bit（32 hex），不是 plan 草稿里的 32 bit（8 hex）。句柄格式为
`out_<generation>_<sequence-base36>_<mac>`；HMAC 输入含 sessionId 与十进制 sequence，错误 session、伪造 MAC 与从未签发的未来
sequence 返回 `not-found`，旧 generation、FIFO 淘汰、dropSession、旧版 base32 handle 返回 `expired`。`dropSession` 不另建
无依据上限的墓碑集合，而是保留该会话的 `nextSequence / evictedThrough` 水位并清正文。

Thread catalog 因持久报告从 `traceHandle` 改为 `transcriptRef` 由 schema 1 升到 schema 2。schema 1 报告保留结论、文件、偏离与
blocks，转换为 `{ runtimeId: "pi", sessionId, fromEntryId: null, toEntryId: null }`；null 端点明确表示该会话当前分支首项 / 叶项。
读取 schema 1 本身不改盘，下一次真实 mutation 或启动对账需要写入时原子提交 schema 2；未来 schema 仍拒绝。

原因：32-bit MAC 在有错误 oracle 的长期 Host 中不适合作为不可伪造句柄；128-bit 不增加有意义的传输成本。单独墓碑集合迟早还要
猜一个淘汰上限，而单调 sequence 水位已经完整表达同一 Host generation 内的过期历史。旧 `traceHandle` 不能恢复原 entry 范围，
但 Pi session 文件仍是耐久真相，因此显式“全分支”比丢报告或伪造范围诚实。

影响：`packages/protocol/src/{harness,harness-threads,utf8}.ts`、Host `output-store.ts` / `thread-transcript.ts`、pi-host
`tool-result-truncation.ts` / `output-tools.ts`、thread catalog schema 2。

状态：已实施

## 决策索引

按 D-030 维护；本节可随时更新，条目正文不动。`folded-in` 表示已回写到设计或 plan。

| Decision | Current status | Superseded by | Folded into |
| --- | --- | --- | --- |
| D-001 | experiment-result | — | plan 0.1（删除过期的 0.83.0 描述） |
| D-002 | implementation | — | — |
| D-003 | active-design | — | native-workspace-recovery-design.md（`uncoveredReasons`；状态头 R1 implemented）— 待回写 |
| D-004 | active-design | — | native-workspace-recovery-design.md（`writerScope` 格式）— 待回写 |
| D-005 | implementation | — | — |
| D-006 | implementation | — | — |
| D-007 | implementation | — | — |
| D-008 | open-question | D-034（淘汰语义） | — |
| D-009 | implementation | — | — |
| D-010 | reverted | D-013 | — |
| D-011 | implementation | — | — |
| D-012 | reverted | D-014 | — |
| D-013 | active-design | — | agent-harness.md 5.2（现状注记）、`lib/harness/DOCUMENTATION.md`（哨兵/环境变量）；前置条件"接进 terminal runtime"未兑现 → status Blocker |
| D-014 | implementation | — | — |
| D-015 | contradicted → superseded | D-031 | agent-harness.md 5.10 |
| D-016 | implementation | — | — |
| D-017 | implementation | — | — |
| D-018 | implementation | — | status（1.11 未接渲染路径） |
| D-019 | active-design | — | agent-harness.md 7.5 |
| D-020 | active-design | — | agent-harness.md 7.5 |
| D-021 | reverted | — | status（3b.3 真实状态） |
| D-022 | experiment-result | — | agent-harness.md 12.2 |
| D-023 | active-design | — | architecture.md §5.1（已有）、`lib/harness/DOCUMENTATION.md`— 待回写 |
| D-024 | superseded in part | D-032（对象模型与存储布局） | agent-harness.md 9.3.1 |
| D-025 | superseded in part | D-035（ask 走 UI、三层模型） | agent-harness.md 9.1.2 |
| D-026 | superseded in part | D-032（对象模型）、D-033（wait 默认超时）、D-034（`traceHandle`） | agent-harness.md 9.3 |
| D-027 | implementation（更正记录） | — | status（未完成项表） |
| D-028 | active-design | — | agent-harness.md 9.2.2 / 9.1.2 / 8.4 / 5.9、architecture §5 |
| D-029 | implementation | — | — |
| D-030 | active-design | — | 本文件治理规则 |
| D-031 | active-design（待实施） | — | agent-harness.md 5.10、plan 1.9 |
| D-032 | folded-in | D-039（原子 catalog 文件形状） | agent-harness.md 9.3.1 / 9.3.4、plan P0、protocol / Host registry |
| D-033 | folded-in | — | agent-harness.md 2 / 9.2.6 / 9.3.6 / 12.2、protocol 与 thread services |
| D-034 | folded-in | D-040（位强度与 schema 1 迁移） | agent-harness.md 5.1、plan P0、protocol / Host / pi-host |
| D-035 | folded-in | — | agent-harness.md 9.1.2、architecture §5.1、plan P0；protocol / broker / Host router 已落地 |
| D-036 | active-design（待实施） | — | plan 1.7 / P0 |
| D-037 | active-design（待实施） | — | agent-harness.md 8.4 / 8.6 |
| D-038 | active-design | — | plan 0.1 / 0.4 / 验收 |
| D-039 | implementation | — | architecture §5.1、plan P0.3–P0.4、thread-registry.ts |
| D-040 | implementation | — | agent-harness.md 5.1、plan P0.5、output-store / transcript reader |
