# @piarium/extension-surface

Framework-neutral Surface lifecycle foundation for Piarium extensions.

Activations stage contributions, services, and cleanup ownership before one atomic commit. Failed or
superseded generations roll back without becoming visible. Deactivation withdraws visible records
before running reverse-order cleanup. The registry also resolves explicit replacements, selected or
multiple service providers, ordered contributions, and retained layout references for contributions
that are temporarily absent. Actual state remains attributed to extension, entrypoint, realm, and
generation. This package does not import React or load external bundles.
