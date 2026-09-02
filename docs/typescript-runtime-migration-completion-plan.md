# Piarium TypeScript 特权运行时迁移收尾计划

Status: implemented; retained as the execution and acceptance record

Baseline: `64cbf5b0` (`main`, pushed 2026-09-02)

Acceptance note: Section 2 records the pre-execution failures. Independent review found that the first
implementation's event allowlist dropped existing window/session events, its command catalog contained
an always-empty `Object.keys({})` value and allowed UI callers to override result types, and its
“if-stale” Host build checked only for file existence. Governance replaced those with exhaustive runtime
command/event catalogs, typed main emit and command boundaries, required argument tuples, a focused
`@piarium/application-client/desktop` bundle entry, and a declaration-only Host type build that never
substitutes stale runtime output. Windows x64 packaging and unpacked runtime smoke were then exercised on
the native host. Final governance also added fault-injected Web asset generation commits, removed obsolete
VS Code suppression directives by aligning its Document Authority bridge with generated Host types, and
made XDG path-list smoke fixtures use the platform delimiter. Root type-check/lint, cloud tests, Electron
architecture tests, and documentation validation pass; macOS/Linux package smoke remain owned by their
matching CI runners.

## 1. 结论

Application Host、Web CLI 和 Electron 产品运行时已经完成物理迁移；剩余工作不是继续批量改扩展名，而是把迁移承诺补齐：

1. 让 Electron 的直接测试也通过严格 TypeScript 检查，并修掉当前唯一的测试运行失败；
2. 给 Electron preload、main 和 UI 共同使用的 58 个桌面命令建立单一、框架无关的类型契约；
3. 清理迁移暴露出的真实 lint、死代码和构建接线问题，不用禁用规则掩盖；
4. 用生成物、包内容和当前平台 smoke 证明生产仍执行预编译 JavaScript，而不是只证明源码能编译；
5. 更新已经过时的 Electron、CLI 和工程文档，并把旧迁移计划标记为已交付。

执行代理应按本文完成全部阶段。边界、类型 owner、验证范围和提交切分已经确定，不需要重新询问是否迁移 Electron scripts、是否新增 package、是否一次做完。只有发现需要改变产品行为、持久化 schema、IPC 权限或发布范围时才暂停说明。

## 2. 当前真实基线

### 2.1 已完成且不得回退

- `packages/web/application-host` 的实现和直接测试均为 `.ts`，`allowJs: false`；`packages/web/server` 是未跟踪的生成目录。
- Host 公开声明由 `index.ts` 发射，旧手写 `application-host/index.d.ts` 已删除。
- `packages/web/cli` 是 CLI TypeScript 源码；发布入口仍为生成的 `packages/web/bin/cli.js`，`bin/` 不再被 Git 跟踪。
- `packages/electron` 根目录的 main、preload、SSH、tray、notification、updater、startup 和平台运行时均为 `.ts`；根目录没有 `.js/.mjs/.cjs` 产品源码。
- `packages/electron/scripts/*.{mjs,cjs}` 是构建、签名、fixture 和 smoke 工具，继续保留，不纳入产品运行时迁移。
- Electron 生产源码执行 `tsc --noEmit -p packages/electron/tsconfig.json` 已通过；禁止重新加入 `allowJs`、`@ts-nocheck`、`@ts-ignore` 或运行时 TS loader。
- Electron 构建入口已是 `main.ts`、`preload.ts`，输出仍是 `dist-bundle/main.mjs`、`dist-bundle/preload.mjs`；开发启动器执行生成的 `dist-bundle/main.mjs`。
- CLI 已通过源码/测试类型检查、100 个测试（另 1 个跳过）、构建、`--help` 与 `--version --json` smoke；Application Host 迁移阶段的源码/测试类型检查和 raw build 已通过。最终仍需在所有收尾修改后各跑一轮，而不是把旧结果当最终结果。

### 2.2 当前明确失败

`packages/electron` 当前状态：

