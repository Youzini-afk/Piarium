# Agent harness 实施计划

Status: active execution plan; accepted capabilities ship as usable defaults (D-078)

Last updated: 2026-09-10

设计与边界见 [agent-harness.md](agent-harness.md)，交付事实只看 [agent-harness-status.md](agent-harness-status.md)，
理由追加到 [agent-harness-decisions.md](agent-harness-decisions.md)。正式能力直接实施、完成后默认提供；独立评测不是前置。
全部交付后删除本计划，决策日志归档保留。

## 0. 执行者须知

### 0.1 工作方式

- **正式设计直接实施。** D-078 已授权工作状态与目录分离、原生结果存储、版本化集成，以及检索、记忆和 review 的默认交付。
  执行者可以调整持久格式、数据 authority、协议、方法语义和默认值，连同消费者和文档完成，不按变更类别自动暂停。
- **没有存量用户，就不要写兼容层。** 本项目尚未发布，不存在需要保全的既有 Piarium 持久状态（会话、设置、缓存、索引）。
  替换一个格式、契约或 authority 时直接换掉并删除旧路径：不写迁移脚本、不双写、不留 facade、兼容分支或版本判别，
  也不为假想的旧数据保留读取路径——旧数据丢弃即可。**这不适用于用户工作区里的文件与 Git 历史**，那是用户资产，照常保全。
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
6. 模型槽位 user-owned；仅 hardImplement/review 默认主模型，其他未配不回退，memory 是活动模型的明示例外。
7. web/权限让位沿公开契约，不复制模型凭据、Pi 会话或插件配置权威。
8. 主 agent 对记忆维护零义务，keeper 只标 plan 状态；块写保持分支、版本与原子冲突检查。
9. 压缩使用 Pi 安全切点，覆盖与必要来源满足才接管；不再追加模型效果回放门禁。
10. 损坏、权限错误、未来格式不读成空；新记录发布后切换，失败迁移不覆盖旧数据。
11. 分支读固定基线加自身修改，shared 才读写 live 父目录；物化修改收集后才发布结果并允许回收。
12. 集成消费选定结果修订，写前检查父相关状态；应用/冲突/补偿可追溯，不覆盖后续用户修改。
13. 线程结果、未完集成与草稿有明确保留责任，恢复清理不删除其他所有者仍引用的正文。

### 0.5 代码入口

| 责任 | 入口 |
| --- | --- |
| 会话装配/配置 | packages/pi-host/src/session-host.ts；runtime-broker session launch |
| Pi 写入包装 | packages/pi-host/src/workspace-mutation-journal.ts |
| 协议/工具/角色 | packages/protocol/src/harness.ts、harness-tools.ts、harness-roles.ts、harness-threads.ts |
| worker harness | packages/pi-host/src/harness/README.md；select-tools、memory-agent-extension、compaction-extension |
| Host harness | packages/web/application-host/lib/harness/DOCUMENTATION.md；router、service-host、harness-services、thread-services |
| 线程与物化 | 同目录 thread-runtime.ts、thread-worktree.ts、thread-registry.ts |
| 知识与观察 | packages/web/application-host/lib/knowledge/DOCUMENTATION.md；store.ts、context-runtime.ts |
| 文件/恢复 | packages/web/application-host/lib/documents/、lib/recovery/ 的 DOCUMENTATION.md；authority、journal-files、journal-catalog、journal-engine |
| 搜索/LSP/终端 | packages/web/application-host/lib/search/content.ts、lib/lsp/supervisor.ts、lib/terminal/runtime.ts |
| UI | packages/ui/src/components/pi-session/；HarnessThreadState、HarnessThreadsPanel、PiChatView |
| 真 Pi 测试 | packages/pi-host/test/harness/session-e2e.test.ts；同目录 thread-runtime-session.e2e.test.ts |

### 0.7 当前顺序与交付方式（D-078）

P0、T1/T2/T3 核心与 D-076 已交付，不重开宽泛 P0。以下是整合建议，不是全部串行等待链：

