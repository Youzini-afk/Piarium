# Piarium agent harness

Status: design accepted; code profile v1 in delivery — per-capability state is in agent-harness-status.md, not here

Last updated: 2026-09-04

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
- 不为尚不存在的领域预建框架。第二个 profile 出现之前，只留接缝，不实现领域机器。
- 不把插件配置页、Pi 包管理或恢复权威并入 harness。它们保持
  [architecture.md](architecture.md) 记录的归属。

### 1.2 借鉴来源与取舍

本设计的机制来自已在生产中验证的 harness：Claude Code 的分层压缩、工具结果预算、`cache_edits`
微压缩与 `<system-reminder>` 尾部附着；Cognition 的 Fast Context 检索子 agent（专用小模型、并行
工具调用、轮数上限、窄工具集）、Devin Fusion 的压缩时刻换模型、"写单线程、其他 agent 只贡献智力"
的多 agent 原则、Devbox Blueprint 的环境确定性；Manus 团队围绕 KV 缓存的上下文工程原则；Aider
repo map 的符号引用图 PageRank。Piarium 不复制它们的实现，只采纳经过验证的形状，并利用自己独有
的资产：host 拥有的 LSP、Document Registry、终端子系统、恢复日志，以及 TriviumDB 嵌入式知识层。

## 2. 已确定的决策

以下决定已经固定，改动它们需要先改这张表：

| 主题 | 决定 |
| --- | --- |
| 产品边界 | Piarium = 工作台 + harness；Pi = agent 内核；其他 agent 是能力协商的 bring-your-own runtime |
| harness 形态 | 通用内核 + 领域 profile；不是每个领域一套 harness |
| profile 作用域 | profile 是**会话级**属性，会话中途不切换工具集与系统提示 |
| 工具注入 | 与 Pi 内置工具**同名覆盖**，不并列；覆盖发生在 pi-host 进程内 |
| 重活归属 | 索引、搜索、shell 监督、诊断、输出存储、知识库全部在 Application Host；pi-host 内只有薄的工具定义与钩子 |
| worker→host 通道 | 类型化协议请求（`@piarium/protocol`），沿 `workspace.mutation.request` 先例；worker 不持有 host 凭据、不直接打 HTTP |
| 检索分层 | 第一层 grep/glob/read 由 ripgrep 与检索子 agent 拥有；第二层结构、第三层记忆由知识库拥有；知识库不参与第一层 |
| 知识库 | TriviumDB 嵌入式，每 host 每 workspace 一个 `.tdb`；Application Host 是唯一写者 |
| embedding | 可插拔 provider；远端 API 一等（含任意 OpenAI 兼容端点）；本地模型选装下载；未配置时知识库以稀疏 + 图模式工作，embedding 是增强不是依赖 |
| shell 形态 | PTY（复用终端运行时，后台 shell 即终端 tab）；持久会话 shell 保持 cwd / env / venv；stdin 开放且 harness 永不代写；等默认时长后**自动转后台**而非超时杀死；配套 `get_output` / `write_to_process` / `kill_shell`（Devin CLI 与 Codex `unified_exec` 的共同形状）；Git Bash 为默认解释器但 Windows 原生工具可从中调用 |
| 工具并发 | 沿用 Pi 默认并行；只读工具并行，`edit` / `write` / `apply_patch` 按路径加锁（不同路径并行），`bash` 家族 `executionMode: sequential`；不做 apply model |
| shell 环境 | 解释器按工作区环境选定（原生 Windows → Git Bash，WSL → wsl bash，远程 → 远端 shell），用户可覆盖，模型不按次选；login shell 继承用户工具链；环境变量只改交互与显示，**不设 `CI=1`**，locale 探测不硬编码 |
| web | harness 自做 `webfetch` / `websearch`，参照 `pi-web-access` 能力清单原生实现（来源面板替代 Curator server、凭据进钥匙串、结果进知识库、独立浏览器 profile、GitHub 走 octokit）；SSRF 复用 security.md；跨域重定向不跟随；搜索 provider 三层（模型 provider 自带 → 搜索 API → 明确不可用）；桌面端 Electron 离屏渲染 JS；`pi-web-access` 启用时自动让位 |
| 模型槽位 | **每个用模型的能力一个独立槽位**（explore / retrievalAgent / quickImplement / hardImplement / frontend / review / check / reader / suggestions / permissionJudge），用户填、不自动选，预设只是填表；仅 hardImplement 与 review 默认主模型；**其余未配置则不注册或退化为无 LLM 路径，永不回退主模型**；memory shadow 是明确的例外：用户单独开启后使用该会话活动模型，UI 明示可能是全价请求，默认关闭（D-045） |
| 可关可换 | 每项 harness 能力有独立开关，关掉后行为明确（回 Pi 默认或不注册）；默认不按插件存在与否偷偷改变行为，已定义明确共存契约的例外是 web 工具对 `pi-web-access` 让位，以及原生权限 fallback 对 `pi-permission-system` 让位；开关下一会话生效；设置按**字段所有权**决定用户级与工作区级谁说了算（第 5.10 节），能力可用性不是设置而是 host 注入 |
| 编辑格式 | 跟模型家族走：`edit`（str_replace）与 `apply_patch`（Codex 语法）并存，按会话模型启用；两者走同一 mutation boundary |
| OS 沙箱 | 后续阶段；macOS Seatbelt / Linux bubblewrap+seccomp 可做，Windows 不承诺；沙箱内 shell 自动放行，`edit` / `write` 仍走权限（它们在 agent 进程内，沙箱管不到） |
| 缓存契约 | Zone 0 会话内冻结；Zone 1 只追加、序列化确定；所有前缀失效操作批处理到压缩时刻 |
| 工作状态归属 | 主 agent 对记忆系统**零义务**（可选的 `plan` / `todo` 只服务其自身注意力；无块编辑与标记工具；系统提示不提记忆）；**记忆 agent** 拥有 memory blocks（后台、fork 前缀、门控触发），从完整轨迹与 host 事实**自行判断**重要性，不接受启发式权重；机械事件只决定它何时运行；标记权属于用户；host 拥有结构化事实；harness 不强加叙述 schema，`plan` 不强制。记忆 agent 先以 **shadow mode** 交付（维护块、不接管压缩），其模型与成本模型在 provider 实测前不定（第 8.4.1 节） |
| 压缩 | Piarium 接管：替换块 = 记忆 agent 维护的 blocks + 主 agent 计划 + host 事实 + 最近 K 步，零模型调用，回合内可多次；块不进 Zone 0；兜底 = 同步有界地运行一次记忆 agent。**接管的前提是存在记忆 agent 维护的块**，否则交还 Pi 默认摘要；从 shadow 到接管由回放对比决定（第 8.6 节） |
| 长任务连续性 | 压缩不降质 + 委派给新上下文子 agent（共享块协作）；压缩计数是给 agent 的信号；**没有自动停下来的 Handoff**，Handoff 仅为用户手动命令 |
| 持久知识治理 | agent 只提议（带触发描述），用户审阅接受；自动接受按作用域显式开启；更新用双时态取代不覆盖；召回按触发相关性；保留由用户裁剪 |
| 多 agent | **原生**子会话 worker（不依赖 `pi-subagents`）；角色 = **模型 × 任务性质**（检索 / 快速实现 / 难度实现 / 前端 / 审查 / 检查），每个角色独立模型槽位，全部可并发；`dispatch(role, task)` 异步 + `wait`；隔离 / 权限由 harness 决定；嵌套不限深，靠角色与成本可见性约束；未配置槽位的角色不注册；并行写者各进 worktree；兄弟不通信 |
| 线程 | 子会话是**线程**：持久、可寻址、用户可见可对话的一等对象（第 9.3 节），不是一次工具调用的返回值。人和父 agent 用同一个原语开线；状态与游标归 host 持久化；生命周期与父的回合、worker 进程解耦——**线程（工作本身）与 Run（一次执行尝试）是两个对象**，worker 丢失结束一个 Run、开始下一个 Run，线程与 worktree 不变；状态是正交维度（lifecycle / attention / integration / worker / outcome）而不是一个枚举；等待输入是一等状态；失败有分类，没有"没返回"；回收是策略不是手动清理 |
| 观察类工具 | 可能被反复调用的观察工具（`threads` / `wait` / `read_thread` / `get_output` 对运行中 shell / `diagnostics`）**默认返回自上次查看以来的增量**，全量要显式要；游标由 host 按（观察者，对象）持有，压缩时重置；结果只追加不回改（第 8.7 节） |
| 防过度委派 | 不设配额、不做准入规则、**不估成本**（估不准且会把注意力引向算账）；只靠系统提示说明角色与"自己更快更省就自己做"的判断原则，加并发上限默认 12（超出排队）；"派发前询问"是默认不生效的用户设置 |
| 长时间委派 | `wait` 是订阅：只因**真实状态变化、用户输入 / 中止、调用方显式超时**返回，**超时是正常结果不是错误**；没有按缓存 TTL 的默认唤醒——按 TTL 续缓存是默认关的实验开关，是否启用由回放数据决定（第 9.2.6 节）；活性与循环由 host 从子会话事件流观察（stalled / looping），翻转本身就是 `wait` 醒来的事件，不靠子自报、不靠父读转录；整理与压缩永不按时间触发 |
| 验证器 | 是有名字的 profile 声明；post-tool 反馈注入是统一通道 |
| 默认 runtime | 内置钉住的 Pi 作为默认；数据目录共享 `~/.pi/agent`；用户自有 Pi 是显式选项并带"未测试版本"诊断 |
| 领域顺序 | code → research → knowledge-work-in-files；SaaS 连接器不在前三个 profile 的范围内 |
| 度量 | 工具错误计数、重试次数、输出字节、缓存命中率是会话级计数器（回答"贵不贵、吵不吵"）；**最小回放集**（5–8 个固定任务、3 个指标）回答"任务做对没有"，是影响模型行为的能力默认开启的门禁（第 8.6 节）；Zone 0 字节稳定性是契约测试 |
| harness 的 UI 投影 | 后台 shell 成为可附着的终端 tab；输出句柄在工具卡片内可展开全文；Zone 2 默认折叠、可查看；压缩边界在时间线可见；线程在父会话侧栏成列、点开即完整聊天、可从父对话任意位置"从这里开一条线"（第 9.3.8 节） |
| 检索 | 三级：`grep` 工具 → `explore` 工具（Devin 式快速检索的**算法管线**：rg 扇出 + 知识库符号图 + 可选向量 + 多信号排序，LLM 至多两小步且可选，**永不跟随主模型**）→ `retrieval` 角色（纯 LLM 多轮，独立槽位，未配置不注册） |
| 模型家族适配 | 一份基础 + 极薄 overlay；先做 Anthropic 与 OpenAI 两档，其他 provider 走通用 |
| Pi 上游 | 不贡献回上游；Pi 更新后重新适配。能 wrap 的 wrap（`edit` / `write` / `grep` 装饰 Pi 实现），只有 `bash` 重写 |
| 权限 | **三层**，不寻找唯一安全边界（第 9.1.2 节）：成熟的 `pi-permission-system` 在已加载时拥有 `tool_call` 决策与唯一 UI；Piarium 原生门是插件缺席时只覆盖 Harness 工具的 fallback；Host 服务授权只验身份、静态能力与 workspace 包含，不弹窗；OS 沙箱后续。停止 provisioning 不再是 T2 的既定结论，只有替代面达到真实能力等价并单独通过安全设计复审后才重新讨论 |
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
| 记忆 agent | `turn_end` 检查门控与事件；fork 与主对话逐字节相同的前缀 | 后台运行，输出块编辑操作由 host 应用；默认同模型以命中缓存；不碰文件、shell、持久知识 |
| 兜底 | 压缩时块缺失或过期 | 同步有界地运行一次记忆 agent；不在正常路径上 |
| 压缩后恢复 | `session_compact` | 重新注入最近文件与技能指针（有预算） |
| 缓存断点 | `before_provider_request`（如需） | pi-ai 的 Anthropic provider 已在 system、tools、最后一条 user 消息设 `cache_control`；仅在 provider 缺失时补 |
| 轨迹采集 | `tool_execution_end`、`turn_end`、host 侧文档 / 终端 / LSP 事件 | 写入知识库，不进上下文 |
| 用户 `!cmd` | `user_bash` → 自定义 `operations` | 与 `bash` 工具共享同一 shell 监督器 |

