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
| Work Status panel | `f2523d0c`, `222057ab`, `630ac299`, `d7231b6d`, `ee9c9d6f` | Pi-native implementation required. Reuse the interaction design, but source state from `SessionSnapshot`, `SessionStats`, `PiSessionFeatureState`, package/extension state, Fleet, MCP status, and Pi provider data. Do not restore OpenCode todo, goal, MCP, or quota stores. |
| Guided diff/branch/PR walkthrough | `2ea828b8` and follow-up fixes | Pi-native implementation required. Reuse the presentation and review flow after replacing OpenCode model/session calls with Pi model selection and a Pi session/tool contract. Git diff ownership stays with Piarium's Git API. |
| Markdown loops in `.agents/loops` | `0ba330c7`, `8a367382`, `bac56fc7`, `ffef080b` | Reimplement in the Pi-native scheduler. Markdown files should be authoritative and synchronize into the existing Pi scheduled-task execution path; no OpenCode agent or permission fields are imported. |
| Relay request-body integrity | `854a0db9`, `aaf397e6`, `d634cd23` | Adopted at Piarium's retained relay boundary. Empty body sources emit an explicit frame, ordinary control bodies are forwarded only after completion, missing frames abort as an ambiguous transport failure, and stalled buffers are released. Large uploads retain streaming behavior. |
| Mobile transient reconnect and device diagnostics | `dea3826f`, `f4005982` | Transient reconnect behavior adopted against Piarium's endpoint-aware mobile state. Explicit token rejection disconnects immediately; temporary reachability failures get bounded fast/full-budget retries and never replace a later manual connection. The upstream hidden diagnostics UI was not copied. |
| Measured Vite/chunk and lazy-render improvements | `fdcf5c27` | Audit by consumer. Apply only changes still relevant to Piarium's bundle graph and measure the Piarium build; do not copy obsolete OpenCode components to reproduce upstream numbers. |
| Provider/OAuth/custom-provider fixes | `70af851b` and follow-ups | Compare behavior with Piarium's provider protocol and current custom-provider GUI. Adopt missing validation, scope, credential, reconnect, and OAuth behavior in the Pi owner; do not copy `/api/provider` or OpenCode provider stores. |
| OpenCode session sync, question/permission routing, MCP settings/auth | `0f52a9be`, `ee5e45ae`, `d33cf518`, `622b8bb6` | Do not copy the implementation. Audit the underlying invariants against Piarium's session worker routing, Pi extension UI requests, and `pi-mcp-adapter`. Add a Pi-native fix only where the same failure is reproducible. |

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