1. **工作状态与集成（3.4/3.5，核心已交付）**：固定结果读取、原生结果、可撤销集成、Git/非 Git 物化、安全回收以及 dispatch
   草稿基线与 surface 写回/绑定预览已进入生产链（D-203）；归档/恢复与用户预算下的空间治理已进入线程面板与 Host 路由（D-204）。
   同名 read/grep/find/ls/explore 的 WorkingState 只读视图已接入真实 Thread Run（D-212）。同名 edit/write/apply_patch 已在虚拟
   Run 上提交 WorkingState delta，首次 bash/LSP 原子切换物化目录（D-213）。隔离 dispatch 已在创建分支时固定 Git/非 Git
   磁盘基线（D-214）。嵌套线程已沿 `parent.kind: "thread"` 接到真实工具能力与 Host 强制（D-215）。D-216 已拆开
   owning/execution workspace，并用 detached Git worktree 或独立 `git init` 隔离物化目录；虚拟写入、基线诚实和嵌套
   集成/权限仍待本轮后续阶段，相关 status 行保持 Partial。
2. **默认记忆与配置（2.4/2.6，D-081 已交付）**：默认 `takeover`、旧设置迁移、实时全局/单会话模式、失败投影，以及 entry/
   分支/block 修订绑定的逐次接管已接线；证据不足或 Host 重启时仅本次回到 Pi。`record-only` 仍非前置。
3. **当前：快速检索（3.2/3.15/3.16，D-173–D-193）**：固定窗口来源、结构切片、图查询、本地语义召回与工具链已接。
   3.15 A–D 已接入公开 `explore`；独立验收补齐 actor scope、取消/截止、真实来源状态、终态、稳定视图、单元排名、required 组、到达即读与 scope 内 Top-K，见 status 3.15 与 D-182–D-189。
   3.16A 已提交（`37b12e8e`、`8752e039`）。3.16B–E 已接入生产链（D-190–D-193）：远程 embedding 绑定、向量复用与前台优先、
   草稿/线程语义覆盖、专用 HTTP rerank。已实现的旧 3.15①②④ 接口继续使用。
   explore 负责快速提供当前代码，较长开放追踪由 retrieval 承担；扩散模型与后训练留待后续。
   3.17 的命令输出整理已交付（D-197/D-199）。完成能力即按有效配置提供，缺某一路不丢弃其他材料。
4. **其余产品面**：知识全量管理、自动 review、后台终端 tab 与 bundled Pi 默认已交付，并经 D-209–D-211 补正身份、并发和退出契约；知识语义召回已沿远程 embedding 接线（D-196）。重叠提示与合并预览随线程服务实现，不设独立收益审批。

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
websearch provider 当前变更需重启 Host，后续新会话使用新的能力世代，旧会话保持配置；不注册不存在的 provider。

## 阶段 2：上下文与知识

### 2.1 知识库服务

保留 TriviumDB 单写者和领域操作，复用 Store 队列。0.8.5 TQL/零向量绕路按设计 7.5 记录，不固化到上层、不外推最新上游。
数据库问题给用户版本、重现与影响；补 retention、删除级联、native 打包消费者。批次按负载配置，不照搬 5000 条硬数字。
工作状态/集成引用独立保护；领域元数据与文件内容存储职责分开。验证真实 Store、引用清理与相关 Node/native smoke。

### 2.2 Zone 2

沿 zone2.assemble 和隐藏 piarium-context 消息追加用户编辑/命令/诊断/Git/知识/计划/线程状态，不重复 agent 已见材料。
保留 event cursor 和送达后游标提交；无材料不造消息。沿现有 zone2.budgetTokens 汇总/折叠，估算明示；不新增固定文件数配额。

### 2.3 Host 观察者

Documents post-commit、用户修改后的 LSP 和现有 Git 刷新已接。逐命令终端信息用真实 shell integration，不把 PTY 退出
当成命令完成、不按键盘换行猜命令。观察失败不反噬已经成功的写入/HTTP，具体来源不可用要可见。

