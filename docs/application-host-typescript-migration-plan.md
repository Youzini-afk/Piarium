# Piarium Application Host TypeScript 迁移执行计划

Status: delivered; retained as the decision and migration record

Last updated: 2026-09-02

Delivery note: the migration landed through `64cbf5b0`, with final Electron contract/build governance in
the commits that follow it. Application Host source now lives in `packages/web/application-host`, CLI
source in `packages/web/cli`, and Electron product runtime source at `packages/electron/*.ts`.
`packages/web/server`, `packages/web/bin`, `packages/web/.application-host-types`, and
`packages/electron/dist-bundle` are generated outputs. Sections describing the former JS counts and
shallow checks are the pre-migration baseline, not current repository state. The detailed final execution
and acceptance record is [typescript-runtime-migration-completion-plan.md](typescript-runtime-migration-completion-plan.md).

## 1. 结论与目标

本计划治理 Piarium 受信任 Node/Electron 运行时的 JavaScript/TypeScript 分裂。目标不是把扩展名批量改成
`.ts`，也不是为了“全仓纯 TypeScript”重写成熟逻辑，而是让 Application Host、Web CLI、共享持久化原语和
Electron 运行时代码由真实的严格类型约束覆盖，同时保持发布物继续运行预编译 JavaScript。

完成后必须满足：

1. `packages/web` 的 Application Host 源码是 TypeScript；`packages/web/server` 只保存构建产物。
2. `packages/web` 的 CLI 源码是 TypeScript；发布入口仍是 `packages/web/bin/cli.js`。
3. `@piarium/settings-store` 不再由 `index.js + index.d.ts` 双写契约，而从 TypeScript 生成实现和声明。
4. Electron 的主进程、preload 和主进程运行时模块由 TypeScript 源码构建；打包产物仍为 `.mjs`。
5. Application Host 的公开启动参数和返回控制器由实现生成声明，删除手写 `server/index.d.ts`。
6. Web、CLI、Electron、云运行时、Docker、SSH 部署和桌面打包继续执行预编译 JS；生产环境不引入
   `tsx`、`ts-node` 或 Node 的运行时 TypeScript stripping。
7. 路由、服务 ID、持久化 schema、错误码、默认值、端口、CLI 输出、包名和运行进程边界保持不变。
8. 迁移后的错误处理不再因为 `catch` 变量、SQLite 行、HTTP body 或 IPC payload 缺少类型而被迫使用
   无差别 `any`，但迁移本身也不擅自改变原有产品语义。

## 2. 当前基线与决定性证据

### 2.1 Application Host 没有进入 Web 的 TypeScript 检查

当前 `packages/web/server` 下共有 358 个 `.js` 文件，其中 125 个以 `.test.js` 结尾，另有 233 个
非 `.test.js` 文件（包含生产实现和少量可执行 fixture）。该目录没有 TypeScript 实现，只有一个 43 行的手写
`server/index.d.ts`。

`packages/web/tsconfig.json` 只包含：

```text
packages/web/src
packages/ui/src
```

`packages/web` 的 `type-check` 因而不会读取 Application Host。`lint` 也只检查 `src/**/*.{ts,tsx}`。
Web 的 1031 个测试（当前基线为 1030 通过、1 跳过）能验证大量运行行为，但不能代替模块之间的静态契约。

### 2.2 手写公开声明已经与真实实现漂移

`server/index.d.ts` 声明的 `StartWebUiServerOptions` 只有少量字段。实际 Electron 调用还会传入：

- `hostEntry`
- `apiOnly`
- `requirePiRuntime`
- `createPiRuntimeBroker`
- `pickPiPackageRoot`
- `openFilesystemPath`
- `onDesktopNotification`
- `getIsWindowFocused`
- `getDesktopRuntimeConfig`

这些字段由 `server/index.js` 真实读取，却没有出现在公开声明里。这不是理论风险，而是已经存在的声明漂移。

### 2.3 运行路径是发布兼容边界

以下消费者直接依赖构建后的物理路径：

- `@piarium/web` 的 `main`：`./server/index.js`
- Web CLI：动态导入或启动 `server/index.js`
- Electron：动态导入 `@piarium/web/server/index.js`
- Electron 还深度导入四个 `@piarium/web/server/lib/*` 工具
- 云运行时构建复制 `packages/web/server`
- Docker/SSH 部署和回滚 smoke 检查 `packages/web/server/index.js`
- 进程识别逻辑匹配 `/packages/web/server/index.js`

因此本迁移不得先改运行路径再到处修消费者。源码和运行产物必须分离，而运行产物继续落在 `server/`。

### 2.4 Electron 也只有语法检查

Electron 当前有 17 个非测试根级 `.mjs` 运行时文件。`main.mjs` 约 5373 行，另有 `ssh-manager.mjs`、
`preload.mjs`、更新、通知、托盘和平台模块。Electron 的 `type-check` 实际只对三个文件执行 `node --check`，
`lint` 是空操作。

Electron 打包已经通过 Bun 预构建 `dist-bundle/main.mjs`，因此它适合使用 TypeScript 源码；开发模式需要同步改为
先构建产物，而不能继续直接执行源码。

### 2.5 `@piarium/settings-store` 是同类的关键小边界

`packages/settings-store` 目前也是 `src/index.js + src/index.d.ts`，其 `build`、`type-check` 和 `lint` 都只是
`node --check`。它却是 Web、Electron、VS Code、Runtime Broker 以及 Recovery 租约的跨进程原子设置权威。
该包规模小、测试明确，应作为迁移试点，而不是让 Application Host 的 TypeScript 继续依赖手写声明。

