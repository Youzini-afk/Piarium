# Piarium 客户端边界与扩展契约治理执行计划

Status: delivered; this document records the implemented boundary and conformance contract

Last updated: 2026-09-01

## 1. 目标

本计划同时治理 `packages/ui` 的职责边界和公共扩展契约的真实性。目标不是按目录或行数机械拆包，
而是让内部依赖方向、第三方扩展 ABI 和实际运行行为一致。

完成后应满足：

1. Web、VS Code 和 React UI 不再通过 `@piarium/ui` 共享应用客户端契约。
2. Document Registry、Editor Workbench Kernel 与 React 表现层形成可执行的单向依赖。
3. 官方 Agent/IDE Shell 与扩展运行时分离，不再把大块产品 UI 放在 `lib/extensions`。
4. JSON Schema、runtime parser 和 compatibility 判断各自职责明确。
5. 未知 contribution contract 能被识别，但不会被旧宿主误执行。
6. `when` 从无人执行的字符串字段升级为真实、可测试的结构化 context expression。
7. npm 发布测试能从真实发布包构建并运行一个外部 Shell。
8. 不减少现有 Shell、view、editor、slot、replacement、service 和 document client 等公开能力。

## 2. 实施前基线问题

### 2.1 `@piarium/ui` 同时充当 UI 和应用客户端契约

`packages/ui/src/lib/api/types.ts` 定义 `RuntimeAPIs`、Documents、Files、Git、Language、Tasks、Debug、
Tests、Extensions 等接口。Web 和 VS Code 为了实现这些接口，直接从 `@piarium/ui` 导入类型、错误和
runtime transport。结果是非 UI 包反向依赖完整 UI 源码。

当前还存在以下反向依赖：

- `RuntimeAPIProvider` 同时挂载 Agent/editor 与 run/debug 协调器；
- Store 导入 `components` 下的纯业务逻辑；
- `lib/extensions` 同时包含 extension runtime 和完整官方 Shell；
- `lib/settings` 的 registry 直接导入大量 React 页面；
- Document Registry 和 Workbench Kernel 仍直接读取部分 UI runtime/store integration。

Document Registry 和 Editor Workbench Kernel 本身已经形成较清晰的领域边界，适合先建立内部依赖
规则，再决定是否物理拆包。相关当前约定见：

- [`packages/ui/src/lib/documents/DOCUMENTATION.md`](../packages/ui/src/lib/documents/DOCUMENTATION.md)
- [`packages/ui/src/lib/workbench/editors/DOCUMENTATION.md`](../packages/ui/src/lib/workbench/editors/DOCUMENTATION.md)
- [`packages/ui/DOCUMENTATION.md`](../packages/ui/DOCUMENTATION.md)

### 2.2 扩展契约的缺口不在测试数量

`@piarium/extension-contract` 已有 manifest、Workbench、recovery、editor、motion、service routing 和
discovery 测试，Host、Surface、SDK、CLI 与 npm release 也有各自测试。真正缺口是：

- JSON Schema 允许执行型 Surface entrypoint 不声明 `file`，runtime parser 会拒绝；
- `contractVersion` 只要是正整数就会通过，没有统一 compatibility 判断；
- manifest 公开 `when?: string`，但没有运行时消费者，内部 Workbench 使用的是另一套结构化条件；
- Schema/runtime 对照只覆盖少量 Shell seam fixture；
- npm release smoke 只生成默认扩展，没有从发布 tarball 构建真实外部 Shell；
- service binding 的 `single`、`selected`、`all` 没有完整的小型行为矩阵。

## 3. 固定设计决定

### 3.1 Manifest 解析与兼容性分开

必须区分三个阶段：

- **parse**：输入结构、字段和引用是否可读取；
- **compatibility**：当前 Piarium 是否理解该 contribution contract；
- **activation**：只有兼容且依赖满足的 contribution 才允许执行。

未知 `contractVersion` 不归类为普通 malformed，也不得继续执行。公共结果至少表达：

```ts
type PiariumContributionCompatibility =
  | {
      status: 'supported';
      kind: PiariumExtensionContributionKind;
      contractVersion: number;
    }
  | {
      status: 'unsupported-contract-version';
      kind: PiariumExtensionContributionKind;
      contractVersion: number;
      supportedVersions: number[];
    };
```