### 2.4 记忆 agent：默认维护

模型调度在 pi-host，Host memory-agent/KnowledgeStore 校验写块。保持活动模型与 memory_edit，不建第二个凭据栈。
复用 D-076 最近祖先/COW/tombstone/CAS/修订前传和实际 entry 覆盖，keeper 只 mark_plan，主 agent 无维护义务。

现行设置区分 `off/assist/takeover`，缺省 `takeover`。`off` 不维护或注入 memory blocks，`assist` 维护并注入但由 Pi 压缩，
`takeover` 在同一路径上通过 2.6 的逐次检查后接管。旧 `shadowMode:false/true` 分别迁移为 `off/assist`，显式 mode 优先；错误值
拒绝而非猜测。memory 是 user-only；全局值对继承中的活动会话实时生效，session-wide 覆盖独立持久并可恢复继承，不暗改全局设置。
`record-only` 可按实际诊断需求后补，不是现行模式或前置。

SessionSnapshot 与 Context 已显示配置/有效模式、session override 和最近 keeper/compaction 失败；Host 拒绝原因进入失败信息，
Settings 可修复坏配置。不新增辅助费用或 Token 看板，普通会话已有费用/Token 展示保留（D-080）。
不承诺相同模型就命中缓存。事件加速接 steering、计划编辑、子返回、真实命令完成；沿已有 token 增长/单个在飞/去抖调度，
有积压才工作，用户“记住这个”不被普通去抖忽略。

版本/分支/CAS、partial apply、主历史无 memory_edit、默认/关闭/assist、实时模式与失败投影已由 protocol、Host 和真 Pi
faux-provider 测试覆盖。剩余触发优化随实际事件入口推进，不做付费协议/缓存对照，不等测试者批准。

### 2.5 todo 与计划面板

保留整表替换 plan、来源和用户版本冲突。confidence 只作信息，不默认因低于 0.6 弹确认；用户明确配置审批或 plan mode 才等。
修改当前自动确认与设置迁移，验证普通计划不中断、显式审批、取消不误写与冲突。不增加记忆维护义务。

### 2.6 压缩默认接线

D-022 已验证 Pi 消费扩展 compaction 并跳过默认摘要。当前实现沿 compaction.before/after 和 Pi preparation 安全切点推导
实际 removedEntryIds；已接受 keeper 更新的 context entry、完整分支祖先路径与所有可见 block 修订必须同时匹配，才组装接管结果。
缺失、不连续、错分支或修订漂移只让该次交还 Pi，不拆 tool call/result。

D-076 水位留在 Host 内存，重启后本次使用 Pi，下一次 material keeper 更新重新建立证据，不先建伪持久 checkpoint。
Host facts 只采事件 authority 能可靠证明的 touched files；诊断没有 resolution authority、恢复没有 session checkpoint 查询时返回空，
不冒充当前事实。`off/assist` 明确不接管，默认 `takeover` 与配置/UI 已接。覆盖缺口、连续压缩、block 修订漂移、错分支、Host 重启、
用户模式和 Pi fallback 已有定向验证；来源恢复能力随真实消费者继续，OutputRef 过期不能当正文，TranscriptRef 不保证截断全文。
没有 T4 门槛。
provider 原生上下文编辑按实际 API 使用，缺能力不阻塞本地压缩。

### 2.7 知识建议与管理

人工标记、memory decisions、suggestions 槽位的用户消息提议和 Settings 全量列表/取代链均已接（D-208/D-211）；未配走已有
无模型路径。Settings 的编辑/接受/驳回/停用以打开时完整修订在同一写队列 CAS，同 scope 预检后提交，旧历史保留；模型提议的
scope/source 由 Host actor 固定，相同正文的历史查重与插入原子完成。自动接受仍按用户显式 scope 设置。

### 2.8 embedding