## 3. 固定设计决定

### 3.1 不新增 `@piarium/application-host` 运行时包

Application Host 继续由 `@piarium/web` 拥有。新增独立 workspace/npm 包会带来：

- 云运行时 package closure 和生产 lock 变化；
- `@piarium/web` 全局安装的额外发布依赖；
- Electron external 配置和深度导入迁移；
- Docker、SSH 部署和回滚 artifact 变化；
- 但运行时仍与 Web/Electron 同进程，没有得到新的隔离收益。

只有将来出现第二个真正独立的 Host 组合消费者时，才单独讨论物理拆包。本计划只建立清晰源码边界：

```text
packages/web/
  application-host/       # Application Host 源码，迁移过程中允许剩余 legacy JS
  server/                 # 生成的 Node ESM 运行产物，不提交 Git
  cli/                # CLI 源码（CLI Phase 建立）
  bin/                    # 生成的 CLI ESM 运行产物，不提交 Git
  src/                    # 浏览器/Web Surface，保持现状
  dist/                   # Vite 浏览器产物
```

“不新增包”不等于只靠文件夹自觉。必须增加 architecture test，保证 `application-host`：

- 不导入 `packages/web/src`、`@piarium/ui`、`packages/electron` 或 renderer 代码；
- 只通过注入接收静态资源目录、Electron native callbacks 和外部 runtime factory；
- 不让 Web route/composition 类型倒灌到 Documents、Recovery、LSP/DAP 等 authority core；
- 对跨包消费者只暴露一个 typed Host 入口，不允许继续增加 `server/lib/*` 深度导入。

这样将来若出现真正需要脱离 `@piarium/web` 部署、独立版本或被第二个产品组合复用的 Host，只需移动这个受控
源码树并调整 manifest/build，不需要重新切断 UI、Electron 和 Web 内部依赖。

实际物理拆包的触发条件至少满足一项：

1. 出现不依赖 `@piarium/web` 资产/CLI 的第二个独立 Host 消费者；
2. Host 需要独立发布、版本或进程生命周期；
3. 当前 Web 发布单元已经造成可测量的部署或依赖闭包问题。

“名字对称”或“以后可能复用”本身不足以增加运行时包。

### 3.2 为 Piarium 自有执行能力预留独立内核，而不是膨胀 Host

如果 Piarium 开始拥有自己的工具调用、上下文规划、执行环境、模型调用或 turn orchestration，这会形成一个真实的
独立领域和生命周期。届时应新增类似：

```text
@piarium/execution-kernel
```

它与 Application Host 的职责不同：

| 边界 | 所有内容 |
| --- | --- |
| Application Host | HTTP/SSE/WebSocket、认证、持久化装配、进程启动、Extension Host、服务路由、桌面注入 |
| Execution Kernel | turn 状态机、tool registry/execution、context planner、environment lease、model/backend adapter、取消与事件 |
| Agent backend adapter | Pi、Codex、Claude Code、Devin 或其他后端的原生会话/能力映射 |

新增 execution-kernel 的触发条件是第一条真实的 Piarium-owned 执行路径，而不是先创建空 package。首个功能应与包、
实现和测试同批落地。该包必须：

- 不依赖 Express、Electron、React、Zustand 或 Web route；
- 通过接口获取 workspace/document/process/credential capability，不自行越过 Host authority；
- 用稳定前缀与易变尾部区分 context，保留 provider prompt-cache 优化空间；
- tool 调用声明 schema、权限、cwd/environment、mutation intent、取消和结果事件；
- 不把 Pi/Codex/Claude Code 等后端压成丢失能力的最低公分母；公共 backend contract 表达 capability，后端保留扩展数据；
- 允许同一个内核被 Application Host、headless/CLI runner 和测试 harness 组合。

本次 TypeScript 迁移不创建空 execution-kernel，也不实现新的 agent 行为；但必须保证迁移后的
`application-host` 没有把上述职责写进 route、Electron callback 或平台 composition。若执行期间发现现有代码已经
包含可独立的 execution primitive，应先记录和类型化边界，不在本任务中改变执行语义。

### 3.3 运行时始终执行预编译 ESM

Application Host 使用 `tsc` 的 `NodeNext`/ES2023 输出。Electron 使用现有 Bun bundler输出 `.mjs`。源码中的相对导入
继续写 `.js` 后缀，让 NodeNext 将它解析到 `.ts` 源码并生成 Node 可直接加载的 ESM。

禁止：

- 生产命令使用 `tsx`、`ts-node` 或 loader hook；
- Electron 打包后加载 `.ts`；
- 为迁移加入 Babel 二次转换；
- 同时保留一份手写 JS 实现和一份 TS 实现。

### 3.4 源码与产物路径分离，运行路径保持稳定

第一阶段将现有 `packages/web/server` 通过 `git mv` 移到 `packages/web/application-host`。构建会先清理并重新生成
`packages/web/server`。该输出目录加入 `.gitignore`，不得提交生成文件。

这使以下路径完全不变：

- `@piarium/web/server/index.js`
- `@piarium/web/server/lib/*`
- 云运行时中的 `packages/web/server/index.js`
- 进程识别和回滚 smoke 使用的路径

GitHub 源码链接、模块文档和测试命令则改为 `packages/web/application-host/...`。

