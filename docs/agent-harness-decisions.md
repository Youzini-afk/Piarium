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

### D-041 · 2026-09-04 · P0.6（批量规范路径租约）

类型：实现澄清

决定：D-036 的逐路径 `acquire` 落为一次 `fs.lock { action: "acquire", paths[] }`。Router 先让 Documents authority 为每条
路径产出 `{ authorityId, workspaceId, canonicalResourceId }`，Host service 再去重并按三元组全序获取；整批共享一个 30 秒
默认 deadline（显式 timeout 可覆盖），中途失败反向释放已得 lease。成功返回 `leaseIds[]`；release 请求只有 leaseId，Host
另外用 broker Actor 的 session owner 校验令牌归属。`apply_patch` 在执行任何一个文件操作前一次拿齐整批租约。

原因：让 worker 按原始路径逐个 acquire，即使每把锁本身正确，两个多文件调用仍可按相反顺序形成死锁；alias 还会让 worker
无法自行稳定排序。规范化只能由握有 Documents identity 的 Host 做，因此批量请求是让“去重 + 全序”成为真实协议保证的最小形状。

考虑过的替代：(a) worker 对原始字符串排序——Windows 大小写、`..`、符号链接和 alias 会得到不同顺序。(b) Host 提供先
canonicalize 再逐个 acquire 两步——在两步之间引入新竞态，协议也更吵。(c) OS / 跨进程锁——当前威胁模型只要求同一
Application Host 内 Harness 管理的写入互斥，不能借此声称管住终端、Git 或外部程序。

影响：protocol `FsLockParams/FsLockResult`、Host `path-authority.ts` / `path-lock.ts` / `harness-services.ts`、pi-host
`path-lock.ts` / `apply-patch-tool.ts`。

状态：已实施

### D-042 · 2026-09-04 · P0.2（静态 capability 取实际工具集）

类型：实现澄清

决定：RunManifest 尚未落地时，Host capability 从 broker 验证后的 `session.snapshot.activeTools` 与 Host 服务可用性推导，
而不是从 `HarnessSettings.tools.*` 的覆盖开关直接推导。`tools.bash = false` 当前语义是“不注册 Piarium 同名覆盖、回退 Pi 内置
bash”，因此实际 `activeTools` 仍有 bash 时必须保留 `process.shell`；只有会话真实没有 bash 才拒绝 `shell.*`。同理，
`write.document` 在 active tools 含 `write`、`edit` 或 `apply_patch` 任一项时授予，因为三者都会使用 Host 路径租约。

原因：把“关闭某个实现”误读成“撤销整个风险类别”会让内置 fallback 仍可写文件，却被 Host 拒绝其 mutation lease，最终表现为
普通 edit/write 全部失败。能力必须描述当前 Run 实际能做什么，不是某个 UI toggle 的字面值。

影响：`service-host.ts::deriveHarnessCapabilities`、设计 9.1.2、RunManifest 后续契约。

状态：已实施

### D-043 · 2026-09-04 · T1（真实 Pi child 线程纵切）

类型：实现澄清

决定：(1) Application Host 通过私有握手的 `harnessThreads` 能力声明真实线程运行时，删除用户设置里的临时
`threadRuntime`；没有该能力时 pi-host 不注册七个线程工具。(2) `dispatch` 先原子写入 Thread + `starting` Run 后立即返回，
worktree 与 Pi child session 在后台创建。(3) Thread catalog schema 4 新增不可变 `ThreadLaunchManifest { tools, worktree, scope,
systemPromptFragment, concurrency }`，resolved model 也随 Thread 持久化；`session.create/open` 在构造 AgentSession 前接收模型和工具 allowlist，
因此角色工具边界不是提示词。(4) T1 保持基础 system/Zone 0 不变，把角色片段、scope 与 brief 放首条任务消息；子 allowlist 不含
`dispatch`，嵌套留待独立纵切。(5) isolated worktree 在父 dirty 状态上建立内部 baseline commit，merge 只应用 child delta；未跟踪
碰撞先预检，冲突结果区分 Git markers 与 parent-unchanged。(6) 第一次意外 worker 退出在同会话/worktree 开新 Run；连续第二次
崩溃翻 `stalled`，不形成无限重启。无事件 300 秒只告警，连续 6 次相同工具+参数哈希翻 `looping`；交互请求投影为
`user/permission` attention。(7) 同一 registry 投影到七个工具、`piarium-harness` Fleet provider、SSE 与父会话最小桌面侧栏。
(8) broker 删除父会话前调用 Application Host coordinator；它在 registry 的 draining 区间停止 active child、取消 queued/active
Run，并归档全部直接子线程，之后才允许删除 Pi session 文件。若用户直接删除 child session，registry 归档其 Thread 并清除指向
即将删除文件的 report/TranscriptRef，不留下“可读”假引用；历史 Run outcome 不被改写。

原因：如果工具先按默认模型构造、之后再切角色模型，provider 专属工具会错配；如果角色工具只写在提示词里，`check/review`
仍能拿到写工具；如果 dispatch 等待 worktree 与 worker，创建体验会重现此前新会话长时间“正在发送”的问题；如果崩溃无恢复，
ThreadRun 只是日志，若无限恢复又会制造进程崩溃循环。内部 baseline commit 则解决父 dirty patch 被合并两次的确定性错误。

考虑过的替代：(a) 继续用 `HarnessSettings.threadRuntime`——Host 缺服务时会暴露只返回 unavailable 的工具。(b) child 创建后再
`model.select`——工具注册已经完成，太晚。(c) 只靠角色提示词约束——不是能力边界。(d) 每次崩溃都自动恢复——同一损坏会无限
拉起进程。(e) 合并前直接复制 untracked——会在发现后一个冲突前留下部分写入。

影响：protocol `HostHandshakeParams` / `session.create/open` / `ThreadLaunchManifest`（thread catalog schema 4）；runtime-broker launch
投影；pi-host SessionHost、角色工具与 Fleet adapter；Host `thread-runtime.ts` / `thread-worktree.ts` / registry / route；UI
`HarnessThreadsPanel` 与 SSE。尚未包含：scope 的 Host 强制、Zone 2 threads 段、worktree/branch 回收、窄屏与讨论线。

状态：已实施

### D-044 · 2026-09-04 · T2（权限插件共存与 scope 的真实边界）

类型：设计修正

决定：(1) `@gotgenes/pi-permission-system` 继续作为 foundational Pi package provision，不再把 T2 之后移除插件当作默认路线。
在会话发布了与本 sessionId 对应的 permission service 时，Piarium 原生 `tool_call` 门完全让位，由插件单独提示；service 缺席或
热卸载后原生门恢复，作为 **Harness 工具范围内**的 fallback。检测每次按 session-keyed service 重新确认，不因其他会话事件串线，
也不缓存已经失效的服务。(2) 原生 Smart 只属于 fallback；插件活跃时若需要模型判断，走插件的 `registerAuthorizer` seam，且仍需
用户在 `authorizerChain` 中显式列名，Piarium 不暗改插件配置。(3) 删除 Web/Application Host 中未接生产链的 `smart-mode.ts`
原型，实际实现只有 pi-host 会话内的一份。(4) child Run 的工作目录先注册为独立 Documents workspace，再绑定 Pi session；
`scope` 随 broker Actor 传播并约束 Host 可解析路径的服务与搜索结果。它不是 OS containment，不声称约束 shell 命令文本或 worker
内直接运行的 Pi 工具。

原因：对本机实际 provision 的 `pi-permission-system` v27.0.1 公共声明与文档核对后，它已覆盖 Bash AST 拆分、规范/符号链接路径、
外部目录、MCP、skills、子会话转发、会话授权、审计以及跨扩展 formatter/extractor/authorizer API；原生门只认识
`HARNESS_TOOL_META`。按旧计划移除会真实缩小保护面。简单地同时运行两个门又会连续弹两次确认。另一个实锤问题是 isolated
child 曾绑定父 Documents workspace，使 Host 搜索和路径 authority 指向父树而不是 worktree；单独 runtime workspace 修复该身份错误。

考虑过的替代：(a) 原生门优先、插件随后再判——无法保证一次提示，且两套路径/命令语义会漂移。(b) T2 结束立即移除插件——
没有能力等价证据。(c) 自动把 Piarium Smart link 写进插件 `authorizerChain`——注册 link 本身不应取得用户授权，违反插件公开契约。

影响：`permission-gate-extension.ts` / SessionHost；Thread runtime、broker actor scope、Host path/search authority；设计 9.1.2、
plan 3b、状态矩阵。

状态：已实施

### D-045 · 2026-09-04 · T3（上下文观察与 memory shadow 的生产形状）

类型：实现澄清

决定：(1) Documents authority 在 `write/move/delete` 成功提交后发布结构化 mutation observation，携带规范 workspace/resource、
created/modified/deleted 与已校验 writer owner；观察回调失败只记 Host 错误，不能反噬已经成功的文件提交。同 workspace 的每个活跃
session 各写一条 event，保持 session 删除级联与各自增量游标语义。(2) Zone 2 请求增加 `afterEventId`、query、context usage；返回
`eventCursor`，并把 cursor 写入隐藏的 `piarium-context` custom message。worker 重载从会话历史恢复 cursor，普通重试不重复追加。
相关 accepted knowledge 按当前 prompt 召回；用户修改后的 LSP error/warning 才作为新诊断进入，agent 自己触发的诊断不复述。
(3) memory keeper 的模型调度在 pi-host（它握有真实 system/messages/model），块校验与写入在 Host（它拥有知识库）。两者通过
`memory.blocks.get/apply` 连接。旧 Host runner 的空 sessionId 与陈旧块快照实现删除。(4) `harness.memory.shadowMode` 是 user-only、
默认 false；开启后使用活动会话模型，UI 明示 tools 前缀不同可能产生全价请求。pi-ai 通用 API 只支持 `toolChoice: auto/none`，
所以无 `memory_edit` tool call 就视为未更新，不解释自由文本。(5) `compaction.takeoverEnabled` 默认 false；即使已有 memory-agent
块，shadow 也必须交还 Pi compaction。低置信度 todo 的确认移到 pi-host UI，Host 只接受显式 confirmed 标志并不再用恒真桩。

原因：观察与记忆必须成为真实会话纵切，但在缓存与质量回放之前不能让后台调用静默产生费用或让实验块成为压缩正确性的依赖。
event cursor 放在耐久会话消息里，比 Host 内存游标能承受 worker 重载；写后 observer 则比 watcher 时序推断 writer 来源准确。

考虑过的替代：(a) Host 自己调用模型——拿不到真实 session context/provider runtime；旧 runner 也已证明 session identity 为空。
(b) 默认开启并固定主模型——缓存命中尚无证据。(c) keeper block 一出现就接管压缩——把实验输出变成数据正确性依赖。
(d) 所有 LSP 诊断都进 Zone 2——会重复 agent 刚在工具结果里看到的错误。

影响：protocol memory/Zone 2 方法；Documents observation；knowledge context runtime；pi-host memory/Zone 2/todo 扩展；Harness Settings；
设计 7.3、8.4，plan T3，状态矩阵。

状态：已实施（核心 shadow 纵切；terminal/Git/面板/事件加速仍在状态矩阵）

### D-046 · 2026-09-04 · T3（session blocks 的用户投影与鉴权）

类型：实现澄清

决定：session blocks 与 delegated threads 共用父会话右侧的 session state 侧栏。blocks 的 GET/PUT 与 threads GET 都经过
现有 UI authentication middleware；用户保存写 `updatedBy: user`，并携带打开时的 `updatedAt` 做同一写队列内的乐观并发检查，
后台已更新则返回 409、重取而不覆盖。KnowledgeStore 提交 block 后广播的 SSE 只含
`{workspaceId, sessionId}` 失效通知，正文由 UI 重新走鉴权 GET 获取，避免把记忆/计划内容放进广播载荷。观察/UI 回调失败不能
把已提交的 block 写伪装成失败。

原因：shadow memory 若不可见、不可编辑，就没有用户审计出口；但 blocks 含任务状态和可能的敏感上下文，不能直接塞进 SSE。
实现时同时发现 T1 的 `/api/harness/threads` 未显式挂 UI auth，会暴露任务说明、worktree 路径和报告元数据，必须同批封口。

影响：Host `context-routes.ts` / `thread-routes.ts`、KnowledgeStore block observation、全局 UI event、
`HarnessThreadsPanel` 与 block parser、设计 8.4.1、状态矩阵。

状态：已实施

### D-047 · 2026-09-04 · T4（最小回放集与执行边界）

类型：实现澄清

决定：第一版回放集固定 6 个真实 Piarium 历史任务，范围为 5–8 的设计窗口内；每项记录 base/reference full commit、用户任务、
可观察验收和建议检查。reference 是评审证据，不是 exact-diff oracle。每次实验按 `{case, model, pair}` 各跑 `native` 与
`harness-shadow`，只比较成功、总 token、人工介入次数；失败另记 D-037 的分类。记录器默认只校验/建记录/汇总，绝不调用模型、
建 worktree 或改用户 settings。自动运行要等 per-session Harness profile override，不能用修改全局设置的捷径。

原因：当前 Harness 设置在 session 创建时从用户/项目文件冻结，没有实验专用的单会话覆盖；自动切全局设置会影响并行普通会话，
结果也无法证明究竟运行了哪个 profile。先固定任务与证据格式，可以开始人工配对，同时不伪造自动化程度或产生意外 API 费用。

影响：`evaluation/harness/cases.json` / README、`scripts/harness-replay.mjs` 与测试、package scripts、设计 8.6、状态矩阵。

状态：已实施（清单与记录器）；真实 paired runs 尚未执行

### D-048 · 2026-09-04 · 1.11（工具摘要接入真实时间线）

类型：实现澄清

决定：`toolSummary.ts` 接入 `PiTimelineEntries` 的真实 live 渲染。每张卡标题显示 tool name + arguments/details 派生摘要；同一
assistant message 中连续的已知只读工具（read/grep/find/glob/ls/diagnostics/web）2 个以上折叠为一组，写入、shell、thinking/text
与未知扩展工具均打断。组在任一调用运行时展开，结束后可折叠，内部仍是原有完整工具卡与 extension renderer。sorted 模式已有
统一 activity 容器，不再叠一层默认折叠。

原因：原实现只有纯函数和 17 个测试，没有生产 import；同时其“未知且不在写工具名单 = 只读”会把第三方变更工具错误折叠。
未知工具改为不分组，宁可多一行也不伪造 mutation 属性。

影响：UI `toolSummary.ts`、`PiTimelineEntries.tsx` 与 SSR/render tests；设计 5.1、状态矩阵 1.11。

状态：已实施

### D-049 · 2026-09-04 · 1.8（Harness 计数器进入现有 Context 侧栏）

类型：实现澄清

决定：不新建诊断面板。pi-host 已随 `session.stats` 发布的 `toolErrors/toolRetries/outputBytes/cacheHitRatio` 投影到现有 Context
sidebar 的独立 Agent harness 区块。只有至少一个字段真实存在才显示；缺失字段不补 0。输出按二进制单位显示，cache ratio 显示
百分比。真 Pi 会话 E2E 必须证明失败、重复调用和输出字节确实穿过 stats 边界。

原因：计数器的消费者本来就是会话诊断视图；另造 store/route/panel 会复制 SessionStats，并让其他 runtime 的“不支持”看起来像
“全为零”。

影响：UI `ContextSidebarTab` / `harnessCounterPresentation`、pi-host session E2E、设计 8.6、状态矩阵 1.8。

状态：已实施

### D-050 · 2026-09-04 · 1b.2–1b.3（Web 工具按 Host 真实能力注册）

类型：实现澄清

决定：client handshake 新增可选 `harnessWebRead/harnessWebSearch`。pi-host 在 AgentSession 构造前读取并冻结：Host 未声明
`harnessWebSearch` 时不注册 `websearch`；未声明 `harnessWebRead` 时，即使用户配置了 reader model，`webfetch(prompt)` 也直接
返回提取正文，不先请求休眠服务。`pi-web-access` 的显式让位规则保持优先。Web Host 当前两个值均为 false，直到真实 provider
被创建并注入，不能用 `resolveSearchProvider` 返回空数组的 placeholder 冒充能力。

原因：状态矩阵已发现 `websearch` 对真实会话是“工具可见、每次 unavailable”；reader 路径也会多一次注定失败的 round-trip。
线程工具已用同一握手模式解决休眠实现暴露，Web 应复用而非另建探测。

影响：protocol handshake、HostController/SessionHost、`selectHarnessTools`、Web broker factory 与能力 E2E；状态矩阵 1b.2/1b.3。

状态：已实施（能力门）；真实 reader/search provider 仍未实现

### D-051 · 2026-09-04 · 3.8（LSP 导航接入真实 LanguageSupervisor）

类型：实现澄清

决定：新增 `lsp.symbols/definition/references/hover` typed Host methods 与同名 pi-host 工具，由 handshake
`harnessLspNavigation` 在 AgentSession 构造前统一开关。所有文件路径先过 Router/Documents authority 与 child scope；Host 使用
authority 给出的 workspace-relative resourceId。未同步文件只在 LanguageSupervisor 尚无 desired document 时从 Documents 读取并
`didOpen`；已有编辑器 buffer 绝不被磁盘内容覆盖。请求携当前 documentVersion，agent 参数 line/character 为一基，进入 LSP 前
转零基，输出位置再转一基。`symbols` 要求代表文件 path 来确定语言 provider。三态保持 ready/empty/unavailable。

原因：旧 `lsp-nav.ts` 是自成一套的假依赖接口，没有生产调用点，也没有适配真实 Supervisor 的 status/value、documentVersion 与
buffer ownership；直接给它补 pi-host 工具仍会是休眠实现。真实 fixture 进程测试还暴露了不携版本会被 Supervisor 正确判 stale。

影响：protocol HarnessServiceMap/handshake；Host router/path authority、LanguageSupervisor 与 nav adapter；pi-host tools/能力门；
工具卡摘要；设计/plan/status 3.8。

状态：已实施

### D-052 · 2026-09-04 · 3.9（Host 观察游标与后台 shell 持续采集）

类型：实现澄清

决定：(1) Host 以 `ObservationCursorStore` 持有 `(observerSessionId, objectKind, objectId)` 游标；会话结束与
`compaction.after` 清该观察者的游标，后者同时清线程观察游标。Host 重启天然回到全量基线。(2) `get_output(sh_*)` 仅在
`offset` 和 `length` 都缺席时采用增量语义；`shell.exec` 以已经返回给模型的 `outputSoFar` 字节数预置基线；任一显式分页参数都是
随机访问且不推进游标，静态 `out_*` 始终保持分页语义。同一对象的观察原子串行，压缩/会话清理会使在途旧 epoch 失效，不能在完成后
写回已经重置的游标。
(3) `diagnostics(path)` 首次返回当前基线，此后按完整诊断指纹的多重集差分新增与消失项；`full: true` 返回完整快照且不推进
增量游标。对象身份使用 Router/Documents 已授权的 canonical resource，而不是调用方原始路径。(4) 会话计数器新增
`observationCalls`，只统计实际进入默认观察语义的调用并投影到既有 Context 侧栏。(5) PTY 命令转后台后仍由同一 supervisor
持续收集输出、解析 cwd/exit 哨兵并关闭 writer；同一持久 shell 上仍有后台命令运行时不接受第二条命令，因为该 PTY 无法并发
执行两个前台命令。

原因：仅加游标不足以形成真实能力。旧 supervisor 在 timeout 后把 `pendingCommand` 清空，后续 PTY data 落入初始化缓冲，
`sh_*` 的内容永远停在转后台那一刻，退出哨兵也不会再解析；旧 E2E 又把 `id` 误传给只接受 `handle` 的工具，并仅断言错误文本
非空，形成假绿。增量状态放在 Host 而非 worker，能活过 worker 重载又不写进模型上下文；显式读取不动游标，使调试回看不会改变
下一次默认观察的基线。

影响：protocol `ShellReadResult` / `DiagnosticsResult` / `SessionStats`；Host observation store、shell supervisor、diagnostics 与 compaction
services；pi-host 工具格式与计数器；Context sidebar；plan/status 3.9。

状态：已实施

### D-053 · 2026-09-04 · 3.4（原生线程进入父会话 Zone 2）

类型：实现澄清

决定：(1) `zone2.assemble` 在知识/编辑材料之外，从同一 Host 的 `ThreadRegistry` 投影线程：queued/active（含 waiting、stalled、
looping）每个父回合都作为事实快照出现；settled/archived 仅在该观察者尚未见过其最新 `eventSeq` 时出现，完成结论、偏离与 diff
随该行交付。(2) Zone 2 使用独立的 `zone2-threads` 观察游标，不推进 `threads`/`wait` 工具的游标；压缩和会话结束沿 D-052 一起
重置。(3) child session 通过持久 Run 的 sessionId 反查所属 Thread，嵌套线程以 `{kind: thread, id}` 为父，不错误投到根会话。
(4) Thread 与 active Run 由注册表一次 catalog 快照读取，避免状态转换期间拼出不一致组合。(5) 不新增固定 `zone2Max` 数量限制；
行按现有 Zone 2 总 token 预算动态保留，优先 waiting/stalled/active/conflict，余项折成一行并提示用 `threads` 查看。(6) 注册表读取
失败投影为显式 `<threads status="unavailable">`，不把损坏/权限错误当作“没有线程”。

原因：线程运行时、侧栏和主动工具已经进入生产链，但父 agent 不调用 `wait` 时完全看不到完成或等输入事件。每轮全量重复所有历史
线程又会持续污染上下文。活跃快照 + 终态增量同时满足监督和低重复；预算来自 Zone 2 已有资源边界，比再猜一个固定条数更符合真实
上下文容量。

影响：Host `zone2-threads.ts`、ThreadRegistry atomic snapshot/session lookup、Zone2 material/formatter、3.9 observation store；phase3 E2E；
plan/status 3.4/3.5。

状态：已实施

### D-054 · 2026-09-04 · 2.3（Git 状态观察复用现有刷新边界）

类型：实现澄清

决定：(1) `/api/git/status` 与 `/api/workspace/git/status` 每次成功取得状态后，以 best-effort 回调交给 knowledge runtime；回调失败
不得改变已经成功的 HTTP 响应。(2) adapter 通过 Documents `resolveScopeId` 找包含该 repo/cwd 的已注册 workspace，再投影为
branch、changed file count，以及 ahead/behind/merge/rebase 摘要；不把文件名或 diff 正文复制进事件库。(3) 每个已绑定 session 对
相同摘要做指纹去重，状态真正变化后才写新 event；首次观察作为基线事实进入下一轮 Zone 2，压缩后只清该 session 的去重基线，
下一次现有刷新可重新交付当前事实。(4) 不新增 Git 轮询器或 watcher：复用
IDE/Workspace 已有状态刷新，外部 Git 变化会在下一次状态刷新时被观察；UI 未刷新期间不声称实时。(5) user terminal 暂不接：现有
terminal 是持久 PTY，process exit 只代表整个 shell 退出，不能冒充单条命令完成；命令与 exit code 要等 shell integration 协议。

原因：Git API 已经是当前两个工作台读取 SCM 真相的共同边界，挂一次轻量投影即可获得准确状态且没有额外扫描成本。直接监听文件
变化再运行 Git 会复制现有刷新机制；把终端键盘输入按换行猜成命令则无法处理多行、交互程序、shell quoting 和退出码，会制造假事实。

影响：Platform routes、Git/Workspace Git status routes、Documents workspace resolution、knowledge Git adapter/context runtime、Zone 2；
plan/status 2.3。

状态：已实施（Git）；user terminal 仍待 shell integration

### D-055 · 2026-09-04 · 3.4（父 blocks 快照与可核验 ThreadReport）

类型：实现澄清

决定：(1) Thread spawn 在创建 child session 前读取父 Pi session 的当前 blocks；非空块以 `<parent-blocks>` 数据段加入初始任务，
明确这是 dispatch 时快照且父可能已前进。空与 unavailable 分开标记；读取失败记 Host error 但不阻止子会话。(2) 初始任务要求最终回答使用
`Conclusion` / `Deviations from brief` / `Unresolved issues` 三个标题。Host 只保守解析这三个受控标题，不从普通散文猜状态；没有结构时
整段仍作为 conclusion。(3) settle 同时读取 child blocks，完整复制为 `blocksSnapshot`；`decisions` 中显式
`Deviation: ...` 与最终回答的 deviation 合并去重。读取失败或 store unavailable 写入 report.unresolved，不伪装为空。(4) metrics、
transcript bounds、worktree diff、blocks 与结构化最终回答收齐后，仍通过 ThreadRegistry 的同一次 `endRun` 原子提交 report 与 Run 终态。

原因：此前 child 启动只拿任务文本，报告又把 `deviations` 和 `blocksSnapshot` 永久写成空值；`read_thread(blocks)` 与 Zone 2 完成行
因此看似结构化，实际没有数据。受控标题与显式 block 标记比对任意自然语言做启发式抽取可靠，同时在 memory shadow 默认关闭时仍能
从最终回答得到报告。

影响：ThreadRuntime session adapter、Application Host knowledge store wiring、真实 Pi child E2E、read_thread/Zone 2 已有消费者；
设计 9.2.5 / 9.3.5，plan/status 3.4。

状态：已实施

### D-056 · 2026-09-04 · 3.6（删除休眠且无依据的 role budget）

类型：设计修正

决定：从 `RoleDefinition` 删除 `budget.maxTurns/maxTokens` 以及六组固定数字。角色继续冻结模型、工具、worktree 和提示片段；Run 继续
记录真实 steps/tokens/cost 并由 Fleet/报告展示。当前不增加自动停止、降级或排队策略。未来若用户显式要求预算，或 T4 同模型回放给出
可定标的分布，再单独设计“用户策略/默认值/告警/硬边界”中的正确层级和 Pi child 执行原语，不能复活仅存在于 catalog 的假字段。

原因：全仓只有定义和“数字大于零”测试，没有生产读取点；Pi child 的一次 Run 也没有 per-role turn/token enforcement。现有
10/15/20/40/50 turns 与 30K–200K tokens 没有协议上限、基础设施数据或回放依据。把它们接成硬拒绝会截断正常长任务，保留则让
状态矩阵长期误报一个不存在的能力，均不如删除。

影响：protocol `harness-roles.ts`、roles tests、plan 3.6、status 3.4/3.5。并发 12 是独立的 Host 背压机制，不受本决定影响。

状态：已实施

### D-057 · 2026-09-04 · 3.4（结果分支先耐久化，live worktree 暂不自动删除）

类型：设计修正

决定：(1) isolated worktree 创建时把内部 `piarium/thread-*` branch 写入持久 `ThreadWorktree`；settle 时将 child 的 staged、tracked 与
untracked 最终状态用 `--no-verify --no-gpg-sign` 提交为内部 result commit，并记录 `resultCommit`。merge 前再次 snapshot，确保等待期间
的新改动也进入分支；snapshot 失败则 merge 不开始，worktree 保留。(2) `base → resultCommit/working tree` 仍是 child delta，既有
plain apply → `--3way` 和 untracked 预检不变。(3) merge 成功暂不自动删除 live worktree，也不启动“默认 7 天”分支计时器；当前线程
侧栏重新打开完整 child session 仍依赖该 cwd，删除会导致打不开，或更危险地把后续对话重定向到父工作区。(4) 真正回收要与“从持久
transcript 只读打开”或显式归档/rehome 同批交付；届时 result commit 是删除前可验证的恢复锚点。没有用户策略或磁盘数据前不猜期限。
(5) registry 已是 `merged` 时再次调用 merge 返回明确 no-op，不重放 patch。
(6) result commit 中相对 base 新增的路径继续走 new-file 预检并从 tracked patch 排除；同路径不同内容时父树保持零写入。复制相对
symlink 时保留 link，自 child worktree 指出的绝对 symlink 不复制，避免父树依赖将来会回收的 child 路径。

