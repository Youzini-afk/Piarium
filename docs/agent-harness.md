# Piarium agent harness

Status: design accepted; D-284–D-286 are implemented and independently corrected by D-287; delivery facts are in agent-harness-status.md

Last updated: 2026-09-19

正文为中文。English readers: this document specifies the Piarium-owned agent harness (tools, retrieval,
knowledge store, context and cache contract, verification, profiles) layered on the Pi agent kernel.
Section 4 of [architecture.md](architecture.md) gives the process model this document extends.

本文档是**边界**。哪项能力做到了哪一级（implemented / wired / proven / default-on）看
[agent-harness-status.md](agent-harness-status.md)；未完成的纵切与实施规则看 [agent-harness-plan.md](agent-harness-plan.md)；
每个偏离的理由看 [agent-harness-decisions.md](agent-harness-decisions.md)——日志不是规格，被采纳的决定都已回写到本文。

D-284 将上下文管理改为容量驱动的后台摘要准备与按需切换，保留前台无明显整理停顿的目标，已实施：持续 keeper /
takeover 已删除，新链按 2.4A/B、2.6A/B 接线并经真 Pi+faux 纵切验证，当前事实见 status。
D-285 接受以工作为中心的可续做线程、可选预设、定向通信与分段成果；D-286 补齐整套上下文原则及“工作可延续、上下文可重建”。
D-287 已按真实 Pi/Host/Rust 消费者验收并修正上下文收据、Run 准入、消息提交边界和物化 baseline handoff；证据见 status 与验收记录。

D-292 的全仓工程阶段 Q：[测试与 CI 体系重整](testing-ci-design.md) 与 D-296 的旧伴侧插件清理已完成。
D-297 明确下一阶段 AI4S 的工作台 UIUX 与 Agent 工作侧重独立，设计见第 10 节；科研能力尚待实施，顺序见 plan。

## 1. 决定

Piarium 不再只是 Pi 的图形外围。产品由两部分组成：**工作台**（已交付：文档权威、编辑器内核、
恢复、多端、可组合 Shell）和 **harness**（本文档）。Pi 继续作为 **agent 内核**：模型/provider 栈、
会话树、包管理、扩展模型、内置工具的默认实现。这是发行版模型——内核来自上游，userland 由
Piarium 拥有、调优、默认提供，且每一块都可以被用户替换。

决定 harness 质量的四件事——工具环境、检索、上下文管理、验证——全部收回到 Piarium 拥有的代码
里。D-282 已完成 D-252 定义的 Rust 系统内核阶段：文件/资源/持久事务、物化、受管进程/PTY 与文件/结构计算由
Application Host 的私有 Rust 子进程接管，TS 保留产品和 Agent 策略，Pi 继续内置。完整边界和实际性能证据见
[rust-kernel-design.md](rust-kernel-design.md) 与 status；不从实现语言外推未测平台或统一提速倍数。

### 1.1 非目标

- 不重写 agent loop、模型抽象或会话存储。Pi 的 `pi-ai` / `pi-agent-core` / `pi-coding-agent` 保持
  为运行时内核。
- 不在"谁的模型更聪明"上竞争。harness 放大模型能力，不替代它。
- 不为第三方 Pi 扩展的上下文注入行为提供归因、节流或代管。第三方扩展在本契约之外；本契约只约束
  Piarium 拥有的组件。
- 按已确定的领域用途建设共享接缝，不预建没有消费者的完整框架；不以第二个 profile 是否已经上线决定能否实施接口。
- 不把插件配置页、Pi 包管理或恢复权威并入 harness。它们保持
  [architecture.md](architecture.md) 记录的归属。

### 1.2 借鉴来源与取舍

本设计的机制来自已在生产中验证的 harness：Claude Code 的分层压缩、工具结果预算、`cache_edits`
微压缩与 `<system-reminder>` 尾部附着；Cognition 的 Fast Context 检索子 agent（专用小模型、并行
工具调用、轮数上限、窄工具集）、Devin Fusion 的压缩时刻换模型、"写单线程、其他 agent 只贡献智力"
的多 agent 原则、Devbox Blueprint 的环境确定性；Manus 团队围绕 KV 缓存的上下文工程原则；Aider
repo map 的符号引用图 PageRank。Piarium 不复制它们的实现，只采纳经过验证的形状，并利用自己独有
的资产：host 拥有的 LSP、Document Registry、终端子系统、恢复日志，以及 TriviumDB 嵌入式知识层。

### 1.3 交付政策：正式实施，完成即默认提供（D-078）

本项目处于早期，正式设计中的能力直接推进实现。接通真实使用路径、通过与改动风险相称的正确性验证并能诊断失败后，随交付默认
提供；不再先挂长期 candidate/shadow 标签，也不要求独立回放集、配对实验或测试者报告才能使用。质量、延迟和成本在真实使用中
持续改进，发现具体错误修对应路径，不把局部问题扩张成整项能力禁用。

执行者可以为正式目标调整持久格式、数据 authority、协议与默认值，并更新全部消费者。当前没有用户兼容需求，
旧 Piarium 内部格式可直接清除重建；不做旧格式升级导入、双读双写或旧后端 fallback，替换完成即删除旧实现（D-253）。
工作区/Git、原生 Pi 数据及外部配置照常保全，不以“再加一个消费者”或完整通用框架作为前置。

默认提供与用户选择分开：已有显式关闭、模型槽位、凭据、持久知识审阅和权限策略保持有效。缺真实服务、缺配置、版本冲突或压缩
来源不足时，只处理对应请求并说明原因。fallback 是这些具体情形的运行行为，不是把新架构永久放在旧实现后面的交付策略。
本次修改的是设计政策；当前代码仍然关闭或未接线的能力如实记录在 status，不能靠改文档把它们标成已启用。

## 2. 已确定的决策

以下决定已经固定，改动它们需要先改这张表：

| 主题 | 决定 |
| --- | --- |
| 产品边界 | Piarium = 工作台 + harness；Pi = agent 内核；其他 agent 是能力协商的 bring-your-own runtime |
| 系统内核 | 阶段 R 已由 D-282 完成：Rust 系统内核 + TS Application Host/产品与 Agent 编排 + 内置 Node/Pi worker；每类系统资源只有一个生产权威，不保留双写、shadow 或旧后端 fallback |
| harness 形态 | 通用内核 + 领域 profile；不是每个领域一套 harness |
| profile 作用域 | Workbench Profile 属于 surface 展示；Agent Profile 属于执行配置。工具与 system 在同一执行配置世代内冻结；同一持久 Pi session 可经用户操作进入新 Run/配置世代，切工作台布局不改变执行配置（D-063/D-072） |
| 工具注入 | 与 Pi 内置工具**同名覆盖**，不并列；覆盖发生在 pi-host 进程内 |
| 重活归属 | Host 服务保持统一入口；工作状态/磁盘恢复/物化、PTY/受管进程、文件与结构计算位于私有 Rust 内核。TS 保留知识库 adapter、LSP 协议/视图、结果呈现与策略；pi-host 保留模型调用、薄工具和钩子 |
| worker→host 通道 | 类型化协议请求（`@piarium/protocol`），沿 `workspace.mutation.request` 先例；worker 不持有 host 凭据、不直接打 HTTP |
| 检索分层 | 精确匹配用 grep；快速发现和原文获取用 explore；开放事实追踪用 retrieval。文件/结构/索引操作归 Host，较长语义判断归 agent，持久记忆检索归知识库；三种工具不要求逐级失败后才可使用（D-173） |
| 知识库 | 优先保留 TriviumDB 嵌入式，每 host 每 workspace 一个 `.tdb`；Application Host 是唯一写者。TriviumDB 非不可替换依赖，具体问题先交用户联系作者处理；当前不迁移 SQLite、不建双写权威（D-071） |
| embedding | 后端可替换，远程接入独立于重排。`harness.embedding` / `harness.rerank` 是用户所有的配置种类，不是聊天模型槽位。未配置远程且用户已安装本地组件时代码语义走 MiniLM，否则语义来源不可用，词法与结构/图检索继续（D-288）；配置有效即按同一 vector space 索引与查询。知识库仍可无向量。来源身份、用途、编码文本与维度决定向量复用，后台建设和查询分别调度；不从模型体积推断速度或跨语言质量（D-173/D-190） |
| shell 形态 | PTY（复用终端运行时，后台 shell 即终端 tab）；持久会话 shell 保持 cwd / env / venv；stdin 开放且 harness 永不代写；等默认时长后**自动转后台**而非超时杀死；配套 `get_output` / `write_to_process` / `kill_shell`（Devin CLI 与 Codex `unified_exec` 的共同形状）；Git Bash 为默认解释器但 Windows 原生工具可从中调用 |
| 工具并发 | D-305 已把 D-302 / 7H 接入真实 Pi 执行入口：按权限确认后的资源读写关系排序，独立工具并行，未知副作用保留屏障；写入仍经过 Host authority，不做 apply model（5.9） |
| shell 环境 | 解释器按工作区环境选定（原生 Windows → Git Bash，WSL → wsl bash，远程 → 远端 shell），用户可覆盖，模型不按次选；login shell 继承用户工具链；环境变量只改交互与显示，**不设 `CI=1`**，locale 探测不硬编码 |
| web | harness 自做 `webfetch` / `websearch`，参照 `pi-web-access` 能力清单原生实现（来源面板、凭据进 Pi auth、独立浏览器 profile、GitHub 走 octokit）；SSRF 复用 security.md；跨域重定向不跟随；搜索默认走 Exa/Parallel 免密钥服务，用户自配 API provider 优先，不复用模型账户（D-289）；桌面端 Electron 离屏渲染 JS。provider / render / domain policy 按 worker generation 冻结，credential 每次调用实时解析；第三方包存在不会自动替换原生工具（D-283） |
| 模型与预设 | 普通线程明确继承当前模型，不要求 role。专用能力/预设沿现有独立槽位或明示的 inherit 解析，未配置不冒充可用；hardImplement/review 的当前模型继承明确展示。续接摘要沿活动请求派生，不新增凭据栈或费用面板（D-284/D-285） |
| 可关可换 | 每项 harness 能力的关闭行为明确；默认不按插件存在与否偷偷改变行为，同名第三方工具替换必须由用户显式关闭原生工具。设置按**字段所有权**决定用户级与工作区级谁说了算（第 5.10 节），能力可用性由 host 注入。自动压缩沿 Pi 开关，后台准备可由用户关闭；两者与长期知识策略分开，不再暴露 keeper 三态 |
| 编辑格式 | 跟模型家族走：`edit`（str_replace）与 `apply_patch`（Codex 语法）并存，按会话模型启用；两者走同一 mutation boundary |
| OS 沙箱 | Windows 沙箱不在交付计划中（用户选择，D-071）；macOS/Linux 留作后续候选。现有权限与路径边界保持，不把工具限制或 worktree 称为 OS 隔离 |
| 缓存契约 | Zone 0 会话内冻结；Zone 1 只追加、序列化确定；所有前缀失效操作批处理到压缩时刻 |
| 工作状态归属 | 主 agent 对上下文维护零义务；plan/todo 与用户笔记保持自身所有权，Host 维护事实，Pi 会话历史保持原文。后台摘要只产出固定历史区间的续接表示，不编辑工作块、计划或知识库（D-284） |
| 压缩 | 接近容量时后台准备一次摘要，前台继续追加；真正需要空间时沿 Pi 安全切点切换到新摘要与保留原文。候选绑定被收束的历史前缀，正常新增消息不使其失效；准备与切换分开，不再持续 keeper / coverage 接管（D-284） |
| 长任务连续性 | 正常路径前台无明显整理窗口期；摘要与近期原文承接工作，缺细节按需回读 Pi 历史。provider 慢或输入突增时真实呈现必要等待，不隐蔽裁剪；不以压缩次数强制委派或 Handoff |
| 持久知识治理 | agent 只提议（带触发描述），用户审阅接受；自动接受按作用域显式开启；更新用双时态取代不覆盖；召回按触发相关性；保留由用户裁剪 |
| 多 agent | code profile 由主线按独立成果/探索路线派发；research profile 增加首席研究主线、动态研究分支和按结果升级模型的集群调度。预设可选，允许 task/inherit 与定向父子/兄弟通信；写入线程默认独立 WorkingState，shared 明示选择；同根嵌套共享执行预算，等待让出名额；不建永久管理层或默认群聊（D-285/D-291） |
| 线程与上下文 | Thread 保留工作身份、成果与关系，Run 冻结当次执行和输入。工作相关可继续；背景大半过期可 fresh 而不清成果，无关工作新开线程。结果固定修订，依赖代码须实际纳入，不能仅靠消息同步（D-285/D-286） |
| 审查 | 实施者正常验证、主线关键验收、按任务安排独立 review/check。自动 review 默认关闭，用户明确开启的选择保留；绑定固定结果与真实 Run，不固定追加审查链（D-285） |
| 观察类工具 | 可能被反复调用的观察工具（`threads` / `wait` / `read_thread` / `get_output` 对运行中 shell / `diagnostics`）**默认返回自上次查看以来的增量**，全量要显式要；游标由 host 按（观察者，对象）持有，压缩时重置；结果只追加不回改（第 8.7 节） |
| 防过度委派 | 不增加调用配额、任务打分门槛或派发前费用估算；主线判断独立委派是否值得，自己更快更省就自己做。同根线程共享用户配置的执行名额，默认 12、超出排队；"派发前询问"是默认不生效的用户设置 |
| 长时间委派 | wait 默认因真实状态变化、用户输入/中止或调用方时限返回，超时是正常结果。缓存保活是用户可选的额外请求，按实际 provider 契约与用量执行；生命周期不依赖保活。等待中的已有摘要准备可完成，TTL、空闲和子返回本身不启动新的摘要任务 |
| 验证器 | 是有名字的 profile 声明；post-tool 反馈注入是统一通道 |
| 默认 runtime | 内置钉住的 Pi 作为默认；数据目录共享 `~/.pi/agent`；用户自有 Pi 是显式选项并带"未测试版本"诊断 |
| 领域顺序 | code → research → knowledge-work-in-files；SaaS 连接器不在前三个 profile 的范围内 |
| 度量 | 记录错误、重试、输出、缓存、普通会话用量、耗时与人工介入；不建立辅助模型分项费用/Token 看板。直接测试验证正确性，真实使用驱动优化。T4 和检索对照按问题需要使用，不是开发或默认启用门禁；Zone 0 稳定性由契约测试保证（D-078/D-080） |
| harness 的 UI 投影 | 后台 shell 成为可附着的终端 tab；输出句柄在工具卡片内可展开全文；Zone 2 默认折叠、可查看；压缩边界在时间线可见；线程在父会话侧栏成列、点开即完整聊天、可从父对话任意位置"从这里开一条线"（第 9.3.8 节） |
| 检索 | explore 由 Host 持有同一次查询，算法执行搜索/读取，向量提供语义候选，LLM 通过 models.explore 生成分组搜索计划、成组选段并指出具体补查；这些是当前交付项，不等待扩散模型。完整自主调查仍归 retrieval。来源机会、当前原文与必需范围贯穿最终呈现（D-173–D-175） |
| 未保存内容 | 用户输入自动固化发起窗口的 dirty buffers，无显式开启/绑定操作；来源引用由内部协议传播，其他窗口仅打开或聚焦不抢占。Host 读取不可变快照，surface 保持可变缓冲所有权；`explore`、`grep`、同名 `read`/`find`/`ls` 与 thread 基线已消费同一引用，语言服务按视图隔离后消费同一引用（第 6.1 / 6.4 节，D-071/D-082/D-085/D-086/D-087） |
| 结构来源 | 语言服务器回答"这个名字指什么"，tree-sitter 回答"这段文字的形状是什么"，两者在 Application Host 长期共存、不替代。结构来源是带修订绑定的可插拔 provider，接口先行，首个实现是 agent 视图 `documentSymbol`，第二个是 web-tree-sitter；语法包 = 语法 wasm + Piarium 查询，随版本锁定 ABI，常用语言捆绑（首刀 TS/TSX）、其余按需下载，目标覆盖大部分常用语言；语言 ≥ 3 时才做设置页（第 6.1 / 6.2 节，D-091） |
| 检查角色 | `check` 有读取与执行能力，测试/构建可能写缓存和生成物；不称只读 agent，不规定 bash 只能执行无写入命令，不强制一律使用独立副本（D-071） |
| 模型家族适配 | 一份基础 + 极薄 overlay；先做 Anthropic 与 OpenAI 两档，其他 provider 走通用 |
| Pi 上游 | 不贡献回上游；Pi 更新后重新适配。能 wrap 的 wrap（`read` / `edit` / `write` / `grep` 装饰 Pi 实现），只有 `bash` 重写 |
| 权限 | Piarium 原生 `tool_call` 门是唯一交互式权限权威，覆盖 Harness、Pi 内置、MCP、Pi 包与嵌套线程工具；Host 只验身份/能力/规范路径，不弹窗。未知/证据不完整的第三方动作必须询问，不能靠工具名或 annotation 自授予；会话授权绑定规范化 source/action/workspace/resource 范围（9.1.2，D-283） |
| 知识库保留 | 可配置；默认按时间自动清理原始 `event` 与已结束会话的 `block`，`knowledge` 不按时间过期；删除会话级联删除其 event 与 block |
| 用户级记忆 | 存在但轻：独立 `user.tdb`，只放 `knowledge`，不放 event / block；写入需经审阅；在 Settings 中可见、可编辑、可审计 |

## 3. 内核与 profile 的边界

harness 拆成层之后，大部分层在所有领域里不变，少数层变，其中一层是决定性的。

| 层 | 跨领域是否变化 | 归属 |
| --- | --- | --- |
| agent loop、会话日志、压缩机制、输出句柄、知识库存取、钩子点、权限框架、子 agent 生成、UI 投影 | 不变 | 内核 |
| 工具集 | 变；shell / 文件 / web / Python 是共享核心 | profile |
| 系统提示片段与技能 | 变 | profile |
| 上下文**策略**（压缩时保留什么、Zone 2 复述什么） | 变 | profile |
| **验证器**（传感器） | 根本不同 | profile |
| 权限默认值 | 变 | profile |
| 工作区形态 | 变 | profile |

验证器一行是分层的理由。编程有强的客观验证器（编译、类型检查、测试），harness 可以自动运行并把结果
注回上下文；科研只有弱验证器（引用是否存在、论断能否追溯到原文、数值能否复现），每一个都要专门构建
且不是二值的；日常工作的验证器是人的确认。三者不能共用传感器，但除此之外的层全部共享。

内核对 profile 暴露的接缝：

- **工具注册表**：profile 声明工具集；注册表支持渐进披露（常驻完整 schema 的核心工具 + 只列名字的延迟
  工具），不把全部工具常驻。
- **钩子点**：pre-tool、post-tool、turn-end、pre-compact。内核把 Pi 的对应事件封装为 profile 可声明的
  验证器挂载点。
- **验证器**：一个有名字的对象，声明触发钩子、作用范围与反馈形状；反馈统一通过 post-tool 结果注入。
- **上下文策略**：profile 提供 Zone 2 组装函数与压缩摘要模板。
- **知识库 schema 扩展**：profile 可以在基础节点/边类型之上追加自己的类型，不改基础类型。

## 4. 进程与代码归属

以下为当前生产形态；Rust 的已完成责任与证据见 4.3、plan 阶段 R 和 status。

```text
Application Host（packages/web/application-host）
  TS：产品策略、公开服务、Thread/Run、Documents/Registry 协调、LSP、知识/模型 adapter
      |
      | 私有生成协议（piarium.kernel.v1）
      v
  Rust kernel：WorkingState/Recovery、文件/物化、PTY/受管进程、文件/结构计算
      ^
      | 类型化 worker→host 请求（@piarium/protocol，requestId 关联）
      v
pi-host session worker（packages/pi-host）
  harness-tools.ts + 进程内 ExtensionFactory → Pi SDK（用户级或内置安装）
```

pi-host 已经通过 `customTools` 同名覆盖了 Pi 的 `write` / `edit`（恢复日志的 mutation boundary），
并以进程内 `ExtensionFactory` 挂载 `before_agent_start` 等钩子。工具仍沿这两个机制进入 Host，
不新增 Pi 包或 MCP 跳板。Rust kernel 是 Host 私有实现，不向 renderer/Pi 开第二端口；ACP agent 的 MCP 门面仍是后续交付，使用相同 Host 服务。

### 4.1 Pi 钩子到 harness 机制的映射

以下映射对照本检出中 Pi SDK 的扩展事件类型核实：

| harness 机制 | Pi 事件 / API | 用法 |
| --- | --- | --- |
| 工具覆盖 | `customTools` on session create | 同名 `ToolDefinition` 覆盖 `read` / `bash` / `edit` / `write` / `grep`；`read` 只在 Host 声明固定来源服务时覆盖，否则保留 Pi 原生实现；新增 `apply_patch`、`get_output`、`write_to_process`、`kill_shell`、`diagnostics`、`todo`、`dispatch`、`wait`、`webfetch`、`websearch`；`executionMode` 按第 5.9 节声明 |
| 请求前上下文尾部 | `ContextRequestBoundary` → provider request | D-301 / 7G 已统一到每次 Agent 模型请求前准备：环境增量实际送达后留史，完整团队快照只临时附在本次尾部；不动态改写 `systemPrompt` |
| post-tool 反馈注入 | `tool_result` → 替换 `content` / `details` | 把诊断附加到 edit/write 结果；验证器的统一通道 |
| 工具门控 | `tool_call` → `block` | profile 的权限默认值；等价于"mask 不删" |
| 提交压缩 | `session_before_compact` → 返回 `compaction` | 提交已准备的摘要与固定 firstKeptEntryId，保留准备期间新增的原文；尚未准备好时沿同一摘要路径等待或生成 |
| 主 agent 意图 | `customTools`：`todo`（第 5.6 节） | 服务主 agent 自身注意力；主 agent 无块编辑与标记工具，对记忆系统零义务 |
| 请求预算 | 每次真实模型请求前，包括回合内工具继续 | 按当前有效窗口、实际请求输出预留和新输入计量；不能只依赖 Pi 的 agent_end 或用户 prompt 前检查 |
| 后台摘要准备 | 请求/步骤边界的容量检查 | 固定历史前缀与切点，沿当前 ModelRuntime 单次生成续接摘要；主会话继续，没有 memory_edit 或工具执行循环 |
| 异常容量压力 | 候选未就绪、失败、模型窗口缩小或新材料过大 | 复用在飞任务或同一摘要机制处理可容纳的旧前缀；保留新原文，不静默切回旧 keeper，也不忙循环重试 |
| 压缩后续接 | `session_compact` | 更新实际失去基线的观察游标与 UI 边界；不默认重注入最近文件、技能正文或整个状态面板 |
| 缓存断点 | `before_provider_request`（如需） | pi-ai 的 Anthropic provider 已在 system、tools、最后一条 user 消息设 `cache_control`；仅在 provider 缺失时补 |
| 轨迹采集 | `tool_execution_end`、`turn_end`、host 侧文档 / 终端 / LSP 事件 | 写入知识库，不进上下文 |
| 用户 `!cmd` | `user_bash` → 自定义 `operations` | 与 `bash` 工具共享同一 shell 监督器 |

### 4.2 已修复的前缀漂移与持续契约

`session-features.ts` 曾在 before_agent_start 把变化的目标 token 计数写进 systemPrompt；现已按 status 1.2 修复。
动态目标与运行状态使用尾部消息，不回改静态前缀。修改相关装配时运行现有 Zone 0 契约测试，不把已修缺陷重新列为前置任务。

### 4.3 Rust 系统内核（正式架构，D-252；D-282 完成）

内核是 Application Host 管理的私有子进程，沿同一生成协议服务 Electron/Web/远程，不向 renderer 或 Pi 扩展开放新端口。
它统一拥有实际文件资源、分支/对象/引用/恢复事务、物化和进程/PTY 后端，并承担固定视图文件搜索与结构计算。
TS 保留 Thread/Run 与模型策略、公开 API、知识领域、语言协议与 UI 投影；Pi 会话、凭据和扩展继续归原 worker。

恢复与 WorkingState 复用现有 SQLite/对象库模式，在同一存储位置的事务域中发布根/引用/operation，
不继续整份 JSON 加另一引用库的双权威。根成为真实读取/CAS/diff/pin 入口，节点增量持久化；
持久身份保留完整字段，平台磁盘比较不能改变哈希。文件外部写者与 surface 回执仍须按可观察事实恢复。

Document Registry 继续拥有未保存缓冲。混合操作在内核记录同一 operationId 的逐目标阶段，经 TS Documents adapter
调用真实 Registry 的修订检查与 grouped undo，不隐式保存、不建第二缓冲权威。Thread/Pi/知识的跨域清理按持久操作与幂等回执协调。

真实链路是 `Application Host → 私有 KernelClient → piarium-kernel 子进程 → framed protocol → kernel SQLite/object store`；
Electron/Web/serve/云从自己的发行目录使用 manifest-verified executable，kernel 不监听公共端口。
R1–R5 已分别接管 immutable root/trie、blob/branch/revision/CAS/pin/Recovery/GC、文件资源与物化、PTY/pipe、固定视图搜索和
tree-sitter 结构计算。所有生产消费者走 root/path/domain/file/process/compute API；旧 TS writer 只保留为明确测试 helper，发行树会
审计并删掉不可达测试/旧实现。

D-282 完成 R0/R6：传输用 acknowledgement-backed request credits，取消可越过数据背压；release smoke 覆盖任意 cwd、安装目录替换、
同一 current-format catalog 重开、坏 manifest、固定 root、条件磁盘写与真实 shell 退出。受控 128/1024/4096 文件对照记录冷/热、
事件循环、RSS、节点和取消，既保留搜索收益，也如实记录 inventory/逐文件 structure 的额外成本。完整契约、数值与平台边界见
[rust-kernel-design.md](rust-kernel-design.md) 和 status。阶段 R 已完成，后续能力直接复用该边界。

## 5. 工具集（code profile v1）

### 5.0 清单

| 工具 | 来源 | 并发 | 一句话 |
| --- | --- | --- | --- |
| `bash` | 覆盖 Pi | 独占（`executionMode: sequential`） | PTY、持久会话 shell、超时转后台不杀 |
| `grep` | 覆盖 Pi | 并行 | rg 搜索、固定 surface 叠加、分组排序与有界结果 |
| `edit` / `write` | 覆盖 Pi | 工具层允许并发；实际提交受资源 gate 与修订检查约束 | 附加新引入的诊断；资源粒度调度目标见 5.9 |
| `apply_patch` | 新增 | 从同一 patch 解析完整路径集，按资源冲突调度 | Codex 语法多文件编辑，按模型家族启用；底层仍由同一 mutation authority 原子/补偿处理 |
| `read` / `find` / `ls` | 同名适配 | 并行 | `read` 保留 Pi 原生分页、截断与图片；find/ls 取得 Host 的固定 dirty path/虚拟祖先并经 Pi 原生定义合并磁盘结果，过期相关来源不可回退 |
| `get_output` / `write_to_process` / `kill_shell` | 新增 | 读并行，写与杀独占 | 后台 shell 与输出句柄；对运行中 shell 默认返回上次读取之后的增量（第 5.5 节） |
| `diagnostics` | 新增 | 并行 | `pending` 后按需查 |
| `todo` | 新增 | 串行 | 主 agent 自己的计划（第 5.6 节） |
| `explore(question, anchors?, paths?, limit?)` | 原生，接通后默认注册 | 并行 | 用主 agent 的问题与已知锚点做确定性召回、结构切片与互补打包，返回带版本的代码原文；`limit` 只管输出条数；模型机制按已配置槽位使用（第 5.7、6.1 节，D-090） |
| `dispatch` / `threads` / `wait` / `send` / `read_thread` / `merge` / `kill` | 新增 | 并行按任务与真实作用域；wait 等待让出执行名额；同目标状态修改串行 | 派发工作（预设可选）、读取状态/成果、定向通知或请求、续做与选择上下文、集成固定结果、终止（第 5.7、9.2、9.3 节） |
| `webfetch` / `websearch` | 新增 | 并行 | 抓取与搜索，SSRF 策略、阅读子 agent、provider 抽象（第 5.8 节） |
| `related` / `recall` | 新增（第 3 阶段） | 并行 | 知识库结构与记忆（第 6.2、7.4 节） |
| `symbols` / `definition` / `references` / `hover` | 新增（第 3 阶段） | 并行 | 真实 LanguageSupervisor 导航；路径受 Host authority/scope 约束，位置对 agent 一基（D-051）；正文来自 agent 视图并携带修订与来源，跨文件位置区分已固定与未固定（第 6.4 节，D-087） |

不在 v1：沙箱（第 9.1.1 节）；浏览器操作（点击、表单——
research 与 knowledge-work profile 再评估）。

### 5.1 贯穿所有工具的原则

1. **同名覆盖，不并列。** 模型不应有两种方式做同一件事。
2. **两份输出。** `content` 文本为模型的下一步决策而写；`details` 为 Piarium 工具卡片渲染而写。两者不互相
   妥协。
