# @piarium/extension-host

Trusted application-host ownership for the Piarium extension catalog.

The host stores manifests, installation records, desired state, capability grants, application-host
identity, and truthful diagnostics. It materializes npm, Git, local-directory, and registered built-in
sources without lifecycle scripts; managed Surface entrypoints are bundled into immutable SHA-256
artifacts. Selected and candidate versions remain separate until a Surface activation transaction
successfully selects the candidate with a catalog revision precondition.

Published extensions can point a managed entrypoint at a self-contained `.cjs` browser bundle; it is
copied verbatim and works in hosts that intentionally do not ship a source compiler. Other supported
source entrypoints are bundled by the application host with esbuild.

The host serves verified artifact bytes through authenticated Runtime API operations. Public catalog
responses never expose source specifiers or resolved filesystem paths, and asset responses never put
credentials in module or resource URLs. Brokered and explicitly trusted-native Host entrypoints use
generation-scoped lifecycle ownership, versioned services, revisioned storage, candidate rollback,
and persisted multi-scope service routing.

Distribution-owned Host extensions use the same immutable artifact and broker lifecycle as installed
extensions. Their requested Host capabilities are granted only while reconciling the distribution
definition; executable artifacts are materialized lazily when their activation event is first requested,
so declarative built-ins do not add startup I/O.
