# Docs Source Deployment

This repository owns Piarium docs **source**. Rendering and hosting for a public
docs site are not automated here yet.

## What exists today

- Content lives in `packages/docs/content/docs/`
- Navigation lives in `packages/docs/sidebar.config.json`
- CI runs `bun run docs:validate` on every pull request and push to `main`

## What does not exist yet

- `.github/workflows/docs-source.yml`
- A separate website repository
- Automatic sync to a hosted Starlight/Astro site

When a docs site is added, package this directory as the content source, keep
`docs:validate` as the gate, and document the renderer repository here.

## Local check

```bash
bun run docs:validate
```