### 3.5 渐进迁移期间只检查新 TS，不伪称旧 JS 已类型化

过渡期的 Application Host build config 可以使用：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": false,
    "rootDir": "application-host",
    "outDir": ".application-host-build",
    "types": ["node"],
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "noEmit": false
  }
}
```

实际 build helper 可以为并发构建传入唯一 staging `--outDir`；示例目录同样必须忽略且不得作为运行入口。

含义必须诚实：legacy JS 只是被复制/发射到运行目录，只有已迁移 `.ts` 文件接受严格检查。为 legacy JS 生成的
内部声明只是过渡期消费辅助，不代表它已严格类型化；公开入口继续由单独的真实 contract 覆盖。最终 Phase 必须将
`allowJs` 改为 `false`，删除 legacy 清单和手写声明。

### 3.6 每个 slice 同时迁实现、测试和直接契约

一个模块不能只把实现改成 `.ts`，却留下无类型测试 mock。每个 slice 的完成条件是：

1. 生产实现改为 `.ts`；
2. 同目录直接测试改为 `.test.ts`；
3. 共享 fixture、错误和 DTO 有真实类型；
4. 对外调用点通过编译，不靠 `as any`；
5. focused tests 通过；
6. legacy JS 精确清单减少；
7. 最近的 `DOCUMENTATION.md` 路径和导出说明同步。

### 3.7 迁移提交与语义修复分开

服务端存在多种 `.catch(() => null|[]|{})`，它们并非都错误：

- 临时文件清理、关闭资源属于明确 best-effort；
- `stat`、Git `rev-parse` 等可能是存在性探测；
- 权威设置、存储、凭据、dirty state 或 catalog 读取则不能把失败当成空成功。

迁移时必须逐处分类。若静态类型暴露真实语义 bug：先增加失败模式测试，再在独立语义提交中修复；不得在机械
rename 提交里批量替换所有 catch，也不得为了过编译把错误统一压成 `unknown as ...`。

## 4. 必须保持的产品与安全不变量

整个迁移不得改变：

- Application Host 与 Electron 同进程、Renderer 只走 HTTP/SSE/WebSocket/preload 的进程模型；
- `DocumentsAPI` 是唯一文本 authority；
- workspace containment、realpath、项目信任和 mutation epoch；
- Recovery v5 的 dirty barrier、workspace lease、retention、operation phase 和 catalog schema；
- Pi worker 的私有 IPC、runtime broker generation 和 session ownership；
- UI/客户端错误中 missing、empty、malformed、stale、conflict、failed 的区分；
- CLI `--json`、`--quiet`、非 TTY 和退出码契约；
- Relay 密文边界、认证 cookie/bearer/pairing、Origin 和 URL-token 策略；
- Electron context isolation、preload allowlist、外部 URL/路径验证和更新签名策略；
- `bun-pty` 只在 Bun 运行时动态加载，Electron/Node fallback 使用 `node-pty`；
- `better-sqlite3`、`node-pty`、`sherpa-onnx-node` 等原生模块继续由当前打包/解包策略提供；
- 所有持久化文件位置和 schema version。

## 5. TypeScript 规则

### 5.1 编译规则

- 继承 `tsconfig.base.json` 的 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax` 和 `isolatedModules`。
- Host config 不加入 DOM lib；Web `Response`/`fetch` 使用 Node 22 提供的类型。
- 类型导入使用 `import type`。
- 保留相对 `.js` 后缀；不使用 `.ts` 运行时路径。
- 不降低根 tsconfig 的严格度，不在单个大文件里设置 `@ts-nocheck`。
- 不以 `skipLibCheck`、ambient `declare module '*'` 或全局 `any` 替代依赖建模。

### 5.2 边界类型

- HTTP body、query、headers、WebSocket frame、JSON-RPC frame、SQLite JSON 和子进程输出从 `unknown`
  开始，在 authority 边界解析。
- Express handler 使用真实 `Request`、`Response`、`RequestHandler`，不要自建不兼容的半个 Express 类型。
- 复用 `@piarium/application-client` 的客户端 DTO 和 typed failures；Host 私有状态不得倒灌到该包。
- 复用 `@piarium/extension-contract` 的 service/recovery contract；不要复制字符串 union。
- `PiRuntimeBroker`、extension runtime、Documents authority 和 supervisor 使用导出的接口或
  `ReturnType<typeof createX>`，不要创建一个全局“HostDependencies”万能对象。
- 注入的 `fsPromises`、`pathModule`、`processLike` 使用最窄的 `Pick<typeof ...>`，保留现有可测试性。
- SQLite 每种 query 建立明确 row interface；JSON 列解析后再成为领域类型。

### 5.3 错误与资源生命周期

- catch 变量保持 `unknown`，通过类、code/status type guard 或解析函数缩窄。
- 资源 cleanup 可以 best-effort，但主操作失败和 cleanup 失败不能互相覆盖；必要时记录次级 failure。
- 不把 malformed/unavailable 变成 `{}`、`[]`、`null`，除非该值就是函数公开声明的探测语义。
- Timer、watch、child process、SQLite handle、lease 和 subscription 的 owner/dispose 状态必须建模。
- 不因为 TypeScript 难以表达就取消 revision、generation、owner 或 abort 检查。

### 5.4 第三方和原生模块

只在编译器实际报告缺口时添加对应类型依赖。优先使用依赖自带类型；缺失时建立窄声明，例如只描述 Piarium
实际使用的 `bun-pty`/Sherpa API。禁止声明整个模块为 `any`。