3. **输出句柄。** 超过阈值（默认可见 32 KiB，首尾各半；`bash` 默认尾部加权，因为退出信息在末尾）的输出由
   host 存全文，模型看到预览与 `[省略 N 字节 — get_output("out_x", offset, length)]`。句柄是会话作用域，
   **压缩后仍有效**。截断发生在结果进入上下文之前，不是事后修改。截断在 `tool_result` 钩子层实现，因此对**所有**
   工具生效，包括 Pi 原样保留的 `read` / `find` / `ls`——读一个 5,000 行文件不会整个进入窗口。

   句柄有两种耐久级别，不混用（D-034）。**`OutputRef` 是临时的**：只在 host 进程内、按会话预算 FIFO 淘汰，
   不得写入任何持久记录；句柄编码 `out_<hostEpoch>_<sequence>_<mac>`，epoch 与截断后的 HMAC 均为 128 bit，host 按会话记
   `{ nextSequence, evictedThrough }`
   两个水位，于是 host 重启（epoch 不同）或被淘汰（序号低于水位）都能返回 **`expired`**，从未签发的返回 `not-found`——
   两种"不在"不合并。**`TranscriptRef`（`{ runtimeId, sessionId, fromEntryId, toEntryId }`）是耐久的**：指向 Pi 会话
   文件本身，线程报告引用持久记录用它，不用 `OutputRef`。**持久记录可能只有截断预览**：`TranscriptRef` 不承诺找回已随 Host 重启
   或淘汰消失的中间正文。可重建来源引用能实际读取正文的 Git/恢复对象；不可重建观察须有操作所属的耐久产物，或明确临时可用。
   文件路径、revision、hash 本身不是正文存储；压缩恢复不能仅依赖临时句柄。所有偏移与长度一律是 **UTF-8 字节**，切片在字节边界处
   向最近的字符边界回退，分页返回 `nextOffset` 与 `eof`，调用方不得假设 `next = offset + length`。从旧 catalog 迁移时
   `fromEntryId / toEntryId` 可为 null，表示该 Pi 会话当前分支的首项 / 叶项，不再保留旧的临时 handle。
4. **错误即指令。** 每条失败文本 = 发生了什么 + 一个具体的下一步。
5. **shell 由 harness 决定。** 模型不选 shell、不选编码、不选交互模式。
6. **非零退出不是工具错误。** 它是正常结果，给退出码与 stderr，不加错误框架；否则模型会把测试失败当成
   工具损坏。
7. **两种"空"不合并。** `0 hits (searched 1,204 files)` 与 `search unavailable: ...` 是两条不同文本。这是
   仓库既有不变量在工具层的体现。
8. **紧凑不删证据。** 工具卡标题从 arguments/details 投影一行摘要；同一 assistant step 内连续 2 个以上、且名称明确列入
   只读集合的调用折叠成一组，写入、shell 与未知扩展工具都打断分组。组和单卡始终可展开原始 arguments/result/details；
   renderer 不根据“未知工具看起来像查询”猜它只读（D-048）。sorted 模式已有整段 activity 折叠，不再套第二层默认分组。

阈值、超时、并行度均为默认值，可由设置覆盖；本文档不设硬上限。默认呈现应足以完成本次调用的用途；缓存命中时可减少
旧结果的重复输入成本，具体折扣和有效期按 provider 计算。临近窗口时先处理上下文容量，不临时降低正常工具的信息质量；
单份材料本身超窗时使用明确分页与全文入口。参照：Claude Code 的 Bash 默认截断 30,000 字符、Grep 落盘阈值 20K 字符、Grep 默认
250 条。

### 5.2 `bash`（覆盖）

保留名字 `bash`——模型的先验是 bash 语法。**锁的是"谁选解释器"，不是"只有一个解释器"**：模型每次调用不选 shell
（这是确定性的来源，Claude Code / Codex / Devin 都如此），解释器由 harness **按工作区环境**选定并在会话内固定：

| 环境 | 解释器 |
| --- | --- |
| 原生 Windows 工作区 | Git Bash（Pi 与 Claude Code 均要求其存在） |
| WSL 内的工作区（`\\wsl$` 路径） | `wsl.exe -d <distro> bash` |
| SSH 远程 / 远程实例 | 远端 shell |
| 容器 | 容器内 shell |
| macOS / Linux | `bash` |

工作区设置 `harness.shell: auto | git-bash | powershell | wsl`（默认 `auto`）供用户覆盖——整套工具链是 `.ps1` 的团队
可切 PowerShell。该值来自现有 Pi `settings.json`（用户默认 + 受信任项目覆盖），在**该会话注册时**生效，不另建配置
文件。Application Host 在构造时用与 Git 服务相同的 Windows 安装根、PATH 和已解析的 `git.exe` 位置发现可执行的
`bash.exe`，优先 `usr\bin` 而不是 `bin` 启动器。未发现时工具返回准确原因和安装/改设置入口，不能把已安装误报成未安装。
注册与工具准入按 actor 的 worker 代际协调：首个请求等待本代配置，关闭或换代后的迟到结果不能复活会话。设置不可读与配置非法
都明确 unavailable，不当成 auto；首次注册保留已经捕获的输入快照。PowerShell 用 ConPTY 可用的交互启动与自身命令包装（D-205）。
此外 Windows 原生工具随时可从 bash 内调用（`powershell.exe -c ...`、`cmd //c ...`），harness 不
禁止。Codex 原生 Windows 与 Cursor 默认 PowerShell；Piarium 跟随 Pi。Git Bash 的已知坑（MSYS 路径自动转换会误转
形如路径的参数，`MSYS_NO_PATHCONV=1` 可关；CRLF；fork 慢）由 shell 监督器的默认环境处理，不暴露给模型。

当前公开工具参数包括 `command`、`waitMs?`、可选受管 `target` 与目标 `cwd`；普通本机调用沿用会话目录。
Pi 工具等待默认 10 s，bridge 请求期限覆盖所选观察窗口并受协议上界约束；该期限只控制本次观察，不终止进程。
**等待期限不等于进程期限**：命令在 `waitMs` 内结束则同步返回；否则**自动转后台**，返回"已等待 N 秒，仍在运行，shell id X"与截至此刻的输出，
模型继续工作，稍后用 `get_output(X)` 取结果、`write_to_process(X, text)` 喂 stdin、`kill_shell(X)` 终止。这是
Devin CLI `exec` / `get_output` / `write_to_process` / `kill_shell` 与 Codex `exec_command(yield_time_ms)` /
`write_stdin` 共同的形状：由 harness 按经过时间决定前后台，模型不需要预判一条命令要跑多久，构建与测试也不会在
中途被 harness 自己杀掉。后台进程随会话生命周期终止；可选的后台硬上限是配置项，默认不设。

执行模型由 host 的 shell 监督器拥有，对照三家的实际做法选择：

- **PTY，不是管道。** Codex 的 `unified_exec` 是 PTY；Claude Code 是持久管道 shell，因此"不能原生处理 vim、sudo 这类
  TTY 交互提示"。Piarium 选 PTY，复用 host 现有终端运行时：后台 shell 天然就是用户可附着、可输入的终端 tab（第 2 节
  已定的 UI 投影），程序的行为与在终端中一致。给模型的文本剥去 ANSI 与控制序列（host 已有 replay-safe 字节逻辑），
  终端 tab 显示原始字节。后台命令使用 terminal runtime 的同一会话身份（D-206）：监督器经
  `createTerminalSession` / `attachTerminalSession` 创建与附着，HTTP 不能指定 owner/spawn。`sh_N` 由全局 terminal runtime
  分配，监督器使用返回的实际 id；同名会话只有完整创建身份一致且仍在运行时才能复用，HTTP 不能接管 Harness handle。
  关闭查看界面只脱离附着，显式终止仍走统一关闭链。哨兵格式与默认环境变量集在 `lib/harness/DOCUMENTATION.md`。
- **stdin 开着，harness 永不代写。** 等输入的程序会停在提示上；`waitMs` 到了它转后台，模型在输出里看到提示文本，
  用 `write_to_process` 回答或 `kill_shell` 放弃。Pi 内置 bash 的 stdin 是 ignore，与 `write_to_process` 不相容，
  因此这里不沿用。
- **持久会话 shell，以 login shell 启动。** 一个 PTY shell 跑所有前台命令，先 source 用户的 `.bash_profile` /
  `.bashrc`——nvm、pyenv、conda、自定义 PATH 全部就位，agent 用的就是用户平时的环境（Claude Code 与 Codex 均如此）。
  cwd、环境变量、`source .venv/bin/activate`、`nvm use` 跨调用保持；Pi 内置 bash 每次 `spawn` 则不保持，`source
  venv` 后 `pytest` 报"not found"正是要消灭的那类工具错误。命令以哨兵标记包裹以分隔输出并捕获退出码。前台命令超过
  `waitMs` 时，**它所在的 shell 整个转为后台 shell**（拿到 id），host 起一个新的会话 shell 继承 cwd 服务后续前台
  命令——模型不被阻塞，后台命令也不失去它的 shell 状态。
- **环境变量只改交互与显示，不改工具语义。** 叠加在用户环境之上：`GIT_TERMINAL_PROMPT=0`（git 不弹凭据框）、
  `PAGER=cat GIT_PAGER=cat`（不弹分页器）、`NO_COLOR=1`（减少 ANSI 噪音）、`PYTHONUNBUFFERED=1`、Linux 上
  `DEBIAN_FRONTEND=noninteractive`。**不设 `CI=1`**：许多构建工具在 `CI` 下改变语义（Create React App 把 warning 当
  error、yarn 变为 frozen-lockfile、部分 CLI 关闭功能），会让 agent 看到的构建结果与用户终端不一致；它原本用于压掉交互
  提示，而 PTY 加 `write_to_process` 已能看到并回答提示。**locale 不硬编码**：host 启动时探测机器上可用的 UTF-8
  locale（`C.UTF-8` 在旧版 macOS 不存在，硬设会让每条命令刷 `setlocale` 警告），没有则不设，PTY 自身按 UTF-8 解码。
  PTY 提供真实 `TERM`，不设 `TERM=dumb`。整套默认环境在设置中可见、可按工作区修改。
- `kill_shell` 与会话结束时终止整个进程树；复用 host 已有的 process-tree termination。没有超时杀死。
- 后台命令的完成由 PTY exit 事件产生，不以模型调用 `get_output` 为前提；start/end 各记录一次，重复观察只读已有事实。
- `bash` 的命令正文是不透明副作用，因此保持资源屏障；其他工具按已验证参数提供资源计划，不再因一个已知 sequential 工具把所有独立调用逐条执行（5.9）。
- 执行期间向 mutation authority 注册为 `process` writer（`WRITER_MODES` 中已存在的模式），使恢复系统知道本轮
  文件覆盖不完整。这是恢复设计已预留的语义。
- 会话关闭等待 PTY 实际退出，再释放写者；中断请求不等于命令已经结束。失败保留活动状态与可重试关闭，已从会话表移除的
  shell 在关闭完成前仍参与目录回收判断。writer 释放失败同样保留目录保护并可在后续关闭重试；线程不能只凭 Pi close
  响应就删除执行目录（D-205/D-209）。

模型看到的文本形状：

```text
exit 0 · 1.2s · cwd packages/web
<stdout 首部>
…
<stdout 尾部>
[stderr 3 行]
[输出共 61,204 字节，显示首 12,288 + 末 20,480 — get_output("out_7f3a", offset, length)]
```

三类结果各有文本：非零退出（正常结果，不是错误）；转后台（正常结果，附 shell id 与已等待时长）；spawn 失败
（工具错误，附 shell 路径与修复方式）。系统提示明令不用 `bash` 跑 `grep` / `rg` / `find` / `cat`——内置工具有
正确的 ignore 规则、权限与截断（Claude Code 的同款约束）。

**输出压缩：按命令整理默认展示（3.17，D-160 / D-197 / D-199 / D-241）。** vitest / tsc / eslint / git 识别失败块、定位与统计，
只收起明确的成功或重复噪声；未知内容保留。常见 pretty/plain 格式、失败块续文与交互提示都属于可读正文，不能因为看见统计行就丢弃其他行。
未识别命令或无法可靠区分来源的混合输出走通用首尾展示；工具名出现在参数中不等于正在执行该工具。目标形状仍是五层：**命令专用解析器**（`vitest` / `jest`、`tsc`、
`eslint` / `biome`、`git`、`cargo`、`pytest` 等，从可靠的执行位置识别命令，用已知格式组织统计与失败块）→
**输出形状嗅探**（经 `npm test` / `make check` 包裹时按输出本身识别）→ **包管理器通配**（`npm` / `pnpm` / `yarn` / `bun` 头 token，已接，D-241）→
**声明式规则**（用户/项目可加的"删这些行、截这些、保留这些"，覆盖长尾）→ **通用兜底**（去 ANSI、连续去重、首尾切）。
全文照旧进 OutputStore，句柄不变。沿用 32 KiB 可见预算，超出时标明省略并提供原文读取；单个大块也要留下可用的首尾，不能只返回省略提示。
分片展示只代表本次观察，退出码只取进程事实。获得 Host 整理结果后免于二次裁切；旧 Host 的未整理结果保留通用截断，显式分页保持原始 UTF-8 与字节游标。
**不用小模型做总结替代**：规则整理不需要额外模型调用，但解析器也可能漏识别格式，因此以保留未知内容为前提。模型总结**可以作为附加**放在非结构化输出上
（"这是头、这是尾、这是模型认为重要的几行、全文在句柄"），减少拉取的同时不让 agent 误以为看到了全部。先做的四个（vitest、tsc、eslint、git）已按 D-197 进入公开 `bash` 与增量 `get_output`。
包管理器通配已按 D-241 接线：`npm`/`pnpm`/`yarn`/`bun` 头的脚本运行与内置命令（`npm test`、`pnpm run build`、`yarn add`、`bun install`）
以及 `exec`/`dlx`/`x` 包裹下未识别的二进制都先归到管理器层；管理器自己回显的脚本命令（`>` / `$` 行）是可靠的执行位置，
能解析出内层命令就把其后正文交给对应解析器（kind 记为内层工具，包裹行保留在正文里）；解析不出时先对正文做形状嗅探，
仍不识别则按管理器形状整理——错误块与 install/audit 摘要是必需项，`npm warn`/进度/下载类重复噪声折叠成计数，其余正文原样保留。
其余命令与未识别输出仍走通用展示；声明式规则和附加模型总结尚未接。

### 5.3 `grep`（覆盖）

覆盖 Pi 内置 `grep` 而非新增 `search`，以保持同名覆盖原则。现行参数是 `pattern`、`path`、大小写、fixed string、
`-A/-B/-C` 等价邻行、多个 include/exclude glob 与 `limit`；曾暴露但从未实现的 `--type` 和 files/count mode 已删除，
不让假参数继续占工具 schema。`limit` 默认 100 条命中，达到限制时返回 partial，模型可缩小 path/glob 或提高 limit。

- 走 host 的 `createWorkspaceContentSearch`（ripgrep，尊重 `.gitignore`，有界）；调用方的 include/exclude glob 直接传给 rg，
  surface 路径用同一组规则过滤。
- 排序按文件分组；当前按命中数、源码/测试路径偏好和路径深度确定顺序。mtime 与 Git modified 尚未接入，不把占位字段
  写成已生效的排序信号。
- **不含符号模式。** 符号导航（定义、引用、工作区符号、悬停签名 `hover`）是独立的 LSP 工具，第 3 阶段与 `related` 一起
  交付——Claude Code 也把 LSP 与 Grep 分开，Devin 的 `hover_symbol` 与定义、引用并列。grep 的 schema 保持与 rg 一致，
  不混入 rg 没有的语义。
- Host 搜索当前有 20 s 工作默认；取消、rg 失败或超时返回 unavailable，命中数超过显示 limit 才返回 partial，不能把 unavailable
  写成零命中。
- D-085 已让 `grep` 消费与 `explore` 相同的固定 surface snapshot：先在 rg 流式计数前排除 dirty path 的旧磁盘命中，再在固定
  草稿上执行相同 regex/fixed/case/glob 过滤，最后统一排序和截断。草稿缺失或过期时整个相关查询 unavailable，不回退磁盘。

### 5.4 `edit` / `write`（已覆盖，附加诊断）

参数形状**不变**（`path` / `oldText` / `newText`），保持模型先验。改变的是返回：写入后若该工作区有对应语言的
LSP 在运行，**等待该文件的下一次诊断发布**（事件驱动，不是固定休眠），上限默认 5 s——大型 TypeScript 项目的诊断
更新常需数秒，过短的固定等待会让 `pending` 成为常态而使该功能失去意义。取到后**只返回本次编辑新引入的**诊断
（与编辑前快照做差）。

