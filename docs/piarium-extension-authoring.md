# Authoring Piarium extensions

Piarium extensions customize the Piarium application host and workbench. They are a separate product
object from Pi packages: installing or disabling a Piarium extension never installs, disables, or
rewrites a Pi package. A repository may publish both, but each keeps its own manifest, lifecycle,
configuration, and update policy.

This guide covers the public authoring path. It does not require imports from `packages/ui`, private
React components, or a source checkout of Piarium.

## Public packages

| Package | Use |
| --- | --- |
| `@piarium/extension-contract` | Browser-safe manifest, contribution, service, routing, workbench, and discovery DTOs plus JSON schemas |
| `@piarium/extension-sdk` | Framework-neutral managed, isolated, and Host activation contexts |
| `@piarium/extension-sdk/testing` | Surface, isolated-realm, and brokered-Host lifecycle conformance harnesses |
| `@piarium/extension-surface` | Surface owner lifecycle and registry substrate for advanced tests or alternate hosts |
| `@piarium/extension-react` | Optional React 19 adapter; React is not part of the core contract |
| `@piarium/extension-cli` | `init`, `check`, `build`, and `test` author workflow |

All packages are public AGPL-3.0-only packages. Extension code should import the SDK and contract,
not Piarium's product UI.

## Create a project

```sh
npx @piarium/extension-cli init ./my-extension \
  --id dev.example.my-extension \
  --name "My Extension"
cd my-extension
npm install
npx piarium-extension build
npx piarium-extension test
```

`init` is deliberately non-interactive and refuses to overwrite a non-empty directory. The generated
project is a complete managed Surface extension with a standalone `piarium.extension.json`, source,
build mapping, TypeScript configuration, and package metadata.

Optional `--template` values:

| Template | What it generates |
| --- | --- |
| `surface` | Default managed Surface page contribution |
| `shell` | Framework-neutral `workbench.shell` replacement using `defineShellMount` |
| `editor` | Custom resource editor selected by language or filename |
| `view` | Sidebar view on `workbench.primary-sidebar.views` |
| `language` | Brokered Host language provider using `defineLanguageProvider` |
| `debug` | Brokered Host debug adapter using `defineDebugAdapter` |
| `test` | Brokered Host test provider using `defineTestProvider` |

Shell, editor, and view templates import only `@piarium/extension-sdk` and
`@piarium/extension-contract`. They must not import Piarium's React product UI. Documents, terminals,
and sessions stay in Core even when a community Shell fully redraws the chrome.

## Workbench SDK

`@piarium/extension-sdk` re-exports workbench targets, slots, context keys, and the `default` /
`piarium.ide` profile IDs. Use:

- `defineSurfaceMount` / `defineShellMount` / `defineViewMount` / `defineEditorMount` for DOM, Canvas, or any framework
- `createWorkspaceDocumentsClient` for resource-scoped, revisioned document reads and writes
- `createWorkspaceLanguageClient` / `defineLanguageProvider` to register a Host-side language server
- `createWorkspaceDebugClient` / `defineDebugAdapter` to register a Host-side debug adapter
- `createWorkspaceTestClient` / `defineTestProvider` to register a Host-side test provider
- `@piarium/extension-sdk/testing` fixtures for enable/disable leak checks, async mount abort, profile switch without mutating desired enablement, and expected-revision document conflict

`@piarium/extension-react` remains optional. `defineReactShell`, `defineReactView`, and
`defineReactEditor` wrap the same mount contract.

Language, debug, and test helpers accept either a static descriptor or a function receiving the
brokered Host context. Use `context.assets.path("runtime/server.mjs")` for an executable shipped in the
extension package. Piarium resolves the path inside the immutable selected artifact; it is not relative
to the workspace, application process, or private artifact layout. Package-relative paths cannot
escape the extension package.

An `editor` contribution declares at least one `data.languageIds` or `data.filenames` selector and may
set a finite `data.priority`. It is a resource provider, not a toolbar action, so it does not need a
Workbench slot. `defineEditorMount` receives a stable `mount.props.document` controller. Subscribe to
it, read `getSnapshot()`, apply text with the current `documentVersion`, and save with the same
expected version. Piarium keeps the buffer, dirty state, conflicts, recovery journal, and disk revision
authoritative; the custom editor only owns its view. If the contribution is disabled, updated, or
fails to mount, that editor view falls back locally without dropping the document or layout.

