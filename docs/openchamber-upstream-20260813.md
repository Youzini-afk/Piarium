# OpenChamber upstream absorption ledger — 2026-08-13

## Reviewed source

- Maintainer fork baseline: `f551150e57de87858383dd62f45462189adf4125`.
- OpenChamber upstream tip: `dea3826f8759e503465a9a9ac5614f4d54caa1b0`.
- Merge base: `ddbc9b536aaa02ed1c1a0e9dc8f2030454cf6854`.
- Reviewed reconciliation: `24379cc84b2818a61f62301fa83c82a24d17986a` on
  `sync/upstream-20260813` in `Youzini-afk/openchamber`.

The reconciliation keeps upstream's current product structure while restoring the fork's custom
providers, workspace/project browsing, cloud and desktop behavior, OpenAgent/orchestration/Magic
surfaces, remote notification listener, directory-selection mode, session routing fallbacks, and
provider/agent refresh behavior. Smart Search and unused worktree parameters were not restored
because the merged application has no real consumer for them.

That merge is not copied wholesale into Piarium. Piarium reviews the resulting behavior and adopts
it through the native Pi protocol, runtime broker, extension contracts, and product stores.

## Adoption rules

1. Prefer the upstream implementation when it already satisfies the fork behavior and does not
   reintroduce an OpenCode dependency or duplicate owner.
2. Supplement a partial upstream implementation at its real ownership boundary instead of keeping
   two competing implementations.
3. Reimplement engine-dependent behavior against Pi; do not project Pi data into OpenCode types or
   restore OpenCode HTTP routes, stores, lifecycle, MCP ownership, or compatibility aliases.
4. Preserve platform behavior, native configuration authority, project trust, revision conflicts,
   credentials, and current user data during each adoption phase.

## Capability disposition

