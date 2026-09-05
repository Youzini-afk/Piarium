# Piarium agent harness

Status: design accepted; code profile v1 in delivery — per-capability state is in agent-harness-status.md, not here

Last updated: 2026-09-05

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
| 检索分层 | 第一层 grep/glob/read 由 ripgrep 与检索子 agent 拥有；第二层结构、第三层记忆由知识库拥有；知识库不参与第一层 |
| 知识库 | 优先保留 TriviumDB 嵌入式，每 host 每 workspace 一个 `.tdb`；Application Host 是唯一写者。TriviumDB 非不可替换依赖，具体问题先交用户联系作者处理；当前不迁移 SQLite、不建双写权威（D-071） |
| embedding | 可插拔 provider；远端 API 一等（含任意 OpenAI 兼容端点）；本地模型选装下载；未配置时知识库以稀疏 + 图模式工作，embedding 是增强不是依赖 |
| shell 形态 | PTY（复用终端运行时，后台 shell 即终端 tab）；持久会话 shell 保持 cwd / env / venv；stdin 开放且 harness 永不代写；等默认时长后**自动转后台**而非超时杀死；配套 `get_output` / `write_to_process` / `kill_shell`（Devin CLI 与 Codex `unified_exec` 的共同形状）；Git Bash 为默认解释器但 Windows 原生工具可从中调用 |
| 工具并发 | 沿用 Pi 默认并行；只读工具并行，`edit` / `write` / `apply_patch` 按路径加锁（不同路径并行），`bash` 家族 `executionMode: sequential`；不做 apply model |
| shell 环境 | 解释器按工作区环境选定（原生 Windows → Git Bash，WSL → wsl bash，远程 → 远端 shell），用户可覆盖，模型不按次选；login shell 继承用户工具链；环境变量只改交互与显示，**不设 `CI=1`**，locale 探测不硬编码 |
| web | harness 自做 `webfetch` / `websearch`，参照 `pi-web-access` 能力清单原生实现（来源面板、凭据进 Pi auth、独立浏览器 profile、GitHub 走 octokit）；SSRF 复用 security.md；跨域重定向不跟随；搜索走用户配置的 API provider，无真实 provider 就不注册；桌面端 Electron 离屏渲染 JS；`pi-web-access` 启用时自动让位 |
| 模型槽位 | **每个用模型的能力一个独立槽位**（explore / retrievalAgent / quickImplement / hardImplement / frontend / review / check / reader / suggestions / permissionJudge），用户填、预设只填表；仅 hardImplement 与 review 默认主模型，其余未配不调用主模型。memory 使用活动会话模型，是明确的内置例外；按 8.4 默认提供，显示实际辅助用量与费用，不承诺缓存命中（D-078） |
| 可关可换 | 每项 harness 能力有独立开关，关掉后行为明确（回 Pi 默认或不注册）；默认不按插件存在与否偷偷改变行为，已定义明确共存契约的例外是 web 工具对 `pi-web-access` 让位，以及原生权限 fallback 对 `pi-permission-system` 让位；开关下一会话生效；设置按**字段所有权**决定用户级与工作区级谁说了算（第 5.10 节），能力可用性不是设置而是 host 注入 |
| 编辑格式 | 跟模型家族走：`edit`（str_replace）与 `apply_patch`（Codex 语法）并存，按会话模型启用；两者走同一 mutation boundary |
| OS 沙箱 | Windows 沙箱不在交付计划中（用户选择，D-071）；macOS/Linux 留作后续候选。现有权限与路径边界保持，不把工具限制或 worktree 称为 OS 隔离 |
| 缓存契约 | Zone 0 会话内冻结；Zone 1 只追加、序列化确定；所有前缀失效操作批处理到压缩时刻 |
| 工作状态归属 | 主 agent 对记忆系统零义务，plan/todo 服务自身注意力；keeper 维护记忆，Host 拥有事实与分支版本。记忆按正式路径默认提供，可关闭；keeper 只能标记 plan 状态，不能改其结构。当前代码仍是 opt-in assist，后续按 D-078 更新默认与用量投影 |
| 压缩 | 正式默认路径使用 keeper 块与 Host 事实，逐次检查分支、块修订、实际 context entry 覆盖与必要来源，使用 Pi 安全切点；缺覆盖仅该次交还 Pi。D-076 水位重启会丢失，按实际结果回退；默认接线属于实施任务，不等待付费实验或回放批准（D-078） |
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
| 度量 | 记录错误、重试、输出、缓存、主/辅助用量、耗时与人工介入；直接测试验证正确性，真实使用驱动优化。T4 和检索对照按问题需要使用，不是开发或默认启用门禁；Zone 0 稳定性由契约测试保证（D-078） |
| harness 的 UI 投影 | 后台 shell 成为可附着的终端 tab；输出句柄在工具卡片内可展开全文；Zone 2 默认折叠、可查看；压缩边界在时间线可见；线程在父会话侧栏成列、点开即完整聊天、可从父对话任意位置"从这里开一条线"（第 9.3.8 节） |
| 检索 | grep → 默认提供的 explore（确定性召回、结构展开、版本化正文与关系打包）→ retrieval 角色。explore 接通即注册，可用来源逐步扩展；intent/judge/查询修复按已配置 explore 槽位和查询需要运行，无槽位走纯算法；不等完整图、向量或独立评测（D-078） |
| 未保存内容 | Agent 默认看到发起用户消息的窗口草稿，无显式开启/绑定操作；来源与版本由内部协议自动传播，其他窗口仅打开或聚焦不抢占来源。Host 读取不可变快照，surface 保持缓冲所有权（第 6.1 节，D-071） |
| 检查角色 | `check` 有读取与执行能力，测试/构建可能写缓存和生成物；不称只读 agent，不规定 bash 只能执行无写入命令，不强制一律使用独立副本（D-071） |
| 模型家族适配 | 一份基础 + 极薄 overlay；先做 Anthropic 与 OpenAI 两档，其他 provider 走通用 |
| Pi 上游 | 不贡献回上游；Pi 更新后重新适配。能 wrap 的 wrap（`edit` / `write` / `grep` 装饰 Pi 实现），只有 `bash` 重写 |
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
| 工具覆盖 | `customTools` on session create | 同名 `ToolDefinition` 覆盖 `bash` / `edit` / `write` / `grep`；新增 `apply_patch`、`get_output`、`write_to_process`、`kill_shell`、`diagnostics`、`todo`、`dispatch`、`wait`、`webfetch`、`websearch`；`executionMode` 按第 5.9 节声明 |
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
| `grep` | 覆盖 Pi | 并行 | rg 镜像 schema，分组排序，句柄 |
| `edit` / `write` | 覆盖 Pi | 不同路径并行，同路径串行 | 参数不变，附加新引入的诊断 |
| `apply_patch` | 新增 | 同上 | Codex 语法多文件编辑，按模型家族启用 |
| `read` / `find` / `ls` | 实体目录复用 Pi；虚拟分支走同名适配 | 并行 | 同一分支读视图，结果经句柄截断（9.2.5b） |
| `get_output` / `write_to_process` / `kill_shell` | 新增 | 读并行，写与杀独占 | 后台 shell 与输出句柄；对运行中 shell 默认返回上次读取之后的增量（第 5.5 节） |
| `diagnostics` | 新增 | 并行 | `pending` 后按需查 |
| `todo` | 新增 | 串行 | 主 agent 自己的计划（第 5.6 节） |
| `explore` | 原生，接通后默认注册 | 并行 | 确定性搜索与结构展开、带版本的代码单元；模型机制按已配置槽位使用（第 5.7、6.1 节） |
| `dispatch` / `threads` / `wait` / `send` / `read_thread` / `merge` / `kill` | 新增 | `dispatch` / `threads` / `read_thread` 并行、`wait` 独占当前步、`send` / `merge` / `kill` 串行 | 开一条线程交给团队中的一个角色（异步）、看增量状态、订阅等待、给线程传话、读它的记忆块或报告、把线程 worktree 三方合并回来、终止（第 5.7、9.2、9.3 节） |
| `webfetch` / `websearch` | 新增 | 并行 | 抓取与搜索，SSRF 策略、阅读子 agent、provider 抽象（第 5.8 节） |
| `related` / `recall` | 新增（第 3 阶段） | 并行 | 知识库结构与记忆（第 6.2、7.4 节） |
| `symbols` / `definition` / `references` / `hover` | 新增（第 3 阶段） | 并行 | 真实 LanguageSupervisor 导航；路径受 Host authority/scope 约束，位置对 agent 一基（D-051） |

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
可切 PowerShell。此外 Windows 原生工具随时可从 bash 内调用（`powershell.exe -c ...`、`cmd //c ...`），harness 不
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
  终端 tab 显示原始字节。**现状**（D-013）：监督器复用的是 PTY 模块（`node-pty` / `bun-pty`），尚未经 terminal runtime
  创建，因此后台 shell 还不是终端 tab；"接进 `lib/terminal/runtime.ts` 的 `createTerminalSession` / `attachTerminalSession`"
  是这条边界的未兑现部分，记在状态矩阵的 Blocker 列。哨兵格式与默认环境变量集在 `lib/harness/DOCUMENTATION.md`。
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
- 声明 `executionMode: "sequential"`：同一批工具调用中有 `bash` 时整批串行（Pi 的批次语义），因为它可以触碰任何路径。
- 执行期间向 mutation authority 注册为 `process` writer（`WRITER_MODES` 中已存在的模式），使恢复系统知道本轮
  文件覆盖不完整。这是恢复设计已预留的语义。

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

