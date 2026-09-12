# Rust kernel dependency notices

The kernel is distributed with the dependency graph locked in `Cargo.lock`. The direct dependencies
used by the private executable are distributed under their upstream permissive licenses:

- `rusqlite` / `libsqlite3-sys` — MIT; SQLite itself is public domain.
- `serde`, `serde_json`, `thiserror`, `uuid`, `sha2`, `hex`, and `base64` — MIT or Apache-2.0.

The complete transitive source and license metadata remain available from crates.io using the exact
versions in `Cargo.lock`; release automation must include this notice beside the staged executable.
