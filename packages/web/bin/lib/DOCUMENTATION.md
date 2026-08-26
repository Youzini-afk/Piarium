# Piarium CLI Module Map

`packages/web/bin/cli.js` is the published `piarium` entrypoint. It owns process bootstrap, command wiring, signal handling, and top-level errors; command behavior belongs in this directory.

## Commands

- `commands-serve.js`: starts the Piarium Web server in foreground or daemon mode and owns port selection, logs, and the PID/instance registry.
- `commands-lifecycle.js`, `commands-status.js`, `commands-logs.js`: stop, restart, discover, inspect, and read logs from Piarium server instances.
- `commands-session.js`: operates directly on the Pi runtime HTTP dispatcher for session list/create/status/messages/send/fork, model and thinking selection, slash commands, waits, and optional worktree creation.
- `commands-schedule.js`: manages project scheduled tasks through Piarium REST routes. Scheduled executions use Pi model and thinking fields.
- `commands-models.js`, `commands-projects.js`: read Pi models and Piarium project settings.
- `commands-startup.js`: manages native per-user startup integration.
- `commands-connect-url.js`: creates pairing-v2 `piarium://` links backed by the shared pairing store.
- `commands-tunnel.js`: manages tunnel providers, profiles, diagnostics, lifecycle, and completion scripts.
- `commands-update.js`: updates the installed `@piarium/web` package and coordinates restart behavior.

## Shared Runtime

- `cli-runtime.js`: authenticated JSON access to `/api/piarium/runtime/request` and Piarium REST routes, plus Pi session idle waiting.
- `cli-api-target.js`: selects an explicit, desktop, or discovered Piarium runtime.
- `cli-args.js`: argument parsing, help, completion scripts, defaults, and typo suggestions.
- `cli-paths.js`: Piarium data, settings, log, run, and tunnel-state paths.
- `cli-process.js`, `cli-lifecycle.js`: process identity, PID files, instance metadata, health probes, discovery, and termination.
- `cli-http.js`: authenticated local HTTP, health, shutdown, tunnel-provider, and system-info requests.
- `cli-network.js`, `cli-ports.js`: bind hosts, LAN safety, URLs, browser-safe ports, and port selection.
- `cli-startup.js`: platform-specific startup service definitions and installation.
- `cli-goal.js`: validates the optional goal token budget.
- `cli-tunnel-profiles.js`, `cli-tunnel-utils.js`, `cli-tunnel-capabilities.js`: tunnel profile storage and tunnel-specific helpers.

## Boundaries

- The CLI talks to Piarium and the Pi runtime only. It must not probe, launch, proxy, or configure OpenCode.
- `--json` emits JSON only; `--quiet` emits concise essential output.
- Session methods use the typed Pi runtime dispatcher. Product REST routes are reserved for Piarium-owned services such as settings, worktrees, schedules, pairing, and tunnels.
- Cross-command dependencies are injected from `cli.js`; modules in this directory must not import `cli.js`.

## Interaction modes

`@clack/prompts` is the human presentation layer; it is not where command policy lives. Required input,
validation, authorization, and failure exit codes apply equally to interactive, fully flagged,
non-TTY, quiet, and JSON use. `cli-output.js` centralizes the mode decisions, prompt gate, JSON output,
status lines, and progress helpers so commands do not invent their own terminal mode detection.

Prompts are an optional way to collect missing input when `canPrompt(options)` says the current output
mode and terminal support them. In non-interactive modes, missing required input becomes a deterministic
error that names the needed flag. JSON results include machine-readable warnings/errors without human
framing; quiet results retain the essential value rather than becoming silent success.

## Verification

From `packages/web`:

```sh
bun run test -- bin/cli.test.js
```

Release-wide verification is selected from the root release and CI scripts rather than repeated here.
