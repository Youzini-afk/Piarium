# Testing and CI audit — Stage Q (D-292)

Baseline: `a92140df` (`docs: plan testing and CI redesign before AI4S`).
Scope covered: every `packages/*/package.json` test/build entry, all Vitest
configs, `scripts/test-*.mjs`, `.github/workflows/*`, and the representative
files listed in the stage plan. This is an entry-and-family audit, not a
line-by-line review of all ~800 test files; dispositions for families not yet
inspected are marked **unknown**.

## 1. Execution entries today

| Entry | Command | Runner | Discovery |
| --- | --- | --- | --- |
| `test:pi` | `bun run --sequential --no-exit-on-error --filter '@piarium/*' test` | mixed | every `@piarium/*` package `test` script |
| `test:pi:dist` | same filter, `test:dist` | node | only pi-host, runtime-broker, runtime-client define it |
| `test:kernel` | `node scripts/test-kernel-authority.mjs` | node --test + vitest | explicit file list, requires release kernel |
| `test:cloud` | `bunx vitest run scripts/cloud-runtime-layout.test.js scripts/cloud-remote-deploy.test.js scripts/docker-cloud-tools.test.js` | vitest | 3 files |
| `test:node-smoke` | `bun run build:application-host && node --test application-host/lib/knowledge/store.smoke.test.ts` | node | 1 file |
| `test:i18n` | `vitest run src/lib/i18n/messages.test.ts src/lib/i18n/messages/i18nParity.test.ts` | vitest | 2 of 6 i18n files |
| Electron | `test:runtime` / `test:architecture` / `test:updater` / `test:linux-desktop` | vitest + node | see §4 |
| docs | `bun run docs:validate`, `test:docs` | node scripts | docs tree |
| packages (flat) | `tsx --test test/**/*.test.ts` / `src/**/*.test.ts` | node --test | **unquoted glob — see §2** |
| packages/vscode | *no `test` script* | none | **17 files dead — see §5** |

## 2. Discovery defects

### 2.1 Unquoted `**` glob in `tsx --test` scripts (confirmed)

`"test": "tsx --test test/**/*.test.ts"` relies on shell glob expansion.
In bash without `globstar`, `**` collapses to `*`, so the pattern becomes
`test/*/*.test.ts` — only one directory level deep.

- `packages/pi-host`: 37 files at `test/*.test.ts` + 38 at `test/*/*.test.ts`
  = 75 total. POSIX-shell expansion silently drops the 37 root files
  (~half the suite, incl. `zone0-stability`, `pi-hooks-contract`,
  permission-gate, session e2e). Matches the design-recorded Linux-vs-Windows
  divergence (247 vs 393 tests).
- Flat packages (`protocol`, `runtime-broker`, `extension-*`,
  `application-client`, `runtime-client`, `settings-store`, …) keep all tests
  at `test/*.test.ts`; the collapsed pattern matches nothing and falls through
  to the runner, whose own glob then still resolves the files — so flat
  packages are only accidentally correct, and pi-host is silently wrong.

Disposition: **fix** — quote the glob (`tsx --test "test/**/*.test.ts"`) so
the runner owns discovery on every platform. Verified working on Windows for
the full pi-host suite.

### 2.2 Kernel/native tests have two owners (confirmed)

`scripts/test-kernel-authority.mjs` builds/requires a release kernel and runs
`kernel-client.test.ts` (node --test) plus 9 vitest files. All 9 are also
inside `packages/web` `vitest run` (only `kernel-client` is excluded), and
five more kernel-requiring files use
`createNativeAuthorityTestRuntime` (`await fs.access(kernelPath)`):

- `lib/kernel/{file-resource-audit,kernel-compute,kernel-process,
  kernel-transport.acceptance,process-consumers,request-window,
  storage-adapter}.test.ts`
