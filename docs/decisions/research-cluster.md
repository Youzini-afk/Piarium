# 决策分卷：科研集群

范围：AI4S 的产品中心、工作台与工作侧重、异构模型协作、研究分支调度与科研运行时接缝。

本卷是 [agent-harness-decisions.md](../agent-harness-decisions.md) 的分卷；条目只追加，索引状态以总索引为准。

### D-291 · 2026-09-19 · research profile / AI4S

类型：默认值调整

背景：原 research profile 草案把文献、PDF、引用、notebook 和 `paper/claim/citation/experiment` 节点放在产品中心，并采用分钟级、人在环、带检查点的半自主研究。这会把科研做成资料和记录管理，忽略问题发现、综合思考、快速实践和并行探索。用户明确提出由强模型做问题发现与综合、较强模型做实验设计、快速模型做实现和监查，并通过子线程形成研究集群。

决定：

1. Piarium AI4S 的产品中心是“异构模型科研集群”：一条首席研究主线持续推进整体问题，多个 Thread 代表独立研究分支，Run 冻结当次模型、工具、权限、范围、输入和工作状态。
2. 模型按能力路由而非固定型号或永久职业：`frontier-reasoning` 负责问题发现和综合，`deep-design` 负责深读与实验设计，`high-throughput-execution` / `fast-exploration` 负责实现、批量分析和局部变体，`critical-review` 与 `scientific-writing` 按影响和缺口触发。分支可动态升级、降级和换模型；快速模型也可以参与假设和反例生成。
3. 研究循环是动态分叉、低成本区分、真实执行、事件触发综合和下一轮重分配。Host 调度器负责模型/CPU/GPU/数据资源，首席模型负责科学方向和投入优先级；普通批处理、进程监控和日志整理不启动 Agent。
4. 线程树只表示执行责任、生命周期和资源归属。研究发现通过引用和定向消息跨分支复用，不再建设一套与 Thread 树平行的强制研究图。分支交接由 Host 自动生成新发现、影响、依据、替代解释和下一步，不要求用户填写表单。
5. 证据、版本、运行、产物和可复现信息是集群的内部事实基础，不是用户的前置流程。研究状态是可重建视图；来源、运行结果和文件修订保留原始权威。证据表、实验协议、Research Diff 和文章结构按需生成。
6. 写作线从研究中途参与，持续发现主张缺口并回流新的检索或实验任务。首个纵切选择开放的计算研究问题，验证“并行问题发现 → 实验设计 → 快速执行 → 强模型综合 → 下一轮”的研究推进闭环；论文复现只是一个场景，不定义整个 Profile。
7. 通用内核只提供研究动作、分支、调度、来源、运行和产物接缝；领域 Profile 通过材料连接器、工具、模拟器、指标、验证器和写作模板扩展。第一阶段从代码、数据和计算实验开始，不预建全领域数据库、实验室系统、自有基础模型或第二套 Agent runtime。

原因：科学价值来自减少未知和形成可行动的新理解，而不是记录数量。把强模型固定为主管、快模型固定为工人会浪费模型能力；把所有实验一次性展开会制造重复和资源浪费；把严谨性放在用户流程前面会形成科研管理表单。现有 Thread/Run、WorkingState、检索、上下文、权限和 Rust kernel 已经提供了实现集群的基础，不应再造平行生命周期。

考虑过的替代：

- 固定“强模型思考 → 中模型设计 → 快模型执行”的流水线：不采用，研究分支需要按结果动态升级，快速模型也能提供局部假设和反例。
- 先建设论文/证据/实验数据库和完整科研工作流：不采用，结构应从实际研究循环中自动生成，避免把研究者变成记录维护者。
- 一次性展开假设×方法×条件的完整矩阵：不采用，先用低成本区分行动动态分配资源，保留独特但早期信号弱的路线。
- 为科研再建一个 Agent runtime、工作图或存储后端：不采用，复用 Pi、Thread/Run、Host 和 Rust kernel；研究关系通过引用和现有结果交付表达。
- 普通运行也持续唤醒模型监查：不采用，进程事件和指标由程序处理，异常、冲突和关键结果才触发模型。