```text
edited packages/ui/src/lib/foo.ts (+3 −1)
diagnostics (typescript): 1 new error
  42:7 TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

三种非成功态各有文本：`unavailable (no language server for .py)`、`pending (server busy) — call
diagnostics("foo.ts")`、`clean`。永不沉默。实现路径优先用 `tool_result` 钩子替换 `content`，这样恢复日志的
覆盖与诊断附加互不耦合。

根会话 `edit` / `write` / `apply_patch` 与本轮固定输入共用同一正文权威（D-225，身份、WAL 与补偿由 D-228/D-232 纠正）。虚拟线程仍先走 `document.branchWrite`。
其余路径进入共享 Host 计划 `document.surfaceWrite`：本轮 snapshot 拥有的路径按固定正文匹配，写回同一 Document Registry
缓冲，并核对 owner / generation / registration / document instance / `localEditRevision` / `baseRevision`。
UI publication 的 `bufferHash` 是规范化编辑器 buffer 身份；snapshot 正文是带原行尾的序列化文件正文，二者不得直接比较。
写回 Registry 前转换成编辑器规范形式；写回后的 snapshot 仍按文件行尾呈现。
用户在计划后继续编辑则明确 stale/conflict，不覆盖缓冲，也不回退写磁盘，且不隐式保存。普通磁盘路径保持既有 journaled
disk 写入。多文件同时含 surface 与 disk 时，在同一 Documents resource gate 内先核对全部磁盘成员的原始字节身份，再允许任何
surface dispatch；第一笔写入前把 intent 记入独立 `agent-mutation` 操作（不冒充 Integration）。WAL 区分明确 failed receipt 与
已 dispatch 但无认证回执，并记录补偿 intent、观察结果和 target-after；
apply 与 undo 共用同一个真实 `operationId`，一次 batch 只能整组撤销。取消 / I/O throw / 断连后走条件补偿或 needs-attention，
补偿不复用已 aborted 的前向 signal。按路径返回 applied / conflict / compensated / needs-attention，不允许“前面已写、后面失败”
却只报普通失败且无记录。`apply_patch` 仅当 `document.readSource` 明确返回 `source=disk` 时才读磁盘；unavailable/stale/传输错误必须停止，
整文件替换携带所读 surface revision/hash。磁盘写成功到 target-after 捕获之间崩溃时不猜写入结果，恢复状态/UI 明确 needs-attention。
删除、二进制、symlink、mode 等 surface 无法表达的操作明确 unavailable/conflict。
成功写入后同一回合后续 read/edit 看到新缓冲正文，不退回旧 snapshot 或旧磁盘。参数保持同名先验。

**编辑格式跟模型家族走。** Codex 系模型按 `apply_patch` 语法训练（`*** Begin Patch` / `*** Update File:` /
`@@` hunk / `*** End Patch`，一次可改多文件，仅相对路径）；Claude 系按 str_replace 训练。Devin CLI 两者并存，
Cursor 为每个前沿模型单独调工具。Piarium 支持任意 provider，因此提供 `apply_patch` 工具，由 profile 按会话模型
家族启用其一或两者；两者共用同一 mutation boundary 与诊断附加，恢复日志按 patch 中声明的路径逐文件记录。

### 5.5 `get_output`、`write_to_process`、`kill_shell`、`diagnostics`

`get_output(handle, offset?, length?)` 统一读取两类东西：已完成输出的句柄（`out_x`）与仍在后台运行的 shell（`bash`
返回的 shell id）。没有它句柄是死的。`write_to_process(id, text)` 与 `kill_shell(id)` 服务后台 shell。
`diagnostics(path?)` 供 `pending` 态后按需查询。

**反复读同一个对象时默认返回增量**（第 8.7 节）。对运行中的 shell，不带 `offset` 的 `get_output` 返回上次读取之后的新
输出，开头一行引头 `[shell sh_3 · +2.1 KB since last read (40 s ago) · still running]`；没有新输出就一行"无新输出，仍在
运行，最近输出 40 秒前"。显式 `offset` / `length` 才是随机访问，用于回看。`diagnostics` 对同一路径的重复查询只报新增与
消失的条目。游标由 host 按（会话，对象）保存，不占模型的上下文，压缩后第一次读取回到全量。已完成的输出句柄是静态的，
没有增量语义，仍按 `offset` / `length` 分页。

D-302 / 7H 已在同一工具上增加可取消的事件等待，保留默认立即读取和显式历史分页；后台完成事实接入 7G 环境增量。
当前 `get_output` 尚不提供这项等待，Agent 后台 shell 的完成也没有通用 Zone 2 通知链；不能把用户终端事件或验证记录当成已接通的替代。
具体启动、等待、通知和生命周期设计见 5.9.2。

### 5.6 `todo`（新增，主 agent 自己的计划）

主 agent 对记忆系统零义务（第 8.4.1 节），但它可以为**自己的注意力**维护一份计划。`todo({ items: [{ text, status }],
confidence? })`——整表替换语义，Claude Code TodoWrite 的形状，模型训练过。写入知识库的 `plan` 块（主 agent 是该块唯一
的模型侧结构所有者，用户可以在面板编辑），显示在计划面板；用户修改作为新事实进 Zone 2，agent 自己的修改已在工具结果中。
后台压缩不编辑 plan，也不因停止 keeper 而隐藏计划。`confidence` 可选：主 agent 声明对计划的信心，
只作说明，不以自报分数自动增加确认步骤。只有用户显式选择 plan mode 或配置计划审批时才按该选择等待。系统提示只建议
"非平凡任务先计划"，harness 不检查它是否被调用，也不因其陈旧而提醒。confidence 只作信息；plan mode 或权限策略需要
批准时由既有 pre-tool 流程处理，`todo.upsert` 写入后没有第二次确认协议（D-206/D-209）。

### 5.7 `explore`、`dispatch` / `wait`（新增）

**`explore(question, anchors?, paths?, limit?)` 是正式默认的快速检索能力**，规格统一见第 6.1 节（D-173）。它使用词法、路径、
符号和可用向量，帮助主 agent 发现实现入口并取得少量当前代码原文。`question` 描述所需材料，`anchors` 提供已有线索，`paths`
限定范围，`limit` 限定输出条数。锚点优先取得候选而非隐式过滤；具体关系可在原文中核实，开放问题的推理留给主 agent 或 retrieval。
当前路线包含 LLM 的局部语义决策：查询理解/搜索表达与候选相关性判断经 `models.explore` 接入，搜索、读取、版本与呈现归算法。
每次模型调用围绕一个明确决策；允许保持原问题、有当前材料依据的局部补查，不在工具内开展开放自主调查。成组选段须保留
必需源码范围，跨进程阶段延续同一次查询。扩散模型与后训练留后续，不推迟当前 LLM 接线（D-174/D-175）。
来源、版本、草稿与输出句柄沿既有实际 authority；接线与未观察项只记在 status，不能把真实 provider 延迟、质量或完整冷扫时间写成已验证。

`dispatch(task, { context?, preset?, scope?, worktree? })` 异步开一条工作线程，父继续推进。默认普通模型执行，不强制选择角色；
预设配置、背景起点与工作分支分别表达（9.2）。成果形状按用途：review 给发现与依据，检索给事实/来源，实现给实际变更与
说明。过程中有用的问题和信息可以定向交流，普通过程不广播。已有工作可继续或 fresh，不因返回过一次结果就必须重建线程。

父 agent 通过增量观察和定向消息协调工作（第 9.3.6 节）：`threads(ids?)` 非阻塞返回一张增量状态表；
`wait(ids?, timeout_ms?)` 等待所选线程的结果、对应答复或需处理的状态变化，超时返回当前观察，**超时是正常结果**，默认只受 Host 请求时限约束，
不按缓存 TTL 唤醒（第 9.2.6 节）；`read_thread(id, what?)` 默认读线程状态与已有报告，需要时读取计划/用户笔记或转录切片；
不为提供 progress/decisions 块启动 keeper。send 给线程传话；kill 终止执行并保留工作结果，目录按 9.3.4 回收。
merge 集成选定的不可变子结果，返回应用、冲突和恢复状态；文本冲突保留标记，非文本提供父/子版本选择（9.2.5b）。
未配置且未声明继承的专用预设不可用，普通派发仍可用；等待/通信与恢复语义按9.2/9.3，不再只接受 active 子线程。

### 5.8 `webfetch` / `websearch`（新增）

web 能力由 Harness 原生提供，搜索与模型账户无关（D-289）。普通用户无需再申请搜索密钥或安装 MCP。
搜索找到来源，`webfetch` 读取来源正文、查找片段并按行展开；来源面板沿同一工具结果展示 URL。
远程搜索服务负责索引，Host 负责 provider 选择、取消、域名策略与结果呈现。搜索本身不增加 LLM 子对话。

**参考 `pi-web-access`（0.24）的能力清单，原生地做得更好。** 它有：多搜索 provider 路由（自动 / 指定 / 并发 / 全
provider / 有序回退）、完整 provider 与凭据体系（含可执行凭据源、API 网关）、Curator（独立本地 HTTP server 做结果
整理与 summary-review，带 bind 与远程暴露警告）、Chromium cookie opt-in、内容控制（摘要与内联长度、GitHub / 视频 /
图片 / PDF 开关与限制、认证抓取 profile）、SSRF 策略与例外、域名策略、持久化结果浏览。Piarium 有 host 与工作台，因此：
Curator 变成工作台的"来源"面板（可审阅、钉住、删除，走已有认证通道，不再有独立 server 与 token-in-URL 风险）；
凭据进 Pi AuthStorage 或系统钥匙串，绝不落明文 JSON；持久化结果进知识库（URL、抓取时间、提取文本；压缩时丢正文
留 URL）；认证抓取用 Electron 的**独立 Piarium 浏览器 profile**，不碰用户日常浏览器的 cookie；GitHub 走 `@octokit`
（host 已有依赖）取 issue / PR / 文件而非抓 HTML；有序回退与并发查询原生实现、配置在 Settings；对话框与后续消息变成
工具结果与 Zone 2。视频转录与图片描述 v1 不做。

**`webfetch(url, { prompt?, find?, start_line?, end_line? })`**：Host 抓取，`find` 对提取正文做不区分大小写的字面查找，返回命中行与相邻上下文；行范围按一开始的提取 Markdown 行号包含两端，未指定范围时沿原正文呈现。查无结果是正常观察，非法范围是明确参数错误。SSRF 策略复用 [security.md](security.md) 已有规则——私有与保留网段默认阻断、
浏览器 cookie 默认不带、显式 opt-in；工作区级域名允许 / 阻断列表；同域重定向自动跟随，跨域重定向返回元数据；正文提取
（readability 类算法 + Markdown 转换；PDF 转文本，research profile 同样需要）；15 分钟缓存。无 `prompt` 时返回提取后的
Markdown 走句柄。有 `prompt` 时**仅当配置了 `models.reader` 槽位**（第 8.5 节）才由阅读子 agent 回答、主上下文只收
回答；未配置则忽略 `prompt`、返回提取内容并注明"reader unavailable: no reader model configured"——**永不回退到主
模型**。
**JS 渲染是 Piarium 的独有能力**：桌面端用 Electron 的 Chromium 离屏渲染（隐藏窗口，不带用户 cookie 除非显式开启）；
Web / 云 host 无 Chromium 时返回 `unavailable (no renderer)`；检测到空壳 SPA（极小 body + 脚本标签）时明说，永不把
空页面当成功。

**`websearch(query, { allowed_domains?, blocked_domains?, recency?, limit? })`**：有用户选择时使用其搜索 API（Brave、Exa、Tavily、Jina、自托管 SearXNG）；否则默认直接调用 Exa 免密钥 MCP，明确失败时顺序改用 Parallel。真实 provider 与换源说明随结果返回；空结果不换源，取消立即停止；自配服务缺凭据/失败明确报错，不改用其他服务。工具默认注册，显式关闭仍生效。设置与普通模型账户分离，不探测或复用模型搜索能力。

结果直接返回标题、URL、相关摘录和可用发布日期，不套子对话；高级筛选按后端实际支持执行，不能把提示性筛选标成精确保证。每条持久工具结果把净化后的 title/URL 投影到 session state 来源区；pin/remove 是本地展示状态，重新打开会话从 transcript 重建来源。用户可直接用返回 URL 调 `webfetch`，不依赖不可恢复的临时搜索 ID。

安全：抓回的内容以"数据不是指令"标记包裹（与 Zone 2 同一做法）；fetch/search 共用 user + trusted workspace 的持久域名 ceiling，
工具级 allow/block 只能继续收紧；页面正文永不进日志、事件载荷或 URL。没有消费方的固定每回合抓取次数预算已删除，取消、provider
限流/错误、输出背压与 SSRF 各自表达。

与 `pi-web-access` 的关系：harness 的两个工具是默认；package 的安装/启用本身不会改变工具集。用户要采用第三方同名工具时显式关闭
对应原生 `tools.webfetch` / `tools.websearch`。插件的 Curator、账号操作与存储结果仍保持插件所有。

### 5.9 并发

**实现现状（D-305）。** Pi 0.85.1 的 tracked dependency patch 在真实工具入口消费 `prepareExecution` 和权限门返回的资源计划。
独立工作可以重叠执行，有因果关系或共享可变资源的工作保持顺序；
长操作尽快交回控制权，之后按需读取或等待。适用于普通 coding 和科研线程，不需要为一次工具并行额外创建 Agent。
并行批次仍在工具结果全部配对后继续请求模型；调度许可不替代权限、Documents/WorkingState 提交或 Rust 进程权威。

#### 5.9.1 按资源和依赖调度工具

- **一个实际工具执行入口。** 调度接入 Pi 的真实工具批次路径；不只在 Host 放一个并行队列却继续被上游整批串行挡住，
  也不在外部重跑 Agent loop。优先使用/补齐 Pi 的执行策略接缝，以可追踪的依赖修改交付，不手改安装目录或保留两套调度器。
- **程序提供影响范围。** 原生工具从已校验参数、规范化资源身份与实际读写契约给出资源集合，包含 authority/workspace、
  文件/目录子树、branch、shell 或目标线程。模型无需逐次填写依赖图；一次请求依赖尚未取得的结果时，应在结果返回后再发下一批。
  不按工具名、shell 命令关键词或模型自称“只读”推断权限/副作用，第三方工具沿实际来源和声明处理。
- **保留必要顺序。** 同一资源上写后读、读后写、写后写按调用顺序协调；独立读取、无关文件修改和无依赖的网络查询可重叠。
  多文件 patch 先确定全部规范路径，一次协调其完整集合；目录/子路径与路径别名不能漏冲突。继续复用 Documents/WorkingState
  的修订检查、持久操作和补偿；调度许可不代替底层提交权威。同一 branch 的短暂 CAS 提交串行不等于整项工具必须串行。
- **串行约束只约束必要范围。** 已知资源可以使用各自执行顺序；影响未知且要求 sequential 的工具仍是有序屏障，
  但屏障前后的独立批次各自并行，不再因出现一个屏障就把整批所有调用逐条执行。不能为追求并行越过尚未证明独立的屏障。
  共享 shell 的 cwd/环境修改需要顺序；独立进程可以重叠，但独立进程身份不证明它们不会读写相同文件。
- **审批、取消和结果保持原契约。** 排队前确定依赖，获得许可后执行；等待人工审批不占着文件提交锁。
  同资源失败/拒绝不能让依赖调用误以为前置成功，独立已获许可的调用可以继续。结果按真实 toolCallId 配对，完成进度可先展示，
  不在仍有未匹配工具结果时强行请求模型。取消未开始的工作不留下幽灵调用，已开始的副作用按实际结果与恢复状态报告。
- 不引入调度模型、apply model、固定并发配额或按文件数量限流；背压来自现有 provider/资源能力和实际负载。
  不把同文件多位置编辑、多文件单 patch、多工具并行、多 Agent、后台进程混作一种性能证据。

#### 5.9.2 长命令交回控制权，事实与正文分开交付

目标路径：`bash` 启动 → 短等待后直接完成或返回 shell/执行身份 → Agent 继续工作 → 完成事实进入下一次请求的环境增量 →
需要时 `get_output` 展开正文。命令执行、工具返回与模型恢复是三个独立时点。

1. **启动与等待。** 保留 `bash(command, waitMs?)`；7H 允许 `waitMs: 0` 明确要求启动后即返回身份，通常调用采用可配置的
   短等待后自动转后台。默认等待值按现有交互与代表性短命令测量选择，本设计不猜一个通用秒数。后台分离不终止进程，
   完成恰好发生在分离时也只能形成一个执行和一个真实结果。前台 shell 转后台后不再接收下一条普通命令；新的前台 shell
   对 cwd/环境的继承必须如实表达，不宣称能复制前一进程中任意未导出的环境、函数或激活状态。
2. **等待期限统一。** 协调工具、bridge、router 与进程启动/等待责任，修复当前 30 s 请求期限早于 60 s 后台返回的路径；
   不只是把超时改成更大的固定数。等待结束返回 running/退出事实，取消观察只结束观察，显式 `kill_shell` 才请求终止。
   进程执行期限只有明确产品配置/用户请求才存在；审计并删除未被执行端消费的 `runMs` 等空参数，不把等待超时变成暗中的杀进程。
3. **按需读与事件等待。** 沿用 `get_output(handle, offset?, length?)`，增加可选 `waitMs`：默认立即读；指定等待时，
   已有未读输出/终态直接返回，否则由新输出、实际退出、取消或本次观察期限结束唤醒。静态输出/显式历史切片直接读取，
   不为已存在的字节等待。返回运行状态、退出码或“无新输出，仍运行”，不用循环轮询或“没有输出=卡死”的推断。
   长期等待复用执行准入的让出/恢复接缝；让出模型名额不释放仍被进程占用的机器、writer 或目录责任。
4. **完成通知接 7G。** 真实完成、失败、取消确认等新事实，带执行身份、命令简述、退出码和详情入口，作为来源明确的
   环境增量在下一次安全模型请求前交付、之后留史。后台通知不用 `<user-terminal>` 冒充用户行为，不灌入全部日志，
   不往团队现状四列表加进程清单。尚在运行/输出增长由工具和 UI 按需呈现；不能从日志关键词臆造“等输入”“失败”或科学判断。
5. **交付不漏不重。** 命令执行身份/终态修订、每个模型接收者的事实收据与输出字节游标分开。`bash`/`get_output` 已实际
   把同一终态交给该模型时，不再作为新消息重复播报；仅读过日志不算读过随后退出事实，完成通知也不消费未读日志。
   UI 阅读不消费模型收据。7G 准备失败、取消、压缩/fresh 仍按实际保留原文恢复必要状态，不给历史中已知终态反复追加“新完成”。
6. **何时恢复模型。** Agent 正在推进其他工作时，下次自然请求接收变化；已经空闲时，只有明确建立的等待或用户/Agent
   选择的完成后续做关系才通过既有会话队列恢复。普通后台启动不自动订阅续做，输出增长不发起模型调用；订阅只记录一次
   明确意图、可取消、完成早于订阅也可处理，并与自然续接合并，避免重复模型回合或在 active 会话旁开第二个 loop。
7. **运行权威和生命周期。** Host 做授权、路由和呈现，Rust/既有 terminal runtime 拥有真实进程、输出与退出；
   终止仍到实际进程树，确认退出前不释放 writer/目录保护。执行身份关联原 toolCallId，启动响应丢失后能查询已受理执行，
   不能盲目重试命令造成双进程。查询入口复用既有会话/终端事实，并向模型提供可发现的找回方式。
   普通 shell 按会话生命周期管理，不因此承诺跨 Host 重启重附着或耐久全文；确需断线/重启继续的实验使用 D-300 durable attempt，
   二者共享底层能力和事实呈现，不把每条 shell 都强制变成实验。不可恢复/日志过期如实表达。

验收同时覆盖工具执行并行与资源提交，不以单纯 `Promise.all` 或工具声明证明生产并发；代表性端到端场景和未实测边界见 plan 7H。

#### 5.9.3 会话等待、触发与续接（D-307，待实施）

在 7G/7H/7I 基础上，后续 [阶段 W](agent-harness-plan.md#阶段-w会话等待触发与续接d-307) 让 Agent 自然登记
“条件满足后在原工作中继续”的意图。完整设计见 [agent-follow-up-design.md](agent-follow-up-design.md)。
时间、执行/实验事件、产物/指标/日志条件由程序观察；明确条件成立或约定评估时点到达才交付后续，
不通过无变化的模型轮询维持等待。简单场景沿长任务返回的身份直接登记，复杂来源按需披露说明。

登记可非阻塞，明确暂停才让出模型槽并抑制 Goal 空转续做；实际进程和资源照常管理。
活跃目标通过 7G/消息在自然请求中处理，空闲且已登记继续意图的目标通过同一准入恢复原 session/Thread。
主/子线程均适用，触发与用户新消息合并协调，不新开隐藏会话、不重复运行、不复活已取消或删除目标。
现有日历新任务保留用途，但启动接受与真实完成分开；等待定义耐久不等于普通 shell 能跨重启存活。
本节登记后续设计，现有短等待、后台句柄和 scheduler API 不代表完整能力已接线。

### 5.10 禁用与替换（适用于全部 harness 能力）

发行版模型的另一半是**每一块都可以被用户关掉、换成 Pi 生态的其他部分**。harness 的每项能力在 Settings 的"Agent
harness"页有独立开关，关掉后的行为明确，不留半开状态：

| 能力 | 关掉后 |
| --- | --- |
| 单个工具（`bash` / `grep` / `edit` / `write` / `apply_patch` / `dispatch` / `todo` / web 等） | 覆盖类回到 Pi 内置实现；新增类不注册。用户可安装任何 Pi 包提供替代 |
| 输出句柄截断 | 工具结果原样进入上下文（Pi 默认行为） |
| Zone 2 组装 | 不追加简报；`before_agent_start` 不返回 `message` |
| 后台摘要准备 | 不提前发起摘要请求；容量不足或用户手动压缩时使用同一摘要实现，允许等待；计划/知识仍可用 |
| 自动压缩（Pi 开关） | 不自动准备或提交压缩，手动压缩仍可用；超出可用容量时明确报告，不靠裁剪伪装成功 |
| 知识库 | 不写入 event / block；`recall` / `related` 不注册；已有 `.tdb` 保留不删 |
| 子 agent 团队 / 单个角色 | `dispatch` 不注册或该角色从团队移除，主 agent 自己做；槽位未配置的角色本就不存在 |
| `explore` 与模型选择 | 工具本身有独立开关；models.explore 服务局部语义决策，清空时无该模型调用并保留算法/向量材料。嵌入/重排绑定分别见第 8.5 节 |
| Piarium 权限门 | 不提供关闭整个交互权限门的独立开关；用户通过 mode/rules 控制策略，`bypass` 是明确的用户选择。会话记忆授权可用 `/piarium-permissions` 撤销 |

规则：

- **不按包存在自动让位。** 同名第三方工具不会仅因 package 安装/启用就改变会话工具集或权限 owner；用户要替换原生
  `webfetch` / `websearch` 等能力时显式关闭对应原生工具。权限确认始终由 Piarium 原生 gate 统一拥有，第三方工具本身仍经过该门。
- 设置**按字段决定所有权**（D-031），不是整份设置一条规则；工作区级只在项目已 trusted 时生效（复用 Pi 的 project trust）：

  | 字段 | 所有权与合并 |
  | --- | --- |
  | 模型槽位 `models.*`、provider 凭据 | user-only |
  | 后台摘要准备与调度偏好 | user-only，全局默认与会话覆盖沿既有配置路径；有效窗口/输出设置继续由模型配置解析，不新增 harness 容量副本；旧 keeper 设置退出规则见 8.4.6 |
  | `knowledge.autoAcceptSuggestions.user` | user-only——一个仓库的配置绝不能替用户打开"自动写入用户级长期记忆" |
  | `knowledge.autoAcceptSuggestions.workspace`、`knowledge.eventRetentionDays` | 工作区可设 |
  | `tools.*`、`shell`、检索策略、`dispatch.concurrency`、`output.*`、UI 偏好 | user 默认 + 工作区覆盖 |
  | `permissions.mode` / `rules`、`dispatch.askBefore` | 工作区**只能收紧**（`bypass < accept-edits < normal`，只能向右；只能追加 ask / deny 与"派发前询问"）；`smart` 需用户显式开启 |
  | `web.*` 域名策略 | user 与工作区取更严格组合 |
  | 能力可用性（如线程运行时是否存在） | **不是设置**，由 host 经 RunManifest 注入，只读 |

- 普通模型/工具设置在下一次会话构造或明确的新 Run/执行配置世代生效，不能隐式改动正在执行的配置。Workbench 布局独立变化；
  权限撤销属于执行门的实时限制，不必修改工具 schema（目标契约，接线状态另记）。
- 开关状态在会话开始时写入 `session` 节点并显示在诊断面板，便于排查"为什么这次没有 X"。

v1 工具在 pi-host 内，不是 Pi 包，因此不出现在 Plugin Settings。若将来需要让用户以第三方工具替换某一项，把
`harness-tools.ts` 提升为 Pi 包是搬家而非重设计——同名覆盖 Pi 包同样可以做。

### 5.11 对话式设置与 Agent 管理（D-306，待实施）

设置页与对话管理同一套配置，目标覆盖现有大部分设置及相关管理动作。完整设计见
[agent-settings-design.md](agent-settings-design.md)，实施见 [plan 阶段 S](agent-harness-plan.md#阶段-s对话式设置与-agent-管理d-306)。
共用设置描述与真实 owner 的读取、校验、写入和生效逻辑，UI 搜索与 Agent 目录从同一来源派生。
原生查询/修改工具提供实时配置、来源、支持范围、动态选项及实际结果；Skills 按需解释组合方法。

常驻短能力入口，相关设置按 search/read 披露；简单项查询后即可修改，复杂项继续展开说明、选项和示例。
不强制先读 Skill，不把完整目录或动态配置快照放进 system，不因发现新字段增添一批工具定义。
set/reset 保留真实字段所有权与 revision，普通修改沿已有授权，安装/登录/连接走原领域动作。
保存与生效分别表达，冻结 Run 的配置只在原有合法边界更新；UI/Agent 同步同一状态，远程 Host 与本地客户端目标区分。
本节是接受的设计，不表示现有后台设置 API 已完成 Agent 接线。

## 6. 检索：三层，两个归属

代码检索既有精确的符号、路径与错误信息，也有“不知道实现叫什么”的自然语言问题。词法、结构和向量各自产生有用线索，
在同一当前来源中读取原文；语义召回独立发现候选，不要求先被词法找到。任何单一来源暂不可用时，其他来源仍正常工作。
衡量的是主 agent 取得有用材料的时间与质量，索引覆盖或某个来源排名不能代替最终可读结果（D-173）。

**检索范围是一等参数，工作区只是范围的一种**（D-162/D-173）。当前 code profile 的范围是工作区，包含尚未打开或修改的实现；
访问与变更事实只影响后台建设顺序。文件知识工作可选择跨目录根、工作集或集合，不能把这种可选范围悄悄变成代码检索的热点白名单。
范围键保留 `workspace / roots / working-set / collection / user` 的接缝，当前仅实现 workspace；索引以
`{ scopeKind, scopeId, documentId, revision }` 定位来源，documentId 不假定为文件路径。邮件等外部来源仍不在本轮交付范围。

文件名/元数据、全文词法、语义表示各自按其消费者建设，不为快速检索先索引整台电脑。已知路径可直接读取，开放概念可并行咨询
可用词法与语义；工具选择不要求前一路失败。工作区之外的范围与来源继续随 `knowledge-work-in-files` 消费者实施。

3.15 负责查询与呈现，3.16 负责嵌入后端、索引与覆盖层；按真实依赖推进。AFT 的批推理与增量复用提供参考，其符号开头摘要
有正文盲区；Piarium 的全文切块也只有在有效编码、及时发布并被查询正确使用时才有价值。两者都不能仅凭表示形状宣称召回更好。

### 6.1 第一层：文件里有什么

本节是 D-173 收敛、D-174 纠正 LLM 范围、D-175 补齐局部取证与查询契约后的现行设计；历史规则与观察保存在决策日志，交付
事实见 status。目标是让主 agent 用自然语言和已有线索发现相关实现，得到能直接阅读、继续判断的当前原文。检索同时优化
发现能力、首次有用结果的延迟与材料可读性。

**工具边界。** 主 agent 按所缺材料选择工具，不要求逐级失败后才能升级：

| 工具 | 负责的工作 | 返回 |
| --- | --- | --- |
| `grep` | 已知符号、字面量、错误信息的精确匹配 | 命中位置与上下文 |
| `explore` | 概念/线索召回、入口定位、相关单元阅读、机械下一跳与有依据的局部补查 | 当前代码、路径、范围、必要关系与具体缺口 |
| `retrieval` 角色 | 需要较长阅读与语义判断的开放事实问题、跨文件机制追踪 | Host 校验后的事实报告：问题与范围、source-checked 事实、路径修订/行范围或带 receipt 的 URL、耐久证据、unknowns；不含建议或优先级。Host 不证明 claim 为真 |

快速工具与 retrieval 共享底层读取和搜索能力，产品职责保持分开。explore 的正式方案由算法、向量和 LLM 分工：算法负责执行，
向量负责候选召回，LLM 负责规则无法可靠表达的局部语义决策。普通低成本模型不能仅换一个工具名就成为完整检索子 agent；
这不妨碍它在一次查询理解或候选选择上发挥作用。开源扩散基座与后训练另行讨论，当前不依赖它们。

**所有权。** Application Host 拥有文件搜索、结构与图查询、Documents、索引和输出存储，以及受它管理的本地嵌入实例。
pi-host 拥有请求中的问题、会话来源引用与已配置的生成式模型调用；UI 拥有可变编辑器草稿。模型/provider 选择与凭据仍由用户现有
配置 authority 管理，不在检索模块复制一套密钥存储。后台索引使用显式解析的范围绑定，不能随任意活动聊天的主模型改变。

Host 持有短生命周期的查询上下文：原问题、actor/范围、输入来源引用、候选生产任务、已读快照、候选视图、工作预算与结束状态。
pi-host 执行模型请求，将搜索计划和选择交回同一次查询。公开工具仍是一次 explore；内部协议支持开始、补充表达、取得候选视图、
提交选择、结束/取消，不建立新 Thread、持久会话或通用工作流框架。查询引用绑定既有 actor/会话，不能凭 ID 越过来源与路径授权。
后续 RPC 延续开始时的来源，不能重新取活动窗口的 getInputContext；已知写入仍按既有规则终结对应路径的旧草稿权威。
本轮截止条件覆盖所有阶段，不因新 RPC 重置；取消传到 Host 查询及模型请求。公开工具调用结束或所属 pi-host worker 关闭时
清理查询，单个阶段 RPC 返回不终结整次查询，迟到结果不复活已结束状态。
查询取消不影响共享后台索引。bridge 本地拒绝 Promise 不能充当 Host 任务已经取消的证据。
现行 bridge 在 signal、请求 timeout 与 worker dispose 时先发 `harness.cancel`；start 结果未送达也由 Host 的 response-delivery
回调释放。对于本地 ONNX，JS signal 能停止等待并丢弃迟到结果，不能抢占已经进入 native runtime 的当前推理批，不能把前者写成后者。

**请求只声明已知事实。** 沿用 question / anchors / paths；已知地址直接用于定位，显式范围约束所有来源与派生路径。
显式 paths 使用 Host Router 已授权的 workspace-relative 身份；有界查询在有效范围内生成、评分并截取图/向量 Top-K，不能先让
全工作区候选占满 K 再过滤。查询开始时固定的范围贯穿
原问题、模型新增表达和局部补查，后续阶段不能换根。
从引号、技术字面量和已知语法形状提取的对象可作搜索线索；同义推断、材料角色和关系倾向保留为推断，不能变成用户未要求的
硬过滤。收窄原计划的 `AnswerRequest`：保存已有明确要求，不建设从任意自然语言推导完整答案规格的规则解释器。
`register("x")`、同一连接值的两端、确切定义存在等均可核验；它们说明局部事实，不自动证明已解释问题中的机制或原因。

**LLM 做局部语义决策（D-174–D-189，已接线；证据见 status 3.15）。** 使用已有 `models.explore` 槽位，由 pi-host 的 ModelRuntime 发起短调用，
沿用当前用户的 provider/凭据与取消路径。两处消费者各有明确输入与输出，按请求需要使用，不强制每次经过全部模型步骤：

- 查询理解与搜索表达：输入原问题、已有锚点、显式范围及少量可用仓库词汇，输出要寻找的行为、按概念分组的搜索表达与预期
  材料。目录、包配置、已有入口/导出和已返回锚点正文可以提供真实词汇，不等待全仓摘要。模型猜测的行为与材料关系保持推断，
  不覆盖用户对象/范围。组内变体扩大匹配，跨组命中可用于词法源内排序，同时保留单组强线索，不强制 AND，也不按改写数量增票。
  自然语言入口未知时，配置有效就参与；原问题词法、可用语义与明确锚点同时执行，新表达补进本轮查询。有地址只说明可先读，
  不能由此推定用户只要导航；已知文件的机制问题仍可能需要材料判断。
- 候选相关性与选段：输入原问题、已读当前单元和呈现选项，输出互补的材料组、候选/视图 ID、必需与辅助范围、简短用途及缺口。
  优先选 Host 提供的范围 ID，自选范围也须属于模型实际看过的正文。Host 验证身份、修订、范围并提取原文；这只证明来源有效，
  不证明模型语义判断正确。原要求、曾尝试的搜索假设和当前源码分开输入，允许否定查询阶段的猜测，不共享强化假设的长对话历史。
  不要求全池数值评分、固定“触发→状态→消费”模板或最终分析答案。判断输入位于最终挑选/排版之前，不能只接在已有 24 KiB
  输出后；先去重共享正文，再按实际模型容量组织有竞争力的候选，输入预算与可见输出预算分开。未送入模型的材料记为未评估。

查询理解与候选选择复用同一模型绑定，但不把“一次判断”扩成长期子会话，也不对每个文件各调一个模型。已有明确输入才发起
对应调用，批量候选一起判断；不设统一调用次数硬上限，也不固定套 intent→judge→repair 流程。速度按整次查询的模型等待、
搜索与读取判断，不能从短输出或低单价直接声称秒级。槽位已配置就按上述需要调用，缺配置或调用失败才使用已取得的算法/向量材料，
如实记模型未参与；这不是以独立评测、专训或新模型发布作为启用门槛。

**局部补查。** 当前代码给出的明确符号、连接值或路径由 Host 直接定位；候选模型也可指出一个有候选/范围依据的具体缺口，
提交保持原问题和范围的搜索表达，由 Host 批量执行。已执行查询与已读材料去重；新增材料若是明确所求的短定义，可直接补充，
需要语义比较时只对已选材料和新增材料增量判断，不重跑查询理解或完整候选池。首版可安排一个可选补查阶段，但不把“一次”
设成永久调用硬上限。边界是仍在补齐有根据的局部材料：无新线索/材料、已用完本轮工作预算，或需要重构问题、试验与持续比较
调查方向时，交回主 agent/retrieval。缺口表述限定于已读材料，并附实际未完成来源，不能声称仓库不存在该实现。

**来源与当前正文。** 用户发送消息时的窗口草稿，经 Document Registry → 鉴权 Documents 通道捕获到 Host 固定 snapshot；runtime
只传不透明引用或 capture unavailable 与已知脏路径。每次读取记来源、revision、hash 与 span。这是请求内已读文件的版本集合，
不是整个工作区的强一致快照。捕获失败的脏路径不取磁盘冒充；无 surface 的 headless 请求使用磁盘。磁盘写入按 D-088 终结该路径的
旧草稿读取权威；根会话对仍由本轮 snapshot 拥有的路径经 `document.surfaceWrite` 改同一缓冲（D-225 / D-228 / D-232），后续 read/edit 看到新正文。
其余路径仍沿本轮输入来源。检索、read/grep/find/ls、语言导航与线程基线沿同一规则。

语义块与图节点首先是带身份的定位线索。范围仍匹配当前正文时可采用；只发生平移时按块正文与父单元重新定位；对应内容实质改变
时读取当前代码并重新取得相关性依据，旧相似度不能替新正文背书。重新评价尚未完成时保留为导航线索并说明状态。派生路径也须经
workspace/realpath 授权；缺来源不能伪造第 1 行、连续正文或“空成功”。固定来源细节见第 6.4 节与 Documents 设计。

**查询过程。**

```text
固定问题、范围与来源 → 原问题检索/明确导航，与 LLM 分组搜索计划并行
        ↓                             ↓
多路候选到达即更新待读队列 ← 补充搜索表达
        ↓
当前来源读取 → 重点范围与结构单元 → 必要的明确下一跳
        ↓
LLM 成组选段 / 配置的重排器 / 来源排名 → 有依据的局部补查与必要的增量选择
        ↓
