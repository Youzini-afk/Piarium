# Piarium Desktop

Electron desktop runtime for Piarium on macOS, Windows, and Linux.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and Piarium server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How It Runs

Desktop starts the Piarium web server in the same Electron main process. There is no separate sidecar subprocess for the Piarium server.

`main.mjs` imports `@piarium/web/server/index.js` and calls `startWebUiServer()`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

Same-origin session-chat iframes complete an authenticated parent-frame handshake before creating their SDK client. The parent supplies its active in-memory endpoint and credentials; when relay is active it also supplies the public relay descriptor without any pairing grant, because Electron preload and IPC are unavailable inside the iframe. The iframe establishes its own transport and rebinds its SDK before rendering. Additional windows retain their own per-window runtime bootstrap instead of being overwritten by the main window. Credentials are never placed in iframe URLs, and other child pages do not receive this runtime state.

The preload bridge exposes desktop-only APIs to the web UI through `window.__PIARIUM_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI.

## Main Files

| File | Purpose |
|------|---------|
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `startup-url-selection.mjs` | Pure bundled/HMR startup probe policy used by main-process URL resolution |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `pi-runtime.mjs` | Resolves and starts the packaged Pi host through Electron's Node mode |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/main.mjs` for packaging |
| `scripts/rebuild-native.mjs` | Rebuilds native modules against the Electron runtime |
| `scripts/package.mjs` | Runs `electron-builder`; release automation can explicitly select unsigned Windows or macOS packaging |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

