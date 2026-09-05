# Agent harness 实施计划

Status: execution plan for agent-harness.md; delete when all slices are delivered

Last updated: 2026-09-05

这是 [agent-harness.md](agent-harness.md) 的执行计划。设计决定在设计文档里，那是**边界**；本文给出每个工作项的
**参考形状**——接口、算法、文本模板、测试要点——省掉从零设计的时间，但实施中遇到的实际情况由执行者临场判断，在边界内
调整，事后验收。仓库惯例：执行计划是临时文档，全部纵切交付后删除，交付记录进 [roadmap.md](roadmap.md)；能力的当前
状态**只**记在 [agent-harness-status.md](agent-harness-status.md)。

本文 2026-09-04 重排：阶段 0、1、1b 已交付，其参考形状已从本文移除（rationale 在决策日志，现行契约在设计文档与
`lib/harness/DOCUMENTATION.md`）；阶段 2、3、3b 保留未完成项的参考形状；新增 **P0 integrity 纵切**（0.6 节），在一切
新功能之前执行。

## 0. 执行者须知

### 0.1 工作方式

- **边界与参考的区分。** 设计文档的决策表（agent-harness.md 第 2 节）与本文 0.4 的不变量是边界，不得越过。本文其余内容——
  接口签名、字段名、算法步骤、文本模板、测试清单、默认值——是参考形状：默认照着做，因为它们已经考虑过缓存、恢复、安全
  与 UI 的联动；但当实际代码、Pi 的真实行为或平台差异说明另一种形状更好时，**按你的判断改**，在报告里写一句"偏离了 X，
  因为 Y"。验收时一起看。
- **五类变更必须暂停该工作项**（D-038）：改**持久格式、数据 authority 或做破坏性迁移**；改**身份、安全默认值或能力边界**；
  **删除、重命名或不兼容修改**公共协议成员；**不改签名但改变已有方法的核心语义**（例：`wait` 从快照改为阻塞）；新增
  **不可逆的外部副作用**。遇到这五类，停下该项，把设计差异写成一条决策日志条目（类型 `待问`）提交验收，**继续做其他独立
  工作项**。这五类之外——新增可选字段、可选方法、内部重构、默认值调整——照常做，写决策日志，不等批准。触碰安全边界时
  把保守的一侧作为默认（默认阻断、默认不带凭据、默认询问），并在记录里标 `security`。
- **交付单位是可运行纵切，不是模块。** 一个纵切 = 协议 → host → worker → 一条真实 E2E 全部到位；缺任何一段只能在状态矩阵
  标 `implemented`（休眠），不得报告为交付。能力四级：`implemented`（模块 + 单测）→ `wired`（进入真实生产调用链）→
  `proven`（E2E / 故障注入 / 真实 smoke，证据链接到文件）→ `default-on`（普通用户默认启用；影响模型行为的能力另需回放
  对比，见设计 8.6）。只有 `proven` 算纵切完成。每次交付同步更新状态矩阵。
- **报告规则。** 每条"已实施"附代码位置（文件与符号）；"定义了但没有调用点"不算已实施；"推迟"必须说明为什么现有骨架
  （如 `pi-hooks-contract.test.ts` 的 faux provider 会话）不可用；测试数字必须来自 0.3 的命令实跑。**不做历史重写、不
  force-push**；误提交用正向删除提交处理。
- **范例文件是起点。** 每个工作项给了同仓库里形状相同的现有实现，新代码的结构、错误处理与测试组织与之一致，减少审阅
  成本。
- **测试覆盖清单里的行为，形式自定。** 清单是"至少要测到的事"，不是断言的逐字规格；不得为了通过而弱化断言或删除用例。
- **改动范围以列出的文件为预期。** 需要改更多文件很正常，报告里写明即可；不做与工作项无关的顺手重构。
- **锚点用 grep 确认。** 本文的行号与导出名是写作时核实的，实施前确认；代码已变化时按当前代码做，报告里更新锚点。
- **文件编辑只用编辑器工具。** 不用 PowerShell 的 `Set-Content` / `Out-File` 改含非 ASCII 的文件——按系统代码页重写会
  损坏 UTF-8。
- **模型可见文本用英文**（工具描述、结果文本、错误文本、提示片段），模板给出的是必含信息与形状，措辞可调；用户可见的 UI
  文本走 `@/lib/i18n`，每个新 key 在全部 catalog 中都要有翻译（`i18nParity.test.ts` 会检查）。
- **决策日志：判断做出的当下就写下来。** 执行者的上下文有限，压缩后细节会丢，所以任何偏离参考形状的决定、任何"实施前先
  验证"实验的结果、任何遇到的问题与选择的解法，**在做出决定的那一步立刻**追加到 [agent-harness-decisions.md](agent-harness-decisions.md)，
  不要等工作项结束再补。条目只追加，不改写旧条目（D-030）。**日志不是规格**：压缩发生后，继续工作前重读的是设计文档、
  本文当前工作项与状态矩阵，日志只解释"为什么"。被采纳的偏离由验收方回写设计文档或本文并在日志索引标 `folded-in`。
  默认值被调整（权重、阈值、间隔）时，同一提交里把新值写回本文对应位置。
- 一个纵切 = 一个提交组（协议 / host / worker / 测试 / 文档可以是几个提交，但一起交付）。提交信息：
  `feat(harness): <slice id> <summary>`，正文写：改动文件、新增 / 变更契约、跑过的测试与 smoke（平台）、未验证的部分、
  状态矩阵变化，以及本次涉及的决策日志条目编号。**没跑的写没跑。**

### 0.2 先读

[AGENTS.md](../AGENTS.md)、[development.md](development.md)、[agent-harness.md](agent-harness.md) 全文、
[architecture.md](architecture.md) 第 4–7 节、[native-workspace-recovery-design.md](native-workspace-recovery-design.md)。
每个工作项标注了设计文档的章节，实施前重读。

### 0.3 验证命令

```sh
bun run --cwd packages/protocol test
bun run --cwd packages/pi-host test          # tsx --test test/**/*.test.ts
bun run --cwd packages/runtime-broker test
bun run --cwd packages/web test              # vitest
bun run type-check && bun run lint           # 触碰 @piarium/protocol 或 @piarium/application-client 后
bun run test:docs && bun run docs:validate   # 触碰 docs/ 后
```

### 0.4 不变量（违反即回退）

1. worker 不持有 host 凭据、不直接打 host HTTP；一切经 1.1 的协议请求。
2. Zone 0 会话内逐字节不变；1.2 的契约测试是所有后续工作项的回归门。
3. 失败、空、不可用、过期是不同结果，绝不合并为"成功的空结果"。
4. 限值全部是可配置默认，不设硬上限。
5. 文件正文、命令输出、页面正文不进日志、事件载荷、URL。
6. 依赖未配置模型槽位的能力不注册或退化为无 LLM 路径，永不回退主模型。
7. 自动让位必须有明确契约：web 工具对启用的 `pi-web-access`，权限 fallback 对本会话实际发布的 `pi-permission-system` service；其他能力不靠猜插件存在而改变行为。
8. 主 agent 没有块编辑工具、没有标记工具；系统提示不出现"请维护记忆"类措辞。
9. host 侧的身份只来自 broker 信封与 host 注册表，永不来自 worker 载荷；每个经 host 中介的能力在 host 侧按 ActorContext、
   静态能力集与 workspace 包含做授权（设计 9.1.2）。
10. 持久记录的读取失败只有"文件不存在"可以当作空；损坏、权限、未来 schema 版本一律抛出且不得被下一次写入覆盖。
11. 线程的生命周期与正确性不依赖任何缓存续命机制；压缩接管不依赖未经回放验证的记忆块。

### 0.5 代码锚点（已核实，实施前用 grep 再确认）