保留必需范围 → 去重与一次预算呈现 → 原文、引用与实际缺口
```

请求执行器拥有本轮的候选、已读快照和结束状态。来源完成后将结果交给这个所有者，不能由异步回调直接改已经返回的输出。
已取得的候选可以开始读取，不等固定 `Promise.all`。排序中的来源家族与调度中的候选生产任务分开：已启动的查询模型及后续
搜索也是在飞生产任务，多个改写不获得多份保留额。在既有读取预算内，按活动任务与常规读取批次保留首批机会，其余立即共享；
来源返回后参与一次常规候选读取便释放保留，空/失败/取消/截止也释放。全部命中已读文件时复用正文与重点范围，不补读弱文件
凑公平。保留的是参与机会，不是输出名额，也不新增固定文件配额。后来的来源调整未执行队列，已读文件与解析结果复用。

主要任务首批机会处理或结束后可以冻结候选视图进行批量判断，不随每批到达各调模型；本轮预算也可提前结束来源等待，保留
判断与呈现的执行时间并标明未完成项，不能把首批机会重新做成必须等齐的屏障。没有统一新增等待秒数；早读不等于最终返回
必然更快。模型运行中新增材料保持未评估，必要时单独增量比较，不能混入该模型未见过的已排序集合。明确导航满足时可返回；
开放问题按来源结局、读取与补查进展、判断材料和本轮截止条件收口，模型说“够了”或词法已有命中均不是全仓充分性证明。

冷库首个有用结果、热查询、编辑后的更新时延和完整构建成本分别观察。后台构建不阻塞查询；向 UI 先显示进度不等于主模型已消费
结果。取消/超时应到达本轮来源与读取任务，迟到结果不能复活请求；取消查询不取消其他读者共享的索引建设。当前 120s 公开等待与
8s 判断预留是为 provider 卡住和最终结果饥饿设置的工作默认，不是 SLO，尚无真实 provider 定标；后续按实际后端行为调整，不从该值
外推出性能或新增文件数、轮数、并发硬上限。

**召回。**

- 词法仍复用 search-service 的 rg 与固定草稿覆盖。完整对象、驼峰/路径拆分等变体属于同一词组；普通内容词作为词法线索，
  不自动变成代码标识符。查询内区分度只描述本次实际候选池，保留 complete / lower-bound / unknown，不冒充全仓库 IDF。
  候选预算与输出 limit 分开，按文件铺开获取机会，避免前几个文件的重复命中耗光预算；重叠根的丢弃数只报告可信下界。
- 路径、精确定义与图查询提供明确导航或关联候选。只有问题/已读材料给出的对象才驱动对应查询。图记录的 range 是线索，
  返回前在当前正文核实。object-triggered / statement-evidence / same-container 保留为到达理由；同容器不是相关性证明。
  只展开当前明确对象或参与解释的具体语句；无关注册表项和整文件出边不自动成为支撑。
- 语义直接对原问题产生独立候选路径和重点范围，不需要先被词法发现。它在开放候选里与其他可用来源正常竞争；同一文件的
  多个块和同一问题的多个变体属于同一来源家族，不靠数量叠加票数。缺模型、未建完、失败各自表达，已有来源仍提供材料。
  中文问题与英文代码的匹配依赖所选模型；分词、模型体积或接口存在都不能代替跨语言能力。

**读取调度。** 明确要求的精确导航直接取得对应正文，仍计入本轮工作；名字出现或一条弱图关联不等于已满足导航要求。
其余开放候选按来源内真实排名融合，取消“纯语义永远低于 import/association”的来源 tier。词法一路按实际词组匹配排序，
语义一路取每文件最有希望的块；来源内去重后使用 RRF：`R(f) = Σ 1 / (k + rank_s(f))`，沿用现有 k=60。
同分保留并列名次，路径只作最终稳定 tie-break。图若只给无相关性顺序的路径集合，不按字母序制造一份 RRF 排名；明确目标走
导航，其余保留为可探索线索。来源内的重复查询只贡献一次名次，来源缺席不补伪造的零分命中。

**单元与相关性。** 当前文件中的 `focusRanges` 接受词法行、已核实图位置和语义块，不把“必须含查询词”设成生成单元的门。
候选单元携当前原文与修订、父容器、各路到达材料和可选的展开范围；同一函数被多路找到合并到达理由，函数内部不同重点范围
仍可分别保留。`arrival` 记录怎么找到，`assessment` 只记录已核实的具体事实，`purpose` 说明这份输出中的用途；相似度不成为
事实置信度，未核实的语义候选也可以作为最有希望的原文入口呈现。

读取后的相关性只取单元自身的材料。LLM 候选判断或重排器未参与时，单元上的词法匹配形成词法排名，落在该单元的语义块形成语义排名，再使用同一
排名融合机制；不能把文件名次、整文件词法得分或另一子块的相似度广播给所有窗口。这是 D-173 对“RRF 只在文件级”的修订：
文件调度与单元选择复用算法，但候选集合、输入证据和排名分别计算。纯图单元仍以真实导航关系呈现，不伪造向量/词法分数。

一次候选选择使用一份有效的相关性判断：需要语义解释/成组选段时使用 `models.explore`；仅需统一排序且配置了专用 reranker
时可由它完成。共享当前正文输入，但输出契约不同：LLM 可给互补关系、必需范围和缺口；普通 reranker 只给视图顺序/分数，
不据此推断支撑行。重排输入须为已定义的可展示视图并符合实际输入长度，不能让后端截掉正文后仍声称评估完整函数。二者不默认
串跑，成功评估的材料由该结果决定相关性，来源排名服务召回与未评估材料，不再叠加旧规则奖金。
不同模型的分数不直接混用。`windowScore` 的十一项拼盘删除，不等重排后端完成：角色与明确范围由请求处理，已验证关系记事实，
重复片段由去重处理，字节成本由呈现处理。对未知的生产/测试偏好保持中性或软偏好，不能用角色墙压过更相关的材料。

**一次决定呈现。** 先保留待选择单元的原文与展开选项，按材料组/相关性结合去重和真实 UTF-8 预算选择输出。LLM 选择的必需
范围须保留，Host 可增加外围条件、扩展语法块或合并重叠；装不下时选择仍含必需范围的较小视图、放弃相应材料组或明确报告
缺口，不能裁掉依据后保留原来的已展示结论。组由本题材料形成，不预设固定角色模板。重排路径保留实际评估的完整视图，
或在评分前构造可展示的较小视图，不能评分后任意改短。小容器优先完整读取；
大容器给签名、重点所在语法块、解释该块所需的局部控制条件与省略标记。结构范围用于让代码可读，不建设通用程序切片器。
普通变量/成员绑定归其所属函数或类；绑定本身定义函数/类时仍是独立单元。缺结构时返回带状态的行范围，不冷启动 LSP 等待语义分析。

limit 是上限，不是填满目标；相同原文与重复事实不反复占位，同文件里不同机制也不因来自同一路径受罚。标题、状态、引用和句柄
提示计入同一预算，formatter 渲染已决定的内容，不在末尾再次裁掉选择依据。根据一组内容选中了候选，却只展示无关签名时不能
沿用原来的相关性/已展示结论。最终呈现记录说明实际输出的源码范围和省略项，观察脚本读这一份记录；逐候选细节不默认塞进模型。

**正文索引与模型后端。** 搜索范围包含工作区里尚未打开的源码。已访问、修改和显式聚焦的文件只影响建设顺序，不能成为隐式
白名单。保留正文区域的编码覆盖目标，摘要可作为额外导航材料，不能用只索引符号开头或仅热点正文替代独立的陌生实现召回。
索引范围按实际可读来源与用户配置确定；忽略规则是默认信号，不是内容重要性的定义，代码与文档来源也不能仅因易产生噪声就一律排除。

小单元在模型输入能容纳时整体编码；大单元按结构子块递归，缺结构或仍过长时使用重叠文本块。每块都按所选后端 tokenizer 和
有效长度独立检查，不能沿用首块行宽再截掉后续块的正文；单条长行按 token/字符位置继续切分并保留位置。正文覆盖以实际送入
编码器的区域为准，行号已出现不等于整行已编码。路径、父单元名、必要签名与正文共同设计输入：容纳不下时继续切正文或压缩
装饰，不能让大量路径/签名占满输入，也不把 512 这类有效上限当成每块必须填满的目标。

嵌入接口区分 query/document 用途、有效长度、取消、批次对应与实际维度。本地 MiniLM 是用户主动安装的可选组件，主包不携带模型和专用推理库，启动不自动下载；未配置远程且组件已安装时才使用它（D-288）。远程嵌入
走 `harness.embedding` → `harness.embed` → OpenAI 兼容 `/embeddings`，复用 Pi provider 与凭据权威。知识库召回在配置有效时
走同一绑定，向量写在独立代际目录，不改权威 `.tdb` 维度。模型选择不取当前聊天主模型；换绑定按兼容空间切换查询与后台建设，不能用旧空间向量响应
新模型。第 8.5 节定义配置责任。本地模型是否适合中文、代码与当前吞吐分别说明，不以“小模型跑得动”推出检索效果或速度。

身份继续分三类：向量空间（后端/endpoint、模型修订、维度、pooling、归一化与用途约定）；索引配方（切块、结构提取、装饰与粒度）；
查询/重排配方。相同空间与用途下的实际编码文本可复用向量，行号移动或同文件其他块变化不要求重算未变文本。换 API key 或
重排器不重嵌正文。代码向量继续在独立代际 TriviumDB 中，不改变权威知识库的维度与内容。

**建设与查询分别调度。** Host 为每个范围合并扫描与变更工作；一次枚举，按批读取/解析/嵌入，先查编码文本缓存再提交未命中项。
同一模型初始化共享在飞请求，推理批次按真实后端内存与吞吐组织；模型实例的任务队列在当前批完成后优先服务等待的前台查询，
再继续后台批，也为后台保留进展。不能预先把整仓后台推理排入不可插队的队列，再靠扫描循环 yield 声称前台优先。
线程参数设置到实际使用的运行时：Node ORT session 与 WASM 配置不能混为一谈。语义扫描与符号目录可复用相同修订的正文/结构
事实，查询不等待目录全部建成，也不为了取一条记录逐文档重新遍历整库。

每批发布其已捕获的文档修订与完整块集合，旧的异步计算不得覆盖已发布的更新修订。计数增量维护，检查点与 flush 合并处理，
不把全库扫描/重写放进每文件路径。持久化先于可见进度，中断后恢复已发布内容；扫描结束时对账删除项和未完成项。
coverage 描述约定范围内实际编码与发布的覆盖，不因枚举循环结束就把读失败、缺模型或未处理路径记成 complete；缺结构但已用
文本块完整编码的文件仍可算覆盖，结构能力与编码覆盖分别记录。
index.lifecycle 与查询结果状态独立，部分索引可查，查询空结果也不代表未覆盖范围没有实现。

查询开始时尚无兼容可查部分，若首个有效发布在本轮来源接收阶段内到达，可据此启动语义查询；监听实际发布事件，不逐批重查、
不等待整仓或延长本轮截止条件。已结束来源窗口和最终返回的查询不接受这次迟到唤醒；后续查询使用新覆盖。

**固定草稿和线程覆盖。** 基础索引 + 当前分支变化 + 本轮固定草稿 − 被替代路径，身份与授权沿既有来源。
捕获正文不等待嵌入完成；按内容哈希在后台计算对应向量，同路径旧磁盘块立即从该视图遮蔽。覆盖层尚未就绪时报告该路径的
语义缺口，词法与读取仍可使用已捕获原文。向量计算可共享，路径/分支归属不能混用；隔离线程不读入 live 父目录后来出现的内容。

当前物化线程直接使用自己的 Documents workspace，不遍历父 WorkingState 对象表作为语义语料。增量写入沿冷扫的文件筛选；
`copyIgnored` 是执行与结果捕获配置，不自动将文件纳入语义索引。已捕获草稿的建设任务由 workspace runtime 持有，重复正文合并；
查询结束只结束该查询的等待，后台建设继续，runtime 关闭时取消。待建草稿先报告 gap，后续查询使用已完成向量（D-195）。

工作区设置、后台推理绑定、配置订阅、查询视图与关闭清理由同一 `WorkspaceSemanticRuntime` 装配（D-235）。Documents 写入
与 Pi 原生工具的成功 journal after 都通知这一实例；原生工具答复前标记旧向量失效，正文读取与嵌入在后台进行，不等待 settle。
仍为虚拟分支时必须取得固定 WorkingState 视图，缺视图报告不可用。物化后按执行目录对应的 Documents workspace 选择 Pi 推理
worker；配置刷新未完成时查询等待或取消，已退出 worker 的迟到绑定不能发布，新订阅建立后重读未观察期间可能变化的设置。

**输出与验证。** 来源结果沿已有 not-requested / ready / empty / unavailable / failed / stale 等状态，超时/取消分别表达；
输出以原文、引用和影响下一步的缺口为主。OutputStore 是经鉴权的会话局部临时存储，保存实际打包材料和未展示候选引用；
不暗示所有未读文件正文都已在其中。只有能证明同一 revision 的相关 span 仍在主模型实际输入中时才可用指针省略正文，未知就返回原文。

验证针对实际问题：纯语义命中不能被来源等级挡住；选择依据确实出现在输出；来源等待/取消不拖垮其他结果；切块没有隐藏截断；
修改与重启不混用修订/空间。既有观察工具区分冷库首个有用结果、热查询、编辑更新和完整建设。十问作为回归材料，按需要加入
真实新问题，不以独立评测集或统计不劣证明作为接线与默认使用前置。真实模型观察同时看首轮关键原文、后续纯定位往返和整体
等待；按实际问题分别启用查询计划、材料判断或补查帮助归因，不要求全组合实验。工具描述随消费者更新，不能继续声称自然语言
只按字面匹配。不自动从后续 read/edit 学相关性，也不新增辅助费用/Token 看板。

### 6.2 第二层：这段代码和什么有关

由知识库拥有。节点是文件与符号，边是 `defines` / `imports` / `connects` / `associates`（tree-sitter 写进同一张图）
加 `references` / `calls`——语言服务解析出的真实关系，由 relation collector 与 lsp 导航回写进入同一张图（D-240）。
这不是 Aider repo map + PageRank：多跳扩展和 rank 分数都还没做，也不在本刀范围。早期 TQL 草稿
（`EXPAND [:calls|references*1..2]` + `pagerank`）留作远期形状，不是当前契约。

图把名字、路径和连接字面量变成可追踪的关系，提供三类定位材料：

1. **定义位置。** 目录知道 `foo` 在哪儿定义、是什么 kind；一般文本命中只说明哪里提到了它。
2. **连线配对。** rg 给你散落的 N 行；图知道这个字面量的一端是 `register`、另一端是 `request`。
3. **反向依赖。** 「谁 import 了这个文件」不需要查询词。

这些关系可能带来词法未取得的入口，也可能与现有候选重合。比如连线的注册端没有进入 rg 候选、或需要读取未含问题词的调用方；
收益由实际查询决定，不预设“只有一种边增加召回”。导航与开放候选的读取规则见第 6.1 节，图来源本身没有永久排名优势。

当前图：Documents 写后事件 + 冷扫描把磁盘正文写进 `file → defines → symbol` 和 `file → imports|connects|associates → link`
（绑 `documentRevision`，共用 generation；D-087/D-105）。`references`/`calls` 行是另一类 link：来源是语言服务的解析
（`resolvedBy` 记录 `lsp.references`/`lsp.definition`/`lsp.callHierarchy.*`），按 relation key 重解析即替换，不叠重；
它随站点文件的 generation 消亡，不属于冷扫描抽取。LSP 暂不可用时保留最后图，权威空结果才清旧符号。
确认连接与同名字符串关联候选分开，候选必须真是同名（D-106/D-109）。冷目录覆盖带 `importQuery` 的语言
（TS/TSX/JS/JSX，D-115）；纯 Python 仓库对目录来说是 `empty`，不是坏了。轮廓收录模块级/类级值绑定（D-113）；
边查询被阻塞时照写 defines 并记 `linksIncomplete`（D-111）。

关联候选的 value/line/callee 与 file 的修订、generation 一起保存为紧凑抽取记录；未确认者不建 link 节点、不进文本索引。
同名确认和撤销只更新当前代际的关系，不再在扫描末尾重读、重解析并重发整份符号。显式重扫仍读取枚举文件的真实修订，
相同 revision 与 extractor 才跳过解析；没有收到 Documents 事件不能证明外部磁盘未变（D-236）。

显式重扫在完整枚举后对账旧路径。列表中缺席还不够：Documents 必须确认 missing，store 再按旧图 revision/generation 条件删除，
排队期间取消也不得删除。路径重现则重新采集，连接消失后撤销相关关联；枚举失败、截断或未知时保留旧图（D-237）。
这是派生图对账，不是对任意外部进程的文件系统事务。

**读者。** `explore.search` 把图当第二路路径候选（定义 / 连线另一端 / 反向 import，D-136，取代 D-108 的「不扩候选池」；
另有已解析的 references / calls 边，按显式 relation 预算进候选），并继续用 `details.relations` 注解已经选中的摘录（D-112）。
`related` 是真实注册的工具：对一个路径或符号名回答它定义了什么、import 了什么、谁 import 了它、它在哪些连线上以及另一端
在哪——并在语言服务可用时回答**已解析的** reference 站点与 call 边（谁调它、它调谁，D-240）。每一项都能表达「没有」和
「不完整」（`linksIncomplete`、specifier 未解析、目录不覆盖该语言、relation 段 `unavailable`/`unsupported`/`partial`）。
`related` **不是**更差的 `lsp.references`：references 按精确位置回答「谁引用这个符号」；related 围绕锚点的定义做有界
解析，且不要求语言服务在跑——没有时只回答文件级拓扑与已存的 resolved 行。

反向 import 在**查询期**解析：相对 specifier 相对于该文件所在目录加上常见扩展名（含 `.js`→`.ts` 孪生）；
非相对（包名、别名）保持未解析。解析不了可见地报，不猜（D-135）。解析结果按目录形状缓存一份反向索引，
任一写入整份失效——新增一个文件会让别的文件原本解析不了的 specifier 突然解析得了（D-139）。store 读路径只用
已经打开的库，未开返回 `unavailable`，不开数据库（D-112/D-138）。

图查询的成本按**热路径上的调用次数**衡量，不按单次墙钟：一次 `explore` 会对每个种子路径问一次反向 import、
对每个 distinctive 词问一次定义，所以「单次 42 ms」和「一次调用 892 ms」是两回事（D-139 的复验数字进 status）。
`related` 正文自己按段设可见上限、`details` 保持完整，和 `explore` 一样不把「装不下什么」交给最后的通用截断器。
结果带查询期 `roles`（路径、角色、依据），正文写明这不是图上的事实。

图只选路径。`documentRevision` 可能过期或为 `null`；范围只能当定位提示，物化后必须在当前正文里重新确认名字。
确认不了就不输出这个窗口。目录只有冷扫描 + Documents mutation 那么新，shell 和外部进程的写入不被观察——
路径级召回 + 当前正文物化就是为此设计的，不另做第二套过期检测。

`references` 与解析后的跨文件 `calls` 已接（D-240）：relation collector 对查询锚点做**有界**解析——每个定义一次
references + 一次 definition + 一条 callHierarchy 链——lsp 导航也把已拿到的结果写回。两处都只持久化磁盘绑定的答案：
锚点文件按绑定 revision 固定，跨文件站点是语言服务器自己的读盘结果、一律 `pinned: false`；目标文件 revision 移动后
行报 `staleTarget`，目标被删除时指向它的行随文件删除一起移除，站点文件重新采集时旧 relation 行随 generation 消亡。
图库由 owning workspace 持有，Documents/LSP/路径由 execution workspace 持有（D-254）。`explore` 只把 owning 图当候选并在
固定 execution 正文中重新定位；`related` 会直接陈述图中位置，所以 owning≠execution 或本轮含未保存草稿时明确 unavailable。
公开 LSP 的文本、raw value 与图写后行都先按 actor scope 过滤；权威空结果按 anchor + relation kind 清掉旧行。
绝不对每个 symbol 无界请求 references 来伪装完成；PageRank 仍未接。仓库级词法索引仍等观察到「找不到入口」再定。

图是**已提交事实**：范围只从磁盘正文采集，并逐文件记录该 document revision（D-087）。脏缓冲算出的范围不入图——它既不是磁盘状态，
也不是任何一轮输入的固定草稿。消费者据修订判断范围是否仍然成立，不成立时按来源状态降级，而不是拿一份无身份的范围继续用。

### 6.3 第三层：我们之前做过什么

由知识库拥有。轨迹信号（编辑 diff、终端命令与退出码、诊断、会话决定）**不追加进对话**，存为可检索事件；
Zone 2 只放 top-k 指针，正文由模型通过 `recall` 拉取。见第 7 节。

### 6.4 语言服务视图：谁的正文、哪个修订（D-087）

第 5 节的导航与诊断工具、6.1 的结构展开、6.2 的符号图都从同一个语言服务器取答案。**一条会话不能同时是编辑器的实时缓冲和
agent 本回合的固定正文**：正文由最后一个写者决定，版本号又是编辑器的 `localEditRevision`，于是符号范围无法归因到任何一份可取得的
正文。在这种结构上补一个 revision 字段只是给来源不明的内容贴标签。

会话键因此是 `(workspaceId, languageId, viewId)`：

| 视图 | 拥有者 | 正文 | 版本与修订 |
| --- | --- | --- | --- |
| `surface` | UI | 编辑器实时缓冲 | 沿用 `localEditRevision`，行为不变 |
| `agent` | Application Host | 导航：D-082 的 `AgentInputContext`（脏路径取固定草稿，其余取磁盘）；符号采集与诊断：只取磁盘 | 版本号 Host 按 (视图, 资源) 单调分配；修订为 `surface-draft:<ref>:<localEditRevision>` 或磁盘 `revision` |

三条约束：

- **惰性。** 首次发生 agent 查询或符号采集才为该语言起进程，空闲超时与 workspace dispose 释放，进程数/开文档数/空闲时长可查询。
  只有一侧活动时仍是一个进程，编辑器与 agent 同时活动才是两个——这份成本如实记账，不藏在"视图"这个词后面。
- **绑定到哪一层就说到哪一层。** 被查询文档是精确绑定，请求前后都断言修订。跨文件位置由语言服务器自己读盘算出，LSP 不报告它用的
  版本，所以一律标 `unpinned` 并说明原因；不给它们编造修订，也不用覆盖不全的信号（Documents mutation 观察不含 Pi 原生写入）去判
  "未变化"。
- **视图各管自己的文档。** 用户关闭标签页不销毁 agent 视图，agent 视图打开的文档按 LRU 设上限、空闲释放，不再单向增长、不再在
  服务器重启时全量重放。语言身份由 Host 单一静态解析器给出；运行时由编辑器注册表贡献的语言仍只在 renderer 可见，agent 侧明确不可用。

诊断是"刚写完的反馈"，因此 `lsp.diagnostics` 绑定当前磁盘正文并等待同一修订的发布，权威空列表即 clean，超时为 `pending`；导航则跟随
本轮固定来源，与 `read`/`grep` 对齐。两者各自声明来源，不混为一谈。

隔离线程另有自己的 workspaceId 与目录，因此本就是独立视图（第 9.2.5b 节）；那份"每个运行中线程一个语言服务器"的成本单独度量。

## 7. 知识库（优先保留 TriviumDB）

TriviumDB 是当前实现选择，不是不可替换的产品前提（D-071）。遇到具体问题先向用户交付版本、重现与影响，由用户联系作者处理；
当前不迁移 SQLite，也不建设第二个可写知识权威。上层使用 Piarium 领域操作，不暴露占位向量或 TQL 绕路。

### 7.1 归属与位置

Application Host 内一个 `knowledge` 服务，通过 napi 进程内加载 `triviumdb`，无服务、无端口。**权威知识存储**每 host 每
workspace 一个文件：`PIARIUM_DATA_DIR/knowledge/{hostId}/{workspaceId}.tdb`，与
`document-recovery/{hostId}/...` 同构，遵守"另一个 host 不继承同路径选择"的既有不变量。Application Host 是
唯一写者；session worker 与子 agent 只读（TriviumDB 的共享只读 Reader 模型）。

"一个文件"说的是权威知识（events / blocks / knowledge / 符号图），不是全部派生数据。这份库在打开时按配置的嵌入维度定
单一 `dim`（`store.ts`），所以**代码语义索引不进这份库**（3.16，D-161）：代码向量是独立的、可重建的**代际存储**，仍用
TriviumDB，仍由 Host 唯一写。用户换嵌入模型或维度时作废并重建的是这个派生索引，不牵动 blocks、knowledge 与结构图；
它不是第二份可写知识权威，因为它随时能从当前正文重算出来。

代际存储按**范围键**而不是工作区命名（D-162）：`knowledge/{hostId}/semantic/{scopeKind}/{scopeId}/{spaceId}/{generation}`，
`scopeKind` 现在只有 `workspace`，将来有 `roots` / `working-set` / `collection` / `user`；同一台机器上不同范围的索引并列存放、
共用向量空间身份与配方身份，一个范围重建不牵动另一个。索引里的**文档身份是 `{ scopeKind, scopeId, documentId, revision }`**，
`documentId` 对文件范围是相对路径，对将来的连接器范围是连接器给的稳定标识——不把"文件路径"焊进块身份或父单元身份。
已交付（D-167）：路径构造与查询签名只接受范围键；`workspaceScope` 是 `workspaceId` → `scopeId` 的唯一处。

"桌面 + `piarium serve` 同机同目录"的两个 host 问题已决定：`serve` 启动时检测到桌面 host 在运行则**复用它**，不起
第二个——一个用户、一台机器、一个 host，知识库与恢复日志都不必面对同一工作区的两份。

### 7.2 基础 schema

六种基础节点类型，profile 可追加不可修改：

| 节点 | 向量 | payload | 文本索引 |
| --- | --- | --- | --- |
| `event` | 事件文本 embedding | `kind`（edit / command / diagnostic / decision / turn）、`at`、`sessionId`、`turnId`、引用 | 事件原文 |
| `file` | 文件摘要 embedding（可选） | `path`、`language`、`modified_at`、`dirty` | 路径与符号名（AC 关键词） |
| `symbol` | 签名 + 文档 embedding | `name`、`kind`、`range`、`file` | 符号名（AC 关键词，精确命中免分词） |
| `session` | 无 | `sessionId`、`profile`、`workspaceId` | 无 |
| `block` | 无 | `sessionId`、`label`、`content`、`revision`、`updatedBy`（agent / user） | 块内容 |
| `knowledge` | 内容 embedding | `scope`（workspace / user）、`content`、`trigger`、`status`（suggested / accepted / dismissed）、`valid_at`、`invalid_at?`、`source`（sessionId、来源种类）、`recalledAt?`、`recallCount` | 内容与触发描述 |

`block` 保留 plan/todo 与用户维护的会话笔记，随会话生命周期；不再要求后台模型维护 progress/decisions 等连续性块。
续接摘要属于 Pi 会话的 compaction 表示，不是知识库 block。`knowledge` 是跨会话的持久条目；会话里的判断不会因为
进入摘要而自动晋升为知识，晋升仍走第 7.2.2 节的审阅流程（D-284）。

基础边：`session → turn(event)`、`event → touched → file`、`event → about → symbol`、`file → defines →
symbol`、`symbol → calls | references | imports → symbol`、`event → fixed_by → event`、`session → owns → block`、
`knowledge → supersedes → knowledge`、`knowledge → derived_from → session`。边带权重（LSP 引用数、时间衰减）。

### 7.2.1 保留与用户级存储

保留策略可配置，默认按时间自动清理：原始 `event` 节点与已结束会话的 `block` 保留 **30 天**后清除（Settings 可改）；
`knowledge` 与 `symbol` / `file` 结构节点不受时间清理影响。删除一个会话级联删除其全部
`event` 与 `block`，与恢复日志的 scoped deletion 同一语义。清理在 host 空闲时段执行，以 TriviumDB 事务进行，不影响
Reader。

用户级记忆存在但刻意轻：独立文件 `PIARIUM_DATA_DIR/knowledge/{hostId}/user.tdb`，只有 `knowledge` 一种节点，不存
event、block 或文件内容。`recall` 先查工作区库再查用户库，用户库命中在结果中标明来源。

### 7.2.2 持久知识的治理：提议、审阅、取代

持久知识的写入遵循 Devin Knowledge 的形状，更新遵循 Zep 的双时态模型：

- **agent 不直接写持久层，只提议。** 用户标记与已配置的用户消息 suggestions 路径生成
  `knowledge` 建议，`status: suggested`，每条应带**触发描述**（什么时候该想起它，语义
  匹配用）。建议进入审阅托盘；用户编辑后接受、要求重新生成、或驳回。agent 也可以对已接受的条目提议更新。建议的
  草拟与触发描述的生成使用 `models.suggestions` 槽位（第 8.5 节）；未配置时，建议以用户标记或纠正的原文呈现、触发
  描述留空由用户填写，不调用主模型。
- **自动接受是显式选项**，按作用域单独开启（workspace 级、user 级各自），默认关闭。关闭时没有任何东西不经用户看到
  就成为持久知识——这是"保证持久层就是用户的意愿"的机制。
- **更新用取代，不用覆盖。** 与已接受条目冲突的新条目被接受时，旧条目标 `invalid_at`，新条目带 `valid_at`，两者由
  `supersedes` 边相连。不删除、不改写历史；"当前有效"是一个查询（`invalid_at` 为空）。UI 默认显示当前有效条目，
  可展开取代链。
- **召回按触发相关性，不全量。** Zone 2 只放触发匹配当前工作的条目指针；每次召回记录 `recalledAt` 并累加
  `recallCount`。
- **保留由用户裁剪，不按时间过期。** 持久条目没有自动过期；被取代的默认隐藏；Settings 列表按 `recallCount` 与
  `recalledAt` 排序，长期未被召回的条目提示用户裁剪或归档。
- **作用域晋升逐级审阅。** session（块）→ workspace（`knowledge`）→ user（`user.tdb`），每一级晋升都是一条新的建议。

Settings 提供列表视图：每条可见、可编辑、可删除、可查看取代链，并记录来源（哪个会话、由哪类时刻触发、谁接受）。
删除是对该 id 写 `invalidAt`，不物理删节点，也不扩大到其他 scope 或相邻历史。权威正文仍在 workspace/user `.tdb`；
派生向量随同一套 store 变更失效。`models.suggestions` 配置后由 pi-host 对用户消息草拟建议并经 Host 落库；
未配置时保留用户标记，不借用主模型。D-284 删除依赖 keeper decisions 的自动建议来源，不从续接摘要另起知识提炼调用。
已有建议、accepted 条目与取代链保留；未接受、已驳回或已被取代的条目不进入公开 recall。

Settings 目录与会话审阅托盘的写操作携带用户打开条目时的 content、trigger、status 与 invalidAt，store 在同一写队列内核对完整期望修订、scope 和当前状态后
再修改；工作区或作用域切换会使旧选择和迟到响应失效。模型提议的 Host 入口只接受正文与触发描述，workspace 与 `user-message`
来源取自已认证 actor，不能由 worker 自报。规范化正文的历史去重和插入也在同一个写队列操作内完成，包含 dismissed/retired，
所以并发相同提议不会生成两个节点或复活旧建议。用户标记与模型提议都读取同一会话的有效 auto-accept 设置；
trusted project 只能调整 workspace scope，设置不可读时保留 suggested 而不自动接受（D-211）。

### 7.3 写入者

- Document Registry 在成功提交 `write/move/delete` 后发布带已校验 writer owner 的结构化事件；观察失败不反噬文件提交。
  同 workspace 的活动会话各保留自己的 event，agent writer 的事件留作轨迹但不进入 Zone 2。LSP 诊断只有紧跟用户编辑的
  error/warning 才作为“新诊断”投影，避免复述 agent 已在工具结果中见过的诊断。Git status 已复用现有刷新边界接入。User
  terminal 的命令正文、cwd 和退出码只来自本次 session integration 发出的带代际标识的 OSC 133/633 帧；没有
  shell integration 时不编造命令，来源为 `not-observed`，终端仍可正常使用。未带本代际标识的 OSC 或普通程序输出
  不生成命令。代际标识是来源绑定的 shell 观察，不是无法伪造的安全身份。`/bin/sh` 不按 Bash 注入 `--init-file`。
  默认注入不得破坏用户已有 PROMPT_COMMAND / DEBUG trap、zsh login/profile hooks 或 PowerShell Enter/prompt。
  命令与 cwd 进入 Zone 2 前要编码，使 `</user-terminal>` 与控制字符不能关闭标签或变成新指令块。
  每个目标 Pi session 的幂等写入落在 knowledge `putEvent`，键为 `targetPiSessionId + commandId`：同一终端命令会分别送达
  工作区内各活动 Pi 会话，而对同一目标的重复投递不二次入库或注入。PowerShell 只在 `$LASTEXITCODE` 相对命令开始基线
  发生变化时把 native 非零码归给本命令；无法证明时记录 1，因此连续相同 native 非零码不声称精确。
  产品链没有 PTY 重播，因此不声称 Host 重启去重。Harness `bash` 不注入该脚本，也不进入 Zone 2 `<user-terminal>`。
  用户命令、steering、用户计划修改和子线程返回作为各自真实通道的新材料送达；D-284 移除这些事件对 `memory.nudge` 的依赖。
  事件可以增加下一次请求的容量估计，但其类型、完成与空闲本身不触发摘要。
  `kind: edit` 的 event 最终引用恢复日志中已存在的 before/after 内容对象，不再复制一份 diff；恢复日志是唯一的逐路径编辑真相源。
- 主 agent 的 plan/todo 与用户笔记使用既有 block 分支/CAS 写入，不由摘要任务回写。用户修改的成功修订进入尾部观察。
- `knowledge` 建议（第 7.2.2 节）由用户标记与显式配置的 suggestions 路径生成，保持审阅与 auto-accept 策略。
- 用户的“记住这个”沿标记/建议入口保留原意；不为压缩启动额外模型，不给历史附加机器重要性评分。
- profile 自己的采集器（research profile 的文献抓取等）。

### 7.4 读取者

`recall(query, k?)`（`search_hybrid`：AC + BM25 + 向量，再 SA-PPR 扩散；`knowledge` 按触发描述匹配）、`related`
（第 6.2 节）、Zone 2 组装（相关知识的新指针与用户修改）、UI 计划面板、知识审阅托盘、research profile 的图查询。
上下文压缩读取 Pi 当前分支与必要的已交付事实，不以知识库滚动块作为连续性的前提。

### 7.5 已知约束与要求

当前钉住 **0.8.6**（D-141）。下面按「已在该版本核实」与「历史记录」区分；向作者报告数据库本身的类型处理、检索语义和能力边界，
不要求数据库适配 Piarium 的领域模型。block 修订、分支归属及代码分词策略由 Piarium 自己负责。

- **0.8.6 已核实**：D-019 的 TQL 字符串字面量错误与 D-020 的全零向量空结果都已修复（原句复现通过）；`indexedLookup` /
  `substringLookup` 提供不经 TQL 解析器的索引查找，索引持久且事后创建会回填。符号图的查询据此改走原生索引，不再在 JS 里维护
  一套并行的内存表。三条必须知道的约束：`maxResults` 是失败即错的行预算（默认 10,000、上限 1,000,000），不是 LIMIT；
  n-gram 子串查询要求 ≥3 个字符；**默认开启的解析 payload LRU 缓存把每次 `getPayload` 变成 O(库大小)**（50K 节点时 60 µs
  对 0.8.5 的 1.7 µs），Piarium 以 `payloadCacheMb: 0` 关掉它——这是数据库侧的缺陷，已向作者报告。`flush()` 仍随库大小
  线性增长（两版一致），D-140 的派生数据去抖 flush 保留。

- **embedding 后端与存储分别负责**（D-173/D-190/D-196/D-198）。TriviumDB 存向量不产向量。代码语义与知识召回的远程路径都是
  `harness.embed` → OpenAI 兼容 `/embeddings`。知识向量是引用权威知识身份与正文修订的派生代际库，换维度不重开
  workspace/user `.tdb`。未配置远程时知识召回保持文本，不使用本地 MiniLM，也不把 placeholder 向量标成 `via:vector`。
  知识复用同一个代际存储、编码文本缓存和调度器，以独立 scope 隔开代码语料。打开与空间变更做对账，普通知识变更合并受影响 id 并立即使旧发布失效；
  自动维度由真实输入解析后继续建设，长条目完整分块。一次 workspace/user 召回固定远程绑定，按有效状态、修订和 scope 约束后选择知识条目 Top-K，
  多个块不占多个条目名额，文本/向量名次在两种范围内统一融合。取消结束本次等待，Host 关闭时收尾后台建设；绑定失败不阻断已有文本结果。
  后端选择、query/document 用途、缓存身份与取消契约见第 6.1/8.5 节。
  - 未绑定向量的知识库继续提供文本和图能力；当前 `recall` 在有效绑定时对已接受条目做 scoped Top-K 再与文本 RRF 合并。
    不把规划中的 BM25 当成已接。
  - 维度取所选后端实际支持的配置并写入空间身份，不假定所有模型支持同一种截断。切换空间重算派生向量，不混用新查询与旧空间；
    原始知识与代码向量的所有权保持分开，不为代码模型切换重写权威知识库。
  - 用户显式配置远程后端即按该绑定调用，沿现有 provider 凭据与项目受信规则，不另设 embedding 信任门或费用守卫（D-158）。
  - 需向 TriviumDB 确认无向量节点的支持；不支持则以最小维度占位向量建库并禁用向量检索路径。历史记录（D-020）：
    v0.8.5 上全零占位向量的 `searchHybrid` 不报错但返回空结果，因此占位模式下 `recall` 走 JS 层扫描 + 词项匹配。
    **0.8.6 已修**：全零向量的 `searchHybrid` 返回命中，TQL 另有不带向量的 `TEXT BM25 / AC / HYBRID` 稀疏入口。
    `recall` 的 JS 扫描目前仍在——换成 BM25 会改变召回排序，属于产品行为变更，未随存储升级一并动（D-141）。
- **TQL 字符串字面量**（D-019，历史记录）：v0.8.5 上 `FIND {type:"block", sessionId:"s1"}` 报 napi 类型转换错误，知识库改用
  `allNodeIds()` + `getPayload()` 在 JS 层过滤。**0.8.6 已修**。符号图查询已改走 `indexedLookup` / `substringLookup`；
  块、知识、事件那几处 JS 过滤仍在（单会话数百节点，成本可忽略），不再是「等修复」而是「可换但没必要急」（D-141）。
- **分词职责**：现有记录描述 tokenizer 为 ASCII 字母数字段 + CJK 2-gram、camelCase 不拆分，本轮未复核最新上游。
  数据库可说明 Unicode、可配置分词或预分词输入等通用能力；camelCase/snake_case/路径的代码分析策略由 Piarium 拥有并版本化，
  不要求数据库为了 Piarium 内置一套代码语言分析器。当前 searchSymbols 是 JS 字符串计分，不声称已走 AC/BM25 排序。
- **native 模块**：系统存储与 PTY 已由打包在 `resources/kernel` 的 Rust executable 接管，不再发行或重建
  `better-sqlite3` / `node-pty` / `bun-pty`。Electron 仍核对 TriviumDB 与 `sherpa-onnx-node` 的目标平台预编译，
  并在打包前、after-pack 与 unpacked smoke 中核对 kernel manifest、架构和摘要（D-282）。
- **两个 host 同路径**：按 `hostId` 隔离；`serve` 复用运行中的桌面 host（第 7.1 节），因此正常情况下同一机器只有一个
  host。
- **数据安全**：知识库含文件内容与命令文本，按工作区数据对待——不进日志、不进事件载荷、不进 URL，与
  documents 模块同规。

## 8. 上下文与缓存契约

用户选择的窗口用于保留工作信息。正常运行保持已进入上下文的内容稳定，工具在首次交付前组织结果；容量需要腾空间时才
批量改变活跃输入。前缀缓存使较早位置的变化影响后续复用，具体计费、缓存边界与 TTFT 按 provider 实际请求判断，不能
用固定折扣或 token 比例外推出普遍提速。后台摘要准备与前台切换在时间上分开，保留无明显整理停顿的正常体验（D-284）。

### 8.0 信息保留与工具首次呈现（D-284 / D-286）

窗口首先承载完成任务所需的信息。用户选择大窗口，也是在保留暂时不必判断哪些细节可以丢弃的余地。减少 token 不独立
构成优化：被迫反复读取、重新调查或漏掉要求也有成本。长上下文研究不能给所有任务提供统一的最佳注意力长度；本系统
不推断“注意力健康”，不每步对旧历史做重要性排序、重写或语义淘汰。

| 输入类型 | 首次呈现应支持什么 | 正文与后续读取 |
| --- | --- | --- |
| 搜索 | 命中位置、足够判断的片段和必要分组，减少为每个命中再次补读 | 需要时按来源/范围取得原文，来源缺失单独说明 |
| 文件读取 | 用户/模型请求的范围或材料，不因之前读过而拒绝 | 保留原文和行号；正常分页独立于当前窗口压力 |
| 测试/构建/命令 | 结果、失败块、错误定位与统计，收起明确重复/进度噪声 | 未识别输出不改成一句“失败”；完整输出有可用入口 |
| 网页/论文/文档 | 正文结构与任务所需细节，过滤明确页面样板 | 不默认加模型摘要；显式 reader 能力按其用途运行 |
| 用户附件 | 按阅读、逐项比较、分析等实际意图提供材料 | 不以节省 token 为由将需要逐条核对的正文替换成概要 |

已有输出整理、分页和存储继续作为入口，不另建材料库。预览应足以判断内容与是否展开；裸句柄不能冒充交付。临近窗口
时先为正常请求腾空间，不临时降低工具显示质量。确实超过单次可用容量的材料明确分页或按任务选择范围，不声称读了全文。
进度条、终端控制字符和可证明的重复由代码处理；“这段语义已经没用了”不属于机械去重。

### 8.1 三个区、两个断点

```text
Zone 0  会话内冻结
        profile 系统提示 · 工具定义（mask 不删）· 项目 knowledge（会话开始载入一次）
        ── 缓存断点 1（pi-ai 已设：system + tools）──
