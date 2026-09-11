# Piarium agent harness

Status: design accepted; code profile v1 in delivery — per-capability state is in agent-harness-status.md, not here

Last updated: 2026-09-10

正文为中文。English readers: this document specifies the Piarium-owned agent harness (tools, retrieval,
knowledge store, context and cache contract, verification, profiles) layered on the Pi agent kernel.
Section 4 of [architecture.md](architecture.md) gives the process model this document extends.

本文档是**边界**。哪项能力做到了哪一级（implemented / wired / proven / default-on）看
[agent-harness-status.md](agent-harness-status.md)；未完成的纵切与实施规则看 [agent-harness-plan.md](agent-harness-plan.md)；
每个偏离的理由看 [agent-harness-decisions.md](agent-harness-decisions.md)——日志不是规格，被采纳的决定都已回写到本文。

## 1. 决定

Piarium 不再只是 Pi 的图形外围。产品由两部分组成：**工作台**（已交付：文档权威、编辑器内核、
恢复、多端、可组合 Shell）和 **harness**（本文档）。Pi 继续作为 **agent 内核**：模型/provider 栈、
会话树、包管理、扩展模型、内置工具的默认实现。这是发行版模型——内核来自上游，userland 由
Piarium 拥有、调优、默认提供，且每一块都可以被用户替换。

决定 harness 质量的四件事——工具环境、检索、上下文管理、验证——全部收回到 Piarium 拥有的代码
里。它们的实现放在 Application Host 与 pi-host 进程内扩展中，而不是依赖社区插件的组合。

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

执行者可以为正式目标调整持久格式、数据 authority、协议与默认值，并完成迁移和消费者更新。旧数据在新记录及正文确认可读后切换，
替换完成清理旧实现；不以“再加一个消费者”或完整通用框架作为前置。未授权的不可逆动作和会损失用户数据的取舍仍需用户决定。

默认提供与用户选择分开：已有显式关闭、模型槽位、凭据、持久知识审阅和权限策略保持有效。缺真实服务、缺配置、版本冲突或压缩
覆盖不足时，只处理对应请求并说明原因。fallback 是这些具体情形的运行行为，不是把新架构永久放在旧实现后面的交付策略。
本次修改的是设计政策；当前代码仍然关闭或未接线的能力如实记录在 status，不能靠改文档把它们标成已启用。

## 2. 已确定的决策

以下决定已经固定，改动它们需要先改这张表：

| 主题 | 决定 |
| --- | --- |
| 产品边界 | Piarium = 工作台 + harness；Pi = agent 内核；其他 agent 是能力协商的 bring-your-own runtime |
| harness 形态 | 通用内核 + 领域 profile；不是每个领域一套 harness |
| profile 作用域 | Workbench Profile 属于 surface 展示；Agent Profile 属于执行配置。工具与 system 在同一执行配置世代内冻结；同一持久 Pi session 可经用户操作进入新 Run/配置世代，切工作台布局不改变执行配置（D-063/D-072） |
| 工具注入 | 与 Pi 内置工具**同名覆盖**，不并列；覆盖发生在 pi-host 进程内 |
| 重活归属 | 索引、搜索、shell 监督、诊断、输出存储、知识库全部在 Application Host；pi-host 内只有薄的工具定义与钩子 |
| worker→host 通道 | 类型化协议请求（`@piarium/protocol`），沿 `workspace.mutation.request` 先例；worker 不持有 host 凭据、不直接打 HTTP |
| 检索分层 | 精确匹配用 grep；快速发现和原文获取用 explore；开放事实追踪用 retrieval。文件/结构/索引操作归 Host，较长语义判断归 agent，持久记忆检索归知识库；三种工具不要求逐级失败后才可使用（D-173） |
| 知识库 | 优先保留 TriviumDB 嵌入式，每 host 每 workspace 一个 `.tdb`；Application Host 是唯一写者。TriviumDB 非不可替换依赖，具体问题先交用户联系作者处理；当前不迁移 SQLite、不建双写权威（D-071） |
| embedding | 后端可替换，远程接入独立于重排。`harness.embedding` / `harness.rerank` 是用户所有的配置种类，不是聊天模型槽位。未配置远程时代码语义走本地 MiniLM；配置有效即按同一 vector space 索引与查询。知识库仍可无向量。来源身份、用途、编码文本与维度决定向量复用，后台建设和查询分别调度；不从模型体积推断速度或跨语言质量（D-173/D-190） |
| shell 形态 | PTY（复用终端运行时，后台 shell 即终端 tab）；持久会话 shell 保持 cwd / env / venv；stdin 开放且 harness 永不代写；等默认时长后**自动转后台**而非超时杀死；配套 `get_output` / `write_to_process` / `kill_shell`（Devin CLI 与 Codex `unified_exec` 的共同形状）；Git Bash 为默认解释器但 Windows 原生工具可从中调用 |
| 工具并发 | 沿用 Pi 默认并行；只读工具并行，`edit` / `write` / `apply_patch` 按路径加锁（不同路径并行），`bash` 家族 `executionMode: sequential`；不做 apply model |
| shell 环境 | 解释器按工作区环境选定（原生 Windows → Git Bash，WSL → wsl bash，远程 → 远端 shell），用户可覆盖，模型不按次选；login shell 继承用户工具链；环境变量只改交互与显示，**不设 `CI=1`**，locale 探测不硬编码 |
| web | harness 自做 `webfetch` / `websearch`，参照 `pi-web-access` 能力清单原生实现（来源面板、凭据进 Pi auth、独立浏览器 profile、GitHub 走 octokit）；SSRF 复用 security.md；跨域重定向不跟随；搜索走用户配置的 API provider，无真实 provider 就不注册；桌面端 Electron 离屏渲染 JS；`pi-web-access` 启用时自动让位 |
| 模型槽位 | **每个用模型的能力一个独立槽位**（explore / retrievalAgent / quickImplement / hardImplement / frontend / review / check / reader / suggestions / permissionJudge），用户填、预设只填表；仅 hardImplement 与 review 默认主模型，其余未配不调用主模型。memory 使用活动会话模型，是明确的内置例外；按 8.4 默认提供，保留模式与失败诊断，不增加辅助用量/费用看板，不承诺缓存命中（D-078/D-080） |
| 可关可换 | 每项 harness 能力有独立开关，关掉后行为明确（回 Pi 默认或不注册）；默认不按插件存在与否偷偷改变行为，已定义明确共存契约的例外是 web 工具对 `pi-web-access` 让位，以及原生权限 fallback 对 `pi-permission-system` 让位；设置按**字段所有权**决定用户级与工作区级谁说了算（第 5.10 节），能力可用性不是设置而是 host 注入。memory 模式是实时读取的 user-only 全局默认，活动会话可单独覆盖；其他设置按各自运行契约生效 |
| 编辑格式 | 跟模型家族走：`edit`（str_replace）与 `apply_patch`（Codex 语法）并存，按会话模型启用；两者走同一 mutation boundary |
| OS 沙箱 | Windows 沙箱不在交付计划中（用户选择，D-071）；macOS/Linux 留作后续候选。现有权限与路径边界保持，不把工具限制或 worktree 称为 OS 隔离 |
| 缓存契约 | Zone 0 会话内冻结；Zone 1 只追加、序列化确定；所有前缀失效操作批处理到压缩时刻 |
| 工作状态归属 | 主 agent 对记忆系统零义务，plan/todo 服务自身注意力；keeper 维护记忆，Host 拥有事实与分支版本。缺省 `takeover`，可选 `assist` 或 `off`，活动会话可覆盖全局默认；keeper 只能标记 plan 状态，不能改其结构（D-081） |
| 压缩 | 默认 `takeover` 使用 keeper 块与 Host 事实，逐次检查完整分支、块修订和实际 context entry 覆盖，使用 Pi 安全切点；缺证据只让该次回到 Pi。coverage 是 Host 内存证据，重启后由下一次有效 keeper 更新重建，不冒充持久 checkpoint（D-081） |
| 长任务连续性 | 有覆盖检查和来源说明的上下文恢复 + 向新上下文子 agent 委派；压缩质量需真实验证，不承诺无损。没有自动停下来的 Handoff，Handoff 仅为用户手动命令 |
| 持久知识治理 | agent 只提议（带触发描述），用户审阅接受；自动接受按作用域显式开启；更新用双时态取代不覆盖；召回按触发相关性；保留由用户裁剪 |
| 多 agent | 原生子会话 worker；角色按模型槽位与任务性质定义，dispatch 异步、wait 订阅。并行写者各有独立工作分支，受控工具读写该分支，需要真实路径时按需物化；shared 明示实时共享。嵌套按角色与既有并发背压实现，不加深度配额；兄弟通信经父协调（D-078） |
| 线程 | Thread 是持久工作，ThreadRun 是执行尝试；身份、状态、游标归 Host。内容寻址工作状态与不可变结果独立于物化目录；结果和验证绑定修订，Integration 记录集成与撤销。Git 是基线/物化/导出后端，原生状态按 9.2.5b 迁移。目录在结果已保存、实际写者退出后按边界回收并可原路径重建，预算按配置与真实空间处理（D-078） |
| 观察类工具 | 可能被反复调用的观察工具（`threads` / `wait` / `read_thread` / `get_output` 对运行中 shell / `diagnostics`）**默认返回自上次查看以来的增量**，全量要显式要；游标由 host 按（观察者，对象）持有，压缩时重置；结果只追加不回改（第 8.7 节） |
| 防过度委派 | 不设配额、不做准入规则、**不估成本**（估不准且会把注意力引向算账）；只靠系统提示说明角色与"自己更快更省就自己做"的判断原则，加并发上限默认 12（超出排队）；"派发前询问"是默认不生效的用户设置 |
| 长时间委派 | wait 默认因真实状态变化、用户输入/中止或调用方时限返回，超时是正常结果。缓存保活是用户可选的额外请求，按实际 provider 契约与用量执行，不等待回放许可；生命周期不依赖保活。stalled/looping 由 Host 事件传感器报告；无新轨迹不做记忆整理 |
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
| 权限 | 插件已加载时由 pi-permission-system 独占 tool_call 与 UI，原生门在缺席时覆盖 Harness 工具；Host 只验身份/能力/路径，不弹窗。原生权限按具体能力演进，替换时覆盖实际消费者并保留用户策略，不因“原生”名义缩小已有保护，也不重复形式审批（9.1.2，D-078） |
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

```text
Application Host（packages/web/application-host）
  harness 服务：索引与搜索、shell 监督、LSP 诊断与符号、输出存储、知识库（TriviumDB）
  现有服务被复用：documents、search、terminal、lsp、recovery journal、git
      ^
      | 类型化 worker→host 请求（@piarium/protocol，requestId 关联）
      | 先例：workspace.mutation.request / respond
      v
pi-host session worker（packages/pi-host）
  harness-tools.ts：与 workspace-mutation-journal.ts 并列，进入同一个 customTools 数组
  harness 进程内 ExtensionFactory：与 session-features.ts 同一模式，挂 Pi 钩子
      |
      v
Pi SDK（用户级或内置安装）
```

pi-host 已经通过 `customTools` 同名覆盖了 Pi 的 `write` / `edit`（恢复日志的 mutation boundary），
并以进程内 `ExtensionFactory` 挂载 `before_agent_start` 等钩子。harness 沿用这两个机制，不引入新的
进程边界、Pi 包或 MCP 跳板。ACP agent 的 MCP 门面是后续交付，它前面的 host 服务与本文档相同。

### 4.1 Pi 钩子到 harness 机制的映射

以下映射对照本检出中 Pi SDK 的扩展事件类型核实：

| harness 机制 | Pi 事件 / API | 用法 |
| --- | --- | --- |
| 工具覆盖 | `customTools` on session create | 同名 `ToolDefinition` 覆盖 `read` / `bash` / `edit` / `write` / `grep`；`read` 只在 Host 声明固定来源服务时覆盖，否则保留 Pi 原生实现；新增 `apply_patch`、`get_output`、`write_to_process`、`kill_shell`、`diagnostics`、`todo`、`dispatch`、`wait`、`webfetch`、`websearch`；`executionMode` 按第 5.9 节声明 |
| Zone 2 尾部追加 | `before_agent_start` → 返回 `message` | 本轮轨迹增量、记忆指针、计划复述作为一条自定义消息追加；**不**通过返回 `systemPrompt` 注入 |
| post-tool 反馈注入 | `tool_result` → 替换 `content` / `details` | 把诊断附加到 edit/write 结果；验证器的统一通道 |
| 工具门控 | `tool_call` → `block` | profile 的权限默认值；等价于"mask 不删" |
| 接管压缩 | `session_before_compact` → 返回 `compaction` | 用当前 memory blocks + host 事实替换切除范围，保留最近 K 步，零模型调用 |
| 主 agent 意图 | `customTools`：`todo`（第 5.6 节） | 服务主 agent 自身注意力；主 agent 无块编辑与标记工具，对记忆系统零义务 |
| 记忆 agent 触发事件 | host 侧：`tool_execution_end`（测试/构建结束、退出码翻转）、用户插话或编辑计划面板、子 agent 返回、用户"记住这个" | 只决定记忆 agent 何时运行，不携带重要性判断；用户标记立即触发 |
| 记忆 agent | `context` 捕获可用消息，`turn_end` 检查调度条件与事件 | 按有效记忆设置使用活动模型，仅输出 `memory_edit`；Host 校验写块，不连接文件/shell 执行器；新默认见 8.4，实际缓存与用量归因 |
| 兜底 | 压缩时块缺失或过期 | 同步有界地运行一次记忆 agent；不在正常路径上 |
| 压缩后恢复 | `session_compact` | 重新注入最近文件与技能指针（有预算） |
| 缓存断点 | `before_provider_request`（如需） | pi-ai 的 Anthropic provider 已在 system、tools、最后一条 user 消息设 `cache_control`；仅在 provider 缺失时补 |
| 轨迹采集 | `tool_execution_end`、`turn_end`、host 侧文档 / 终端 / LSP 事件 | 写入知识库，不进上下文 |
| 用户 `!cmd` | `user_bash` → 自定义 `operations` | 与 `bash` 工具共享同一 shell 监督器 |