影响：新增 [research-cluster-design.md](../research-cluster-design.md)；更新 `agent-harness.md` 的 research profile、`agent-harness-plan.md` 的后续领域顺序、`roadmap.md` 的 research 条目与 `agent-harness-status.md` 的未接线说明。后续实现使用现有 `dispatch` / `send` / `wait` / `read_thread` / WorkingState / Rust kernel 接缝；本条不宣称任何生产代码已接线。

状态：已接受设计；待实施。

### D-297 · 2026-09-19 · 工作台 UIUX 与 Agent 工作侧重独立

类型：产品交互与执行配置边界

背景：D-291 的 research Profile 同时被用于描述研究行为和界面，实施计划没有明确入口与切换语义。
讨论中曾提出把科研与 Agent/IDE 作为绑定执行行为的互斥模式、为左侧增加独立“研究”入口，或由项目选择科研界面。
这些形式会把 UIUX 与任务混在一起，使切入 IDE、浏览项目或打开对话改变研究环境。用户明确要求：在现有 Agent/IDE
切换区域增加整体工作台入口，播放既有切换动画；项目和对话另行选择影响提示词与工具组织的工作侧重，未来办公同样适用。

决定：

1. **工作台 UIUX 与工作侧重有不同身份。** Workbench Profile 管理完整 Shell、导航、布局、操作与动画；
   Agent Profile 的用户可见名称为“工作侧重”，管理提示词、默认激活能力、工具组织、上下文和协作方式。
   不再用未限定的 research Profile 同时指代两者。
2. **入口位于现有 Agent/IDE 切换区域。** 科研与未来办公复用现有工作台、贡献点、Transition Scene 与选择事务，
   不放进项目选择菜单，不另建研究中心或平行会话库。用户主动切换整套 UIUX；打开项目/对话、改变侧重不自动切 Shell。
   7A 调整当前 workspace 优先的所选 Profile 解析，项目仍可保留面板/编辑器布局，不能覆盖当前工作台。
3. **新对话捕获默认，已有对话独立。** 对话显式选择优先，其次是创建时的项目默认，最后沿用现有通用/编程默认。
   工作台类型不参与解析；项目默认改变不回写已有对话。对话显示当前侧重及待应用选择，允许手动覆盖。
4. **配置切换与执行生命周期分开。** 对话侧重变更从下一轮用户请求沿 Run/worker 安全切点应用；在途 Run 与已派发分支
   保持冻结配置，新配置失败保留原配置。切 UIUX 不应用 Agent 配置、不调用模型、不派发任务；切侧重不删除成果或隐式取消分支。
5. **跨组合保持可用。** IDE 是完整开发环境，能够继续科研任务；科研工作台能够处理普通编程对话，办公工作台与侧重
   后续沿同一边界发展。工具调用不以科研 Shell 挂载为前置，研究界面只消费实际 Thread/Run/Artifact，不为填充面板生成任务。
6. **复用既有权威。** 工作台、项目设置、会话配置、Run、Documents、编辑器、进程和对象各守原责任；研究主线在切换后
   继续使用同一身份和成果。7A 交付独立入口、基础科研工作台与根主线，7B–7E 逐步接入分支、实验、综合和写作视图，
   不以办公完整实现或新的通用 Profile 框架为前置。

原因：科研同时需要讨论、检索、计算、编码和写作。让用户选择适合当前操作的 UIUX，并另行指定 Agent 工作方式，
才能在同一项目和同一任务中使用这些能力；界面导航不应成为修改执行配置的隐式动作。

