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

## 矩阵

Owner：`host` = `packages/web/application-host/lib/harness`（或 `lib/knowledge`），`pi-host` = `packages/pi-host/src/harness`，`protocol` = `packages/protocol/src`，`ui` = `packages/ui`。

| 能力 | Owner | Implemented | Wired | Proven evidence | Default-on | Fallback | Blocker |
| --- | --- | :-: | :-: | --- | :-: | --- | --- |
| **0.2** 恢复 coverage 路径级（R1） | host recovery | ✓ | ✓ | `lib/recovery/engine.test.ts`（partial / none / ready 三态）；`piRecoveryPolicy.test.ts` | ✓ | — | 设计文档状态头未改 "R1 implemented"（D-003） |
| **0.3** `HARNESS_TOOL_META` 与 unjournalled 判定 | protocol / host | ✓ | ✓ | `protocol/test/harness-tools.test.ts`；`turn-coordinator.test.ts` | ✓ | — | — |
| **1.1** worker→host 请求通道（bridge / router） | protocol / pi-host / host | ✓ | ✓ | `pi-host/test/harness/host-services-bridge.test.ts`、`router-bridge-contract.test.ts`、`harness-e2e.test.ts`；`runtime-broker/test/worker-event-identity.test.ts`；`host/router.test.ts`、`service-host.test.ts` | ✓ | — | broker 在 create/open/fork 方法响应后 pin session；请求 payload 无 sessionId；Router 只使用 broker Actor，并由 Host 注册表补齐 workspace 与静态能力（D-035） |
| **1.2** Zone 0 字节稳定 | pi-host | ✓ | ✓ | `pi-host/test/zone0-stability.test.ts`、`pi-hooks-contract.test.ts` | ✓ | — | — |
| **1.3** `bash` / shell 监督器（PTY、持久 login shell、自动转后台） | host / pi-host | ✓ | ✓ | `host/shell-supervisor.test.ts`；`harness-e2e.test.ts` #1–3；Windows 真实 smoke（提交 `e01ce485`） | ✓ | Pi 内置 bash | 后台 shell 不是终端 tab——D-013 的前置条件"接进 terminal runtime"未兑现；macOS / Linux smoke 未做 |
| **1.4** 输出句柄与 `tool_result` 截断 | host / pi-host | ✓ | ✓ | `host/output-store.test.ts`；`pi-host/test/harness/tool-result-truncation.test.ts`；`harness-e2e.test.ts` #5 | ✓ | Pi 默认（结果原样进上下文） | 字节 / 字符单位不一致；淘汰返回 `not-found` 而非 `expired`；句柄不耐久却被 `ThreadReport` 引用（D-034，P0 ⑤）；`read` 大文件走句柄未在真会话验证 |
| **1.5** `grep` 覆盖 | host / pi-host | ✓ | ✓ | `host/search-service.test.ts`；`harness-e2e.test.ts` #4、#6 | ✓ | Pi 内置 grep | — |
| **1.6a** `edit` / `write` 编辑后诊断、`diagnostics` 工具 | host / pi-host | ✓ | ✓ | 单测：`lib/harness/diagnostics-service`；`output-tools.test.ts` | ✓ | 无诊断附注 | 未用真实 LSP server 端到端验证（`unavailable` / `pending` / `ready` 三态） |
| **1.6b** `apply_patch`（Codex 语法，OpenAI 家族） | pi-host | ✓ | ✓ | `pi-host/test/harness/apply-patch-tool.test.ts`（12 解析用例） | ✓（仅 OpenAI） | 不注册 | 多文件回滚未在真会话验证 |
| **1.7** 按路径编辑锁 | host / pi-host | ✓ | ✓ | `host/path-lock.test.ts`；`pi-host/test/harness/path-lock.test.ts` | ✓ | — | 键按 `sessionId` 分桶，两会话互不可见；`release` 无所有权 token（D-036，P0 ⑥） |
| **1.8** 计数器（toolErrors / toolRetries / outputBytes / cacheHitRatio） | pi-host | ✓ | ✓（pi-host 聚合） | `pi-host/test/harness/counter-tracker.test.ts` | — | — | UI 诊断面板未显示（`packages/ui` 无引用）；plan 每阶段检查第 5 条一直未满足 |
| **1.9** `HarnessSettings` + 设置页 | protocol / pi-host / ui | ✓ | ✓ | `protocol` 合并规则单测；`HarnessSettingsPage.tsx` | ✓ | — | 字段所有权矩阵未实现（D-031）；`autoAcceptSuggestions.user` 可被工作区覆盖是安全侧问题 |
| **1.10** 静态提示片段 | pi-host | ✓ | ✓ | `zone0-stability.test.ts`（注册全部工具后 system 不变） | ✓ | — | — |
| **1.11** 工具卡片紧凑渲染 | ui | ✓ | ✗ | `toolSummary.test.ts`（17，纯逻辑） | — | 现有卡片 | `toolSummary.ts` 无任何渲染组件引用（D-018） |
| **1b.1** 抓取服务（SSRF、重定向、提取、PDF、缓存） | host | ✓ | ✓ | `host/web-fetch.test.ts` | ✓ | — | — |
| **1b.2** `webfetch` 工具 / 阅读子 agent | pi-host / host | ✓ | ✓（fetch）/ ✗（read） | `pi-host/test/harness/webfetch-tool.test.ts`；`host/web-read-service.test.ts` | ✓（fetch） | 无 `models.reader` 时返回提取内容 | `webReadService` 在 `index.ts` 未注入 |
| **1b.3** 搜索 provider 抽象 / `websearch` | host / pi-host | ✓ | **✗（工具已注册，服务未注入）** | `host/web-search.test.ts`；`pi-host/test/harness/websearch-tool.test.ts` | — | 应为不注册 | `index.ts` 未注入 `webSearchService`，真实会话里 `websearch` 每次返回 unavailable——与线程工具曾有的问题同类，应在服务缺失时不注册 |
| **1b.4** Electron 离屏渲染 | electron / host | ✓ | ✓（桌面） | 提交 `12e77d90`；契约测试 `desktop-contract.test.ts` | ✓（桌面） | `renderer-unavailable` | Electron smoke 未在本轮验证 |
| **1b.5** 来源面板 store | ui | ✓ | ✗ | `useWebSourcesStore` 单测 | — | — | store 无组件引用 |
| **1b.6** 对 `pi-web-access` 让位 | pi-host | ✓ | ✓ | `pi-host/test/harness/select-tools-web.test.ts` | ✓ | — | — |
| **2.1** 知识库 v1（TriviumDB） | host knowledge | ✓ | ✓（按工作区懒加载） | `knowledge/store.test.ts`；`store.smoke.test.ts`（Node 加载构建产物，CI `test:node-smoke`） | ✓（仅被 todo / recall 使用） | — | TQL 与全零向量两条 TriviumDB 约束（D-019 / D-020）待写进设计 7.5；Electron asar 打包 smoke 未做 |
| **2.2** Zone 2 组装 | host / pi-host | ✓ | ✓（扩展已挂；材料为空） | `host/zone2.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（注入材料时进入请求且不碰 system） | ✓（等价于关） | 不追加消息 | `zone2Provider` 返回空材料——2.3 观察者未订阅事件源 |
| **2.3** host 观察者 | host knowledge | ✓ | ✗ | `knowledge/observers.test.ts` | — | — | 未订阅 documents / terminal / lsp / git 事件源（D-023） |
| **2.4** 记忆 agent | host | ✓ | ✗ | `host/memory-agent.test.ts`（门控表、op 校验） | — | 不维护块 | 无 model 访问；前缀缓存假设未验证（D-037）；目标形态 shadow mode |
| **2.5** `todo` / `plan` 块 | host / pi-host | ✓ | ✓ | `host/todo-tool.test.ts`；`phase2-e2e.test.ts` | ✓ | 不注册 | 确认走 `askConfirmation: () => true` 桩；"只问一次"未实现；计划面板未做 |
| **2.6** 接管压缩 | host / pi-host | ✓ | ✓（扩展已挂；接管门禁为 keeper 块） | `host/compaction.test.ts`；`session-e2e.test.ts`（有 keeper 块时零模型调用接管；只有 plan 块时交还 Pi）；`pi-hooks-contract.test.ts`（D-022） | ✗（shadow：无 keeper 块 → Pi 摘要） | Pi 默认压缩 | 需回放对比（D-037）；压缩后重注入最近文件未实现 |
| **2.7** 知识建议 / 审阅托盘 / 取代链 | host | ✓ | ✗ | `host/knowledge-suggestions.test.ts` | — | — | 三类触发均未接；UI 托盘未做 |
| **2.8** embedding provider | host knowledge | ✓ | ✗ | `knowledge/embedding.test.ts` | — | 占位向量模式 | 未接 Settings 与代际切换 |
| **2.9** 模型槽位 | protocol / host | ✓ | ✓（`resolveRoles` 用于 dispatch） | `host/model-slots.test.ts`、`roles.test.ts` | ✓ | — | 预设与设置页未做；用量按槽位归因未做 |
| **2.10** `recall` | host / pi-host | ✓ | ✓ | `host/recall-tool.test.ts`；`phase2-e2e.test.ts` | ✓ | 不注册 | `user.tdb` 未打开（`userStore: null`） |
| **3.1** 符号图采集器 | host knowledge | ✓ | ✗ | `knowledge/symbols`（单测） | — | 只维护 file 节点 | 未接 LSP / watch |
| **3.2** `explore` 管线 | host | ✓ | ✗ | `host/explore.test.ts`（17） | — | — | pi-host 无 `explore` 工具定义；10 问题快照未做 |
| **3.3** `related` | host | ✓ | ✗ | 单测 | — | — | pi-host 无工具定义 |
| **3.4 / 3.5** 线程注册表与 7 个工具 | protocol / host / pi-host | ✓ | 部分（生产 Host 已创建 versioned registry 并启动对账；无 child runtime 时不授予 `control.thread`） | `host/thread-registry.test.ts`（损坏/权限/未来 schema、旧格式迁移、崩溃对账、正交状态）；`phase3-e2e.test.ts`（7：ThreadRun、事件 wait、transport deadline）；`protocol/test/harness-threads.test.ts` | ✗ | 不注册 | P0 ⑤ TranscriptRef；真实 spawn / kill / send / merge、worktree、活性传感器、Zone 2 threads 段、Fleet provider、侧栏属于 T1 |
| **3.6** 角色目录 / 团队提示 | protocol / pi-host | ✓ | ✓（随 dispatch） | `host/roles.test.ts`（14） | ✓（随 dispatch） | 未配置槽位的角色不出现 | — |
| **3.7** review 传感器 | host | ✓ | ✗ | `host/review-sensor.test.ts`（6，含对父不可见） | — | — | 未挂 `agent_settled`；`<review>` Zone 2 注入未做 |
| **3.8** LSP 导航工具 | host | ✓ | ✗ | `host/lsp-nav.test.ts`（13） | — | — | pi-host 无工具定义 |
| **3.9** 观察类工具增量视图（`get_output` / `diagnostics`） | host | ✗ | ✗ | — | — | — | 仅线程有游标；通用 `ObservationCursorStore` 未做 |
| **3.10** 线程侧栏 / 讨论线 | ui | ✗ | ✗ | — | — | — | 依赖 3.4 纵切 |
| **3b.1** 权限门（`tool_call`） | protocol / pi-host / host | ✓ | ✓ | `host/permission-gate.test.ts`（22）；`phase3b-e2e.test.ts`；`session-e2e.test.ts`（真会话：allow once / deny / 会话授权 / 高风险覆盖 / 只读不弹窗）；`router.test.ts`（静态 capability / path） | ✓ | 交还给任何强制型 Pi 扩展 | 与 `pi-permission-system` 并存、无重复提示（D-021）；工作区 regex 无 ReDoS 防护 |
| **3b.2** Smart 模式 | host | ✓ | ✗ | `host/smart-mode.test.ts`（10） | — | — | `permissionJudge` 槽位未接 |
| **3b.3** 停止 provisioning 插件 | protocol | ✗（已回退） | — | — | — | — | 插件仍在 `FOUNDATIONAL_PI_PACKAGE_MANIFEST`（revision 2）；等 3b.1 覆盖插件全部面后再移除 |

## 未完成项（来自 D-027，按来源）

| 来源 | 未完成 |
| --- | --- |
| D-023 | Zone 2 material 收集（观察者未订阅事件源）；记忆 agent 无 model 访问；user 知识库未打开；todo 的确认通道与"只问一次"未接 |
| D-024 / D-026 | worktree 创建与回收；活性传感器 stalled / looping；Zone 2 threads 段；Fleet provider；broker child session（spawn / kill / send / applyWorktreeDiff 仍为 mock）；`read_thread(steps)` 转录切片；progress / decisions / errors 块提取 |
| D-025 | smart mode 未接 permissionJudge 槽位 |
| D-013 | harness shell 未接进 terminal runtime |
| 3b.3 | 插件未移除，原生门控与插件并存 |

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
