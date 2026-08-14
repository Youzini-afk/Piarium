# @piarium/extension-cli

`@piarium/extension-cli` is the publishable author tool for Piarium extensions. It works with the
public `piarium.extension.json` contract and the framework-neutral `@piarium/extension-sdk`; it does
not require the Piarium monorepo or any Pi package.

## Commands

```sh
piarium-extension init ./my-extension --id dev.example.my-extension --name "My Extension"
piarium-extension check ./my-extension
piarium-extension build ./my-extension
piarium-extension test ./my-extension
```

`init` is non-interactive. Both `--id` and `--name` are required, and an existing non-empty target is
never overwritten. The generated project contains a public manifest, package metadata, TypeScript
configuration, a managed Surface entrypoint, and author documentation.

`check` parses the manifest with `@piarium/extension-contract`, checks that the manifest version and
`package.json` version agree, and checks every declared Host or executable Surface file. Errors name
the failing path and the next useful action.

`build` bundles each declared executable entrypoint with esbuild. Host entrypoints use the Node 22
platform; Surface entrypoints use the browser platform. The manifest `file` remains the exact output
path. The optional `package.json` `piarium.build.entrypoints` map supplies a source path when the
manifest path is a published output path. Output format follows `.cjs`/`.mjs` and otherwise the
package `type`, so published JavaScript keeps its declared module semantics. No package lifecycle
script is run.

`test` checks and builds the project, then validates declarative, managed, native, and isolated
Surface lifecycle behavior. Managed/native modules run through `runSurfaceExtensionConformance`;
isolated modules run through `runIsolatedExtensionConformance`; brokered Host modules run through `runHostExtensionConformance`
with revisioned storage and no privileged capabilities. These public harnesses are also available
from `@piarium/extension-sdk/testing` for an extension's own test suite.

The complete manifest, lifecycle, update, distribution-profile, and publishing workflow is in the
[Piarium extension authoring guide](https://github.com/Youzini-afk/Piarium/blob/main/docs/piarium-extension-authoring.md).
