# @piarium/extension-loader

Surface-side lifecycle loader for external declarative, managed, isolated, and trusted-native
extensions. Manifest contributions use a public data-only implementation and require no asset or
module read. Executable entrypoints with no activation event, `application-startup`, or `background`
start eagerly. `command`, `contribution-visible`, `workspace-match`, and `service-request` entrypoints
remain inactive until the matching real event is sent through `triggerActivation`; manifest data stays
visible in the meantime without executing extension code.

Activation and candidate replacement remain Surface transactions. A triggered entrypoint replaces its
declarative implementation with the dynamic generation atomically, preserves declarations the module
does not override, and keeps the selected generation when candidate activation fails. Disable clears
the event latch, withdraws every owner, and requires a fresh event after re-enable.

Executable artifacts remain authenticated and content addressed. The loader verifies every received
byte, evaluates self-contained browser bundles without credential-bearing module URLs, and owns
styles, object URLs, isolated realms, capability bindings, service requirements, actual state, and
generation-safe cleanup across disable, host switch, update, and rollback.

Surface hosts can inject `externalServiceFactories`. Each factory declares one service descriptor and
creates an instance from the loader-supplied consumer `SurfaceOwnerIdentity`; extension code cannot
submit its own owner. Returned disposers transfer to the activation owner scope. Host service proxies
keep their existing application-host routing, while managed and isolated entrypoints can call a
Surface-local service's serializable methods through the same declared requirement. A missing optional
factory never blocks activation.
