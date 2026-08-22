# Piarium 可组合工作台与 IDE 约定

Status: 十一个切片已交付；本文是工作台的目标架构与归属约定

Last updated: 2026-08-22

这份文档规定 Piarium 工作台的目标架构、已固定的产品决策,以及文档、编辑器、Profile、语言服务和
调试各自的归属边界。它按十一个切片组织,因为实现是按这个顺序落地的;交付进度见
[roadmap.md](roadmap.md) 的 Phase 10。切片编号只用于两份文档对读,不代表尚未完成的工作。

正文为中文。英文读者可先看 [architecture.md](architecture.md) 第 4 节的工作台概述。

## 1. 目标

把 Piarium 建成一套可由 Piarium 扩展重新组合乃至替换完整 UI/UX 的工作空间平台，同时交付两套高质量官方工作形态：

- **Agent Workspace**：会话、任务、Fleet、上下文与恢复工作流居中；
- **IDE Workbench**：项目、编辑器、搜索、Git、终端、诊断与调试居中，Agent 是可停靠的一等工作面板。

二者不是 Piarium Core 中的两个硬编码 mode，也不是两套应用。它们是普通的第一方 Piarium 扩展和 Workbench Profile。用户可以：

- 选择 Agent、IDE 或自建 Profile；
- 替换完整 `workbench.shell`；
- 只替换导航、页面、编辑器、面板、Composer、Timeline 或状态栏；
- 混合使用官方与社区贡献，例如 IDE 中央编辑器、社区 Explorer、官方 Agent 右栏；
- 动态启用、停用和更新这些扩展，而不刷新文档、不重启 Pi Runtime、不丢失共享工作状态。

Pi Packages 与 Piarium Extensions 继续是两个系统。前者扩展 Pi Agent；后者扩展 Piarium 产品、Surface 与 Application Host。不得把本计划实现成 Pi 插件配置的另一种表现层。

## 2. 已确定的产品决策

以下决定已经固定,改动它们需要先改这张表：

| 主题 | 决定 |
| --- | --- |
| 产品模型 | Profile + Piarium 扩展组合，不增加全局 `ideMode` 或 `agentMode` |
| 官方形态 | Agent Workspace 和 IDE Workbench 都是第一方 Piarium 扩展 |
| 默认形态 | 现有 `default` Profile 成为 Agent Profile 的稳定 ID，用户可按工作区选择其他 Profile |
| IDE Profile ID | `piarium.ide` |
| 编辑器引擎 | 保留并深化 CodeMirror 6；不并行维护 Monaco，不 fork Code OSS |
| 核心状态 | 文档、会话、终端、Git、Profile、Runtime 身份由共享内核拥有，Shell 只负责表现和布局 |
| 扩展自由度 | 完整 Shell 可自绘 DOM、Canvas、WebGL、WebAssembly 或使用任意框架；不强制 Piarium 组件库 |
| Profile 与启停 | 选择 Profile 不暗中启停扩展；“应用扩展集”和“选择布局”保持可观察、可分别失败的明确动作 |
| 动态切换 | 同一 Surface 内热切换；新 Shell 就绪前保留旧 Shell，失败时不提交选择 |
| 故障恢复 | Recovery Shell 由 Core 固定提供；它只负责恢复扩展/Profile，不是第三套日常工作区 |
| 移动端 | 官方移动端继续以 Agent Profile 为主；完整官方 IDE 初始只声明 desktop/web 支持 |
| VS Code | 暂时保留；自有 IDE 达到验收后收敛成 Companion，不继续建设第二套完整工作台 |
| Pi 插件 | Pi Packages、Plugin Settings 及其原生数据权威不并入 Piarium 扩展生命周期 |
| 发布 | 各 Phase commit/push；不自动创建 GitHub Release、npm tag 或发布公共 SDK，除非用户另行批准 |

## 3. 当前基线与缺口

### 3.1 可以直接复用的扩展平台

当前仓库已经具备：

- `@piarium/extension-contract`：manifest、catalog、Profile、布局和服务路由契约；
- `@piarium/extension-surface`：owner/generation 归属、原子激活、撤销、replacement 和 provider 选择；
- `@piarium/extension-loader`：declarative、managed、isolated、trusted-native Surface 生命周期；
- `@piarium/extension-host`：安装、desired/actual state、能力授权、artifact、Host entrypoint 和存储；
- `@piarium/extension-sdk` / `extension-react` / `extension-cli`：公开作者工具和测试工具；
- Workbench Profile 的 application/user/workspace 选择、显式扩展集和 revision 写入；
- `workbench.shell`、sessions、timeline、composer、agents、MCP、explorer、settings 等 replacement target；
- 固定 Recovery path 和候选版本失败回滚。

因此不得新增第二个插件管理器、第二个 contribution registry、IDE 专属 loader 或 Cordis 运行时。Cordis 只作为动态生命周期的设计参考，不成为依赖。

### 3.2 当前工作台仍然是硬编码产品壳

当前 `MainLayout.tsx`、`ContextPanel.tsx`、`SettingsView.tsx` 等仍直接拥有大量布局、页面和 Surface 分发。`App.tsx` 虽已通过 `workbench.shell` 提供 replacement seam，但 fallback 仍是完整产品 Shell。

目标不是在这些组件中增加 IDE 条件分支，而是逐步把它们注册为 `piarium.builtin.agent-workspace` 的贡献。迁移完成后，Core fallback 只剩 Recovery Shell。

### 3.3 当前文件编辑不是 IDE 文档内核

当前 `FilesView.tsx` 同时承担文件树、标签、预览、CodeMirror、搜索、创建、重命名、删除、保存和外部变化轮询。主要缺口是：

- 只有当前选中文件拥有一份活动草稿；
- `useFilesViewTabsStore` 只保存路径、选中项和树展开状态；
- 没有每个文档独立的 dirty、saving、conflict、deleted、cursor、selection 和 view state；
- `FilesAPI.writeFile(path, content)` 没有 expected revision；
- `WorkspaceAPI.writeFile` 使用可碰撞的 `mtimeMs`，与 Files editor 又形成两个写入 owner；
- 外部变化只针对当前文件轮询，dirty 时忽略，后续保存可能覆盖 Agent 或其他程序的新内容；
- `CodeMirrorEditor` 是整段字符串受控组件，不能作为多个 editor view 共享的 Document Model。

必须先建立共享文档权威，再建设 IDE Shell。禁止先画 IDE 外壳、之后再补文件一致性。

### 3.4 当前 Workbench Profile 的正确边界

现有 Profile 文档已经存储：