当前 contribution kind 只支持 v1，但不得在多个消费者中散落 `version === 1` 判断。版本支持表或 helper
由 `@piarium/extension-contract` 单独拥有。

### 3.2 外层 Manifest 保持向前可读

不得给整个 manifest 机械添加 `additionalProperties: false`。

- 顶层 manifest 和普通 metadata 允许未来可选字段；
- 有明确版本与语义的 data contract，例如 `piarium-workbench-shell/v1`，严格检查已知字段；
- Schema 和 runtime 对同一个 versioned payload 采用相同策略；
- 未知字段不能在一侧报错、另一侧静默丢弃而没有测试和文档说明。

### 3.3 未知版本可保留、不可执行

已安装扩展不能因为宿主暂时不支持某个 contribution version 就被删除或重写。

- Catalog 保留 manifest、用户 desired state、Profile 和 replacement reference；
- Surface 不注册、不挂载不兼容 contribution；
- Inspector 显示 contribution ID、kind、声明版本与当前支持版本；
- 失败代码使用 `unsupported-contract-version`，不塌缩成 `internal`、`missing` 或空贡献列表；
- 同一扩展中的其他兼容 contribution 继续工作；
- CLI `check` 面向当前 Piarium 开发目标时明确报告不兼容版本。

### 3.4 `when` 使用结构化表达式

将当前无消费者的 `when?: string` 替换为 v1 结构表达式，不自创字符串语法：

```ts
type PiariumContextValue = string | number | boolean;

type PiariumContextExpressionV1 =
  | { op: 'defined'; key: string }
  | { op: 'equals'; key: string; value: PiariumContextValue }
  | { op: 'not'; expression: PiariumContextExpressionV1 }
  | { op: 'all' | 'any'; expressions: PiariumContextExpressionV1[] };
```

语义：

- `all: []` 为 `true`；
- `any: []` 为 `false`；
- 不增加猜测性的深度、节点数或字符串长度硬限制；
- key 使用公共 identifier 规则；
- Core key 使用 `PIARIUM_WORKBENCH_CONTEXT_KEYS`；
- 扩展写入的自定义 key 必须带自己的 extension ID 前缀；
- 扩展可以读取其他公开 key，以支持组合；
- owner 退出时自动清理它写入的 key。

v1 不允许 `shell` 和 `transition-scene` 使用 `when`。context 变化若直接隐藏当前 Shell 或过渡层，会
绕过 Profile 的 stage-and-commit 与 Recovery 不变量。Shell 切换继续通过 Profile/replacement selection
完成。

### 3.5 新客户端包保持私有

新增私有包：

```text
@piarium/application-client
```

它拥有：

- `RuntimeAPIs` 和各能力 DTO；
- typed failures；
- endpoint identity、runtime key 和 generation；
- framework-neutral URL/auth/fetch transport；
- runtime switch 事件和 blocker；
- Web、VS Code、React UI 共享的客户端行为。

它不得依赖 React、Zustand、UI components、Monaco/CodeMirror、主题系统、Agent/IDE Shell 或 Web
server 实现。

`@piarium/runtime-client` 继续只负责 Piarium WebSocket/worker protocol client。应用 Host HTTP client
不并入该包，`RuntimeAPIs` 也不放进 `@piarium/extension-contract`。

## 4. Phase 1 — Contribution compatibility

### 4.1 写入范围

- `packages/extension-contract/src/types.ts`
- `packages/extension-contract/src/validation.ts`
- 新 compatibility 模块
- `packages/extension-contract/src/index.ts`
- 直接相关测试
- 必要的 Host、Surface、CLI 调用点

### 4.2 实施要求

1. 建立 contribution kind 到支持版本的唯一映射。
2. `parsePiariumExtensionManifest` 继续验证 JSON-safe data、ID、supports、entrypoint、capability 引用及
   `contractVersion` 为正整数。
3. 只有兼容的 v1 contribution 执行 kind-specific data validation，例如 Shell seam、transition scene、
   editor selector。
4. Surface、Host、CLI 使用同一个 compatibility helper。
5. Surface activation 前排除不兼容 contribution，并生成 typed diagnostic。
6. 同一扩展的兼容 contribution 继续激活。
7. Inspector 显示兼容状态。
8. 不因不兼容版本删除 catalog record、candidate、grant 或 Profile reference。