原因：旧文档说 merge 后删目录、留分支，但旧分支只有父工作区 baseline，child 结果完全未提交，直接删除会丢唯一独立副本；补上
提交后，又发现 UI 的 thread open 仍使用 `thread.worktree.path`。所以本轮先消除数据丢失前提，不用磁盘回收换取会话生命周期回归。

影响：protocol `ThreadWorktree.branch/resultCommit`（向后兼容可选字段）、ThreadRegistry parser、ThreadWorktreeRuntime snapshot、
ThreadRuntime settle/merge、真实 Git tests；设计 9.2.5b / 9.3.4、plan/status 3.4。

状态：已实施（结果耐久化）；目录/分支回收仍待产品纵切

### D-058 · 2026-09-04 · 2.7（用户标记 → 双作用域知识审阅纵切）

类型：实现澄清

决定：(1) 现有 session state 侧栏中的 block 提供“记到项目/记到用户”两个显式动作，只创建 `suggested` 条目；无 suggestions model
时 trigger 留空，由用户在审阅卡编辑。(2) 鉴权 Host routes 同屏读取 workspace store 与 `user.tdb`，每条 identity 是 `(scope,id)`；
每项操作先验证 URL 中的 session 能解析 workspace，再选择目标 store，不能给 user knowledge 伪造来源；user store 拒绝非 user scope
写入。单独保存与接受都携带草稿及打开时原值，写队列内不匹配返回 409；接受在同一个 store task 中完成编辑、状态与取代预检，
accepted/dismissed 条目不能再按 suggested 编辑。(3) 接受时 `supersedes` 必须是同 store、同 scope、当前有效的 accepted knowledge；全部预检后才使旧条目失效并建边，
不删除历史。候选只要 trigger 词有交集就按重合度排序展示，不用无数据依据的 0.5 阈值隐藏；是否取代必须由用户勾选。(4) mutation
SSE 只广播 `{sessionId,scope}` 失效通知，正文重新走鉴权 GET。(5) 删除未接 UI 且“先 dismiss、后模型 create”会在后半失败时吞掉建议
的 regenerate 原型；模型草拟、用户消息识别和 memory decisions 自动提议继续保持未接，不产生静默费用。

原因：此前 suggestion/store helper 虽有单测，但没有路由或组件引用，且 create 固定写 workspace、auto-accept 也固定读 workspace 设置；
它不是可用能力。先交付用户明确标记的无模型纵切，能验证治理、双时态与作用域，而不需要提前决定自动抽取质量。

影响：KnowledgeStore mutation contract、`knowledge-suggestions.ts`、authenticated context routes、global SSE、session state sidebar 与 10 locale；
设计 7.2.2，plan/status 2.7。

状态：已实施并 proven（block user-mark）；其他两类触发与完整 Settings 知识管理仍待实现

### D-059 · 2026-09-04 · 3.1（Documents 驱动的真实 file/symbol/defines 图）

类型：设计修正

决定：(1) 删除旧 collector 的伪实现：不再用 `event` 节点冒充 file/symbol，不再用 `edgesCreated++` 冒充图边，也不保留无依据的
`maxFiles=200`。(2) KnowledgeStore 新增真实 `file` / `symbol` payload 与 `defines` edge 原语。单文件替换先 batch insert
`active:false` 新符号，再用 TriviumDB `commitTransaction` 同批更新 file generation、删旧符号、激活新符号并建边；崩溃窗口最多留下
不可检索的 inactive staging，下次替换回收。(3) Documents 权威写后 observation 是唯一触发：created/modified 按 path 串行，deleted
删 file graph；不做启动时全仓扫描或额外 watcher。未知语言只 touch file；LSP unavailable 保留最后已知 symbols，`ready + []` 才是
权威清空。(4) 若 LanguageSupervisor 已有 document buffer，直接用其 version，绝不以磁盘覆盖；尚未同步才从 Documents 读取并 open。
(5) workspace store 暴露关键词 symbol search 与按 file 读取真实 defines edge；`user.tdb` 拒绝 file/symbol 写。(6) embedding recall 同批
修正为只返回 accepted、未失效的 knowledge，图节点或 suggested/dismissed 不能混进长期记忆。(7) references/calls/imports 边尚未接；
不能为每个 symbol 无界扇出 references 请求，需在 LSP 能力与实际文件分布上定批处理/背压后单独实现。
Store 打开时一次建立 path→file/symbol ids 的内存索引，后续写后替换不遍历全部 event/knowledge 历史；只有显式 symbol search 扫描
当前 active symbol 集。

原因：旧代码只有看似完整的接口和计数器，接生产会把“采集成功”写成假事实；固定前 200 个 Git 文件还会因排序偶然性永久漏图。
写后单文件替换只为真实变化付费，且沿现有 Documents/LSP 权威边界，不新增扫描成本。

影响：KnowledgeStore graph contract、`symbols.ts`、`symbol-runtime.ts`、Documents mutation fan-out、Application Host lifecycle、user store；
设计 6.2 / 7.2，plan/status 3.1。

状态：已实施并 proven（file/symbol/defines）；跨文件 references/calls/imports 未实施

### D-060 · 2026-09-04 · 2.7（持久消息与工具结果的显式知识标记）

类型：实现澄清

决定：时间线现有 hover action 区新增一个 knowledge 图标菜单，用户明确选择“记到项目”或“记到用户”；覆盖持久 user message、
assistant answer、配对/独立 tool result、extension-rendered tool result 与 legacy bash output。live 尚未落盘的消息不显示，空文本不显示。
动作只 POST 原文、空 recall trigger 和来源 kind 到 D-058 的 suggested API，不直接接受、不调模型；成功后沿同一 SSE 让审阅侧栏刷新。
scope 在菜单中显式选择，不以当前页面或模型猜测。工具卡的动作放在展开结果尾部，消息动作与复制/分叉同层，不占正文空间。

原因：D-058 只接了 block，设计列出的三个人工来源尚不完整；另建浮层会复制现有消息操作与 scope 选择。只允许持久项避免用户把
尚可能重试/变化的 streaming 文本写成长期建议。

影响：UI `RememberKnowledgeButton` / request projection、`PiTimelineEntries`、10 locale 与 SSR；status/plan 2.7。

状态：已实施并 proven（全部人工 user-mark 来源）

### D-061 · 2026-09-04 · 2.7（memory decisions 的机械建议触发）

类型：实现澄清

决定：(1) KnowledgeStore 在 block 写入成功后向观察者提供 `{previous,current}`，保留原 session invalidation 通知；失败写不发布。
(2) 只处理 `updatedBy: memory-agent` 且 label=`decisions` 的块，只把 Markdown bullet、numbered item 或显式 `Decision:` 行当作 entry；
普通散文、progress、用户编辑块不猜。(3) previous/current 先做新增差分，再与该 session 来源为 `memory-decision` 的全部历史 knowledge
比对；suggested/accepted/dismissed 任一状态已出现都不重提，避免用户驳回后下一次 keeper 重写又出现。(4) 新项固定写 workspace
`suggested`、空 trigger，整批完成后只发一次 scope identity SSE；不调 suggestions model，不读取 auto-accept。per-session 写入串行，错误只报
Host diagnostics，不阻断 memory block 已完成的提交。(5) memory shadow 默认关闭，因此默认不会产生后台 keeper 或建议写入。

原因：这是设计列出的第二个触发，输入已经是 memory keeper 明确维护的结构化 decisions，不需要再让一个模型判断。若从任意新增文本
猜“知识”，会把 progress 和叙述噪音灌进托盘；若不查 dismissed 历史，会违背用户驳回。

影响：KnowledgeStore block observation、`decision-suggestions.ts`、Application Host wiring/global SSE、plan/status 2.7。

状态：已实施并 proven；配置 suggestions model 后的用户消息判断仍未实施

### D-062 · 2026-09-04 · 3.10（窄屏 session state overlay）

类型：实现澄清

决定：`HarnessThreadsPanel` 的数据加载、SSE 订阅、draft/conflict 状态和 action handlers 保持单实例；`xl` 及以上渲染原右 rail，
更窄窗口在聊天右上显示带实时 item count 的 session state 按钮，打开项目既有 `MobileOverlayPanel`，内部复用同一份
knowledge review / blocks / threads 内容。无任何内容时 rail、按钮、overlay 都不渲染；切换会话时清数据并关闭 overlay。聊天根容器成为
positioning context，按钮不会相对整个应用漂移。移动端没有第二套 store、route 或轮询。

原因：旧 `<aside class="hidden ... xl:flex">` 让普通窄窗口、平板和手机完全无法处理 waiting thread、block 冲突或知识审阅；仅做响应式
样式而没有入口仍不可达。复用现有 overlay 保留项目统一的焦点、关闭和滚动行为。

影响：UI `HarnessThreadsPanel`、`HarnessSessionStateTrigger`、PiChatView positioning、10 locale；plan/status 3.10。

状态：已实施并 proven（响应式触发器 SSR + 既有 panel/overlay 生产链）

### D-063 · 2026-09-05 · 3.10（用户讨论线与同会话转实现）

类型：实现澄清

决定：(1) 时间线只在已持久化且有文本的 user/assistant message 上显示“从这里开一条线”；菜单默认携父 blocks，也提供显式不携带
入口。创建走鉴权的 session-scoped Host route，UI 不提交 workspace 或 parent 身份；Host 从 broker session snapshot 和 registry
反查权威 workspace/父边，并要求 fork point 仍在活动分支。(2) 讨论线只从父会话**实际活跃**的工具里取
`read/grep/find/ls/glob/explore/related/recall/webfetch/websearch` 交集，`worktree:none`；`carryBlocks` 加入冻结的
`ThreadLaunchManifest`，catalog schema 5 将旧 schema 4 明确迁为历史默认 `true`。(3) 讨论线每次 `agent_settled` 只刷新 Run metrics 并
标为等待用户，不生成终态 report、不关闭 worker；空闲讨论不占 implementation dispatch 的并发槽。(4) 用户转实现前要求当前回答已结束，
从父会话当前真实 active tools 中去掉线程控制工具并确认至少有一种 mutation 工具；创建 isolated worktree 后，旧讨论 Run 以
`converted to implementation` 成功结束，新 Run 沿用同一个 sessionId。worker 必须 close/open 才能在 AgentSession 构造边界切换 cwd 与
tool allowlist；随后自动发送转换说明并按普通实现线结算。(5) conversion 的新 Run 在落盘时已经带原 sessionId，Host 若在
registry commit、worker reopen 之间崩溃，现有 lost-Run 对账仍能从同一 transcript 恢复。

原因：只在 UI 增加按钮会立刻撞上两个事实：原 ThreadRuntime 把第一次 `agent_settled` 当整个线程完成并关闭，而已有 worker 的
`session.open` 不会重建工具 allowlist。前者让讨论线无法继续说话，后者会让“转实现”只改标签却仍拿不到写工具。把转换定义为同一
Thread/session 上的新 Run，既保留对话，又让一次执行尝试和一次能力边界对应；session-scoped route 则避免重新引入由 UI 自报
workspace/parent 的身份问题。

考虑过的替代：(a) 复制父完整对话——违背 blocks + brief 的低污染上下文设计；fork point 只记录来源并把该消息作为明确 data prompt。
(b) 讨论回答后直接 settle，再靠 resume 续聊——会伪造多个“崩溃恢复”并产生终态报告。(c) 在现有 worker 上改 manifest——Pi 工具在
AgentSession 构造时冻结，registry 与实际能力会分叉。(d) 给讨论线沿用父全部工具、只靠提示词说别写——不是能力边界。(e) 转换时
另建 session——对话不再延续。

影响：protocol `ThreadLaunchManifest`；Thread catalog schema 5；Host ThreadRuntime/registry/session-scoped routes 与真实 Pi E2E；UI
timeline action、session state conversion、10 locale；设计 9.3.2、plan/status 3.10、architecture 5.2。

状态：已实施并 proven（真实 Pi faux-provider 纵切；时间线线程卡片与归档/恢复 UI 仍待实现）

### D-064 · 2026-09-05 · 3.10（时间线线程标记复用 session feed）

类型：实现澄清

决定：把线程 GET、SSE scope 与 eventSeq 合并从 `HarnessThreadsPanel` 提取为会话级 React provider；右 rail、窄屏 overlay 与父时间线
都消费这一个内存投影。每个带 `forkPoint` 的线程在来源消息下显示紧凑状态标记，点击沿冻结的 model/tools/scope 和记录的 worktree
打开 child session。旧事件不能覆盖较新的 `eventSeq`，archived/hidden 不进入活动投影。时间线本身不发第二次请求、不建轮询器，
也不复制 thread action 状态。

原因：若时间线另建 store 或独立 fetch/SSE，用户会看到侧栏已完成而消息卡仍运行，且 D-062 的单实例约束失效；若只在创建成功时
向时间线塞临时卡，刷新后即丢。会话级 provider 让所有表面共享 Host registry 的同一投影，同时不把 blocks/knowledge 的独立数据
所有权混入线程状态。

影响：UI `HarnessThreadState`、`HarnessThreadMarkers`、`HarnessThreadsPanel`、`PiChatView` 与 timeline SSR；plan/status 3.10。

状态：已实施并 proven（SSR + eventSeq/fork-point 单测；归档/恢复 UI 仍待）

### D-065 · 2026-09-05 · 1.4 / 1.6（真实 Pi 输出分页与版本化 LSP 诊断）

类型：错误修复与验证补齐

决定：(1) `LanguageSupervisorDiagnosticsProvider` 每个 resource 为每次 `publishDiagnostics` 维护单调 publication revision，snapshot
使用 `{serverGeneration}:{revision}`，不再拿只在进程重启时变化的 server generation 冒充诊断版本。(2) 同步文档时传入由扩展名解析的
`languageId`，并在 supervisor 当前 document version 上递增；不再用 `as never` 隐去缺字段。(3) 编辑后诊断先读取 baseline 与建立订阅，
再发 didOpen/didChange；等待 publication snapshot 变化，新的空列表也作为“错误已全部消失”的 ready，而不是 pending。(4) 用真实
fixture LSP 子进程覆盖 error→clean、pending、unavailable，并再经真实 Pi agent loop 的 `diagnostics` tool/Host bridge 验证。(5) 大文件
read 的截断通过真实 Pi agent loop 验证：模型只收到 UTF-8 预览与 `out_*`，下一步能用 `get_output` 分页，完整尾部不进入上下文。

原因：原适配器漏传 `languageId/documentVersion`，真实 supervisor 会直接拒绝同步；即使已有 LSP，旧 service 又在 sync 后才读取
baseline，可能把同步发布的新诊断吞进旧基线，并且永远观察不到“最后一个错误被清空”。此前直接调用 tool 的 E2E 看不到这两个问题，
也不能证明模型实际拿得到并能消费输出句柄。

影响：Host diagnostics adapter/service 与真实 fixture 测试；pi-host session E2E；status 1.4/1.6。

状态：已实施并 proven

### D-066 · 2026-09-05 · 1b.2（reader 模型归 session，Host 只负责安全抓取）

类型：设计修正

决定：`webfetch(url, prompt)` 始终先且只先调用一次 Host `web.fetch`。配置 `models.reader` 且官方 Host 声明受保护抓取可用时，
pi-host 用本会话的 `ModelRuntime`、provider 配置与凭据对提取正文做一次 `completeSimple(toolChoice:none)`；网页正文明确标为不可信数据。
reader 未配置、模型不存在、调用失败或返回空文本时，保留成功抓取的 Markdown 作为 fallback，不二次请求 URL。删除没有生产调用方的
Host `web.read` service、协议方法和测试；`harnessWebRead` 握手位改为“Host 允许在其 guarded `web.fetch` 结果上使用 session-local
reader”，不再声称 Host 拥有模型栈。

原因：Application Host 不拥有活动 Pi 会话的模型 provider、API 凭据或模型运行时；把 `readerRequest` 放在那里只能继续留桩，或复制
一套最敏感的模型/凭据权威。pi-host 已经为 permission judge 与 memory shadow 使用同一个 `ModelRuntime`，reader 也应在这里。
旧工具先调 `web.read`，失败后再 `web.fetch`，真实接线后还会重复下载页面；单 fetch + 本地 reader 同时解决所有权与重复 I/O。

影响：protocol 删除私有 `web.read` Harness method；pi-host webfetch/select-tools/SessionHost；官方 Web broker capability；Host 删除
web-read service；真实 Pi session E2E；architecture、plan/status 1b.2。

状态：已实施并 proven

### D-067 · 2026-09-05 · 1b.3 / 1b.5（真实搜索 provider 与 transcript 来源投影）

类型：设计修正与实现澄清