| Upstream capability | Upstream evidence | Piarium disposition |
| --- | --- | --- |
| Raw HTML in assistant Markdown stays inert | `3de9be9f` | Adopted directly. Raw HTML is visible text; `script` and `style` are forbidden again at the sanitization boundary. Composer HTML fragments are not treated as file mentions. |
| Final shell output reflects terminal control sequences | `91d2a546`, `1c27155b` | Adopted in the Pi-native timeline. ANSI styling, carriage-return progress, cursor movement, and line erasure are normalized only for persisted/final output. Synthetic cursor expansion has a dedicated allocation budget; real output remains Pi-owned and is not truncated here. |
| Code line numbers never wrap | `a7db4015` | Adopted directly in shared Markdown CSS. |
| Work Status panel | `f2523d0c`, `222057ab`, `630ac299`, `d7231b6d`, `ee9c9d6f` | Adopted as a Pi-native wide-chat panel. It projects `SessionSnapshot`, `SessionStats`, `PiSessionFeatureState`, current tool executions, Fleet RPC, MCP public status, and pinned branch entries. It does not restore OpenCode todo, goal, MCP, or quota stores. |
| Guided diff/branch/PR walkthrough | `2ea828b8` and follow-up fixes | Adopted through Piarium's Git service, Pi model catalog/auth, server-side generation jobs, and the context-panel surface. The complete reviewable diff must fit the selected model; it is never silently clipped. Upstream's fixed chapter/stop/hunk caps were removed because they were presentation guesses rather than protocol or resource boundaries. |
| Markdown loops in `.agents/loops` | `0ba330c7`, `8a367382`, `bac56fc7`, `ffef080b` | Adopted in the Pi-native scheduler. Markdown remains authoritative and uses Pi model, thinking, agent, and goal fields. File-path identity prevents same-name GUI tasks from being hijacked; revisioned edits prevent agent/UI races; malformed higher-priority loops keep their last-good state without activating a lower duplicate. No OpenCode owner, permission, or variant field is imported. |
| Relay request-body integrity | `854a0db9`, `aaf397e6`, `d634cd23` | Adopted at Piarium's retained relay boundary. Empty body sources emit an explicit frame, ordinary control bodies are forwarded only after completion, missing frames abort as an ambiguous transport failure, and stalled buffers are released. Large uploads retain streaming behavior. |
| Mobile transient reconnect and device diagnostics | `dea3826f`, `f4005982` | Transient reconnect behavior adopted against Piarium's endpoint-aware mobile state. Explicit token rejection disconnects immediately; temporary reachability failures get bounded fast/full-budget retries and never replace a later manual connection. The upstream hidden diagnostics UI was not copied. |
| Measured Vite/chunk and lazy-render improvements | `fdcf5c27` | Adopted after a Piarium-specific bundle audit. Diff, Files, Git, PR, Plan, Settings, Ghostty, Markdown Shiki, diff workers, and Nerd Fonts now load at their real first consumer. The upstream package-name parser did not recognize Bun's nested `node_modules/.bun/.../node_modules` layout and still produced a 15.8 MB eager `.bun` vendor chunk; Piarium resolves the innermost package and isolates Vite's preload helper. Production entry resources fell from 16,411,160 to 838,532 raw bytes (94.9%). Obsolete OpenCode chat tool components were not restored. |
| Provider/OAuth/custom-provider fixes | `70af851b` and follow-ups | Audited against Pi's provider runtime. Piarium already projects API-key/OAuth methods on every catalog read, uses one provider-owned login call that waits for browser callback, device polling, or manual completion before persisting credentials, preserves the effective edit scope, resets the edit form, and keeps secrets outside config DTOs. The OpenCode JSON-body route and two-step OAuth callback are not applicable. Piarium supplements the upstream behavior by gating `.pi/models.json` on project trust and making form-owned field removal real while preserving comments, credentials, and unknown native keys. It intentionally does not hide every unauthenticated model: Pi supports anonymous/local providers, and model availability remains the runtime-owned signal. |
| OpenCode session sync, question/permission routing, MCP settings/auth | `0f52a9be`, `ee5e45ae`, `d33cf518`, `622b8bb6` | Audited by failure mode rather than copied. OpenCode's directory-store routing, worktree directory guessing, queued-send retry, callback proxy, and Apply-&-Restart state do not exist in Piarium. Piarium already routes every session action and Extension UI response through the broker's exact `sessionId → worker` binding; MCP authentication remains a `pi-mcp-adapter` command/status contract. One shared failure did reproduce: an unexpected Pi session-worker exit was server-only and left busy/tool/dialog UI stale. A routed terminal event now settles that session and clears its extension UI. |
| Git worktree, identity, symlink, and base-branch fixes | `58e6e704`, `955e7231`, `5fc61373`, `18fefc99`, `c9ab916c` | Adopted and completed across Piarium's Web and VS Code Git owners. Managed worktrees populate with `core.longpaths`, run the repository's normal `post-checkout` hook, and keep bootstrap usable when that hook fails. SSH identity writes use the targeted simple-git opt-in and a raw config write. Symlink diffs expose link targets rather than following directory/file targets. Branch workflows use each remote's declared default branch, preserve cached remote refs while offline, avoid self-comparisons, and resolve bases hosted by a non-`origin` remote for both diff and file lists. OpenCode project registration remains absent. |
| Pairing reachability, Android payload parsing, and Relay demand | `9aa98df2`, `24b44f71`, `e04e34a2` | Adopted at Piarium's retained pairing and Relay owners. Pairing links keep the public reverse-proxy origin as a fallback after the preferred LAN URL while excluding desktop loopback. Android QR redemption has a URL-API-independent parser with the same v2 validation. A real relayed request repairs legacy client demand, and an unreadable client/pairing store no longer masquerades as zero demand and switches the Relay off. Piarium's existing scanner lifecycle, external-access profiles, capabilities, and audit records remain authoritative. |
| File reveal and browser file actions | `6599891d`, `a416e033` | Adopted and completed for Piarium's local/remote runtime switching. macOS/Linux reveal waits until the file-browser launcher actually starts and reports launcher failures. Browser clients download files instead of offering to reveal a path on the server. Electron only exposes reveal while connected to its local Piarium server; VS Code keeps its host-owned behavior. Download remains available even when it is the row's only menu action. |
| Desktop minimize, Linux terminal discovery, and notification edits | `f2b3c50a`, `b76bbd7a`, `f498fad3` | Adopted at their existing Piarium owners. Native taskbar minimize remains native; only Piarium's own window control applies the minimize-to-tray preference. The generic Linux terminal target selects a desktop entry declaring `TerminalEmulator` instead of a name collision. Notification template field edits derive from the latest store value so adjacent edits cannot overwrite each other. |
| Shared terminal, context rail, and mobile gesture fixes | `10728dbf`, `a5c413b9`, `16e03d13`, `d7e82eea`, `0b393e5b` | Adopted against Piarium's own stores and surfaces. Default terminal labels advance from the highest open default label instead of the tab count; Escape reaches the PTY before the context panel can close; only Git shows repository activity and now exposes the changed-file count; Android session switching starts beyond the system Back strip. Piarium keeps its own session ordering and context-surface registry. |
| Android QR scanning without Play Services | `cc40ff9f` | Adopted in Piarium's pairing flow. Android uses the ML Kit plugin's bundled CameraX `startScan` path with an in-app preview and explicit cancellation, so scanning no longer waits for the Play Services barcode UI module. iOS retains the native one-shot scanner, and both paths continue through Piarium's v2 pairing parser and redemption owner. |
| Embedded chat loading, context focus, and terminal keepalive | `7a04dd5c`, `687cc17d`, `8702c6d5` | Adopted through Piarium's context panel and Pi-native chat. Only the active persisted session-chat tab mounts a complete embedded application, and closing the panel mounts none. A successful context pin returns focus to Piarium's native composer. Terminal ping cadence is 45 seconds, below Piarium Relay's measured 90-second data-socket reaper while avoiding unnecessary wakeups. |
| Composer, session-row, message, and scrollbar fixes from the OpenCode UI | `287d6b87`, `721525e6`, `54d24a48`, `294552b0`, `cc6c5db3` | Reviewed, not copied. Piarium's active composer is a native textarea, so Shift+Enter and caret visibility do not depend on the removed CodeMirror composer. Its Pi session rows do not carry the upstream rounded clipping wrapper, Pi bash entries already render complete output without a collapsed tool card, and the latest upstream explicitly restores the same auto-hiding overlay-scrollbar behavior Piarium already has. |

