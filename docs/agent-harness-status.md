# Agent harness 能力状态矩阵

Status: living document maintained by the executing agent; the only authority on what is delivered

Last updated: 2026-09-12

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
使用实际 recovery storage。旧实现曾把 helper、构造器和测试总数当作完整交付，本表已按真实消费者重新校准；其后 D-082–D-086
已补窗口草稿的 explore/grep/read/find/ls、线程基线消费者和 copyIgnored 结果范围，双修订预览（D-201）与归档/空间治理（D-202）已接线。

**D-203–D-205 已完成本轮验收返工。** 旧预览覆盖新编辑、surface 提前 complete、预览请求自循环、退出前释放写者、准备失败无法重试及并发回收/预算问题均已按具体反例修复。真实 Documents/Registry 混合集成与撤销、Windows Git Bash/PowerShell、Git/native 归档恢复再发布及普通线程打开前恢复已有证据；证据范围与尚未验证的平台见下表。

**D-206/D-209 已接通后台 shell 与 terminal runtime，并补正身份和退出契约。** 公开 `bash` 后台命令与用户终端 tab 共用同一进程；`sh_N` 由全局 runtime 分配，HTTP 不能接管；后台自然退出不依赖 `get_output`，终止和 writer 释放失败不会伪报完成或提前放开目录。bundled Pi 在无显式选择时优先于 PATH/system；todo/plan 的 confidence 只作信息，已删除写入后的假确认字段。证据与未测平台见 1.3 / 2.5。

**D-207/D-210 已接通固定结果的验证记录与默认自动 review，并去掉时间邻近式绑定。** 子检查要求 actor/worker generation/Run/binding generation 和命令 start/end/publish 输入身份一致；父检查绑定完整 Integration 的 result/operation/parent session 持久窗口。非 Git 无便宜身份时如实标 uncertain，不做每命令全仓扫描。review 绑定结果、review 线程和 Run，失败/取消与迟到旧结果均有明确归属。证据与未测范围见 3.4 / 3.5 / 3.7。

**D-208/D-211 已接通 Settings 知识目录与 suggestions 槽位的用户消息提议，并补正并发和写入身份。** Settings 对 workspace/user `.tdb` 做列表/查看/编辑/停用与取代链，所有变更核对打开时完整修订；作用域切换淘汰旧请求。`knowledge.suggest` 固定写 actor workspace/user-message 来源，相同正文的历史查重与插入原子完成。公开 recall 与 Zone 2 仍只看当前有效 accepted；未配置不借用主模型。证据与未测范围见 2.7 / 2.10。

**D-212 已接通隔离 Thread Run 的 WorkingState 只读视图。** 同名 `read` / `grep` / `find` / `ls` / `explore` 走 Host `document.readSource` / `document.pathOverlay` / `search.content` / explore reader，读取固定 base 加 delta/tombstone；父目录与物化/scratch 磁盘不能补读。没有路径绑定工具的隔离 Run 只建 scratch cwd。

**D-213 已接通虚拟文本写入与原子物化切换。** 同名 `edit` / `write` / `apply_patch` 经 Host `document.branchWrite` 提交 WorkingState delta，父磁盘不变；`writeRevision` CAS 拒绝迟到覆盖。首次 `bash` 或 LSP 导航由 Host 冻结修订、等待在飞虚拟写、staging 物化并原子切换整个 Run；失败保持原虚拟分支。结算发布 `publishHeadResult` 或收回目录变化。证据见 3.4 / 3.4a。

**D-214 已接通隔离 dispatch 的磁盘基线固定。** 创建 Thread 之后、返回之前（含 queued）捕获 Git/非 Git 工作目录字节并建立 WorkingBranch；父之后的漂移不能进入子基线。捕获失败或取消删除 Thread。证据见 3.4 / 3.4a。

**D-215 嵌套线程接线的所列生产反例已由 D-216–D-224 关闭。** 角色目录与 `parent.kind: "thread"` 数据模型保留。D-216 已拆开 owning/execution 身份；D-217 已让改父虚拟分支走同一写 gate；D-218 已补 dispatch 基线诚实；D-219 已补冻结权限、耐久嵌套集成、级联终止与 captureScopes 继承；D-220 已补执行 Git baseline、查询级固定视图与 dispatch 内容身份；D-221 已补 branch Integration 锁顺序与 WAL；D-222 已补恢复时 execution gate、dequeue 冻结权限、session-bindings 对账与知识 owning 解析；D-223 已补后代自己的 lifecycle serialization 与 scope 只拒绝完整 `..` 段。3.4 / 3.4a / 3.6 保持 Partial：D-231 已补受管 retrieval 输入；旧记录缺 managedRoot 会拒绝自动动作，真实付费嵌套 Pi 与完整桌面重启未测。

**D-216 已拆开 owning workspace 与 execution workspace，并给 Git 物化独立上下文。** Thread catalog / WorkingState / 父子关系使用 owning workspace；Documents / LSP / 路径 / shell 使用 execution workspace。子会话注册不再靠扫描 catalog 或路径猜测。Git 物化使用 `worktree add --detach`（会写 `.git/worktrees`）或独立 `git init`。证据见 3.4 / 3.4a / 3.6。

**D-217 已补正虚拟写入、修订标签、物化切换恢复与树不变量。** 物化 `switching` 后重读 execution view；失败或取消仍写 WorkingState，scratch 不是权威。切换 journal 可从 staging/backup/promote 恢复到一个权威视图。嵌套改父虚拟分支走同一写 gate 并更新父 `writeRevision`。read/grep/explore/semantic 标签等于实际读取的 `writeRevision`。symlink/环/非法 UTF-8/非法祖先拒绝且不写 delta。

**D-218 已补正 dispatch 基线诚实、mode 全字段比较与失败清理。** Git 错误不再吞成空清单或普通目录；捕获窗口变化和活跃 Documents writer 以可重试 `baseline-changed` 失败；gitlink/unsupported 不得静默当空目录或跳过物化；新虚拟文件在形成结果前写入真实默认 mode；apply/补偿按 `sameState`。D-220 已把 fingerprint 扩到内容身份，并去掉用户树上的 mode 探测。

**D-219 已接通嵌套权限冻结、耐久集成与级联生命周期。** `session.create/open` 携带冻结 overlay；live 放宽不能放宽孙。物化父集成对象库仍在 engine dataDir。branch 父集成写入 operations 并可对账/撤销。kill/archive 先停子孙。嵌套 captureScopes 继承父冻结范围。3.4 / 3.4a / 3.6 保持 Partial。

**D-220 已拆开执行 Git baseline 与逻辑 base，并钉住查询级视图。** 独立 init / detach / 崩溃恢复 / rematerialize 持久化执行仓库可解析的 `executionBaseline`；inspect/settle 不再用父 HEAD 去子仓库 `rev-parse`。WorkingBranch 读取在 store lease 后重取当前 view；explore 查询在同一 lease 内复制 immutable snapshot。默认新文件 mode 按 umask 计算。dirty 内容替换与路径集合不变时拒绝混合基线。

**D-221 已规定 branch Integration 锁顺序并补上写前日志。** 先取得父分支写入/切换权威，再决定 branch 或 directory，再打开 store/目录；不得持有 exclusive lease 后等待 `VirtualWriteGate`。`runWhenVirtual` 按 gate/切换/取消等待或改走 disk。branch 操作先写 applying intent，再 CAS，再 complete；启动对账按 before/after 补 aborted、complete 或 needs-attention。

**D-222 已补恢复时 execution identity、dequeue 冻结权限与知识所有权。** directory reconcile 走 execution Documents gate，对象库仍在 owning root；无法解析则 needs-attention。生产 dequeue 把 manifest permissions 送进 `session.create`。`session-bindings.json` 由 catalog/run 重建并对账。Thread knowledge/recall/suggestions/Zone 2 解析 owning workspace。

**D-223 已补级联生命周期 serialization 与 scope segment。** 父 kill/archive 按稳定后序进入每个后代自己的 lifecycle serialization；与 restore/reclaim/merge 并发时不能留下活跃 Run、半归档或在已归档祖先下复活。scope 只拒绝完整 `..` 段、绝对路径和盘符路径。3.4 / 3.4a / 3.6 保持 Partial：D-231 已补受管 retrieval 输入；旧记录缺 managedRoot 会拒绝自动动作，真实付费嵌套 Pi 与完整桌面重启未测。

**D-232 已在 D-228 之上补齐 `agent-mutation` 的写前检查、阶段与恢复可见性。** 根会话仍经 `document.surfaceWrite` 写回同一 Registry 缓冲，不隐式保存。混合 batch 在同一 Documents gate 内先核对全部磁盘字节身份，再允许 surface dispatch；明确失败与无回执分别处理。WAL 记录外部 dispatch/补偿 intent/观察结果与 target-after，条件补偿继续处理其他安全路径，needs-attention 进入恢复状态与 UI。非权威的 32 项内存缓存已删除。磁盘写成功到 target-after 捕获之间崩溃仍会留下可见 needs-attention；完整桌面 Registry 与 Host 进程重启未实测，因此不得标 Proven。证据见 3.2 与 D-228/D-232。

**D-233 已在 D-229 之上纠正多会话投影和退出事实。** 一条用户终端命令按目标 Pi session 分别持久化，幂等键为 `targetPiSessionId + commandId`；生产 adapter 不再丢目标身份，只有该目标首次插入才 nudge。PowerShell 用命令开始时的 `$LASTEXITCODE` 基线区分本命令产生的 native 状态与旧值；无法证明时记录 1，连续相同 native 非零码不冒充精确值。zsh source 用户文件时恢复原 `ZDOTDIR` 语义。产品链无 PTY 重播，不声称 Host 重启重放；本机无 zsh，相关 live 用例跳过，macOS/Linux 真机仍未实测。证据见 2.2 / 2.3 / 2.4 与 D-229/D-233。

**D-231/D-234 已在 D-230 之上收紧 retrieval 的目录与证据权威。** 嵌套 retrieval 在 dispatch 时沿正常 isolated 分支固定父状态，虚拟 scratch 位于 Application Host 受管根；持久 `managedRoot` 必须经 canonical containment 与 Host/backend 再授权，retrieval settle 只封印 evidence，不发布目录变化。receipt 仅 active retrieval Run 可铸造并绑定 owning/session/thread/run、exact URL 与耐久正文；artifact 从创建起有临时引用，promotion/删除/启动对账负责转移或释放。公开 `read_thread` 按 UTF-8 字节分页，不先整体载入大正文。旧 worktree 记录缺 `managedRoot` 时拒绝自动操作；真实付费 retrieval、完整桌面重启与授权 web 抓取仍未实测，3.4/3.4a/3.6 保持 Partial。

**D-080 简化辅助统计。** 已移除“模型槽位用量”区块及其专用聚合/传输，后续不新增同类辅助费用或 Token 看板。
右上角原有普通会话费用、输入/输出/缓存 Token 和上下文容量展示保留；模型槽位的配置与功能不变。
验证：`harnessCounterPresentation.test.ts`、`sessionStats.test.ts`、`usagePresentation.test.ts` 与 i18n 两组测试共 17 项；
pi-host 计数器及 reader、Smart judge、正常 Harness counters 的定向测试共 11 项通过。UI/pi-host 类型检查、protocol 构建、
修改文件 lint 与文档链接检查通过；没有改动 SDK 用量或历史数据。

**D-081 已交付默认记忆与逐次压缩接管。** 缺省模式为 `takeover`；`off/assist`、旧 `shadowMode` 迁移、实时全局设置和
session-wide 持久模式覆盖已经接入。`off` 不再把旧 blocks 注入 Zone 2。接管同时核对实际 context entry 覆盖、完整活动分支和所有
可见 block 修订；缺口、漂移或 Host 重启只让该次回到 Pi，自身摘要不会被阻断。运行模式与最近 keeper/compaction 失败投影到
SessionSnapshot、Harness Settings 和 Context。证据与仍未提供的 facts 见 2.4/2.6。

**D-082/D-085/D-086 已交付发起窗口草稿读取。** UI 输入自动把本窗口 dirty buffers 固化到 Application Host，不要求附件或绑定操作；runtime
只传不透明引用。`explore`、`grep` 和 Host-capability 门控的同名 `read`/`find`/`ls` 在这些路径上读取同一固定草稿，后续编辑不污染结果，捕获失败
也不会静默读取旧磁盘内容。read 保留 Pi 原生分页/截断和磁盘图片路径；find/ls 合并 Host 固定路径与原生结果并在合并后限流，相关快照过期返回 unavailable。

**D-083 已交付 dispatch 持久草稿基线。** `thread.dispatch` 在请求内把固定草稿的保存字节与来源修订复制进 WorkingState，
Thread manifest 只保存不可变 baseline id；queued/lost 恢复不依赖临时 surface ref。草稿是 branch revision 0 的父输入，dirty 角色
统一隔离，未修改草稿不进入子结果，ignored 草稿仍被结果采集。Integration 对尚需回到编辑器协调的路径明确返回 surface target，
该路径不写磁盘或冲突标记。surface buffer 写回与整组撤销现见 D-203 / 3.5a；非草稿文件现见 D-214，在 dispatch 创建分支时固定。

## 矩阵

Owner：`host` = `packages/web/application-host/lib/harness`（或 `lib/knowledge`），`pi-host` = `packages/pi-host/src/harness`，`protocol` = `packages/protocol/src`，`ui` = `packages/ui`。