- `lib/recovery/kernel-durable-engine.test.ts`
- `lib/harness/shell-assembly.test.ts`
- `lib/lsp/bundled-language.test.ts` (kernel-gated, **not** in the authority
  list — hidden `skipIf` in the Web suite; only runs when a binary exists)
- `lib/documents/authority-surface-identity.test.ts`,
  `lib/harness/document-read-source.test.ts`,
  `lib/harness/thread-lifecycle.acceptance.test.ts`,
  `lib/harness/working-state/materialized-baseline-update.acceptance.test.ts`,
  `test/integration-surface-vertical.test.ts` (fail hard when the kernel is
  absent or stale)

Consequences measured locally: `bun run test:pi` on a checkout whose
`kernel/target/release` binary is stale (host 0.9.12 vs kernel 0.9.11)
produces ~17 failures across these files; on a checkout with no binary the
`skipIf` files silently pass without testing anything. `test:pi` is thus not
deterministic without a fresh kernel build, and the kernel tests run twice in
CI (inside `test:pi` and again via `test:kernel`).

Disposition: **re-own** — all native/kernel-path test files belong to the
kernel authority entry (fresh, manifest-matched binary). The Web suite must
exclude them so `vitest run` is deterministic without Rust artifacts. Because
Vitest `exclude` also filters CLI file arguments, the kernel set needs its
own Vitest config rather than an exclusion plus file list.

### 2.3 i18n specialized entry duplicates the UI suite (confirmed)

`test:i18n` runs 2 of 6 i18n test files; all 6 already run inside
`vitest run` (the `test` script consumed by `test:pi`). CI additionally runs
`bun run test:i18n` as a separate step — pure duplicate execution.

Disposition: **merge** — i18n files stay in the UI unit suite; drop the CI
step. Keep `test:i18n` as a local convenience alias (documented as such).

### 2.4 Electron entries overlap (confirmed)

- `test:runtime` = `vitest run` → all top-level `*.test.ts` including the four
  `updater-*.test.ts` and `linux-autostart.test.ts`.
