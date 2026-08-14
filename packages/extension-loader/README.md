# @piarium/extension-loader

Surface-side loader for authenticated, content-addressed managed extension artifacts. It verifies
every received byte, evaluates self-contained browser bundles without credential-bearing module URLs,
stages styles and object URLs under the owner scope, activates all compatible entrypoints as one
transaction, and selects a staged catalog candidate only after activation validation succeeds.