生产路径按 D-196 / D-198 接线与收口，交付以 status 为准。权威 workspace/user `.tdb` 仍以 placeholder 维度打开，知识向量复用共享代际存储的独立 scope。有效 `harness.embedding`
时，召回与 Zone 2 注入走同一 `harness.embed` 绑定；未配置保持文本/图。旧 `knowledge/embedding.ts` HTTP adapter 已删除。
知识库不使用本地 MiniLM。建设必须覆盖自动维度、空间切换、正常变更的增量合并、迟到发布与关闭；有效状态/修订在 Top-K 前约束，长条目的多个块按知识身份合并。
公开 recall 与 Zone 2 使用同一绑定、取消和两种范围的融合逻辑，绑定解析异常仍交付文本。验证包含未指定维度的真实 remote adapter 与公开服务消费，faux 证据不外推真实远程质量。

### 2.9 模型槽位与执行配置

当前 protocol/UI 提供十个普通 Harness 槽位；`harness.embedding` / `harness.rerank` 是独立配置种类（3.16B/E）。继续使用用户所属的 Pi
配置与凭据路径，子线程模型记在 ThreadRun；仅 hardImplement/review 明示默认主模型。新增模型 kind 必须同时完成类型、设置、
有效绑定与调用消费者，不能靠 UI 任意填一个 model id 冒充后端能力。D-080 的普通会话统计保持，不增辅助分项看板；完整
RunManifest 不成为这组能力共同前置。

### 2.10 recall

保持 workspace/user 召回和来源标注；suggested/dismissed/失效知识不当有效记忆，user.tdb 不存 event/文件。
补实际查询与管理消费者，不要求评测集。

## 阶段 3：检索、工作状态与线程

### 3.1 符号图

已有 file/defines/symbol 以及 `imports` / `connects` / `associates`（3.11 第 4 步）。读者是 explore 的路径级候选
（定义 / 连线另一端 / 反向 import，3.12）和 `related` 工具；摘录出边注解（D-108/D-112）仍在。
继续按实际查询建 `references` / 解析后的跨文件 `calls`，来源/版本明确，LSP `references` 不冒充调用图，也不和 `related` 抢活。
复用背压和按变化路径采集，未知语言/不可用不清最后图；不把全图或所有索引完成作为 explore 前置。
范围只从磁盘正文采集并逐文件记 document revision（D-087）；脏缓冲结果不入图。图只选路径，行号在当前正文里重新确认。

### 3.2 explore：正式默认工具

本节提供当前入口；新的查询与索引工作分别在 3.15/3.16 排期，行为契约以设计 6.1 为准（D-173–D-175）。

| 已有能力 | 下一步实际改动 |
| --- | --- |
| 自动 surface snapshot、Documents 当前正文、固定草稿的 read/grep/find/ls 与线程基线 | 语义覆盖沿同一来源（3.16D）；不另建读取权威 |
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

✓ 已接线（3.12）。工具回答文件级定义、import、反向 import 和连线另一端；没有与不完整分开表达。
不是 `lsp.references`，不做 PageRank / 多跳。store 未打开返回 `unavailable`，不开库。

### 3.4 工作状态、物化与生命周期

沿已交付 Thread/ThreadRun、catalog、角色冻结、异步 dispatch、blocks、传感器、真实 child 和 Fleet 扩展，不重建旧模型。
设计 9.2.5b 为完整行为边界，下列工作直接实施：

**A. 固定结果。** inspect/merge 选定 resultCommit 后，patch、新文件、二进制、链接和 mode 全从修订读取；snapshot 后 live
修改不混入，另发新结果。报告/测试绑定受检修订，输入变化不自动继承通过。此修复可先交付，原生存储随后用同一结果契约。

