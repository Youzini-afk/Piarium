# Piarium contributor notes

## Boundaries

- Never execute Pi extensions in the Electron renderer.
- Keep Electron preload APIs explicit and typed; do not expose raw IPC or filesystem access.
- Treat host protocol input as untrusted and validate it at every process boundary.
- Keep Pi session JSONL authoritative. Do not rewrite it outside the recovery transaction layer.
- Do not put credentials, prompt bodies, or file contents in diagnostic logs.
- Preserve user data and unrelated working-tree changes.

## Commands

```powershell
npm run format
npm run typecheck
npm run test
npm run build
```

Run the narrowest relevant check while iterating and `npm run check` before a phase commit.

## Commit discipline

Each roadmap phase is committed and pushed independently after its acceptance checks pass. Avoid
mixing later-phase features into an earlier-phase commit.