## Phase checkpoints

### Direct rendering and terminal hardening

Scope: Markdown HTML handling, mention classification, code-line layout, and final Pi bash output.
This phase has no protocol or persistence change and does not alter live streaming output.

Acceptance:

- active raw HTML cannot enter application DOM through Markdown;
- ordinary Markdown, generated syntax highlighting, math, and Mermaid keep their current renderer;
- final Pi bash output presents the terminal's visible result rather than raw control bytes;
- huge cursor coordinates cannot allocate output proportional to the coordinate;
- code line-number cells stay on one line.

### Platform transport and mobile lifecycle

Completed against Piarium's retained relay and mobile code. The relay uses `hasBody` plus explicit
empty frames to distinguish empty bodies from missing frames, buffers ordinary control requests
until `StreamEnd`, releases stalled buffers at the delivery deadline, and leaves larger uploads on
the previous streaming path. Mobile resume uses a 4-second/10-second retry ladder with a final
full-budget probe; cold launch releases the splash after the fast verdict and retries once in the
background without overriding a manual connection.

### Pi-native product capabilities

Implement Work Status, walkthroughs, and Markdown loops as separate recovery points. Each phase must
name its authoritative Pi data source and remove any temporary duplicate owner before completion.

Work Status is complete for the main chat surface. It appears only when the chat container retains
enough width for both the conversation and a 288px panel; mobile, VS Code, Mini Chat, and embedded
agent-manager conversations do not mount it. Session statistics refresh from the existing Pi stats
method, Fleet uses the existing read-only RPC, MCP uses `pi-mcp-adapter/status/v1`, and pinned rows
resolve only from the already loaded branch rather than introducing another message owner.