**B. 原生状态与迁移。** Host 建内容对象/路径树、固定基线与 delta/tombstone 分支头，结构共享、原子发布。结果/Integration
独立持有正文引用，复用恢复捕获与路径状态；恢复历史删除不丢线程结果。Git tree 可作基线来源，原生 capture/copy/CoW 支持
非 Git 和无首次 commit。初次采集有真实成本，普通消息不捕获全仓；监视器只作失效信号，变动中捕获重读或报告不完整。
从 Git base/resultCommit 导入或建立受保护来源引用，新正文/引用可读后原子切换 Thread；崩溃可重试，不长期双权威。
完成迁移清旧写路径，Git 留作后端/导出。覆盖读取失败、并发更新、迁移中断、对象保留与旧会话重开。

**C. 工具与草稿。** 同名 read/grep/find/ls/edit/write/apply_patch 读写固定 base+delta，父改动不串读，包括子未改路径。
用户消息自动取得草稿快照，来源/版本随分支保留；草稿集成走 Document Registry 的版本化编辑和 grouped undo，不隐式存盘。
原生 Pi 工具、LSP、扩展、shell 需要真实路径时 materialize 并切同一执行视图，不为无目录而禁用正常能力；shared 明示实时共享。

已交付的第一段是 dispatch 草稿基线：请求内复制固定正文与字节格式，Thread catalog 持有不可变 baseline id，queued/lost 恢复从持久
对象重建；有效草稿是 branch revision 0，不是 child delta。dirty 角色强制 isolated，来源不可用则 dispatch 失败。D-214 已把非草稿
路径改到 dispatch 创建分支时固定：Git 捕获工作目录身份与变化集，非 Git/unborn 做一次可取消目录捕获；失败删除 Thread。
父会话的同名 read 与 grep 已消费同一固定 surface snapshot；find/ls 已消费同一快照。surface 写回与绑定预览
已按 D-201 接入线程面板 / Document Registry。D-212 已把隔离 Thread Run 的同名只读工具接到 WorkingState 视图：delta 覆盖 base，
tombstone 隐藏路径，父 drift 不能补读，scope 仍由 Host 拒绝。D-213 / D-217 已把同名 edit/write/apply_patch 接到同一分支视图：虚拟写入
做 writeRevision CAS，不碰父磁盘；首次 bash/LSP 冻结修订、等在飞写入、staging 物化后原子切换。失败或取消后重读
execution view，仍虚拟则继续写分支；崩溃按 `materializationSwitch` 恢复到一个权威视图。修订标签等于实际读取的
`writeRevision`。嵌套改父虚拟分支走同一写 gate。
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

**F. 提示。** 路径重叠非阻塞，未知 shell 覆盖明示，不长期占编辑锁。合并预览绑定子结果与父相关路径/草稿版本，改变即失效，
接 integration/Zone 2/UI，不等全仓 WorkspaceHead 或收益 benchmark。实现与集成共用查询，不复制状态 authority。
预览查询不制造自身 Thread 更新循环；冲突提交消费旧预览的完整 binding，不在重取父正文后复用旧解决（D-203）。

对应验收：固定结果后 live 修改不混入；父改动不串读；子原地写不改父；setup/执行写回；ignored/后台 writer 不误回收；
原路径重建；跨清理/迁移引用；非 Git/无 HEAD；真实 Pi child 创建到执行、结果和重开。平台后端在相应机器验证，不要求所有
平台完成才启用已验证后端；这些是实施测试，不是决定要不要采用架构的研究门。

### 3.5 线程工具与 Integration

dispatch 立即返回 Thread，准备过程/失败可见；并发按现有配置背压。threads/wait/read_thread 增量、送达后推进、压缩重置，
wait 超时正常，send/用户输入可继续。kill 停执行保留结果，目录按 3.4 回收。

merge 以选定结果和父相关状态生成计划，过渡 Git 也只能用固定 commit。逐路径三方处理相同/未改、文本、删除/修改、
类型/链接/mode；文本可留标记，非文本给版本选择。无需父 clean 或用户 commit，不切分支、不改历史。
UI/agent 共用 operationId，重试与新结果分别处理。