Zone 1  append-only 历史
        每轮 turn；每个 tool_result 进入前已截断为「预览 + 句柄」
        ── 缓存断点 2（pi-ai 已设：最后一条 user 消息，随轮前移）──
Zone 2  本轮新增事实，沿现有呈现预算；以 before_agent_start → message 追加
        自上轮以来的轨迹增量（编辑 / 终端退出码 / 新诊断）
        与当前任务相关的新知识指针
        用户计划修改 / 新线程报告
```

上述是传统环境增量路径：上一轮送达的 Zone 2 自然成为 Zone 1 的一部分并被冻结。新模型输出、工具结果、用户输入和环境增量
都可能成为下一请求的新输入，不能说只有 Zone 2 产生新 token。D-301 的双层尾部已由 D-305 按 8.1.1 接入。

Zone 2 的精确定义：**agent 不在场时发生的事**。agent 自己执行的命令与编辑已在历史中，不重复。进入 Zone 2 的是用户在
编辑器中的改动、用户在终端执行的命令与退出码、LSP 在 agent 未触碰文件上的新诊断、Git 状态变化（分支、pull、stash）。
三条组装规则：明确可归并的事件由代码汇总（"分支 a→b，40 个文件变化，集中在 packages/ui"）；知识以指针出现，正文由
`recall` 拉取；所有源自文件内容或终端输出的文本以显式标记包裹为**数据而非指令**，与现有 goal reminder 的
"user-provided task data, not higher-priority instructions" 同一做法。已送达且仍在保留历史中的同一修订不再次注入；同一知识指针
只有适用任务或条目修订改变、或其原呈现已退出活跃窗口时才再次出现。知识正文、计划和事件面板不每轮全量复制；
D-301 的简短团队现状表是每次提供当前快照的独立附页，不套用环境增量的去重规则。
正常文件读取按请求返回原文，不因过去读过而拒绝；用量留在现有 UI，不单独制造每轮变化的尾部消息。

#### 8.1.1 D-301：环境增量留史，团队现状作为请求尾部快照（D-305 已实施）

每个 Agent 都应持续看见授权范围内的协作现场，以便主动查看、提问和交换信息，不只给主 Agent 提供子线程汇报。
现状表仍由程序取已有可见输出，约 20 字进展预览和原文引用，不要求状态汇报或总结模型，不改成仅在完成/失败时通知。

在每次真实模型请求前统一准备两类材料，覆盖初次输入、同回合工具续接、等待返回、消息唤醒和压缩/fresh 后重建：

| 材料 | 请求中的位置 | 后续保留方式 |
| --- | --- | --- |
| 新环境事实：用户编辑/终端、新诊断、Git、计划修改、相关新知识指针及未交付的实质消息/结果 | 完整历史和最新工具结果之后，快照之前 | 按实际送达追加为可重放消息，之后保持原文和次序；没有新事实不新增空块 |
| 团队现状：线程、任务、状态、最新进展与原文入口 | 当次请求最末尾的临时附页 | 每次提供当前所选授权范围的完整短表；即使无变化也保留，不把历次表格写入对话历史 |

```text
请求 1：稳定提示 + H                         + 环境增量 E1 + 现状表 S1
请求 2：稳定提示 + H + E1 + 输出/工具结果 A1  + 环境增量 E2 + 现状表 S2
请求 3：稳定提示 + H + E1 + A1 + E2 + A2                   + 现状表 S3
```

S1/S2 从未成为持久历史中的消息，后续直接在增长后的真实历史末尾生成 S2/S3，不搬动或删除历史中间的消息。
旧环境事实与输出/工具结果留在原位；例如请求 3 保留请求 2 到 E2 的相同前缀。快照通常需每次处理，属于明确成本，
不能宣称临时附页自身免费或一定缓存命中。检查实际 provider 序列化的角色、文本块和缓存断点，缓存是否命中仍取决于
provider 配置与有效期。快照是完整当前视图，不能只发变化行却让上一请求的基线消失。

固定协作说明位于稳定系统提示：尾部表是 Piarium 提供的现场资料，允许按需查看线程、发送消息和等待回复，无需逐行回应；
由 Agent 结合当前任务决定是否沟通，不强制每次联系别人。动态环境事实与现状表默认映射为 `user` 内容，显式标注 Host 来源、
观察/快照类型及摘录来源。内部继续区分真实用户消息、环境观察、团队快照和定向消息；API 的 `user` 不授予来源额外权限。
不把其他 Agent 原话提升到 `system/developer`，不伪装成本 Agent 的 `assistant` 输出或无对应调用的 `tool` 结果。
`threads/read_thread` 的实际调用仍返回正常工具结果。provider 适配遵循工具调用/结果配对和允许的续接位置，不打断未完成交换。

Host 投影可在段落完成、工具边界和结果事件后更新；只在既有模型请求前取快照，不新增轮询或模型请求。
短表按授权关系和当前查询范围提供，范围/未展开部分可见，不以猜测的线程数硬上限截断；“无相关线程”与“状态暂不可用”分开，
查询失败不能伪造空团队，也不能把旧快照假称最新。UI、模型和其他观察者的游标/读标记独立。
环境事件游标只确认实际送入请求的内容，准备或发送失败不冒充送达；团队快照不因“已读”而在下一请求省略。
实质消息与结果沿原账本交付，表中标记不消费其正文。普通线程状态不同时重复进入环境事件块。

容量计算必须包含当次完整快照和待追加环境事实，再决定是否压缩并组装实际请求；不能在预算检查之后偷加附页。
单次请求冻结一次材料与来源，重试沿既有请求/送达身份处理，不因刷新表制造重复历史。压缩/fresh 后环境增量按保留原文收据
恢复必要基线，团队表直接重建当前视图；临时快照不伪造 Pi entry 或原文保留收据，也不因未落历史反复清理环境事件游标。
知识召回仍按任务/条目变化工作，不因为每次准备输入就重新检索；程序只能合并明确重复事实，不能代替模型判断科学意义。

D-302 / 7H 已将后台命令的新完成事实接到这里的环境增量：执行身份、退出码、简述与正文入口，已由工具交付的同一终态不重复。
日志字节游标与事实送达分开；通知不消耗未读日志，不添加另一张每请求完整进程表。活跃模型在自然请求中消费，
空闲恢复只沿明确等待/完成后续做关系；输出增长不额外调用模型。具体契约见 5.9.2。

尾部位置有利于持续发现协作入口，但“U 型”位置效应不是对所有模型的固定保证。采用简短表、明确来源和稳定使用说明，
用实际连续工作中的读取/通信与请求结构验证设计；不靠每轮重述任务或额外总结调用抵消可能的干扰。

### 8.2 三条规则

1. **Zone 0 在同一执行配置世代内一个字节不变。** 没有随轮变化的计数、时间戳或状态。持久 session 身份不等于永久固定配置：
   用户转换讨论线等操作可构造新 Run/配置世代，记录新工具/system；工作台布局切换不改变 Agent Profile。
2. **Zone 1 只追加、不修改，序列化确定。** JSON 键序固定；重试不产生新的随机 ID；工具结果的截断在进入前完成。
3. **主动上下文整理集中在压缩边界。** 用户显式改变模型或转换线程时，经会话构造边界生成新的执行配置；不以“冻结”为理由延迟
   权限撤销，也不为切换布局重建工具集。记录与来源的正确性属于语义契约，provider 缓存只是可观测优化，不能成为恢复正确性的前提。

### 8.3 三个进入通道（按缓存代价）

- **A. 尾部追加**：Zone 2 新事实、`recall` / `related` 与普通工具结果、观察类工具增量（第 8.7 节）。新内容仍有输入成本，
  原有稳定前缀可按 provider 能力复用。
- **B. 压缩提交**：仅在容量需要或用户手动要求时，使用已准备摘要与保留原文替换活跃输入。生成候选本身不改变历史。
- **C. provider 原生上下文编辑（有则用）**：按 provider 实际接口清理旧 tool_result，受影响前缀可能需要重新写入缓存；
  成本按真实请求记录。缺这项接口时使用 B，不阻塞正常压缩。

材料按需读取，新事实按增量送达；不对历史每轮打分、排序或替换，不按文件后来变化回改模型当时看到的正文。

### 8.4 容量驱动的后台续接压缩（D-284）

正常工作中，前台没有明显的“整理上下文”窗口期。后台摘要准备是首版主线：在容量将要不足时生成固定区间的摘要，前台
继续执行，到真正需要空间时提交。平时不运行滚动 keeper，不要求主 agent 写工作日报。provider 异常变慢、输入突增或窗口
缩小时，必要等待如实表达，不能通过隐藏状态或裁掉正常工具结果伪装无感。

Pi 的 `turn` 是一次模型调用及其工具结果，下文称**步**；一个用户请求从 `agent_start` 到 `agent_settled` 称**回合**。
预算检查与切换覆盖回合内每次模型继续，不能只放在用户发消息或整个回合结束时。

#### 8.4.1 一份历史、一个固定候选与持续追加的原文

原始消息、工具调用与结果仍由 Pi SessionManager 会话树保存。压缩只改变下一次活跃输入的构造，不改写原文，不新建上下文
数据库、隐藏 Thread 或长期 memory daemon。设：

```text
P  = 当前执行配置的 system / tools
S0 = 上一次续接摘要，首次压缩前为空
A  = 本次准备收束的较早历史
B  = 准备保留的近期原文
N  = 后台准备期间及之后追加的新消息和工具结果