### 4.3 必测行为

- `contractVersion: 1` 正常；
- 更高版本可解析但 compatibility 为 unsupported；
- unsupported contribution 不进入 Surface registry；
- 同一扩展的其他 v1 contribution 仍可用；
- owner 更新为受支持版本后可正常替换；
- unsupported 不被报告为 malformed、missing 或 internal；
- CLI 错误包含 kind、声明版本和支持版本。

## 5. Phase 2 — Schema/runtime 一致性

### 5.1 写入范围

- `packages/extension-contract/schema/piarium.extension.schema.json`
- `packages/extension-contract/test`
- 必要的 parser helper

### 5.2 Entrypoint 规则

- `declarative` 允许无 `file`；
- `managed`、`isolated`、`native` 必须有 `file`；
- Host entrypoint 必须有 `file`。

建立共享 manifest fixture 表，每项明确：

```ts
{
  schemaValid: boolean;
  runtimeValid: boolean;
  compatible: boolean;
}
```

Schema 可以表达的规则必须与 runtime 一致。只能由 runtime 表达的 extension ID 前缀、跨字段引用等
规则，应明确记录为 `schemaValid: true`、`runtimeValid: false`，不能伪称 Schema 完全覆盖。

### 5.3 Fixture 范围

- 合法 declarative、managed、isolated、native 与 brokered Host；
- 各执行型 entrypoint 缺 `file`；
- 非法 SemVer 与 engine range；
- contribution ID 未使用 extension namespace；
- contribution 引用不存在 entrypoint；
- contribution supports 超出 entrypoint supports；
- 未声明 capability；
- Shell 的 web/desktop/mobile/vscode seam；
- versioned data 多余字段；
- 未知 contract version；
- editor/view/shell/transition 代表性 contribution。

AJV 测试不得继续使用恒为 `true` 的假 `semver-range` format。测试端注册基于 `semver.validRange` 的
真实 format，并在 Schema 文档中说明该自定义 format 的运行时权威。

## 6. Phase 3 — Context expression 与 context-key owner

### 6.1 写入范围

- `packages/extension-contract`
- `packages/extension-surface`
- `packages/extension-sdk`
- `packages/extension-loader` isolated bridge
- `packages/ui/src/lib/workbench/editors/context-keys.ts`
- contribution projection、Inspector 与作者文档

### 6.2 Contract

实现并导出：

- `PiariumContextValue`
- `PiariumContextExpressionV1`
- parser
- evaluator
- `collectPiariumContextExpressionKeys`

JSON Schema 的 `when` 只接受该结构。

### 6.3 Surface owner

- Core 使用单独可信 setter 更新公共 key；
- managed extension activation context 得到 owner-scoped context client；
- isolated extension 通过现有消息桥获得同语义 client；
- 扩展只能写入 `${extensionId}.` namespace；
- disable、update、activation failure 自动清理 owner key；
- 旧 generation 的异步 completion 不能写入新 generation；
- key 清理后重新计算受影响 contribution visibility。

### 6.4 Projection

`when` 控制可见投影，不删除注册记录和持久 reference：

- 条件为 false 时，contribution 仍归属于 owner，但不进入可见 candidate；
- replacement selection 保留并临时回落到可用 fallback；
- slot contribution 不渲染；
- Inspector 显示条件、依赖 key 和当前结果；
- context 变化只通知依赖相关 key 的 projection；
- hidden contribution 不触发 `contribution-visible` activation。

### 6.5 必测行为

- `defined`、`equals`、`not`、`all`、`any`；
- 空 `all` 与空 `any`；
- 多 key 订阅与无关 key 零通知；
- owner cleanup 与 stale generation write；
- managed/isolated 一致语义；
- false → true 激活，true → false dispose；
- selected replacement false 时保留 selection 并 fallback；
- Shell/transition 携带 `when` 时明确拒绝。

## 7. Phase 4 — 抽出 `@piarium/application-client`

### 7.1 已交付结构

```text
packages/application-client/
  src/
    api/
    errors/
    transport/
      runtime-auth.ts
      runtime-fetch.ts
      runtime-switch.ts
      runtime-url.ts
      relay-provider.ts
    index.ts
  test/
  package.json
  tsconfig.json
  tsconfig.build.json
```

