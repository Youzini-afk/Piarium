# Agent harness 实施计划

Status: active execution plan; accepted capabilities ship as usable defaults (D-078)

Last updated: 2026-09-07

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
| 真 Pi 测试 | packages/pi-host/test/harness/session-e2e.test.ts；Host thread-runtime-session.e2e.test.ts |

### 0.7 当前顺序与交付方式（D-078）

P0、T1/T2/T3 核心与 D-076 已交付，不重开宽泛 P0。以下是整合建议，不是全部串行等待链：

1. **工作状态与集成（3.4/3.5，核心已交付）**：固定结果读取、原生结果、可撤销集成、Git/非 Git 物化、安全回收以及 dispatch
   草稿基线已进入生产链；虚拟分支工具、surface 写回、空间总预算和归档产品面随对应消费者继续。
2. **默认记忆与配置（2.4/2.6，D-081 已交付）**：默认 `takeover`、旧设置迁移、实时全局/单会话模式、失败投影，以及 entry/
   分支/block 修订绑定的逐次接管已接线；证据不足或 Host 重启时仅本次回到 Pi。`record-only` 仍非前置。
3. **当前：窗口读取与 explore（3.2）**：自动消息来源、固定 dirty snapshot、draft-aware explore/grep/read/find/ls、线程草稿基线、
   写入失效与写入守卫（D-088/D-089）、语言服务视图隔离与符号修订（D-087）已接。D-090 第一组与 D-092（候选广度按文件铺开及同批小项）已实施。
   3.11 第 1–5 步已接（结构接口 + LSP outline、冷启动对照、web-tree-sitter TS/TSX/JS/JSON、连接边/冷目录/`imports`、
   语言支持设置页与可验证按需下载，其中按需语言经上游 `tags.scm` 适配器真出轮廓，D-091/D-093–D-132）。下一步按观察到的"找不到入口"决定词法索引/桥接/embedding。缺可选来源仍返回已有正文，不等
   全图/向量/索引/BM25 基线；模型增强按槽位与缺口接入。
4. **其余产品面**：知识管理、embedding、自动 review、归档/恢复、terminal runtime、bundled Pi 按实际依赖交付；重叠提示与
   合并预览随线程服务实现，不设独立收益审批。

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

阶段 1 待做：shell 接 terminal runtime/终端 tab；apply_patch 多文件恢复真会话证据；平台 shell 与 Electron 打包验证。
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

人工标记和 memory decisions 已接。继续 suggestions 槽位的用户消息提议、Settings 全量列表/取代链，完成启用；未配走已有
无模型路径。编辑/接受同队列 CAS、同 scope 预检后提交，旧历史保留。自动接受仍按用户显式 scope 设置。
验证实际 route/UI、跨 scope 身份、并发/取代；再生成失败不能丢旧建议。

### 2.8 embedding

接已有 provider adapter 到 Settings、凭据和 Store，覆盖设计中的远端/OpenAI 兼容端点；校验维度，新代重算完再发布，失败
保留旧代。未配 embedding 的稀疏路径正常提供。用户配置时说明传输与费用，已授权使用不重复询问。
fake HTTP 验证契约/错误，实际代际/native 按消费者验证；选装本地模型不阻塞远端能力。

### 2.9 模型槽位与执行配置

protocol 统一解析，真实 provider 目录预设只填空槽；只有 hardImplement/review 默认主模型。保留模型选择和执行身份，
取消辅助模型分项统计（D-080）；子线程按 ThreadRun 记录。单会话覆盖不放宽 workspace 权限、不改模型凭据，显示实际装配。
完整 RunManifest 按这些消费者收敛，不作为所有功能共同前置。

### 2.10 recall

保持 workspace/user 召回和来源标注；suggested/dismissed/失效知识不当有效记忆，user.tdb 不存 event/文件。
补实际查询与管理消费者，不要求评测集。

## 阶段 3：检索、工作状态与线程

### 3.1 符号图

已有 file/defines/symbol。继续按实际查询建 references/imports/calls，来源/版本明确，LSP references 不冒充调用图。
复用背压和按变化路径采集，未知语言/不可用不清最后图；不把全图或所有索引完成作为 explore 前置。
范围只从磁盘正文采集并逐文件记 document revision（D-087，随 3.8 第 6 步交付）；脏缓冲结果不入图，消费者据修订判断范围是否仍成立。

