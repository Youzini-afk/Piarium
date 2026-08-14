# @piarium/extension-sdk

Framework-neutral authoring API for managed, isolated, and brokered-Host Piarium extensions.
Extensions export an `activate` function or use `defineSurfaceExtension`, `defineIsolatedExtension`,
or `defineHostExtension`. Activation contexts own contributions, services, disposers, authenticated
assets, styles, revisioned storage, and capability clients without importing Piarium's product UI.

`@piarium/extension-sdk/testing` exports managed Surface, isolated Surface, and Host conformance
harnesses with real owner cleanup semantics. See the complete
[authoring guide](https://github.com/Youzini-afk/Piarium/blob/main/docs/piarium-extension-authoring.md).
