# Agent harness 实施计划

Status: active execution plan; accepted capabilities ship as usable defaults (D-078)

Last updated: 2026-09-19

设计与边界见 [agent-harness.md](agent-harness.md)，Rust 系统内核的完整目标见
[rust-kernel-design.md](rust-kernel-design.md)，交付事实只看 [agent-harness-status.md](agent-harness-status.md)，
理由追加到 [agent-harness-decisions.md](agent-harness-decisions.md)。正式能力直接实施、完成后默认提供；独立评测不是前置。
全部交付后删除本计划，决策日志归档保留。

当前已完成 **D-296：退役原 VS Code companion**，决策与范围见
[foundation-governance.md](decisions/foundation-governance.md)。下一阶段进入 AI4S 阶段 7；Q
已完成并作为 D-296 的验证基础，不阻塞既有版本按自身产物证据发行。

## 0. 执行者须知

### 0.1 工作方式

- **正式设计直接实施。** D-078 已授权工作状态与目录分离、原生结果存储、版本化集成，以及检索、记忆和 review 的默认交付。
  执行者可以调整持久格式、数据 authority、协议、方法语义和默认值，连同消费者和文档完成，不按变更类别自动暂停。
- **当前没有用户，不留旧内部格式兼容。** Piarium 内部协议、catalog、缓存、索引和派生状态直接替换，旧内部库可清除重建。
  不做旧格式 reader、升级/导入器、多版本分支、双写或旧后端 fallback；相关消费者、夹具和文档在同一改动更新。
  工作区文件/Git、原生 Pi 数据及外部配置照常保全；尚未写回的实际成果如需带走，做具体交接，不据此建设旧 schema 转换机制。
  新格式自身的事务、引用保护、崩溃恢复与损坏报错仍须正确，不能把读取失败吞成空库（D-253 更正 D-252 的默认转换要求）。
- **不暂停等决策，自己决定并记入日志。** 维护者通常不在线，等答复会阻塞整条交付。遇到产品取舍、设计与代码现实冲突、
  或任务范围内没明说的选择，执行者自行决定、按现有格式追加一条决策日志（新编号 + 索引行，写清背景、决定、明确不做什么），
  然后继续做下去；这正是决策日志存在的原因，验收复审会重点看这些条目。身份、权限、路径和持久化边界用代码实现，
  不把一切未知变成默认拒绝。仓库之外的不可逆动作（发布、写外部服务、force-push）仍然不做——那不是「先问」，是不在授权内。
- **交付可用路径。** implemented 是模块实现，wired 是生产调用，proven 是有与风险相称的验证。正式能力随这次交付默认启用，
  用户显式选择继续有效。仅有 helper/单测没有消费者不能算交付；服务缺失或冲突仅影响对应请求。
- **不设统一研究门槛。** T4、独立 retrieval replay、配对实验、测试者报告和统计不劣证明都不是开发、接线或默认启用条件。
  正确性测试针对实际失败模式，质量与性能在使用中优化；不先为每个机制建评测项目。
- **验证按风险选择。** 共享协议测真实消费者，数据与并发测冲突/故障恢复，模型请求用已有真 Pi + faux provider。
  UI/纯存储不强制绕 agent loop；不固定抽两个测试、不强制 mutation testing、不每次跑全量。
- **执行者同步文档。** 重要判断做出时追加日志，直接写回设计/计划与索引，不等待另一验收方。历史条目不改，状态不冒充完成。
  参考接口可按真实调用调整，不维护过期平行 schema。
- **Git 与文件。** 保留用户和其他人的改动，不重写历史、不 force-push。按可审阅提交组交付，文档用 docs(harness)，功能用
  feat/fix(harness)，正文写契约、实际验证、未验证部分及决策编号。不带任何自动化助手署名或 Co-authored-by。
- **文本。** 模型可见工具/结果/错误用英文；UI 用项目 i18n 并补齐 catalog。用编辑器工具修改 UTF-8 文件。

### 0.2 阅读入口

[AGENTS.md](../AGENTS.md)、[development.md](development.md)、[agent-harness.md](agent-harness.md)、
[architecture.md](architecture.md)、[native-workspace-recovery-design.md](native-workspace-recovery-design.md)。
实施前读所属模块文档、确切代码和消费者；已读资料按变化与需要复查，不机械重读。

### 0.3 验证命令

根及所属包 package.json 是命令 authority。以下是入口，按改动选择 focused 文件/用例，不是每次必跑的清单：

    bun run --cwd packages/protocol test
    bun run --cwd packages/pi-host test
    bun run --cwd packages/runtime-broker test
    bun run --cwd packages/web test
    bun run type-check
    bun run lint
    bun run test:docs
    bun run docs:validate

按本轮实际改动选择命令；文档改动跑文档检查，运行时改动补所属包类型与定向行为验证，不因计划文件列出命令就机械跑全仓。

### 0.4 不变量

1. worker 不持有 Host 凭据、不直接打 Host HTTP；身份来自 broker pin/Host 注册表，服务按实际能力与路径授权。
2. system/tools 在执行配置世代内冻结，历史只追加；换配置可新建 Run，布局切换不改工具，权限撤销实时生效。
3. 失败、空、不可用、过期、部分结果分别表达，缺用量不补零，缺来源不造正文。
4. 限制对应真实问题；权限/路径是边界，调度是背压，输出/磁盘预算是配置策略，没有定标不猜硬拒绝数值。
5. 正文不进日志、广播事件或 URL，经已授权的正文/工具通道传递。
6. 模型选择 user-owned；普通线程明确继承当前模型，预设沿槽位或明示 inherit，专用未配不偷借。续接摘要沿活动请求派生，不新增凭据栈。
7. 用户确认由 Piarium 原生 `tool_call` 门统一拥有，Host 只做不交互的身份/能力/路径强制；原生 web 工具不会因检测到插件而自动让位，替换能力必须由用户显式关闭原生工具。
8. 主 agent 对上下文维护零义务。plan/todo、用户笔记和 accepted knowledge 独立保留；停止 keeper 不删除或隐藏它们。
9. 摘要准备不改历史；提交使用 Pi 安全切点，摘要与固定收束范围一起发布，保留准备期间新增原文。回合内每次模型请求前检查预算，不能用摘要丢失 B/N 来凑比例（D-284）。
10. 损坏、权限错误、未来格式不读成空；新记录发布后切换，失败迁移不覆盖旧数据。
11. 分支读固定基线加自身修改，shared 才读写 live 父目录；物化修改收集后才发布结果并允许回收。
12. 集成消费选定结果修订，写前检查父相关状态；应用/冲突/补偿可追溯，不覆盖后续用户修改。
13. 线程结果、未完集成与草稿有明确保留责任，恢复清理不删除其他所有者仍引用的正文。
14. Thread 保留工作身份，Run 冻结执行配置与输入；continue/fresh 不改变工作结果，消息传递不冒充代码同步（D-285/D-286）。

### 0.5 代码入口

| 责任 | 入口 |
| --- | --- |
| 会话装配/配置 | packages/pi-host/src/session-host.ts；runtime-broker session launch |
| Pi 写入包装 | packages/pi-host/src/workspace-mutation-journal.ts |
| 协议/工具/角色 | packages/protocol/src/harness.ts、harness-tools.ts、harness-roles.ts、harness-threads.ts |
| worker harness | packages/pi-host/src/harness/README.md；select-tools、compaction-extension；memory-agent-extension 是 D-284 要替换的旧入口 |
| Host harness | packages/web/application-host/lib/harness/DOCUMENTATION.md；router、service-host、harness-services、thread-services |
| 线程与物化 | 同目录 thread-runtime.ts、thread-worktree.ts、thread-registry.ts |
| 知识与观察 | packages/web/application-host/lib/knowledge/DOCUMENTATION.md；store.ts、context-runtime.ts |
| 文件/恢复 | packages/web/application-host/lib/kernel/ 与 lib/recovery/ 的 DOCUMENTATION.md；KernelClient/file-resource/recovery adapters、Documents authority、journal-engine；`journal-catalog` 只属测试夹具 |
| 搜索/LSP/终端 | packages/web/application-host/lib/search/content.ts、lib/lsp/supervisor.ts、lib/terminal/runtime.ts |
| UI | packages/ui/src/components/pi-session/；HarnessThreadState、HarnessThreadsPanel、PiChatView |
| 真 Pi 测试 | packages/pi-host/test/harness/session-e2e.test.ts；同目录 thread-runtime-session.e2e.test.ts |

### 0.7 当前顺序与交付方式（D-078）

P0、T1/T2/T3 核心与 D-076 已交付，不重开宽泛 P0。以下是整合建议，不是全部串行等待链：

**2026-09-15 的推进状态（D-252 / D-282）：** D-246–D-251 的返工基线已被阶段 R 的 R0–R6 完整接管并验收。
工作状态/恢复、文件/物化、进程/PTY、文件与结构计算的生产权威都已迁入 Rust kernel，旧生产 writer 与发行依赖已清理；TS 保留
产品与 Agent 编排，Pi 保留 Agent loop/provider/session。未测平台、真实 provider 与真实 CoW 的观察继续如实登记，但不把它们
改写成已完成平台的功能禁用。

**现有 Harness 收口（D-283）已完成。** Piarium 原生权限门已经接管 Harness、Pi 内置、MCP、Pi 包工具和嵌套线程的用户确认，
foundational `pi-permission-system` 及其设置/让位双轨已删除；原生 `webfetch` / `websearch` 的配置代际、域名策略、渲染选择与
插件替换语义也已收口，不再重开权限/Web 双轨。

**D-284–D-286 已实施，D-287 已完成消费者验收收口。** 容量驱动的后台摘要、按需续接与 history 回读，以及
3.18A–E 的普通派发/可选预设、task/inherit/continue/fresh、定向通信、共享准入与连续交付均已进入生产链；当前事实见 status。
**阶段 Q（D-292）与 D-296 均已完成；接下来进入 AI4S 阶段 7（D-291）。** 外部 runtime adapter 是独立后续能力，不是 AI4S 的隐含前置。
Q 整理全仓验证责任、测试装配与执行成本，不重开已完成的 Harness/Rust 迁移，也不把当前红灯一概当作测试问题。

1. **工作状态与集成（3.4/3.5，核心已交付）**：固定结果读取、原生结果、可撤销集成、Git/非 Git 物化、安全回收以及 dispatch
   草稿基线与 surface 写回/绑定预览已进入生产链（D-203）；归档/恢复与用户预算下的空间治理已进入线程面板与 Host 路由（D-204）。
   同名 read/grep/find/ls/explore 的 WorkingState 只读视图已接入真实 Thread Run（D-212）。同名 edit/write/apply_patch 已在虚拟
   Run 上提交 WorkingState delta，首次 bash/LSP 原子切换物化目录（D-213）。隔离 dispatch 已在创建分支时固定 Git/非 Git
   磁盘基线（D-214）。嵌套线程已沿 `parent.kind: "thread"` 接到真实工具能力与 Host 强制（D-215）。D-216 已拆开
   owning/execution workspace，并用 detached Git worktree 或独立 `git init` 隔离物化目录；D-217 已补虚拟写入与切换恢复；
   D-218 已补 dispatch 基线诚实；D-219 已补冻结权限、耐久嵌套集成与级联终止。D-220 已把执行 Git baseline 与逻辑 base
   拆开，钉住 explore 查询级 snapshot，并用内容身份拒绝混合基线。D-221 已规定 branch Integration 先 gate 后 store，
   并补写前日志与启动对账。D-222 已补 directory reconcile 的 execution Documents gate、dequeue 冻结 overlay、
   session-bindings 对账与知识 owning 解析。D-223 已补级联生命周期 serialization 与 scope 只拒绝完整 `..` 段。
   D-224 已补剩余状态契约：materialized 父条件撤销、cascade admission、binding 当前 owner、默认 native result 失效与
   scoped explore pin。D-231 又把 retrieval 输入改为 dispatch 时的正常 isolated 分支，scratch 与邻接 staging/result 路径必须落在
   Host/backend 重新授权的持久 `managedRoot` 内；retrieval 可按需物化，但 settle 不发布输入目录变化。3.4 / 3.4a / 3.6 仍保持
   Partial：旧记录缺 managedRoot 会拒绝自动处理，真实付费嵌套 Pi 与完整桌面重启未测。
   D-225 已让根会话 `edit` / `write` / `apply_patch` 与本轮固定 surface snapshot 共用同一正文权威；
   D-228 纠正了 CRLF/CR 身份、整组 undo、耐久 `agent-mutation` 补偿、磁盘 encoding/BOM 恢复，以及
   `apply_patch` 在 `readSource` 非 disk 时不得回退磁盘；D-232 再补写前全磁盘预检、外部回执阶段、逐路径条件补偿和 Recovery UI。
   写入到 target-after 捕获之间崩溃会明确 needs-attention，完整桌面 Registry 与 Host 进程重启仍未实测。
   D-226 已把用户终端真实命令完成接入 Zone 2（当时的 `memory.nudge` 唤醒链已随 D-284 删除）。
   D-229 纠正了 PowerShell 退出码捕获、`/restart` 代际重置、`sh` 不当作 Bash、用户 shell
   保留、带代际标识的 OSC 观察和 Zone 2 结构编码；D-233 把终端事实按目标 Pi session 分别持久化并用
   `targetPiSessionId + commandId` 幂等，补正 PowerShell 旧状态归属与 zsh `ZDOTDIR`。
   zsh/macOS/Linux 真机用户终端与完整桌面重启仅未实测。
   D-227 / D-230 / D-234 已把 `thread.dispatch(role: "retrieval")` 做成可等待的事实检索 Thread：冻结 retrieval 槽位/工具/scope，
   Host 校验 `submit_facts`，Run-bound receipt 与 artifact 持久保护正文，报告经 wait / 支持字节分页的 read_thread / Zone 2 可见。
2. **上下文后台准备与续接（2.4/2.6，D-284 已实施）**：真实请求前预算、固定前缀后台摘要、按需提交、近期原文保留、
   history 回读与 UI/线程/知识消费者收口已进入生产链；D-081 的 `takeover`、keeper coverage 与 memory-mode 设置/UI 已删除。
3. **已接线的快速检索（3.2/3.15/3.16，D-173–D-193）**：固定窗口来源、结构切片、图查询、本地语义召回与工具链已接。
   3.15 A–D 已接入公开 `explore`；独立验收补齐 actor scope、取消/截止、真实来源状态、终态、稳定视图、单元排名、required 组、到达即读与 scope 内 Top-K，见 status 3.15 与 D-182–D-189。
   3.16A 已提交（`37b12e8e`、`8752e039`）。3.16B–E 已接入生产链（D-190–D-193）：远程 embedding 绑定、向量复用与前台优先、
   草稿/线程语义覆盖、专用 HTTP rerank。已实现的旧 3.15①②④ 接口继续使用。
   explore 负责快速提供当前代码，较长开放追踪由 retrieval 承担；扩散模型与后训练留待后续。
   3.17 的命令输出整理已交付（D-197/D-199）。完成能力即按有效配置提供，缺某一路不丢弃其他材料。
4. **其余产品面**：知识全量管理、自动 review、后台终端 tab 与 bundled Pi 默认已交付，并经 D-209–D-211 补正身份、并发和退出契约；知识语义召回已沿远程 embedding 接线（D-196）。重叠提示与合并预览随线程服务实现，不设独立收益审批。
5. **Harness 收口（1b.7 / 3b，D-283，已交付）**：原生权限唯一权威与 web 配置/替换语义已进入生产链；验证和剩余平台观察见
   status。本计划后续不再保留 permission-system 共存或 pi-web-access 自动让位作为兼容目标。

TriviumDB 优先保留，不启动 SQLite 迁移；Windows 沙箱排除。平台与外部 provider 的未验证范围如实报告，不把缺另一平台机器
写成已验证平台的禁用条件。不自行发起付费记忆实验；完成一个切片后按本节顺序继续，不把文档同步解释为停工点。

## 阶段 0 / 1 / 1b 与 P0：已交付入口

当前事实与证据保留在 status，此处不重复已完成计划与废弃接口。

### P0.1 broker 会话身份 pin

create/open/fork 响应后 pin，snapshot 只校验不重绑，见 runtime-broker 与 status 1.1。

### P0.2 Router Actor 与静态授权

按 activeTools/Host 可用性推导，关闭同名覆盖不等于撤销 Pi 工具，见 status 1.1/1.7/3b。

### P0.3 注册表与启动对账

每 workspace 原子 catalog，损坏/权限/未来版本分开，中断 Run 标 lost；当前 schema 以代码为准。

### P0.4 Thread 与 ThreadRun

lifecycle、attention、integration、Run 结局正交；恢复新建 attempt，不清掉旧 lost 历史。

### P0.5 OutputRef 与 TranscriptRef

临时句柄有 Host generation/FIFO 水位；耐久转录不保证截断全文；分页统一 UTF-8 字节。

### P0.6 路径租约

Host 规范化、完整批次全序获取 owner-bound lease；只保证该 Host 管理的写入互斥。

### P0.7 已有验证

身份、Unicode、跨会话、注册表故障测试已存在，修改相关契约时复用，不重新跑一轮完整 P0。

阶段 1 待做：apply_patch 多文件恢复真会话证据；macOS/Linux 与 Electron 打包验证。
Windows 生产发现与按工作区 `harness.shell` 接线已由 D-200 交付；后台 shell 与 terminal runtime 共用真实进程、全局身份及退出/写者
生命周期已由 D-206/D-209 收口。
websearch provider / render / domain policy 现在按 worker generation 冻结：设置改变后新会话直接使用新绑定，无需重启 Host；
旧会话保持原 provider identity，凭据则每次请求实时解析，撤销后明确 unavailable。

### 1b.7 原生 Web 能力收口（D-283，已完成）

现有 `webfetch`、`websearch`、Host SSRF fetch、Brave/Exa/Tavily/Jina/SearXNG provider、search-only Pi auth 凭据和来源面板
保留为正式实现。本阶段已完成配置和所有权收口，没有重做搜索引擎，也没有新增第二套抓取服务：

