English | [简体中文](README.zh-CN.md)

# Piarium Docs Source

This package is the source of truth for Piarium public docs content.
**English is the default language and source locale.**

## Layout

- `content/docs/*.mdx` — English pages (source of truth, no URL prefix)
- `content/docs/zh-cn/*.mdx` — Simplified Chinese translations
- `content/docs/<locale>/*.mdx` — other translations (e.g. `uk/`, `pt-br/`, `fr/`); see
  [CONTRIBUTING.md](CONTRIBUTING.md) → Localization
- `sidebar.config.json` — Starlight sidebar; `label` is English, other languages live in
  `translations`
- `CONTRIBUTING.md` — English authoring guide
- `CONTRIBUTING.zh-CN.md` — Simplified Chinese authoring guide
- `DEPLOYMENT.md` — how this source is validated and what is not automated yet

A future Starlight site should treat English as the root locale:

```js
locales: {
  root: { label: "English", lang: "en" },
  "zh-CN": { label: "简体中文", lang: "zh-CN" },
  // ...
}
```

## Local validation

Run from repo root:

```bash
bun run docs:validate
```

This validates:

- frontmatter (`title`, `description`) exists for every MDX page
- sidebar links resolve to default (English) MDX routes

It does not check branding, translation quality, or whether commands still match the code.

## Deployment model

This repository owns the docs source. There is no separate website workflow in
`.github/workflows` yet. Until a docs site is published, treat these pages as
the canonical content for GitHub and any future Starlight renderer.