An isolated iframe editor receives a `piarium-message` event whose value is a
`PiariumIsolatedEditorMountMessage`. It then uses its granted `workspace.documents` Surface capability
with the supplied resource identity. Reads include the current Piarium buffer and `documentVersion`;
writes must include both `expectedRevision` and `expectedDocumentVersion`, so an isolated realm cannot
silently overwrite a newer local edit.

Do not publish a new npm tag from this handoff. The coordinated next public version is **0.2.0** for
`extension-contract`, `extension-sdk`, `extension-react`, `extension-cli`, `extension-surface`, and
`extension-host`. Wait for an explicit publish approval.

## Manifest authority

`piarium.extension.json` is the authoritative package contract. `package.json` remains npm/package
metadata; its version must match the manifest version.

```json
{
  "$schema": "https://raw.githubusercontent.com/Youzini-afk/Piarium/main/packages/extension-contract/schema/piarium.extension.schema.json",
  "schemaVersion": 1,
  "id": "dev.example.memory-workbench",
  "displayName": "Memory Workbench",
  "version": "1.2.0",
  "engines": { "piarium": ">=0.1.0 <0.2.0" },
  "metadata": {
    "description": "A custom memory workspace",
    "homepage": "https://example.dev/memory-workbench",
    "repository": "https://github.com/example/memory-workbench",
    "icon": "assets/icon.svg",
    "keywords": ["memory", "workspace"]
  },
  "entrypoints": {
    "host": {
      "file": "dist/host.cjs",
      "mode": "brokered",
      "activation": ["service-request"]
    },
    "surfaces": [
      {
        "id": "dev.example.memory-workbench.main",
        "file": "dist/surface.cjs",
        "mode": "managed",
        "supports": ["desktop", "mobile", "vscode", "web"]
      }
    ]
  },
  "requires": {
    "services": [{ "id": "piarium.sessions", "version": 1, "binding": "single" }]
  },
  "provides": {
    "services": [{ "id": "dev.example.memory", "version": 1, "multiple": true }]
  },
  "capabilities": {
    "host": ["extension-storage"],
    "surface": ["notifications"]
  },
  "storage": { "schemaVersion": 1 },
  "integrates": { "piPackages": ["pi-observational-memory"] }
}
```

The parser in `@piarium/extension-contract` is the runtime authority. The published schema supplies
editor completion and diagnostics. npm, Git, local directories, and built-in distributions all
resolve the same manifest; a source string or display name is never extension identity.

Manifest IDs, entrypoint IDs, contribution IDs, and service IDs use lowercase namespaced identifiers.
Contribution IDs must be qualified by the extension ID. Entrypoint files are forward-slash relative
paths and cannot escape the package.

`integrates.piPackages` is discovery/navigation metadata only. It does not grant access to a Pi
package and does not couple either lifecycle.

## Execution modes

An extension can declare any combination of Host and Surface entrypoints.

### Surface modes

- `declarative`: data-only contributions from the manifest; no extension JavaScript executes.
- `managed`: a framework-neutral bundle runs in the Surface realm. Piarium tracks SDK registrations,
  while raw browser effects must register a disposer.
- `isolated`: an application-host-materialized IIFE runs in a sandboxed iframe or Worker and
  communicates through a versioned MessagePort. Realm destruction provides physical unload. Authors
  publish an ordinary browser module; the application host creates the final realm bundle once.
- `native`: explicitly trusted same-realm code. Piarium withdraws tracked effects, but cleanup failure
  truthfully becomes `restart-required`.

### Host modes

- `brokered`: runs in a supervisor-owned Node process and uses capability/service/storage RPC. The
  process boundary isolates crashes and lifecycle, but it is not an operating-system sandbox.
- `native`: explicitly trusted application-host code for operations that genuinely require ambient
  host access. Updates take effect after host restart and cleanup remains cooperative.

Capability grants are recorded per manifest version and realm. A first installation that requests
capabilities remains disabled until every request has an explicit allow/deny decision. A candidate
that asks for a new capability cannot activate until every added capability has a decision. Completing
review does not execute code; update application is a separate explicit action.

`workspace.documents` is a Host capability for revisioned, resource-scoped document access. Use
`callWorkspaceDocuments` from `@piarium/extension-sdk`. Reads distinguish missing, empty, binary,
undecodable, and failed results. Watch events carry metadata only and never include file bodies.

