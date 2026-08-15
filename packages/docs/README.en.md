English | [简体中文](README.md)

# Piarium Docs Source

This package is the source-of-truth for Piarium public docs content.
**Simplified Chinese is the default language and the source locale.**

## Layout

- `content/docs/*.mdx` — Simplified Chinese pages (source of truth, no URL prefix)
- `content/docs/en/*.mdx` — English translations
- `content/docs/<locale>/*.mdx` — other translations (e.g. `uk/`, `pt-br/`, `fr/`); see
  [CONTRIBUTING.en.md](CONTRIBUTING.en.md) → Localization
- `sidebar.config.json` — Starlight sidebar; `label` is Chinese, other languages live in
  `translations`
- `CONTRIBUTING.md` — Chinese authoring guide
- `CONTRIBUTING.en.md` — English authoring guide
- `DEPLOYMENT.md` — how this source is validated and what is not automated yet

A future Starlight site should treat Simplified Chinese as the root locale:

```js
locales: {
  root: { label: "简体中文", lang: "zh-CN" },
  en: { label: "English", lang: "en" },
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
- sidebar links resolve to default (Chinese) MDX routes

It does not check branding, translation quality, or whether commands still match the code.

## Deployment model

This repository owns the docs source. There is no separate website workflow in
`.github/workflows` yet. Until a docs site is published, treat these pages as
the canonical content for GitHub and any future Starlight renderer.