| 能力 | Owner | Implemented | Wired | Proven evidence | Default-on | Fallback | Blocker |
| --- | --- | :-: | :-: | --- | :-: | --- | --- |
| **0.2** 恢复 coverage 路径级（R1） | host recovery | ✓ | ✓ | `lib/recovery/engine.test.ts`（partial / none / ready 三态）；`piRecoveryPolicy.test.ts` | ✓ | — | —（设计文档状态头已记录 R1 implemented） |
| **0.3** `HARNESS_TOOL_META` 与 unjournalled 判定 | protocol / host | ✓ | ✓ | `protocol/test/harness-tools.test.ts`；`turn-coordinator.test.ts` | ✓ | — | — |
| **1.1** worker→host 请求通道（bridge / router） | protocol / pi-host / host | ✓ | ✓ | `pi-host/test/harness/host-services-bridge.test.ts`、`router-bridge-contract.test.ts`、`harness-e2e.test.ts`；`runtime-broker/test/worker-event-identity.test.ts`；`host/router.test.ts`、`service-host.test.ts` | ✓ | — | broker 在 create/open/fork 方法响应后 pin session；请求 payload 无 sessionId；Router 只使用 broker Actor，并由 Host 注册表补齐 workspace 与静态能力（D-035） |
| **1.2** Zone 0 字节稳定 | pi-host | ✓ | ✓ | `pi-host/test/zone0-stability.test.ts`、`pi-hooks-contract.test.ts` | ✓ | — | — |
| **1.3** `bash` / shell 监督器（D-200 / D-205 / D-206 / D-209） | host / pi-host / ui | ✓ | ✓ | `terminal/runtime.test.ts`（程序化 create/attach、全局 Harness id、完整创建身份、HTTP 冲突、真实 force-kill/exit）；`terminal-harness-bridge.test.ts`（同一 handle 上用户附着与 agent 读写）；`shell-assembly.test.ts`（本机真实 Git Bash 后台附着与输入回显、PowerShell 连续调用与非零退出、跨 supervisor id）；`shell-supervisor.test.ts`（转后台继续采集、自然退出不靠 read、kill 失败、真实退出、迟到/释放失败 writer 保留与重试）；`openHarnessTerminal.test.ts` / `useTerminalStore.test.ts`（detach tab、不重开）；`runtime-broker/test/runtime-manager.test.ts`（无选择时用 bundled，显式 system 保持优先） | ✓ | Host 不提供能力时保留 Pi 内置；已配置解释器/设置失败明确 unavailable | macOS / Linux 真机 smoke 未做；浏览器完整点击链未跑。bundled Pi 是 runtime 选择，不是 `harness.shell` |
| **1.4** `OutputRef` 与 `tool_result` 截断 | host / pi-host / protocol | ✓ | ✓ | `host/output-store.test.ts`（epoch、HMAC、水位、Unicode）；`protocol/test/utf8.test.ts`；`tool-result-truncation.test.ts`；`harness-e2e.test.ts` #5；`session-e2e.test.ts`（真实 Pi agent loop：read 大文件只见预览/句柄，再用 get_output UTF-8 分页） | ✓ | Pi 默认（结果原样进上下文） | — |
| **1.5** `grep` 覆盖 | host / pi-host | ✓ | ✓ | `host/search-service.test.ts`；`harness-e2e.test.ts` #4、#6 | ✓ | Pi 内置 grep | — |
| **1.6a** `edit` / `write` 编辑后诊断、`diagnostics` 工具 | host / pi-host | ✓ | ✓ | `diagnostics-adapter.test.ts`（真实 fixture LSP 进程、版本化 error→clean、pending/unavailable）；`session-e2e.test.ts`（真实 Pi agent loop → Host bridge → fixture LSP）；`output-tools.test.ts` | ✓ | 无诊断附注 | — |
| **1.6b** `apply_patch`（Codex 语法，OpenAI 家族） | pi-host | ✓ | ✓ | `pi-host/test/harness/apply-patch-tool.test.ts`（12 解析用例） | ✓（仅 OpenAI） | 不注册 | 多文件回滚未在真会话验证 |
| **1.7** workspace 规范路径租约 | host / pi-host / protocol | ✓ | ✓ | `host/path-authority.test.ts`（Documents identity / Windows）；`path-lock.test.ts`（跨会话、lease ownership、超时）；`apply-patch-tool.test.ts`（多文件单批） | ✓ | — | 保证仅覆盖同一 Application Host 内由 Harness 管理的写入，不覆盖终端、Git、外部进程或另一 Host（D-036/D-041） |
| **1.8** 计数器（toolErrors / toolRetries / outputBytes / observationCalls / cacheHitRatio） | pi-host / ui | ✓ | ✓ | `counter-tracker.test.ts`；`session-e2e.test.ts`（真 Pi 工具失败/重复调用 → SessionStats）；`harnessCounterPresentation.test.ts`（缺字段不造 0、字节/观察/命中率投影）；Context sidebar 生产引用 | ✓ | 非 Pi/Harness runtime 不发布字段则整段不显示 | — |
| **1.9** `HarnessSettings` + 设置页 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-settings.test.ts`（含 `review` 用户所有、默认 enabled/非 gate）；`pi-host/test/harness/session-e2e.test.ts`（Smart 与动态 memory 设置进入真会话）；`harnessMemoryPresentation.test.ts` | ✓ | — | 模型槽位、memory mode、automatic review 与 user memory auto-accept 为用户所有；memory / review 的 workspace 值不覆盖，全局默认与 session override 实时解析（D-031/D-081/D-207/D-210） |
| **1.10** 静态提示片段 | pi-host | ✓ | ✓ | `zone0-stability.test.ts`（注册全部工具后 system 不变） | ✓ | — | — |
| **1.11** 工具卡片紧凑渲染 | ui | ✓ | ✓ | `toolSummary.test.ts`（摘要、已知只读分组、未知工具不猜只读）；`PiTimelineEntries.renderMode.test.tsx`（真实 SSR：grep+read 折叠、write 独立） | ✓（live 模式） | 每组/每卡仍可展开完整 arguments/result/details | sorted 模式已有整段 activity 容器，不做第二层默认折叠（D-048） |
| **1b.1** 抓取服务（SSRF、重定向、提取、PDF、缓存） | host | ✓ | ✓ | `host/web-fetch.test.ts` | ✓ | — | — |
| **1b.2** `webfetch` 工具 / session-local reader | pi-host / host | ✓ | ✓ | `webfetch-tool.test.ts`（单次 fetch + reader/fallback）；`session-e2e.test.ts`（真实 Pi：Host SSRF fetch 一次 → 配置 reader slot → 主回合收到答案）；`thread-runtime-capability.test.ts`（Host 能力门） | ✓（fetch；reader 在用户配置槽位后） | reader 未配/失败时返回已提取正文，不重复 fetch | reader 使用 pi-host 的 session model/credential authority；已删除无调用方的 Host `web.read` 模型栈（D-066） |
| **1b.3** 搜索 provider / `websearch` | host / pi-host / ui | ✓ | ✓（配置后） | `web-search.test.ts`（Brave/Exa/Tavily/Jina/SearXNG HTTP 契约、过滤、失败不塌缩）；`web-search-routes.test.ts`（search-only credential ref/鉴权/不回传 key）；`session-e2e.test.ts`（真实 Pi websearch → Host provider）；`harness-settings.test.ts`（workspace 不可改 provider/credential）；Settings 生产入口 | 用户配置并重启后 | 无 provider 时握手不声明、工具不注册；`pi-web-access` 启用则让位 | 当前 Host capability 在进程启动时冻结，改变 provider 后需重启；模型 provider 的 server-side search 未有可独立调用契约，不接空 adapter（D-067） |
| **1b.4** Electron 离屏渲染 | electron / host | ✓ | ✓（桌面） | 提交 `12e77d90`；契约测试 `desktop-contract.test.ts` | ✓（桌面） | `renderer-unavailable` | Electron smoke 未在本轮验证 |
| **1b.5** 来源面板 | ui / pi-host | ✓ | ✓ | `harnessWebSources.test.ts`（只接收持久、安全 URL）；`useWebSourcesStore.test.ts`（稳定去重、pin/remove tombstone）；webfetch/websearch details → PiChatView transcript projection → session state panel 生产链；i18n parity | ✓（有来源时） | 无持久 web 工具结果时不显示 | pin/remove 是本地展示状态；来源权威仍是 Pi transcript，重新打开可重建（D-067） |
| **1b.6** 对 `pi-web-access` 让位 | pi-host | ✓ | ✓ | `pi-host/test/harness/select-tools-web.test.ts` | ✓ | — | — |
| **2.1** 知识库 v1（TriviumDB） | host knowledge | ✓ | ✓（按工作区懒加载） | `knowledge/store.test.ts`（34，含大小写不敏感子串、短词只精确、重开后不重建内存、写入后计数与形状跟随）；`store.smoke.test.ts`（Node 加载构建产物，CI `test:node-smoke`） | ✓（仅被 todo / recall 使用） | — | 钉住 **0.8.6**，`payloadCacheMb: 0`——其解析 payload 缓存把 `getPayload` 变成 O(库大小)，已向作者报告（D-141）。D-019/D-020 在 0.8.6 上核实已修，块/知识/事件的 JS 过滤与 `recall` 的 JS 扫描保留为「可换」。`flush()` 仍随库线性增长（两版一致），D-140 去抖保留。Electron asar 打包 smoke 未做；v9 格式与 `.pld` sidecar 只在测试临时库上验证 |
| **2.2** Zone 2 组装 | host / pi-host | ✓ | ✓ | `host/zone2.test.ts`（含 `</user-terminal>` 不能拆段）；`knowledge/context-runtime.test.ts`（用户命令进 Zone 2、harness 过滤、两个目标 Pi session 各自入库、per-target 去重、游标不倒退）；`pi-host/test/harness/session-e2e.test.ts`（Documents 用户写入与用户终端命令在下一真实 Pi turn 出现、event cursor 不重复、system 不变） | ✓ | 无材料时不追加消息 | Git 与 prompt-relevant accepted knowledge 已接。无 shell integration 时不造 `<user-terminal>` 伪命令。D-233 纠正结构编码、per-target 持久幂等与退出事实；不得标 Proven |
| **2.3** host 观察者 | host knowledge | ✓ | ✓（Documents + user-change LSP + Git status + user-terminal 带代际 OSC） | `documents/authority.test.ts`（提交后通知且观察失败不反噬写入）；`knowledge/context-runtime.test.ts`（多会话 fan-out、agent 过滤、诊断因果、raw Git status → workspace → event → Zone 2 与去重、用户终端按目标 Pi session 持久化且重复 delivery 最多 nudge 一次）；`terminal-projection.test.ts`（user/harness 分流、nudge 失败不反噬、重复 commandId 不 nudge）；`store.test.ts`（`putEvent` 按 target Pi session + commandId 的持久索引在单写队列内幂等并回填旧行）；`git-status.test.ts` / `git-status-runtime.test.ts`；`git/routes.test.ts` / `workspace-routes.test.ts`；`session-e2e.test.ts`（Documents 与 user-terminal 纵切）；`terminal/shell-integration.test.ts`（只接受本代际标识帧）；`shell-integration-scripts.test.ts`（`sh` 不注入、Bash/zsh/PowerShell 保留用户 hook、Windows PowerShell native/cmdlet/重复同码归属）；`runtime.test.ts`（只注入 user、untagged OSC 不生成命令、`/bin/sh` 无 `--init-file`、restart 后新 zsh D 不结算旧命令且下一 commandId 属新 generation） | ✓ | 观察失败只降级本轮上下文并记录 Host 错误；不新增 Git 轮询；无 integration 为 not-observed | Git 外部变化在现有 status 下一次刷新时可见，不声称后台实时；Harness shell / agent 自身事件不重复进 Zone 2（D-054）。D-233 纠正命令事实后不得标 Proven。zsh / macOS / Linux 用户终端与完整桌面 Host 重启仅未实测；不声称 Host 重启去重 |
| **2.4** 记忆 keeper（off / assist / takeover） | protocol / pi-host / host / ui | ✓ | ✓ | `memory-agent-extension.test.ts`（动态 off、拒绝/成功、user-command nudge 合并、off/无回合零调用、重复 commandId 不进 keeper material、`</user-terminal>` 编码）；`phase2-e2e.test.ts`（Host 顺序 apply、off 不注入）；`session-e2e.test.ts`（当前模型后台调用、默认/旧值/实时全局/session override、失败投影，memory_edit 不进主对话）；`context-routes.test.ts` / `harnessBlockPresentation.test.ts` / `harnessMemoryPresentation.test.ts` | ✓（缺省 takeover） | off：不维护、不注入、Pi 压缩；assist：维护/注入、Pi 压缩 | D-238 已接用户命令、steering、用户计划编辑和本次 Run 返回的材料加速；共享在飞/冷却队列，分支导航清掉旧待处理事件并丢弃旧调用结果。`thread-return.test.ts` / `thread-memory-return.test.ts` 核对持久提交、旧报告不重发、真实嵌套 owning/session 绑定与关闭接收者；keeper 定向 11 项与 Host 3 文件 7 项通过，公开 steering faux SessionHost 已测。辅助费用/Token 明细按 D-080 不提供。不把 faux keeper 写成真实模型质量。D-233：同一目标重复投递最多 nudge 一次；不声称 Host 重启去重 |
| **2.5** `todo` / `plan` 块 | host / pi-host / ui | ✓ | ✓ | `host/todo-tool.test.ts`（confidence 不改变写入）；`pi-host/test/harness/todo-tool.test.ts`（工具不弹写后确认、不发送确认字段）；`phase2-e2e.test.ts`；session state 侧栏可见可编辑（D-046） | ✓ | 不注册 | confidence 只作信息。需要批准时由既有 pre-tool plan/permission 流程处理；`todo.upsert` 没有第二确认协议（D-206/D-209） |
| **2.6** 接管压缩 | host / pi-host | ✓ | ✓ | `host/compaction.test.ts`（覆盖/错分支/block 修订/重启）；`compaction-extension.test.ts`（Pi 移除边界）；`session-e2e.test.ts`（零额外模型调用接管、Pi fallback、连续两次压缩）；`pi-hooks-contract.test.ts`（D-022） | ✓（takeover 模式） | 任一证据不足或 off/assist 时由 Pi 完成本次摘要 | coverage 有意保留在 Host 内存，重启后等下一次 material keeper 更新重建；facts 当前只可靠提供 touched files，不伪造当前诊断/checkpoint；测试为本地 faux provider |
| **2.7** 知识建议 / 审阅托盘 / 取代链 | host / ui / pi-host | ✓ | ✓（user-mark + memory decisions + Settings catalog + suggestions 槽位用户消息） | `knowledge-suggestions.test.ts`（同 scope 取代、并发相同 user-message 原子去重、dismissed/retired 不复活、trusted settings 合并）；`context-routes.test.ts`（审阅托盘完整 opened-revision CAS、auth/409/取代、显式建议消费 auto-accept）；`knowledge-catalog-routes.test.ts`（Documents workspace 身份、完整 opened-revision CAS、已停用/并发编辑冲突、跨 scope 不串）；`store.test.ts`（accepted 编辑、单 id 停用、reopen 后 recall 不含旧正文、user store 拒非 user 写）；`knowledge-services.test.ts`（`knowledge.suggest` 固定 actor workspace/user-message、协议不能伪造 scope/kind、消费 workspace auto-accept）；pi-host `knowledge-suggestion-extension.test.ts`；UI `KnowledgeSettingsPage.behavior.test.tsx`（scope/workspace 切换、迟到响应与旧 selection）、`KnowledgeSettingsPage.test.ts` / `knowledgeCatalogRequest.test.ts`；既有审阅托盘与标记测试 | ✓（用户显式动作；keeper decisions；配置 suggestions 后的用户消息） | 未配置 suggestions 槽位时不调模型、不借用主模型；设置不可读时保留 suggested；suggested/dismissed/superseded 不参与 recall | 真实付费 suggestions 模型质量未观察；Settings 完整浏览器点击链未跑。删除是 `invalidAt` 停用，不是物理删节点（D-208/D-211） |
| **2.8** 知识库语义召回（D-196 / D-198） | host knowledge | ✓ | ✓ | `knowledge-recall.test.ts`（向量命中、范围/状态/修订、完整长条目分块、换空间）；`vectors/acceptance.test.ts`（自动维度、绑定异常保留文本、不自循环重试、并发 bootstrap 不串 query、resolver 取消/关闭）；`knowledge-services.test.ts`（actor 工作区传递、公开 recall / Zone 2 取消）；知识库 134 项及新增边界/公开接线 9 项通过 | ✓（未配远程保持文本；有效配置启用派生向量） | failed/unavailable/partial/empty 分列，绑定解析异常也保留文本 | 复用共享代际库、chunker、缓存与调度；受影响 id 即时失效，配置刷新与关闭已接。证据来自真实模块和 faux provider，不证明完整桌面 IPC 或真实外部质量；权威 `.tdb` 不变，不回退 MiniLM |
| **2.9** 普通模型槽位 | protocol / pi-host / ui | ✓ | ✓ | `protocol/test/harness-model-slots.test.ts`、`roles.test.ts`；`pi-host/test/harness/session-e2e.test.ts`（reader / permissionJudge 实际功能调用）；Harness Settings 生产入口 | ✓（依赖能力各自按配置启用） | 未配置辅助槽位不注册或走无 LLM 路径；仅 hardImplement / review 明示回退主模型 | 当前十个普通槽位不含 embedding/rerank；后者是独立配置种类（3.16B/E）。聊天模型列表仍依赖 Pi session。三套预设只填空槽位；D-080 的普通会话统计与 ThreadRun 记录保持 |
| **2.10** `recall` | host / pi-host | ✓ | ✓ | `host/recall-tool.test.ts`（workspace + user 合并）；`store.test.ts`（停用后 reopen 不再召回旧正文）；`phase2-e2e.test.ts` | ✓ | 不注册 | Application Host 已懒加载 `user.tdb`；Settings 目录与公开 recall 共用同一权威。suggested/dismissed/retired 不进入有效召回 |
| **3.1** 符号图采集器与查询 | host knowledge | ✓ | ✓（defines + imports/connects/associates；explore 路径候选 + 摘录注解 + `related`） | `knowledge/store.test.ts`（节点/边、代际、match、反向 import、紧凑候选 close/reopen 后补关系）；`import-resolve.test.ts`；`symbol-runtime.test.ts`；`catalog-scan.test.ts`（并发扫描合并、无事件正文修改后重扫、连接移除/恢复、不重采集消费文件） | ✓（随 Documents mutation + 打开后火忘冷扫描） | 未知语言只 touch file；结构 unavailable 保留最后图；范围绑定磁盘 revision，脏缓冲不入图。未确认关联仅存在 file metadata，不建 link 节点 | D-236 已移除同名闸门再访的重读/重解析；extractor 3 使旧目录下次重采集。当前 2520 文件冷建 185767.1 ms、显式未变重扫 10314.095 ms，详见下方观察；没有同语料改前对照。D-140/D-141 的 18.4/4.8 分钟保留为历史。仍不冷启 LSP；`references`/解析后 `calls` 未接，目录限 TS/TSX/JS/JSX。D-237 已补完整重扫的外部删除对账：missing 确认、代际条件删除与排队取消；失败/截断/未知 inventory 保留旧图。完整桌面冷建未实测 |
| **3.15** 快速 explore：查询上下文、分组计划、成组选段与局部补查（D-175–D-189） | protocol / host / pi-host | ✓ | ✓ | `explore-query-run.test.ts`（start 到达即读、原问题词法与慢语义并行、同文件晚到语义重建、稳定 viewId、required 组、单元来源排名、来源终态与冻结）；`explore-query-services.test.ts`（固定来源、完整 actor、受限 scope、取消与响应未送达、fixed roots 传递）；`router.test.ts` / `service-host.test.ts`（授权 cancel、request actor key、session 换代清理）；`semantic/runtime.test.ts`（查询取消停止等待）；`explore-model.test.ts` / `explore-tool.test.ts` / `host-services-bridge.test.ts`（模型输入、Host accepted、补查失败保留首选、timeout/dispose 实传 cancel）；`session-e2e.test.ts`「runs plan expressions through ModelRuntime…」（公开 `explore` → `completeSimple` → 新表达搜索 → 最终原文）；`knowledge/store.test.ts` / `knowledge/semantic/store.test.ts`（scope 内 Top-K、`.` 快路径、文档更新删除） | ✓（公开 `explore` 默认；配置 `models.explore` 后同一路径启用模型，未配置保留算法/向量） | 未配置或调用失败保留已取得材料，不回退主模型；取消/失败/不可用/无命中/截止未完成分列 | 真实 `models.explore` 质量与墙钟未观察，不作为启用门。120s/8s 是尚未按真实 provider 定标的工作预算，不是 SLO。D-189 已让受限 scope 的图/向量后端在有效 roots 内计算 Top-K，reverse importer 在截断前过滤；`.` / 空 roots 保留未受限语义快路径。native ONNX 当前批不能被 JS signal 硬抢占，取消会停止等待并丢弃迟到结果。远程嵌入、向量复用、语义草稿覆盖与专用 reranker 见 3.16B–E；router 取消与超时目前同为 `timeout` 码；`harness-e2e` #3 是既有 D-103 |
| **3.16B** 远程 embedding 配置、后台绑定与 OpenAI 兼容调用（D-190） | protocol / pi-host / host / ui | ✓ | ✓ | `protocol/test/harness-settings.test.ts`（workspace 不能留下 embedding/rerank）；`pi-host/test/harness/openai-embeddings.test.ts`（乱序/缺项/维度/NaN/取消）；`pi-host/test/harness/background-inference.test.ts`（user/operator-only resolver、项目 provider 重定向隔离、binding 竞态、cancel→fetch、endpoint/credential space）；`semantic/harness-316.test.ts`；`session-e2e.test.ts`（旧手工 consumer 链）；`semantic-workspace.e2e.test.ts`（D-235：共用生产装配、真实 SessionHost/HTTP adapter、双执行目录路由、无效配置/失败状态）；`workspace-runtime.test.ts`（配置与取消生命周期） | ✓（未配置远程时本地 MiniLM；配置有效即走远程同一 space） | 远程失败/未绑定 Pi：语义 `failed`/`unavailable`，词法与图继续；同一查询不静默切回本地 MiniLM | 真实远程 provider 延迟、质量、成本未观察，不作为启用门。知识库语义召回已按 2.8 / D-196 单独接线，不回退 MiniLM。Host 从不接收或持久化 provider secret |
| **3.16C** 向量复用、完整编码与前台优先（D-191） | host | ✓ | ✓ | `semantic/harness-316.test.ts`（embedText 复用、单块重嵌、并发扫描合并、前台插队、partial 首发、迟到 revision、scoped 缓存仍做授权 Top-K）；`semantic/chunker.test.ts`（超长单行续切、多块覆盖无缺口）；`semantic/minilm.test.ts`（Node ORT session 线程） | ✓（随语义索引） | 缓存满按字节软预算淘汰，不拒绝查询；后台当前批完成后前台优先 | 完整冷扫墙钟仍未量得（沿用 3.16A）。远程 Host 侧按字符长度续切，不是远程 tokenizer 精确计数 |
| **3.16D** 固定草稿与线程分支语义覆盖（D-192） | host | ✓ | ✓ | `semantic/harness-316.test.ts`（立即遮蔽、dirty-only、删除、supersede、捕获后继续编辑、兄弟线程隔离、缺向量≠缺正文） | ✓（公开 explore 的 `semanticRecall`） | 草稿/线程向量未完成：语义 gap/partial，词法与读取继续用已固定原文 | 物化 child 使用自身 Documents workspace，virtual 使用固定 WorkingBranch；copyIgnored 不自动扩大范围。D-235 公开 SessionHost 纵切已覆盖原生写入通知、后台发布后同回合 explore；完整 nested dispatch/桌面启动未测 |
| **3.16E** 专用 HTTP reranker（D-193） | protocol / pi-host / host / ui | ✓ | ✓ | `pi-host/test/harness/http-rerank.test.ts`（非法/缺失 ID、部分响应）；`explore-rerank.test.ts`；`explore-query-services.test.ts`（select=used 不调用、select=unconfigured 调用）；`session-e2e.test.ts`（旧手工 consumer 链）；`semantic-workspace.e2e.test.ts`（D-235 共用生产装配 → 真实 Pi `/rerank` adapter，结构化状态为 used） | ✓（`harness.rerank` 有效且本轮未用 LLM 选择时） | 失败保留来源排名与可读材料，details 标明未参与/失败；explore 整体不失败 | 真实 rerank provider 质量与费用未观察。当前 registry 无标准 rerank 方法，使用可配置 HTTP `/rerank` 契约，不把 chat/embeddings 改名为 rerank |
| **3.17** 按命令整理 bash / get_output（D-197 / D-199） | host / pi-host / protocol | ✓ | ✓ | `output-organize/organize.test.ts`（pretty 诊断、未知正文、混合命令、失败位置/watch 提示、UTF-8 首尾、超预算大块/提示、分片）；与 `observation-services.test.ts` 25 项通过；Pi 公开工具相关测试 24 项，最后截断复验 10 项通过 | ✓ | 未识别或不可归属的混合输出走通用展示；显式分页与 `out_` 读原文；旧 Host 未整理结果保留通用截断 | 只对实际 Host 整理结果免二次裁切。原文、字节游标与退出码保持；增量末片也标当前观察。不接包管理器通配、TOML、jest 专名或模型总结；不是完整 shell 解释器 |
| **3.2** `explore` + `grep` + `read` + `find`/`ls` 的磁盘/发起窗口草稿纵切；根会话 `edit`/`write`/`apply_patch` 写回同一缓冲（D-225 / D-228 / D-232 纠正身份、WAL 与补偿） | pi-host tool / host Engine / Documents / ui | ✓ | ✓ | `explore.test.ts`；`explore-service.test.ts`；`search-service.test.ts` / `search/content.test.ts`（dirty 排除先于有界 cap、regex/fixed/case/glob/context、写入后该路径改按磁盘搜索）；`document-read-source.test.ts`（固定字节、BOM、dirty-only、过期、写后读回自己的写；经 router 写缓冲后同一回合 read 见新正文）/ `pi-host/test/harness/read-tool.test.ts`（原生分页与图片）；`documents/authority.test.ts`（写入失效：原生写、Documents 写、根外路径不失效、过期仍不回退磁盘、overlay 与 clone 同步；缓冲写、二次 edit、用户续编 conflict）；`documents/authority-surface-identity.test.ts`（CRLF 二次 edit + apply_patch 不改盘、两 surface 路径一次 Registry undo、UTF-16/BOM 字节恢复、重开 catalog 为 compensated/needs-attention、owner 不可用不对账猜成功）；`documents/surface-mutation.test.ts`（共享计划、同一 operationId 整组 undo、前向 abort 后补偿用新 signal、delete/NUL unavailable）；`recovery/turn-coordinator.test.ts`（确认工具前 await，before/失败不失效）；`document-path-overlay.test.ts`；`find-ls-tool.test.ts`；`workspace-mutation-journal.test.ts`（surface 不 journal、普通路径仍 journal）；`apply-patch-tool.test.ts`（surface 匹配不写盘且携带 revision/hash、readSource unavailable 即使磁盘可匹配也不写、混合失败诚实状态）；`session-e2e.test.ts` 固定 surface find/ls 与「fixed surface edit」公开 Pi edit → Host → Registry | ✓ | 已知 dirty capture 不可用时相关 read/search/find/ls/LSP 导航都不读磁盘；其余路径继续 disk；Host 未声明对应 capability 时保留 Pi built-in。D-225/D-228/D-232：snapshot 拥有的路径写 Registry 缓冲，不隐式保存；用户续编 conflict 保留其正文；混合写入先预检全部磁盘成员并持久记录外部阶段。磁盘写到 target-after 捕获之间崩溃仍明确 needs-attention，不冒充自动恢复 | D-090 第一组已验证：`limit` 只管输出条数（`explore.test.ts` T1）；search-service 收 actor/inputContext，explore 不再自带草稿匹配（`explore-service.test.ts` T2）；词项分组与 anchors 字面优先、非硬过滤（T3/T4）；测试路径不默认降权（T5）；按需物化记 `not-requested`（T6）；互补打包（T7）；自身字节预算与句柄（T8）；工具接受并转发 `anchors`（`explore-tool.test.ts` / `session-e2e.test.ts` T9）。D-092 已验证：候选模式 30 个匹配文件×每文件 12 命中、预算 200 时 30 个文件都进候选且总命中 ≤ 200，路径序最后的文件仍在（`search-service.test.ts` breadth-first）；文件数超过预算时报 `filesDropped` 且与命中裁剪分列；grep 同输入仍是默认 limit 100 的深度优先截断。六个小项已收：`showHandle` 为真时 `result.text` ≤ `byteBudget`（`explore.test.ts` / `explore-service.test.ts` T8）；返回对象不含 `searchIncomplete`；空白 anchor 过滤后 `supplied` 保留原样（`explore-service.test.ts`）；每路 `rgSearch` 用局部 partial；`fileScore` 每文件一次；一个 anchor 文件排在只匹配 3 个拆词组的文件之前。验收复验补的两项已修并有断言：`filesDropped` 取单次查询最大值作下界（`explore.test.ts` 跨词项不求和、`explore-service.test.ts` 250 文件 × 两个重叠根仍报 50 而非 100，正文"at least"）；工具 schema 接受空白 anchor 交由 Host 过滤（`explore-tool.test.ts` 对 `tool.parameters` 直接 `Value.Check`，非字符串仍拒）。D-232 的生产链与定向反例已接，但磁盘写成功到 target-after 捕获之间仍以 needs-attention 收口；完整桌面 Registry、生产 Host 进程重启对账与 macOS/Linux 会话未实测，3.2 写入纵切不得标 Proven。证据见 D-228/D-232 记录。之后：结构切片消费 6.4 带修订范围、上下文覆盖、模型增强 |
| **3.3** `related` | host / pi-host / protocol | ✓ | ✓ | `related-tool.test.ts`（Host：没有 vs 不完整、反向 import、空目录 vs 未收录、未解析 specifier）；`pi-host/test/harness/related-tool.test.ts`（默认注册、`tools.related: false` 省略）；`session-e2e.test.ts`「session e2e — related」（真 Pi：`activeTools` 含 `related`，已打开 store 返回定义/Imported by，正文含 `lsp.references` 分工、不含 rank） | ✓ | store 未打开 → `unavailable`（不开库）；空目录 / 未收录路径 / 名字未命中 → `empty`；查询抛错 → `failed`。不是 `lsp.references` | 不做 PageRank / 多跳 / references 边。目录未扫到的语言是不完整或 empty，不是失败 |
| **3.4 / 3.5** 原生线程运行时与 7 个工具 | protocol / broker / host / pi-host | ✓ | Partial | `workspace-identity.test.ts`（Documents 给原目录与 scratch 不同 workspaceId；session.create + Harness router + 公开 dispatch 建孙线程；孙写入 owning catalog 且 `parent.kind` 为父 Thread；threads/wait/Zone 2/lost resume 看直接子层）；`thread-registry.test.ts`（session binding 重启后仍指向 owning workspace；catalog 无 binding 可重建；stale binding 拒绝）；`thread-services.test.ts` / `zone2-threads.test.ts`（execution workspaceId 不能冒充 owning catalog；binding 无 owner 拒绝 thread tool；生产 `thread.kill` → runtime cascade 含 queued 子孙；`src/foo..bar` / `version...txt` 经 dispatch 接受；非法 scope 带草稿 cleanup）；`dequeue-permissions.test.ts`（生产 `onThreadDequeued` → `session.create` 带 accept-edits，live bypass 不能放宽）；`knowledge-owning.test.ts`（owning≠execution 时 recall/suggest/Zone 2 打 owning store）；`thread-worktree.test.ts`（父 worktree 内独立 `git init` 持久化 `executionBaseline`，inspect 不对该执行 SHA 报 bad object）；`working-state/execution-baseline.test.ts`（Git 父仓库 isolated dispatch → `document.branchWrite` → `workingBranch.ensureMaterialized` → shell 写 → settle/drain → native result → merge 根目录；reclaim/rematerialize 不引用已删子仓库对象；staging-promoted 恢复写出可解析 execution baseline）；`working-branch-view.test.ts`（lease 后重读正文与 `@revision`；`explore.query.start` pin 后词法/原文/语义仍用快照）；`thread-runtime.test.ts`（create 传入冻结 permissions；dirty 文件内容中途替换且路径集合不变时 `baseline-changed` 且不留 branch；kill 取消在飞 preparation；archive 先归档子孙；父 archive/kill 与子 restore/merge 并发不复活、不留活跃 Run） | — | Host 未声明 harnessThreads 时不注册 | D-216–D-224 已接线 owning/execution、执行 Git baseline、查询级固定视图、dispatch 内容身份、branch Integration WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle serialization 与 scope 完整 `..` 段。D-231 已补 retrieval 受管 scratch、持久 managedRoot 与 Host/backend 再授权；旧记录缺根时拒绝自动动作。真实付费嵌套 Pi 与完整桌面重启未测。`nested-threads.test.ts` 中部分 fixture 把 `resolveRuntimeWorkspaceId` 钉成同一个 `"ws"`，这部分不能作为 owning/execution 身份证据 |
| **3.6** 角色目录 / 团队提示 | protocol / pi-host / host | ✓ | Partial | `host/roles.test.ts`（hard-implement/frontend 含 nest 工具，review/retrieval 不含 dispatch；retrieval 含 submit_facts / explore，不含 bash/edit/write）；`thread-services.test.ts`（未授权 dispatch 拒绝、binding 无 owner 拒绝、生产 kill cascade、dotted relative scope 接受、retrieval 无 model 拒绝、`carryBlocks: false`）；`workspace-identity.test.ts`（execution workspaceId 下公开 dispatch 仍写入 owning catalog）；`dequeue-permissions.test.ts`（queued dequeue 把 accept-edits 送进 session.create）；`nested-threads.test.ts`（captureScopes 继承父冻结范围）；`protocol/test/permission-gate.test.ts`（缺省 overlay 冻结为 normal；accept-edits 不被 live bypass 放宽） | — | 未配置槽位的角色不出现；无 nest 工具的角色不能嵌套 | 角色 allowlist 保留。D-219 / D-222 / D-223 已接线冻结 overlay、dequeue 生产回调、级联 lifecycle serialization 与 scope 完整 `..` 段。D-227 已把 retrieval 做成事实 Thread；D-231/D-234 补受管输入与耐久证据，见下一行。真实付费嵌套 Pi 会话未测 |
| **3.6 retrieval** 长任务事实检索（D-227 / D-230 / D-231 / D-234） | protocol / host / pi-host | ✓ | Partial（faux 公开纵切与定向反例已接线；真实付费 retrieval 与完整桌面重启未测） | `protocol/test/harness-threads.test.ts`（`thread.facts.set` 方法表、seal 不发明 source-checked、question 用 brief、completion 为 delivered）；`retrieval-evidence.test.ts`（无关 claim 只 source-checked、顺序无关聚合、短 URL receipt、换绑 URL 拒绝、耐久 excerpt、output handle 复制后 dropSession 仍可读、后续磁盘变化不丢当时身份）；`thread-facts.test.ts`（child 校验、settle 去掉建议字段、cancel 保留 facts、lost 保留 pending 且新 Run 清空、deferred-reader settle 与 lost→resume 拒绝旧 submit）；`retrieval-artifacts.test.ts`（重开 catalog 仍可读 excerpt）；`nested-threads.test.ts`（retrieval dispatch 在返回/排队前沿正常 isolated 分支固定父虚拟或物化状态，不回根 live）；`thread-worktree.test.ts` / `materialization-switch.test.ts`（持久 managedRoot、归属拒绝、只读输入物化/回收）；`web-fetch.test.ts`（仅 active retrieval 请求可得耐久 receipt；普通 fetch 不铸 receipt；取消不缓存）；`thread-services.test.ts`（无 model 拒绝）；`select-tools-web.test.ts`（根会话不注册 submit_facts）；`retrieval-session.e2e.test.ts`（父公开 dispatch → 真 child SessionHost → explore/read/related/submit_facts → settle → Zone 2 / wait / read_thread；outside 不进 facts；invented range 不 source-checked；不写盘；不复制父对话） | ✓（配置 `models.retrievalAgent` 后同一 dispatch 路径启用；未配置不注册） | 未配置槽位：角色不出现且 Host 拒绝无 model 的 retrieval dispatch，不借主模型。scope 外/不存在/越界不得标 source-checked。无 bash，故默认不能改工作区 | D-231/D-234 的生产链与定向反例已接，但不得标 Proven。旧 worktree 记录缺 managedRoot 时拒绝自动动作；不把 faux provider 写成真实模型质量。webfetch/websearch 仅 Host 已装配时可用。取消/失联复用既有 Thread 生命周期。不预加载整仓，不新建向量库或 daemon。真实付费 retrieval、完整桌面 Host 重启、授权 web 抓取仅未实测 |
| **3.7** review 传感器 | host / protocol / ui | ✓ | ✓ | `host/review-sensor.test.ts`（空 diff / 关闭 / 无角色跳过；hidden + `startRun`；同结果运行去重与失败关闭）；`thread-runtime.test.ts`（settle 后 create+start+spawn，prompt 含固定 diff、不含父对话；`resultRevision + reviewThreadId + reviewRunId` 回写、迟到旧 Run 丢弃、结构化 gate 在完成/失败/取消时解除）；`zone2.test.ts`（三事实分行、review 失败/取消可见）；`protocol/test/harness-settings.test.ts`（`review` 用户所有、默认 enabled/非 gate） | ✓（默认审阅；gate 默认关） | 未配置 review 槽且无主模型时跳过，不是失败；`enabled: false` 不派发 | 触发是已发布子结果，不是父 journaled 变化。隐藏线程不进默认 `<threads>` / UI 列表。faux provider 只证明调用链，不是真实模型审阅质量。Settings / 线程面板完整浏览器点击链未跑（D-207/D-210） |
| **3.8** LSP 导航工具与按来源隔离的语言视图 | protocol / host / pi-host / ui | ✓ | ✓ | `host/lsp/supervisor.test.ts`（14：视图隔离、Host 单调版本、同修订不重发、`expectedRevision` stale、关标签页不动 agent 视图、LRU 上限与空闲释放）；`host/lsp-nav.test.ts`（真实 fixture 进程下 `surface` 保持 absent、固定草稿、草稿不可用不回退磁盘、`unpinned`、stale 重试一次、一基位置/三态）；`diagnostics-adapter.test.ts`（磁盘修订随写入变化、后缀同名不串台、pending）；`knowledge/symbol-runtime.test.ts` / `store.test.ts`（符号行携带 revision、空修订被拒）；`ui/language-id.test.ts`（单一身份表）；`lsp-tools.test.ts`；`thread-runtime-capability.test.ts`（握手能力门） | ✓（Web/Application Host） | Host 不声明 `harnessLspNavigation` 时四个工具不注册；agent 视图惰性起进程、空闲释放，占用可由 `inspectViews()` 查询 | `symbols` 需一个代表文件路径来选择语言 provider；未知后缀明确 unavailable（D-051）。跨文件位置只能标 `unpinned`：LSP 不报告它自读文件的版本，且可用的 Documents mutation 观察不覆盖 Pi 原生写入，因此不做 stale 判定。`explore` 结构展开尚未消费带修订的符号范围；Host 视图占用尚无 UI 呈现。隔离线程因自身 workspaceId 各有一个语言服务器进程，进程复用不在 D-087 范围内 |
| **3.9** 观察类工具增量视图（`get_output` / `diagnostics`） | protocol / host / pi-host / ui | ✓ | ✓ | `observation-cursors.test.ts`（观察者/类型隔离与清理）；`observation-services.test.ts`（Unicode 字节游标、显式分页不推进、压缩重置、诊断新增/消失）；`shell-supervisor.test.ts`（转后台后继续采集并解析退出）；`harness-e2e.test.ts` #3/#7（完整 bridge 链）；`output-tools.test.ts`；`counter-tracker.test.ts` | ✓ | 显式 offset/length 与 `full: true` 保留全量/随机访问；Host 重启回到全量基线 | 当前游标覆盖 Pi 会话观察者；未来用户面板若直接观察 shell/diagnostics，应使用独立 observer id（D-052） |
| **3.10** session state rail / overlay / discussion threads | ui / host | ✓ | ✓ | `thread-routes.test.ts`（session 权威、鉴权、integration、archive/restore/reclaim/space）；`thread-runtime.test.ts`（同 session 转换、归档及普通 settled 恢复）；Pi `thread-runtime-session.e2e.test.ts`；`HarnessThreadsPanel.test.ts`（事件与占用投影）；`HarnessThreadsPanel.behavior.test.tsx`（真实 React：等待恢复后用新 Run/cwd 打开、占用失败不打开并显示原因）；`HarnessThreadIntegrationPanel.behavior.test.tsx`；`PiTimelineEntries.renderMode.test.tsx`；`HarnessSessionStateTrigger.test.tsx`；`piariumEvents.test.ts` | ✓（工作区持久消息与 session state 有内容时） | Host 无线程运行时时不显示入口；原线程工具仍可操作 | 浏览器完整归档→回收→恢复点击链未跑。rail、overlay 与时间线标记共用一个 session-scoped feed（D-062–D-064）。合并预览见 D-203；归档/占用见 D-204 |
| **3.11** Harness Fleet provider | pi-host / host | ✓ | ✓ | `piarium-harness-adapter.test.ts`；复用 `phase3-e2e.test.ts` 的 Host thread service 链 | ✓（普通会话） | 专用 `threads` / `wait` 工具 | 子会话按冻结的角色工具 allowlist 不注册该 provider；父会话 Zone 2 已走同一 registry 投影 |
| **3b.1** 权限 fallback（`tool_call`）与插件共存 | protocol / pi-host / host | ✓ | ✓ | `host/permission-gate.test.ts`；`phase3b-e2e.test.ts`；`session-e2e.test.ts`（真会话：allow once / deny / 会话授权 / 高风险覆盖 / 只读不弹窗 / 公共 service 契约下插件与 fallback 只弹一次）；`permission-gate-extension.test.ts`（同会话让位、跨会话隔离、热卸载恢复）；`router.test.ts`（静态 capability / path） | ✓ | 插件在场时由 `pi-permission-system` 单独裁决 | 原生 fallback 只覆盖 Harness 工具；不是插件的能力等价替代（D-044） |
| **3b.2** Smart fallback | pi-host | ✓ | ✓ | `session-e2e.test.ts`（配置槽位后真实模型调用）；`permission-gate-extension.test.ts`（普通 ask 可放行、高风险不调用 judge） | 用户选择后 | 无槽位时不可选、判断失败时 ask | 插件活跃时应使用其显式 `authorizerChain`，原生 Smart 不参与裁决 |
| **3b.3** foundational 权限插件 | protocol / pi-host | ✓ | ✓ | `permission-gate-extension.test.ts`；插件 v27 公共 service 契约复审（D-044） | ✓ | 插件缺席时原生 fallback | 保留 provisioning；未来替换须单独证明完整能力等价 |
| **T4** 可选配对回放记录器 | evaluation / scripts | ✓ | ✗（尚无真实模型配对结果） | `evaluation/harness/cases.json`（6 个历史任务）；`scripts/harness-replay.test.mjs`（commit/ancestor、记录、配对与失败分类） | — | 不运行不产生模型请求/设置变化 | 自动执行尚缺单会话配置；只有实际安排配对时才需要，不再阻塞其他功能或默认启用（D-078） |
| **3.4a** 内容寻址工作分支、草稿基线与结果物化 | host / protocol / pi-host | ✓ | Partial（D-216–D-224 已接线 owning/execution、执行 Git baseline、查询级固定视图、dispatch 内容身份、branch Integration 锁顺序/WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle serialization 与 scope 完整 `..` 段；D-231 又补受管 retrieval scratch、managedRoot 与只读 settle。旧记录缺 managedRoot 时拒绝自动动作，真实付费嵌套 Pi / 完整桌面重启未测） | `working-state/working-state-store.test.ts`（schema 1/2→3、draft objects/ref、固定多修订、窄路径与 captureScopes、effectiveState/origin、writeRevision CAS、新文件 mode 不写 `.piarium-mode-probe-*`）；`working-state/draft-baseline.test.ts`；`working-state/materializer.test.ts`；`working-state/branch-view.test.ts`；`working-state/working-branch-view.test.ts`（Host router 上的 read/grep/find/ls，lease 后正文与 provenance 一致，explore start pin 后词法/原文/语义不读后写）；`working-state/working-branch-writes.test.ts`（虚拟 write 不碰父盘、兄弟隔离、迟到修订冲突、物化后 publishDirectoryResult）；`working-state/execution-baseline.test.ts`（isolated init 虚拟写+shell 写 settle/merge，无 bad object；reclaim/rematerialize；crash recovery baseline）；`working-state/virtual-write-invariants.test.ts` / `virtual-write-tree.test.ts` / `materialization-switch.test.ts`（失败物化并发写、孙 merge 后再写再物化、writeRevision 标签、树拒绝、semantic pin、abort/crash 恢复）；`working-state/workspace-baseline.test.ts`（Git 变化集与 ignored/captureScopes、unborn/非 Git、字节诚实、取消不建分支、listing 失败不发明完整 inventory、gitlink 列出）；`thread-runtime.test.ts`（surface 释放后的 queued spawn、revision 0、copyIgnored scope、虚拟 spawn 绑定、scratch 回收、bash 预算预占、prepare 后父漂移隔离、Git 失败/捕获窗口变化/writer/gitlink/dirty 内容替换不建完整分支、setWorkingState 失败清理未绑定 branch）；`thread-services.test.ts`（dispatch 必准备、失败删除、baseline-changed 可重试）；`nested-threads.test.ts`（父虚拟分支作孙基线、嵌套 merge 不写根盘、父结果再入工作区、captureScopes 继承父冻结范围）；`working-state/integration-coordinator.test.ts`（虚拟新文件省略 mode 仍可应用到工作区；物化父 directory 不把 recovery objects 写入父目录且 live/reconcile 走 execution Documents gate；无法解析 execution directory 则 needs-attention；branch 集成对账/撤销）；`dequeue-permissions.test.ts`；`knowledge-owning.test.ts`；`thread-registry.test.ts`（binding 重建与 stale 拒绝）；`thread-worktree.test.ts`（fixed/live、virtual scratch、detached Git 上下文、`executionBaseline`）；`workspace-identity.test.ts`；`working-state/path-requirement.test.ts`；pi-host `read-tool.test.ts` / `find-ls-tool.test.ts`（working-branch provenance）；`workspace-mutation-journal.test.ts` / `apply-patch-tool.test.ts`（`document.branchWrite` 优先，disk 才落盘） | — | 旧 Git base/resultCommit 是导入来源；带草稿的 Thread 缺原生结果时不走旧合并旁路；shared/none 仍读 live 父目录 | D-239 已接旧结果引用释放 UI、Host 依赖重查与中断对账；当前分支/结果和仍在使用的版本保持保护。Merkle 优化、跨平台 CoW 与整个 Thread/当前分支删除 UI 未交付。D-220–D-223 已关执行 baseline / 固定视图 / dispatch 内容身份、branch Integration WAL、directory reconcile execution gate、dequeue 冻结权限、binding 对账、知识 owning、级联 lifecycle 与 scope segment 反例；D-231 补受管 retrieval 目录和只读 settle。旧记录缺 managedRoot 会拒绝自动动作；真实付费嵌套 Pi 与完整桌面重启未测。物化预算与占用治理见 D-204；显式 copyIgnored 已随 branch 冻结并捕获后续新增/修改/删除；基线读工作目录字节，不把 Git blob 冒充转换后正文 |
| **3.5a** 固定修订 Integration、草稿写回与绑定预览（D-203） | host / protocol / ui | ✓ | ✓ | `integration-coordinator.test.ts`（旧预览拒绝、持久 intent/回执、故障与条件补偿）；`integration-surface-vertical.test.js`（真实 Documents barrier + Registry + Coordinator，磁盘/草稿同一操作合并及撤销，草稿变 clean）；`documents/authority.test.ts`（定向注册、取消与固定来源更新）；UI `documents/registry.test.ts`（实例替换、观察者异常、重试/撤销）；`HarnessThreadIntegrationPanel.behavior.test.tsx`（真实 React 挂载、无请求循环、迟到丢弃、提交审阅绑定）；`thread-routes.test.ts`、Pi `phase3-e2e.test.ts` | ✓（UI 与 agent 共用 Host 定向执行；缓冲不保存） | 不明执行状态保留 needs-attention；不可用缓冲不写盘；失败不等于未写入；旧输入来源不冒充新正文 | 草稿目标支持文本；缓冲无法表达的类型/权限位变化明确 unavailable。完整浏览器点击链未跑；可应用性不代表测试或行为兼容 |

## 当前缺口与后续顺序

**3.15 A–D 已接入生产调用链（D-176–D-189）。** 公开入口仍是 pi-host `explore`。Host 持有短生命周期查询：开始时固定问题、
范围与 `inputContext`，原问题词法/图/语义与计划模型并行；新表达真正执行搜索；候选模型看到最终挑选前的当前单元；Host
校验后提取原文。未配置或模型失败保留算法/向量材料并标明未参与，不回退主模型。retrieval 与扩散模型仍按后续项，不是本行前置。

**D-236 目录观察（2026-09-12）。** `bun run --cwd packages/web symbol-graph-query` 在本机对测量时的 2520 个 tracked
TS/TSX/JS/JSX 文件调用生产 `scanWorkspace`、tree-sitter 和 TriviumDB；枚举为 `git ls-files`，Documents 端口用磁盘读取/正文哈希适配，
没有启动完整桌面。冷建 **185767.1 ms**，显式未变重扫 **10314.095 ms**。两次扫描共读 **7560** 次，outline/imports/literalCalls
各 **2520** 个请求，第二次没有结构采集；不是实际 parser 缓存命中的埋点。产物 **2520 files / 26295 symbols / 14681 active links**，
合计 **43496 nodes**，readFailed/runtimeErrors 均为 0。热查询单次 searchSymbols/findLinks/findImporters 为 8.242/0.653/166.327 ms。
未做同语料的改前受控测量，不把 D-140/D-141 的历史仓库耗时用于提速百分比，也不把符号目录数字用于嵌入索引。
`catalog-scan.test.ts` / `symbol-runtime.test.ts` 8 项与 `store.test.ts` 44 项通过；包含取消保留旧图、候选重开后补关系、连接正文移除/恢复，
该轮不包含无事件外部删除旧路径的对账；后续 D-237 已补，fs/search、catalog-scan、store、symbol-runtime 共 67 项定向通过。脚本已去掉固定 `revisitCount: 0` 和把 outline 请求数叫作 `parsedFileCount` 的字段。

**3.16B–E 的身份/配置/取消与异步发布边界已按 D-194–D-195 / D-235 纠正，共用生产装配与原生写入通知已有公开工具证据。** Settings
`harness.embedding` / `harness.rerank` 仍是用户所有配置种类；Pi 后台 provider 定义只取 user/operator 层，项目 provider 继续只影响
普通聊天。Application Host 按 workspace 保存 cwd/settings/backend/runtime，共享的只有本地 MiniLM、调度器和完整 space 身份下的
数值缓存。远程方法与 cancel 只在内部 HostMethod；公开 Runtime surface 不能调用。空间身份使用去凭据的实际 endpoint/API、最终维度
及 embedding 参数，配置变化启动该 workspace 新扫描。活跃 isolated child 改查自己的 Documents workspace，不再把父 WorkingState
整表当语义语料；仍为 virtual 时必须取得固定 WorkingBranch 视图。增量写入在读取正文前沿冷扫的文件筛选，`copyIgnored` 不自动扩大语义语料。原生 Pi journal after 在工具答复前通知同一索引，不等待 settle。rerank 使用同身份原文视图，重复及并发 finish 共用一次判断，取消可到 Pi fetch。

**本轮接线证据与未验证项。**

- 定向证据：protocol 覆盖 missing/invalid 与 public method 排除；pi-host `background-inference.test.ts` 覆盖项目 provider
  重定向不能取得用户 key、完整 binding 竞态、endpoint/credential space 与 cancel 到 faux fetch；Host
  `workspace-inference.test.ts` 覆盖双 workspace 交错、取消丢弃迟到结果及 missing/invalid/unavailable；`semantic/runtime.test.ts` 覆盖旧发布不解除新编辑遮蔽、读失败/恢复、旧目录清单不删新变更、空目录重启清旧向量、查询固定 backend、范围内草稿和后台建设；
  `fs/search.test.ts` 用真实 Git 覆盖 ignored 与强制 tracked 文件的增量筛选；`host-controller.test.ts` 用真实 controller/transport 覆盖排队取消、重复批次与畸形请求清理；finish 测试覆盖异步 Settings 判断预留、并发及重复终态、partial score 和 malformed 降级；UI 测试覆盖隐藏字段 round-trip。
- D-235 新增 `semantic-workspace.e2e.test.ts`：公开 `explore` → Host Router/Services → `index.ts` 同一 `WorkspaceSemanticRuntime`
  → 真实 SessionHost 的 Settings/BackgroundInferenceRuntime → faux HTTP embedding/rerank → 真实 Documents 与代际向量库。
  两个执行目录分别路由到对应 SessionHost，源码/查询请求与各自凭据相符；纯语义夹具没有词法命中。真实 Pi `write` 的 after
  经 recovery coordinator 先通知、后答复；后台发布后，同一次 Pi prompt 的下一次 `explore` 返回新正文/修订，早于 recovery turn settled。
  未配置、无效绑定、远程失败分别核对绑定状态、来源状态与实际远程请求，不能只比较带随机 ID 的文本。3 项通过。
- `workspace-runtime.test.ts` 的 6 项覆盖 virtual pin 不可用、退休 worker 的迟到绑定、配置刷新、订阅恢复、Settings 等待取消与
  关闭后的迟到 watch 清理。相关 runtime / workspace-inference 合计 20 项通过。
- 上述夹具复用生产装配模块，但 workspace broker 的转发与配置 watch 是本地适配；不等于完整桌面启动、实际 broker 进程重启，
  也没有跑 nested dispatch → 物化 → child SessionHost 的整条链。真实 embedding/rerank provider 的延迟、质量与完整向量冷扫仍未观察。
  旧 `session-e2e.test.ts` 的手工 remote consumer 证据范围保持原标注。
- 3.16A 已在此前提交：`37b12e8e`（本地 embedder 运行时）、`8752e039`（语义索引/打包）。D-175 设计正文提交为 `88ca06e5`，
  当时尚未改变运行行为。

**已交付的基础。** D-082–D-089 的窗口来源、草稿失效/写入边界和语言视图，3.11 的结构来源，3.12 的图读者，以及 3.13/3.14
的查询与呈现修复保持。旧 3.15①②④ 的到达理由、文件角色和 focusRanges/三字段接口已由 D-163–D-165 接线；D-166–D-172
已接本地 MiniLM、独立语义代际库、部分可查与 explore 消费者，并首次验证真实模型的局部词汇缺口。十问的旧观察保留在下表，
不是全仓语义质量证据；D-171 起位次来自渲染正文，不能与更早的 snippets 数组下标直接比较。

**3.16A 已提交的性能/发行证据（`37b12e8e` + `8752e039`，不是本轮）。**

- 真实数组批推理；切块尺寸查找避免逐行/逐字符重复缩短；语义存储使用增量计数、批量发布与合并检查点，恢复中断留下的 WAL。
  这些改动在 `semantic/{minilm,chunker,runtime,store}.ts`。按实际编码文本复用与前台优先已由 3.16C 接线。
- 模型 recipe 固定上游修订，构建自动准备发行包，after-pack 校验模型/运行时文件；Windows unpacked smoke 从实际
  `app.asar.unpacked` 模块加载 Host、MiniLM、ONNX，零词汇重合夹具命中排名 1，status/coverage/lifecycle 为 ready/complete/ready。
  入口：[Windows smoke](../packages/electron/scripts/smoke-windows-unpacked.mjs)。这是该夹具与打包链的证据，不是全仓召回结果。
- [存储探针](../packages/web/scripts/semantic-store-perf.ts)：3000 文档、真实 TriviumDB、假 embedder，旧实现总计 11.26 s，
  改后逐文档 6.56 s、8 文档一批 1.15 s。仅说明存储路径，不包含真实推理速度。
  [局部扫描探针](../packages/web/scripts/semantic-scan-perf.ts)：40 个 knowledge 文件、真实 MiniLM、621 块，首批发布 6.06 s，
  扫描 34.77 s；首批发布不是首个有用查询结果。旧全仓扫描人工中断，恢复后有 439 文档/8191 块，完整冷扫时间未量得。

**已核对的当前缺口。**

| 范围 | 当前代码事实 | 对应实施 |
| --- | --- | --- |
| LLM 局部语义决策 | 公开 `explore` 经 `models.explore` 调用计划/选段/可选补查；描述已写概念与标识映射 | 3.15D 已接线；真实模型效果未观察 |
| 多阶段查询 | Host 查询上下文 + `explore.query.*`；后续阶段沿用 start 来源；`harness.cancel` 传到查询与模型 | 3.15 共同上下文已接线 |
| 开放候选排序 | 已取消 `candidateTier`；开放候选按真实来源名次 RRF | 3.15A 已接线 |
| 当前单元与呈现 | 模型看挑选前视图；已删 `windowScore`；必需范围原子保留 | 3.15B 已接线 |
| 查询调度 | 到达即读；在飞主任务保留首批机会；共享截止可提前冻结 | 3.15C 已接线 |
| embedding/rerank 配置 | Settings 独立 Embedding / Rerank 段；workspace 不能改绑；不从 chat model id 推断能力 | 3.16B/E 与知识库 2.8 已接线，知识建设生命周期见 D-198 |
| 后台远程调用 | 隔离的 user/operator-only provider runtime + 用户 AuthStorage；Host 只提交已授权正文与冻结绑定 | D-194 已接线；真实 provider 未观察 |
| 复用、切块与推理调度 | space+purpose+embedText 复用；续切；前台优先；Node ORT session 线程；软预算缓存 | 3.16C 已接线；完整冷扫未量得 |
| 语义草稿/线程视图 | 查询开始 pin；草稿立即遮蔽并异步向量；物化 child 查自身 Documents workspace | D-235 已测独立执行工作区 SessionHost 的公开工具和同回合写后查询；完整 dispatch/桌面链未测 |
| 专用 rerank | HTTP `/rerank`；与 LLM select 互斥；失败保留来源排名 | 3.16E 已接线；真实 rerank 质量未观察 |

按 plan 0.7：3.15 A–D、3.16B–E、2.8、3.17 与 D-227 retrieval Thread 已接线。下一步是真实 provider
观察与扩散项。既有工作区范围和正文覆盖目标保留，活动工作集只改变建设优先级；没有采纳 sketch 替代全文或只索引热点的设计。

以下保留其他能力及历史检索阶段的验证记录；当前检索取舍以上述 2.8 / 3.15 / 3.16 行与 D-173–D-198 为准。

| 范围 | 已确认现状 / 待做 | 验证与外部边界 |
| --- | --- | --- |
| 2.4 记忆写入与模式 | block 以 source leaf 修订，活动祖先路径按 label 解析最近值；后代 copy-on-write，删除写 tombstone；create/update/delete 原子 CAS；keeper 仅 mark plan。默认 takeover，旧 bool、实时全局设置与独立 session override 已接；off 撤销后台写入和 Zone 2 block 注入。用户终端命令完成经 `memory.nudge` 加速同一 keeper，不另建循环 | `memory-agent.test.ts` 覆盖分支/CAS；`memory-agent-extension.test.ts` 与真 Pi `session-e2e.test.ts` 覆盖动态模式、主历史隔离和失败；nudge 合并/off 零调用为扩展单测。`phase2-e2e.test.ts` 覆盖 off 的 Host 注入边界。真实语义质量在使用中优化，不另设启用门槛 |
| 2.6 覆盖与证据 | coverage 绑定 keeper 实际 context entry ID、完整活动分支和可见 block 修订；removed range 按上次 boundary 与本次 first-kept 计算。partial/no-op 不推进，压缩后清除；Host 重启不冒充持久 checkpoint，下一次 material 更新可重建。facts 只给可靠 touched files，诊断/checkpoint 暂为空 | `compaction-extension.test.ts`、`compaction.test.ts`、`phase2-e2e.test.ts` 与真 Pi `session-e2e.test.ts` 覆盖缺口、错分支、修订漂移、重启、Pi fallback 和连续压缩；本地 faux provider 证明调用链与零接管模型调用，不宣称外部模型语义质量 |
| 3.9 / 线程观察 | 已实现并接线到 worker 送达边界：observation 使用单调 revision CAS；pending 跨 clear 失效；Router success commit / failure abort；shell、diagnostics、Zone 2 threads、thread list/wait 延迟推进，线程游标按 eventSeq 防倒退 | cursor/router/phase3 focused tests 已覆盖并发、固定时钟、clear、响应失败与增量行为。确认只到 pi-host 响应，不宣称 tool result 已耐久落盘；更强 acknowledgement 仍待独立纵切 |
| 窗口读取 / 3.2 | UI 输入自动捕获该 surface 全部 dirty records；正文只经 Documents 鉴权通道进入 Host 内容寻址内存 snapshot，runtime/Harness 传 ref。输入接受后 active、失败 release、下一成功来源替换、session drop 清理。explore/grep/read 直接读取固定草稿；find/ls 取得相对请求根的固定文件与虚拟祖先，并经 Pi 原生定义合并磁盘枚举；thread.dispatch 在请求内把保存字节和来源修订复制进持久 WorkingState。无 dirty 或不相关 root 走 disk，相关 capture unavailable 禁止磁盘回退 | `authority.test.ts`、`authority-surface-identity.test.ts`、`surface-mutation.test.ts`、`routes.test.ts`、`explore-service.test.ts`、`search-service.test.ts`、`document-read-source.test.ts`、`document-path-overlay.test.ts`、pi-host `read-tool.test.ts` / `find-ls-tool.test.ts` / `workspace-mutation-journal.test.ts` / `apply-patch-tool.test.ts`、`usePiSessionStore.test.ts`、`thread-services.test.ts`、`thread-runtime.test.ts`、`session-e2e.test.ts`。Host 重启后未消费 ref 过期，已创建 Thread 不受影响；agent 的 `lsp.*` 已按同一固定来源绑定并回报 revision/source，符号图只绑磁盘 revision（D-087）。观察到磁盘写入后该路径草稿失效、read/grep/explore/find/ls/LSP/dispatch 一起回到磁盘，journal 那条在确认工具前 await；`index.ts` 把 `observeToolWrite` 接到 `observeAgentWrite` 的那一行只有类型检查，没有跨 broker 的 e2e；shell 与外部进程写入未观察（与恢复日志同一边界）。根会话 `edit` / `write` / `apply_patch` 对仍由本轮 snapshot 拥有的路径经 `document.surfaceWrite` 写回同一 Registry 缓冲（D-225 / D-228），匹配用固定正文，`bufferHash` 只对规范化编辑器身份；成功后同一回合 read/edit 看到新缓冲；用户继续编辑为 conflict，不写盘、不隐式保存。普通磁盘路径仍走 mutation journal。混合 surface/disk 写入在第一笔写前记 `agent-mutation`，返回 per-path applied/conflict/compensated/needs-attention。`apply_patch` 在 `readSource` 非 disk 时停止。真 Pi faux-provider 纵切证明公开 `edit` → Host → Documents `requestSurfaceOperation` → Registry 完成回执，不是只调 helper。未测完整桌面 Registry 手工编辑、Host 进程重启对账与真实付费模型 |
| 查询内区分度 / 3.14 检查点三 | 同一张查询内权重表进入局部选择与打包（D-155）。`full-object` 只给对象/锚点；内容词原词命中是 `lexical`。已读正文按原词补种窗口，同组远距命中各算一簇。打包看自身加权覆盖、相对已选（含同文件）新增词组价值、正文成本；换文件不再是奖励。入口窗口已占住的词组，同文件尚未选中的函数/方法仍算本地互补。定位题已有直接答案时 `offTopic` 不展开、不进包（D-156）。设计 6.1 改为：无法判定无关 ≠ 已经证明有关。十问对照（`--skip-scan`）：1 满足（`harness-services.ts` register 可见 #3）；9 满足（request #1、register #3）；V1–V5 满足。6：`parseDocument` 可见 #2。4：`capabilitiesFromSpec` 可见 #16。5：classify 可见 #15；write 已读，匹配窗口从未生成；`self:` 占 3 个可见槽（rg 排除后仍被反向 import 拉回）。7：`document.writeGuard` 窗口已生成 501-522，未选中；inspect 仍读预算。3：supersede 可见 #1；8：reclaim 可见 #2。2 仍读预算（未核验 connects 占 tier 1）。10 仍 `not acquired`。**验收修正**（D-157）：问题 1 首条曾是测试夹具、生产注册退到 #3，`relationRoleRank` 接线后恢复为请求端 / 生产注册 / 夹具，register 回到 #2；问题 5 的 write 实为「`unit loadGraphFacts 147-238` 已选中，`links.push` 在第 220 行落进 `unit.omitted` 的 220-238」，不是窗口未生成；问题 4/6 的翻转已用服务返回的 `text` 复核，不只是数组位次。大单元正文组装是命中驱动的，没有查询词匹配的行进不了正文——加权修不了，留下一轮。不声称质量或速度提升。 | `explore.test.ts` 检查点三组（内容词窗口不得是 full-object——无修复时为 full-object；同文件两段互补块、同文件实现函数压过只重复已覆盖词的第二文件——均先红后绿，真解析器；已读正文补种被 rg 丢掉的内容词；定位题有答案后 offTopic 不再进池）。D-152 已读证据重算与 3.13 入口守卫仍绿。十问观察是观察不是评测。 |
| 查询内区分度 / 3.14 检查点二 | 同 tier 主比较改为加权覆盖 \(L(f)\)（D-154）：`tier → L(f) → roleFit → 路径`。`roleFit` 数值表仍在，只作有界偏好。how 问句不再因摘录包已满停读；`maxMaterializeReads` 数值未改。十问对照（`--skip-scan`，脚本已自排除，与检查点一同一测量污染说明）：1 满足（register 可见 #2）；9 满足（request #1、register #3）；V1–V5 满足。3：`surface-snapshot-store` 的 supersede 可见 #15，`authority` 的 observeWrite 仍读预算。5：`connections.ts` 的 classify 可见 #6；`symbol-runtime.ts` 已读，匹配窗口从未生成。7：`register("document.writeGuard")` 可见 #7，inspect 仍读预算。8：`thread-worktree.ts` reclaim 可见 #3。2：`explore.ts` 已进池，仍 `not-requested: read budget`——17 条未核验 `connects` 占 tier 1，吃掉未改的读预算。10：目标仍 `not acquired`（截断词法池里没有 `explore.ts`）。4：可见 #6，匹配窗口从未生成。6：匹配窗口已生成 291-412，未选中。不声称质量或速度提升。 | `explore.test.ts`：两稀有内容词压过堆泛词；弱源码不再凭 roleFit 墙压过更强清单；摘录包已满仍读同权第四个文件（先把停止条件退回检查点一形状证明会红，再接线）。3.13 入口守卫仍绿。十问观察是观察不是评测。 |
| 查询内区分度 / 3.14 检查点一 | 每次调用建查询内词组权重表（D-153）：\(N\) 与 \(df\) 都是本池去重文件数，不是命中行数，也不是全仓库 IDF。覆盖三态 `complete` / `lower-bound` / `unknown` 跟着权重走；完整且稀有才加 \(\ln\frac{N+1}{df+1}\)，截断或不完整覆盖只保留普通匹配贡献 1。`search.content` 在 explore 候选模式另报 `fileCoverage`，per-file 命中帽不把去重文件覆盖标成不完整。`details.distinctiveness` 与 `details.windows`（path / why / packed / 命中行）对观察可见。`rankCandidates` 比较顺序未改——权重还不是主排序键，这是有意的。观察脚本排除自身路径（相对 `6f92b49c` 基线，问题 4/6 各少一个被问题原文占用的可见槽；`wants` 不变），阶段诊断分开「匹配窗口从未生成」与「生成了但没被选中」。十问对照（`--skip-scan`，脚本已自排除）：1 满足（register 可见 #2）；9 满足（request #1、register #3）；V1–V5 满足。2/3/5/7/8 仍读预算；10 仍 `not acquired`。4 可见 #6，诊断为「匹配窗口从未生成」。6 可见仍是 `ensureRuntime`，诊断为「匹配窗口已生成 291-412，未选中」。权重表每题可读。不声称质量或速度提升。 | `explore-distinctiveness.test.ts`（公式与三态；先红后绿）；`explore.test.ts` 查询内区分度组（截断不得冒充精确 df、per-file 帽仍为 complete、生成窗口可区分 packed/未选中——窗口项跑真解析器）；`search-service.test.ts`（per-file 帽 → `fileCoverage=complete`，丢文件 → `lower-bound`）。十问观察是观察不是评测。 |
| 精确线索验证 / 3.13 | 查询先提取对象再处理问句（D-144）。排名按任务匹配分层，路径只作 tie-break，原始组分不再与 RRF 混加（D-145）。问题里的连接值/符号/路径在第一次打包前就查；补充物化看是否已读而不是是否见过路径（D-146，修订 D-137）。图理由绑定核验成立的窗口；`connects` 与 `associates` 分等；打包覆盖所需证据；定位题可早停；跳过的泛词与读预算 `not-requested` 分开（D-147）。文件角色按问题决定；测试路径条件式优先；`definitionDropped` 去重（D-148）。观察脚本收紧十问最小证据、阶段诊断、五个入口变体（D-149）。十问观察（D-150）：问题 1/9 与五个入口变体能看见当前 `register`/`request` 端；无对象的 2/3/5/7/8/10 仍断在读预算。阶段诊断的所需证据由可选改为必填，未命中时报「窗口不含所需证据」而不是 `verified`；按读发现的连线字面量若与问句对象无关则降到 `support` 档（D-151，订正 D-149/D-150）。降等后问题 1 的三个无关另一端从可见 #4–#6 退到 #11–#13，不再挤占在题证据，但 `limit` 未被更好证据填满时仍占尾部槽位。**已读证据重算**（D-152）：对象词一趟冻结的窗口不再挡住内容词一趟的命中，连线展开落到已读文件的图线索也会被定位；复用快照与按内容哈希的解析缓存，不消耗新文件读取预算。复跑十问：1/9 与五个变体不变，问题 4 从可见 #19 升到 #6、问题 6 从 #2 到 #3，都仍未命中所需证据——问题 6 断得更早，`parse`/`budget` 对该文件的命中撞候选预算没回来。观察脚本自身存着问题原文，实测每题都进候选、并在问题 4 和 6 各占一个可见槽位，已在诊断里如实上报（D-152）；3.14 检查点一把该脚本排除出检索（D-153）。不引入 embedding/BM25/词法索引/NLU，不声称质量或速度提升。 | `explore-query.test.ts`；`explore.test.ts` 3.13 组（路径序不再赢、rg 池内图命中仍读、图陈旧/不可用、测试与生产同名注册、结构 unsupported 不宣称 verified、定义理由绑窗口、`direct-verified` 跳过泛词、注册表容器窗口里的无关另一端不压过本对象证据——该项跑真解析器切片，并已验证无修复时会红）；`explore-graph.test.ts`；`explore-service.test.ts`；`search-service.test.ts`；真 Pi `session-e2e.test.ts` explore 5 项。十问观察是观察不是评测。 |
| 符号图读者 / 3.12 | explore 第二候选来源：定义优先（distinctive 词命中目录名字，精确档压过只是提到该词的文件）、连线补全（已选摘录里确认的连接字面量 → `findLinks` 其他端点；这是本刀唯一的新召回）、反向 import（已选路径，每种子最多 6、总共 12，同目录优先）。图只选路径；`hits` 在当前正文里定位后才写，定位失败丢掉窗口不退化成第 1 行。`details.graph` 自带 `not-requested / ready / empty / unavailable / failed / stale`（`stale` 预留，本刀不加第二套过期检测）。独立预算 40/16/12，`filesDropped` 与 rg 取 max。图那一趟的物化复用主循环的读预算与并行度（`maxMaterializeReads` + 3 路分批），超预算的新候选仍是候选、报 `not-requested`；打包 boost 按结构化来源查表（D-139）。`related` 回答文件级拓扑，正文写明与 `lsp.references` 的分工，无 rank；正文每段最多 40 条、名字锚点最多走 8 个路径并写明还剩多少，`details` 完整（D-139）。对照查询（加内存行缓存之前）：`bun run --cwd packages/web symbol-graph-query`。一次结果：`catalogBuildMs=1102591.4`，`searchSymbolsMs=185.999`，`findLinksMs=73.232`，`findImportersMs=42.379`，`symbolCount=24232`，`fileCount=2349`，`linkCount=13969`，`languages=javascript/typescript/typescriptreact`，`searchHitCount=20`（exact 1 / name-contains 19），`linkHitCount=4`，`importerCount=2`。方法：`git ls-files` ∩ `CATALOG_SCAN_LANGUAGES`（2349），tree-sitter outline/imports/literalCalls + `replaceFileSymbols`（同名闸门 + 1777 文件再访），然后各一次 `searchSymbols("explore", 20)` / `findLinks("explore.search")` / `findImporters` of `packages/web/application-host/lib/harness/explore.ts`。时钟为进程内 `performance.now()`。机器：win32 x64，AMD Ryzen 5 5600GT，12 逻辑 CPU，32049 MiB，Node v24.18.0。未走 `scanWorkspace`/`searchFilesystemFiles`：该路径每个目录 spawn `git check-ignore`，在本机挂了 11+ 分钟且 CPU≈0。这是对照数字，不是省时声称。量完后加了 `symbolQueryByPath` / `linksByValue`（D-134）。**验收又重量了建目录本身，并把它当前置条件修掉**（D-140）：枚举与写入原先都是产品跑不动的形状。枚举 `respectGitignore: true` 从「4363 次 `git check-ignore` spawn、投影 74 s、曾观测挂 11+ 分钟」变成一次 `git ls-files -z --cached --others --exclude-standard` 的 **199 ms**；`replaceFileSymbols` 从每文件 flush 整库（隔离测量：400 文件的库上 `touchFile` 单次 66.8 ms，同样 20 次成批共 91 ms）改为派生写入按安静 250 ms / 最长 30 s 去抖，全库 `catalogBuildMs` **1104500 → 290502**（18.4 → 4.8 分钟），同轮 `searchSymbolsMs=17.051`、`findImportersMs=41.422`、`parsedFileCount=4143`。测量脚本本身也改成按 `CATALOG_SCAN_BATCH` 成批并发——逐个 await 量的是产品不会跑的形状。去抖第一版按写队列占用写，全库只从 18.4 降到 17.6 分钟（解析夹在写入之间，队列几乎总是只剩一个），已改为安静期。当时剩余三成是再访重新解析 1785 个文件（解析缓存 32 条）；该重复采集已由 D-236 移除，旧数字不是本轮受控对照。**D-141 之后**（TriviumDB 0.8.6 + 原生索引 + `payloadCacheMb: 0`）同一脚本：`catalogBuildMs=256693`，`searchSymbolsMs=11.526`，`findLinksMs=0.966`，`findImportersMs=147.04`（首次含形状重建），2359 文件 / 4145 次解析 / 24301 符号 / 14024 边。**验收复验按调用次数重量了一次**（D-139）：一次 explore 调用做 `catalogStats` × 1 + `searchSymbols` × 每个 distinctive 词 + `getFileRelations` × 已选窗口 + `findImporters` × 每个种子（最多 20），同量级目录（2270 文件 / 23321 符号 / 12370 边）实测**892.2 ms**，主项是 `findImporters` 58.15 ms × 20。改成解析后的反向索引 + `catalogStats` 不逐文件读 payload 之后：`catalogStats` 14.19 → 1.13 ms，`findImporters` 首次 124.89 ms 建索引、之后 0.164 ms，**一次调用 892.2 → 51.7 ms**。同样是对照数字。 | `explore.test.ts`「explore graph path recall」（定义压过提及、连线另一端不在 rg 候选里仍出现、反向 import why、定位失败不输出、store 未开 `unavailable`、查询抛错 `failed`、空目录 `empty`、`filesDropped` 取 max）；`explore-graph.test.ts`；`related-tool.test.ts`（Host：没有 vs 不完整、反向 import、空目录 vs 未收录、未解析 specifier、每段上限与「还有 N 条」、名字撞多路径只走 8 个 + pi-host）；`store.test.ts`（路径集合变化后反向 import 重新解析）；真 Pi `session-e2e.test.ts` related。未测 Electron asar；未在多工作区桌面量冷扫描墙钟；未声称检索质量或速度提升 |
| 结构来源 / 3.11 | 第 1–3 步已接。第 1 步：`lib/structure` provider 接口 + LSP `documentSymbol` outline + explore 按 D-090/D-093/D-098/D-102 切片（容器单位：小函数全文，大函数签名 + 命中块 + 省略标记 + 完整读取入口；普通值绑定/成员签名不是单元，命中落在其上时切所属函数/类，至少不差于 ±3；`const foo = () => {}` 仍是自己的单元；签名即全体的单元——如 `documentSymbol` 把接口调用签名报成 `method`——按命中 ±3 取并补齐，D-102 起由 `sliceSymbol` 执行而不只是意图）；缺结构或 `stale` 退行 ±3 窗口并在 snippet/`details.structure` 标明状态（D-094）。第 2 步冷启动对照已量：`bun run --cwd packages/web structure:cold-start`。一次结果：`coldStartToDocumentSymbolMs=833`（`bindMs=240`，`documentSymbolMs=593`），`symbolCount=50`，`status=ready`。方法：agent 视图冷进程，对一份 `explore.ts` 副本（27355 字节）做首次 bind（input-context/disk）+ 首次 `documentSymbols`；工作区是带最小 tsconfig 的单文件临时目录，不是整仓索引；时钟为进程内 `performance.now()`。机器：win32 10.0.26200 x64，AMD Ryzen 5 5600GT，12 逻辑 CPU，32049 MiB，Node v24.18.0（tsx 跑脚本，`bun` 字段为 null）。这是对照数字，不是省时声称。第 3 步：web-tree-sitter 0.27 + `tree-sitter-typescript` 0.23.2 发布 wasm（TS/TSX），生产顺序 tree-sitter → LSP（D-097）；`empty` 或未覆盖命中的 `ready` 可问后续 provider，但 `warmOnly` 不冷启动 LSP（D-099）；命中分类只打已物化窗口分（D-095）；wasm 经 ASAR 重映射读取（D-096），约 3 MB 二进制以 git 为事实来源（D-101），加载失败报 `unavailable`。第 4 步：`StructureSource` 长出 `literalCalls`/`imports`（缺能力报 `unsupported` 不是失败，D-106）；确认连接（`request`/`register`/`on`/`once`/`emit`/`subscribe`/`addEventListener`）与关联候选分列，**候选须真是同名**——该字面量已是某处的确认连接值才写入，闸门看 store 的 connects 值索引加本批，冷扫描末尾补一遍（D-109，实测 `application-host/lib` 499 文件从 10,711 条降到 153 条，link 节点 13,220 → 2,662）；`imports`/`connects`/`associates` 与 defines 共用 generation，重收集后无悬挂边（D-105）；outline 单独决定能否写这一代，边查询被阻塞记 `linksIncomplete` 而不冻结符号（D-111）；轮廓行区间转字符范围时末列取真实行长（D-110）；outline 收模块级/类级值绑定作目录名、切片仍按容器过滤（D-113）；冷扫描复用 `searchFilesystemFiles` + Documents 磁盘读，不读脏缓冲、不扫 LSP、不阻塞启动/首 turn，覆盖带 `importQuery` 的语言（TS/TSX/JS/JSX，D-115 取代 D-104）；JSON 进切片不进目录（D-114）。`explore.search` 仍读摘录路径出边作注解（D-108/D-112：库不可用或查询失败按 `status` 降级而不失败检索、读路径只用已打开的 store、修订不同则去掉行号并标 `stale`、可见预算排在 issue 之后且每文件 12 条上限）。3.12 取代 D-108 的「不扩候选池」：定义 / 连线另一端 / 反向 import 成为独立预算的路径候选，物化后在当前正文里定位名字才写 `hits`（D-136/D-137）。第 5 步：语言分布在 `LanguageSupportAPI.getStatus` 时现算（文件上限 8000，`partial`，工作区缓存 30s，不进启动路径，D-120）；wanted 是按工作区内存需求信号，结构仍报 `unsupported`，Host 不自发网络（D-121/D-124）。设置「语言支持」页（普通渲染器 order 38）列语言服务器 + 结构包两行（D-122）。发布期 `grammar-packs.json` 自算 wasm sha256（D-125）；运行期下载→摘要比对→rename 进 `{PIARIUM_DATA_DIR}/structure-grammars/sha256/<hex>.wasm`，可取消，不做续传。捆绑 `runtime/` 优先于下载目录（D-126）。可装 15 种（python/go/rust/java/c/cpp/csharp/kotlin/ruby/php/shellscript/css/html/yaml/toml）；swift/markdown/xml 上游无 ABI 兼容 wasm（D-127）。按需语言的轮廓来自上游 `queries/tags.scm`：发布期用该包自己的 wasm 编译验证，编得过才把 `tagsPath`/`tagsIntegrity` 记进清单，安装时与 wasm 同样按摘要校验；15 种里 9 种（python/go/rust/java/c/cpp/csharp/php/ruby）装上即有 `outline` + `classifyHits`，其余 6 种（kotlin/shellscript/css/html/yaml/toml）上游未带查询，装上只有解析器、能力旗标全关、`outline` 仍 `unsupported`，设置页按此标注而不显示为成功（D-128）。`literalCalls`/`imports` 仍只有手写规格的 TS/TSX/JS/JSX 有。语法索引只有 ENOENT 算空，其他读失败/解析失败抛错并原子写索引，界面报 `grammarStore: unreadable` + 语言 `unknown` 并停用安装（D-129）。导入校验 `.wasm` 后缀与 32 MiB 上限、不回传文件系统错误原文、ABI 检查异常变 `abi` 失败（D-130）。清单加载失败退到空清单而非启动失败，解析期筛掉 ABI 超窗的包，重复点安装并到同一 Promise，刷新脚本默认按已提交版本复现（D-131）。D-116–D-119 永久空号（D-132）。用户自带 wasm 标未验证（D-123） | 第 1 步：`structure/*.test.ts`、`explore.test.ts`、`explore-service.test.ts`、`session-e2e.test.ts` 结构切片真 Pi 断言。第 3 步：`tree-sitter-provider.test.ts`（真实 wasm 解析、取消、预算耗尽、缺 wasm → unavailable、定义绑定与 var/declare/namespace 覆盖）、`explore.test.ts`（同一大函数三种命中、冷 LSP 下 tree-sitter 切片、名字先于注释、不分类未读候选、缺 wasm 退行窗口）、`source.test.ts` / `lsp-provider.test.ts`（empty/缺口 `warmOnly`）、`slice.test.ts`（签名即全体的一行 `method` 补齐到 ±3、有函数体的单元仍精确，D-102）。第 4 步：`connections.test.ts`、`source.test.ts` 门面 fan-out/`unsupported`、`store.test.ts` 确认 vs 候选与悬挂边、`store.smoke.test.ts` 编译产物、`symbol-runtime.test.ts` 结构写入与 unavailable 保留 + 同名闸门（含同文件 register/log）+ 边阻塞仍更新符号并记 `linksIncomplete`、`catalog-scan.test.ts` 未改动文件 + 不读脏缓冲 + JS 进目录/JSON 不进、`tree-sitter-provider.test.ts` 模块级绑定入目录/局部绑定不入 + JS/JSX/JSON 轮廓、`explore.test.ts` / `explore-service.test.ts` 真实入口读边 + 图不可用仍返回摘录 + 草稿摘录关系标 stale 去行号 + 关系不挤掉 issue + JSON 大切片。第 5 步：`language-support/runtime.test.ts`（上限/`partial`/wanted + 装了带查询的语法真出能力、没查询的报 installed 但能力全关、索引不可读报 `unknown`）、`grammar-installer.test.ts`（wasm 与 tags 摘要不匹配都拒绝并清理、下载可取消、重复安装并流只下一次、ABI 越界报 `abi`、用户导入、不回传文件系统错误原文、后缀/体积拒绝）、`grammar-store.test.ts`（查询随语法存取与删除、索引损坏抛错且不覆盖、缺文件才算空）、`grammar-manifest.test.ts`（9 种带已验证查询、ABI 超窗移入 skipped、摘要格式不对的查询字段丢弃）、`tree-sitter-provider.test.ts`（用真实 wasm 走一遍 tags 适配器出 `function`/`class` 单元与 `variable` 目录名、命中分类、无查询报 `unsupported`；`tagsDefinitionKind` 映射）、`runtime-path.test.ts`（捆绑优先于下载目录）、`language-id.test.ts`、设置页 presentation/i18n（已装但无轮廓不显示成功、`unknown` 无动作、体积文案）。断言真实解析的测试自带解析预算，不继承生产值（D-102）。脚本不进默认测试套件。未测 Electron asar 真机打包；未在本步重跑冷启动脚本；冷扫描未在真实多工作区桌面启动路径上量墙钟；tags 适配器用捆绑 JS 语法验证，9 种按需语言的查询只在发布期脚本里编译过、未在本机装后逐语言走查；真实 npm 下载未走（单测注入 download/extract） |
| T4 / 执行配置 | memory 的单会话覆盖与实际模式已接；完整跨 runtime RunManifest 未收敛，record-only 未实现；Workbench/Agent Profile 职责分开 | record-only/T4 非前置；其余单会话配置随实际消费者完成，不要求统一 RunManifest 先行 |
| 结果与集成 | 基线与结果来自原生对象，merge 消费 fixed resultRevision 与被审阅的父绑定。磁盘写入与 surface intent/回执共用持久操作，确认前不完成，条件补偿和 Host 撤销保留后续编辑。父已含子结果为 no-op；buffer 不隐式保存，默认不改 Git index。磁盘变更仍与父回合 checkpoint 同事务绑定。D-207：同 Run 命令记录绑定到 published revision；子检查 / 合并可应用性 / 父检查分列；草稿合并不能验证未保存缓冲 | 真实文件/故障注入、Documents→Registry 混合纵切、真实 Pi 会话（faux provider）与 React 挂载通过。验证记录定向组见 3.4 / 3.7。完整桌面未跑；Host 资源协调不等于对外部进程的 OS 级原子比较交换。正文、类型与未验证范围见 3.5a |
| 物化生命周期 | Git/非 Git 结果独立发布；copy snapshot 按修订保留。归档先取消并等待实际准备和会话退出，再保存结果；关闭后的采集失败可重试。准备阶段和部分目录 fingerprint 持久化，恢复失败不删除后续新内容。原 session 重绑新 Run；普通已结束线程打开也先恢复。用户与自动回收共用线程生命周期协调，guard 内核对结果并持有到删除结束。占用覆盖整个 workspace，用户预算以短临界区预留并发已知需求；未知不记零 | `thread-lifecycle.acceptance.test.ts`、`thread-worktree.test.ts`、`thread-runtime.test.ts`、`thread-space.test.ts`、`thread-routes.test.ts`、`worktree-reclaim-guard.test.ts`、`thread-worktree-settings.test.ts`、`working-state/working-state-store.test.ts`；未显式分类的 setup 产物仍会保留目录，Git filters/LFS 与 CoW 仍待实施。真实 ENOSPC / 浏览器完整归档链 / macOS、Linux 未测 |
| `check` | 现有角色含 bash 且 shared，具备命令执行能力 | 不称只读 agent，不阻止测试/构建正常生成文件；不新增统一副本要求 |

**D-081 本地实施证据**：protocol 全组 74 项；pi-host memory/compaction/Phase 2/真 Pi session/feature 定向组 42 项；
Application Host memory/compaction/service/Zone 2 定向组 84 项；UI 模式投影/session store/i18n 54 项，均通过。真 Pi 测试使用本地
faux provider，证明实际 hook、Host bridge、零接管模型调用与 Pi fallback，不宣称外部模型的长期语义质量。protocol、pi-host、
Application Host test 与 UI 类型检查及四包 lint 通过；文档检查见本次提交。未运行付费模型或完整桌面 smoke。

**D-082 本地实施证据**：protocol 全组 75 项；Documents Authority/routes、真实 rg/explore 与 query 定向组 53 项；UI session store
45 项；SessionHost prompt 与真 Pi session 定向组 25 项通过。protocol、application-client、runtime-broker、pi-host、UI 与 Application Host
测试类型检查和六包 lint 通过；工程文档 19 项及链接校验通过。测试覆盖 snapshot 后继续编辑、旧磁盘命中删除、dirty-only 新词、
错误 session/workspace/scope、来源不可用、发送/commit 失败，以及 runtime payload 不含正文；使用本地 faux provider，未运行完整桌面
或多窗口手工 smoke。

**D-083 本地实施证据**：Application Host 的 Documents、Thread registry/services/runtime/worktree、WorkingState 与 Integration 9 文件组
138 项通过，1 项 Windows symlink 权限跳过；主代理修正字节格式、结构闭包、窄路径、live/fixed 与 surface 冲突后，受影响 6 文件 88 项
再次通过；最终小改另有 runtime/service/store 37 项、worktree 15 项（同一 symlink 跳过）及 WorkingState 17 项复验通过。UI Document Registry 24 项、线程投影 7 项；protocol 全组 75 项；Node/tsx 下真 Pi Thread capability、讨论转换与父回合集成/
撤销 5 项通过。protocol、application-client、pi-host、UI 与 Application Host 类型检查及五包 lint 通过；application-client/protocol
构建通过。测试覆盖 CRLF+BOM、surface 释放后的 queued 启动、schema 迁移、lost 恢复、ignored draft、文件/目录互换、固定结果后的 live
续写、草稿路径零写入与父已含子结果 no-op。工程文档检查见本次提交；未运行完整桌面或外部 provider smoke。

**D-084/D-085 本地实施证据**：WorkingState store/runtime 定向组 31 项通过，覆盖 schema 1/2→3、文件/目录 capture scope 的新增、
修改、删除、持久重开与结果物化；search/explore 三文件组 40 项通过，覆盖 fixed/regex/case/glob/context、dirty path 在 rg cap 前排除、
空模式、scope、并发草稿读取与磁盘 revision 漂移。Documents read source/router/authority 四文件组 51 项，pi-host 原生 read/grep、
能力门、磁盘图片与 Harness E2E 组 28 项、真 Pi fixed-surface read 纵切 1 项通过。protocol、pi-host 与 Application Host 测试类型检查通过。
pi-host 与 Application Host 构建、改动 TypeScript ESLint、工程文档 19 项及 378 页/288 本地链接校验通过。未运行完整桌面、
多窗口 UI 或外部 provider smoke。

**D-086 本地实施证据**：`document-path-overlay.test.ts`、Router path authorization、pi-host `find-ls-tool.test.ts` 与
`select-tools-web.test.ts` 定向组通过；`session-e2e.test.ts` 的真实 Pi faux-provider 回合证明 Host capability 下同名
`find`/`ls` 覆盖实际进入模型结果，dirty-only nested path 可见且不相关磁盘目录仍走 Pi 原生实现。Host overlay 返回相对请求根的
fixed files、revisions 和虚拟目录，find 在合并后交回 Pi definition 处理目录后缀、limit 与 50KB truncation，ls 对覆盖节点采用固定
snapshot 类型。protocol、pi-host 与 Application Host type-check 通过；未运行完整桌面、多窗口 UI 或外部 provider smoke。

**D-079 本地实施证据**：最终 Host 定向组覆盖 working-state、线程、explore、Documents 与 recovery，共 21 个文件，228 项通过，
1 项 Windows 符号链接权限跳过。Protocol 71 项；Pi 线程 service/bridge 8 项、能力门 3 项；真实 Pi 原生线程测试文件 2 项、explore
纵切 3 项通过。测试使用本地 faux provider，没有执行真实付费模型或完整桌面 smoke；不以旧报告的全仓数字代替当前证据。
Protocol、pi-host 与 Application Host 类型检查通过，Host 构建与本轮修改文件 ESLint 通过；工程文档测试 19 项、文档链接校验
和 git diff --check 通过。未重复运行无关平台或全仓测试。

**D-076 本地证据**：protocol 70/70；关键 Host focused（分支/CAS/coverage/cursor/router/route/thread）全通过；pi-host 关键纵切 38/38；UI block projection 2/2；protocol/pi-host/UI/
Application Host type-check 与四包 lint、文档 19/19、链接校验、`git diff --check` 通过。扩大并行运行时 Host 另有 3 个计时用例、
pi-host 有 1 个后台 shell 计时用例失败，全部单独复跑通过；不把并行负载下的偶发超时记成本纵切失败，也不伪报全量零失败。

**D-206/D-209 本地实施证据**：Host terminal runtime、Harness bridge、shell assembly/supervisor 与 todo 定向测试覆盖全局 id、
HTTP/程序化身份冲突、后台自然退出、真实 kill、迟到 exit、writer 释放失败重试和无写后确认；pi-host todo/output/phase2 定向组覆盖
公开工具协议。Runtime Manager 的 bundled/显式选择证据保留。未跑完整浏览器终端点击链和 macOS/Linux 真机。

**D-207/D-210 本地实施证据**：protocol `harness-settings.test.ts`；Host `verification-records.test.ts`、
`verification-coordinator.test.ts`、`working-state-store.test.ts`、`review-sensor.test.ts`、`service-host.test.ts`、`zone2.test.ts`、
`thread-runtime.test.ts` / `thread-worktree.test.ts` 定向组覆盖 actor/Run/代际、变化范围身份、一次性绑定、父窗口重载、已应用但未保存的
surface 仍不可冒充磁盘验证，以及 review gate。
不把 faux provider 写成真实审阅质量；非 Git 精确输入仍明确 uncertain。未跑完整浏览器 Settings/线程面板点击链，也未发起付费模型实验。

**D-208/D-211 本地实施证据**：protocol `harness.test.ts`；Host `store.test.ts`、`knowledge-suggestions.test.ts`、
`knowledge-catalog-routes.test.ts`、`knowledge-services.test.ts`、`context-routes.test.ts`；pi-host
`knowledge-suggestion-extension.test.ts`；UI `KnowledgeSettingsPage.behavior.test.tsx`、`KnowledgeSettingsPage.test.ts`、
`knowledgeCatalogRequest.test.ts`、i18n 与事件投影定向组覆盖完整 CAS、并发去重、固定 actor scope/source、有效 auto-accept 设置、
切换与迟到响应。
未跑完整浏览器 Settings 点击链，也未发起付费 suggestions 模型实验。

**D-213 本地实施证据**：protocol `harness.test.ts` 识别 `document.branchWrite` / `workingBranch.ensureMaterialized`；Host
`working-state-store.test.ts`、`working-branch-writes.test.ts`、`working-branch-view.test.ts`、`path-requirement.test.ts`、
`thread-space.test.ts`、`thread-runtime.test.ts` 定向组覆盖 writeRevision CAS、父磁盘不变、兄弟隔离、scope 拒绝、首次 bash/LSP
物化切换、虚拟 scratch 回收与 bash 预算预占；pi-host `workspace-mutation-journal.test.ts`、`apply-patch-tool.test.ts` 覆盖公开
edit/write/apply_patch 先走 branchWrite、disk 才落盘。未跑完整桌面 bash 物化、真实 Git filter/LFS 一致性或非 Git 大目录墙钟。

**D-214 本地实施证据**：Host `workspace-baseline.test.ts`、`thread-runtime.test.ts`、`thread-services.test.ts`、
`thread-space.test.ts` 定向组覆盖 Git 变化集与 ignored/captureScopes、unborn/非 Git、BOM/CRLF/二进制、捕获取消不建分支、
dispatch 必准备且失败删除 Thread、prepare 后 spawn 不重扫、父漂移隔离。未测真实 Git filter/LFS 一致性、Windows 符号链接/
执行位，以及非 Git 大目录捕获墙钟。

**D-215 本地实施证据**：角色目录与嵌套 parent 数据模型仍在；`nested-threads.test.ts` 把 `resolveRuntimeWorkspaceId` 钉成同一个 `"ws"`，不能证明 owning/execution 拆分。身份查找已由 D-216 改走 Host session binding。

**D-216 本地实施证据**：Host `workspace-identity.test.ts`（Documents 不同 workspaceId、session.create、Harness router、公开 dispatch、threads/wait/Zone 2/lost resume、物化后子 Git 不改父状态）；`thread-registry.test.ts`（session binding 持久化与重启）；`thread-services.test.ts` / `zone2-threads.test.ts`（execution workspaceId 下仍写 owning catalog）；`thread-worktree.test.ts`（父仓库内 `git init`、外部路径 `--detach` 写 `.git/worktrees`，都不污染父分支列表）。未跑真实付费嵌套 Pi 会话或完整桌面 Host 重启。

**D-217 本地实施证据**：Host `virtual-write-invariants.test.ts`（失败物化并发写仍进分支且 scratch 非权威、孙 merge 后再写再物化两者都在、symlink/环/非法 UTF-8/文件祖先拒绝、read/explore revision=writeRevision、semantic pin 排除父盘漂移、abort 不完成后台切换、staging-promoted 崩溃完成物化 / live-backed-up abort 回虚拟）；`virtual-write-tree.test.ts`；`materialization-switch.test.ts`；`branch-view.test.ts`（unpublished writeRevision 标签）；`working-branch-writes.test.ts` 原生产链仍通过。未跑完整桌面 bash 物化或真实付费 explore semantic。

**D-218 本地实施证据**：Host `workspace-baseline.test.ts`（listing 失败抛错、unborn 不跑 `diff HEAD`、gitlink 列出）；`thread-runtime.test.ts`（Git 失败/捕获窗口变化/活跃 writer/gitlink 不生成完整 branch，`setWorkingState` 失败删除未绑定 branch 与 scratch）；`thread-services.test.ts`（`baseline-changed` 可重试并删除 Thread）；`working-state-store.test.ts`（新虚拟文件写入真实默认 mode）；`materializer.test.ts`（unsupported 拒绝）；`integration-coordinator.test.ts`（省略 mode 的新文件仍可 apply；apply 后 chmod 则补偿 needs-attention，Windows 上 chmod 无效果则跳过该断言）。未测真实 Git filter/LFS、已 checkout 的 submodule 闭包或完整桌面 Host 重启。内容身份与无探测 mode 见 D-220。

**D-220 本地实施证据**：Host `execution-baseline.test.ts`（生产 router `document.branchWrite` / `workingBranch.ensureMaterialized` + `processEvent` settle/drain + `runtime.merge`：虚拟写与 shell 写同时进入 native result 并落到根目录，无 bad object；reclaim 后 rematerialize 使用父仓库可解析 ref；staging-promoted 恢复持久化 execution HEAD）；`thread-worktree.test.ts`（父仓库内 init 的 `executionBaseline` ≠ 父 HEAD，inspect 不 bad object）；`working-branch-view.test.ts`（shared lease 等待期间提交后读到新正文与 `@1`；`createExploreQueryStartService` pin 后 rg/read/semantic 仍见 pin 正文）；`thread-runtime.test.ts`（两个 dirty 文件扫描中途改内容、Git 路径集合不变 → retryable `baseline-changed` 且不留 branch）；`working-state-store.test.ts`（新文件 mode 不创建 `.piarium-mode-probe-*`）。未跑真实付费 Pi 会话、完整桌面 Host 重启或 Git filter/LFS。

**D-221 本地实施证据**：Host `integration-coordinator.test.ts`（生产 `mergeResult` + `commitParentVirtualWrites` 在 CAS 成功后注入崩溃，重启 `fenceUnfinishedOperations` 把 applying 对账为 complete，`operationId` 幂等复用）；`working-state/branch-integration-lock.test.ts`（真实 recovery engine store 队列上 `materializeExecutionView` 已 `beginSwitch` 并等待 store 时，`runtime.merge` 经生产 coordinator 返回确定结果且不挂起）；`working-branch-writes.test.ts`（切换中写入等真实 cancel，不因两次重试失败）。未跑真实付费嵌套 Pi 会话或完整桌面 Host 重启。

**D-222 本地实施证据**：Host `dequeue-permissions.test.ts`（生产 `createOnThreadDequeued` → `runtime.spawn` → `sessions.create` 带 `accept-edits`，`mergePolicies` 后 live bypass 仍是 accept-edits）；`integration-coordinator.test.ts`（directory apply/reconcile 经 `fenceUnfinishedOperations` 调用 execution `runResourceOperation`，对象库不进父目录；无法解析则 needs-attention 且不走 owning gate）；`thread-registry.test.ts`（catalog 无 binding 经 `reconcileAfterHostRestart` 重建；stale binding 拒绝）；`thread-services.test.ts`（binding 无 catalog owner 拒绝 dispatch）；`knowledge-owning.test.ts`（snapshot 先绑 execution，`markRunRunning` 后 recall/suggest/Zone 2 打 owning store）。未跑真实付费嵌套 Pi 会话或完整桌面 Host 重启。

TriviumDB 的数据库问题按版本和通用语义向用户说明，不转嫁 Piarium 领域职责；迁移未立项。Windows 沙箱是用户排除项，
不是缺平台测试而暂时 blocked。macOS/Linux smoke、Electron 打包、真实 provider 分别记录未验证环境；测试者结果是后续质量反馈，
不作为默认交付阻塞。

**D-239 旧结果释放已接线、默认可用（2026-09-12）。** 线程卡片按需读取历史、展示保留原因并确认选定 branch/revisions；鉴权
Host 路由重查当前结果、Run 输入、review 与未结束 Integration。先移除版本元数据，再释放引用并回收无主对象；当前分支、报告、
转录及其他线程的共享内容保留。清理失败可用原请求重试，返回实际清理结果。它不提供整个 Thread 或当前分支的删除功能。

证据：`thread-history.test.ts` 6 项经真实 Registry/WorkingState/SQLite/Recovery engine 和公开路由覆盖鉴权、整批冲突、活动/未启动
review、active/lost Run 输入、共享对象、释放源版本后 undo、引用清理失败重试及 Registry 并发；与 registry、Integration、锁顺序和
recovery engine 5 文件共 116 项通过。`working-state-retention.test.ts` + store 共 19 项覆盖 JSON/rename 与 SQLite 中断及目录缺失；
`HarnessThreadResultHistory.behavior.test.tsx` 5 项覆盖确认、关闭重开后的重试、409 与迟到响应，邻近面板 9 项和 i18n parity 4 项通过。
Host/UI 类型与相关 lint 通过。完整 Electron 点击、真实卷耗尽和进程级断电未实测；3.4/3.4a 其他 Partial 原因仍保留。

## 未完成项（来自 D-027，按来源）

| 来源 | 未完成 |
| --- | --- |
| D-023 | user terminal 与 memory 事件加速已由 D-226 接通，命令事实由 D-229/D-233 纠正。suggestions 槽位用户消息提议与 Settings 知识目录已由 D-208/D-211 接通并补正并发/身份。steering/计划编辑/本次 Run 返回的加速已由 D-238 接通并有定向与 faux 证据；zsh/macOS/Linux 用户终端和真实 keeper 质量仍未实测 |
| D-024 / D-026 | merge/归档后的 worktree 与分支回收已由 D-077/D-202 接线；归档/恢复 UI 见 D-202 |
| D-013 | 已由 D-206/D-209 接通 terminal runtime 并补正身份/退出；见矩阵 1.3 |

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

`index.ts`：HarnessServiceHost（传入 `discoverShells()`）、HarnessRouter、broker 事件消费、会话注册时按工作区 `settings.get` 解析 `harness.shell`、registerWriter、诊断 provider、`harness.respond` ok 字段；`session-host.ts`：selectHarnessTools → customTools、截断扩展、apply_patch OpenAI-only、Settings 门控；`service-host.ts`：bash 初始 cwd、省略 discovery 时本机发现；`workspace-mutation-journal.ts`：诊断经 hostServicesBridge；`HarnessSettingsPage.tsx`：工具开关 + shell + output + bash。

### E2E（`packages/pi-host/test/harness/harness-e2e.test.ts`，6/6）

1. bash pwd 输出包含工作区目录名；2. 两次独立调用 `cd packages` → `pwd` 以 "packages" 结尾；3. 超过 waitMs 的命令返回 `sh_` id，`get_output` 取到非空输出；4. grep 命中含 "hello"，miss 返回 "0 hits (searched"；5. `cat big.txt`（5000 行）返回 `out_` 句柄，page1 含 "line 1"，page2 非空；6. `selectHarnessTools`：grep=false 时无 grep，默认有 grep。

### Contract（`packages/pi-host/test/harness/router-bridge-contract.test.ts`，3/3）

`buildHarnessRespondParams` → host-controller `harness.respond` → `respondHarness` → bridge：ok 结果 resolves；error 结果 rejection；timeout 为 retryable rejection。

当时的已知缺口：`read` 的 `tool_result` 截断未在真会话验证；诊断 provider 已接线但未用真实 LSP 验证；D-013 的 terminal runtime 集成待完成。前两条已于 2026-09-05 由 D-065 补齐；terminal runtime 集成已由 D-206 收口，见矩阵 1.3。

**D-224 本地实施证据**：`working-state/integration-coordinator.test.ts` 覆盖 child merge → parent materialize → execution Documents gate undo、父后续编辑 needs-attention、undo apply 后崩溃重启并同时对账磁盘/branch cache；`thread-runtime.test.ts` 覆盖 native publish 失败以及 inspect + Git snapshot 同时失败时清除默认 resultRevision；`thread-registry.test.ts` 覆盖新 Run 撤下旧默认结果、active Run owner 重建、superseded session 拒绝、registry cascade fence 与 cascade 接管后的失败 dispatch 不互删；`nested-threads.test.ts` 覆盖父目录回收后孙线程仍从父 WorkingBranch 固定基线；`explore-query-services.test.ts` 与 `working-branch-view.test.ts` 覆盖 scoped pin 且不克隆整分支。9 个受影响测试文件 174 项通过，Application Host tests type-check、改动 TypeScript lint、文档 19 项测试、378 页文档校验与 `git diff --check` 通过。完整桌面重启、真实付费嵌套 Pi、Git filter/LFS、外部 provider 未测；scoped pin 在 Merkle/路径索引前仍遍历平面元数据，但不克隆或读取范围外正文。3.4 / 3.4a / 3.6 继续 Partial。

**D-225 本地实施证据**：见当时提交记录。正文身份、整组 undo、耐久补偿与 `apply_patch` 读源以 D-228 为准，不得再把 D-225 写成已 Proven。

**D-228 本地实施证据**：定向反例入口为 `documents/authority-surface-identity.test.ts`（CRLF dirty B / disk A 后 edit→C、二次 edit 读 C、apply_patch 写 P 且磁盘仍 A；两 surface 路径整组应用后 disk 失败，真实 Registry 一次 undo 恢复两者且同一 `operationId` 不能再撤；UTF-16LE+BOM 补偿后字节一致；surface apply 后 I/O throw，重开 catalog 为 compensated 或 needs-attention；owner 不可用时启动对账 needs-attention）、`documents/surface-mutation.test.ts`（CRLF `bufferHash` 与序列化正文分离、同一 `operationId` 整组 undo、前向 abort 后补偿 signal 未 aborted）、`pi-host/test/harness/apply-patch-tool.test.ts`（readSource unavailable 时磁盘可匹配也不写 surface/disk；surface 整文件替换携带 revision/hash）。完整桌面 Registry、生产 Host 进程重启、macOS/Linux 会话仅未实测。不把 faux provider 写成真实模型质量。

**D-229 本地实施证据**：定向反例入口为 `terminal/shell-integration-scripts.test.ts`（Windows PowerShell 失败 cmdlet / `exit 7` / 成功分别为 1/7/0；`/bin/sh` 不注入；Bash PROMPT_COMMAND 数组与 DEBUG trap、zsh profile 文件、PowerShell 不替换 Enter）、`terminal/runtime.test.ts`（parser 已有旧 E/C 后 restart，新 zsh 初始 D 不产生旧命令，下一 commandId 属新 generation；`/bin/sh` 无 `--init-file`；无本次 integration 标识的 OSC 不生成命令）、`terminal/shell-integration.test.ts`（untagged / 错代际 OSC 不 ready）、`host/zone2.test.ts`（命令含 `</user-terminal>` 时结构仍完整）、`knowledge/context-runtime.test.ts` 与 `store.test.ts`（重建 context runtime 后重复 commandId 一条 event，projector 最多 nudge 一次）、`memory-agent-extension.test.ts`（同一 commandId 不重复进 keeper material）。zsh/macOS/Linux 真机用户终端与完整桌面 Host 重启仅未实测。不声称 Host 重启去重。

**D-227 本地实施证据**：见当时提交记录。事实名称、delivery、run 绑定、耐久证据、URL receipt 与嵌套基线以 D-230 为准，不得再把 D-227 写成已 Proven。

**D-230 本地实施证据**：定向反例入口为 `retrieval-evidence.test.ts`（任意有效行范围配无关 claim 只标 source-checked；一条来源有效、一条失效顺序互换状态一致；短 URL 有合法 receipt，换绑另一 URL 被拒绝；子会话 output handle 复制为耐久 artifact，dropSession 后仍可读；本地摘录在磁盘变化后仍指向当时身份）、`thread-facts.test.ts`（旧 Run submit 等待 Documents 期间 settle 或 lost→resume，旧提交不能写入新 Run）、`retrieval-artifacts.test.ts`（重开 object catalog 仍可读同一 excerpt）、`nested-threads.test.ts` 与 `retrieval-session.e2e.test.ts`（嵌套 retrieval 在 dispatch 时建立 isolated 冻结分支，真 child SessionHost 可读父虚拟新文件且不见后续 root live 漂移）、`web-fetch.test.ts` / `webfetch-tool.test.ts`（active retrieval 短 fetch 铸耐久 receipt，普通 fetch 不铸，取消贯通）。真实付费 retrieval、完整桌面 Host 重启与授权 web 抓取仅未实测。不把 faux provider 写成真实模型质量。

**D-231 本地实施证据**：`retrieval-session.e2e.test.ts` 经公开父 dispatch 启动真 child SessionHost，并覆盖 retrieval 的 isolated manifest、父虚拟新文件读取、LSP 首次物化到受管 scratch、settle 不发布目录结果；`nested-threads.test.ts` 覆盖 queued/直接 dispatch 固定父状态；`thread-worktree.test.ts` 覆盖 managedRoot 缺失/越界拒绝、独立 Git 与 inspect 归属；`materialization-switch.test.ts` 覆盖 staging/backup 也必须位于受管根。Application Host 生产 backend 同时授权 `{PIARIUM_DATA_DIR}/worktrees/<id>`、`thread-scratch/<workspace-hash>` 与已注册工作区 `.piarium/worktrees`，持久记录本身不能授权。完整桌面重启和旧记录人工恢复未实测，3.4/3.4a/3.6 保持 Partial。

**D-232 本地实施证据**：`authority-surface-identity.test.ts` / `surface-mutation.test.ts` 覆盖磁盘漂移在 surface dispatch 前拒绝、CRLF 原始字节身份、明确 failed receipt 安全终止、无回执 needs-attention、逐路径补偿保留用户后写、WAL 重开对账；`recovery/engine.test.ts` 与 `PiRecoveryPanel` 接线让 durable needs-attention 可观察。Documents 的非权威 operation cache 已删除。当前文件存储无法在实际磁盘写之前持久化 intended target bytes，所以写成功到 target-after 捕获之间的崩溃仍诚实进入 needs-attention；完整桌面重启未实测。

**D-233 本地实施证据**：`terminal-projection.test.ts` / `context-runtime.test.ts` / `store.test.ts` 覆盖两个 Pi session 各有一条 event、per-target duplicate 不重入/不 nudge、持久 dedupe index 与旧行回填、写失败不推进 RAM seen；Application Host 使用保留 `targetSessionId` 的 adapter。`shell-integration-scripts.test.ts` 覆盖 PowerShell native 7、cmdlet 1、连续相同 native 码降为 1，以及 zsh 原 `ZDOTDIR` 语义；本机无 zsh，live case 跳过。产品没有 PTY restart replay，不声称 Host 重启重放。

**D-234 本地实施证据**：`web-fetch.test.ts` / `webfetch-tool.test.ts` 覆盖普通 fetch 不铸 receipt、active retrieval authority 才铸耐久 receipt、取消贯穿 body/renderer 并不缓存；`retrieval-evidence.test.ts` 覆盖完整 authority 与 exact URL/hash；`retrieval-artifacts.test.ts` 覆盖临时引用、promotion、store 重开保留同一 active Run receipt/artifact、Run 结束清理与 Thread 删除同时释放 sealed/temporary/receipt；`thread-facts.test.ts` 覆盖 catalog 提交竞态；`phase3-e2e.test.ts` 与 `retrieval-session.e2e.test.ts` 覆盖公开 `read_thread(offset,length)` 的 UTF-8 字节切片和真 child 流程。真实外部 web、完整桌面 Host 重启与付费模型质量未观察。