### 4.2 现存违规

`packages/pi-host/src/session-features.ts` 在 `before_agent_start` 中把 `${goal.tokensUsed} of
${goal.tokenBudget}` 拼进 `systemPrompt`。该数字每轮变化，使整个前缀缓存每轮失效。修法是把目标提醒改为
返回 `message`（Zone 2），并把 token 计数从提醒文本中移除或移到尾部。这是缓存契约（第 8 节）落地的
第一项工作。

## 5. 工具集（code profile v1）

### 5.0 清单

| 工具 | 来源 | 并发 | 一句话 |
| --- | --- | --- | --- |
| `bash` | 覆盖 Pi | 独占（`executionMode: sequential`） | PTY、持久会话 shell、超时转后台不杀 |
| `grep` | 覆盖 Pi | 并行 | rg 镜像 schema，分组排序，句柄 |
| `edit` / `write` | 覆盖 Pi | 不同路径并行，同路径串行 | 参数不变，附加新引入的诊断 |
| `apply_patch` | 新增 | 同上 | Codex 语法多文件编辑，按模型家族启用 |
| `read` / `find` / `ls` | Pi 原样 | 并行 | 结果同样经句柄截断 |
| `get_output` / `write_to_process` / `kill_shell` | 新增 | 读并行，写与杀独占 | 后台 shell 与输出句柄；对运行中 shell 默认返回上次读取之后的增量（第 5.5 节） |
| `diagnostics` | 新增 | 并行 | `pending` 后按需查 |
| `todo` | 新增 | 串行 | 主 agent 自己的计划（第 5.6 节） |
| `explore` | 新增 | 并行 | Devin 式快速检索：rg 扇出 + 符号图 + 可选向量 + 多信号排序的算法管线，LLM 至多两小步且可选（第 5.7、6.1 节） |
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
   文件本身，线程报告里引用的原始 trace 用它，不用 `OutputRef`。所有偏移与长度一律是 **UTF-8 字节**，切片在字节边界处
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