### 5.3 `grep`（覆盖）

覆盖 Pi 内置 `grep` 而非新增 `search`，以保持同名覆盖原则。参数 schema **忠实镜像 rg 的命令行 flag**（`pattern`、
`path`、`-i`、`-A/-B/-C`、`--glob`、`--type`、`--fixed-strings`、输出模式 files / content / count），让模型训练时学到
的用法直接迁移；`limit` 默认 100 条命中，完整结果仍存入句柄。这是 Claude Code Grep 的做法；Devin CLI 同样提供 `grep` /
`glob` 工具且 Fast Context 只用它们；Codex 没有专用 grep 工具而走 shell 里的 rg；Cursor 是 rg 工具加一个语义
`codebase_search`。

- 走 host 的 `createWorkspaceContentSearch`（ripgrep，尊重 `.gitignore`，有界）；permission 的 ignore 模式编译为
  `--glob !pattern` 传入。
- 排序按文件分组；文件按命中密度、最近修改（mtime 与 Git status 中 modified 加权）、路径偏好（源码优先于测试、
  浅路径优先）三信号排序。目标是第一屏就是模型要的文件。
- **不含符号模式。** 符号导航（定义、引用、工作区符号、悬停签名 `hover`）是独立的 LSP 工具，第 3 阶段与 `related` 一起
  交付——Claude Code 也把 LSP 与 Grep 分开，Devin 的 `hover_symbol` 与定义、引用并列。grep 的 schema 保持与 rg 一致，
  不混入 rg 没有的语义。
- 超时（默认 20 s）时若已有部分输出，丢弃可能不完整的最后一行后返回部分结果并注明"未搜完"；零输出才报工具错误。
  模型必须能区分"没搜完"与"没搜到"。
- v1 只搜磁盘；叠加未保存缓冲是 v2（恢复 v5 已有 host 向编辑器索取脏状态的先例）。

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
"非平凡任务先计划"，harness 不检查它是否被调用，也不因其陈旧而提醒。当前低于 0.6 自动确认的实现待按 D-078 修改。

### 5.7 `explore`、`dispatch` / `wait`（新增）

**`explore(question, paths?)` 是正式默认检索能力**，规格与依赖统一见第 6.1 节。它用确定性搜索与结构展开减少找定义、
找引用等机械跳转，返回按当前来源重读、带版本和关系的代码单元；不承诺固定时延，也不声称结构查询能替代所有跨文件推理。
纯算法路径先行，意图扩展、候选裁决和查询修复按查询需要接入；没有 models.explore 就没有模型调用，永不回退主模型。
当前 v1 仍未接线；补齐当前正文读取、真实句柄与生产调用后默认注册，不等独立回放、所有可选来源或上下文去重优化完成。

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
| `explore` 管线中的 LLM 步 | 清空 `models.explore` 即纯算法模式；`explore` 工具本身另有开关 |
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

对代码，agentic grep 已被 Claude Code 与 Cognition 的实践证明优于 embedding RAG：代码检索的查询多为精确的符号名、
字面量、错误信息。因此三层各有归属，知识库不参与第一层。

