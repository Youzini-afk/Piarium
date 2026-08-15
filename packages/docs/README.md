# Piarium Docs Source

This package is the source-of-truth for Piarium public docs content.

## Layout

- `content/docs/*.mdx` - English docs pages (source of truth)
- `content/docs/<locale>/*.mdx` - translations, mirroring the English filenames
  (e.g. `uk/`, `zh-cn/`, `pt-br/`, `fr/`); see `CONTRIBUTING.md` → Localization
- `sidebar.config.json` - docs navigation structure for Starlight sidebar
- `CONTRIBUTING.md` - authoring guide for adding pages, sections, and translations
- `DEPLOYMENT.md` - how this source is validated and what is not automated yet

## Local validation

Run from repo root:

```bash
bun run docs:validate
```

This validates:

- frontmatter (`title`, `description`) exists for every MDX page
- sidebar links resolve to existing MDX routes

It does not check branding, translation quality, or whether commands still match the code.

## Deployment model

This repository owns the docs source. There is no separate website workflow in
`.github/workflows` yet. Until a docs site is published, treat these pages as
the canonical content for GitHub and any future Starlight renderer.