v1 保持 `edit` 直接写磁盘、编辑器事后 reconcile 的现状（已决定）。让 `edit` 走 Documents authority 做 revision 检查并
在存在脏缓冲时拒绝，留到第 2 阶段之后评估——届时记忆 agent 与 Zone 2 已让 agent 知道用户正在改哪个文件，撞车本身会
变少。

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
低于 profile 阈值时在进入自主运行前确认一次，之后不再打断。系统提示只建议"非平凡任务先计划"，harness 不检查它是否
被调用，也不因其陈旧而提醒。

### 5.7 `explore`、`dispatch` / `wait`（新增）

**`explore(question, paths?)` 是 Devin 式快速检索工具，靠算法而不是靠 LLM 循环达到速度**（第 6.1 节）。它是一条固定
的检索管线：查询扩展 → ripgrep 并行扇出 + 知识库符号图查询 + 可选向量召回 → 合并 → 多信号排序 → 切片段窗口 → 返回。
没有多轮模型调用；返回排好序、去重、带上下文窗口的 `file:line` 片段（默认上限 20，全部入句柄）与一行一句的"为什么
是这些"。rg 部分亚秒级，全管线通常一两秒。工具描述："知道确切符号用 `grep`；不知道从哪开始、或问题涉及多个概念时
用 `explore`。"

LLM 在这条管线里最多出现两次、每次一小步、都是可选的：查询扩展（把自然语言问题变成 rg 模式与符号候选）与最终重排
（对候选片段做一次相关性排序并写那一句解释）。二者使用 `models.explore` 槽位；**未配置时不调用任何模型**，退化为纯
算法模式——查询扩展用启发式（提取标识符、引号内字面量、驼峰拆分，再用知识库 `symbol` 节点的 BM25 匹配候选名），
重排只用算法信号。**它永不跟随主模型**：基础检索能力必须便宜到可以频繁调用。

`dispatch(role, task, { scope?: paths })` 把一个任务交给第 9.2.2 节角色目录中的一个成员：**开一条线程**（第 9.3 节），
**异步**，立即返回线程 id；父继续工作。系统提示把角色呈现为团队成员而非工具（第 9.2.4 节）。每个角色有自己的结果
schema：`review` 返回带严重度的发现列表，`check` 返回通过 / 失败与证据，实现类角色返回改动文件、结论、未解决项、置信度、
相对简报的偏离。中间过程留在线程自己的上下文里，不进入主上下文。

父 agent 与线程的交互是"看仪表盘、必要时传话"，不是对话（第 9.3.6 节）：`threads(ids?)` 非阻塞返回一张增量状态表；
`wait(ids?, timeout_ms?)` 是同一张表的阻塞版本，任一线程状态变化或超时即返回，**超时是正常结果**，默认截止由 harness
按 provider 缓存 TTL 计算（第 9.2.6 节），模型通常不传；`read_thread(id, what?)` 默认读线程的记忆块（progress /
decisions / errors），其次报告，最后才是转录切片（走句柄）；`send(id, message)` 给线程传话；`kill(id)` 终止但默认保留
worktree。`merge(id)` 把写者线程的 worktree 变更三方合并到父工作树，冲突时返回冲突文件列表、标记留在文件中，父用
`edit` 自己解（第 9.2.5b 节）。未配置对应模型槽位的角色不注册，模型看不见。

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

**`websearch(query, { allowed_domains?, blocked_domains?, recency? })`**：provider 三层——会话模型的 provider 自带搜索时
优先（Anthropic `web_search`、OpenAI web search、Gemini grounding：零基础设施、带引用）；否则用 Settings 配置的搜索
API（Brave、Exa、Tavily、Jina、自托管 SearXNG）；都没有则 `unavailable (no search provider configured)` 附配置指引，
**永不伪造结果**。返回标题 + URL + 摘要片段列表直接给主 agent，不套子对话。

安全：抓回的内容以"数据不是指令"标记包裹（与 Zone 2 同一做法）；每回合抓取次数有可配置预算；页面正文永不进日志、
事件载荷或 URL。

与 `pi-web-access` 的关系：harness 的两个工具是默认；会话中启用了 `pi-web-access` 时它们**自动让位**（该会话内不注册），
遵守"模型不该有两种方式做一件事"，而不是管理插件；插件的 Curator 与存储结果保持插件所有。这是 harness 中**唯一**的
自动让位（第 5.10 节）。

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
  | `memory.shadowMode` | user-only——仓库不能替用户开启后台模型调用与费用 |
  | `knowledge.autoAcceptSuggestions.user` | user-only——一个仓库的配置绝不能替用户打开"自动写入用户级长期记忆" |
  | `knowledge.autoAcceptSuggestions.workspace`、`knowledge.eventRetentionDays` | 工作区可设 |
  | `tools.*`、`shell`、检索策略、`dispatch.concurrency`、`output.*`、UI 偏好 | user 默认 + 工作区覆盖 |
  | `permissions.mode` / `rules`、`dispatch.askBefore` | 工作区**只能收紧**（`bypass < accept-edits < normal`，只能向右；只能追加 ask / deny 与"派发前询问"）；`smart` 需用户显式开启 |
  | `web.*` 域名策略 | user 与工作区取更严格组合 |
  | 能力可用性（如线程运行时是否存在） | **不是设置**，由 host 经 RunManifest 注入，只读 |

- 一切**在下一个会话生效**——profile 与工具集是会话级属性（第 8.2 节），会话中途改变会打碎 Zone 0。
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

**第二级：`explore` 工具——用算法达到 Devin 的速度。** Devin 的 Fast Context 快在专训小模型加并行工具调用；我们训不了
那个模型，所以用一条**固定管线**替代它的角色，LLM 最多在边缘用两小步。管线：

1. *查询扩展*：把问题拆成多组 rg 模式与符号候选——提取标识符、引号内字面量、驼峰与下划线拆分、同义扩展；知识库
   `symbol` 节点的 AC 关键词与 BM25 给出候选名。配置了 `models.explore` 时用一次小模型调用做扩展，否则纯启发式。
2. *并行扇出*：多组 rg 查询并行（host ripgrep 服务）；同时查知识库——符号图 1–2 跳扩展（`related`，第 6.2 节）、
   配置了 embedding 时的向量召回（第 7 节，`search_hybrid`）。三路结果合并去重。
3. *多信号排序*：命中密度、符号图 PageRank、mtime 与 Git status、路径偏好（源码优先于测试、浅路径优先）、向量相似度
   （若有）。配置了 `models.explore` 时对前 N 个候选做一次小模型重排并写一句解释，否则只用算法信号。
4. *切片段*：每个命中取上下文窗口，去重后返回默认最多 20 个 `file:line` 片段，全部入句柄。

rg 部分亚秒级，全管线通常一两秒。**它的质量随知识库成长**：没有知识库时它是 rg 扇出 + 启发式；有符号图时多了结构
信号；有 embedding 时多了语义召回。**永不跟随主模型**：`models.explore` 未配置就是纯算法模式，不调任何模型。