接恢复逐路径 before/after、apply intent、核对、条件补偿；预期冲突保留现场，意外 I/O 部分失败补偿，后续用户修改不被覆盖。
结果明确 applied/conflict/compensated/needs-attention 并给已应用/冲突路径，不用 merged:0 暗示父完全未改。
冲突解决核对同一操作，不重放已写 patch。草稿在 surface 应用撤销，磁盘经 Host。原生路径集成不修改 index；旧 Git 结果先导入，
不继续使用写入 index 的 --3way。集成完成状态与父回合 checkpoint 的变更绑定同事务提交；不能把 process writer 注册等同于可撤销日志。
草稿执行复用 Documents owner 连接，绑定实例/代际/修订/哈希；正文与回执经认证通道。磁盘与 surface 在同一持久操作先记 intent，
确认后才完成，崩溃不明保留 needs-attention；撤销与条件补偿校验当前产物。agent 不依赖线程面板代为执行，UI 不自报裸路径完成（D-203）。
合并与验证分别记录；父对合并后状态做相关检查。结构感知优化沿合并策略实施，不把不同函数等同语义无冲突。

验证正常/冲突/部分失败/中断、幂等、父并发、草稿不存盘、index 后续修改和报告绑定；覆盖重叠区间、权限位、无效 UTF-8、日志提交失败
后重试、共享 catalog 工作区隔离，以及删除完成历史仍保留线程结果；用真实文件/Git 与现有 Pi E2E，
不要求新评测集。

### 3.6 角色与嵌套

protocol 统一目录/解析/团队提示；不加固定角色轮数/token 限制。check 可执行/生成文件，按任务选 shared/隔离，不称只读。
不用“纯编辑”标签阻止后来测试。`hard-implement` / `frontend` 角色目录含嵌套工具；Host 按冻结 allowlist 与
`control.thread` 装配，拒绝扩 scope 与未授权工具（D-215）。沿 `parent.kind: thread` 创建/等待/取消/删除/用量，
不加深度配额，复用既有并发排队。兄弟经父协调，不复制父完整对话。

### 3.7 自动 review

已有 review-sensor 已接到固定结果发布，使用 review 槽位（默认主模型），默认运行、不阻断，用户可关闭或显式设完成门
（D-207/D-210）。一轮以结果修订、review 线程和 review Run 的组合身份落盘；输入为固定 diff/任务/项目知识，不含父完整对话；
结论、失败和取消可见，带严重度/file:line 进 Zone 2。旧修订或迟到旧 Run 不标成当前已审；不等待 T4。

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

rail/overlay/时间线共用 session feed/SSE。接归档/独立恢复、结果修订、占用/保留原因和集成状态；重开按需物化，在原 Pi
session 继续，讨论转实现新分支/Run 保留 transcript。子消息不进父正文；未知占用不补零；新文案 i18n。
归档等待 Run 准备与真实执行退出，失败保留重试所需身份；恢复原 session 时创建并绑定新 Run。已结束或已回收的普通线程打开也先恢复，失败保留原生命周期。
回收持有写者屏障直到删除完成；同线程生命周期互斥，自动回收跳过忙目标；首次准备/恢复按工作区全局占用预留可知新增需求，慢 setup 不持工作区锁（D-204）。

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
5. **语言 ≥ 3 时：按需下载与设置页。** ✓ 常用语言随应用捆绑（TS/TSX/JS/JSON）。其余语言的「按需」是需求信号 + 用户在设置页点安装，
   **不是** Host 自动下载。仓库里没有 embedding 模型下载/同意管道（`openWorkspaceKnowledge` 一律 `embedding: null`）；听写本地模型下载
   没有摘要、取消或同意门，不能当先例。同意模型：明确动作即同意，不做弹窗，不做 `ask`/`always`/`never`（D-124）。
   发布期脚本从 npm 解出 wasm、自算 sha256、记录 ABI，清单提交进 git（D-125）。运行期下载到临时文件 → 算摘要 → 与清单比 →
   对上才写入 `{PIARIUM_DATA_DIR}/structure-grammars/sha256/<hex>.wasm`；对不上删除。带 `AbortController`，不做断点续传。
   解析顺序：先捆绑 `runtime/`，再下载目录（D-126）。ABI 闸门仍在 `loadLanguage`。设置「语言支持」页按工作区现算分布列出，
   每种两行状态（语言服务器 / 结构包）。用户自带 `.wasm` 走同一存储、标未验证、仍过 ABI 闸（D-123）。覆盖进度见 status（D-127）。
   **装上必须真的出轮廓**：按需语言取上游 `queries/tags.scm`，发布期用该包自己的 wasm 编译验证后连摘要一起记进清单，安装时同样按摘要校验；
   得到 `outline` + `classifyHits`，`literalCalls` / `imports` 仍需手写查询。上游没带查询的包装上只有解析器，界面须把这种状态与"能用"分开显示（D-128）。
   语法索引读不出来是 `unknown` 而不是"没装"，此时停用安装（D-129）。导入端点校验后缀与体积、不回传文件系统错误原文（D-130）。
   清单坏了退到空清单而不是起不来；解析期筛掉 ABI 超窗的包；刷新脚本默认按已提交版本复现（D-131）。

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
   同名闸门再访仍会重新解析（解析缓存 32 条），未修。

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