### 6.1 第一层：文件里有什么

三级升级，每级更贵，主 agent 自己判断用哪级：

**第一级：`grep` 工具。** rg 镜像、分组排序、句柄（第 5.3 节）。知道确切符号或字面量时一次调用就该给出第一屏正确的
文件。

**第二级：`explore` 工具——用结构查询减少机械跳转（正式实施，D-078）。**
目标是尽快返回主 agent 能直接使用的代码单元及其关系。确定性召回、结构展开、版本化正文和关系打包作为默认实现，接通后投入使用。
工程测试保证来源、版本、路径与输出正确；实际任务用于优化召回和延迟，不作为批准这个方向的前提。依赖与实施形状见 plan 3.2。
当前磁盘纵切已接通实际 rg、多路径与 actor scope、Documents 版本化连续正文和会话 OutputStore。查询后文件变化/不可读会明确标记
stale/unavailable，不能补造片段。结构展开、窗口草稿与可选模型处理继续沿本节实施；现有词项搜索不冒充这些来源已接通（D-079）。

**设计依据与性能边界。** 以下研究记录说明取舍，不是必须复现的上线门槛；真实使用发现反例时修正算法及相应结论：

- H1 *结构查询减少机械跳转*：Host 可从定义、引用、测试关联和栈帧取得下一批候选，但不能据此声称能生成所有新的因果假设。
  直接据此实施；节省多少时间和调用，按 Piarium 实际使用记录。
- H2 *召回与成本比挑选更重要*：OpenLocus 的 BEA 系列在同预算 BM25 面前全部 mixed，FD1 失败分解最大的桶是"正确文件未进
  候选池"与"花了时间没换来质量"，候选缺席时改进挑选只能救回 1/119。边界：外部 benchmark（ContextBench / RepoQA）Python
  frame 与合成任务，不是 Piarium 用户任务。
- H3 *部分问题需要目标与支撑的组合*：B16-J 是人为构造歧义支撑的合成任务；其专项报告记录目标加支撑 8/8、仅支撑 2/8、仅目标 0/8。
  这属于 *bounded synthetic evidence*，不能外推为所有查询必须带支撑。精确定位可能只需目标，关系分析再按问题保留支撑。
- H4 *确定性内核能把答案送进前十*：FRK-B 四路索引（稀疏词 + 符号名 + 路径 + AST 片段）在 R14-S sanity 套件上 p95 < 10 ms、
  文件召回@10 very high、召回@1 medium。边界：小规模 sanity 套件，报告明确 `runtime_default_method_scale_claim: false`；
  后续 FRK-E 结论是 *no proxy lift over best baseline*。所以"模型只需十选一"是待验证假设，不是前提。