**第三级：`retrieval` 角色——纯 LLM 的多轮检索 agent。** 团队目录中的一个角色（第 9.2.2 节）：受限只读工具（`grep` /
`read` / `find` / `explore`），默认每轮最多 8 个并行调用、最多 6 轮（5 轮探索 + 1 轮作答；SWE-grep 的 4 轮是 RL 专训
模型的数字，通用模型需要更多串行轮次），返回排好序的片段与一段回答。它处理管线答不了的问题——需要跨文件推理的
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

## 7. 知识库（TriviumDB）

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
  error/warning 才作为“新诊断”投影，避免复述 agent 已在工具结果中见过的诊断。user terminal 与 Git status 的生产订阅仍待接。
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
    向量路径只在配置了 embedding 时启用。需要 TriviumDB 提供：显式的"无向量 / 纯稀疏"检索入口。
- **TQL 在 v0.8.5 上不可用于 payload 字段过滤**（D-019）：`FIND {type:"block", sessionId:"s1"}` 对字符串字面量报
  napi 类型转换错误。知识库当前所有查询用 `allNodeIds()` + `getPayload()` 在 JS 层过滤；`createIndex` 仍建，待 TQL 修复
  后启用。数据规模（单会话数百 event）下可接受，是 TriviumDB 侧需要修的项，不是 Piarium 的长期形状。
- **代码分词**：TriviumDB 当前 tokenizer 为 ASCII 字母数字段 + CJK 2-gram，camelCase 不拆分。需要向
  TriviumDB 增加 identifier-aware tokenizer（camelCase 拆分并保留原词）；未落地前以 AC 关键词层承担精确符号
  命中。
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

1. **Zone 0 会话内一个字节不变。** 没有随轮变化的计数、时间戳或状态；profile 切换只在会话边界。Pi 系统提示
   已核实不含日期时间，仅含会话稳定的 cwd。
2. **Zone 1 只追加、不修改，序列化确定。** JSON 键序固定；重试不产生新的随机 ID；工具结果的截断在进入前完成。
3. **所有前缀失效操作批处理到压缩时刻。** 记忆固化、摘要、模型切换、工具集变更、技能重新注入、profile 更新
   全部在 `session_before_compact` 内一次完成。

### 8.3 三个进入通道（按缓存代价）

- **A. 尾部追加（几乎免费）**：Zone 2 消息、模型调用 `recall` / `related` 得到的 tool_result、上一轮工具结果、观察类
  工具的增量视图（第 8.7 节）。90% 的"无感"发生在这里。
- **B. 压缩时刻（反正已失效）**：第 8.2 条 3 的全部内容。后台采集持续运行，但产出等在知识库里，此刻才被消费。
- **C. provider 原生上下文编辑（有则用）**：Anthropic `cache_edits` 类能力允许服务端删除旧 tool_result 而保留
  前缀缓存。按 provider 能力门控；无则退回 B。

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
"交出去就走开"产品的正确选择，不是通用规则）。计划带置信度时，低于 profile 阈值在进入自主运行前确认一次，之后不再
打断。**除此之外主 agent 对记忆系统零义务**：没有块编辑工具，没有标记工具，系统提示中不出现任何"请维护记忆"的措辞，
harness 也不因块或计划陈旧而提醒它。理由：注意力税不在一次工具调用上，而在**每一步都要判断要不要调用**上；一个"记得
为记忆系统做 X"的常驻义务会一直占据推理。Letta 的主 agent 没有任何记忆工具；Claude Code 的主 agent 不参与 Session
Memory，且 TodoWrite 已默认关闭；Cognition 的压缩模型完全从轨迹推断关键信息。可选的 `plan` / `todo` 之所以保留，是
因为它服务于主 agent **自己**的注意力（Manus 复述的价值在写的人身上），不是为记忆系统写的。

主 agent 的判断不需要显式标记就已经可读：它在文本里自然会写"重要 / 注意 / 决定用 X 因为 Y / 这条路不行"，反复编辑
的文件、失败后通过的命令、放弃的路径也都在轨迹里。记忆 agent 读完整轨迹，这些都看得见，**由它自己判断什么重要**。
harness 不向它提供任何启发式权重或"重要性"标注：Letta 的睡眠时 agent、Claude Code 的 Session Memory 子 agent、
Cognition 的压缩模型都只读轨迹本身，没有一个依赖手写检测器；给一个有判断力的模型附上机械权重只会把它的注意力从
"发生了什么"引向"哪里被打了标"。记忆 agent 的输入只有三样：完整轨迹、host 事实（文件、命令、诊断——中性数据，不是
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

**记忆 agent 的上下文。** 当前 shadow 实现从 Pi 的 `context` hook 捕获本步真实 provider-neutral messages，在 `turn_end`
补上本次 assistant 与 tool results，复用活动会话的 system 与 model，只暴露 `memory_edit`，尾部追加当前块、游标与编辑指令。
输出必须是结构化块操作，由 Host 逐项验证、按本次前一项的结果顺序应用并记账；自由文本、陈旧 patch 与越过预算的操作都不写。
它没有文件与 shell 工具，不写持久知识（那走第 7.2.2 节的建议流程），`memory_edit` 也不进入主会话历史。

**成本模型是未验证假设（D-037）。** 原设想"前缀逐字节相同、整段缓存命中、因此固定用主模型最便宜"有一个洞：记忆
agent 必须带 `memory_edit` 工具才能被 `tool_choice` 强制，而主 agent 按本节规则**没有**这个工具，两者的 tools 块必然
不同；Anthropic 的缓存层级是 tools → system → messages，tools 变则整段前缀失效，"0.1× 缓存读"不成立；OpenAI 的自动前缀
缓存对 tools 的序列化位置不透明。因此：记忆 agent 的模型与是否复用前缀，**按 provider 实测 system / tools / messages
分段命中后决定**，不从"相同前缀"概念推断；实测前只提供用户显式开启的 shadow mode（维护块、进 Zone 2，不接管
压缩），并明确提示额外请求可能全价。pi-ai 的 provider-neutral `toolChoice` 目前只能保证 `auto/none`，所以 prompt 要求调用
`memory_edit`；未返回该调用就按“本轮未更新”处理，不从自由文本猜操作。缓存是 provider adapter 的优化能力，不是正确性依赖。

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

1. **清理工具结果（每步，免费）。** 旧 tool_result 正文替换为句柄引用，正文已在 host。有 provider 原生上下文编辑
   （Anthropic `cache_edits` 类）时服务端删除、前缀缓存保留；无则在下一次本地压缩时一并处理。回合内的上下文增长
   绝大部分来自工具输出，这一档就能把回合延长很多。
