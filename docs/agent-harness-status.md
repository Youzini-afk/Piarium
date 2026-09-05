# Agent harness 能力状态矩阵

Status: living document maintained by the executing agent; the only authority on what is delivered

Last updated: 2026-09-05

这是 [agent-harness.md](agent-harness.md) 所述能力的**交付状态**，四级定义见
[agent-harness-plan.md](agent-harness-plan.md) 0.1（D-038，经 D-078 修订）：

| 级别 | 含义 |
| --- | --- |
| `implemented` | 模块存在且单测通过；没有进入任何真实调用链（休眠） |
| `wired` | 进入真实生产调用链（host 或 pi-host 在真实会话里会走到它） |
| `proven` | 有 E2E、崩溃 / 故障注入或真实平台 smoke 的证据；证据必须链接到具体文件 |
| `default-on` | 代码对普通用户默认启用；正式能力完成生产接线与相关正确性验证后在同一交付中启用，不再要求独立回放或测试者批准（D-078） |

规则：proven 才算已验证的可用路径，证据列给具体文件；Blocker 写实际未完成行为/特定环境问题，不把优化或缺独立评测当通用阻塞。
Default-on 列只记当前代码，尚未完成的正式目标单独列为待实施。
[roadmap.md](roadmap.md) 只引用本文件，不再自述测试数。

**P0 integrity、T1 线程核心与 T2 权限纵切（2026-09-04）已完成**：broker Actor、Host 静态授权、versioned
Thread/ThreadRun catalog 与启动对账、事件驱动 wait、OutputRef/TranscriptRef、UTF-8 字节分页、workspace canonical lease，
以及异步 dispatch → 真实 Pi child session → 冻结角色模型/工具 → worktree → report/transcript → merge 均已进入 Web/Application
Host 生产链。Host 通过握手声明真实线程能力，pi-host 才注册七个工具；无能力的 Host 不暴露休眠工具。

**T3 上下文 shadow 第一条纵切（2026-09-04）已交付**：Documents 提交与现有 Git 状态刷新 → 会话事件库 → 增量游标 → Zone 2 → 真实 Pi
provider 请求；用户改动后的 LSP 诊断、当前 blocks、context usage 与相关 accepted knowledge 进入同一路径。memory keeper
由用户显式开启，复用活动会话模型在后台写块，默认关闭且不接管 Pi compaction。

**历史文档修订（D-071–D-073）未改变当时代码。** shadowMode:true 实际是 assist；当时登记的版本/分支/覆盖缺口随后由 D-076
修复。record-only、窗口草稿读取仍未交付；TriviumDB 优先保留、Windows 沙箱排除、不自行发起付费记忆实验的边界保持。

**随后 D-076 已完成第一组本地正确性纵切**：branch copy-on-write/tombstone、原子 CAS、实际 context entry coverage，以及
worker 响应送达后推进 observation/thread cursors 已接生产路径。它不改变 assist/default-off，也不把本地 faux-provider 证据当作
外部语义验证；具体边界见下表。

**D-078 的正式实施与默认交付政策保持。D-079 修复实际数据链路。** 磁盘 explore 默认接入真实 Documents 正文，原生结果与集成
使用实际 recovery storage。旧实现曾把 helper、构造器和测试总数当作完整交付，本表已按真实消费者重新校准；窗口草稿、无目录工具、
双修订预览与完整空间治理仍是待完成行为。memory 缺省 shadowMode 已改为 true（assist），显式关闭保持；压缩接管及自动 review
的剩余工作分别见矩阵，不再以独立 baseline 或测试者许可阻止交付。

## 矩阵

Owner：`host` = `packages/web/application-host/lib/harness`（或 `lib/knowledge`），`pi-host` = `packages/pi-host/src/harness`，`protocol` = `packages/protocol/src`，`ui` = `packages/ui`。