- 生产源码 type-check：通过；
- 测试 type-check：失败，集中在 6 个文件；
- Vitest：12 个文件中 11 个通过，47 个测试中 46 个通过；
- 唯一运行失败：`ssh-manager.test.ts` 使用了 Vitest/Chai 不存在的 `toStartWith`；
- ESLint：45 个错误，主要是有意的空 `catch` 没有说明、迁移后死代码、测试夹具未类型化和少量无用 import/变量。

测试 type-check 的六个文件及根因：

| 文件 | 根因 |
| --- | --- |
| `notification-listener.test.ts` | `http.Server`/listener/header 夹具没有类型，`Promise<void>` 缺失，断言没有收窄 nullable headers |
| `pi-runtime.test.ts` | path 参数、broker event、typed failure 的 `code/candidates` 没有建模 |
| `renderer-security-policy.test.ts` | `createPreloadBootstrapPayload` 的 `localPage` 被推断为普通 boolean，未形成真假分支的可辨识联合 |
| `ssh-manager.test.ts` | EventEmitter 伪子进程没有实现 `SshChildProcess`，calls/session/forward fixture 漂移，catch 为 unknown，matcher 写错 |
| `updater-capability.test.ts` | 生产注入类型要求完整 `fs.Stats`，但实现只使用 `isFile()`，测试因此被迫伪造过宽对象 |
| `updater-check.test.ts` | 比较函数参数未类型化，existing update fixture 不符合真实 `DesktopUpdateResult` |

### 2.3 仍然不诚实的契约和接线

- `preload.ts` 暴露 `invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>`；UI 在 `packages/ui/src/lib/desktop.ts` 又手写了一份同样宽泛的 `DesktopBridgeGlobal`。
- `main.ts` 有 58 个 `desktop_*` case，但 command/args/result 没有一个共享 owner；编译器无法证明 preload、main 和 UI 对同一命令的理解一致。
- `packages/web` 的 `lint` 覆盖 browser source 和 Application Host，但漏掉新 `packages/web/cli/**/*.ts`。
- `packages/electron` 的 `build` 仍是 no-op，根命令 `bun run build:electron` 因而不会生成 `dist-bundle`。
- Electron 直接 `type-check` 依赖已存在的 workspace `dist` 和 `packages/web/server/index.d.ts`；需要证明 clean output 下能自行准备依赖，而不是碰巧吃到上次构建产物。
- Web `clean` 只清 Application Host，没有清生成 CLI `bin` 和 CLI staging/backup。
- `docs/development.md`、`packages/electron/README.md`、`packages/web/cli/lib/DOCUMENTATION.md` 和旧迁移计划仍引用源码 `.mjs`、`packages/web/bin/lib` 或“Electron 类型检查刻意很浅”等旧现实。

## 3. 固定边界与禁止项

### 3.1 类型和实现边界

- 继承现有严格配置：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`isolatedModules` 等不得降低。
- 不使用 `@ts-nocheck`、`@ts-ignore`、`as any`、显式 `any`、通配 ambient module、扩大 `exclude`、关闭 ESLint 规则或把测试移出 type-check。
- 可以使用从 `unknown` 到领域类型的解析函数、具体接口、可辨识联合和窄的测试替身；不得用双重断言伪造正确性。
- 不为了让测试通过而放宽生产接口。若测试只需要依赖的一小部分，优先把注入接口收窄到实现真实使用的能力。
- 保留相对 import 的 `.js` 后缀；TypeScript source 不在生产中直接执行。

### 3.2 产品与安全边界

- 不改变 Electron 的命令权限划分、`REMOTE_SAFE_DESKTOP_COMMANDS`、renderer origin gate、context isolation、preload 能力范围、外部 URL/路径校验或 updater 签名策略。
- 不把 Application Host 逻辑复制到 Electron，也不把 Electron native 能力放进 renderer。
- 不改变 Recovery、Documents、Pi protocol、设置文件或 SSH 配置 schema。
- 不借 lint 清理新增 timeout、文件大小、命令 allowlist、平台禁用或其他没有真实失败依据的限制。
- 现有 50 MB 本地读取上限和现有凭据路径防护不是本任务设计内容；既不扩大也不顺手重写。