原生模块的动态加载位置和 external 配置不改变。类型导入不得把原本的条件动态 import 变成顶层运行时 import。

## 6. Phase 0 — 基线、进度护栏与执行纪律

执行 agent 应按本文固定决定依次完成全部 Phase，并按建议切分 commit；本文已经决定 package 边界、源码/产物
布局、运行路径和验收策略，不需要再次询问“是否新建 application-host 包”或“是否一次提交”。只有发现当前代码与
本文证据冲突、需要改变产品行为、或必须扩大权限/发布范围时才暂停说明。

### 6.1 基线记录

执行 agent 在首个提交说明中记录：

- Application Host `.js` 和 `.test.js` 数量；
- Web 全量测试结果；
- `settings-store` 测试结果；
- Web production build；
- cloud layout tests；
- Electron architecture tests；
- `git status --short`。

已有结果可以复用，但必须在当前执行分支确认，没有必要反复运行同一套昂贵基线。

### 6.2 临时 legacy 清单

源码移动后增加精确的 legacy JS 清单和 architecture test：

- 清单列出仍允许存在于 `application-host` 的 `.js`/`.test.js`；
- 新增 JS 若不在清单中则失败；
- 每个迁移 Phase 删除对应条目；
- 最终 Phase 删除清单与临时测试。

允许永久保留的只有明确作为外部 Node 子进程输入的静态 fixture；优先也由 TS 源码编译生成。任何例外必须在
清单旁写明为何不能编译，而不是笼统写“兼容”。

### 6.3 提交纪律

- 每个 Phase 单独 commit。
- 大规模 `git mv` 不与语义修复混在一起。
- Phase 2 之后不提交生成的 `server/`；Phase 10 建立 CLI source/output 分离后不再提交 `bin/`。`dist/` 和
  `dist-bundle/` 始终是生成物。
- 不创建 tag、Release、npm publish 或版本号。
- 未经用户明确要求不 push。

## 7. Phase 1 — 将 `@piarium/settings-store` 迁为标准 TS 包

### 7.1 写入范围

- `packages/settings-store`
- 直接消费者的 build dependency scripts
- `scripts/build-cloud-runtime.mjs`
- `scripts/cloud-runtime-layout.test.js`
- 必要的 root build 顺序和 lockfile

### 7.2 实施

1. 将 `src/index.js` 和 `src/index.test.js` 迁为 `.ts`。
2. 删除手写 `src/index.d.ts`，由 `tsconfig.build.json` 生成 `dist/index.d.ts`。
3. `package.json` 的 `main/types/exports` 改为 `dist`，增加标准 build/type-check/lint/test。
4. 类型化 transaction result、atomic replacement、lock owner、process liveness 和注入的 fs/path/process。
5. `read()` 继续区分 missing、malformed 和 `.previous` fallback。
6. 跨进程 lock 的 ESRCH/EPERM 语义、Windows replacement 和文件权限保持不变。
7. 所有 clean-checkout 消费者在编译前构建 settings-store：Runtime Broker、Web、Electron、VS Code 和根
   `build:type-dependencies`。
8. 云运行时从复制 `settings-store/src` 改为复制 `settings-store/dist`，更新 fixture 和 closure test。

### 7.3 验收

- settings-store build/type/lint/test 通过；
- 两个独立 store instance 的序列化测试仍通过；
- Runtime Broker 和 Web 能从 clean checkout 编译；
- cloud runtime layout 要求 `dist`，不再要求 `src`；
- 包内没有手写实现声明双轨。

## 8. Phase 2 — 建立 Application Host 源码/产物流水线

### 8.1 机械移动

使用 `git mv`：

```text
packages/web/server  -> packages/web/application-host
```

`packages/web/server` 随后成为生成目录。不要复制后保留旧源码。

### 8.2 构建配置

新增：

- `packages/web/tsconfig.application-host.json`
- 跨平台 build/clean helper（若纯 package script 无法可靠清理和复制公开声明）
- 过渡期公开声明源，例如 `packages/web/types/server-index.d.ts`（不能与 legacy `index.js` 同目录同 basename）
- `build:application-host`
- `type-check:application-host`

构建必须：

1. 编译到同包内的临时 staging 目录，而不是直接覆盖当前 `server/`；
2. 编译/复制 application-host 的非测试 JS/TS，并生成 source map/declaration；
3. 暂时用独立维护的公开声明覆盖 staging 中 legacy `index.js` 推断出的宽松声明；
4. 不复制 `.test.*` 和模块文档到运行 artifact；
5. 验证 staging 至少包含可解析的 `index.js` 和所需深度导入；
6. 验证成功后再原子/可补偿地替换 `server/`，Windows replacement 失败时保留上一份完整 runtime；
7. 编译失败时删除 staging，继续保留上一份完整 `server/`，不能留下 partial runtime 或 stale 文件。

### 8.3 脚本接线

- `packages/web build`：先 build Application Host，再构建浏览器 UI。
- `dev:server`：先构建 Host，再启动 `server/index.js`。
- `dev:server:watch`：监听 `application-host/**/*.{js,ts}`，每次成功构建后重启生成的 server。
- `start` 和根脚本 `pack:web`：保证 Host 已构建。
- Electron HMR/打包：继续加载 `@piarium/web/server/*`，但构建链必须先生成它。
- 根 `build:type-dependencies` 与直接 `packages/electron type-check` 在读取 `@piarium/web` 声明前生成 Host；
  clean checkout 不能依赖另一个并行 package 恰好先完成。