影响：[research-cluster-design.md](../research-cluster-design.md) 第 10 节；[agent-harness.md](../agent-harness.md)
第 10 节；[agent-harness-plan.md](../agent-harness-plan.md) 阶段 7；[composable-workbench.md](../composable-workbench.md)
选择语义；architecture、roadmap、status 与决策索引。D-291 正文保留；本条补齐其产品形态与独立绑定。

状态：设计已在 D-298 的 7A 中实现；异构能力路由、调度、实验和写作仍按 7B–7F 继续实施。

### D-298 · 2026-09-19 · AI4S 7A：独立工作台与真实研究主线

类型：产品入口与执行身份

决定：

1. 增加第一方 `piarium.research` Shell，复用已有 Profile 切换事务、动画和共享窗口/导航/资源框架。
   删除 workspace Profile selection 的持久字段与写者，项目只保留布局。科研展示从既有 Thread 投影读取主线与分支，
   不从原生 Pi session 的 fork 关系猜测科研分支，不为展示而创建任务。
2. 工作侧重使用独立的 `code`/`research` 执行配置。项目条目保存新对话默认，broker 的 session metadata 保存
   创建时捕获的来源及 selected/active/generation。运行中只修改待应用选择；新 Run 启动前 stage worker、提交
   durable metadata 再发布，失败保留原 active。当前 Run 的 steer/followUp 属于同一次执行，保持其冻结侧重。
3. 科研主线直接使用用户当前 Pi 会话与模型。实际 agent_start 附着一个 `purpose: research-root` Thread 与新 Run，
   实际 settle 写报告和原文引用；不会额外启动主模型会话。普通分支仍使用原 ThreadRuntime 和原生 Pi 子会话。
4. Run/session binding 显式区分 `attached-root` 与 `spawned-child`。主线结束解绑不留子会话 tombstone，lost 不自动
   作为子任务重启，删除 Thread 不删其附着的用户会话；主会话删除仍沿其自己的 broker 生命周期处理。
   用户在主线运行中或结束后均能以 user 身份操作其研究分支。
5. 本阶段保持现有模型选择和工具授权。异构 capability 路由、研究更新与调度、实验/产物组织、综合写作和质量验证
   按 7B–7F 实施。通用侧重仍可使用已有工具；科研侧重不扩大权限，不限制在科研 Shell 内执行。

持久格式：Thread catalog 使用 schema 10，session-binding 索引使用 schema 2；不引入旧内部格式迁移或双写。
原生 Pi JSONL、用户工作区文件与项目资产不改写。工作台选择与 session work focus 各守既有权威。

状态：7A 已实现并接线；本地验证与未实测边界见 [status](../agent-harness-status.md)。7B–7F 未宣称交付。

### D-299 · 2026-09-19 · AI4S 7B 第一段：能力路由与冻结分支

类型：研究分支执行配置

决定：

1. `thread.dispatch` 可声明 `investigation`、`experimental-design`、`fast-exploration` 或
   `high-throughput-execution`。每种能力有独立模型槽位、工具集合、系统提示片段和默认资源请求；
   用户可在 dispatch 时补充 CPU/GPU/network/long-running 请求。
2. 能力槽位未配置时，dispatch 返回 `unavailable`，不静默使用主模型。能力分支只能从科研工作侧重的主线派出，
   工具仍受父 Run 冻结 allowlist 约束。分支的 `research` manifest 进入 Thread/Run durable projection，资源请求暂时只冻结记录，
   不在本段偷偷实现调度器。
3. 能力分支沿既有 WorkingState/Thread/Run 和 Pi 子会话执行；隔离执行能力使用 isolated WorkingState，
   调查/设计/快速探索默认只读。7B 后续再接动态模型升级、同 Thread 新 Run、资源等待和结果交接。

原因：先让不同能力真正进入已有 Thread/Run 生命周期，才能在同一权限、工作状态和恢复边界内观察并行研究；
预先建设一套独立的研究调度平台会把能力声明和实际执行再次分离。

状态：7B 第一段已实现并接线；完整 7B 及 7C–7F 仍为后续阶段。
