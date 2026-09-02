# Piarium CLI Module Map

`packages/web/bin/cli.js` is the generated, published `piarium` entrypoint. Its TypeScript source is `packages/web/cli/cli.ts`; command behavior belongs in this directory and `bin/` is never edited directly.

## Commands

- `commands-serve.ts`: starts the Piarium Web server in foreground or daemon mode and owns port selection, logs, and the PID/instance registry.
- `commands-lifecycle.ts`, `commands-status.ts`, `commands-logs.ts`: stop, restart, discover, inspect, and read logs from Piarium server instances.
- `commands-session.ts`: operates directly on the Pi runtime HTTP dispatcher for session list/create/status/messages/send/fork, model and thinking selection, slash commands, waits, and optional worktree creation.
- `commands-schedule.ts`: manages project scheduled tasks through Piarium REST routes. Scheduled executions use Pi model and thinking fields.
- `commands-models.ts`, `commands-projects.ts`: read Pi models and Piarium project settings.
- `commands-startup.ts`: manages native per-user startup integration.
- `commands-connect-url.ts`: creates pairing-v2 `piarium://` links backed by the shared pairing store.
- `commands-tunnel.ts`: manages tunnel providers, profiles, diagnostics, lifecycle, and completion scripts.
- `commands-update.ts`: updates the installed `@piarium/web` package and coordinates restart behavior.

## Shared Runtime

- `cli-runtime.ts`: authenticated JSON access to `/api/piarium/runtime/request` and Piarium REST routes, plus Pi session idle waiting.
- `cli-api-target.ts`: selects an explicit, desktop, or discovered Piarium runtime.
- `cli-args.ts`: argument parsing, help, completion scripts, defaults, and typo suggestions.
- `cli-paths.ts`: Piarium data, settings, log, run, and tunnel-state paths.
- `cli-process.ts`, `cli-lifecycle.ts`: process identity, PID files, instance metadata, health probes, discovery, and termination.
- `cli-http.ts`: authenticated local HTTP, health, shutdown, tunnel-provider, and system-info requests.
- `cli-network.ts`, `cli-ports.ts`: bind hosts, LAN safety, URLs, browser-safe ports, and port selection.
- `cli-startup.ts`: platform-specific startup service definitions and installation.
- `cli-goal.ts`: validates the optional goal token budget.
- `cli-tunnel-profiles.ts`, `cli-tunnel-utils.ts`, `cli-tunnel-capabilities.ts`: tunnel profile storage and tunnel-specific helpers.

## Boundaries

- The CLI talks to Piarium and the Pi runtime only. It must not probe, launch, proxy, or configure OpenCode.
- `--json` emits JSON only; `--quiet` emits concise essential output.
- Session methods use the typed Pi runtime dispatcher. Product REST routes are reserved for Piarium-owned services such as settings, worktrees, schedules, pairing, and tunnels.
- Cross-command dependencies are injected from `cli.ts`; modules in this directory must not import `cli.ts`.

## Interaction modes

`@clack/prompts` is the human presentation layer; it is not where command policy lives. Required input,
validation, authorization, and failure exit codes apply equally to interactive, fully flagged,
non-TTY, quiet, and JSON use. `cli-output.ts` centralizes the mode decisions, prompt gate, JSON output,
status lines, and progress helpers so commands do not invent their own terminal mode detection.

Prompts are an optional way to collect missing input when `canPrompt(options)` says the current output
mode and terminal support them. In non-interactive modes, missing required input becomes a deterministic
error that names the needed flag. JSON results include machine-readable warnings/errors without human
framing; quiet results retain the essential value rather than becoming silent success.

## Verification

From `packages/web`:

```sh
bun x vitest run cli --config vitest.config.ts
```

Release-wide verification is selected from the root release and CI scripts rather than repeated here.