2. **替换（零模型调用，回合内可用，但默认关闭）。** 阈值到达时，`session_before_compact` 返回 `compaction`：Zone 0 不动，切除
   范围替换为**当前 memory blocks + 主 agent 的计划 + host 事实记录**，保留范围用 Pi `preparation` 给出的安全切点
   （tool_use / tool_result 配对由 Pi 保证），不自行按步数计算。**接管的前提是存在记忆 agent 维护的块**（`updatedBy:
   memory-agent`）：只有 `todo` 写的 `plan` 或只有 host 事实时不接管，交还 Pi 默认摘要——一张清单不是对话的替代
   （D-028）。存在 keeper block 仍不足以开启接管；`takeoverEnabled` 默认 false，shadow 阶段始终交还 Pi，只有回放通过后才
   改默认。替换块是记忆 agent 持续维护的状态与 host 的事实，不是压缩时刻回忆的散文，所以压多少次都是一份当前
   图景，没有"摘要的摘要"——Codex 团队观察到的随压缩次数下降的准确率来自摘要堆叠，这里结构上不存在。但这个结论
   有前提：记忆 agent 第一次压缩后看到的历史已是压缩后的历史，"不叠加损失"要求原始 trace 耐久可读（`TranscriptRef`，
   第 5.1 节），并且要在回放集上证明（第 8.6 节），不能从结构推定。块最多落后一个门控间隔（约 5K token），那部分落在
   保留范围内。毫秒级装配，断点 1 之后 Zone 0 依然命中。
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

- **压缩不降质**（第 8.4.2 节第 2 档），所以单一上下文可以被压很多次。
- **委派**。范围大的任务由 agent 把子范围交给团队中的角色（`dispatch`，异步，第 5.7 / 9.2 节）：子拿到任务与父计划的
  快照，在独立 worktree（并行写者）或共享工作区（只读者）中工作，结果以结构化形式回到父。写操作仍单线程于每个
  worktree（第 9.2.2 节）。子 agent 是 broker 起的原生子会话 worker，不依赖插件。
- 压缩计数超过阈值（默认 3）时，信号给 **agent**（Zone 2："本会话已压缩 3 次，考虑将剩余子任务委派给新上下文的子
  agent"）和 UI（信息条），**不是停顿，不是建议用户做什么**。

Handoff（把当前会话提炼为一条草稿 prompt 开新分支，Amp 的做法）只作为**用户手动命令**存在于交互式使用，不在
自主路径上，永不自动触发。

`session_compact` 之后按预算重新注入最近文件与技能指针（默认最近 5 个文件 / 50K token、技能 25K token）。UI 上没有
模态与输入锁定，时间线以一个安静的分隔标记表示压缩边界，composer 全程可用。

### 8.5 子 agent、模型槽位与模型切换

同模型的探索子 agent 共用父 agent 的 Zone 0 字节，其首轮前缀直接命中父缓存。模型切换（Fusion 式主 agent /
sidekick）只在压缩时刻进行：缓存按模型隔离，中途切换等于全 miss。

**模型槽位（model slots）规则：每个用模型的能力一个槽位，独立配置。** 许多 provider 没有更便宜的兄弟模型，自动挑选
会挑不到，回退主模型会烧钱；而不同能力的任务性质与实现都不同，不能共用一个"便宜模型"。因此 harness 不自动挑模型，
每个用模型的能力有自己的槽位：

| 槽位 | 服务的能力 | 默认 | 未配置时 |
| --- | --- | --- | --- |
| `models.explore` | `explore` 管线的查询扩展与重排（两次小调用） | 未配置 | 纯算法模式，不调模型 |
| `models.retrievalAgent` | `retrieval` 角色（纯 LLM 多轮检索） | 未配置 | 角色不注册 |
| `models.quickImplement` | `quick-implement` 角色 | 未配置 | 角色不注册 |
| `models.hardImplement` | `hard-implement` 角色 | **主模型** | — |
| `models.frontend` | `frontend` 角色 | 未配置 | 角色不注册 |
| `models.review` | `review` 角色与回合结束的 review 传感器 | **主模型** | — |
| `models.check` | `check` 角色 | 未配置 | 角色不注册 |
| `models.reader` | `webfetch` 的阅读子 agent | 未配置 | 忽略 `prompt`，返回提取内容 |
| `models.suggestions` | 知识建议的草拟与触发描述生成 | 未配置 | 用用户原文，触发描述留空 |
| `models.permissionJudge` | 原生权限 fallback 的 Smart 判断 | 未配置 | Smart 不可选；插件活跃时由插件 authorizer 链负责 |

记忆 agent 不走槽位。shadow 由用户单独开启后使用该会话活动模型，以避免跨 provider 回放不兼容；这**不代表缓存必然命中**，
因为它的 tools 块与主请求不同。是否改为独立槽位、继续使用活动模型或默认开启，等 provider 缓存实测与 T4 回放决定。

Settings 提供**预设**一键填充多个槽位（如 Anthropic 预设：explore / retrievalAgent / quickImplement / check / reader /
suggestions 填 Haiku，hardImplement / review 保持主模型），但预设只是填表，每个槽位随时可单独改。规则：

- 依赖未配置槽位的能力**不注册、退化为无 LLM 路径**，**永不静默回退到主模型**。`websearch` 与 `grep` 本来不用 LLM。
- 只有 `hardImplement` 与 `review` 默认等于主模型，因此零配置时这两个角色可用：即便同模型，新上下文与 worktree 隔离、
  干净审阅本身就有价值。
- 每个槽位的用量在会话计数器中单独归因。

判断标准只有一条：**有没有共享前缀**。有，同模型靠缓存最便宜；没有，只用用户为该能力明确配置的模型。

### 8.6 度量

Piarium 已按轮聚合 token 用量并显示 cache-read / cache-write（0.9.8）。harness 增加会话级计数器：缓存命中率、
工具错误次数、近三步同工具同参数的重复次数、工具输出 UTF-8 字节。这四项随 `SessionStats` 进入现有 Context 侧栏；runtime
不发布字段时整段不显示，不把“无能力”渲染成四个 0。它们回答"这次改动有没有把体验做贵、做吵"；回答不了"任务做对没有"。

**最小回放集**（D-037）回答后者，是影响模型行为的能力从 shadow / `proven` 升到 `default-on` 的门禁：5–8 个来自
Piarium 自身历史的真实任务（跨多文件修改、测试失败到修复、长上下文后回忆早前决定、编辑器有未保存改动时的恢复），
每个固定起点（commit + 工作区状态）与判定标准；三个指标——任务是否成功、总 token、人工介入次数；每次失败附一个类别
（`retrieval miss` / `lost context` / `wrong edit` / `permission interruption` / `tool-runtime failure` /
`coordination failure`）让失败可诊断。对比同模型、同 provider、同起点，原生 Pi 对开了某项能力的 Pi。它不是 benchmark：
手工跑、结果记入状态矩阵的 evidence 列。Recovery、安全、崩溃等确定性行为由 E2E 与故障注入验证，不进回放集。
需要回放证据的能力：记忆 agent 接管压缩、`explore` 默认开启、自动 review、按 TTL 唤醒；基础设施类能力（bash / grep
覆盖、截断、权限门）`proven` 即可默认开启。