### 3.3 仓库与发布边界

- 不新建 `@piarium/application-host` 或空的 execution-kernel package。
- Electron `scripts/*.mjs/.cjs` 继续作为工具链边界；不要为了“零 JS”把它们机械改成 TS 或加 wrapper。
- 不改版本号、不建 tag/Release、不发布 npm 或安装包。
- 每个阶段形成可审查 commit；未经用户单独要求不 push，不重写已经推送的 `64cbf5b0` 之前历史。

## 4. Phase 1 — Electron 测试与窄生产契约收口

### 4.1 `notification-listener.test.ts`

1. `servers` 使用 `http.Server[]`，`listeners` 使用 `NotificationListener[]`。
2. `listen(server)` 明确参数和 `Promise<string>`；close/listen promise 使用 `Promise<void>`。
3. observed headers 使用 Node 的 `IncomingHttpHeaders | null`。
4. 不用非空断言硬压；增加一个小的 `requireHeaders` 测试 helper，null 时抛出明确测试错误，再对返回值断言。
5. 空 cleanup catch 保留 best-effort 语义，但写明注释，满足 lint。

### 4.2 `pi-runtime.test.ts`

1. `source(relativePath: string): Promise<string>`。
2. 用 `unknown` 接住异常，并以本模块可复用的小 type guard 验证 `{code:string,candidates?:string[]}`；断言前必须证明形状。
3. `events` 使用 `PiRuntimeBrokerEvent[]`，从 `@piarium/runtime-broker` 导入 type。
4. 不把生产错误改成宽泛 Error 子类来迁就测试。

### 4.3 renderer bootstrap 可辨识联合

在 `renderer-security-policy.ts` 定义明确返回类型：

- remote 分支：`{localPage:false, ...shared}`，不得包含 token、headers、homeDirectory、relayHostId；
- local 分支：`{localPage:true, ...shared, clientToken, requestHeaders, homeDirectory, relayHostId}`。

实现必须返回字面量 `true/false`，让测试通过 `if (!local.localPage) throw ...` 后自然收窄。不要在测试中用断言强转。该类型后续由 Phase 2 的共享 desktop contract 接管或 re-export，不能最终留下第二份。

### 4.4 SSH 测试替身

1. 在测试中建立 `TestSshChildProcess extends EventEmitter implements SshChildProcess`，真实提供 `stdin/stdout/stderr`、`exitCode`、`kill()`；不要把普通 EventEmitter 强转成 child process。
2. calls 数组明确为 `{command:string,args:string[],options:SpawnOptions}[]`。
3. servers、tempDirs、spawnedChildren、killedChildren 全部使用具体类型。
4. forward fixture 补上真实必填 `enabled`；session/instance fixture 补齐 `SshInstance` 的 `installMethod`、`uploadBundleOverSsh` 及 session 必填状态，不要放宽生产类型。
5. catch 保持 `unknown`，用 `instanceof Error` 收窄。
6. 把不存在的 `toStartWith` 改为 `toMatch(/^.../)` 或标准字符串断言；保留 redaction、控制字符剔除和 2000 字符边界验证。

### 4.5 updater 测试性边界

1. `assertUpdaterCapability` 的 `stat` 注入类型收窄为实际所需的 `(path) => Pick<fs.Stats, 'isFile'>`；默认实现仍可传 `fs.statSync`。
2. updater-check 的比较函数明确接收两个 string。
3. existing update fixture 使用真实含 `updateInfo.version` 的结果，或为测试声明满足泛型约束的具体 result type；不得删除 pending-update 行为断言。

### 4.6 Phase 1 验收

在 `packages/electron`：

```sh
bun x tsc --noEmit -p tsconfig.tests.json --pretty false
bun x vitest run --config vitest.config.ts
```

完成条件：测试 type-check 零错误；12 个文件、47 个测试全部通过；没有新增 suppression 或显式 any。

建议提交：

```text
test(electron): type desktop runtime fixtures
```

## 5. Phase 2 — 单一桌面 IPC 契约

### 5.1 类型 owner

