# Plugin-backed recovery

> This document describes the current implementation. It is superseded as a target architecture by
> [Piarium native workspace recovery](native-workspace-recovery-design.md); the plugin-backed paths stay
> in place only until the native phases replace them completely.

Piarium owns recovery UX, policy, and capability discovery. Pi and its maintained plugins own the
actual history. Piarium does not keep a second shadow-Git repository, copy a plugin's state files,
or rewrite that private state into an application database.

## User semantics

- `conversation` uses Pi's append-only session tree and intentionally leaves workspace files alone;
- `both` uses Pi tree navigation while `pi-workspace-history` restores its associated workspace
  snapshot through the standard `session_before_tree` hook;
- `files` is exposed only when an installed plugin advertises files-only restore through the bridge;
- undo, redo, and named checkpoints use `pi-workspace-history`;
- prompt repair, typo-assisted repair, and the explicitly destructive repair action use `pi-wtf`;
- the UI preference is conversation only, conversation + files, or always ask;
- the normal entry point stays on the existing per-message revert action, while detailed controls
  belong in the right sidebar or settings.

The desktop/web right-side Recovery surface now shows current provider health and issues, lets the
user choose conversation or combined scope, and exposes undo, redo, named checkpoints, and all
advertised prompt-repair actions. Each control is enabled only when one active provider advertises
both the requested action and mode; Piarium never combines the independent global action and mode
unions into a capability that no provider actually offers. Destructive prompt repair has its own
explicit confirmation.

Returning to a user entry restores its text and images to the composer. Piarium reports the provider
that handled every operation. Native and bridged operations report `applied` or `cancelled` when
known. Current command-only plugins do not return structured results, so their fallback result is
truthfully reported as `unknown`; their existing notifications remain visible and Piarium refreshes
the authoritative session snapshot.

## Current provider integration

Piarium discovers loaded extension commands together with their Pi source metadata. This supports
the current public releases without pinning their internal storage formats:

| Provider | Current integration | Exposed capability |
| --- | --- | --- |
| Pi session tree | native SDK | conversation navigation and conversation undo |
| `pi-workspace-history` | tree hook plus `/undo`, `/redo`, `/checkpoint` | combined restore, undo/redo, checkpoints |
| `pi-wtf` | its registered command set, including configured command words | recover prompt, typo repair, explicit destructive repair |

`pi-workspace-history` 0.2.2 does not expose files-only restore, preview/list APIs, or a structured
command result. Those capabilities remain unavailable rather than falling back to a duplicate
Piarium engine. When the plugin adds them through the bridge, the same Piarium UI can enable them
without reading `turn-snapshots.json` or any other private file.

`pi-wtf` is reported as a conversation-repair provider. Installing workspace history does not make
`pi-wtf` claim combined file recovery; that capability remains attributed to the provider that
actually owns workspace snapshots.

Piarium absorbs `pi-workspace-history`'s unconditional first-turn initialization preflight notice:
the active turn already shows that work is in progress, and the notice otherwise repeats for every
new session without offering an action. A later notification that the initial snapshot is still
blocking, plus all plugin warnings and errors, remains visible.

## Recovery bridge v1

The shared Pi event bus is the extension point. A provider listens on
`piarium.recovery.discover/v1` and synchronously registers an offer:

```ts
pi.events.on("piarium.recovery.discover/v1", (request) => {
  request.register({
    id: "my-history-provider",
    name: "My History Provider",
    source: "npm:my-history-provider",
    bridgeVersion: 1,
    modes: ["files", "both"],
    actions: ["navigate", "undo", "redo", "checkpoint"],
    execute: async ({ action, mode, sessionId, targetId, name }) => {
      // The provider remains the authority for its own snapshots and transactions.
      return { outcome: "applied", editorText: undefined, editorImages: undefined };
    },
  });
});
```

Discovery is synchronous, while `execute` may be asynchronous. Provider IDs are stable UI and
diagnostic identities. The supported modes and actions are explicit; Piarium never assumes a
files-only operation from a combined tree hook. Invalid offers are ignored with a visible issue.

The bridge passes functions only inside the trusted Pi worker. It is not serialized to the browser,
does not expose credentials, and does not grant an extension capabilities beyond the code execution
it already has as a trusted Pi extension.

## Updates and ownership

Plugins remain normal Pi packages. Installation and updates go through Pi's `PackageManager`, so
`npm:pi-workspace-history` and `npm:pi-wtf` can advance independently of Piarium. After a package
reload, capability discovery runs against the new extension instance. Command renames configured by
`pi-wtf` are discovered from Pi source metadata and the plugin's public base/`?`/`!` command set
rather than hard-coded to `/fuck` or coupled to English description text.

Both recovery providers are in Piarium's foundational package manifest, so a missing first-time
global installation is provisioned in the background. This changes discovery, not ownership: either
package can be disabled or removed through Pi Packages, removal remains suppressed across restarts,
and explicit Restore is required before Piarium installs it again. Existing plugin configuration and
history are never copied into the provisioning receipt, and Piarium does not auto-update either
package.

Piarium persists only application policy such as the default recovery mode and view state. Session
history stays in Pi JSONL; workspace snapshots and retention stay with the workspace-history
provider; repair behavior stays with `pi-wtf`.

The Plugins settings editor writes `workspaceHistory` through Pi's global/project `settings.json`
documents and edits `pi-wtf`'s global `wtf.json` as an extension-owned JSON document. Piarium treats
both as unrestricted JSON objects, applies only changed top-level keys under an atomic file lock, and
reloads the extension instance after saving. Magic Context remains similarly independent: its user
and project `magic-context.jsonc` files retain comments and trailing commas and are saved atomically
with revision conflict detection. Piarium does not duplicate any plugin's schema, defaults,
validation, or migrations, so new fields remain owned by the updated plugin.

The Sessions settings page persists that policy as `conversation`, `both`, or `ask` and links to the
two recovery packages. The general Plugins page exposes the same typed
`package.list/install/update/remove` operations for all Pi packages and arbitrary
Pi-supported sources. Package cards deliberately distinguish “configured for this workspace context” from
“active in an open session”; command and bridge capabilities remain authoritative and are
rediscovered after Pi reloads the package.

## Verification

Automated host tests cover native conversation recovery, text and image restoration, deliberate
bypass of workspace hooks for conversation-only recovery, combined navigation through the
workspace-history hook, command delegation for checkpoints and `pi-wtf`, bridge v1 discovery, and
files-only execution by a bridged provider. Protocol, broker, and packaged-host tests verify that
the capability contract crosses the isolated worker boundary.

UI tests additionally cover provider-local action/mode capability checks, all sidebar recovery
store operations, single-instance Recovery surface behavior, and independent per-surface width.