The guided walkthrough is complete for desktop and web context panels. Working-tree, staged,
unstaged, branch three-dot, and pull-request sources all resolve in the server's existing Git owner;
the renderer receives server-owned content hashes and never recreates merge or hunk identity logic.
Generation is explicit, deduplicated per repository/source, survives a detached client, and can be
cancelled explicitly. Results are content-addressed under the Piarium data directory and retain
stale/uncovered hunks instead of presenting an incomplete review as complete. VS Code does not show
the surface because that host still does not serve the Git/model HTTP routes this implementation owns.

### Build graph and first-use loading

Completed against Piarium's Bun workspace rather than copying upstream's chunk names. The settings
window does not fetch until its first open; context surfaces keep their state but load their heavy
implementation only when selected; Ghostty JS/WASM and remote Nerd Fonts load only when a terminal
mounts; Markdown creates its Shiki worker only for an actual highlighting request; diff worker pools
and Pierre theme registration stay dormant until a diff consumer requests a pool. CSS syntax variables
remain dependency-free, and the unused `openchamber-md` Pierre registration was removed.

The production `index.html` resource graph is the acceptance measurement: before this phase it eagerly
referenced 16,411,160 bytes, dominated by a 15,780,665-byte `vendor-.bun` chunk. After resolving the
innermost package name and separating Vite's dynamic-import helper, it references 838,532 bytes and no
longer preloads Settings, CodeMirror, Pierre/Shiki, Ghostty, Git, or Files chunks. These are raw emitted
bytes, not a claim about every device's wall-clock startup time.

### Provider configuration and authentication

Completed at Piarium's Pi provider boundary. Project-local `.pi/models.json` is now itself a
trust-requiring resource, is neither read nor registered before approval, and cannot be written or
deleted through Provider settings while the project is untrusted. The user and explicit operator
layers remain available. Editing a native provider now replaces the GUI-owned `api`, `authHeader`,
`baseUrl`, `models`, and `name` fields, so clearing one actually removes it; comments, `apiKey`,
headers, compatibility settings, and future unknown keys remain intact.

Pi's OAuth implementation needs no OpenCode callback emulation. `ModelRuntime.login()` owns the
complete browser callback/device-code/manual-code flow and stores the credential only after it
returns. Provider methods are rebuilt from the active Pi provider on every list/reconnect. The UI
continues to show configured anonymous and local providers because absence of a credential is not a
valid reason to hide models in Pi; each model's runtime `available` flag remains authoritative.

### Session and extension interaction convergence

Completed against the Pi worker topology. OpenCode's parent-directory versus worktree routing bugs
are structurally absent: the public runtime accepts a `sessionId`, the broker owns the single active
worker for that id, and Extension UI/provider-auth responses carry the request's emitted session id
back to that exact worker. Piarium therefore does not restore directory-resolution indexes, local
question stores, permission stores, or an OpenCode queued-send scheduler.

The applicable interrupted-turn invariant is now explicit. When a Pi session worker exits, the
broker forwards one ordered `session.worker.exited` terminal event to connected surfaces. The session
store closes the live record, clears busy/streaming/compaction/retry state, marks unfinished live
assistant output and running tool executions as interrupted errors, and raises background attention
for an unexpected exit. The interaction store removes dialogs and session chrome owned by that dead
worker. Persisted Pi entries are not rewritten; reopening the session continues to refresh them from
Pi's JSONL authority.