| 能力 | Owner | Implemented | Wired | Proven evidence | Default-on | Fallback | Blocker |
| --- | --- | :-: | :-: | --- | :-: | --- | --- |
| **0.2** 恢复 coverage 路径级（R1） | host recovery | ✓ | ✓ | `lib/recovery/engine.test.ts`（partial / none / ready 三态）；`piRecoveryPolicy.test.ts` | ✓ | — | —（设计文档状态头已记录 R1 implemented） |
| **0.3** `HARNESS_TOOL_META` 与 unjournalled 判定 | protocol / host | ✓ | ✓ | `protocol/test/harness-tools.test.ts`；`turn-coordinator.test.ts` | ✓ | — | — |
| **1.1** worker→host 请求通道（bridge / router） | protocol / pi-host / host | ✓ | ✓ | `pi-host/test/harness/host-services-bridge.test.ts`、`router-bridge-contract.test.ts`、`harness-e2e.test.ts`；`runtime-broker/test/worker-event-identity.test.ts`；`host/router.test.ts`、`service-host.test.ts` | ✓ | — | broker 在 create/open/fork 方法响应后 pin session；请求 payload 无 sessionId；Router 只使用 broker Actor，并由 Host 注册表补齐 workspace 与静态能力（D-035） |
| **1.2** Zone 0 字节稳定 | pi-host | ✓ | ✓ | `pi-host/test/zone0-stability.test.ts`、`pi-hooks-contract.test.ts` | ✓ | — | — |
| **1.3** `bash` / shell 监督器（PTY、持久 login shell、自动转后台） | host / pi-host | ✓ | ✓ | `host/shell-supervisor.test.ts`；`harness-e2e.test.ts` #1–3；Windows 真实 smoke（提交 `e01ce485`） | ✓ | Pi 内置 bash | 后台 shell 不是终端 tab——D-013 的前置条件"接进 terminal runtime"未兑现；macOS / Linux smoke 未做 |
| **1.4** `OutputRef` 与 `tool_result` 截断 | host / pi-host / protocol | ✓ | ✓ | `host/output-store.test.ts`（epoch、HMAC、水位、Unicode）；`protocol/test/utf8.test.ts`；`tool-result-truncation.test.ts`；`harness-e2e.test.ts` #5；`session-e2e.test.ts`（真实 Pi agent loop：read 大文件只见预览/句柄，再用 get_output UTF-8 分页） | ✓ | Pi 默认（结果原样进上下文） | — |
| **1.5** `grep` 覆盖 | host / pi-host | ✓ | ✓ | `host/search-service.test.ts`；`harness-e2e.test.ts` #4、#6 | ✓ | Pi 内置 grep | — |
| **1.6a** `edit` / `write` 编辑后诊断、`diagnostics` 工具 | host / pi-host | ✓ | ✓ | `diagnostics-adapter.test.ts`（真实 fixture LSP 进程、版本化 error→clean、pending/unavailable）；`session-e2e.test.ts`（真实 Pi agent loop → Host bridge → fixture LSP）；`output-tools.test.ts` | ✓ | 无诊断附注 | — |
| **1.6b** `apply_patch`（Codex 语法，OpenAI 家族） | pi-host | ✓ | ✓ | `pi-host/test/harness/apply-patch-tool.test.ts`（12 解析用例） | ✓（仅 OpenAI） | 不注册 | 多文件回滚未在真会话验证 |
| **1.7** workspace 规范路径租约 | host / pi-host / protocol | ✓ | ✓ | `host/path-authority.test.ts`（Documents identity / Windows）；`path-lock.test.ts`（跨会话、lease ownership、超时）；`apply-patch-tool.test.ts`（多文件单批） | ✓ | — | 保证仅覆盖同一 Application Host 内由 Harness 管理的写入，不覆盖终端、Git、外部进程或另一 Host（D-036/D-041） |
| **1.8** 计数器（toolErrors / toolRetries / outputBytes / observationCalls / cacheHitRatio） | pi-host / ui | ✓ | ✓ | `counter-tracker.test.ts`；`session-e2e.test.ts`（真 Pi 工具失败/重复调用 → SessionStats）；`harnessCounterPresentation.test.ts`（缺字段不造 0、字节/观察/命中率投影）；Context sidebar 生产引用 | ✓ | 非 Pi/Harness runtime 不发布字段则整段不显示 | — |
| **1.9** `HarnessSettings` + 设置页 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-settings.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（Smart 设置进入真会话） | ✓ | — | 模型槽位与 user memory auto-accept 为用户所有；工作区权限/派发只可收紧（D-031） |
| **1.10** 静态提示片段 | pi-host | ✓ | ✓ | `zone0-stability.test.ts`（注册全部工具后 system 不变） | ✓ | — | — |
| **1.11** 工具卡片紧凑渲染 | ui | ✓ | ✓ | `toolSummary.test.ts`（摘要、已知只读分组、未知工具不猜只读）；`PiTimelineEntries.renderMode.test.tsx`（真实 SSR：grep+read 折叠、write 独立） | ✓（live 模式） | 每组/每卡仍可展开完整 arguments/result/details | sorted 模式已有整段 activity 容器，不做第二层默认折叠（D-048） |
| **1b.1** 抓取服务（SSRF、重定向、提取、PDF、缓存） | host | ✓ | ✓ | `host/web-fetch.test.ts` | ✓ | — | — |
| **1b.2** `webfetch` 工具 / session-local reader | pi-host / host | ✓ | ✓ | `webfetch-tool.test.ts`（单次 fetch + reader/fallback）；`session-e2e.test.ts`（真实 Pi：Host SSRF fetch 一次 → 配置 reader slot → 主回合收到答案）；`thread-runtime-capability.test.ts`（Host 能力门） | ✓（fetch；reader 在用户配置槽位后） | reader 未配/失败时返回已提取正文，不重复 fetch | reader 使用 pi-host 的 session model/credential authority；已删除无调用方的 Host `web.read` 模型栈（D-066） |
| **1b.3** 搜索 provider / `websearch` | host / pi-host / ui | ✓ | ✓（配置后） | `web-search.test.ts`（Brave/Exa/Tavily/Jina/SearXNG HTTP 契约、过滤、失败不塌缩）；`web-search-routes.test.ts`（search-only credential ref/鉴权/不回传 key）；`session-e2e.test.ts`（真实 Pi websearch → Host provider）；`harness-settings.test.ts`（workspace 不可改 provider/credential）；Settings 生产入口 | 用户配置并重启后 | 无 provider 时握手不声明、工具不注册；`pi-web-access` 启用则让位 | 当前 Host capability 在进程启动时冻结，改变 provider 后需重启；模型 provider 的 server-side search 未有可独立调用契约，不接空 adapter（D-067） |
| **1b.4** Electron 离屏渲染 | electron / host | ✓ | ✓（桌面） | 提交 `12e77d90`；契约测试 `desktop-contract.test.ts` | ✓（桌面） | `renderer-unavailable` | Electron smoke 未在本轮验证 |
| **1b.5** 来源面板 | ui / pi-host | ✓ | ✓ | `harnessWebSources.test.ts`（只接收持久、安全 URL）；`useWebSourcesStore.test.ts`（稳定去重、pin/remove tombstone）；webfetch/websearch details → PiChatView transcript projection → session state panel 生产链；i18n parity | ✓（有来源时） | 无持久 web 工具结果时不显示 | pin/remove 是本地展示状态；来源权威仍是 Pi transcript，重新打开可重建（D-067） |
| **1b.6** 对 `pi-web-access` 让位 | pi-host | ✓ | ✓ | `pi-host/test/harness/select-tools-web.test.ts` | ✓ | — | — |
| **2.1** 知识库 v1（TriviumDB） | host knowledge | ✓ | ✓（按工作区懒加载） | `knowledge/store.test.ts`；`store.smoke.test.ts`（Node 加载构建产物，CI `test:node-smoke`） | ✓（仅被 todo / recall 使用） | — | TQL 与全零向量约束已写入设计 7.5（D-019/D-020）；Electron asar 打包 smoke 未做 |
| **2.2** Zone 2 组装 | host / pi-host | ✓ | ✓ | `host/zone2.test.ts`；`knowledge/context-runtime.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（Documents 用户写入在下一真实 Pi turn 出现、event cursor 不重复、system 不变） | ✓ | 无材料时不追加消息 | user terminal 尚缺 shell integration；Git 与 prompt-relevant accepted knowledge 已接 |
| **2.3** host 观察者 | host knowledge | ✓ | ✓（Documents + user-change LSP + Git status） | `documents/authority.test.ts`（提交后通知且观察失败不反噬写入）；`knowledge/context-runtime.test.ts`（多会话 fan-out、agent 过滤、诊断因果、raw Git status → workspace → event → Zone 2 与去重）；`git-status.test.ts` / `git-status-runtime.test.ts`（最小投影与 Documents workspace 解析）；`git/routes.test.ts` / `workspace-routes.test.ts`（两个生产刷新边界且 observer 失败不反噬）；`session-e2e.test.ts`（Documents 纵切） | ✓（已接部分） | 观察失败只降级本轮上下文并记录 Host 错误；不新增 Git 轮询 | user terminal 需要 shell integration 才有可靠的逐命令/退出码；Git 外部变化在现有 status 下一次刷新时可见，不声称后台实时；Harness shell / agent 自身事件不重复进 Zone 2（D-054） |
| **2.4** 记忆 agent assist（旧称 shadow） | protocol / pi-host / host / ui | ✓ | ✓ | `memory-agent-extension.test.ts`；`phase2-e2e.test.ts`（Host 校验并顺序 apply）；`session-e2e.test.ts`（当前模型后台调用、块落盘且 memory_edit 不进主对话）；`context-routes.test.ts` / `harnessBlockPresentation.test.ts` | ✓（缺省 shadowMode:true；保留显式 false） | 用户关闭时不维护块 | assist 不等于压缩接管；辅助调用费用/失败投影与事件加速待接；缓存收益未测只作优化信息 |
| **2.5** `todo` / `plan` 块 | host / pi-host / ui | ✓ | ✓ | `host/todo-tool.test.ts`；`pi-host/test/harness/todo-tool.test.ts`（当前低置信度真 UI、同会话只问一次、取消不写 Host）；`phase2-e2e.test.ts`；session state 侧栏可见可编辑（D-046） | ✓ | 不注册 | D-078 将默认低置信度确认改为用户显式审批策略，尚未改代码 |
| **2.6** 接管压缩 | host / pi-host | ✓ | ✓（能力存在，当前默认关闭） | `host/compaction.test.ts`（assist 交还 Pi；显式 takeover 接管）；`session-e2e.test.ts`（显式测试设置接管）；`pi-hooks-contract.test.ts`（D-022）；D-076 覆盖测试见下表 | ✗ | Pi 默认压缩 | 默认接线/设置迁移、必要来源可读状态与压缩后版本化恢复待补；无覆盖/错分支仍只回退该次请求，取消独立回放门槛（D-078） |
| **2.7** 知识建议 / 审阅托盘 / 取代链 | host / ui | ✓ | ✓（全部 user-mark + memory decisions） | `knowledge-suggestions.test.ts`（同 scope 取代与状态）；`context-routes.test.ts`（UI auth、workspace/user 创建→编辑→原子接受/驳回、409、取代链）；`decision-suggestions.test.ts`（committed previous/current、结构化新增、历史/驳回去重、用户块忽略）；`recall-tool.test.ts`（user store scope）；`harnessKnowledgePresentation.test.ts` / `HarnessKnowledgeReviewSection.test.tsx`（双 scope id、malformed、编辑与候选渲染）；`RememberKnowledgeButton.test.ts` / `PiTimelineEntries.renderMode.test.tsx`（持久 user/assistant/tool 来源）；`piariumEvents.test.ts`（失效通知） | ✓（用户显式动作；memory shadow 开启时 decisions） | 未标记且 memory shadow 关闭时零写入、零模型调用；建议未接受不参与 recall | 配置 suggestions model 后的用户消息提议、Settings 全量知识/取代链管理未接（D-058/D-060/D-061） |
| **2.8** embedding provider | host knowledge | ✓ | ✗ | `knowledge/embedding.test.ts` | — | 占位向量模式 | 未接 Settings 与代际切换 |
| **2.9** 模型槽位 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-model-slots.test.ts`、`roles.test.ts`（统一 fallback）；`pi-host/test/harness/counter-tracker.test.ts` 与 `session-e2e.test.ts`（reader / permissionJudge 真请求归因）；`harnessCounterPresentation.test.ts`；Harness Settings 与 Context sidebar 生产入口 | ✓（依赖能力各自按配置启用） | 未配置辅助槽位不注册或走无 LLM 路径；仅 hardImplement / review 明示回退主模型 | 三套预设从已连接 provider 的真实 model id 匹配且只填空槽位；线程角色的 model/token 由 `ThreadRun` 记录，不在父 SessionStats 双计 |
| **2.10** `recall` | host / pi-host | ✓ | ✓ | `host/recall-tool.test.ts`（workspace + user 合并）；`phase2-e2e.test.ts` | ✓ | 不注册 | Application Host 已懒加载 `user.tdb`；显式审阅/写入已接，Settings 全量知识管理仍待 2.7 |
| **3.1** 符号图采集器 | host knowledge | ✓ | ✓（file/symbol/defines） | `knowledge/store.test.ts`（真实节点、defines edges、代际替换、坏 range 不破坏旧图）；`symbol-runtime.test.ts`（Documents post-commit → LSP → graph、buffer 不覆盖、unavailable 保留、delete、嵌套 symbols） | ✓（随 Documents mutation） | 未知语言只 touch file；LSP unavailable 保留最后图，ready 空结果才清空 | 不做启动全仓扫描；references/calls/imports 边未接，需基于 LSP 请求成本设计批处理/背压（D-059） |
| **3.2** `explore` 磁盘检索纵切 | pi-host tool / host Engine | ✓ | ✓ | `explore.test.ts`；`explore-service.test.ts`（真实 rg、Documents、多路径/scope、会话 OutputStore）；`pi-host/test/harness/session-e2e.test.ts`（真实 Pi：连续正文/revision/handle、查询后文件修改与删除） | ✓ | 来源失败返回具体缺口；全部正文不可用则报错 | LSP 结构展开、上下文覆盖、窗口草稿与模型增强尚未接通；已删除未使用的 Host 模型/向量/PageRank 桩 |
| **3.3** `related` | host | ✓ | ✗ | 单测 | — | — | pi-host 无工具定义 |
| **3.4 / 3.5** 原生线程运行时与 7 个工具 | protocol / broker / host / pi-host | ✓ | ✓ | `thread-runtime-session.e2e.test.ts`；`thread-worktree.test.ts`（Git/non-Git、不可变 copy 修订、回收重建）；`thread-runtime.test.ts`；`thread-registry.test.ts`；`phase3-e2e.test.ts`；`worktree-reclaim-guard.test.ts`（真实 Documents 写者屏障与编辑器）；`thread-worktree-settings.test.ts`（Pi projectTrusted、显式配置与失败） | ✓（Web/Application Host） | Host 未声明 harnessThreads 时不注册 | 内部目录仍在 Run 启动时物化；空间总预算、完整结果验证记录、窗口草稿/虚拟工具与归档 UI 待接；scope 非 OS 沙箱 |
| **3.6** 角色目录 / 团队提示 | protocol / pi-host | ✓ | ✓（随 dispatch） | `host/roles.test.ts`（14） | ✓（随 dispatch） | 未配置槽位的角色不出现 | — |
| **3.7** review 传感器 | host | ✓ | ✗ | `host/review-sensor.test.ts`（6，含对父不可见） | — | — | 未挂 agent_settled、结果修订/用量与 review Zone 2；D-078 要求接通后默认不阻断运行，不等 T4 |
| **3.8** LSP 导航工具 | protocol / host / pi-host | ✓ | ✓ | `host/lsp-nav.test.ts`（真实 fixture LanguageSupervisor、编辑器 buffer 不覆盖、版本/一基位置/三态）；`lsp-tools.test.ts`；`thread-runtime-capability.test.ts`（握手能力门） | ✓（Web/Application Host） | Host 不声明 `harnessLspNavigation` 时四个工具不注册 | `symbols` 需一个代表文件路径来选择语言 provider；未知后缀明确 unavailable（D-051） |
| **3.9** 观察类工具增量视图（`get_output` / `diagnostics`） | protocol / host / pi-host / ui | ✓ | ✓ | `observation-cursors.test.ts`（观察者/类型隔离与清理）；`observation-services.test.ts`（Unicode 字节游标、显式分页不推进、压缩重置、诊断新增/消失）；`shell-supervisor.test.ts`（转后台后继续采集并解析退出）；`harness-e2e.test.ts` #3/#7（完整 bridge 链）；`output-tools.test.ts`；`counter-tracker.test.ts` | ✓ | 显式 offset/length 与 `full: true` 保留全量/随机访问；Host 重启回到全量基线 | 当前游标覆盖 Pi 会话观察者；未来用户面板若直接观察 shell/diagnostics，应使用独立 observer id（D-052） |
| **3.10** session state rail / overlay / discussion threads | ui / host | ✓ | ✓ | `thread-routes.test.ts`（session 权威与鉴权）；`thread-runtime.test.ts`（只读存活、blocks 选择、同 session 转换）；`thread-runtime-session.e2e.test.ts`（真实 Pi：开、聊、转实现、继续回答）；`HarnessThreadsPanel.test.ts`（事件合并与 fork point）；`PiTimelineEntries.renderMode.test.tsx`（消息入口与同源线程标记）；`HarnessSessionStateTrigger.test.tsx`（窄屏入口与数量）；`piariumEvents.test.ts` | ✓（工作区持久消息与 session state 有内容时） | Host 无线程运行时时不显示入口；原线程工具仍可操作 | 归档/恢复 UI 未做；rail、overlay 与时间线标记共用一个 session-scoped feed，不复制轮询（D-062–D-064） |
| **3.11** Harness Fleet provider | pi-host / host | ✓ | ✓ | `piarium-harness-adapter.test.ts`；复用 `phase3-e2e.test.ts` 的 Host thread service 链 | ✓（普通会话） | 专用 `threads` / `wait` 工具 | 子会话按冻结的角色工具 allowlist 不注册该 provider；父会话 Zone 2 已走同一 registry 投影 |
| **3b.1** 权限 fallback（`tool_call`）与插件共存 | protocol / pi-host / host | ✓ | ✓ | `host/permission-gate.test.ts`；`phase3b-e2e.test.ts`；`session-e2e.test.ts`（真会话：allow once / deny / 会话授权 / 高风险覆盖 / 只读不弹窗 / 公共 service 契约下插件与 fallback 只弹一次）；`permission-gate-extension.test.ts`（同会话让位、跨会话隔离、热卸载恢复）；`router.test.ts`（静态 capability / path） | ✓ | 插件在场时由 `pi-permission-system` 单独裁决 | 原生 fallback 只覆盖 Harness 工具；不是插件的能力等价替代（D-044） |
| **3b.2** Smart fallback | pi-host | ✓ | ✓ | `session-e2e.test.ts`（配置槽位后真实模型调用）；`permission-gate-extension.test.ts`（普通 ask 可放行、高风险不调用 judge） | 用户选择后 | 无槽位时不可选、判断失败时 ask | 插件活跃时应使用其显式 `authorizerChain`，原生 Smart 不参与裁决 |
| **3b.3** foundational 权限插件 | protocol / pi-host | ✓ | ✓ | `permission-gate-extension.test.ts`；插件 v27 公共 service 契约复审（D-044） | ✓ | 插件缺席时原生 fallback | 保留 provisioning；未来替换须单独证明完整能力等价 |
| **T4** 可选配对回放记录器 | evaluation / scripts | ✓ | ✗（尚无真实模型配对结果） | `evaluation/harness/cases.json`（6 个历史任务）；`scripts/harness-replay.test.mjs`（commit/ancestor、记录、配对与失败分类） | — | 不运行不产生模型请求/设置变化 | 自动执行尚缺单会话配置；只有实际安排配对时才需要，不再阻塞其他功能或默认启用（D-078） |
| **3.4a** 内容寻址工作分支与结果物化 | host / protocol | ✓ | ✓（磁盘分支） | `working-state/working-state-store.test.ts`（持久重载、固定多修订、独立引用、物化匹配）；`working-state/materializer.test.ts`；`thread-runtime.test.ts`（真实存储发布）；`thread-worktree.test.ts` | ✓（隔离线程） | 旧 Git base/resultCommit 是导入来源；不作为正常合并写入旁路 | 草稿 helper 有单测但无 surface 正文调用链；Merkle 结构/无目录工具、跨平台 CoW、完整预算与引用释放 UI 尚未交付 |
| **3.5a** 固定修订 Integration 与条件恢复 | host / protocol | ✓ | ✓ | `working-state/three-way-merge.test.ts`；`working-state/integration-coordinator.test.ts`（固定结果、类型/mode、故障补偿、真实 Documents 保存排队、共享存储隔离、冲突重试）；`pi-host/test/harness/thread-runtime-session.e2e.test.ts`（父 Pi 选择旧结果 → checkpoint → 撤销）；`recovery/journal-catalog.test.ts` | ✓（原生磁盘合并） | 恢复失败保留具体路径与 needs-attention；不回到旧 git apply | 双修订投机预览、独立冲突解决 UI 与验证绑定尚未交付；文本检查不保证行为兼容 |