在 `@piarium/application-client` 建立 framework-neutral desktop contract，例如：

```text
packages/application-client/src/desktop.ts
```

选择这里而不是 `@piarium/protocol`，因为它是本机 preload client contract，不是 Pi worker/network wire protocol；选择这里而不是 UI/Electron，是为了让两端依赖纯 DTO，而不形成 renderer 或 Electron 实现依赖。

该模块至少拥有：

- `PiariumDesktopCommandMap`：58 个 `desktop_*` command 的 args/result；
- `PiariumDesktopCommand`、`PiariumDesktopCommandArgs<K>`、`PiariumDesktopCommandResult<K>`；
- `PiariumDesktopBridge`：typed `invoke`、`openDialog`、`grantFileAccess`、`openExternal`、`listen`；
- typed dialog options/result；
- `PiariumDesktopEventMap` 中当前正式消费的 menu、tray、update、session/window 事件；
- Phase 1 的 preload bootstrap local/remote union；
- 已经散落在 UI 的 host、SSH、window state、installed-app、update 等纯 DTO，优先迁移/re-export，不复制第三份。

类型文件不得导入 React、Zustand、Electron、Node fs/process 或 Host 私有实现。

### 5.2 命令覆盖

必须覆盖 `main.ts` 当前全部 58 个 case。按能力分组建模，避免一个不可读的万能对象：

1. window/chrome：title、theme、fullscreen、minimize/maximize/close、pin、menu、new window/mini chat；
2. system：launch-at-login、minimize-to-tray、keep-awake、version、LAN address；
3. capture/file/shell：capture、save/read、open/reveal/open-in-app、installed apps；
4. host/auth：hosts get/set、probe、password login、install id/local token；
5. update：check、download、restart；
6. tray/notification；
7. SSH instances/connect/status/logs。

`void` 命令用 `undefined` 或 `null` 只能选择一个与当前真实返回一致的类型，不能随意混用。可选字段应按实际返回建模；不要为了省事把 result 留成 `unknown`。外部 HTTP/IPC 输入仍从 unknown 进入 main，并在进入命令 handler 前或各 case 内解析。

### 5.3 main/preload/UI 接线

1. `preload.ts` 的 `invoke` 变成 `K extends PiariumDesktopCommand` 的泛型调用。
2. `main.ts` 的 raw IPC handler 先验证 command 是已知命令，再把 args 交给对应解析/handler；未知命令仍明确失败。
3. 不要求把 5600 行 main 重写成 service locator。可以保留 switch，但请求应是可辨识 command request，或由逐命令 handler table 保证 command/args/result 相关性。
4. `REMOTE_SAFE_DESKTOP_COMMANDS` 使用 `satisfies ReadonlySet<PiariumDesktopCommand>` 或等价约束，权限集合不得因类型迁移改变。
5. `packages/ui/src/lib/desktop.ts` 删除本地 `DesktopBridgeGlobal` 双写，改用 shared type。
6. `desktopNative.ts`、`desktopSsh.ts`、hosts/tray/update consumers 逐步采用 typed invoke；调用方不能再随意写不存在的 command 或错误 args。
7. `packages/electron` 声明对 `@piarium/application-client` 的 workspace 依赖，并更新 build 顺序与 lockfile；因为运行时仅 type import，不得把 application-client bundle 进 preload/main。

### 5.4 契约测试

增加测试证明：

- 每个 main command 都在 shared command map/catalog 中；
- remote-safe set 是 command catalog 的子集；
- 未知 command 被拒绝；
- 至少覆盖一个无参数、一个带 union 参数、一个敏感命令和一个带结构化结果的 compile/runtime fixture；
- local bootstrap 能带凭据，remote bootstrap 的对象结构中完全没有凭据字段。

不要只用正则扫描源码宣称 58 个 case 一致；若保留 switch，可由导出的 command catalog 与 handler registration 在测试中比较。

### 5.5 Phase 2 验收

```sh
bun run --cwd packages/application-client build
bun run --cwd packages/application-client type-check
bun run --cwd packages/application-client lint
bun run --cwd packages/application-client test
bun run --cwd packages/ui type-check
bun run --cwd packages/electron type-check
bun x vitest run --config packages/electron/vitest.config.ts
```

