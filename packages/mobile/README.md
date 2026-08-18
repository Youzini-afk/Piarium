# Piarium Mobile

Capacitor shell for the dedicated Piarium mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

The native product identity is Piarium-owned:

- app/package ID: `dev.piarium.mobile`;
- iOS App Group: `group.dev.piarium.mobile`;
- widget extension: `dev.piarium.mobile.widget`;
- notification service: `dev.piarium.mobile.notification-service`;
- deep-link scheme: `piarium://`.

These identifiers intentionally do not accept the unreleased inherited OpenChamber identity as a
compatibility alias.

## Runtime Model

- The native app bundles the mobile UI only; it does not embed the Piarium web server or Pi runtime.
- On first launch in Capacitor, the app shows a connection screen for an existing Piarium server.
- Connections are saved locally in the app and can be managed from the mobile overflow menu under `Instances`.
- The connection screen and `Instances` menu item are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected Piarium servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- `piarium://` connection/session links open the native app on Android and iOS. Android declares a
  browsable intent filter; iOS declares the same scheme for the app and bundled widgets.
- The Terminal workspace surface runs its PTY on the active Piarium server over the shared authenticated runtime transport; it never opens a local shell on the phone or tablet. Closing the surface detaches the renderer while the server session remains available for reattachment. On touch devices, dragging scrolls the buffer while long-pressing and dragging selects terminal text.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run build:assets`: prepares mobile assets from an existing `packages/web/dist` build; the root workspace build uses this to avoid rebuilding web.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK without launching an emulator.
- `bun run build:ios:simulator`: builds an iOS Simulator app without launching Xcode or Simulator.
- `bun run sim:run`: boots a simulator if needed, installs the built iOS app, and launches it.
- `bun run sim:dev`: one-command dev loop — builds the simulator app, installs + launches it, starts the `serve-sim` stream, and prints the preview URL; Ctrl+C stops the stream. Pass `--no-build` to skip the build step.
- `bun run sim:serve`: starts `serve-sim` in detached JSON mode and prints the browser preview URL.
- `bun run sim:list`: lists running `serve-sim` streams.
- `bun run sim:kill`: stops running `serve-sim` streams.
- `bun run open:ios`: opens the iOS project.
- `bun run open:android`: opens the Android project.

## Headless Quickstart

```sh
bun run build
bun run sync
bun run build:ios:simulator
bun run build:android:debug
```

These commands build and sync the native projects without launching Xcode, Android Studio, Simulator, or an emulator.

## Local Tooling

The default scripts assume the local Homebrew/Xcode paths prepared for this workspace:

- Xcode: `/Applications/Xcode.app/Contents/Developer`
- JDK 21: `/opt/homebrew/opt/openjdk@21`
- Android SDK: `/opt/homebrew/share/android-commandlinetools`

Override `DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` when using a different local setup.

Required local tools:

- Xcode with iOS Simulator support.
- CocoaPods for iOS dependency installation.
- JDK 21 for Android Gradle builds.
- Android SDK command-line tools with platform/build-tools 35.

## Push configuration

The repository does not ship another product's Firebase or Apple credentials.

- Android builds remain usable without Firebase, but push registration is disabled. Official
  release automation must supply a Piarium-owned `android/app/google-services.json` for
  `dev.piarium.mobile`; that file is ignored by Git.
- iOS signing must provision `dev.piarium.mobile`, its widget and notification-service identifiers,
  the `group.dev.piarium.mobile` App Group, and the APNs entitlement.
- A central push relay is opt-in through `PIARIUM_PUSH_RELAY_URL`. Source builds have no inherited
  default relay. Self-hosters can instead configure direct APNs delivery with the documented
  `PIARIUM_APNS_*` environment variables.

## Troubleshooting

- If `xcodebuild` reports that the active developer directory is Command Line Tools, keep using the provided scripts or set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- If Android builds fail with `Unable to locate a Java Runtime` or `source release: 21`, install/use JDK 21 and set `JAVA_HOME` accordingly.
- If Android SDK packages are missing, install `platform-tools`, `platforms;android-35`, and `build-tools;35.0.0`, then accept SDK licenses.
- If CocoaPods cannot find Capacitor pods after reinstalling dependencies, run `bun install` from the workspace root, then rerun `bun run sync`.
- If connecting to a remote Piarium server fails from the app while `/health` works in curl, check that the server build includes the packaged-client CORS allowlist for `capacitor://localhost` and local dev origins.
- If `serve-sim` preview says the stream is not producing frames, check the raw MJPEG stream before assuming the simulator stopped. In prior testing the raw stream worked while the browser preview UI stayed stale.

## Generated Assets

Launcher, adaptive, and splash assets are generated from Piarium's maintained desktop product icon:

```sh
bun run branding:generate
```

The generated native assets are committed so Android/iOS builds do not depend on a release-time
image tool. Run `bun run test:identity` after changing identifiers, targets, schemes, or branding.