- Profile ID、label 和显式 extension ID 集；
- application/user/workspace 选择；
- Surface-specific replacement selection；
- contribution reference 的 region、order、size 和 visibility。

不应把所有 Shell 的布局强制成一个通用树。完整自定义 Shell 可能没有活动栏、侧栏或编辑器组。布局边界调整为：

- Core Profile 继续保存跨 Shell 可理解的 contribution reference 和 replacement selection；
- 每个 Shell 通过 `workbench.layout` service 在 profile-scoped extension storage 中维护自己的 versioned layout document；
- 共享 editor group/document state 独立于 Shell layout，因此切换 Profile 不卸载文档；
- Shell layout 缺失、空、malformed、read failure 分开处理，失败保留上次有效布局。

这避免把官方 IDE 的布局结构变成第三方 Shell 的限制。

## 4. 最终 ownership

### 4.1 Piarium Core / Application Host

Core 与 Application Host 是以下状态的唯一权威：

- application-host identity、Runtime endpoint/generation 和 Surface instance identity；
- Workspace descriptor、root 映射、项目信任和文件权限；
- 磁盘文件 revision、原子写入、watch event sequence 和恢复 journal；
- Extension catalog、desired state、capability grants、candidate 和 actual state；
- Workbench Profile、通用 contribution references 和 selected replacements；
- Pi session、终端进程、Git、LSP/DAP/test provider 生命周期；
- Recovery Shell 和扩展修复入口。

### 4.2 Shared Workbench Kernel

Shared Workbench Kernel 位于共享 UI 与其 Application Host services 中，拥有：

- open Document Registry；
- editor group、tab、resource view 和 active editor；
- command、keybinding、context-key、menu projection；
- Problems、Output、Search result 等共享模型；
- Agent context attachment 与 file-change reconciliation；
- 跨 Profile 保留的当前 workspace workbench state。

Kernel 不决定 Shell 长什么样，也不拥有扩展私有配置。

### 4.3 Shell 与普通 Piarium 扩展

Shell 与扩展拥有：

- 自己的 DOM、CSS、组件树和内部短期 UI 状态；
- profile-scoped Shell layout；
- 自己声明的 views、editors、commands、providers 和 cleanup；
- 自己 namespace 下的 revisioned extension storage；
- 被授予的 capability client。

它们不得：

- 建立第二份文档磁盘权威；
- 从 renderer 直接访问主机路径、进程、凭据或 Pi 私有状态；
- 把 transport/read failure 投影成空文件、空目录或空扩展列表；
- 用卸载 UI 的方式删除用户项目、Pi package 数据或插件原生数据库。

## 5. 稳定身份模型

所有新状态和异步操作必须携带足够身份，不能只用 path 或 session ID：

```ts
interface PiariumWorkspaceIdentity {
  applicationHostId: string;
  workspaceId: string;
}

interface PiariumConnectionOwner {
  applicationHostId: string;
  connectionGeneration: number;
}

interface PiariumSurfaceIdentity {
  applicationHostId: string;
  surface: 'desktop' | 'web' | 'mobile' | 'vscode';
  surfaceInstanceId: string;
}

interface PiariumResourceReference {
  workspaceId: string;
  uri: string;          // workspace-scoped opaque URI
  relativePath: string; // display and user intent, not host authority
}
```

要求：

- Application Host 生成稳定、opaque 的 `workspaceId`；
- persisted document/layout key 使用稳定的 application host + workspace identity；连接 generation 只用于拒绝旧异步结果；
- Pi Runtime worker generation 属于 session/Agent 执行，不进入磁盘文档身份。升级或切换 Pi 不得复制同一 workspace 的 Document record；
- 现有单目录工作区映射为一个 root，模型允许未来多个 root；
- 公共扩展 API 使用 workspace resource URI，而不是把远端绝对路径当身份；
- Core 可保留受信任绝对路径用于终端、Pi cwd 和本地“在文件管理器中显示”；
- document、search、diagnostic、editor、layout 和 recovery 状态至少由 host + workspace + resource/surface identity 隔离；
- application-host endpoint/connection 切换后，旧 connection generation 的 load、watch、save、diagnostic 和 activation completion 必须被拒绝；
- 同一 workspace 的多个窗口拥有独立未保存缓冲区，通过文件 revision/watch 发生冲突，不暗中共享编辑内容。

## 6. 公开 Workbench 契约

### 6.1 常量归属

当前 `WORKBENCH_REPLACEMENT_TARGETS` 只存在于 UI 私有模块。公共扩展无法可靠引用。把稳定 target/slot 常量移到 `@piarium/extension-contract`，UI 只 import，不保留另一份字符串表。

必须保留并公开现有 targets：

```text
workbench.shell
sessions.navigator
chat.timeline
chat.composer
agents.workbench
mcp.workbench
workspace.explorer
settings.workbench
```

新增官方可组合工作台 targets：

```text
workbench.activity
workbench.primary-sidebar
workbench.editor
workbench.secondary-sidebar
workbench.panel
workbench.status
```

新增官方 slots：

```text
workbench.activity.items
workbench.primary-sidebar.views
workbench.editor.actions
workbench.secondary-sidebar.views
workbench.panel.views
workbench.status.items
```

这些是官方 Shell 的稳定组合 seam，不要求完整自定义 Shell 必须渲染全部 slots。一个 Shell 若选择提供某个标准 slot，就必须遵守该 slot 的 props、ownership 和 disposal contract。

### 6.2 Contribution kinds

现有 `command`、`keybinding`、`menu-item`、`page`、`panel`、`sidebar`、`shell`、renderer 等继续有效。新增：

```text
view
editor
```

- `view` 表示可放入 Shell container/slot 的可复用工作视图；
- `editor` 表示根据 resource selector 打开的 resource editor；
- language/search/debug/test 是 versioned services，不为每种 service 新造 Surface contribution kind；
- `activity-item`、toolbar 和 tab action 使用 placement + command/menu，不增加无必要的专用 kind。

Manifest schema、parser、JSON schema、CLI check/build/test 和 SDK 类型必须同步，禁止 UI 私下接受 schema 不认识的 kind。

### 6.3 Profile 语义

- `default` 是官方 Agent Profile 的稳定 ID，不新增 alias。持久化 `label` 是稳定 fallback；官方 Surface 通过第一方 locale metadata 显示本地化名称；
- `piarium.ide` 在 IDE 扩展真正可用的同一 Phase 加入；
- Profile selection 是 user/workspace layout choice；
- `extensionIds` 是显式 desired-set 模板，只有用户执行 Apply set 才改变 enablement；
- 选择 Profile 时若其 Shell extension 未启用，显示“启用并切换”和“只检查配置”动作，不能静默启用；
- built-in 可被 disabled。没有可用 Shell 时进入 Recovery Shell，不阻止用户操作；
- Profile 引用暂时 missing/disabled contribution 时保留 reference，重新启用后恢复布局；
- Profile load failure 保留上次权威 Profile；malformed state 进入诊断，不回写空默认覆盖原文件。