**B. 已接线（D-190 / D-194–D-195）。** 调用边界：Settings `harness.embedding` → Host `settings.get` 与 Pi binding describe（无密钥）→ 确认未配置才走本地 MiniLM；
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

工作区仍是包含陌生文件的范围，注意力只改变建设顺序。真实 provider 延迟、质量、成本和完整冷扫时间未观察。扩散模型/
后训练、全仓生成式摘要与零样本路由仍留后续。知识库语义召回已按 2.8 / D-196 单独接线，不与代码语义 MiniLM 回退混写。

### 3.17 bash 输出压缩：按命令分派（D-160 / D-197 / D-199）

已接线前四类：vitest、tsc、eslint、git。Host 在 `shell.exec` 与增量 `shell.read` 上整理默认 `display`，原文仍进
OutputStore / 后台 buffer；显式分页读原始字节。`tool_result` 只对实际取得 Host 整理结果的默认展示免于再次头尾切；旧 Host 未整理结果保留通用截断。
解析器只收起明确的成功/重复噪声，未知正文、pretty 诊断、失败位置、分片续文与提示保留。混合输出不能可靠归属时用通用展示；超预算保留可读首尾与省略事实，不能只剩提示。
其余三层
（包管理器通配、声明式规则、附加模型总结）未做。**不用小模型总结替代**（漏一个失败是静默的）；模型总结只作非结构化输出上的附加，
且要明确标注"这是模型挑的行，不是全部"。

## 阶段 3b：权限与插件

T2 已交付，插件 session-keyed service 独占提示，缺席才 Harness fallback；Host 只验身份/能力/路径。这是实际能力范围决定
的共存，不是暂不开原生能力。Smart 走配置的 permissionJudge；插件活跃走其公开 authorizerChain。

原生权限按具体能力推进，替换时覆盖实际 Bash/路径/MCP/skill/子会话/审计消费者，不能只接 Harness 却删除其他保护。
已有授权内无需重复形式审批，不静默降低用户权限或给未启用 authorizer 授权。测一次提示、跨会话/卸载、workspace 只收紧、
高风险规则，不机械重复全量权限复审。

## 阶段 4–6

- 默认 runtime：直接交付 bundled Pi、Runtime Manager 默认选择与 Git Bash 就绪说明，保留自有 runtime；实际 Electron smoke。
  已有版本依赖明确，不等 harness 全部完成。
- 外部 runtime：按实际 Host 服务接 MCP/ACP/能力协商，选定 adapter 的协议版本在实现中完成，不先预建全部未来兼容框架。
- research/文件知识工作：沿共享工具、存储、文档、验证器做文献/PDF/引用/notebook；按实际用途交付。第二个 profile 发展公共
  接口，不是允许建接口的前置。SaaS 连接器与 Windows 沙箱保持范围之外。

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