决定：(1) 删除会话模型 provider 的三个“search 返回空数组”占位适配器；pi-ai 没有可独立调用并返回来源的 server-side search
契约时，模型可能具备搜索能力不等于 Host 有搜索服务。(2) 实装 Settings 可选的 Brave、Exa、Tavily、Jina 与 SearXNG HTTP adapter；
请求形状分别对照其官方契约（[Brave](https://api-dashboard.search.brave.com/api-reference/web/search/get)、
[Exa](https://exa.ai/docs/reference/search)、[Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search)、
[Jina](https://jina.ai/reader/)、[SearXNG](https://docs.searxng.org/dev/search_api.html)）。provider 的非 2xx、畸形 JSON 与调用错误向上
传播，不能压成“0 results”。domain policy 在 provider 参数之后仍由 Host 对返回 URL 再过滤。(3) 搜索 provider、endpoint 与
credentialRef 为 user-owned；workspace 只能覆盖 fetch 的非身份行为，不能把搜索重定向到仓库指定端点。(4) API key 写入
`piarium-web-search-<provider>` 固定命名的 Pi auth.json 条目，鉴权 route 只返回 configured 布尔值；请求 body 即使伪造
credentialRef 也不能覆盖模型凭据。SearXNG 可显式使用无认证实例，其余 provider 缺 key 时 Host 不声明能力。(5) Host 启动时解析
有效配置并据此握手；因此更改 provider 后 UI 明示需重启，新 session 才构造 `websearch`。(6) webfetch/websearch 的持久 tool result
details 携净化后的 title/URL；PiChatView 从 transcript 投影到现有 session state，稳定键去重，pin/remove 只属本地展示，正文与 key
都不进 UI store。

原因：旧 resolver 把“模型供应商声称支持搜索”变成永远空结果，正是项目禁止的失败→空成功；配置 API 的 adapter 也全部只返回空。
凭据若直接写 Harness settings 会进入普通设置 JSON，若允许 route 接收任意 credentialRef 又可误覆盖模型 key。来源直接从持久
transcript 重建，比让一个未接线的 Zustand store 成为第二真相更可靠。

影响：protocol Harness web settings ownership；Host search adapters、启动 wiring 与 credential routes；pi-host websearch details/真实 Pi E2E；
Harness Settings 与 session state 来源区；10 locale；设计 5.8、plan/status 1b.3/1b.5。

状态：已实施并 proven（外部 live key smoke 需用户实际 provider 凭据，不是默认测试前提）

### D-068 · 2026-09-05 · 2.9（模型槽位单一解析与真实用量归因）

类型：实现澄清

决定：(1) 槽位目录、仅 hardImplement/review 回退主模型的解析规则、Anthropic/OpenAI/Gemini 轻量预设归
`@piarium/protocol`，角色解析复用同一函数，不在 Host 复制第二套默认规则。(2) 预设按已连接 provider 的实际 model id 匹配，
不依赖 provider id 必须叫 openai/anthropic/google；只填尚未配置的辅助槽位，不覆盖用户逐槽选择。(3) reader 与
permissionJudge 的每次真实 `completeSimple` 响应按槽位累计 calls、完整 token 分类与 cost，随 `SessionStats` 进入 Context
sidebar；无调用的槽位不造零值。(4) 子线程已由 `ThreadRun` 持久化 role/model/tokens，不再向父会话重复记账；memory shadow
继续按设计使用活动会话模型，不冒充某个槽位。

原因：槽位规则同时被 pi-host、Host 与 Settings 消费，复制默认逻辑会漂移；自定义 API provider 常用用户自己的 id，按 provider
名称猜系列会让有效模型无法使用；用量只有绑定到真实模型响应才可信，配置本身不能算调用；父会话重复累计 child token 会让总成本
失真。

影响：protocol `harness-model-slots.ts` / `harness-roles.ts` / `SessionStats`；pi-host counter 与 reader/Smart judge；Harness
Settings、Context sidebar、10 locale；设计 8.5/8.6、plan/status 2.9。

状态：已实施并 proven（protocol 单测、真实 Pi reader/Smart judge E2E、UI projection）

### D-069 · 2026-09-05 · 3.2 / 6.1（explore v2：把 Devin 的多轮展开成结构查询）

类型：偏离

决定：`explore` 从 v1 的"关键词 → rg → 命中密度排序 → ±3 行窗口"改为六阶段管线，四条硬要求：(1) **输出单位是"目标 + 结构
支撑"**（目标函数连同其定义、调用方、测试、配置、co-change 邻居），不是平铺的命中列表；(2) Devin 模型每轮"想"出来的下一跳
（看定义、找调用方、找测试、沿栈帧走）**换成 LSP / 符号图 / git / 文档注册表的确定性并行查询**，中间没有任何等模型思考的
环节；模型只在两处出场且都是一次性、无工具、与主路径并行、超预算即弃的调用——问题无代码词时的意图抽取，和排序分差小
时的"十选一"裁决；(3) **搜索的是当前内容**：rg 搜磁盘的同时对文档权威的脏缓冲做内存匹配，返回前按当前内容重切并校验行号；
已在主上下文里的文件只回一行指针不再返回片段；(4) **默认开启需通过回放门禁**——对照同预算 BM25 / 现有 `grep`，FileRecall@K
与 token 浪费率都不劣才默认注册，只赢延迟不算赢。问题类型（where / how / impact / why）决定扩展方向而不是重要性权重；
低置信时明说并建议 `retrieval` 角色。反馈回路按 Cognition 的口径在线算 recall@k，只做有界的权重微调与"问题 → 文件"记忆。

原因：这是对两份外部证据的直接回应。OpenLocus 研究（`D:\project\opencr\OpenLocus-Lab`）的负结果：给上下文对 agent 成功率
影响巨大（0.25 → 1.0），但更聪明的候选挑选（BEA v0–v0.3）**没有赢过同预算 BM25**（B16-F 打平且更贵）；FD1 失败分解里最大
的桶是"正确文件没进候选池"（ContextBench 62 条）和"花了时间没换来质量"（80 条），"文件对片段错"最小（11 条），正确文件缺席
时改进挑选只能救回 1/119；B16-J 去掉文件名泄漏后，目标 + 支撑 11/11、只给支撑 2/8、只给目标 0/8；FRK-B 纯算法四路索引
（稀疏词 + 符号名 + 路径 + AST 片段）p95 < 10 ms 文件召回@10 very high 而召回@1 只有 medium。这四点分别对应四条硬要求：
钱花在召回与结构扩展上而不是重排器；目标必须带支撑；确定性路径把答案送进前十，模型只负责十选一且默认不调；无差别地开
可选阶段就是最大的浪费桶，所以要门。OpenLocus 设计的 2.4"脏缓冲是一等现实"与 EvidenceCore"候选不是事实、必须按当前源
重物化"对应第 (3) 条。OCE（`D:\project\opencr\oce`）提供两个可借的零件：tree-sitter 切块里"只含签名的小块并入邻居"
（`cast_chunker._merge_small`），与覆盖度优先的两遍贪心打包（`coverage_selector.py`）；OCE 的向量主通道、服务化与 LLM 全量
重排是设计 6.1 明确不选的赌注，不借。

考虑过的替代：(a) 用通用小模型跑 Devin 式 4 轮 tool loop——一轮 2–5 秒、总计十几二十秒，且未训练的模型第二轮乱跳；
(b) 全仓库 embedding 作主通道（OCE 路线）——代码检索上 grep 打 embedding 已被 Claude Code、Cognition 与 OpenLocus 的 BM25
打平数据反复验证，且引入服务依赖；(c) 只调 v1 的权重——v1 的结构（平铺命中、行窗口、只搜磁盘、无支撑）不是权重问题；
(d) 裁决默认开——FD1 的"latency without quality gain"桶说明无差别开可选阶段是最大浪费。

影响：`agent-harness.md` 6.1 第二级重写（六阶段、问题类型表、低置信、反馈回路、门禁）；`agent-harness-plan.md` 3.2 重写为
v2 实施形状（`ExploreContext` / `ExploreTarget` / `ExploreResult` 类型、各阶段与预算、参考形状路径、测试清单、门禁）；
`agent-harness.md` 12.2 "explore 无 LLM 时的查询扩展"待决项关闭；status 3.2 行 Blocker 更新。实施在 T4 回放集就位之后。

状态：待实施（设计已回写；代码仍是 v1）

### D-070 · 2026-09-05 · 3.2 / 6.1（explore v2 降级为候选架构；更正 D-069 的六处）

类型：问题与解法

决定：D-069 保留方向（结构查询替代多轮乱跳、返回前按当前内容重读、默认关闭并与 grep / BM25 对照、带关系的代码单元），但**状态
从"待实施规格"降为"候选架构 / 待验证假设"**，不据此开工、不据此决定默认启用。更正六处：

(1) **组件所有权**。D-069 把整条管线写在 host，却要求 `models.explore` 调用、主上下文文件表、`read` / `edit` 步数、未保存正文、工作台
焦点——这些分属三个进程：模型与 `completeSimple` 在 pi-host（D-068 的 reader / permissionJudge 同路）；主上下文与 `read` 轨迹在
pi-host，host 没有 read 观察链；UI 焦点与选区属于具体 surface，不在 worker 发布的 `session.snapshot` 里；Documents authority 的脏
缓冲发布只有路径、`baseRevision`、`localEditRevision`，**没有正文**（`lib/documents/authority.ts` `DirtyBufferResource`）；LSP
supervisor 的缓存正文没有 surface 所有权。拆为 pi-host `ExploreCoordinator`、host 纯确定性 `ExploreEngine`、UI 可选焦点提示
（带 `surfaceId` / `generation` / `revision`）。

(2) **"已交付依赖"说重了**。`lsp.symbols` 需先给 `path` 选语言 provider，不是跨语言 workspace 符号索引；符号图只有 `file → defines →
symbol`，无 references / calls / imports 边，无 PageRank API；`searchSymbols` 是 JS 扫描 + `includes` 计分（`knowledge/store.ts:800`），
不是 AC / BM25；`related` 只接受注入的 `findNode` / `getNeighbors`，无生产实现；恢复日志知写不知读；git co-change、工作台焦点、
最近失败输出入口都无服务。plan 3.2 改为**依赖矩阵**（available / partial / unavailable），缺失来源只能降级并在结果里报告该来源
状态，不得折叠成一个 `partial: true`。

(3) **外部证据被外推**。OpenLocus 自己标 B16-J 为 *bounded synthetic evidence*；FRK-B 是 R14-S sanity 小套件且报告明确
`runtime_default_method_scale_claim: false`；后续 FRK-E 结论是 *no proxy lift over best baseline*。因此"目标 + 支撑"是优先输出形状
而非硬要求（精确 `where` 可能只需目标），"答案几乎总在前十"是待验证假设而非前提；设计 6.1 改写为假设 H1–H4 各带证据边界，
并把 H1（结构可替代多轮）标为**无直接实证、最需回放集检验**。来源固定到远程与提交：OpenLocus-Lab
<https://github.com/Youzini-afk/OpenLocus-Lab> @ `eecd28b218b2be211074db2bdd9e7dad43100336`；OCE <https://github.com/oce-ai/oce>
@ `a359272560bbbdb321055aaed6c16ba1f4e06887`；本地检出路径不作设计依据。

(4) **T4 无法执行 D-069 写的门禁**。`evaluation/harness/cases.json` 与 `scripts/harness-replay.mjs` 只记成功、token、人工介入、失败
类别，没有查询、目标 / 支撑标注、正确 span、各 baseline 返回包；用 reference commit 的改动文件当正确上下文会把不被修改的支撑
文件算成浪费，"后来读过的 token"会惩罚自包含的好结果。改为**两级门禁**：独立的检索回放集（`evaluation/retrieval/cases.json`，
含 query / questionType / targets / support / commit；B0 现有 grep、B1 独立实现的同输出预算 BM25、B2 explore v2；FileRecall@K、
Span F0.5、首个正确文件位置、返回字节、来源状态）决定是否进入真实会话实验；T4 端到端再决定是否默认注册。

(5) **硬数字无定标依据**。1.5 / 4 s、6000 token、references 20、500 commits、300 字符、60% 重叠、每文件 2 块、分差 0.1、20 条反馈、
步进 0.05 全部没有 Piarium 数据支持，且 host 不知 tokenizer 不能声称"硬 6000 token"。参数分三类：硬边界（父请求取消、workspace
containment、judge 只返回候选 ID）不可配置；软预算与观测目标（延迟、候选数、输出**字节**——token 由 Coordinator 按活动模型换算）
为可配置默认；首版阈值标 experimental，待回放集定标后写回。

(6) **反馈 bandit 不能自动改权重**。"模型随后 read / edit 的文件"有位置偏差、支撑不被改、分析任务无 edit、自包含结果减少 read
反而是成功、压缩后 `inContext` 旧 step 失效、read 后文件已变。第一版只记 telemetry；排序用 **RRF** 融合各来源排名，不做量纲不同
信号的加权和。

另外接受的具体更正：阶段不是"全并行"，画出依赖图（intent 只在 fan-out 结束前回来才补一轮；judge 依赖 fuse 的 top-N）；
`references` 不是调用图、无 call hierarchy，删去"调用图 BFS"；OCE 的 300 字符合并修的是其 AST 切块列切分伪影，不适用于
`documentSymbol`（它本身区分 `range` 与 `selectionRange`），删去；OCE 两遍覆盖度选择器是平铺 chunk 选择器，打包必须 bundle-aware
（先在 bundle 内降级支撑再丢 bundle）；`usedLlm: boolean` 与单一 `partial` 改为每来源 `ready | empty | unavailable | failed | stale`、
每次模型调用 `not-requested | completed | timed-out | failed`；LSP 返回路径与派生支撑路径重新过 workspace scope / realpath 授权；
judge 看到的仓库正文标不可信数据且只能返回候选 ID；标识符用 Unicode `\p{L}`，问题类型分类同时支持中文线索。

原因：D-069 把一个值得做的方向写成了可以照着做的规格，而它的输入、依赖和证据都还不支持这一步。评审方（另一位复审 agent）的
六点全部经代码与来源核实成立。

考虑过的替代：退回 v1——v1 的结构（平铺命中、行窗口、只搜磁盘、无关系）不是权重问题，方向仍以 D-069 为准；立即按 D-069 开工
并在实施中修正——三个进程的所有权与依赖矩阵不先钉，实施必然把 host 写成全能视角。

影响：`agent-harness.md` 6.1 第二级重写（候选架构、H1–H4 与边界、所有权表、依赖图、来源级状态、参数三类、两级门禁、来源提交）；
`agent-harness-plan.md` 3.2 重写（六步交付顺序、所有权表、依赖矩阵、`ExploreSeeds` / `ExploreBundle` / `ExploreResult` 含状态枚举、
参数三类表、检索回放集 schema 与 runner、测试清单）；status 3.2 行；D-069 在索引中标 superseded in part。

状态：已实施（文档）；代码仍是 v1；开工条件见 plan 3.2 交付顺序第 1、2 步

### D-071 · 2026-09-05 · 用户取舍与本轮范围

类型：设计修正（用户已决定）

决定：

1. **优先保留 TriviumDB，但不是不可替换依赖。** 不启动 SQLite 迁移。具体缺陷、受影响版本、最小重现和需要的能力先报给用户，
   由用户联系 TriviumDB 作者处理；Piarium 不长期把绕路当目标接口，也不设无依据的修复期限。保持一个可写知识权威。
2. **Agent 默认可读所在窗口的未保存内容。** 不增加显式开启、绑定或每次读取确认。用户从窗口发起消息时，surface 来源随已有鉴权
   请求自动传播；同一会话在别处仅被打开或获得焦点不改变本次工作的来源。后续用户从另一窗口发消息时自动更新来源。后台工作保留
   最近一次已接受用户输入的窗口来源；只读取得带 generation/revision 的不可变快照，不把 Host 变成第二个可变缓冲权威。窗口断开时
   已捕获快照仍可标版本使用，最新内容不可得须明说；不把另一窗口或磁盘冒充当前草稿。无 surface 的 headless 任务使用磁盘。
3. **实施顺序由执行者负责。** 先修已确认的记忆写入/分支、证据版本和观察送达缺口，再补最小实验记录、版本化读取和检索；
   不要求完整跨 runtime RunManifest、数据库迁移或沙箱先全部完成，不重开宽泛 P0。
4. **`check` 是执行检查角色，不是只读角色。** 测试、构建、缓存和生成物可能写文件；它需要执行能力，遵守正常工具权限与恢复边界。
   不规定“bash 只跑不改”，不靠提示词声称只读，不新增一律复制工作区或独立 worktree 的硬规则。工作副本选择按检查目标与真实环境需要决定。
5. **不安排付费记忆协议/缓存对照实验，不建设 Windows 沙箱。** 记忆质量与真实成本由用户招募的测试者在真实使用中验证；本地只准备
   可执行场景、配置记录、用量和失败归因。保留当前 `memory_edit` 路径、活动模型与默认关闭；不借本次评审新增 memory 模型槽位、
   同前缀 JSON 实验或独立记忆会话。Windows 沙箱不再列为待补齐交付项，也不妨碍现有 Windows 能力交付；已有权限与路径边界继续成立。

原因：用户明确选择默认、低摩擦的窗口协作，并要求检查拥有真实执行能力；数据库问题可由作者协作解决，暂无迁移和 Windows 沙箱需求。
默认读取草稿不等于跨窗口混用正文：内部仍需区分来源、世代与版本，用户不用管理这些字段。

影响：设计决策表、第 6.1/7.5/8.4/9.1.1/9.2.2 节；plan 当前顺序与相关任务；status 仅登记缺口。

状态：已回写文档；**本轮只改文档，不推进实现、不运行实验、不提交**。上述新能力不得因设计被接受而标为 wired/proven。

### D-072 · 2026-09-05 · 更正 D-069/D-070，并收口记忆、证据与执行的契约

类型：设计修正

决定：

- explore 保持候选架构和 default-off。H1 改为“结构查询减少机械跳转”；RRF 只融合排名，不用分差充当答案置信度。目标与支撑按问题
  组成 bundle，支撑可为空，预算降级不预置统一的支撑删除顺序。可选 intent/judge/查询修复是待比较的机制，不把任何一种定成必经阶段。
- pi-host Coordinator 拥有上下文、模型/凭据、调度与用量；Host Engine 拥有确定性搜索、来源授权、内容物化、融合/打包与 OutputStore；
  surface 按 D-071 自动提供本窗口草稿。Host 不等待或直接访问 pi-host 模型回调。judge 必须在候选物化后调用，只能返回候选 ID；
  补查若日后采用，也只能提交经过类型和路径校验的查询操作。正文作为不可信数据传入模型。
- 每来源保留 ready/empty/unavailable/failed/stale/timed-out，未请求与取消也独立表达。每次模型调用的真实结局、结果是否采用、用量是否
  可得分别记录；迟到但成功不能伪装成超时，失败/取消不能伪造零费用。Host 计 UTF-8 字节，pi-host 只有拿到真实 tokenizer 时才声称
  精确 token 数，否则保留估算标签。所有未定标数字只作实验候选，不形成产品默认或检索通过条件。
- `inContext` 按实际请求保留的 revision + span + request/context generation 判覆盖，不按文件或 read step 去重。当前不具备该证明时
  返回正文。新建独立 retrieval replay，人工标注目标 span 与可选支撑；baseline 查询不能由正确答案泄漏产生。固定比较预算与 K，记录
  baseline 返回包、召回/片段质量、延迟、输出量与来源状态。离线结果支持进入测试者真实任务验证，不把少量样本包装成统计不劣证明。
- `TranscriptRef` 耐久指向 Pi 持久记录，**不承诺恢复被截断的完整正文**。可重建来源必须有能解析正文的既有对象；不可重建观察要有
  操作所属的耐久产物，或明确临时。OutputRef 不作为压缩恢复的唯一来源，不把所有输出改为永久保存。
- keeper 写入需要读取时版本与分支归属；plan 只能标记条目，不能整块 replace。压缩前的 checkpoint 必须证明相关分支上待移除的
  已处理连续区间；块修订与水位一起提交，部分失败不推进完整水位。缺覆盖或来源不可用时明确降级、保留 Pi 安全切点并回退默认压缩。
  这证明机械覆盖，不保证语义无遗漏；撤销“结构上不叠加损失”的承诺。
- 区分 record-only（只记录/展示）、assist（进入 Zone 2，但 Pi 压缩）、takeover（检查点参与接管）；三者之外保持关闭。现有
  `shadowMode:true` 实际是 assist，保留其行为，不宣称 record-only 已实现。当前 memory 输出协议与模型不变，真实效果由测试者验证。
- Workbench Profile 归展示，Agent Profile 归执行；工具/system 的冻结以一次执行配置世代为界，持久 session 可在用户操作下换新
  Run/配置。单会话实验配置先沿现有 launch 接缝提供，不以完整 RunManifest 为前置。结果/验证/集成应绑定明确版本，操作回执与观察
  送达分别补最小契约，不顺带引入完整 Work Graph、全局并发上限或新的单 Host 禁入规则。

原因：本次代码核对确认 memory get/apply 没有版本与分支字段，`applyOps` 允许 replace plan，compaction 仅检查 keeper 块存在，
截断后的文本才进入 Pi 持久消息，观察游标在结果发送前推进。报告指出的问题成立，但具体新对象与算法仍需按真实消费者逐项实现。
当前 takeover 默认关闭，不能将候选接管缺陷描述成默认已经发生的历史丢失；Host/会话清理会重置游标，送达缺口需按仍保留基线的窗口验证。

外部证据固定在设计 6.1 的远程 commit 链接；D-069 原文中的本地路径按 append-only 保留为历史，不再作为现行证据入口。
Anthropic [工具缓存](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)明确 `tool_choice` 变化使
messages 缓存失效，[上下文清理](https://platform.claude.com/docs/en/build-with-claude/context-editing)明确 tool-result clearing 会触发缓存重写。
OpenAI [Windows 沙箱实现](https://openai.com/index/building-codex-windows-sandbox/)证明存在原生路线；D-071 不实施 Windows 沙箱是用户选择，
不是“没有技术路线”的推断。

影响：设计 2/5.7/6.1/8/9/10/12，plan 0.7/2.4/2.6/3.2 与阶段验收，status 缺口与下一步表。仅文档修订，不升级实现状态。

状态：已回写文档；代码实施与测试者验证尚未开始。

### D-073 · 2026-09-05 · TriviumDB 问题按数据库职责报告

类型：设计修正（用户补充）

决定：TriviumDB 的问题直接在回复中提供，不另建 Piarium 适配需求文档。区分数据库缺陷、待确认语义和可选通用能力，报告版本与证据范围。
TQL 的字符串类型转换错误应从查询语言/绑定/执行链调查；零向量 hybrid 返回空需先确认参数与算法契约，不先判为缺陷；分词扩展若讨论，
应是数据库通用的 Unicode/可配置分词或预分词能力，而不是要求内置 Piarium 的代码分析器。分支、memory checkpoint、槽位、编辑器等
领域职责留在 Piarium，不能以“保留数据库”为由转嫁给作者。

原因：用户明确该项目首先是数据库；作者协作不等于接受 Piarium 专用需求。D-019/D-020 是 0.8.5 的既有实验记录，本轮不运行新实验，
也不能推断当前上游版本仍有同样问题。

影响：设计 7.5 与 plan 2.1 的问题表述；不改依赖、不迁移存储、不向作者发送消息。

状态：已回写文档；数据库问题在本轮回复说明。

### D-074 · 2026-09-05 · 记忆版本/分支、压缩覆盖、证据标记、观察游标延迟推进

类型：实现决策（纵切 1）

决定：按 plan 0.7 步骤 1 的顺序，完成四项本地可实现的一致性修复，每项包含协议、生产接线、测试和文档同步。

1. **记忆版本与分支归属**。`MemoryBlockSnapshot` 新增 `revision`（store `updatedAt`）；`MemoryEditOp` 新增可选 `expectedRevision`；`memory.blocks.get/apply` params 新增可选 `branchLeafId`；`MemoryApplyResult` 新增可选 `conflicts`。`KnowledgeStore.Block` 和 `BlockInput` 新增 `branchLeafId`，`getBlocks`/`upsertBlock`/`deleteBlock` 按 `(sessionId, branchLeafId, label)` 过滤。旧块（`branchLeafId` undefined）归默认分支（null），保持向后兼容。`applyOps` 检查 `expectedRevision`，不匹配时拒绝并记录 conflict，不静默覆盖。pi-host `memory-agent-extension` 从 `sessionManager.getLeafId()` 获取 branchLeafId，从 get 结果的 revision 附加到 ops 的 expectedRevision。

2. **Keeper plan 变更限制**。`applyOps` 拒绝 keeper 对 `plan` 的 `replace`/`patch`/`create`/`delete`，仅允许 `mark_plan`。原代码允许 `replace`，违反 main agent 对 plan 结构的所有权。

3. **压缩接管覆盖检查**。新增 `KeeperCoverageStore` 跟踪 keeper 连续处理区间。`memory.blocks.apply` 成功后扩展覆盖；`handleBeforeCompact` 在 `firstRemovedTurn`/`lastRemovedTurn` 提供时检查覆盖是否跨越整个移除区间；不满足时返回 `unavailable`，Pi 执行压缩。`compaction.after` 和 `dropSession` 清除覆盖。仅 keeper 块存在不再足够。

4. **证据标记与观察游标延迟推进**。截断标记包含 `ephemeral, generation <gen>` 明确标记 OutputRef 的生命周期。`OutputStore` 全文通过 `output.read` 分页可恢复；Host 重启后 handle 过期返回 `expired`。`ObservationCursorStore` 新增 `prepare`/`commit` 方法：`prepare` 运行任务但不推进游标，`commit` 在响应成功交付后推进，`abort` 不推进使下次观察包含未交付变更。现有 `observe` 保持立即推进语义，消费者按需切换。

原因：D-072 列出的缺口（2.4/2.6/3.9）在当前实现中会导致静默覆盖用户编辑、跨分支污染、keeper 未观察的历史被压缩后丢失、截断输出在 Host 重启后不可恢复、以及观察游标在响应未交付时已推进。这些是协议级完整性问题，不是可选增强。

影响：protocol `memory-agent.ts`/`harness.ts`；application-host `store.ts`/`memory-agent.ts`/`harness-services.ts`/`compaction.ts`/`observation-cursors.ts`/`service-host.ts`/`index.ts`；pi-host `memory-agent-extension.ts`/`session-host.ts`/`tool-result-truncation.ts`。测试：`memory-agent.test.ts`、`compaction.test.ts`、`output-store.test.ts`、`observation-cursors.test.ts`、protocol `memory-agent.test.ts`、`tool-result-truncation.test.ts`、`memory-agent-extension.test.ts`。

未完成：`observe` 调用点未改为 `prepare`/`commit`；后台调用用量归因仍待补；TranscriptRef 恢复仍限于 Pi transcript 持久 entry；真实 Pi session E2E、外部测试者、macOS/Linux smoke、Electron 打包证据未获取。

状态：首个实现候选；后由 D-075/D-076 修正。

### D-075 · 2026-09-05 · D-074 第一轮验收返工

类型：问题与解法（后由 D-076 完成）

决定：第一轮返工把 `branchLeafId` 改为 `sourceLeafId + branchEntryIds`，把已有记录的 revision 检查移入 Store CAS，把覆盖改成 entry ID set，并以 `observedAt` 做 observation CAS。该候选没有通过第二轮验收：写入仍按 source leaf 精确等值，后代无法更新祖先；读取未按每个 label 选择最近祖先，分支删除会物理删除兄弟仍需的祖先；UI、todo、thread snapshot、compaction 未全部使用活动分支。create 未以 `expectedUpdatedAt:null` 断言仍不存在。coverage 把完整 `getBranch()` 冒充 keeper 实际 context，且部分 op 成功即可推进。毫秒时间戳 CAS 会碰撞，clear 后 pending commit 还能复活游标；生产观察调用仍提前推进。

原因：这些问题均由真实最小复现确认，不能靠增加已有 happy-path 测试或修改状态文字解决。本条恢复 D-074 原始记录，纠正此前在未提交工作区直接改写 D-074 的 append-only 违规。

影响：D-076 接管最终实现；D-074/D-075 在索引标为被修正，保留失败形状供后续回归。

状态：superseded by D-076。

### D-076 · 2026-09-05 · 分支块、覆盖水位与送达游标的最终修正

类型：实现修正

决定：

1. block 采用分支 copy-on-write：读取按 `branchEntryIds` 为每个 label 只选最近祖先；后代更新在当前 leaf 写新修订，祖先保留；删除在当前 leaf 写 tombstone，兄弟分支仍继承祖先。create 用 `expectedUpdatedAt:null` 原子断言缺席，update/delete 在 Store 写队列内 CAS，同一 apply 内修订顺序前传。UI route 从 broker 活动分支自动解析，todo、Zone 2、memory、compaction 和 thread blocks snapshot 使用同一分支视图。
2. keeper 单独提交 `coveredEntryIds`，来源是 `SessionManager.buildContextEntries()` 中真实产生 context message 的 entry；Host 先验证其属于提交分支，只有全部 op 接受且确有 material block 更新才扩展水位。compaction 依照 Pi 上一次 compaction 的 boundaryStart 与本次 firstKeptEntryId 推导真正被摘要的 context entry，强制检查后才接管；当前仍 default-off。
3. observation cursor 新增 store-local 单调 revision，pending 在 commit/abort 前持续占有 namespace generation；同毫秒提交不会绕过 CAS，compaction/clear 会使旧 pending 失效。shell、diagnostics、Zone 2 threads 和 thread list/wait 均把游标推进延迟到 Router 成功把响应交给 pi-host；响应失败 abort，线程游标另按 eventSeq 防倒退。持久 tool-result entry acknowledgement 仍是更强的后续边界，不在本次冒充完成。
4. OutputRef 的 ephemeral generation 标记保留，它只说明生命周期，不声称 Host 重启后恢复全文。

原因：分支版本必须保留共同祖先而不是改写或删除它；coverage 必须描述 keeper 真正读到的输入而不是可枚举的整条 transcript；送达优化必须能承受并发、固定时钟和压缩清理。

影响：protocol memory/compaction/todo/Zone 2 参数；KnowledgeStore block revision/tombstone；Host routes/services/router/thread cursors；pi-host memory/compaction/todo；相关测试与 status 2.4/2.6/3.9。

状态：已实施；本地验证与仍缺外部证据见状态矩阵。

### D-077 · 2026-09-05 · 3.4（worktree 生命周期：setup 命令、目录即缓存、磁盘预算；取代 D-057 的"暂不回收"）

类型：偏离

决定：isolated worktree 的生命周期由三件确定性的事组成，一起交付、缺一不可；闲置计时器只作兜底。

(1) **setup 命令。** `git worktree add` + 父的 diff 与未跟踪文件给出的是源码不是环境：被 `.gitignore` 忽略的 `node_modules` /
`target` / `.venv` / `.env*` 全不会过去，`check` 与并行实现者在里面什么都跑不起来。每工作区一条**用户在 Settings 显式写下**的
`harness.worktree.setup`，worktree 就位后、Run 启动前以 login shell 执行，超时（可配置默认，首版 600 s）或非零退出 → 线程
`outcome: failure` / `exitReason: setup-failed`、输出进 `OutputRef`，不带着坏环境开跑；**只对 `tools` 含 `bash` 的角色按需跑**；
命令须幂等。被忽略文件复制走白名单 `harness.worktree.copyIgnored`（默认空，`.env*` 常含凭据）；依赖共享 `shareDependencies`
（symlink / junction）是显式选项默认关。setup 在用户机器上执行任意命令，属 plan 0.1 暂停类别，本条即其决策：**不从仓库文件推断、
不猜默认，用户配置是唯一来源**。

(2) **目录是缓存，回收发生在边界。** D-057 已让 settle / merge 前把结果提交到 `piarium/<threadId>` 分支；结果一旦在分支且目录里
没有活跃 Run，目录就是冗余的，可用 `git worktree add <原路径> piarium/<threadId>` **在同一路径重建**——重开 child session 的 cwd
不变，D-057 不敢删目录的顾虑由此解除。回收触发点：merge 成功（立即）、cancelled / failed / 用户归档（先快照再回收）、Run 结束后
idle 且无打开会话（`reclaimIdle` 默认 true）。硬前置条件：快照后 `status --porcelain` 为空、无 `starting | running` 的 Run、路径
在 worktree 根之内；任一不满足不删并报 `{ reclaimed: false, reason }`。`ThreadWorktree` 加 `materialized` 字段；`materialize()`
在重开或新建 Run 前重建并按需重跑 setup。

(3) **磁盘预算，超出显式拒绝。** 每工作区 `harness.worktree.budget`（首版 `{ maxBytes: 8 GiB, minFreeRatio: 0.1 }` 取更严者，
experimental），`prepare` 前累计已物化 worktree 占用；超出则 `dispatch` 返回 `unavailable`，文本含个数、总量与可释放候选。不因预算
杀正在跑的线程。这是不变量 3 的磁盘版：把"磁盘被悄悄吃满"变成显式、可行动的失败。

(4) **兜底与对账。** 启动时每工作区 `git worktree prune`，注册表与目录比对：满足前置条件的按 `reclaimIdle` 处理，注册表外的目录标
`orphan` 报给用户不自动删；`branchRetentionDays`（首版 30，experimental）只作用于已回收目录的分支。可见性：线程面板显示
`materialized` 与占用、总量与预算，≥ 80% 时父的 Zone 2 一行，"立即回收"动作。

(5) **写明 index 影响。** 普通 `apply` 不碰 index；退到 `--3way` 且冲突时 Git 会写 unmerged 条目进用户 index，工具文本与 Git 面板
如实说明。合并成功不等于合并后父树通过验证；团队提示要求父合并后自己验证。

原因：D-057 把"暂不自动删除 live worktree"当成安全侧，理由是重开 child session 依赖 cwd——但同路径重建解决了这一点，而"暂不删"
的代价是确定会发生的：并发 12、每个 worktree 装完依赖几百 MB 到几 GB，几天就把用户磁盘填满，远等不到任何"闲置 N 天"。把回收
寄托在计时器上等于把用户磁盘当缓冲区。同时 setup 命令会让每个 worktree 显著变贵，所以它和回收、预算必须同批交付——只加 setup
不加回收，是加速填满磁盘。

考虑过的替代：(a) 只靠闲置计时器——磁盘先满；(b) symlink `node_modules` 作默认——bun hoisting 与平台原生模块不稳，只作显式选项；
(c) 从仓库的 `package.json` / CI 配置推断 setup 命令——在用户机器上执行推断出来的任意命令，违反 0.1 暂停类别的精神；(d) 保留目录、
只做预算——预算会很快命中，然后所有 isolated 派发都被拒绝。

影响：`agent-harness.md` 决策表"线程"行、9.2.5b、9.3.4；`agent-harness-plan.md` 3.4（worktree 生命周期项、测试清单）；protocol
`ThreadWorktree.materialized`、`HarnessSettings.worktree.*`；`thread-worktree.ts`（setup / reclaim / materialize / budget）、
`thread-runtime`、线程面板；status 3.4/3.5 Blocker 列。D-057 在索引标 superseded in part（"暂不回收"部分）。

状态：待实施（T1 硬化；三件一起交付）

### D-078 · 2026-09-05 · 正式实施、默认交付与工作状态架构（用户重新授权）

类型：设计修正（用户已决定）

决定：

1. **完成可用路径就交付并默认启用。** 用户明确要求当前早期项目大胆推进，撤销 D-037、D-070/D-072 中把独立回放集、配对实验、
   测试者结果作为 explore、记忆、压缩接管和自动 review 默认启用前提的安排。相关生产路径、版本/权限/数据正确性与失败诊断由直接
   测试验证；真实使用继续优化质量、成本和性能。T4 与检索对照保留为可选诊断工具，不新建评测项目充当开发或上线许可证。
2. **权限按已有授权推进。** D-038 的五类变更不再自动暂停。正式设计内的持久格式、数据 authority、私有协议和默认值调整由执行者
   连同迁移、消费者和文档完成，不为保住旧实现长期维持双权威或休眠 fallback。真正超出用户授权的不可逆动作、明确产品分歧或无法
   保留用户数据的迁移才请求决定。决策由执行者及时写回，取消等待另一验收方、固定抽两条 mutation 测试等流程要求。
3. **具体启用策略。** explore 的确定性路径接通后默认注册；辅助模型仍按用户槽位配置。记忆沿现有活动模型与 memory_edit 实现，
   新配置默认维护记忆并在分支、修订、实际覆盖和必要来源检查满足时接管压缩；缺覆盖仅该次交还 Pi。已有明确关闭、assist 等用户
   选择保留，缺省值与显式值在迁移中区分。自动 review 接通后默认作为不阻断传感器，使用已定义的 review 槽位。单会话配置与实际
   用量一起交付，不以 record-only 模式、完整 RunManifest 或缓存对照实验为前置。todo 的自报置信度只作信息，不再默认弹确认。
4. **工作状态与目录分离是正式架构。** Thread/ThreadRun 保留；新增由 Application Host 拥有的内容寻址工作状态、不可变结果修订、
   按需物化与版本化 Integration。状态可 fork，工具读取固定基线加本分支修改；真实执行修改收回状态后目录才可回收。窗口草稿以
   带版本快照加入基线，编辑器仍拥有可变缓冲，草稿集成不自动保存磁盘。非 Git 与无首次 commit 的目录通过 copy/CoW 后端支持。
   Git 是可复用的基线/物化/导出后端，迁移期间既有 resultCommit 是有效结果来源；原生状态持久化并发布成功后切换权威，不建长期双写。
5. **撤销不成立的性能与隔离形状。** 不用 live 父目录加 child delta 冒充固定基线；不默认硬链接可写依赖；不承诺首次采集、文件哈希
   或端到端 fork 是 O(1)。Merkle 结构共享、Git tree 读取、CoW 与按变化路径收集直接实施，必要成本显式计量；不把普通消息变成全仓
   捕获。需要真实路径的 Pi 工具、LSP、扩展与 shell 按需物化；受控工具虚拟分支与 shared 模式明确区分。
6. **D-077 收敛为物化生命周期。** 保留 setup、同路径重建、回收和占用可见性；setup 使用用户配置，按真实环境需要执行，失败可诊断。
   输入、可重建缓存、环境文件按用途处理，ignored 不是可删除或不重要的证明；回收须覆盖待保留结果和实际后台写者，git status 干净
   只是检查之一。撤回未经定标的 8 GiB/10%、600 s、30 天和 80% 固定默认；配置预算可执行，缺省按真实空间、占用与可回收量处理，
   不因猜测配额拒绝派发。结果引用保护实际对象，目录删除不等于释放结果历史。
7. **集成、验证与提示直接实现。** 先修 merge 只消费选定结果修订（含新增文件正文、类型与 mode），再落实逐路径三方分类、受检修订
   绑定和恢复操作；预期冲突保留可处理现场，意外部分失败条件补偿，文件/草稿/index 的实际影响分开记录。重叠提示非阻塞，投机合并
   绑定子结果与父相关路径/草稿版本，不要求完整 WorkspaceHead。两者随调用链交付，不加离线收益门槛。结构感知合并可继续实现和优化，
   不把文本合并成功解释成行为验证通过。

事实更正：当前 thread-services.ts 已提示 conflict markers/index entries；缺口是逐路径应用记录和恢复。thread-runtime.ts 的
withMergeWriter 在 index.ts 只注册 process writer，不是已接通的逐路径 before/after 集成事务。当前 prepare 要求 HEAD，不能声称
无首次 commit 或非 Git 目录已经支持隔离。上述事实已回写 status，不抹去既有 T1 核心交付。

保留：模型槽位/凭据的用户所有权、持久知识审阅、现有权限插件的单一提示权威、真实路径授权、失败分类和用户明确的设置；Windows
沙箱排除与不自行发起付费记忆实验的要求不变。缓存保活仍为用户可选的额外请求，不再以回放作为开关的使用门槛。

原因：项目尚处早期，长期关闭已设计能力、反复申请同类批准和为每个机制另建评测，会让工程流程阻碍实际使用。已证实的错误应修掉，
工程复杂度由实现承担，不能泛化为整项功能的禁用依据。

考虑过的替代：继续只保留候选与旧 Git 权威——违背用户本次决定；不区分实现状态直接改成已上线——会伪造交付；移除所有 fallback
与确认——会破坏已有配置、真实服务缺失和权限边界。采用默认交付、局部失败局部处理与一次性迁移。

影响：agent-harness.md 决策表、工具/记忆/检索/线程/度量；plan 执行规则、当前顺序、2.4–2.6、3.2–3.7 与验收；status 的政策和
待做项；architecture 的目标架构说明。D-077 原始条目保留，已存在的未提交文档改动在其基础上整合。

状态：正式设计已采用；本次只修订文档与验证文档，未修改运行时代码、未切换用户设置、未执行迁移或付费实验。实现进度只看 status。

### D-079 · 2026-09-05 · 修复工作状态、集成恢复与检索正文的真实调用链

类型：实现修正（D-078 范围内）

决定：保留既有 Thread/Run 和正式原生工作状态方向，替换 a08fbdd5/9b07c9be 中只有表面接线的实现。工作状态通过 recovery engine
提供的可信 storage 访问取得当前实际存储位置、catalog、对象捕获与 workspace queue/lease；基线、结果和未完成集成各自登记引用，
删除恢复历史不得删除它们。操作记录不再同时依赖 workspace 根目录猜测数据库和 best-effort JSON，写前保存真实内容对象与操作阶段。

集成比较实际基线与选定子结果，只处理其变化路径；原始父内容、子内容和恢复内容按哈希读取，不按字节数或文件种类猜相等。Git
和非 Git 使用同一结果/集成语义；非 Git 修订原子发布，重建/第二次捕获不能改变旧结果。默认逐路径集成不修改用户暂存区，不沿
git apply --3way 产生额外 index 改动；已有用户 index 保持其自身状态。漂移、正常冲突、意外失败和重启后的条件恢复分别记录。
这些检查协调受控调用，并不承诺对任意同用户外部进程提供 OS 原子比较交换。
集成的最终比较、写入和补偿与同一 DocumentAuthority 实例的 Documents 读写/移动/删除共用规范路径资源队列；目录操作覆盖子树，
无关路径仍可并行。Harness 路径租约、直接 fs/命令写入与其他 Host 实例的范围单独保持，不能把共享资源队列写成全部进程隔离。
同一结果重试在父相关路径状态仍等于首次输出时复用原冲突操作，不再次写入标记，也不把旧操作的写入数算作本次新写入。

补齐最终操作提交与父回合 checkpoint 的同事务绑定，避免“磁盘已合并、恢复历史没有这次变化”。日志阶段或最终提交失败必须进入
条件补偿；未完成操作先恢复再计算新计划，不能先算 no-op 后回滚旧结果。重启只对当前工作区记录操作对应目录；显式删除恢复历史
清除已完成 Integration 的恢复材料，保留工作分支/结果和仍待处理操作。文本合并按真实重叠区间与独立 mode 三方分类，无效 UTF-8
按不透明内容处理；不可应用的符号链接权限不作为伪造的目标身份。

setup 读取父 Pi 会话实际配置与 projectTrusted，不由 Host 绕过信任直接执行项目配置。目录删除期间持有现有 Documents 写入屏障，
活跃进程和编辑器使用者保留目录；shell 注册写入者失败不得继续执行未登记命令。

检索正文经 Documents 与 Host actor 路径 authority 读取，返回实际磁盘 revision/range。读取失败或搜索后内容变化不得回到
“扩展行号加单行命中”的假片段；可用结果与具体缺口一起返回，全部不可读则明确不可用。确定性检索不保留未接线的 Host 模型、
向量和 PageRank 桩；问题词项使用实际搜索、排序与当前片段，取消和多个请求路径贯通，不新增固定工具输出条数上限。

原因：真实复现确认了父新增文件被当作子删除、空 hash 漏掉内容修改、选旧结果读到新 snapshot、恢复只比 kind 删除用户内容、
Git 协调器立即 fallback，以及检索读取失败仍声明连续正文。单测总数和“已构造对象”不能证明这些行为成立。

影响：Host working-state/thread/recovery、index 生产装配、相关 protocol/Pi 工具、explore 服务和 Documents reader；更新 status
只记录实际调用与验证。窗口草稿/无目录工具等未接面按事实保留待做，不再以 helper 的存在标为交付。

状态：方案已采用并进入实现；最终交付证据见 agent-harness-status.md。

### D-080 · 2026-09-06 · 取消辅助模型分项统计，保留正常会话统计

类型：产品简化（用户明确决定）

决定：移除 Context 面板“智能体 Harness → 模型槽位用量”的调用次数、Token 和估算费用明细，并删除专为该区块提供的
modelSlotUsage 聚合与传输。后续记忆、explore、review 不再新增同类成本或辅助 Token 看板。保留右上角原有的普通会话费用、
输入/输出/缓存 Token、上下文容量，以及模型槽位的配置与功能；不修改 SDK 原始用量、单价配置或历史会话记录。

原因：用户认为额外分项统计占用视觉空间、实际意义不大，并明确澄清正常会话已有的费用和 Token 展示需要保留。

考虑过的替代：删除所有费用/Token 展示——超出用户范围，已撤回；把辅助金额换成 Token 看板——仍保留用户不需要的统计区块。

影响：ContextSidebarTab、harnessCounterPresentation、pi-host counter/session 装配、SessionStats、i18n；设计 8.4–8.6、
plan 0.7/2.4/2.9/3.2/3.7 和 status。D-068、D-078 中要求辅助模型分项用量/费用展示的部分由本决定取代，其余规则保留。

状态：已按本范围实施；验证记录见 agent-harness-status.md。

### D-081 · 2026-09-06 · 2.4 / 2.6（默认记忆与逐次压缩接管）

类型：默认值与运行契约落地（D-078）

决定：记忆设置收敛为 `off | assist | takeover` 三态，缺省为 `takeover`。`off` 停止 keeper、排除 Zone 2 中的 memory blocks
并始终交还 Pi 压缩；`assist` 维护和注入 blocks、由 Pi 压缩；`takeover` 在相同维护路径上逐次检查接管条件。旧
`shadowMode:false/true` 分别迁移为 `off/assist`，显式 `mode` 优先；错误类型和值拒绝读取或写入，不吞成默认。memory 是 user-only，
workspace 设置不能覆盖。全局值由活动 `SettingsManager` 实时读取；每个 Pi session 可持久设置覆盖或恢复继承，覆盖独立于分支上的
Goal/Assist 记录，不改全局文件。

接管要求同一次已接受且确有 material block 变化的 keeper 提交提供实际 context entry IDs、当时的完整活动分支祖先路径和可见 block
修订集合。压缩前重新解析 Pi 实际移除区间、当前分支与 block 修订；任何一项缺失、不连续、错分支或过期，都只让这次请求回到 Pi
自身摘要，不阻断会话。Host 重启后的内存 coverage 为空，不能冒充持久 checkpoint；下一次有效 keeper 更新可重新建立证据。
`compaction.after` 清旧 coverage，连续压缩各自重新证明。Host facts 当前只提供事件权威能可靠证明的 touched files；诊断事件缺少
resolution authority、恢复层缺少 session checkpoint 查询，因此暂不伪造“当前未解决诊断”或 checkpoint 正文。

运行失败投影到可选的 `SessionSnapshot.harness.memory`，区分 keeper/compaction，包含配置模式、有效模式、会话模式覆盖和最近失败；Context
可即时切换当前会话，Settings 修改继承中的活动会话。无效设置可在 UI 中修复。成功的同阶段运行或模式变更清除陈旧失败。主会话历史
不写 `memory_edit`，keeper 无文件/shell 工具；D-080 的普通会话费用/Token 展示保留，不恢复辅助分项看板。`record-only` 不加入本次
模式契约，也不作为默认交付前置。

原因：D-076 已提供 block 分支/CAS 与实际 entry 覆盖；此前剩余问题是这些证据未绑定完整分支和 block 修订、设置只在会话构造时读取、
默认仍停在 assist，以及失败对用户不可见。本次直接完成可用路径；局部证据不足时使用已经可靠的 Pi 摘要，比维持整个功能默认关闭更符合
D-078。`off` 若仍注入旧 blocks 也不是真正关闭，因此模式随 Zone 2 请求传递，只排除该来源而保留其他上下文。

考虑过的替代：继续 `shadowMode` 加独立 takeover 开关会保留两个冲突权威；持久化 coverage 会把 Host 进程内观察误写成 durable
checkpoint；无 keeper 证据时同步阻塞跑一次模型会增加压缩等待，当前直接交还 Pi；为当前诊断/checkpoint 造空值会把缺 authority
伪装成已采集事实。

影响：protocol harness settings、session feature/snapshot 与 Zone 2/compaction 请求；pi-host session 装配、memory/compaction/Zone 2
extensions；Application Host coverage、facts 与服务；Harness Settings、Context sidebar、i18n；设计 8.4、plan 0.7/2.4/2.6、status、
architecture 与两侧模块文档。

状态：已实施；本地验证与外部边界见 agent-harness-status.md。

### D-082 · 2026-09-06 · 3.2（发起窗口快照与 draft-aware explore）

类型：实现决策（D-071/D-078 的窗口正文纵切）

决定：用户从 Piarium UI 发送 prompt、steer 或 follow-up 时，Document Registry 自动取得该 surface 在会话 workspace 内的全部
dirty records。没有 dirty buffer 时直接声明 disk，不增加捕获请求；存在 dirty 时，先以现有 owner/generation 发布准确路径、
baseRevision 与 localEditRevision，再经 UI-authenticated Documents HTTP 路径把正文交给 Application Host。Agent runtime 请求只携
`AgentInputContext` 的不透明 snapshot ref，或 capture unavailable 加已知 dirty paths；正文不进入 prompt 参数、broker 事件、日志或广播。

DocumentAuthority 在捕获时核对 workspace、owner/generation、完整 dirty path 集合、每个 base/local revision，并重新做资源 containment
解析；任一变化使本次来源 unavailable，不取磁盘冒充。通过校验的正文复制进 Host 内存的内容寻址 SurfaceSnapshotStore：pending
快照只服务正在送达的输入，Pi 接受输入后 commit 为 active 并释放上一 active，发送失败 release，session drop 清理。后续编辑不改变
已捕获正文；surface 断开不删除 active snapshot。Host 重启会使内存快照过期，后续读取按 dirty paths 明确 unavailable，不声明持久。

SessionHost 在输入执行期间切到新 context，拒绝或发送失败恢复上一 context；CLI/headless 未携来源时切到 disk。快照 commit 属于输入
已接受后的生命周期记账：它失败时将新来源降为 unavailable、尝试释放并写 Host warning，绝不能把已经开始的 Pi run 报成发送失败，
从而诱发重复消息。HostServicesBridge 为 Harness 请求自动附当前 context，模型不能给 `explore` 伪造或选择 surface 参数；Router 仍以
broker actor 校验 session/workspace/capability。

`explore` 对 snapshot 中的 dirty paths 删除 rg 的磁盘命中，在固定草稿正文中执行同一 literal 匹配，再从同一 revision 切片；其他
路径继续读 Documents disk。snapshot 缺失/过期时，已知 dirty path 只返回来源问题。所有草稿路径和派生命中再次经过 actor scope 与
realpath-aware authority；snippet 标明 `disk | surface-draft` 和固定 revision。融合前不以 excerpt limit 删除 draft 候选。连续中文问题
通过 `Intl.Segmenter` 增加可搜索词，同时保留合法 Unicode 标识符和引号字面量。

边界：本次只让 `explore` 消费自动 surface snapshot；Pi 原生 `read`、现有 `grep`、LSP 共享 live buffer 和 isolated thread baseline
尚未切到该固定视图。结构图节点也尚未记录可与正文核对的 document revision，因此不把现有 symbol helper 直接混进结果。下一切片先
复用本引用接线程草稿基线，再为结构来源建立明确版本绑定。

原因：已有 recovery journal 服务于崩溃恢复，会被后续编辑更新，不能充当一轮输入的不可变正文；把正文塞进 runtime prompt 又会绕过
Documents authority。单独捕获、内容寻址、引用传递同时满足窗口所有权、固定读取和低延迟；已知 dirty 失败时禁用该路径的磁盘回退，
避免“功能仍能跑”掩盖读取了错误版本。

考虑过的替代：只把显式 editor attachment 注入 prompt 不能覆盖默认窗口语义，也不能被 thread/工具复用；让 Host 直接读 LSP buffer
会混用另一时刻或另一 surface；把每个 snapshot 永久持久化会在没有恢复消费者前制造新保留权威；捕获失败阻断用户消息则把辅助上下文
故障升级成会话不可用。

影响：protocol runtime/Harness 输入来源；application-client Documents API；UI DocumentRegistry、Pi session store 与 review flow；
runtime-broker dispatcher；pi-host SessionHost/HostServicesBridge；Application Host Documents authority/routes/snapshot store、Harness
router/service/explore；设计 6.1、plan 0.7/3.2、status、architecture 与模块文档。

状态：已实施；本地证据和仍未接的固定视图消费者见 agent-harness-status.md。

### D-083 · 2026-09-06 · thread.dispatch 持久草稿基线与 surface 集成边界

类型：实现决策（D-078 工作状态、D-082 窗口来源的线程纵切）

决定：`thread.dispatch` 在创建 Thread 之前，同步从 D-082 的不透明 surface snapshot 克隆完整 dirty 集合，并把将来保存会产生的
UTF-8 字节（含 BOM 与原换行）、磁盘 baseRevision、surface localEditRevision 和固定 snapshot revision 写入 WorkingState 的
内容对象与 draft-baseline manifest。它不把临时 snapshot ref 当作 queued Thread 的恢复权威，也不把正文放进 Thread catalog、broker
事件或模型参数。WorkingState catalog 升至 schema 2；Thread catalog 升至 schema 7，`ThreadLaunchManifest.draftBaselineId` 是不可变
launch input，旧 schema 明确迁移为 `null`。Thread 创建失败释放刚建立的 draft baseline；Thread 已创建后该对象随工作保留。

带 dirty baseline 的角色统一使用 isolated worktree，包括通常为 shared/none 的角色。snapshot unavailable、过期、session/workspace 或
完整 dirty path 集不匹配时 dispatch 失败，不创建一个读取磁盘却声称继承窗口状态的 Thread；已验证为空的 surface 保留角色原来的
worktree 策略。正文已复制后，surface snapshot 可正常被下一次输入替换或随 Host 生命周期释放，queued、首次启动与无 session id 的
lost 恢复只依赖持久 baseline id。

Run 首次启动先由现有 Git/copy 后端准备磁盘目录和显式 ignored 输入，再把 draft baseline 叠到相同目录。叠加后的有效路径状态直接
成为 WorkingBranch `baseState`，`headRevision = 0`、`deltas = {}`，`draftBasePaths` 记录来源范围；草稿是父输入，不是子结果。
因此子未修改草稿时结果不含该路径；发布 live 结果时即使 Git 忽略该文件也必须比较所有 draftBasePaths。运行中结果采集明确读取
materialized live 目录，merge 的旧 Git/copy 兼容入口默认读取已选 fixed result，已有 resultCommit/resultPath 不得遮蔽恢复后继续产生的修改。

集成只处理子相对有效基线真正改变的路径。对 draftBasePaths：父磁盘等于子结果时 no-op；父磁盘等于固定草稿基线时可按普通计划应用；
父磁盘同时不同于二者时返回可识别的 `surfaceTargetPaths` 冲突，该路径不生成 target、不写磁盘、不放冲突标记。当前尚无把结果写回
原编辑器缓冲的 Host→surface 操作，因此用户先在父编辑器保存或协调草稿后重试；这项明确的零写入冲突替代把未保存输入偷偷落盘。

边界：非草稿文件仍以 Run 物化时的目录为基线，本决定不声称整个工作区在 dispatch 时固定。Pi 原生 `read`、现有 `grep` 与父工作区
LSP 尚未直接读取 WorkingState 虚拟视图；隔离线程通过真实物化目录获得一致内容。surface buffer 写回/grouped undo、无目录工具、
完整物化预算和归档释放继续按 3.2/3.4/3.5 实施。

原因：持久复制发生在 snapshot 仍可读的 dispatch 请求内，既消除排队/重启对 Host 内存引用的依赖，也保持 surface 是可变编辑缓冲的
唯一所有者。把草稿放进 branch base 让结果、三方合并和 ignored 路径都使用同一个父输入身份；若把它发布成 revision 1 delta，未修改
草稿会被误报为子工作并可能在 merge 时写回磁盘。live/fixed 读取模式分开则同时满足半成品恢复和固定结果消费。

影响：protocol `ThreadLaunchManifest` / `ThreadMergeResult`；UI Documents capture 与 application-client 类型；Application Host
SurfaceSnapshotStore、ThreadRegistry、Thread services/runtime/worktree、WorkingState store/materializer/IntegrationCoordinator；
设计 6.1/9.2.5b/9.3、plan 0.7/3.2/3.4/3.5、status、architecture 与模块文档。

状态：已实施；本地证据和当前未接边界见 agent-harness-status.md。

### D-084 · 2026-09-06 · copyIgnored 成为持久结果捕获范围

类型：实现决策（D-078 工作状态/物化边界的收口）

决定：`harness.worktree.copyIgnored` 在首次 Run 准备并捕获基线时规范化为工作区相对根，写入 WorkingBranch `captureScopes`；
WorkingState catalog 升为 schema 3。schema 1 迁移为空 draft/capture 范围，schema 2 保留 draft baselines 与 draftBasePaths、
captureScopes 为空，schema 3 严格要求该字段。已有 branch 恢复使用持久范围，不重新解释后来变化的 settings。

窄结果发布把后端 changed paths、草稿结构闭包与 captureScopes 合并。每个 capture scope 只枚举该文件或目录子树，并同时比较
baseline 后代与当前后代，因此修改、新增和删除都进入 native WorkingResult；符号链接作为链接捕获，不递归跟随。它不为显式 ignored
输入重新扫描整个工作区。partial publish、lost-run 恢复、directoryMatchesResult、reclaim 与 materialize 继续消费同一个 native
resultRevision，Git status 是否看见该路径不再决定结果是否保存。

原因：copyIgnored 已是用户明确选入的执行输入。只在 prepare 时复制却不把范围留在 branch，会使 Git ignored 修改既进不了
resultCommit 也进不了 native result，最终只能永久保留目录或在错误回收时丢结果。把根随 branch 持久化同时解决重启配置漂移和目录
后代新增/删除，不需要 WorkspaceHead 或每次全仓扫描。

状态：已实施；代码、迁移与验证见 status 3.4a。

### D-085 · 2026-09-06 · 普通 read/grep 消费固定窗口草稿

类型：实现决策（D-082 固定来源的工具纵切）

决定：`search.content` 接收 Router 已校验的 AgentInputContext。surface dirty paths 先按 actor scope、请求 path 与 glob 过滤；
Application Host 在 rg 流式结果计数前按规范化 resourceId 排除它们的旧磁盘命中，再在消息发送时的固定正文上执行 regex/fixed string、
大小写与同一 glob 过滤，合并后统一排序、context 和 limit。已知 dirty snapshot 不可用时返回 unavailable，不从磁盘补值。公开但从未
实现的 `type` 与 files/count mode 从协议和工具 schema 删除；before/after/context、glob、fixedStrings 与 ignoreCase 贯通真实后端。

普通 `read` 继续使用 Pi 0.84.3 的 `createReadToolDefinition`，只新增一个同名 source wrapper。Application Host 声明
`harnessDocumentRead` 后，worker 在每次执行前以受授权 path 请求 `document.readSource`：非 dirty 返回 disk sentinel 并直接执行 Pi
原生 read；dirty 返回固定 revision 的 save-compatible UTF-8 bytes（保留 BOM 与换行），再把这一次 bytes 交给相同 Pi definition。
因此分页、截断、错误和磁盘图片 attachment 不复制实现。Host 未声明能力或用户关闭该覆盖时保留 Pi built-in。来源正文不进入工具参数、
请求事件或日志，surface revision 写入 tool details；Windows 等不区分大小写的工作区按等价 resource identity 查 snapshot。

边界：find/ls 尚未叠加 dirty-only 路径；LSP/符号图还没有与固定正文绑定的独立 revision/session；surface snapshot 仍是 Host 生命周期内
的输入来源，Thread dispatch 已按 D-083 复制为持久基线。上述缺口继续直接实施，不回退已接通的 read/grep。

状态：已实施；生产接线与验证见 status 3.2。

### D-086 · 2026-09-06 · 普通 find/ls 消费固定窗口路径快照

类型：实现决策（D-082 固定来源的目录枚举纵切）

决定：新增内容为空的 `document.pathOverlay` Host method。Router 以 `allowMissing` 授权请求根；Documents 先核对同 session、workspace
和 ready surface snapshot，再返回相对请求根的 fixed dirty file、每路径 revision 和虚拟目录祖先。请求根不在 dirty 集合时返回 disk
sentinel；相关快照过期或不可用返回 Harness `unavailable`，不以磁盘空结果替代。Host 复用 picomatch 的 basename、brace/extglob 和
Windows nocase 语义筛选 find pattern，不在协议或事件中传正文。

`find`/`ls` 仅在 Host handshake 明示 path-overlay capability 且对应 Settings 工具开启时同名覆盖。find 对固定 entries 与原生 fd 结果去重、
确定排序后交回 Pi `createFindToolDefinition`，保留目录后缀、limit、通知和 50KB 截断；ls 通过 Pi `createLsToolDefinition` 合并 immediate
磁盘项和虚拟子项。固定 snapshot 对已覆盖路径的 file/directory 类型优先，避免磁盘漂移被 Pi 原生 stat 循环静默丢弃。

边界：snapshot 当前只表达 dirty text file exists，不表达删除或 rename tombstone；LSP、固定正文 revision 和隔离线程物化仍分别由既有纵切负责。

状态：已实施；生产接线与验证见 status 3.2。

### D-087 · 2026-09-06 · 3.8 / 3.1（语言服务视图隔离与正文修订绑定）

类型：实现决策（D-082 固定来源的语言服务纵切；含协议与符号图 schema 变更）

决定：`LanguageSupervisor` 的会话键从 `(workspaceId, languageId)` 扩为 `(workspaceId, languageId, viewId)`。`surface` 视图由 UI 独占，
沿用现有 `localEditRevision` 语义与生产行为，renderer 请求不能选择别的视图，事件流也只投递该视图。`agent` 视图由 Application Host
独占，每个文档单独绑定到一个命名的正文身份：导航工具用 D-082 的 `AgentInputContext`（脏路径取 `readAgentInputSnapshot` 的固定草稿，
其余取磁盘），符号采集与诊断只取磁盘。同一视图内两类需求对同一文档冲突时，由修订断言分出胜负——导航重绑一次后重试，采集直接放弃
并保留上一张图，不循环。

agent 视图惰性创建：首次发生 agent 查询或符号采集时才为该语言起进程，空闲超时、`disposeWorkspace` 与 `dispose` 释放它，进程数、
开文档数与空闲时长由 `inspectViews()` 报告。**代价如实记账**：只有一侧活动时仍是一个进程，编辑器与 agent 同时活动才是两个；不常驻
第二套服务器，也不为省内存改回单会话逐次重同步。

文档版本号由 Host 按 (视图, 资源) 自行单调分配，不再与编辑器 `localEditRevision` 共用命名空间；**内容身份**单独携带——固定草稿为
`surface-draft:<ref>:<localEditRevision>`，磁盘为 Documents `revision`。绑定到同一身份时不再发通知、不推进版本。每个 agent 侧结果
声明它实际使用的修订与来源（`disk | surface-draft`）。被查询文档是精确绑定，请求前后都断言该修订，不符即 `stale`；跨文件位置由语言
服务器自己读盘计算，LSP 不报告它使用的版本，因此这些位置一律标为 `unpinned` 并说明原因，不给它们编造修订，也不冒充已绑定。

每个视图拥有自己打开的文档：`surface` 关闭最后一个标签页不再销毁其他视图，agent 视图在回合结束、会话结束或空闲时关闭文档并设开
文档上限，provider 重注册与 restart 只影响本视图。现有 harness 与符号采集只开不关、`desiredDocuments` 单向增长并在服务器重启时全量
重放 `didOpen` 的行为一并修掉。语言身份收敛为 Host 单一解析器（含扩展贡献），harness 与 UI 不再各持一张扩展名表：`.mts/.cts/.mjs/.cjs`
在 agent 侧不再判为 unsupported，`.sh` 不再因 `shellscript`/`shell` 分裂成两个会话。

符号图按用户选择只绑磁盘：`replaceFileSymbols` 要求并记录该文件的 document revision，空修订被拒；旧行缺该字段时读作 `null`（unknown），
可被下一次采集替换，无需数据迁移。脏缓冲算出的范围不入图——采集不再"已同步就沿用别人的正文"，每次都绑定磁盘正文，代价是每次采集
一次 Documents 读取。`explore` 的结构展开只使用带修订且与当前正文一致的范围，不一致时退回行窗口并说明来源状态。
`lsp.symbols/definition/references/hover` 与 `lsp.diagnostics` 的结果一并带修订与来源；诊断适配器按规范化 resourceId 精确查找，删除现有
`endsWith` 双向后缀匹配（`src/lib/a.ts` 会被 `a.ts` 命中）。

**诊断读磁盘。** `lsp.diagnostics` 绑定该路径的当前磁盘正文并等待针对同一修订的发布（默认 5 s，权威空列表就是 clean），超时为
`pending`。理由是它是"刚写完的反馈"，必须描述 agent 自己写上磁盘的正文；导航则跟随本轮固定来源以便与 `read`/`grep` 对齐。两者各自
声明来源，不混。按 D-085 的先例，公开但无生产调用方的 `lsp.diagnostics.afterSnapshot` 参数与其驱动的 provider `syncDocument` 一并从
协议和 provider 契约删除——版本命名空间冲突的唯一可达路径随之消失。

边界与事实更正：`syncedDocumentVersion + 1` 的版本冲突只在调用方传 `afterSnapshot` 时可达，此前没有生产调用方，因此那是潜在故障而非
已发生的用户故障，本决定按结构消除，不声称修复了正在发生的问题。已可复现的是另外两条：文件在编辑器里脏时 agent 的 `lsp.*` 与符号
采集读到未保存缓冲，而同一回合的 `read`/`grep` 按 D-085 给固定草稿；UI 在 agent 查询之间同步一次就让该查询返回 `unavailable`。
**跨文件位置不做 stale 判定**：可用的只有 Documents mutation 观察，而它不覆盖 Pi 原生 `write`/`edit`（不经 Documents authority），在不
完整的信号上标"未变化"等于伪造事实，因此只标 `unpinned`。隔离线程今天已因 `resolveRuntimeWorkspaceId(cwd)` 取得自己的 workspaceId
而拥有独立会话，即每个运行中线程一个语言服务器进程；本切片只度量并说明该成本，进程复用不在范围内。语言身份表是 Host 静态表，
renderer 在运行时由编辑器注册表贡献的语言仍然只在 renderer 可见，agent 侧对它们明确不可用。

原因：三个写者共用一条会话，正文由最后一个写者决定，而版本号是编辑器的计数器。于是 agent 的符号范围取决于用户当时有没有打开该文件、
有没有在打字，跨回合也无法归因到任何一份可取得的正文。在这种结构上只补一个 revision 字段，等于给来源不明的正文贴标签，并让下游开始
信它；隔离视图加内容绑定才让"这些范围来自哪份正文"成为可回答的问题。

考虑过的替代：给草稿文件另一套影子 URI——模块身份改变，import 解析与 references 失真；为父会话每回合物化整个工作区——正是 D-078/D-083
拒绝的普通消息全仓成本；单会话每次查询前重新同步——与编辑器互相覆盖并抬高延迟，等于把当前故障做成机制；始终双进程——内存占用最高
且常见情况没有收益。

影响：`lib/lsp/supervisor.ts`（视图键、版本分配、生命周期）、`lib/lsp/routes.ts`、UI `language-services/session.ts`；
`lib/harness/lsp-nav.ts`、`diagnostics-adapter.ts`、`diagnostics-service.ts`、`lib/knowledge/symbol-runtime.ts` / `symbols.ts` / `store.ts`
（符号 schema 与迁移）、`lib/harness/language-id.ts` 与 UI `language-services/language-id.ts` 合并；protocol `LspNavigationResult` /
`DiagnosticsResult` 增加修订与来源；设计 5.0/6.1/6.2/6.4、plan 0.7/3.1/3.2/3.8、status 3.1/3.2/3.8 与相关模块文档。

状态：已实施；生产接线与验证见 status 3.1/3.2/3.8。

### D-088 · 2026-09-06 · 3.2（写入使固定窗口草稿在该路径上失效）

类型：实现修正（D-082/D-085/D-086 的读取语义缺陷）

决定：固定窗口草稿是一轮输入，不是永久权威。Piarium 观察到某路径被写入后，**该次写入之前捕获的每个 snapshot 都停止用草稿回答这个
路径**：`document.readSource` 返回 disk sentinel（Pi 原生 read 因此读到刚写的字节），`search.content` 与 `explore` 不再排除它的磁盘命中、
改按普通 rg 路径搜索，`document.pathOverlay` 不再枚举它，`lsp.*` 导航按磁盘绑定，`thread.dispatch` 的草稿基线不再叠加它。写入之后
捕获的 snapshot 保留自己的草稿——那份草稿正是用户当时屏幕上的正文。

观察来源两条，都是 Host 侧可靠信号：Documents 权威的 write/move/delete（含用户保存），以及 Pi mutation journal 的 `after` 阶段且
`succeeded === true`（覆盖原生 `write`/`edit`/`apply_patch`）。journal 那条在**确认工具之前**被 await，因此同一回合里紧接着的读取不可能
还看到写前的草稿。journal 记账失败不影响失效判定——文件确实被写了。绝对路径按工作区根解析，落在根外（隔离线程的 worktree）不失效
本工作区的草稿。

完整性检查保留：`thread.dispatch` 仍要求请求的每个 dirty path 都被交代清楚，只是判据从"全部克隆到"变为"克隆到的草稿 ∪ 已失效的路径 ==
请求集合"。已失效路径以 `supersededPaths` 显式返回，不静默消失。`agentInputDraftPaths` 返回"本轮固定来源仍拥有的 dirty 路径"，
过期捕获仍返回全部已知 dirty 路径，因此 D-085 的"已知 dirty 不可用时不回退磁盘"不变；失效与不可用是两件事，前者是磁盘成为更新的
权威，后者是我们丢了本该展示的正文。

边界：shell 与外部进程的写入仍未被观察，与恢复日志同一边界；这类写入之后草稿继续服务该路径。**另一件事本决定不做**：Pi 原生 `edit`
的 `old_string` 匹配的是磁盘正文，而 `read` 给的是草稿，两者不同时首次编辑会报"字符串未找到"。让 `edit` 改按草稿匹配等于把用户未保存
的改动顺带落盘，违反 D-083 明确的"草稿集成不自动保存磁盘"，因此保留为独立产品问题，不在本修正内改。

原因：D-085 让 `read` 消费固定草稿，但没有定义"写入之后草稿还算不算权威"。实际后果不止读不回自己的写：`grep` 会把该文件的磁盘命中
整体排除并只在旧草稿里匹配，agent 刚写的代码对 `grep` 完全不可见；`find`/`ls` 继续枚举旧快照；dispatch 会把旧草稿叠回子线程基线，
覆盖已经写进磁盘的结果。读回自己的写是工具循环的基本前提，缺了它 agent 无法验证自己的编辑。

考虑过的替代：把该路径从 snapshot 的 `resources` 里直接删除——会破坏 `samePaths` 的完整集合校验，把失效误报成过期；让 `read` 在写入后
返回 unavailable——把可用的磁盘正文说成不可读；只修 `read` 不修 grep/find/dispatch——留下更严重的不可见性。

影响：`lib/documents/surface-snapshot-store.ts`（`superseded`、`observeWrite`、`draftPaths`、clone 的 `supersededPaths`）、
`lib/documents/authority.ts`（`publishMutation` 失效、`observeAgentWrite`、`agentInputDraftPaths`）、`lib/recovery/turn-coordinator.ts`
（`observeToolWrite`，确认前 await）、`index.ts` 接线、`lib/harness/search-service.ts` / `explore-service.ts` / `service-host.ts`、
`lib/harness/thread-runtime.ts` 的 dispatch 完整性判据；plan 3.2、status 窗口读取行与 3.2。

状态：已实施；验证见 status 3.2。

### D-089 · 2026-09-06 · 3.2（读写来源不对称：写入前拦住并说清楚）

类型：实现修正（D-085 读取语义的写入侧对偶；用户已决定语义）

决定：新增 Host method `document.writeGuard`（capability `write.document`，路径以 `allowMissing` 授权）。原生 `write` / `edit` /
`apply_patch` 在**同一条路径租约内、写入与 journal before 之前**先请求它；返回 `conflict` 或 `unavailable` 时工具以该原因失败，
磁盘、journal 与工具结果都不产生任何写入痕迹。判据只有一条：**本轮该路径的固定草稿仍有效，且草稿正文与当前磁盘正文不同。**
草稿与磁盘相同（脏缓冲但内容一致）、路径没有草稿、草稿已按 D-088 失效、本轮来源是 disk，全部照旧放行。

拦住时给的是可执行的原因：文件有未保存的编辑器改动、你读到的是草稿而写入落在磁盘、现在写会把用户未保存的改动落盘，本次什么都没写。
消息不含正文，草稿修订以 `revision` 放在结构化结果里。磁盘缺失（只存在于未保存的新建草稿）与磁盘为 binary/unsupported 同样按 conflict
处理——无法证明写入安全就不写。已知脏路径但草稿不可读（快照过期、Host 重启）返回 `unavailable`：既不假称安全，也不谎称冲突。

**本轮唯一的解法是保存，消息只说保存。** 用户保存走 Documents write，因此按 D-088 使该路径草稿失效，重试即是普通写入。放弃不行，
而且不该行：本轮仍按捕获的草稿回答该路径，把它写回磁盘等于把用户刚否决的改动重新落盘，与拦住的初衷同一个错误。消息因此明说放弃不
解除拒绝、需要在后续回合重新读取，避免 agent 在同一条建议上反复重试。`unavailable` 同理不建议原地重试：固定来源已经丢了，本轮内
保存也换不回它（`read` 在快照过期时先于 superseded 判定返回 unavailable），消息让 agent 报告路径并在后续回合重读。

`apply_patch` 在拿到全部文件租约后先逐个预检，任一路径冲突即整体拒绝，不留半应用的树。worker 侧先看本轮 `AgentInputContext`：
来源是 disk 或没有 dirty path 时根本不发这次请求，因此普通写入零额外成本；只有"用户此刻有未保存文件"这个窄窗口才多一次往返。
该检查与固定草稿 read 覆盖共用 `harnessDocumentRead` 握手能力——两者是同一套来源契约的两面，Host 不提供草稿时读写本来同源，
无需守卫。

明确不做：让 `edit` 按草稿匹配 `old_string`、或让 `write` 把草稿正文写回磁盘。那等于把用户尚未决定保存的改动落盘，正是 D-083 在
子线程集成路径上拒绝的事（宁可返回 `surfaceTargetPaths` 零写入）。原生工具的匹配语义完全不动。

边界：守卫协调的是受控写入。shell 命令、外部进程与第三方工具照旧不经过它，与 D-088、恢复日志同一边界。守卫请求本身失败（传输、
超时）按失败处理，写入不发生——在这个窄窗口里无法证明安全就不写；理由随错误消息可诊断。

原因：D-085 让 `read` 消费固定草稿，`write`/`edit` 仍落在磁盘，于是同一路径读写不同源。后果不只是 `edit` 的 `old_string` 匹配失败：
agent 拿不到匹配就会退化成 `write` 全量覆盖，而它手里的正文是草稿加自己的改动，用户未保存的编辑因此被静默写进磁盘。这条路径把
D-083 保护的原则在父会话自己的写入上破掉了，且发生时没有任何提示。

考虑过的替代：把拒绝挂在 journal 的 `accepted` 布尔上——那个布尔的既有语义是"记账是否成功、失败不阻断工具"，复用会让记账故障开始
阻断写入；该路径 read 直接给磁盘——agent 就看不到用户屏幕上的正文，与 D-082 的窗口语义冲突；做成用户设置——先交付明确语义，
需要时再加开关。

影响：protocol `DocumentWriteGuardResult` / 方法表 / capability 映射；`lib/documents/authority.ts` `inspectAgentWriteTarget`；
`lib/harness/harness-services.ts`、`router.ts`、`service-host.ts`、`index.ts` 接线；pi-host `host-services-bridge.ts`（暴露
`inputContext()`）、`workspace-mutation-journal.ts`（`assertWritablePath` 与锁内预检）、`harness/apply-patch-tool.ts`、
`harness/select-tools.ts`、`session-host.ts`；设计 6.1、plan 3.2、status 窗口读取行与 3.2。

状态：已实施；验证见 status 3.2。

### D-090 · 2026-09-06 · 3.2（explore 的快速检索策略：替主 agent 做掉机械步骤）

类型：设计修正 + 实现缺陷清单（D-078 目标重述；用户采纳 2026-09-06 外部设计评审的方向，逐条核对后记录）

决定：`explore` 的目标改写为一句话——**基于主 agent 当前的问题与已知线索，用本地检索和结构追踪取得一小组可直接判断的代码原文；
尽量消除机械性的搜索—阅读往返，保留尚未解决的语义问题。** 优化对象是"主 agent 获得足够证据、能推进下一步的时间"，不是"返回一批
相关文件的时间"。边界只有一条：**机械依赖由 Host 接着走**（找到名字才能查定义、找到定义再找注册点、读到参数再读实现），**语义假设
留给主 agent**（"问题可能不是权限而是缓存键"）。内部存在串行依赖不等于需要串行模型调用。

按主 agent 此刻缺什么分四种情形，各有合适的能力与返回，不塞进一条管线：知道名字不知道位置（符号/路径/字面量定位 → 定义或关键
出现点）；知道概念不知道仓库用什么词（概念到词汇的桥接 → 少量可信入口，保留候选分歧）；找到文件不知道关键部分在哪（文件内定位与
结构化阅读 → 相关语法块、签名、必要条件）；找到入口不知道如何连到另一处（有方向的关系追踪 → 连接两端的原文与关系依据）。

工具分工改写：只需精确匹配用 `grep`；需要定位后顺便理解相关上下文用 `explore`，即使已知确切符号。不是"知道符号用 grep、不知道
用 explore"，`grep → explore → retrieval` 也不是必须逐级失败才能升级的阶梯。

`explore.search` 增加 `anchors?: string[]`：主 agent 已知的符号、方法名、错误文本、路径片段。`question` 回答"想知道什么"，`anchors`
表达"已经知道什么"。锚点是强种子：优先取得候选、有独立于泛词的预算、按字面匹配；但**不是硬过滤**——主 agent 猜错的同义词不能把
正确实现排除掉，它只是候选。不要求主 agent 编写检索计划或正则。

候选获取与融合：词项分组——同一概念的变体（原始标识符与其拆分词、字面量、路径线索、中文分词）用于扩大匹配，不同概念之间的共同命中
才增加相关性；精确符号与引号字面量保留高辨识度。候选预算与输出预算分开：`limit` 只管输出的摘录条数，候选获取用独立的工作预算，
达到扫描预算时明确返回未搜完。`explore` 不继承 `grep` 的展示排序（命中数 + 测试路径惩罚 + 深度惩罚）作为相关性定义，测试目录偏好由
问题决定。脏路径叠加统一走 search-service 一条路径（传 actor 与 inputContext，后端在计数前排除），`explore` 不再自带第二套草稿匹配。
RRF 融合的是不同信息来源的名次，不掩盖单路本身只是命中数排序。

物化：先用便宜信息排候选，按需读取当前来源正文，输出满足后不再无条件读完；未读候选记 `not-requested`，不混进 `empty`。正文读取
可有受控并行，但目标是少做无用读取。

切片单位：**与当前问题相关、尽可能自包含的原文单元**，不固定为完整符号。小函数全文；大函数返回签名、命中所在语法块、必要外围
条件，明确标记省略区间，并保留完整符号的读取入口。不声称自动选出的片段语义完备。冷/热语言服务是显式执行条件："得到可读代码"
不依赖"语言服务器已经热了"，缺结构来源退回行窗口并说明来源状态。结构来源是带修订绑定的可插拔 provider，第一个实现是 6.4 的 agent
视图 `documentSymbol`（语法层请求，不等语义分析完成）。**tree-sitter 作为第二个 provider 是带触发条件的待决项**：出现第二个消费者
（注册/协议字面量等连接边的形状识别，或冷仓库的轻量符号目录），或实测 `documentSymbol` 场景的冷启动不可接受。引入前先在本仓库
量一次 agent 视图从冷启动到 `documentSymbol` 可用的时间。语法包按语言随应用打包、惰性加载，无语法包的语言退回行窗口；
"让 agent 视图对主要语言保持热"是性能开关，按 plan 0.4 不变量 11 正确性不依赖它。

连接点：注册点、协议字面量、配置键、事件名是一等检索连接点（例：`"explore.search"` 把 pi-host 工具、protocol 契约与 Host
`router.register` 连成一条链，LSP 给不出这条边）。查询时只从少数能可靠识别的调用/注册形状取证；无法确认的同名字符串标为关联候选，
不伪装成已解析的运行路径。

打包：内部尽量找全可能性，外部只给能支撑当前判断的材料；片段之间要互补——先比较文件内哪些片段最有用，再考虑集合互补，不做
"每文件最多 N 块"的普遍硬限制。歧义时返回区分依据与各自支撑原文，不急着请 judge 十选一。`explore` 在进入通用工具结果之前按字节预算
完成打包，装不下时说明哪个支撑未展开并保留可读引用；细粒度 provenance 放 `details`，模型正文以代码与可行动缺口为主。OutputStore
句柄保存完整打包正文与未展示候选的引用清单，是展开长材料的后备入口，不是每次的固定下一步。

可选模型增强按"当前缺的那一步"选一种：没有可匹配的仓库词汇 → 意图转换；已搜到材料但目标缺席或线索指向新方向 → 受限查询修复
（必须能提出新词项或入口，只选已有候选 ID 解决不了候选缺席）；候选多、都似成立、阅读成本高 → 候选比较。不默认
intent → judge → repair 全跑；这是策略，不是新的硬轮数不变量。

§6 开头"agentic grep 已被证明优于 embedding RAG"改为"词法、路径、符号是可靠的基础入口；语义召回用于弥补词汇不一致，不承担所有
检索任务，也不是基础可用性的前提"——与同节 H2/H4 自己标注的证据边界一致。embedding 在 Piarium 要回答的问题是"它有没有找回词法与
结构路径没找到的有用入口"。

已观察缺陷（代码可推导，非实测；均在默认开启的工具上）：
1. `explore.ts` 把 `input.limit` 传给 search-service 的 `limit`，后端 `maxResults = 3·limit` 且总命中截到 `limit`——要 3 段摘录时
   每个词项候选池只有 3 条命中。
2. `explore-service.ts` 调 search-service 不传 actor/inputContext，脏文件旧磁盘命中先吃预算再被事后丢弃；两套草稿匹配器语义不同。
3. 标识符、拆分词、中文分词、字面量在 RRF 里对等投票，拆得越碎权重越高；反引号字面量已提取但无优先级。
4. 每一路名次来自 `fileScore`（recency 因 TODO 恒为 1），`explore` 继承了 `grep` 的测试路径与深度先验。
5. 全部有命中文件顺序读完再 `slice(0, limit)`；默认最多 100 个文件串行读只为展示 20 段。
6. 排第一文件的全部窗口先入列，可占满输出；打包单元是按文件排好的命中列表。
7. `explore` 无自身字节预算；通用截断 32 KiB 头尾各半会裁掉中段片段并二次存入 OutputStore；句柄内容与已展示正文相同，
   `get_output` 不含被裁候选。
8. 工具描述 "Open question … broad questions" 超出无词汇桥接时的能力；`_onUpdate` 未用于模型提前消费，不得作为承诺。

顺序：先修上述缺陷并加 `anchors`（不需要新模型、索引或依赖），再让结构展开消费 6.4 带修订的范围（贯穿例子：`explore.search` 的
worker—protocol—Host 链；验收是主 agent 一次结果能否看见这条链，而不是"多了一个 symbols 调用"），再按观察到的"找不到入口"决定
词法索引、仓库文档关联、意图转换或 embedding。这改变 D-087 后"下一步是结构展开"的顺序。

不做：独立 retrieval benchmark 门禁——观察三件事即可：拿到 explore 后还做了多少纯定位动作（验证与新假设所需的阅读是正常工作）、
返回正文是否含关键判断依据（正确文件在列表里不够）、从调用到可用结果的时间与交给模型的正文量（冷/热/无 LSP 分开看）；出问题先分
候选没进来、打包丢掉了、来源不对、主模型没利用。不把 UI 流式早期结果当作主模型等待时间减少的证据。不现在建仓库级索引或引入
tree-sitter。不声称能省多少时间。

原因：§6.1 对"有哪些来源、谁拥有、失败怎么表示"已清楚，对"一次 explore 替主 agent 做哪些查找、返回什么、何时停、为什么省时间"
仍是通用管线形状。外部设计评审指出这一点并给出代码级诊断；逐条核对后代码诊断全部成立，其中 `limit` 耦合与脏路径路径分叉比评审
描述的更确定。评审约三分之一的主张（bundle 支撑可空、不预置删除顺序、模型增强不全开、纯算法默认、只记录不学习、修复接受类型化
搜索/导航）已在 6.1 中，问题在实现未兑现，不重复记为新决策。

考虑过的替代：按原顺序先做结构展开——会建在被前置截断的候选池上；只在工具描述里提示反引号、不加字段——用户选择正式字段；现在
引入 tree-sitter——没有第二个消费者、没有冷启动实测，先定接口不定库；让 LSP 常驻——是性能开关而非正确性条件。

影响：agent-harness 2（检索行）、5.0 工具表、5.7、6 开头、6.1（分工、策略段、seed/fan-out/fuse/slice/pack/模型增强、句柄语义）；
plan 0.7、3.2；status 3.2 与下一步；待实施：protocol `explore.search` params、pi-host `explore-tool.ts`、Host `explore.ts` /
`explore-service.ts` 及其对 search-service 的调用方式、模块文档。

状态：策略已采纳并回写；缺陷修正与 `anchors` 待实施（plan 3.2 "候选获取与物化" 行）；结构展开在其后；tree-sitter 待决（触发条件见上）。

### D-091 · 2026-09-06 · 3.11（结构来源 provider 与 tree-sitter 语法包）

类型：设计决定（解决 D-090 的 tree-sitter 待决项；用户已决定捆绑范围与首刀语言）

决定：引入 tree-sitter 作为 Application Host 的第二个结构来源，与语言服务器**长期共存、不替代**。两者回答不同问题：语言服务器回答
"这个名字指什么"（定义、引用、类型、诊断），tree-sitter 回答"这段文字的形状是什么"（函数边界、命中所在的语法块、字面量与注释、
带字面量的调用形状、import）。它给不了类型、跨文件解析与诊断。

消费者按对现有缺口的直接程度排：explore 结构切片（不等语言服务器起进程）；**命中分类**——6.1 fuse 段"名称、路径、注释、字符串和
函数正文不按同一方式计分"要落地，必须知道命中在哪类节点里，rg 只知道"这一行有这个词"；**连接边识别**——`bridge.request("…")`、
`router.register("…")`、`on("…")` 等调用 + 字面量形状，查询几行可稳定抓出，正则不稳；**冷仓库符号目录**——喂进 6.2 现有
`file → defines → symbol` 图，名字/种类/范围与 `documentRevision` 绑定同一形状；`imports` 边；线程与压缩用的仓库地图。

实施形状：
- 在 Application Host，不进 renderer。编辑器（Monaco、移动端 CodeMirror）各有自己的解析器，不为高亮再加一套；宿主是所有客户端
  共用的，装一次全部受益。
- 用 wasm 版（web-tree-sitter），不用原生绑定。原生版需按平台与 Electron ABI 各编译一份，打包与升级都是负担；wasm 版 Node 到处
  可跑、解析仍是毫秒级，代价只是打包时 `.wasm` 要放在可读位置。
- 语言身份复用 D-087 的 `languageIdForPath`：语法包按同一规范 ID 索引，与语言服务器视图同一把钥匙，不再多一套扩展名映射。
- 解析结果按内容哈希缓存。D-082 的快照存储本来就是内容寻址的：同一正文只解析一次，多次查询与不同线程复用；授权与来源仍每次核验，
  缓存命中不跳过。
- **先定接口。** 结构来源是带修订绑定的可插拔 provider：输入语言 ID、正文、修订；输出符号轮廓（名字/种类/范围）、命中节点分类、
  带字面量的调用、import；能力标志声明本 provider 能给哪些。第一个实现是 6.4 agent 视图的 `documentSymbol`，第二个是 tree-sitter；
  explore 只认接口。定接口这一步不需要新依赖。

语法包：一个可用的包 = 语法 wasm + Piarium 按用途写的查询（定义、带字面量调用、import；字面量与注释由节点种类直接给出）。语法
wasm 用社区现成构建；查询是 Piarium 自己的工作，可从 Aider / nvim-treesitter 的 Apache 2.0 查询改起并注明来源。**因此每种语言的
成本主要在查询，不在字节。** 包由 Piarium 精选、随应用版本锁定 ABI；语法 wasm 与运行时 ABI 不匹配会直接加载失败，所以第一版不接受
任意第三方语法包——用户看到的只会是"装了没用"。

分发：桌面版随应用**捆绑最常用语言**，首批 TS/TSX/JS/JSON（合计个位数 MB），其余按需下载到数据目录，与"本地 embedding 模型选装
下载"同一套同意提示与下载管理；Web/远程部署由宿主下载，同意方式与其他下载一致。**目标是覆盖大部分常用语言**（Python、Go、Rust、
Java、C/C++、C#、Kotlin/Swift、Ruby/PHP、Shell、HTML/CSS、YAML/TOML、Markdown 等），按用户工作区实际出现的语言排优先级，每种语言
一个包一次交付，覆盖进度记在 status。用户自带包留作后续高级选项，带 ABI 校验与明确提示；wasm 在沙箱内运行，风险是卡死或吃内存而非
越权，与其他解析同样受工作预算与取消约束。

UI：设置里"语言支持"页，按工作区实际检测到的语言列出，每种语言两行状态——语言服务器（已有 LSP 配置）与结构包（已装 / 可装 / 暂无），
用户不用面对一百种语言的清单。**第一刀不做包管理器**：只有一种语言时不存在"选"；语言 ≥ 3 种时再做按需下载与设置页。

顺序（接在 D-090 之后）：
1. D-090 第一组：候选获取与物化修正 + `anchors`。
2. 结构来源接口 + LSP `documentSymbol` 实现，explore 切片消费它。无新依赖。
3. 引入 web-tree-sitter + TS/TSX 包作为第二个 provider，同时接命中分类；此步引入依赖与打包路径。准入：第 2 步接口稳定；在本仓库量过
   一次 agent 视图从冷启动到 `documentSymbol` 可用的时间，作为对照基线——记录"好了多少"，不再决定"要不要做"。
4. 连接边查询；冷仓库符号目录喂进符号图；`imports` 边。
5. 语言 ≥ 3 时做按需下载与设置页；之后按工作区语言分布逐个补包。

不做：把 tree-sitter 当"通用 AST 服务"先建完再找消费者——每个消费者是独立工作，接口只承诺已有实现的能力；不替代语言服务器的导航与
诊断；不在 renderer 引入；第一版不接受任意第三方语法包；不声称解析速度或省时数字，实测记 status。

原因：D-090 把它记为待决是因为当时只看到一个消费者、没有冷启动实测。再核对后消费者不止四个，新增命中分类与 `imports` 边，其中
命中分类、连接边、冷仓库目录三项语言服务器给不了，"让 LSP 常驻"只解决冷启动这一项。用户判断"迟早要引入"并确定捆绑与首刀范围。
把决定提前到现在，是为了让第 2 步的接口从一开始就按两个实现设计，避免 explore 切片写死在 LSP 上再返工。

考虑过的替代：原生绑定——更快但平台/Electron ABI 各编一份；全部按需下载——首次使用要等，且 Piarium 自己的 TS 仓库是验证基线，
捆绑最常用几种更稳；任意第三方语法包——ABI 与查询缺失导致"装了没用"，留作高级选项；先做包管理器 UI——一种语言时无可选，是投机性建设。

影响：agent-harness 2（结构来源行）、6.1 fuse/slice 段、6.2、D-078 收口表；plan 0.7、3.2、新增 3.11；status 新增 3.11 行；D-090 索引行
的 tree-sitter 待决改由本条解决。实施待接：Host 结构来源接口与两个 provider、explore 切片消费、web-tree-sitter 依赖与 TS/TSX 包、
打包路径、后续语言包与设置页。

状态：已决定；实施按上述顺序在 D-090 第一组之后开始。

### D-092 · 2026-09-07 · 3.2（候选广度按文件铺开，不按命中数深度优先截断）

类型：验收复验结论 + 修正方向（D-090 缺陷 1 未达成）

背景：D-090 第一组交付后复验。缺陷 2–8 与 `anchors` 成立并有真断言；缺陷 1 只做了一半。候选获取确实不再用 `params.limit`，但
`search-service` 的 `groupAndSort` 在候选模式下仍按"文件路径序逐个吃满总命中预算、吃完即 break"截断。实测：30 个匹配文件、每文件
12 条命中、预算 200 → 只有 17 个文件进入候选，`dir17/file.ts` 之后的 13 个一条命中都没进，`partial: true` 与 `totalFiles: 30` 如实
上报。这与缺陷 1 原本要消除的"大量通用命中把后面的文件挡住"是同一形状，只是阈值从 `limit` 抬到 200、顺序从 `fileScore` 换成字母序。
后端 `maxResults = 预算 × 3` 也按 rg 遍历序截断，两层截断叠加。

放大它的是每文件命中上限与排序所需信息不匹配：排名只读 `evidence.groups`（每文件每词组一票），**一个文件在一个词组里只需 1 条命中
就能确定其排名**，所以 12 个预算槽位里有 11 个花在不可能改变任何文件排名的命中上，候选广度被压缩约一个数量级。

决定：候选模式下按文件广度优先分配预算——先每个匹配文件取 1 条命中铺开，再在剩余预算内逐轮加深到 `hitsPerFile`；或候选模式只对
文件数设上限，不对总命中数做深度优先截断。每文件上限届时只服务窗口生成，不再决定谁能进排序。`search.content` / grep 路径不变。

不改：诚实上报已经到位（`partial` / `searched.incomplete` / 正文写明未搜完），本条不是不变量违规，是召回目标未达成；不引入新索引、
新模型或新依赖来绕过它。

同批复验发现的小项，一并修：`get_output` 提示在 `formatExploreOutput` 应用字节预算之后拼接，`showHandle` 为真时返回文本超预算约
一行；`explore-service` 用对象展开把 `searchIncomplete` 返回到声明的结果类型之外，且与 `searched.incomplete` 重复；单个空 anchor
字符串以 `invalid-params` 否掉整次调用，而 `buildTermGroups` 本就 trim + 过滤空串（anchors 来自模型，应过滤后在 `details.anchors`
说明）；`explore-service` 的 `searchPartial` 是被所有并行 `rgSearch` 共享的单一可变量，终值因再次 OR 而正确但按词项归因错误；
`fileScore` 移进排序比较器后由每文件一次变为 O(n log n) 次（仅 grep 路径，纯浪费）；候选排序中 `GROUP_WEIGHT` 除以 `RRF_K + rank + 1`
后每组贡献 ≤ 0.13，被整数量级的 `evidence.groups.size + 2 × anchors.size` 主导，权重表实际只在组数相同时当平手裁判——输出顺序仍
anchor 优先（打包阶段 `windowScore` 给 anchor +100），故只影响候选数超读取预算时的物化顺序。

交付形状：`8218af95`–`d910ed14` 四个提交在推送前重排为三个（搜索层 / 协议+引擎 / 工具+文档），原因是协议与其唯一生产者分开提交时
中间提交无法编译（实测 `tsc -p tsconfig.application-host.json` 两个错），且四条提交正文缺 plan 0.1 要求的验证与决策编号、并带了
禁止的 `Co-authored-by` 署名。提交未推送，重排不影响他人；`review-backup-d090` 标签留在原 `d910ed14` 上。

影响：plan 0.7、3.2（候选获取与物化行）；status 3.2 行与"下一步"。实施待接：`groupAndSort` 候选模式广度优先分配 + 上述小项。

状态：已复验并记录；候选广度与小项待实施，排在 3.11 第 1 步之前。

### D-093 · 2026-09-07 · 3.11（小函数 / 大函数切片阈值）

类型：实施拍板

背景：plan 3.11 / D-090 要求小函数全文、大函数签名 + 命中块 + 省略标记 + 完整读取入口，但没有给出「小 / 大」的行数。需要一个具名常量，不能把魔数散在切片里。

决定：`SMALL_STRUCTURE_SPAN_LINES = 24`（含首尾的行数）。依据是一个常见编辑器视口大约能看完的短函数加几行局部变量；超过则按大函数切片。这是工作阈值，不是硬拒绝，也不是测过的产品上限。

不改：不按字符数、AST 深度或「300 字符并入邻居」切；不把阈值做成用户设置；不声称这个数字优化了召回或省时。

影响：`lib/structure/constants.ts`；explore 结构切片；D-091 实施。

状态：已实施。

### D-094 · 2026-09-07 · 3.11（结构切片的协议字段）

类型：实施拍板

背景：`ExploreSearchSnippet` 只有 path/行号/text/why/revision/source。语法单元和结构来源状态若塞进 `why` 或未声明字段，会重复 D-092 修过的漏字段问题；worker—protocol—Host 链也无法在一次 `explore.search` 结果里看见切片契约。

决定：在协议层显式加字段，不另开方法：
- `ExploreSearchSnippet.unit?`：`{ name, kind, startLine, endLine, omitted? }`，行号与 explore 一样是 1-based 闭区间；`omitted` 只出现在大函数。
- `ExploreSearchSnippet.structure?`：`{ provider: "lsp" | "tree-sitter" | null, status }`，status 含 `ready|empty|unavailable|unsupported|stale|failed|cancelled|not-requested`。
- `details.structure.files[]`：按文件记录本次咨询过的 provider/status，让一次工具结果能看见来源，而不只是摘录正文。
LSP 范围是 0-based，转换在 Host 结构模块完成，协议不暴露 0-based。未咨询结构来源时这些字段缺席，避免把「没接线」伪装成「已请求」。

不改：不把结构信息只写在 `why` 或可见文本里；不新增 `explore.symbols` 工具；不在协议里放 AST 节点或 wasm 细节。

影响：`protocol/src/harness.ts`；explore 引擎与 `explore-service`；pi-host 工具 details 原样转发 snippets。

状态：已实施。

### D-095 · 2026-09-07 · 3.11（命中分类只作用在已物化文件）

类型：实施拍板

背景：6.1 fuse 段要求名称 / 路径 / 注释 / 字符串 / 正文不同计分，但候选排序发生在 `readFile` 之前，分类需要正文。把分类前推到读文件之前，就要解析本来不会读的文件；候选预算是 200 个文件，不允许为此解析整个候选池，也不许悄悄放大预算。

决定：分类只作用在已经物化的窗口上——`windowScore` / `packComplementary` / 最终摘录顺序。候选文件排序仍只用词组与锚点权重。已物化窗口上，声明名字 +30、正文 +8、字符串 −4、注释 −10（`STRUCTURE_HIT_CLASS_SCORE`）。未读候选保持 `not-requested`，不解析。

不改：不把分类前推到 `readFile` 之前；不提高 200 文件候选预算或物化读预算来换分类覆盖；不把 hit class 塞进协议 `why`。

影响：`lib/structure/constants.ts`；explore `windowScore`；tree-sitter `classifyHits`。

状态：已实施。

### D-096 · 2026-09-07 · 3.11（语法 wasm 打包与 ASAR 路径）

类型：实施拍板

背景：web-tree-sitter 与 TS/TSX 语法 wasm 必须在 Electron 与 Web 宿主都能读到。另写一套路径解析会和 `extension-builtins` 的 asar / asar.unpacked 重映射分叉。`tree-sitter-wasms@0.1.13` 的预编译文件没有 `dylink.0`，`Language.load` 在 web-tree-sitter 0.27 上失败。

决定：运行时资产放在 `lib/structure/runtime/`，由 `copy-structure-runtime.mjs` 在 Host 编译前刷新，并随 Host 非 TS 资源拷进 `server/`。路径解析复用与 `extension-builtins` 相同的 `ASAR_DIRECTORY_SEGMENT` → `.asar.unpacked` 重映射，不另发明。`web-tree-sitter.wasm` 来自钉住的 `web-tree-sitter@0.27.0`；TS/TSX 语法 wasm 来自钉住的 `tree-sitter-typescript@0.23.2` 发布包（ABI 14，兼容 0.27 的 13–15）。加载失败报 provider `unavailable`。许可与出处按 `LICENSE.typescript` 先例放在同一 runtime 目录。

不改：不把整个 `tree-sitter-wasms` 语言包当运行时依赖；不在 renderer 加载 wasm；不在缓存命中时跳过路径核验；不声称解析速度。

影响：`packages/web` 依赖与 copy/build 脚本；`lib/structure/runtime-path.ts`；D-091 第 3 步。

状态：已实施。

### D-097 · 2026-09-07 · 3.11（结构 provider 顺序：tree-sitter 先于 LSP）

类型：实施拍板

背景：语言服务器冷态时仍要能切出语法单元（与第 2 步 833ms 对照），但 wasm 加载失败时 explore 不能整体挂掉。需要一条固定的 fan-out 顺序，而不是按文件临时挑选。

决定：生产 `structureSource` 先 tree-sitter、后 LSP。`createStructureSource` 对每个文件按这个顺序问 outline；第一个 `ready`/`empty` 获胜，`unavailable`/`failed`/`unsupported` 试下一个。tree-sitter 给出切片时不再等 LSP；两者都不可用时退行 ±3 窗口并标明来源状态。

不改：不删 ±3 降级；不在 wasm 失败时让工具失败；不把连接边 / `imports` 图写进本步（第 4 步）。

影响：`application-host/index.ts`；`lib/structure/source.ts`；explore 切片。

状态：已实施。

### D-098 · 2026-09-07 · 3.11（切片单位是容器，不是最小语法捕获）

类型：问题与解法

背景：验收实测同一 63 行函数只改命中位置：`const needle = 1` 切成 1 行 `variable`，比旧 ±3 窗口更差；`handle(needle)` 才切到外层函数。成因是 `TYPESCRIPT_DEFINITION_QUERY` 把每个 `lexical_declaration` 标成 `@unit`，`enclosingSymbol` 取最小包含范围。同一问题也出现在 interface 成员、`method_signature`、字段、单行 type alias、enum 成员上。

决定：切片只认**容器**（function / method / constructor / class / interface / enum / module / namespace / type / struct / package）。tree-sitter 仍捕获 lexical / var / 字段以便分类，但只有初始化器是函数/箭头/类表达式时才作为单元发出，且 kind 是 `function` / `class`。`enclosingSliceSymbol` 忽略非容器。单行 type alias 仍是容器（它就是整条定义）。D-093 的 24 行阈值不改。

原因：读者必须能判断命中属于哪个函数/类；定义绑定必须继续单独切开，不能整条删掉 lexical 查询。按 kind 过滤比「给小单元并入 ±3」更连贯——后者会把 `const foo = () => {}` 与外层函数糊在一起，或让 1 行 interface 签名看起来像自包含单元。

考虑过的替代：(1) 只在初始化器是函数/类时认 lexical 为单元、切片仍取最小范围——能修 const，但 LSP 仍可能发出 1 行 `method` / `variable`，同一缺陷换来源还会出现。(2) 小单元与外层签名或 ±3 取并——残留「单位就是那个绑定」，status 仍超报，且定义绑定与值绑定要两套下限。(3) 把 `enclosingSymbol` 改成「最小定义型单元」却继续把值绑定当定义——只换名字。

不改：24 行阈值；命中分类分值；JS/JSX 作为目标语言。

影响：`lib/structure/kinds.ts` / `slice.ts` / `tree-sitter-provider.ts` / `queries.ts`；explore 结构切片；agent-harness 6.1 slice、plan 3.2/3.11、status 3.11。

状态：已实施。

### D-099 · 2026-09-07 · 3.11（empty / 覆盖缺口可问后续，但 warmOnly 不冷启动 LSP）

类型：问题与解法

背景：`createStructureSource` 在第一个 `ready` **或 `empty`** 时返回。tree-sitter 对 `var zeta = 1`、`declare function` 等形状会 `empty` 或部分轮廓（namespace 只有内层 `z`）。配合 D-097 的 tree-sitter 优先，阶段 1 的 LSP outline 在这些形状上永不被问，explore 静默退窗口。D-097 把 tree-sitter 放前面正是为了避开 833ms 冷启动；「empty 就问 LSP」会把它请回来。

决定：第一个覆盖全部 `hitLines` 的 `ready` 立即获胜。`empty`、或 `ready` 但有命中落在任何容器外，设置 `priorAnswered` 并以 `warmOnly: true` 问下一个。第一个 provider 的 `unavailable`（缺 wasm）仍允许冷启动。LSP 在 `warmOnly` 下先 `getStatus(workspaceId, languageId, AGENT_LANGUAGE_VIEW)`；不是 `ready`/`degraded` 就返回 `unavailable`，不 `bind`。explore 把证据行传进 `outline`。后续 `ready` **替换**前答，不合并。容器规则（D-098）阻止 LSP 的 1 行 variable 再变成切片单位。顺带扩查询：`variable_declaration`、`function_signature`、`internal_module`/`module`、匿名 `export default class {}`、object-literal `method_definition`；箭头与 `export default function` 实测本来就能出轮廓，之前自评的缺口记错了。

代价：热 LSP 会话上，tree-sitter `empty`/缺口会多一次 `documentSymbols`；冷会话付出的是一次 `getStatus`（不拉起进程）。不阻塞 explore：未就绪就窗口降级。

考虑过的替代：(1) empty 无条件问 LSP——把 833ms 请回每次 explore。(2) 合并两个 outline——需要冲突规则，且会把 LSP 的 1 行成员和 tree-sitter 容器叠在一起。(3) 云端/缺 wasm 才问 LSP——修不了「ready 但有缺口」。

不改：D-097 的生产顺序；不在 renderer 起解析；不把连接边写入本步。

影响：`lib/structure/source.ts` / `types.ts` / `lsp-provider.ts` / `queries.ts`；`explore.ts` 传 `hitLines`。

状态：已实施。

### D-100 · 2026-09-07 · 3.11（云运行时把 web-tree-sitter 当生产能力）

类型：默认值调整

背景：`web-tree-sitter` 在 `packages/web` 的生产依赖里，云镜像构建 `packages/web` 并以其 CLI 为入口，但 `scripts/cloud-runtime.bun.lock` 未锁上它，冒烟 `require` 清单也只有 `better-sqlite3` / `node-pty` / `sherpa-onnx-node`。云部署里 tree-sitter 会是 `unavailable`，只能走 LSP/窗口。

决定：按既有 `--update-lock` 重生成 lock，并把 `require.resolve('web-tree-sitter')` 加入云运行时冒烟。缺依赖必须被构建抓住，而不是运行期才发现 explore 只能降级。

考虑过的替代：明确让云端 explore 走 LSP/窗口、不锁 wasm——省 lock 体积，但云与桌面生产能力分叉，且 D-097 的第一来源在云上永久 `unavailable`。

影响：`scripts/cloud-runtime.bun.lock`；`scripts/build-cloud-runtime.mjs`；`scripts/cloud-runtime-layout.test.js`。

状态：已实施。

### D-101 · 2026-09-07 · 3.11（语法 wasm 以 git 为事实来源）

类型：问题与解法

背景：D-096 记了 wasm 存放位置与 ASAR 重映射，没有记「约 3 MB 二进制 vendor 进 git」这个取舍。`.gitignore` 不排除 `lib/structure/runtime/*.wasm`。`copy-structure-runtime.mjs` 的 `copyIfNeeded` 在目标已存在且 >1024 字节时跳过，所以正常检出下脚本是 no-op，只有 `--force` 才从 npm 包刷新。

决定：接受把 `web-tree-sitter.wasm` 与 TS/TSX grammar wasm 检入仓库。git 是检出后的事实来源；copy 脚本是升级 web-tree-sitter / tree-sitter-typescript 时的刷新工具，不是每次构建的下载步骤。不把「脚本会在缺文件时补上」写成日常路径——新鲜 clone 若缺文件，应视为 git 内容缺失。

原因：wasm 必须在 Electron/Web/云构建里不依赖开发机的 `tree-sitter-typescript` 解析结果；grammar 包是 `devDependency`，生产安装不会带它。检入二进制避免每个环境重跑 copy，并让 ASAR 解包路径稳定。

考虑过的替代：(1) gitignore wasm、构建必跑 copy——云/CI 必须装 `tree-sitter-typescript`，与「语法 wasm 随 Host 走」不一致。(2) 运行期从 npm 解包——多一套失败模式，且 Electron asar 仍要带文件。

不改：D-096 正文（路径与 ABI 选择仍有效）；不声称体积或加载时间。

影响：决策索引中 D-096 的补充说明；`lib/structure/DOCUMENTATION.md`。

状态：已实施。

### D-102 · 2026-09-07 · 3.11（解析预算是跑飞兜底；签名即全体的单元补齐窗口）

类型：问题与解法

背景：D-098 / D-099 验收复跑暴露两件事。其一，`packages/web` 完整套件里 `tree-sitter-provider.test.ts`「outlines TypeScript units from the vendored wasm」与 `explore.test.ts`「keeps a value-binding hit inside its enclosing function」失败，单独跑同样两个文件 44/44 通过；失败时收到的状态是 `failed`，而那条路径上 `failed` 只由 `STRUCTURE_PARSE_BUDGET_MS` 产生——40ms 挂钟在满载 runner 上被调度延迟吃掉。其二，D-098 只按 kind 认容器，而 `documentSymbol` 把接口调用签名报成 `method`，所以最小容器可以是一行：命中该行时切出 19 字节的 `  needle(): string;`，比它替换掉的 ±3 窗口（145 字节 / 7 行）更少，而 status 3.11 已经写下「至少不差于 ±3」。

决定：(1) 预算定位为跑飞文件的兜底闸，不是延迟目标，默认值上调到 250ms 并在常量注释里写明理由；断言真实解析或断言预算耗尽的测试都自带预算，不继承生产值。(2) 单元的签名范围覆盖整个单元范围时，视为没有自己函数体的片段，按每个命中的 ±3 窗口取并补齐；有函数体的单元仍精确输出。

原因：挂钟预算与 CPU 争抢共享同一个时钟，贴着普通文件解析时间设值会让能力变成负载相关，且降级是静默的（`failed` → 窗口，不是错答案），最难发现。判据用「签名是否即全体」而不是跨度或 kind 表：它对 provider 无关，能同时接住 LSP 的一行 `method`、ambient 声明和单行定义，又不会把自包含的小定义（嵌套 3 行箭头函数）撑宽成外层噪声。

考虑过的替代：(1) 对所有小单元与 ±3 窗口取并——会把 `const foo = () => {}` 这类完整定义也拉进外层签名和右括号，抹掉结构切片相对窗口的全部收益，并推翻已验收的嵌套单元断言。(2) 跨度阈值（容器 ≤ N 行就跳过）——会跳过大函数里真正有用的小嵌套函数。(3) 只扩容器 kind 黑名单——要逐 provider 追 kind 表，且 `method` 既是真方法也是接口签名，无法只靠 kind 区分。(4) 把预算改成按字节相对计算——仍要挑系数，本刀不需要。

不改：`SMALL_STRUCTURE_SPAN_LINES`（24，D-093）；`STRUCTURE_HIT_CLASS_SCORE`（D-095）；容器 kind 集合（D-098）；provider 顺序与 `warmOnly` 契约（D-097 / D-099）。不声称解析耗时或省时比例。

影响：`lib/structure/constants.ts`；`lib/structure/slice.ts`；`lib/structure/slice.test.ts`；`lib/structure/tree-sitter-provider.test.ts`；`lib/harness/explore.test.ts`；`lib/structure/DOCUMENTATION.md`；status 3.11。

状态：已实施。

### D-103 · 2026-09-07 · 测试套件里的挂钟阈值与未捕获 EPIPE

类型：问题与解法

背景：D-102 的并发压测（`packages/web` 完整套件与 `packages/pi-host` 整套同时跑）暴露三处与结构来源无关的既有项，都不是断言逻辑错，而是挂钟阈值贴得太紧或子进程收尾未捕获。

1. `packages/web/application-host/lib/harness/thread-runtime.test.ts`「marks an event-silent Run as stalled and clears it on the next observed event」用 `stalledAfterMs: () => 20`。20ms 阈值在并发负载下失败，单独跑该文件 22/22 通过。由 `036b43e3`（2026-09-04，`feat(harness): run durable child threads`）引入。
2. `packages/web/application-host/lib/run/supervisor.test.ts`「discovers and runs Node tests, and isolates a crashed test provider」在满载时抛未捕获的 `write EPIPE`（`errno -4047`）。**后果是完整 `packages/web` 套件退出码间歇为 1，而 196 个文件、1653 项断言全过**——CI 会红，但红的原因不是任何测试失败。单独跑该文件 3 遍 8/8 且退出码 0。
3. `packages/pi-host/test/harness/harness-e2e.test.ts:198`「background command + get_output retrieves output」。status 3.2 已记「待单独立项」；在 D-092 之前的 `53350ec2` 上同样失败、之后又自行通过，是既有时序抖动。

决定：本条只立项与固定证据，不在 3.11 里修。方向：(1) 与 (3) 把挂钟阈值换成可注入的时钟或事件驱动等待，而不是调大数值——调大只是把抖动推远。(2) 属于崩溃隔离用例向已死子进程写 stdin，应在该测试内捕获 `EPIPE` 或在写入前检查管道存活，使套件退出码只反映断言结果。三项都不改产品行为，只改测试与其时钟来源。

原因：挂钟阈值与 CPU 争抢共享同一个时钟，这类失败会随机器和并发度漂移，长期会训练维护者忽略红色。(2) 尤其有害，因为它让「退出码」与「有测试失败」解耦——按 plan 0.1 的验证纪律，套件的退出码必须能作为判据。

考虑过的替代：(1) 只把 20ms 调大到几百毫秒——延长了单测时间又没有消除负载相关性。(2) 在 CI 上串行跑 `packages/web` 与 `packages/pi-host`——掩盖问题且拖慢反馈。(3) 把 EPIPE 加进 vitest 的 `dangerouslyIgnoreUnhandledErrors`——会一并吞掉真实的未捕获错误。

不改：`STRUCTURE_PARSE_BUDGET_MS`（D-102 已标定）；三处涉及的产品代码；不把这三项算进 3.11 的验收范围。

影响：`lib/harness/thread-runtime.test.ts`；`lib/run/supervisor.test.ts`；`packages/pi-host/test/harness/harness-e2e.test.ts`；status 3.2 已有的「待单独立项」记述。

状态：待实施（不阻塞 3.11 第 4–5 步；建议在下一次触及这三个模块时一并收）。

### D-104 · 2026-09-07 · 3.11 第 4 步（冷目录只覆盖 TS/TSX）

类型：问题与解法

背景：冷仓库符号目录要把从未改动过的文件写进 6.2 图。tree-sitter 今天只接 `typescript` / `typescriptreact`。若把「扫全仓」写成仓库级覆盖，status 会撒谎。

决定：冷扫描枚举仍走 `searchFilesystemFiles`，但只对 TS/TSX `observe`。非 TS/TSX **跳过**，不 `touchFile`。事件驱动路径保持今天的行为：未知语言 `touchFile`；有 `structureSource` 时 defines/imports/连接边走门面（tree-sitter 先，LSP outline 可作 defines 后备）。

原因：`touchFile` 只声明「见过这个路径」，冷扫描对 Markdown/JS 写这种节点会让消费者以为目录覆盖了那些语言。跳过把「没有符号」和「这种语言还没有采集器」分开。

考虑过的替代：(1) 对非 TS `touchFile`——扩大图却没有符号或边，status 更容易被读成全仓目录。(2) 等第 5 步语言包再做冷扫描——未改动的 TS 文件会继续缺席，第 4 步交不出目录。

不改：JS/JSON 语法包、设置页、按需下载（第 5 步）；仓库级词法索引；LSP 全仓扫描。

影响：`symbol-runtime.ts` `CATALOG_SCAN_LANGUAGES`；`catalog-scan.test.ts`；status 3.11 必须写 TS/TSX only。

状态：已实施。

### D-105 · 2026-09-07 · 3.11 第 4 步（加法边与 generation 同寿）

类型：问题与解法

背景：`replaceFileSymbols` 每次换新 generation UUID，并删掉该路径旧 symbol 节点。store 没有 schema version 或 migration runner。新增边若不属于同一事务，重收集会留下悬挂边。`touchFile` 在 unavailable 时「刷新文件事实」，但会抹掉 `documentRevision`，使已提交范围失去身份。

决定：新增节点类型 `link` 与边标签 `imports` / `connects` / `associates`，加法写入，不跑 migration。link 与 symbol 共用该次 `generation`；`replaceFileSymbols` 在同一事务里 `unlinkLabel` 旧出边并删除旧 symbol **和** link。不把 import specifier 解析成文件（没有 tsconfig）。`touchFile` 保留已有 `generation` / `documentRevision`。查询面是 `getFileRelations` / `findLinks`，`danglingEdges` 数目标 payload 已消失的出边。

原因：确认连接与关联候选必须是不同节点/边，不能靠消费者记一个布尔。specifier 字符串是今天能诚实写下的事实。

考虑过的替代：(1) 边直接连 file→file 或 symbol→symbol——没有解析器会写成猜的。(2) 加 schema version + runner——本刀没有不兼容旧库的必要，旧库只是没有 link。(3) 接线未实现的 `related-tool.ts`——store 原先没有邻居 API，草稿会把候选当事实。

不改：`references`、PageRank、跨文件解析后的 `calls`。

影响：`lib/knowledge/store.ts`；collector / symbol-runtime；store 与 smoke 测试。

状态：已实施。

### D-106 · 2026-09-07 · 3.11 第 4 步（门面长出 literalCalls/imports）

类型：问题与解法

背景：`literalCalls` / `imports` 已在 `StructureProvider` 上，tree-sitter 已实现，LSP 报 `unsupported`，但 `StructureSource` 只暴露 outline/classifyHits。分类器必须把确认连接与关联候选分开。

决定：门面按 outline 同样的 fan-out：`cancelled` 立即返回，首个 `ready` 获胜，`empty` 之后 `warmOnly`，先前 `unavailable` 允许后者冷启。没有任何 provider 声明该能力时门面是 `unsupported`，不是 `failed`。确认 callee 允许名单：`request` / `register` / `on` / `once` / `emit` / `subscribe` / `addEventListener`。`require`/`import` 归 imports 查询，不重复写成调用边。其余带字面量的调用是 `associates`。

原因：LSP `unsupported` 是正当能力声明。空成功与缺能力不能合成同一个结果。

考虑过的替代：只让 collector 直接打 tree-sitter——绕过 fan-out 与 `warmOnly`，和 D-097/D-099 分叉。

不改：LSP 补 literalCalls/imports 实现。

影响：`structure/source.ts` / `connections.ts`；symbol-runtime 写边。

状态：已实施。

### D-107 · 2026-09-07 · 3.11 第 4 步（冷扫描不挡启动与首 turn）

类型：问题与解法

背景：全仓扫描若 await 在 `openWorkspaceKnowledge` / 首个 harness turn 上，会把目录建成启动门。

决定：store 打开之后 `queueMicrotask` 火忘 `scanWorkspace`。扫描可取消、按 8 个文件一批 `drain` 后让出事件循环、按磁盘修订幂等跳过。不设硬文件上限（以免静默少扫）；取消或中途停下的文件等下次打开再补。正文/修订/二进制/体积上限走 `documents.read`（内部已是 `inspectDocumentBytes` + `maxReadBytes`）。

原因：目录是增强，不是打开工作区的前置。修订相同则跳过，重入不会把同一磁盘事实再写一遍。

考虑过的替代：(1) 等首个 explore 再扫——从未被 explore 的仓库会一直空。(2) 启动时 await 扫完——违反「不阻塞启动或第一个 turn」。

不改：启动墙钟对照；把扫描进度做成 UI。

影响：`application-host/index.ts`；`symbol-runtime.scanWorkspace`。

状态：已实施。

### D-108 · 2026-09-07 · 3.11 第 4 步（explore 做唯一生产消费者）

类型：问题与解法

背景：符号图此前没有生产读者。`related-tool.ts` 未 import，store 原先没有邻居 API。只写边没有读者是货架代码（plan 0.1）。

决定：选 explore，不选 related 工具，也不改 compaction。`explore.search` 在物化并选出摘录之后，按摘录路径读 `getFileRelations`，写入 `details.relations` 与可见/stored 正文（计入 24 KiB 字节预算）。`connections` 与 `associations` 分列；不把关联文件加入 rg 候选池，不改变 D-090/D-092/D-098/D-102 的字节/候选预算。无 `fileRelations` 依赖时输出字节与现在一致。

原因：explore 已是「这段代码和什么有关」的模型入口；related 草稿会把未实现的 PageRank/邻居假装接上。扩候选池会回归已经收口的预算。

考虑过的替代：(1) 接线 `related-tool.ts`——要先发明邻居 API 和工具面，本刀范围外。(2) 仓库地图进 compaction——没有现成字节预算与验收例子。(3) 按字面量反查把连接文件扩进候选——改变物化集合。

不改：pi-host explore 参数 schema；`related` 工具。

影响：protocol `ExploreSearchResult.details.relations`；`explore.ts` 打包；`explore-service.ts`；`index.ts` `fileRelations`。

状态：已实施。

### D-109 · 2026-09-07 · 关联候选必须真是「同名」，不是「任何带字符串首参的调用」

类型：问题与解法

背景：plan 3.11 第 4 步写的是「无法确认的**同名**字符串标关联候选」——条件是这个字面量和某个已知连接标识同名。首版 `classifyLiteralCall` 只看 callee 名字，凡不在允许名单里就归 `associates`，完全没有同名条件。

在 `application-host/lib` 全部 499 个 TS 文件上实测（真实 wasm 解析）：`connects` 360 条，`associates` **10,711** 条，噪声比约 30:1。前十二位 callee 是 `it` 1518、`join` 1272、`toBe` 827、`toContain` 323、`get` 307、`describe` 296、`writeFile` 292、`post` 274、`startsWith` 210、`includes` 207、`error` 194、`setHeader` 159——测试脚手架、路径拼接、字符串判定、日志，按任何定义都不是连接候选。单这一个目录就是 13,220 个 link 节点，仓库 2,245 个 TS/TSX 文件等比约 5.9 万。每个 link 节点都进 `db.indexText` + `db.indexKeyword`，而 `searchSymbols` 与 `recall` 都是全节点 `scanNodes`，所以这批节点会被永久扫过一遍再丢掉。explore 还会把它们打进可见正文。

决定：`associates` 只在该字面量**已经是某处的确认连接值**时写入。store 增 `connectionLiterals(values)`，用一份按路径引用计数的 connects 值索引回答（open 时从 payload 建，写入/删除时同步维护），不做全表扫描。闸门同时看本批：同一文件里 `register("x")` 与 `log("x")` 是最清楚的同名情形，而 store 还没看到这一代。闸门只看已采集到的连接，所以冷扫描里排在注册文件之前的文件会先丢掉候选——记下这些路径，扫描主循环结束后再补一遍（解析按内容哈希缓存，这一遍便宜，且不递归）。

同一测量在闸门后：`associates` 10,711 → **153**，link 节点 13,220 → 2,662。留下的 153 条都是真正的同名情形。

原因：候选的价值在于「这个标识别处也出现了，但这次的调用形状不能确认」。没有同名条件时它退化成"任何字符串首参调用"，既不是候选也不是信息，只是把预算和索引填满。

考虑过的替代：(1) 扩大 callee 拒绝名单（`it`/`describe`/`toBe`/`join`…）——黑名单永远追不上真实代码，且仍然存不该存的东西。(2) 全部字面量都存、读时再过滤——存储与索引成本照付。(3) 读时用 `findLinks` 反查——需要先存下全部字面量，回到 (2)。(4) 整类去掉只留 `connects`/`imports`——比现状好，但放弃了 plan 明确要的那一类。

不改：`connects` 允许名单（D-106）；`findLinks` 语义；import 边。

影响：`lib/knowledge/store.ts`（`connectionLiterals` 与 connects 值索引）；`lib/knowledge/symbol-runtime.ts`（闸门与补扫一遍）；`symbol-runtime.test.ts`；`store.ts` 顶部节点/边说明。

状态：已实施。

### D-110 · 2026-09-07 · 结构轮廓写进图时的范围转换

类型：问题与解法

背景：`StructureSymbol.range` 是**只有行**的 1-based 闭区间，图里的 `SymbolGraphRange` 是 0-based 字符范围。首版把字符位一律填 0 并把 `endLine` 减一，于是多行符号的范围止于末行第 0 列（排除整个末行），单行符号退化成零宽：`{startLine:0,startCharacter:0,endLine:0,endCharacter:0}`。此前 LSP 路径给的是 `selectionRange`，即名字的真实跨度。

决定：末列取该行**真实长度**（`loadGraphFacts` 手里就有正文，按 `\n` 切分并去掉 `\r` 后取长度），`endLine` 用 `max(startLine, endLine-1)`。范围含义随之从「名字跨度」变为「符号整体跨度」，这是 tree-sitter 轮廓能诚实给出的粒度。

原因：零宽范围通不过任何「这个范围还成立吗」的判断，而 §7.2 要求消费者据修订与范围判断事实是否仍然成立。

考虑过的替代：(1) `endCharacter` 填一个大哨兵值——范围不再对应真实文本。(2) 把 `SymbolGraphRange` 改成只有行——LSP 路径（仍在用，见 D-111）会丢掉已有的列精度。

不改：`SymbolGraphRange` 类型；`validRange`；LSP 路径的 `selectionRange` 语义。

影响：`lib/knowledge/symbol-runtime.ts` `flattenOutlineSymbols`。

状态：已实施。

### D-111 · 2026-09-07 · 边查询被阻塞不得冻结可用的轮廓

类型：问题与解法

背景：首版 `loadGraphFacts` 里 `if (blocked(importsResult.status) || blocked(callsResult.status)) return null;` 与 outline 状态无关。tree-sitter 的能力按语言静态声明，wasm 加载失败后 `imports` 报 `unavailable`，而 LSP 没有 `imports` 能力会被门面跳过，于是门面结果就是 `unavailable`，整个文件走 `touchFile` 保留分支。

实测：outline 仍 `ready`、文件已改名，store 只收到 `touchFile`。也就是说 **wasm 一坏，全部 TS/TSX 文件的符号更新永久冻结**，而 D-104 明说「LSP outline 可作 defines 后备」，D-097 明说 wasm 失败应降级。配合 D-105 让 `touchFile` 保留 `documentRevision`，图会一直上报一个早已不成立的修订。既有测试 `preserves the graph when extraction is unavailable` 只断言图还活着，没断言新鲜度，把这个行为锁成了预期。

决定：由 **outline 单独决定这一代能不能写**——`ready`/`empty` 可写（空集只有在真有 provider 应答时才是权威的），`unsupported` 回落到 LSP `documentSymbol`，其余保留旧图。边查询被阻塞时不再抑制 outline，而是照写 defines、带上已就绪的那部分边，并在文件节点上记 `linksIncomplete`，经 `getFileRelations().linksIncomplete` 透出，explore 显示「edge extraction was incomplete for this revision」。

原因：「没有边」和「边没采集到」必须分开（plan 0.4）。冻结符号是把一个可修复的降级变成静默错误，而且没有任何通道报告。

考虑过的替代：(1) 边被阻塞时保留旧边、只更新符号——`replaceFileSymbols` 是按文件整体事务，做不到部分保留，硬做要引入第二种写路径。(2) 继续全否定但把冻结报出来——图仍然停在旧修订，只是多一行日志。

不改：`replaceFileSymbols` 的事务形状；`touchFile` 保留语义（D-105）。

影响：`lib/knowledge/symbol-runtime.ts`；`lib/knowledge/symbols.ts` `CollectedSymbols.linksIncomplete`；`lib/knowledge/store.ts`（`linksIncomplete` payload 与 `SymbolGraphFileRelations`）；`symbol-runtime.test.ts`。

状态：已实施。

### D-112 · 2026-09-07 · 关系是注解：不许拖垮检索，不许冒充当前

类型：问题与解法

背景：首版把 `fileRelations` 接在 `explore.search` 的成功路径上且无保护。实测一个必然抛错的知识库：检索本身完全成功、摘录已物化，结果整体返回 `{"ok":false,"error":{"code":"failed","message":"knowledge store is corrupt"}}`，内部错误原文还漏给了 agent。这次提交之前 explore 对知识库零依赖。而且 `getKnowledgeStoreForWorkspace` 会按需开库并触发全仓扫描，等于把开库和扫描搬到了读路径上。

另一半：图装的是磁盘已提交事实，摘录可能来自固定草稿或更新的磁盘修订。首版既不比较修订也不打标记。实测摘录在 `disk-r9`、关系在 `disk-r2` 时，可见正文照样印 `- src/router.ts connects register("gone.handler") (L3)`——L3 指向 agent 没在看的那个修订。§7.2 就在这次改动的下一段写着「消费者据修订判断范围是否仍然成立……而不是拿一份无身份的范围继续用」。

决定：三件事。(1) 查询失败或库未打开时降级注解、不失败检索：`details.relations` 增 `status`（`ready` / `partial` / `unavailable`），`unavailable` 与"没有任何出边"（`relations` 缺席）是不同结果，可见正文写一行说明，不透内部错误原文。读路径只用**已打开**的 store，不开库也不触发扫描——会话自身的知识工作负责打开。(2) 关系与摘录修订比较，不同则 `stale: true`，可见正文标 `[stale @<修订>]` 并**去掉行号**——移位的行号比没有行号更坏，边本身仍是证据。(3) 关系排在可见预算的**最后**，在 `Omitted supports`、未读候选与 issue 行之后，每文件上限 12 条并报省略数——注解不得挤掉「这个结果不包含什么」的通道。

原因：装饰性注解的失败必须只降级注解（plan 0.4）。检索成功却整体失败，是把一个增强变成了新的失败源。

考虑过的替代：(1) 只 try/catch 静默吞掉——把「查不到」和「没有边」压成同一个空成功。(2) 过期就整条丢掉——丢掉了"这两个文件之间有连接"这个仍然成立的事实。(3) 保持关系在预算靠前——D-090/D-092 刚把预算收口，注解不该优先于 issue。

不改：候选池（D-108 不扩候选仍然成立）；24 KiB 预算；`ExploreSearchSnippet`。

影响：protocol `ExploreRelationStatus` / `ExploreFileRelation.stale` / `.incomplete` / `details.relations.status`；`lib/harness/explore-service.ts`；`lib/harness/explore.ts` 打包顺序与 `relationLines`；`lib/harness/service-host.ts` `fileRelations` 返回类型（不含 `stale`）；`application-host/index.ts`；`explore.test.ts` / `explore-service.test.ts`。

状态：已实施。

### D-113 · 2026-09-07 · 切片查询与目录查询是两件事

类型：问题与解法

背景：第 4 步把图的符号来源从 LSP `documentSymbols` 换成了 `structureSource.outline`。TS/TSX 下 tree-sitter 必胜，LSP 永远不会被问，而那份定义查询是按 D-098「切片单位是容器」调的：provider 用 `isSliceUnit` 过滤，普通值绑定根本不进 outline。实测 `export const DEFAULT_BYTE_BUDGET = 24576;` 与 `export const TABLE = { a: 1 };` 从轮廓里整体消失，只剩 `type:Alias` / `function:realFn` / `function:arrow`。于是 `searchSymbols("DEFAULT_BYTE_BUDGET")` 再也找不到——目录的覆盖面被一份为切片调的查询悄悄收窄了。

决定：outline 的收录条件与切片的单位条件分开。outline 收 `isSliceUnit(node) || isModuleLevelBinding(node)`，即容器、定义绑定，再加**模块级与类级**的值绑定（`kind` 为 `variable`）；函数体内的局部绑定仍不收——那不是 `searchSymbols` 要回答的东西，LSP 的 `documentSymbol` 也不给。切片侧无需改动：`enclosingSliceSymbol` 早已按 `isStructureContainerKind` 过滤，`variable` 不是容器种类，所以 D-098 与 `outlineCoversHitLines` 的行为不变。

原因：「哪些跨度值得当作一段代码切出来」和「哪些名字值得被检索到」是不同的判据，复用同一个过滤器会让后者被前者的取舍绑架。

考虑过的替代：(1) 目录改回 LSP `documentSymbols`——事件驱动路径可以，但会让同一张图的符号语义按发现途径分叉，而 plan 3.11 又禁止基于 LSP 的全仓扫描。(2) 在 store 侧补一层——图不该猜 provider 漏了什么。(3) 连局部绑定一起收——`explore.ts` 这类文件会多出大量局部名，`searchSymbols` 的信噪比反而更差。

不改：`TYPESCRIPT_DEFINITION_QUERY`（`lexical_declaration` / `variable_declaration` 早已捕获，被 provider 过滤掉的）；`isSliceUnit`；`isStructureContainerKind`；D-098 的切片行为。

影响：`lib/structure/tree-sitter-provider.ts`（`isModuleLevelBinding` / `isOutlineUnit`）；`tree-sitter-provider.test.ts`。

状态：已实施。

### D-114 · 2026-09-07 · 3.11 第 5 步（JSON 进切片、不进目录）

类型：问题与解法

背景：plan 要 JS/JSON 语法包。JSON 键名不是 `searchSymbols` 要回答的东西，全量入图会淹没符号表。但大 JSON 命中若退回 ±3 行窗口，agent 看不到所在对象。D-113 已经把目录查询和切片查询拆开。

决定：JSON **只服务切片**。轮廓收顶层 `pair`、值为 `object`/`array` 的 `pair`（`kind: property`），并额外收 object/array 节点作切片容器；深度上限 **8**、符号上限 **256**，文档根 object/array 始终保留，所以触顶时仍切到根容器而不是裸 ±3。`isJsonStructureContainerKind` 接受 `property`/`object`/`array`，**不**并进 `isStructureContainerKind`（否则会放宽 D-098 对 TS/JS 的 `property`）。JSON 的 `literalCalls`/`imports` 报 `unsupported`。JSON **不进**冷目录扫描。

原因：切片要的是「命中落在哪一段」，目录要的是「这个名字指什么」。JSON 只有前者。

考虑过的替代：(1) JSON 也进目录——`name`/`version`/`scripts` 会淹没 `searchSymbols`。(2) 只出 pair、不出 object/array——顶层数组里的对象命中没有容器。(3) 把 `property` 加进 D-098 容器集合——TS/JS 的 property 成员会变成切片单位。

不改：D-098 的 TS/JS 容器集合；候选池。

影响：`json-outline.ts`；`kinds.ts` `isJsonStructureContainerKind`；`slice.ts` / `source.ts` 按语言选容器谓词；冷扫描跳过 json。

状态：已实施。

### D-115 · 2026-09-07 · 3.11 第 5 步（D-104 被取代：冷目录含 JS）

类型：偏离

背景：D-104 把冷目录收成 TS/TSX，因为当时只有这两份语法。本刀加上 JS/JSX 语法后，再跳过 `.js`/`.jsx` 是把已有能力藏起来。

决定：冷目录语言改为规格表里**带 `importQuery` 的语言**（今日：`typescript` / `typescriptreact` / `javascript` / `javascriptreact`）。JSON 没有 import 查询，继续不进目录（D-114）。D-104 正文不改；本条取代它的覆盖范围。事件驱动路径对未知语言仍 `touchFile`。

原因：目录该覆盖 tree-sitter 已经能诚实抽出 defines/imports/连接边的语言，而不是永远停在第 4 步的 TS/TSX 快照。

考虑过的替代：(1) 继续只扫 TS/TSX——JS 仓库的图是空的。(2) 一切有 outline 的语言都扫——JSON 会进目录，与 D-114 冲突。

不改：D-104 原文；非目录语言的 `touchFile`；扫描不挡启动（D-107）。

影响：`CATALOG_SCAN_LANGUAGES` 改由规格表推导；`catalog-scan.test.ts`。

状态：已实施。

### D-120 · 2026-09-07 · 3.11 第 5 步（语言分布现算、上限与缓存）

类型：默认值调整

背景：设置页需要按工作区列出语言，但仓库里没有语言分布索引。开机时扫全仓会挡启动。

决定：`LanguageSupportAPI.getStatus` 被调用时用冷扫描那条 `searchFilesystemFiles` + `languageIdForPath` 现算。文件上限 **8000**，多出来的那一份只用来置 `partial: true`。按工作区缓存 **30 秒**。不落盘，不进启动路径。无 `languageId` 的文件计入扫描数但不占语言行。

原因：设置页是用户主动打开的；几百毫秒可以接受，开机不行。上限避免一次枚举把 Host 拖死。

考虑过的替代：(1) 持久化分布——又一份会过期的索引。(2) 复用冷目录扫描的文件名单——那份只含目录语言，JSON/Python 会消失。

不改：冷目录扫描本身；启动路径。

影响：`lib/language-support/runtime.ts`；`/api/language-support/status`。

状态：已实施。

### D-121 · 2026-09-07 · 3.11 第 5 步（wanted 是内存需求信号）

类型：问题与解法

背景：plan 的「按需」容易被做成 Host 自己下载。本机没有 embedding 下载管道可抄，而且结构请求今天对缺包语言已经返回 `unsupported`。

决定：结构请求在规格表没有、但清单标明可装的语言上，把 languageId 记进**按工作区的内存** wanted 集合，**仍然返回 `unsupported`**。`getStatus` 把 wanted 行排最前。没有工作区 id 的请求不记。Host 不因此发起网络。

原因：「按需」是需求信号，不是自动下载。同意模型是下一刀的明确安装动作。

考虑过的替代：(1) 全局 wanted——A 工作区的 Python 请求会污染 B 的设置页。(2) 请求时自动下载——Host 自发网络。

不改：`unsupported` 语义；D-099 fan-out。

影响：tree-sitter `onLanguageRequest`；`LanguageSupportRuntime.noteRequest`。

状态：已实施。

### D-122 · 2026-09-07 · 3.11 第 5 步（语言支持设置页）

类型：默认值调整

背景：plan 要求设置「语言支持」页按工作区列语言，每种两行状态。`piarium:*` 渲染器会被转成 `PiariumSettingsPage` 分节，本页需要自己的组件。

决定：普通 `language-support` 渲染器，`group: 'pi'`，`order: 38`（紧挨 runtime 39）。页面只读 `LanguageSupportAPI` 与已有的 `LanguageServicesAPI.getStatus`。用户自带 wasm 的导入按钮留到下载管道落地；本页先提供状态与「安装」动作。

原因：设置页不能碰文件系统、网络或 tree-sitter。LSP 状态已有 owner，不另造一份。

考虑过的替代：(1) `piarium:language-support` 分节——会被应用设置壳吞掉。(2) 本页自己扫工作区——越权。

不改：LanguageServicesAPI；Host 下载管道。

影响：`builtin-page-metadata.ts`；`LanguageSupportPage`。

状态：已实施。

### D-123 · 2026-09-07 · 3.11 第 5 步（用户自带 wasm：未验证，不覆盖捆绑）

类型：问题与解法

背景：D-122 把导入按钮留到下载管道。用户自带包是高级选项，不是默认信任。

决定：设置页「导入 .wasm」走桌面选文件 + `importUserGrammar`。同一内容寻址目录，`source: 'user'`，不算清单摘要，ABI 仍在 `Language.load` 窗口里闸。UI 标 `user-unverified`。捆绑语言拒绝导入，避免下载目录永远到不了 TS/JS/JSON。

原因：明确动作即同意；未验证必须看得见。

不改：捆绑优先（D-126）；清单摘要只约束 npm 包。

影响：`grammar-installer.ts`；`LanguageSupportPage`。

状态：已实施。

### D-124 · 2026-09-07 · 3.11 第 5 步（明确动作即同意；Host 不自发网络）

类型：问题与解法

背景：plan 3.11 第 5 步原文写「与本地 embedding 模型同一套同意提示与下载管理」。那套东西不存在：`openWorkspaceKnowledge` 一律 `embedding: null`，听写 `ensureLocalSttModel` 无摘要、无取消、无同意门，缺模型就后台自动下。

决定：不做同意弹窗，不做 `ask`/`always`/`never`。用户点「安装」或「导入」就是同意。Host **从不自己发起**语法包网络请求。wanted 只是需求信号。

原因：抄听写等于给 ABI+摘要双重校验套上两样都没有的管道。

考虑过的替代：(1) 抄听写自动下载。(2) 新做同意设置项——无既有消费者。

不改：听写下载；embedding 仍为 null。

影响：plan 3.11 第 5 步原文；`grammar-installer.ts`。

状态：已实施。

### D-125 · 2026-09-07 · 3.11 第 5 步（清单摘要在发布期生成）

类型：implementation

背景：运行期不能从网络取信。npm tarball 的 integrity 是整包的，不是 wasm 字节的。

决定：`scripts/refresh-grammar-manifest.mjs` 从 npm 拉 tarball、解出 wasm、用 web-tree-sitter 读 ABI、**我们自己算 sha256**，写入提交进 git 的 `grammar-packs.json`。运行期只把下载字节与这份清单比。

原因：与 D-101「checked-in wasm 是权威」同一精神。

不改：`scripts/cloud-runtime.bun.lock`。

影响：`grammar-packs.json`；`createGrammarInstaller`。

状态：已实施。

### D-126 · 2026-09-07 · 3.11 第 5 步（捆绑目录优先于下载目录）

类型：implementation

背景：下载目录若优先，被污染的 `tree-sitter-typescript.wasm` 能遮蔽内置语法。

决定：`resolveStructureRuntimeFile` 先查捆绑 `runtime/`（含 asar 重映射），只有捆绑文件不存在才问 `resolveInstalled`。默认不注入第二级，现有测试无需数据目录。

原因：内置 TS/JS/JSON 必须不可被数据目录覆盖。

不改：asar 重映射；`pathExists` 注入。

影响：`runtime-path.ts`；`createTreeSitterStructureProvider({ resolveInstalled })`。

状态：已实施。

### D-127 · 2026-09-07 · 3.11 第 5 步（按需语言名单与落选原因）

类型：实验结果

背景：plan 覆盖目标是 python、go、rust、java、c、cpp、c-sharp、kotlin、swift、ruby、php、bash、css、html、yaml、toml、markdown、xml。协议 id 是 `csharp` / `shellscript`，不是 `c-sharp` / `bash`。

决定：清单收入 15 种：python、go、rust、java、c、cpp、csharp、kotlin、ruby、php、shellscript、css、html、yaml、toml。落选：swift（`tree-sitter-swift@0.7.1` 无 wasm）、markdown（两个候选包都无 wasm）、xml（两个候选包都无 wasm）。`languageIdForPath` 补 `.cs/.kt/.kts/.swift/.rb/.php/.toml/.cc/.cxx/.hh`，否则分布永远看不到这些语言。下载不做断点续传；C#/C++/Kotlin wasm 超过 1 MB，整包下完再校验。

原因：脚本对每个候选如实判定，没有的记下原因略过。

不改：捆绑的 TS/TSX/JS/JSX/JSON；冷目录仍只含带 `importQuery` 的语言（D-115）。按需语言装上 wasm 但还没有查询规格时，结构仍报 `unsupported`，能力旗标全关。

影响：`grammar-packs.json`；`language-id.ts`。

状态：已实施。

### D-128 · 2026-09-07 · 装下来的语法必须真的出轮廓，否则不许说"已安装"

类型：active-design

背景：D-127 交付时，15 种按需语言只有 wasm，没有 `definitionQuery` / `commentTypes` / `stringTypes`。装完之后 `grammarStatus` 是 `installed`、设置页显示绿色成功，但 `capabilities` 四项全关、`outline` 继续 `unsupported`。用户按了按钮、下了 5 MB、看到"已安装"，检索行为一点没变。这是假可用性，比不提供这个功能更坏。

决定：两件事同时做。

一是接上游 `queries/tags.scm`。tree-sitter 生态里几乎每个语法包都带这个文件，捕获名是跨语言约定：`@definition.function` / `@definition.class` / `@definition.method` / `@definition.interface` / `@definition.module` 等，配套 `@name`。`treeSitterTagsSpec(grammarFile, tagsQuery)` 把这份查询变成一份运行期语言规格：`tagsDefinitionKind` 把 `definition.*` 后缀映射到 `StructureSymbol.kind`，认识的映到对应种类，不认识的映到 `unknown`（进目录，不进切片）；`reference.*` 与裸 `@name` 不产生符号。命中分类退化为按节点类型名判断——`stringTypes` 用 `/string|char/`、`commentTypes` 用 `/comment/` 匹配节点类型，这是 tree-sitter 命名惯例，不是逐语言表。`literalCalls` / `imports` 仍然关闭：那两项需要按语言写的查询，tags 里没有。

二是把这件事变成发布期可验证的。`refresh-grammar-manifest.mjs` 从 tarball 里连 `queries/tags.scm` 一起取出来，**用该包自己的 wasm 编译一遍**，编得过才把 `tagsPath` / `tagsIntegrity` 写进清单；编不过只记 `tagsNote`，清单里 `tagsPath` 为 `null`。安装时 `tags.scm` 和 wasm 一样按摘要校验，摘要不符整个安装失败。清单解析阶段还会丢掉摘要格式不对的 tags 字段——宁可没有轮廓，不要一份没验证过的查询。

结果：15 种里 9 种（python、go、rust、java、c、cpp、csharp、php、ruby）拿到编译通过的 tags 查询，装上就有 `outline` + `classifyHits`。6 种（kotlin、shellscript、css、html、yaml、toml）上游包没带 `queries/tags.scm`，装上只有解析器。

原因：能力旗标是协议事实，不是宣传语。要么让它真的为真，要么在按钮旁边说清楚它为假。

不改：`literalCalls` / `imports` 仍只有手写规格的语言有（TS/TSX/JS/JSX）。JSON 仍按 D-114 只进切片。捆绑语言不受影响。

影响：`structure/languages.ts`（`treeSitterTagsSpec` / `tagsDefinitionKind`）；`structure/tree-sitter-provider.ts`；`grammar-store.ts`（存查询）；`grammar-installer.ts`（校验查询）；`grammar-manifest.ts`（`tagsPath` / `tagsIntegrity`）；`scripts/refresh-grammar-manifest.mjs`；`grammar-packs.json`。

状态：已实施。

### D-129 · 2026-09-07 · 语法索引读不出来是"不知道"，不是"没装"

类型：implementation

背景：`readGrammarIndex` 之前把任何异常都吞成空索引。`index.json` 被截断、被别的进程占住、权限不对，都报"没装任何语法"。这违反 plan 0.4 不变量 10（只有 ENOENT 算空），而且下一次 `put` 会把这份"空"索引写回去——真装过的语言就此消失。

决定：只有 ENOENT 算空。其他 IO 错误、JSON 解析失败、形状不对，都抛 `GrammarStoreUnreadableError`。`index.json` 改成写临时文件再 rename，与 blob 的写法一致，崩在中途不会留下半个索引。

这个错误必须在界面上能看见，不能在 Host 里静静吞掉：`LanguageSupportStatus` 长出 `grammarStore: 'ready' | 'unreadable'`，`grammarStatus` 多一个 `unknown` 值。索引读不出来时，按需语言显示 `unknown`（灰色，不是"没装"的可操作态），安装和导入按钮都停用，页面顶部说明状态未知。捆绑语言不受影响——那张表在代码里，不在索引里。

原因：把"读不出来"报成"没装"，会让用户点安装，然后覆盖掉自己原有的安装记录。

不改：blob 文件名仍是内容地址，索引坏了 blob 还在，修好索引即恢复。

影响：`grammar-store.ts`；`language-support/runtime.ts`；`application-client` 的 `LanguageSupportStatus` / `StructureGrammarStatus`；`presentation.ts`；`LanguageSupportPage.tsx`；五个语言的 settings 词条。

状态：已实施。

### D-130 · 2026-09-07 · 导入端点的路径策略与错误面

类型：implementation

背景：`/api/language-support/import` 把 `readLocal` 的 `error.message` 原样回给调用方。已认证客户端能拿这个端点当文件探针：错误原文里带路径、`EACCES` / `EISDIR` / `ENOENT` 的区别，足以枚举 Host 机器上的文件。另外后缀和体积都没校验，任何文件都会先读进内存再交给 ABI 检查。

决定：读之前先判后缀必须是 `.wasm`，读到的字节超过 `MAX_USER_GRAMMAR_BYTES`（32 MiB）就拒。读失败一律回一句固定文案，不带 `errno`、不带路径。ABI 检查本身也包起来——喂给它一个不是 wasm 的文件会抛，那要变成 `reason: "abi"` 的失败，不是未捕获异常。

原因：D-124 说 Host 不自发网络；同理，Host 也不该把本地文件系统的形状当错误消息往外送。

不改：路径仍来自桌面 `requestFileAccess`，仍要求绝对路径；`source: "user"` 与 D-123 的 `user-unverified` 标记不变。

影响：`grammar-installer.ts`（`importUserGrammar`、`MAX_USER_GRAMMAR_BYTES`）。

状态：已实施。

### D-131 · 2026-09-07 · 清单坏了不许掀翻 Host；刷新脚本按已提交版本可复现

类型：implementation

背景：三处不牢。`loadCommittedGrammarPackManifest()` 在 `main()` 里裸调，`grammar-packs.json` 少一个字段就是 Host 起不来。清单解析不看 ABI 窗口——超窗的包照样列成 `available`，点了必然失败。刷新脚本取 npm `dist-tags.latest`，同一份代码今天明天生成的清单不一样。

决定：`main()` 用 try/catch 包住清单加载，失败退到 `EMPTY_GRAMMAR_PACK_MANIFEST`——按需下载没了，捆绑语言和已装语言照旧工作。解析阶段就按 `minCompatibleAbi` / `maxCompatibleAbi` 筛掉超窗的包，移进 `skipped` 并写原因。刷新脚本默认复用已提交清单里的版本号，`--latest` 才去 npm 问最新；`generatedAt` 取当次运行日期。

同时把重复点安装从"取消上一个"改成"并到同一个 Promise"，ABI 不匹配从 `reason: "failed"` 改成 `reason: "abi"`。

原因：清单是发布期产物，它的问题不该变成运行期启动故障；能装的清单不该列出装不上的东西。

不改：摘要校验仍是硬闸门（D-125）；捆绑优先（D-126）。

影响：`grammar-manifest.ts`；`application-host/index.ts`；`grammar-installer.ts`；`scripts/refresh-grammar-manifest.mjs`。

状态：已实施。

### D-132 · 2026-09-07 · D-116 至 D-119 是空号

类型：active-design

背景：3.11 第 5 步的实现里有注释引用 D-117 / D-118 / D-119，但这三个编号从未写过条目。按 D-030，编号一旦被引用就该能查到。

决定：D-116、D-117、D-118、D-119 永久空号，不回填。已有引用改指真实条目：D-117 → D-125（清单摘要在发布期生成），D-118 → D-126（捆绑目录优先），D-119 → D-127（按需语言名单）。以后新条目从 D-128 起编号，不复用空号。

原因：回填会让编号顺序和时间顺序对不上；空号比错号便宜。

不改：D-114 / D-115 / D-120 至 D-127 正文。

影响：`refresh-grammar-manifest.mjs`；`tree-sitter-provider.ts` 注释。

状态：已实施。

### D-133 · 2026-09-07 · D-103 第 2 项：崩溃隔离用例忽略已死管道的 EPIPE

类型：问题与解法

背景：D-103 立项三处测试收尾项。第 2 项：`lib/run/supervisor.test.ts`「isolates a crashed test provider」在子进程已死后仍向 stdin 写 `initialized` / RPC，未捕获的 `write EPIPE`（`errno -4047`）让 `packages/web` 完整套件退出码为 1，而断言全过。3.12 要反复跑这个套件，先修这一条。

决定：在 `test-supervisor.ts` 给崩溃隔离用例的子进程 stdin/stdout/stderr 挂 `error` 监听，忽略 `EPIPE` 与 `ERR_STREAM_DESTROYED`。崩溃隔离本身仍被断言。不改产品监督器。D-103 第 1 项（`thread-runtime` 20ms stalled）和第 3 项（pi-host `harness-e2e` #3）本刀不碰。

原因：套件退出码必须能当判据。把 EPIPE 吞进 vitest 全局忽略会一并吞掉真实未捕获错误；只在这条故意崩子进程的路径上忽略已死管道，范围最小。

不改：D-103 正文（历史立项）；两处挂钟阈值；生产 `supervisor.ts`。

影响：`lib/run/test-supervisor.ts`；status 3.2/下一步；D-103 索引行。

状态：已实施。

### D-134 · 2026-09-07 · 3.12 先量再决定：查询走已有 path→id 图，不加名字哈希

类型：问题与解法

背景：`searchSymbols` / `findLinks` 曾 `scanNodes` 全节点。上 explore 热路径前要先量本仓库目录规模和单次查询墙钟，再决定要不要内存索引。`connectionLiteralCounts` / `connectionLiteralsByPath` 是「打开时和每次写入维护、不改持久格式」的先例。

决定：查询不再 `scanNodes` 全库。打开与每次写入维护三份内存结构，无新持久格式、无迁移：`symbolQueryByPath`（searchSymbols 扫行而不是 `getPayload`）、`linksByValue`（findLinks 按字面量取值）、`importSpecifiersByPath`（findImporters 仍在查询期解析）。`searchSymbols` 把计分档暴露为 `match: exact | name-contains | path-contains`（分仍是 4/2/1）。对照测量（加缓存前、本仓库 2349 文件 / 24232 符号 / 13969 边）：`searchSymbols("explore", 20)=186.0ms`，`findLinks("explore.search")=73.2ms`，`findImporters(explore.ts)=42.4ms`。186ms × 每个 distinctive 词已经够上 explore 热路径，所以加了行缓存和按值的 link 映射；**不加**按名字的第二份哈希（名字包含仍要扫行）。findImporters 42ms 留在查询期解析，因为解析依赖当时的路径集合。

原因：全节点扫描会把 event/block/knowledge 和符号混在一起数。对照数字说明贵的是逐 id `getPayload`，不是缺一个名字哈希。`connectionLiteralCounts` 就是这个先例。

不改：持久 schema；embedding；词法/BM25 索引。

影响：`knowledge/store.ts`；`scripts/symbol-graph-query.ts`；status 3.1/3.12。

状态：已实施。

### D-135 · 2026-09-07 · 反向 import 查询期解析，未解析可见，不猜

类型：问题与解法

背景：import 边存的是未解析 specifier 字符串（D-105）。`./explore.js` 和 `../harness/explore.js` 是两个键，却常指向同一个文件。`related` 最有用的答案是「谁用了这个文件」。

决定：在查询期解析。相对 specifier 相对于该文件所在目录，尝试常见扩展名和 `index.*`；本仓库需要的 `.js`→`.ts` / `.tsx` 孪生一并试。命中目录里恰好一个已知路径才算解析成功。命中零个或多个孪生 → `unresolved-relative`。包名、别名、`node:`、`#` → `non-relative`。未解析必须出现在结果里，不许悄悄丢掉，更不许在多个孪生里猜一个。

原因：解析写进边会强迫冷扫描做模块解析，D-105 已拒绝。查询期有完整路径集合，相对路径足够确定性；包名没有工作区解析器，猜会撒谎。

不改：边的持久格式；tsconfig paths / package exports。

影响：`knowledge/import-resolve.ts`；`store.findImporters`；`related` 的 imports.unresolved。

状态：已实施。

### D-136 · 2026-09-07 · 本刀取代 D-108 的「不扩候选池」

类型：问题与解法

背景：D-108 把 explore 定为图的唯一生产消费者，但只注解已经选中的摘录，明确不把关联文件加入候选池。3.11 第 4 步因此建了只写的图：冷扫描持续维护符号，没有任何路径读目录做定义优先或连线补全。plan 0.7 要按观察到的「找不到入口」决定下一步；证据已经在库里——`explore.search` 的注册端和请求端是同一字面量的两头，rg 候选预算可能只留下提到它的文件。

决定：explore 增加图路径候选：定义、连线另一端、反向 import。摘录出边注解（`details.relations`）和 D-112 的降级/去行号/可见预算规则保留。D-108 正文不改；本条取代其中「不扩候选池」一句。

原因：图能加的是定义位置、连线配对和反向 import，不是笼统扩大召回。继续只注解已经选中的摘录，兑现不了第 4 步建的东西。

不改：rg 候选预算；24 KiB 字节预算；结构切片；`lsp.references`。

影响：`explore.ts` / `explore-graph.ts` / `explore-service.ts`；protocol `details.graph`；设计 6.1/6.2；plan 3.2/3.12；D-108 索引行。

状态：已实施。

### D-137 · 2026-09-07 · 图召回始终跑定义；连线与反向 import 等第一次打包之后

类型：问题与解法

背景：两级门控要自己定：始终跑图，还是只在 rg 不足时跑。第 1 步对照查询（path→id 扫描，见 D-134）显示单次 `searchSymbols` / `findLinks` / `findImporters` 的墙钟远小于一次 rg 扇出，定义优先的价值在 rg 命中很多时也成立。

决定：store 已打开且目录非空时**始终**跑定义召回（跳过 `path-contains` 档，避免把路径碰巧含该词的文件当定义）。连线补全和反向 import 需要已选中的摘录正文/路径，所以放在第一次 `packComplementary` 之后：只对摘录**正文里出现过**的确认连接字面量做 `findLinks`，只对已打包路径做 `findImporters`。独立预算：定义 40、连线 16、反向 import 每种子 6 / 总共 12。RRF 权重定义 10 / 连线 7 / import 3，打进现有 `rankCandidates`。打包另加 `graphBoost`（定义 30 / 连线 16 / import 4），因为互补打包原先不看 RRF，只提及时会压过定义文件。`filesDropped` 与 rg 取 max。why 写明来源，不伪装成 rg 命中。

原因：定义优先在「rg 已经很多」时仍然要把定义文件排到前面。连线和反向 import 没有查询词就做会把半个仓库拉进来；有了选中摘录才有种子。反向 import 噪声最大，上限宁可少给；同目录、更少 `../` 的 importer 优先。

不改：rg 200/80/20 预算；embedding；模型增强。

影响：`explore.ts`；`explore-graph.ts`；`explore.test.ts`。

状态：已实施。

### D-138 · 2026-09-07 · `related` 是文件级拓扑，不是 references，也不做 PageRank

类型：问题与解法

背景：`related-tool.ts` 依赖 store 上不存在的 `findNode` / `getNeighbors` 和 PageRank，还打印不存在的 rank。pi-host 没有工具定义。plan 0.1：不留 facade。

决定：按路径（含扩展名或分隔符）或名字重写。路径：定义、import（解析与未解析分列）、反向 import、连线及另一端。名字：先精确符号，再当连接字面量。空目录（含「这种语言目录不收录」）与「这个路径/名字没扫到」都是 `empty`，不是失败。`linksIncomplete`、未解析 specifier 是不完整。store 未打开返回 `unavailable`，读路径不开库。工具描述必须写明与 `lsp.references` 的分工。不保留 hops/labels/rank。

原因：LSP `references` 已经接线，精确回答谁引用这个符号。图回答它回答不了的：文件级连线和 import 拓扑，而且不需要语言服务器。做一个更差的 references 会和 3.8 抢活。

不改：PageRank、多跳、`references`/`calls` 边（D-059）。

影响：protocol `related.query`；Host `related-tool.ts` / `related-service.ts`；pi-host `related-tool.ts` / `select-tools.ts`；`session-e2e.test.ts`。

状态：已实施。

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
| D-031 | implementation | — | agent-harness.md 5.10、plan 1.9、protocol `harness-settings.ts` |
| D-032 | folded-in | D-039（原子 catalog 文件形状） | agent-harness.md 9.3.1 / 9.3.4、plan P0、protocol / Host registry |
| D-033 | superseded in part（事件等待保留，取消保活回放门槛） | D-078 | agent-harness.md 9.2.6；plan 3.5 |
| D-034 | folded-in | D-040（位强度与 schema 1 迁移） | agent-harness.md 5.1、plan P0、protocol / Host / pi-host |
| D-035 | folded-in | D-042（过渡 capability 来源语义） | agent-harness.md 9.1.2、architecture §5.1、plan P0；protocol / broker / Host router 已落地 |
| D-036 | folded-in | D-041（批量 acquire） | architecture §5.1、plan P0.6、Host / pi-host path lock |
| D-037 | superseded in part（撤销回放启用门槛与长期 shadow 默认） | D-078 | agent-harness 1.3/8.4/8.6；plan 2.4/2.6；status |
| D-038 | superseded in part（撤销类别自动暂停与固定流程，交付事实保留） | D-078 | plan 0.1/0.4/验收 |
| D-039 | implementation | — | architecture §5.1、plan P0.3–P0.4、thread-registry.ts |
| D-040 | implementation | — | agent-harness.md 5.1、plan P0.5、output-store / transcript reader |
| D-041 | implementation | — | architecture §5.1、plan P0.6、path authority / leases |
| D-042 | implementation | — | agent-harness.md 9.1.2、service-host capability derivation |
| D-043 | implementation | — | agent-harness.md 9.3、architecture §5.2、plan T1、status 3.4/3.5/3.10/3.11 |
| D-044 | implementation | — | agent-harness.md 9.1.2、plan 3b、status 3b / 3.4；pi-host / broker / Host scope |
| D-045 | superseded in part（已有 assist 实现保留，新默认已决定） | D-046 / D-078 | agent-harness 8.4；plan 2.4/2.6；status |
| D-046 | implementation | — | agent-harness.md 8.4.1、status 2.4/2.5；Host routes / SSE / session state sidebar |
| D-047 | superseded in part（记录器保留，配对不再阻塞交付） | D-078 | agent-harness 8.6；plan 0.7；status T4 |
| D-048 | implementation | — | agent-harness.md 5.1、status 1.11；toolSummary / PiTimelineEntries |
| D-049 | implementation | — | agent-harness.md 8.6、status 1.8；SessionStats / Context sidebar |
| D-050 | implementation | — | architecture 4.4、plan/status 1b；protocol / pi-host / Web broker |
| D-051 | superseded in part（工具、授权与一基位置保留；共享会话与 documentVersion 语义改为按视图隔离） | D-087 | agent-harness/plan/status 3.8、architecture 5.1；protocol / Host LSP / pi-host |
| D-052 | implementation | — | agent-harness/plan/status 3.9；protocol / Host observation/shell/diagnostics / pi-host / UI |
| D-053 | implementation | — | agent-harness/plan/status 3.4/3.5；Host ThreadRegistry / Zone 2 / observation cursors |
| D-054 | implementation | — | agent-harness/plan/status 2.3；Git routes / Documents / knowledge context runtime |
| D-055 | implementation | — | agent-harness 9.2/9.3、plan/status 3.4；ThreadRuntime / knowledge blocks / report |
| D-056 | implementation | — | plan/status 3.6；protocol role catalog |
| D-057 | superseded in part（既有 Git 结果是迁移来源；原生结果与回收已采用） | D-077 / D-078 | agent-harness 9.2.5b/9.3.4；plan 3.4/3.5；status |
| D-058 | implementation | — | agent-harness 7.2.2、plan/status 2.7；KnowledgeStore / routes / session state UI |
| D-059 | superseded in part（事件驱动逐文件采集保留；正文来源收窄为磁盘并记录 document revision） | D-087 | agent-harness 6.2/7.2、plan/status 3.1；Documents / LSP / KnowledgeStore graph |
| D-060 | implementation | — | agent-harness 7.2.2、plan/status 2.7；Pi timeline / scoped review API |
| D-061 | implementation | — | agent-harness 7.2.2、plan/status 2.7；KnowledgeStore / decision suggestion runtime |
| D-062 | implementation | — | agent-harness 9.3.8、plan/status 3.10；session state rail / mobile overlay |
| D-063 | implementation | — | agent-harness 9.3.2/9.3.8、architecture 5.2、plan/status 3.10；protocol / Host / pi-host E2E / UI |
| D-064 | implementation | — | agent-harness 9.3.8、plan/status 3.10；UI shared thread state / timeline markers |
| D-065 | implementation | — | status 1.4/1.6；Host diagnostics adapter/service、真实 LSP 与 Pi session E2E |
| D-066 | implementation | — | architecture、plan/status 1b.2；protocol / pi-host session-local reader / Host fetch |
| D-067 | implementation | — | agent-harness 5.8、plan/status 1b.3/1b.5；protocol / Host providers+auth / pi-host / UI sources |
| D-068 | superseded in part（槽位配置保留，取消分项统计） | D-080 | agent-harness 8.5/8.6、plan/status 2.9；protocol / pi-host / UI |
| D-069 | superseded in part（错误承诺撤销，检索正式采用） | D-070 / D-072 / D-078 | agent-harness 6.1；plan 3.2；status |
| D-070 | superseded in part（来源/证据边界保留，撤销候选与回放门禁） | D-071 / D-072 / D-078 | agent-harness 6.1；plan 3.2；status |
| D-071 | superseded in part（数据库/草稿/check/不付费实验/无 Windows 沙箱保留；推进与默认更新） | D-073 / D-078 | agent-harness 1.3/6/7/8/9；plan 0.7；status |
| D-072 | superseded in part（版本/覆盖/来源正确性保留；默认与权威演进更新） | D-078 | agent-harness 6/8/9；plan 2/3；status |
| D-073 | folded-in（用户补充；仅文档） | — | agent-harness 7.5、plan 2.1 |
| D-074 | superseded in part（首个实现候选） | D-075 / D-076 | plan 0.7 step 1；原始失败形状保留 |
| D-075 | superseded（第二个实现候选未通过验收） | D-076 | D-076 回归用例 |
| D-076 | implementation | — | agent-harness 8.4/8.7、status 2.4/2.6/3.9；protocol / pi-host / Host |
| D-077 | superseded in part（生命周期保留；补原生状态/实际写者/ignored 保留，撤销猜测默认） | D-078 | agent-harness 9.2.5b/9.3.4；plan 3.4；status |
| D-078 | folded-in（用户重新授权；正式实施与默认交付） | — | agent-harness 1.3/2/6/8/9/12；plan 0.1/0.7/2/3；status；architecture |
| D-079 | implementation（修复实际调用与数据正确性） | — | Host working-state/thread/recovery/explore；status |
| D-080 | implementation（取消辅助分项统计，保留会话统计） | — | protocol / pi-host / UI；设计 8.4–8.6、plan、status |
| D-081 | implementation（默认记忆、动态模式与逐次压缩接管） | — | protocol / pi-host / Host / UI；设计 8.4、plan 2.4/2.6、status、architecture |
| D-082 | implementation（自动 surface snapshot 与 draft-aware explore） | — | protocol / UI / broker / pi-host / Documents / Host explore；设计 6.1、plan 3.2、status、architecture |
| D-083 | implementation（dispatch 持久草稿基线与 surface 集成边界） | — | protocol / UI Documents / Host Thread+WorkingState+Integration；设计 6.1/9.2.5b、plan 3.2/3.4/3.5、status、architecture |
| D-084 | implementation（copyIgnored 持久 captureScopes 与结果发布） | — | Host WorkingState/Thread runtime；设计 9.2.5b、plan 3.4、status、architecture |
| D-085 | implementation（普通 read/grep 固定 surface 来源） | — | protocol / pi-host / Host Documents+search；设计 5.3/6.1、plan 3.2、status、architecture |
| D-086 | implementation（普通 find/ls 固定 surface 路径快照） | — | protocol / pi-host / Host Documents+path overlay；设计 5.0/6.1/9.2.5b、plan 3.2、status、architecture |
| D-087 | implementation（语言服务视图隔离与正文修订绑定） | — | agent-harness 5.0/6.1/6.2/6.4、plan 0.7/3.1/3.2/3.8、status 3.1/3.2/3.8；protocol language identity+results / Host LSP views / Documents / knowledge graph / UI |
| D-088 | implementation（写入使固定窗口草稿在该路径上失效） | — | agent-harness 6.1、plan 3.2、status 窗口读取/3.2；Documents surface snapshot / recovery turn coordinator / Harness search+explore+thread dispatch |
| D-089 | implementation（读写来源不对称：写入前拦住并说清楚） | — | agent-harness 6.1、plan 3.2、status 窗口读取/3.2；protocol document.writeGuard / Documents / Harness router+services / pi-host write+edit+apply_patch |
| D-090 | implementation（explore 快速检索策略已回写；缺陷 2–8 与 `anchors` 已实施，缺陷 1 复验未达成见 D-092；结构切片已由 3.11 第 1、3 步接上） | D-091（tree-sitter 第 5 步仍待决）、D-092（缺陷 1 未达成部分） | agent-harness 2/5.0/5.7/6/6.1、plan 0.7/3.2、status 3.2/下一步；protocol explore.search / pi-host explore-tool / Host explore+explore-service |
| D-091 | active-design（结构来源 provider 与 tree-sitter 语法包：wasm 版、接口先行、TS/TSX 首刀、常用语言捆绑 + 其余按需下载、语言 ≥ 3 时设置页；目标覆盖大部分常用语言） | D-093–D-108（第 1–4 步实施拍板） | agent-harness 2/6.1/6.2/D-078 收口表、plan 0.7/3.2/3.11、status 3.11；第 1–4 步已接，第 5 步待做 |
| D-092 | implementation（候选广度按文件轮转分配；`filesDropped` 与 grep 深度优先截断分开；六个小项已修；验收复验再补两项：`filesDropped` 跨词项/重叠根取最大值作下界而非求和、工具 schema 与 Host 对空白 anchor 同口径） | — | agent-harness 6.1、plan 0.7/3.2、status 3.2/下一步；protocol search.content+explore.search / Host search-service+explore+explore-service / pi-host explore-tool schema |
| D-093 | implementation（小/大函数阈值 24 行，一个典型编辑器视口） | — | structure/constants.ts；3.11 切片 |
| D-094 | implementation（结构切片字段放在 ExploreSearchSnippet 与 details.structure，不进 why） | — | protocol harness explore.search；Host explore + structure；pi-host explore-tool details |
| D-095 | implementation（命中分类只打已物化窗口分，不解析 200 文件候选池） | — | structure/constants.ts；explore windowScore；tree-sitter classifyHits |
| D-096 | implementation（wasm 放 lib/structure/runtime，ASAR 重映射复用 extension-builtins；语法取 tree-sitter-typescript 0.23.2 而非 tree-sitter-wasms） | D-101（补充：二进制以 git 为事实来源，copy 仅 `--force` 刷新） | packages/web 依赖与 copy/build；structure/runtime-path.ts |
| D-097 | implementation（生产顺序 tree-sitter → LSP → ±3 窗口） | D-099（empty / 缺口不再直接获胜） | application-host/index.ts；structure/source.ts；explore |
| D-098 | implementation（切片单位是容器；值绑定切所属函数/类；定义绑定仍是自己的单元） | — | structure kinds/slice/tree-sitter；agent-harness 6.1；plan/status 3.11 |
| D-099 | implementation（empty/缺口可问后续 provider，warmOnly 不冷启动 LSP） | — | structure source/lsp-provider；explore hitLines |
| D-100 | implementation（云 lock 与冒烟包含 web-tree-sitter） | — | scripts/cloud-runtime.bun.lock；build-cloud-runtime.mjs |
| D-101 | implementation（约 3 MB grammar wasm 检入 git；copy 脚本只在 `--force` 时刷新） | — | structure/DOCUMENTATION.md；copy-structure-runtime.mjs 行为说明 |
| D-102 | implementation（解析预算是跑飞兜底、250ms、测试自带预算；签名即全体的单元按 ±3 取并补齐） | — | structure/constants.ts + slice.ts；structure/explore 测试；structure/DOCUMENTATION.md；status 3.11 |
| D-103 | open（第 1、3 项仍待：thread-runtime 20ms stalled、pi-host harness-e2e #3；第 2 项 EPIPE 已由 D-133 修） | D-133（仅第 2 项） | thread-runtime.test.ts；run/supervisor.test.ts；pi-host harness-e2e.test.ts；status 3.2/3.12 |
| D-104 | implementation（冷目录只采集 TS/TSX；非 TS 跳过不 touchFile） | D-115 | symbol-runtime catalog scan；status 3.11 |
| D-114 | implementation（JSON 进切片不进目录；深度 8、符号 256；根容器始终保留） | — | json-outline.ts；kinds/slice/source；catalog scan |
| D-115 | implementation（冷目录扩到带 importQuery 的语言：TS/TSX/JS/JSX；取代 D-104 覆盖范围） | — | languages.ts CATALOG_SCAN_LANGUAGES |
| D-120 | implementation（语言分布现算；文件上限 8000；工作区缓存 30s） | — | language-support/runtime.ts |
| D-121 | implementation（wanted 按工作区内存记，结构仍报 unsupported；Host 不自发网络） | — | tree-sitter onLanguageRequest；LanguageSupportRuntime |
| D-122 | implementation（语言支持设置页：普通渲染器 order 38；LSP 复用 LanguageServicesAPI） | — | LanguageSupportPage；builtin-page-metadata |
| D-123 | implementation（用户自带 wasm：source=user，ABI 闸门，不覆盖捆绑） | — | grammar-installer importUserGrammar |
| D-124 | implementation（明确动作即同意；Host 不自发网络；embedding 下载管道不存在） | — | grammar-installer；plan 3.11 第 5 步 |
| D-125 | implementation（发布期自算 wasm sha256，不从网络取信） | — | refresh-grammar-manifest.mjs；grammar-packs.json |
| D-126 | implementation（捆绑 runtime/ 优先于下载目录） | — | resolveStructureRuntimeFile |
| D-127 | 实验结果（15 种可装；swift/markdown/xml 无 wasm；协议 id 用 csharp/shellscript） | — | grammar-packs.json；language-id.ts |
| D-105 | implementation（link 节点与 imports/connects/associates 加法写入，generation 同寿；touchFile 保留修订） | — | knowledge/store.ts；symbol collector/runtime |
| D-106 | implementation（StructureSource literalCalls/imports fan-out；确认 callee 允许名单） | — | structure/source.ts + connections.ts |
| D-107 | implementation（冷扫描 queueMicrotask，不挡启动/首 turn） | — | application-host/index.ts；symbol-runtime.scanWorkspace |
| D-108 | superseded in part（摘录出边注解保留；「不扩候选池」由 D-136 取代） | D-136 | protocol explore.search details.relations；explore + explore-service |
| D-109 | implementation（关联候选须真同名：`connectionLiterals` 闸门 + 本批 connects + 冷扫描补一遍；实测 10,711 → 153） | — | knowledge/store.ts connects 值索引；symbol-runtime 闸门；symbol-runtime.test.ts |
| D-110 | implementation（轮廓行区间转字符范围时末列取真实行长，不再零宽） | — | knowledge/symbol-runtime.ts flattenOutlineSymbols |
| D-111 | implementation（outline 单独决定能否写这一代；边被阻塞记 `linksIncomplete` 而非冻结符号） | — | knowledge/symbol-runtime.ts + symbols.ts + store.ts；symbol-runtime.test.ts |
| D-112 | implementation（关系是注解：`status` 降级不失败检索、读路径不开库、过期去行号标 `stale`、可见预算排最后并每文件 12 条上限） | — | protocol ExploreRelationStatus/ExploreFileRelation；explore.ts 打包；explore-service.ts；service-host.ts；index.ts |
| D-113 | implementation（outline 收模块级/类级值绑定作目录名，切片仍按容器过滤） | — | structure/tree-sitter-provider.ts；tree-sitter-provider.test.ts |
| D-116 | 空号（未使用） | D-132 | — |
| D-117 | 空号（引用改指 D-125） | D-132 | — |
| D-118 | 空号（引用改指 D-126） | D-132 | — |
| D-119 | 空号（引用改指 D-127） | D-132 | — |
| D-128 | active-design（上游 `tags.scm` 变运行期规格；发布期编译验证；15 种里 9 种真出轮廓） | — | agent-harness.md 6.4；plan 3.11 第 5 步；status 3.11；languages.ts / grammar-* / refresh 脚本 |
| D-129 | implementation（只 ENOENT 算空；索引原子写；读不出来报 `unknown` 并停用安装） | — | grammar-store.ts；language-support/runtime.ts；application-client 类型；LanguageSupportPage |
| D-130 | implementation（导入校验后缀与体积；不回传文件系统错误原文；ABI 检查异常变 `abi` 失败） | — | grammar-installer.ts importUserGrammar |
| D-131 | implementation（清单加载失败退空清单；解析期筛 ABI 超窗；刷新脚本按已提交版本可复现；重复安装并流） | — | grammar-manifest.ts；application-host/index.ts；grammar-installer.ts；refresh 脚本 |
| D-132 | active-design（D-116–D-119 永久空号，引用改指真实条目） | — | 本文件治理规则 |
| D-133 | implementation（D-103 第 2 项：崩溃隔离用例忽略已死管道的 EPIPE） | — | lib/run/test-supervisor.ts；status 3.2/3.12 |
| D-134 | implementation（查询走内存行缓存 + linksByValue；searchSymbols 暴露 match 分档；对照数字后不加名字哈希） | — | knowledge/store.ts；scripts/symbol-graph-query.ts；status 3.1/3.12 |
| D-135 | implementation（反向 import 查询期解析；未解析可见；`.js`→`.ts` 孪生；多命中不猜） | — | knowledge/import-resolve.ts；store.findImporters；related imports.unresolved |
| D-136 | implementation（取代 D-108「不扩候选池」：explore 增加图路径候选） | — | explore.ts / explore-graph.ts；protocol details.graph；设计 6.1/6.2；plan 3.12 |
| D-137 | implementation（定义召回始终跑；连线与反向 import 等第一次打包之后；独立预算与 filesDropped max） | — | explore.ts；explore-graph.ts |
| D-138 | implementation（related 是文件级拓扑，不是 references，无 PageRank；store 未开 → unavailable） | — | protocol related.query；Host related-tool/service；pi-host related-tool；session-e2e |
