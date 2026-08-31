# Piarium contributor guide

## Start from current authority

Piarium keeps project knowledge in ordinary repository documentation, next to the code it describes.
Start with [docs/development.md](docs/development.md), [docs/architecture.md](docs/architecture.md), and
the nearest `README.md` or `DOCUMENTATION.md` in the owning package or module.

Code, types, tests, schemas, and `package.json` scripts are executable authority. Documentation explains
ownership and intent. If prose and implementation disagree, inspect recent commits and callers, decide
which behavior is current, and update the stale side in the same change. Historical plans and the local
OpenChamber checkouts are reference material, not current authority.

The repository deliberately has no project-local workflow Skills. Do not add one merely to repeat a
module document, prescribe routine steps, or encode a one-off failure. A Skill is justified only when
the user explicitly wants a reusable, tool-specific operation that cannot be made clearer or more
reliable as code, a script, or normal documentation.

## Product boundary

- Piarium is a Pi-native direct refactor of the maintainer's OpenChamber fork. All Piarium edits,
  commits, and pushes happen in this repository; external OpenChamber checkouts remain read-only.
- The OpenCode cutover is complete. Do not restore OpenCode contracts, compatibility facades, parallel
  implementations, or dead migration paths.
- Preserve the fork capabilities recorded in
  [docs/openchamber-pi-migration.md](docs/openchamber-pi-migration.md) unless a reviewed Pi-native
  implementation is behaviorally and security-equivalent.
- Do not add speculative restrictions. A limit needs a concrete protocol, platform, safety, data, or
  measured resource failure behind it; defaults, warnings, and configurable budgets are distinct from
  hard rejection.

## Ownership and trust boundaries

- `packages/application-client` owns the framework-neutral `RuntimeAPIs` aggregate interface, all API
  interfaces, typed failures, and pure DTO types. It has no React, Zustand, or UI component dependencies.
- `packages/ui` owns shared React presentation, Pi domain state, the Document Registry, and the Editor
  Workbench Kernel. It does not own privileged processes or the runtime-facing client contracts.
- `packages/web` owns Web/remote surfaces and the trusted application host, including document, search,
  language, task, debug, test, and Pi runtime services.
- `packages/electron` is the native shell. It hosts the Web application host in-process and must not
  grow a parallel backend.
- `packages/vscode` is a companion extension and runtime bridge, not a second workbench.
- `packages/mobile` is a Capacitor client connected to a Piarium server.
- Runtime, protocol, and extension packages own their named process and contract boundaries as mapped in
  [docs/architecture.md](docs/architecture.md).

Never execute Pi extensions in a renderer. Keep privileged filesystem, network, credential, shell, and
process behavior in the application host, Electron main/preload, VS Code extension host, or Pi host as
appropriate. Validate untrusted process/network input and never log credentials, prompt bodies,
bearer/pairing data, or file contents.

## Workbench and data invariants

- Agent Workspace (`default`) and IDE Workbench (`piarium.ide`) are extension-provided shells selected
  through Workbench Profiles. Do not add a global `agentMode`/`ideMode` ownership branch.
- Shells own presentation. Documents, editor groups, terminals, Git, profiles, and runtime identity
  remain in the shared kernel or their trusted host authority.
- `DocumentsAPI` is the single text-content path. `FilesAPI` remains browse/binary/CRUD and
  `WorkspaceAPI` remains project/tree/Git/upload.
- Desktop/Web Agent and IDE share the Monaco document path. Mobile and embedded editors use their
  purpose-specific CodeMirror adapters; VS Code keeps its host editor. None creates another buffer,
  dirty-state, save, or language-process authority.
- Pi session JSONL, Pi settings/packages, and plugin-native configuration remain their documented
  authorities. Missing, empty, malformed, stale, failed, and conflicting states must not collapse into
  the same successful empty result.
- Commit a profile, shell, provider, or owner generation only after its candidate is ready. Failed or
  superseded work leaves the previous authoritative generation active.

## Changes, verification, and Git

Inspect the owning implementation, consumers, and focused tests before changing behavior. Choose
verification by what could actually regress: a local change needs focused evidence; a shared contract
needs its real consumers; packaging and platform behavior need the relevant runtime or smoke check.
Do not repeat broad checks that cannot change the decision. The command source of truth is the nearest
`package.json`; repository development and validation details live in
[docs/development.md](docs/development.md).

Preserve unrelated user changes and avoid destructive Git operations. Keep coherent phases reviewable,
commit and push completed phases, and report what was and was not verified.