T4 第一版已把 6 个真实历史任务固定在 `evaluation/harness/cases.json`，涵盖故障修复、跨包能力、Settings UI、持久子线程、
长上下文 shadow 与用户审计面；每项钉住 base/reference commit，但 reference 只供复核，不要求逐字节复刻。记录器
`scripts/harness-replay.mjs` 默认不调用模型、不改 settings，只创建 run record 并汇总配对结果。自动执行要等 per-session
Harness profile override，避免为了跑实验临时改全局设置而污染用户的普通会话（D-047）。

**Zone 0 字节稳定性契约测试**：在一个测试会话内跨 N 轮截获发往 provider 的请求，断言 system 与 tools 段逐字节相同、
Zone 1 只增不改。它确定、便宜，直接捕获第 4.2 节那一类缺陷，并让任何向系统提示加入动态字段的改动立刻失败。放在
`packages/pi-host` 的契约测试中。

### 8.7 观察类工具的增量视图

有一类工具会被对同一个对象反复调用：`threads` / `wait` 看线程、`read_thread` 读线程记录、`get_output` 读运行中的 shell、
`diagnostics` 查同一文件。若每次返回全量快照，上下文里堆的是重复内容；若事后把旧快照折叠成一行，就是回改 Zone 1，
违反第 8.2 条规则 2。Devin 的查看工具反复使用而上下文几乎不涨，可观察到的解释就是增量返回。规则：

1. **默认增量。** 工具记住"这个观察者上次看到哪"，再次调用只返回这之后的变化，开头一行引头说明基线（"自上次查看 2 分 14 秒
   前以来"）。没有变化就是一行明确的"无变化"，写得让模型觉得再查没有意义。全量视图要显式参数（`full: true` 或显式
   `offset`）。
2. **游标归 host。** 按（观察者会话，被观察对象）保存，不占任何一方的上下文，活过 worker 丢失；用户面板是另一个观察者，
   有自己的游标。
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

Codex（Seatbelt / Landlock+seccomp / bubblewrap）、Claude Code（Seatbelt / bubblewrap）、Devin CLI（Autonomous
模式）都以 OS 级沙箱作为**自动放行 shell** 的前提：沙箱把命令能触及的文件与网络限住，权限提示就只剩沙箱外的动作。
Devin 的一个诚实细节值得照搬：沙箱内 shell 自动放行，但 `edit` / `write` 仍走权限，因为它们在 agent 进程内执行，
沙箱管不到。三家在 Windows 上都没有原生沙箱（Claude Code 要求 WSL2）。Piarium 把沙箱列为第 5 阶段之后的候选：
macOS 与 Linux 在 host 的 shell 监督器内可做，Windows 不承诺。沙箱不替代权限门控，只改变门控的默认答案。

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

子 agent 是 **broker 起的子会话 worker**，绑定父会话，拥有自己的 Zone 0（同模型时与父逐字节相同，首轮命中父缓存）、
受限的工具集与权限、独立的预算。这是 Piarium 已有的原语（每会话一个 worker），也是 Devin Local 的形状（每个子 agent
独立进程、独立会话、在 Kanban 可见）。`pi-subagents` 不再是 harness 的依赖，保持为用户可装的替代品，其 Fleet 适配器
不变（第 5.10 节）。每个子会话都是一条**线程**（第 9.3 节）：在父会话的侧栏成列、点开就是完整聊天、人可以直接对话，在
父的时间线上是一张折叠的子卡片带状态与报告。

#### 9.2.2 角色 = 模型档位 × 任务性质

主 agent 换不了自己的模型，委派是它借用另一个模型长处的唯一途径。因此角色按**模型档位与专长**定义，不按流程步骤
定义——"父模型 + 全工具"的通用子 agent 除隔离上下文外什么都没换，不在目录里。code profile 的角色目录，全部可并发：

| 角色 | 模型槽位 | 工具 | 用途 | 隔离 |
| --- | --- | --- | --- | --- |
| 检索 `retrieval` | `models.retrievalAgent` | 只读（grep / read / find / explore） | 纯 LLM 多轮检索，处理 `explore` 管线答不了的跨文件推理问题（第 6.1 节第三级） | 无 |
| 快速实现 `quick-implement` | `models.quickImplement` | 全工具 | 规格明确的机械任务：重命名、样板、已知模式在多文件铺开、测试脚手架 | 并行时 worktree |
| 难度实现 `hard-implement` | `models.hardImplement`（默认主模型） | 全工具 | 模糊、跨切面、需要推理的实现 | 并行时 worktree |
| 前端设计与实现 `frontend` | `models.frontend` | 全工具 + 预览截图 | UI 设计与实现；可通过 host 预览与 Electron 离屏渲染看到自己的结果 | 并行时 worktree |
| 审查 `review` | `models.review`（默认主模型） | 只读 + diff | 独立、干净上下文的审阅，返回带严重度与 `file:line` 的发现 | 无 |
| 检查 `check` | `models.check` | 只读 + 运行（bash 只跑不改） | 快速验证：跑测试、lint、核对一个论断、冒烟一处改动，返回通过 / 失败与证据 | 无 |

Devin 式快速检索**不在目录里**：它是工具 `explore`（第 5.7 节）——一条算法管线，不是 agent；`retrieval` 角色是它之上
纯 LLM 的第三级。

**每个角色一个独立槽位**（第 8.5 节），任务不同、实现不同，不共用"便宜模型"。零配置时可用的角色是 `hard-implement`
与 `review`——默认主模型，但新上下文与 worktree 隔离本身就有价值；其余角色的槽位未配置则**不注册**、模型看不见，
不静默回退主模型。profile 可增删角色（research profile 会有文献检索与引用核对角色）。

主 agent 的动词：`dispatch(role, task, { scope?: paths })`——**异步**，立即返回子 id，父继续工作；`wait(ids?,
timeout_ms?)` 等待（第 9.2.6 节）。返回结构化结果：改动文件、结论、未解决项、置信度、完整轨迹句柄。其余由 harness
决定：**隔离**（并行写者各进独立 git worktree，父负责合并，合并是显式可审阅的一步；单个写者共享父的 worktree；只读者
共享工作区）；**权限**（继承父策略；只读角色由原生门控强制而非提示词；后台子 agent 只能用预批准工具）；**深度**（不限，
线程可以再开线程，靠角色目录与成本可见性约束，不靠硬上限）；**并发**（默认 12，可配置；到上限的派发排队）；每线程的
步数与 token 上限是可选的用户设置，默认不设，设了则超出时返回部分结果并注明。线程的寿命与父的回合和 worker 进程解耦
（第 9.3.4 节）：父的回合结束、父 worker 退出，线程照跑；只有用户删除父会话时线程才停下并归档。

#### 9.2.3 harness 自己的 agent 对主 agent 不可见

记忆 agent（第 8.4.1 节）与阅读子 agent（第 5.8 节）由 harness 规则触发，主 agent 没有调用它们的工具。`review` 角色
有两个入口：主 agent 可以 `dispatch('review', ...)`；harness 也在回合结束且 diff 非空时作为**传感器**自动运行一次
（第 9.1 节）。两者输入相同——只有 diff、任务说明与项目 knowledge，**不带父的对话**，干净是它有效的原因（Devin
Review 在 Devin 自己写的 PR 上仍平均抓 2 个 bug、58% 为严重）；输出带严重度与 `file:line` 的发现，作为 post-tool
反馈注入，默认不阻断，profile 可设为完成门。

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

