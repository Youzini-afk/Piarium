English | [简体中文](DEPLOYMENT.zh-CN.md)

# Docs Source Deployment

This repository owns Piarium docs **source**. Rendering and hosting for a public
docs site are not automated here yet.

The default language is English: `content/docs/*.mdx` is the English source, and
Simplified Chinese lives in `content/docs/zh-cn/`.

## What exists today

- Content lives in `packages/docs/content/docs/`
- Navigation lives in `packages/docs/sidebar.config.json` (`label` is English)
- CI runs `bun run docs:validate` on every pull request and push to `main`

## What does not exist yet

- `.github/workflows/docs-source.yml`
- A separate website repository
- Automatic sync to a hosted Starlight/Astro site

When a docs site is added, package this directory as the content source, keep
`docs:validate` as the gate, and document the renderer repository here. Starlight
should use English as the root locale (`lang: "en"`) and Simplified Chinese as
`zh-CN`.

## Local check

```bash
bun run docs:validate
```