### 4.2 已修复的前缀漂移与持续契约

`session-features.ts` 曾在 before_agent_start 把变化的目标 token 计数写进 systemPrompt；现已按 status 1.2 修复。
动态目标与运行状态使用尾部消息，不回改静态前缀。修改相关装配时运行现有 Zone 0 契约测试，不把已修缺陷重新列为前置任务。

## 5. 工具集（code profile v1）

### 5.0 清单

| 工具 | 来源 | 并发 | 一句话 |
| --- | --- | --- | --- |
| `bash` | 覆盖 Pi | 独占（`executionMode: sequential`） | PTY、持久会话 shell、超时转后台不杀 |
| `grep` | 覆盖 Pi | 并行 | rg 搜索、固定 surface 叠加、分组排序与有界结果 |
| `edit` / `write` | 覆盖 Pi | 不同路径并行，同路径串行 | 参数不变，附加新引入的诊断 |
| `apply_patch` | 新增 | 同上 | Codex 语法多文件编辑，按模型家族启用 |
| `read` / `find` / `ls` | 同名适配 | 并行 | `read` 保留 Pi 原生分页、截断与图片；find/ls 取得 Host 的固定 dirty path/虚拟祖先并经 Pi 原生定义合并磁盘结果，过期相关来源不可回退 |
| `get_output` / `write_to_process` / `kill_shell` | 新增 | 读并行，写与杀独占 | 后台 shell 与输出句柄；对运行中 shell 默认返回上次读取之后的增量（第 5.5 节） |
| `diagnostics` | 新增 | 并行 | `pending` 后按需查 |
| `todo` | 新增 | 串行 | 主 agent 自己的计划（第 5.6 节） |
| `explore(question, anchors?, paths?, limit?)` | 原生，接通后默认注册 | 并行 | 用主 agent 的问题与已知锚点做确定性召回、结构切片与互补打包，返回带版本的代码原文；`limit` 只管输出条数；模型机制按已配置槽位使用（第 5.7、6.1 节，D-090） |
| `dispatch` / `threads` / `wait` / `send` / `read_thread` / `merge` / `kill` | 新增 | `dispatch` / `threads` / `read_thread` 并行、`wait` 独占当前步、`send` / `merge` / `kill` 串行 | 开一条线程交给团队中的一个角色（异步）、看增量状态、订阅等待、给线程传话、读它的记忆块或报告、把线程 worktree 三方合并回来、终止（第 5.7、9.2、9.3 节） |
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

阈值、超时、并行度均为默认值，可由设置覆盖；本文档不设硬上限。默认值偏向可见性而非节省：在前缀缓存下，
一个大的工具结果只在进入时支付一次写缓存成本，之后每轮按 0.1× 计费；真正的约束是窗口耗尽，那由句柄与压缩
负责，不由截断阈值负责。参照：Claude Code 的 Bash 默认截断 30,000 字符、Grep 落盘阈值 20K 字符、Grep 默认
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

参数：`command`、`cwd?`（工作区相对路径，默认沿用上一次）、`wait_ms?`（默认 60 s）。**没有超时杀死**：命令在
`wait_ms` 内结束则同步返回；否则**自动转后台**，立即返回"已等待 N 秒，仍在运行，shell id X"与截至此刻的输出，
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
- **stdin 开着，harness 永不代写。** 等输入的程序会停在提示上；`wait_ms` 到了它转后台，模型在输出里看到提示文本，
  用 `write_to_process` 回答或 `kill_shell` 放弃。Pi 内置 bash 的 stdin 是 ignore，与 `write_to_process` 不相容，
  因此这里不沿用。
- **持久会话 shell，以 login shell 启动。** 一个 PTY shell 跑所有前台命令，先 source 用户的 `.bash_profile` /
  `.bashrc`——nvm、pyenv、conda、自定义 PATH 全部就位，agent 用的就是用户平时的环境（Claude Code 与 Codex 均如此）。
  cwd、环境变量、`source .venv/bin/activate`、`nvm use` 跨调用保持；Pi 内置 bash 每次 `spawn` 则不保持，`source
  venv` 后 `pytest` 报"not found"正是要消灭的那类工具错误。命令以哨兵标记包裹以分隔输出并捕获退出码。前台命令超过
  `wait_ms` 时，**它所在的 shell 整个转为后台 shell**（拿到 id），host 起一个新的会话 shell 继承 cwd 服务后续前台
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
- 声明 `executionMode: "sequential"`：同一批工具调用中有 `bash` 时整批串行（Pi 的批次语义），因为它可以触碰任何路径。
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

**输出压缩：按命令整理默认展示（3.17，D-160 / D-197 / D-199）。** vitest / tsc / eslint / git 识别失败块、定位与统计，
只收起明确的成功或重复噪声；未知内容保留。常见 pretty/plain 格式、失败块续文与交互提示都属于可读正文，不能因为看见统计行就丢弃其他行。
未识别命令或无法可靠区分来源的混合输出走通用首尾展示；工具名出现在参数中不等于正在执行该工具。目标形状仍是五层：**命令专用解析器**（`vitest` / `jest`、`tsc`、
`eslint` / `biome`、`git`、`cargo`、`pytest` 等，从可靠的执行位置识别命令，用已知格式组织统计与失败块）→
**输出形状嗅探**（经 `npm test` / `make check` 包裹时按输出本身识别）→ **包管理器通配**（`npm` / `pnpm` / `bun` 头 token）→
**声明式规则**（用户/项目可加的"删这些行、截这些、保留这些"，覆盖长尾）→ **通用兜底**（去 ANSI、连续去重、首尾切）。
全文照旧进 OutputStore，句柄不变。沿用 32 KiB 可见预算，超出时标明省略并提供原文读取；单个大块也要留下可用的首尾，不能只返回省略提示。
分片展示只代表本次观察，退出码只取进程事实。获得 Host 整理结果后免于二次裁切；旧 Host 的未整理结果保留通用截断，显式分页保持原始 UTF-8 与字节游标。
**不用小模型做总结替代**：规则整理不需要额外模型调用，但解析器也可能漏识别格式，因此以保留未知内容为前提。模型总结**可以作为附加**放在非结构化输出上
（"这是头、这是尾、这是模型认为重要的几行、全文在句柄"），减少拉取的同时不让 agent 误以为看到了全部。先做的四个（vitest、tsc、eslint、git）已按 D-197 进入公开 `bash` 与增量 `get_output`。
其余命令与未识别输出仍走通用展示；包管理器通配、声明式规则和附加模型总结尚未接。

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

当前 edit/write 仍是 Pi 工具直接写盘并由编辑器 reconcile。目标统一到带版本的执行视图：实体目录保留 mutation journal，虚拟分支
写本分支 delta，草稿目标经 surface 的 Document Registry 修改。参数保持同名先验，路径、版本与来源在内部传递；冲突按文件处理，
不因存在任意脏缓冲就禁用整个工具。对应工作随 9.2.5b 的分支与窗口读取适配实施，不等待记忆效果实验。

**编辑格式跟模型家族走。** Codex 系模型按 `apply_patch` 语法训练（`*** Begin Patch` / `*** Update File:` /
`@@` hunk / `*** End Patch`，一次可改多文件，仅相对路径）；Claude 系按 str_replace 训练。Devin CLI 两者并存，
Cursor 为每个前沿模型单独调工具。Piarium 支持任意 provider，因此提供 `apply_patch` 工具，由 profile 按会话模型
家族启用其一或两者；两者共用同一 mutation boundary 与诊断附加，恢复日志按 patch 中声明的路径逐文件记录。

### 5.5 `get_output`、`write_to_process`、`kill_shell`、`diagnostics`

`get_output(id, offset?, length?)` 统一读取两类东西：已完成输出的句柄（`out_x`）与仍在后台运行的 shell（`bash`
返回的 shell id）。没有它句柄是死的。`write_to_process(id, text)` 与 `kill_shell(id)` 服务后台 shell。
`diagnostics(path?)` 供 `pending` 态后按需查询。

**反复读同一个对象时默认返回增量**（第 8.7 节）。对运行中的 shell，不带 `offset` 的 `get_output` 返回上次读取之后的新
输出，开头一行引头 `[shell sh_3 · +2.1 KB since last read (40 s ago) · still running]`；没有新输出就一行"无新输出，仍在
运行，最近输出 40 秒前"。显式 `offset` / `length` 才是随机访问，用于回看。`diagnostics` 对同一路径的重复查询只报新增与
消失的条目。游标由 host 按（会话，对象）保存，不占模型的上下文，压缩后第一次读取回到全量。已完成的输出句柄是静态的，
没有增量语义，仍按 `offset` / `length` 分页。

### 5.6 `todo`（新增，主 agent 自己的计划）

主 agent 对记忆系统零义务（第 8.4.1 节），但它可以为**自己的注意力**维护一份计划。`todo({ items: [{ text, status }],
confidence? })`——整表替换语义，Claude Code TodoWrite 的形状，模型训练过。写入知识库的 `plan` 块（主 agent 是该块唯一
的结构所有者，记忆 agent 只能标条目状态），显示在计划面板，Zone 2 复述。`confidence` 可选：主 agent 声明对计划的信心，
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

`dispatch(role, task, { scope?: paths })` 把一个任务交给第 9.2.2 节角色目录中的一个成员：**开一条线程**（第 9.3 节），
**异步**，立即返回线程 id；父继续工作。系统提示把角色呈现为团队成员而非工具（第 9.2.4 节）。每个角色有自己的结果
schema：`review` 返回带严重度的发现列表，`check` 返回通过 / 失败与证据，实现类角色返回改动文件、结论、未解决项、置信度、
相对简报的偏离。中间过程留在线程自己的上下文里，不进入主上下文。

父 agent 与线程的交互是"看仪表盘、必要时传话"，不是对话（第 9.3.6 节）：`threads(ids?)` 非阻塞返回一张增量状态表；
`wait(ids?, timeout_ms?)` 是同一张表的阻塞版本，任一线程状态变化或超时即返回，**超时是正常结果**，默认只受 Host 请求时限约束，
不按缓存 TTL 唤醒（第 9.2.6 节）；`read_thread(id, what?)` 默认读线程的记忆块（progress /
decisions / errors），其次报告，最后才是转录切片（走句柄）；send 给线程传话；kill 终止执行并保留工作结果，目录按 9.3.4 回收。
merge 集成选定的不可变子结果，返回应用、冲突和恢复状态；文本冲突保留标记，非文本提供父/子版本选择（9.2.5b）。
未配置对应模型槽位的角色不注册，模型看不见。

### 5.8 `webfetch` / `websearch`（新增）

web 能力由 harness 自己做，不交给插件。参照 Claude Code 的做法与教训：其 WebFetch 本地抓取、同域重定向自动跟随、
**跨域重定向不跟随而返回元数据要求显式再调**（防 SSRF 与外泄）、10 MB 上限、HTML→Markdown 后截断、15 分钟缓存，
并把页面交给便宜模型（Haiku）带问题阅读，主上下文只收回答；其 WebSearch 走 provider 服务端搜索但包在 Opus 子对话里
（每千次约 145 美元，反面教材）。Codex 内置搜索只返回摘要片段。业界共同模式是**先搜后抓**。

**参考 `pi-web-access`（0.24）的能力清单，原生地做得更好。** 它有：多搜索 provider 路由（自动 / 指定 / 并发 / 全
provider / 有序回退）、完整 provider 与凭据体系（含可执行凭据源、API 网关）、Curator（独立本地 HTTP server 做结果
整理与 summary-review，带 bind 与远程暴露警告）、Chromium cookie opt-in、内容控制（摘要与内联长度、GitHub / 视频 /
图片 / PDF 开关与限制、认证抓取 profile）、SSRF 策略与例外、域名策略、持久化结果浏览。Piarium 有 host 与工作台，因此：
Curator 变成工作台的"来源"面板（可审阅、钉住、删除，走已有认证通道，不再有独立 server 与 token-in-URL 风险）；
凭据进 Pi AuthStorage 或系统钥匙串，绝不落明文 JSON；持久化结果进知识库（URL、抓取时间、提取文本；压缩时丢正文
留 URL）；认证抓取用 Electron 的**独立 Piarium 浏览器 profile**，不碰用户日常浏览器的 cookie；GitHub 走 `@octokit`
（host 已有依赖）取 issue / PR / 文件而非抓 HTML；有序回退与并发查询原生实现、配置在 Settings；对话框与后续消息变成
工具结果与 Zone 2。视频转录与图片描述 v1 不做。

