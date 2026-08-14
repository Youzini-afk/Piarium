# @piarium/extension-sdk

Framework-neutral authoring API for managed Piarium Surface extensions. Extensions export an
`activate` function or use `defineSurfaceExtension`; the activation context owns contributions,
services, disposers, authenticated assets, and styles. `@piarium/extension-sdk/testing` supplies the
same lifecycle conformance harness used by Piarium.