准备开始：P + S0 + A + B
前台继续：P + S0 + A + B + N
后台产出：S1，承接 S0 + A；B 只用于理解续接位置
需要时切换：P + S1 + B + N
```

**先固定收束范围与安全切点，再生成摘要。** 使用 Pi 的 entry 身份、`findCutPoint()` / `firstKeptEntryId` 和工具配对规则。
候选记录所属 session、当前 compaction 边界、被收束前缀/固定输入末端、保留起点、摘要及调用配置/实际用量。身份依赖被替换
的那段祖先路径，不要求生成后当前 leaf 仍等于旧 leaf。新增 N 保留在尾部，不要求摘要追赶最新状态；steering 正常追加不会
使 S1 失效，新的用户纠正继续作为后来的要求生效。

当前压缩周期共用一个候选及其在飞调用，手动压缩与自动容量检查复用它。候选就绪只暂存，不提前替换历史，不反复注入
Zone 2。会话回退/分支导航使来源不再匹配、另一次压缩已经提交、用户改变本次压缩重点时，取消或弃用不适用的候选。
换模型/输出设置需重新核对容量与请求配置，不能把旧模型的缓存或 usage 当作新模型证据。

未提交候选是 session worker 的可丢弃准备状态；重启可从完整 Pi 历史重新准备。提交后的摘要与切点通过现有 Pi compaction
entry 持久化。plan/todo 与用户笔记仍在原有 Host block authority，保留分支/CAS/来源和 UI 编辑；它们不依赖摘要任务维护，
也不因停止 keeper 被整体隐藏或删除。

#### 8.4.2 请求预算、准备水位与原文保留量

容量唯一来源是当前 provider/model 的有效窗口与用户覆盖。沿既有 ModelRuntime/Pi 设置解析实际输出额度、推理参数及计数
口径，不增加 harness 专属小窗口。输入与输出共享窗口时，可用输入是有效窗口扣除本次实际输出预留及必要估算余量；不盲目
扣掉模型标称最大输出，再叠“注意力安全区”。显式 `reserveTokens` / `keepRecentTokens` 等设置按实际语义读取，不重复扣除。

每次真实请求前计算已组装输入，包括 system/tools、摘要、保留原文、新用户输入、工具结果与尾部观察。以上一次有效 usage
加新增材料估算并按实际 usage 校正；压缩、换模型后的旧 usage 不能冒充当前输入。provider cache 字段先按其口径归一化，
不能把已包含在 input 内的缓存 token 再相加。不逐步调用远程 token-count API，不用历史累计 token 代替当前请求长度。

**准备水位与提交条件分开。** 正常自动提交只因下一次请求需要空间；用户手动压缩也可提交。准备提前给模型生成摘要的时间：

- 首次没有摘要耗时样本时，以约 **75% 可用输入预算**作为可配置的后台启动默认，沿用此前预准备水位的工程起点。它不是
  注意力最佳长度、运行上限或已验证 SLO；当前上下文继续增长到实际输入预算。
- 有本会话同配置的实际摘要耗时后，结合近期输入增长与已知待发送增量调整提前量；增长快或摘要慢就提前，样本缺失不当零。
  这是现有 token/耗时上的局部调度，不预测任务剩余步数，不新增经济调度器或监控平台。
- 仅在有待收束历史、任务仍在推进或已有明确待处理请求时启动。任务完成、空闲、TTL 过期、测试结束、子线程返回等事件
  本身不触发收费整理；其实际新增材料参与容量判断。等待期间已启动的准备可以完成，不按时间反复更新。

**压缩幅度独立决定。** 用户未显式设置近期原文保留量时，规划一次提交后的总输入约占可用输入预算的 **60%**。这个默认
用于在细节保留和后续工作空间之间取舍，不要求精确达到，也不限制之后继续增长。规划时包含 P、摘要输出预留、B，以及
准备期间预计增加和已确定待发送的 N；提交前用实际 S1 与 N 重新计量。不能让 B 独占 60%，再把整个新增尾段加上去。

近期原文不再对所有窗口固定 20K。切点由总目标、摘要输出预算和完整交互边界共同确定；摘要不按语义栏目分配固定 2K
配额。S1 较短时可以保留更多已纳入收束范围的原文；**不能为了给较长摘要腾位置，事后从未被摘要覆盖的 B/N 中删内容**。
60% 装不下必须保留的交互时优先连续性，记录实际规模；可行请求不为凑比例再次摘要。

#### 8.4.3 缓存友好的单次摘要调用

摘要请求从主请求的实际构造路径派生：保持可复用的 system、工具定义、原消息序列及适用的缓存路由，末尾追加一次摘要
指令，明确 S0/A/B 范围。模型、凭据和 provider 转换继续由该 session 的 ModelRuntime 拥有；不把对话重包装成一条巨大 user
字符串，不使用独立 summarizer system，也不为摘要自动换成廉价模型。

thinking/effort、tool choice、序列化与 cache 参数按 provider 真实能力处理，不因为“只是摘要”自动切到 minimal 或关闭缓存。
保留工具定义只维持请求形状，摘要调用没有 Host/Pi 工具执行器，不进入 Agent loop；模型若只返回工具调用或失败，不执行
动作、不将空结果提交为摘要。工具执行边界由代码实现，不能仅靠提示词声称工具已禁用。

摘要保留用户目标与纠正、仍有效的约束、形成判断的原因、排除过的解释、关键接口/路径/错误/数字、未完工作与必要来源入口。
关键原文可以直接引用，不要求全改写成散文；近期 B 已保留的内容不重复大段抄写。一次调用收束较早历史与被切开的回合前段，
不分别生成两份摘要，也不加摘要审查 agent 或语义评分门槛。
每次提交以新的 S1 替换活跃输入中的 S0，不叠放历次摘要或无限增长的历史索引。摘要服务于继续判断，须保存理由和未决问题，
不能只写“调查完成/测试通过”等日报；明确要求中的关键措辞、代码和数字可以保留。旧摘要与原始消息仍在 Pi 日志中。

缓存命中是优化而非成功前提。摘要调用读旧缓存与切换后新前缀的首次计算是两笔成本；S1 出现在 B 前面后，不能因 B 原文
未改就声称仍全命中。后台准备主要移走摘要生成等待，首次续接的前缀处理延迟单独观察。首版不靠额外模型调用循环预热。
参见 [Claude Code 的摘要缓存形状](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation) 与
[缓存失效条件](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。缓存冷时缺少旧计算可复用，不是免费整理时机。

provider 原生压缩可作为同一职责的另一种实现，当前主线先交付可读摘要。每次压缩只有一个实现拥有，不让 provider 与 Piarium
各压一遍。原生不透明项不得转述成第二份摘要；例如 OpenAI 独立 compact 返回的完整窗口须按其契约继续使用，不能只取其中
一个项。参见 [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)。

#### 8.4.4 前台切换、并发与异常容量压力

在所有本步工具结果收齐、下一模型请求尚未发出的安全边界提交。核对候选前缀仍属于当前分支、保留切点合法、最新尾段完整
且下一请求可容纳，然后通过 Pi 原生 compaction 记录一起发布摘要与切点。已发出的请求不被中途修改；新增消息、steering、
follow-up 和工具配对不得覆盖、丢失或重复重放。摘要成功前原历史一直有效，失败或取消不先推进截断边界。

**摘要请求自身也有容量约束。** 大工具结果或更小窗口可能让整份历史无法再用于摘要。此时沿安全边界收束能够容纳的较早
前缀，保留其后原文与新结果；摘要指令、工具定义及生成预留也计入请求。不能把超窗输入原样发送给总结模型。确需分次收束
时沿同一机制推进，每次必须减少尚需处理的旧内容，不循环生成同一无进展候选。若单条新材料或固定前缀本身已超窗，压缩
旧历史无法解决；按材料能力提供明确分页/全文入口或报告需要调整窗口，不能静默裁成“已完整读取”。

容量已不足但候选未就绪时，复用并等待在飞摘要；候选失败、失效或没有启动时，沿同一摘要路径准备所需区间，明确呈现等待。
候选偏离 60% 但足以容纳下一请求时直接使用。实际仍装不下才扩大收束范围，不丢 B/N，不叠第二套 keeper 兜底。失败沿现有
取消/重试政策，确定性容量/来源错误不忙循环重试。前台请求在可控制的模型队列中优先；后台准备不能占住本地串行槽阻塞
前台，provider 自身限速造成的竞争如实记录。

任务结束后不启动“善后整理”；会话关闭、明确取消或来源失效时取消无用的在飞准备，已完成但未使用的候选可留在当前 worker
供下次请求复核。已经发生的候选费用不会因未采纳消失；这是提前准备的取舍，不把普通短任务变成常态记忆调用。

#### 8.4.5 历史回读、观察与 UI

提供薄的当前会话 `history` 入口：按关键词、文件名或 Pi entry 定位，再读取相邻原文。默认限定当前活动分支，权限由已有
session/Thread 关系约束，子线程不因此得到父完整对话。复用 Pi 会话读取与现有输出分页，不建向量历史库或另一套摘要树。
回读作为新工具结果追加到尾部；历史索引不常驻 prompt，摘要只保留少量有用入口。

会话日志只保留实际记录的内容，不等于所有工具预览背后的全文。跨压缩需可读的大输出沿现有输出/耐久产物保留规则处理；
临时 OutputRef 的过期/Host 重启语义继续明确，不能用 handle、hash 或路径冒充永久正文。正常 read 按请求返回足够原文，
不因临近窗口临时压低显示预算。网页、附件与命令输出只收明确样板/机械噪声，不默认用另一个模型替用户总结所有材料。
计划跨压缩继续引用的输出，须指向现有会话保留正文或已存储 artifact；只有临时句柄时明确其可用性，不把过期入口抄进摘要
后承诺可恢复全文。只保留有实际引用用途的正文，不要求所有输出永久保存。

`session_compact` 不再重注入最近五个文件、50K 文件正文或 25K 技能，不因累计三次压缩提醒必须委派。仍在保留原文中的
观察基线继续使用；确已退出活跃输入的基线才在下次观察重建（第 8.7 节）。后台候选未提交时不重置游标。Handoff 仍仅是用户
手动操作，委派仍由任务本身决定。

UI 保留普通会话的 token、缓存与费用显示。后台准备不显示阻断模态、不锁输入；实际提交在时间线留边界，展开可看摘要、
来源区间、前后估算输入量与保留原文量。只有实际阻塞模型继续时显示准备/失败状态。内部记录准备耗时、是否采纳、前台等待、
真实 usage 与首次续接延迟；不新增注意力健康分、辅助费用面板或评测审批流程。

#### 8.4.6 替换范围与设置

完成 D-284 时，删除持续 keeper 的 token/事件/cooldown 调度、memory_edit 模型协议、coverage 接管、off/assist/takeover
运行模式及专属 UI，不留默认关闭的旧引擎。保留 plan/todo、用户笔记的版本/分支契约、已接受知识和建议审阅；移除 keeper
decisions 自动提议知识的来源。线程简报、进度、结果与偏离使用已有计划/报告/Run 事实，不为保持旧字段另起后台模型。

自动压缩沿 Pi 的开关与配置 authority；后台准备是默认启用的用户偏好，允许全局设置与活动会话覆盖。关闭后台准备仅取消
提前调用，必要压缩仍用同一实现；关闭自动压缩则自动准备也停止，手动压缩保留。容量继续在模型/provider 设置，60% 目标与
75% 起始水位属于可配置工程默认，不要求普通用户管理百分比。

Pi 原生会话与外部配置不删、不静默改写。新运行时不保留旧 keeper 引擎；旧 memory 字段在设置诊断中说明已退出，不映射成
含义不同的自动压缩开关。新后台准备选项未显式设置时，外部旧 `mode:off` / `shadowMode:false` 的关闭意图按“后台准备关闭”
处理；用户显式的新选择优先。这里只保留外部关闭意图，不恢复旧三态引擎或建立内部格式迁移器。Pi 自动压缩禁用与显式保留量必须尊重。

D-284 已实施：预算检查位于 `context` hook，覆盖回合内每次真实请求；摘要经同一 ModelRuntime 派生，保留真实 system 与
schema-only 工具，`toolChoice:none`、无执行器。不能只改 keepRecentTokens 或挂上 session_before_compact 就声称完成——
本实现逐项对应上述要求。

#### 8.4.7 工作连续性与上下文重建（D-285 / D-286）

复用线程/会话身份不要求永久携带全部旧上下文。已有成果、文件状态与工作记录保持连续；下一次执行独立选择输入：

| 工作关系 | 输入方式 |
| --- | --- |
| 结果刚交付，继续修复或推进同一段工作 | continue：沿用当前有效摘要与原文，追加新任务 |
| 同一件工作，但阶段、代码或要求已明显变化，旧背景大半不适用 | fresh：保留工作身份/成果，重新建立当前输入 |
| 无关的新工作 | 新 Thread；默认只带任务和必要材料，需要时显式继承当前可用输入 |

发起者或用户根据任务选择；接收 agent 发现背景明显不适用可请求 fresh 并交代必要的续接材料。运行时不按年龄、固定轮数、
token 比例或语义新鲜度评分自动清空，不新建“上下文清洗 agent”。大段旧背景即使命中缓存仍被反复读取，缓存不足以决定续做。

fresh 的种子来自当前任务、仍有效的用户要求与纠正、当前系统/项目配置、选定工作状态和交付物、必要未决问题及历史入口。
不把旧历史再完整总结后全部塞回，也不为重建强制增加一次摘要调用。项目指令、权限与工具从当前权威重新解析，保留来源版本；
已知旧验证结果只说明对应修订，不冒充当前验证。难以机械判断的调查结论由模型结合来源判断，不给每句话设置有效期。

通过 Pi 的受支持会话/分支接缝建立新的输入世代，记录 continue/fresh 与来源，旧会话原文仍能从该工作历史按需回读。重建
不删除任务/成果、不回退代码、不扩大权限，不把同一 Thread 的旧 Run 改写为新执行。输入与执行配置就绪后才发布新世代；
失败保留原现场和待处理消息。在既有执行配置边界处理系统/项目规则更新，不能为了缓存永远使用旧版要求。

新线程的 inherit 只固定派发时实际可用的输入：已有摘要与保留原文，排除未完成的派发工具调用，不恢复全部被压缩历史。
与当前任务无关的旧背景不自动广播给每条子线。输入继承、同线程 fresh、容量压缩共用 Pi 历史与请求构造接缝，分别决定
“从哪里开始”“是否需要重建背景”“何时腾空间”；不把它们实现成互相叠加的多套总结循环。

#### 8.4.8 本阶段的完整取舍

GPTpro 上下文报告与随后讨论共同形成以下目标，实施不能只交付后台摘要调度：

| 讨论要点 | 正式取舍与所在位置 |
| --- | --- |
| 信息价值、工具输入质量 | 8.0；充分首答、原文/结构、机械去重，不只追求更少 token |
| 缓存稳定与真实成本 | 8.1–8.3、8.4.3；前缀稳定、尾部追加，摘要读取旧缓存与续接重建分开 |
| 用户容量与保留长度 | 8.4.2；真实请求预算、显式设置、较长近期原文，60% 是规划目标 |
| 前台无明显整理停顿 | 8.4.1/8.4.4；约75%起步的后台准备、固定范围、前台继续、需空间才提交；取代报告的默认同步等待选择 |
| 摘要与原文完整续接 | 8.4.1/8.4.3/8.4.4；保留因果与精确细节，一份活跃摘要，切点先定，新增消息不丢 |
| keeper、知识与历史回读 | 8.4.5/8.4.6；退出持续维护，计划/知识独立，按需回读，无第二个记忆平台 |
| 过期背景与长期工作 | 8.4.7；身份/成果可复用，上下文可 fresh，权威规则刷新，模型判断相关性 |
| UI 与验证 | 8.4.5、8.6；实际提交才呈现边界，保留正常用量，观察真实效果，不增评测门禁 |

### 8.5 子 agent、模型槽位与模型切换

子 agent 能否复用父缓存取决于实际 system/tools/messages 与 provider 行为；同模型不等于前缀一致或必然命中。
模型切换经明确的执行配置边界记录，主动上下文整理尽量集中到压缩时刻；缓存收益按实际用量观察，不作正确性承诺。

**模型槽位与线程预设。** 专用能力沿独立配置，普通线程明确继承当前模型；预设可声明继承或绑定已有槽位。许多 provider 没有更便宜的兄弟模型，自动挑选
会挑不到，回退主模型会烧钱；而不同能力的任务性质与实现都不同，不能共用一个"便宜模型"。因此 harness 不自动挑模型，
每个用模型的能力有自己的槽位：

| 槽位 | 服务的能力 | 默认 | 未配置时 |
| --- | --- | --- | --- |
| `models.explore` | 查询理解/搜索表达与候选相关性/选段（3.15D） | 未配置 | 使用算法与可用向量，明确模型未参与，不回退主模型 |
| `models.retrievalAgent` | `retrieval` 角色（可等待的事实 Thread；Host 校验 submit_facts） | 未配置 | 角色不注册，不借主模型 |
| `models.quickImplement` | `quick-implement` 角色 | 未配置 | 角色不注册 |
| `models.hardImplement` | `hard-implement` 角色 | **主模型** | — |
| `models.frontend` | `frontend` 角色 | 未配置 | 角色不注册 |
| `models.review` | `review` 角色与已发布结果的 review 传感器 | **主模型** | — |
| `models.check` | `check` 角色 | 未配置 | 角色不注册 |
| `models.reader` | `webfetch` 的阅读子 agent | 未配置 | 忽略 `prompt`，返回提取内容 |
| `models.suggestions` | 知识建议的草拟与触发描述生成 | 未配置 | 用用户原文，触发描述留空 |
| `models.permissionJudge` | 原生权限 fallback 的 Smart 判断 | 未配置 | Smart 不可选；插件活跃时由插件 authorizer 链负责 |
| `harness.embedding` | explore 文档与查询嵌入（3.16B） | 未配置远程且已安装本地组件时使用 `all-MiniLM-L6-v2`；否则不启用向量来源 | 远程失败/未绑定 Pi 时语义来源 `failed`/`unavailable`，词法与图继续；同一查询不静默切回另一 vector space |
| `harness.rerank` | 对当前可展示视图提供统一顺序（3.16E） | 未配置 | 保留来源排名与可读材料，details 标明未参与/失败；不使 explore 整体失败 |

**配置种类与聊天槽位分开**（D-190）。前十个普通 Harness 槽位仍走 `HarnessModelRole`；embedding/rerank 不在该表里，也不能
从任意 chat model id 推断具备 embedding 或 rerank 能力。Settings 有独立的 Embedding / Rerank 入口。远程 embedding 使用明确的
OpenAI-compatible `/embeddings` 协议；rerank 使用可配置的 HTTP `/rerank` 契约，不把 chat completion 或 embeddings 协议改名为
rerank。不把未选定的本地交叉编码器写成现成默认。

远程绑定复用 Pi provider 的请求形状与用户凭据权威。后台 provider 定义只解析 user/operator 层，明确排除受信项目层；凭据仍留在
Pi `AuthStorage` 所属进程，不通过协议交给 Host 或 renderer。workspace worker 内的 `BackgroundInferenceRuntime` 使用隔离的配置
ModelRuntime，并仅从会话 runtime 读取同一用户的进程内 auth overlay；不借“第一个活动聊天会话”。Host 只提交已授权正文、查询、
用途和冻结 binding 并接收向量/分数。关闭最后一条聊天不终止范围索引；Host 或 Pi runtime 重启后从现有 settings 与 auth.json
恢复。provider/model/maxTokens/最终维度或去凭据 endpoint/API identity 改变建立新 space/generation；仅凭据轮换不重嵌。新空间已发布部分可按
partial 查询，不混入旧空间。

本地模型包包含权重、tokenizer、配置、pooling/归一化和运行配方，发行准备与 asar 路径沿已有打包流水线。Host 管理本地实例，
初始化合并、推理批次与前台优先按实际 backend 实现；只设 WASM numThreads 不算配置了 Node ORT session。远程批次按提供商
真实限制组织，统一接口显式携 query/document 用途、取消和输入身份，核对返回数量、次序与维度。

本地 MiniLM 的 English 配方不承诺中英代码检索质量；有效输入长度和权重大小也不证明全仓速度。后端可替换，兼容空间约束所有
缓存与索引；模型能力和实际工作负载分别验证。LLM 查询理解/搜索表达与候选判断已由 3.15D 接入公开工具，使用已有会话
ModelRuntime，不依赖后台远程 embedding 的新执行上下文。生成全仓摘要与零样本原型路由仍不属于当前工作项。

续接摘要不走新槽位，沿该会话活动模型与请求配置派生，准备/切换规则见 8.4。请求形状保持可复用，不承诺缓存命中；
不增加辅助费用面板或第二套模型/凭据 authority，T4 与外部缓存实验不是默认交付门槛。

Settings 提供**预设**一键填充多个槽位（如 Anthropic 预设：explore / retrievalAgent / quickImplement / check / reader /
suggestions 填 Haiku，hardImplement / review 保持主模型），但预设只是填表，每个槽位随时可单独改。规则：

- 依赖未配置槽位的能力**不注册、退化为无 LLM 路径**，**永不静默回退到主模型**。`websearch` 与 `grep` 本来不用 LLM。
- 普通派发零配置可用；`hardImplement` / `review` 预设保留明示的当前模型继承，其余专用槽位未配不静默借用。工具和工作区
  模式独立于模型价格；自动 review 是否运行是另一项用户策略，D-285 默认关闭。
- 模型槽位保留配置和功能；取消 `SessionStats.modelSlotUsage` 及“模型槽位用量”区块（D-080）。子线程的角色、模型与 token
  继续由自身 `ThreadRun` 记录，普通会话已有统计保持。

槽位选择遵循用户配置；前缀一致只是可能获得缓存收益的条件。设置明确续接摘要的活动模型归属及自动 review 的启用状态。

### 8.6 度量

Piarium 已按轮聚合 token 用量并显示 cache-read / cache-write（0.9.8）。harness 增加会话级计数器：缓存命中率、
工具错误次数、近三步同工具同参数的重复次数、工具输出 UTF-8 字节。这四项随 `SessionStats` 进入现有 Context 侧栏；runtime
不发布字段时整段不显示，不把“无能力”渲染成四个 0。普通会话已有 Token、缓存、费用和上下文容量展示保留；不再按辅助模型槽位
展示调用次数、Token 与成本（D-080）。操作计数器用于定位重复调用、错误和输出噪声，不能判断任务是否做对。

**验证服务于交付（D-078）。** 来源读取、分支/CAS、固定摘要范围与原文保留、工具配对、取消、崩溃恢复、数据保留与集成结果用对应生产链验证。
涉及模型请求时沿现有真 Pi 会话加 faux provider，验证发出的真实请求和回写结果；不要求纯存储或 UI 改动穿过无关的 agent loop。
这些验证通过即可交付默认路径，不再为“影响模型行为”统一追加独立评测、统计不劣证明或人工验收阶段。

实际会话记录有效配置、主/辅助调用用量、耗时、人工介入与可定位失败；模型质量在使用中改进。失败可按 retrieval miss / lost context /
wrong edit / permission interruption / tool-runtime failure / coordination failure 分类。需要比较某项优化时，选择能回答问题的任务
与相同条件，既不把少量样本包装成普遍质量证明，也不因缺样本禁用已完成的能力。不自行发起付费记忆协议或缓存对照实验。

T4 是可选的重现与诊断资产。第一版已把 6 个真实历史任务固定在 `evaluation/harness/cases.json`，涵盖故障修复、跨包能力、Settings UI、持久子线程、
长上下文 shadow 与用户审计面；每项钉住 base/reference commit，但 reference 只供复核，不要求逐字节复刻。记录器
`scripts/harness-replay.mjs` 默认不调用模型、不改 settings，只创建 run record 并汇总配对结果。自动执行使用单会话配置，避免临时改
全局设置影响普通会话；记录器、配对执行和新的检索基线都不是其他功能的交付依赖。

**Zone 0 字节稳定性契约测试**：在一个测试会话内跨 N 轮截获发往 provider 的请求，断言 system 与 tools 段逐字节相同、
Zone 1 只增不改。它确定、便宜，直接捕获第 4.2 节那一类缺陷，并让任何向系统提示加入动态字段的改动立刻失败。放在
`packages/pi-host` 的契约测试中。

### 8.7 观察类工具的增量视图

有一类工具会被对同一个对象反复调用：`threads` / `wait` 看线程、`read_thread` 读线程记录、`get_output` 读运行中的 shell、
`diagnostics` 查同一文件。若每次返回全量快照，上下文里堆的是重复内容；若事后把旧快照折叠成一行，就是回改 Zone 1，
违反第 8.2 条规则 2。Devin 的查看工具反复使用而上下文几乎不涨，可观察到的解释就是增量返回。规则：

1. **默认增量。** 工具记住"这个观察者上次确认接收到哪"，再次调用只返回这之后的变化，开头一行引头说明基线（"自上次查看 2 分 14 秒
   前以来"）。没有变化就是一行明确的"无变化"，写得让模型觉得再查没有意义。全量视图要显式参数（`full: true` 或显式
   `offset`）。
2. **游标归 host。** shell、diagnostics、Zone 2 threads 与 thread list/wait 先 prepare；Router 成功把响应交给 pi-host 后才 commit，
   发送失败 abort 并允许重放。游标用单调 revision 做 CAS；并发旧响应不能倒退，压缩/会话清理会使 pending commit 失效。
   这证明到达 worker，不等于 tool result 已成为持久 Pi entry；后者若作为更强保证交付，需要单独的 worker acknowledgement。
   用户面板仍是独立观察者。
3. **按保留边界重建。** D-284 提交后，只有基线已退出活跃原文的观察者才在下次查询返回完整基线；仍能绑定保留 entry 的游标
   继续增量。不能证明基线仍在时重建对应对象，不全会话重放所有观察。游标失效在压缩实际提交后发生，后台准备不改游标。
4. **只追加。** 增量视图是普通 tool_result，走通道 A；永不回改历史中的旧视图。

这条规则的副作用是查看变得便宜，模型会更愿意查；防轮询靠两道闸——"无变化"行的措辞，以及工具说明里的"要等就用
`wait`，不要循环 `threads`"——并把观察类调用计入计数器，让轮询行为可观察。

## 9. 验证与多 agent

### 9.1 传感器优先于指南

指南预测模型会错在哪；传感器在错了之后抓住它，且不随模型进步而腐烂。code profile 的传感器：编辑后诊断（第
5.4 节）、可选的 turn-end 测试门（profile 声明测试命令，失败结果作为 post-tool 反馈注入而非阻断）、危险命令
前置拦截（`tool_call` → `block`，profile 提供规则）。

### 9.1.1 OS 沙箱（后续阶段）

OS 隔离与工具权限保护不同对象。仅隔离 shell 进程树，不能约束仍在普通 worker 内执行的文件工具或第三方扩展。
macOS/Linux 可作为后续平台候选；用户已决定不建设 Windows 沙箱（D-071），它不是当前 Windows 交付阻塞。
这不是没有技术路线：[OpenAI 公开实现](https://openai.com/index/building-codex-windows-sandbox/)使用专用用户、受限 token、ACL 与防火墙，
也需要管理员安装和兼容性维护。当前 Piarium 继续准确说明实际的工具权限、Host 身份/路径授权及其未覆盖的同用户进程访问。

### 9.1.2 权限管理：Piarium 原生唯一交互门（D-283）

Piarium 内置 pi-host `tool_call` extension 是当前唯一的用户确认权威。它覆盖 Harness override、Pi built-in、MCP、普通 Pi package
以及嵌套 Thread 会话里实际注册的工具，不再把未知工具 pass-through 给第二套权限系统。来源身份取自 Pi 活跃 registry 的
`getAllTools().sourceInfo`：只有 Piarium SDK Harness override 才按 `HARNESS_TOOL_META` 分类；MCP/package/unknown 缺明确副作用证据时
动作归为 unknown 并询问，不能因为工具恰好叫 `read`、声明 annotation 或说明文字像只读就自动获得权限。

权限对象包含实际 cwd、source/action、候选路径、网络 origin 与 thread scope。路径在提示前通过 Host `permission.inspect` 走与其他
Harness 服务相同的 actor/capability/workspace canonical path authority；Host inspect 失败、组合 shell/sub-shell 等无法完整提取的命令、
未知第三方动作都标为 evidence incomplete，因此不能走 Smart 自动放行或 remembered session grant。当前 shell 证据提取是保守边界，
不是完整 shell 解释器：无法证明完整时询问，而不是靠 regex 猜安全。高风险模式仍覆盖危险命令、Git 变更、包管理器变更与敏感路径。

`normal` / `accept-edits` / `bypass` / `smart` 和用户规则都在同一个 gate 内解析；trusted workspace 仍只能收紧规则。Smart 只有在用户
配置 `models.permissionJudge` 时处理普通、完整、非高风险 ask；模型失败回到 ask，不借主模型。"Allow for this session" 的 key 包含
工具来源、动作、owning/execution workspace、cwd、Host canonical resource IDs、网络目标和 thread scope；未知/高风险/不完整证据不能
记忆。用户可通过 `/piarium-permissions` 查看/撤销该会话记忆授权。每次 allow/deny/remember 通过 `permission.audit` 投影
credential/body-free 目标，不新建 permission 数据库，也不把审计正文放进模型上下文。

`@gotgenes/pi-permission-system` 的 foundational provision、session service yield、Piarium Plugin Settings/Composer/quick mode/status bridge
已删除；D-044 只保留为历史共存记录。用户仍可通过 Pi 的普通 package surface 自行安装第三方扩展，但第三方 `tool_call` 仍经过
Piarium 原生门，不能替换或绕过它。

**三层，不寻找唯一安全边界**（D-035）：

1. **Pi `tool_call` 门**：Piarium 原生 gate 做 allow / ask / deny 与确认 UI，并对 worker 内直接执行的内置/扩展工具统一生效。
   `ask` 走现有 `ui.select`（Allow once / Allow for this session scope / Deny）；取消/关闭视为 deny。它不能成为 OS 隔离，但能在工具
   入口阻断 `edit` / `write` / `apply_patch`、MCP/package mutation 与进程工具。
2. **Host 服务授权**：不弹窗、不重算用户策略，只验证 `ActorContext`、RunManifest 里的静态能力集、workspace / path 包含，
   覆盖一切经 host 中介的能力（`shell.*` / `output.*` / `search.*` / `document.readSource` / `thread.*` / `fs.lock` / `lsp.*`）。能力按会话实际冻结的
   `activeTools` 推导：只有没有任何 `bash` 工具时才不含 `process.shell`；关闭 Piarium 的同名覆盖若会回退到 Pi 内置 bash，
   仍然具有 process 能力。缺少该能力时绕过工具直接到达的 `shell.exec` 必须被拒——这不是第二套用户策略，是防止
   绕过工具入口。按风险类别授权：`read`（document / search / output / lsp）、`process`（shell）、`control`（thread send / kill /
   merge）、`write`（未来经 host 中介的文档写入）。
3. **OS 沙箱**（第 9.1.1 节）：限制 worker 绕过工具直接访问文件与网络。当前不具备。

`ThreadLaunchManifest.scope` 是任务范围，同时对 Host 能解析出具体路径的服务形成强约束：`search.content` 的返回项、固定来源
`read`、LSP 路径、`fs.lock` 路径与显式 `shell.exec.cwd` 都必须落在 scope 内。规范化只拒绝完整的 `..` 段、绝对路径和盘符路径，
不把 `src/foo..bar` 或 `version...txt` 当成穿越（D-223）。它**不是文件系统沙箱**：shell 命令文本内部可以
改变目录或访问其他路径；Host 未提供固定来源或用户关闭覆盖时，Pi 内置 `read` 也仍在 worker 内直接执行。隔离 worktree 把写入副本与父工作区分开，但只有未来的 OS containment 才能约束
同用户进程能读写的全部路径。

**威胁模型**：worker 是 host 自己 spawn 的、同一 OS 用户的子进程，本来就拥有整个文件系统；第二层防的是**跨会话串线、
陈旧 worker 污染当前会话、第三方 Pi 扩展借 host 能力越权**，不是防同权限下完全恶意的 worker——后者只有第三层能防。

**身份**：`ActorContext { authorityInstanceId, sessionId, runId, workerId, workerGeneration, workspaceId, grantedCapabilities }`
只能由 broker 信封与 host 注册表生成，请求载荷里不再有 `sessionId`。broker 在 `session.open` / `session.create` 的方法
响应成功后 pin 住 `{ sessionId, workerGeneration }`；worker 自己发出的 `session.snapshot` 只能验证与更新状态，不能重绑
身份，不一致视为协议违规；`session.closed` 不能仅凭 worker 自报清空 pin；未 pin 的 worker 发出的 harness 请求一律拒绝。
RunManifest 落地前，host 从 broker 验证后的首次 `session.snapshot.activeTools` 与 Host 实际服务可用性推导能力集并随会话
注册冻结；它不二次读取可能已变化的设置。RunManifest 落地后收敛为显式单一来源。

**第一层的判定顺序**（真值表，实现必须与之一致）：

| 规则匹配 | 高风险类别 | 本会话已授权 | 结果 |
| --- | --- | --- | --- |
| deny | — | — | 阻断 |
| allow（含 bypass 模式、用户显式 allow 规则） | — | — | 放行 |
| ask | 否 | 是 | 放行 |
| ask | 否 | 否 | 弹窗；选 "Allow for this session" 记入本会话授权 |
| ask | 是 | 任意 | 弹窗；"Allow for this session" **不**记入——高风险每次都问 |

高风险类别：`bash` / `write_to_process` 的命令匹配 `rm | sudo | chmod | chown | mkfs | dd`、`git push | reset | checkout |
rebase | clean`、包管理安装 / 卸载、路径含 `.env | id_rsa | .ssh`；`write` / `edit` / `apply_patch` 的路径含
`.env | id_rsa | .ssh`。`bypass` 是用户说"别再问我"，高风险在 bypass 下同样放行。工作区提供的 regex 规则须有 ReDoS
防护（配置长度上限，并在构造 `RegExp` 前拒绝反向引用、lookaround、嵌套量词和量词包裹的分支），工作区只能收紧不能放宽
（第 5.10 节）。

### 9.2 多 agent：持续工作的主线与按任务展开的线程（D-285）

主线是能调查、设计、实现和验收的正常 agent。独立工作值得展开时才委派；共享接口未确定就先解决真实依赖，已经明确就
直接并行，不先设 planner/manager 层，不要求模型规划完整 DAG。主线负责整体取舍、关键验收和最终交付，也亲自推进重要
实现；没有独立工作时等待结果，不重复调查制造忙碌。

多一条执行过程可以缩短等待、并行尝试不同解法，或使用适合任务的模型/工具。可以用费用换速度或探索广度，不把省 token
当作唯一成功标准。批量读取、已知命令和机械转换优先用普通工具并行；需要独立判断和行动过程时再开线程。每条会话独立
使用第 8 节的上下文机制，多 agent 不替代压缩，也不因上下文长而被强制使用。

#### 9.2.1 原生运行时与工作身份

Thread 表示一件可继续的工作，Run 表示一次执行；broker/Pi 提供实际会话和模型调用，Host 持有关系、准入、消息和结果投影，
Rust WorkingState/Integration 保持文件与结果权威。任务身份不会因从调查进入实现而变化；模型、工具、权限和输入来源在
每次 Run 中解析并冻结，上一 Run 的真实配置与结果留存。

复用 Thread 不强制复用全部旧对话。新线程可以接收简洁任务背景或继承当前可用输入；已有线程可以沿用上下文，也可以保留
成果而重新建立输入（8.4.7、9.3.2）。工作区选择、上下文选择与执行预设分别表达；清上下文不清工作分支，发消息不更新代码。
不自动让支线取代用户正在进行的主线，用户点开支线仅改变其当前查看和交流的位置。

#### 9.2.2 普通派发与可选执行预设

模型可见接口为 `dispatch(task, { input?, preset?, scope?, worktree? })`；`task`/`preset`/`input`/`scope`/`worktree`已是
当前协议参数（`input`取`task|inherit`，`worktree`仅接受显式`shared`）。
普通派发不要求 role：默认简洁任务背景、明确继承发起者当前模型和已获准的普通工作能力，写入任务默认独立 WorkingState，
需要 shell/LSP 等真实路径时才物化。shared 是明确需要共同现场时的执行选择，不因“任务简单”或某预设名称而默认共享。

预设只是解析执行配置的快捷方式，不是线程的永久职业。预设说明任务方法与产出，不把用户任意选择的模型永久称为便宜或强。
保留现有模型槽位与用户配置；预设可明确声明使用当前模型，未绑定且未声明继承的专用槽位保持不可用，不静默借主模型。
普通线程本身的模型继承是明确默认，不冒充已配置专用能力。

| 可选预设 | 主要用途与工具形状 | 模型来源 |
| --- | --- | --- |
| quick-implement | 已有模式下的实现、局部设计与相关验证；能力边界按任务配置，不强制 shared | models.quickImplement |
| hard-implement | 需要深入推理或跨层协调的实现 | models.hardImplement，可明确继承当前模型 |
| frontend | 界面设计、实现与可用的预览工具 | models.frontend |
| retrieval | 较长事实追踪，读取/检索/授权 web 与 submit_facts；无写入和 shell | models.retrievalAgent，未配不可用 |
| review | 对实际成果作独立审查，给具体发现和来源 | models.review，可明确继承当前模型 |
| check | 任务所需的验证与事实核对；执行命令可能写生成物，不称只读 | models.check |

工具选择、scope、文件工作状态和权限由 Host 校验并落实到 Run。把预设改成可选不能撤掉真实 allowlist、路径与权限边界。
只读任务转实现时留在同一 Thread，在新 Run 确定获准的写能力；不凭消息里的“开始写”放大权限。允许嵌套的普通执行配置与
预设使用相同调度和父权限继承规则，不把“能派发”永久限在两个角色名上。retrieval 的专门事实协议和干净背景预设继续有效。

#### 9.2.3 验收与可选 review

实施者完成与改动相关的正常验证，主线承担全局理解、关键审查与集成判断。按实际价值安排独立 review/check，不要求每个
worker 结果都经过额外模型，更不设置固定的审查—核验—裁决链。运行命令本身无需包成新 agent。

D-285 将自动 review 默认改为关闭；用户已有明确 enabled/gate 选择保持有效。主动派出的 review 和用户开启的自动 review
仍复用当前 resultRevision + reviewThreadId + reviewRunId 绑定、失败/取消与迟到结果处理，通常使用简洁任务和固定 diff，
不默认继承主线推理。是否独立判断由任务需要决定，不能用一句“独立”代替提供成果、契约和验收依据。
后台摘要是 D-284 的单次模型请求，reader 是其已有能力，两者不因此成为常驻团队或每次交付的附加步骤。

#### 9.2.4 按成果与依赖委派

任务说明用清楚的自然语言交代要完成什么、已有材料和需要交出的成果，不强制表格，也不要求先列完整工作图。共享类型、
存储归属等公共决定先明确，再把能独立推进的部分展开；边界清楚的线程可自主定位和实现。等待时由运行时订阅，不通过
定时推理询问“好了没有”。模型可以选择不同实现路线并行探索，得到足够结果后停止不再需要的工作。

已有工作相关且上下文仍适用，优先原线程续做；工作延续但背景大半过期，原线程 fresh；无关任务建新线程。选择依据是任务
关联和当前输入的价值，不以缓存命中、线程寿命或固定调用次数决定，不为此添加新鲜度评分模型。

并发预算是调度参数，不是目标人数。默认沿用用户可调的12个委派执行名额，在同一根任务的嵌套树中共享；等待子任务的父
让出执行名额，收到所等结果后重新准入。会话仍可保留，后台进程/文件写者的真实占用也仍存在，不能把让出执行名额当成
进程退出或目录可回收。恢复、续做、自动 review 与嵌套派发走同一准入，不按每个父节点再复制一份预算。不同根任务保持
各自配置，Host/provider 的实际资源限制另按既有机制处理，不顺手增加全工作区硬上限。

用户可要求特定预设派发前确认，默认不启用；沿原生权限门处理，不要求模型提交成本估算。既有用量应区分主/子实际调用，
不只看主线变短就宣称总成本下降，也不增加多 agent 财务面板。

#### 9.2.5 定向消息与成果流

以下记录 D-285/D-287 已实施的消息语义；D-300 对公开交互的下一阶段调整见 9.2.5a，尚未接线。

责任关系仍是父子树，通信允许同一根任务内已授权的子问父、父指导子、相关兄弟定向交流。复用 `send(to, message, { kind })`，
发送者身份由 Host actor 解析，不允许模型自报为 user/parent 或仅凭可猜测 threadId 跨任务发送。可交流不授予读取对方全部
转录、改权限、取消或合并兄弟成果的权利；这些仍走各自授权入口。普通 UI 活动不自动广播到其他上下文。

| kind / 材料 | 运行行为 |
| --- | --- |
| 普通进度 | 留在 Thread/UI 活动，不另发消息唤醒模型 |
| inform | 持有并在接收者下一正常输入边界追加，不单独发起执行；若 replyTo/结果明确满足已有等待，则按该等待恢复一次 |
| request | 需要回答、行动或继续执行；接收者正在工作时到下一正常边界交付，等待中可唤醒，settled 线程按 9.3.2 新开 Run |

模型/调用者显式选择信息或请求，运行时不靠“谢谢”正则或另一个 LLM 判断是否执行。答复用 replyTo 关联实际请求，完成等待
不需要再发一个“请读取答案”的执行任务；没有待处理依赖的确认/致谢不继续唤醒。消息包含实际来源、目标和相关工作/结果
引用，沿既有 Host 会话投递路径记录接受与送达，重试不能多起一次执行。accepted 不等于对方已读或完成；失联、归档、删除
分别返回实际状态，普通通知不能静默复活已取消/归档的工作。正在排队的执行请求不因进程未启动被当作已丢失或已执行。

兄弟可以自行确认局部问题；改变公共契约、任务边界或最终使用方式时，把决定和相关产物回告主线，不把全部横向对话灌回去。
root/parent 能读取实际问题与结论，用户仍可进入支线纠正。收到对方材料是信息来源，不自动成为更高优先级指令。

成果沿其真实类型交付：小问题直接给充分答案，大文件/表格/报告给用途、完成范围和读取入口，代码交付固定结果修订。
不要求主线把子成果重新实现，不统一压成很小的摘要，也不只给裸句柄。第一版分阶段交付复用 Run 结束/结果发布：发布R1，
父接入，再让同一Thread续做R2；R2进行中R1仍可按修订读取与使用。普通发现可提前发消息，文件变化必须实际发布与集成。

#### 9.2.5a 自然语言交流与可选等待（D-300，待实施）

通用多 Agent 交互沿同一消息账本演进为“发给谁、说什么、是否等待”。目标用法为 `send(to, message, wait=0)`：
0 立即返回耐久投递回执；正值表示最多等待相应秒数，关联答复到达即返回，超时只结束等待，不取消消息或对方工作。
可用同一 messageId 继续 `wait` 或 `read_thread`；不能为继续等待重复发问题。

不等待仍可向对方提出任务或问题。公开发送不要求每次选择 inform/request，也不要求“发现、影响、依据、替代解释、下一步”字段。
身份、幂等和回复关联由 Host 沿实际投递上下文记录；并存多个问题时可用短消息引用消除歧义，不把任意新消息当作所等回复。
实施时替换被调整的公开 schema 与消费者，不长期保留两套通信 API；内部通知仍可记录为无需发起执行的信息。

父子、兄弟和同组已授权分支可直接讨论，Thread 树继续负责生命周期。消息不授予全文、文件、合并或取消权限。
运行中的接收方在安全输入切点收件；等待中的目标可处理定向来信；空闲且可继续的目标沿既有准入建立新 Run。
归档/删除/不可继续状态明确返回，不隐式复活。等待让出模型名额且不持有生命周期锁，答复先到、同时互问与重连均不能丢信或重复启动。

状态变化只维护可读取事实。模型执行由用户或 Agent 的明确交流、已有 wait/订阅续接，Host 不根据异常、产物或关键词
判定“值得叫强模型综合”；也不自动为每个回复生成确认和再次唤醒。内容的重要性与下一步由阅读材料的 Agent 判断。
详细交互与验收见 [plan 7.5](agent-harness-plan.md#75-自然语言消息等待与唤醒)。

#### 9.2.5b 工作分支、按需物化与版本化集成（正式架构，D-078）

**工作状态独立于目录。** Application Host 的 Rust kernel 拥有内容寻址的工作状态存储：文件按字节哈希存为不可变对象，目录树引用路径状态，
工作分支引用一个固定基线与自身修改，发布新修订时原子切换分支头。Thread 关联工作分支，ThreadRun 关联本次输入修订及执行目录；
结果是不可变修订，目录是执行载体。需要保留的修改收回持久状态之前，目录不能视为可丢弃缓存。

**D-282 的当前实现：** 本节用户行为继续有效；存储/分支 gate/磁盘操作的最终执行者是 Host 的 Rust kernel。
生产调用使用不可变 root/path/domain、file-resource 与 materialization API，不展开持久全树或打开 TS recovery SQLite。
Thread catalog、Pi 会话和 Registry 保持各自所有权，见 4.3 与 Rust 设计。

| 对象 | 所有权与用途 |
| --- | --- |
| 内容对象 / 路径状态 | Host 存字节与哈希；路径状态复用 missing、file+mode、directory、symlink 原始目标、unsupported 的恢复模型，保留编码与换行；文本/二进制用于合并策略 |
| 工作树 / 工作分支 | 固定 baseState、按路径的 delta/tombstone、单调 revision、草稿路径与显式 captureScopes；目录节点采用 Merkle 结构共享，旧修订不变 |
| 物化记录 | branchId、输入 revision、实际路径、已收集 revision、运行者与未收集改动、环境准备状态、占用；同一分支写入按世代协调 |
| 结果 / 验证记录 | resultRevision、可读取正文的引用、变更路径与来源；验证记录保存 actor/Run/binding generation、观察边界输入身份、命令、cwd、退出与输出引用，运行中输入变了须说明 |
| Integration | 选定子结果、父相关路径/草稿的期望状态、逐路径计划和实际 before/after、冲突、暂存区影响与恢复操作引用 |

这是正式实施目标，不以第二个消费者或独立评测为前置。对象名称是领域责任，不要求每一行另建数据库或服务。Thread/ThreadRun
仍归现有原子 catalog，Pi 对话仍归 SessionManager，Document Registry 仍拥有窗口可变草稿，知识库仍用 TriviumDB。

**基线捕获与读取。** fork 捕获磁盘基线，并叠加发起消息窗口的版本化草稿；没有 surface 的任务读取磁盘。草稿来源自动传递，
不增加用户绑定操作。已知有草稿却拿不到正文时列出缺失路径，不把磁盘称为该窗口版本。基线发布后 read、grep、枚举、explore
读取同一 baseState 加分支 delta；父后来新增、删除或修改的文件不自动进入子分支，更新基线是一次显式记录的新修订。

当前 `thread.dispatch` 纵切在创建 Thread 前同步把固定草稿正文、编码/BOM、原换行和 surface/disk 修订来源复制进 WorkingState；
`ThreadLaunchManifest.draftBaselineId` 只持久化 Host 对象身份，不进入模型参数。带草稿的角色统一使用 isolated worktree。
隔离 dispatch 在创建 Thread 之后、返回之前（含 queued）固定非草稿磁盘基线并创建 WorkingBranch revision 0（D-214）。
Git 工作区固定 HEAD/tree 身份，并捕获 staged、unstaged、tracked mode、已删除与非忽略 untracked 的工作目录字节；
ignored 默认不进，显式 `copyIgnored`/`captureScopes` 必须进入。非 Git 与 unborn 在同一边界做一次可取消、有进度的目录捕获。
Git 命令失败、捕获窗口内父写入、活跃 Documents writer，或 gitlink/unsupported，都不得生成完整分支（D-218）。
捕获失败或取消删除该 Thread，不留下宣称完整的分支。父之后的新增、修改、删除、checkout 或提交不能改变子基线。
新虚拟 regular-file 在形成结果前写入工作区真实默认 mode；apply 与条件补偿按全字段 `sameState` 比较。
同名 `read` / `grep` / `find` / `ls` / `explore` 经 Host 分支视图读取该 base 加 delta/tombstone，provenance 标明
branch/base/delta；父 live 目录与 scratch/worktree 磁盘不能补读未改路径。隔离 Run 从虚拟 scratch 启动；同名
`edit` / `write` / `apply_patch` 把文本变更提交到同一 WorkingState delta，不写父目录（D-213 / D-217）。只有 `bash` 或
LSP 导航（`symbols` / `definition` / `references` / `hover`）首次需要真实路径时，Host 冻结当前 `writeRevision`、等在飞虚拟
写入结束、物化该修订并原子切换整个 Run；此后本 Run 的文件工具都走该目录，结算再把目录变化收回新结果。
切换失败或调用方取消后重读 execution view：仍是 virtual 则继续写分支，不得把 scratch 当权威。崩溃按
`materializationSwitch` 恢复到一个权威视图。read/grep/explore 返回的 revision 等于实际读取的 `writeRevision`。
Git blob 与工作目录转换后的字节不能无条件视为相同；当前基线读取实际输入字节。
具备角色目录嵌套工具的子线程经真实 tool registry 与 `control.thread` 能力调用 `dispatch` / `threads` / `wait` /
`send` / `read_thread` / `merge` / `kill`；Host 把 caller 解析为 `parent.kind: "thread"`，scope 与权限只能继承或收窄
（D-215）。owning workspace 保存 catalog / WorkingState / 父子关系；execution workspace 只覆盖 scratch 或物化目录的
Documents、LSP、路径与 shell（D-216）。子会话注册、thread services、Zone 2、lost resume 和 knowledge/recall/suggestions
从 Host session binding 读取 owning workspace；binding 是 catalog/run 的可重建索引，启动对账并在每次解析时核对
owning/thread/run/session，owner 缺失或 stale 必须拒绝（D-222）。嵌套隔离基线复制父分支有效视图，不扫父 live 盘；孙结果先集成到父分支或父物化目录，再由父结果进入根工作区。
每条受管目录记录持久化绝对 `managedRoot`。inspect、snapshot、materialize、setup、Git attach、reclaim/discard 在访问主路径及
staging/backup/result 邻接路径前，先验证 canonical containment，再要求 Application Host 或 create-worktree backend 重新授权根；
持久记录不能自证删除权。虚拟 scratch 默认在 Application Host 数据目录的 `thread-scratch/<workspace-hash>/<threadId>`，不借父工作区
目录充当执行路径。旧记录缺 managedRoot 时停止自动动作并报告恢复需求（D-231）。
Git 物化使用 `git worktree add --detach`（会写 `.git/worktrees`，不创建用户可见分支）或独立 `git init`，子 Git 命令不得发现或修改父仓库。
`worktree.base` / 分支 `baseRef` 仍是父状态身份；inspect/snapshot/settle 使用执行仓库可解析的 `executionBaseline`（D-220）。
reclaim 清除该执行 SHA；rematerialize 只从父仓库导出父仓库能解析的 commit。结算目录结果并入当前虚拟 delta，避免独立 init
把虚拟写吃进执行基线后丢掉。WorkingBranch 普通读取在取得 store lease 后重取当前 view；一次 explore 查询在同一 lease 内
复制 immutable snapshot，词法/结构/语义/原文都消费它。新文件默认 mode 按 umask 计算，不在用户树写探测文件。
捕获窗口 fingerprint 含 dirty/untracked 内容身份，路径集合不变但正文被替换时拒绝混合基线。
嵌套 merge 先取得父分支写入/切换权威，再决定 branch 或 directory authority，再打开对应 store/目录，不得持有
WorkingState exclusive lease 后再等 `VirtualWriteGate`（D-221）。branch Integration 先持久化 applying intent、before/after
与 retry identity，再 CAS 父 branch，再写 complete；启动对账按当前 revision/切片补 aborted、complete 或 needs-attention。
`runWhenVirtual` 按 gate、切换结束和取消信号等待或改走 disk。
directory 恢复写物化父目录走 execution Documents gate，对象库仍在 owning root；无法解析则 needs-attention（D-222）。
queued dequeue 把 `thread.manifest.permissions` 送进 `session.create`，live bypass 不能放宽冻结 overlay。
父 kill/archive 按稳定后序进入每个后代自己的 lifecycle serialization，不得持有父锁再等子锁；后代 restore/reclaim/merge 与级联并发时不能留下活跃 Run、半归档或在已归档祖先下复活（D-223）。
`scope` 只拒绝完整 `..` 段、绝对路径和盘符路径；`src/foo..bar`、`version...txt` 这类相对名必须接受。
父子树继续确定工作归属，兄弟可按9.2.5定向通信；根上下文不自动复制孙对话正文。不加深度配额，同根嵌套共享执行调度。

`harness.worktree.copyIgnored` 在首次准备后规范化为 WorkingBranch 的持久 `captureScopes`（schema 3）。窄结果发布只枚举这些
显式文件/目录根、其基线后代与当前后代，捕获新增、修改和删除；不会因此重新扫描整个工作区。重启、partial publish、reclaim 和
materialize 使用同一冻结范围，Git 是否忽略该路径不再决定结果是否保存。

Git 后端提供 staged/unstaged/untracked、filter/EOL、index mode 与 execution baseline 语义；文件正文由 kernel `file.scan/capture`
从工具实际看到的工作目录固定。非 Git、尚无首次 commit 的目录走同一捕获。kernel `file.materialize` 从不可变 root 构建 staging，
Linux 尝试 FICLONE、macOS 尝试 `clonefile`，不支持时正式 copy，并返回真实 backend；Windows 当前实测为 copy，不伪报 extent sharing。
初次发现/捕获文件有真实成本，单文件哈希随字节数增长，Merkle 只减少重复树结构；O(1) 只适用于引用已就绪不可变 root。
当前 v10 catalog 由 Rust 持久化 AVL/Merkle 节点、branch/revision/pin 与完整 mode 身份；单路径 CAS 只更新树深相关节点，
不复制整个平表。旧 schema、TS JSON writer 与升级 importer 都不在生产链。
文件监视器提供失效信号，不是完整事务日志；并发外部修改导致捕获不稳定时重读相关路径或报告不完整，不宣称跨文件瞬时一致。
基线采集属于创建/更新分支的工作，不进入普通消息、每轮恢复或每次查询的全仓扫描。Git 的过滤器、LFS 与换行转换由适配层处理，
记录实际工具所见版本，不能把仓库 blob 与物化字节无条件当成相同。（D-254：不再从 commit blob 重放 filter/LFS。
dispatch 捕获已物化给工具的实际 base 字节；settle 先固定 snapshot，再从其真实文件字节发布并在提交 catalog 前复核身份，
因此不会执行自定义 filter 或访问 LFS 网络。Git index mode 只补 Windows 无法观察的 100644/100755，并进入捕获指纹。）

**受控工具与真实执行。** 无目录分支让同名 read/grep/find/ls/edit/write/apply_patch 通过 Host 分支视图工作，保持 schema 与真实
路径授权；不在 live 父目录上搜完只覆盖 child delta。Pi 原生工具、LSP、第三方扩展或 shell 需要真实路径时先物化，所有参与该 Run
的文件工具随执行世代切到同一目录。此时普通命令可按现有权限写源码、快照与生成物；Host 收集这些修改并发布结果修订，不能让
Branch 和目录同时各自接受不相容的写入。shared 模式是有意的实时共享，与虚拟隔离分支不同。

命令返回、后台 shell 退出、Run 结算与重开时收集变化；工具 journal、目录变化记录和后端 diff 一起确定需要读取的路径。发生遗漏
或重启时按后端状态对账，必要时在该物化目录捕获差异；未确认收集完成就保留目录并显示原因。验证观察在命令 start/end 固定
authority/session/worker generation/Run 与 binding generation。Git 输入身份用不可变 base/HEAD 加 staged、unstaged、tracked mode、
非忽略 untracked 的变化路径状态；子分支再含固定草稿和显式 captureScopes。只有 start/end/publish 身份一致的同 Run 命令才能绑定
结果修订，不做每命令全目录扫描。非 Git 在没有便宜固定身份时标 uncertain。格式化、生成源码或后台写入产生新修订，不自动继承旧修订的验证结论。
相关流程直接实现并用故障测试验证，不另建研究门槛（D-210）。

**存储与保留。** kernel 的内容寻址对象、流式捕获、路径状态与条件补偿为工作分支、结果、集成提供独立引用所有者。
恢复历史清理、恢复插件关闭/更换不得删除仍由线程引用的对象；线程删除释放自身引用，只有没有任何所有者的对象才能清理。
用户可以从线程面板释放选定的旧结果版本（D-239）。当前 branch head、Thread 默认结果、active/lost Run 输入、活动 review 和
未结束或冲突 Integration 的输入仍保留；释放旧结果不删除当前分支、报告和转录。已完成 Integration 独立持有 safety/target，
其撤销不依赖原 WorkingResult。版本引用字节包含共享对象，界面只把对象实际删除后的字节报告为本次回收量。

释放绑定 branchId 与 resultRevisions，在 Thread lifecycle、存储独占 lease 和 Registry 快照序列化内重核依赖；任一选中版本
仍在使用时整批拒绝。先持久化版本目录删除，再释放引用和回收无所有者对象；失败分别报告逻辑移除与清理未完成，可用原请求重试。
对象先 flush/安装，SQLite 事务再发布 root/record/reference；result release、pin 与 GC 在同一 Rust 权威下按可达性处理。
启动及显式释放按实际记录对账；缺失或损坏的节点/对象不能被解释为空集。没有新增保留天数、自动删除线程或全仓扫描。

正常的存储位置转移须同时复制新格式对象及引用，不能仅复制 hash。固定 Git resultCommit 可以作为正常导入来源；
这些能力不要求维护旧 Piarium 库升级路径。当前内部格式替换按 D-253 直接重建并删除旧写入权威，Git 保留基线/物化/导出职责。

**集成选定结果。** merge 默认选择已发布的最新结果，并把选定 revision 写入操作；调用方可指定旧结果。Git 过渡实现使用
base → resultCommit，patch、新文件正文、类型与 mode 全从该 commit 读取，不能在 snapshot 之后再复制 live worktree。
同一结果的重试复用操作状态，不能仅靠 thread.integration 为 merged 就永远忽略该线程后来的新结果。

逐路径比较 base、parentNow、child：父等于 base 则应用子；父等于子则 no-op；子等于 base 则保留父；其他文本情况做三方合并，
干净则应用，冲突保留标记；二进制、删除/修改、文件/目录或链接类型冲突返回具体选择，不向非文本写冲突标记。按可用语言结构
减少文本假冲突的优化也沿此接口实施，文本合并成功不代表程序行为正确。

**应用与恢复。** 计划是纯计算，应用走 Host 的路径授权、版本检查与恢复操作。写前重检受影响路径和草稿 revision；不符则重算
该路径或返回冲突，不覆盖新的用户修改。受控调用按资源协调，普通外部进程仍可能绕过 Host，不声称这是操作系统级原子比较交换。
记录每个实际写入的 before/after 与阶段；意外部分失败按当前状态条件补偿，补偿遇到后续编辑则保留现场并标 needs-attention。
结果明确区分 applied、conflict、compensated、needs-attention，并附已应用/冲突路径；预期的文本冲突可包含已应用路径和冲突标记，
不把这种正常冲突处理自动撤回。记录的完成状态使用户解决冲突后无需再次重放整个 patch。

草稿来源的最终目标是对应 Document Registry 缓冲，不隐式保存用户未保存内容；磁盘目标经 Host 文件路径写入。同一次集成可能包含
两类目标，共用同一个持久 Integration `operationId`、选定结果修订和逐目标 apply 阶段。草稿按发起 owner、连接注册/代际、文档实例、
base/local 修订、正文哈希与格式核验；agent 的 owner 从 Host 固定 inputContext 解析。Documents 定向请求对应 Registry，事件只带
元数据，正文与确认走认证通道；调用方不能用自报正文或裸路径 ack 替代权威。窗口断连不等于草稿消失；只有磁盘已保存同一基线或
已经等于子结果等可核对情况才按磁盘处理。目标 before/after 和 intent 在执行前持久化并保护对象，缓冲未确认时不 complete；
重启不能把 surface 记录当磁盘目标。条件补偿与整组撤销走同一 Host 操作，重试保留首次撤销基线，后续用户编辑不被覆盖（D-203）。
缓冲不可用或修订漂移保留子结果，不静默改磁盘。其他原生集成直接应用路径状态，不执行 git apply --3way，不修改
用户 index；旧 Git 结果先导入再走同一原生集成。UI、`thread.merge`、`threads`/`wait` 与 Zone 2 共用 Thread `integration` 与
`integrationBinding`。合并预览只说明可应用性，不代表测试通过。

父状态检查只在一次 Integration 完整 applied 后，为选定 `resultRevision + operationId + parentSessionId` 打开持久观察窗口；冲突、补偿、
needs-attention 和未保存草稿不进入磁盘验证。Host 重启可恢复该窗口，只有窗口之后且命令 start/end 都匹配合并后 Git 身份的父命令
才进入记录。退出码是事实，`allExitedZero` 只汇总这些已绑定命令，不表示检查充分或行为兼容（D-210）。

**重叠提示与合并预览。** 已记录的分支变更路径可投影非阻塞重叠提示；恢复日志覆盖不到的 shell 路径标未知，未发现重叠不等于无冲突。
提示不长期占有编辑锁，不阻塞独立分支写者。后台三方预览绑定子 resultRevision 与父受影响路径/草稿版本；输入变更即失效重算，
只显示“此修订可干净合并”或具体冲突。提交解决必须消费所审阅的 binding，不能用旧解决覆盖新父输入。预览读取与同值投影不产生
新的 Thread 事件，避免面板读取触发自身重载。复用 Thread integration 投影，不需要全仓 WorkspaceHead。接通即提供，成本按变化路径计量。

**环境准备。** 使用工作区用户配置的 setup 命令与环境文件规则，按需要执行/分析的工具准备环境；没有命令不伪称已准备，也不因此
禁用不需要准备的任务。setup 幂等，重建或依赖输入变化后重跑；超时由用户配置或既有任务运行时语义处理，不设无依据的 600 秒默认。
Host 通过父 Pi 会话的 settings.get 取得实际设置和 projectTrusted，不能直接重读项目文件绕过项目信任；坏配置明确失败，不当作缺省值。
失败记录 setup-failed、退出码和输出引用，可修复后继续。需要跨重启查看的 setup 记录使用操作所属的耐久输出，OutputRef 只作当前
快速读取句柄，不作为持久报告唯一引用。用户配置一次即授权正常重复执行，不每次再问，不自动执行从仓库猜出的命令。

文件分为需版本化的工作输入/结果、可重建缓存、用户提供的环境文件；ignored 仅作初始选择信号，不能判定重要性。copyIgnored 可显式
选入文件或目录，其规范化根随工作分支持久化并参与每次结果发布。优先文件系统 CoW 克隆（写时分离）和包管理器自身缓存，缺该能力正常复制；可写构建产物不默认硬链接或 junction
到父目录。用户显式共享时显示共享范围。Git 后端不切用户当前分支、不改写提交历史，内部引用可识别；允许必要的 worktree 元数据，
不承诺“用户 .git 一个字节不动”。

#### 9.2.6 等待、资源与缓存

wait由运行时订阅实际依赖，不产生周期性模型调用；结果/答复到达、用户输入/取消或明确超时才恢复处理。等待中的父线程
让出委派执行名额，子线程能准入；唤醒后也走同一调度，不因恢复绕过预算。会话可保持可恢复，实际进程、内存与文件writer
是否释放由它们的生命周期决定，不把线程等待等同物理资源已回收。

缓存可能在等待期间过期，也可能因其他适用请求仍可复用，按provider实际响应计量。默认不为保持热缓存唤醒主模型；用户
已有明确缓存保活选择按其契约保留，真实额外请求记账，不让任务正确性或可恢复性依赖保活。不能只看主线输入减少就宣称
整项任务更便宜，同样也不把用更多调用换更快结果当成失败。

D-284 已启动的摘要准备可在等待期间完成，空闲/TTL/子返回本身不启动新摘要。后续请求按当前容量处理。若新工作背景已
明显过期，选择fresh而不是为旧缓存继续携带它；这不把时间变成自动清历史的阈值。

#### 9.2.7 后续能力

smart friend（便宜主模型遇难题时 fork 完整上下文向配置的强模型求教，Cognition 的 80/20 解法是共享完整上下文的 fork）
——需要一个高于主模型的 `models.smartFriend` 槽位，不进 v1。

### 9.3 线程：一件工作可以多次交付与继续（D-285）

线程在父会话侧栏按任务呈现，用户可打开、提问、调整方向或停止。Thread 的寿命独立于一次模型调用、一个 Run 和一次
结果返回；观察只是订阅，连接断开不等于工作消失。主线保持整体任务归属，用户进入支线不自动改变主线或广播全部讨论。

#### 9.3.1 对象与状态

Thread 是工作本身，ThreadRun 是一次执行。D-285 的职责示意如下；当前 DTO 尚需迁入这些职责，不把示意当作已接线字段：

```text
Thread
  id / parent / workspaceId / brief / 创建与任务关系
  lifecycle / attention / waitingFor / integration
  working branch / published results / reports / activeRunId / eventSeq