- 云 runtime：继续复制 `packages/web/server`，不复制 `application-host`。

### 8.4 路径与文档

- 运行时字符串、CLI process detection、CI bad-artifact injection 和部署 smoke 继续使用 `server/index.js`。
- GitHub 源码 URL、开发文档、模块文档和测试命令改为 `application-host`。
- `@piarium/web` 的 `main` 与深度导入暂不改变。

### 8.5 验收

- clean checkout 执行 `build:application-host` 后存在 `server/index.js`；
- `server/` 不含测试且未被 Git 跟踪；
- `node --check server/index.js` 和动态 import smoke 通过；
- 至少一个 smoke 证明源码测试中的 `.js` import specifier 能同时解析 legacy `.js` 和已迁移 `.ts`；
- Web focused/full tests 从 `application-host` 源码运行；
- production Web build、cloud layout、CLI foreground start 和 Electron architecture test 通过；
- 运行 artifact 中不存在源码目录副本。

## 9. Phase 3 — 公共 Host contract 与平台基础模块

### 9.1 先迁移的基础模块

优先迁移低耦合、被多处消费的模块及其测试：

- `platform/data-paths`
- `platform/inherited-env`
- `platform/path-utils`
- `path-realpath-cache`
- `projects/project-id`
- `workspace/path-safety`
- settings normalization/helpers 中的纯函数
- Documents/Recovery 的 error 与 serialization primitives

Electron 当前深度导入的四个 Web helper 必须在本 Phase 获得生成声明；不要为绕过编译把 Electron 改回复制实现。
同时将这些 helper 通过 typed `server/index` facade 导出，并把 Electron 收敛到该入口；Phase 结束后不得再有新的
`@piarium/web/server/lib/*` 跨包导入。物理运行文件仍保留原路径，现有外部兼容不受影响。

### 9.2 Host public contract

建立一个 TypeScript owner，完整描述：

- `StartWebUiServerOptions`
- `WebUiServerController`
- `QuitRiskStatus`
- `parseArgs` 的结果
- Electron 注入的 broker factory、native path picker、filesystem opener、notification/focus/runtime config callback

逐个 grep `options.*` 和所有 `startWebUiServer(...)` 调用点，不能只照抄旧 d.ts。过渡期的独立
`types/server-index.d.ts` 从该 TS contract re-export，并由 Host build 复制到 `server/index.d.ts`；最终由 typed
`index.ts` 自动生成。

### 9.3 验收

- Electron 现有 `startWebUiServer` 调用不再包含声明外字段；
- Electron 不再从 `@piarium/web/server/lib/*` 深度导入；
- architecture test 阻止 Application Host 反向依赖 Web/UI/Electron；
- path identity、Windows alias、AppImage `ARGV0`、PATH merge 和 data-dir tests 通过；
- 无新增顶层动态 import 或原生模块加载；
- legacy 清单只减少不增加。

## 10. Phase 4 — Documents authority

### 10.1 范围

迁移整个 `application-host/lib/documents` 及直接测试/fixture，并迁移它依赖的 workspace path primitive。

### 10.2 关键类型

- workspace registry persisted document；
- mutation token、writer、maintenance owner 和 durable witness；
- read/write/move/delete discriminated results；
- watch position、dirty publication、dirty barrier acquire/ack/release；
- recovery journal record；
- owner-scoped capability context；
- `DocumentAuthorityError` 子类及 status/code guard。

### 10.3 不变量

- 不改变 workspace ID 或持久化 schema；
- dirty barrier 必须等待当前 generation 的新 publication；
- surface disconnect 仍使 barrier 失败；
- stale generation 不得清理新 generation；
- 文件 body 不进入 watch、URL 或日志；
- Windows 大小写和 realpath containment 保持 Host filesystem profile 语义；
- mutation authority 的跨进程 owner 回收保持“只有 ESRCH 证明死亡”。

### 10.4 验收

- Documents contract fixture 在 Web 和 VS Code 两侧通过；
- authority/routes/watch/mutation/recovery-journal tests 通过；
- Web/VS Code/UI type-check；
- 不出现 `any` authority 或通用成功空结果。

## 11. Phase 5 — Recovery v5

### 11.1 范围

迁移 `application-host/lib/recovery` 全部实现、SQLite catalog、lease、capability、coordinator 和测试。

### 11.2 关键类型

- SQLite metadata/checkpoint/change/binding/operation/operation-file/object-reference row；
- v3/v4/v5 catalog classification 与 migration result；
- `RecoveryPrimitiveError` code/origin/retryable/details；
- file state、target/safety、conflict fingerprint；
- shared/exclusive workspace lease document和 handle；
- service API result union。

### 11.3 硬边界

- 本 Phase 不升级 service version 或 catalog schema；
- 不改变 retention 默认值；
- 不改变 overwrite-confirmed、compensation 或 startup reconciliation；
- SQL 查询结果先解析再进入领域对象；
- `safe()` 只能把异常映射为明确 failure，不能映射成空列表或 ready；
- object reference 与源记录继续同事务维护。

### 11.4 验收

- catalog inspect/migrate/future-schema/read-only tests；
- crash-window apply/compensate/needs-attention tests；
- dirty barrier 和 workspace lease tests；
- retention protected-record 和 GC tests；
- 双 workspace deletion/retention scope tests；
- service integration 与完整 Recovery focused suite 通过。

