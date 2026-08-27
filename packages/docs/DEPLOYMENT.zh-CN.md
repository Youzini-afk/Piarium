[English](DEPLOYMENT.md) | 简体中文

# 文档源码发布

本仓库持有 Piarium 文档**源码**。公开文档站的渲染和托管尚未在此自动化。

默认语言是英文：`content/docs/*.mdx` 是英文源页，简体中文在 `content/docs/zh-cn/`。

## 当前已有

- 内容在 `packages/docs/content/docs/`
- 导航在 `packages/docs/sidebar.config.json`（`label` 为英文）
- 每次 Pull Request 和推送到 `main` 时，CI 会运行 `bun run docs:validate`

## 尚未具备

- `.github/workflows/docs-source.yml`
- 独立的网站仓库
- 自动同步到托管的 Starlight/Astro 站点

以后增加文档站时，把本目录作为内容源，继续用 `docs:validate` 做门禁，并在这里写明渲染器仓库。
Starlight 的根 locale 应设为英文（`lang: "en"`），简体中文为 `zh-CN`。

## 本地检查

```bash
bun run docs:validate
```