### 7.2 类型迁移

已从原 `packages/ui/src/lib/api/types.ts` 迁出：

- `RuntimeAPIs`；
- Terminal、Git、Files、Documents、Settings、Permissions、Notifications 等 API；
- Language、Search、Task、Debug、Test 与 Extensions API；
- `Subscription`、request/result DTO 和 failure reason。

当前由 UI 内部文件拥有的 `WorktreeMetadata`、`DraftStarterRef`、`FileEditorSettingsPatch` 等纯 DTO，迁到
正确的 framework-neutral owner。不要迁移对应 React 页面、Store 或业务动作。

同一 Phase 更新全部消费者并删除长期双定义。可用临时 re-export 完成一次迁移，但 Phase 结束前必须删除。

### 7.3 Transport 迁移

移动 runtime URL、auth、fetch、endpoint generation 和 switch primitive。现有 relay 通过显式 adapter
注入，不得让 application-client 反向导入 UI relay：

```ts
interface PiariumApplicationTransportAdapter {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
```

### 7.4 消费者迁移

必须迁移：

- `packages/ui`
- `packages/web/src/api`
- `packages/vscode/webview/api`
- Web/VS Code Vite alias
- 测试 mock
- 根 build/type dependency scripts

完成后，Web、VS Code 的非渲染代码不得导入 `@piarium/ui/lib/api/*`。它们仍可导入 UI 的 render root、
样式和真正 React Surface。

### 7.5 验收

- application-client 不依赖 React、Zustand 或 UI alias；
- endpoint switch 的 stale generation 行为不变；
- auth token 不进入 URL 或日志；
- relay/local/remote transport 行为保留；
- unsupported capability 仍返回明确状态；
- UI、Web、VS Code type-check。

## 8. Phase 5 — UI 内部依赖层

### 8.1 目标方向

```text
apps / workbenches
        ↓
features / React integrations
        ↓
kernel / application-client
        ↓
protocol / extension-contract
```

### 8.2 明确迁移

1. 将 `lib/extensions/builtin-agent-workspace.tsx` 和 `builtin-ide-workbench.tsx` 迁到
   `src/workbenches/agent`、`src/workbenches/ide` 一类的产品组合目录。
2. 将 `lib/settings/builtin-settings-contributions.tsx` 移到 Settings/workbench 组合层，分离纯 metadata
   和 React 页面注册。
3. 将 `components/pi-session/piComposerSubmission.ts` 等纯逻辑移出 `components`，Store 不得导入组件。
4. 将 `contexts/runtimeAPIRegistry.ts` 迁到 application-client integration；它不是 React Context。
5. `RuntimeAPIProvider` 只提供 Context 和绑定 API authority。`AgentEditorCoordinator`、
   `RunDebugCoordinator` 由应用组合根显式挂载。

核对所有生产根：Web/Electron、Mobile、VS Code、Mini Chat 和 Recovery/特殊根。协调器搬迁不能导致某个
根丢失功能，也不能让不需要的根意外启动后台工作。

### 8.3 Kernel import 边界

以下核心模块的非 React 文件禁止导入 `components`、`apps`、`contexts` 和 Zustand Store：

- `lib/documents`
- `lib/workbench/editors`
- framework-neutral `lib/agent-editor`
- context expression evaluator

React hooks 移到明确 adapter 文件或 React integration 目录。Document Registry 的 runtime generation
从 application-client 获取；Agent file hints 通过窄接口或 kernel-owned service 注入；不得为了拆包把
整个 Store 或 UI 对象传入 Kernel。

### 8.4 自动边界

在 ESLint 或独立 architecture test 中加入仅针对已确认问题的路径规则：

- kernel 不得导入 components/apps/stores/contexts；
- stores 不得导入 components/apps；
- application-client 不得导入 ui；
- extension-contract 不得导入 SDK/Surface/Host/UI；
- workbenches 可以向下依赖，底层不得反向依赖 workbenches。

## 9. Phase 6 — 生态 Conformance

### 9.1 Contract 与 Surface