## Managed Surface entrypoint

```ts
import { defineSurfaceExtension, defineSurfaceMount } from "@piarium/extension-sdk"

export default defineSurfaceExtension((context) => {
  context.contribute({
    contractVersion: 1,
    data: {},
    id: "dev.example.my-extension.page",
    kind: "page",
    supports: ["desktop", "mobile", "vscode", "web"],
    title: "My Page",
  }, defineSurfaceMount((container, mount) => {
    container.textContent = String(mount.props.title ?? "My Page")
    return () => { container.textContent = "" }
  }))

  context.onDispose(() => stopExternalBrowserEffect())
})
```

SDK contribution, service, asset, style, and lifecycle registrations belong to the current owner
generation. Activation stages them and publishes them atomically. Disable or update withdraws them
before reverse-order cleanup. A late completion from an old generation cannot publish into the new
one.

Raw timers, listeners, framework roots, browser objects, or external effects created outside an SDK
helper remain the author's responsibility. Register their cleanup with the Surface lifecycle or the
returned activation disposer.

`defineSurfaceMount` is the public rendering boundary. Piarium supplies the actual `HTMLElement`,
current contribution props, owner generation, a mount-scoped `AbortSignal`, and `reportError`. The
extension owns everything it creates inside that container, including a framework root, and returns a
sync or async disposer. Piarium aborts and disposes the mounted instance exactly once when props or
owner generation change, the contribution is withdrawn, or the extension is disabled. The optional
React adapter implements this contract with an extension-owned React root; it does not share the
workbench's React singleton.

### Activation events

Manifest contributions are indexed without loading executable code. An executable entrypoint with no
activation list, `application-startup`, or `background` starts eagerly. Entrypoints declaring
`command`, `contribution-visible`, `workspace-match`, or `service-request` stay inactive until that
actual event occurs. The declared contribution remains visible while its executable implementation is
inactive. Disabling clears the trigger latch, so re-enabling does not silently reuse a prior event.

## Isolated Surface entrypoint

```ts
import { defineIsolatedExtension } from "@piarium/extension-sdk"

export default defineIsolatedExtension((context) => {
  context.contribute({
    contractVersion: 1,
    data: {},
    id: "dev.example.my-extension.isolated-page",
    kind: "page",
    supports: ["web"],
  })

  if (context.capabilities.has("notifications")) {
    void context.capabilities.call("notifications", "show", { message: "Ready" })
  }
})
```

Isolated code has no ambient Piarium object graph. Assets, services, and privileged operations use the
provided clients. Ambient network entrypoints are unavailable in the standard isolated realm; request
a concrete capability when network access is part of the extension contract.

## Brokered Host entrypoint

```ts
import { defineHostExtension } from "@piarium/extension-sdk"

export default defineHostExtension(async (context) => {
  context.services.provide(
    { id: "dev.example.my-service", version: 1, multiple: true },
    { read: () => context.storage.snapshot.document.data },
  )

  await context.storage.update(
    { started: true },
    context.storage.snapshot.document.revision,
  )

  context.effect(() => stopOwnedHostResource())
})
```

Host storage is extension-namespaced, revision checked, and authoritative at the application host.
Use the snapshot revision for every update. Missing, ready, and stale storage states are distinct.

New code can open independent documents with
`await context.storage.open({ scope, key, schemaVersion? })`. Supported scopes are `application`,
`profile`, `workspace`, `surface`, and `session`; arbitrary keys let one extension separate unrelated
state without inventing one product-wide schema. Every document has its own revision and update
stream. Piarium injects the current extension ID, so the request cannot address another extension's
namespace. `context.storage.snapshot` and `update` remain the `application/state` compatibility
document.

If the manifest storage schema version changes, export `migrate({ data, fromSchemaVersion,
toSchemaVersion })`. Candidate migration is staged with activation; failed candidate activation keeps
the selected generation and selected storage state.

Required services control activation and dependency-safe teardown. Optional services do not block
activation. Multi-provider services publish stable `providerKey` identities; invocation resolves the
latest provider generation through application-host routing. Extensions do not inspect or prioritize
one another.

## Build mapping

The manifest names published artifacts. `package.json` can map each entrypoint ID to source:

```json
{
  "piarium": {
    "build": {
      "entrypoints": {
        "host": { "source": "src/host.ts" },
        "dev.example.my-extension.main": { "source": "src/surface.ts" }
      }
    }
  }
}
```