## 12. Phase 6 — Process protocol、LSP、Run、Search 与 Pi runtime bridge

### 12.1 迁移顺序

`run/test-supervisor` 与 `lsp/jsonrpc` 互相依赖，按一个 strongly connected slice 迁移：

1. `run/content-length` 与 `lsp/jsonrpc`
2. DAP/task/test adapters 和 supervisors
3. LSP mapping/supervisor/routes/capability
4. workspace search
5. Pi runtime broker/gateway Web bridge
6. scheduled tasks 与 Pi session automation

### 12.2 要求

- JSON-RPC、DAP、LSP 和 worker frame 从 `unknown` 解析；
- child process 的 stdin/stdout/error/exit owner 明确；
- request correlation、generation、abort 和 dispose 不因类型化而简化；
- project-provided command 继续受 trust gate；
- fixture server/adapter 若由外部 Node 启动，使用编译产物或明确静态 fixture，不在生产引入 ts loader；
- 复用 application-client/extension-contract DTO，不复制 Renderer 类型。

### 12.3 验收

- Content-Length 分帧、JSON-RPC error、LSP lifecycle 和真实 TypeScript hover smoke；
- DAP、task、test supervisor tests；
- stale generation 与 provider disable tests；
- runtime gateway/broker focused tests；
- 无子进程泄漏，测试结束无悬挂 handle。

## 13. Phase 7 — 安全、认证、Relay、Tunnel、Mobile 与通知

### 13.1 范围

- `security`
- `ui-auth`
- `client-auth`
- `relay`
- `tunnels` 及 Cloudflare/Ngrok provider
- `external-access`
- `preview` / realtime proxy
- `mobile`
- `notifications`

### 13.2 要求

- credential、pairing、passkey、remote-client 和 tunnel persisted documents 有 parser；
- secret/token 不进入错误 details、日志或 URL；
- WebSocket/Origin/auth allowlist 保持两层独立；
- Relay 二进制/文本握手 discriminant 明确；
- 认证失败、missing credential、malformed store、network failure 不合并；
- APNs/Web Push/Expo payload 和 provider response 从 unknown 验证；
- 不借迁移新增硬配额或缩小当前外部访问能力。

### 13.3 验收

- request security、bind host、UI auth、passkey/pairing、remote client tests；
- Relay cross-compat/E2EE/host lifecycle tests；
- tunnel provider/managed config tests；
- notification/mobile tests；
- Electron 本地 server 启动仍无需第二套认证后端。

## 14. Phase 8 — 文件、Git、项目和产品服务

按依赖方向分为可审查提交，不做一个“剩余文件全转”的提交：

### 14.1 Filesystem/Git/Projects

- `fs`
- `git`
- `projects`
- `workspace`
- `session-folders`
- `package-manager`

保留 Git 存在性 probe 与 cleanup catch 的明确语义。破坏性 Git、worktree、move/delete 路径不能因类型迁移扩大
目标范围。

### 14.2 GitHub/Quota/Model services

- `github`
- `quota`
- `small-model`
- `smart-search`
- `magic-prompts`

HTTP JSON 均从 unknown 解析；provider-specific 可选字段不伪造成必填，不把非 2xx 或 malformed body 当无额度。

### 14.3 Terminal/Dictation/TTS/Walkthrough

- `terminal`
- `dictation`
- `tts` / `text`
- `walkthrough`

保持 `bun-pty`/`node-pty` 动态 fallback、Sherpa 原生加载、音频流 backpressure、终端 WebSocket frame 和 walkthrough
job lifecycle。为缺少类型的原生模块写最窄声明，并由真实 smoke 验证，而不是相信声明。

### 14.4 验收

- 每个子组 focused tests；
- Git/FS containment 与 mutation authority tests；
- quota/provider tests；
- terminal protocol/runtime tests；
- dictation/TTS tests；
- 相关路由的失败状态不退化。

## 15. Phase 9 — Platform composition 与 Host 入口

最后迁移：

- `platform/routes-runtime`
- bootstrap/startup/static/settings/tunnel wiring
- shutdown runtime
- extension route composition
- `application-host/index.js`

入口必须最后迁移，因为它聚合所有 runtime factory。此 Phase 可以把 1300 行入口中已经存在的组合块提取为 typed
factory，但不得借机重写启动顺序或创建新的 service locator。

完成后：

1. `application-host/index.ts` 真实导出 `startWebUiServer`、`gracefulShutdown`、`parseArgs`；
2. declaration emit 打开；
3. 删除手写 `index.d.ts`；
4. 删除 legacy JS 清单；
5. `allowJs` 改为 `false`；
6. architecture test 断言 `application-host` 没有生产 `.js` 或 `.test.js` 源码；
7. `server` 只含生成的 `.js`、`.d.ts`、map 和必要运行资产。

验收必须覆盖启动成功、启动失败 cleanup、Host handshake、shutdown、API-only、Electron callback injection、tunnel 启动和
无 Pi runtime 的 onboarding 路径。

## 16. Phase 10 — Web CLI TypeScript

### 16.1 源码/产物

建立：

```text
packages/web/cli  # TypeScript source/tests/docs
packages/web/bin      # generated runtime, package bin path unchanged
```

`bin` 随后成为生成目录。不要复制后保留旧源码。CLI build 与 Host build 一样先写 staging、验证
`cli.js`/shebang，再替换完整 `bin/`，失败时保留上一份完整 runtime。

