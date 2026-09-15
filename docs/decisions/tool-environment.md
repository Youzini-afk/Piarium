# 决策分卷：工具环境

范围：1.x 工具与 shell 监督、输出契约、编辑/诊断、路径租约、计数器、设置与提示、1b.x Web 工具、3.9 观察视图、3.17 命令整理。

本卷是 [agent-harness-decisions.md](../agent-harness-decisions.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

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

### D-014 · 2026-09-03 · 1.6
类型：偏离
决定：apply_patch 回到决策表形状：使用 Codex 语法（*** Begin Patch / *** Update File: / *** Add File: / *** Delete File: / @@ 上下文 / *** End Patch），支持多文件。每个文件的写入经与 edit / write 相同的 workspace.mutation.request before/after。只在会话模型为 OpenAI 家族（provider === "openai" || api === "openai"）时注册。
原因：决策表要求 apply_patch 使用 Codex 语法以与 OpenAI 模型的训练数据对齐。多文件支持减少了工具调用次数。workspace.mutation 集成确保所有文件变更都经过 journal，与 edit/write 工具一致。OpenAI-only 限制避免了在不支持该语法的模型上注册无用工具。
考虑过的替代：(1) unified diff 语法（D-012，已回退）——不匹配 OpenAI 训练数据。(2) 不经过 mutation journal——绕过了 recovery 系统。(3) 所有模型都注册——浪费非 OpenAI 模型的工具槽位。
影响：`packages/pi-host/src/harness/apply-patch-tool.ts`（完全重写）；`packages/pi-host/src/session-host.ts`（OpenAI-only 条件注册 + 传入 mutationJournal）。
状态：已实施

### D-015 · 2026-09-03 · 1.9
类型：决策
决定：HarnessSettings 存储在 Pi settings 的 `harness` 键下，用户级（scope: `global`），不使用项目级覆盖。
原因：harness 工具配置是用户偏好（shell 选择、输出截断大小、命令超时），不是项目协作约定。用户级存储确保同一用户在不同项目中有一致的 harness 行为。工具开关也放在用户级——如果某用户不想用 grep override，这个偏好应跨项目生效。
考虑过的替代：(1) 项目级存储——harness 行为会随项目变化，造成困惑。(2) 混合（工具开关用户级，shell/output 项目级）——增加复杂度，没有实际用例驱动。
影响：`packages/ui/src/components/sections/harness/HarnessSettingsPage.tsx`（写入 `scope: 'global'` 的 `harness` 键）；`packages/pi-host/src/session-host.ts`（从 Pi settings 读取 `harness` 键并 mergeHarnessSettings）。
状态：已实施

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

### D-036 · 2026-09-04 · 1.7（工作区级规范路径锁）
类型：偏离
决定：编辑锁的键从 `sessionId → path` 改为 `{ authorityId, workspaceId, canonicalResourceId }`；`acquire` 返回 `leaseId`，`release` 只凭 `leaseId`；路径身份规范化（realpath、Windows 大小写与 alias、符号链接）**复用 Documents authority**，harness 不再自行处理。锁只做进程内实现，其保证写明为："同一 Application Host authority 内，所有 Harness 管理的写操作按 workspace / resource 互斥"，不声称阻止其他 Piarium host、终端、Git 或外部进程写文件。
原因：plan 1.7 参考形状原文就是 `Map<sessionId, Map<path, queue>>`，两个会话写同一文件互相看不见；`release(sessionId, path)` 没有所有权 token，同会话内另一个请求可以误释放。所有会话的 harness 服务都在同一个 host 进程内，双 host 共用工作区的情形由 plan 2.1 的"复用运行中的 host"处理，跨进程 lease 不在需要范围内。
考虑过的替代：把锁做成 Documents 的 writer lease——Documents 的 lease 是按 scope 的写者模式，不是按文件互斥，形状不对；只借它的身份规范化。
影响：`packages/web/application-host/lib/harness/path-lock.ts`；`packages/protocol/src/harness.ts`（`fs.lock` 参数与结果）；`packages/pi-host/src/harness/path-lock.ts`（`withPathLock` 持 leaseId）；plan 1.7 回写。
状态：待实施（P0 第 6 项）

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

### D-160 · 2026-09-08 · bash 输出压缩按命令分派规则解析；模型总结只作附加

背景：维护者问"工具输出的裁剪那里，我们现在是直接裁剪的吧，如果专门有个小模型做裁剪或总结呢，可以减少 agent 拉取"。核实：
`tool-result-truncation.ts` 是纯字节头尾切——32 KB，头 50%（bash 37.5%），最近换行，全文进 OutputStore——对内容一无所知，
50 KB 测试输出的失败块在中间就得再拉。AFT 的 `compress/` 是五层规则：20 个命令专用解析器（vitest / jest / tsc / eslint /
biome / git / cargo / pytest / mypy / ruff / playwright / go / npm / pnpm / bun …）→ 输出形状嗅探 → 包管理器通配 →
TOML 声明式规则 → 通用去 ANSI 去重。**没有模型。**

决定：走 AFT 那条路。结构化命令输出本来就有结构，解析器几微秒精确抽出统计行与每个失败块、不会漏；小模型总结 50 KB 输出
可能把一个失败名写错或漏掉，而这个错是**静默的**——agent 以为测试全过就往下写。头尾切至少诚实，agent 知道中间被切了会去拉；
模型总结看起来完整，agent 不会去拉，这正是"减少拉取"的另一面：前提是总结不能错。所以方向对、手段分开：结构化输出按命令
分派规则（先做 Piarium 自己天天跑的 vitest / tsc / eslint / git 四个，每个带真实输出样本的确定性测试）；非结构化输出上模型总结
可以做，但只作**附加**——"这是头、这是尾、这是模型认为重要的几行、全文在句柄"——不替代头尾切，且明确标注是模型挑的行。
全文照旧进 OutputStore，句柄语义不变。

同一问题下维护者还问了"训练小模型做路由判断"。结论：`parseExploreQuery` 里靠正则和词表的推断（relation / domain / preferTests /
16 个英文问句词）在自然语言变化面前确实脆，但训练要标注数据（十条不够，蒸馏可行）、而且黑盒路由与"量具不能撒谎、每个决定说得出
理由"的纪律冲突——AFT 的 `QueryShape` 也选了正则。先用 3.16 反正要引入的嵌入模型做零样本分类（每类几个原型问题，最近原型赢，
不训练、跨语言、出错时看得到匹配了哪个原型），不够用了再谈蒸馏。真正值的"小模型进管线"是重排器（D-158）。

不改：OutputStore 句柄语义；32 KB 可见预算数值。

影响：设计 5.2；plan 3.17。

状态：已决定，待实施（plan 3.17）。

### D-197 · 2026-09-10 · 按命令整理 bash / get_output 默认展示（3.17）

背景：默认展示仍是字节头尾切。失败块在长输出中段时会被切掉；`tool_result` 再切一次会抵消任何命令整理。D-160 已定规则解析，不用模型总结替代。

决定：

1. 整理只改默认展示。`stdout` / incremental `text` 仍是原始 UTF-8；游标按原始 `nextOffset` 推进。显式 `offset`/`length` 与 `out_` 句柄继续读原文。
2. 用命令 token（含 `bunx` / `npx` / `bun run` 与 `&&` 分段）识别 vitest、tsc、eslint、git；无法从命令判断时只认窄输出形状。不执行命令，不调用模型。git 按子命令：status 保留文件状态，diff/show 保留 hunk 与请求正文，log 保留 commit；其余 git 走通用展示。
3. 可见预算仍是既有 32 KiB。超预算时说明省略并指向全文句柄，不新加 per-file/per-hunk 硬上限。退出码只来自进程。
4. 公开 `bash` 与增量 `get_output` 使用 `display`。`tool_result` 不再对这两项做头尾切。未完成或分片输出标明当前观察，不当最终结果。交互提示保留。
5. 本阶段不接 jest 专名、包管理器通配、TOML 规则层或附加模型总结。

验证：真实样本覆盖成功/失败/无法识别、中段失败块、ANSI/CRLF/分片、超预算省略；`createShellExecService` / `createShellReadService` 与公开 bash、get_output 格式化。未做完整 shell 解释器。

影响：`output-organize/`、`harness-services.ts`、`shell-supervisor.ts`、`bash-tool.ts`、`output-tools.ts`、`tool-result-truncation.ts`；设计 5.2；plan/status 3.17。

状态：已实施。

### D-199 · 2026-09-10 · 命令整理保留未知正文与原文读取（3.17）

背景：验收 D-197 复现了 pretty tsc 诊断被统计行遮掉、混合命令丢失前段结果、Vitest 失败位置和分片正文被静默丢弃。未知长输出被当成一个不可装入的块，只剩省略提示；按工具名无条件跳过截断也让旧 Host 的全文越过原可见预算。

决定：

1. 整理器只收起明确识别的成功/重复噪声，保留未知正文、失败上下文、定位和交互提示。统计行不是丢弃其他内容的依据。支持常见 plain/pretty 诊断；分片中的未知内容也保留。
2. 命令识别只使用可靠的执行位置和包装结构；混合输出不能可靠归属时用通用展示，不选择最后一个工具解析整份输出。无需完整 shell 解释器。
3. 通用超预算展示保留可读首尾；大块不能变成只有省略提示的空壳。沿用 32 KiB 展示预算与原文句柄，不增加文件/错误块硬上限。
4. 只有实际获得 Host 整理结果才免于二次裁切；旧 Host 和未整理结果继续沿通用展示路径。显式分页保持请求的原始 UTF-8 内容，游标、进程退出码和原始输出权威不变。

影响：命令识别/解析/展示、shell 默认读取、Pi 工具与 `tool_result` 截断；设计 5.2；plan/status 3.17。补正 D-197 的识别范围及无条件跳过截断，功能默认启用的方向不变。

状态：待验收。

### D-200 · 2026-09-10 · Windows shell 真实发现与按工作区配置接线（1.3）

背景：生产 `index.ts` 创建 `HarnessServiceHost` 时不传 `discoveredShells` / `shellSetting`。Host 因此用 `auto` 加空 discovery。普通 Windows 路径下 `selectInterpreter` 返回 “Git for Windows not found”，即使用户已安装 Git Bash 或在现有设置里选了可用解释器。e2e 里手工塞 `gitBashPath` 不能证明生产装配。

决定：

1. 解释器发现是 Host 机器级责任，复用 Git 服务 / environment runtime 已有的 Windows 安装根、PATH 可执行检查，以及已解析的 `git.exe` 旁边的 bash。优先记录可执行的 `usr\bin\bash.exe`，避免 `bin` 启动器和把 `usr\bin` 误写成 `usr\usr\bin`。WSL 发行版来自 `wsl.exe --list --quiet`（含 UTF-16LE）。不另建配置文件。
2. `harness.shell` 沿现有 Pi `settings.get`（用户默认 + 受信任项目覆盖）在**该会话注册时**解析，按 workspace/session 生效。Host 不再使用单一冻结的 `shellSetting` 作为生产权威。已运行的 PTY 不热切换；新会话或新 worker 代际再注册。两个工作区不能串用对方的解释器。
3. 生产 `index.ts` 在构造 Host 时传入真实 `discoverShells()` 结果；Host 在选项省略时也自己发现一次，避免再次漏接。设置读取失败回退 `auto` + 真实发现；非法 `harness.shell` 记为 unavailable 并给出修复入口，不假装未安装。
4. 本阶段只修可用性和配置接线。后台 shell 变终端 tab、bundled Pi 默认优先级不在此列。WSL 路径、PowerShell、远端和非 Windows 的原有选择规则保留；`auto` 在原生 Windows 上仍要求 Git Bash，不暗降到 PowerShell。

验证：注入式发现/设置单测；缺解释器走公开 `shell.exec` 的 spawn-failed；本机 Windows 上 Host 默认发现 + 公开 `shell.exec` 执行 `echo`。不把 e2e 手工路径当作生产证明。

影响：`shell-discovery.ts`、`harness-shell-settings.ts`、`service-host.ts`、`index.ts`、`shell-supervisor.ts`；设计 5.2；status 1.3；Host DOCUMENTATION。

状态：已实施。

### D-205 · 2026-09-10 · shell 注册按 actor 代际等待，退出以进程和写者完成为准

背景：D-200 的异步 settings 注册存在首个工具请求先到、旧 worker 注册迟到复活的问题。PowerShell 的 `-Command -` 不适用于 ConPTY。Host 丢弃会话时火忘关闭 PTY，也不能作为线程目录可回收的依据。

决定：

1. 注册按 authority/session/worker/generation 归属并去重，工具准入等待自己的注册。换代、会话关闭和 Host 停止使旧等待失效，迟到配置不能复活旧 actor。首次注册不清除已捕获的用户输入快照。
2. 设置读取失败明确 unavailable，替代 D-200 第 3 条的 auto 回退；配置有效时仍按工作区选定并固定解释器。PowerShell 使用真实交互进程与其自身命令包装，Git Bash 继续使用 Bash 包装。
3. 关闭先确认 PTY 退出，再释放命令写者。超时或失败不伪造已停，仍可观察与重试；被 drop/换代移出的 shell 在关闭完成前仍参与回收判断。线程的 sessions.close 等待这条 Host 关闭链，再完成 Pi 会话关闭。
4. `harness.cancel.requestId` 取消同 actor 已准入的请求，不额外要求搜索权限；按 `queryId` 取消 explore 仍要求 `read.search`。公开 merge 的 signal 进入同一取消链，不能因借用 explore 的权限检查而失效。

影响：session registration、Router、shell supervisor、service-host 与 index；不增加解释器设置或后台终端 tab。

状态：已实施，真实 Windows 与定向证据见 status 1.3。

### D-206 · 2026-09-10 · 后台 shell 接入终端 runtime，bundled Pi 默认与 todo 确认

背景：D-013 只复用了 PTY 模块，监督器与用户终端各自创建同类进程。无显式选择时 Runtime Manager 仍偏向 PATH/system。todo 曾因 confidence 低于阈值默认弹确认。

决定：

1. 生产监督器只通过 terminal runtime 的 `createTerminalSession` 取得 PTY。公开 `sh_N` 就是该会话 id。HTTP create 不能指定 `owner` / `spawn` / retain；程序化 API 才允许 harness spawn。用户附着走同一 runtime 的 attach/WebSocket，agent `get_output` / `write_to_process` / `kill_shell` 写同一 handle。关闭查看（DELETE retain 或 tab `closePolicy: detach`）不终止进程；force-kill、`kill_shell` 与 supervisor dispose 仍等真实退出再放写者，后台命令继续按会话 cwd 阻止回收。短命令不自动打开终端。
2. 没有 `selectedId` 且 bundled 为 ready 时，Runtime Manager 优先 bundled Pi。用户明确选择的 system/standalone/custom/source 只要不是 missing 就保持优先。这是 Pi 运行时选择，不是 `harness.shell`。
3. `todo` 的 confidence 只作信息。默认 `requireConfirmation: false`。只有已有、明确启用的审批策略才让 Host 返回等待，并由 pi-host 在该响应之后弹确认。不另造审批框架。

考虑过的替代：(1) 打开终端时重跑命令——不是同一进程。(2) 监督器继续自管 PTY、终端只镜像输出——两套生命周期。(3) 把 bundled 与 `harness.shell` 合成一项——混淆解释器与 Pi 运行时。

影响：terminal runtime / session API、shell supervisor / service-host / index 晚绑定、Runtime Manager 优先序、todo Host/pi-host、UI 时间线“打开终端”；设计 5.2 / 5.6、architecture 10、status 1.3 / 2.5。D-013 的未兑现前置在此收口。

状态：已实施；Windows Git Bash / PowerShell 与定向证据见 status 1.3 / 2.5。macOS / Linux 与完整浏览器点击链未测。

### D-209 · 2026-09-10 · 1.3 / 2.5（终端身份、退出事实与 todo 单一审批边界）

类型：问题与解法（补正 D-206）

背景：D-206 把 Harness shell 接进 terminal runtime，但初版仍由每个 `ShellSupervisor` 从 `sh_1` 开始编号；terminal runtime 是全局表，多个会话会碰撞。`kill_shell` 还可能在只发送中断、PTY 尚未退出时返回成功，强制终止则可能先移除会话再异步等待，导致 exit 事件、写者释放和目录回收互相失真。todo 的 Host 二次确认字段没有生产审批策略消费者，只留下一个看似可用的假契约。

决定：

1. terminal runtime 是 `sh_N` 的唯一分配者，编号在该 runtime 内全局唯一；监督器采用返回 handle 的实际 id。已有 id 只有 owner、创建来源、cwd、shell/spawn、writer 注册与 retain 语义全部一致且仍在运行时才能复用。HTTP 不能接管程序化 Harness 会话，已退出 id 必须先显式关闭。
2. 一条命令的 started/completed 由监督器在真实执行边界发出。后台命令由 PTY exit 完成，不依赖 agent 是否再次调用 `get_output`；重复读取不重复完成记录。
3. `kill_shell`、会话关闭和 force-kill 只在目标 PTY 真实退出、相关 process writer 释放后报告成功。退出或 writer 释放失败保留可观察、可重试状态，并继续阻止相关目录回收；迟到 exit 仍由原 handle 消费。
4. `todo.confidence` 只作内容信息。若 plan mode 或权限策略需要批准，批准发生在既有 pre-tool 流程；`todo.upsert` 不在写入后再问一次。删除没有生产消费者的 `confirmed` / `askedConfirmation` 协议字段，不保留假兼容层。

影响：terminal runtime / Harness bridge / shell supervisor / service-host、公开 shell 工具、todo protocol/Host/pi-host、设计 5.2 / 5.6、architecture 4.4 / 6、status 1.3 / 2.5。

状态：已实施；进程身份、跨监督器冲突、后台自然退出、终止失败和 writer 释放重试有定向证据。完整浏览器点击链与 macOS/Linux 真机仍未测。

### D-241 · 2026-09-12 · 3.17 / 5.2（包管理器通配进命令输出整理）

类型：问题与解法

背景：五层输出整理（设计 5.2）接了专用解析器与输出嗅探，`npm test` / `pnpm run build` 这类包裹命令靠正文形状碰巧
识别内层工具；内层输出被截断、缺页脚或格式不巧时就退回通用首尾。管理层自己的回显（`> name@ver script` 后接
`> 内层命令`、yarn/bun 的 `$` 行）是可靠的执行位置，此前没有被消费。

决定：

1. `identifyFromCommand` 把 `npm`/`pnpm`/`yarn`/`bun` 头的脚本运行与内置命令归为 `package-manager`：`run` 子命令后的
   名字是用户脚本而非工具身份；`exec`/`dlx`/`x` 子命令解析后直接跑二进制，二进制名仍是工具身份（`npm exec vitest` →
   vitest）；`npx`/`bunx` 裸包裹同理，解析不出时仍回 generic。`deno`/`node` 是运行时头，不归管理层。
2. `package-manager` 整理器先取管理器回显的内层命令（顶部窗口内第一个非 `name@ver` 的 `>`/`$` 行，深处的 `>` 行是
   工具正文不算回显），能经 `identifyFromCommand` 认出已知工具就把其后正文交给对应解析器——kind 记为内层工具，包裹
   行留在正文里；回显不可识别或缺失时对内层正文做形状嗅探，仍不识别才走管理器形状整理。
3. 管理器形状：错误块（`npm error`/`ERR_PNPM_`/yarn `error Command failed`）与 install/audit/完成摘要是必需项；
   `npm warn|timing|http|verb|sill`、进度、下载/解析类重复行折叠成计数并给首样本；其余正文原样保留——和 D-199 一样，
   收起只针对明确的重复噪声。内层识别了但正文完全不可认时回退管理器形状，不丢弃。
4. 混合命令（`npm test && git status`）仍按既有规则走通用展示，不把整份输出归给最后一个工具。

验证与边界：`organize.test.ts` 覆盖命令分类（run/exec/dlx/x 三分、PM 头、混合段）、`npm test`→vitest、`yarn test`→tsc、
`bun run test` 的 `$` 回显、echo 指向未识别工具时的正文嗅探、install 摘要+错误块+warn 折叠，以及 `shell.exec` 生产链上
npm 包裹 vitest 的整理结果。未实测 yarn berry（无回显，靠嗅探）与 pnpm 递归脚本；声明式规则与模型总结仍未接。

### D-247 — D-241 返工：包管理器输出整理修正

背景：D-241 接入了包管理器通配层，但验收发现四处缺陷——exec/dlx/x 后未知二进制
被标为 package-manager 而非 generic、所有 `npm warn` 行被折叠丢失唯一 warning、
进度行含 failed/error/checksum/permission 也被折叠、非零退出时可能解释失败的
manager 行未进 required。

决定（supersedes in part D-241 的 exec 未知二进制路由、噪声折叠范围与非零退出
required 部分；D-241 的 PM 头归类、脚本回显识别内层工具、PM 噪声折叠主体保留）：

1. **exec/dlx/x 未知二进制走 generic**：`classifySegment` 在 `WRAPPER_EXEC_SUB`
   分支内直接判断 wrapped 二进制——受支持工具返回其 kind，未知二进制返回 `unknown`，
   不再 fall through 到 `package-manager`。`pnpm dlx custom-tool` 的输出走 generic
   组织，PM 噪声折叠不会隐藏未知工具自身输出。
2. **只折叠可证明重复的噪声**：`isFoldableNoise` 区分 failure-relevant 噪声
   （含 failed/error/checksum/permission/denied/EACCES/EPERM/ENOENT/EBADENGINE/
   ERESOLVE）与可折叠噪声。Warning 行按内容去重——首次出现的唯一 warning 保留，
   重复相同 warning 才折叠。进度/下载行（非 warning、非 failure-relevant）仍可折叠。
3. **非零退出时失败解释行进 required**：`organizePackageManager` 在 `exitCode !== 0`
   时把 failure-relevant 噪声与唯一 warning 放入 `required`（fitBlocks 不裁切），
   而非 `optional`。成功退出时它们进 `optional`，预算压力下可裁切。
4. **原契约不变**：原 stdout、UTF-8 byte cursor、exitCode、OutputRef、显式分页与
   后台增量保持原契约——组织只影响 display text。

验证：`organize.test.ts`（未知 `pnpm dlx custom-tool` 走 generic；唯一 warning
保留、重复折叠；checksum failure 进度行保留；EBADENGINE 唯一 warning 在非零退出
进 required；watch/interactive prompt 保留；分片输出首尾保留）；既有 31 项 organize
与 3 项 observation-services 套件回归通过。