### 6.4 Shell 切换事务

当前 persisted selection 不能在新 Shell 尚未证明可 mount 时先提交。新增 Surface-side transition controller：

1. 根据指定 Profile 解析 candidate layout，但不更改当前选择；
2. 触发 candidate Shell `contribution-visible` activation；
3. 使用 candidate owner/generation 创建 staging mount；
4. managed/isolated mount promise resolved 后视为 candidate ready；
5. 使用 `expectedRevision` 写入 Profile selection；
6. 写入成功后一次性交换可见 Shell，再逆序 dispose 旧 Shell；
7. revision conflict、activation、mount 或 render 失败时 dispose candidate，继续显示旧 Shell；
8. 启动时 selected Shell 失败则显示 Recovery Shell，保留 selected Profile 和诊断，不伪造切回默认成功。

多窗口各自报告 actual Surface state。一个窗口 mount 失败不能把全局 desired state改成 disabled。

### 6.5 Versioned service IDs

以下服务 ID 是计划中的 canonical owner。实现时若发现已有同语义公共 ID，迁移到已有 owner，而不是保留两个别名：

| Service ID | Owner / routing |
| --- | --- |
| `piarium.documents` v1 | Core/Application Host 单一 provider，Surface 得到 resource-scoped capability |
| `piarium.commands` v1 | Surface Core registry，owner-scoped handlers |
| `piarium.context-keys` v1 | Surface Core registry，extension keys namespaced |
| `piarium.workbench.layout` v1 | 当前 Shell selected provider，profile-scoped storage |
| `piarium.workbench.editors` v1 | Shared Kernel registry，允许多个 editor providers |
| `piarium.workspace.search` v1 | Application Host，可由显式 provider routing 替换 |
| `piarium.language` v1 | Host multi-provider，按 workspace/language routing |
| `piarium.debug` v1 | Host multi-provider，按 workspace/debug type routing |
| `piarium.tests` v1 | Host multi-provider，按 workspace/provider routing |

Core services 不通过 renderer global 暴露。官方 UI 使用 `RuntimeAPIs`/registry hooks；managed、isolated 和 Host extensions 使用 SDK capability/service clients。服务缺失、歧义、版本不兼容和 provider failure 是明确状态，不投影成空结果。

## 7. Revisioned Documents API

### 7.1 单一权威

新增共享 `DocumentsAPI`。所有文本编辑、预览和扩展 resource editor 最终都通过它访问内容。

迁移完成后：

- `FilesAPI` 只保留目录浏览、文件搜索和非内容型 workspace 操作；
- `WorkspaceAPI` 可保留项目/归档/Git 管理，但不再拥有另一套文本 read/write；
- 删除 `FilesAPI.readFile/statFile/writeFile` 与 `WorkspaceAPI.readFile/writeFile` 的重复编辑路径；
- 不保留长期 compatibility wrapper；同一 Phase 内完成消费者迁移和旧接口删除。

### 7.2 建议 DTO

最终 spelling 可遵循仓库风格，但语义必须完整：

```ts
type PiariumDocumentReadResult =
  | {
      status: 'ready';
      resource: PiariumResourceReference;
      revision: string;       // opaque Host revision
      content: string;
      encoding: string;
      bom: boolean;
      byteLength: number;
      modifiedAt?: string;
    }
  | {
      status: 'missing';
      resource: PiariumResourceReference;
    }
  | {
      status: 'binary';
      resource: PiariumResourceReference;
      revision: string;
      byteLength: number;
      mime?: string;
    }
  | {
      status: 'unsupported-encoding';
      resource: PiariumResourceReference;
      revision: string;
      byteLength: number;
      candidates?: string[];
    };

interface PiariumDocumentWriteRequest {
  resource: PiariumResourceReference;
  content: string;
  encoding: string;
  bom: boolean;
  expectedRevision: string | null; // null means assert missing/create
  operationId: string;
}

type PiariumDocumentWriteResult =
  | { status: 'written'; revision: string; byteLength: number; modifiedAt?: string }
  | { status: 'conflict'; current: Omit<PiariumDocumentReadResult, 'content'> };
```

网络、权限、主机和磁盘失败应 reject/返回明确 failed result，使调用者保留旧状态；不得映射为 `missing`、空字符串或 conflict。

Host 不得用 replacement characters 猜测无法可靠解码的文本。`content` 不包含 BOM，但保留原始换行序列；默认保存沿用 snapshot 的 encoding/BOM。新文件使用明确的 workspace/user 默认值。用户显式选择编码或换行格式是独立编辑操作，不在普通保存时悄悄转换。

`DocumentsAPI` 同时提供 revision-checked `move` 和 `delete`。源文件使用 expected revision；目标已存在、源已改变、源缺失是不同结果。用户在 conflict UI 选择“以我的版本覆盖”时，先读取并展示当前 disk candidate，再使用它的最新 revision 写入；不得增加一个绕过 revision 的普通 `force: true` 保存路径。

Revision 算法由 Host 私有实现，必须能检测常见的相同 mtime/不同内容变化。Host 串行化 Piarium 对同一 resource 的 mutation，在写入边界再次校验 expected revision，并使用同目录临时文件 + atomic replace。不得向 UI 暴露 revision 的组成，也不得声称普通文件系统可以提供不存在的跨进程强事务保证。

### 7.3 Watch contract

Application Host 为 workspace 提供有序文件事件：

```ts
type PiariumWorkspaceFileEvent =
  | { kind: 'created' | 'changed' | 'deleted'; sequence: number; resource: PiariumResourceReference; revision?: string }
  | { kind: 'moved'; sequence: number; from: PiariumResourceReference; resource: PiariumResourceReference; revision?: string }
  | { kind: 'reset'; sequence: number; reason: 'overflow' | 'reconnected' | 'authority-changed' };
```

要求：

- sequence 只在同一 application host + workspace watch generation 内比较；
- reconnect/overflow 发送 `reset`，消费者重新读取打开文档和可见树，不从不完整事件推断删除；
- Web 使用认证后的已有 transport/明确 route；凭据不进入 URL；
- Electron 复用 Web/Application Host，不新增文件系统 preload IPC；
- VS Code 通过 extension host 的 workspace filesystem watcher 实现相同抽象；
- hosted mobile 复用远端 Web host；本地 Capacitor 文件系统不意外 fall through；
- watcher 只通知元数据，不发送文件正文，不记录正文；
- visible/open resources 驱动读取，隐藏 Shell 不启动第二个 watcher。