**`webfetch(url, prompt?)`**：host 抓取，SSRF 策略复用 [security.md](security.md) 已有规则——私有与保留网段默认阻断、
浏览器 cookie 默认不带、显式 opt-in；工作区级域名允许 / 阻断列表；同域重定向自动跟随，跨域重定向返回元数据；正文提取
（readability 类算法 + Markdown 转换；PDF 转文本，research profile 同样需要）；15 分钟缓存。无 `prompt` 时返回提取后的
Markdown 走句柄。有 `prompt` 时**仅当配置了 `models.reader` 槽位**（第 8.5 节）才由阅读子 agent 回答、主上下文只收
回答；未配置则忽略 `prompt`、返回提取内容并注明"reader unavailable: no reader model configured"——**永不回退到主
模型**。
**JS 渲染是 Piarium 的独有能力**：桌面端用 Electron 的 Chromium 离屏渲染（隐藏窗口，不带用户 cookie 除非显式开启）；
Web / 云 host 无 Chromium 时返回 `unavailable (no renderer)`；检测到空壳 SPA（极小 body + 脚本标签）时明说，永不把
空页面当成功。

**`websearch(query, { allowed_domains?, blocked_domains?, recency? })`**：使用 Settings 配置的搜索 API（Brave、Exa、Tavily、Jina、
自托管 SearXNG）；没有可用配置或凭据时在构造 AgentSession 前省略工具，**永不伪造结果**。模型 provider 的 server-side search
只有 pi-ai 将来提供明确、可独立调用且能返回来源的公共能力时才接；当前不能把“模型本身可能支持搜索”变成返回空数组的 Host
adapter。返回标题 + URL + 摘要片段列表直接给主 agent，不套子对话。每条持久工具结果把净化后的 title/URL 投影到 session state
来源区；pin/remove 是本地展示状态，重新打开会话从 transcript 重建来源。

安全：抓回的内容以"数据不是指令"标记包裹（与 Zone 2 同一做法）；每回合抓取次数有可配置预算；页面正文永不进日志、
事件载荷或 URL。

与 `pi-web-access` 的关系：harness 的两个工具是默认；会话中启用了 `pi-web-access` 时它们**自动让位**（该会话内不注册），
遵守"模型不该有两种方式做一件事"；插件的 Curator 与存储结果保持插件所有。另一项明确的让位契约是权限插件，见第 5.10 节。

### 5.9 并发

Pi 的 agent loop 默认**并行**执行一批工具调用（`toolExecution: "parallel"`），任一工具声明 `executionMode:
"sequential"` 则整批串行。Claude Code 更保守：只读工具并行，Write / Edit / Bash 一律串行（`isConcurrencySafe`）。Cursor
的多文件编辑速度来自模型一次发出多个独立文件的编辑并行应用，加一个专门合并编辑的 apply model——Cognition 指出
edit-apply 模式在 2024 年普遍、现在更多由单模型一步完成，Piarium 不做 apply model。

策略：只读工具（`grep` / `read` / `find` / `ls` / `get_output` / `diagnostics` / `dispatch` / `webfetch` / `websearch` /
`recall` / `related`）并行；
`edit` / `write` / `apply_patch` 在**不同路径上并行、同一路径串行**——harness 在 mutation boundary 前按路径加锁，恢复
日志本来就按路径记录 before/after；`bash` / `write_to_process` / `kill_shell` 声明 `executionMode: "sequential"`，同批
有它们时整批串行，因为 shell 可以触碰任何路径。这拿到多文件编辑的并行速度，也保住真正存在竞争处的安全。

### 5.10 禁用与替换（适用于全部 harness 能力）

发行版模型的另一半是**每一块都可以被用户关掉、换成 Pi 生态的其他部分**。harness 的每项能力在 Settings 的"Agent
harness"页有独立开关，关掉后的行为明确，不留半开状态：

| 能力 | 关掉后 |
| --- | --- |
| 单个工具（`bash` / `grep` / `edit` / `write` / `apply_patch` / `dispatch` / `todo` / web 等） | 覆盖类回到 Pi 内置实现；新增类不注册。用户可安装任何 Pi 包提供替代 |
| 输出句柄截断 | 工具结果原样进入上下文（Pi 默认行为） |
| Zone 2 组装 | 不追加简报；`before_agent_start` 不返回 `message` |
| 记忆 agent | 不维护块；压缩回到下一行的行为 |
| 接管压缩 | Pi 默认压缩（同步摘要） |
| 知识库 | 不写入 event / block；`recall` / `related` 不注册；已有 `.tdb` 保留不删 |
| 子 agent 团队 / 单个角色 | `dispatch` 不注册或该角色从团队移除，主 agent 自己做；槽位未配置的角色本就不存在 |
| `explore` 与模型选择 | 工具本身有独立开关；models.explore 服务局部语义决策，清空时无该模型调用并保留算法/向量材料。嵌入/重排绑定分别见第 8.5 节 |
| Piarium 权限 fallback | 插件存在时本来就由 `pi-permission-system` 持有门控；插件缺席且关闭 fallback 时 UI 明示该会话没有 Piarium 提供的 Harness 工具确认 |

规则：

- **让位必须有明确契约，不能靠包名猜。** `pi-web-access` 启用时 harness 的 `webfetch` / `websearch` 不注册，因为两组同功能
  工具会让模型有两种入口；`pi-permission-system` 则通过公开的 session-keyed service 宣告它确实持有本会话权限门，原生
  fallback 才让位。记忆、搜索等没有同等运行时契约的插件仍由用户选择关哪边。
- 设置**按字段决定所有权**（D-031），不是整份设置一条规则；工作区级只在项目已 trusted 时生效（复用 Pi 的 project trust）：

  | 字段 | 所有权与合并 |
  | --- | --- |
  | 模型槽位 `models.*`、provider 凭据 | user-only |
  | 记忆模式与启用选择（旧键 `memory.shadowMode`） | user-only；产品新默认按 8.4，仓库无权覆盖用户的明确选择 |
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
| `retrieval` 角色 | 需要较长阅读与语义判断的开放事实问题、跨文件机制追踪 | 有引用的事实回答、支撑材料与未确认部分 |

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
不是整个工作区的强一致快照。捕获失败的脏路径不取磁盘冒充；无 surface 的 headless 请求使用磁盘。观察到写入后，按 D-088/D-089
终结该路径的旧草稿读取权威；其余路径仍沿本轮输入来源。检索、read/grep/find/ls、语言导航与线程基线沿同一规则。

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

嵌入接口区分 query/document 用途、有效长度、取消、批次对应与实际维度。现有本地 MiniLM 保持为未配置远程时的后端；远程嵌入
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

**输出与验证。** 来源结果沿已有 not-requested / ready / empty / unavailable / failed / stale 等状态，超时/取消分别表达；
输出以原文、引用和影响下一步的缺口为主。OutputStore 是经鉴权的会话局部临时存储，保存实际打包材料和未展示候选引用；
不暗示所有未读文件正文都已在其中。只有能证明同一 revision 的相关 span 仍在主模型实际输入中时才可用指针省略正文，未知就返回原文。

验证针对实际问题：纯语义命中不能被来源等级挡住；选择依据确实出现在输出；来源等待/取消不拖垮其他结果；切块没有隐藏截断；
修改与重启不混用修订/空间。既有观察工具区分冷库首个有用结果、热查询、编辑更新和完整建设。十问作为回归材料，按需要加入
真实新问题，不以独立评测集或统计不劣证明作为接线与默认使用前置。真实模型观察同时看首轮关键原文、后续纯定位往返和整体
等待；按实际问题分别启用查询计划、材料判断或补查帮助归因，不要求全组合实验。工具描述随消费者更新，不能继续声称自然语言
只按字面匹配。不自动从后续 read/edit 学相关性，也不新增辅助费用/Token 看板。

### 6.2 第二层：这段代码和什么有关

由知识库拥有。节点是文件与符号，边是 `defines` / `imports` / `connects` / `associates`（tree-sitter 写进同一张图；
`references` 与解析后的跨文件 `calls` 仍未接）。这不是 Aider repo map + PageRank：多跳扩展和 rank 分数都还没做，
也不在本刀范围。早期 TQL 草稿（`EXPAND [:calls|references*1..2]` + `pagerank`）留作远期形状，不是当前契约。

图把名字、路径和连接字面量变成可追踪的关系，提供三类定位材料：

1. **定义位置。** 目录知道 `foo` 在哪儿定义、是什么 kind；一般文本命中只说明哪里提到了它。
2. **连线配对。** rg 给你散落的 N 行；图知道这个字面量的一端是 `register`、另一端是 `request`。
3. **反向依赖。** 「谁 import 了这个文件」不需要查询词。

这些关系可能带来词法未取得的入口，也可能与现有候选重合。比如连线的注册端没有进入 rg 候选、或需要读取未含问题词的调用方；
收益由实际查询决定，不预设“只有一种边增加召回”。导航与开放候选的读取规则见第 6.1 节，图来源本身没有永久排名优势。

当前图：Documents 写后事件 + 冷扫描把磁盘正文写进 `file → defines → symbol` 和 `file → imports|connects|associates → link`
（绑 `documentRevision`，共用 generation；D-087/D-105）。LSP 暂不可用时保留最后图，权威空结果才清旧符号。
确认连接与同名字符串关联候选分开，候选必须真是同名（D-106/D-109）。冷目录覆盖带 `importQuery` 的语言
（TS/TSX/JS/JSX，D-115）；纯 Python 仓库对目录来说是 `empty`，不是坏了。轮廓收录模块级/类级值绑定（D-113）；
边查询被阻塞时照写 defines 并记 `linksIncomplete`（D-111）。

**读者。** `explore.search` 把图当第二路路径候选（定义 / 连线另一端 / 反向 import，D-136，取代 D-108 的「不扩候选池」），
并继续用 `details.relations` 注解已经选中的摘录（D-112）。`related` 是真实注册的工具：对一个路径或符号名回答它定义了什么、
import 了什么、谁 import 了它、它在哪些连线上以及另一端在哪。每一项都能表达「没有」和「不完整」（`linksIncomplete`、
specifier 未解析、目录不覆盖该语言）。`related` **不是**更差的 `lsp.references`：references 精确回答「谁引用这个符号」，
需要语言服务器；related 回答文件级 import 拓扑和连线端点，不需要语言服务器在跑。

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

`references`、解析后的跨文件 `calls` 与 PageRank 仍未接，不能通过对每个 symbol 无界请求 references 来伪装完成。
仓库级词法索引仍等观察到「找不到入口」再定。

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

`block` 是 agent 拥有的会话工作状态（第 8.4.1 节），随会话生命周期。`knowledge` 是跨会话的持久条目，取代此前的
`decision` 作为唯一持久类型；会话内的"决定"先只是 `plan` / `decisions` 块里的文本，晋升为 `knowledge` 走第 7.2.2 节
的审阅流程。

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

- **agent 不直接写持久层，只提议。** 在自然时刻——用户纠正了 agent、用户表达了"以后都这样"、回合结束——harness 从
  对话与 `decisions` 块生成 `knowledge` 建议，`status: suggested`，每条必须带**触发描述**（什么时候该想起它，语义
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
未配置时只保留用户标记和 keeper 路径，不借用主模型。未接受、已驳回或已被取代的条目不进入公开 recall。

Settings 目录与会话审阅托盘的写操作携带用户打开条目时的 content、trigger、status 与 invalidAt，store 在同一写队列内核对完整期望修订、scope 和当前状态后
再修改；工作区或作用域切换会使旧选择和迟到响应失效。模型提议的 Host 入口只接受正文与触发描述，workspace 与 `user-message`
来源取自已认证 actor，不能由 worker 自报。规范化正文的历史去重和插入也在同一个写队列操作内完成，包含 dismissed/retired，
所以并发相同提议不会生成两个节点或复活旧建议。用户标记、memory decision 与模型提议都读取同一会话的有效 auto-accept 设置；
trusted project 只能调整 workspace scope，设置不可读时保留 suggested 而不自动接受（D-211）。

### 7.3 写入者

- Document Registry 在成功提交 `write/move/delete` 后发布带已校验 writer owner 的结构化事件；观察失败不反噬文件提交。
  同 workspace 的活动会话各保留自己的 event，agent writer 的事件留作轨迹但不进入 Zone 2。LSP 诊断只有紧跟用户编辑的
  error/warning 才作为“新诊断”投影，避免复述 agent 已在工具结果中见过的诊断。Git status 已复用现有刷新边界接入；user
  terminal 仍需完整 shell integration 才能可靠记录逐命令退出。
  `kind: edit` 的 event 最终引用恢复日志中已存在的 before/after 内容对象，不再复制一份 diff；恢复日志是唯一的逐路径编辑真相源。
- 记忆 agent 维护的 `block`（第 8.4.1 节），每次改动记录来源与游标；主 agent 的 `plan` / `todo` 亦为 `block`。回合
  结束时块快照挂在该回合的 `event` 上。`session_before_compact` 只读块与库，不调模型。
