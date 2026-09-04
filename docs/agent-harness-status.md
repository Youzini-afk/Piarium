# Agent harness 能力状态矩阵

Status: living document maintained by the executing agent; the only authority on what is delivered

Last updated: 2026-09-04

这是 [agent-harness.md](agent-harness.md) 所述能力的**交付状态**，四级定义见
[agent-harness-plan.md](agent-harness-plan.md) 0.1（D-038）：

| 级别 | 含义 |
| --- | --- |
| `implemented` | 模块存在且单测通过；没有进入任何真实调用链（休眠） |
| `wired` | 进入真实生产调用链（host 或 pi-host 在真实会话里会走到它） |
| `proven` | 有 E2E、崩溃 / 故障注入或真实平台 smoke 的证据；证据必须链接到具体文件 |
| `default-on` | 对普通用户默认启用。影响模型行为的能力（记忆 agent、压缩接管、explore、自动 review、TTL 唤醒）另需回放对比（D-037）；基础设施类 `proven` 即可 |

规则：只有 `proven` 算纵切完成；`Proven evidence` 列不接受 `yes`，只接受路径；`Blocker` 列写阻止升级到下一级的具体事项。
[roadmap.md](roadmap.md) 只引用本文件，不再自述测试数。

**P0 integrity、T1 线程核心与 T2 权限纵切（2026-09-04）已完成**：broker Actor、Host 静态授权、versioned
Thread/ThreadRun catalog 与启动对账、事件驱动 wait、OutputRef/TranscriptRef、UTF-8 字节分页、workspace canonical lease，
以及异步 dispatch → 真实 Pi child session → 冻结角色模型/工具 → worktree → report/transcript → merge 均已进入 Web/Application
Host 生产链。Host 通过握手声明真实线程能力，pi-host 才注册七个工具；无能力的 Host 不暴露休眠工具。

**T3 上下文 shadow 第一条纵切（2026-09-04）已交付**：Documents 提交 → 会话事件库 → 增量游标 → Zone 2 → 真实 Pi
provider 请求；用户改动后的 LSP 诊断、当前 blocks、context usage 与相关 accepted knowledge 进入同一路径。memory keeper
由用户显式开启，复用活动会话模型在后台写块，默认关闭且不接管 Pi compaction。

## 矩阵

Owner：`host` = `packages/web/application-host/lib/harness`（或 `lib/knowledge`），`pi-host` = `packages/pi-host/src/harness`，`protocol` = `packages/protocol/src`，`ui` = `packages/ui`。