1. 删除按 `pi-web-access` 包名/启用状态自动让出 `webfetch` / `websearch` 的会话装配路径。原生工具按 Harness 设置提供；用户要使用
   第三方同名工具时，显式关闭对应原生工具。包的存在本身不改变运行行为，也不保留自动让位兼容分支。
2. 把 provider 与凭据解析做成 Host 管理的配置代际。设置或 credential 改变后，未来创建的会话直接取得新的 provider identity 与
   工具可用性，无需重启应用；已创建会话的工具集和绑定保持冻结。凭据被撤销后，旧调用明确返回 unavailable，不缓存旧密钥或
   静默切换 provider。
3. 为 fetch 与 search 接通同一套 user/workspace 域名策略。workspace 只能收紧；工具参数中的 allowed/blocked domains 与配置求交，
   不能扩大持久策略。Host 在发请求和接受重定向前执行实际策略，来源面板只展示已经通过策略的 URL。
4. `web.render` 必须真实控制 Electron 离屏渲染选择：关闭时不启动 renderer；开启而当前 Host 无 renderer 时明确 unavailable，不能把
   未渲染的 SPA 当成功。Web/云 Host 继续如实声明自身能力。
5. 删除没有生产消费者的 `maxFetchesPerTurn` 配置、UI 和文档。它没有对应的已定标失败模式，不能以未实施的硬次数预算冒充安全
   边界；真实网络取消、provider 限流/错误、输出背压和 SSRF 继续各自表达。
6. 当前单 provider 配置足以交付；本阶段不增加自动多 provider 并发、隐藏回退或模型包装。以后出现真实可用性需求时再扩展 provider
   选择，不把功能数量当收口条件。

验证沿公开 `websearch` / `webfetch` 工具到 Host adapter，覆盖配置变更后的新旧会话、credential 撤销、域名策略交集、跨域
重定向、renderer unavailable 和显式关闭后的第三方替换；对应证据已写入 status。默认搜索行为随后由 D-289 更新如下。

### 1b.8 默认网页搜索与原文续读（D-289，已实施）

1. Host 服务可用时默认注册 `websearch`，无配置选择 Exa 免密钥搜索、明确失败时顺序尝试 Parallel；不使用模型账户、不启动搜索子 Agent、不要求用户安装 MCP。
2. 自配 provider 保留原凭据与固定会话绑定，失败不隐式改绑。默认服务的实际来源/换源原因可见；区分空结果、服务失败和取消，空域名允许集不发网络。
3. Settings 默认显示“无需密钥”，说明 Exa/Parallel、查询发送与供应商限流；保留自配服务和显式关闭。所有已有语言同步。
4. `webfetch` 在原抓取/缓存路径上支持字面查找及提取 Markdown 行范围；结果保留来源与收据，不新增持久页面库或额外模型总结。
5. 验证无搜索配置的公开工具 → bridge/router → Host 默认服务 → 真实 HTTP adapter → 结果与后续原文读取；定向覆盖限流换源、取消不换源、合法空结果、域名 ceiling 与自配凭据错误。实际网络样本只证明当次可用性，不外推免费额度或质量排行。

## 阶段 2：上下文与知识

### 2.1 知识库服务

保留 TriviumDB 单写者和领域操作，复用 Store 队列。0.8.5 TQL/零向量绕路按设计 7.5 记录，不固化到上层、不外推最新上游。
数据库问题给用户版本、重现与影响；补 retention、删除级联、native 打包消费者。批次按负载配置，不照搬 5000 条硬数字。
工作状态/集成引用独立保护；领域元数据与文件内容存储职责分开。验证真实 Store、引用清理与相关 Node/native smoke。

### 2.2 Zone 2

现有 zone2.assemble / 隐藏 piarium-context 追加通道保留。D-284 只投递新事实、用户修改与相关的新知识指针，不每轮复制全部
blocks/计划/用量面板；agent 自己的编辑、命令和 todo 已在工具结果中。用量 UI 保留，不为变化的使用率单独追加消息。
保留 event cursor 与送达提交；无材料不造消息。去重绑定来源/修订及其是否仍在保留原文中；压缩实际切点丢失基线才重建
对应观察，不在候选准备时重置。沿现有呈现预算汇总明确机械重复，正常 read 不因读过或临近容量缩短，估算明示。
User terminal 段只投影 `source !== agent` 且带 command+exitCode 的事件；cwd 有则写入。每个目标 Pi session 单独写 event 并推进自己的游标，
幂等键包含目标 session 与终端 commandId。无 integration 不造伪命令。

### 2.3 Host 观察者

Documents post-commit、用户修改后的 LSP 和现有 Git 刷新已接。逐命令终端信息用真实 OSC 133/633 shell integration，
不把 PTY 退出当成命令完成、不按终端文本或提示符正则猜命令。只对 user 会话注入；Harness spawn 不注入、不解析。
观察失败不反噬已经成功的写入/HTTP/终端，具体来源不可用要可见。`targetPiSessionId + commandId` 去重，不重放 history、不倒退 Zone 2 游标。
用户终端、steering、计划修改和子返回的事实送达保留；D-284 删除为持续 keeper 发送 `memory.nudge` 的模型调度依赖。
事件实际带来的新内容计入下次请求预算，事件名称/完成/缓存 TTL 本身不触发摘要。

### 2.4 后台摘要准备（D-284，已实施）

正常路径无明显整理停顿是本阶段的产品目标。后台只为下一次压缩生成固定历史摘要，不持续维护工作块；候选 ready 不提前
提交，前台正常新增 entry 不使候选失效。术语、默认和失败语义统一见设计 8.4。
D-286 明确本阶段吸收完整上下文讨论，不能仅交付无感调度：设计8.0的工具首次呈现、8.1–8.3的缓存/增量、8.4.2的容量与
原文、8.4.3的续接摘要、8.4.5的回读与保留、8.4.6的keeper退出、8.4.7的输入重建都须有对应消费者，范围汇总见8.4.8。

#### 2.4A 真实请求预算与摘要请求派生

- 入口是 session-host/ModelRuntime 与 Pi 的真实模型请求构造，不仅是 `session_before_compact`。覆盖一个回合内工具执行后的
  每次模型继续；现有 Pi prompt 前/agent_end 后的自动摘要不能并行成为第二个调度 owner，也不在已结束任务后做收费整理。
- 有效窗口来自模型/provider 与用户覆盖；读取本次真实输出/推理参数，估算 system/tools、保留消息、新工具结果和用户输入，
  按 provider usage 校正。换模型、压缩后计数重新建立，cache 字段不重复相加；显式自动压缩开关和原文保留量仍有效。
- 从活动主请求派生摘要请求：稳定 system/tools/原消息与适用缓存参数，尾部增加固定范围的总结要求。摘要无工具执行器，
  无 memory_edit，无新槽位/密钥；不自动换 minimal、toolChoice:none 或 cacheRetention:none 后仍宣称共享完整前缀。
- 复用 Pi 会话/切点/compaction entry。若 SDK 接缝不足，在受版本管理的依赖/适配层完成所需接缝；不热改 node_modules、
  不复制新 Agent loop、不靠 UI 隐藏阻塞。将实际入口和支持的 Pi 契约写进模块文档。

验收针对真正出站请求：公开会话一次回合内有连续工具调用，新工具结果参与下一请求检查；摘要请求形状、输出预留、usage
可观察且不会执行返回的工具调用。沿已有真 Pi/faux provider 纵切验证，不先建立外部质量评测平台。

#### 2.4B 固定候选与前台并行

- 固定 `(session, 现有 compaction 边界, 被收束前缀, 输入末端, firstKeptEntryId)`，先决定摘要范围，再调用模型。记录调用配置与
  摘要用量；同一压缩周期复用在飞任务/候选。前台 B+N 原文继续追加，不因正常 steering 或几条新消息重新生成。
- 准备首轮采用约 75% 可用输入的可配置软水位；有同配置的摘要耗时后结合近期增长调整提前量。保留量未显式配置时，以约
  60% 可用输入作为压缩后总目标，预留摘要与准备期间新增尾段空间。两者不是运行硬上限或已经测得的最优比例。
- 主请求在可控制的队列中优先，不用本地串行 ModelRuntime 锁把前台卡在后台摘要后。任务结束不新开准备；关闭/取消/来源
  失效终止无用任务，分支导航取消不适用候选。模型变化重核预算与配置；同分支正常追加不是失效。
- 候选在 worker 内暂存，重启时完整 Pi 历史仍在；不增加候选数据库或持久 daemon。手动压缩复用适用候选，明确不同重点时
  才替换，旧迟到结果不能被提交。

验收用受控延迟的摘要响应证明前台仍完成后续步骤，候选只生成一次，候选 ready 时历史尚未改变；分支导航、取消和新消息
分别核对实际来源与尾段。不能把“异步函数已返回”当作前台不被阻塞的证据。

### 2.5 todo 与计划面板

保留已交付的整表替换 plan、来源和用户版本冲突。confidence 只作信息，用户明确配置审批或 plan mode 才等；
普通计划不中断、显式审批与取消/冲突的既有边界保持，不重新增加记忆维护义务。
停止 keeper 后 plan/todo、用户编辑与笔记继续可见可写；不得沿旧 `memoryMode:off → blocks:[]` 将这些能力一并屏蔽。

### 2.6 按需切换与消费者收口（D-284，已实施）

#### 2.6A 提交、异常容量与历史回读

- 在下一模型请求前，沿 Pi 安全边界核对候选来源、工具配对与当前预算，发布摘要和 firstKeptEntryId，再构造
  `P + S1 + B + N`。保留准备期间新增的用户消息、工具结果和待处理 steering/follow-up，不覆盖或重复重放。
- 切点不能在摘要后向后移动，导致未被收束的原文消失；摘要较短可向前多保留原文。候选偏离 60% 但下一请求可用时直接采纳，
  不为了比例重做摘要。连续压缩替换一份活跃摘要，原始 Pi entry 留存。
- 新材料/窗口缩小导致超窗时，摘要调用自己也要有可用预算：按配对边界分次收束可容纳的旧前缀，保留最新原文。候选未完成
  则复用并等待同一次调用；失败或失效走同一摘要实现，不回到 keeper。每次扩大收束须有进展，单份材料本身超窗要明确
  分页/读取入口或容量错误，不静默裁掉正常结果。
- 公开 `history` 工具复用当前 Pi session/branch 的查找与 entry 读取，支持关键词、路径、entry 与相邻原文；继承 actor
  和父子权限，不向子暴露父完整对话。大输出沿现有分页和保留责任，临时句柄失效与真正全文可读分开表达。
- 补同一工作 fresh 的输入构造接缝：当前任务与仍有效约束、当前系统/项目规则、选定成果与未解决项、必要历史/活跃动作引用。
  原始Pi历史和工作状态保留，旧验证不冒充新修订通过；新输入就绪后才发布世代，不强制再总结一遍旧历史。Thread 的具体
  continue/fresh 入口在3.18B消费这条通用能力，不复制第二个上下文引擎。

验收沿一条真实会话证明“后台准备 → 前台新增 → 容量切换 → 下一次请求 → history 回读”；结合来源漂移/取消、超大新结果、
模型变小与再次压缩的实际反例。候选失败不能先截历史，退出任务无新增总结调用。共享场景合并验证，不按字段机械堆测试。

#### 2.6B 默认切换、UI 与旧依赖删除

- 以新链完整替换持续 keeper：删除 memory-agent 调度与专用 memory_edit/coverage/compaction.before 组块路径，删除
  off/assist/takeover 和 shadow 运行分支、专属状态/UI。保留有实际用户/计划消费者的 block 读写，不按名字删整个知识模块。
- 联动 2.2/2.3：真实事件照常送达，移除 keeper nudge；不重复注入全部 blocks/用量。观察基线绑定交付 entry，只有实际退出
  保留原文的基线才重建；候选 ready 不重置。删除未接线的文件/技能重注入 helper，不再按压缩次数推委派。
- 联动线程：dispatch carryBlocks 只携带计划/用户笔记；read_thread/Zone 2 优先展示真实状态与报告；报告偏离从明确报告字段
  取得，缺失明示。删除依赖 decisions 块的自动报告/建议来源，不另起模型补齐；accepted knowledge 与已有建议保留。
- 自动压缩沿 Pi 开关，后台准备默认启用且 user-owned，可单独关闭并保留必要时的同一同步摘要路径。删除旧引擎，不静默
  改写外部 Pi 配置；旧 memory 字段提示退役，明确关闭后台维护的用户选择继续阻止提前调用，不能误当自动压缩开关。
- UI 在实际提交时展示边界，可展开摘要、前后规模和保留原文；准备不锁 composer，只有实际等待才显示等待。保持正常 token/
  缓存/费用 UI；准备耗时、采纳、等待、真实 usage 与首次续接延迟沿现有诊断记录，不建辅助费用看板。
- 核对工具输入端：搜索一次返回足够判断的片段，read保持请求原文，测试失败块/未知输出不被噪声整理吞掉，附件不擅自替成
  概要；复用现有格式器/存储。跨压缩仍需引用的输出用会话保留正文或已有artifact，不把临时句柄当永久全文。没有问题的
  工具不重写、不逐工具机械加测试；重点检查窗口压力不会改变正常返回质量。

接通新会话控制器时保证同一次压缩只有一个调度/摘要 owner；最终交付前删除旧 keeper 及无消费者的相关协议、测试和文档。
最后以公开消费者验证计划/用户笔记、知识、线程返回仍可用，未到准备水位的正常短任务没有新增摘要调用。真实缓存率与质量
在实际使用中观察，不用测试数冒充结果，也不以付费模型对照作为上线前置。

### 2.7 知识建议与管理

人工标记、suggestions 槽位的用户消息提议和 Settings 全量列表/取代链均已接（D-208/D-211）；未配走已有
无模型路径。Settings 的编辑/接受/驳回/停用以打开时完整修订在同一写队列 CAS，同 scope 预检后提交，旧历史保留；模型提议的
scope/source 由 Host actor 固定，相同正文的历史查重与插入原子完成。自动接受仍按用户显式 scope 设置。
keeper decisions 来源已随 2.6B 移除；不从续接摘要追加自动提炼调用，已有知识/建议不删除。

### 2.8 embedding

生产路径按 D-196 / D-198 接线与收口，交付以 status 为准。权威 workspace/user `.tdb` 仍以 placeholder 维度打开，知识向量复用共享代际存储的独立 scope。有效 `harness.embedding`
时，召回与 Zone 2 注入走同一 `harness.embed` 绑定；未配置保持文本/图。旧 `knowledge/embedding.ts` HTTP adapter 已删除。
知识库不使用本地 MiniLM。建设必须覆盖自动维度、空间切换、正常变更的增量合并、迟到发布与关闭；有效状态/修订在 Top-K 前约束，长条目的多个块按知识身份合并。
公开 recall 与 Zone 2 使用同一绑定、取消和两种范围的融合逻辑，绑定解析异常仍交付文本。验证包含未指定维度的真实 remote adapter 与公开服务消费，faux 证据不外推真实远程质量。

### 2.9 模型槽位与执行配置

当前 protocol/UI 提供十个普通 Harness 槽位；`harness.embedding` / `harness.rerank` 是独立配置种类（3.16B/E）。继续使用用户所属的 Pi
配置与凭据路径，子线程模型记在 ThreadRun；D-285普通线程与预设的明示继承不伪装专用绑定。新增模型 kind 必须同时完成类型、设置、
有效绑定与调用消费者，不能靠 UI 任意填一个 model id 冒充后端能力。D-080 的普通会话统计保持，不增辅助分项看板；完整
RunManifest 不成为这组能力共同前置。

### 2.10 recall

保持 workspace/user 召回和来源标注；suggested/dismissed/失效知识不当有效记忆，user.tdb 不存 event/文件。
补实际查询与管理消费者，不要求评测集。

## 阶段 3：检索、工作状态与线程

### 3.1 符号图

D-237 已补显式重扫的外部删除对账：完整枚举 + Documents missing + store revision/generation 条件删除，排队取消保留旧图；
失败/截断/未知 inventory 不删除，重建路径重新采集，关联随 connects 集合更新。沿现有扫描入口，不新增后台循环。

已有 file/defines/symbol 以及 `imports` / `connects` / `associates`（3.11 第 4 步）。读者是 explore 的路径级候选
（定义 / 连线另一端 / 反向 import / 已解析 references/calls，3.12）和 `related` 工具；摘录出边注解（D-108/D-112）仍在。
D-240 已按实际查询建 `references` / 解析后的跨文件 `calls`：relation collector 围绕锚点有界解析并持久化、lsp 导航回写
磁盘绑定结果，来源/版本明确（resolvedBy + 站点修订 + staleTarget），LSP `references` 不冒充调用图，也不和 `related` 抢活。
复用背压和按变化路径采集，未知语言/不可用不清最后图；不把全图或所有索引完成作为 explore 前置。
范围只从磁盘正文采集并逐文件记 document revision（D-087）；脏缓冲结果不入图。图只选路径，行号在当前正文里重新确认。

### 3.2 explore：正式默认工具

本节提供当前入口；新的查询与索引工作分别在 3.15/3.16 排期，行为契约以设计 6.1 为准（D-173–D-175）。

| 已有能力 | 下一步实际改动 |
| --- | --- |
| 自动 surface snapshot、Documents 当前正文、固定草稿的 read/grep/find/ls 与线程基线；根会话 edit/write/apply_patch 经 `document.surfaceWrite` 写回同一缓冲（D-225） | 语义覆盖沿同一来源（3.16D）；不另建读取权威 |
| question/anchors/paths、对象与词组提取、候选按文件轮转、真实 rg | 保留明确范围和线索，收窄隐式意图判断；路径/符号明确时直接导航 |
| models.explore 经公开 explore 接入查询理解/搜索表达和候选判断 | 沿用 Pi 会话 ModelRuntime；真实槽位质量仍未观察 |
| 结构切片、图定义/连线另一端/反向 import、带版本的 focusRanges | 图只给可核验导航或关联；语义焦点不依赖查询词命中 |
| 词法加权覆盖、本地/远程向量、开放候选按真实来源名次 RRF | 单元自身依据；配置了 rerank 且本轮未用 LLM 选择时走 3.16E，不与 LLM 默认串跑 |
| 原文、provenance、OutputStore 与 UTF-8 预算 | 一次决定实际呈现，原文省略项与最终记录一致 |

