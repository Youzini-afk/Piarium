# @piarium/extension-surface

Framework-neutral Surface lifecycle foundation for Piarium extensions.

Activations stage contributions, services, and cleanup ownership before one atomic commit. Failed or
superseded generations roll back without becoming visible. Deactivation withdraws visible records
before running reverse-order cleanup. The registry also resolves explicit replacements, selected or
multiple service providers, ordered contributions, and retained layout references for contributions
that are temporarily absent. Actual state remains attributed to extension, entrypoint, realm, and
generation. This package does not import React or load external bundles.

Most extension authors use `@piarium/extension-sdk`; this lower-level package is public for alternate
Surface hosts and advanced lifecycle tests. See the
[authoring guide](https://github.com/Youzini-afk/Piarium/blob/main/docs/piarium-extension-authoring.md).

An injected `SurfaceExternalService` may carry a disposer. The runtime attaches it to the consumer
owner scope, so candidate rollback, generation replacement, and disable clean up the exact service
instance that was created for that owner. Optional requirements remain non-blocking when no external
service is available.