建议提交：

```text
refactor(electron): unify desktop bridge contracts
```

## 6. Phase 3 — Electron lint、死代码与运行时边界治理

### 6.1 处理当前 45 个 lint 错误

逐类处理，不加文件级 rule disable：

- 有意忽略的 cleanup/probe catch：在 block 内加入具体注释，例如“best-effort cleanup；主操作结果已确定”；
- 应该可观察的失败：记录不含敏感数据的诊断或继续抛出，不能一律改成注释；
- `parseSshConfigImports`、`readDesktopSshInstances`、`writeDesktopSshInstances`、`updateHostUrlForSshInstance` 当前只有定义无调用，确认由 `ElectronSshManager` 接管后删除，不用改名或 `void` 假装使用；
- `notification-listener.ts` 未使用的 `data`、`updater-feed.ts` 未使用的 `fs`、`updater-check.ts` 未使用入参、`main.ts` 未使用的 `updateResult` 按真实语义删除；
- `ssh-manager.ts` 未使用的 `defaultTrue` 删除；
- SSH 控制字符清洗改成等价、可读且 lint 可接受的实现，保留原有 redaction/截断行为，不用禁用 `no-control-regex`；
- `linux-app-discovery.ts` 的无用 escape 修正，但不得改变 desktop entry `%` field-code 语义。

### 6.2 架构护栏

增加或扩展 architecture tests：

- Electron package 根目录不允许新增 `.js/.mjs/.cjs` 产品源码；`scripts/`、生成的 `dist-bundle/` 和 `resources/web-dist/` 明确排除；
- Electron TS source 不含 `@ts-nocheck/@ts-ignore`；
- Application Host 现有边界继续通过；
- 为 `packages/web/cli` 增加同类 source-boundary 测试：没有 production/test JS、没有 renderer/Electron implementation import、没有 TS check suppression；
- architecture test 不把注释中的英文单词 `any` 当违规，显式 any 交给 TypeScript ESLint 规则。

### 6.3 Web lint 覆盖 CLI

把 `packages/web/package.json#lint` 加入 `./cli/**/*.ts`。修复真实 CLI lint 错误；不把 CLI 单独设成宽松 override。

### 6.4 Phase 3 验收

```sh
bun run --cwd packages/electron lint
bun run --cwd packages/electron type-check
bun run --cwd packages/web lint
bun x vitest run packages/web/application-host/architecture.test.ts packages/web/cli/architecture.test.ts
```

建议提交：

```text
refactor(runtime): enforce typed source boundaries
```

## 7. Phase 4 — 构建、clean checkout 与发布物接线

### 7.1 Electron build 不能继续 no-op

1. `packages/electron package.json#build` 至少生成 `dist-bundle/main.mjs` 和 `preload.mjs`；根 `bun run build:electron` 必须产生真实结果。
2. `bundle-main.mjs` 在 exact `packages/electron/dist-bundle` 内清理旧生成物后再 build，避免删除了 entry 的 stale bundle 被继续打包。
3. 保持 external：`electron`、`@piarium/web`、Pi host/broker、`bun-pty`、`node-pty`、`better-sqlite3`；不得因类型 import 改为内联。
4. bundle 后验证两个 entry 均存在并能通过 `node --check`；失败时返回非零，不能打印成功。

### 7.2 直接 type-check 的依赖准备

建立一个明确的 Electron type/build dependency script，使 fresh checkout 上的：

```sh
bun run type-check:electron
```

能够自行准备它读取的 `protocol/dist`、`application-client/dist`、`runtime-broker/dist`、`settings-store/dist`、`extension-host/dist` 和 `web/server/index.d.ts`。可以复用 `packages/web#prepare:application-host` 与现有 package build，不复制 build graph，也不要依赖根全量 build 恰好先跑。

增加一个 targeted clean-output test：通过各 owner 的 `clean` script 删除生成目录后，重新执行 Electron type-check + bundle。不要用 `git clean` 或删除源码。

