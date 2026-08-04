# @piarium/web

Piarium's browser, remote, and trusted server runtime.

This package serves the shared Piarium UI and owns the Web-side platform services. Conversation and
agent execution are provided by the bundled Pi runtime workspace:

```text
@piarium/web
  -> @piarium/runtime-broker
     -> @piarium/pi-host
        -> @piarium/protocol
```

The four packages are one release unit. Publishing or installing the Web tarball by itself is not a
supported deployment path because it would omit the private broker, host, protocol, and their package
exports.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun run dev:web:full
```

Or build and start the production-like server:

```bash
node scripts/build-cloud-runtime.mjs --install --no-archive
node artifacts/cloud-runtime/packages/web/bin/cli.js serve --foreground
```

The canonical cloud builder compiles the Pi host/broker and Web UI, creates a production lockfile,
and preserves the workspace layout required by `resolveBundledPiHostEntry()`.

## Cloud and remote deployment

Use the Piarium container images, Docker Compose, or the atomic SSH deployment helper. Image names,
persistent paths, environment variables, remote configuration, health validation, and rollback
behavior are documented in [Cloud deployment](../../docs/cloud-deployment.md).

## Runtime data

Set `PIARIUM_DATA_DIR` to choose the persistent data root. The Linux default is
`~/.config/piarium`. It contains settings, runtime registry files, authentication keys, remote
clients, pairing state, notifications, and tunnel state; it must remain outside immutable release
directories.

Binding beyond loopback requires `PIARIUM_UI_PASSWORD`. Tunnel tokens and passwords are runtime-only
configuration and must not be placed in package archives or build arguments.

## License

MIT
