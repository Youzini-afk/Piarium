# Piarium Rust system kernel

This workspace contains the private kernel executable used by each Application Host. It is not a
public server and it does not expose a TCP port. The Host starts `piarium-kernel` with stdin/stdout
framed JSON (`u32` big-endian length followed by one UTF-8 JSON envelope); stderr is diagnostics only.

The wire source is [`protocol/schema.json`](protocol/schema.json). TypeScript DTOs used by the Host
client are generated at `packages/web/application-host/lib/kernel/protocol.generated.ts` and checked by
`bun run kernel:protocol`.

Build locally with:

```text
cargo check --manifest-path kernel/Cargo.toml
cargo build --manifest-path kernel/Cargo.toml --release --bin piarium-kernel
```

Release packaging must copy the resulting executable outside an Electron `app.asar` archive and set
`PIARIUM_KERNEL_PATH` (or use the release layout resolver). The kernel acquires an owner file in its
storage root, rejects a second writer, and leaves a corrupt/future catalog as an error rather than an
empty store.

R1 storage commands are domain operations: durable content-object installation, immutable trie roots,
write-revision CAS, published revisions, pins, idempotent operation IDs, recovery records, and GC.

R2 adds a scoped file-resource domain rather than a generic filesystem escape hatch. The Host registers a
Documents-authorized canonical root; the kernel owns exact/subtree overlap leases, typed file capture,
conditional apply, mkdir/remove/rename, and restart reconciliation for started filesystem operations. Regular-file
capture/apply reuses the kernel content-object store. Production Documents/Files/Recovery/Integration and Harness
`fs.lock` share this authority. Registry buffers remain outside Rust, and R3 still owns baseline/materialization.
There is no arbitrary SQL or arbitrary filesystem-write method on the wire.