### 3.2 explore：正式默认工具

设计 6.1 的 Coordinator/Engine/surface 所有权保持。`explore` 工具、磁盘纵切和 D-082 的自动 surface snapshot 已进入生产链；
剩余来源沿同一版本与授权边界扩展：

| 环节 | 实施 |
| --- | --- |
| 来源 | ✓ UI prompt/steer/follow-up 自动捕获全部 dirty records，正文走 Documents、runtime 只带 ref；失败保留 dirty paths，headless 读磁盘；explore/grep/同名 read/find/ls 消费固定来源，dispatch 已把固定草稿复制进持久隔离线程基线。观察到写入后该路径的草稿失效、全部消费者回到磁盘（D-088）；shell 与外部写入仍未观察 |
| seed | ✓ Unicode 标识符、引号字面量与连续中文分词；✓ `explore.search` `anchors?: string[]`（protocol、pi-host 工具 schema 与描述、Host seed），锚点优先取候选、独立预算、字面匹配、非硬过滤；**待做**：继续补路径、错误/栈帧的类型化提取（D-090） |
| 候选获取与物化 | ✓ D-090 缺陷 2–8 与 `anchors`；✓ D-092 候选广度按文件轮转分配（30 文件×12 命中、预算 200 时 30 个文件都进候选，总命中 ≤ 预算；文件数超过预算才丢文件并报 `filesDropped`；grep 深度优先截断不变）。同批小项：句柄提示计入字节预算、返回对象只含协议字段、空白 anchor 过滤、`rgSearch` 局部 partial、`fileScore` 每文件一次、候选排序加权组数。验收复验又补两项：`filesDropped` 跨词项与重叠搜索根不求和，取单次查询最大值作下界、正文说"至少"（原实现两处相加会虚报去重后的文件数）；pi-host 工具 schema 不再给 anchor 元素加 `minLength`，与 Host 的"接受并过滤空白"同口径（原实现两层口径相反，`""` 撞 schema 而 `"  "` 被优雅过滤）。覆盖：`explore.test.ts` T1/T3–T8 与 filesDropped/空白 anchor/加权排序、`explore-service.test.ts` T2/T8（含 `showHandle` 为真时的字节预算）与空白 anchor、`search-service.test.ts` 广度优先与 `filesDropped`、`explore-tool.test.ts` / `session-e2e.test.ts` T9。✓ 结构切片消费 6.4 / tree-sitter 带修订范围（D-091 第 1、3 步；小/大阈值 D-093，协议字段 D-094） |
| 召回/展开 | rg 经 search-service 单一路径（✓ D-090）、按种子文件选择 LSP、符号图（✓ TS/TSX defines/`imports`/`connects`/`associates`，explore 读摘录路径出边，D-108）、配置的向量；注册点/协议字面量/配置键/事件名作为连接点，从可靠识别的调用/注册形状取证、同名字符串标关联候选（形状识别由 tree-sitter 承担并写入图）；定义/引用/测试配对/co-change 按可用性接入，派生路径重新授权 |
| 版本与融合 | 按来源重读与问题相关、尽可能自包含的原文单元（容器：小函数全文，大函数签名 + 命中语法块 + 省略标记 + 完整读取入口；普通值绑定切所属函数/类，D-098），位置匹配版本；结构来源为带修订绑定的可插拔 provider（3.11），生产顺序 tree-sitter → LSP（D-097），`empty`/覆盖缺口可问后续但 `warmOnly` 不冷启动 LSP（D-099），缺时退行窗口；命中分类只打已物化窗口分（D-095）；RRF 融合保留来源，不用分差当置信度 |
| 打包 | 内部找全、外部只给支撑判断的材料；目标与所需支撑组成 bundle，支撑可空，省略说明；歧义返回区分依据；字节预算在 explore 内落实（✓ D-090）；真实 OutputStore 与 UTF-8 分页 |
| 模型 | pi-host 使用 models.explore；按"当前缺的那一步"选一种：无仓库词汇 → intent，目标缺席 → 受限修复（须能提新词项/入口），候选多 → 比较；intent 可并行，judge 等正文，修复仅类型化搜索/导航；无槽位零模型调用 |
| 上下文 | 同 revision/span 仍在实际请求才省正文；无覆盖表或压缩后未知时返回正文 |
| 注册 | 可用来源、正文、授权、句柄和工具链通过相关验证即默认注册，不等所有增强或独立评测 |