3.15 A–D 的查询上下文、开放排名、呈现前单元与 LLM 消费者已交付，见 status 3.15 与 D-182–D-189。工具原生链、Actor 路径、
固定草稿与输出句柄的已验证事实看 status；3.16B–E 接线见 status 3.16，真实 explore/embedding/rerank provider 质量仍未观察。
精确匹配继续用 grep，较长开放问题由 retrieval 处理；快速 explore 用 LLM 做局部语义决策，算法执行批量搜索/读取，不复制
完整自主子 agent 循环。全仓生成式摘要和新词法索引按各自实际需要另行设计。
没有某一路时明确来源状态，其他检索保持可用。

### 3.3 related

✓ 已接线（3.12 + D-240）。工具回答文件级定义、import、反向 import 和连线另一端，并对符号名锚点做有界解析回答已
解析的 references 与双向 call 边（每定义一次 references+definition+callHierarchy，≤8 个定义）；没有与不完整分开表达，
relation 段按 per-source 状态区分。不是 `lsp.references`（按位置精确回答），不做 PageRank / 多跳。store 未打开返回
`unavailable`，不开库。

### 3.4 工作状态、物化与生命周期

沿已交付 Thread/ThreadRun、catalog、角色冻结、异步 dispatch、blocks、传感器、真实 child 和 Fleet 扩展，不重建旧模型。
设计 9.2.5b 为完整行为边界，下列工作直接实施：

D-252 把本节存储、文件事务、物化及对应底层资源的下一轮结构演进纳入阶段 R。已完成的 TS 返工保留并独立验收；
后续按 R1–R3 接管其权威与消费者，不再并行规划第二轮同目标的 TS 存储重写。本文 A–F 的用户行为仍是 Rust 验收输入。

**A. 固定结果。** 物化线程 settle 先建立固定 snapshot，再从该 snapshot 中工具实际看到的文件字节发布 native result；发布
catalog 前复核 snapshot 身份。snapshot 后 live 修改不混入，另发新结果。报告/测试绑定受检修订，输入变化不自动继承通过。

**B. 原生状态与迁移。** Host 建内容对象/路径树、固定基线与 delta/tombstone 分支头，结构共享、原子发布。结果/Integration
独立持有正文引用，复用恢复捕获与路径状态；恢复历史删除不丢线程结果。Git tree 可作基线来源，原生 capture/copy/CoW 支持
非 Git 和无首次 commit。初次采集有真实成本，普通消息不捕获全仓；监视器只作失效信号，变动中捕获重读或报告不完整。
Git 留作基线/物化/导出后端；不从 commit blob 重放可能执行副作用或触网的 filter 来迁移旧内部结果，也不建设升级导入器。
内部格式按 0.1 直接替换并清旧路径。覆盖新格式的读取失败、并发发布、中断、对象保留与原生 Pi 会话消费。

**C. 工具与草稿。** 同名 read/grep/find/ls/edit/write/apply_patch 读写固定 base+delta，父改动不串读，包括子未改路径。
用户消息自动取得草稿快照，来源/版本随分支保留；草稿集成走 Document Registry 的版本化编辑和 grouped undo，不隐式存盘。
原生 Pi 工具、LSP、扩展、shell 需要真实路径时 materialize 并切同一执行视图，不为无目录而禁用正常能力；shared 明示实时共享。

已交付的第一段是 dispatch 草稿基线：请求内复制固定正文与字节格式，Thread catalog 持有不可变 baseline id，queued/lost 恢复从持久
对象重建；有效草稿是 branch revision 0，不是 child delta。dirty 角色强制 isolated，来源不可用则 dispatch 失败。D-214 / D-218 已把非草稿
路径改到 dispatch 创建分支时固定：Git 捕获工作目录身份与变化集，非 Git/unborn 做一次可取消目录捕获；Git 错误、捕获窗口变化、
活跃 writer 与 gitlink 不得发明完整分支；失败删除 Thread。新虚拟文件在形成结果前写入真实默认 mode，apply/补偿按 `sameState`。
父会话的同名 read 与 grep 已消费同一固定 surface snapshot；find/ls 已消费同一快照。surface 写回与绑定预览
已按 D-201 接入线程面板 / Document Registry。D-212 已把隔离 Thread Run 的同名只读工具接到 WorkingState 视图：delta 覆盖 base，
tombstone 隐藏路径，父 drift 不能补读，scope 仍由 Host 拒绝。D-213 / D-217 已把同名 edit/write/apply_patch 接到同一分支视图：虚拟写入
做 writeRevision CAS，不碰父磁盘；首次 bash/LSP 冻结修订、等在飞写入、staging 物化后原子切换。失败或取消后重读
execution view，仍虚拟则继续写分支；崩溃按 `materializationSwitch` 恢复到一个权威视图。修订标签等于实际读取的
`writeRevision`。嵌套改父虚拟分支走同一写 gate。
所有物化/scratch 记录持久化 `managedRoot`，读取或改变目录前同时验证 canonical containment 与 Host/backend 根授权；旧记录不能靠
自己写下的路径取得删除权。Application Host 的虚拟 scratch 位于自身数据目录，不占用父或根工作区路径（D-231）。
D-220：独立 init / detach 后 inspect/settle 使用执行仓库可解析的 `executionBaseline`，`worktree.base` 仍是父状态身份；
reclaim 后 rematerialize 不得引用已删子仓库对象。WorkingBranch 读取在 store lease 后重取当前 view；explore 查询开始时
在同一 shared lease 内复制 immutable snapshot。默认新文件 mode 按 umask 计算，不探测用户树。fingerprint 含 dirty 内容身份。
D-221：嵌套 merge 先取得父分支写入/切换权威，再决定 branch 或 directory，再打开 store/目录；branch 集成先持久化
applying intent，CAS 后再 complete。启动对账按 before/after 补记录。`runWhenVirtual` 不再用固定次数制造失败。
D-222：directory 恢复写物化父目录必须走 execution Documents gate，对象库仍在 owning root；dequeue 把 manifest
permissions 送进 `session.create`；`session-bindings.json` 由 catalog/run 重建并对账；Thread knowledge/recall/Zone 2
解析 owning workspace，Documents/LSP/shell 仍用 execution。
D-223：父 kill/archive 按稳定后序进入每个后代自己的 lifecycle serialization；祖先归档或正在级联时拒绝恢复该后代。
scope 只拒绝完整 `..` 段、绝对路径和盘符路径。
D-215 已把 `parent.kind: "thread"` 接到真实 dispatch/wait/read/merge：角色目录装配嵌套工具，Host 拒绝扩 scope 与未授权
工具；嵌套基线复制父分支视图，孙结果先入父分支再入根工作区。

**D. 环境与执行写回。** Git/copy/CoW 按平台选择，缺 CoW 用正常复制，默认不硬链接可写目录；包管理器缓存可复用。
setup 采用用户工作区配置，配置一次授权正常重复执行，不猜仓库命令；按工具、依赖输入和实际环境需要运行幂等准备。
没有 setup 不伪报已准备，也不禁止已能工作的任务；timeout 可配置，不预置 600 秒硬停止。失败记 setup-failed、退出和可追溯
输出，修正后新 Run 继续。copyIgnored 已以 branch captureScopes 冻结并捕获后续新增/修改/删除；其他规则继续标记版本化输入/结果、
可重建缓存、环境文件，ignored/名字不等于可删除。
用户显式共享显示范围。命令、后台 shell、格式化/生成文件通过后端差异和变化记录收回状态，成功发布 revision。
物化期间受控工具与命令用同一目录，分支按执行世代协调写入；未收集完保留目录，崩溃按实际对账，不重放可能已执行的副作用。

**E. 回收与空间。** D-077 的 merge/cancel/failure/archive/无使用者 idle 边界默认回收；前提是待保留结果保存、相关实际写者
退出，原路径可按结果重建及 setup。git status 干净/无 running Run 不是全部证据，ignored 结果和后台进程也要处理。
未知内容只保留该目录并报原因，不禁其他线程；显式 keep_worktree 有效。统计目录与对象历史占用及可回收量，按用户配置预算、
真实空间/已知需求处理，缺定标不采用 8 GiB/10%/80% 默认。必要时回收/排队/明确不足，不杀已有任务；未知 setup 占用不计零。
真实 ENOSPC 可诊断并保留可恢复结果。启动对账检查受管归属，未知目录不猜删除；历史按引用/用户保留清理，不固定 30 天删结果。

D-239 已接用户旧结果释放：线程卡片按需 GET history，确认 branchId/resultRevisions 后 POST release。Host 在同一生命周期与
存储/Registry 边界重查 head、当前结果、Run 输入、review 和未结束 Integration；先删除版本元数据，再释放其引用并回收无主对象。
中断对账保留当前权威，未知目录不授权清理；返回逻辑移除和实际对象清理两个结果。保留当前分支、报告、转录及其他引用。
验收包括共享内容仍可读、释放旧输入后已完成 Integration 仍可撤销、失败重试与 UI 迟到响应隔离。整个 Thread/当前分支删除不在本切片。

**F. 提示。** 路径重叠非阻塞，未知 shell 覆盖明示，不长期占编辑锁。合并预览绑定子结果与父相关路径/草稿版本，改变即失效，
接 integration/Zone 2/UI，不等全仓 WorkspaceHead 或收益 benchmark。实现与集成共用查询，不复制状态 authority。
预览查询不制造自身 Thread 更新循环；冲突提交消费旧预览的完整 binding，不在重取父正文后复用旧解决（D-203）。

对应验收：固定结果后 live 修改不混入；父改动不串读；子原地写不改父；setup/执行写回；ignored/后台 writer 不误回收；
原路径重建；跨清理/迁移引用；非 Git/无 HEAD；真实 Pi child 创建到执行、结果和重开。平台后端在相应机器验证，不要求所有
平台完成才启用已验证后端；这些是实施测试，不是决定要不要采用架构的研究门。

### 3.5 线程工具与 Integration

dispatch 异步准备、观察增量、固定结果集成与kill保留结果是现有基础。当前send仅接受直接子active/running，并不能续做settled
实现线程；D-285在3.18补新Run、inform/request与目标路由。等待按共享执行准入，压缩基线按D-284保留区间处理。

merge 以选定原生结果和父相关状态生成计划。逐路径三方处理相同/未改、文本、删除/修改、
类型/链接/mode；文本可留标记，非文本给版本选择。无需父 clean 或用户 commit，不切分支、不改历史。
UI/agent 共用 operationId，重试与新结果分别处理。

接恢复逐路径 before/after、apply intent、核对、条件补偿；预期冲突保留现场，意外 I/O 部分失败补偿，后续用户修改不被覆盖。
结果明确 applied/conflict/compensated/needs-attention 并给已应用/冲突路径，不用 merged:0 暗示父完全未改。
冲突解决核对同一操作，不重放已写 patch。草稿在 surface 应用撤销，磁盘经 Host/Rust。原生路径集成不修改 index，不恢复已删除
Git结果导入器或写index的--3way。集成完成与父回合checkpoint绑定；不能把process writer注册等同可撤销日志。
草稿执行复用 Documents owner 连接，绑定实例/代际/修订/哈希；正文与回执经认证通道。磁盘与 surface 在同一持久操作先记 intent，
确认后才完成，崩溃不明保留 needs-attention；撤销与条件补偿校验当前产物。agent 不依赖线程面板代为执行，UI 不自报裸路径完成（D-203）。
合并与验证分别记录；父对合并后状态做相关检查。结构感知优化沿合并策略实施，不把不同函数等同语义无冲突。

验证正常/冲突/部分失败/中断、幂等、父并发、草稿不存盘、index 后续修改和报告绑定；覆盖重叠区间、权限位、无效 UTF-8、日志提交失败
后重试、共享 catalog 工作区隔离，以及删除完成历史仍保留线程结果；用真实文件/Git 与现有 Pi E2E，
不要求新评测集。

### 3.6 可选预设与嵌套（D-285）

目标由3.18交付：role不再必填，普通线程继承当前模型；预设提供任务方法/工具/明确模型来源，工作区和背景另选，执行配置
归Run。保留Host allowlist、capability、父权限和scope，不以消息改变权限。允许普通执行配置嵌套，不限两个角色名；同根
共享执行预算，父子/兄弟允许定向通信。task为默认背景，inherit显式选择，不为所有线程复制长历史，不按轮数或token设新限制。

`retrieval` 是较长事实Thread，当前入口是 `dispatch(role: "retrieval")`，新入口通过preset表达，事实协议保留。未配置
`models.retrievalAgent` 时角色不出现且 Host 拒绝无 model 的 retrieval dispatch。工具 allowlist 不含写/bash；
web 工具仅在 Host 已装配时可用。交付物由 `submit_facts` → `thread.facts.set` 写入，settle 时 Host 封印
`report.evidence`。Host 标 source-checked 而不是 verified，delivery 不用假 completeness，pending 绑定 runId，
证据走耐久 artifact；receipt 只由 active retrieval Run 铸造并绑定 owning/session/thread/run 与 exact URL，普通 webfetch 不铸权威。
嵌套 retrieval 在 dispatch 时沿 isolated 分支固定父状态，可按需物化只读输入，settle 不发布目录变化（D-227 / D-230 / D-231 / D-234）。
取消/失联复用既有 Thread 生命周期，真正删除 Thread 同时释放 pending/sealed/temporary artifact 与 receipt 引用。

### 3.7 自动 review

当前review-sensor默认enabled:true/gate:false。D-285改默认关闭，已有用户显式enabled/gate保持；实施者正常验证、主线关键
验收与按需独立review不变。仍用固定diff/任务/项目知识和resultRevision+reviewThreadId+reviewRunId绑定，迟到旧结论不标
新结果通过；不把每个子结果自动接一轮模型审查。模型来源按预设明示，不新建review流程层。

### 3.8 LSP 导航与语言服务视图（D-087）

保持现有 workspace/scope、一基位置与"编辑器 buffer 不被磁盘覆盖"；隔离线程用自身版本/物化目录，不能借父缓冲冒充子状态。
缺某语言服务器只说明该来源不可用。本切片把共享会话拆成按来源隔离的视图，并让范围携带正文修订，交付顺序：

1. **语言身份统一（已交付）。** `@piarium/protocol` 的 `languageIdForPath` 取代 `lib/harness/language-id.ts` 与 UI
   `language-services/language-id.ts` 两张表。`.mts/.cts/.mjs/.cjs` 在 agent 侧不再判 unsupported，`.sh` 统一为 `shellscript`
   （编辑器显示经 `editorLanguageIdForLanguage` 映射回 `shell`）。运行时由编辑器注册表贡献的语言仍只在 renderer 可见。
2. **视图键与版本命名空间（已交付）。** 会话键加 `viewId`；Host 视图按 (视图, 资源) 单调分配版本，`surface` 视图沿用
   `localEditRevision` 且行为不变；renderer 路由固定 `surface`，事件流按视图过滤。
3. **agent 视图的正文绑定（已交付）。** `createLanguageViewBinder` 统一解析正文：导航按 `AgentInputContext` 取固定草稿或磁盘，
   符号采集与诊断只取磁盘；已知脏路径草稿不可用时不回退磁盘。惰性起进程，`inspectViews()` 报告进程数/开文档数/空闲时长。
4. **修订出现在结果里（已交付）。** `LspNavigationResult` / `DiagnosticsResult` 带 `revision` 与 `disk | surface-draft`；被查询
   文档请求前后断言修订，`stale` 重绑一次后重试；跨文件位置标 `unpinned`，不编造修订、不在覆盖不全的信号上判 stale。
5. **生命周期归位（已交付）。** 视图各管自己打开的文档：关标签页只销毁 `surface`，Host 视图按 LRU 设上限、空闲释放、重启不重放
   `didOpen`；`restart` 与 provider 重注册只影响本视图。
6. **符号图记修订（已交付）。** `replaceFileSymbols` 要求 document revision（空值拒绝），旧行缺该字段读作 `null`；脏缓冲结果不
   入图。`explore` 结构展开只用修订一致的范围——该消费者仍待接。
7. **诊断精确化（已交付）。** 删除 `endsWith` 双向后缀匹配；`lsp.diagnostics` 绑定磁盘正文并等待同一修订的发布，超时 `pending`；
   无生产调用方的 `afterSnapshot` 参数与 provider `syncDocument` 一并删除。

已验证：视图隔离与 Host 版本分配、同修订不重复通知、`expectedRevision` 不符即 stale、关闭编辑器最后一个标签页不影响 agent 视图、
LRU 上限与空闲释放、导航的固定草稿与"草稿不可用不回退磁盘"、跨文件 `unpinned`、stale 重试一次后不循环、真实 fixture 进程下
`surface` 视图保持 absent、诊断按磁盘修订变化、后缀同名不串台、符号行携带 revision、语言身份统一。
待接：`explore` 结构展开消费带修订的符号范围；Host 视图占用的 UI 呈现。

### 3.9 观察游标

复用 D-076 prepare/commit/abort、单调 revision 和 namespace generation，响应失败可重放，clear 后 pending 不复活。
对象销毁释放游标，用户 UI 独立观察者。持久 tool-entry acknowledgement 按实际送达需求接，不阻塞现有默认增量工具。

### 3.10 线程 UI

rail/overlay/时间线共用session feed/SSE。已有归档/恢复、结果/占用基础保留；D-285以任务命名，增加继续/fresh和阶段成果选择，
定向消息带来源，普通子过程不广播。浏览历史不自动开始新Run或占执行名额，明确执行请求才恢复；未知占用不补零，文案i18n。
归档等待 Run 准备与真实执行退出，失败保留重试所需身份；恢复原 session 时创建并绑定新 Run。已结束或已回收的普通线程打开也先恢复，失败保留原生命周期。
回收持有写者屏障直到删除完成；同线程生命周期互斥，自动回收跳过忙目标；首次准备/恢复按工作区全局占用预留可知新增需求，慢 setup 不持工作区锁（D-204）。
旧结果历史入口按 D-239 接在同一线程卡片，按需加载与显式确认，不新增后台轮询或浏览器持久状态。