| 用途 | 位置 |
| --- | --- |
| Pi 会话装配：进程内扩展 | `packages/pi-host/src/session-host.ts` ~L2635 `extensionFactories`，`createSessionFeaturesExtension` ~L2637 |
| Pi 会话装配：工具覆盖 | `packages/pi-host/src/session-host.ts` ~L2694 `customTools: createWorkspaceMutationJournalTools(...)` |
| 同名覆盖范例 | `packages/pi-host/src/workspace-mutation-journal.ts` |
| 进程内扩展范例 | `packages/pi-host/src/session-features.ts`（`createSessionFeaturesExtension`） |
| worker→host 请求范例 | 事件 `workspace.mutation.request` `packages/protocol/src/events.ts:97`；host 处理 `packages/web/application-host/lib/recovery/turn-coordinator.ts:325`；回复方法 `workspace.mutation.respond` `packages/protocol/src/methods.ts:185`；worker 接收 `packages/pi-host/src/host-controller.ts:1001`；worker 侧桥 `workspace-mutation-journal.ts` 的 `WorkspaceMutationJournalBridge` |
| 未日志化工具判定 | `turn-coordinator.ts` 用 `toolMutation()`（`@piarium/protocol` `HARNESS_TOOL_META`），已交付 |
| harness 请求通道 | `packages/protocol/src/harness.ts`（`HarnessServiceMap` / `HarnessRequestData`）；router `packages/web/application-host/lib/harness/router.ts`；bridge `packages/pi-host/src/harness/host-services-bridge.ts`；服务 `harness-services.ts` |
| broker 会话身份（P0.1 改动点） | `packages/runtime-broker/src/host-client.ts:340`（`session.snapshot` 赋 `#sessionId`）；`runtime-broker.ts:1582`（信封 `sessionId` 取 `client.sessionId`） |
| 线程注册表 | `packages/web/application-host/lib/harness/thread-registry.ts`；角色目录 `packages/protocol/src/harness-roles.ts` |
| 权限门 | `packages/protocol/src/permission-gate.ts`；`packages/pi-host/src/harness/permission-gate-extension.ts` |
| 真会话 e2e 骨架 | `packages/pi-host/test/harness/session-e2e.test.ts`（faux provider + 真 router，`extension.ui.request` 由测试应答） |
| Pi 类型 | `node_modules/.bun/@earendil-works+pi-coding-agent@*/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：`ToolDefinition`（L343：`name` / `label` / `description` / `promptSnippet?` / `promptGuidelines?` / `parameters`(TypeBox) / `executionMode?` / `execute(toolCallId, params, signal, onUpdate, ctx) → Promise<AgentToolResult>`）；`ExtensionContext`（`cwd`、`model`、`sessionManager`、`getContextUsage()`、`compact()`） |
| `AgentToolResult` | `pi-agent-core/dist/**/types.d.ts`：`{ content: (TextContent \| ImageContent)[]; details: T; usage?; addedToolNames? }` |
| 工具并发语义 | `pi-agent-core/dist/agent-loop.js`：`toolExecution ?? "parallel"`；任一工具 `executionMode: "sequential"` → 整批串行 |
| 缓存断点 | `pi-ai/dist/providers/anthropic-messages.js`：system、tools、最后一条 user 消息 |
| 终端运行时 | `packages/web/application-host/lib/terminal/runtime.ts` `createTerminalRuntime`；`shells.ts`；`DOCUMENTATION.md` |
| 内容搜索 | `packages/web/application-host/lib/search/content.ts` `createWorkspaceContentSearch`（结果为 `ready` / `empty` / `cancelled` / `failure`） |
| LSP | `packages/web/application-host/lib/lsp/supervisor.ts` `createLanguageSupervisor` |
| 文档权威 / 恢复 | `packages/web/application-host/lib/documents/`（`mutation-authority.ts` `WRITER_MODES`）、`lib/recovery/` |
| 原子设置存储 | `@piarium/settings-store` `createSettingsFileStore`（用例 `lib/documents/mutation-authority.ts:308`） |
| 服务契约参照 | `packages/extension-contract/src/services.ts` |
| 工具卡片渲染 | `packages/ui/src/components/chat/message/toolRenderers.tsx` |
| 恢复 UI | `packages/ui/src/components/pi-session/PiChatView.tsx` ~L532、`PiRecoveryDialog.tsx`、`piRecoveryPolicy.ts` |
| 内置扩展 / 基础 Pi 包 | `packages/extension-builtins/src/index.ts`；`packages/protocol/src/foundational-pi-packages.ts` |
| TriviumDB Node API | `D:\project\TDB\TriviumDB\triviumdb.d.ts`（`TriviumDB` 类：`insert` / `link` / `indexText` / `indexKeyword` / `search` / `searchHybrid` / `tql` / `createIndex` / `flush`；npm 包 `triviumdb`） |

### 0.7 当前顺序与本轮范围（2026-09-05，D-071/D-072）

**本轮只修订文档，不实现、不运行实验、不提交。** 用户已授权后续实施顺序由执行者判断；这不等于现在开始推进。
既有 P0/T1/T2/T3 交付保留；新发现的缺口列入状态矩阵，不用新设计覆盖已有交付事实，也不把设计接受当作实现完成。

后续按能够独立形成可用结果的范围推进：

1. **已启用路径的正确性**：keeper expected revision、分支来源与 plan 所有权；观察结果生成/送达水位；核实完整输出的实际可恢复性。
   接管保持关闭，先补覆盖检查点与必要来源契约；不先建设通用证据仓库或完整 Work Graph。
2. **最小实验记录**：沿已有 session launch 增加单会话配置与实际执行配置记录，补主/辅助用量、耗时、失败归因；区分 record-only/assist/takeover。
   不要求完整跨 runtime RunManifest 先完成，不修改全局设置跑比较。真实记忆验证由用户招募测试者完成，本地不安排付费模型实验。
3. **版本化读取与检索**：默认自动取得发起消息窗口的草稿，先贯通来源/版本/片段；独立 retrieval replay 的 B0/B1 可先建立，
   explore 的纯算法候选与可用来源逐步接入，始终 default-off，不等待所有图边、co-change 或向量能力。
4. **结果、验证与集成**：随消费者把报告/验证绑定明确代码修订，合并指定结果并记录父状态、暂存区与恢复影响，再处理归档/回收。

TriviumDB 优先保留，问题先交用户联系作者，不启动 SQLite 迁移；`check` 是执行检查角色，不称只读、不加“测试不能写文件”的门；
不强制每次检查创建副本。Windows 沙箱不在交付计划中；原有 macOS/Linux smoke、Electron 打包与真实外部服务验证仍按能力分别记阻塞。
其余 status 本地可实施任务按依赖继续安排，不因上述顺序一律暂停，也不追加猜测性全局配额或单 Host 禁入规则。

## 阶段 0 / 1 / 1b：已交付

阶段 0（前置）、1（工具与 host 服务）、1b（web）的工作项已交付，参考形状从本文移除。当前状态与已知缺口在
[agent-harness-status.md](agent-harness-status.md)；契约在 `packages/protocol/README.md`、`lib/harness/DOCUMENTATION.md`、
`packages/pi-host/src/harness/README.md`；理由在决策日志 D-001–D-018。仍开着的缺口（都在状态矩阵 Blocker 列）：
harness shell 未接进 terminal runtime（D-013 的前置条件）；`websearch` 已接 Brave/Exa/Tavily/Jina/SearXNG、search-only Pi auth
凭据、Settings 与真实 Pi 回合，未配置时仍不注册；reader 已改为 pi-host session-local model 路径并经真实 Pi 回合验证，不再依赖休眠的 Host `web.read`；macOS /
Linux 的 bash smoke 未做。1.4 大文件句柄与 1.6 诊断已分别经真实 Pi agent loop、真实 fixture LSP
进程验证并修正 publication/version 时序（D-065）。其余缺口随相关纵切一起收，不单独立项。

## P0：integrity 纵切（一切新功能之前）

设计：agent-harness.md 第 5.1、9.1.2、9.3.1 节；决策日志 D-032–D-036、D-038。**固定七项，做完立即进入 T1 线程纵切，
不顺手清其他债务。** 每一项都属于 0.1 的暂停类别（持久格式、身份、公共协议），因此本节就是它们的预先验收：按本节做
不需要再暂停；偏离本节要暂停。

### P0.1 broker 会话身份 pin

- 现状：`runtime-broker.ts:1582` 的信封 `sessionId` 取自 `client.sessionId`，而它在 `host-client.ts:340` 由 worker 自己
  发出的 `session.snapshot` 赋值——信封身份与载荷身份同源，都不可信。
- 做法：`session.open` / `session.create` 的**方法响应**成功后，broker 写入 `client.pin = { sessionId, workerGeneration }`
  （`workerGeneration` 用 `client.id` + broker 已有的 `runtimeGeneration`）。`session.snapshot` 只验证 `data.sessionId ===
  pin.sessionId` 并更新状态，不一致 → `diagnostic(level: "error", "protocol violation: session identity mismatch")`
  并忽略该事件。`session.closed` 只在 broker 发起的关闭成功或连接 / 进程确认终止时清 pin。未 pin 的 worker（含 catalog
  worker）发出的 `harness.request` 直接丢弃并记诊断。信封新增 `actor: ActorContext`（见 P0.2），由 broker 填。
- 若存在 worker 合法切换会话的路径，切换必须由 broker 发起并在方法响应后更新 pin；实施时确认并记决策日志。
- 测试（`packages/runtime-broker/test`）：伪造 `session.snapshot` 换 id → 被忽略且有诊断；未 pin worker 的 harness 请求
  被丢弃；正常 open → pin 正确；陈旧 generation 的迟到事件不影响当前会话。

### P0.2 Router `ActorContext` 与 Host 静态授权

- 契约（`packages/protocol/src/harness.ts`）：`HarnessRequestData` **删除 `sessionId`**；新增
  `ActorContext { authorityInstanceId; sessionId; runId?; workerId; workerGeneration; workspaceId | null; grantedCapabilities: HarnessCapability[] }`
  与 `HarnessCapability = 'read.search' | 'read.output' | 'read.lsp' | 'process.shell' | 'control.thread' | 'write.document'`。
  `HarnessError.code` 加 `'forbidden'`。
- Router：只从信封取 `actor`；`HarnessServiceContext` 用 `actor` 替代 `sessionId` / `workspaceId`。每个方法声明所需
  capability（表放 protocol：`HARNESS_METHOD_CAPABILITY`），router 在分派前检查 `actor.grantedCapabilities`，缺 →
  `forbidden`（不是 `denied`——`denied` 留给用户策略）。`fs.lock.paths[]`、`lsp.*`、`search.content` 的路径参数须在
  `actor.workspaceId` 的根内（复用 Documents 的 `allowed-roots` 判定），越界 → `forbidden`。
- 能力集来源（过渡）：host 在收到 broker 验证后的首次 `session.snapshot` 时，从该会话已经冻结的 `activeTools` 与 Host
  实际服务可用性推导并注册；例如真实存在 `bash` 才给 `process.shell`，线程工具与线程运行时同时存在才给
  `control.thread`。这比 Host 再读一遍可变设置更接近真实运行态；RunManifest 下发后收敛为显式单一来源（设计 12.2）。
- **不做**：allow / ask / deny、弹窗、重算用户策略——那是 pi-host 门的事（设计 9.1.2 真值表）。
- 测试：跨会话——会话 A 的 worker 请求 `shell.exec`，信封 actor 为 A，shell 只能是 A 的；伪造载荷不再有可伪造字段；
  `bash` 关闭的会话直接调 `shell.exec` → `forbidden`；`fs.lock` 越界路径 → `forbidden`；`router-bridge-contract.test.ts`
  与 `harness-e2e.test.ts` 迁到新信封形状。

### P0.3 注册表错误分类、schema 版本、启动对账

**状态（2026-09-04）**：已实施。每 workspace 一个原子 catalog，旧 parent 数组在 workspace 关系已知时导入且原文件保留；
启动对账逐 workspace 返回失败，不把损坏或权限错误读成空表。

- catalog 读取只吞 `ENOENT`；`JSON.parse` 失败、`EACCES`、`schemaVersion > 当前` 返回独立 typed failure，且**不写入
  cache**，之后的 persist 不会用空表覆盖。当前文件带 `{ schemaVersion: 2, workspaceId, threads, runs }`；无版本旧 parent
  数组按 0 在 workspace 关系已知时导入，schema 1 的 `traceHandle` 报告方向性迁入 `TranscriptRef`。
- 启动对账：host 起来后遍历已知工作区的注册表，所有 `workerState ∈ { starting, running }` 的 Run 标 `lost`
  （`outcome: lost`，`exitReason: "host restarted"`），线程 `attention` 按是否有未答问题保留；与 broker 当前 worker 列表
  交叉——broker 里有而注册表里没有的会话不属线程系统，忽略。
- 测试：损坏 JSON → 抛错、文件原样保留、随后写入不覆盖；EACCES 同；未来版本同；ENOENT → 空表；重启对账把 running
  标 lost。

### P0.4 最小 Thread + ThreadRun 与正交状态

**状态（2026-09-04）**：已实施。协议、Host registry、7 个 service 与 pi-host 工具已迁移；生产 Host 已创建 registry，
但 `control.thread` 在真实 child runtime 接通前仍不授予，避免再次暴露只会返回 unavailable 的休眠工具。

- 契约按设计 9.3.1 的两个类型替换 `ThreadRecord`；`parent: { kind: 'session' | 'thread', id }`；事件
  `harness.thread.changed` 载荷改为 `{ thread: 状态子集, activeRun?: 状态子集 }`；`harness.thread.done` 不变。
- 注册表：`createThread` / `startRun`（新 Run，`attempt + 1`，`workerState: starting`）/ `markRunRunning` /
  `endRun(outcome, exitReason)` / `setAttention` / `setIntegration` / `archive`；删除 `resumeThread` 与 `markWorkerLost`。
  存储 `PIARIUM_DATA_DIR/threads/<hostId>/<workspaceId>.json`，原子写、按工作区串行；`eventSeq` 从持久化最大值恢复。
  并发槽位 = `lifecycle: active` 且 activeRun 的 `workerState ∈ { starting, running }` 的线程数；出队在 Run 结束时统一处理。
- `wait`（D-033）：只因目标线程的 `eventSeq` 变化、abort signal、显式 `timeout_ms` 返回；**删除** `DEFAULT_WAIT_TIMEOUT_MS`
  的 240s 默认，默认上限为 `HARNESS_MAX_REQUEST_TIMEOUT_MS`；`harness.wait.cacheKeepaliveWake`（默认 false）打开时才用
  `getTtl(providerId)` 作默认超时。`thread.list` / `thread.wait` 文本按 `attention` / `integration` 渲染，`waiting` 桶保留。
- 测试：状态维度独立变化（active + lost、settled + conflict）；崩溃 → Run 1 lost、Run 2 starting、`activeRunId` 更新、
  线程 `attention` 保留；`parent.kind: thread` 的嵌套线程；旧文件迁移；`wait` 无默认唤醒（用 200ms 传输默认证明不会被截断，
  用 abort 证明能中止）。

### P0.5 `OutputRef` / `TranscriptRef` 与 UTF-8 偏移

**状态（2026-09-04）**：已实施。`OutputRef` 使用 128-bit Host generation 与 128-bit HMAC，FIFO 水位区分 expired / not-found；
`TranscriptRef` 经 broker 的持久 Pi session entries 读取，catalog schema 1 报告方向性迁到 schema 2。

- `OutputStore`：句柄 `out_<hostEpoch>_<sequence>_<mac>`（epoch = 进程启动时随机 128 bit；MAC = HMAC(epochKey,
  session:seq) 截 128 bit）；每会话 `{ nextSequence, evictedThrough }`；淘汰 **FIFO**（写进模块文档为契约）；`read` 三态
  判定见设计 5.1；`dropSession` 清内容并推进同一会话的水位。`OutputSlice` 加 `nextOffset`、`eof`；所有 offset / length 为 UTF-8 字节，
  切片用 `Buffer.subarray` 并向最近的字符边界回退（不切开多字节序列）。`HarnessError.code` 加 `'expired'`。
- `ThreadReport.traceHandle` → `transcriptRef: TranscriptRef`；`read_thread(steps)` 经 broker `session.entries` 读
  `[fromEntryId, toEntryId]`。`tool-result-truncation` 与 `get_output` 文本里的 `[a-b of total]` 改为字节语义并带 `next`。
- 测试：中文 / emoji 输出的分页——`total` 与累计读取字节一致、无半个字符；重启后旧句柄 `expired`、伪造句柄 `not-found`、
  被淘汰句柄 `expired`；`dropSession` 后 `expired`；`nextOffset` / `eof` 正确；`transcriptRef` 落盘后 host 重启仍可读。

### P0.6 工作区级规范路径锁

**状态（2026-09-04）**：已实施。worker 一次提交完整 paths 批次；Host 用 Documents identity 规范化、去重、全序获取，
返回 owner-bound leaseId，`apply_patch` 的多文件操作共用一批租约。

- 键 `{ authorityId, workspaceId, canonicalResourceId }`，规范化复用 Documents authority 的路径身份（realpath、Windows
  大小写与 alias）；`fs.lock acquire` 接收 `paths[]` 并返回 `{ leaseIds[] }`，`release({ leaseId })` 不再携带路径；Host
  仍用 broker actor 的 ownerId 校验令牌归属，`withPathLock` 持 leaseId
  释放。进程内实现；模块文档写明保证："同一 Application Host authority 内，所有 Harness 管理的写操作按 workspace / resource
  互斥"，不声称阻止其他 host、终端、Git 或外部进程。
- 测试：两个会话同一文件串行、不同文件并行；`D:\A\..\B\f.ts` 与 `D:\B\F.TS`（Windows）归一；无 leaseId 的 release 失败；
  超时；异常释放。

### P0.7 故障注入与契约测试

**状态（2026-09-04）**：已实施。四类证据分别落在 runtime-broker identity、thread registry schema/reconcile、
OutputRef/UTF-8、path authority/lease 与三段 bridge E2E；本轮 protocol 59、Host harness 275、pi-host 245（另 1 个既有
平台 skip）通过。

- 覆盖上面六项的四类：**崩溃**（host 重启后注册表对账、句柄 expired、transcriptRef 可读）、**损坏**（注册表 JSON 损坏 /
  权限错误 / 未来版本）、**跨会话**（伪造 snapshot、伪造载荷、A 请求不能碰 B 的 shell / 线程 / 锁）、**Unicode**（输出分页）。
- 契约：`packages/protocol/test` 覆盖 `ActorContext`、`HarnessCapability`、`Thread` / `ThreadRun`、`OutputSlice` 新字段、
  错误码 `forbidden` / `expired`；`packages/protocol/README.md` 与 `architecture.md` §5 同步。
- 完成标准：0.3 全部命令绿；状态矩阵中 1.1 / 1.4 / 1.7 / 3.4 的 Blocker 列清空对应项；D-032–D-036 在索引标 `folded-in`。

### P0 之后的顺序

T1 **真实 child session 的线程纵切（核心已于 2026-09-04 交付）**（一个 Thread、一个 Pi Run、一个 worktree；dispatch / send /
wait / cancel / report / merge；worker 与 host 崩溃恢复；活性与等待传感器；Fleet；最小线程侧栏；先不做嵌套与自动 review）→
T2 **权限纵切（2026-09-04 已交付）**（Host capability / scope enforcement + pi-host fallback + 插件单一提示所有权；保留成熟插件）→ T3 **上下文 shadow mode（核心纵切已于 2026-09-04 交付）**（Documents / user-change LSP → Zone 2 真材料；相关 knowledge 与 blocks；用户显式 memory shadow，不接管压缩）→ T4 **最小回放集**（设计 8.6）→ 由回放数据决定压缩接管、记忆 agent
模型、TTL 唤醒实验。阶段 4（默认 runtime）并行；阶段 5、6 暂停到 T1 `proven`。

## 阶段 2：上下文层

设计：agent-harness.md 第 7、8 节。依赖 1.1、1.4、1.8。

**状态（2026-09-04）**：T3 核心 shadow 纵切已交付：Documents 与用户修改后的 LSP 诊断写入事件库，Zone 2 用耐久会话消息中的
event cursor 增量投影；blocks、context usage 与 prompt-relevant accepted knowledge 已接；memory shadow 由用户显式开启、使用
活动会话模型、Host 验证块操作，压缩接管默认关闭；低置信度 todo 在 pi-host 真 UI 同会话只问一次。Git 已复用两个现有 status
刷新边界并按 session 去重；block 的 workspace/user 知识标记与审阅已接进会话状态侧栏；仍缺 user terminal 的 shell integration、
其余知识建议触发与 memory 事件加速。这些剩余产品面不阻塞先建立
T4 回放基线。当前工作的具体顺序已由 0.7 更新。

**T4 当前状态（2026-09-04）**：`evaluation/harness/cases.json` 已固定 6 个来自 Piarium 历史的任务、base/reference commit、原始任务
与可观察验收；`scripts/harness-replay.mjs` 可校验清单、创建不覆盖的 run record、记录 success/tokens/interventions 与失败类别、按
case/model/pair 汇总 native 和 harness-shadow。它不会调用模型或修改全局设置。真实自动执行仍需 per-session Harness profile
override；在此之前由操作者显式建 checkout、切同一模型并运行两种变体，不能用脚本暗改用户 settings 充数。
压缩接管（2.6 第 2 档）与记忆 agent 的模型选择等 T4 回放数据（设计 8.6）。下列参考形状对未完成部分仍有效；已交付部分
的形状以代码与 `lib/knowledge/DOCUMENTATION.md` 为准。已被决策日志修正的点：2.1 的 TQL 与全零向量（D-019 / D-020，
设计 7.5）；2.4 的"前缀逐字节复用"是未验证假设（D-037，设计 8.4.1）；2.6 的保留范围用 Pi `preparation` 的切点、接管
要求 keeper 块（D-028，设计 8.4.2）。

### 2.1 知识库服务 v1

- 设计：agent-harness.md 第 7.1、7.2、7.2.1 节。
- host `lib/knowledge/store.ts`：

```ts
export const openWorkspaceKnowledge = (deps: { dataDir: string; hostId: string; workspaceId: string; embedding: EmbeddingProvider | null }) => Promise<KnowledgeStore>;
export interface KnowledgeStore {
  readonly dim: number;                       // 有 embedding 时为其 dim（默认 1024），否则占位 8
  putEvent(e: EventInput): Promise<NodeId>;   // payload: { type:'event', kind:'edit'|'command'|'diagnostic'|'turn'|'source'|'user-mark', at, sessionId, turnIndex?, text, refs?: { path?, journalObject?, url?, handle? }, source: 'agent'|'user'|'external' }
  putSession(s: { sessionId; profile; workspaceId; startedAt; harness: unknown }): Promise<NodeId>;
  getBlocks(sessionId): Promise<Block[]>; upsertBlock(b: { sessionId; label; content; updatedBy: 'agent'|'memory-agent'|'user'; cursorTurn?: number }): Promise<Block>; deleteBlock(sessionId, label): Promise<void>;
  putKnowledge(k: KnowledgeInput): Promise<NodeId>; listKnowledge(filter: { scope?; status?; activeOnly?: boolean }): Promise<Knowledge[]>; acceptKnowledge(id, opts: { supersedes?: NodeId[] }): Promise<void>; dismissKnowledge(id): Promise<void>; recordRecall(ids: NodeId[]): Promise<void>;
  recall(query: string, k: number): Promise<Array<{ node: KnowledgeOrEvent; score: number; via: 'text'|'vector'|'graph' }>>;   // 无向量时 searchHybrid 的向量项关闭
  deleteSession(sessionId): Promise<void>;     // 级联 event / block
  runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }>;
  close(): Promise<void>;
}
```

  TriviumDB 用法：`new TriviumDB(path, { dim })`；每个节点 `insert(vector, payload)`，payload 含 `type` 字段；`indexText(id,
  text)` 对 event / block / knowledge 正文；`indexKeyword(id, kw)` 对 knowledge 的触发描述分词与（阶段 3）符号名；边用
  `link(src, dst, label, weight)`；`createIndex('type')`、`createIndex('sessionId')`、`createOrderedIndex('at')`。占位向量
  模式当前是 `dim = 8` 全零占位，查询在 JS 层过滤/词项匹配（D-019/D-020）；不再执行已被实验否定的“直接用占位向量 hybrid”参考形状，
  也不用单位向量制造虚假相似度。后续先确认数据库本身的类型过滤与文本/混合查询契约，再替换对应绕路。会话事件、块、有效知识和
  取代链由 Piarium 领域接口表达，不把 TQL 写成上层必须依赖的协议。
  保留：`runRetention` 由 host 空闲调度（复用现有空闲检测），删除 `at < now - eventRetentionDays` 的 event 与已结束会话
  的 block；每次至多删 5000 个节点后 `flush()`。
  两个 host：`packages/web/cli` 的 `serve` 启动时探测桌面 host（现有的实例发现路径 `discoverPiariumInstanceOnPort` /
  `isDesktopRuntimeForPort`），存在则连接复用而不起新 host。
- 打包：`triviumdb` 依赖加入 `packages/web`；Electron 侧加入 asar unpack 列表与重建（照 `better-sqlite3` 的处理，grep
  `better-sqlite3` 于 `packages/electron` 找到全部位置）。
- 测试：建库与 schema；级联删除；保留；只读 Reader 并发读；占位向量模式 `recall`；Electron 打包 smoke（`packages/electron`
  现有 smoke 加载 `triviumdb`）。
- 判断要点：用户可联系 TriviumDB 作者处理数据库问题，优先保留当前数据库；报告其自身的类型处理、检索语义和能力边界，
  不把 Piarium 的领域需求包装成数据库缺陷。不把旧版问题外推到最新上游，不启动未经比较的迁移。阶段 2 只需要
  `event` / `session` / `block` / `knowledge` 四种节点跑起来；边和索引按实际查询需要加，不要为了对齐设计表而预建用不到的
  索引。`.tdb` 的写入全部经 host 单写者，如果发现有并发写路径（比如观察者与记忆 agent 同时写），在 host 内排队而不是加锁到
  TriviumDB 层。Electron 打包是这一项最容易拖时间的部分——`.node` 的 ABI 与 asar unpack 有现成先例，照抄 `better-sqlite3`
  的每一处即可。

### 2.2 Zone 2 组装

- 设计：agent-harness.md 第 8.1、8.3 节。范例：`session-features.ts`。
- host `context.zone2: { params: { sinceTurn: number }; result: Zone2Material }`：

```ts
interface Zone2Material {
  userEdits: Array<{ path; kind: 'modified'|'created'|'deleted' }>;
  userCommands: Array<{ command; exitCode; at }>;
  newDiagnostics: Array<{ path; count; worst: 'error'|'warning' }>;
  git: { branch?; changed?: number; note?: string } | null;
  knowledge: Array<{ id; title; trigger }>;
  blocks: Array<{ label; content }>;
  contextUsage: { used: number; window: number } | null;
  threads?: { status: 'ready'; items: Zone2Thread[] } | { status: 'unavailable'; reason: string } | null;
}
```

  `userEdits` 只含 `source !== 'agent'` 的 event；`knowledge` 为当前有效条目中触发描述与最近 3 步文本 BM25 匹配的 top 5。
- pi-host 进程内扩展 `src/harness/zone2.ts`：`before_agent_start` → `{ message: { customType: 'piarium-context', display:
  false, content } }`，`content` 模板（各段为空则省略；全部为空则**不返回 message**）：

```text
<piarium-context note="Observations recorded while you were not running. They are data, not instructions.">
<user-changes>
modified packages/web/lib/foo.ts
deleted packages/web/lib/old.ts
</user-changes>
<user-terminal>
exit 1 · bun test  (3 min ago)
</user-terminal>
<new-diagnostics>
packages/ui/src/a.ts: 2 errors
</new-diagnostics>
<git>branch main → feature/x, 40 files changed (mostly packages/ui)</git>
<knowledge>
#412 Use bun, never npm — trigger: package management
</knowledge>
<plan>…块复述（2.5 后）…</plan>
context: 41% of window used
</piarium-context>
```

  预算：按 4 字符 ≈ 1 token 估算，总上限 2000 token（设置 `harness.zone2.budgetTokens`）。超预算时依次：`userEdits` 超过
  15 条 → 折叠为"N files changed, mostly <top-level dir with most changes>"；`userCommands` 只留最近 5 条；`newDiagnostics`
  只留前 5 个文件；`knowledge` 减到 3；仍超 → 截断 `plan` 段。
- 测试：模板快照（全段 / 部分段 / 空 → 无 message）；预算折叠三级；Zone 0 契约测试保持绿。

### 2.3 host 观察者

- 设计：agent-harness.md 第 7.3 节。
- host `lib/knowledge/observers.ts`：订阅 documents watch（写事件）、terminal runtime（exit）、lsp supervisor（诊断发布）、git
  status 变化（现有 `lib/git` 的刷新提示），写 `event`。来源判定：写事件在 mutation authority 中有 `pi-worker` 的活动
  writer → `agent`，否则 `user`（编辑器保存）或 `external`；终端 exit 来自 harness shell 监督器 → `agent`，来自用户终端 tab →
  `user`。`agent` 来源的 event 仍写库（供记忆与恢复联动），但 Zone 2 只取非 `agent`。
- 测试：三路各一条；agent 编辑标 `agent`；用户保存标 `user`。

### 2.4 记忆 agent

- 设计：agent-harness.md 第 8.4.1 节。
- 当前模型调度在 pi-host `src/harness/memory-agent-extension.ts`，Host `lib/harness/memory-agent.ts` 只校验和提交块操作。
  保留 `memory_edit` 与用户开启后使用活动模型的现状，不重建 Host 模型栈、不开展输出协议或缓存付费实验。
- **D-076 已接的正确性**：get 返回活动祖先路径上每个 label 最近的 block 修订；apply 携带读取时版本、来源 leaf 与实际 context entry。
  Store 以 copy-on-write/tombstone 保留兄弟分支，create/update/delete 在写队列内 CAS，同一块多操作前传 revision；keeper 只可 mark plan。
  UI route 从 Host 活动 Pi session 自动解析分支，todo、Zone 2、compaction、thread snapshot 同路。部分失败不推进覆盖；Host 崩溃只丢
  内存水位并回退 Pi。真实多分支与语义质量仍需测试者验证。
- 关闭保持默认；已有 `shadowMode:true` 对应 assist（块进入 Zone 2，Pi 压缩）。record-only 仅记录/展示、不注入主请求，待增加；
  takeover 需 2.6 的覆盖契约与测试者证据。模式迁移保留用户既有 assist 行为。

  门控（表驱动实现，测试用同一张表）：

| 条件 | 结果 |
| --- | --- |
| `contextTokens < 10_000` 且从未运行 | 不跑 |
| 有运行在飞 | 不跑 |
| 距上次结束 `< 30 s` | 不跑 |
| `contextTokens - lastRunTokens >= interval` 且（`toolCallsSinceLastRun >= 3` 或 `lastStepHadNoTools`） | 跑 |
| 事件加速（任一事件） | 跑（仍受"在飞"与 30 s 约束） |
| 上次运行未改动任何块 | `interval = min(interval * 1.5, 20_000)`；有改动 → `interval = 5_000` |

  当前请求从 Pi `context` hook 的可用消息及本步结果构造，追加当前块与维护任务。工具集不同，不保证复用主请求缓存。
  下列维护指令只是参考文本，来源内容仍按数据处理：

```text
You are the memory keeper for this session. Below are the current memory blocks and the turn cursor. Read the full
conversation above and update the blocks so that they describe the CURRENT state of the work: progress, decisions
and their reasons, errors and how they were fixed, learnings, open questions. Rewrite in place; do not append logs.
Respect per-block budgets. Do not change the structure of the "plan" block; you may only mark its items done or
blocked. Emit edits through the memory_edit tool only.
<blocks cursor="turn 42">
[progress]
…
</blocks>
```

  仅接受 `memory_edit` 的结构化操作；当前 pi-ai 通用路径使用 `toolChoice:auto`，未返回该调用视为未更新，不伪称强制成功。参考 schema：

```ts
{ ops: Array<
  | { op: 'replace'; block: string; content: string }               // 整块重写
  | { op: 'patch'; block: string; find: string; replace: string }   // 局部替换，find 必须唯一
  | { op: 'create'; block: string; content: string }
  | { op: 'delete'; block: string }
  | { op: 'mark_plan'; item: number; status: 'done' | 'blocked' | 'open' } > }
