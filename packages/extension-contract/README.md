# @piarium/extension-contract

Browser-safe, versioned data contracts shared by Piarium application hosts and surfaces.

This package describes Piarium extensions. It does not describe or load Pi packages, and it does
not contain an extension runtime. Extension packages publish a standalone
`piarium.extension.json`; npm, Git, local-directory, and built-in sources all resolve to that same
manifest contract.

The same contract validates selected and staged candidate artifacts, selected/candidate capability
decisions, a separate persistent candidate-application request, content-addressed asset and
managed-entrypoint payloads, revision-checked candidate selection, and per-realm actual state. Public
catalog DTOs expose source identity and integrity without exposing source specifiers or host paths.

Multi-provider Host services expose a stable `providerKey` separately from their generation-bound
`providerId`. Revisioned routing rules can select a provider from distribution through invocation
scope; the application host performs resolution and reports ambiguity or unavailable selections
without teaching a renderer to merge policy.

The package publishes editor schemas at `@piarium/extension-contract/schema/manifest` and
`@piarium/extension-contract/schema/discovery`. Discovery documents contain ordinary npm, Git, local,
or built-in source specifiers and remain optional installation shortcuts rather than an allowlist.

Stable workbench replacement targets and contribution slots, including `view` and `editor` kinds,
live in this package. Application surfaces import those constants; they must not keep a second
string table. The distribution Agent profile keeps the stable ID `default` and the English fallback
label `Agent`; official UI localizes that name. Its default `workbench.shell` contribution is
`piarium.builtin.agent-workspace.shell`. The optional IDE profile uses the stable ID `piarium.ide`
and `piarium.builtin.ide-workbench.shell` on web and desktop only. Selecting a profile does not
enable or disable extensions.

See the complete [authoring guide](https://github.com/Youzini-afk/Piarium/blob/main/docs/piarium-extension-authoring.md).