### 3.11 结构来源 provider 与 tree-sitter 语法包（D-091）

语言服务器回答"这个名字指什么"，tree-sitter 回答"这段文字的形状是什么"；两者在 Application Host 长期共存，不进 renderer。
消费者：explore 结构切片、命中分类（6.1 fuse 段"名称/路径/注释/字符串/正文不同计分"的落地）、连接边形状识别、冷仓库符号目录与
`imports` 边、线程/压缩用的仓库地图。它给不了类型、跨文件解析与诊断。第 1–5 步已实施（D-093–D-127）。
交付顺序，每步独立可验证：

1. **结构来源接口 + LSP 实现。** 定义带修订绑定的 provider：输入语言 ID（复用 `languageIdForPath`）、正文、修订；输出符号轮廓
   （名字/种类/范围）、命中节点分类、带字面量调用、import，能力标志声明能给哪些。首个实现包装 6.4 agent 视图的 `documentSymbol`；
   explore 切片只认接口，冷/热为显式条件，缺时退行窗口并说明来源状态。无新依赖。验收：切片单位按 D-090 / D-098（容器：小函数全文、大函数签名 +
   命中语法块 + 省略标记 + 完整读取入口；普通值绑定切所属函数/类），`explore.search` 的 worker—protocol—Host 链能在一次结果里看见。
2. **冷启动对照基线。** 在本仓库量一次 agent 视图从冷启动到 `documentSymbol` 可用的时间，记入 status；这是第 3 步"好了多少"的对照，
   不再是"要不要做"的门。
3. **web-tree-sitter + TS/TSX 包作第二 provider，同时接命中分类。** 引入依赖与 `.wasm` 打包路径（Electron/Web 宿主都能读到）；
   语法包 = 语法 wasm + Piarium 查询（定义、带字面量调用、import；从 Aider / nvim-treesitter 的 Apache 2.0 查询改起并注明来源）；
   解析结果按内容哈希缓存，授权与来源仍每次核验；ABI 随应用版本锁定，加载失败按 provider `unavailable` 报告。验收：同一查询在
   语言服务器冷态下由 tree-sitter 给出切片；命中按节点种类分类进入排序；解析受工作预算与取消约束。
4. **连接边查询、冷仓库符号目录、`imports` 边。** ✓ `bridge.request("…")` / `router.register("…")` / `on("…")` 等形状产出确认连接，
   无法确认的同名字符串标关联候选；`searchFilesystemFiles` + Documents 磁盘读把 TS/TSX defines/imports/连接边写进 6.2 现有图，同一
   `documentRevision` 与 generation 绑定，不做基于 LSP 的全仓扫描。生产消费者是 explore 读摘录路径出边（D-104–D-108）。
5. **编程语言支持开箱即用（D-290）。** 常用结构包随发行提供 wasm 和可工作的提取查询，构建校验摘要与查询兼容性；不把只有解析器的安装当作可用结构检索。
   TS/JS、Python、HTML/CSS、JSON、YAML、Shell 的 Node 语言服务器随应用提供，使用现有扩展注册和 Supervisor。
   Rust、Go、C/C++、Markdown 的独立服务器首次实际使用时自动准备到私有目录，优先复用可运行的本机程序；不修改项目依赖、不全局安装工具链。
   固定远端发行版本/摘要，Go 通过官方模块校验；准备可取消、并发去重，只有完整产物才成为安装结果。
   设置页与普通启动不下载、不启动语言进程；编辑器或 agent 请求，以及用户主动准备/重试，才触发对应语言。
   设置按当前工作区展示结构检索与代码分析，分别反映发行可用性和运行状态；包名、ABI、wasm 导入收进技术详情。
   用户自带语法仍走已有存储/ABI校验；失败、未知、缺项目运行环境不能显示为成功。具体语言覆盖与实测证据见 status。

不做：先建"通用 AST 服务"再找消费者；替代语言服务器的导航与诊断；renderer 引入；第一版接受任意第三方语法包；一种语言时做包管理器；
声称解析速度或省时数字（实测记 status）。

### 3.12 符号图读者（explore 路径候选 + `related`）

3.11 第 4 步把 TS/JS 符号和边写进图，但读者只有摘录出边注解（D-108）。`searchSymbols` 没有生产调用方；
`findLinks` 只给 associates 闸门用；`related` 是依赖不存在 API 的 PageRank 空壳。本刀给图真实读者，
并分清图能加什么、不能加什么：

| 图给的 | rg 给不了的 | 是不是新召回 |
| --- | --- | --- |
| 定义优先 | 目录知道 `foo` 在哪儿*定义*、是什么 kind；rg 只知道提到 `foo` 的行 | 否：同一文件 rg 也能命中，图改的是排序与理由 |
| 连线配对 | 同一字面量的 `register` 端和 `request` 端是一根线的两头 | **是**：另一端可能不在 rg 候选里（plan 0.7 的「找不到入口」） |
| 反向 import | 「谁 import 了这个文件」不需要查询词 | 否：问的是拓扑，不是词 |

硬约束：图只选路径，不给行号；物化后必须在当前正文里重新定位符号名/字面量，定位不到就丢掉这个窗口，
不许退化成第 1 行，也不许把图里的行号当真（D-112 已修过的错误类型）。图不可用不得拖垮检索：读路径只用
已经打开的 store，失败/空/未开按来源状态降级，rg 结果照出。目录只覆盖带 `importQuery` 的语言，纯 Python
仓库是 `empty` 不是坏了。图有独立预算，`filesDropped` 跨来源取最大值。不和 `lsp.references` 竞争。
目录只有冷扫描 + Documents mutation 那么新，不另做第二套过期检测。

交付：

1. **退出码（D-103 第 2 项）。** 崩溃隔离用例给已死子进程 stdio 加上 `EPIPE` / `ERR_STREAM_DESTROYED` 处理。
   第 1、3 项（挂钟阈值）本刀不碰。
2. **可查的 store。** 先量再决定要不要内存索引。`searchSymbols` 暴露精确 / 名字含 / 路径含分档。
   反向 import 解析相对 specifier（含 `.js`→`.ts` 孪生）；解析不了可见地报，不猜。
   量要按**热路径上的调用次数**量，不按单次量：反向 import 建解析后的反向索引，写入即整份失效
   （新增一个文件会让别的 specifier 突然解析得了），`catalogStats` 不为了 `languages` 逐文件读 payload（D-139）。
3. **explore 第二候选来源。** 定义候选始终跑（只要 store 开着且目录非空）；连线补全和反向 import 在第一次
   打包之后，用已选中摘录里确认过的字面量/路径。三路进现有 `rankCandidates` RRF，不另起排序。
   取代 D-108 的「不扩候选池」。摘录出边注解仍在。打包 boost 按结构化来源查表，不靠展示文案的前缀；
   图那一趟物化复用主循环的预算与并行度形状，超预算的仍是候选、走 `not-requested`（D-139）。
4. **`related`。** 丢掉 PageRank facade，按路径或名字回答定义 / import / 谁 import 了它 / 连线另一端。
   接进 pi-host（协议 + 工具定义 + 默认注册）。工具描述写明和 `lsp.references` 的分工。
   正文按段设可见上限、`details` 保持完整，不把「装不下什么」交给通用截断器（D-139）。
5. **前置条件：目录得建得起来（D-140）。** 读者再好，目录建不出来就没有可读的东西，而且失败是静默的
   （冷扫描火忘 + `graph: empty`）。枚举一次问 git（`git ls-files -z --cached --others --exclude-standard`），
   不是每目录 spawn 一次 `check-ignore`；派生图写入按安静期去抖 flush，用户数据仍在各自写入里即时 flush；
   测量脚本按 `CATALOG_SCAN_BATCH` 成批并发，量产品真会跑的形状。数字进 status。
   D-236 把同名闸门再访改为 file 行内的修订/代际绑定抽取记录；只更新确认后的关系，不重读源码或重发 symbols。
   未确认候选不建图节点，显式重扫仍核对文件修订；输入语料、结构请求次数、节点数与耗时记入 status。

不做：PageRank、多跳、`references`/`calls` 边、embedding、词法索引、BM25、语法包/设置页、记忆/压缩/线程/权限、
explore 模型增强。不声称检索质量或速度提升；量到的数字进 status，标明是对照数字。

### 3.13 验证已有精确线索，并让验证后的证据决定输出

D-142 观察：8 个成功返回的问题、约 160 个片段，没有一个来自源码——全是 `docs/*.md`、`CHANGELOG.md`、`LICENSE`、`bun.lock`。
图里已经有答案（`findLinks("explore.search")` → `harness-services.ts` 的 `connects register`，D-143 后还有 `explore-tool.ts` 的
`connects request`），explore 没去问。六个核实过的缺陷：词组内按路径字母序当 RRF 名次；原始 `GROUP_WEIGHT` 与 RRF 混加；
`findLinks` 不看 `end.kind`；已在 rg 池的文件被图找到后不进补充物化；`graphBoost` 是文件级；`limit` 凑满即停。

本刀三部分，都不引入 embedding / BM25 / 词法索引 / NLU：

1. **查询入口（D-144）。** 先提取对象，再处理问句。完整技术字面量整体保留；普通问句词是内容词。关系词表写死为注册/连接、
   import、定义。只有对象驱动 `searchDefinitions` / `findLinks`。
2. **候选验证（D-145 / D-146 / D-148）。** 任务匹配分层，路径只作 tie-break。直接线索在既有读预算内优先物化。补充物化看
   是否已读、是否已有当前证据。文件角色按问题决定；测试路径条件式优先。`definitionDropped` 改为去重路径。
3. **证据打包（D-147）。** 理由绑定窗口；`connects` 与 `associates` 分等；核验区分「含有名字」与「在这里定义/注册」。
   `limit` 是上限。因直接线索已验证而跳过的泛词记 `direct-verified`，与读预算 `not-requested` 分开。

观察脚本收紧十问的最小证据要求，每题打印阶段诊断，并对同一入口加五个变体（D-149）。十问足以证明「已知入口现在能被利用」，
不足以证明泛化或普遍性能提升。

验收补第 4 项（D-151）：阶段诊断的所需证据必填，量具不得在未核验时报 `verified`；按读发现的连线字面量与问句对象无关时降到
`support` 档，因为容器切片让注册表窗口含有它注册的全部字面量，「只展开窗口正文里的字面量」在这个形状下不构成约束；守这条的
单测必须跑真解析器的容器切片，并先验证无修复时会红。

第 5 项（D-152）：已读快照按新增证据重算窗口。对象词一趟冻结的窗口不再挡住内容词一趟的命中，连线展开落到已读文件的图线索
也会被定位。复用快照与解析缓存，不消耗新文件读取预算、不重新解析。这条只影响有对象的问句（十问里的 1/4/6/9），无对象的六题
只有一趟、没有冻结可修；两个缺陷各管一半。

**3.14 查询内区分度与片段证据贯通**（已接，D-153–D-156）：

1. **检查点一（已接，D-153）。** 每次调用建一张查询内词组权重表：\(N\) 与 \(df(g)\) 都是本池去重文件数；覆盖三态
   （完整 / 下界 / 无法判断）跟着权重走；完整且稀有才加 \(\ln\frac{N+1}{df+1}\)，截断词不拿未经证明的稀有奖励。
   `details.distinctiveness` 与 `details.windows` 可见。观察脚本区分「正确窗口从未生成」与「生成了但没被选中」，
   并排除自身问题文本。
2. **检查点二（已接，D-154）。** 同 tier 比较加权覆盖 \(L(f)\)；`roleFit` 退到其后作有界偏好。how 问句不因摘录包已满停读。问题 4/6 预期仍不翻转。
3. **检查点三（已接，D-155 / D-156）。** 同一张表进入局部选择与打包；内容词不再拿完整对象档；定位题已有直接答案时
   `offTopic` 不再展开或填正文。多词邻近性仍留到下一次观察。
4. **验收补项（已接，D-157）。** 关系证据相当时生产路径优先必须用**比较**表达：`roleFit` 只作有界偏好时，写着同一个
   `register(...)` 的测试夹具会压过生产注册（问题 1 首条一度是夹具），因为夹具总能在加权覆盖上赢。观察字段不得进生产
   载荷——`details.windows` 改为 `traceWindows` 按需开启。量具补第三态：大单元正文按签名 + 命中块组装，所需证据可以落在
   已选中单元的 `omitted` 区间里，那既不是「未生成」也不是「未选中」。

**后续工作的观察依据**：命中驱动的正文组装曾省略没有查询词的机制行（问题 5 的 `links.push`）。D-165 已增加 focusRanges
接口；当前单元的相关性与最终原文一致性由 3.15B 收口，继续调整词法权重不能代替这项工作。

### 3.15 快速查询：语义决策、召回与呈现（D-173–D-175）

旧编号 ①图到达理由、②共享文件角色、④focusRanges/三字段接口已由 D-163–D-165 接入；下面 A–D 是其上的剩余工作。
请求保存 question/anchors/paths 与可确认的显式要求，规则核验具体事实，取消建设通用 `AnswerRequest` 充分性解释器。
算法与向量消费者继续收敛，同时由 D 接入 LLM 的局部语义判断；两类工作共用请求/当前单元契约，不等待扩散模型或新的索引表示。

**共同查询上下文。** 随第一条真实模型链路接入短生命周期 Host 查询状态，保存 actor/范围、原问题、开始时输入来源、已读快照、
生产任务、候选视图、预算与结束状态。pi-host 使用当前模型绑定执行并提交计划/选择；内部阶段可追加表达、取候选视图及结束/取消，
公开仍为一次 explore，不建持久会话或通用框架。阶段 RPC 沿用查询来源而非重新读取 getInputContext，保留写入终结旧草稿规则；
取消从工具/bridge 传到 Host 查询与模型，公开工具调用结束或所属 worker 关闭时清理，单个阶段 RPC 返回不清理整次查询。
共享后台索引不受影响。所有阶段共用本轮截止条件，旧响应
不能更新已结束查询。候选视图/选择携同一查询身份与修订，复用既有 actor/路径授权。这是 A–D 的执行边界，不独立排成大型前置工程。

D-189 已收口后端作用域：显式 paths 先取 Router 已授权的 workspace-relative 身份，查询 start 固定的 effective roots 再贯穿图符号与语义向量召回；图在评分/截断前过滤，reverse importer 在每 seed
截断前过滤，语义用 scope 内 block anchors 做精确 Top-K。`.` 或空 roots 继续走未受限语义快路径，作用域 block 身份首次惰性建立、文档发布/删除增量维护。

**A. 明确导航与开放候选各归其位。** 明确要求的路径/定义/连接关系直接读取并核实；普通名字出现或关联边不等同于精确导航。
开放候选取消来源 tier，采用去重后的真实来源排名融合，沿用 RRF 的现有 k。来源内同分并列，多块/多变体不重复投票，路径
只作稳定输出顺序。没有相关性排名的图路径不伪造词法/语义票；图提供明确目标时走导航，其余关联保留为探索线索。
验证纯语义第一候选能跨过弱 import 线索、多个同源块不增票、用户明确导航仍能直接取得目标。改动落在候选与读取入口，
不以扩大读预算替代排序修复。

**B. 当前单元选择与一次呈现一起交付。** 为 D 的 LLM 判断或 3.16E 的重排提供最终挑选/排版前的当前单元/视图；模型输入预算
独立于主 agent 的可见输出预算，先去重正文与视图，再按实际模型容量提交竞争候选，未提交者记为未评估。模型未参与时复用 A
的来源归并，但只用当前单元上的词法/语义依据；文件得分不广播给每个窗口，旧正文实质变化后不沿用旧相似度。保留无查询词
的语义 focus，以及同文件不同机制。LLM 输入提供视图/范围 ID，输出可组成互补材料并指定必需范围；Host 验证模型实际看过的
来源与范围，不能据此声称语义正确。原文与展开选项、材料组、去重及真实 UTF-8 预算共同决定呈现。必须保留选择依据，装不下
则改用仍含必需范围的视图、放弃材料组或报告缺口，formatter 不再事后裁掉依据；不预设固定机制模板。
删除 `windowScore` 拼盘：显式范围归请求，局部核验归事实，重复归去重，字节归呈现，不另造同样的加分器或等待 reranker。
最终呈现记录驱动正文、省略提示和观察工具；验证零词汇重合的机制正文可见、同文件互补范围保留、截掉的片段不算已交付。

**C. 来源完成即可推进读取。** 区分评分来源家族与候选生产任务：原问题检索、已启动的查询计划及后续搜索、明确导航各按真实
任务状态登记，多个改写不增加保留额。在既有读取预算与常规批次内给在飞主要任务保留首批机会，其余按当前排名先读；空、失败、
取消、截止或返回已有正文时释放，复用新增 focus，不为公平补读弱文件。后到来源更新待执行队列，不为每路保证输出名额。
首批机会处理/结束后冻结候选视图批量判断；本轮预算也可提前收口等待，给判断与呈现留出执行时间并报告未完成项，不能变成新
的必须等齐屏障。模型在飞时的新增材料仍为未评估，需要时增量比较，不每批到达各调一次模型。明确导航取得原文即可返回；
开放问题按来源结局、读取/补查进展与本轮截止条件结束，不把词法命中、limit 满或模型说“够了”当全仓充分性证明。用可控
慢来源验证早期读取、机会释放、候选视图、取消及结果冻结；不新增固定秒数、文件配额或循环上限。