#### 9.2.5b worktree 的合并与冲突

写者子 agent 在独立 git worktree 中工作；`dispatch` 时从父当前状态分出，放在 Piarium 管理的目录下。**合并是把子
worktree 的变更以三方合并方式应用到父的工作树**（`git apply --3way` 语义）：不要求父工作树干净——agent 的编辑本就
未提交——也不在用户的 git 历史里强制产生提交。父 agent 调 `merge(child_id)`，host 执行：干净则一步完成并返回改动
文件列表；有冲突则不猜、不自动解，返回冲突文件列表，标准冲突标记留在文件中。**父 agent 自己解**——冲突文件就是普通
文件，用 `edit` 处理标记即可，工作树中没有标记就是合并完成，不需要额外步骤；父持有派发意图与子的结构化结果（`wait`
已返回），是最了解全局的一方；子只专注它那一块，不让它去解与别人的冲突。不需要为此写特别的系统提示。

恢复日志把合并与后续的冲突处理记为父回合的普通变更集（逐路径 before / after），回滚父的这一轮能撤掉。settle 与 merge 前
先把 child delta 提交到内部结果分支并记录 commit；当前合并成功后仍保留 live worktree，因为线程侧栏重开会话依赖其 cwd。
目录回收须等只读 transcript/rehome 与显式归档动作同批交付；分支保留期限没有数据前不猜。合并失败始终保留。
Git 面板显示每条线程的 worktree 与差异，面板上的"合并这条线"与 `merge` 工具调**同一个 host 服务**，合并后线程状态变为
`merged`，人和 agent 不会各合一次；用户可选"合并前审阅"，默认关——自主流程不停顿。

#### 9.2.6 长时间委派与缓存

父等待子 agent 期间没有请求发出，前缀缓存在 provider TTL 后变冷（Anthropic 默认 5 分钟、可选 1 小时；各家不同），
子返回时那一次请求要全价重写整个前缀。

**`wait` 默认只因真实事件返回**（D-033）：目标线程的状态变化（含 `attention` 翻转为 stalled / looping / 等输入、Run
结束、报告就绪）、用户输入或中止、调用方显式给的 `timeout_ms`；上限是 host 的请求时限（1 小时）。**没有按缓存 TTL 的
默认唤醒**。原设想的"按 TTL 唤醒以续缓存"（5 分钟 TTL 约 4 分钟醒一次）降为默认关的实验开关 `harness.wait.cacheKeepaliveWake`，
provider TTL 只作 telemetry；是否启用由回放数据决定。原因：下面的算账只在 30 分钟任务、5 分钟 TTL、每次唤醒完全续上
缓存时成立，超过约 10 个 TTL 周期后多次 0.1× 已比一次冷启动贵；更重要的是每次唤醒都是一次行动机会，防轮询只靠一句提示
词，而第 9.1 节的原则正是传感器优先于指南。原设想的第二个理由——顺便看到 stalled / looping——不需要 TTL：这两个标志由
host 传感器翻转，翻转本身就是 `wait` 醒来的事件。

若开关打开，每次唤醒是一次前缀全命中（0.1×）的请求加几十 token 输出，`wait` 返回极简状态：

```text
2 running · 0 done
  A  editing packages/web/lib/foo.ts · 14 steps · 40s ago
  B  3 steps · no activity for 6 min ⚠
```

唤醒让父看到**增量**进度（第 8.7 节：只有自上次以来的变化）。**超时返回是正常结果**，不是错误，也不意味着任何线程出
了问题。原算账（30 分钟委派、5 分钟 TTL，唤醒 7 次 ≈ 0.7× 上下文，低于一次冷 miss 的 1.0×）保留在此作为实验的假设，
不作为默认行为的依据。

一个纯机械的可选优化：TTL 极短且父确实无事可做时，harness 自行发送同前缀、`max_tokens` 最小的保活请求刷新 TTL，
零注意力成本但无监督价值；作为设置项，默认关，记入待决。线程的生命周期与正确性**不得依赖**任何缓存续命机制。

**这与上下文整理无冲突。** 记忆 agent 的触发是"有未整理的新轨迹"（token 增长 + 工具调用），不是墙上时钟；父等待期间
没有新步骤就没有东西可整理，不会触发；子返回时进入的是一条结构化结果，正常门控。压缩也永不按时间触发。因此长时间
委派不会导致频繁整理或信息丢失。