```

  应用与校验：块名 `^[a-z][a-z0-9_-]{0,31}$`；`plan` 只接受 `mark_plan`；每块 ≤ `blockBudgetTokens`（默认 2000）；总量 ≤
  `totalBudgetTokens`（默认 12000），超出拒绝该 op 并记录；`updatedBy: 'memory-agent'`，`cursorTurn`。模型固定主模型。
- pi-host 在本地评估门控；事件加速仍需接线。每次真实调用的用量、无效输出和失败都要归因，不能因为未更新块就漏计费用。
- 测试：用户编辑后旧 patch/replace/delete 被拒；后代更新不改兄弟、删除为 branch tombstone、同 label 只取最近祖先、create 并发不覆盖；
  plan 只能标状态；partial apply 不推进覆盖；record-only 不注入、assist 不接管。沿现有真 Pi faux-provider 骨架验证，不调用付费 provider。
- 判断要点：主 agent 不承担记忆维护；版本、分支、来源和费用必须诚实。门控参数先保持可配置现状，实际质量与缓存收益由测试者观察，
  不增加无定标的比例门槛，也不以缓存命中作为记忆正确性的前提。

### 2.5 `todo` 工具、`plan` 块与计划面板

- 设计：agent-harness.md 第 5.6 节。
- pi-host `todo`：schema `{ items: Array<{ text: string; status: 'open' | 'done' | 'blocked' }>; confidence?: number (0-1) }`；
  整表替换 `plan` 块（`updatedBy: 'agent'`），内容渲染为 `- [ ] text` / `- [x] text` / `- [!] text` 行；返回文本
  `plan updated: ${done}/${total} done${blocked ? `, ${blocked} blocked` : ''}`。`confidence < settings.plan.confirmBelow`
  （默认 0.6）且会话尚未确认过 → 通过现有 permission 询问通道发起一次确认（文案 i18n `chat.plan.confirm`），确认后本
  会话不再问。`promptGuidelines`：`["For non-trivial tasks, write a short plan with todo before acting, and state your confidence."]`
  ——仅此一句，不出现"维护 / 更新记忆"等措辞。
- UI：计划面板（新组件 + `usePlanStore`），显示块内容、每次改动来源；用户编辑 → `upsertBlock(updatedBy:'user')` →
  下一步 Zone 2 `plan` 段前置一行 `(edited by user)`。
- 测试：整表替换；确认只问一次；用户编辑标记。

### 2.6 接管压缩

- 设计：agent-harness.md 第 8.4.2–8.4.4 节。
- **前置实验（先做，结论写回设计文档 12.2）**：fake provider 下触发 `session_before_compact`，返回构造的 `CompactionResult`
  （摘要 = 固定字符串，`firstKeptEntryId` = 最近 K 步的起点），检查 Pi 之后发给 provider 的 `messages`：(a) 切除段是否被一条
  摘要消息替代；(b) 保留段的 tool_use / tool_result 配对是否完好；(c) 是否有 Pi 自己再次摘要。三条都满足 → 按下文实现；
  否则选替代路径——优先用 `context` 钩子在每次请求前把切除段投影为摘要块（Pi 的会话文件不动），其次 `before_provider_request`
  改写载荷——把观察到的消息序列与选择写进决策记录，继续。
- pi-host `src/harness/compaction.ts`：`session_before_compact` → 从 host 取 `compaction.materials: { blocks, plan, facts:
  { touchedFiles: string[]; unresolvedDiagnostics: Array<{path;count}>; checkpoints: string[] }, recentTurnsToKeep: K }`，
  组装摘要文本：

```text
<piarium-compaction note="State carried across compaction. Blocks are maintained by the memory keeper; facts come from the host.">
<plan>…</plan>
<blocks>
[progress] …
[decisions] …
</blocks>
<facts>
files touched: a.ts, b.ts (+12 more)
unresolved diagnostics: c.ts (2)
last checkpoint: 2026-09-03T10:12Z
</facts>
</piarium-compaction>
```

  `firstKeptEntryId` 只取 Pi 支持的安全切点，不自行按 K 步计算。D-076 以 `buildContextEntries()` 的真实 context-producing entry IDs
  记录 keeper 覆盖；压缩按上一次 Pi compaction boundary 与本次 first-kept 推导移除区间。缺区间、错分支、partial patch 或必要来源
  不可用时不接管。水位在 block 成功后更新，崩溃窗口保守回退，不声称跨重启持久 checkpoint；不能只附 stale note 后删除缺口。
  压缩后重注入按实际请求中丢失的版本/片段与可用来源决定，仍是待实现；不把“最近 read 过这个路径”当成当前有效正文证明。
- 触发：host 在子任务边界（测试 / 构建命令结束、`todo` 条目勾掉、上一步无工具）且 `contextUsage >= threshold`（默认 0.8）
  时调用 `ctx.compact()`；用户空闲超过 provider TTL 且积压时同样。压缩计数写入 Zone 2（`compactions: 3`）与 UI 信息条。
- 第 1 档：provider 为 Anthropic 且 pi-ai 暴露 `cache_edits` 类能力时，在阈值 0.6 处先清除 5 步以前的 tool_result 正文
  （保留句柄行）；能力探测失败则跳过。**实施前确认 pi-ai 是否暴露该能力**，不暴露则跳过此档并在决策记录写明（可附一句
  是否值得向 Pi 上游提需求的判断）。
- UI：时间线压缩分隔标记（i18n `chat.timeline.compacted`）；composer 不因压缩锁定。
- 测试：正确分支与连续区间覆盖；处理到 100 而切到 121 时缺口不被接管删除；tool call/result 配对；块并发修改；原始正文仅临时
  可得、Host 重启后来源过期的降级；assist 始终交还 Pi。D-022 已验证钩子消费，不重复开展同一前置实验。
- 不嵌套旧摘要文本不能证明没有累计语义损失。测试者用多次压缩后的早期约束、放弃方案理由和未解决问题检查语义质量；本地不安排
  付费模型对照。必要来源必须真能读取，不以 TranscriptRef 名称或内容 hash 代替正文持久性。

### 2.7 知识建议、审阅托盘、双时态取代

- 设计：agent-harness.md 第 7.2.2 节。
- 触发（只这三类，不做启发式）：用户在 UI 上"记住这个"（消息 / 工具结果 / 块条目上的动作）；回合结束时记忆 agent 的
  `decisions` 块相对上一回合新增的条目；用户消息中显式的模式仅当 `models.suggestions` 配置时由该模型判断（提示：
  "Does this user message state a durable preference or correction that should apply to future sessions? Answer with a
  JSON suggestion or null"），未配置则不判断。
- host：`knowledge.suggest` 生成 `{ status: 'suggested', scope: 'workspace', content, trigger, source: { sessionId, kind } }`；
  `models.suggestions` 配置时用它草拟 `content` 与 `trigger`（提示固定，输出 JSON），否则 `content` = 原文、`trigger` = ''。
  接受：`acceptKnowledge(id, { supersedes })`——同 scope 现有条目只要触发词有交集就作为候选并排序，`supersedes` 必须由 UI 用户
  勾选；旧条目 `invalid_at = now`，边 `supersedes`。自动接受：`settings.knowledge.
  autoAcceptSuggestions.{workspace,user}` 默认 false。
- UI：会话状态侧栏审阅区：编辑 / 接受 / 驳回；Settings 知识页：
  当前有效列表、取代链展开、`recallCount` / `recalledAt` 排序、删除。
- 测试：三类触发；草拟有无模型两路；取代链；默认不自动接受；召回计数（配合 2.2）。
  - **状态（2026-09-04）**：block 与持久 user/assistant/tool result 上“记到项目/记到用户”→ authenticated routes → scope store →
  审阅卡 → 冲突检查编辑/接受/驳回 → SSE 失效通知已 proven。接受把最终草稿、打开时原值和 supersedes 在同一 store 写任务内处理。
  memory decisions 的结构化新增已机械提议并对全部历史状态去重；suggestions model 的用户消息提议与 Settings 全量管理尚未接；
  未接部分不调模型、不写知识（D-058/D-060/D-061）。

### 2.8 embedding provider 抽象

- host `lib/knowledge/embedding.ts`：`interface EmbeddingProvider { id; model; dim; embed(texts: string[]): Promise<number[][]> }`；
  适配器：OpenAI（`text-embedding-3-*`，`dimensions` 参数截到 1024）、Voyage、Mistral、Gemini、Jina、Cohere、OpenAI 兼容
  端点（base URL + model）；凭据走 provider 凭据路径。store 元数据 `{ provider, model, dim }` 存于 `.tdb` 同目录的
  `meta.json`；切换 → 后台按批（100 条）重算全部有向量节点，写入新代 `.tdb`，完成后 `publishGenerationManifest`（TriviumDB
  API）切换，旧代按 Reader 租约回收。未配置 → 占位模式。每个 provider 首次启用需用户在 Settings 确认（与远程模型
  provider 同一确认 UI）。
- 测试：适配器 fake HTTP；维度校验（返回维度 ≠ 声明 → 失败不写）；重算与代际切换；未确认不启用。

### 2.9 模型槽位设置

**状态（2026-09-05）**：槽位解析与 provider 目录驱动的三套轻量预设已归 `@piarium/protocol`；Settings 可逐槽位选择并只用
预设填补空槽位；reader / permissionJudge 的真实 `completeSimple` 用量进入 `SessionStats.modelSlotUsage` 与 Context sidebar，
委派角色用量由 `ThreadRun` 按 role/model 记录。未发生调用的槽位不造 0。

- Settings `harness.models`（1.9 的 schema）：九个槽位 + `permissionJudge`（3b 用）；`hardImplement` 与 `review` 未设时
  解析为主模型，其余未设即未配置。预设：`applyPreset('anthropic' | 'openai' | 'gemini')` 填表——Anthropic：
  explore / retrievalAgent / quickImplement / check / reader / suggestions = 当前 provider 的 Haiku 系；OpenAI：mini / nano
  系；Gemini：Flash 系；具体型号从 provider 的模型目录里按名称匹配，匹配不到则不填。
- protocol `resolveHarnessModelSlot(slot): { providerId; modelId } | null`；会话内辅助调用按 `slot` 进入计数器，委派角色由
  `ThreadRun` 记录，避免在父会话重复累计。
- 测试：解析规则；预设填充后可覆盖；未配置 → 依赖能力不注册（与 3.6、1b.2、2.7 联动）。

### 2.10 `recall` 与 `user.tdb`

- pi-host `recall(query, k = 5)`：文本 `${n} memories for "${query}"\n` + 每条 `- [${scope}] ${title or first line} (${via}, #${id})`；
  workspace 库与 user 库合并按分值排序；`promptSnippet: 'recall: search this workspace\'s memory of past sessions and decisions'`。
- host：`user.tdb` 在 `PIARIUM_DATA_DIR/knowledge/{hostId}/user.tdb`，只允许 `knowledge` 节点；晋升 = 一条新的建议
  （`scope: 'user'`）。
- 测试：合并与来源标注；占位向量模式；user 库拒绝非 knowledge 写入。

### 阶段 2 完成标准

- faux provider 验证实际门控、版本/分支冲突、连续覆盖、Pi 安全切点和不同模式的请求投影；不从 fake provider 的 cache 值宣称真实缓存收益。
- 测试者验证用户编辑、早期约束、计划修正与多次压缩后的语义质量，记录真实用量/耗时，不安排本地付费模型实验。
- 知识建议进入托盘 → 接受 → Settings 显示；再接受一条冲突条目 → 取代链可见。

## 阶段 3：检索与子 agent

设计：agent-harness.md 第 6、9.2、9.3 节。依赖阶段 1 与 2.1 / 2.9。

**状态（2026-09-04）**：T1 核心纵切已经 `proven`：3.4 / 3.5 七个工具经 Host 能力握手默认接入真实 Pi child、冻结的
`ThreadLaunchManifest`、真实 Git worktree、崩溃恢复、活性/权限等待传感器、durable transcript、merge 与 Harness Fleet；3.10
已有父会话桌面最小侧栏，3.8 LSP 导航已通过 Host 能力门接入真实 LanguageSupervisor；父 Zone 2 已接 queued/active 快照与
settled 增量，含嵌套父边和压缩重置；dispatch 已携父 blocks 快照，settle 持久化 child blocks 与结构化 deviations/unresolved。
未完成边界以 `agent-harness-status.md` 为准：worktree/branch 回收与归档/恢复 UI。窄屏投影、时间线线程标记、用户讨论线及转实现
纵切已接通；child 结果已先提交到持久分支；
旧 role budget 数字没有执行原语或定标依据，
已按 D-056 删除而非升级成硬停止。
3.1 的 file/symbol/defines 已从 Documents/LSP 写入真实图；3.2 / 3.3 / 3.7 仍只是 `implemented`。

**3.4 / 3.5 的对象模型已由 P0.4 替代**：下文两节里的 `ThreadRecord` 单枚举 `status` + flags 的形状**不再有效**，以设计
9.3.1 的 Thread + ThreadRun 与正交维度为准；`wait` 不再有 TTL 默认唤醒（D-033）；报告里的 `traceHandle` 改为
`transcriptRef`（D-034）。两节保留的仍有效部分是：worktree 的创建与回收、活性传感器的判定、观察游标、Zone 2 threads 段、
`threads` / `wait` / `read_thread` 的文本模板与增量语义、`merge` 的 `git apply --3way`。它们与真实 child session 一起以
**T1 线程纵切**交付（P0 节末），T1 的范围是"一个 Thread、一个 Pi Run、一个 worktree；dispatch / send / wait / cancel /
report / merge；worker 与 host 崩溃恢复；最小侧栏"，嵌套与自动 review 不在 T1。

检索线按 0.7 与 3.2 推进：先建立独立 retrieval replay 的基线，纯算法 explore 保持默认关闭；真实使用的证据决定是否注册，
不把未接线的图/向量能力或完整 T4 自动执行器作为全部本地检索工作的前置。

### 3.1 符号图采集器

- host `lib/knowledge/symbols.ts`：Documents created/modified 后，仅当对应 LanguageSupervisor 已 ready/degraded 时请求
  `textDocument/documentSymbol`，写 `file` 节点与 `symbol` 节点，边 `file → defines → symbol`（weight 1）；符号名
  `indexKeyword`。每个文件独立换代，delete 删除该文件图。无服务器/未知语言只 touch file 并保留最后可用图；不做 Git 全量扫描。
- 测试：小仓库快照（用 fixture 语言服务器）；增量；无 LSP 退化。
- **状态（2026-09-04）**：真实 file/symbol/defines 在单文件 transaction 中换代，复用 LanguageSupervisor 当前 buffer/version，
  unavailable 与权威空结果分开；关键词 symbol search 已可供后续 explore 使用。references/calls/imports 尚未接，不能把每 symbol 的
  无界 LSP 扇出藏进写后 observer（D-059）。

### 3.2 `explore` 管线（v2 候选架构，D-069–D-072）

- 设计：agent-harness.md 第 6.1 节第二级——假设 H1–H4 与证据边界、三进程所有权、真实依赖图、参数三类、两级门禁都在那里。
  **状态**：候选架构；代码仍是 v1，pi-host 无工具定义。v1 的窗口只扩行号并拼命中，语义结果未用于排序、handle 未入 OutputStore，
  不能直接注册为退化路径。**本轮仅改文档**。
- **后续参考顺序**：先明确跨进程契约并建立检索专用回放的 B0/B1 基线；按可用来源实现纯算法 Engine 与 Coordinator，贯通当前内容
  物化、RRF、bundle 打包及真实输出句柄。不把每个算法阶段当成必须单独 proven 的纵切。可选模型机制后续按证据比较；只记反馈，
  不自动改权重。离线结果支持进入测试者真实使用，默认注册另行依据结果决定。

**所有权**（不能都写在 host）：

| 输入 / 职责 | 归属 | 现状 |
| --- | --- | --- |
| 问题文本、`paths` | pi-host Coordinator | 有 |
| 实际请求中可见的 revision/span 覆盖 | pi-host Coordinator（实际请求物化、截断与会话分支） | **无**：不能只从 read step 或 firstKeptEntryId 推断；未知覆盖时不省正文 |
| `models.explore` 调用（intent / judge）、槽位用量 | pi-host Coordinator（`completeSimple`，与 reader / permissionJudge 同路，D-068） | 有机制，无 explore 用法 |
| 最终请求 token 计量 | pi-host Coordinator | 知道模型不等于有 tokenizer；可得时精确计算，否则明确估算 |
| rg、LSP、符号图、git、Documents 脏状态、恢复日志、shell 输出、OutputStore | host `ExploreEngine` | 见依赖矩阵 |
| 本窗口草稿与当前文件/选区 | UI surface；用户消息自动传播来源，草稿默认可读，焦点是可选提示 | **无**；不增加开启/绑定操作，不让 worker snapshot 自报来源 |

**依赖矩阵**（缺失来源只能**降级并在结果里报告该来源的状态**，不得折叠成一个 `partial: true`）：

| 来源 | 状态 | 现有 | 缺口 |
| --- | --- | --- | --- |
| rg 内容搜索 | available | `search.content` | — |
| LSP `workspace/symbol` | partial | `lsp.symbols`（D-051）需先给一个 `path` 选语言 provider | 无跨语言通用符号索引；按种子文件逐语言发起，无种子文件时不可用 |
| LSP definition / references | partial | `lsp.definition` / `lsp.references`（D-051） | `references` 不是调用图，无 call hierarchy；返回路径需重新授权 |
| 符号图 | partial | `file → defines → symbol`，关键词 `searchSymbols`（D-059） | `references` / `calls` / `imports` 边未接；无 PageRank API；`searchSymbols` 是 JS 扫描 + 字符串计分，不是 AC / BM25 |
| `related` | unavailable | `related-tool.ts` 只接受注入的 `findNode` / `getNeighbors` | 无生产实现 |
| 脏缓冲正文 | unavailable | Documents authority 只发布路径、`baseRevision`、`localEditRevision` | 从自动识别的消息来源 surface 读不可变快照；断开时说明最新内容不可得；LSP 缓存不能冒充来源权威 |
| 脏路径与新近度 | available | Documents dirty publication、git status | — |
| 主上下文文件表 | unavailable | 恢复日志只知写、不知读 | pi-host 侧建（上表） |
| 会话触碰（写） | available | 恢复日志 | — |
| 最近失败命令输出 | partial | shell 监督器有输出存储 | 无"最近一条失败命令"入口，需加 |
| git co-change | unavailable | `lib/git` 有 status / blame 基础 | 需 `git log --name-only` 统计 + 缓存服务 |
| 测试 ↔ 源码配对 | unavailable | — | 纯命名规则，需实现 |
| 工作台焦点 / 选区 | unavailable | — | UI 可选提示协议 |
| tree-sitter 兜底切块 | unavailable | — | 优先 wasm 版；LSP 已覆盖的语言不需要 |
| embedding 语义召回 | partial | 知识库 embedding 模式（2.8 未接线） | 未配置即无此来源 |

- 下面是候选结果形状，**不是已存在的 protocol**。取消在 Coordinator/Engine 中传播并停止后续工作；具体时延/资源预算按已有服务与测量决定：

```ts
export type SourceStatus = 'not-requested' | 'ready' | 'empty' | 'unavailable' | 'failed' | 'stale' | 'timed-out' | 'cancelled';
export type ModelCallStatus = 'not-requested' | 'succeeded' | 'timed-out' | 'failed' | 'cancelled';
export type ExploreQuestionType = 'where' | 'how' | 'impact' | 'why' | 'unknown';
export interface ExploreSeeds {                // Coordinator 组装；可选来源缺失需独立报告
  question: string; paths?: string[];
  questionTypeHint?: ExploreQuestionType;      // Coordinator 的分类（中英文线索）或 intent 结果
  sourceSurface?: { surfaceId: string; generation: number }; // 随用户消息自动取得，非显式绑定设置
  inContext: Array<{ path: string; revision: string; startLine: number; endLine: number; requestGeneration: string; sourceEntryIds: string[] }>;
  sessionTouched: Array<{ path: string; kind: 'read' | 'edit'; step: number }>;
  focus?: { surfaceId: string; generation: number; revision: string; path: string; startLine?: number; endLine?: number };
  lastFailedCommandOutput?: string;
  lastExplore?: { targets: string[] };
  budgetBytes?: number;                         // 实验软预算；Host 计 UTF-8 字节
}
export interface ExploreSpan { id: string; path: string; symbol?: string; startLine: number; endLine: number; text: string; revision: string; sourceStatus: SourceStatus; provenance: { source: string; request?: string; surfaceId?: string; generation?: number } }
export interface ExploreBundle { id: string; target: ExploreSpan; why: string; support: Array<ExploreSpan & { role: 'definition' | 'reference' | 'test' | 'config' | 'cochange' }>; omittedSupport?: string[] }
export interface ModelAttempt { kind: 'intent' | 'judge' | 'repair'; status: ModelCallStatus; resultUse: 'used' | 'ignored' | 'none'; usageStatus: 'reported' | 'unavailable'; tokens?: number; cost?: number }
export interface ExploreResult {
  bundles: ExploreBundle[];                     // 目标 + 支撑；`where` 类可能只有 target
  alreadyInContext: ExploreSeeds['inContext'];    // 必须是真实可见覆盖，不是已读文件表
  gaps: string[];                               // 可观察缺口；RRF 分差不等于置信度
  questionType: ExploreQuestionType;
  sources: Record<string, { status: SourceStatus; ms: number; hits: number; note?: string }>;
  model: ModelAttempt[];                        // Coordinator 汇总，Engine 不调用模型
  droppedForAuthorization: number;              // LSP / 派生路径越界被丢弃的数量
  staleRiskPaths: string[];                     // 脏路径：正文来自磁盘、可能落后于编辑器
  partial: boolean; searched: { patterns: number; files: number; ms: number };
  handle?: OutputRef;                           // 只有已授权物化的正文可入实际 OutputStore
}
```

- 阶段（依赖图见设计 6.1）：
  0. `seed`：标识符覆盖 Unicode 字母/组合字符、语言允许的 `_`/`$` 和单字符，不把中文整句当一个代码名；引号字面量；路径片段；栈帧解析（Node `at fn (path:line:col)`、
     Python `File "path", line N`、Rust `--> path:line:col`、Go `path:line`、.NET `in path:line N`）；问题类型分类用中英文线索表
     （在哪 / 哪里 / where → `where`；怎么 / 如何 / 流程 / how → `how`；改了 / 影响 / 会不会 / what if / impact → `impact`；为什么 /
     报错 / 失败 / why / 有栈帧 → `why`；未知保留 `unknown`）。可选 intent 由 Coordinator 与初次检索并行调度，采纳时另发补充检索
     请求；Engine 不访问模型回调。是否采用迟到结果与真实调用结局分开，不能因初次搜索先结束就把模型标成 timed-out。
  1. `fanOut`：rg（沿用 `buildRgPatterns`）；`lsp.symbols` 按种子文件逐语言发起；`searchSymbols` 退化通道；`semanticRecall`（有则用）。
     每个来源独立计时、独立状态。
  2. `expand`：按问题类型——`where`：definition + 少量 references；`how`：references 有界（**不是**调用图）+ defines 邻居；`impact`：
     references 有界传递 + 测试配对；`why`：栈帧 → definition → 脏路径 / git 最近改动。**所有派生路径过 workspace scope / realpath
     授权**，越界丢弃并计数。
  3. `fuse`：各来源排名用 RRF 融合，保留 provenance 与确定性并列顺序，不把相关来源一致当成独立确认。最终物化/截断后，
     Coordinator 只有证明同 revision 的相关 span 仍在实际请求里才投影为 alreadyInContext，不能移除整文件。
  4. `slice`：`lsp.documentSymbol` 的 `range`（它区分 `range` 与 `selectionRange`，不需要 OCE 的字符阈值合并）→ tree-sitter 兜底 →
     行窗口。按实际来源的当前快照重读并记录版本，LSP 位置必须与该版本匹配；窗口草稿尚未接通时只声明磁盘原型，脏路径标 stale。
  5. `pack`：按问题所需关系组成 bundle，支撑允许为空；预算降级保留必要关系并注明省略，不预置统一支撑删除顺序。先重读、再
     打包，使用真实 OutputStore，不自行拼句柄。token 精确计量仅在真实 tokenizer 可得时由 pi-host 完成。
  6. 可选模型机制由 Coordinator 拥有：judge 等已物化候选后只选候选 ID；查询修复若采用只提类型化补查，由 Engine 重新授权执行。
     正文标为不可信数据，不连接 shell。各机制先分开比较，不强制全开；记录真实调用结局、采用状态、已知用量/成本及未知用量。
- **参数三类**（实验配置的值**无 Piarium 数据支持**，待回放集定标后写回）：

| 类 | 项 | 首版 |
| --- | --- | --- |
| 硬边界 | 父请求 abort 立即停；workspace scope / realpath 授权；judge 只返回候选 ID | 不可配置 |
| 软预算 / 观测 | 端到端及分来源延迟、实际输出字节、候选量与服务负载 | 复用已有服务背压；默认值待测量，不在这里新定产品数字 |
| 实验候选 | 查询扩展方式、references/历史窗口、候选量与重叠处理 | D-069/D-070 的 1.5/4 秒、6000 token/24 KiB、20 references、500 commits、300 字符、60%、2 块、0.1 分差、20 样本、0.05 步进均不作为默认或门槛；不用 RRF 分差判答案置信度 |

- **检索专用回放集**（独立于 T4 的 `evaluation/harness/cases.json`）：`evaluation/retrieval/cases.json`，每条
  每项固定 repo/commit、可还原的磁盘/草稿状态、query/questionType、人工 targets（path/revision/startLine/endLine）、可选 support
  （关系、来源 span 与所属目标）、标注依据。覆盖定位、解释、影响、故障、中文、Unicode、候选缺席及多窗口草稿；样本数按覆盖缺口选择。
  Runner `scripts/retrieval-replay.mjs`：B0 = 现有 grep 工作流，B1 = 独立 BM25，B2 = 候选 explore。查询来自问题及明确记录的查询策略，
  不从答案标签提取文件/符号作为某一路输入。固定比较的输出预算与 K，记录实际查询/返回包、FileRecall@K、Span F0.5、支撑覆盖、
  首个正确结果位置/时间、总耗时、输出量与来源/模型状态。无 span 标注不参与 span 指标，不把各路返回数量当作不同的 K。**不用** reference
  commit 的改动文件充当正确上下文，**不用**"后来读过的 token"算浪费。
- **两级证据**：离线按问题类型比较正确性、遗漏与资源代价；有值得验证的收益后交测试者真实任务/T4 配对。记录成功、耗时、主及辅助
  用量、人工介入与失败，不把少量样本宣称为统计不劣。明确收益、无已知严重回归、可诊断且可关闭后才讨论默认注册。
- **反馈**：第一版只记 telemetry（问题、类型、返回包摘要、各来源状态、后续 read / edit、耗时）到知识库 `event(kind: 'explore')`；
  **不自动改权重**。原因见设计 6.1（位置偏差、支撑不被改、无 edit 任务、自包含结果减少 read、压缩后 inContext 失效）。
- pi-host `explore(question, paths?)`：首行给目标数、总耗时和实际采用的模型机制；
  每个 bundle `## ${path}:${startLine}-${endLine} ${symbol ?? ''} — ${why}` + 正文 + `  ↳ ${role} ${path}:${startLine}-${endLine}`；
  `alreadyInContext` 一行；`staleRiskPaths` 一行 `note: ${n} files have unsaved edits; text shown is from disk`；来源不可用时一行
  `sources unavailable: lsp (no server for .py), cochange (not built)`；failed/stale/timed-out 分别显示，首行说明关键缺口。工具说明只陈述
  已实现能力，不承诺速度或必有完整支撑；`HARNESS_TOOL_META.explore` 保持 `mutation: none, parallel`。
- **参考形状**（读实现、不引架构）：[OpenLocus 固定版本](https://github.com/Youzini-afk/OpenLocus-Lab/tree/eecd28b218b2be211074db2bdd9e7dad43100336) 的指标与 FRK-B 索引思路；
  [OCE 固定版本](https://github.com/oce-ai/oce/tree/a359272560bbbdb321055aaed6c16ba1f4e06887) 的 `coverage_selector.py`（只借“覆盖面、重叠抑制”，不借平铺
  选择）；OCE 的 `cast_chunker._merge_small` **不借**（修的是它自己 AST 切块的伪影）。
- 测试：中文/Unicode/栈帧；同文件只读部分、文件变化、压缩/切分支/截断后不误省正文；自动来源与多窗口/断开；派生路径重新授权；
  RRF 确定性、bundle 关系与省略说明；每来源状态独立；纯算法零模型调用；可选 judge 依赖真实候选、拒绝未知 ID；迟到成功与超时区分、
  已知费用不漏记；取消传播与真实 OutputStore 分页。验证当前实现的风险，不要求所有可选来源先建齐。
- 判断要点：要守住的四条——不调主模型；来源状态与模型状态到项目级诚实；派生路径必须重新授权；正文按当前内容重切并对脏路径
  标注。最可能撞到：`lsp.symbols` 需要种子文件——无种子时坦白 `unavailable` 而不是猜一个文件；`references` 在高频符号上爆炸——
  先记录负载并利用背压/可配置实验预算；co-change 慢则按测量选择缓存/窗口；tree-sitter 是可选兜底，不必为已有 LSP 语言引入。
  自然语言问题可能缺候选，说明已知缺口；只有 retrieval 角色实际可用才建议调用，不用“高置信”标签掩盖未知。

### 3.3 `related`

- 当前仅有注入 findNode/getNeighbors 的 helper，无生产图邻居查询、PageRank 或 pi-host 工具。后续通过 KnowledgeStore 领域接口提供
  实际可用关系与来源，不以 TQL 作为上层契约；未实现的关系报告 unavailable。测试覆盖真实节点/边与失败分类后再注册。

### 3.4 线程运行时（原生子会话）

- 设计：agent-harness.md 第 9.2.1、9.2.2、**9.3** 节。范例：broker 现有的 per-session worker 生命周期（`runtime-broker.ts`）；
  pi-host 已有的 child session 关系持久化（Pi header，见 `session-host` 的 parent sessions 测试）；恢复子系统对 worker 退出的
  处理（`pi-writer-tracker.ts` / turn binding 的 incomplete 语义）。
- **线程注册表（host 持久化，唯一真相）**：`PIARIUM_DATA_DIR/threads/<hostId>/<parentSessionId>.json` 或知识库 `session` 节点
  （2.1 就位后优先后者，前者作为无知识库时的退化）。

```ts
interface ThreadRecord {
  id: string; parentSessionId: string; sessionId: string /* 线程自己的 Pi 会话 */; forkPoint: { entryId: string } | null;
  brief: string; role: RoleId | null /* null = 人开的线程 */; createdBy: 'user' | 'agent'; kind: 'discussion' | 'implementation';
  worktree: { path: string; base: string } | null; status: 'queued' | 'running' | 'idle' | 'waiting-for-input' | 'done' | 'failed' | 'cancelled' | 'merged' | 'archived';
  flags: { workerLost: boolean; stalled: boolean; looping: boolean }; waitingFor: { kind: 'user' | 'permission' | 'thread'; text: string } | null;
  lastActivityAt: string; steps: number; tokens: { input: number; output: number; cacheRead: number }; costUsd: number | null;
  lastToolCall: { name: string; at: string } | null; diffStats: { files: number; insertions: number; deletions: number } | null;
  report: ThreadReport | null; exitReason: string | null; createdAt: string; updatedAt: string;
}
// ThreadReport = { conclusion: string; changedFiles: string[]; unresolved: string[]; deviations: string[] /* 相对简报的偏离，来自线程 decisions 块 */; confidence: number; traceHandle: string; blocksSnapshot: Record<string, string> }
```

- broker / host：

```ts
createThread(input: { parentSessionId; brief; role?; kind; createdBy; forkPoint?; carryBlocks: boolean /* 默认 true */; scope?: string[]; worktree: 'none' | 'shared' | 'isolated'; model?; tools: string[]; permissions: PermissionPolicy; systemPromptFragment?: string; autoRun: boolean; hidden?: boolean /* harness 自己开的线程（review 传感器、记忆 agent 不用此路径），不进父的 threads 列表 */ }): Promise<ThreadRecord>;
sendToThread(threadId, message, { from: 'user' | 'parent-agent' }); resumeThread(threadId) /* worker-lost 后在同一会话与 worktree 上重启 */; cancelThread(threadId, { keepWorktree = true }); archiveThread(threadId); convertThread(threadId, { kind: 'implementation' }) /* 讨论线转实现线：挂 worktree、开写工具，对话延续 */
// 事件（protocol events.ts 新增，一律只带状态不带正文）："harness.thread.changed": { parentSessionId; thread: ThreadRecord 的状态子集 }；"harness.thread.done": { parentSessionId; threadId; report: ThreadReport }
```

  T1 保持基础 system/Zone 0 与普通 Pi 会话一致，把冻结的角色片段、scope 与简报放进首条任务消息；角色边界由 Pi 会话创建时的
  `tools` allowlist 强制，而不是依赖提示词。这样不会为每个角色改写静态 system 前缀。父记忆块快照尚未接入；T1 子会话的
  allowlist 不含 `dispatch`，嵌套线程留到后续显式纵切，不做隐式半支持。
- **生命周期解耦**：父回合结束、父 worker 退出，线程照跑。线程 worker 退出 → `flags.workerLost = true`，状态不变；host 用现有
  的会话恢复路径在同一会话文件、同一 worktree 上重启 worker，线程 id 不变，Zone 2 给它一行"你被中断过，上一条工具结果可能
  缺失"（沿用恢复子系统的 incomplete 语义）。用户删除父会话 → 运行中的线程 `cancelled`（worktree 保留）并归档。
- **活性传感器（host 从线程事件流推导）**：`stalled` = 无事件 ≥ `harness.threads.stalledAfterMs`（默认按 3.5 的 TTL 表推，
  未知 300 s）；`looping` = 连续 ≥ `harness.threads.loopWindow`（默认 6）次工具调用的 (name, 参数哈希) 完全相同；每次事件更新
  `lastActivityAt` / `steps` / `tokens` / `lastToolCall`。线程调用权限询问或 `ask` → `waiting-for-input` + `waitingFor`。
- **完成幂等**：线程 agent_settled 且无未决 `ask` → 生成 `ThreadReport`（`deviations` 直接取 decisions 块中标记为偏离的条目），与
  记忆块快照、diffStats 一次事务写入注册表，发 `harness.thread.done`；之后任何 `wait` / `read_thread(report)` 返回同一份。
- **进入父的 Zone 2**：2.2 的 Zone 2 组装新增 `threads` 段——每条活跃线程一行（状态 · 一句进度 · 最近活动），完成的线程一行
  "完成：结论 · N 文件 · 偏离：…"；不另设固定条数，超过现有 Zone 2 总预算时按 actionable 状态优先并折为"另有 K 条"。
- worktree（`isolated`）：复用 Git 服务创建受管分支/worktree，从父 HEAD 分出，再把父工作树的 tracked patch 与未跟踪文件复制
  进去；若父起点非 clean，在子 worktree 内提交一笔仅用于界定基线的内部 commit。这样最终 `base → child` diff 只包含子线程增量，
  不会把父原有脏改动重复合并。合并先预检未跟踪文件碰撞，再尝试 plain `git apply` 与 `--3way`；失败明确区分“父未改动”和
  “Git 已留下冲突项”。settle 与 merge 前把 child 最终状态提交到内部结果分支并记录 commit。**worktree 独立于线程寿命**：
  failed / cancelled / worker-lost 都不删。
- **回收策略**：当前不自动删除 merge 后的 live worktree，也不设置无依据的天数；线程 UI 重新打开 session 仍依赖该 cwd。
  后续以“持久 transcript 只读打开或显式 rehome + 用户归档动作 + result commit 校验”为一个纵切再删目录；分支保留策略由用户
  选择或磁盘数据定标。对话正文永不自动删除；报告与记忆块进知识库 `session` 节点并加 `spawned_from` 边（2.1 就位后）。
- UI：Fleet 注册表新增 `piarium-harness` provider（卡片：角色、状态、步数、最后活动、花费、`kill`）；父时间线折叠卡片链接到
  线程会话；侧栏与讨论线见 3.10。
- 测试：状态机每条迁移；worker 丢失后 `resumeThread` 在同一会话继续且 id 不变；父 worker 退出线程仍在跑；`stalled` /
  `looping` 判定；`waiting-for-input` 由权限询问与 `ask` 触发；报告幂等（两次读取字节相同）；删除父会话 → cancelled + worktree
  仍在；同模型前缀断言；worktree 从工作树状态分出（父有未提交改动时线程能看到）；Zone 2 `threads` 段折叠。
- 判断要点：为什么原生而不是 `pi-subagents`——核心能力不依赖第三方，且 broker 本来就有"每会话一个 worker"这个原语，线程
  只是加了父子绑定、角色化的 Zone 0、host 持有的状态和结果投影。**边界**：状态与游标归 host 而非任何一方的上下文；`dispatch`
  永不阻塞；worker 丢失可恢复且 worktree 不删；失败分类不合并成"没返回"；后台线程只用预批准工具。最可能撞到的：(1) 线程的
  Zone 0 要与父逐字节相同才能吃缓存，但角色片段必须追加——放在 system 末尾；如果 Pi 的系统提示组装让"原样复用父的前缀"
  做不到，接受同模型线程首轮全价，记录下来，不要为此改 Pi 的组装逻辑；(2) worktree 从父的工作树状态分出，二进制与未跟踪
  文件要单独处理，这里容易漏；(3) 恢复日志按 worktree 记录，线程的编辑不应出现在父的回合日志里，`merge` 才是父的变更集；
  (4) 恢复 worker-lost 的线程时上一条未完成的工具调用可能已经产生副作用（写了一半文件、命令跑完了），不要试图重放，只在
  Zone 2 说明；(5) `looping` 的阈值是传感器参数，调得保守一点（宁可漏报），误报会让父 agent 乱杀线程。budget 数字、Fleet
  卡片样式、注册表存储位置自己定。

### 3.5 `dispatch` / `threads` / `wait` / `send` / `read_thread` / `merge` / `kill`

- 设计：agent-harness.md 第 5.7、8.7、9.2.5b、9.2.6、9.3.6、9.3.7 节。
- **观察游标（host）**：`threadViewCursors[(observerSessionId, threadId)] = { eventSeq; status; progressVersion; decisionsCount;
  diffStats; viewedAt }`。`threads` / `wait` 在 Router 成功把结果交给 pi-host 后推进游标，失败允许重放；`session_compact` 钩子把压缩事件报给 host
  （经 1.1 的通道，`compaction.after` 方法）→ host 清空该会话的全部游标；用户面板是另一个观察者。
- pi-host：
  - `dispatch(role, task, { scope? })`：`createThread({ role, kind: 'implementation', createdBy: 'agent', autoRun: true, … })`。角色
    未注册 → isError `unknown role`；并发已满（默认 12，`harness.dispatch.concurrency`）→ 入队，返回 `queued as ${id}`；否则
    `dispatched ${id} (${role})`。立即返回，永不阻塞。
  - `threads(ids?, { full? })`：非阻塞。每条线程一行头 + 增量：

```text
${n} threads · ${changed} changed since last view (${ago})
${每条：`${icon} ${id} (${role ?? 'user thread'}) ${status}${statusChanged ? ` (was ${prev})` : ''} · +${steps} steps · +${calls} tool calls (${topTools}) · last activity ${ago}`}
${progress 块新增行，每行前缀 '  · '}
${decisions 新增条目，每行前缀 '  ! '}
${waitingFor ? `  ? waiting for ${kind}: ${text}` : ''}
${diffStats 变化 ? `  Δ ${files} files (+${ins} −${del})` : ''}
```

    无变化的线程只有一行 `${id} — no change since last view (${ago}); still ${status}, last activity ${ago2}`。全部无变化时首行
    改为 `no changes since last view (${ago}); use wait to block instead of polling`。`full: true` 忽略游标。
  - `wait(ids?, timeout_ms?)`：与 `threads` 相同的表，阻塞到任一线程状态变化（含 `waiting-for-input`、`stalled` / `looping` 翻转、
    `done` / `failed` / `worker-lost`）或超时；**超时是正常返回**，首行 `timed out after ${s}s — ${summary}`，不是 isError。
    未显式传入时只受 `HARNESS_MAX_REQUEST_TIMEOUT_MS` 的传输上限约束；provider TTL 只保留为默认关闭的续缓存实验数据（D-033）。
    `done` 的线程附完整报告：

```text
✔ ${id} (${role}) — ${conclusion}
  files: ${changedFiles.join(', ')} · confidence ${confidence}
  deviations from brief: ${deviations.length ? deviations.join('; ') : 'none'}
  unresolved: ${unresolved.join('; ') || 'none'} · notes: read_thread("${id}") · trace: read_thread("${id}", "steps")
```

  - `read_thread(id, what = 'blocks' | 'report' | 'steps', { since? })`：`blocks` 返回 progress / decisions / errors 块全文（这是
    默认，够回答"它在干什么、决定了什么、卡在哪"）；`report` 返回 `ThreadReport`；`steps` 返回自游标以来的转录切片，引头
    `[steps ${from}–${to} shown earlier; showing ${to+1}–${now}]`，全部入句柄。
  - `send(id, message)`：`sendToThread(id, message, { from: 'parent-agent' })`，线程侧以数据标记包裹并注明来自父 agent；
    唤醒 idle / waiting-for-input。返回 `sent to ${id} (${status})`。
  - `merge(id)`：host 先把线程当前状态提交到结果分支，再执行 `git diff <base>` 得到 patch，在父工作树 `git apply --3way`；成功 →
    状态 `merged` 并保留当前仍可打开的 worktree，返回 `merged ${n} files: …`；冲突 → 保留 worktree，返回 `merge has conflicts in ${k} files (markers
    left in place):\n${paths}\nResolve them with edit; no further merge step is needed.`；每个受影响路径走 mutation boundary
    （before / after）。Git 面板"合并这条线"调同一个 host 服务。
  - `kill(id, { keepWorktree = true })`：`cancelThread`。
  - 线程侧工具：`ask(question)` → 状态 `waiting-for-input`、`waitingFor = { kind: 'user', text }`，工具返回后线程回合结束等待；
    报告不是工具，由 3.4 在 settled 时自动生成。
  - `promptGuidelines`（`dispatch`）：`["Dispatch is asynchronous. Use wait to block until something changes; threads is a quick
    non-blocking glance — do not call it in a loop.", "Teammates report deviations from your brief; trust the report over your
    assumptions.", "read_thread shows a teammate's notes first; only read steps when the notes are not enough."]`。
- 测试：TTL 表；增量视图（两次 `threads` 之间有 / 无变化的文本）；`wait` 超时非错误；`wait` 被 `waiting-for-input` 唤醒；游标在
  `compaction.after` 后重置为全量；`send` 唤醒 idle 线程；`read_thread` 三档；`merge` 干净 / 冲突；排队与出队；`kill` 保留
  worktree；观察类调用计入计数器。
- 判断要点：`wait` 无 TTL 默认唤醒；已有 Host 请求时限与调用方显式 timeout 保持。**边界**：超时是正常结果；观察类工具默认增量、游标归 host、压缩重置；
  `read_thread` 默认是块不是转录；`kill` 默认保留 worktree；并发 12 是默认，排队而非拒绝。`merge` 用 `git apply --3way` 而不是
  `git merge`，是因为父的工作树有未提交改动且我们不想在用户历史里制造提交；如果 `--3way` 在某些情况（重命名、二进制）下
  表现不好，可以退回到"逐文件三方合并 + 未跟踪文件复制"的自实现，只要冲突时标记留在文件里、父能用 `edit` 解决这个体验
  不变。线程报告里的 `confidence` 由线程自报，父可以不信——不要为它建校准机制。增量文本的具体措辞可调，但"无变化"那一行
  必须让模型读出"再查没意思"。

### 3.6 角色目录与团队提示

- `packages/pi-host/src/harness/roles/*.ts`，每个角色：

```ts
interface RoleDefinition { id: RoleId; slot: SlotId; tools: string[]; worktree: 'shared' | 'isolated-when-parallel' | 'none'; systemPromptFragment: string; resultSchema: TSchema }
```

  六个角色按设计文档 9.2.2 表；不携带无执行语义的固定 token/turn budget，实际用量随 Run 记录并进入 Fleet；`review` 的 `systemPromptFragment` 明确"You have not seen the conversation; review the diff
  on its own merits"；`check` 有读取与命令执行能力，测试/构建及准备步骤可在正常权限下写文件，不能叫只读角色或承诺 bash 只跑不改。
  当前 shared 工作区选择保留，不强制每次复制；需要工作副本时记录真实受检版本与环境。团队提示片段（追加到 code profile 的静态提示）：

```text
You can hand work to teammates with dispatch(role, task). Teammates: quick-implement (cheap model; mechanical, well-specified changes), hard-implement (strong model; ambiguous or cross-cutting work), frontend (UI specialist), review (strong model; independent review of a diff), check (cheap model; run tests/lint and report), retrieval (cheap model; multi-step code search). Judge by time and cost: if you can finish in a few tool calls yourself, do it yourself. Dispatch is asynchronous: wait blocks until a teammate changes state, threads is a quick glance, send passes a teammate new information, read_thread shows their notes. The user may also open and talk to teammates directly; their final report tells you what actually happened.
```

  未配置槽位的角色从列表与片段中省略（片段随注册角色集静态生成）。**不实现**配额、准入、成本估算。
- 测试：注册随槽位变化；片段静态；`review` 请求载荷不含父消息。

### 3.7 review 传感器

- host：`agent_settled` 后若本回合 journaled 变更非空 → 自动 `createThread({ role: 'review', kind: 'implementation', createdBy:
  'agent', worktree: 'none', carryBlocks: false, autoRun: true, brief: diff })`——harness 自己开的线程，不出现在父的 `threads`
  列表里（`hidden: true`），但在侧栏的"harness"分组可见；结果以 Zone 2 段 `<review>` 注入下一步（不阻断）；
  `harness.review.gate = true` 时改为在回合结束前等待并把发现作为回合结束提示。
- 测试：触发条件；不阻断路径；gate 路径。

### 3.8 LSP 导航工具

- pi-host `symbols(path, query)` / `definition(path, line, character)` / `references(path, line, character)` /
  `hover(path, line, character)` → host `lsp.*`；无服务器 → `unavailable (no language server for ${language})`。
- `hover` 返回签名与文档（`${signature}\n\n${documentation}`，无文档时只返回签名），是"看一个类型 / 参数是什么"最便宜的
  路径，替代为此打开整个定义文件的 `read`（Devin 的 `hover_symbol` 同样与定义、引用并列）。`promptGuidelines`：
  `["Use hover to check a signature or type before reading the whole definition file."]`。
- 测试：四个工具各三态（`ready` / `empty` / `unavailable`）。
- **状态（2026-09-04）**：已接通。路径先过 Router/Documents authority；未同步文件从 Documents 读取并 `didOpen`，已有编辑器
  buffer 不被磁盘内容覆盖；每次请求携带当前 documentVersion，agent 侧 line/character 一基、LSP 侧零基。Web Host 在握手声明
  `harnessLspNavigation` 后才注册四个工具。

### 3.9 观察类工具的增量视图

- 设计：agent-harness.md 第 5.5、8.7 节。3.5 的线程游标是同一机制，本项把它推到其余观察类工具。
- host：通用 `ObservationCursorStore`——键 `(observerSessionId, objectKind, objectId)`，值由对象类型定义；`compaction.after`
  清空该会话全部游标。D-076 使用 store-local 单调 revision 做 prepare/commit CAS，pending 在 commit/abort 前受 namespace generation
  保护；Router response 成功 commit、失败 abort。游标随对象实际销毁清理；当前 shell 到会话结束才与输出一起释放。
- `get_output(shellId)`（无 `offset`）：返回上次读取之后的新输出，引头 `[shell ${id} · +${bytes} since last read (${ago}) ·
  ${running ? 'still running' : `exited ${code}`}]`；无新输出 → `[shell ${id} · no new output since last read (${ago}); ${running ?
  'still running' : 'exited'}; last output ${ago2}]`。显式 `offset` / `length` 是随机访问，不动游标。已完成的 `out_` 句柄保持
  `offset` / `length` 分页，无增量语义。
- `diagnostics(path)` 重复查询：只报自上次以来新增与消失的条目，引头 `[${path} · +${added} −${resolved} since last check]`，全量加
  `full: true`。
- 计数器：观察类调用次数（`threads` / `wait` / `read_thread` / `get_output` 无 offset / `diagnostics`）按会话累计，进诊断面板。
- 测试：两次读取之间有 / 无新输出；显式 offset 不动游标；固定时钟与逆序提交不倒退；clear 后 pending 不复活；Router 发送失败不推进；
  压缩后第一次读取为全量；shell 退出后最后一次增量含退出码。
- 判断要点：这项的价值是让"再看一眼"几乎不占上下文，副作用是模型更愿意看——"无新输出"那一行的措辞和 `promptGuidelines`
  里"要等就用 wait / 不要循环查看"是防轮询的全部手段，不要加频率限制之类的机制。1.4 已交付的 `get_output` 是显式 offset
  语义，这里是加默认行为，不改已有参数。
- **状态（2026-09-04）**：已接通并 proven。通用 Host 游标覆盖 shell/diagnostics，会话结束与压缩清理；后台 PTY 在 timeout 后
  继续采集并识别退出；`harness-e2e.test.ts` 已改掉旧的错误参数假绿，验证默认增量、退出码与诊断新增/消失。观察调用数进入现有
  Context 侧栏。D-076 又把 shell/diagnostics/Zone 2 threads/thread list/wait 推进移到 worker 响应送达后；持久 tool-result entry
  acknowledgement 仍是更强的后续边界。对象自动销毁尚无独立保留策略，当前随会话生命周期统一释放（D-052）。

### 3.10 线程侧栏与讨论线

- 设计：agent-harness.md 第 9.3.2、9.3.8 节。范例：Fleet 面板与 `pi-session` 组件的会话切换。
- UI：父会话右侧线程栏——每条线程一行：角色 / "用户线程" 标记、状态、徽标（等输入、完成未读、卡住、worker 丢失）、花费、
  diff 大小、最近活动；点开在同一窗口内切换到线程会话（完整聊天，可直接说话，消息带"来自你 / 来自父 agent"标记）；父对话
  任意消息的操作菜单加"从这里开一条线"（默认讨论线、默认带记忆块，两个开关）；讨论线有"转为实现线程"按钮（`convertThread`）；
  归档区列出可恢复的线程；全部读同一份线程注册表（`harness.thread.changed` 事件驱动，不轮询）。
- 讨论线：`kind: 'discussion'`，工具集 = 只读（`read` / `grep` / `find` / `ls` / `explore` / `related` / `recall` / `webfetch` /
  `websearch`），无 worktree，权限继承父；转换时挂 worktree、切到实现类工具集，同一会话延续（工具集变更是前缀失效操作，
  在转换那一刻一次完成——会话边界之外唯一允许的工具集变更，因为它是用户显式动作）。
- 子线程消息**绝不**进父对话正文；父那边只有 Zone 2 的 `threads` 段。
- i18n：全部新 key 进 10 个 catalog。
- 测试：侧栏按事件更新；徽标状态映射；"从这里开一条线"创建的记录含 `forkPoint` 与记忆块快照；转换后工具集变化且对话延续；
  归档 / 恢复。
- 判断要点：这是让线程模型对用户"存在"的那一半，没有它 9.3 只是 agent 之间的协议。侧栏样式、徽标形状自己定；**边界**是
  子线程消息不进父正文、面板与 agent 读同一份状态、讨论线零成本可丢。
- **状态（2026-09-05）**：父 session state 已包含 threads/blocks/knowledge review；桌面用右 rail，`xl` 以下用现有
  `MobileOverlayPanel` 和带实时数量的入口，共用同一加载/SSE/draft/action 状态。持久 user/assistant 消息菜单可创建默认携 blocks
  的只读讨论线，也可显式不携带；Host 从可信 session 解析 workspace/父边/fork point。讨论回答后保持同一会话等待用户，侧栏可将
  空闲讨论线转换为 isolated 实现线；转换新建 Run、重构工具边界但沿用同一 session/transcript。真实 Pi faux-provider 测试覆盖
  “开、聊、转实现、继续回答”。父消息下的线程标记与 rail/overlay 共用同一个 session-scoped feed，并随 SSE 更新；仍缺
  归档/恢复 UI（D-063/D-064）。

### 阶段 3 完成标准

- `explore` 满足 3.2 的来源/版本/片段与真实句柄契约，纯算法零模型调用；独立 retrieval replay 保留 baseline 输出，默认关闭。
- fake provider：并发 `dispatch` 两个角色，`wait` 只因真实状态、取消或显式时限返回，超时非错误，`threads` 两次调用第二次只含增量，`merge`
  干净；人为冲突由 `edit` 解决后无残留标记。
- 线程韧性：杀掉一条运行中线程的 worker 进程 → 该 Run `outcome: lost`、父 `wait` 看到 `attention` / Run 变化、
  `startRun` 开出 `attempt + 1` 的新 Run 在同一会话继续、worktree 未动；父 worker 退出后线程继续跑并在父恢复的下一回合
  以 Zone 2 一行出现。（原文的 `workerLost` / `resumeThread` 已由 P0.4 替代。）
- 用户在线程会话里直接发消息并改变其方向后，父收到的报告 `deviations` 非空。
- 讨论线开、聊、转实现线、merge 回父，全程一条会话。
- review 传感器在 diff 非空回合后注入 `<review>`。

## 阶段 3b：原生权限（与阶段 3 并行）

设计：agent-harness.md 第 9.1.2 节（三层模型、真值表、威胁模型）。

**状态（2026-09-04）**：T2 已交付。Host 静态 capability 与 path/scope enforcement 已接生产；用户/工作区字段所有权、
工作区只收紧权限、危险 regex 拒绝均有契约测试；pi-host fallback 的 normal / accept-edits / bypass / Smart 已进真会话 E2E。
`pi-permission-system` 活跃时按 session-keyed service 让它成为唯一提示所有者，原生门动态让位；插件卸载后无需重启即可恢复
fallback。D-044 取代“验证后移除插件”的旧目标。

### 3b.1 `tool_call` 门控与策略文件

- 策略 schema（`harness.permissions`，Piarium 自有原子 JSON；所有权见设计 5.10：工作区只能收紧）：

```ts
interface PermissionPolicy { mode: 'normal' | 'accept-edits' | 'bypass' | 'smart'; rules: Array<{ tool: string | '*'; match?: { param: string; pattern: string /* regex */ }; decision: 'allow' | 'ask' | 'deny' }> }
```

  默认规则由 `HARNESS_TOOL_META.mutation` 生成（已实施，`packages/protocol/src/permission-gate.ts`）；非 harness 工具不由
  本门处理。判定顺序以设计 9.1.2 的真值表为准，实现与测试都对着那张表。
- pi-host 进程内扩展 `permission-gate-extension.ts`（已实施）：插件缺席时，`ask` 走 `ctx.ui.select`（Allow once / Allow for this
  session / Deny），高风险调用的 "Allow for this session" 不记入。插件存在时按**当前会话**的已发布 service 每次确认，完全
  让位；不因其他会话的 ready 事件串线，也不把卸载后的旧状态永久缓存。
- 测试：`permission-gate.test.ts` 覆盖合并、模式、高风险与 regex；`session-e2e.test.ts` 覆盖真会话 allow/deny/会话授权/Smart；
  `permission-gate-extension.test.ts` 覆盖插件并存只弹一次、跨会话隔离与热卸载恢复。

### 3b.2 Settings 页与 Smart 模式

- Settings 权限页：模式选择、规则编辑器（工具 / 参数模式 / 决定）；Smart 模式需 `models.permissionJudge`，对 `ask` 决定
  的调用先让该模型判定（提示固定，输出 `allow | ask`），高风险类别（`bash.command` 匹配 `\b(rm|sudo|chmod|chown|mkfs|dd)\b`、
  包管理安装、`git (push|reset|checkout|rebase|clean)`、路径含 `.env|id_rsa|\.ssh`）**永远 ask**，不经模型。
- 测试：模式行为；高风险类别不受模型判定影响；槽位未配置 → Smart 不可选。

### 3b.3 保留成熟插件与明确 fallback

- `@gotgenes/pi-permission-system` 保留在 foundational manifest；它在已加载会话中拥有权限提示，Piarium 原生门仅作缺席 fallback。
- 当前不建立“做到某几个测试后自动移除”的检查表。若未来重提替换，必须先逐项证明 Bash AST、规范路径/外部目录、MCP、skill、
  子会话权限转发、审计与跨扩展 API 的能力等价，并作为安全默认值变更单独复审；不能把 Harness 自有工具的 E2E 当成全插件等价。

## 阶段 4–6（纲要）

- **4 默认 runtime**（agent-harness.md 第 11 节）：桌面打包放入 Pi 包树、`packageRoot` 指向、Runtime Manager bundled 优先、
  Git for Windows 就绪检查、版本随 `cloud-runtime.bun.lock` 流水线；Electron 打包 smoke。
- **5 外部 agent**：host 服务 MCP 门面（`search.content` / `explore` / `lsp.*` / `recall`）、`acp-host` worker 角色、client `fs`
  能力、能力门控；前置决定协议兼容策略。
- **6 research profile**（第 10.3 节）：schema 扩展、结构化文献 provider、引用完整性验证器、两个角色、三个 Shell 面。

## 交叉事项

### 文档同步矩阵

| 阶段 | 必须更新 |
| --- | --- |
| 0 | `native-workspace-recovery-design.md` 状态头；`security.md` Pi 基线 |
| 1 / 1b | `lib/harness/DOCUMENTATION.md`（新）；`packages/pi-host/src/harness/README.md`（新）；`packages/protocol` README；`architecture.md` 第 5 节 |
| 2 | `lib/knowledge/DOCUMENTATION.md`（新）；`architecture.md` 第 6 节数据归属表；`packages/ui/src/stores/DOCUMENTATION.md` |
| 3 / 3b | `architecture.md` 第 4.3、7.1、9 节；`README.md`；`extension-compatibility.md`；`security.md` |
| 每项 | agent-harness.md 中任何被实施改变的默认值或形状；`agent-harness-status.md` 每次交付更新；`roadmap.md` 只引用状态矩阵 |

### 每个纵切的验证选择

按 [development.md](development.md) 和真实回归风险选择：文档只跑文档校验；行为改动跑相关生产链测试与所属类型/静态检查；
共享契约覆盖真实消费者；只有影响请求前缀、Node 产物或平台行为时才追加相应契约/打包 smoke。失败或新的风险才扩大验证，
不把全量检查固定附到每次改动。状态矩阵写具体证据与未验证项，0.1 的设计差异按已有授权处理。

## 验收

验收看**行为、边界与偏离记录**，不看与参考形状的逐字一致。每个纵切结束后集中验收：

| 检查 | 方法 |
| --- | --- |
| 边界 | 逐条对照 0.4 不变量与设计文档决策表；没有引入被明确否定的机制（配额、成本估算、启发式重要性权重、多处自动让位、主 agent 的记忆义务、host 侧的第二套 allow / ask / deny） |
| 纵切完整 | 协议 → host → worker → 真实 E2E 每段都在真实生产调用链上；"定义了但没有调用点"、"开关硬编码为 true"、"工具已注册但 host 服务未注入"都算未接线 |
| 行为 | 纵切完成标准中的每条可观察行为在真实或 faux provider 的 **Pi 会话**里重现一次（不是只调 `tool.execute`）；随机对两条关键断言做一次 mutation 校验（去掉被测保护，测试必须变红） |
| 契约 | `@piarium/protocol` / `@piarium/application-client` 的变更有编解码或契约测试，且所有消费方通过 type-check |
| 测试 | 测试清单里的行为都被测到；随机抽两个新增测试文件核对断言测的是行为而非"不抛错"；无 `skip` / `only`；测试不向源码树写文件 |
| 偏离 | 以 [agent-harness-decisions.md](agent-harness-decisions.md) 为准（提交信息只引用编号）：每条偏离都有理由与替代方案；理由成立的由验收方回写设计文档或本文并在索引标 `folded-in`，不成立的讨论后决定改回或保留；标为"待问"的条目都已回答 |
| 报告 | 报告里的每条"已实施"有代码位置且在代码里成立；测试数字与 0.3 命令实跑一致；状态矩阵与代码一致 |
| 平台 | 要求 smoke 的项有平台与结果；未能执行的平台已写明 |
| 文本 | 模型可见文本含模板要求的信息；UI 文本经 i18n 且 catalog 齐全 |
| 文档 | 文档同步矩阵对应行已更新 |

模型行为的真实验收由用户组织测试者运行，记录实际配置、任务成功、主/辅助用量、耗时与人工介入；本地先完成可执行前置与确定性验证。
不把固定步数或一次真实会话当质量证明，不因当前缺少测试者结果伪装完成，也不自行发起付费记忆实验。