### 7.3 Web Host/CLI clean 与 package 内容

1. 给 CLI build helper 增加 `--clean`，只删除 `packages/web/bin`、`.cli-build`、`.cli-staging-*`、`.cli-backup-*`，保持现有 exact parent safety check。
2. `packages/web#clean` 同时调用 Host clean 与 CLI clean。
3. clean 后依次 build Host、CLI，验证：
   - `server/index.js`、`server/index.d.ts`、`bin/cli.js` 存在；
   - `bin/cli.js` 保留 shebang；
   - `server`/`bin` 无 `.test.*`、Markdown 和源 `.ts`；
   - Git 不跟踪 `server`、`bin`、`dist-bundle`。
4. pack inspection 必须确认 `@piarium/web` tarball 包含 `server`、`bin`、Web `dist`，不包含 `application-host`、`cli` 源码或测试。

### 7.4 Electron package 内容

验证 electron-builder 的 `files` 只取 `dist-bundle/main.mjs` 和 `preload.mjs`，两个 bundle 中没有：

- 运行时 `.ts` import；
- `tsx`、`ts-node` 或 loader hook；
- 被错误内联的 Web Host/native module；
- 同时携带的一份 Electron TS source tree。

Windows 当前平台应运行 unpacked package smoke。macOS/Linux package smoke 不在 Windows 伪造，最终报告明确留给对应 runner。

### 7.5 Phase 4 验收

```sh
bun run --cwd packages/web clean
bun run --cwd packages/web build:application-host
bun run --cwd packages/web build:cli:raw
node packages/web/bin/cli.js --version --json
node packages/web/bin/cli.js --help

bun run build:electron
node --check packages/electron/dist-bundle/main.mjs
node --check packages/electron/dist-bundle/preload.mjs

bun run --cwd packages/electron package:win:x64
bun run --cwd packages/electron smoke:win:unpacked
```

若 Windows package 因本机缺少明确的外部打包前提失败，报告缺失前提和已经完成的 bundle 证据；不得把未运行写成通过。

建议提交：

```text
build(runtime): verify generated host and desktop artifacts
```

## 8. Phase 5 — 文档同步

### 8.1 必改文档

- `packages/electron/README.md`
  - source 改为 `main.ts`、`preload.ts`、`ssh-manager.ts` 等；
  - 明确 dev/bundled/package 执行的是 `dist-bundle/*.mjs`；
  - IPC 扩展顺序引用 shared desktop contract；
  - quick checks 与当前 package scripts 一致。
- `packages/web/cli/lib/DOCUMENTATION.md`
  - 发布入口仍写 `bin/cli.js`；
  - source module 名改为 `.ts`；
  - 测试命令改到 `packages/web/cli` 的 Vitest 路径。
- `docs/development.md`
  - knowledge map 从 `packages/web/bin/lib` 改到 `packages/web/cli/lib`；
  - 删除“Electron type-check/lint intentionally shallow”的旧说明，改写为“静态检查不能替代原生 package smoke”。
- `docs/application-host-typescript-migration-plan.md`
  - Status 改为 delivered；
  - 增加实际交付摘要与 commit range；
  - 纠正实际目录 `packages/web/cli`（不是 `cli-src`）和 Electron 根级 TS source + generated `dist-bundle`；
  - 勾选真实完成项，未在当前平台验证的跨平台 smoke 保持未勾选并说明 owner。
- `docs/architecture.md`
  - 记录 Application Host/CLI/Electron 的 source/generated artifact 边界；
  - 记录 desktop bridge contract 的 owner；
  - 不把迁移计划写成新的产品架构。

### 8.2 文档验收

```sh
bun run docs:validate
bun run test:docs
```

建议提交：

```text
docs(architecture): record typed privileged runtimes
```

## 9. Phase 6 — 最终验证，只跑一轮有区分度的检查

不要在每个小改动后重复全仓。Phase 1–5 的 focused checks 通过后，再运行以下最终矩阵。

### 9.1 Application Host 与 CLI