## 当前缺口与后续顺序

顺序见 plan 0.7；D-076 已收口第一组本地正确性问题，以下区分已接线行为与仍缺证据。

| 范围 | 已确认现状 / 待做 | 验证与外部边界 |
| --- | --- | --- |
| 2.4 记忆写入 | 已实现并接线：block 以 source leaf 修订，活动祖先路径按 label 解析最近值；后代 copy-on-write，删除写 tombstone；create/update/delete 原子 CAS；keeper 仅 mark plan；todo、Zone 2、UI、memory、compaction、thread snapshot 共用 Host 解析的分支视图 | `memory-agent.test.ts` 覆盖后代更新、兄弟隔离、tombstone、同 label 折叠、create 竞态与顺序 op；`context-routes.test.ts` 覆盖 Host 自动分支。真实用户多分支与语义质量仍由测试者验证 |
| 2.6 覆盖与证据 | 已实现并接线：coverage 使用 keeper 实际 context entry ID；removed range 按上次 boundary 与本次 first-kept 计算，缺失/不全回退；partial patch 不推进；水位在 Host 内存，重启丢失不冒充持久 checkpoint | `compaction-extension.test.ts`、`compaction.test.ts`、`phase2-e2e.test.ts` 保留机械覆盖证据；当前代码默认关闭，新默认/来源/恢复按 D-078 接线，语义质量在使用中优化 |
| 3.9 / 线程观察 | 已实现并接线到 worker 送达边界：observation 使用单调 revision CAS；pending 跨 clear 失效；Router success commit / failure abort；shell、diagnostics、Zone 2 threads、thread list/wait 延迟推进，线程游标按 eventSeq 防倒退 | cursor/router/phase3 focused tests 已覆盖并发、固定时钟、clear、响应失败与增量行为。确认只到 pi-host 响应，不宣称 tool result 已耐久落盘；更强 acknowledgement 仍待独立纵切 |
| 窗口读取 / 3.2 | 已接通的是磁盘正文：Host 经 actor 路径授权与 Documents 读取 revision，核对搜索命中是否仍存在，返回真实连续片段、partial/issues 与当前会话 handle；草稿正文传输没有生产调用链 | `explore-service.test.ts` 与真实 Pi `session-e2e.test.ts` 覆盖修改/删除、范围、正文和句柄；`draft-baseline.test.ts` 仅证明输入快照已有时的转换，不证明能从窗口取得正文 |
| T4 / 执行配置 | 无单会话覆盖与完整实际配置记录；record-only 未实现；Workbench/Agent Profile 职责分开 | 单会话配置和归因随相关能力完成，record-only/T4 非前置；不要求完整跨 runtime RunManifest |
| 结果与集成 | 基线与结果从原生对象读取，merge 选择固定 resultRevision，只处理 changedPaths；实际 recovery storage/catalog/lease 负责日志与对象。最终操作与父回合 checkpoint 同事务，已有冲突重试不叠加标记。最终比较/写入/补偿与同一 Documents 实例的保存共用资源队列；默认不改 index | 真实文件/故障注入与 Pi 会话测试；Pi e2e 使用 faux provider、手工提供 broker actor/turn 生命周期适配，未启动完整桌面。资源队列不覆盖独立 Harness 路径租约、直接 fs/命令、其他实例与外部进程 |
| 物化生命周期 | Git/非 Git 结果已独立发布；copy snapshot 按修订保留，不清空旧版本。先保存结果、关闭 session，再持有 Documents 写者屏障回收；活跃写者、编辑器或未收集内容保留目录并记录原因。设置来自父 Pi settings.get 与 projectTrusted，坏配置不吞成默认 | `thread-worktree.test.ts`、`thread-runtime.test.ts`、`worktree-reclaim-guard.test.ts`、`thread-worktree-settings.test.ts`、`working-state/git-migration.test.ts`；未分类的 setup/ignored 产物会保留目录，Git filters/LFS 的 blob/checkout 适配、完整预算、CoW 与归档 UI 仍待实施 |
| `check` | 现有角色含 bash 且 shared，具备命令执行能力 | 不称只读 agent，不阻止测试/构建正常生成文件；不新增统一副本要求 |