- Contract 包保留纯 parser、Schema、compatibility、evaluator 测试；
- Surface 增加 `single`、`selected`、`all` 的小型 binding 矩阵；
- service ID 相同但 version 不同时不得匹配；
- provider withdrawal 后验证 dependent lifecycle；
- 不复制 Host 进程、artifact 和 storage 测试。

### 9.2 CLI

保留现有模板测试，并覆盖 Shell、editor、view、brokered Host、isolated Surface、compatibility 错误和
生命周期 cleanup。生成项目不得导入 `@piarium/ui`。

### 9.3 npm release smoke

默认模板之外，从打包后的 npm tarball 创建一个真实 Shell：

```text
piarium-extension init ... --template shell
build
check
test
```

确认它能使用 `defineShellMount`、声明 seam、调用 `mountReplacement`/`mountSlot`，且 disposer 被执行。
不做所有 Surface、kind、mode 的笛卡尔积。

## 10. Phase 7 — 文档同步

同批更新：

- `AGENTS.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/composable-workbench-execution-plan.md`
- `docs/piarium-extension-authoring.md`
- `packages/ui/DOCUMENTATION.md`
- application-client 的 README/DOCUMENTATION
- extension-contract compatibility 文档

文档必须明确：

- `packages/ui` 不再拥有 Runtime API 公共契约；
- application-client 是私有应用客户端边界；
- extension-contract 只拥有社区扩展 ABI；
- parse、compatibility、activation 是三个阶段；
- 未知版本可识别但不可执行；
- `when` 的真实结构和生命周期；
- Workbench Kernel 是内部权威，不是社区必须采用的 UI 框架；
- OpenCode cutover 继续成立，不恢复 compatibility facade。

## 11. 明确排除

本任务不做：

- MainLayout 或 MobileApp 全面重写；
- 重画 Agent/IDE UI；
- 替换 Zustand；
- 重做 Pi session store；
- 重写 Monaco/CodeMirror；
- 立即公开发布 Workbench Kernel；
- 把 RuntimeAPIs 放进 extension-contract；
- 迁移 Host/Web server JavaScript 到 TypeScript；
- 批量删除所有含 OpenCode 字样的内容；
- 增加文件数、扩展数、表达式深度或并发数等无依据硬限制；
- 创建 Release、npm tag 或版本号。

## 12. 提交建议

建议四个可审查提交：

1. `fix(contract): make contribution compatibility and context conditions explicit`
2. `refactor(client): extract application client boundary`
3. `refactor(ui): enforce kernel integration and workbench layers`
4. `test(extension): add public conformance and release smoke coverage`

不要把大规模机械移动与契约语义修改混在同一个提交。

## 13. 验证策略

避免每个 Phase 重复跑全仓：

- Phase 1–3：contract test/type-check/lint、Surface/SDK/Host/CLI focused tests；
- Phase 4：application-client checks，UI/Web/VS Code type-check，runtime auth/fetch/switch focused tests；
- Phase 5：UI boundary、Document Registry、Workbench editors、Surface registry focused tests；
- 最终一次：`release:npm:test`、`release:npm:build`、production Web build、dead-code diagnostic、docs
  validation 和 `git diff --check`。

只有 Electron startup/preload 或移动原生边界实际变化时，才运行对应原生 smoke/build。

## 14. 最终验收

- [x] Web/VS Code 非渲染代码不再从 `@piarium/ui` 导入应用客户端契约或 transport 实现。
- [x] application-client 无 React、Store 和 UI 依赖。
- [x] Kernel 无 components/apps/stores/contexts 反向依赖。
- [x] Store 不再导入 Component。
- [x] 官方 Agent/IDE Shell 不位于 extension runtime 核心目录。
- [x] Schema/runtime 可表达规则一致。
- [x] runtime-only 规则有明确 fixture 分类。
- [x] 未知 contribution version 可识别、不可执行且不会删除安装记录。
- [x] `when` 有真实 parser、evaluator、subscription 和 owner cleanup。
- [x] 条件隐藏不删除 replacement selection。
- [x] Shell/transition 不能用 `when` 绕过切换事务。
- [x] service binding 三种模式有行为测试。
- [x] 外部 Shell 能从 npm tarball 创建、构建、检查和测试。
- [x] 公开扩展仍不需要导入 Piarium 私有 React/UI。
- [x] 没有新增 OpenCode compatibility facade。
- [x] 没有无依据的新硬限制。