- `test:architecture` = `prepare:pi-runtime` + `test:runtime` + `node --test`
  scripts/*.test.mjs.
- `test:updater` re-runs the 4 updater vitest files + 2 node scripts.
- `test:linux-desktop` re-runs `linux-autostart.test.ts` + 2 smokes.

In CI (`windows-runtime` runs `test:architecture` + `test:updater`) the
updater files execute twice and the full vitest suite runs twice.

Disposition: **split ownership** — the main vitest config excludes
`updater-*.test.ts` and `linux-autostart.test.ts`; those files are owned by
`test:updater` / `test:linux-desktop` respectively. Every file still runs,
each exactly once.

## 3. False-success and formalistic tests

### 3.1 Zone 0 stability (confirmed defect)

`packages/pi-host/test/zone0-stability.test.ts` configures a faux provider
with a fixed list of 5 responses but drives 5 prompts that include tool-call
continuations; the actual provider-call count exceeds the fixture. Observed
~93 s runtime and failure. Provider exhaustion does not fail fast — it
surfaces as timeout/retry noise, and terminal state is not asserted.

Disposition: **repair** — make the faux provider fail loudly on unexpected
requests, give every expected call an explicit response, assert terminal
success and byte-identical Zone 0 prefix growth. Do not raise timeouts.

### 3.2 Retired recovery engine used as production evidence (confirmed)

Production wiring (`application-host/index.ts`):
`createWorkspaceRecoveryEngine` (`lib/recovery/journal-engine.ts`) over
`kernelRecoveryStore`/`KernelRecoveryContentStore`, wrapped by
`createKernelRecoveryDirectFacade`. The kernel owns durable state.

`lib/recovery/local-sqlite-recovery-engine.test-helper.ts` is a ~3,585-line
re-implementation of the whole engine surface — the retired pre-kernel
engine, used only by tests:

- `engine.test.ts` (~1,370 lines) tests this dead engine directly.
- `service-integration.test.ts` (~173 lines) tests capability dispatch
  through it.
- ~7 consumer test files import it as their engine fixture.

Testing the retired engine proves nothing about production, and ~3,585 lines
of parallel state machine must be kept behavior-identical by hand. A narrow
in-memory port already exists
(`lib/recovery/recovery-durable-port.test-helper.ts`, ~197 lines,
`RecoveryDurableMetadataPort`) and is used by 3 tests.

Disposition: **replace** — point engine/consumer tests at the production
`createWorkspaceRecoveryEngine` with the in-memory durable port, then delete
the retired engine helper. Keep `kernel-durable-engine.test.ts` and the
native vertical files as the authoritative-path evidence.

### 3.3 Source-text / statement-order tests

| File | Pattern | Disposition |
| --- | --- | --- |
| `ui/src/App.pi-root.test.ts` | `readFileSync(App.tsx)` + `toContain` | **delete** — asserts absence of retired OpenCode symbols and presence of identifiers; no user behavior. Real boot behavior belongs to a render test if a gap remains. |
| `ui/src/apps/MobileApp.pi-root.test.ts` | same | **delete** (same reason) |
| `ui/src/components/**/​*.pi-root.test.ts` (4 files) | same migration-era source assertions | **delete** |
| `ui/src/components/views/__tests__/terminalViewportRemount.test.ts`, `mainLayoutMobileSidebarMount.test.ts` | source/DOM-text assertions | **review** — replace with rendered-behavior assertions or delete |
| `ui/src/components/ui/piarium-splash-lattice.test.ts`, `piarium-logo-geometry.test.ts` | reads SVG/component source | **review** — geometric invariants may be tested on rendered output |
| `vscode/src/webviewHtml.test.ts` | regexes `workerSrc`/`scriptSrc` out of source | **replace** — call the real HTML/CSP generator and assert on its output (real security boundary) |
| `scripts/cloud-remote-deploy.test.js` | `indexOf` statement-order assertions on deploy scripts | **delete** — the production-build deploy smoke exercises real archive→deploy→health→rollback; statement order proves nothing. Note: Windows-local install ordering it checks is *not* covered by the Linux deploy smoke — record as residual gap, do not keep text test for it. |
| `scripts/cloud-runtime-layout.test.js` | lock-file content checks + builder-source `toContain` | **keep** the `cloud-runtime.bun.lock` package-closure assertions (real artifact input to `--frozen-lockfile`); **trim** builder-source text checks |
| `scripts/docker-cloud-tools.test.js` | parses Dockerfile/apt package lists, workspace-manifest COPY completeness, workflow text | **keep** artifact-closure checks (every workspace manifest COPY'd, apt deps, entrypoint); **trim** pure workflow-structure assertions |
| `scripts/host-production-boundary.test.mjs` | exercises real `inspectHostProductionGraph`/`pruneLegacyHostArtifacts` on fixture trees | **keep** — behavior test of a real packaging tool |
| `electron/architecture.test.ts` | file-set + `no-any`/`@ts-ignore` source scan | **keep** file-set boundary (no parallel JS backend); the `no-any` property overlaps lint — low priority to migrate |
| `web/…/architecture.test.ts`, `cli/architecture.test.ts` | import-graph boundary | **keep** — production import graph is an explicitly protected boundary |

### 3.4 Docs gates

`docs:validate`/`test:docs` mostly run real checks (links, page routes,
validator behavior). The commit-date↔document-date sync gate exists only to
keep prose timestamps fresh — it blocks unrelated work and proves no
capability. Disposition: **remove** the date gate; keep link/route/structure
checks. (Confirm exact location during Q1.)

### 3.5 Remaining `readFileSync` tests

~50 test files read files. Most are legitimate (fixture inputs, built-output
checks, message catalogs). The `*.pi-root.test.ts` family above is the
source-text offender. Unknown: some `web` tests reading source for wiring
assertions (e.g. `startup-pipeline-runtime.test.ts`,
`shell-integration-scripts.test.ts`) — **review in Q1**; where they assert
generated artifact content they are acceptable, where they assert statement
presence they are not.

## 4. Build / smoke duplication

- `test:node-smoke` = `build:application-host` + node --test 1 file; then
  `test:pi:dist` runs dist smoke in 3 packages, each rebuilding or rebuilding
  against dist. Production-build job then builds the full production bundle
  again. Measured cost is acceptable but ownership is fuzzy.
- `desktop-release.yml` re-runs the whole source-quality suite before
  packaging — same-environment duplicate execution. Disposition: reuse the
  `production-build` artifact or gate on its success instead of re-verifying.
- `docker.yml` + `cloud` smoke: immutable image smokes set
  `PIARIUM_UI_PASSWORD=piarium-ci-smoke-only` and verify health — real
  artifact tests, **keep**.

## 5. Dead suite: packages/vscode

17 test files, **no `test` script** — never run by `test:pi`
(package name `piarium` is outside the `@piarium/*` filter) and never run in
CI except `test-pi-runtime.mjs`/`test-native-search.mjs` harness checks.

Measured `bun test` run: 53 pass, 6 fail, 5 file-level errors:

- 5 files (`webviewHtml.test.ts`, `webview/piRuntimeTransport.test.ts`,
  `webview/api/{bridge,bridge-acquire-fallback,documents}.test.ts`) use
  `node:test` `describe`/`test` nesting that Bun does not implement —
  runner-level `ERR_NOT_IMPLEMENTED`. **Replace**: port these small files to
  `bun:test` (trivial) so one runner owns the package; `webviewHtml` is
  rewritten per §3.3 anyway.
- `search-runtime.test.ts` "bridges to a manifest-verified release kernel"
  fails locally against the stale 0.9.11 binary — real kernel test,
  environmental failure locally; runs against the packaged runtime in CI.

Disposition: **wire** — add `test` (`bun test`) to the package, migrate the 5
node:test files, add a CI step so the suite is no longer dead.

## 6. Cloud deploy smoke failure (root-caused)

CI failure signature: `PIARIUM_UI_PASSWORD is not set` →
`Piarium daemon exited before reporting ready (code 1)` on the **first**
"good" deploy; rollback scenarios never execute.

Local reproduction with the checked-out generated kernel artifact shows the
real daemon error: `kernel-manifest-mismatch` (host 0.9.12, kernel 0.9.11).
Classification: **product/artifact + diagnostics**, not test noise — the
staged runtime must carry a kernel whose manifest matches the host build;
the smoke must surface the daemon log tail on failure instead of only
`code 1`.

Disposition: **fix in Q2** — ensure the cloud runtime archive is built
against a matching release kernel in the same job (identity-bound artifact),
and print daemon stderr/log on startup failure. The local stale artifact is
an environment issue and out of editable scope.

## 7. Platform coverage

- `windows-runtime` job re-runs kernel build + `test:pi` + Electron suites —
  genuine platform evidence (paths, process spawning, updater). Keep the
  platform gate; dedupe within the job (single kernel build feeding all
  steps; Electron ownership per §2.4).
- `production-build` duplicates `source-quality` verification. Keep it as
  the **artifact** gate: build once, run dist/cloud/vsix checks against that
  artifact; do not re-run the source suite.
- Docs-only changes currently trigger every job including Docker/native.
  Add path filters so docs-only diffs run the docs/source gates only.

## 8. Disposition summary

| Family | Disposition |
| --- | --- |
| `tsx --test` unquoted globs (12 packages) | fix — quote pattern |
| kernel/native web tests (15 files) | re-own under `test:kernel` via dedicated vitest config |
| `test:i18n` CI step | merge into UI suite; drop duplicate CI step |
| Electron runtime/updater/linux overlap | split vitest ownership |
| `zone0-stability.test.ts` | repair fixture + terminal assertions |
| `local-sqlite-recovery-engine.test-helper.ts` + `engine.test.ts` | retarget to production engine + in-memory port; delete retired engine |
| `*.pi-root.test.ts` (7 files) | delete (retired-migration source text) |
| `webviewHtml.test.ts` | replace with generator-output assertion |
| `cloud-remote-deploy.test.js` | delete (covered by real deploy smoke) |
| `cloud-runtime-layout`/`docker-cloud-tools` | keep artifact-closure checks, trim text checks |
| vscode suite | wire runner, migrate 5 node:test files |
| docs date gate | remove date sync check |
| cloud deploy smoke | fix artifact kernel identity + failure logging |
| desktop-release re-verification | consume build artifacts instead of re-running suite |
| docs-only CI triggering | add path filters |
| `thread-runtime.test.ts` (4,007 lines), explore*.test.ts family | **unknown** — reviewed for duplication in Q1 only if touched; they are real behavior tests on inspection samples |
| `settings-store`, `protocol`, `runtime-*`, `extension-*` suites | **retain** — input/output and boundary tests; glob fix only |

## 9. Q1 outcomes on the open questions

1. **local-sqlite helper removal** — resolved. Consumers split into two
   fixtures: recovery-semantics tests now drive the production
   `createWorkspaceRecoveryEngine` over a faithful in-memory durable port
   (`recovery-durable-port.test-helper.ts`), and `WorkingStateStore` tests
   use an explicit SQLite catalog context shim with real object GC
   (`working-state-root-adapter.test-helper.ts`). The 3.5k-line retired
   engine is deleted. Crash/recovery expectations were rewritten to the
   journal-engine semantics (navigation rejection stays resumable;
   compensation crash reaches `needs-attention`; host-kill leaves the
   catalog at the pre-crash state).
2. **`.pi-root` deletions** — resolved. The 6 files asserted retired
   OpenCode symbols and identifier presence, not user behavior; boot
   catalog and surface resolution remain covered by the UI suite.
3. **Docs date gate** — resolved. `checkLastUpdated` in
   `scripts/docs/engineering-docs.mjs` compared `Last updated:` against
   the file's last commit date via a per-file `git log` call in
   `validate-docs.mjs`. The comparison, the git machinery, and the
   shallow-clone branch are removed; ISO-format and future-date checks
   remain.
4. **`cloud-runtime.bun.lock` authority** — still open for Q2; the lock
   file remains the `--frozen-lockfile` input, and the cloud smoke's
   first-deploy failure is a kernel-identity artifact issue (§6), not a
   lock problem.
5. **Windows-local install ordering** — residual gap accepted. The
   statement-order text test is deleted; the Linux deploy smoke covers
   archive→deploy→health→rollback on the real artifact, and no
   fixture-level Windows install check exists.
6. **`terminalViewportRemount.test.ts`** — deleted. It asserted source
   text of `TerminalView.tsx`/`TerminalViewport.tsx`; the remount-churn
   regression it guarded (session-id in the viewport key rebuilding the
   WASM terminal) now has no behavioral coverage — the UI suite has no
   renderer-level terminal harness. Accepted residual gap.
7. **`mainLayoutMobileSidebarMount.test.ts`** — listed in the audit but
   does not exist in the tree; nothing to do.
8. **`webviewHtml.test.ts`** — replaced with a real `getWebviewHtml`
   call asserting the generated CSP (`worker-src` allows `blob:`,
   `script-src` does not).
9. **VS Code suite** — wired (`test` = `bun test`), all `node:test`
   imports migrated, `documents.test.ts` isolated from the module-cached
   bridge via a query-busted bridge + `mock.module`, and the worktree
   bootstrap test now disables `gc.auto`/`maintenance.auto` in fixture
   repos and polls bounded `rm` retries, ending the Windows `EBUSY`
   flake and the dangling git child. `search-runtime` passes against a
   rebuilt 0.9.12 kernel.
10. **`startup-pipeline-runtime.test.ts`** — kept the ordering behavior
    test; removed the retired-OpenCode source scan.