**D-079 本地实施证据**：最终 Host 定向组覆盖 working-state、线程、explore、Documents 与 recovery，共 21 个文件，228 项通过，
1 项 Windows 符号链接权限跳过。Protocol 71 项；Pi 线程 service/bridge 8 项、能力门 3 项；真实 Pi 原生线程测试文件 2 项、explore
纵切 3 项通过。测试使用本地 faux provider，没有执行真实付费模型或完整桌面 smoke；不以旧报告的全仓数字代替当前证据。
Protocol、pi-host 与 Application Host 类型检查通过，Host 构建与本轮修改文件 ESLint 通过；工程文档测试 19 项、文档链接校验
和 git diff --check 通过。未重复运行无关平台或全仓测试。

**D-076 本地证据**：protocol 70/70；关键 Host focused（分支/CAS/coverage/cursor/router/route/thread）全通过；pi-host 关键纵切 38/38；UI block projection 2/2；protocol/pi-host/UI/
Application Host type-check 与四包 lint、文档 19/19、链接校验、`git diff --check` 通过。扩大并行运行时 Host 另有 3 个计时用例、
pi-host 有 1 个后台 shell 计时用例失败，全部单独复跑通过；不把并行负载下的偶发超时记成本纵切失败，也不伪报全量零失败。

TriviumDB 的数据库问题按版本和通用语义向用户说明，不转嫁 Piarium 领域职责；迁移未立项。Windows 沙箱是用户排除项，
不是缺平台测试而暂时 blocked。macOS/Linux smoke、Electron 打包、真实 provider 分别记录未验证环境；测试者结果是后续质量反馈，
不作为默认交付阻塞。

## 未完成项（来自 D-027，按来源）

| 来源 | 未完成 |
| --- | --- |
| D-023 | Zone 2 尚缺 user terminal；配置 suggestions model 后的自动提议与 Settings 全量知识管理未接；memory 事件加速触发未接 |
| D-024 / D-026 | merge/归档后的 worktree 与分支回收；归档/恢复 UI |
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

当时的已知缺口：`read` 的 `tool_result` 截断未在真会话验证；诊断 provider 已接线但未用真实 LSP 验证；D-013 的 terminal runtime 集成待完成。前两条已于 2026-09-05 由 D-065 补齐；terminal runtime 集成仍见矩阵。
