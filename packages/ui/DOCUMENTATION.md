# Shared UI architecture and conventions

`@piarium/ui` is the React surface shared by Web, Electron, mobile, and the VS Code companion. It owns
presentation and client-side kernels, not privileged filesystem, credential, shell, or process work.
Surface-specific packages provide `RuntimeAPIs` and host bridges; shared components consume those
contracts without hardcoding an origin, port, desktop IPC channel, or local path.

## Module map

- `src/lib/documents/DOCUMENTATION.md`: revisioned client buffers and conflict behavior.
- `src/lib/workbench/editors/DOCUMENTATION.md`: editor groups, providers, panels, and layout state.
- `src/lib/monaco/DOCUMENTATION.md`: desktop/Web editor projection and language integration.
- `src/lib/codemirror/DOCUMENTATION.md`: mobile and embedded document adapters.
- `src/lib/api/DOCUMENTATION.md`: shared runtime capability and browser-URL boundaries.
- `src/stores/DOCUMENTATION.md`: store ownership, synchronization, cache identity, and visible-demand
  refresh behavior.
- `src/components/sections/shared/DOCUMENTATION.md`: Settings layout, controls, save feedback, and
  search integration.

## Theme and component system

Piarium themes expose semantic surface, interactive, status, primary, syntax, and feature tokens.
Components use those roles rather than embedding palette colors: selection describes current state,
primary describes an action, status colors describe feedback, and syntax colors remain code-specific.
When a third-party renderer needs resolved colors, `useThemeSystem()` is the adapter; ordinary React
chrome uses CSS variables and semantic utility classes.

Common controls live under `src/components/ui`. `Button`, `dropdownTriggerVariants`, and the Settings
primitives carry shared interaction chrome, sizes, focus behavior, and theme semantics. Extending a
shared primitive is preferable when several callers genuinely need the same missing shape; a local
layout exception does not automatically justify another wrapper component.

Icons use the sprite-backed `Icon`/`IconName` contract documented in
[src/components/icon/README.md](src/components/icon/README.md). The generator is
`bun run scripts/generate-icon-sprite.mjs`; `sprite.ts` is generated output. User theme format and
authoritative data locations are documented in [docs/CUSTOM_THEMES.md](../../docs/CUSTOM_THEMES.md).

## User-facing text

Visible text and accessibility labels are resolved through `@/lib/i18n` inside React render or hook
scope. The message catalogs under `src/lib/i18n/messages` ship together, and
`i18nParity.test.ts` checks their key shape. New semantic keys therefore need real translations in
every shipped catalog rather than an English placeholder. Product names, protocol acronyms, paths,
commands, environment variables, model/provider names, and user-generated content remain literal.

Message parameters carry values, not pieces of grammar. Count-dependent or optional clauses use
complete messages where languages cannot share one sentence. Locale state stays inside the i18n
module so changing language re-renders the surface without remounting the application.

## Interaction and performance precedents

Interaction choices follow the layout and input model rather than one global recipe. Existing sortable
precedents are `DraftPresetChips.tsx` for wrapping variable-width chips and
`components/ui/sortable-tabs-strip.tsx` for a single horizontal row. They use stable item identities;
wrapping and single-row layouts intentionally choose different sorting strategies. Sensor distances,
long-press timing, virtualization thresholds, and cache bounds are implementation decisions to verify
against the actual interaction and scale, not repository-wide magic numbers.

High-frequency state should remain close to its owner and preserve unrelated references. Visible
surfaces drive refresh and subscriptions; hidden surfaces should not keep language, Git, PR, terminal,
or extension work alive. The concrete store and editor lifetimes are documented by their owning
modules rather than repeated here.