## 8. Document Registry 与编辑状态

### 8.1 状态模型

每个文档拥有独立 record：

```text
unloaded -> loading -> ready
                    -> dirty
                    -> saving
                    -> conflict
                    -> deleted
                    -> error
```

Record 至少包含：

- workspace/resource/application-host identity，以及当前异步操作捕获的 connection generation；
- base content/revision；
- current buffer 与 monotonic local edit revision；
- dirty/saving/conflict/deleted/error；
- active save operation ID 和它捕获的 edit revision；
- 外部 candidate snapshot；
- attached editor views 与 language-service subscriptions；
- recovery journal revision。

高频正文不能放进会让整个 React 树或 broad Zustand selector 每个按键重跑的普通对象图。实现一个外部 `DocumentRegistry`，提供 per-document subscription；Zustand 只保存低频导航/布局元数据。CodeMirror transaction 进入 document model，再只通知该文档的 views 与服务。

### 8.2 并发不变量

- load 开始时捕获 local edit revision，返回时不能覆盖更新的草稿；
- save 捕获内容、base revision 和 local edit revision；save 成功后若已有新编辑，只推进 base 到已保存版本，文档仍 dirty；
- clean 文档收到新 revision 自动 reload；
- dirty 文档收到新 revision 进入三方 conflict：base、buffer、disk candidate；
- delete/move 事件不会静默关闭 dirty 文档；
- application-host endpoint/workspace switch 前，pending write 要么完成在捕获 owner，要么以明确取消结果保留 recovery journal；
- mode/Profile/Shell 切换不触发 document unload；
- 多窗口各自 buffer，用 revision/watch 发现冲突；不实现隐式协同编辑；
- authoritative read failure 保留现有文档与 dirty 状态；
- no-op file event 不创建新 record 或刷新无关 editor。

### 8.3 恢复 journal

未保存正文属于敏感项目数据。Recovery journal：

- 由 Application Host 写到 `PIARIUM_DATA_DIR` 下的 Piarium 文档恢复 namespace；
- keyed by application host + authenticated user/profile + workspace + recovery session + resource；
- client 在页面重载/窗口恢复范围内保留 recovery session ID；Host 可列出同一用户/workspace 的 orphan journals，让新 Surface 显式接管或丢弃；
- 使用 revisioned/serialized writes；
- 只在有未保存修改时存在；保存或明确放弃后删除；
- 崩溃重启后提供 restore/discard/diff，不自动覆盖项目文件；
- 不写入浏览器 Local Storage 大文本，不写日志，不进入 Pi session JSONL；
- 不使用猜测性的数量/字节/天数硬限制。真实磁盘风险通过可见用量、清理动作和后续测量治理。

## 9. Editor Workbench Kernel

### 9.1 Document 与 Editor View 分离

一个 Document 可同时被多个 Editor View 打开：

- Document 共享正文、base revision、dirty/conflict；
- View 独立保存 cursor、selection、scroll、fold、focus 和临时 UI；
- 同一 Document 的编辑 transaction 广播给其他 views，但不覆盖各自 selection；
- Profile 切换只 unmount/mount views，Document record 继续存在；
- 关闭最后一个 view 时，dirty 文档要求 save/discard/keep-in-recovery 的明确选择。

### 9.2 Editor Group

共享 editor state 包括：

- split tree（horizontal/vertical）；
- group ID、tab order、active tab；
- preview/pinned tab；
- resource + editor provider ID；
- transient diff/preview input；
- per-workspace restore snapshot。

这份状态独立于 Agent/IDE Shell layout。Agent Profile 可以把同一 editor group 显示在右栏；IDE Profile 可以把它显示在中心；没有可见 editor container 时状态仍保留。

### 9.3 Editor provider

公开 `editor` contribution 通过 selector 声明支持的 scheme、mime、language、filename pattern 和 read/write 能力。解析顺序：

1. 用户对该资源/类型的显式关联；
2. 当前 Profile 的 replacement/provider selection；
3. selector specificity 与声明 order；
4. 官方 text/binary fallback。

同优先级歧义显示选择器并可记住用户选择，不依赖加载时序。Editor provider 通过 Document capability 操作内容；只有额外获得 workspace-files capability 时才能执行任意文件操作。

官方 resource editors 至少包括：

- text/code；
- diff；
- Markdown preview；
- image；
- JSON tree/raw；
- PDF；
- Drawio/HTML preview 沿用现有安全边界。

### 9.4 CodeMirror 迁移

- 不替换 CodeMirror 6；
- 新建 document-bound CodeMirror adapter，不再每次 props 变化替换完整 document；
- editor view dispatch transaction 到 Document Registry；
- language、diagnostics、completion 和 decorations 作为 compartments/extensions 动态重配；
- current `MAX_OPEN_FILE_LINES=5000` 不是新 IDE 的永久产品边界。先测量现有文件规模与 CodeMirror 行为，再决定警告、只读降级、分块或虚拟化；不得直接提高或复制一个猜测数字。

### 9.5 官方 Shell layout document

Agent 和 IDE Shell 各自维护 layout schema，不由 Core 强迫第三方采用。官方 IDE 的 v1 layout 至少表达：

```ts
type PiariumIdeLayoutNode =
  | { id: string; kind: 'split'; axis: 'horizontal' | 'vertical'; children: string[]; weights: number[] }
  | { id: string; kind: 'stack'; viewIds: string[]; activeViewId?: string }
  | { id: string; kind: 'editor-area' };

interface PiariumIdeLayoutDocument {
  schemaVersion: 1;
  rootId: string;
  nodes: Record<string, PiariumIdeLayoutNode>;
  floating: Array<{ viewId: string; x: number; y: number; width: number; height: number }>;
  activityVisible: boolean;
  statusVisible: boolean;
}
```

约束：

- `editor-area` 只挂载共享 Editor Groups，不复制 tab/document state；
- stack 中保存 contribution/view IDs，missing/disabled view reference 不删除；
- distribution default、user default 和 workspace override 使用 extension storage 的现有 scope/revision，不把 JSON 塞回 React state；
- malformed/read failure 使用上次有效布局和诊断，不写回空布局；
- resize/reorder writes 捕获 profile/workspace owner，串行并拒绝 stale revision；page hide/freeze 时 flush；
- drag/resize 交互使用 container measurements，不用 viewport breakpoint 猜测；
- floating 是普通 Surface 内浮层。真正的额外 native window 仍由 Electron 能力与明确扩展 grant 管理。

## 10. Command、Keybinding 与 Context Keys