现有来源是 search.content、Documents disk、固定 surface draft、需代表文件选语言的 LSP 导航、file/defines 图。surface snapshot 已能
替换 explore/grep 的 dirty path 磁盘命中，由同名 read 返回固定正文，并为同名 find/ls 提供固定文件与虚拟目录；线程基线也消费同一来源。
视图隔离与修订绑定已按 3.8（D-087）完成；D-090 候选获取/物化与 `anchors` 已实施，结构切片已按 3.11 第 1、3 步接入，连接边与
TS/TSX 冷目录已按第 4 步写入同一张图并由 `explore.search` 读出。贯穿验收例子是
`explore.search` 的 worker—protocol—Host 链——主 agent 能否从一次结果看见这条链，而不是"多了一个 symbols 调用"。related、co-change、
测试配对、embedding 各自推进；仓库级词法索引仍等观察到"找不到入口"再定。冷目录不是全语言覆盖。
每来源保留 not-requested/ready/empty/unavailable/failed/
stale/timed-out/cancelled，不能压成空成功。模型结局与 used/ignored 分开，迟到成功不伪报超时；不新增分项费用看板。
Host 计字节，只有真实 tokenizer 才报精确 token。复用服务预算，不加固定候选数/轮数/时间门槛。

已验证中文/Unicode 词项、磁盘与草稿正文/revision、dirty-only 新词、草稿删除旧磁盘词、后续编辑不污染、session/workspace/scope、
捕获失败、分页句柄和 Pi 真调用链。结构 range/version、冷 LSP 下的 tree-sitter 切片、命中分类与解析取消/预算已接。继续补多窗口
来源切换及可选模型失败。缺可选来源不禁整个工具，不建议不存在的 retrieval 角色。

实际遇到召回/时延问题再用固定 query/版本/目标 span/支撑比较 grep、BM25 和 explore，保存相同预算下实际返回包。
不从答案生成查询，不把后续 edit/read 当唯一相关性标签。evaluation/retrieval 与新 runner 非必建交付物，T4 非注册门槛。
先记反馈，不从有偏隐式标签自动改权重。

### 3.3 related

接现有 helper 到真实 KnowledgeStore 节点/边与 worker 工具，返回关系/来源/版本，缺关系明确说明。
有可用关系就注册，不等 PageRank/完整调用图，继续优化是正常迭代。

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
对象重建；有效草稿是 branch revision 0，不是 child delta。dirty 角色强制 isolated，来源不可用则 dispatch 失败。当前非草稿路径仍
在 Run 启动时捕获。父会话的同名 read 与 grep 已消费同一固定 surface snapshot；find/ls、surface 写回、无目录 branch 工具和整仓
dispatch 快照尚未交付。

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
合并与验证分别记录；父对合并后状态做相关检查。结构感知优化沿合并策略实施，不把不同函数等同语义无冲突。

验证正常/冲突/部分失败/中断、幂等、父并发、草稿不存盘、index 后续修改和报告绑定；覆盖重叠区间、权限位、无效 UTF-8、日志提交失败
后重试、共享 catalog 工作区隔离，以及删除完成历史仍保留线程结果；用真实文件/Git 与现有 Pi E2E，
不要求新评测集。

### 3.6 角色与嵌套

protocol 统一目录/解析/团队提示；不加固定角色轮数/token 限制。check 可执行/生成文件，按任务选 shared/隔离，不称只读。
不用“纯编辑”标签阻止后来测试。子 allowlist 当前无 dispatch；沿 parent.kind:thread 接嵌套创建/等待/取消/删除/用量，
接通按角色配置提供，不加深度配额。兄弟经父协调，不复制父完整对话，权限来自工具装配而非提示词。

### 3.7 自动 review

接已有 review-sensor 到 agent_settled 和真实结果 diff/修订，使用 review 槽位（默认主模型），默认运行、不阻断，用户可关闭
或显式设完成门。同结果去重，输入为 diff/任务/项目知识，不含父完整对话；结论和失败可见，带严重度/file:line 进 Zone 2。
旧修订审阅不标成当前已审；链路测试通过直接启用，不等 T4。

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