- `knowledge` 建议（第 7.2.2 节）：在用户纠正、"以后都这样"、用户"记住这个"、回合结束等时刻由 harness 生成，
  `status: suggested`，经审阅才成为持久条目。
- 用户的"记住这个"标记作为 `event` 写入，供记忆 agent 读取与审计。host 不生成任何重要性权重。
- profile 自己的采集器（research profile 的文献抓取等）。

### 7.4 读取者

`recall(query, k?)`（`search_hybrid`：AC + BM25 + 向量，再 SA-PPR 扩散；`knowledge` 按触发描述匹配）、`related`
（第 6.2 节）、Zone 2 组装（当前有效 `knowledge` 的 top-k 指针、块复述）、压缩替换块（块 + 事实记录）、UI 计划面板与
知识审阅托盘、research profile 的图查询。

### 7.5 已知约束与要求

当前钉住 **0.8.6**（D-141）。下面按「已在该版本核实」与「历史记录」区分；向作者报告数据库本身的类型处理、检索语义和能力边界，
不要求数据库适配 Piarium 的领域模型。keeper 漏传版本、分支归属及代码分词策略由 Piarium 自己负责。

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
- **native 模块**：`.node` 需按 Electron ABI 构建。Piarium 已维护 `better-sqlite3` / `node-pty` /
  `sherpa-onnx-node` 的 asar unpack 与重建流水线，本项复用同一条；TriviumDB 已发布六平台预编译。
- **两个 host 同路径**：按 `hostId` 隔离；`serve` 复用运行中的桌面 host（第 7.1 节），因此正常情况下同一机器只有一个
  host。
- **数据安全**：知识库含文件内容与命令文本，按工作区数据对待——不进日志、不进事件载荷、不进 URL，与
  documents 模块同规。

## 8. 上下文与缓存契约

所有主流 provider 的提示缓存是前缀缓存：命中要求 token 序列从头逐字节一致。一个 100K 上下文，若每轮在系统
提示注入 2K 变化内容，成本 ≈ 100K × 1.0；若追加在尾部，成本 ≈ 98K × 0.1 + 2K × 1.25 ≈ 12K。差约 8 倍，TTFT
差距同量级。因此上下文管理的核心是把"计算知识"与"进入上下文"在**时间上分开**。

### 8.1 三个区、两个断点

```text
Zone 0  会话内冻结
        profile 系统提示 · 工具定义（mask 不删）· 项目 knowledge（会话开始载入一次）
        ── 缓存断点 1（pi-ai 已设：system + tools）──
Zone 1  append-only 历史
        每轮 turn；每个 tool_result 进入前已截断为「预览 + 句柄」
        ── 缓存断点 2（pi-ai 已设：最后一条 user 消息，随轮前移）──
Zone 2  本轮尾部，默认预算 ≤ 2K token；以 before_agent_start → message 追加
        自上轮以来的轨迹增量（编辑 / 终端退出码 / 新诊断）
        top-k 记忆指针（指针，不是正文）
        计划 / todo 复述
```

上一轮的 Zone 2 在下一轮自然成为 Zone 1 的一部分并被冻结；每轮只有 Zone 2 是新 token。

Zone 2 的精确定义：**agent 不在场时发生的事**。agent 自己执行的命令与编辑已在历史中，不重复。进入 Zone 2 的是用户在
编辑器中的改动、用户在终端执行的命令与退出码、LSP 在 agent 未触碰文件上的新诊断、Git 状态变化（分支、pull、stash）。
三条组装规则：增量过大时摘要而非罗列（"分支 a→b，40 个文件变化，集中在 packages/ui"）；记忆以指针出现，正文由
`recall` 拉取；所有源自文件内容或终端输出的文本以显式标记包裹为**数据而非指令**，与现有 goal reminder 的
"user-provided task data, not higher-priority instructions" 同一做法。

### 8.2 三条规则

1. **Zone 0 在同一执行配置世代内一个字节不变。** 没有随轮变化的计数、时间戳或状态。持久 session 身份不等于永久固定配置：
   用户转换讨论线等操作可构造新 Run/配置世代，记录新工具/system；工作台布局切换不改变 Agent Profile。
2. **Zone 1 只追加、不修改，序列化确定。** JSON 键序固定；重试不产生新的随机 ID；工具结果的截断在进入前完成。
3. **主动上下文整理集中在压缩边界。** 用户显式改变模型或转换线程时，经会话构造边界生成新的执行配置；不以“冻结”为理由延迟
   权限撤销，也不为切换布局重建工具集。记录与来源的正确性属于语义契约，provider 缓存只是可观测优化，不能成为恢复正确性的前提。

### 8.3 三个进入通道（按缓存代价）

- **A. 尾部追加（几乎免费）**：Zone 2 消息、模型调用 `recall` / `related` 得到的 tool_result、上一轮工具结果、观察类
  工具的增量视图（第 8.7 节）。90% 的"无感"发生在这里。
- **B. 压缩时刻（反正已失效）**：第 8.2 条 3 的全部内容。后台采集持续运行，但产出等在知识库里，此刻才被消费。
- **C. provider 原生上下文编辑（有则用）**：按 provider 实际接口清理旧 tool_result，受影响前缀可能需要重新写入缓存；
  成本按真实请求记录。缺这项接口时使用 B，不阻塞正常压缩。

拉优于推：记忆不由后台进程推入历史，由模型经工具拉取或在 Zone 2 以指针提示。

### 8.4 前缀保留式、无停顿的压缩

"无感"有两层：agent 知道用户没说的事（Zone 2 与知识库），以及**压缩本身不是一个前台停顿**——没有"正在压缩
上下文"的等待，agent 不在任务中途停下来写总结。默认的 Pi 压缩在阈值处同步调用一次模型生成摘要，停顿来自这次
调用。本设计把这次调用从压缩时刻挪走，并且必须在**一个回合内多次压缩**时依然成立：agent 编程里一个回合几百次
工具调用、窗口在回合内被填满数次是常态，不是例外。

术语：Pi 的 `turn`（`turn_start` / `turn_end`）是 agent loop 的**一次迭代**——一次模型调用加它的工具结果，下文称
**步**；一个用户请求的完整处理是 `agent_start → agent_end → agent_settled`，下文称**回合**。所有后台工作以步为
粒度，不等回合结束。

#### 8.4.1 三种状态，三个所有者

harness **不强加叙述 schema**，也**不让主 agent 分心整理记忆**。会话内需要跨压缩存活的状态分三类，所有者不同：

**主 agent 只拥有意图。** 可选的 `plan` / `todo`：主 agent 认为任务值得先计划时写一份（profile 的系统提示建议"非
平凡任务先读代码再写计划并给出置信度"；用户可用 plan mode 强制；harness **不检查其存在**——Devin 的先计划是它作为
"交出去就走开"产品的正确选择，不是通用规则）。计划置信度只作信息；审批遵循用户显式模式，不由分数触发默认打断。
**除此之外主 agent 对记忆系统零义务**：没有块编辑工具，没有标记工具，系统提示中不出现任何"请维护记忆"的措辞，
harness 也不因块或计划陈旧而提醒它。理由：注意力税不在一次工具调用上，而在**每一步都要判断要不要调用**上；一个"记得
为记忆系统做 X"的常驻义务会一直占据推理。Letta 的主 agent 没有任何记忆工具；Claude Code 的主 agent 不参与 Session
Memory，且 TodoWrite 已默认关闭；Cognition 的压缩模型完全从轨迹推断关键信息。可选的 `plan` / `todo` 之所以保留，是
因为它服务于主 agent **自己**的注意力（Manus 复述的价值在写的人身上），不是为记忆系统写的。

主 agent 的判断不需要显式标记就已经可读：它在文本里自然会写"重要 / 注意 / 决定用 X 因为 Y / 这条路不行"，反复编辑
的文件、失败后通过的命令、放弃的路径也可能在轨迹里。记忆 agent 从实际可用的轨迹判断重要性，不能假定截断或压缩后的输入仍完整。
harness 不向它提供任何启发式权重或"重要性"标注：Letta 的睡眠时 agent、Claude Code 的 Session Memory 子 agent、
Cognition 的压缩模型都只读轨迹本身，没有一个依赖手写检测器；给一个有判断力的模型附上机械权重只会把它的注意力从
"发生了什么"引向"哪里被打了标"。记忆 agent 的输入只有三样：标明来源区间与缺口的可用轨迹、host 事实（文件、命令、诊断——中性数据，不是
权重）、当前块。

机械信号只用于回答"什么时候跑"，永不回答"什么重要"（第 8.4.1 节触发部分）。

**标记权属于用户。** 用户标记对 agent 免费，也不是启发式：UI 上任何消息、工具结果或块条目都可"记住这个"，作为明确的
用户意图交给记忆 agent 并立即触发它；知识建议流程本来就由用户纠正与"以后都这样"触发（Devin 的建议同样源自用户反馈）。
用户是唯一有资格说"这个重要"而不付注意力税的一方。

若将来计数器显示记忆 agent 经常漏掉用户后来不得不重讲的事，可实验一个**无参数、系统提示不推、工具列表中靠渐进披露
隐藏**的 `remember(text)`。v1 不加——工具列表里的每一项本身也是一点常驻注意力。

**记忆 agent 拥有工作状态：memory blocks。** 一个专门的后台子 agent维护若干带标签的块——`progress`、`decisions`、
`errors`、`learnings`、`open_questions` 为 code profile 默认，可按任务增删（调试任务开 `hypotheses`，迁移任务开
`checklist`），每块有 token 上限（默认 2K），总量有上限（默认约 12K）。这是 Letta sleep-time agent 的形状：Letta 创建
agent 时实际生成共享记忆块的两个 agent，**主 agent 不被给予编辑核心记忆的工具**，理由是把记忆管理捆在主 agent 上
"更慢、更不可靠、增量记忆随时间变乱"。Claude Code 同一路：TodoWrite 归主 agent，Session Memory 归 fork 出的子
agent。记忆 agent 对 `plan` 只能标记条目状态，不能重构——共享块的所有者规则是"重编辑归一个所有者，其他人只追加"。

**host 拥有事实。** 触碰的文件与函数（恢复日志）、执行过的命令与退出码（shell 监督器）、未解决的诊断（LSP）、最近
checkpoint。天然结构化，host 直接写，零模型调用。

块存在知识库（第 7 节 `block` 节点，会话作用域），在 UI 中以"计划"面板可见、可编辑并标注每次改动的来源（主 agent /
记忆 agent / 用户）；用户的编辑作为一条 Zone 2 事实回到主 agent。块只出现在三处，**永远不进 Zone 0**：主 agent 的
计划工具结果（尾部）、Zone 2 中一份受预算约束的复述（Manus 的 todo 复述；主 agent 不用自己写就能在每步尾部看到
新鲜状态——这是"注意力"上的收益；profile 可关）、压缩替换块。

当前 UI 将 blocks 与子线程合并到父会话右侧的 session state 侧栏：后台/agent 写入通过 SSE 只发失效通知，UI 随后走鉴权
GET 重取；用户编辑走鉴权 PUT、带 `updatedAt` 做冲突检查并写 `updatedBy: user`，后台更新后保存旧草稿会收到 409 而不是覆盖，
且不把块正文放进广播事件。线程列表路由同样必须经过 UI auth，不能因
“通常只绑定 localhost”而暴露任务说明、worktree 路径或报告元数据（D-046）。

**正式默认与用户选择（D-078/D-081）。** 现行模式是 `off | assist | takeover`，缺省 `takeover`。`off` 停止 keeper、从 Zone 2
排除 memory blocks 并由 Pi 压缩；`assist` 维护并注入 blocks、仍由 Pi 压缩；`takeover` 在相同维护路径上逐次检查接管证据。旧
`shadowMode:false/true` 分别解析为 `off/assist`，显式 `mode` 优先；无设置使用新默认，损坏值不吞成默认。memory 是 user-only，
活动会话实时继承全局值，也可用独立、持久的 session override 选择三态或恢复继承。`record-only` 仍可作为未来诊断模式，但不是
现行契约或默认路径的前置。

**记忆 agent 的上下文。** keeper 从 Pi 的 `context` hook 捕获本步真实 provider-neutral messages，在 `turn_end`
补上本次 assistant 与 tool results，复用活动会话的 system 与 model，只暴露 `memory_edit`，尾部追加当前块、游标与编辑指令。
输出必须是结构化块操作，由 Host 逐项验证、按本次前一项的结果顺序应用并记账；自由文本、陈旧 patch 与越过预算的操作都不写。
它没有文件与 shell 工具，不写持久知识（那走第 7.2.2 节的建议流程），`memory_edit` 也不进入主会话历史。

**版本与分支提交契约（D-076）。** block 修订记录写入时的 `sourceLeafId`；活动分支按祖先路径为每个 label 选择最近修订。
后代更新 copy-on-write 到当前 leaf，分支删除写 tombstone，兄弟仍继承共同祖先。keeper、todo、Zone 2、UI、compaction 与线程快照
使用同一分支视图；UI 的路径由 Host 从活动 Pi session 自动取得。更新、创建和删除在 Store 写队列内做 expected-revision CAS，
同一 patch 内的后续操作使用前一项返回的新修订；`plan` 只允许 keeper 标记条目。