| 能力 | Owner | Implemented | Wired | Proven evidence | Default-on | Fallback | Blocker |
| --- | --- | :-: | :-: | --- | :-: | --- | --- |
| **0.2** 恢复 coverage 路径级（R1） | host recovery | ✓ | ✓ | `lib/recovery/engine.test.ts`（partial / none / ready 三态）；`piRecoveryPolicy.test.ts` | ✓ | — | 设计文档状态头未改 "R1 implemented"（D-003） |
| **0.3** `HARNESS_TOOL_META` 与 unjournalled 判定 | protocol / host | ✓ | ✓ | `protocol/test/harness-tools.test.ts`；`turn-coordinator.test.ts` | ✓ | — | — |
| **1.1** worker→host 请求通道（bridge / router） | protocol / pi-host / host | ✓ | ✓ | `pi-host/test/harness/host-services-bridge.test.ts`、`router-bridge-contract.test.ts`、`harness-e2e.test.ts`；`runtime-broker/test/worker-event-identity.test.ts`；`host/router.test.ts`、`service-host.test.ts` | ✓ | — | broker 在 create/open/fork 方法响应后 pin session；请求 payload 无 sessionId；Router 只使用 broker Actor，并由 Host 注册表补齐 workspace 与静态能力（D-035） |
| **1.2** Zone 0 字节稳定 | pi-host | ✓ | ✓ | `pi-host/test/zone0-stability.test.ts`、`pi-hooks-contract.test.ts` | ✓ | — | — |
| **1.3** `bash` / shell 监督器（PTY、持久 login shell、自动转后台） | host / pi-host | ✓ | ✓ | `host/shell-supervisor.test.ts`；`harness-e2e.test.ts` #1–3；Windows 真实 smoke（提交 `e01ce485`） | ✓ | Pi 内置 bash | 后台 shell 不是终端 tab——D-013 的前置条件"接进 terminal runtime"未兑现；macOS / Linux smoke 未做 |
| **1.4** `OutputRef` 与 `tool_result` 截断 | host / pi-host / protocol | ✓ | ✓ | `host/output-store.test.ts`（epoch、HMAC、水位、Unicode）；`protocol/test/utf8.test.ts`；`tool-result-truncation.test.ts`；`harness-e2e.test.ts` #5 | ✓ | Pi 默认（结果原样进上下文） | `read` 大文件走句柄未在真 provider 会话验证 |
| **1.5** `grep` 覆盖 | host / pi-host | ✓ | ✓ | `host/search-service.test.ts`；`harness-e2e.test.ts` #4、#6 | ✓ | Pi 内置 grep | — |
| **1.6a** `edit` / `write` 编辑后诊断、`diagnostics` 工具 | host / pi-host | ✓ | ✓ | 单测：`lib/harness/diagnostics-service`；`output-tools.test.ts` | ✓ | 无诊断附注 | 未用真实 LSP server 端到端验证（`unavailable` / `pending` / `ready` 三态） |
| **1.6b** `apply_patch`（Codex 语法，OpenAI 家族） | pi-host | ✓ | ✓ | `pi-host/test/harness/apply-patch-tool.test.ts`（12 解析用例） | ✓（仅 OpenAI） | 不注册 | 多文件回滚未在真会话验证 |
| **1.7** workspace 规范路径租约 | host / pi-host / protocol | ✓ | ✓ | `host/path-authority.test.ts`（Documents identity / Windows）；`path-lock.test.ts`（跨会话、lease ownership、超时）；`apply-patch-tool.test.ts`（多文件单批） | ✓ | — | 保证仅覆盖同一 Application Host 内由 Harness 管理的写入，不覆盖终端、Git、外部进程或另一 Host（D-036/D-041） |
| **1.8** 计数器（toolErrors / toolRetries / outputBytes / cacheHitRatio） | pi-host / ui | ✓ | ✓ | `counter-tracker.test.ts`；`session-e2e.test.ts`（真 Pi 工具失败/重复调用 → SessionStats）；`harnessCounterPresentation.test.ts`（缺字段不造 0、字节/命中率投影）；Context sidebar 生产引用 | ✓ | 非 Pi/Harness runtime 不发布字段则整段不显示 | — |
| **1.9** `HarnessSettings` + 设置页 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-settings.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（Smart 设置进入真会话） | ✓ | — | 模型槽位与 user memory auto-accept 为用户所有；工作区权限/派发只可收紧（D-031） |
| **1.10** 静态提示片段 | pi-host | ✓ | ✓ | `zone0-stability.test.ts`（注册全部工具后 system 不变） | ✓ | — | — |
| **1.11** 工具卡片紧凑渲染 | ui | ✓ | ✓ | `toolSummary.test.ts`（摘要、已知只读分组、未知工具不猜只读）；`PiTimelineEntries.renderMode.test.tsx`（真实 SSR：grep+read 折叠、write 独立） | ✓（live 模式） | 每组/每卡仍可展开完整 arguments/result/details | sorted 模式已有整段 activity 容器，不做第二层默认折叠（D-048） |
| **1b.1** 抓取服务（SSRF、重定向、提取、PDF、缓存） | host | ✓ | ✓ | `host/web-fetch.test.ts` | ✓ | — | — |
| **1b.2** `webfetch` 工具 / 阅读子 agent | pi-host / host | ✓ | ✓（fetch）/ ✗（read） | `pi-host/test/harness/webfetch-tool.test.ts`；`host/web-read-service.test.ts`；`thread-runtime-capability.test.ts`（Host 未声明 reader 时不走休眠服务） | ✓（fetch） | Host 无 reader 时直接返回提取内容，不先发一个注定 unavailable 的请求 | `webReadService` 在 `index.ts` 未注入 |
| **1b.3** 搜索 provider 抽象 / `websearch` | host / pi-host | ✓ | ✗（provider 未接；工具正确隐藏） | `host/web-search.test.ts`；`pi-host/test/harness/websearch-tool.test.ts`；`select-tools-web.test.ts` / `thread-runtime-capability.test.ts`（握手能力门） | — | Host 不声明 `harnessWebSearch` 时不注册；`pi-web-access` 启用则由插件提供 | 配置 provider 适配器仍是 placeholder；不能把返回空数组的骨架声明成可用服务（D-050） |
| **1b.4** Electron 离屏渲染 | electron / host | ✓ | ✓（桌面） | 提交 `12e77d90`；契约测试 `desktop-contract.test.ts` | ✓（桌面） | `renderer-unavailable` | Electron smoke 未在本轮验证 |
| **1b.5** 来源面板 store | ui | ✓ | ✗ | `useWebSourcesStore` 单测 | — | — | store 无组件引用 |
| **1b.6** 对 `pi-web-access` 让位 | pi-host | ✓ | ✓ | `pi-host/test/harness/select-tools-web.test.ts` | ✓ | — | — |
| **2.1** 知识库 v1（TriviumDB） | host knowledge | ✓ | ✓（按工作区懒加载） | `knowledge/store.test.ts`；`store.smoke.test.ts`（Node 加载构建产物，CI `test:node-smoke`） | ✓（仅被 todo / recall 使用） | — | TQL 与全零向量两条 TriviumDB 约束（D-019 / D-020）待写进设计 7.5；Electron asar 打包 smoke 未做 |
| **2.2** Zone 2 组装 | host / pi-host | ✓ | ✓ | `host/zone2.test.ts`；`knowledge/context-runtime.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（Documents 用户写入在下一真实 Pi turn 出现、event cursor 不重复、system 不变） | ✓ | 无材料时不追加消息 | user terminal / Git 事件尚未接；用户知识当前仅由显式 `recall` 合并 |
| **2.3** host 观察者 | host knowledge | ✓ | ✓（Documents + user-change LSP） | `documents/authority.test.ts`（提交后通知且观察失败不反噬写入）；`knowledge/context-runtime.test.ts`（多会话 fan-out、agent 过滤、诊断因果）；`session-e2e.test.ts`（纵切） | ✓（已接部分） | 观察失败只降级本轮上下文并记录 Host 错误 | user terminal 无逐命令退出事件；Git 无中心订阅；Harness shell / agent 自身事件只入轨迹、不重复进 Zone 2 |
| **2.4** 记忆 agent shadow | protocol / pi-host / host / ui | ✓ | ✓（用户显式开启） | `memory-agent-extension.test.ts`；`phase2-e2e.test.ts`（Host 校验并顺序 apply）；`session-e2e.test.ts`（当前模型真实后台调用、块落盘且 `memory_edit` 不进主对话）；`context-routes.test.ts` / `harnessBlockPresentation.test.ts`（鉴权、用户编辑、UI 投影） | ✗（Settings 默认关闭） | 不维护块，Pi 行为不变 | tools 块不同，缓存命中与成本未验证；事件加速触发、回放对比未做（D-037/D-045） |
| **2.5** `todo` / `plan` 块 | host / pi-host / ui | ✓ | ✓ | `host/todo-tool.test.ts`；`pi-host/test/harness/todo-tool.test.ts`（低置信度真 UI、同会话只问一次、取消不写 Host）；`phase2-e2e.test.ts`；session state 侧栏经 authenticated block routes + SSE 可见可编辑（D-046） | ✓ | 不注册 | — |
| **2.6** 接管压缩 | host / pi-host | ✓ | ✓（能力存在，生产门禁关闭） | `host/compaction.test.ts`（shadow 即使有 keeper block 也交还 Pi；显式 takeover 才接管）；`session-e2e.test.ts`（只有显式测试设置才接管）；`pi-hooks-contract.test.ts`（D-022） | ✗ | Pi 默认压缩 | `takeoverEnabled` 默认 false；需回放对比后才讨论开启（D-037/D-045）；压缩后重注入最近文件未实现 |
| **2.7** 知识建议 / 审阅托盘 / 取代链 | host | ✓ | ✗ | `host/knowledge-suggestions.test.ts` | — | — | 三类触发均未接；UI 托盘未做 |
| **2.8** embedding provider | host knowledge | ✓ | ✗ | `knowledge/embedding.test.ts` | — | 占位向量模式 | 未接 Settings 与代际切换 |
| **2.9** 模型槽位 | protocol / host | ✓ | ✓（`resolveRoles` 用于 dispatch） | `host/model-slots.test.ts`、`roles.test.ts` | ✓ | — | 预设与设置页未做；用量按槽位归因未做 |
| **2.10** `recall` | host / pi-host | ✓ | ✓ | `host/recall-tool.test.ts`（workspace + user 合并）；`phase2-e2e.test.ts` | ✓ | 不注册 | Application Host 已懒加载 `user.tdb`；知识审阅/写入 UI 仍未做 |
| **3.1** 符号图采集器 | host knowledge | ✓ | ✗ | `knowledge/symbols`（单测） | — | 只维护 file 节点 | 未接 LSP / watch |
| **3.2** `explore` 管线 | host | ✓ | ✗ | `host/explore.test.ts`（17） | — | — | pi-host 无 `explore` 工具定义；10 问题快照未做 |
| **3.3** `related` | host | ✓ | ✗ | 单测 | — | — | pi-host 无工具定义 |
| **3.4 / 3.5** 原生线程运行时与 7 个工具 | protocol / broker / host / pi-host | ✓ | ✓ | `thread-runtime-session.e2e.test.ts`（真实持久 Pi child、独立 runtime workspace、冻结模型/工具/scope、报告）；`thread-worktree.test.ts`（真实 Git、dirty baseline、冲突不覆盖）；`thread-runtime.test.ts`（worker/host 中断续跑、权限等待、stalled/looping）；`path-authority.test.ts` / `search-service.test.ts`（scope enforcement）；`phase3-e2e.test.ts`（bridge→router→registry）；`thread-runtime-capability.test.ts`（Host 握手能力门）；`runtime-dispatcher-session-launch.test.ts`；`session-delete-coordinator.test.ts` | ✓（Web/Application Host） | Host 未声明 `harnessThreads` 时不注册 | role budget、父 blocks 快照与结构化 deviations 尚未接；Zone 2 threads 段、完成后的 worktree/branch 回收策略仍待做；scope 不是 OS 沙箱，不约束 shell 文本或 worker 内置 read（D-044） |
| **3.6** 角色目录 / 团队提示 | protocol / pi-host | ✓ | ✓（随 dispatch） | `host/roles.test.ts`（14） | ✓（随 dispatch） | 未配置槽位的角色不出现 | — |
| **3.7** review 传感器 | host | ✓ | ✗ | `host/review-sensor.test.ts`（6，含对父不可见） | — | — | 未挂 `agent_settled`；`<review>` Zone 2 注入未做 |
| **3.8** LSP 导航工具 | protocol / host / pi-host | ✓ | ✓ | `host/lsp-nav.test.ts`（真实 fixture LanguageSupervisor、编辑器 buffer 不覆盖、版本/一基位置/三态）；`lsp-tools.test.ts`；`thread-runtime-capability.test.ts`（握手能力门） | ✓（Web/Application Host） | Host 不声明 `harnessLspNavigation` 时四个工具不注册 | `symbols` 需一个代表文件路径来选择语言 provider；未知后缀明确 unavailable（D-051） |
| **3.9** 观察类工具增量视图（`get_output` / `diagnostics`） | host | ✗ | ✗ | — | — | — | 仅线程有游标；通用 `ObservationCursorStore` 未做 |
| **3.10** 最小线程侧栏 | ui / host | ✓ | ✓ | `thread-routes.test.ts`；`HarnessThreadsPanel.test.ts`；`piariumEvents.test.ts`（SSE 重连后重取 + 增量事件） | ✓（有线程且桌面宽度足够时） | 线程工具仍可完整操作 | 当前是父会话桌面最小侧栏；窄屏/移动投影、时间线卡片与用户创建讨论线未做 |
| **3.11** Harness Fleet provider | pi-host / host | ✓ | ✓ | `piarium-harness-adapter.test.ts`；复用 `phase3-e2e.test.ts` 的 Host thread service 链 | ✓（普通会话） | 专用 `threads` / `wait` 工具 | 子会话按角色工具 allowlist 不注册该 provider；Zone 2 threads 段未做 |
| **3b.1** 权限 fallback（`tool_call`）与插件共存 | protocol / pi-host / host | ✓ | ✓ | `host/permission-gate.test.ts`；`phase3b-e2e.test.ts`；`session-e2e.test.ts`（真会话：allow once / deny / 会话授权 / 高风险覆盖 / 只读不弹窗 / 公共 service 契约下插件与 fallback 只弹一次）；`permission-gate-extension.test.ts`（同会话让位、跨会话隔离、热卸载恢复）；`router.test.ts`（静态 capability / path） | ✓ | 插件在场时由 `pi-permission-system` 单独裁决 | 原生 fallback 只覆盖 Harness 工具；不是插件的能力等价替代（D-044） |
| **3b.2** Smart fallback | pi-host | ✓ | ✓ | `session-e2e.test.ts`（配置槽位后真实模型调用）；`permission-gate-extension.test.ts`（普通 ask 可放行、高风险不调用 judge） | 用户选择后 | 无槽位时不可选、判断失败时 ask | 插件活跃时应使用其显式 `authorizerChain`，原生 Smart 不参与裁决 |
| **3b.3** foundational 权限插件 | protocol / pi-host | ✓ | ✓ | `permission-gate-extension.test.ts`；插件 v27 公共 service 契约复审（D-044） | ✓ | 插件缺席时原生 fallback | 保留 provisioning；未来替换须单独证明完整能力等价 |
| **T4** 最小配对回放集 | evaluation / scripts | ✓ | ✗（尚无真实模型配对结果） | `evaluation/harness/cases.json`（6 个真实历史任务）；`scripts/harness-replay.test.mjs`（commit/ancestor 校验、非覆盖记录、配对汇总、失败分类） | — | 不运行即不产生模型调用或设置变化 | 缺 per-session Harness profile override；需同 provider/model/machine 跑完 native + harness-shadow 配对（D-047） |

## 未完成项（来自 D-027，按来源）

| 来源 | 未完成 |
| --- | --- |
| D-023 | Zone 2 尚缺 user terminal / Git；知识建议与审阅 UI 未接；memory 事件加速触发未接 |
| D-024 / D-026 | Zone 2 threads 段；merge/归档后的 worktree 与分支回收；窄屏侧栏与讨论线；progress / decisions / errors 块提取；`scope` 的 Host 强制 |
| D-013 | harness shell 未接进 terminal runtime |

## 历史快照：阶段 1 小结（2026-09-03，自决策日志迁入）

以下内容原位于 `agent-harness-decisions.md`，按 D-030 迁到此处；只是当时的快照，现行状态以上表为准。

### 模块已写并有单测

| 工作项 | 模块 | 单测数 |
| --- | --- | --- |
| 1.1 | HarnessServiceMap, HostServicesBridge, HarnessRouter | 17 |
| 1.2 | Zone 0 violation fix + stability contract | 5 |
| 1.3 | ShellSupervisor (PTY), bash tool | 21 |
| 1.4 | OutputStore, tool-result-truncation | 12 |
| 1.5 | HarnessSearchService, grep tool | 6 |
| 1.6 | LspDiagnosticsService, apply_patch (Codex) | 6 |
| 1.7 | PathLockService, withPathLock | 13 |
| 1.8 | CounterTracker | 7 |
| 1.9 | HarnessSettings schema + Settings page | 6 |
| 1.10 | promptSnippet / promptGuidelines | — |
| 补齐 | get_output, write_to_process, kill_shell, diagnostics | 15 |

### 已接进运行系统（当时）

`index.ts`：HarnessServiceHost、HarnessRouter、broker 事件消费、会话注册、registerWriter、诊断 provider、`harness.respond` ok 字段；`session-host.ts`：selectHarnessTools → customTools、截断扩展、apply_patch OpenAI-only、Settings 门控；`service-host.ts`：bash 初始 cwd；`workspace-mutation-journal.ts`：诊断经 hostServicesBridge；`HarnessSettingsPage.tsx`：工具开关 + shell + output + bash。

### E2E（`packages/pi-host/test/harness/harness-e2e.test.ts`，6/6）

1. bash pwd 输出包含工作区目录名；2. 两次独立调用 `cd packages` → `pwd` 以 "packages" 结尾；3. 超过 waitMs 的命令返回 `sh_` id，`get_output` 取到非空输出；4. grep 命中含 "hello"，miss 返回 "0 hits (searched"；5. `cat big.txt`（5000 行）返回 `out_` 句柄，page1 含 "line 1"，page2 非空；6. `selectHarnessTools`：grep=false 时无 grep，默认有 grep。

### Contract（`packages/pi-host/test/harness/router-bridge-contract.test.ts`，3/3）

`buildHarnessRespondParams` → host-controller `harness.respond` → `respondHarness` → bridge：ok 结果 resolves；error 结果 rejection；timeout 为 retryable rejection。

当时的已知缺口：`read` 的 `tool_result` 截断未在真会话验证；诊断 provider 已接线但未用真实 LSP 验证；D-013 的 terminal runtime 集成待完成。前两条至今未变，见矩阵。