所有官方 Shell 和 IDE 操作通过共享 command service，不继续增加组件私有快捷键分支。

需要：

- owner-scoped command registration/disposal；
- keybinding contribution 和用户 override；
- versioned context-key store；
- menu/toolbar/action 由 command + `when` 投影；
- core keys 如 active workspace、active editor、resource language、dirty、conflict、terminal focus、agent busy；
- extension 自定义 keys 必须 namespace 到 extension ID；
- context key 变化只通知依赖该 key 的 commands/views，不全量重算全部贡献；
- command 执行捕获 Surface、workspace、resource 和 owner generation，晚到 completion 不更新新 owner。

官方命令至少覆盖 Profile/Shell 选择、文件打开/保存/关闭、split、搜索、问题导航、终端、Agent focus/context attachment。

## 11. Search 与 Language Services

### 11.1 Search

- 文件名搜索沿用并收敛现有 Files search authority；
- 内容搜索在 Application Host 执行，可取消、workspace scoped、结果 streaming/batched；
- symbol 搜索来自 language providers；
- query generation 与 workspace identity 进入每个 request/result；
- 搜索取消或失败保留已明确展示的旧结果并显示 stale/failed，不伪装为零结果；
- 不为隐藏 Search view 保持全仓 poll；
- 大仓库优化以真实 scale trace 为依据，优先缩小/索引/增量，不先加任意结果或文件数限制。

### 11.2 Language service

新增 versioned Host service，例如 `piarium.language-server`，由现有多 provider 路由选择具体实现。职责：

- workspace/language/provider generation 维度启动和停止 LSP；
- JSON-RPC transport、restart、diagnostics 和 progress；
- textDocument open/change/save/close 使用 Document local version；
- completion、hover、definition、references、rename、code action、document/workspace symbols；
- stale document version 的 diagnostics/result 不提交；
- 一个 provider 失败不清空其他 provider 的 diagnostics；
- workspace trust 和 capability grant 在 Host spawn 边界执行；
- 不在 renderer、Pi worker 或 Electron preload 中启动 language server；
- 不把所有语言服务器打进普通安装包。第一方/社区 language extension 提供 discovery、command 和配置。

Electron 复用同进程 Web/Application Host。远程 Web 在服务器工作区运行 LSP。VS Code 可以桥接其 extension host 或稳定声明 unsupported，不允许浏览器意外 spawn。

## 12. Agent 与编辑器协作

### 12.1 上下文附件

Active editor、selection、Problems、Git diff 都可以形成显式 Agent attachment：

```ts
interface PiariumEditorContextAttachment {
  resource: PiariumResourceReference;
  documentRevision: string | null;
  localEditRevision: number;
  source: 'saved' | 'unsaved-buffer';
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  languageId?: string;
}
```

- saved attachment 可让 Pi 工具读取磁盘；
- unsaved attachment 的实际文本作为明确的 prompt/context payload 发送，UI 标记“未保存快照”；
- 不创建隐藏 shadow workspace，也不声称 Pi 文件工具能看到未保存 buffer；
- 用户决定附加 selection、完整 buffer 或仅 path；
- provider/model context 上限通过现有 token/usage 反馈呈现，不新增猜测性的固定字符上限。

### 12.2 Agent 文件修改

Pi 和 Pi 插件继续写真实 workspace 文件。Document watcher 负责协调：

- clean open document：载入新 revision，并在 UI 标明 Agent 修改来源（可从 session/tool hint 补充，但文件事件仍是权威）；
- dirty open document：进入 conflict，不 autosave 覆盖；
- closed document：更新 tree/Git/search invalidation；
- rename/delete：保留 dirty buffer 并提供 save as/compare/discard；
- tool diff、timeline changed files 和 editor diff 可以互相导航；
- Patch review 支持逐文件/逐 hunk 接受、拒绝或手工合并，但最终写入仍走 DocumentsAPI revision precondition。

恢复插件仍拥有会话/工作区历史能力；Document conflict 不复制 `pi-workspace-history` 私有状态。

## 13. Runtime 与 Surface 行为矩阵

| Runtime/Surface | Documents/Watch | Agent Profile | IDE Profile | Host services |
| --- | --- | --- | --- | --- |
| Web 本地/远程 | Web Application Host | 完整 | 完整 | 文件、终端、Git、LSP/DAP 均在服务器 |
| Electron | 复用 Web Host | 完整 | 完整 | 只有窗口/菜单/对话框等原生能力走 Electron IPC |
| Hosted mobile | 复用远端 Web Host | 完整移动布局 | 官方 IDE 初始不声明支持 | 远端 Host |
| Capacitor | 连接 Piarium server | 完整移动布局 | 稳定 unsupported | 不直接访问设备项目文件 |
| VS Code | extension-host bridge | 保留当前工作流 | 官方 IDE 不声明支持 | 文件/LSP 可桥接或明确 unsupported |
| Headless | Host contract only | 无 Surface | 无 Surface | Documents/search/language provider 可供协议测试 |

每个新增 Runtime API 在共享接口中明确以上行为。Electron 不因为“桌面 IDE”而获得一个并行文件后端。

## 14. 性能契约

不用随意的实体上限掩盖性能问题。先记录真实交互、代表性仓库和当前成本，再决定实现。

结构性要求：

- 隐藏/停用 Shell 和 view 不执行轮询、文件树扫描、Git refresh 或 language request；
- 文件事件成本与受影响 resource/open views 成正比，不与全部项目 × 全部文档相乘；
- 高频 buffer 不进入 broad Zustand state 或每键 durable serialization；
- editor/group/document selectors 保留无关对象引用；
- Search、index 和解析不阻塞主线程交互；
- 同一 workspace 的 watch/search/language service 由 provider 共享，不由每个 view 重复启动；
- Profile 切换不重新读取所有文档、不销毁终端、不重新建立 Pi session；
- inactive extension 的 declarative metadata 可存在，但 executable entrypoint 只按 activation event 加载；
- 记录 Shell mount duration、document count/bytes、watch event backlog、LSP process 和 cleanup failure，先用于 Inspector/诊断，不转化成无依据硬拒绝。

性能验收优先使用 operation count、无关引用稳定性、inactive zero-work 和真实 production build trace。不得仅凭 memo、单个微基准或 type-check 声称性能完成。

## 15. 安全与数据边界