ThreadRun
  id / threadId / attempt / runtimeId / sessionId / execution state / outcome
  execution = model + tools + permissions + scope + worktree mode + 配置世代
  input = task | inherit | continue | fresh + 来源边界 + 选定工作状态
  实际用量 / 步骤 / 退出与时间事实
```

每次 Run 的执行配置和输入来源由 Host/broker/Pi 共同解析并冻结；Thread 可投影最新配置供 UI 查看，但不再以永久 role/manifest
决定所有未来执行。换预设、只读转实现或 fresh 都保留 Thread，按既有授权启动新 Run，历史 Run 不被改写。原生 Pi 会话或
分支承担对话；新的输入世代可以使用 SDK 支持的新分支/会话，Thread 保持到原转录与成果的可读关系，不手改 JSONL。

任务状态、Run 结局、集成冲突、待处理消息与执行名额分别表达：settled 表示本次交付已结束，不等于 Thread 永不可继续；
等待释放执行名额不改写为成功/退出，不伪装进程关闭。崩溃仍以 lost 结束该次尝试，恢复新建 Run；记录在既有 workspace
catalog，身份来自 broker/Host，不因状态条目还在就声称 worker 活着。模型资源名额与文件写者/物化占用按各自权威管理。

固定结果与验证仍由 WorkingState 保有修订，Thread 投影子检查、可应用性和父检查。开启下一 Run 不删除之前已发布成果；
旧成果可按明确 revision 使用，新尝试失败不继承旧检查为当前通过。最新交付与当前执行分开显示。

#### 9.3.2 新线程起点与已有线程续做

新建入口仍由用户“从这里开一条线”与模型 dispatch 共用，显式选择任务背景或继承当前输入：

- `task`：默认。任务、必要材料引用、当前项目规则与可选计划/用户笔记；无需父完整对话。适合独立问题和独立审查。
- `inherit`：固定派发时父实际可用的摘要与原文，把子任务加在尾部；不等 dequeue 时取父的未来内容，不复制未完成工具调用
  或正在执行的过程。工具输出/文件引用按新会话的真实读取权限与存储重新绑定，不能只复制失效句柄。

模型/工具相容时保留可复用前缀；需要不同配置时按正确配置构造，不为缓存放弃权限或适用工具。相同历史被多个子模型读取
仍各有实际用量，不把逻辑引用当作共享模型状态。工作区基线与上下文分别固定，父的旧阅读记录不能冒充子现在的磁盘版本。
retrieval 默认 task，保留不携父 blocks 和专门事实协议的选择；预设声明与用户显式输入选择冲突时清楚表达，不偷偷继承。

已有线程继续由执行请求进入：工作和背景仍相关用 `continue`；工作延续但旧背景大半过期用 `fresh`（8.4.7）；不相关新任务
新建 Thread。`send` 的 `kind:"request"` 对 settled 实现线程经 `threadContinueRun` 新建 Run：`continue` 重开保留会话
原样续跑，`fresh` 按 2.6A 组装新输入开新会话（旧转录经 `previewSessionEntries` 可读，工作与结果保留）；普通 `inform`
仍只投递不新建 Run——对 settled/非运行线程作为耐久 held 记录留在 Thread 上，到下一次正常输入边界成批交付。
需要时从选定结果重建已回收目录，沿实际权限和统一执行准入启动；新 Run 记录输入结果身份。普通 inform 不触发这些动作。

只读讨论转实现保留工作与历史，按新 Run 授予实际工具/权限并准备工作分支。上下文可继续，也可 fresh；不强制新建“实现员工”。
重建输入时加载当前规则和适用成果、未解决问题、仍在运行的子任务/进程引用及待处理消息，不依赖旧会话缓存继续沿用旧要求。
这不创建周期性的背景清洗，也不要求新 Run 先让另一个模型概括全历史。

#### 9.3.3 成果续接与代码依赖

线程可以发布一个可用阶段并结束该 Run，父接入后让同一 Thread 继续。消息提前交流发现；代码、表格或报告以实际结果/产物
交付。说明须足以判断用途、已完成部分与缺口，简单问题直接给答案，大材料给必要说明和可读入口，不强制所有结果按极小
预算截断。主线使用真实产物并完成所需集成检查，不根据一份报告重新制造同一成果。

父合入 R1 后，原线程可以从自己的 R1 继续 R2；父此后产生的新公共变更不会自动进入子工作状态。新派发依赖任务时从选定
父状态建基线；已经启动的依赖线程则显式纳入选定父修订，再继续执行。复用 WorkingState 三方计划、原子修订和物化切换，
保留子自己的 delta，冲突按已有 Integration 处理；更新基线与结果来源一起记录，旧 R1/验证引用保持不可变。运行中的写入
在安全边界协调，不能发一句“接口更新了”就宣称同步成功，也不建设任意线程自动双向同步。

上下文重建与代码同步是两个独立选择：fresh 不丢子改动；continue 也不能掩盖代码还在旧基线。父对明确结果 revision 集成，
不依赖“最新报告”别名猜测。兄弟相互确认局部问题即可，涉及公共契约或任务方向的决定带产物/修订回告主线。
报告的偏离来自明确完成字段，缺失如实表达；不借 keeper 块、聊天长度或虚构进度补齐，不自动增加审查链。

#### 9.3.4 生命周期与回收

- **与父的回合、worker 进程解耦。** 线程是持久会话，会话文件每步落盘。父回合结束它继续跑；父 worker 死了它不受影响；
  线程自己的 worker 死了会把当前 `ThreadRun` 结束为 `outcome: lost`：host 在同一会话文件、同一 worktree 上创建下一次
  `attempt`，线程 id 不变，从最后一个
  完成的步继续，Zone 2 告诉它"你被中断过，上一条工具结果可能缺失"。这是恢复子系统"worker 退出 → 标 incomplete、不说谎"
  的推广。
- **完成进入父的下一回合。** 线程完成是一个事件；父在 `wait` 里就立即返回，不在就以 Zone 2 一行进入下一回合（通道 A）：
  "线程 X 完成：一句结论 · 3 个文件 · 相对简报的偏离：…"。父压缩也不丢线程：活跃线程列表是 host 事实，每回合以一行
  一条出现在 Zone 2，超过 N 条折成"另有 K 条"。
- **半成品保留。** 失败、取消或 worker 丢失先收集可取得的修改并发布结果修订；尚未完成收集的目录保留，明确显示未持久化路径。
  已发布结果及其正文由工作状态引用保留，Git 迁移阶段由持久 resultCommit 承担；不能因没有正常结算就丢弃半成品，也不承诺
  从未成功写入存储的内容能够凭空恢复。父或用户可查看结果、继续原线程或开新线。
- **边界回收（D-077 经 D-078 修订）。** merge、取消、失败、归档、无活动使用者的 idle 触发收集与回收，默认执行；目录重开时从
  固定结果在原路径重建，按需重跑 setup。无活跃 Run 之外还要检查相关 shell/process writer 与实际使用者。Git status 干净仅说明
  Git 跟踪范围；需保留的 ignored 输入/结果同样要已保存，已声明可重建缓存允许删除，未知内容保留并报告。路径必须位于该记录的
  受管根内且身份一致。条件不满足仅保留该目录，不禁用其他线程；显式 keep_worktree 选择继续有效。
  归档取消并等待该 Run 的准备/setup/启动、实际会话与 shell 退出，失败保留绑定和目录。删除期间持续持有 Documents 写者屏障并
  重核结果。同线程的归档、恢复和回收互斥，自动清理跳过正忙目标。父 kill/archive 对每个后代进入该后代自己的 lifecycle
  serialization，使用 `createdAt` 再 `id` 的稳定后序，避免递归锁反转；祖先归档或正在级联时拒绝恢复该后代（D-223）。
  恢复从选定 native resultRevision 重建，沿原 session 绑定新 Run；
  普通已结束/已回收线程的打开也走该链。失败保持原生命周期可重试，不开放错误目录；准备进度持久化为明确阶段，部分目录重试清理核对 fingerprint（D-204）。
- **占用与背压。** 记录物化目录、对象库、受引用历史及可回收量，删除目录不等于释放结果对象。共享对象在工作区只计一次。
  优先回收符合条件的缓存；新增物化按用户配置预算、实际可用空间与可知准备需求安排，必要时排队或返回可行动的 unavailable，
  不终止已有线程来腾配额。没有定标时不默认设置 8 GiB/10% 硬拒绝，也不把未知所需空间当 0；运行中的实际空间不足按 I/O 失败
  明确记录（ENOSPC）。线程面板展示 Host 占用、保留原因和立即回收，不设无依据的 80% 统一阈值（D-202）。
  统计覆盖该工作区全部父会话；首次物化与恢复在短临界区预留已知新增需求，慢 setup/会话调用不持工作区锁。未知量不遮住已知超额，也不因此统一拒绝任务（D-204）。
- **启动对账与历史清理。** 对受管记录和目录对账，修复 Git 元数据；能确认属于 Piarium 且已保存的无使用者目录正常回收，归属
  不明的目录展示而不猜测删除。历史对象与分支按引用及用户保留配置清理，不以固定 30 天删除仍可继续的结果。分支名虽小，其
  引用会保留内容对象，须计入历史占用；对账和回收不依赖某个 idle 定时器。
- **用户释放旧结果。** 线程卡片按需加载版本、引用大小与保留原因；确认冻结的版本选择后由 Host 重核并释放（D-239）。
  刷新或切换会话不会让旧选择指向新分支，清理失败保留相同请求重试。仍可继续的当前分支和正文转录保持独立生命周期。
- 对话正文不因压缩自动删除；最终报告与计划/用户笔记快照按原有会话、Thread 与知识引用保留，不要求存在后台工作块。
  **用户删除父会话**：现有删除确认说明运行线程将停止并归档；结果保留是否成功按实际执行返回，不预先声称都已保存，不弹第二个模态；
  删除后给可撤销提示；运行中的线程停下（`outcome: cancelled`，快照后目录按上面的规则回收）并归档，归档区提供"恢复为独立线程"
  ——这是产品决定，不是技术约束（另一种可选设计是让它们直接成为工作区级的独立线程）。每条线的花费与占用可见。
  线程报告里的原始 trace 引用是 `TranscriptRef`（第 5.1 节），指向线程自己的会话文件，与线程同寿命。
  **用户删除整条线程（D-242，已接）**：线程卡片的两步确认 → 鉴权 `DELETE /threads/:threadId` → 与归档同一级联形状后序删除
  后代。每个节点先停活 Run（不铸 partial result），再删除该线程拥有的全部 Pi 会话（worker、转录文件、metadata 经
  `piRuntimeBroker.deleteSession`），随后释放工作分支上的全部结果修订、分支头与草稿基线并回收无主对象，然后删除受管目录
  （跳过结果快照 diff，仍过 ownership 断言与 user/writer guard；keep_worktree 对删除不生效，否则目录成无记录占用），
  最后原子移除 Thread+Run 行并解绑 session binding。删除 intent 与下一 phase 先持久化到 Thread catalog；Host 重启可续跑。
  任一后代未完成时父节点不得移除，knowledge/evidence 引用清理属于提交前必需阶段，返回值只列真实删除项（D-254）。

#### 9.3.5 活性与失败分类

活性由 host 从线程的事件流观察，不靠线程自报、不靠父读转录：最近事件时间、工具调用频率、连续相同工具加相同参数的次数、
上下文增长、花费。停滞 = 超过 T 没有事件（T 默认按 provider 缓存 TTL 推，与第 9.2.6 节一致）；循环 = 重复模式。这是
传感器，允许机械判定（它决定的是"提醒谁"，不是"什么重要"）。

T1 的落地值是：无事件 300 秒只翻 `stalled` 告警、不取消 Run；连续 6 次完全相同的 `(tool name, 参数哈希)` 翻
`looping`，下一次不同调用自动清除。第一次非预期 worker 退出会在同一会话/worktree 上自动开新 Run；若新 Run 再连续崩溃，
停止自动重启并翻 `stalled`，避免形成进程崩溃循环。角色模型、工具和冻结 permission overlay 经 `session.create/open` 在 Pi 会话构造前冻结（D-219 / D-222）；`hard-implement` 与 `frontend` 的角色目录含嵌套线程工具，
由 Host 能力与 `assertOwnerTool` 启用，不是提示词授权。`review` / `check` / `retrieval` / `quick-implement` 不含
`dispatch`（D-215）。`retrieval` 通过冻结 allowlist 与 `thread.facts.set` 交付事实：Host 按冻结 scope 与
Documents 读取核对路径/行范围，模型不能自行把不存在或越权来源标成 source-checked；Host 不能把来源存在写成 claim 为真。
大材料与子会话 output 复制为耐久 artifact，URL 必须带 active retrieval Run 铸造、绑定 owning/session/thread/run、exact URL 与
正文 hash 的 Host receipt；普通 webfetch 不生成该权威。临时 artifact/receipt 从创建起有 object reference，提交时转成 pending，
封印后转成 sealed，真正删除 Thread 时一并释放。父 `read_thread` 按 UTF-8 字节从耐久对象分页，不先载入全文。不复制父完整对话
（`carryBlocks: false`），默认不改工作区；嵌套 retrieval 在 dispatch 时建立 isolated 冻结分支，可为 LSP 物化只读输入，settle
只封印 evidence、不发布目录变化（D-227 / D-230 / D-231 / D-234）。

失败有分类，没有"没结果"：Run 的 `success / failure / cancelled / lost` 记录执行结局；Thread 的 `stalled / looping /
user / permission` 记录当前需要关注的原因，`integration` 独立记录合并状态。每种是不同的结果（不变量 3）。等待输入是一等
attention——实践里最常见的"卡死"其实
是在等一个没人看见的权限确认或澄清问题：它出现在 `threads` / `wait` 结果和用户面板里，附问题正文，父 `send` 或人直接
答；权限请求走当前活动权限门的 UI 并带线程徽标，永远不会静默等待。完成报告用受控的
`Conclusion` / `Deviations from brief` / `Unresolved issues` 标题形成，不从普通散文猜，不依赖 keeper decisions；
报告、实际存在的计划/用户笔记快照、diff 统计原子写进注册表，
`done` 之后再 `wait` 仍返回同一份。

#### 9.3.6 线程工具与执行请求

- `dispatch(task, options)`：异步建立任务线程，选 task/inherit、可选预设与工作状态；返回实际准备/排队状态。
- `threads(ids?)`：任务名、当前执行/等待、最近实际活动、可用结果与缺口的增量视图，不伪造 progress。
- `wait(targets?, timeout?)`：由 Host 订阅指定结果、请求答复或需要处理的状态变化；超时是正常观察结果。普通读文件进度留在
  UI，不因每个步骤把等待者唤醒做模型检查。等待明确让出执行名额，完成后按同一队列恢复。
- `send(to, message, { kind, replyTo?, context? })`：inform 投递材料，request 请求回答/执行；replyTo 绑定已有请求，满足显式
  等待时可唤醒一次。context 的 continue/fresh 用于后续执行请求，不改变普通通知。来源由 Host 填入。
- `read_thread(id, what?)`：默认状态/结果说明，可按结果修订读报告、产物、计划/用户笔记或分页转录；不给所有场景统一极小摘要。
- `merge(id, resultRevision?)`：沿现有 Integration 消费固定成果；依赖线程纳入父变化是明确的工作状态更新，不靠 send 模拟。
- `update(resultRevision?)`：把调用方工作分支重订到选定父结果修订；三方规划保留自身 delta、采纳父方变更、干净
  文本合并，分歧路径保留自身字节并报告冲突；kernel 在同一 CAS 写中原子切换基线并记录 `parentRef`，旧结果仍绑定
  其发布时基线。普通消息和 fresh 续做都不能替代这次文件级更新。
- `kill(id)`：停止执行并保留已发布结果，目录按真实 writer 与保留责任回收；普通通知不复活已取消/归档工作。

这些是 D-285 的目标语义；3.18A–E 已实施：任务中心派发与可选预设、task/inherit 与 continue/fresh 续做、inform/request/
replyTo 定向消息、同根共享执行名额与等待让出、不可变结果修订冻结溯源与 `update` 显式纳入父修订均已沿生产链接线。
3.18E 收口：自动 review 默认关（父线程无会话同样默认关，唯一翻案是用户显式 `harness.review.enabled`）；UI 面板提供
Ask/Fresh/Note 定向消息控件与最近消息来源/held 显示，经公开 `POST .../threads/:threadId/send` 走与 Pi Host 工具
相同的 `thread.send` 服务；role-required、单向 send、永久执行 manifest、per-parent 准入等被替换路径已删除。
无需先建设任务市场或通用工作流，公开入口必须能完成“派发—解决依赖—交付—使用—同线程续做”的一条纵切。

D-300 的可选等待发送与自动现状是后续目标，见 9.2.5a 与 9.3.7；这里的现有工具清单不证明新参数已实现。

#### 9.3.7 增量视图与送达

Host 为观察者保存实际交付的事件/结果修订和所属 Pi entry，按8.7提供增量；消息的已接受、已送达和执行完成分别表达。
重复响应/重连不重复入队任务或唤醒，尚未送达的正文沿原有会话/消息持久路径保留。普通状态更新可合并，用户请求、需要
处理的问题和不可替代的结果不能被进度折叠抹掉。

固定上下文准备不改观察游标；提交压缩后，只有确已失去原文基线的对象在下次观察重建。fresh 开始新输入视图，保留旧转录，
当前待处理请求和活动任务引用重新投递一次。用户 UI 的观察仍独立；环境事件按增量提供，不每轮复制完整报告或 keeper 块。
D-301 / 7G 的简短团队快照按 8.1.1 每次附尾，不属于此处的历史事件去重。

**D-300 的后续扩展（待实施）：** 为主线与分支提供“线程 / 任务 / 状态 / 进展”的简短现状表。
任务来自 brief，状态来自 Thread/Run/等待，进展机械摘取该 Agent 最近一段已完成的可见输出，约 20 个可见字符加省略号。
工作说明和最终答复都可作为来源；不要求专门汇报，不用总结模型，不读取隐藏推理。
新消息/结果在进展列标记来源，不能冒充该 Agent 的文字；没有新输出就保留时间和旧引用或显示暂无。
每条预览可由 `read_thread` 展开到显示时对应的原文修订，再逐层读邻近上下文、消息、成果。

Host 从现有事件维护投影。D-300 当时采用首次短表/后续变化行；D-305 的独立 7G 按 D-301 改为每次模型请求
末尾的完整当前短表，覆盖同回合工具续接与等待返回，历次表不进入对话历史，环境增量仍按送达留史。
不能只依赖初始化/`before_agent_start`，也不逐 token 更新输入；固定协作说明与请求角色见 8.1.1。
环境观察确认只覆盖实际送入模型的内容，UI 游标独立；临时表不依赖旧表收据，压缩/fresh 后直接重建当前视图。
大团队按根、关系、关注范围渐进展开并说明未展开范围，读取不启动模型。
完整设计见 [科研集群设计第 7 节](research-cluster-design.md#7-通用多-agent-交流与持续现状)，适用于整个 Harness。

#### 9.3.8 以任务和成果呈现

父侧栏以“摘要请求实现”“设置面板”等任务名展示，模型/预设是辅助信息，不按职位扮演组织公司。点开可直接交流、继续、
重建上下文、停止或查看历史结果；“继续工作”与“保留成果并重建上下文”说明影响，不要求用户手管团队。已有讨论转实现、
归档恢复和结果保留入口继续复用。

定向消息在接收者会话中带真实来源与可展开正文，主线显示影响整体的结果/决定和待处理问题；普通子过程不自动广播。
子线程发布R1后继续R2，UI同时显示已可用成果和当前执行，不能把旧验证标成新结果通过。常规用量包括真实子执行，缺失不
补零；不新增财务看板、聊天量进度或编造完成百分比。rail、overlay、Fleet沿同一Host注册表与事件源投影。

## 10. 工作侧重与工作台

### 10.1 与 Workbench Profile 的关系

[composable-workbench.md](composable-workbench.md) 的 **Workbench Profile** 选择 surface 的 Shell 与贡献点。
**Agent Profile** 在产品中称“工作侧重”，声明提示词、工具、技能、团队目录、上下文/验证策略、权限默认值与知识库扩展，
属于执行配置（D-072/D-297）。Workbench Profile 的 `default`/Agent Workspace 也不能与 Agent Profile 混为同一身份。

工作台在现有 Agent/IDE 切换区域提供入口，科研与未来办公使用完整 UIUX 和已有切换动画。
用户打开项目或会话、改变工作侧重时保持当前工作台；界面切换保留会话、文档、任务和执行配置，不调用模型或派发研究。
IDE 是完整开发环境，能继续科研任务；科研工作台也能承载普通编程对话，工具可用性不由 Shell 挂载决定。
具体产品交互见 [科研集群设计第 10 节](research-cluster-design.md#10-产品入口工作台与工作侧重)。

项目设置只提供新对话的默认工作侧重。新对话显式选择优先，未指定时捕获项目默认，再未指定沿用现有通用/编程默认；
工作台类型不参与解析。对话保存自身选择及来源，修改项目默认不改已有对话。对话侧重可手动修改，从下一轮用户请求
沿已有 Run/worker 安全切点应用；当前执行和已派发分支保持冻结配置，新配置失败时保留原配置并报告失败。
切侧重不删除成果或隐式停止任务；停止和继续保持显式的生命周期动作。

产品可以给出独立选择的建议，不能通过选工作台暗中应用执行预设。**模型槽位的值仍 user-only**，Agent Profile 只声明需要的槽位；
工作侧重也不扩大用户授权。办公工作台与 `knowledge-work-in-files` 侧重沿同样边界发展，不要求成对选择。
Agent Profile 的实际绑定随 Run/配置世代记录，单会话实验覆盖先沿已有 launch 接缝提供；完整 RunManifest 待真实消费者逐步收敛。
D-298 已接通独立入口、项目默认/对话覆盖和基础科研 UIUX；D-299 接通首段能力路由。
剩余调度、执行与 D-300 的协作扩展按 plan 后续阶段实施，具体交付事实见 status。

### 10.2 `code`（v1）

本文档第 5–9 节即其规格。工作区形态：仓库；验证器：编辑后诊断、可选测试门、review 传感器；权限由 Piarium 原生
`tool_call` gate 统一管理，并叠加 Host 的非交互 actor/capability/path enforcement（第 9.1.2 节）。

### 10.3 `research` 工作侧重（第二个）

AI4S 科研工作侧重的产品中心是 [科研集群设计](research-cluster-design.md) 定义的异构模型协作，而不是资料或记录管理。
用户面对一条首席研究主线，主线按研究方向派生多个 Thread 分支：强模型负责问题发现、第一性原理分析和跨分支综合，较强模型负责文献深读与实验设计，快速模型负责局部假设、实现、批量分析和异常处理，复核与写作按影响和论证缺口触发。模型按能力路由，分支可以升级、降级或换模型，不把具体型号绑定成永久职业。

研究循环是动态分叉、低成本区分、真实执行、交流综合和下一轮资源分配。普通批处理、进程监控和日志整理由程序完成；
是否因异常或冲突发起综合，由用户/Agent 通过自然语言交流决定，程序只响应明确请求与已建立的等待。
Thread 树负责执行责任，父子和同组分支可授权直连交流。现状取已有输出短摘录，经 Zone 2 持续增量提供，按需展开原文，
不新增交接表、状态汇报或总结模型。这些是通用多 Agent 能力，科研与普通编程、未来办公共同使用。

D-303 收口本机实验与事实消费者；D-305 已实施 D-304 的受管远程、真实进程/job 控制、多机器资源和材料复用，Slurm 暂缓。
Agent Run 与计算 attempt 独立；SSH 连接状态不冒充作业状态，资源请求不冒充 allocation。
Host 负责研究编排，目标 Rust 执行服务拥有实际作业和资源确认；运维角色使用普通 Thread，可按规模由零个发展为多个分管线程，
负责环境准备、故障诊断和授权修复，不替代程序准入、不固定管理层级。研究矩阵自然生长，系统只提供批量便利操作与来源关联，
不要求矩阵对象或参数表。实现边界见 [实验执行设计](research-cluster-design.md#6-实验执行与资源协作) 和 plan 7I。

文献、PDF、代码、数据、Shell、notebook 和领域工具作为工作侧重的材料与执行能力接入。证据、版本、运行和产物自动保留为内部事实基础；证据表、实验协议、Research Diff 和文章结构按需生成，不是研究者的前置表单。写作线从研究中途参与，发现论证缺口后回流检索或实验任务。第一阶段从代码、数据和计算实验开始，后续领域通过 Agent Profile/Adapter 扩展，不把产品固定成论文复现工具。

### 10.4 `knowledge-work-in-files`（第三个，收窄）

以文件为载体的知识工作：笔记、文档、表格、PDF，加浏览器与 web。**它的范围不是一个目录**（D-162）：办公的东西天然分散在
Documents / 桌面 / Notes / Downloads，所以这个 profile 的检索范围按第 6 节的分层走——文件名与元数据全用户目录、全文词法
在用户指定的根、语义跟着工作集与钉住的集合——而不是把工作区模型硬套成"一个大目录"，也不是索引整个电脑。它是第 6 节
`scope` 参数化的第一个真实消费者；在它之前 3.16 只须不把门堵死。
SaaS 连接器（邮件、日历、聊天）本质是 MCP server 加不可逆动作的确认 UX，不在此 profile 范围内，未来若做以连接器层
出现，不新建产品形态；结构上它们是"把外部东西变成带身份、内容、修订的文档进同一个索引"，`scope` 多一种。

### 10.5 接缝先于领域

共享接缝围绕当前已确定的 code、research 与文件工作能力发展；一个真实消费者已能说明用途时就实现，不要求凑齐两个实例才允许
抽象。领域组件随自己的使用路径交付，不为尚无用途的功能预建完整框架，也不把 code 的全部长尾工作作为其他 profile 的共同前置。

## 11. 默认 runtime

桌面内置一份钉住的 Pi 作为默认 runtime。`inspectBundledPi()` 与 `includeBundled` 路径已存在并被云镜像使用，桌面端
只需在打包时放入 Pi 包树并设置 `packageRoot`；`nodePath` 使用 Electron 自带 Node。三条约束：

- **runtime 代码内置，数据目录共享。** 内置 Pi 使用用户的 `~/.pi/agent`；CLI 与 GUI 看到同一批会话、包与设置。
  这是 [architecture.md](architecture.md) 第 10 节既有的分离。
- **用户自有 Pi 是显式选项。** Runtime Manager 的 system / standalone / source / custom 来源保留在 Settings；选择的
  版本超出已测试范围时显示诊断，不阻止。
- **短滞后跟随上游。** 内置版本由与 `cloud-runtime.bun.lock` 相同的流水线更新，避免社区扩展要求的 Pi 版本高于内置
  版本。数据目录格式"旧读新"的风险由短滞后压缩窗口，由显式选项提供出口。

内置 Pi 不内置 Git Bash：Windows 上 `bash` 工具依赖 Git for Windows，Runtime Manager 的就绪检查必须包含它并给出
安装指引，否则"内置 runtime 开箱即用"在 Windows 上不成立。

当前 harness 的具体 Pi 版本依赖已经形成，bundled runtime 直接按阶段 4 交付，不再等待其他能力全部完成。

## 12. 交付顺序与待决问题

### 12.1 顺序

交付单位是用户可用的实际调用链。跨进程工具贯通协议、Host、worker 与实际请求验证；纯 UI 或存储按自己的调用链验证，不强制
走无关层。implemented / wired / proven / default-on 记录在 status。proven 的正式能力随交付默认提供，用户选择继续有效；
不再附加统一的回放批准阶段（D-078）。文件入口与验收要点见 plan。

P0、T1/T2/T3 核心和 D-076 已交付；工作状态/集成、默认记忆、窗口读取/explore 的具体进度见 status。
D-282 已完成 D-252 的阶段 R，后续外部 runtime 和新领域直接复用当前 Rust kernel/TS Host 边界。单会话配置与归因随相关能力完成，
T4、完整 RunManifest、知识数据库迁移或沙箱不作为共同前置。下面是总体范围，实际顺序按 plan 0.7。

0. **前置**：对齐 Pi 版本并在该版本上复核第 4.1 节的钩子形状（已完成，D-001：0.84.3）；恢复的 coverage 从计划级二值改为路径级（见
   [native-workspace-recovery-design.md](native-workspace-recovery-design.md) R1），否则 `bash` 注册为 `process`
   writer 后几乎每一轮都会被标为 incomplete，组合回滚在实践中消失。
1. **工具与 host 服务**：`harness-tools.ts`（`bash` / `grep` / `edit` / `write` 覆盖，`apply_patch`、`get_output` /
   `write_to_process` / `kill_shell`、`diagnostics`）、shell 监督器（按环境选解释器、PTY、login 会话 shell、自动转
   后台）、按路径的编辑锁、`tool_result` 层的通用句柄截断、worker→host 类型化请求、第 4.2 节违规修复、第 8.6 节计数器。
   `bash` 优先——在 Windows 上一天内可感。（`todo` 依赖 `block` 存储，随第 2 阶段交付。）
1b. **web**：`webfetch` / `websearch`、抓取服务（SSRF、提取、PDF 转文本、缓存、Electron 离屏渲染）、搜索 provider 抽象、
   来源面板。可与 2 并行。
2. **上下文层（D-284/D-286/D-287，已完成）**：真实请求前预算、缓存友好的后台摘要准备、固定切点提交与较长近期原文、
   当前/同 Thread 历史回读及 receipt-bound Zone 2 增量。`todo`、用户笔记、知识库与 suggestions 保持各自权威；持续 keeper 与三态接管已删除。
3. **检索与子 agent 层**：`explore` 管线（多路召回、当前原文读取、单元排序与一次呈现；按 D-173 收敛职责与调度）、
   `file` / `symbol` 节点与 LSP / Git 采集器、`related`、LSP 导航工具（`symbols` / `definition` /
   `references` / `hover`）；原生子会话 worker 运行时按**线程**形态（第 9.3 节）交付：host 持久化的线程注册表与状态机、
   worker 丢失恢复、host 观察的活性与循环检测、`dispatch` / `threads` / `wait` / `send` / `read_thread` / `kill`、角色目录
   与独立模型槽位、原生工作分支与按需物化、集成与回收、事件驱动等待、观察游标、线程侧栏与讨论线。D-285/D-287 已接通普通
   派发、task/inherit/continue/fresh、定向消息、分段成果与共享执行调度；自动 review 默认关闭，仅在用户显式启用后运行。
3b. **权限纵切（D-283，已完成）**：Host 静态授权与 scope、Piarium 原生唯一 `tool_call` 门、规范化权限对象、session grant / audit、Settings 与 Smart；旧 permission-system 双轨已删除。
R. **Rust 系统内核与 Host 分层（D-252/D-282，已完成）**：R0–R6 已接管工作状态/恢复、磁盘/物化、进程/终端、文件/结构计算，
   并完成数据保留、取消/崩溃恢复、性能定标与发行矩阵接线。TS/Pi 保留上层职责；外部 runtime 和领域扩展沿此边界继续。
4. **默认 runtime**：内置钉住的 Pi。
5. **外部 agent**：host 服务的 MCP 门面、ACP host、能力协商；届时重新评估协议兼容策略。
6. **research profile**：复用已具备的工具/知识库/文档能力，直接建设文献采集、引用核验与 Shell 面，不等 1–3 全部长尾任务结束。

### 12.2 历史决定与实施选择

历史决定（后续修订以当前正文为准）：2026-09-02 的 edit v1 使用直接写盘 + reconcile，后续按 5.4/9.2.5b 实施版本化视图；
`piarium serve` 检测到桌面 host 在运行时复用它而不起第二个（第 7.1 节）；子 agent worktree 由父 agent 的 `merge` 工具
合并、Git 面板可选审阅（第 9.2.5b 节）；`event` 默认保留 30 天（第 7.2.1 节）。

2026-09-04 的决定（D-030–D-038，其中默认和回放政策已由 D-078 修订）：Pi 0.84.3 消费 `session_before_compact` 返回的
`{ compaction }` 并跳过自身摘要，`session_compact` 随后触发且 `fromExtension: true`（D-022，前置实验结论，8.4.4 的提交复用此接缝）；
线程对象拆为 Thread + ThreadRun、状态正交（第 9.3.1 节）；wait 默认事件驱动、缓存保活可选
（第 9.2.6 节）；输出引用分 `OutputRef` / `TranscriptRef` 两级、偏移统一 UTF-8 字节（第 5.1 节）；权限三层与 Host 静态
授权（第 9.1.2 节）；设置按字段所有权（第 5.10 节）；D-081 曾交付记忆三态与默认 takeover，D-284 已确定替换目标但尚未改代码；父会话删除
时线程停下并归档、不弹第二个模态（第 9.3.4 节）。

**D-078 的交付政策保持**：正式能力完成后直接提供，不加回放门禁。上下文与线程的新默认分别按D-284–D-286；自动review改为
用户选择，不以“默认交付”推导必须常驻调用。以下列实施选择：

| 范围 | 已确定方向与实施选择 |
| --- | --- |
| Rust 内核 | D-252 已采用、D-282 已完成 R0–R6；完整契约与实际性能边界见 rust-kernel-design/status。生产只有 Rust 系统资源权威；修复后的 TS 路径只作为历史验收/性能 baseline 或显式测试 helper |
| 上下文续接 | D-284：活动请求配置派生摘要，容量临近时后台准备，前台继续，需空间才提交；原文保留随窗口缩放，history 回读；完整替换 keeper/coverage/三态与其消费者。当前实现仍见 status 的 D-081 行 |
| 工作状态与结果 | Host 原生内容对象/树/分支/Integration，Git 基线与物化可复用；独立引用、真实执行写回；旧内部格式按 D-253 直接替换，不建升级导入器 |
| RunManifest | Host 执行意图、runtime 解析模型/工具、Host 确认能力、worker 报实际装配；沿 launch 消费者收敛，不复制凭据权威 |
| 外部 runtime | 对实际 adapter 做版本和能力协商，不先解决全部未来版本兼容问题 |
| 本地 embedding | 按可部署模型与 runtime 选型，显式下载；远端和稀疏模式不等它 |
| 结构来源与语法包 | tree-sitter 作 Host 第二结构来源，wasm 版、接口先行、TS/TSX 首刀；常用语言随应用捆绑、其余按需下载（点安装即同意，Host 不自发网络，与本地 embedding 各走各的，D-124）；发布期清单自算 wasm 与查询摘要，运行期只按摘要装（D-125/D-128）；用户自带 wasm 过 ABI 闸门并标未验证（D-123）；语言 ≥ 3 时设置页（D-091） |
| TriviumDB | 优先保留；按实际版本核实无向量/文本查询，具体数据库问题交用户联系作者，不迁移 SQLite |
| Pi 接口缺口 | 钩子与 provider 能力按本机真实版本适配，缺可选能力仅影响对应路径 |
| explore 增强 | 确定性路径默认；已配槽位后按查询需要 intent/judge/修复，失败保留已有结果；反馈优化不另设研究门禁 |
| 缓存保活 | 用户可选的额外请求策略，直接实现实际 provider 路径，生命周期不依赖保活 |
| 批量修改 | 可沿 quickImplement 与相同 mutation 边界实现正则定位批改；按实际使用价值安排，不先造通用工作图 |

## 13. 与其他文档的关系

- [architecture.md](architecture.md)：本文档扩展其第 4 节进程模型（新增 host 服务与 worker→host 请求族）与第 7
  节（harness 是 Piarium 拥有的进程内扩展，不是 Pi 包适配器）。
- [rust-kernel-design.md](rust-kernel-design.md)：阶段 R 的最终资源归属、私有协议、存储与恢复、物化/进程/检索计算及发行性能契约。
- [composable-workbench.md](composable-workbench.md)：profile 对象在此扩展为同时承载 harness 绑定。
- [native-workspace-recovery-design.md](native-workspace-recovery-design.md)：`bash` 的 `process` writer 注册与
  `edit` / `write` 覆盖共存于同一 mutation boundary。
- [security.md](security.md)：知识库内容按工作区数据对待；`webfetch` 复用其私有网段阻断与 cookie opt-in 规则；worker
  不持有 host 凭据。
- [extension-compatibility.md](extension-compatibility.md)：第三方 Pi 扩展不受本契约约束，也不由 harness 管理；可继续通过普通 package
  surface 安装，但 package 存在不会让原生 web 工具或权限 owner 自动让位。

### D-224 补充：集成、级联与查询身份

集成撤销以当前父 authority 为准：virtual parent 在 `VirtualWriteGate` 内做 branch CAS；materialized parent
解析 execution directory 后经该 workspace 的 Documents resource gate，以 after→before 条件恢复。纯 disk、virtual
branch 与 branch→materialized 的撤销都先持久化 `undoing`，再执行条件变更并观察 before；branch→materialized 只有磁盘与
WorkingState branch cache 都同步到 before 后才写 `undone`，启动对账能区分仍是 after、已经 before 与未知状态。父 gate
返回后重新读取 authority；物化目录已回收时，WorkingBranch 重新成为读写真相。

级联准入由 ThreadRegistry 持有。cascade 进入 registry mutation tail 后，目标 Thread 子树的新 create/dispatch/start/restore
按父与祖先的 archived/cascading 状态拒绝；dispatch 准备期间若准入失效，会清理 surface draft。尚未进入 lifecycle 的失败
Thread 可删除，已经被 cascade 接管的 Thread 由该生命周期归档，准备失败路径不得同时删除。session
bindings 是一次启动重建的派生索引，按当前 `thread.activeRunId` 的 Run/session 建立，并按 sessionId 与 threadId 去重；坏
索引可覆盖重建，坏 workspace catalog 不遮蔽健康 catalog，历史 session 不回落为 root owner。

带 `workBranchId` 的默认 merge 只消费当前 settled Run 成功发布的 native resultRevision；遗留 `resultCommit` 只用于没有
WorkingBranch 的导入。新 Run 把上一 revision 记为 `inputRevision` 后立即撤下默认指针；目录 inspect 或 native publish
失败也都会在独立 Git snapshot 前清除默认 revision 并保留
needs-attention/conflict；snapshot 失败也不能让旧 revision 复活。Git baseline 捕获前后重列冻结
`captureScopes` 并比较路径和内容身份；explore pin 接收 effective authorized roots 与同一 signal/deadline，只固定授权范围。
默认新文件 mode 的合法 0 保持不变。上述实现与证据记录在 D-224；3.4、3.4a、3.6 仍按真实桌面重启和付费嵌套 Pi 的未测范围保持 Partial。