keeper 覆盖水位只记录 `buildContextEntries()` 实际物化进其输入的 entry ID，并绑定提交时的完整活动分支路径与所有可见 block 修订；
部分失败或无 material 更新不推进。压缩前重新核对移除区间、当前分支和 block 修订。水位在 block 写成功后更新，Host 崩溃窗口只会
丢水位并让本次回到 Pi，下一次有效 keeper 更新可重建；它不是跨 Host 重启的持久 checkpoint。
这组证据证明机械处理区间，不证明保存了所有未来重要的信息；来源无法重新读取时仍须说明，不能用 hash 冒充正文。

**执行事实与失败诊断。** keeper 使用活动模型但工具集不同，不保证命中主请求缓存；这不阻止默认交付。保留 memory_edit 输出协议和
session-local 模型归属，未返回有效操作就是未更新，不从散文猜操作。有效模式、session override 以及最近一次 keeper/compaction
失败进入 SessionSnapshot 和 Context；成功的同阶段运行或模式变更清除陈旧失败。取消辅助调用分项费用/Token 看板及其专用聚合
（D-080），保留正常会话已有费用、Token 和上下文容量展示。本地不自行发起付费记忆输出协议/缓存对照实验。
Anthropic 的工具定义变更影响整个前缀，`tool_choice` 变更影响 messages 缓存；缓存只作优化，不作为正确性前提。

**触发。** 频率过高浪费，过低模糊，所以分层：

- *底线门控*（Claude Code 实测值）：上下文不到 10K 不启动；之后每增长 ≥5K token **且**（自上次至少 3 次工具调用，或
  上一步没有工具调用——自然断点）运行一次。
- *事件加速*（不等 token 门，受去抖约束；这些是客观事件，只决定何时运行，不携带任何"什么重要"的判断）：测试或构建
  命令结束；命令退出码由失败翻为通过；用户中途插话、steering 或编辑了计划面板；子 agent 返回；用户在 UI 上"记住这个"
  （立即触发）。
- *压缩前保底*：上下文越过软阈值（默认 75%）且块比一个门控间隔更旧时立即优先运行；压缩最多等待它一步。
- *去抖与自适应*：同时只有一个在飞；上次结束不足 30 s 不再起；一次运行未改动任何块则退避（间隔 ×1.5，上限约 20K），
  改动大则回到底线。
- *空闲整理*：用户空闲超过 provider 缓存 TTL **且存在未整理的轨迹**时做一次更完整的整理——缓存已冷，此时最便宜。
  这不是定时器：没有新轨迹就没有东西可整理，父 agent 等待子 agent 的时间再长也不会触发（第 9.2.6 节）。

所有触发都以"有未整理的新轨迹"为前提，**没有任何按墙上时钟重复运行的触发**。所有值为可配置默认；运行失败和实际 block
变化进入现有状态通道，不新增辅助调用费用/Token 明细面板。

与 Devin 的差异：Devin 的压缩**调用**一个 Cognition 专门微调的小模型识别历史中的 key details、events、decisions。
Piarium 没有这样的模型，替代品是**分工**——记忆 agent 持续把这三类信息维护成显式的块，host 维护事实，压缩时刻不需要
任何模型去识别它们。Letta 论文的结果支持这一分工：同等准确率下测试时算力约少 5 倍，上下文被反复读取时平均成本低
2.5 倍；同一论文也记录了反例——SWE-Features 上测试时预算很高时纯测试时算力有时精度更好，因此复述保持紧凑且只是
上下文而非指令。

#### 8.4.2 三档压缩