**D. LLM 搜索计划、成组选段与局部补查（D-174–D-189，已交付）。** 消费已有 models.explore 槽位，在 pi-host 中复用当前会话的
ModelRuntime、provider/凭据及取消路径，接入真实 explore 工具执行，不新建长期会话、Thread 或另一套模型设置。
查询理解输入原问题、锚点/范围和已有仓库词汇，输出行为目标、概念分组表达及预期材料；模型对行为与所需材料的理解仍为推断。
Host 实际执行新表达；
组内扩展、跨组支持可以影响词法源内名次，不强制 AND，不丢单组强线索，不改原问题/范围或原词区分度计数。原问题词法、
可用语义和明确导航与模型并行，不等模型完成才启动原始搜索。已有目录/入口和已返回锚点正文提供词汇，不等待全仓摘要。

候选判断输入 B 的当前正文、视图/范围 ID，与原问题、曾尝试的假设分开呈现；允许否定查询阶段猜测，不积累一段自我强化的
推理历史。输出选中的材料组、必需/辅助范围、互补用途与缺口，不要求全池数值评分或最终分析。Host 验证来源和实际可见范围，
提取原文；无查询词的机制仍可被选中。首版提供可选局部补查阶段：缺口须指向已读候选/范围，表达保持原问题与范围，批量去重
执行；明确短定义直接补充，需要语义比较时只处理已选与新增材料。阶段不是永久一次硬上限，无新材料、预算用尽或需要开放
调查时返回限定于已读材料的缺口；不重跑完整候选池或内部自主研究。

两处按实际需要调用：纯导航省掉不必要步骤；已知文件但问机制时先读再判断，不能因有锚点就省略语义；开放自然语言入口未知时
直接使用查询计划，没有当前正文不对空候选调用判断。LLM 与专用 reranker 共享正文输入但不伪造相同输出契约，同批不默认串跑。
真实槽位已配置就按此路径使用，未配置/失败时保留算法和向量结果并说明模型未参与；不回退主模型，不等独立评测或后训练。
验证真实 Pi 工具→模型请求→分组表达执行→当前材料组选择/补查→必需原文呈现，以及未展示的正确候选不会被旧打包器提前
丢弃、非法 ID/范围、阶段间来源变化、取消和失败。工具描述与示例同步更新。真实问题看首轮关键原文、后续定位往返和整体
等待；按需要观察局部阶段贡献，不跑固定全组合，不把单次生成速度当查询延迟，也不另建大型评测框架。

A–D 已由 D-176–D-189 接入同一引擎与公开工具。不把 3.16 的索引/远程优化做成模型启用前置，也不依赖 3.16B 的后台远程绑定。
保留既有来源、路径、修订与 OutputStore 正确性测试。十问用于回归，必要时加入真实新问题；不先建设完整评测项目，
也不从后续 read/edit 自动学权重。真实 `models.explore` 效果见 status，本计划不把它写成已观察。

### 3.16 嵌入后端、索引与覆盖层（D-173）

本地索引身份/代际库/部分可查已有 D-166–D-169，召回接线与真实本地运行已有 D-170–D-172。下面区分已有工作收口与新的
生产接线；配置、向量缓存、前台优先、重排及 overlay 均不能由 helper 或 UI 字段推定完成。

**A. 收口现有性能与发行修复。** 已提交：`37b12e8e`、`8752e039`（真实批推理、切块尺寸查找、存储增量计数/批事务与中断恢复、
模型配方固定修订、构建准备和 Electron 实际加载 smoke）。完整冷扫时间仍未量得，不能把部分语料或中断扫描外推成全仓性能。

**B. 已接线（D-190 / D-194–D-195，默认发行方式由 D-288 更新）。** 调用边界：Settings `harness.embedding` → Host `settings.get` 与 Pi binding describe（无密钥）→ 确认未配置且用户已安装本地组件才走 MiniLM；
配置后 `createRemoteEmbedder` → workspace `harness.embed` → Pi `BackgroundInferenceRuntime`（workspace worker 的
隔离的 user/operator 配置 ModelRuntime / 用户 `auth.json`）→ OpenAI 兼容 `POST {baseUrl}/embeddings`。Host 提交已授权正文、用途、批次和绑定。空间身份
由 protocol/provider/model/maxTokens、去凭据 endpoint/API 配置身份和最终实际维度命名；自动维度由首个真实输入解析，不持久化 `auto` 空间。知识库召回在 2.8 / D-196
复用同一 `harness.embed` 绑定，向量写独立代际目录，不改权威 `.tdb`。

**C. 已接线（D-191）。** 复用键为 space + purpose + 实际 embedText；查询缓存不绕过 D-189。调度器一次一批，当前批结束后
前台优先于下一批后台。冷扫等本轮第一个兼容发布后再查 partial。远程不套用 MiniLM 512；超长单行续切。Node ORT
`intraOpNumThreads` 写到真实 session。`publishToken`、扫描结束对账、checkpoint 恢复。向量缓存按字节软预算淘汰，不拒绝查询。

**D. 已接线（D-192 / D-194–D-195）。** `pinSemanticQueryView` 固定发起窗口的草稿；对应路径立即遮蔽磁盘向量。
缺向量报告具体 gap，不读旧磁盘、不把缺向量写成缺正文。已捕获草稿的向量建设由 workspace runtime 在后台完成，结束查询不反复取消建设。
活跃隔离线程查询自身物化目录的 Documents workspace，父分支的后续变化不会进入。增量写入和冷扫使用相同的文件筛选，`copyIgnored` 不自动扩大语义语料。仍走 scoped Top-K。

**E. 已接线（D-193）。** 调用边界：`explore.query.finish` 在 select 为 `skipped`/`unconfigured` 且 `harness.rerank` 有效时
→ Host `harness.rerank` → `POST {baseUrl}{endpoint||/rerank}`。select 已 used/failed/cancelled 则不调用。失败保留来源排名，
details 标明 rerank 状态。输入是 3.15B 当前 view；没有 provider tokenizer 时按字符长度估算，超预算 view 不参与评分；该估算不保证满足远程 tokenizer 的限制。

**身份与当前性纠正（D-194）。** Host 装配改为 workspace-keyed，Pi provider 权威限于 user/operator 层，内部 inference 方法从
公开 Runtime surface 移除并增加显式 batch cancel。远程空间在实际维度解析后才稳定命名，并包含去凭据 endpoint/API 配置身份；
设置变化启动新空间扫描。扫描核对当前 revision 后才解除旧行 mask，读失败保持 gap/incomplete。活跃 isolated child 直接查询自身
Documents workspace。rerank 超预算 view 不截断冒充原 ID，finish 冻结配置且终态无二次 HTTP。

**生产装配与原生写入（D-235）。** Application Host 与公开工具纵切共用 `WorkspaceSemanticRuntime`，统一 Settings/describe、
workspace 推理传输、固定查询视图、配置订阅和关闭。成功的 Pi 原生 journal after 在工具答复前通知执行工作区语义索引；后台
重建不等待本回合 settle。验证覆盖真实 SessionHost 的 embedding/rerank HTTP 适配与 Documents，具体证据范围记入 status。

**本地组件发行（D-288）。** 主包和普通构建不准备模型或专用推理运行库。设置中由用户主动下载或导入独立平台组件，验证完整性与真实推理后启用；安装失败/取消不替换已有完整组件。未安装不发起本地扫描、下载或原生模块加载。基础安装的启动/词法/结构检索与可选组件的安装/推理分别验证，发行流水线发布独立组件资产，不把可选能力变成基础安装等待。

工作区仍是包含陌生文件的范围，注意力只改变建设顺序。真实 provider 延迟、质量、成本和完整冷扫时间未观察。扩散模型/
后训练、全仓生成式摘要与零样本路由仍留后续。知识库语义召回已按 2.8 / D-196 单独接线，不与代码语义 MiniLM 回退混写。

### 3.17 bash 输出压缩：按命令分派（D-160 / D-197 / D-199）

已接线前四类：vitest、tsc、eslint、git。Host 在 `shell.exec` 与增量 `shell.read` 上整理默认 `display`，原文仍进
OutputStore / 后台 buffer；显式分页读原始字节。`tool_result` 只对实际取得 Host 整理结果的默认展示免于再次头尾切；旧 Host 未整理结果保留通用截断。
解析器只收起明确的成功/重复噪声，未知正文、pretty 诊断、失败位置、分片续文与提示保留。混合输出不能可靠归属时用通用展示；超预算保留可读首尾与省略事实，不能只剩提示。
包管理器通配已接（D-241 / D-247 返工）：`npm`/`pnpm`/`yarn`/`bun` 头归类、脚本回显识别内层工具、exec/dlx/x 未知二进制走 generic、唯一 warning 保留、failure-relevant 噪声不折叠、非零退出时失败解释行进 required。其余两层
（声明式规则、附加模型总结）未做。**不用小模型总结替代**（漏一个失败是静默的）；模型总结只作非结构化输出上的附加，
且要明确标注"这是模型挑的行，不是全部"。

### 3.18 任务线程、定向协作与连续交付（D-285 / D-286 / D-287；3.18A–E 已实施并验收收口）

在D-284的Pi请求/历史接缝上推进，沿现有Thread/Run、WorkingState、Integration与broker完成，不新建永久团队、消息审查模型
或通用DAG产品。主线亲自负责全局设计和关键实现/验收；派发能独立推进的工作或不同解法，成本判断不变成派发前填表。

#### 3.18A 普通派发、预设与Run配置（已实施）

- 同步protocol、pi-host工具、Host服务与UI：dispatch以task为核心，preset可选；普通线程明确使用发起者当前模型和获准的
  普通能力。专用预设沿现有槽位或明示inherit，不配置不冒充可用；去掉固定便宜/强模型标签与按角色强制shared的绑定。
- 写入任务默认独立WorkingState，shared显式选择。上下文、工作状态和执行配置分别表达；冻结实际model/tools/permissions/
  scope/config generation到Run，Thread仅投影最新配置。只读转实现可在同Thread新Run进行，必须由Host授予实际能力。
- 保持已有嵌套授权、固定基线、级联删除与结果引用；更新Thread manifest旧消费者、恢复/出队/归档路径，不能只让工具role可选。

验收普通零配置派发、显式预设/未配预设、同Thread更换执行配置和权限继承；普通任务获得真实结果，不靠schema解析通过宣称接线。

#### 3.18B 输入起点、继续与fresh（已实施）

- 新线程task默认，inherit显式：固定派发时当前实际输入（已提交摘要+保留原文），把子任务加到尾部；queued不能后读父未来
  状态，未完成派发/其他工具不冒充已执行。依据Pi消息配对接缝构造，输出引用按新会话实际权限/存储重绑或复制合法正文。
- settled实现线程收到明确执行请求时新建Run并恢复选定结果/工作现场，不只放开send状态检查；活跃线程的信息投递不新建Run。
  同一相关工作continue，旧背景大半过期fresh，无关任务新Thread。用户/派发者选择，模型可提出重建，不按TTL/轮数强制清空。
- fresh消费2.6A的输入构造：当前任务/约束/规则、选定成果、未解决问题、活动动作与历史入口；保留已有工作delta/结果/转录，
  不重新总结全部旧历史，不要求额外模型调用。新的背景与执行配置就绪才切换，失败/取消不丢原现场和待处理消息。
- UI“查看历史”只观察，“继续工作/重建上下文后继续”才执行；重开Pi会话与创建实际Run分开，避免浏览完成结果也占名额。

验收任务A刚交付接着修改、同一工作在项目规则/代码变更后fresh、另一任务新建三个场景；确认旧原文可读、当前规则生效、
工作成果不被fresh重置。inherit证据必须来自真实子SessionHost的实际请求，不能只看parentSession元数据或prompt字符串。

#### 3.18C 定向消息与共享执行准入（已实施）

- send支持授权的父子与相关兄弟；from由Host actor生成，目标范围从实际根任务关系解析，不能因同工作区就跨根会话发送。
  inform只投递，request安排执行，replyTo绑定实际请求并完成等待；通知不自动赋予控制/读取对方全部历史的能力。
- 复用既有会话/消息记录接受和送达，待收信息到正常输入边界成批追加。相同消息重试不多起Run；关闭、失联、归档、删除
  都有实际结果。普通确认/致谢无待处理依赖则不唤醒，不靠文字正则或另一个模型决定要不要执行。
- 同根嵌套共享用户配置的委派执行名额，默认12可调。等待依赖的父让出名额，子可运行；答复/结果到达后重新准入。派发、
  dequeue、lost恢复、续做与显式自动review共用准入，不按每个父重新获得一池，不在startRun侧绕过检查。
- wait只为实际依赖/需处理变化恢复，不让每个UI活动触发模型进度检查。执行名额释放不代表会话、后台进程或文件writer释放；
  保留现有物化回收与真实退出边界，不新增内存/目录硬上限。

验收UI线程问Host线程并收到对应答复、inform不启动模型、request续做、跨根目标拒绝、重复交付不重复执行；用小并发预算
证明父等待时子可准入、唤醒后重排、嵌套不乘法扩张。测试等真实事件，避免固定sleep或循环让模型报状态。

#### 3.18D 阶段结果与依赖代码更新（已实施）

- 沿现有Run settle发布R1，父按修订使用，原Thread继续R2；R2运行/失败时R1仍可明确读取/集成。实际代码、材料表、报告
  直接交付，说明服务于使用，不统一塞进极小摘要，不靠主线重新生成成果。
- 新派发依赖任务从选定父状态建立基线；已启动线程提供显式纳入父修订的入口，复用三方Integration与受控物化切换，保留子
  delta与冲突。记录新基线/输入来源，旧结果/验证仍绑定原修订；普通消息和fresh不能替代该文件更新。
- 主线收到影响公共接口/任务方向的决定与产物引用，不读取全部横向对话。普通发现提前发消息，可使用文件则必须发布。

验收同一公共接口R1被主线使用、依赖线程真实获得新字节、原线程继续发布R2；父/子各有修改时条件集成不覆盖；newRun不把
旧验证复制成当前通过。保留现有Rust存储/文件权威，不造任意线程双向同步系统。

#### 3.18E 默认、UI与旧路径收口（已实施）

- 自动review默认关闭，已有显式enabled/gate保留；主动review与现有结果/Run绑定不变。删除每次交付自动追加检查的提示，
  保留主线关键验收和实施者正常验证，不把check强制变成纯跑命令代理。
- UI按任务名/真实成果显示，提供continue/fresh、结果修订、定向问题与来源；原文、状态和费用继续来自既有权威，不做虚构
  进度或财务面板。总效果评价包括实际子调用，不只比较主线token。
- 删除role-required/单向send/永久Thread执行manifest/per-parent准入等被替换路径与重复夹具，按当前内部格式直接切换；
  用户配置、原生Pi历史和工作成果照常保全，不保留双实现兼容层。

最终沿公开生产链走通“普通派发 → 合适背景 → 定向解决依赖 → 交付可用成果 → 主线使用 → 原线程continue/fresh → 再交付”，
并观察独立并行路线能被选择/停止。已有共享场景合并验证，不按本节每句话各建一个test，不要求固定审查轮数或新评测平台。

## 阶段 3b：原生权限唯一权威（D-283，已完成）

当前交付事实：Piarium 内置 `tool_call` extension 是唯一交互式确认权威，覆盖 Harness、Pi 内置、MCP、Pi package 与嵌套线程工具。
`normal` / `accept-edits` / `bypass` / `smart`、用户规则、workspace 只收紧和 `permissionJudge` 都作用于这条唯一链；Host 继续只做
非交互 actor/capability/workspace/path enforcement。D-283 完成了以下纵切：

1. pi-host 内置 `tool_call` extension 成为 Piarium 会话唯一的用户确认权威。它在会话构造时取得所有实际工具的稳定身份与来源，覆盖
   Harness、Pi 内置、MCP、Pi 包工具和嵌套线程允许集；不能再以“非 Harness 工具”直接放行。Host 继续只验证 broker actor、冻结
   capability、workspace/path scope 与资源 authority，不弹第二次确认，也不替 worker 内执行的工具假装做交互门。
2. 工具装配生成规范化的权限对象：工具来源、动作类别、实际 cwd、命令、规范路径集合、网络目标和子线程范围。Harness/Pi 内置工具
   使用项目维护的明确描述；MCP annotations 与第三方声明只作为输入证据，不能自行授予权限。缺少副作用描述的第三方工具按未知动作
   询问，不能默认当只读。
3. 命令与路径判断覆盖实际选择的 shell、命令组合、重定向和子进程入口；路径在确认前相对真实 execution cwd 解析，并核对规范路径、
   符号链接/reparse 与工作区外目标。不能只靠当前关键字 regex 判断 `rm`、`git` 或敏感文件，也不能用提示词代替解析和 Host path
   authority。
4. 保留现有四种模式与从上到下的用户规则；workspace 仍只能追加 ask/deny、不能放宽用户策略。Smart 只在用户配置
   `permissionJudge` 后参与普通 ask，高影响或证据不完整的动作仍走确定性策略；模型失败回到 ask，不借主模型。
5. “本会话允许”绑定工具来源、动作类别、owning/execution workspace 与明确资源范围，UI 显示将被记住的范围；不能再只按 tool name
   放行整个 `bash` 或未知工具。嵌套线程继承创建时冻结的 overlay，只能收紧；父会话之后切到 bypass 不放宽已运行子线程。
6. 每次 allow/deny/ask、规则来源、规范化目标、用户选择和 policy generation 进入现有 session/Thread 事件与审计投影；敏感正文和凭据
   不进入日志。不新建另一套 permission 数据库或把审计写进模型上下文。
7. 单一 Piarium 权限 UI 负责确认卡片、会话授权撤销、模式与规则。完成覆盖后，从 foundational manifest 删除
   `@gotgenes/pi-permission-system`，并删除 session service 让位、permission-system Plugin Settings/quick mode/status bridge、专属 i18n 与
   测试路径；不保留默认关闭、旧配置 reader 或双重提示兼容层。