新增独立 `tsconfig.cli.json` 和 `build:cli`；最终 CLI config 同样 `allowJs: false`、strict、NodeNext，并由 Web
`build/start/pack` 在需要 `bin` 前调用。

先机械移动，再按依赖顺序迁移：

1. errors/output/args/path/network/port primitives；
2. process/PID/instance/HTTP/runtime target；
3. tunnel profile 与 lifecycle；
4. 各 command；
5. `cli.ts` 和 `cli-entry.ts`。

### 16.2 契约

- `--json` stdout 不混入日志；
- `--quiet` 保留必要值；
- 非 TTY 缺参数给确定性错误和退出码；
- foreground 保持 in-process，不能改成 child orchestration；
- daemon process identity 同时识别现有发布路径；
- update/restart 不改变包名和运行目录；
- shebang 保留在生成 `bin/cli.js`。

### 16.3 最终状态

- `package.json#bin` 仍指向 `./bin/cli.js`；
- cloud/deploy scripts 仍检查该路径；
- `bin` 不提交，`cli` 无 production JS；
- CLI help、plain/quiet/json、foreground/background、status/stop/restart 和代表性 session/schedule/tunnel tests 通过。

## 17. Phase 11 — Electron 运行时 TypeScript

### 17.1 范围与排除

迁移 Electron 运行时模块和直接测试：main、preload、Pi runtime、SSH、tray、notification、updater、startup URL、
renderer security、path open、Linux discovery/autostart。

`scripts/*.mjs`、`after-pack.cjs`、installer helper 等构建工具可以继续使用 JS/MJS；它们是明确工具链，不是假装有
类型的产品 runtime。若修改其契约，仍需对应 tests/smoke。

### 17.2 目标布局

The delivered layout keeps the existing package-root module organization rather than adding cosmetic
`src/` and `test/` wrappers:

```text
packages/electron/main.ts
packages/electron/preload.ts
packages/electron/*.ts                       # native runtime modules and direct tests
packages/electron/scripts/*.{mjs,cjs}        # build/package/smoke tooling
packages/electron/dist-bundle/main.mjs       # generated
packages/electron/dist-bundle/preload.mjs    # generated
```

### 17.3 顺序

1. 先迁纯策略和 updater helpers；
2. 再迁 Linux、notification、tray、SSH；
3. 定义 preload bridge 和 IPC command/request/result union；
4. 单独构建 preload 到 `dist-bundle/preload.mjs`，开发和打包都从与 `main.mjs` 同目录的生成文件加载；
5. `main.ts` 最后迁移；
6. dev launcher 改为在启动 Electron 前构建；UI HMR 保持现状，主进程源码变化允许明确重启 Electron，不为此
   引入运行时 TS loader；
7. electron-builder 只打包 `dist-bundle/main.mjs` 与 `dist-bundle/preload.mjs`。

### 17.4 要求

- Electron 官方类型是 IPC/window/app authority；
- `window.__PIARIUM_DESKTOP__` 的 renderer-facing shape 只有一个共享类型 owner；
- IPC payload 从 unknown 验证，主进程继续执行权限检查；
- `@piarium/web`、native modules 和 Pi host/broker 继续 external；
- 开发和生产都执行构建产物，不直接执行 `.ts`；
- 不把 Web Application Host 逻辑复制到 Electron。

### 17.5 验收

- Electron strict type-check 和真实 ESLint，不再是三个 `node --check`/空 lint；
- architecture、preload/security、startup URL、updater、Linux desktop tests；
- HMR dev 和 bundled dev 启动；
- bundle-main 及 preload bundle smoke；
- Windows unpacked smoke；
- Linux/macOS 对应打包 smoke 由原生 CI runner 完成；
- native module external/unpacked 断言保持。

## 18. 构建、云和发布接线清单

执行 agent 必须逐项确认，不能只让本地 Vitest 通过：

### Web package

- `main/types/files/bin` 指向生成产物；
- build 生成 Host、CLI、Web UI；
- start/dev/watch/pack 在 clean checkout 不依赖旧产物；
- package tarball 不包含 `application-host`/`cli` 源码或测试；
- package tarball 包含 server/bin 的实际运行文件和 source map/declaration 策略允许的文件。

### Cloud runtime

- settings-store 从 `dist` stage；
- Web 仍 stage `package.json/bin/server/dist`；
- `pruneNonRuntimeFiles` 不再承担删除源码测试的职责；测试本来就不进入 runtime；
- cloud layout fixture 与 closure 更新；
- frozen production lock 只在 manifest dependency graph 确实改变时更新。

### Electron

- `@piarium/web` 继续 external；
- Electron build 前先生成 Web server；
- preload 使用生成路径；
- `asarUnpack` 和 native module inventory 不变；
- packaged smoke 继续激活真实 Host/runtime/terminal/language service。

### CI/Deploy

- intentional bad cloud archive 仍修改生成的 `packages/web/server/index.js`；
- SSH deploy artifact 检查路径不变；
- process identity 继续接受发布 runtime 路径；
- docs/source links 改到 source 目录，runtime assertions 保持 server/bin。

## 19. 验证策略

不要在每个文件 rename 后跑全仓。按能够暴露不同错误类别的范围验证。

### 每个 slice

- owner tsconfig type-check；
- owner ESLint；
- 同目录 focused tests；
- application-host build；
- legacy 清单收缩测试；
- `git diff --check`。