## Development

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/main.mjs`.

The Electron workspace package trusts Electron's install script so `bun install` downloads the platform runtime in fresh checkouts and worktrees.

`postinstall` verifies that Electron's package, downloaded runtime, version, and native architecture agree. An interrupted or script-skipped install is repaired automatically; `electron:dev` performs the same check before starting any development servers.

Useful variants:

```bash
bun run electron:dev:bundled
bun run type-check:electron
bun run lint:electron
```

`electron:dev:bundled` builds and uses packaged web assets instead of the HMR server. Use it when testing behavior closer to a packaged app.

## Packaging

From the repo root:

```bash
bun run electron:build
```

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `prepare:pi-runtime` to compile the Pi host bootstrap and runtime broker.
3. `bundle:main` to create `packages/electron/dist-bundle/main.mjs`.
4. `rebuild:native` to verify the bundled N-API `better-sqlite3` binary and the published Windows
   `node-pty` prebuild under Electron's Node ABI.
5. `package.mjs` to run `electron-builder`; its `afterPack` hook stages the target `better-sqlite3`
   binary, removes its other-platform/build-only files, and removes the duplicate dependency copy of
   the already staged Web UI.

Build output goes to `packages/electron/dist`.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

For a local or CI Windows x64 NSIS build, run from the repo root:

```bash
bun run electron:build:win
```

This is equivalent to running `bun run --cwd packages/electron package:win:x64` and produces `packages/electron/dist/*.exe`, `*.blockmap`, and `latest.yml`.

Release ARM64 packages run natively on GitHub's `windows-11-arm` runner. The workflow sets
`PIARIUM_TARGET_ARCH=arm64`, packages with `--win --arm64`, executes the unpacked ARM64 application,
and publishes `latest-arm64.yml` beside the architecture-specific installer and blockmap.

After packaging, verify the unpacked application, external-runtime discovery state, health endpoint,
renderer app-ready signal/error boundary, and a real `node-pty` terminal create/close cycle without
installing it. The smoke must cover both the no-runtime onboarding state and a selected Pi runtime;
merely finding the compiled Piarium Host is not proof that the selected Pi installation can load:

```bash
bun run electron:smoke:win
```

Set `PIARIUM_SMOKE_PROFILE_SOURCE` to a packaged Piarium user-data directory to seed the isolated
smoke profile with Piarium settings plus Chromium Local/Session Storage. The source profile is never
launched or modified.

## Platform Notes

macOS packages must be built on the matching native Intel or Apple Silicon runner. The public release
workflow currently produces unsigned `dmg` and `zip` assets by explicitly disabling identity discovery,
hardened runtime, DMG signing, and notarization. A future signed distribution can supply Apple signing
credentials and restore those production signing options without changing the application payload.

Windows packaging uses `electron-builder` with the NSIS target. For reliable native module rebuilds and NSIS installer creation, run Windows builds on a Windows runner or host. The default x64 path uses `node-pty`'s published N-API prebuild and therefore does not require Visual Studio's optional Spectre libraries; set `PIARIUM_REBUILD_NODE_PTY_FROM_SOURCE=1` only when intentionally testing its C++ source build. If no Windows signing environment is present, `package.mjs` intentionally disables code signing and produces an unsigned installer.

### Code Signing

Windows code signing is optional. If signing credentials are present, `package.mjs` uses the standard `electron-builder` signing environment variables:

- `CSC_LINK` / `CSC_KEY_PASSWORD`
- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`

For compatibility with earlier Piarium automation, `package.mjs` also maps `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` to the standard `WIN_CSC_*` names when the standard variables are not set.

When these variables are absent, the build falls back to an unsigned NSIS installer.

### Smoke Builds

Run the `Windows Desktop Build` workflow on demand for a focused Windows x64, ARM64, or dual-architecture
build. For a release, run `Desktop Release Build` against an existing version tag. It builds and smokes
Windows x64/ARM64, Linux x64/ARM64, and macOS Intel/Apple Silicon on matching native GitHub runners,
assembles the architecture-specific updater channels, and can upload only the verified assets to an
existing draft GitHub Release. Publishing the draft remains a separate deliberate action.

The Linux and macOS smoke path starts the unpacked packaged application, waits for the renderer's
`__piariumAppReady` signal, rejects the React error boundary, checks `/health`, and creates and closes a
real terminal. Linux additionally verifies the AppImage, Electron executable, desktop identity, and
packaged native module architecture. macOS checks the application executable and packaged `.node`
modules before launch.

Windows updates use `latest.yml` for x64 and the `latest-arm64.yml` channel for ARM64 so each installation resolves an architecture-matching installer.

Linux AppImages must be built natively. Set `PIARIUM_TARGET_ARCH=x64` or `PIARIUM_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the native Electron rebuild and Electron Builder architecture. Linux identity is stable across architectures: executable `piarium`, desktop file `piarium.desktop`, icon `piarium`, and `StartupWMClass=piarium`.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Linux updates are supported only when the packaged app is running from a writable AppImage. Update checks, downloads, and installation report an actionable error when `APPIMAGE` is missing, invalid, or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. macOS and Windows updater behavior is unchanged. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate and validate each manifest against its AppImage before upload. Linux AppImages download full updates (no `.blockmap` differential channel yet).

macOS release jobs retain each native builder manifest until the final assembly job. That job verifies
every referenced `zip`/`dmg` checksum and merges Intel and Apple Silicon entries into one
`latest-mac.yml`, so both architectures use the standard Electron updater channel without overwriting
one another.

### Updater End-to-End Fixture

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](./scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls, auto-update, system tray (right-click Show / Hide / Close), and launch-at-login (XDG autostart). Opening files in installed apps, installed-app discovery, and FreeDesktop icon lookup (including the default file manager) work on macOS, Windows, and Linux.

The macOS menu bar item is enabled by default and can be disabled in General settings. The setting applies after restart; while disabled, Desktop does not create the native tray controller or start the renderer subscriptions, polling, quota refresh, or IPC updates that feed it.

## Pi Runtime

Packaged Desktop builds include Piarium's compiled Host bootstrap and runtime broker, but runtime
execution no longer binds to a permanently bundled copy of the three Pi SDK packages. The Runtime
Manager discovers a user-level Pi installation, verifies its package root and Node executable, and
accepts it only after the Host handshake succeeds. Onboarding and Settings may select, install, or
upgrade that installation; a newer Pi is retained, and no downgrade or silent upgrade is performed.

Electron's executable provides Node mode for the Piarium Host process, so running the desktop shell
does not require a separately installed Node runtime. Pi remains an independent user-level tool and
can still be used by the Pi CLI outside Piarium. Cloud and VS Code distributions deliberately keep a
pinned Pi runtime because their unattended/isolated hosts have different reproducibility needs.

The official ordinary installer still has to prove that its final dependency inventory contains no
unused Pi SDK copy; the optional offline distribution may instead carry an explicitly verified
standalone installation payload. The production dependencies that normal Node workers do require
remain unpacked for filesystem module resolution. Chromium locale files are limited to Piarium's
supported interface languages.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `PIARIUM_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `PIARIUM_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `PIARIUM_SKIP_LOCAL_SERVER=1` | Skips the in-process local Piarium server and uses the configured default remote instance; Desktop imports this from the user's login-shell environment, and packaged/bundled UI remains available for connection recovery |
| `PIARIUM_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `PIARIUM_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `PIARIUM_RUNTIME=desktop` | Set by Electron before starting the web server |
| `PIARIUM_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `PIARIUM_REBUILD_NODE_PTY_FROM_SOURCE=1` | Opts Windows packaging into the `node-pty` C++ source build instead of its verified published prebuild |
| `PIARIUM_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `PIARIUM_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `PIARIUM_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in Desktop/server logs; disabled by default |

## Native Features Owned Here

- Floating Mini Chat windows.
- Multiple native windows.
- Native notifications.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding.
- SSH uses OpenSSH ControlMaster on macOS/Linux. Windows uses independent hidden OpenSSH processes for setup commands and each long-lived forward because Win32 OpenSSH does not support ControlMaster reliably.
- Tunnel lifecycle integration through the web server runtime.
- Auto-update checks, downloads, and restart/apply flow.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `piarium:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Logs And Data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. In packaged apps, logs are written through the platform log path for the `Piarium` app name.

Development builds use a separate user data directory named `Piarium Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Pi runtime behavior belongs in the host/broker packages.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@piarium/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup.
- Rebuild `better-sqlite3` and re-run the Electron-backed `node-pty` prebuild check after dependency or Electron version changes.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick Checks

```bash
bun run type-check:electron
bun run lint:electron
bun run electron:dev:bundled
```

For full repo validation before shipping:

```bash
bun run type-check
bun run lint
```