1. **清理工具结果。** 工具结果进入历史前可截断，历史中的清理集中在压缩或支持的 provider 请求投影中。是否有完整可读正文按来源
   判断，不从临时句柄或 TranscriptRef 推导。Anthropic tool-result clearing 会使相关缓存前缀失效并产生重新写入成本，后续请求可复用
   新前缀；不是“服务端清理免费保留原缓存”。见 [官方文档](https://platform.claude.com/docs/en/build-with-claude/context-editing)。
2. **替换（正式默认路径）。** 材料是 memory blocks、主 agent 计划与 Host 事实。接管前验证 keeper evidence：完整分支祖先路径
   匹配，待移除历史全部属于 keeper 实际处理的 context entry，当前可见 block 的 label/revision 集合与提交时一致。仅有
   `updatedBy: memory-agent` 的块不够。
   例如处理到第 100 条而 Pi 准备保留第 121 条之后，101–120 的缺口不能靠 stale 提示丢掉。只可用 Pi 支持的安全切点保留缺口，或完成
   维护后重检；不能安全满足时交还 Pi 默认压缩，不自行切断 tool call/result 配对。生产压缩按 Pi 上一次 compaction boundary 与
   本次安全切点推导 `removedEntryIds`，`handleBeforeCompact` 同时检查覆盖、分支和 block 修订；无移除区间、覆盖不全、错分支、修订
   漂移或 Host 重启后无 coverage 时，该次交还 Pi。`takeover` 已是新默认；`assist`/`off` 始终不请求接管（D-081）。
   不复制上次摘要文本不等于没有累计语义损失；承诺的是来源可追溯、覆盖缺口可检测、保留来源可重新读取，而非无损记忆。
3. **兜底。** 当前块缺失、覆盖落后、分支/修订不符或 keeper 失败时，直接让 Pi 完成本次摘要；会话继续运行，失败状态可见。
   若实际使用证明值得在压缩前同步刷新 keeper，可复用同一机制实现；有服务端压缩的 provider 也可按其真实 API 接入，不让候选优化
   阻塞当前可靠兜底。

#### 8.4.3 触发时机

回合内的触发点是 **loop boundary**——所有工具结果已返回、模型将要继续——Codex 的做法；排队的 follow-up 与 steering
在压缩后保留并重放。回合之间优先在用户空闲超过 provider 缓存 TTL 时压缩（缓存已冷、免费）。`reason: 'overflow'`
（一步撑爆）走第 3 档。子任务边界由 host 推断，不要求主 agent 配合：测试或构建刚结束、todo 条目刚勾掉、上一步没有
工具调用，都是比任意 loop boundary 更好的压缩点，触发器优先在这些点动作——这吸收了 2026 年 SelfCompact 研究的结论
（在子任务边界压缩优于纯固定阈值）而不给主 agent 增加义务。Zone 2 的上下文压力一行（"context 72%"）是纯信息，不
要求任何动作。

#### 8.4.4 长任务的连续性：不停下来

agent 现在跑的是数小时的自主任务，任何要求用户介入才能继续的机制都不可用。连续性靠两件事，都不产生停顿：

- **有检查点的压缩与来源恢复**（第 8.4.2 节第 2 档）：机械覆盖可检查，多次压缩后的语义遗漏在真实使用中观察，不从结构推定无损。
- **委派**。子接收任务与父计划快照，在独立分支及其按需物化目录，或明确的 shared 视图中工作；结果以带修订的结构回到父。
  同一执行视图按路径和进程写入语义协调，不把独立分支的并行写者锁成串行。子会话由 broker 启动，不依赖插件。
- 压缩计数超过阈值（默认 3）时，信号给 **agent**（Zone 2："本会话已压缩 3 次，考虑将剩余子任务委派给新上下文的子
  agent"）和 UI（信息条），**不是停顿，不是建议用户做什么**。

Handoff（把当前会话提炼为一条草稿 prompt 开新分支，Amp 的做法）只作为**用户手动命令**存在于交互式使用，不在
自主路径上，永不自动触发。

`session_compact` 之后按预算重新注入最近文件与技能指针（默认最近 5 个文件 / 50K token、技能 25K token）。UI 上没有
模态与输入锁定，时间线以一个安静的分隔标记表示压缩边界，composer 全程可用。

### 8.5 子 agent、模型槽位与模型切换

子 agent 能否复用父缓存取决于实际 system/tools/messages 与 provider 行为；同模型不等于前缀一致或必然命中。
模型切换经明确的执行配置边界记录，主动上下文整理尽量集中到压缩时刻；缓存收益按实际用量观察，不作正确性承诺。

**模型槽位（model slots）规则：每个用模型的能力一个槽位，独立配置。** 许多 provider 没有更便宜的兄弟模型，自动挑选
会挑不到，回退主模型会烧钱；而不同能力的任务性质与实现都不同，不能共用一个"便宜模型"。因此 harness 不自动挑模型，
每个用模型的能力有自己的槽位：

| 槽位 | 服务的能力 | 默认 | 未配置时 |
| --- | --- | --- | --- |
| `models.explore` | 查询理解/搜索表达与候选相关性/选段（3.15D） | 未配置 | 使用算法与可用向量，明确模型未参与，不回退主模型 |
| `models.retrievalAgent` | `retrieval` 角色（纯 LLM 多轮检索） | 未配置 | 角色不注册 |
| `models.quickImplement` | `quick-implement` 角色 | 未配置 | 角色不注册 |
| `models.hardImplement` | `hard-implement` 角色 | **主模型** | — |
| `models.frontend` | `frontend` 角色 | 未配置 | 角色不注册 |
| `models.review` | `review` 角色与已发布结果的 review 传感器 | **主模型** | — |
| `models.check` | `check` 角色 | 未配置 | 角色不注册 |
| `models.reader` | `webfetch` 的阅读子 agent | 未配置 | 忽略 `prompt`，返回提取内容 |
| `models.suggestions` | 知识建议的草拟与触发描述生成 | 未配置 | 用用户原文，触发描述留空 |
| `models.permissionJudge` | 原生权限 fallback 的 Smart 判断 | 未配置 | Smart 不可选；插件活跃时由插件 authorizer 链负责 |
| `harness.embedding` | explore 文档与查询嵌入（3.16B） | 未配置远程时本地 `all-MiniLM-L6-v2` | 远程失败/未绑定 Pi 时语义来源 `failed`/`unavailable`，词法与图继续；同一查询不静默切回另一 vector space |
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

记忆 agent 不走槽位，直接使用该会话活动模型，默认与迁移规则见 8.4。工具集不同，不承诺缓存命中，也不增加辅助费用统计；不用 T4 或缓存实验
决定是否允许使用。后续模型/协议优化按具体问题实施，不复制 Host 模型与凭据权威。

Settings 提供**预设**一键填充多个槽位（如 Anthropic 预设：explore / retrievalAgent / quickImplement / check / reader /
suggestions 填 Haiku，hardImplement / review 保持主模型），但预设只是填表，每个槽位随时可单独改。规则：

- 依赖未配置槽位的能力**不注册、退化为无 LLM 路径**，**永不静默回退到主模型**。`websearch` 与 `grep` 本来不用 LLM。
- 只有 `hardImplement` 与 `review` 默认等于主模型，因此零配置时这两个角色可用：即便同模型，新上下文与 worktree 隔离、
  干净审阅本身就有价值。
- 模型槽位保留配置和功能；取消 `SessionStats.modelSlotUsage` 及“模型槽位用量”区块（D-080）。子线程的角色、模型与 token
  继续由自身 `ThreadRun` 记录，普通会话已有统计保持。

槽位选择遵循用户配置；前缀一致只是可能获得缓存收益的条件。设置明确 memory 的活动模型例外及自动 review 的启用状态。

### 8.6 度量

Piarium 已按轮聚合 token 用量并显示 cache-read / cache-write（0.9.8）。harness 增加会话级计数器：缓存命中率、
工具错误次数、近三步同工具同参数的重复次数、工具输出 UTF-8 字节。这四项随 `SessionStats` 进入现有 Context 侧栏；runtime
不发布字段时整段不显示，不把“无能力”渲染成四个 0。普通会话已有 Token、缓存、费用和上下文容量展示保留；不再按辅助模型槽位
展示调用次数、Token 与成本（D-080）。操作计数器用于定位重复调用、错误和输出噪声，不能判断任务是否做对。

**验证服务于交付（D-078）。** 来源读取、分支/CAS、压缩覆盖、工具配对、取消、崩溃恢复、数据保留与集成结果用对应生产链测试验证。
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
3. **压缩重置。** 压缩后早先的增量视图已不在窗口里，"相对上次的变化"接不上；`session_compact` 触发时 host 重置该会话
   的全部观察游标，压缩后第一次查看返回全量。压缩本身把被取代的旧视图折叠掉——这是唯一允许"折叠"的时刻（第 8.2 条
   规则 3）。
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

### 9.1.2 权限管理与原生 fallback

Piarium 不再把移除 `@gotgenes/pi-permission-system` 当作既定迁移终点。对实际 provision 的 v27 公共契约复审后确认，插件已经
覆盖 Bash 语法拆分、规范路径与外部目录、MCP、skill、子会话转发、会话授权与审计，并提供 session-keyed service；当前原生门
只覆盖 Harness 工具，直接替换会缩小真实保护面（D-044）。因此插件已加载时由它独占 `tool_call` 决策与 UI，Piarium 原生门按
本会话发布的 service 动态让位；插件缺席或卸载后原生门立即恢复，作为 Harness 工具的 fallback，不出现连续两次确认。

fallback 策略按工具
名与参数模式声明，默认规则由 `HARNESS_TOOL_META` 的 `mutation` 属性生成（`none` 放行；`journaled` 在 normal 下 ask、
accept-edits 下 allow；`process` 除 bypass 外 ask），非 harness 工具（MCP、Pi 包）不由本门处理、交给 Pi 自己的权限
系统；用户在 Settings 修改，策略文件是 Piarium 自有的原子 JSON 而非插件的原生配置。Devin CLI 的 Smart 模式（快模型
判定安全性，装包 / 变更 git / `rm` / `sudo` / 敏感文件永远询问）作为 fallback 的可选模式纳入。插件活跃时，以上原生模式
与规则不参与最终决策；需要模型判断时使用插件公开的、由用户在 `authorizerChain` 中显式启用的 authorizer 扩展点。注册 link
本身不取得权限，是否启用仍由插件配置决定。

**三层，不寻找唯一安全边界**（D-035）：

1. **Pi `tool_call` 门**：插件存在时由 `pi-permission-system` 做 allow / ask / deny、路径与命令分析及 UI；插件缺席时由
   pi-host fallback 处理 Harness 工具（`ask` 走现有 `ui.select`：Allow once / Allow for this session / Deny）。这一层也是
   `edit` / `write` / `apply_patch` 这类**在 worker 进程内直接写文件**的工具目前唯一可阻断的门——Host 对这些写入只能通过
   Harness wrapper 的 mutation lease 约束，无法约束任意第三方工具或 worker 自己的文件访问。
2. **Host 服务授权**：不弹窗、不重算用户策略，只验证 `ActorContext`、RunManifest 里的静态能力集、workspace / path 包含，
   覆盖一切经 host 中介的能力（`shell.*` / `output.*` / `search.*` / `document.readSource` / `thread.*` / `fs.lock` / `lsp.*`）。能力按会话实际冻结的
   `activeTools` 推导：只有没有任何 `bash` 工具时才不含 `process.shell`；关闭 Piarium 的同名覆盖若会回退到 Pi 内置 bash，
   仍然具有 process 能力。缺少该能力时绕过工具直接到达的 `shell.exec` 必须被拒——这不是第二套用户策略，是防止
   绕过工具入口。按风险类别授权：`read`（document / search / output / lsp）、`process`（shell）、`control`（thread send / kill /
   merge）、`write`（未来经 host 中介的文档写入）。
3. **OS 沙箱**（第 9.1.1 节）：限制 worker 绕过工具直接访问文件与网络。当前不具备。

`ThreadLaunchManifest.scope` 是任务范围，同时对 Host 能解析出具体路径的服务形成强约束：`search.content` 的返回项、固定来源
`read`、LSP 路径、`fs.lock` 路径与显式 `shell.exec.cwd` 都必须落在 scope 内。它**不是文件系统沙箱**：shell 命令文本内部可以
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

### 9.2 多 agent：主 agent 不面对角色，harness 面对

多 agent 的目的只有三个：借助多个模型的长处、降低成本、减少主上下文污染。传统设计把"在哪跑"（同上下文 / 新上下文 /
隔离 worktree）和"用哪个模型"捆成**角色**暴露给主 agent，结果是重流程的模型把"调用某个角色"当成必走步骤，死板地
尽可能调用，浪费时间与资源。Piarium 的答案是把这两个轴拆开，且不让主 agent 碰第二个。

#### 9.2.1 原生运行时

子 agent 是 **broker 起的子会话 worker**，绑定父会话，拥有自己的静态 Zone 0、实际工具集与权限、按用户设置的预算。
同模型不保证工具、路径和 system 相同，缓存按实际响应计量。这复用 Piarium 已有的每会话 worker 原语（每个子 agent
独立进程、独立会话、在 Kanban 可见）。`pi-subagents` 不再是 harness 的依赖，保持为用户可装的替代品，其 Fleet 适配器
不变（第 5.10 节）。每个子会话都是一条**线程**（第 9.3 节）：在父会话的侧栏成列、点开就是完整聊天、人可以直接对话，在
父的时间线上是一张折叠的子卡片带状态与报告。

#### 9.2.2 角色 = 模型档位 × 任务性质

主 agent 换不了自己的模型，委派是它借用另一个模型长处的唯一途径。因此角色按**模型档位与专长**定义，不按流程步骤
定义——"父模型 + 全工具"的通用子 agent 除隔离上下文外什么都没换，不在目录里。code profile 的角色目录，全部可并发：

| 角色 | 模型槽位 | 工具 | 用途 | 隔离 |
| --- | --- | --- | --- | --- |
| 检索 `retrieval` | `models.retrievalAgent` | 只读（grep / read / find / explore） | 纯 LLM 多轮检索，处理 `explore` 管线答不了的跨文件推理问题（第 6.1 节第三级） | 无 |
| 快速实现 `quick-implement` | `models.quickImplement` | 全工具 | 规格明确、既有模式的实现与相关验证 | 并行时独立工作分支，按需物化 |
| 难度实现 `hard-implement` | `models.hardImplement`（默认主模型） | 全工具 | 模糊、跨切面、需要推理的实现 | 并行时独立工作分支，按需物化 |
| 前端设计与实现 `frontend` | `models.frontend` | 全工具 + 预览截图 | UI 设计与实现；Host 预览/Electron 渲染 | 并行时独立工作分支，按需物化 |
| 审查 `review` | `models.review`（默认主模型） | 只读 + diff | 独立、干净上下文的审阅，返回带严重度与 `file:line` 的发现 | 无 |
| 检查 `check` | `models.check` | 读取 + 命令执行；测试、构建及准备步骤允许在正常权限下产生文件变更 | 跑测试、lint、核对论断、冒烟；记录受检代码版本、环境、命令、结果与生成物，不称只读 agent | 当前 shared；按任务需要选择工作副本，不一律强制隔离 |

Devin 式快速检索**不在目录里**：它是工具 `explore`（第 5.7 节）——一条算法管线，不是 agent；`retrieval` 角色是它之上
纯 LLM 的第三级。

**每个角色一个独立槽位**（第 8.5 节），任务不同、实现不同，不共用"便宜模型"。零配置时可用的角色是 `hard-implement`
与 `review`——默认主模型，但新上下文与 worktree 隔离本身就有价值；其余角色的槽位未配置则**不注册**、模型看不见，
不静默回退主模型。profile 可增删角色（research profile 会有文献检索与引用核对角色）。

主 agent 的动词：`dispatch(role, task, { scope?: paths })`——**异步**，立即返回子 id，父继续工作；`wait(ids?,
timeout_ms?)` 等待（第 9.2.6 节）。返回结构化结果：改动文件、结论、未解决项、置信度、持久转录引用及来源可用性。其余由 harness
决定：**隔离**（并行写者各持独立工作分支，按实际工具需要物化，父集成结果；shared 模式直接读写父目录并明示实时共享；
检查角色按任务选择工作副本）；**权限**（继承父策略，角色工具集由实际装配强制；询问投影到父和用户，不能静默卡住）；**深度**（不限，
线程可以再开线程，靠角色目录与成本可见性约束，不靠硬上限）；**并发**（默认 12，可配置；到上限的派发排队）；每线程的
步数与 token 上限是可选的用户设置，默认不设，设了则超出时返回部分结果并注明。线程的寿命与父的回合和 worker 进程解耦
（第 9.3.4 节）：父的回合结束、父 worker 退出，线程照跑；只有用户删除父会话时线程才停下并归档。

#### 9.2.3 harness 自己的 agent 对主 agent 不可见

记忆 agent（第 8.4.1 节）与阅读子 agent（第 5.8 节）由 harness 规则触发，主 agent 没有调用它们的工具。`review` 角色
有两个入口：主 agent 可以 `dispatch('review', ...)`；harness 也在子线程成功发布非空结果后作为**传感器**自动运行一次
（第 9.1 节，D-207/D-210）。两者输入相同——已存储结果的 diff、任务说明与已接受的项目 knowledge，**不带父的对话**，干净是它有效的原因（Devin
Review 在 Devin 自己写的 PR 上仍平均抓 2 个 bug、58% 为严重）；输出带严重度与 `file:line` 的发现，写回源线程投影并进入 Zone 2。
自动 review 默认运行且不阻断 settle；一轮执行以 `resultRevision + reviewThreadId + reviewRunId` 识别，新修订和新 Run 不继承
旧审阅，迟到旧结论不能覆盖。用户可关闭，或把 `harness.review.gate` 设为完成门；gate 保存同一组结构身份，只由对应完成、失败或
取消解除，后两者也会显示。用量归 review 槽位（未配置则回退主模型），不以 T4 配对为启用前提。父会话的 journaled 变化不是自动 review 触发。

#### 9.2.4 委派的判断交给主 agent，harness 不设配额、不估成本

不做配额（前面用光后面没有，且不区分必要与多余），不做准入规则，不估算成本——成本因人、因 API、因模型而异，估不出
可信的数；把成本数字注入主上下文还会把它的注意力引向算账而非任务。只做两件事：

- **说明。** 系统提示把角色呈现为一支团队而非工具：每个成员是谁、擅长什么、模型档位相对高低、大约多久。然后一条判断
  原则："按时间与资源成本判断——如果自己做更快、消耗更少，就自己做。" 工具命名为 `dispatch`，让模型落在"把活交给同事"
  而非"调一个工具"的先验上。
- **并发数。** 默认 12，可配置；到上限的派发排队。

可选的、**默认不生效**的用户设置：按角色或槽位要求"派发前询问"（不带任何成本估算，只是一个是否放行的问题），走原生
权限门（第 9.1.2 节）。Fleet 按角色显示用量；计数器记录每会话每角色的派发次数，让过度派发可观察、可用 profile 提示词
纠正。

#### 9.2.5 通信模型（照 Cognition 踩过的坑）

- 子 agent 启动时拿到：任务说明、父的 `plan` 与相关块的**快照**（标注"这是快照，父可能已前进"；空与不可用分开）、host 事实。不拿父的
  完整对话——对应"agent 误以为与子共享状态"。
- 子的记录对父**可读但分层**（`read_thread(id, what)`，第 9.3.6 节）：默认是它的记忆块（progress / decisions / errors），
  其次报告，最后才是转录切片走句柄。按需拉，不默认灌进父上下文——Walden 的"共享完整轨迹"原则的按需版本，加一层
  "先看笔记再看原文"。
- 子完成时父收到结构化结果 + 轨迹句柄，不收散文；父当时不在 `wait` 里，结果就在父的下一回合以 Zone 2 一行进入
  （第 9.3.4 节）。
- **兄弟之间不通信**。一个子的发现若影响另一个子，走父的下一次委派——map-reduce-and-manage，不做 swarm。父的指令
  应描述目标与边界而非步骤——对应"manager 过度指令化"。

#### 9.2.5b 工作分支、按需物化与版本化集成（正式架构，D-078）

**工作状态独立于目录。** Application Host 拥有内容寻址的工作状态存储：文件按字节哈希存为不可变对象，目录树引用路径状态，
工作分支引用一个固定基线与自身修改，发布新修订时原子切换分支头。Thread 关联工作分支，ThreadRun 关联本次输入修订及执行目录；
结果是不可变修订，目录是执行载体。需要保留的修改收回持久状态之前，目录不能视为可丢弃缓存。

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
捕获失败或取消删除该 Thread，不留下宣称完整的分支。父之后的新增、修改、删除、checkout 或提交不能改变子基线。
同名 `read` / `grep` / `find` / `ls` / `explore` 经 Host 分支视图读取该 base 加 delta/tombstone，provenance 标明
branch/base/delta；父 live 目录与 scratch/worktree 磁盘不能补读未改路径。隔离 Run 从虚拟 scratch 启动；同名
`edit` / `write` / `apply_patch` 把文本变更提交到同一 WorkingState delta，不写父目录（D-213）。只有 `bash` 或
LSP 导航（`symbols` / `definition` / `references` / `hover`）首次需要真实路径时，Host 冻结当前修订、等在飞虚拟
写入结束、物化该修订并原子切换整个 Run；此后本 Run 的文件工具都走该目录，结算再把目录变化收回新结果。
切换失败保持原虚拟分支。Git blob 与工作目录转换后的字节不能无条件视为相同；当前基线读取实际输入字节。
具备角色目录嵌套工具的子线程经真实 tool registry 与 `control.thread` 能力调用 `dispatch` / `threads` / `wait` /
`send` / `read_thread` / `merge` / `kill`；Host 把 caller 解析为 `parent.kind: "thread"`，scope 与权限只能继承或收窄
（D-215）。owning workspace 保存 catalog / WorkingState / 父子关系；execution workspace 只覆盖 scratch 或物化目录的
Documents、LSP、路径与 shell（D-216）。子会话注册、thread services、Zone 2 和 lost resume 从 Host session binding
读取 owning workspace，不扫描全部 catalog。嵌套隔离基线复制父分支有效视图，不扫父 live 盘；孙结果先集成到父分支或父物化目录，再由父结果进入根工作区。
Git 物化使用 `git worktree add --detach`（会写 `.git/worktrees`，不创建用户可见分支）或独立 `git init`，子 Git 命令不得发现或修改父仓库。
兄弟线程不直接通信；根上下文不复制孙对话正文。不加固定深度上限，复用既有并发与排队。

`harness.worktree.copyIgnored` 在首次准备后规范化为 WorkingBranch 的持久 `captureScopes`（schema 3）。窄结果发布只枚举这些
显式文件/目录根、其基线后代与当前后代，捕获新增、修改和删除；不会因此重新扫描整个工作区。重启、partial publish、reclaim 和
materialize 使用同一冻结范围，Git 是否忽略该路径不再决定结果是否保存。

Git 后端可直接读取 baseline commit 的 tree/blob 并搜索树对象；非 Git、尚无首次 commit 的目录按需捕获输入并使用 copy/CoW。
初次发现/捕获文件有真实成本，单文件哈希随字节数增长，Merkle 只减少重复树结构；O(1) 只适用于引用已就绪不可变根，不承诺端到端。
文件监视器提供失效信号，不是完整事务日志；并发外部修改导致捕获不稳定时重读相关路径或报告不完整，不宣称跨文件瞬时一致。
基线采集属于创建/更新分支的工作，不进入普通消息、每轮恢复或每次查询的全仓扫描。Git 的过滤器、LFS 与换行转换由适配层处理，
记录实际工具所见版本，不能把仓库 blob 与物化字节无条件当成相同。

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

**存储迁移与保留。** 复用恢复库的内容寻址、流式捕获、路径状态与条件补偿实现，增加工作分支、结果、集成的独立引用所有者。
恢复历史清理、恢复插件关闭/更换不得删除仍由线程引用的对象；线程删除释放自身引用，只有没有任何所有者的对象才能清理。
存储位置变更同时迁移对象及引用，不能仅复制 hash。当前 Git resultCommit 可作迁移来源；新状态正文和引用提交成功后切换 Thread，
失败继续使用原来源。切换后 Git 分支只作物化后端或显式导出，移除旧写入权威，不长期双写，也不要求用户先清空已有工作。

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

#### 9.2.6 长时间委派与缓存

父等待子 agent 期间没有请求发出，前缀缓存在 provider TTL 后变冷（Anthropic 默认 5 分钟、可选 1 小时；各家不同），
子返回时那一次请求要全价重写整个前缀。

**`wait` 默认只因真实事件返回**（D-033）：目标线程的状态变化（含 `attention` 翻转为 stalled / looping / 等输入、Run
结束、报告就绪）、用户输入或中止、调用方显式给的 `timeout_ms`；上限是 host 的请求时限（1 小时）。**没有按缓存 TTL 的
默认唤醒**。缓存保活是可选的费用/延迟策略，用户可直接开启 harness.wait.cacheKeepaliveWake，不需先交回放报告。
默认不因等待自动增加模型请求，是 wait 的事件语义；stalled/looping 本来就会唤醒父。保活按实际 provider 支持实现，记录请求
和用量，不把 TTL 或估算命中当成正确性条件，也不因某 provider 缺保活能力影响线程运行。

若开关打开，wait 返回极简增量状态；下一请求的缓存命中和费用按实际响应记录，不保证前缀全命中：

```text
2 running · 0 done
  A  editing packages/web/lib/foo.ts · 14 steps · 40s ago
  B  3 steps · no activity for 6 min ⚠
```

唤醒让父看到**增量**进度（第 8.7 节：只有自上次以来的变化）。**超时返回是正常结果**，不是错误，也不意味着任何线程出
了问题。原算账（30 分钟委派、5 分钟 TTL，唤醒 7 次 ≈ 0.7× 上下文，低于一次冷 miss 的 1.0×）保留在此作为实验的假设，
不作为默认行为的依据。

自动最小请求保活也可在用户选择的策略内实现，不必唤醒父模型决策；调用、失败与用量仍记账。线程的生命周期与正确性不依赖保活。

**这与上下文整理无冲突。** 记忆 agent 的触发是"有未整理的新轨迹"（token 增长 + 工具调用），不是墙上时钟；父等待期间
没有新步骤就没有东西可整理，不会触发；子返回时进入的是一条结构化结果，正常门控。压缩也永不按时间触发。因此长时间
委派不会导致频繁整理或信息丢失。

#### 9.2.7 后续能力

smart friend（便宜主模型遇难题时 fork 完整上下文向配置的强模型求教，Cognition 的 80/20 解法是共享完整上下文的 fork）
——需要一个高于主模型的 `models.smartFriend` 槽位，不进 v1。

### 9.3 线程：子会话是用户可见、可对话的一等对象

第 9.2 节解决的是"主 agent 把活分出去"。它解决不了另一个常见场景：同一项目里几个截然不同的想法要并行推进，而每个想法
本身都需要人和 agent 来回讨论——把两个不相干的设计放进一个上下文不干净，把它们拆成两个独立窗口又丢掉了和父对话的
关系。传统子 agent 也不适合：它以工具调用为生命周期，对用户不可见，一次连接中断就被父判为"没返回"，长时间卡住无人
察觉——是个黑盒，最多是装了内窥镜的黑盒。

根因是把三样东西混成了一个"调用"：观察通道与被观察的对象（通道故障被读成对象死亡）、父的注意力窗口与子的寿命（子只在
调用 pending 期间存在，父回合结束或压缩就成孤儿）、进度与完成（唯一信号是"回来了没"）。Devin 的查看工具只解了第三个。

Piarium 把三样拆开：**身份和状态归 host，观察归事件，等待只是订阅。**子会话升格为**线程**。业界没有谁把下面四样合在
一起——Codex 桌面应用有用户可见、各占 worktree 的并列 thread 和 CLI 侧父 agent 可 `send_input` 的子 agent，但两半分开；
Devin 的 MultiDevin 让用户能打开任何 worker 对话纠偏，但没有合并与回收设计；Cursor 与 Antigravity 是多个独立 agent 的
并列面板，没有父子；Roo 的子任务用户可见但父子串行。线程是这四样的并集。

#### 9.3.1 对象与状态

线程是协议中的一等对象，由**两个对象**构成（D-032）：**Thread** 是工作本身，**ThreadRun** 是一次执行尝试。

```ts
Thread {
  id; parent: { kind: "session" | "thread"; id }; workspaceId; brief; kind: "discussion" | "implementation";
  role; model; manifest: { tools; worktree; scope; systemPromptFragment; concurrency; draftBaselineId }; // Run 配置世代内冻结
  lifecycle:   "queued" | "active" | "settled" | "archived";
  attention:   "none" | "user" | "permission" | "stalled" | "looping";     // 归 Thread：Run 崩了问题还在等
  integration: "none" | "dirty" | "merge-ready" | "conflict" | "merged";   // 归 Thread：worktree 比 Run 活得久
  workBranchId?; resultRevision?; materialization?; worktree?; report; activeRunId?; hidden; createdAt; updatedAt; eventSeq;
}
ThreadRun {
  id; threadId; attempt; runtimeId /* "pi" */; sessionId;
  workerState: "starting" | "running" | "lost" | "exited";
  outcome?: "success" | "failure" | "cancelled" | "lost"; exitReason?;
  inputRevision?; tokens; costUsd; steps; lastToolCall; startedAt; endedAt?;
}
```

工作分支、结果修订与草稿基线身份已经进入当前协议。验证记录写在 WorkingState 可选字段，Thread 只投影子检查、合并可应用性与父检查
以及该修订的 review 状态；观察和 review 都绑定实际 actor/Run 身份，不能由时间相邻推断（D-207/D-210）。更完整的物化记录仍是后续形状。
旧 worktree 在迁移期间作为后端记录保留。
状态是**正交维度**，不是一个枚举：`done + merge conflict`、`active + worker lost`、`archived + worktree retained`、
`waiting-for-input + permission pending` 都是合法组合，一条状态机表达不了。worker 崩溃 = 当前 Run 以 `lost` 结束，
恢复 = 新建 `attempt + 1` 的 Run 并更新 `activeRunId`；**不在同一条记录上把 worker-lost 清掉、改回 running**——那是把
第二次尝试伪装成第一次没中断，与恢复子系统"标 incomplete、不说谎"的原则相悖。`parent` 是一条图边（根会话或嵌套线程），
不是存储目录的所有者；注册表按工作区用一个同时包含 threads/runs 的原子 catalog 持久化（D-039），带 schema 版本，读取只吞
"文件不存在"，损坏、权限错误、未来版本都抛出且绝不
用空表覆盖；host 启动时对账——所有 `starting` / `running` 的 Run 标 `lost`。注册表是 host 的协调记录：它记录 host
知道的事，worker 是否活着由 broker 事实说了算，二者靠对账一致，注册表不凭自己宣布 worker 在跑。这份状态是父 agent、
用户面板、Zone 2 共同读的一份。将来接其他 runtime（ACP、Codex、Claude）换的是 `ThreadRun.runtimeId` 对应的 adapter，
不重写线程系统。

#### 9.3.2 一个原语，两种入口

人从父对话的任意位置"从这里开一条线"，或父 agent 调 `dispatch`——底层同一个创建原语，`dispatch` 只是"agent 开线程 +
自动开跑 + 父订阅完成事件"。开线带走的上下文是**父会话的记忆块**（记忆 agent 维护的 progress / decisions，标注"这是
快照，父可能已前进"）加一段简报，不是父的对话历史：便宜、干净、接得上共识。人开的线程默认也带记忆块，可以不带。

**讨论线**是只读工具集、没有 worktree 的线程，开销接近零、随手丢——"设计阶段就该在两个窗口里讨论"对应的就是它。Host
只接受父会话里仍处于活动分支的持久消息 id，workspace 与父边由 broker 会话反查，不由 UI 指定。首轮和后续每次回答完成时只把
线程标为等待用户继续，不结算 Thread、不关闭 Pi session。想清楚后一键"转为实现线程"：创建独立工作分支并按工具需要物化，再结束讨论 Run、
在**同一个持久 Pi session** 上新建实现 Run，并以父会话当前真实工具集重新构造 worker；对话延续，写能力只在这次用户显式转换时
打开。实现线两边都能开，讨论线以人开为主。是否携带父 blocks 是冻结在 `ThreadLaunchManifest.carryBlocks` 的创建选择，重启恢复
不得把“不携带”改回默认值。

#### 9.3.3 两个主体

线程里的消息带来源标记：来自人，还是来自父 agent（沿用 Zone 2 的"数据而非指令"标记方式，人的消息优先）。父 agent 的
`send(id, message)` 就是 Codex 的 `send_input`。用户把线程聊偏了，父手里的简报就过期了——规则是父只信线程的**最终
报告**，报告必有"相对简报的偏离"一节，由线程自己的记忆 agent 维护的 decisions 块直接生成，不给线程增加义务。子线程
**没有读父会话的工具**，简报就是契约。

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
  重核结果。同线程的归档、恢复和回收互斥，自动清理跳过正忙目标。恢复从选定 native resultRevision 重建，沿原 session 绑定新 Run；
  普通已结束/已回收线程的打开也走该链。失败保持原生命周期可重试，不开放错误目录；准备进度持久化为明确阶段，部分目录重试清理核对 fingerprint（D-204）。
- **占用与背压。** 记录物化目录、对象库、受引用历史及可回收量，删除目录不等于释放结果对象。共享对象在工作区只计一次。
  优先回收符合条件的缓存；新增物化按用户配置预算、实际可用空间与可知准备需求安排，必要时排队或返回可行动的 unavailable，
  不终止已有线程来腾配额。没有定标时不默认设置 8 GiB/10% 硬拒绝，也不把未知所需空间当 0；运行中的实际空间不足按 I/O 失败
  明确记录（ENOSPC）。线程面板展示 Host 占用、保留原因和立即回收，不设无依据的 80% 统一阈值（D-202）。
  统计覆盖该工作区全部父会话；首次物化与恢复在短临界区预留已知新增需求，慢 setup/会话调用不持工作区锁。未知量不遮住已知超额，也不因此统一拒绝任务（D-204）。
- **启动对账与历史清理。** 对受管记录和目录对账，修复 Git 元数据；能确认属于 Piarium 且已保存的无使用者目录正常回收，归属
  不明的目录展示而不猜测删除。历史对象与分支按引用及用户保留配置清理，不以固定 30 天删除仍可继续的结果。分支名虽小，其
  引用会保留内容对象，须计入历史占用；对账和回收不依赖某个 idle 定时器。
- 对话正文永不自动删除；最终报告与记忆块作为 `session` 节点进知识库，带 `spawned_from` 边，父会话之后可以 `recall`。
  **用户删除父会话**：现有删除确认说明运行线程将停止并归档；结果保留是否成功按实际执行返回，不预先声称都已保存，不弹第二个模态；
  删除后给可撤销提示；运行中的线程停下（`outcome: cancelled`，快照后目录按上面的规则回收）并归档，归档区提供"恢复为独立线程"
  ——这是产品决定，不是技术约束（另一种可选设计是让它们直接成为工作区级的独立线程）。每条线的花费与占用可见。
  线程报告里的原始 trace 引用是 `TranscriptRef`（第 5.1 节），指向线程自己的会话文件，与线程同寿命。

#### 9.3.5 活性与失败分类

活性由 host 从线程的事件流观察，不靠线程自报、不靠父读转录：最近事件时间、工具调用频率、连续相同工具加相同参数的次数、
上下文增长、花费。停滞 = 超过 T 没有事件（T 默认按 provider 缓存 TTL 推，与第 9.2.6 节一致）；循环 = 重复模式。这是
传感器，允许机械判定（它决定的是"提醒谁"，不是"什么重要"）。

T1 的落地值是：无事件 300 秒只翻 `stalled` 告警、不取消 Run；连续 6 次完全相同的 `(tool name, 参数哈希)` 翻
`looping`，下一次不同调用自动清除。第一次非预期 worker 退出会在同一会话/worktree 上自动开新 Run；若新 Run 再连续崩溃，
停止自动重启并翻 `stalled`，避免形成进程崩溃循环。角色模型和工具经 `session.create/open` 在 Pi 会话构造前冻结；`hard-implement` 与 `frontend` 的角色目录含嵌套线程工具，
由 Host 能力与 `assertOwnerTool` 启用，不是提示词授权。`review` / `check` / `retrieval` / `quick-implement` 不含
`dispatch`（D-215）。

失败有分类，没有"没结果"：Run 的 `success / failure / cancelled / lost` 记录执行结局；Thread 的 `stalled / looping /
user / permission` 记录当前需要关注的原因，`integration` 独立记录合并状态。每种是不同的结果（不变量 3）。等待输入是一等
attention——实践里最常见的"卡死"其实
是在等一个没人看见的权限确认或澄清问题：它出现在 `threads` / `wait` 结果和用户面板里，附问题正文，父 `send` 或人直接
答；权限请求走当前活动权限门的 UI 并带线程徽标，永远不会静默等待。完成报告用受控的
`Conclusion` / `Deviations from brief` / `Unresolved issues` 标题与 decisions 块的显式 `Deviation:` 条目形成，不从普通散文猜；
报告、记忆块快照、diff 统计原子写进注册表，
`done` 之后再 `wait` 仍返回同一份。

#### 9.3.6 父 agent 的工具：看仪表盘，必要时传话

- `threads(ids?)`：非阻塞快照，一张小表——id、角色、状态、最近活动距今、步数、花费、一行进度（取线程 progress 块最后
  一条）、在等输入则附问题正文、diff 统计。**默认增量**（第 8.7 节），一次约两百 token。
- `wait(ids?, timeout_ms?)`：同一张表的阻塞版本，任一线程状态变化或超时返回，超时是正常结果；`done` 的线程附完整报告。
  未显式给截止时只使用 Host 请求上限（当前 1 小时，服务会提前 5 秒正常返回 `timedOut`），不按缓存 TTL 唤醒；这是父
  "让出去等"的唯一方式。
- `read_thread(id, what?)`：`what` 默认 `blocks`（progress / decisions / errors 块），其次 `report`，最后 `steps`（转录切片，
  带游标，走句柄）。默认值决定用法：父想知道"它在干什么、决定了什么、卡在哪"时拿到的是结构化摘要，不是十万字对话。
- `send(id, message)`：带"来自父 agent"标记进线程，能唤醒 idle 或 waiting 状态。
- `kill(id)`：停止执行、保留结果；收集完成后的目录按 9.3.4 回收，显式 keep_worktree 则保留目录。

线程那边只有两件：结束时报告自动生成；中途一个 `ask(question)` 进入 `waiting-for-input`。

这是"看仪表盘 + 必要时传话"，不是 agent 之间聊天：指令单向（父到子的 `send`、人到子的直接对话），结果单向（子到父的
报告与 Zone 2 状态行），状态由 host 拥有、双方读同一份。Cognition 反多 agent 的文章反对的正是 agent 之间来回对话——
上下文互相污染、token 烧在协调上。这里协调成本被压到几行结构化状态，"卡了没"的判断从父 agent 挪到 host 传感器，父的
注意力留给"接手、指引、还是等"。防轮询：`threads` 的"无变化"行、工具说明里的"要等就用 `wait`"、观察类调用计数。

#### 9.3.7 增量视图与游标

`threads` / `wait` / `read_thread` 全部按第 8.7 节工作：host 为每个（观察者，线程）对保存游标——上次展示到的事件序号、
上次展示的状态、progress 块版本。每次只返回每条线程一行头加变化量：状态迁移（变了才写）、`+N 步`、`+K 次工具调用
（grep×3, edit×2）`、progress 块新增的行、decisions 新增的条目、diff 统计增量、期间的错误。`waitingFor` 是例外，只要还在
等就每次都显示——它是要行动的东西。无变化就是一行。压缩时 host 重置该会话的观察游标，之后第一次查看回到全量。Zone 2
里的活跃线程行不用游标——Zone 2 每回合重生成，天然是快照。

#### 9.3.8 UI 投影

父会话有一个线程侧栏：每条线程一行，状态、徽标（等输入、完成、卡住）、花费、diff 大小；点开就是完整聊天，可以直接说话；
从父对话任意消息处"从这里开一条线"；讨论线与实现线以标记区分，讨论线可一键转为实现线；线程面板可显示归档并沿原会话/结果恢复。子线程
的消息**绝不**推进父对话正文——父那边只有 Zone 2 的状态行，用户那边靠侧栏徽标。Fleet 面板的卡片与侧栏读同一份注册表。
当前 session state 在宽屏是右 rail，在窄屏/移动端由带数量的按钮打开项目统一 overlay；两者共享同一 Host 投影和 UI 状态，不因
设备形态复制线程、blocks 或知识数据源。

## 10. Profile

### 10.1 与 Workbench Profile 的关系

[composable-workbench.md](composable-workbench.md) 的 **Workbench Profile** 选择 surface 的 Shell 与贡献点。
**Agent Profile** 声明工具、技能、团队目录、上下文/验证策略、权限默认值与知识库扩展，属于一次执行配置（D-072）。
两者不合并身份：同一会话在桌面 IDE 和手机布局中打开，不因此改变工具或权限；切换布局也不要求新建 Pi session。
可以用一个产品预设同时建议两者，但运行绑定独立。**模型槽位的值仍 user-only**，Agent Profile 只声明需要的槽位。
Agent Profile 的实际绑定随 Run/配置世代记录，单会话实验覆盖先沿已有 launch 接缝提供；完整 RunManifest 待真实消费者逐步收敛。
这是目标契约，当前还没有通用 Agent Profile/RunManifest 的完整生产实现，状态见 plan 0.7 与 status。

### 10.2 `code`（v1）

本文档第 5–9 节即其规格。工作区形态：仓库；验证器：编辑后诊断、可选测试门、review 传感器；权限默认由活动的
`pi-permission-system` 管理，插件缺席时由原生 fallback 接管 Harness 工具（第 9.1.2 节）。

### 10.3 `research`（第二个）

基本是 `code` 的超集：编程工具 + 文献检索（arXiv / Semantic Scholar / OpenAlex 等公开 API）+ PDF 全文抽取与索引 +
引用完整性检查（引用是否存在、论断能否定位到原文段落）+ notebook / 数据工具 + 知识库中的 `paper` / `claim` /
`citation` / `experiment` 节点与 `cites` / `supports` / `contradicts` 边。Shell 需要 PDF 阅读面、notebook 面、
引用面板作为普通 contribution。交互模式采用分钟级、人在环、带检查点的半自主研究（Deep Research 类系统的验证
路线），不做批处理式 AI Scientist。知识跨会话积累是这个 profile 的核心价值，也是第 7 节 schema 从第一天就是
workspace 级、跨会话的原因。

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

P0、T1/T2/T3 核心和 D-076 已交付；当前直接实施工作状态/集成、默认记忆、窗口读取/explore，以及各自独立的产品调用点。
单会话配置与归因随相关能力完成，T4、完整 RunManifest、数据库迁移或沙箱不作为共同前置。下面是总体范围，实际顺序按 plan 0.7。

0. **前置**：对齐 Pi 版本并在该版本上复核第 4.1 节的钩子形状（已完成，D-001：0.84.3）；恢复的 coverage 从计划级二值改为路径级（见
   [native-workspace-recovery-design.md](native-workspace-recovery-design.md) R1），否则 `bash` 注册为 `process`
   writer 后几乎每一轮都会被标为 incomplete，组合回滚在实践中消失。
1. **工具与 host 服务**：`harness-tools.ts`（`bash` / `grep` / `edit` / `write` 覆盖，`apply_patch`、`get_output` /
   `write_to_process` / `kill_shell`、`diagnostics`）、shell 监督器（按环境选解释器、PTY、login 会话 shell、自动转
   后台）、按路径的编辑锁、`tool_result` 层的通用句柄截断、worker→host 类型化请求、第 4.2 节违规修复、第 8.6 节计数器。
   `bash` 优先——在 Windows 上一天内可感。（`todo` 依赖 `block` 存储，随第 2 阶段交付。）
1b. **web**：`webfetch` / `websearch`、抓取服务（SSRF、提取、PDF 转文本、缓存、Electron 离屏渲染）、搜索 provider 抽象、
   来源面板。可与 2 并行。
2. **上下文层**：Zone 2 组装与 host 观察者、记忆 agent（fork 同前缀、门控与事件触发、块编辑操作）、`todo` 与计划面板、
   接管压缩、知识库 v1（`event` / `session` / `block` / `knowledge` 四种节点，`recall`、知识建议托盘，稀疏 + 图模式
   先行）、embedding provider 抽象（远端优先，本地选装其后）、模型槽位设置。
3. **检索与子 agent 层**：`explore` 管线（多路召回、当前原文读取、单元排序与一次呈现；按 D-173 收敛职责与调度）、
   `file` / `symbol` 节点与 LSP / Git 采集器、`related`、LSP 导航工具（`symbols` / `definition` /
   `references` / `hover`）；原生子会话 worker 运行时按**线程**形态（第 9.3 节）交付：host 持久化的线程注册表与状态机、
   worker 丢失恢复、host 观察的活性与循环检测、`dispatch` / `threads` / `wait` / `send` / `read_thread` / `kill`、角色目录
   与独立模型槽位、原生工作分支与按需物化、集成与回收、事件驱动等待（缓存保活可选）、观察游标、线程侧栏与讨论线；默认 review 传感器。
3b. **权限纵切**：Host 静态授权与 scope、`pi-permission-system` 单一提示所有权、原生 Harness fallback、Settings 与 Smart fallback。可与 3 并行。
4. **默认 runtime**：内置钉住的 Pi。
5. **外部 agent**：host 服务的 MCP 门面、ACP host、能力协商；届时重新评估协议兼容策略。
6. **research profile**：复用已具备的工具/知识库/文档能力，直接建设文献采集、引用核验与 Shell 面，不等 1–3 全部长尾任务结束。

### 12.2 历史决定与实施选择

历史决定（后续修订以当前正文为准）：2026-09-02 的 edit v1 使用直接写盘 + reconcile，后续按 5.4/9.2.5b 实施版本化视图；
`piarium serve` 检测到桌面 host 在运行时复用它而不起第二个（第 7.1 节）；子 agent worktree 由父 agent 的 `merge` 工具
合并、Git 面板可选审阅（第 9.2.5b 节）；`event` 默认保留 30 天（第 7.2.1 节）。

2026-09-04 的决定（D-030–D-038，其中默认和回放政策已由 D-078 修订）：Pi 0.84.3 消费 `session_before_compact` 返回的
`{ compaction }` 并跳过自身摘要，`session_compact` 随后触发且 `fromExtension: true`（D-022，前置实验结论，第 8.4.2 节
第 2 档据此实现）；线程对象拆为 Thread + ThreadRun、状态正交（第 9.3.1 节）；wait 默认事件驱动、缓存保活可选
（第 9.2.6 节）；输出引用分 `OutputRef` / `TranscriptRef` 两级、偏移统一 UTF-8 字节（第 5.1 节）；权限三层与 Host 静态
授权（第 9.1.2 节）；设置按字段所有权（第 5.10 节）；记忆三态与默认 takeover 见第 8.4.1/8.6 节（D-081）；父会话删除
时线程停下并归档、不弹第二个模态（第 9.3.4 节）。

**D-078 已收口的决定**：工作状态/内容寻址结果、物化、草稿基线与版本化集成正式采用；explore、记忆与自动 review 按第 1.3 节
默认交付；回放不再决定能否启用。以下仅列实施时的具体选择，不是暂停清单：

| 范围 | 已确定方向与实施选择 |
| --- | --- |
| 记忆 | 活动模型、memory_edit、分支/块修订/实际 entry 覆盖；默认 takeover，off/assist/session override 与失败可见，缺证据逐次回到 Pi，取消辅助分项统计（D-081） |
| 工作状态与结果 | Host 原生内容对象/树/分支/Integration，Git 基线与物化可复用；一次性迁移、独立引用、真实执行写回，见 9.2.5b |
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
- [composable-workbench.md](composable-workbench.md)：profile 对象在此扩展为同时承载 harness 绑定。
- [native-workspace-recovery-design.md](native-workspace-recovery-design.md)：`bash` 的 `process` writer 注册与
  `edit` / `write` 覆盖共存于同一 mutation boundary。
- [security.md](security.md)：知识库内容按工作区数据对待；`webfetch` 复用其私有网段阻断与 cookie opt-in 规则；worker
  不持有 host 凭据。
- [extension-compatibility.md](extension-compatibility.md)：第三方 Pi 扩展不受本契约约束，也不由 harness 管理；
  `pi-web-access` 启用时 harness 的 web 工具让位，其适配器不变。
