English | [简体中文](DEPLOYMENT.md)

# Docs Source Deployment

This repository owns Piarium docs **source**. Rendering and hosting for a public
docs site are not automated here yet.

The default language is Simplified Chinese: `content/docs/*.mdx` is the Chinese
source, and English lives in `content/docs/en/`.

## What exists today

- Content lives in `packages/docs/content/docs/`
- Navigation lives in `packages/docs/sidebar.config.json` (`label` is Chinese)
- CI runs `bun run docs:validate` on every pull request and push to `main`

## What does not exist yet

- `.github/workflows/docs-source.yml`
- A separate website repository
- Automatic sync to a hosted Starlight/Astro site

When a docs site is added, package this directory as the content source, keep
`docs:validate` as the gate, and document the renderer repository here. Starlight
should use Simplified Chinese as the root locale (`lang: "zh-CN"`) and English as
`en`.

## Local check

```bash
bun run docs:validate
```