- workspace path containment、symlink 和 project trust 在 Application Host 执行；
- custom editor 默认只得到当前 resource 的 Document client，不自动得到整个文件系统；
- LSP/DAP/task subprocess 必须由 Host capability 启动，renderer 只发送 typed request；
- remote page、preview iframe 和 isolated extension 不继承 Electron 本地权限；
- file contents、unsaved buffers、prompt attachments、credentials、LSP payload 和 recovery journal 不写普通日志；
- trusted-native mode 保持显式，不伪装成隔离；
- Recovery Shell 不加载普通扩展代码；
- 扩展 disable 保留 storage/layout/document data；remove 时 retain/delete 只影响该扩展 namespace；
- 不增加没有真实失败模式依据的文件大小、并发、扩展数、进程数或语言数限制。

## 16. 验证强度按风险分配

每个切片独立成一个可回退的提交。验证跟着风险走，不靠重复次数堆证据：

1. 迭代时只跑直接受影响的 focused tests；
2. 切片完成时跑归属包的 type-check、lint 和契约测试；
3. 改公共 contract/export 时跑其消费者的 build/type-check，并跑一次 `bun run dead-code`；
4. 只有改 UI Shell 的切片才跑 production Web build；
5. 只有 Electron startup/package 边界变化时才跑 bundled dev/package smoke；
6. 完整 workspace suite、Windows installer、Docker 和 CI 留到最终收敛；
7. 每个切片跑一次 `git diff --check`；
8. 准确记录哪些检查跑了、哪些没跑。

公共 npm tooling 在契约稳定前使用 workspace source，等整套工作台切片收敛后再准备协调版本。

## 17. Phase 1 — Workbench composition foundation

### 17.1 目标

让现有扩展平台具备公开、可测试的标准 Workbench seams 和“先 stage、后提交”的 Profile 切换，不实现 IDE UI。

### 17.2 写入边界

- `packages/extension-contract`：公开 target/slot 常量、`view`/`editor` kinds、显式 profile resolution helper；
- `packages/extension-surface` / `extension-loader`：仅补充 stage/ready/owner lifecycle 所需能力；
- `packages/ui/src/lib/extensions`：transition controller、Profile bridge 和 Recovery Shell 接入；
- `packages/extension-host`：只在需要的 Profile revision/diagnostic 边界修改；
- Extensions Settings：显示 active profile、selected shell、missing/disabled/failed diagnostics 和明确 Apply set。

不要修改文档编辑、FilesView、MainLayout 产品结构。

### 17.3 验收

- 公共 schema 能验证新增 kinds/slots；CLI 与 SDK 同步；
- target 常量只有 `extension-contract` 一个 owner；
- 切换到同步、异步 managed、isolated Shell 都在 ready 后提交；
- candidate activation/mount/render/revision conflict 保留旧 Shell；
- active Shell 被 disable 后进入 Recovery Shell，能够重新启用或选择其他 Profile；
- Profile selection 不修改 desired extension set；
- application-host endpoint switch 拒绝旧 candidate completion；
- 多窗口 actual state 分开。

## 18. Phase 2 — Workspace identity and DocumentsAPI

### 18.1 目标

在不改现有 Files UI 的前提下建立 workspace/resource/revision/watch authority，并实现 Web/Electron/VS Code 明确 parity。

### 18.2 写入边界

- `packages/ui/src/lib/api/types.ts`：Workspace identity、resource DTO、DocumentsAPI；
- `packages/web/src/api` 与 server routes/services：resource mapping、read/write、watch、recovery storage；
- `packages/vscode` bridge：workspace FS 和 watcher 实现；
- `packages/extension-host` / SDK capability：resource-scoped document access；
- Electron 只复用 Web，不新增通用文件 IPC；
- mobile 声明远端/unsupported 行为。

同一 Phase 将 `WorkbenchProfileBridge` 的 workspace scope 从裸 `currentDirectory` 迁移为 application-host 提供的 workspace ID。对当前持久化 raw-path selection 做一次原子迁移：只在同一 Host 能明确解析该路径时迁移，成功后写回 canonical ID，不保留永久双查找，也不让另一台 Host 的同名路径继承选择。

### 18.3 必测边界

- missing、empty、binary、read failure；
- create with expected missing；
- stale revision conflict；
- same-mtime content change；
- mutation during read/write；
- watch created/changed/moved/deleted/reset；
- overflow/reconnect 不推断删除；
- symlink、path escape、untrusted project；
- application-host endpoint switch stale completion；
- recovery journal missing/malformed/write failure。

### 18.4 验收

- API 具备单一 Host authority 和 opaque revision；
- Web 与 VS Code 行为通过相同 contract fixtures；
- Electron 仍只使用 in-process Web Host；
- file content 不出现在日志/event；
- 现有 FilesView 尚未迁移也不受行为回归。

## 19. Phase 3 — Document Registry and current editor migration

### 19.1 目标

建立 per-document external store、并发保存与恢复模型，把当前 Files/Workspace 文本编辑迁入唯一 DocumentsAPI，界面外观尽量不变。

### 19.2 写入边界

- 新增 Document Registry、document hooks、recovery client 和 focused model tests；
- 新增 document-bound CodeMirror adapter；
- 迁移 `FilesView`、preview、inline editor、Workspace file editor 和 open-file helpers；
- 删除重复 `FilesAPI` / `WorkspaceAPI` text read/write shape 及所有 runtime 实现；
- `useFilesViewTabsStore` 暂时只保留 tree/tab navigation，正文不进入该 store。

### 19.3 验收场景

- 同时打开并修改多个文件，切换 tab 不要求先保存；
- clean external/Agent edit 自动刷新；
- dirty external/Agent edit 进入三方 conflict；
- save in flight 时继续输入，返回后保留后续 dirty edits；
- rename/delete dirty file 不丢 buffer；
- read/save failure 保留旧权威和 dirty 状态；
- Profile/Settings/context surface remount 不丢文档；
- crash 后恢复草稿但不自动写磁盘；
- 同一文档两 view 内容同步，selection 独立；
- 高速输入不触发全局 store/persistence 每键重写。

## 20. Phase 4 — Editor Workbench Kernel

### 20.1 目标

把文件树、文档、编辑器组和资源编辑器从大 FilesView 拆成可被任意 Shell 挂载的共享 Kernel。

### 20.2 交付

- Editor Group split tree、tab、preview/pinned、active group；
- per-view cursor/selection/scroll/fold restore；
- Explorer view 与 Document/Editor 分离；
- text、diff、Markdown、image、JSON、PDF、Drawio/HTML providers；
- editor provider registry、selector、用户关联和歧义选择；
- commands/context keys/menu projection；
- terminal/problems/output container model 与现有 store/service 对接；
- workspace-scoped workbench snapshot，Profile-independent；
- current Files surface 作为对新 Kernel 的适配器，旧大组件被删除或收敛为组合层。

### 20.3 验收