### Documents/Recovery/协议等高后果 slice

- 对应 contract/service consumer tests；
- persisted schema old/current/future/malformed；
- stale/conflict/disconnect/crash/restart；
- Web/VS Code/UI consumers type-check。

### Host 入口完成后

- Web full test；
- production Web build；
- Application Host generated import/start/shutdown smoke；
- cloud runtime tests与实际 stage layout；
- dead-code diagnostic；
- docs validation。

### CLI 完成后

- CLI full tests；
- 生成 tarball 后从 `bin/cli.js` 执行 help、status 和 foreground health smoke；
- plain/quiet/json 输出 snapshot/behavior tests。

### Electron 完成后

- strict type/lint；
- architecture/updater/Linux focused tests；
- HMR 与 bundled dev smoke；
- bundle/package/unpacked native smoke；
- 最终跨平台 smoke 留给对应原生 runner，不在错误架构上伪造通过。

### 性能

迁移前后使用现有 `PIARIUM_STARTUP_PERF=1` 在同一机器记录 Host startup/health/handshake 样本，并比较生成
artifact 大小和模块加载路径。不得凭空制定百分比硬门槛；若出现可观察的额外编译器 loader、重复 bundle、明显启动
回退或内存增长，必须定位原因。结构性硬要求是生产 runtime 没有 TypeScript loader，也不同时携带源码和运行副本。

## 20. 推荐提交切分

建议至少保持以下可独立审查提交：

1. `refactor(settings): migrate atomic settings store to TypeScript`
2. `build(web): separate application host source from runtime output`
3. `refactor(host): type public contracts and platform foundations`
4. `refactor(host): migrate document authority to TypeScript`
5. `refactor(host): migrate recovery v5 to TypeScript`
6. `refactor(host): migrate language and run supervisors to TypeScript`
7. `refactor(host): migrate security and network runtimes to TypeScript`
8. `refactor(host): migrate filesystem and product services to TypeScript`
9. `refactor(host): type application host composition and declarations`
10. `refactor(cli): migrate Piarium CLI to TypeScript`
11. `refactor(electron): migrate desktop runtime to TypeScript`
12. `docs(architecture): record the typed privileged runtime boundary`

若某 Phase 暴露真实行为 bug，增加“测试 + 语义修复”独立 commit，不要塞进 rename commit。

## 21. 明确排除

本计划不做：

- 新建可发布 `@piarium/application-host` 包；
- 改变 Application Host 进程模型；
- 在 Application Host route/composition 中新建 Piarium-owned tool/context/environment/turn engine；
- 创建没有真实执行功能的空 `@piarium/execution-kernel` scaffold；
- 重写 Express 为另一套 HTTP 框架；
- 把 Electron backend 复制成第二套 Host；
- 修改 Recovery/Document/extension/protocol schema；
- 重新设计 route URL 或 RuntimeAPIs；
- 重画 UI；
- 顺手迁移仓库所有 build/release 脚本；
- 因类型困难删除功能、平台分支或第三方 provider；
- 批量把错误吞成 `null`/空数组；
- 加无依据的 timeout、大小、数量、并发或路径限制；
- 发布版本或改产品版本号。

## 22. 执行 agent 最终报告要求

执行完成后报告必须包含：

- 每个 Phase 的 commit hash 与目标；
- Application Host、CLI、Electron runtime 剩余 JS source 数量及每个例外理由；
- 手写 `.d.ts` 是否全部移除；
- clean checkout build 依赖链；
- 实际运行的 focused/full/package/smoke 命令和结果；
- 未能在当前平台运行的原生 smoke；
- 新增类型依赖或 ambient declaration 的依据；
- 迁移中发现并单独修复的语义 bug；
- 未解决风险，不得用“全部测试通过”代替说明证据边界。

## 23. 最终验收清单

- [x] `settings-store` 为 TS source + generated dist/declarations。
- [x] `application-host` 无未解释的 JS production/test source。
- [x] `server` 是未跟踪的纯生成运行目录。
- [x] Host public declaration由实现生成，旧 `server/index.d.ts` 删除。
- [x] Application Host 不反向依赖 Web browser source、UI 或 Electron。
- [x] 跨包 Host 消费只经过 typed `server/index` facade，不再新增 `server/lib/*` deep import。
- [x] Application Host 没有吸收未来 execution-kernel 的 tool/context/environment/turn 职责。
- [x] Web tsconfig/lint 真正覆盖 Application Host。
- [x] Documents/Recovery/LSP/DAP/auth/persistence 无 `any` authority。
- [x] `cli` 为 TS，`bin` 为生成 JS，CLI 路径和输出契约不变。
- [x] Electron main/preload/runtime 为 TS source，packaged output 为预编译 MJS。
- [x] Electron scripts 中保留的 MJS 都是明确工具链而非产品 runtime。
- [x] Web/CLI/Electron/Cloud clean-checkout 构建不依赖本地 stale artifact。
- [x] 生产产物不包含 TS loader，不重复携带 source/runtime tree。
- [x] 原生模块仍按当前 external/unpacked 策略工作。
- [x] Web full tests、cloud tests、CLI tests、Electron tests和可用原生 smoke 通过。
- [x] 路由、服务、持久化 schema、错误码、默认值和产品能力无意外变化。
- [x] 文档、源码链接、开发命令和包 ownership 与最终目录一致。
- [x] 没有新增 OpenCode compatibility facade 或无依据限制。
