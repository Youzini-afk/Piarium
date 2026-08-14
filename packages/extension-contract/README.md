# @piarium/extension-contract

Browser-safe, versioned data contracts shared by Piarium application hosts and surfaces.

This package describes Piarium extensions. It does not describe or load Pi packages, and it does
not contain an extension runtime. Extension packages publish a standalone
`piarium.extension.json`; npm, Git, local-directory, and built-in sources all resolve to that same
manifest contract.