`piarium-extension build` bundles Host code for Node 22 and Surface modules for ES2022 browsers. It
writes exactly the manifest paths and never runs package lifecycle scripts. Installation later
materializes immutable, content-addressed artifacts, verifies their integrity, and converts an
isolated module into the one final IIFE owned by its iframe/Worker realm.

The output format follows the target extension (`.cjs` or `.mjs`) and otherwise `package.json`'s
`type`. In a `"type": "module"` package, use a `.cjs` manifest target when the published entrypoint
must be CommonJS.

Files listed by `package.json.files` alongside `dist` remain package assets. The generated language
and debug templates publish their runnable starter adapter under `runtime/` and resolve it with the
Host asset API. The generated Node test template uses `kind: "node-test"`, so it needs no extra process.

## Check and test

```sh
piarium-extension check
piarium-extension build
piarium-extension test
```

`check` validates the contract, version agreement, path containment, and published entrypoint files.
`test` rebuilds and executes the public conformance harnesses:

- managed/native Surface activation, committed contribution/service state, deactivation, and leak
  detection;
- isolated module activation, contributions, and reverse-order cleanup;
- brokered Host activation, revisioned storage, service registration, abort, and cleanup with no
  privileged capability implementations.

Extensions can call the same harnesses directly from `@piarium/extension-sdk/testing` for richer
fixtures. These are contract tests, not a substitute for browser tests of the extension's own UI.

All four author commands accept `--quiet` for a stable compact result or `--json` for a single JSON
success/error value. These modes run the same validation and lifecycle checks as human output and keep
non-zero exit codes on failure.

## Install and development workflow

Open **Settings → Piarium Extensions → Install or update** and choose npm, Git, or local folder. The
specifier is passed to the application-host package source resolver; the UI does not maintain an
allowlist. For a local folder, the application host reads the real project directory and builds a new
immutable content-addressed artifact without copying or modifying the working tree. If `package.json`
declares dependencies, install them in the project first; Piarium never runs `npm install` in a local
extension project.

An installed local extension has a **Reload local directory** action. Reload resolves the complete
source identity already stored in the application-host catalog, so the UI neither receives nor
resubmits the hidden path specifier. Unchanged content is a no-op. Changed content with no new
capability request is applied to the current Surface through the normal candidate transaction; a
failed candidate keeps the selected artifact and active generation. A candidate that adds a
capability is only staged for review and still requires the explicit **Apply update** action afterward.

An extension without requested capabilities is enabled on first installation. An extension that
requests Host or Surface capabilities is installed disabled; decide every request in its card, then
enable it with the ordinary lifecycle switch. A denial is still a completed decision—the extension
may activate with only the capabilities actually granted and must handle their absence.

The application host owns installation and execution. Switching the active Pi runtime does not move
or reinstall Piarium extensions. Web/cloud and Electron-hosted Web use the server application host;
VS Code uses its extension host and global storage. A Surface reports unsupported/waiting state when
an entrypoint or capability is unavailable there instead of disabling compatible Surfaces.

An external source cannot stage a candidate over a distribution-owned built-in ID. Built-ins are
updated by the Piarium distribution; authors provide an alternative extension/contribution ID and let
the user select that replacement explicitly.

## Candidate updates

Installing a source whose manifest ID already exists stages a candidate rather than overwriting the
selected version.

1. The host validates the manifest, engine range, artifacts, integrity, and capability delta.
2. Added capabilities receive explicit decisions in the Extensions page.
3. **Apply update** persists application intent, stages Host and all compatible entrypoints in the
   initiating Surface, and selects the candidate only after staging and validation succeed.
4. **Discard update** removes the candidate record and its prepared generation.

Failure preserves the selected artifact, desired state, active generation, storage, and layout.
Immutable content-addressed files may remain in the application-host cache; they are not active or
selected extension records.

Review completion never applies an update by itself. A trusted-native Host update records the apply
request and reports `restart-required`; the application host completes that already-requested update
on restart. Staged or merely reviewed native candidates do not move on restart.

## Inspector and diagnostics

The Extension Inspector uses public host and Surface state. It shows:

- selected version/source/integrity and candidate artifact facts;
- Host and Surface owner realms, generation, current status, update timestamp, and cleanup generation;
- manifest and live dynamic contributions, including slot placement and replacement targets;
- the active Shell contribution and whether the inspected extension owns it;
- document, language, debug, and test service ownership from granted capabilities and live Host providers;
- live Host and Surface service providers;
- required services and companion Pi-package metadata;
- capability decisions and extension-attributed catalog/runtime diagnostics.