- 分屏、移动 tab、同文档多 view、关闭/恢复；
- resource provider enable/disable/update 时 editor 局部 fallback；
- disabled/hidden editor contribution 无后台工作；
- workbench restore 区分 missing、empty、malformed、failure；
- workspace/runtime switch 不串 tab、路径或 buffer；
- no broad selector per keystroke；
- 当前 Agent 产品文件、diff、terminal、Git 工作流不回归。

## 21. Phase 5 — Agent Workspace as a built-in extension

### 21.1 目标

证明现有完整 Piarium 产品可以运行在 Piarium 扩展平台上，而不是依赖 Core 的硬编码 MainLayout。

### 21.2 交付

- `piarium.builtin.agent-workspace` manifest 与 Surface implementation；
- `piarium.builtin.agent-workspace.shell` contribution；
- `default` Profile 使用稳定 `Agent` fallback label，官方 locale metadata 显示本地化名称，并引用该 Shell；
- MainLayout、session navigator、chat timeline、composer、context rail、settings 等通过 contributions/slots 组合；
- desktop/web 和 mobile 各自受支持的 Agent Shell contribution；
- `App.tsx` 的日常 fallback 改为 Recovery Shell；
- 现有功能只有在完整 contribution owner 存在后才删除 hard-coded switch；
- disabled Agent extension 不删除 session/document/layout state。

### 21.3 验收

- 新安装默认进入 Agent Profile；
- active Agent extension disable 无 reload，进入 Recovery；re-enable 恢复；
- 社区 shell replacement 可以完全替代 Agent；
- navigator/timeline/composer/Agents/MCP/Settings 可分别替换；
- Agent Shell failure 不导致空白页或 React root 崩溃；
- desktop/web/mobile 原有核心 journey 可用；
- application startup 只激活当前可见贡献。

这一 Phase 跑一次 production Web build；若 App root/startup 改变，再跑 bundled Electron smoke，而不是整个安装包矩阵。

## 22. Phase 6 — Official IDE Workbench extension

### 22.1 目标

交付第一方但可停用、可替换的 IDE Workbench，以及 `piarium.ide` Profile。IDE 不获得任何独立文档、终端或 Git owner。

### 22.2 官方布局

- Activity：Explorer、Search、Git、Run/Test、Extensions；
- Primary sidebar：选中的 workspace view；
- Center：共享 Editor Groups；
- Secondary sidebar：Agent、Context、Fleet、Recovery 等可停靠 views；
- Bottom panel：Terminal、Problems、Output、Tasks；
- Status：workspace、branch、language、diagnostics、Runtime/Agent 状态；
- Command Palette 与统一 keybinding/context keys；
- Shell layout 存于 `piarium.builtin.ide-workbench` 的 profile-scoped storage。

### 22.3 Profile 和生命周期

- 同一 commit 新增 IDE extension、contributions 和 `piarium.ide` Profile；
- 官方分发可预装 Agent 与 IDE，代码按 contribution-visible lazy activation；
- Profile 选择不强制启用用户已停用的 IDE extension；
- 提供明确“启用并切换”组合动作，并分别展示 enable 与 selection 结果；
- Agent/IDE 热切换保留 documents、editor groups、terminals、sessions、Git 和 Agent state；
- 自定义 Shell 可以只消费部分标准 slots，或完全自绘。

### 22.4 验收

- Agent -> IDE -> Agent 无 reload、无文档/终端/会话丢失；
- workspace-specific Profile 选择不污染其他 workspace/host；
- IDE layout 独立保存，切回后恢复；
- extension update/disable 中 active view 局部 fallback；
- IDE Shell 异步 mount 失败继续显示旧 Shell；
- 没有 LSP 时基础编辑、搜索、Git、终端和 Agent 仍可用，不显示伪造健康；
- desktop/web production build 和一次真实浏览器交互检查通过。

## 23. Phase 7 — Search and language-service infrastructure

### 23.1 目标

把 IDE 从“多面板文本编辑器”推进到具备标准语言智能的工作台，同时保持 provider 可插拔。

### 23.2 交付

- cancellable workspace file/content search service；
- Problems/diagnostic registry；
- Host-side LSP supervisor 和 versioned service contract；
- Document incremental sync；
- completion、hover、definition、references、symbols、rename、code actions；
- language provider routing、workspace trust、restart/diagnostics；
- CodeMirror language/client adapter；
- 一个受控 fixture server 契约测试和至少一个真实 TypeScript LSP smoke；
- Python/Rust 等通过相同 provider contract 接入，不硬编码到 Core。

### 23.3 验收

- provider absent、starting、ready、degraded、failed 分开；
- stale diagnostics/completion 不进入新 document version；
- provider crash 只影响自己的 workspace/language；
- hidden editor/search view 不重复启动服务；
- remote Web server 执行 LSP，renderer 不 spawn；
- untrusted workspace 不执行项目提供的 server command；
- application-host endpoint/workspace switch 回收旧进程和 listeners；
- search failure 不显示“0 results”。

## 24. Phase 8 — Agent/editor transactions

### 24.1 目标

让 Agent 与 IDE 在同一文档/version 模型上协作，解决 unsaved context、Agent 磁盘修改、冲突和 Patch review。

### 24.2 交付

- active editor/selection/diagnostic/diff attachment；
- saved 与 unsaved-buffer 的明确来源；
- unsaved text prompt projection；
- Agent tool changed-file hints 与 authoritative watcher reconciliation；
- dirty conflict UI、三方 diff/merge；
- patch/hunk accept/reject/edit；
- session timeline/file editor 双向跳转；
- changed files view 与 Document revisions 关联；
- composer、Agent panel 和 IDE command 共用一套 attachment service。

### 24.3 验收

- Agent 修改 clean/dirty/open/closed/moved/deleted 文件；
- user 保存与 Agent write 并发；
- unsaved attachment 的 Pi 可见内容和磁盘不可见事实均准确；
- reject/accept 使用 expected revision，冲突不覆盖；
- session/runtime switch 不把 attachment 发到错误 Agent；
- 不复制 workspace-history、WTF 或其他 Pi 插件私有数据。

## 25. Phase 9 — Public Workbench SDK and ecosystem handoff

### 25.1 目标

把经过官方 Agent/IDE 验证的 contracts 交给社区，而不是先发布未经真实产品使用的抽象。

### 25.2 交付

- public manifest/schema/SDK 的 `view`、`editor`、targets、slots、document clients、context keys；
- framework-neutral Shell、view、editor mount APIs；
- React adapter；
- Host language-provider API；
- conformance fixtures：enable/disable、async mount、candidate rollback、profile switch、resource conflict、runtime switch；
- 示例扩展：完整 Shell、自定义 editor、侧栏 view、language provider；
- Extension Inspector 显示 contribution placement、active Shell、document/language service owners 和 cleanup；
- authoring docs 与 CLI init template；
- coordinated npm tooling next version preparation。