```sh
bun run --cwd packages/web type-check:application-host:raw
bun run --cwd packages/web type-check:cli:raw
bun run --cwd packages/web lint
bun x vitest run packages/web/application-host packages/web/cli --config packages/web/vitest.config.ts
bun run --cwd packages/web build:application-host:raw
bun run --cwd packages/web build:cli:raw
```

报告 Application Host 和 CLI 的实际 test file/test/skip 数，不只写“通过”。

### 9.2 Electron

```sh
bun run --cwd packages/electron type-check
bun run --cwd packages/electron lint
bun run --cwd packages/electron test:architecture
bun run --cwd packages/electron test:updater
bun run --cwd packages/electron test:linux-desktop
bun run --cwd packages/electron bundle:main
```

`test:architecture` 已包含 runtime Vitest，不需要在它之后再重复一次同样的 `test:runtime`。updater/linux scripts 覆盖不同的工具链和平台策略，保留。

### 9.3 跨包和生成布局

```sh
bun run type-check
bun run lint
bun run test:cloud
bun run docs:validate
bun run test:docs
bun run dead-code
git diff --check
```

`dead-code` 是诊断：只治理本次迁移新引入或暴露且已确认不可达的项，不把全仓历史发现扩进本任务。

### 9.4 最终结构断言

- Electron 根级产品 runtime：0 个 `.js/.mjs/.cjs` source；
- Electron scripts 的 JS/MJS/CJS 逐项仍属于 build/package/smoke tooling；
- Application Host 与 CLI：0 个未解释 JS source/test；
- `server`、`bin`、`dist-bundle`：均为未跟踪生成物；
- 手写 Host `index.d.ts`：不存在；
- 生产启动路径：`server/index.js`、`bin/cli.js`、`dist-bundle/main.mjs`；
- 生产 artifact 中没有 TS loader 或重复 source tree；
- 不存在 TS check suppression 或显式 any workaround；
- 当前 Windows unpacked smoke 通过，macOS/Linux 原生 smoke 清楚标为 CI/native-runner 责任。

## 10. 交付和验收报告格式

执行代理最终必须报告：

1. 每个 Phase 的 commit hash、目标和修改范围；
2. Electron 测试 type-check 原有六类错误如何收口；
3. 58 个 desktop command 的单一 contract owner 与 consumer 接线；
4. 删除的死代码及为何确认不可达；
5. Host/CLI/Electron 的 source 数量、保留 JS/MJS/CJS 数量和例外理由；
6. clean output 后实际生成的 `server/bin/dist-bundle` 入口；
7. 实际执行的 type/lint/test/build/pack/smoke 命令及数量结果；
8. 当前 Windows 已验证内容，以及未在本机运行的 macOS/Linux 边界；
9. 任何新增依赖或 shared DTO 的依据；
10. 仍未解决的风险。不得用“全部完成/全部通过”代替证据边界。

## 11. 完成定义

- [x] Electron source 和直接 tests 均严格 type-check。
- [x] Electron Vitest 47/47（最终为 61/61）通过。
- [x] Electron/Web CLI ESLint 零错误，无规则禁用绕过。
- [x] preload、main、UI 对 58 个 desktop command 使用同一个 framework-neutral contract。
- [x] remote-safe command 集合被类型约束且行为未变化。
- [x] renderer bootstrap 是 local/remote 可辨识联合，remote 结构无凭据字段。
- [x] `bun run build:electron` 真实生成两个 MJS bundle。
- [x] direct Electron type-check 在 clean generated output 后能自行准备声明依赖。
- [x] Web clean 同时治理 Host 与 CLI 生成物；pack 内容与源码/产物边界一致。
- [x] Electron root 无 JS runtime；scripts JS 例外都有明确工具链理由。
- [x] Electron README、CLI 文档、development、architecture 和旧迁移计划与代码一致。
- [x] Host/CLI/Electron focused checks、根 type/lint、cloud/docs 通过。
- [x] 当前平台的 Windows package/unpacked smoke 通过，其他平台没有伪造验证。
- [x] 没有版本、Release、发布、schema 或无依据产品限制变更。