Diagnostics remain attributed to extension, entrypoint, realm, and generation. The Inspector does
not scrape private plugin databases, package working trees, credentials, or Pi session content.

## Disable, remove, and retained data

The switch changes desired enablement and reconciles Host/Surface generations without refreshing the
document. Installed, enabled, and active remain separate facts. Disabling preserves extension storage,
layout references, service routing rules, and package artifacts.

Remove first deactivates the extension and then deletes its catalog installation record. Built-in
distribution extensions cannot be removed through this action; they can be disabled or omitted by a
distribution. The removal dialog makes the data choice explicit: **retain data** is the default, while
**delete extension data** removes only that extension's validated Piarium storage namespace after the
catalog record is removed. Neither choice deletes project files, Pi package data, plugin-native data,
workspace files, or shared artifact-cache material.

## Workbench distribution profiles

Workbench profiles can store both layout/replacement selections and an explicit `extensionIds` set.
Editing the set does not silently change lifecycle. **Apply set** performs one revision-checked catalog
mutation and reconciles the result. Missing extension IDs remain profile references so reinstalling a
package can restore the intended distribution.

The Extensions page supports creating, selecting, applying, and removing profiles. User and workspace
layout selection remains separate from application-host desired extension state; this avoids a hidden
global enable/disable when one window changes its workspace layout.

## Optional discovery catalogs

`@piarium/extension-contract` exports `parsePiariumExtensionDiscoveryDocument` and the
`@piarium/extension-contract/schema/discovery` JSON schema. A discovery document contains presentation
metadata plus a complete npm, Git, local, or built-in source specifier. A catalog entry is a shortcut
that fills an ordinary install request. It is never an allowlist and grants no capability or trust.

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "dev.example.my-extension",
      "displayName": "My Extension",
      "description": "A custom workspace extension",
      "source": {
        "kind": "npm",
        "display": "@example/piarium-my-extension",
        "specifier": "npm:@example/piarium-my-extension"
      }
    }
  ]
}
```

Catalogs are optional metadata distribution. Direct npm, Git, and local installation remains a
first-class workflow even when no catalog contains the extension.

## Publishing checklist

1. Keep `package.json` and manifest versions equal.
2. Declare only capabilities the entrypoints actually call.
3. Bundle framework dependencies; do not rely on Piarium's React or internal packages.
4. Include `piarium.extension.json`, built entrypoints, styles, and referenced assets in the package.
5. Run `piarium-extension test` and the extension's own UI/integration tests.
6. Install the resulting npm/Git/local source in a clean Piarium application host and inspect every
   supported Surface.
7. Stage an update and verify both apply and discard behavior before publishing it as the default.

Piarium's complete lifecycle, trust, data-ownership, contribution, workbench, and routing architecture
is recorded in [piarium-extension-platform.md](piarium-extension-platform.md).

## Piarium public tooling releases

Piarium maintainers publish the five public authoring packages as one exact-version set:
`extension-contract`, `extension-surface`, `extension-sdk`, `extension-react`, and `extension-cli`.
Prepare the next version with:

```sh
bun run release:npm:prepare 0.1.1
```

This updates all five manifests and their exact internal dependency versions, then refreshes the Bun
lockfile. Review and commit those changes on `main`. Pushing the matching dedicated tag starts the
release:

```sh
git tag -a npm-v0.1.1 -m "Publish Piarium npm tooling 0.1.1"
git push origin npm-v0.1.1
```

`.github/workflows/npm-publish.yml` accepts only `npm-v*` tags whose source commit is already on
`main`. It tests and builds the public packages, packs the exact tarballs, installs and exercises them
in a disposable project, preserves the artifacts in GitHub Actions, and publishes in dependency
order. A rerun skips a version only when npm reports the same immutable integrity; an existing version
with different bytes fails closed.

The workflow uses npm Trusted Publishing with GitHub OIDC. It has no `NPM_TOKEN`, browser approval, or
GitHub Environment gate. Each package trusts repository `Youzini-afk/Piarium`, workflow filename
`npm-publish.yml`, no environment claim, and the `npm publish` action. GitHub obtains a short-lived
credential for each run, and npm attaches provenance automatically.