来源固定到提交：[OpenLocus 研究结论](https://github.com/Youzini-afk/OpenLocus-Lab/blob/eecd28b218b2be211074db2bdd9e7dad43100336/docs/zh/current-research-conclusions.md)、
[B16-J 专项报告](https://github.com/Youzini-afk/OpenLocus-Lab/blob/eecd28b218b2be211074db2bdd9e7dad43100336/docs/en/b16j-ambiguous-support-conjunction.md)、
[FRK-B](https://github.com/Youzini-afk/OpenLocus-Lab/blob/eecd28b218b2be211074db2bdd9e7dad43100336/docs/en/bea-v1-frk-b-fast-retrieval-kernel-prototype.md)、
[FRK-E](https://github.com/Youzini-afk/OpenLocus-Lab/blob/eecd28b218b2be211074db2bdd9e7dad43100336/docs/en/bea-v1-frk-e-downstream-utility-probe.md)；
[OCE 固定版本](https://github.com/oce-ai/oce/tree/a359272560bbbdb321055aaed6c16ba1f4e06887)。本地检出路径不作现行设计依据。

**三个进程，三份所有权。** 管线需要的输入分属不同进程，不能都写在 host：

| 归属 | 组件 | 拥有的输入 / 职责 |
| --- | --- | --- |
| pi-host | `ExploreCoordinator` | 问题、实际请求中仍可见的片段/版本覆盖、会话轨迹、模型槽位/凭据、可选模型调用与用量；真实 tokenizer 可得时才计精确 token，否则标为估算 |
| Application Host | `ExploreEngine`（纯确定性） | rg、LSP、符号图、git、Documents 脏状态、恢复日志、shell 输出、OutputStore；每个来源带状态与 provenance；不调模型 |
| UI surface | 默认窗口草稿与可选焦点提示 | 用户消息自动携带窗口来源；草稿快照与焦点均带 surface/generation/revision。正文经受控读取通道，不进广播；不让 worker 自报 `session.snapshot` 成为来源权威 |

**默认读本窗口草稿，内部自动区分来源。** 用户在一个窗口发起消息，Agent 默认可读该窗口的未保存内容，不要求显式开启或绑定。
后台工作沿用最近一次已接受用户输入的窗口来源；从另一窗口发消息会自动更新来源，单纯打开同一会话或改变焦点不会抢占它。
Host 按来源读取带版本的不可变快照，UI 保持可变缓冲的所有权。每次读取记录 workspace/checkout、来源、revision、hash 和 span；
这是本次已读文件的版本集合，不是全仓库强一致快照。窗口断开后已捕获快照可按其版本使用，拿不到最新内容则显式 unavailable/stale；
磁盘替代只能标为磁盘，不能冒充当前草稿。没有 surface 的 headless 任务使用磁盘。

**当前缺口**：Documents dirty publication 只有路径和版本、没有正文；LSP 缓存也不能代表某个窗口的权威草稿。
正文快照与自动来源传递仍待实现。它们接通前，原型只能声明磁盘读取并提示 dirty/stale 风险，不能把产品目标写成已交付能力。

**管线与真实依赖。** 各阶段不是全并行，join 点如下（→ 表示依赖）：

```text
Coordinator: 问题/来源 → Engine 请求 → 已物化候选 → 可选模型处理 → Engine 确定性打包 → 当前请求可见性投影
Engine:      seeds → 可用来源召回 → 结构展开 → 当前来源重读/授权 → RRF/候选 → bundle packing / OutputStore
可选 intent 可与初次召回并行；补查需 Coordinator 再发明确请求；judge 必须等待候选正文。
```

- *seed*：问题里的标识符（保留语言允许的 Unicode 字母、组合字符、单字符及 `_`/`$` 等形式）、引号字面量、路径片段、错误信息；栈帧 `file:line` 解析；上下文
  种子由 Coordinator 提供（主上下文文件、会话触碰、上一次结果）与 UI 提示（若有）。问题类型分类同时支持中英文线索
  （在哪 / 哪里 / where；怎么 / 如何 / how；改了 / 影响 / what if；为什么 / 报错 / why / 有栈）。
- *fan-out*：rg（磁盘）；`lsp.symbols` 当前需要一个文件来选择语言 provider，因此按种子文件逐语言发起，不是全仓库通用符号
  索引；知识库符号搜索当前是 JS 扫描 + 字符串计分（不是 AC / BM25），作为退化通道；有 embedding 时语义召回。
- *expand*：`lsp.definition` / `lsp.references`（有界；**`references` 不是调用图**，当前没有 call hierarchy，不写"调用图 BFS"）；
  符号图目前只有 `file → defines → symbol`，`references` / `calls` / `imports` 边与 PageRank 都未接，扩展先只用 defines 与 LSP；
  git co-change 与测试 ↔ 源码配对是待建服务。**LSP 返回的路径与所有派生出的支撑路径都要重新经过 workspace scope / realpath
  授权**，不能只校验用户传入的 `paths`——定义可以跳进 `node_modules` 或工作区之外。
- *fuse*：用 **RRF** 按各路名次融合，不生硬相加不同量纲的分数；先保留来源身份与确定性的并列顺序，相关来源不冒充独立证据。
  RRF 分差不是答案置信度。没有目标、来源不可用、版本冲突等可观察缺口可提示补查；“缺少解释所需配置”等语义判断仍是待验证推断。
- *slice*：按 LSP `documentSymbol` 的 `range` 切完整符号（它本身区分 `range` 与 `selectionRange`，签名与函数体的问题在这里
  不存在）；无语言服务器时 tree-sitter 兜底，再退化到行窗口。**不**照搬 OCE 的"300 字符以下并入邻居"——那是修它 AST 切块的
  列切分伪影，套到 `documentSymbol` 上会把合法的小函数、声明、配置项误合并。
- *pack*：目标与问题所需支撑组成 bundle，支撑允许为空。打包保留关系，省略支撑要注明；不预置 co-change/test/reference 的普遍删除顺序，
  不让平铺覆盖选择器拆散必要组合。Host 计 UTF-8 字节，Coordinator 对最终请求另做 token 计量或带标签的估算。
- *模型增强*：intent、judge 和受限查询修复按已配置槽位与查询需要运行，不强制每个问题全开。judge 在候选物化后只返回候选 ID 与理由，未知 ID 拒绝；若使用补查，
  只接受类型化搜索/导航操作并重新授权路径，不接受 shell。正文标为不可信数据。迟到结果是否采用由 Coordinator 决定，调用结局与采用状态分开记录。

**结果必须诚实到来源级。** 每来源保留 `not-requested | ready | empty | unavailable | failed | stale | timed-out | cancelled`；
每次模型调用保留 `not-requested | succeeded | failed | timed-out | cancelled`，另记结果 used/ignored/none 和用量 reported/unavailable。
失败、超时、迟到但成功均按实际记录，已知费用照常归因，未知费用不补零。每个候选有 ID、来源版本、provenance 与关系，授权后才入 OutputStore。需要特别明确：`OutputStore` 句柄是经鉴权的会话局部临时存储（session-local ephemeral storage），用于长输出跨工具调用的安全分页读取，生命周期跟随会话进程与世代，不是持久模型资源或永久知识条目。
`inContext` 必须证明**同一 revision 的相关 span 仍在实际请求中**，并考虑截断、压缩、分支与请求世代；read 发生过或路径相同都不够。
覆盖未知就返回正文；只有覆盖成立的片段才换成指针。低置信提示说明实际缺口，`retrieval` 未配置时不建议调用一个不存在的角色。
**永不跟随主模型**：`models.explore` 未配置就是纯算法模式。

**参数按用途处理。** 身份、路径授权和取消传播是实际边界；延迟、输出量和服务负载复用软预算与已有背压。references 数、历史
窗口、候选量等可按实际服务能力设可调整的工作默认，不为了缺完整评测就停工，也不把未经定标的数字变成产品硬拒绝。见 plan 3.2。

**反馈：第一版只记录，不学习。** "模型随后 read / edit 的文件"不是无偏标签：排前的文件更容易被看到（位置偏差）；支撑文件有用
但不会被改；分析任务没有 edit；explore 已给完整代码后模型不再 read 恰恰是成功；压缩后 `inContext` 的旧 step 不再可靠；文件
read 后可能已变。因此按工作区记录 telemetry（问题、类型、返回包、各来源状态、后续 read / edit、耗时），**不自动改权重**；若将来
学习，至少需要独立标签、随机探索或 propensity 校正，以及版本化、可重置的实验状态。

**交付与优化。** 完成可用来源的检索、当前正文物化、授权、真实 OutputStore 与 worker 工具接线，直接验证这些行为后默认注册。
缺 LSP、向量、co-change 或上下文覆盖优化时分别说明来源状态，仍交付可用结果；未知 inContext 覆盖时返回正文，不阻塞检索。
意图扩展、裁决和查询修复按需求与模型槽位实现，失败不丢弃已取得的确定性材料。

出现召回或性能问题时，可用固定 query/版本/目标 span/支撑与 grep、BM25 比较；记录各路真实输入、输出、耗时与用量，不从答案
生成查询，不用“后来编辑过的文件”充当完整正确上下文。T4 记录可辅助重现，独立 retrieval replay 和统计不劣证明均非开发前置。

**第三级：`retrieval` 角色——纯 LLM 的多轮检索 agent。** 团队目录中的一个角色（第 9.2.2 节）：受限只读工具（`grep` /
`read` / `find` / `explore`），沿用实际 runtime 工具并发和用户预算，不照搬专训模型的固定调用数或轮数；返回排好序的片段与回答。
它处理需要跨文件推理的
"X 是怎么流经 Y 的"。模型用 `models.retrievalAgent` 槽位，**未配置则该角色不注册**。中间过程留在它自己的上下文里。

### 6.2 第二层：这段代码和什么有关

由知识库拥有。节点是符号与文件，边是 `imports` / `calls` / `references` / `defines`（来源为 host LSP 与
Git），payload 是路径、语言、最近修改时间、dirty 状态。这是 Aider repo map 的图 + PageRank，直接以 TQL
表达：

```sql
SEARCH VECTOR $q TOP 20 AS seed
WITH seed
EXPAND seed [:calls|references*1..2] AS related
WITH related
pagerank related AS scored
WITH scored
WHERE scored.modified_at > $since
RETURN scored, graph_score(scored) AS rank ORDER BY rank DESC LIMIT 15
```

暴露为工具 `related(anchor, hops?, labels?)`。

当前已交付的第一纵切（D-059）只在 Documents 权威写后事件上，复用已运行的 LanguageSupervisor 建立真实
`file → defines → symbol` 图；不做启动全仓扫描，LSP 暂不可用时保留最后图，权威空结果才清旧符号。`references` / `calls` /
`imports` 边与 `related` 工具仍未接生产；它们不能通过对每个 symbol 无界请求 references 来伪装完成。

### 6.3 第三层：我们之前做过什么

由知识库拥有。轨迹信号（编辑 diff、终端命令与退出码、诊断、会话决定）**不追加进对话**，存为可检索事件；
Zone 2 只放 top-k 指针，正文由模型通过 `recall` 拉取。见第 7 节。

## 7. 知识库（优先保留 TriviumDB）

TriviumDB 是当前实现选择，不是不可替换的产品前提（D-071）。遇到具体问题先向用户交付版本、重现与影响，由用户联系作者处理；
当前不迁移 SQLite，也不建设第二个可写知识权威。上层使用 Piarium 领域操作，不暴露占位向量或 TQL 绕路。

### 7.1 归属与位置

Application Host 内一个 `knowledge` 服务，通过 napi 进程内加载 `triviumdb`，无服务、无端口。每 host 每
workspace 一个文件：`PIARIUM_DATA_DIR/knowledge/{hostId}/{workspaceId}.tdb`，与
`document-recovery/{hostId}/...` 同构，遵守"另一个 host 不继承同路径选择"的既有不变量。Application Host 是
唯一写者；session worker 与子 agent 只读（TriviumDB 的共享只读 Reader 模型）。

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

下面的 TQL、占位向量与分词记录针对当前钉住的 0.8.5 集成；不能推断最新上游仍有同样问题。向作者报告数据库本身的类型处理、检索
语义和能力边界，不要求数据库适配 Piarium 的领域模型。keeper 漏传版本、分支归属及代码分词策略由 Piarium 自己负责。

- **embedding 是可插拔 provider，远端一等，本地选装，缺省可无。** TriviumDB 存向量不产向量。2026 年的现状：
  代码专用远端模型（Codestral Embed、voyage-code-3、Gemini Embedding、Cohere v4）领先通用模型约 10 分
  （CodeSearchNet Python：voyage-code-3 80.8 vs text-embedding-3-large 70.8）；开源最强的 Qwen3-Embedding-8B
  与 nomic-embed-code 7B 权重 16–26 GB，笔记本跑不动；0.6B 级小模型在代码上明显落后，唯一体积例外是
  CodeRankEmbed-137M（768 维、521 MB、Python 78.4）。据此：
  - provider 列表：OpenAI、Voyage、Mistral、Gemini、Jina、Cohere，以及**任意 OpenAI 兼容端点**（Ollama /
    LM Studio / vLLM / TEI）——后者让想本地跑大模型的用户自带权重，Piarium 不捆绑。
  - 选装本地模型：按需下载，候选 CodeRankEmbed-137M 或 Qwen3-Embedding-0.6B，ONNX 走 `sherpa-onnx-node` 已引入
    的 runtime 路径。
  - **未配置 embedding 时知识库照常工作**：AC + BM25 + 图不需要向量，`related` 是纯图扩展，`recall` 退化为
    稀疏 + 图。最需要向量的是记忆召回与 research profile，不是代码检索（第一层是 grep）。
  - store 记录 `{provider, model, dim}`；默认 1024 维（Matryoshka 截断，所有主流模型支持），满足 QuIVer ≤ 3072。
    向量是**派生数据**：源文本都在 payload 里，切换 provider 触发后台重算并以 TriviumDB `GenerationStore` 原子
    发布新代，旧代由 Reader 租约保护。
  - 每个远端 provider 单独同意，与远程模型 provider 同一信任门。使用云端 LLM 时代码本已出机器，embedding 不是新的
    暴露类别，但可能是新的 vendor。
  - 需向 TriviumDB 确认无向量节点的支持；不支持则以最小维度占位向量建库并禁用向量检索路径。**已验证**（D-020）：
    v0.8.5 上全零占位向量的 `searchHybrid` 不报错但返回空结果，因此占位模式下 `recall` 走 JS 层扫描 + 词项匹配，
    向量路径只在配置了 embedding 时启用。需向作者确认数据库自身的纯稀疏入口、混合检索权重与零/缺失向量语义；全零向量不应被要求
    产生正常相似度，当前返回空不能未经参数/语义核对就定为数据库错误。占位向量是 Piarium 的绕路，不是数据库必须兼容的领域协议。
- **TQL 在 v0.8.5 上不可用于 payload 字段过滤**（D-019）：`FIND {type:"block", sessionId:"s1"}` 对字符串字面量报
  napi 类型转换错误。知识库当前所有查询用 `allNodeIds()` + `getPayload()` 在 JS 层过滤；`createIndex` 仍建，待 TQL 修复
  后启用。数据规模（单会话数百 event）下可接受，是 TriviumDB 侧需要修的项，不是 Piarium 的长期形状。
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

**正式默认与用户选择（D-078）。** 新默认维护块、注入 Zone 2，并在每次覆盖检查满足时接管压缩。实现连同实际配置、后台用量与错误
投影交付，不等待测试者或付费缓存实验。off 停止维护；record-only 只记录展示；assist 注入 Zone 2、仍由 Pi 压缩；takeover 启用逐次
覆盖检查。record-only 是可选诊断模式，不是默认路径的前置。现有代码 shadowMode:true 实际为 assist、缺省为关闭，尚未改成新默认。
迁移保留显式 off/assist；缺省采用产品新默认，按原始设置与版本区分历史默认，无法区分的旧值保留原行为，不覆盖用户选择。

**记忆 agent 的上下文。** 当前 assist（旧称 shadow）实现从 Pi 的 `context` hook 捕获本步真实 provider-neutral messages，在 `turn_end`
补上本次 assistant 与 tool results，复用活动会话的 system 与 model，只暴露 `memory_edit`，尾部追加当前块、游标与编辑指令。
输出必须是结构化块操作，由 Host 逐项验证、按本次前一项的结果顺序应用并记账；自由文本、陈旧 patch 与越过预算的操作都不写。
它没有文件与 shell 工具，不写持久知识（那走第 7.2.2 节的建议流程），`memory_edit` 也不进入主会话历史。

**版本与分支提交契约（D-076）。** block 修订记录写入时的 `sourceLeafId`；活动分支按祖先路径为每个 label 选择最近修订。
后代更新 copy-on-write 到当前 leaf，分支删除写 tombstone，兄弟仍继承共同祖先。keeper、todo、Zone 2、UI、compaction 与线程快照
使用同一分支视图；UI 的路径由 Host 从活动 Pi session 自动取得。更新、创建和删除在 Store 写队列内做 expected-revision CAS，
同一 patch 内的后续操作使用前一项返回的新修订；`plan` 只允许 keeper 标记条目。

keeper 覆盖水位只记录 `buildContextEntries()` 实际物化进其输入的 entry ID；部分失败或无 material 更新不推进。
水位在 block 写成功后更新，Host 崩溃窗口只会丢水位并回退 Pi，不会产生虚假的覆盖；当前不宣称它是跨 Host 重启的持久 checkpoint。
检查点证明机械处理区间，不证明保存了所有未来重要的信息；来源无法重新读取时仍须说明，不能用 hash 冒充正文。

**成本按真实调用记录。** keeper 使用活动模型但工具集不同，不保证命中主请求缓存；这不阻止默认交付。保留 memory_edit 输出协议和
session-local 模型归属，未返回有效操作就是未更新，不从散文猜操作。主/辅助请求分别记录实际 cache-read、用量、耗时与错误；
失败或无效操作也保留已知费用，未知用量不伪造为零。本地不自行发起付费记忆输出协议/缓存对照实验。
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

所有触发都以"有未整理的新轨迹"为前提，**没有任何按墙上时钟重复运行的触发**。所有值为可配置默认；计数器记录每会话的
记忆 agent 运行次数、token 与每次改动的块数。

与 Devin 的差异：Devin 的压缩**调用**一个 Cognition 专门微调的小模型识别历史中的 key details、events、decisions。
Piarium 没有这样的模型，替代品是**分工**——记忆 agent 持续把这三类信息维护成显式的块，host 维护事实，压缩时刻不需要
任何模型去识别它们。Letta 论文的结果支持这一分工：同等准确率下测试时算力约少 5 倍，上下文被反复读取时平均成本低
2.5 倍；同一论文也记录了反例——SWE-Features 上测试时预算很高时纯测试时算力有时精度更好，因此复述保持紧凑且只是
上下文而非指令。

#### 8.4.2 三档压缩

1. **清理工具结果。** 工具结果进入历史前可截断，历史中的清理集中在压缩或支持的 provider 请求投影中。是否有完整可读正文按来源
   判断，不从临时句柄或 TranscriptRef 推导。Anthropic tool-result clearing 会使相关缓存前缀失效并产生重新写入成本，后续请求可复用
   新前缀；不是“服务端清理免费保留原缓存”。见 [官方文档](https://platform.claude.com/docs/en/build-with-claude/context-editing)。
2. **替换（正式默认路径）。** 材料是 memory blocks、主 agent 计划与 Host 事实。接管前必须验证 MemoryCheckpoint：分支祖先路径
   匹配，待移除历史落在已处理的连续区间，blocksRevision 与检查点同次提交，必要来源可读。仅有 `updatedBy: memory-agent` 的块不够。
   例如处理到第 100 条而 Pi 准备保留第 121 条之后，101–120 的缺口不能靠 stale 提示丢掉。只可用 Pi 支持的安全切点保留缺口，或完成
   维护后重检；不能安全满足时交还 Pi 默认压缩，不自行切断 tool call/result 配对。覆盖检查已实现（D-076）：使用稳定 entry ID 集合
   追踪 keeper 实际 context，生产压缩按 Pi 上一次 compaction boundary 与本次安全切点传入 `removedEntryIds`，`handleBeforeCompact` 强制检查——无移除区间或覆盖不全时
   该次交还 Pi 压缩。当前代码 takeoverEnabled 仍为 false；默认接线按 plan 2.6 直接实施，覆盖/来源检查和用户关闭选择继续有效。
   不复制上次摘要文本不等于没有累计语义损失；承诺的是来源可追溯、覆盖缺口可检测、保留来源可重新读取，而非无损记忆。
3. **兜底（调一次模型）。** 仅当块缺失或落后超过容忍（导入的长会话、记忆 agent 连续失败）时使用：以**同步且有界**的方式
   运行一次记忆 agent（同一机制，不是另一个组件）；有服务端压缩的 provider（Anthropic `compact_20260112`，用
   `pause_after_compaction` 追加最近步与块）可替代。这是唯一可能出现可感知等待的路径。

#### 8.4.3 触发时机

回合内的触发点是 **loop boundary**——所有工具结果已返回、模型将要继续——Codex 的做法；排队的 follow-up 与 steering
在压缩后保留并重放。回合之间优先在用户空闲超过 provider 缓存 TTL 时压缩（缓存已冷、免费）。`reason: 'overflow'`
（一步撑爆）走第 3 档。子任务边界由 host 推断，不要求主 agent 配合：测试或构建刚结束、todo 条目刚勾掉、上一步没有
工具调用，都是比任意 loop boundary 更好的压缩点，触发器优先在这些点动作——这吸收了 2026 年 SelfCompact 研究的结论
（在子任务边界压缩优于纯固定阈值）而不给主 agent 增加义务。Zone 2 的上下文压力一行（"context 72%"）是纯信息，不
要求任何动作。

#### 8.4.4 长任务的连续性：不停下来

agent 现在跑的是数小时的自主任务，任何要求用户介入才能继续的机制都不可用。连续性靠两件事，都不产生停顿：

- **有检查点的压缩与来源恢复**（第 8.4.2 节第 2 档）：机械覆盖可检查，多次压缩后的语义遗漏由测试者验证，不从结构推定无损。
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
| `models.explore` | explore 按查询需要使用的意图扩展、裁决或查询修复 | 未配置 | 纯算法模式，不调模型 |
| `models.retrievalAgent` | `retrieval` 角色（纯 LLM 多轮检索） | 未配置 | 角色不注册 |
| `models.quickImplement` | `quick-implement` 角色 | 未配置 | 角色不注册 |
| `models.hardImplement` | `hard-implement` 角色 | **主模型** | — |
| `models.frontend` | `frontend` 角色 | 未配置 | 角色不注册 |
| `models.review` | `review` 角色与回合结束的 review 传感器 | **主模型** | — |
| `models.check` | `check` 角色 | 未配置 | 角色不注册 |
| `models.reader` | `webfetch` 的阅读子 agent | 未配置 | 忽略 `prompt`，返回提取内容 |
| `models.suggestions` | 知识建议的草拟与触发描述生成 | 未配置 | 用用户原文，触发描述留空 |
| `models.permissionJudge` | 原生权限 fallback 的 Smart 判断 | 未配置 | Smart 不可选；插件活跃时由插件 authorizer 链负责 |

记忆 agent 不走槽位，直接使用该会话活动模型，默认与迁移规则见 8.4。工具集不同，实际缓存与费用分别记账；不用 T4 或缓存实验
决定是否允许使用。后续模型/协议优化按具体问题实施，不复制 Host 模型与凭据权威。

Settings 提供**预设**一键填充多个槽位（如 Anthropic 预设：explore / retrievalAgent / quickImplement / check / reader /
suggestions 填 Haiku，hardImplement / review 保持主模型），但预设只是填表，每个槽位随时可单独改。规则：

- 依赖未配置槽位的能力**不注册、退化为无 LLM 路径**，**永不静默回退到主模型**。`websearch` 与 `grep` 本来不用 LLM。
- 只有 `hardImplement` 与 `review` 默认等于主模型，因此零配置时这两个角色可用：即便同模型，新上下文与 worktree 隔离、
  干净审阅本身就有价值。
- 每个槽位的用量单独归因：reader、permission judge 等会话内辅助请求进入
  `SessionStats.modelSlotUsage`；子线程的角色、模型与 token 已由 `ThreadRun` 记录，不在父会话重复累计。只有真实发生过请求的槽位
  才出现，未配置或尚未调用不显示为 0。

槽位选择遵循用户配置；前缀一致只是可能获得缓存收益的条件。memory 的活动模型例外及自动 review 的默认费用在设置与会话用量中明示。

### 8.6 度量

Piarium 已按轮聚合 token 用量并显示 cache-read / cache-write（0.9.8）。harness 增加会话级计数器：缓存命中率、
工具错误次数、近三步同工具同参数的重复次数、工具输出 UTF-8 字节。这四项随 `SessionStats` 进入现有 Context 侧栏；runtime
不发布字段时整段不显示，不把“无能力”渲染成四个 0；会话内辅助模型请求还按模型槽位显示调用次数、token 与成本。
它们回答"这次改动有没有把体验做贵、做吵"；回答不了"任务做对没有"。

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
   覆盖一切经 host 中介的能力（`shell.*` / `output.*` / `search.*` / `thread.*` / `fs.lock` / `lsp.*`）。能力按会话实际冻结的
   `activeTools` 推导：只有没有任何 `bash` 工具时才不含 `process.shell`；关闭 Piarium 的同名覆盖若会回退到 Pi 内置 bash，
   仍然具有 process 能力。缺少该能力时绕过工具直接到达的 `shell.exec` 必须被拒——这不是第二套用户策略，是防止
   绕过工具入口。按风险类别授权：`read`（search / output / lsp）、`process`（shell）、`control`（thread send / kill /
   merge）、`write`（未来经 host 中介的文档写入）。
3. **OS 沙箱**（第 9.1.1 节）：限制 worker 绕过工具直接访问文件与网络。当前不具备。

`ThreadLaunchManifest.scope` 是任务范围，同时对 Host 能解析出具体路径的服务形成强约束：`search.content` 的返回项、LSP 路径、
`fs.lock` 路径与显式 `shell.exec.cwd` 都必须落在 scope 内。它**不是文件系统沙箱**：shell 命令文本内部可以改变目录或访问其他
路径，Pi 内置 `read` 也在 worker 内直接执行。隔离 worktree 把写入副本与父工作区分开，但只有未来的 OS containment 才能约束
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
有两个入口：主 agent 可以 `dispatch('review', ...)`；harness 也在回合结束且 diff 非空时作为**传感器**自动运行一次
（第 9.1 节）。两者输入相同——只有 diff、任务说明与项目 knowledge，**不带父的对话**，干净是它有效的原因（Devin
Review 在 Devin 自己写的 PR 上仍平均抓 2 个 bug、58% 为严重）；输出带严重度与 `file:line` 的发现，作为 post-tool
反馈注入。自动 review 接通后默认运行且不阻断；以待审结果修订去重，避免同一结果重复审查。profile 可显式设为完成门，用户可关闭；
用量归 review 槽位，不以 T4 配对为启用前提。

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
| 工作树 / 工作分支 | 固定 baseState、按路径的 delta/tombstone、单调 revision、来源与覆盖；目录节点采用 Merkle 结构共享，旧修订不变 |
| 物化记录 | branchId、输入 revision、实际路径、已收集 revision、运行者与未收集改动、环境准备状态、占用；同一分支写入按世代协调 |
| 结果 / 验证记录 | resultRevision、可读取正文的引用、变更路径与来源；验证记录输入修订、环境、命令、退出与生成物，运行中输入变了须说明 |
| Integration | 选定子结果、父相关路径/草稿的期望状态、逐路径计划和实际 before/after、冲突、暂存区影响与恢复操作引用 |

这是正式实施目标，不以第二个消费者或独立评测为前置。对象名称是领域责任，不要求每一行另建数据库或服务。Thread/ThreadRun
仍归现有原子 catalog，Pi 对话仍归 SessionManager，Document Registry 仍拥有窗口可变草稿，知识库仍用 TriviumDB。

**基线捕获与读取。** fork 捕获磁盘基线，并叠加发起消息窗口的版本化草稿；没有 surface 的任务读取磁盘。草稿来源自动传递，
不增加用户绑定操作。已知有草稿却拿不到正文时列出缺失路径，不把磁盘称为该窗口版本。基线发布后 read、grep、枚举、explore
读取同一 baseState 加分支 delta；父后来新增、删除或修改的文件不自动进入子分支，更新基线是一次显式记录的新修订。

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
或重启时按后端状态对账，必要时在该物化目录捕获差异；未确认收集完成就保留目录并显示原因。测试通过绑定命令的实际输入；
格式化、生成源码或后台写入产生新修订，不自动继承旧修订的验证结论。相关流程直接实现并用故障测试验证，不另建研究门槛。

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

默认把草稿来源的结果集成到对应 Document Registry 缓冲，不隐式保存用户未保存内容；磁盘目标经 Host 文件路径写入。同一次集成
可能包含两类目标，分别记录撤销材料。当前原生集成直接应用路径状态，不执行 git apply --3way，不修改用户 index；旧 Git 结果先导入
再走同一原生集成。未来后端若涉及 index，必须记录实际影响并只条件恢复相关条目。UI 与工具共用 Integration，重开仍能继续处理；
合并后按实际变化执行相关验证。

**重叠提示与合并预览。** 已记录的分支变更路径可投影非阻塞重叠提示；恢复日志覆盖不到的 shell 路径标未知，未发现重叠不等于无冲突。
提示不长期占有编辑锁，不阻塞独立分支写者。后台三方预览绑定子 resultRevision 与父受影响路径/草稿版本；输入变更即失效重算，
只显示“此修订可干净合并”或具体冲突。复用 Thread integration 投影，不需要全仓 WorkspaceHead。接通即提供，成本按变化路径计量。

**环境准备。** 使用工作区用户配置的 setup 命令与环境文件规则，按需要执行/分析的工具准备环境；没有命令不伪称已准备，也不因此
禁用不需要准备的任务。setup 幂等，重建或依赖输入变化后重跑；超时由用户配置或既有任务运行时语义处理，不设无依据的 600 秒默认。
Host 通过父 Pi 会话的 settings.get 取得实际设置和 projectTrusted，不能直接重读项目文件绕过项目信任；坏配置明确失败，不当作缺省值。
失败记录 setup-failed、退出码和输出引用，可修复后继续。需要跨重启查看的 setup 记录使用操作所属的耐久输出，OutputRef 只作当前
快速读取句柄，不作为持久报告唯一引用。用户配置一次即授权正常重复执行，不每次再问，不自动执行从仓库猜出的命令。

文件分为需版本化的工作输入/结果、可重建缓存、用户提供的环境文件；ignored 仅作初始选择信号，不能判定重要性。copyIgnored 可显式
选入文件并记录用途。优先文件系统 CoW 克隆（写时分离）和包管理器自身缓存，缺该能力正常复制；可写构建产物不默认硬链接或 junction
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
  role; model; manifest: { tools; worktree; scope; systemPromptFragment; concurrency }; // Run 配置世代内冻结
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

上面的工作分支/修订/物化字段是 D-078 的目标形状，尚未进入当前协议；旧 worktree 在迁移期间作为后端记录保留。
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
- **占用与背压。** 记录物化目录、对象库、受引用历史及可回收量，删除目录不等于释放结果对象。优先回收符合条件的缓存，利用 CoW
  和包管理器缓存减少复制；新增物化按用户配置预算、实际可用空间与可知准备需求安排，必要时排队或返回可行动的 unavailable，
  不终止已有线程来腾配额。没有定标时不默认设置 8 GiB/10% 硬拒绝，也不把未知所需空间当 0；运行中的实际空间不足按 I/O 失败
  明确记录。UI 提供占用、保留原因和立即回收，不设无依据的 80% 统一阈值。
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
停止自动重启并翻 `stalled`，避免形成进程崩溃循环。角色模型和工具经 `session.create/open` 在 Pi 会话构造前冻结；T1 子会话的
allowlist 不含 `dispatch`，因此嵌套线程仍是后续能力，而不是当前的隐式半支持。

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
从父对话任意消息处"从这里开一条线"；讨论线与实现线以标记区分，讨论线可一键转为实现线；归档区列出可恢复的线程。子线程
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

以文件为载体的知识工作：目录内的笔记、文档、表格、PDF，加浏览器与 web。契合 Piarium 以目录为中心的工作区模型。
SaaS 连接器（邮件、日历、聊天）本质是 MCP server 加不可逆动作的确认 UX，不在此 profile 范围内，未来若做以连接器层
出现，不新建产品形态。

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
3. **检索与子 agent 层**：`explore` 管线（查询扩展、rg 扇出、符号图与向量召回、多信号排序；先做纯算法模式，再接
   `models.explore` 的两小步）、`file` / `symbol` 节点与 LSP / Git 采集器、`related`、LSP 导航工具（`symbols` / `definition` /
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
授权（第 9.1.2 节）；设置按字段所有权（第 5.10 节）；已交付 assist 模式，新默认见第 8.4.1/8.6 节；父会话删除
时线程停下并归档、不弹第二个模态（第 9.3.4 节）。

**D-078 已收口的决定**：工作状态/内容寻址结果、物化、草稿基线与版本化集成正式采用；explore、记忆与自动 review 按第 1.3 节
默认交付；回放不再决定能否启用。以下仅列实施时的具体选择，不是暂停清单：

| 范围 | 已确定方向与实施选择 |
| --- | --- |
| 记忆 | 活动模型、memory_edit、版本与覆盖；默认提供，实际成本/失败可见，后续针对实际问题优化 |
| 工作状态与结果 | Host 原生内容对象/树/分支/Integration，Git 基线与物化可复用；一次性迁移、独立引用、真实执行写回，见 9.2.5b |
| RunManifest | Host 执行意图、runtime 解析模型/工具、Host 确认能力、worker 报实际装配；沿 launch 消费者收敛，不复制凭据权威 |
| 外部 runtime | 对实际 adapter 做版本和能力协商，不先解决全部未来版本兼容问题 |
| 本地 embedding | 按可部署模型与 runtime 选型，显式下载；远端和稀疏模式不等它 |
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