#### 9.2.7 v2 候选

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
  role; model; manifest: { tools; worktree; scope; systemPromptFragment; concurrency }; // 创建时冻结，重启后仍按同一能力启动
  lifecycle:   "queued" | "active" | "settled" | "archived";
  attention:   "none" | "user" | "permission" | "stalled" | "looping";     // 归 Thread：Run 崩了问题还在等
  integration: "none" | "dirty" | "merge-ready" | "conflict" | "merged";   // 归 Thread：worktree 比 Run 活得久
  worktree; report; activeRunId?; hidden; createdAt; updatedAt; eventSeq;
}
ThreadRun {
  id; threadId; attempt; runtimeId /* "pi" */; sessionId;
  workerState: "starting" | "running" | "lost" | "exited";
  outcome?: "success" | "failure" | "cancelled" | "lost"; exitReason?;
  tokens; costUsd; steps; lastToolCall; startedAt; endedAt?;
}
```

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

**讨论线**是只读工具集、没有 worktree 的线程，开销接近零、随手丢——"设计阶段就该在两个窗口里讨论"对应的就是它。想
清楚后一键"转为实现线程"：挂上 worktree、打开写工具，对话延续。实现线两边都能开，讨论线以人开为主。

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
- **worktree 独立于线程寿命。** 线程失败、被杀、worker 丢失，worktree 都在；半成品永远不丢，父或人看 diff 后自己接手或
  开新线继续。
- **回收是策略。** 当前先保证每个 settled/待 merge child 有可解析的内部结果分支与 commit，不自动删 live worktree；完整回收
  必须同时解决线程对话脱离 cwd 后如何只读打开或显式 rehome。空闲归档与分支保留期限要由用户策略或磁盘数据定标，不预置天数；
  对话正文永不自动删除；最终报告与记忆块作为 `session` 节点进知识库，带 `spawned_from` 边，父会话之后
  可以 `recall`。**用户删除父会话**：现有的删除确认框写明后果（"还有 N 条运行中的线程，将停止并归档；worktree 保留"），
  不弹第二个模态；删除后给可撤销提示；运行中的线程停下（`outcome: cancelled`，worktree 保留）并归档，归档区提供"恢复为
  独立线程"——这是产品决定，不是技术约束（另一种可选设计是让它们直接成为工作区级的独立线程）。每条线的花费可见。
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
- `kill(id)`：默认保留 worktree。

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

## 10. Profile

### 10.1 与 Workbench Profile 的关系

[composable-workbench.md](composable-workbench.md) 的 Workbench Profile 选择 Shell 与贡献点。harness profile
扩展同一对象：一个 profile 同时绑定 Shell 布局、工具集、技能集、团队角色目录（第 9.2.2 节）、上下文策略（Zone 2
组装、压缩保留的 K、记忆块默认标签）、验证器（review 传感器等）、权限默认值与知识库 schema 扩展。**模型槽位不属于
profile**——它们是用户级设置，跟着用户的 provider 走，profile 只声明角色需要哪个槽位。选择解析沿用 `workspace →
user → active`；一个 Git 仓库默认 `code`，含大量 PDF / `.bib` 的目录建议 `research`——启发式只建议，用户显式选择。
profile 是会话级属性：切换只在会话边界生效，会话中途不换工具集与系统提示（第 8.2 节）。

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

第二个 profile 存在之前，只保证第 3 节列出的接缝存在并被 `code` 使用；不预先实现 research 专用机器。抽象从两个
实例里长出来。

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

内置的时机放在 harness 形成具体版本依赖之后（第 12 节交付顺序第 4 阶段），否则钉住的只是一个无人依赖的版本号。

## 12. 交付顺序与待决问题

### 12.1 顺序

交付单位是**可运行纵切**（协议 → host → worker → 一条真实 E2E），不是模块；能力状态按四级
（implemented / wired / proven / default-on）记在 [agent-harness-status.md](agent-harness-status.md)，只有 `proven`
算纵切完成（D-038）。逐项的文件、契约、测试与完成标准在 [agent-harness-plan.md](agent-harness-plan.md)（执行计划，
交付后删除）。

2026-09-04 复审后的顺序调整：阶段 0–1b 已交付（详见状态矩阵）；阶段 2、3、3b 的模块大部分处于 `implemented`，接线部分
`wired`。**P0 integrity、真实 child session 的 T1 线程纵切与 T2 权限纵切已完成**（具体证据见状态矩阵）。下一步是
上下文 shadow mode + 最小回放集 → 由回放数据决定压缩
接管与记忆 agent 是否开启。阶段 4 与内核正交，并行推进；阶段 5、6 暂停到线程纵切 `proven` 之后——是顺序，不是取消。
下面的阶段列表保留为原始规划。

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
   与独立模型槽位、worktree 隔离与回收策略、事件驱动等待（TTL 续缓存仅作默认关闭实验）、观察类工具的增量游标、线程侧栏与讨论线；review 传感器。
3b. **权限纵切**：Host 静态授权与 scope、`pi-permission-system` 单一提示所有权、原生 Harness fallback、Settings 与 Smart fallback。可与 3 并行。
4. **默认 runtime**：内置钉住的 Pi。
5. **外部 agent**：host 服务的 MCP 门面、ACP host、能力协商；届时重新评估协议兼容策略。
6. **research profile**：在 1–3 稳定后开始，先做知识库 schema 扩展与文献采集器，再做 Shell 面。

### 12.2 待决问题

已于 2026-09-02 决定并移入正文的：`edit` v1 保持直接写盘 + 事后 reconcile，第 2 阶段后再评估 host 权威（第 5.4 节）；
`piarium serve` 检测到桌面 host 在运行时复用它而不起第二个（第 7.1 节）；子 agent worktree 由父 agent 的 `merge` 工具
合并、Git 面板可选审阅（第 9.2.5b 节）；`event` 默认保留 30 天（第 7.2.1 节）。

已于 2026-09-04 决定并移入正文的（决策日志 D-030–D-038）：Pi 0.84.3 消费 `session_before_compact` 返回的
`{ compaction }` 并跳过自身摘要，`session_compact` 随后触发且 `fromExtension: true`（D-022，前置实验结论，第 8.4.2 节
第 2 档据此实现）；线程对象拆为 Thread + ThreadRun、状态正交（第 9.3.1 节）；`wait` 只因真实事件返回、TTL 唤醒降为实验
（第 9.2.6 节）；输出引用分 `OutputRef` / `TranscriptRef` 两级、偏移统一 UTF-8 字节（第 5.1 节）；权限三层与 Host 静态
授权（第 9.1.2 节）；设置按字段所有权（第 5.10 节）；记忆 agent shadow mode 与回放门禁（第 8.4.1、8.6 节）；父会话删除
时线程停下并归档、不弹第二个模态（第 9.3.4 节）。

尚未决定、留待 P0 之后：

| 问题 | 分叉 | 影响 |
| --- | --- | --- |
| 记忆 agent 的模型与前缀复用 | 主模型 + 承受 tools 变更的缓存失效 / 便宜模型 / 把 `memory_edit` 放进主 agent 工具集但用门控禁止主 agent 调用 | 按 provider 实测分段命中后决定（第 8.4.1 节）；第三种会让主 agent 看见一个它不能用的工具 |
| Work Graph 目标形态 | 仅 Thread + ThreadRun / 加 Artifact、Relations、Checkout 对象 | 有第二个消费者（Fleet、知识库 `session` 节点、外部 runtime）之前不扩 |
| RunManifest 的下发路径 | host 在 `session.open` 时计算并下发 / pi-host 继续自读设置 | 决定 Host 静态授权的能力集来源何时从"同源各读一次"收敛为单一来源（第 9.1.2 节过渡方案） |
| 外部 agent 的协议兼容 | 严格版本匹配 / 能力协商 / N-1 窗口 | 第 5 阶段前必须决定；影响 DTO 对未知字段的容忍设计 |
| 选装本地 embedding 模型 | CodeRankEmbed-137M / Qwen3-Embedding-0.6B / 不提供 | 影响下载体积与 ONNX 打包；不影响文件格式（维度由 Matryoshka 统一到 1024） |
| TriviumDB 无向量节点 | 原生支持 / 占位向量（当前：占位 + JS 扫描，第 7.5 节） | 决定"未配置 embedding"模式的长期实现 |
| Pi 上游缺口 | `tool_result` 钩子的执行顺序；TQL 字面量类型推断（TriviumDB 侧） | 若不能，在 harness 扩展内补或向上游提交 |
| 模型槽位预设表 | 哪些 provider 给哪些槽位默认建议 | 只是 Settings 的便利，不影响规则本身 |
| `explore` 无 LLM 时的查询扩展 | 启发式的具体规则（标识符提取、驼峰拆分、同义表、符号 BM25）与效果 | 决定零配置下 `explore` 的可用度；实现阶段用真实仓库调 |
| 缓存保活请求 | 长时间委派时 harness 自行发送同前缀最小请求刷新 TTL / 只靠 `wait` 唤醒 | 前者零注意力成本但无监督价值；默认关，观察 `wait` 的实际开销后决定 |
| 正则定位的批量修改工具 | 提供 `find_and_edit(pattern, path, glob?, instruction)`：正则定位全部匹配点，每个匹配点交给 `models.quickImplement` 独立判断改或不改（Devin 的 `find_and_edit` 形状，误报由小模型跳过）/ 不提供，跨文件同类修改由主 agent 用 `apply_patch` 或 `dispatch(quick-implement)` 完成 | 第 3 阶段子 agent 运行时就位后评估；若提供：槽位未配置则不注册，`HARNESS_TOOL_META` 记为 journaled 写入，走第 5.9 节按路径锁并行，每个匹配点的编辑经 `edit` 同一日志边界 |

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