实现使用 Pi `getAllTools().sourceInfo` 识别实际来源，SDK Harness override 才按 Harness 元数据分类；MCP/package/未知工具缺副作用证据时
进入 unknown/ask，不能借同名 `read` 等默认规则放行。路径证据经 Host `permission.inspect` 复用既有规范路径 authority；shell 解析保持
保守，组合/子 shell 等无法完整归一时标 evidence incomplete，因此不能走 Smart 或 session grant。会话 grant 绑定来源、动作、owning /
execution workspace、cwd、规范资源、网络目标和 thread scope，`/piarium-permissions` 可撤销。每次决定经 `permission.audit` 投影，不含正文/
凭据。foundational manifest 已升 revision 3 且只保留 MCP；permission-system 的 service 让位、状态桥、Plugin Settings、Composer quick mode、
专属 i18n 与测试路径已物理删除。公开反例与跨包类型/lint 证据见 status 3b.1–3b.3。

## 阶段 R：Rust 系统内核与 Host 分层（D-252）

目标架构、资源归属和失败语义见 [rust-kernel-design.md](rust-kernel-design.md)。D-282 已在 R0–R5 各自接管后完成 R6 汇总验收，
因此阶段 R 整体完成。模块迁移后的生产默认只有新写者；TS 保留产品编排、Pi runtime、Document Registry、知识领域和模型/索引装饰层。

| 里程碑 | 交付范围 | 必须接通的消费者与删除的旧路径 |
| --- | --- | --- |
| R0 | **Complete（D-282）**：framed kernel、同源 DTO、epoch/grant、acknowledgement-backed request window、取消/断线/关闭与 release identity | 真实 Host/release binary 覆盖饱和、queued cancel、截断输入、任意 cwd、relocated restart 与 manifest mismatch；Web/Electron/云/VS Code 都从自己的发行目录启动同一 kernel。支持平台的 native build/smoke 是 release workflow gate；本机证据只声明 Windows x64 |
| R1 | **Complete**：format v10（D-280 增 process records）、typed path state、AVL immutable root/trie、revision pin、recordRevision CAS、blob/source authority、workspace/actor-scoped identity、分页 root read、typed recovery 与 GC | Application Host 的 WorkingState、result/draft/verification/review/retrieval/history/materialize/delete 和 combined Recovery/Integration/agent-mutation 元数据均走 Rust root/path/domain/recovery API；TS 不再有生产 compatibility projection 或 SQLite recovery writer。旧实现仅保留为测试 helper。内置 Recovery 固定共用 kernel application-data root，`storageManagement:false`；可替换 provider 的位置管理仍是公开 v5 可选能力。落盘顺序、事务故障注入与重启对账构成 R1 durability evidence |
| R2 | **Complete**：单一 Rust file authority + Host-visible pending-operation disposition | Registry 保持 buffer authority；low-level operationId/path/reason/disposition 可列举并可安全 reconcile，证据不足保留 needs-attention；不恢复 TS writer |
| R3 | **Complete**：fixed baseline + kernel materialization + durable Host/Git/Registry handoff | native operationId/root/writeRevision、persistent handoff pin、Git executionBaseline、Registry/binding 使用同一可重入 intent/receipt；setup timeout/abort 等真实 child close 后才结束；旧 seam 仍仅为测试夹具 |
| R4 | **Complete（D-280）**：统一 Rust PTY/pipe、process tree/raw output/writer authority | 用户终端、Harness shell、Thread setup、LSP/DAP、任务/测试均经实际 native backend；未确认退出/失联保留 writer，控制不依赖输出排空；Host 保留协议与启动取消编排。Pi broker 仍拥有 Pi worker；Git 短命令和 shell 发现留作领域适配，不另建通用进程 authority |
| R5 | **Complete（D-281）**：固定 pin/live revision-bound 文件检索、遍历/哈希、native tree-sitter 结构解析/切块，前后台 lane + 实际取消 | read/grep/find/ls/explore、file find、语言/符号/语义目录建设均复用 kernel compute；virtual WorkingBranch semantic 直接在 pin 上 `unitsFixed`，不跨 Host 搬整分支正文。旧 TS ripgrep/recursive scan、branch corpus/body mirror、Host AST/chunker discovery 已退出生产链；Registry draft、TriviumDB/vector/embedder/Pi/LSP 仍按原领域权威 |
| R6 | **Complete（D-282）**：完整生产/故障验收、受控结构与资源测量、发行更新、遗留实现清理 | Desktop/Web/云/VS Code 的实际 release layout 均带 manifest-verified kernel；Windows unpacked 与 cross-domain surface 纵切已跑。旧 PTY/SQLite authority 发行依赖、TS file writer 和 emitted legacy/test artifacts 已退出生产；当前文档指向唯一实现 |

### R0. 契约、运行时与发行基础

盘点目标模块的入口/写者/持久对象/后台任务，以设计职责表落实模块边界；复用已经存在的公开协议和错误语义。
Rust 内核通过私有进程管道连接一个 Host，生成跨语言 DTO/schema，不复制 Pi provider/凭据栈。控制与数据流分开，
批量范围/内容引用避免整树往返。actor grant、workspace/execution/storage identity、kernel epoch、request/operationId、
取消/事件/回执均在第一版协议内形成可执行契约；不靠后续补一层“安全包装”。

真实 Host 装配需验证启动、协议不匹配、损坏帧、背压、取消、关闭和内核退出后的状态。Windows/macOS/Linux 的仓库发行
target 从此步开始构建，不把二进制打包、Node/Electron 协同和许可证检查留到最后才发现。R0 只标运行时基础完成，
尚未迁移的功能保持原生产所有者。

D-282 完成本节。握手发布 `requestWindow`，Host credit 只在 Rust 响应/断线时释放；blob chunk、branch builder 和普通请求共用
acknowledged request window，cancel 控制帧可在数据背压时到达。重复 request id、超窗发送、坏帧和截断输入结束本 epoch，关闭先等
已准入工作，再发 shutdown 或关闭 stdin，不把未确认工作报成功。真实 release smoke 从任意 cwd 启动，核对 build/target/arch/hash，
复制到另一安装目录后用新 epoch 重开同一 v10 catalog；坏 manifest 明确拒绝。Web、Electron、云和 VS Code 分别携带自己的 kernel+
manifest，支持平台由 native runner 构建，不需要客户端安装 Rust。

### R1. 工作状态与恢复存储接管

沿现有 SQLite + 内容对象库建立原生存储。WorkingState 根/修订、结果/草稿、节点、对象所有者和 recovery operation/checkpoint
在同一存储事务域发布。不可变根成为真实内存/持久入口，单路径写直接更新受影响索引页；宽目录不整表复制。
树哈希保留完整 mode 等声明字段，与平台磁盘比较分开；损坏/缺节点/循环明确失败。对象先耐久，事务再发布引用，
pin/GC/并发发布保证可达正文；不每次更新重写整个 JSON/node pool 或扫描全部历史。

Rust 接管同一 storage location 的所有元数据 writer，TS storage adapter 只调用领域操作。在活动写者退出后切换代码，
直接初始化唯一的新内部格式、重建夹具和派生数据；不导入旧 WorkingState/catalog/恢复元数据，不实现旧格式转换阶段机。
需要保全的实际工作成果先作具体交接；跨 Thread catalog 的正常发布/释放仍有持久意图与幂等确认。
尚未迁移的文件编排通过新 storage adapter 工作，不直接连 SQLite；分支写 gate/CAS 随分支权威一起迁移。

验证真实 Host client→Rust→重开后的分支读写、跨分支 sharing、mode/字节身份、固定查询、CAS 冲突、pin 与 GC 并发、
新格式发布关键窗口故障，以及旧实现/数据移除后从新库启动。复用本轮反例；节点数/读写字节从生产调用计量，不能仅测一个 trie helper。

本轮 D-274 完成了 D-273 要求的生产切换：catalog/握手格式统一为 v9；WorkingState 所有生产 consumer 使用 root/path/domain API；branch metadata、draft/result/verification/review 与引用释放由 Rust 事务绑定；combined Recovery/Integration/agent-mutation 的唯一耐久元数据 writer 是 Rust typed recovery，所有 phase/terminal 调用被等待，文件或 Registry 副作用发生在对应 CAS 之后。旧 WorkingState 与 SQLite recovery engine 只保留为测试 helper。D-275 进一步收口 storage location：内置 Recovery 与 WorkingState 共用 kernel application-data root，不支持独立 relocation，UI 按 `storageManagement` capability gating；replacement provider 的公开 v5 storage management 保持可选。R1 的 durability gate 以落盘顺序、故障注入和 restart reconciliation 为准，跨平台 package smoke 归 R0/发行 CI，签名不是当前产品硬要求，物理断电 campaign 留作发行 QA。R1 因此完成，R2–R6 不变。

D-266 已把 Rust crate 的进程入口、transport 与存储领域实现分开，并用一个授权 dispatch 限制 runtime 可见面；它不改变
R1 数据格式或消费者状态。后续 R1/R2 直接进入对应 `storage/recovery.rs`、`storage/branches.rs` 和新的文件资源模块，不能再把
领域实现堆回 `main.rs` 或在各模块自行打开 SQLite。

### R2. 文件权威、Documents 与恢复事务

迁移 canonical 文件资源、路径 gate、磁盘 before/after、三方计划/应用/条件补偿及启动对账。
完整接入 Documents 保存、Files CRUD、原生工具 mutation、Integration、恢复 provider 和内部文件消费者；
尚未迁移的 Git/进程 adapter 向相同资源服务登记写者，不保留另一个决定“可写/可回收”的 TS gate。

surface 权威留在 Registry，Rust 维护混合操作的 operationId/intent/回执阶段，Host 定向执行 Registry CAS/grouped undo。
等待外部回执不持数据库事务或形成反向锁等待；断线/迟到不得伪报完成，surface 无正文不能改写磁盘。
恢复仍是受影响路径变更集，不把 Rust 捕获能力用于普通回合全仓快照。

验证公开 Pi edit/write/apply_patch 与真实 Documents/Registry，磁盘/草稿混合、编码/BOM/换行、用户后写、
缺回执/取消/进程重启、嵌套 branch/directory merge 和恢复导航；实际 Rust 子进程必须参与。

D-276 已完成本阶段生产接管：kernel `fileResources` 注册 Documents-authorized canonical execution root，负责 exact/subtree lease、稳定 file state capture、内容对象安装、条件 apply、mkdir/remove/rename 以及 side-effect 后 terminal 丢失的 restart reconciliation。Documents write/move/delete、workspace-scoped Files CRUD、Recovery/Integration disk apply/compensation 和生产 `fs.lock` 使用该同一权威；Registry 仍拥有未保存正文和 grouped undo，Host 只在 kernel intent/file phase 已持久化后定向执行 surface 操作，等待 Registry 回执期间不持 SQLite transaction。

Piarium 模式的 Pi `write` / `edit` / `apply_patch` 先走 virtual `document.branchWrite`，disk/surface target 统一由 `document.surfaceWrite` 进入 Host Documents；Host mutation backend 不可用时明确失败，不再退回 pi-host 本地 `writeFile/rm`。WorkspaceAPI/Git/bulk/external adapter 尚未迁移其领域实现，但在执行时向同一 kernel exact/subtree gate 登记 writer；这满足 R2 的 single-gate 要求。D-278 曾因 low-level pending operation 处置缺口重新打开 R2；D-279 通过 `file.operation.list/reconcile` 与真实 restart audit 关闭该 gate。R4–R6 不变。

### R3. 基线、物化与资源生命周期

Git 与非 Git/unborn 共用固定根、受管目录及执行世代；保留 dispatch 时捕获、草稿优先与 frozen captureScopes。
Git 的 base/result 属性、执行 baseline、LFS/filter/EOL 和真实 index mode 各有身份，不静默吞过滤器错误。
虚拟→物化的 staging/切换/重启、shell 写回发布、原路径重建、普通复制/真实 CoW 与空间事实全部迁到同一内核。

Thread/Run 与级联产品策略继续归 Registry，Rust 提供可重试资源操作；会话/知识清理由各领域 adapter 确认。
archive 保留引用；history release/delete 先核依赖和真实写者，再释放根和清理目录，返回阶段化结果。
旧目录、未知进程、未收集内容不得因换格式而获得删除许可。

验收 Git/非 Git/无 HEAD、queued/nested/virtual+shell 两阶段编辑、固定结果后 live 变动、filter 配置、
共享引用删除、回收恢复、目录占用和 ENOSPC/中断。实际 clone 与普通 copy 分别报告；未测文件系统不能称已证明 CoW。

D-277 已接入本阶段主要原语和生产消费者；D-278 重新打开整体完成度，具体缺口见 [审查记录](rust-kernel-audit.md)：WorkingState baseline 的 filesystem inventory/body capture 改由 kernel `file.scan` / `file.capture` 完成，且使用 Host-admitted root 与创建 branch 的同一 scoped grant；Git 继续提供 staged/unstaged/untracked、index mode、dirty-content identity 和真实 filter/EOL 语义。完整 capture 后重读同一路径集合，Git/目录 inventory 与 frozen captureScopes 也在窗口两端核对，变化时不发布混合 root。

virtual→materialized 使用 kernel `file.materialize` 从固定 root 构建 operation-specific staging，校验对象后执行真实 clone backend 或正式 copy fallback，以 backup/promotion + restart reconciliation 切换 execution generation。Git 只附加 linked-worktree metadata，并经 `read-tree`、`add -A`、内部 baseline commit 建立执行 Git 身份；required filter 失败直接中止，不把 TS copy 当退路。materialized settle 由 Git changed paths + prior/current captureScopes 或非 Git完整 Rust inventory 发布 immutable result root；native archive/history 不再依赖旁路 snapshot。reclaim/discard/delete 走 kernel subtree remove 并 prune linked-worktree metadata；`file.measure` 在 Unix 使用实际 block 计数，Windows 未有已验证 physical-allocation backend 时明确返回 unknown。Windows release-kernel 的 scan/measure/materialize 与 live-backup-before-promote restart 反例已通过；Windows 当前只证明普通 copy，未测文件系统不称已证明 CoW。D-278 当时据此只承认原语和部分消费者证据，并要求补跨域持久 switch、真实退出/回收交接。D-279 已补齐该 gate：Thread Registry 先持久化固定 root/revision/writeRevision、operationId 与 pinId，kernel persistent pin 保活固定源；materialize 和 Git attach 各持久 receipt，同一 operationId 重入；git-attached receipt 在 pin release 成功前不会清除，setup timeout/abort 等 child close。R3 因而完成；R0 与 R4–R6 不变。

### R4. 进程与终端底层

Rust 接管现有 terminal runtime 实际进程，TS 保留 UI/API/命令整理/Zone 2 adapter；Agent 与用户仍附着同一 handle。
stdin/resize、输出原字节/游标、自动后台、退出码、终止与 writer 释放均由实际进程决定。外部 LSP/DAP/任务/测试
采用同一通用进程服务；Pi session/catalog/inference worker 的会话与协议生命周期继续归 runtime-broker。

接管发生在实际进程生命周期边界，不把 PID 当可移交 PTY。Host 或 kernel 崩溃后，按平台进程证据处置遗留进程，
不重放命令、不在未知状态回收目录；恢复新 epoch 后旧 handle 不复用。用户 shell hooks 与现有 OSC 命令事实不退化为猜测。
验证本机真实 shell、UI attach/输入、后台自然退出、停止失败、Host/kernel 单独退出、LSP/DAP 流和已有任务消费者。

D-280 已完成本节生产接管，消费者与 native failure evidence 见 [唯一状态记录](agent-harness-status.md) 及 [process ownership](../packages/web/application-host/lib/process/DOCUMENTATION.md)。kernel 使用同一 executable 的 guardian 隔离阻塞 I/O/进程树；guardian 不开 SQLite，唯一 Storage 保留 durable identity/tombstone。Window Job、Unix session（Linux subreaper）提供实际生命周期证据；未证明旧进程退出就保持 unknown。不存在 Node/Bun PTY 生产 fallback，也不把死亡会话重启成另一个 shell。进程作用域与 R2 file gate 共用物理目录边界。

R4 不声称新增恶意代码 OS sandbox，也不要求用户本地其他平台/签名/物理断电。旧分发依赖与 rebuild probe 的移除、完整 packaged smoke、受控多进程性能仍按 R0/R6；已定义的短命 Git 语义命令和发现/bootstrap 探测不因此迁成第二套 Rust 调度器。

### R5. 文件与结构检索计算

用内核 pin 直接执行固定视图范围读、枚举、搜索、结构解析/切块，scope 在候选选择前约束。
前台请求与后台扫描分开调度，取消到达实际任务；图/语义提供线索，原文依旧绑定实际 revision。
复用 rg、tree-sitter 与已有原生计算，不为 Rust 重建搜索算法、TriviumDB、向量库或 ONNX；
图/向量库继续经已有 TS adapter 单写，LLM 计划/选段与远程推理继续经 Pi。

生产消费必须覆盖 read/grep/find/ls/explore 及索引输入，不只给新工具加一个旁路。
验证父 live 漂移、草稿覆盖、嵌套 view、scope、查询取消/partial/终态、结构批量传输与后台负载下前台响应。
删除对应旧扫描/解析/缓存路径；跨边界只传需要的记录/范围，不传整库。

D-281 完成本节：`compute.start/read/cancel/release` 使用 bounded cursor 和 2 foreground + 1 background worker；immutable WorkingState query 复制短生命周期 reader pin，caller unpin/branch delete/GC 不改变正在读取的 root。live workspace 通过 Host-admitted canonical root 读取并给正文/结构结果绑定实际 content revision，读取窗口漂移只能 partial/failed，不被宣传为 immutable snapshot。surface draft 是 Registry 捕获后上传的 fixed object overlay，ancestor tombstone 在候选预算前遮蔽。`search.content`、file find、Harness grep/explore、language catalog、symbol graph 与 semantic disk scan 统一走该 native boundary；virtual Thread semantic 只枚举 pin 内 path/revision，tree-sitter `unitsFixed` 在 pin 上直接产生结构 unit，再由 TS tokenizer/embedder 装饰，不再复制整分支正文到 Host。Host 保留 grammar 安装 ABI 校验与 LSP 协议，不把它们当第二套 workspace parser；TriviumDB/vector store/remote inference/Pi 归属不变。R5 因此 Complete；D-281 当时不改变 R0/R6，二者随后由 D-282 收口。

### R6. 完整验收与发行收口