### 25.3 验收

- monorepo 外的 disposable project 可以 build/test/install 示例；
- 任意框架 Shell 不 import Piarium React/private UI；
- isolated extension 通过 MessagePort capability 编辑 resource；
- disable physically destroys isolated realm 并保留 document/layout；
- managed extension disposer、object URL、styles、commands、services 全部清理；
- malformed/unknown contract 明确失败；
- npm pack 内容和 public exports 与文档一致。

发布公共版本是独立决定，不随这一切片自动发生。

## 26. Phase 10 — Run, debug and test workbench

### 26.1 目标

补齐 IDE 的运行、调试和测试闭环，并继续使用 provider/service 架构。

### 26.2 交付

- workspace tasks/run configurations；
- Host-side DAP supervisor；
- breakpoints、threads、stack、variables、watch、debug console；
- test discovery、tree、run/debug、results 和 output；
- command/context/menu integration；
- extension-contributed debug adapters 和 test providers；
- Agent 可以引用测试失败/stack/diagnostics，但不会取得未授权进程能力。

### 26.3 验收

- 至少一个真实语言完成 run/debug/test；
- provider/process crash 可恢复且不拖垮 Shell；
- workspace switch 停止旧 debug/test owner；
- disable provider 清理 process/listener/view；
- hidden views 没有持续刷新；
- 远程 Web 与 Electron 复用 Host，renderer 不启动调试器。

## 27. Phase 11 — VS Code Companion transition and convergence

### 27.1 进入门槛

只有满足以下条件才缩减 VS Code：

- IDE Profile 已覆盖文件、搜索、Git、终端、语言、Agent context、run/test/debug 的目标路径；
- Agent Profile 与 IDE Profile 在 Web/Electron 稳定；
- 用户数据/深链接/会话打开路径有迁移说明；
- VS Code 当前特有能力有明确保留、迁移或拒绝结论。

### 27.2 Companion 目标

VS Code 扩展保留：

- 打开/聚焦 Piarium；
- 将文件、selection、diagnostic 发送到 Piarium；
- 查看/切换当前 Agent session；
- deep link 和状态；
- 必要的 workspace bridge。

不再维护完整平行的 Settings、Agent manager、session editor 和第二套 Runtime UI。删除能力前完成真实使用路径迁移，不保留永久双实现。

### 27.3 最终 convergence

这一 Phase 才运行：

- full workspace type-check/lint；
- public package build/pack/conformance；
- production Web build；
- Electron bundled dev、Windows x64 package/smoke，适用时 ARM64 CI；
- hosted Web/cloud smoke；
- mobile Agent Profile build/smoke；
- VS Code Companion build/package；
- high-value GitHub CI；
- `bun run dead-code` 和 docs validation。

## 28. 跨切片的行为要求

下面是整套工作台必须同时成立的性质，跨切片有效。它们的权威证据是代码里的测试，不是这份文档里的
勾选状态——本节曾经是一张逐项打勾的验收表，但打勾从未回填，所以那张表既不能证明完成、也不能证明
未完成。要看某一条现在由什么守着，去对应包的测试和 `DOCUMENTATION.md`。

### Profile 与扩展

- Agent 与 IDE 都通过普通 built-in extension manifest 注册；
- 没有 `ideMode` 条件树成为第三个 ownership；
- Profile 选择与 extension set apply 是两个可分别失败的动作；
- Shell candidate ready 后才提交 selection；
- enable/disable/update 不触发 document reload；
- 最后一个 Shell 被停用时 Recovery 仍可用；
- 社区 Shell 可以不使用官方布局或 React。

### 文档与文件

- 只有一个 DocumentsAPI 内容权威；
- expected revision 加原子写入；
- missing、empty、binary、failure 互相可区分；
- clean external update 与 dirty conflict 分开处理；
- save、load、hydration 的竞态有明确结果；
- move、delete、rename 走同一套 revision 校验；
- 崩溃后可恢复；
- application-host endpoint、workspace、多窗口互相隔离；
- 文件内容不进日志。

### Workbench

- 多个 dirty document 同时存在；
- split 与 editor group；
- 同一文档多个视图；
- resource provider 有 fallback；
- Agent/IDE 切换保留状态；
- Shell 私有布局与共享编辑器状态并存；
- 隐藏的视图不做后台工作；
- 键盘、context key 和菜单有明确归属。

### Agent、LSP 与调试

- 未保存内容只在显式附加时进入 Agent；
- Agent 写入遇到 dirty buffer 走冲突流程；
- 过期的语言或调试结果被拒绝；
- provider 相互隔离且能清理；
- 项目信任在 Host 侧判定；
- 远程运行时保持一致行为；
- 不复制任何 Pi 插件的私有状态。

## 29. 主要风险与处理

| 风险 | 处理 |
| --- | --- |
| 先做 IDE UI 导致后补文档一致性 | Phase 2–4 是 Phase 6 前置门槛 |
| MainLayout 迁移时出现两套 Shell owner | 每个 seam 完整迁移后删除 hard-coded branch；不保留永久 wrapper |
| Profile 切换先持久化导致白屏 | staging mount ready 后再 revision commit |
| 外部/Agent 修改覆盖 dirty buffer | expected revision + watch + explicit conflict |
| 每按键全局 rerender/persist | per-document external store，正文不进 broad Zustand |
| 通用布局限制第三方 Shell | Profile 只存通用 refs；Shell layout 属于 profile-scoped service/storage |
| 公共 SDK 过早冻结错误抽象 | 官方 Agent、IDE、editor、LSP 先消费；Phase 9 才发布 |
| LSP/DAP 子进程失控 | Application Host supervisor、owner generation、workspace trust、shutdown cleanup |
| Electron 重复后端 | Electron 继续复用 Web/Application Host |
| VS Code 永久双实现 | Phase 11 有进入门槛，达到后删除重复产品 UI |
| 为大文件/仓库随意加小上限 | 先测量真实 scale，使用警告、按需加载、索引、背压或可配置策略 |

## 30. 最高风险的边界

复核这套工作台时，按风险排序看下面这些边界，而不是机械重跑全部命令：

1. Shell/Profile stage-and-commit 与 Recovery；
2. Document revision/watch/conflict/recovery；
3. Agent/IDE 热切换状态保留；
4. external extension disable/update cleanup；
5. LSP/DAP provider generation 与 workspace trust；
6. Web/Electron/VS Code/mobile 明确 parity；
7. 公共 npm tarball 与文档契约一致。