采用已修正并验收的 TS 基线，同机同语料区分冷/热，测端到端耗时、写放大、Host+kernel+Pi 总内存与资源释放。
复用现有观察脚本，记录语料/文件字节/并发和节点/存储操作计数，避免把算法修复、缓存预热或省略耐久写当语言收益。
性能目标按设计第 8 节：已有根操作不扫描全树、增量写不改无关状态、后台计算不阻塞前台；具体延迟/容量根据证据定标。
结构回归和系统性性能退化必须解释并处理，不要求付费模型或独立研究评测才能验收。

从真实发行目录启动 kernel，验证更新/退出、数据位置接管、Host+kernel 重启、文件与 shell 公开纵切；覆盖仓库支持的
平台构建，真机证据按平台分别登记。移除全部已接管的旧 TS writer/重复状态/临时桥接，模块文档记录唯一调用链。
现有薄的公共 API adapter 是架构组成，不因“清旧”误删。R0–R5 的消费者、故障和资源证据齐备后再把阶段 R 标成完成。

依赖关系：R0 → R1 → R2 → R3；R4 在 R0/R2 的身份与 writer 契约确定后可独立推进，R5 依赖 R1/R2 的固定视图。
R6 汇总所有里程碑并完成发行验收。并行不能让两个任务各改一份共享协议/存储权威；共同契约由一个整合者负责。

D-282 已完成本节。`scripts/measure-kernel.mjs` 对固定语料和 D-280 后/R5 前的 TS 产品路径做交替顺序的冷/热对照，记录语料 hash、
脚本/kernel identity、事件循环、分阶段 RSS、root 节点、WAL 文件长度变化与实际取消；结果见 status，不从瞬时 RSS/WAL 长度推导物理
写放大，也不把结构解析或 inventory 的额外成本藏掉。`smoke-kernel-release.mjs`、Windows unpacked smoke、VS Code native-search smoke
和云运行时 verify 脚本都从发行树运行，覆盖重启、固定 root、文件条件应用、结构读取、shell 退出与句柄释放。

生产依赖已删除 `node-pty`、`bun-pty`、`better-sqlite3` authority 与 Electron rebuild 脚本；TriviumDB/sherpa 仍按各自领域的预编译
binary 验证。Application Host build 会对 emitted import graph 做运行时可达性审计，拒绝可达的旧 store/test helper，并从发行树删掉不可达
测试/旧实现；源码测试 helper 不构成生产 fallback。Document Registry 关闭等待最后 journal/owner release，Web/VS Code 的 surface operation
事件不再被 watch adapter 丢弃。R0–R6 均完成，阶段 R 的下一步是使用与优化，不再维护迁移待办。

## 阶段 4–6：既有默认 runtime 与后续领域

- 默认 runtime：直接交付 bundled Pi、Runtime Manager 默认选择与 Git Bash 就绪说明，保留自有 runtime；实际 Electron smoke。
  已有版本依赖明确，不等 harness 全部完成。
- 外部 runtime：排在 D-283 的原生权限与 web 收口之后；届时按实际 Host 服务接 MCP/ACP/能力协商，选定 adapter 的协议版本在实现中完成，不先预建全部未来兼容框架。
- research/文件知识工作：以 [科研集群设计](research-cluster-design.md) 为准，沿共享工具、存储、文档、线程、调度和验证器实现
  异构模型并行研究。首个纵切从开放计算问题开始，包含问题发现、文献/代码调查、实验设计、快速执行、事件触发综合和写作回流；
  论文复现只是场景，不先建设科研管理表单或第二套 Agent runtime。第二个 profile 发展公共接口，不是允许建接口的前置。
  SaaS 连接器与 Windows 沙箱保持范围之外。

默认 bundled Pi 的已交付路径保持。阶段 R 已由 D-282 收口；外部 adapter 和新领域 profile 使用当前 Rust kernel/TS Host 边界，
不另建一套资源、存储或进程后端。

## 阶段 Q：测试与 CI 体系重整（D-292，已验收收口）

设计权威为 [testing-ci-design.md](testing-ci-design.md)，现状审计与处置结果见 [testing-ci-audit.md](testing-ci-audit.md)。本阶段覆盖全仓；其后 D-296 已收口，再开始 AI4S 的 7A–7F。
先建立整体判断，再分责任完成修改；不得把它交付成只修近期几处失败、只删源码断言或只移动 workflow 的局部补丁。
当前状态是 Q0–Q3 已实施并经主代理验收收口（D-293/D-295）；D-296 已完成原 VS Code
companion 的完整退役，故它不再是当前 required CI 或手动入口。以下编号保留为实施记录，不构成每次
日常开发都要重复的检查流程。

### Q0. 全仓现状、责任和目标结构

1. 从当前 tracked 文件、各 package scripts、runner 配置、Cargo 与独立 smoke/workflow 入口建立测试家族与执行关系。
   覆盖 UI/Web/CLI/Electron/Mobile、Pi/broker/client、protocol/settings/extensions、kernel、构建/部署脚本；
   排除依赖和产物副本。统计测试文件与实际发现/执行集合时分别标明口径，不用 grep 出来的声明数量冒充通过用例数。
2. 复用近期 CI 日志，定位时间集中项、重复运行/构建、失败和未执行入口。对代表性慢测试、易碎测试与关键正确性链读取
   完整装配和消费者，区分产品问题、测试问题、环境故障。不能仅按 `mock`、`readFile`、文件长度等关键词判定删除。
3. 按能力列出简短处置：现有证据层/入口、保留或删除/合并/替换、受影响消费者和未知。以模块/测试家族为粒度，放在本节
   实施记录或所属模块文档；不维护几千行用例台账，不要求每个测试新增标签或决策号。
4. 确定目标套件职责和构建依赖图，再进入 Q1/Q2。根 scripts、共享 fixture 和 workflow 的修改由同一整合者负责；
   模块内清理可独立推进，但不能各自新增一套发现机制、重复入口或相冲突的测试基类。

交付：每个维护领域都有处置结论和真实入口，成本基线标明提交/环境/范围；已有证据足够时直接推进，不为清点先全量重跑。
原始调查见设计 1.1，只作起点，不把抽查包装成全仓已审完。

### Q1. 清理无效约束，修正测试行为与装配

按 Q0 的能力分组完成整套处置，先处理高维护成本和错误证据，不以文件数作为工作量或成果指标：

| 工作面 | 具体处理 | 保留的结果保证 |
| --- | --- | --- |
| 源码/清单/历史门禁 | 删除无现行需求的固定条数、workflow 字面结构、旧迁移符号、日期/Git 历史比较；类型/lint/构建边界各归原 owner | 真实协议、依赖边界、文档链接与用户可见契约 |
| 重复场景 | 比较每层新增的风险，同义输入合并，底层详细覆盖、上层代表性连接；删除无人消费的旧辅助实现及专属测试 | 重要行为在正确责任层仍被验证 |
| UI/设置/平台适配 | 优先调用实际投影、处理函数或必要交互；去掉只核对组件源码措辞的证明 | 设置生效、状态呈现、导航与权限等具体结果 |
| Harness/Pi 上下文与线程 | 检查 faux 回复、工具继续、正常/错误终态、provider/会话隔离与释放；关键流程走真实 consumer | 结果归属、上下文续接、取消/等待/恢复不被中间采样冒充 |
| Rust/文件/恢复/进程 | 策略 fake 与真实权威验收分清；退役实现不能替现行生产后端背书 | 文件/草稿保全、scope、CAS、durable recovery、实际进程退出 |
| 构建/部署/发行 | 把重要行为从源码字符串转到产物/运行观察；已有有效 smoke 直接复用 | 内置 runtime/kernel 可用，失败部署可恢复，产物身份正确 |

实施注意：

- 对 Zone 0 等已发现异常测试，先复现正确的输入/工具步数、回复耗尽和结束原因，再修 fixture/断言；不得只提高 timeout。
- 局部时序使用事件或可控时间。真实 OS 生命周期测试继续观察进程和 I/O；资源竞争按实际来源隔离，不全仓无差别串行。
- fixture 只共享必要启动/隔离/清理，默认不用付费服务、真实个人设置和不受控外网；外部兼容性观察单独表达。
- 预期故障显式断言，未预期异步异常/子进程失败不能吞掉。即使断言失败也释放本测试拥有的资源。
- 不要求每个删除项补一个新测试；如果删除会丢失唯一的重要保护，把该行为在同一改动移到正确层即可。
- 为测试便利改变生产接口时，说明具体接缝需求；不得复制第二套业务逻辑、恢复旧 writer 或添加只为测试通过的产品限制。

交付：分组修改可审阅，说明被删除/合并证据的去向与保留的实际行为；针对改变的责任运行必要验证，不每组重复整个仓库。

### Q2. 统一发现与执行，重组构建和 CI

1. **先修执行集合。** 核实 Linux/Windows 对 `test/**/*.test.ts` 的展开，消除相同命令漏根目录文件等差异。
   使用现有 runner 或简单可移植脚本，分别列出公共与平台专属文件；确保 targeted 参数实际缩小运行范围。
   node:test、Vitest、Cargo 和 smoke 不互相误收集，也不扫描构建副本。保留本地完整适用验证入口。
2. **给每项验证一个明确归属。** 处理 kernel 专项与 Web 全包、i18n 与 UI 全包、Electron runtime 与 updater、
   CI/Docker/release 源码检查的实际重叠。不同平台或构建产物的有效独立证据保留，不能仅为减少 job 数删除。
3. **整理构建依赖。** 类型依赖/生产构建/dist smoke 不反复重建相同包；按提交、依赖、工具链、配置、平台/架构复用
   可用产物。先消除同 job 冗余，再判断跨 job 传输/缓存是否值得，不为缓存建设单独服务。
4. **按职责组织反馈。** 快速源码/行为检查、平台运行检查、发行成品验证清楚分工；任务拆分与并发取决于真实耗时和资源，
   不预设三个 job 或整仓切成固定份数。Windows/Linux 不机械重复全部无平台差异的测试，实际平台消费者继续运行。
5. **按依赖选择触发。** 文档改动无需重建无关原生/容器产物；协议/kernel/依赖锁/构建和 workflow 变动扩大到相关消费者。
   不确定影响范围时运行相关完整套件。比较代表性变更实际选择的任务，避免 path filter 漏测或 required check 永久 pending。
6. **让失败直接可定位。** 保留相应子进程退出、stderr 与最小必要日志，区分装配和产品故障，不输出凭据/用户正文。
   当前云首次启动失败等具体问题先取得真正错误，不再仅凭 wrapper 报错猜测、重跑或改超时；确认产品缺陷则独立修复。
7. **衔接分支与发行。** required checks 随 job/聚合责任更新；不得清空规则、使用 continue-on-error 或盲目重试换绿灯。
   发布只复用适用于同一源修订/构建条件的证据，保留对应成品 smoke；不重打或覆盖正在发行的已选产物来混入本阶段改动。

交付：统一且可本地运行的命令、互不重复的执行责任、可核对的发现集合和工作流；相关模块/开发说明同步到实际入口。
Q1 与 Q2 可在责任明确后交错推进，但不得先隐藏未解决失败再把新入口标为完成。

### Q3. 验证整理效果并收口

- 从文档、UI、Host、kernel/共享协议、打包配置的代表性变更核对任务选择、公共/平台集合和产物来源；
  使用 runner 清单、现有提交差异和实际任务即可，不新造永久 CI 元测试框架。
- 对保留的关键行为与已修缺陷取得相称证据。数据、权限、上下文终态、线程生命周期和目标发行启动不能因清理而失去保护。
  一个错误不要求从协议到 UI 每层各补一遍完整复现。
- 与 Q0 对比墙钟、重复构建/执行和失败定位路径；环境或测试范围改变单列。正常重构是否仍被源码文字断言绊住，也是判断项。
  不把缩小覆盖面的时间节省全部算成执行提速，不设置删减百分比、覆盖率和固定测试总数门槛。
- 更新开发指南、模块 README、status 当前证据引用及 plan；退役测试不再作为当前 `proven` 依据，历史决策正文不改写。
  交付报告以保护的能力、清理原因、实际验证和剩余限制为主，不用通过数代替结果。

完成条件见设计第 7 节：全仓各责任已处理，已确认的错误成功/漏执行/无效约束已关闭，关键行为仍有可信证据，CI 的重复成本和
诊断问题已收口。当前重大产品错误不得冒充测试噪声；无关外部服务短暂失败和可选优化不把本阶段变成无限验收。
不要求固定次数全绿、付费模型实验、全量 mutation testing 或新增监控平台。

Q 完成后已实施 D-296；AI4S 直接沿用整理后的职责与脚本，不为科研 Profile 重建一套验证体系。

## D-296：退役原 VS Code companion（AI4S 前）

D-296 紧接阶段 Q，完成 AI4S 7A–7F 之前的产品边界收口。实现范围是删除 companion 包、开发/构建/打包
入口、companion-only shared contracts，以及当前安装、Marketplace、配置和开发说明；不保留归档兼容副本。
涉及 LSP 包、TextMate 格式、外部编辑器启动或 provenance 的文字按原语义保留，历史 changelog、决策正文
和阶段 R 交付证据不改写。

当前状态：文档与公共入口说明已同步；代码、配置、脚本和发布链已完成。根构建（含 Web
Host+Vite、Electron bundle、Mobile assets）与 built-server knowledge smoke 2/2 已本地通过。未把
packaged、跨平台或远端 CI 结果外推为本地证据；D-296 已完成，下一阶段进入 AI4S。

## 阶段 7：AI4S 科研集群（D-291，设计已接受）

阶段 Q（D-292）与 D-296 已完成。科研设计与讨论可继续，7A–7F 的功能实施现在可以启动。

本阶段的产品中心是异构模型科研集群，而不是科研资料管理器。首席研究主线负责问题发现、第一性原理分析、跨分支综合和文章主线；
研究 Thread 负责独立调查、实验设计、实现、复核和写作缺口；Host 调度模型与实际计算资源，普通批处理和进程监控由程序完成。

首个交付纵切是“开放问题 → 多路调查/假设 → 低成本区分行动 → 快速执行 → 事件触发综合 → 下一轮分配”。实现复用已有
Thread/Run、WorkingState、检索、上下文、权限、Rust kernel 和 Pi runtime。研究证据、版本、运行和产物是自动保留的内部事实，
证据表、协议、Research Diff 和文章结构按需生成，不作为用户前置流程。

本阶段尚未实现或接线；交付状态不写入 status 的 wired/proven/default-on，具体目标和边界见
[research-cluster-design.md](research-cluster-design.md)。以下是执行顺序和不可改变的实现边界。

### 7.0 实施规则与边界

1. **复用已有生命周期。** 科研分支使用现有 `Thread` / `ThreadRun`、`dispatch` / `wait` / `send` /
   `read_thread` / `kill`、WorkingState、OutputRef/Artifact、Rust kernel 和 Pi SessionHost。不另建
   `ResearchAgent` 进程、科研专用 thread tree、第二套恢复 writer 或第二个模型调用循环。
2. **研究状态不是新的事实库。** 文件、运行输出、Pi transcript、来源收据和已发布 Artifact 是事实；研究板和分支摘要是可重建的
   projection。不能把模型生成的 board 摘要当作原文、运行结果或科学证明。
3. **结构隐藏在运行时。** 用户可以直接开始研究，不先填写问题、假设、指标或协议表单。必要字段由首席模型和 Host 从真实工作中生成；
   缺少某个字段不能阻止探索，只有工具本身需要的参数才是准入条件。
4. **不设通用硬上限。** 并发、模型预算、GPU、磁盘和网络使用已有用户/部署配置；本阶段不新增固定假设数、实验轮数、token、墙钟或
   分支深度上限。遇到真实资源不足时使用既有排队、背压、取消和 unavailable 状态。
5. **模型选择不暗中借用。** 当前会话模型作为首席主线的默认输入；专用能力槽位只有在用户配置或 Run 明示 `inherit` 时使用。
   未配置的能力不得静默冒充已绑定模型。每个 Run 冻结最终模型、工具、权限、scope、输入来源和执行资源。
6. **先完成一条真实纵切。** 任何抽象接缝都必须由首个开放问题任务消费；只写 DTO、角色目录或 UI 面板不能标记阶段完成。

### 7.1 权威与模块责任

| 对象 | 唯一权威 | 允许的职责 | 禁止的职责 |
| --- | --- | --- | --- |
| Thread/Run 生命周期 | ThreadRegistry / Run catalog | 分支身份、父子关系、运行配置、等待、取消、结果入口 | 保存完整科研知识图或复制全部材料 |
| 研究板 projection | Host 研究协调器，绑定根 Thread 与 revision | 当前问题、分支索引、假设状态、最近综合、待处理事件 | 冒充原文、文件、运行或 Artifact 的事实来源 |
| 文件与代码 | Documents / WorkingState / Rust kernel | 分支读写、基线、版本、合并和恢复 | 由研究协调器另存一份正文 |
| 进程与计算 | Rust kernel process/PTY/resource 服务 | 运行、取消、输出、资源占用和退出事实 | 让模型轮询或直接管理 Host 凭据 |
| 来源与网页 | 现有 web/retrieval/receipt 服务 | 搜索、抓取、来源身份和原文切片 | 把模型摘要当作来源正文 |
| 研究产物 | Rust object/artifact 及现有引用域 | 图表、数据、日志、报告和版本引用 | 只把短期 OutputRef 当长期成果 |
| 模型与凭据 | Pi SessionHost / user-owned model slots | 调用、流式事件和 Run 绑定 | 研究 Profile 保存一份凭据或偷偷换 provider |

研究协调器可以把多个事实引用组合成一个 `ResearchBoardRevision`，但该 revision 必须能从 Thread 事件、分支结果和 Artifact 引用重建。
写入研究板时使用现有 Host/catalog CAS；旧综合不能覆盖新分支事件，冲突时重新取当前 revision 生成下一次综合。

### 7.2 最小研究状态

第一版不建立 `paper` / `citation` / `experiment` 全套强制图。根研究 Thread 可有一个版本化的 `ResearchBoard` projection，最少包含：

```ts
interface ResearchBoard {
  rootThreadId: string;
  revision: number;
  question: string;
  constraints?: string[];
  branchRefs: Array<{
    threadId: string;
    purpose: 'investigation' | 'design' | 'execution' | 'review' | 'writing';
    status: 'queued' | 'active' | 'waiting' | 'settled' | 'cancelled';
    latestUpdateRef?: string;
  }>;
  hypotheses: Array<{
    id: string;
    label: string;
    state: 'open' | 'supported' | 'weakened' | 'blocked' | 'merged';
    basisRefs: string[];
    updatedAt: string;
  }>;
  openQuestions: string[];
  latestSynthesisRef?: string;
  writingRef?: string;
}
```

这段结构是 Host/模型间的内部投影，不要求用户逐项编辑。`branchRefs.status` 是对现有 Thread lifecycle、Run outcome 和等待状态的投影，不能替换 Thread 的生命周期权威。`basisRefs` 必须指向实际来源、文件修订、运行或 Artifact；不允许只有模型文字没有依据。
`hypotheses.state` 描述当前研究状态，不是概率或“可信度百分比”。状态改变应能追溯到触发它的分支更新。

研究板只保存短的当前投影。大段原文、代码、日志和图表通过引用按需读取；历史 board revision 保留在现有结果/消息或对象引用中，
不能在每次更新时复制全部分支上下文。

### 7.3 Thread、Run 与研究分支

1. 根会话显式进入 research Profile 后，首条研究请求建立一个 root research Thread 或绑定当前研究主线；普通 code session 不自动变成科研集群。
2. 首席主线派发的每个分支仍调用现有 `thread.dispatch`。研究用途写入 manifest 的 profile/capability/purpose 元数据，
   不用永久 role 绑定模型。分支只继承 dispatch 时实际可用的材料摘要、来源引用和授权 scope。
3. 分支 Run 冻结 `modelBinding`、`toolAllowlist`、`permissions`、`workspaceScope`、`inputOrigin`、`resourceRequest` 和 parent board revision。
   后续升级模型必须新建 Run，不能在活动 Run 中偷偷换模型。
4. 分支默认独立 WorkingState。只读调查可共享父的固定 view；需要写代码或产物时使用独立 branch，`shared` 仍须显式选择。
5. 分支完成后通过现有 Thread result/revision 发布，研究更新只引用该 revision。`send` 传递请求或信息，不能代替文件合并、结果发布或
   研究板 CAS。
6. 分支可以从新的发现派生子分支，但父分支负责其 scope、资源和取消；不创建跨根群聊，不把孙线程完整 transcript 注入根上下文。


### 7.4 能力路由与模型升级

研究 Profile 声明能力目录，不复制当前 `harness-roles` 的永久职业绑定。第一版能力至少包括：

| capability | 输入重点 | 交付重点 | 默认路由 |
| --- | --- | --- | --- |
| `frontier-reasoning` | 用户问题、当前 board、关键分支更新 | 新问题、解释框架、方向选择、综合 | 当前主线模型或用户显式绑定 |
| `deep-design` | 指定假设、来源和约束 | 区分性实验、对照、混淆变量分析 | 用户显式研究模型槽位 |
| `fast-exploration` | 窄材料、局部问题、快速检索范围 | 术语、反例、局部变体和短调查 | 高吞吐模型槽位 |
| `high-throughput-execution` | 已确定的代码、数据和参数 | 真实作业、日志、指标和产物 | 快速实现模型或无模型批处理 |
| `critical-review` | 关键实现、异常结果或候选主张 | 独立反例、方法问题和缺口 | 用户显式复核模型槽位 |
| `scientific-writing` | board、引用和结果产物 | 备忘录、论点、章节和缺口请求 | 强模型槽位或主线显式派发 |

路由器只根据 capability、用户配置、Run 影响和资源可用性选择候选，不根据模型名字硬编码科学角色。执行前向 Run manifest 写入最终 binding；
写入后本次 Run 的模型不变。升级行为是“结束/暂停当前 Run → 新建同 Thread 的 Run → 带上结果 revision 和窄输入”，不是在流中切模型。

未配置的专用能力返回明确 unavailable 或等待用户配置。只有 dispatch 明示 `inherit` 时才继承调用者当前模型；不能为了让集群看起来完整而静默借用主模型。

### 7.5 分支交接与事件触发

分支不能直接修改父的 board 或在父 transcript 中写任意总结。分支结束一个有意义的推进后，经 Host 校验生成内部 `ResearchUpdate`：

```ts
interface ResearchUpdate {
  updateId: string;
  rootThreadId: string;
  branchThreadId: string;
  runId: string;
  baseBoardRevision: number;
  kind: 'finding' | 'conflict' | 'failure' | 'artifact' | 'question' | 'writing-gap';
  headline: string;
  impact: string;
  evidenceRefs: string[];
  failureKind?: 'implementation' | 'environment' | 'data' | 'scientific' | 'cancelled';
  alternativeExplanations?: string[];
  nextActions?: string[];
}
```

要求：

1. `updateId` 与 `(branchThreadId, runId, sequence)` 幂等；重连和重复 `wait` 不重复触发综合；
2. `evidenceRefs` 只能引用授权的来源、文件 revision、运行、Artifact 或 Thread result；不存在的引用返回明确错误，不能用模型正文顶替；
3. `baseBoardRevision` 不匹配时不能覆盖当前 board；Host 把它作为待综合冲突输入；
4. `failure` 必须区分实现/环境/数据/科学结果不支持/取消，不能只有一个 failed；
5. 普通进度、下载百分比、重复日志和心跳只进分支 UI，不生成 ResearchUpdate。

Host 合并更新后，按事件触发一次合并综合。下列事件可触发：新机制、与当前假设冲突的观察、分支间冲突、明确失败原因、低成本批次完成、写作缺口和用户请求。
同一时间窗内的多个更新合并为一次输入；综合运行中到达的更新排队，不递归启动第二个首席调用。综合以 `baseBoardRevision` 读取 board，成功后 CAS 发布新的 board/summary revision；
CAS 失败表示研究状态已变，重新读取并建立下一次综合输入，不设固定重试循环。

### 7.6 自适应调度与资源准入

调度器是 Host 内的普通服务，不是一个永久“管理 Agent”。它维护研究 work item 与实际资源事实：

```ts
interface ResearchWorkItem {
  id: string;
  rootThreadId: string;
  branchThreadId?: string;
  kind: 'investigation' | 'design' | 'execution' | 'review' | 'synthesis' | 'writing';
  dependsOn: string[];
  resourceRequest: {
    modelCapability?: string;
    cpu?: number;
    memoryBytes?: number;
    gpu?: string;
    network?: 'none' | 'workspace' | 'external';
  };
  inputRefs: string[];
  requestedBy: 'user' | 'principal' | 'branch';
}
```

实现边界：

- `dependsOn` 未完成时进入 waiting，不占用运行名额；等待父线可以处理其他分支；
- 模型调用、CPU/GPU 作业、外部网络和 workspace 写者分别登记实际资源，不能用一个“并发数”冒充所有资源；
- read-only 材料、语法包、数据索引和已构建环境可以共享；可变 WorkingState、参数、随机种子和输出必须按分支隔离；
- 一个执行 Agent 可以提交一批普通作业，作业由程序运行；不为每个 seed/参数组合创建 Thread；
- 运行中资源取消必须到达实际模型请求或 kernel process，不能只把 UI 状态改成 cancelled；
- GPU 满载、provider 限流、网络不可用和 workspace writer 冲突分别返回对应 waiting/unavailable/failed 状态；
- 主线可以提供研究优先级，但调度器不计算科学价值分数，也不自动淘汰所有早期弱信号分支。

动态矩阵以“分支 → 低成本行动 → 结果 → 再分配”为单位扩展。继续、收缩、合并和保留的理由写进 ResearchUpdate 或 board revision，不能只藏在调度器内存。

### 7.7 研究执行适配器

第一版先接本地代码、数据和计算实验，不实现完整 Jupyter 或领域实验室系统。适配器必须调用现有 Rust kernel 受管进程/文件/对象服务，不能由 renderer 或模型直接 spawn 任意 Host 进程。

先定义一个 Host 侧 `ResearchExecutionAdapter`，包含：

1. 输入：代码/命令、工作分支、数据和环境引用、参数、随机种子、资源请求；
2. 执行：通过 kernel process service 启动或附着，支持取消、输出游标和真实退出事实；
3. 产物：把 stdout/stderr、指标、图表、数据和报告作为对象或 Artifact 写入，长期引用不使用临时 OutputRef；
4. 结果：返回 `success`、`failure`、`cancelled`、`unavailable`、`partial`，并带实际输入/环境/产物引用；
5. 重放：根据 Run manifest 创建干净执行，不能把探索进程内存当作可复现依据。

执行形态分两种：

- **batch**：干净进程运行一个完整脚本或命令，绑定代码、数据、环境和参数，作为首个可复现路径；
- **explore**：后续可以接持久 Python worker，让多个代码单元共享内存以提高探索速度。每个单元仍须提交需要保留的 Artifact，
  worker 崩溃后不能假称内存状态恢复；需要复现时回到 batch。

首个纵切可以先以 Python/现有 Shell 执行 batch 为主；不要为了“支持 notebook”先复制一套 Agent loop、Jupyter server 或长期内存数据库。
如果接入持久 worker，worker 只负责代码执行和 host RPC，不负责研究调度、权限或最终结论。

### 7.8 上下文装配与原始材料

首席综合输入由以下部分组成：当前 board projection、尚未消费的 ResearchUpdate、影响判断的关键引用和用户最新指令。普通分支进度不注入，
完整原文、代码、日志和图表通过引用按需读取。分支输入只包含其目标、父线已接受的相关材料和授权范围，不复制根线程完整对话。

使用 D-284 的容量驱动后台摘要和 D-286 的 fresh/continue 语义；不要为科研再启一个持续 keeper。board 摘要准备与 ResearchUpdate 提交分开，
不能在候选生成时推进观察游标或消费用户消息。摘要过期时从 board revision、Thread result 和原始引用重建。

### 7.9 写作回流

写作任务是一个普通 research Thread/Run，默认不自动启动。用户请求写作或首席主线判断结果已形成可表达论点时才派发。

写作 Run：

- 读取指定 board revision 和结果引用；
- 生成研究备忘录、图表说明或文章段落；
- 为每个重要主张保留来源/运行引用；
- 把“无法由当前结果支持”的主张记录为 `writing-gap` ResearchUpdate；
- 不修改实验结果或原始来源，不由多个写作线程各自维护冲突的文章主线。

写作缺口回到首席主线后，可以派发新的调查、设计或执行分支。文章不是最后一次性搬运结果，而是研究判断的一个反馈入口。

### 7.10 最小 UI 投影

第一阶段 UI 只需要让用户看清研究推进：

1. 当前问题与首席主线暂时判断；
2. 活跃分支、分支目的、当前状态和最近研究更新；
3. 正在运行、等待、冲突和卡住的工作；
4. 下一轮准备投入的模型能力和计算资源；
5. 结果卡片展开来源、代码、日志、图表和 Artifact；
6. 派发、暂停、停止、扩大方向、要求综合和继续某条分支的自然语言入口。

不在第一阶段建设复杂的科研数据库编辑器、默认大图、逐工具审批弹窗或完整论文编辑器。证据、实验、产物和文章视图必须共享 board/Thread/Artifact 引用，
不能在 UI 各自复制一套状态。

### 7.11 分阶段交付

**7A：Profile 与根主线。**

- 增加 research Agent Profile 的能力声明、工具集合和上下文模板；
- 研究会话显式进入 Profile，普通 code session 不自动改变；
- 复用当前模型作为首席主线，真实创建 root Thread/Run；
- 验证用户问题 → 首席模型 → 持久 root Thread 的真实纵切。

**7B：研究分支与能力路由。**

- 扩展 `dispatch` 的 research purpose/capability/resource manifest；
- 接通 investigation/design/fast-exploration/high-throughput-execution 的模型解析；
- 实现同 Thread 换模型的新 Run、分支继承窄输入、独立 WorkingState 和取消/等待；
- 验证未配置能力不静默借模型、Run 配置冻结、分支结果不污染父盘。

**7C：更新交接与自适应调度。**

- 实现 `ResearchUpdate` 的生成、引用校验、幂等、board revision CAS 和事件合并；
- 接通同根模型/CPU/GPU/网络/写者资源登记与排队；
- 普通批处理直接由程序执行，异常和冲突才升级模型；
- 验证重复 update、并发综合、取消、资源等待和 Host 重启后的恢复。

**7D：计算执行纵切。**

- 接入 batch Python/Shell 执行适配器、输入/环境/参数/产物 manifest；
- 复用 Rust kernel 的 process、file、object、working-state 和 recovery；
- 产物可从 Thread result 和 board 引用读取，真实退出和取消可见；
- 先证明一个开放问题的基线运行和一个变体运行，不先实现持久 notebook。

**7E：综合、写作与 UI。**

- 接通事件触发的首席综合与 board projection；
- 接通按需 writing Thread，以及 writing-gap 回流；
- 提供最小研究推进视图和自然语言控制；
- 验证结果冲突、意外发现、文章缺口和用户改方向可以回到下一轮研究。

**7F：完整首个纵切与评估。**

- 用一个真实开放计算问题贯通用户输入、并行调查、实验设计、快速执行、结果回流、综合和写作备忘录；
- 对比最强单 Agent、异构串行和异构并行三种形态，保持相近资源条件；
- 观察研究进展、有效实验、结论质量、人工返工和达到下一判断的时间；
- 只把真实发现的问题加入后续计划，不用一次评测构造永久门槛。

### 7.12 关键验收反例

执行 agent 至少要覆盖以下反例，不能只测 helper 或 mock coordinator：

1. 两条独立分支对同一问题提出不同解释，首席综合看见差异而非重复摘要；
2. 一个分支先产出异常，能够直接派生下一步，其他分支继续运行；
3. 快速实现失败时，系统区分代码/环境失败与科学结果不支持，不错误淘汰假设；
4. 普通日志和进程状态不触发模型，异常和关键结果触发一次合并综合；
5. 同一 update 重送、Host 重启或综合并发不会重复派发或覆盖新 board；
6. 分支共享只读准备材料，但可变代码、参数和产物互不污染；
7. 关键结果升级到强模型时，新 Run 继承正确结果引用，旧 Run 模型和输入保持不变；
8. 资源等待不占用错误的运行名额，取消真实到达模型/进程并保留已产生的 Artifact；
9. 过期背景 fresh 后仍能读到 Thread 成果和原始引用，不把旧摘要当作最新事实；
10. 写作线发现主张缺口并回流新的研究分支，不能只改写没有依据的段落；
11. 删除或归档根 Thread 时，后代运行、board projection、产物引用和工作区保留责任沿现有级联契约处理；
12. 没有 research Profile 或专用模型配置时，普通 code harness 行为不改变。

### 7.13 阶段完成判据

阶段 7 完成必须同时满足：

- 公开入口能够从真实用户问题启动 root research Thread；
- 至少两种不同 capability 的真实子 Run 并行工作并返回 durable update；
- 至少一个真实代码/数据执行产物进入现有 Artifact/Thread result 路径；
- 事件触发综合能根据分支结果继续、收缩或派生路线；
- 用户可以中途改变方向、停止分支、继续旧成果或 fresh 重建输入；
- Rust kernel、Thread/Run、权限、上下文和文件 authority 没有新增第二套生产实现；
- 关键反例和一次完整纵切有对应测试/现场证据；
- status 只按实际达到的 implemented/wired/proven/default-on 级别回写，未观察的真实模型质量、平台和外部计算如实保留。

## 文档同步与验收

设计记目标、status 记交付、模块文档记当前实现、日志只追加。按责任同步，不再复制状态表：

| 变更 | 验证与同步 |
| --- | --- |
| 文档 | test:docs、docs:validate、diff whitespace；设计/计划/状态/索引一致 |
| 工具/模型请求 | 真实协议和 Pi 请求结果链；默认/用户选择/运行结果；所属模块 README |
| 状态/集成/回收 | 后端文件、并发/中断/迁移/引用保留；线程/恢复模块文档与 architecture |
| UI | 投影、入口、i18n，不为纯展示要求模型请求 |
| 平台/打包 | 相应 smoke，缺平台如实写未验证，不扩大成跨平台禁用 |

完成报告写结果、具体代码、实际检查和剩余问题。已有证据足够就交付，新失败/真实风险才扩大检查。
真实使用反馈进入修复和优化，不单设“等外部测试者后才启用”的阶段。

### D-224 追加：剩余状态契约修复

本轮补齐集成撤销的当前 authority 与耐久状态机：纯 disk、virtual branch、branch→materialized 均先写
`undoing`，条件 CAS/apply 后观察 before，启动对账区分 after、before 与未知；materialized branch 使用 execution
Documents gate，并同步非权威 branch cache；两者完成前 operation 保持 `undoing`。gate 返回后重读父 authority，已回收目录继续以
WorkingBranch 为真相。ThreadRegistry 现在是 cascade admission fence 的权威，create/dispatch/start/restore 检查父与祖先；
拒绝的 surface draft 清理，已被 cascade 接管的 Thread 不由准备失败路径删除。session-bindings 启动一次按健康 catalog 重建，只索引
`activeRunId` 当前 owner，历史 session 不再回落 root。

带 WorkingBranch 的默认 merge 只使用当前 settled Run 成功发布的 native resultRevision；新 Run 先把旧 revision 记录成
`inputRevision` 再撤下默认指针，目录 inspect 或 native publish 失败也都在 Git snapshot 前清除默认 revision，snapshot 自身
失败不能恢复旧值。
Git baseline 对冻结 `captureScopes` 前后重列并比较完整状态身份，explore pin 传入 authorized roots 与查询 signal/deadline，
不克隆未使用的 states。默认 mode 计算保留合法 0。新增反例与验证见 status 的 D-224 记录；3.4 / 3.4a / 3.6 继续 Partial，
真实付费嵌套 Pi、完整桌面重启和外部 provider 仍未测。
