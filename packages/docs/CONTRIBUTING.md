[English](CONTRIBUTING.en.md) | 简体中文

# 文档编写指南

本包是 Piarium 公开文档的源码。**先写简体中文，再补译本。**

## 语气与风格

写给想把事情做完的人，而不是在读规格的工程师。假定读者不一定懂技术。一页应该很快读完，
不要像额外作业。

下面这些规则就是现有文档的写法。按它们写，风格才不会因人而异。

### 写给谁

- 假定读者有好奇心，而不是已经懂内部实现。他们知道自己想做什么，不知道 Piarium 里面怎么跑。
- 一页只做一件事。如果一页在回答两个不相关的问题，就拆开。

### 写短

- 先写任务，再写背景。第一句就说明这一页是干什么的（「用 `piarium tunnel` 把正在运行的
  Piarium 暴露出去。」）。
- 删掉不会改变读者下一步动作的内容。
- 普通页面应在一两屏内读完。像「反向代理」这样的长参考页是例外——它们会在第一句说清楚
  （「如果你在……后面运行 Piarium，请使用本页。」）。

### 步骤

- 有先后顺序的动作用数字；选项或无序说明用列表。
- 每一步用动词开头：「运行」「打开」「选择」。
- 流程结束时告诉读者成功长什么样，好确认自己做对了。

```mdx
3. 运行 `piarium --ui-password be-creative-here`。
4. 打开打印出的 URL（通常是 `http://localhost:3000`）。

你应该看到 Piarium 会话列表。如果看到了，说明服务已在运行。
```

### 用白话

- 术语第一次出现时，用括号、日常说法解释：
  - 好：启动一条隧道（指向本机 Piarium 的公开链接）
  - 差：启动一条隧道——读者还不知道那是什么
- 能用常见词就不用内部词。「应用」「版本」「页面」优于「surface」「instance」「route」。
  内部词避不开时，解释一次。
- 除非这一页明确是给运维/进阶读者的，否则不要写 `SSE`、`WebSocket`、`buffering` 或请求头名字。

### 列表和句子

- 同一列表里保持一致：要么全是短片段（不用句号），要么全是完整句子（有句号）——不要混用。
- 快速选项用片段；规则、警告、不能读错的内容用完整句子。

### 能链出去就不要重写

- 某一步很可能失败时，当场链到[问题排查](/troubleshooting/)，不要只放在文末。
- 别的页面已经写过的内容，链接过去，不要再写一遍。（快速开始链到安装页拿安装命令，而不是复制一遍。）

### 能展示就不要只讲

- 按钮在哪、屏幕长什么样，一张截图比一段话有用。加图方式见[图片](#图片)。
- 截图必须配一句说明——图是在帮步骤，不是整步只有图。

### 命令和代码

- 代码块要能直接复制：用真实能跑的值。只有值确实因人而异时才用 `<占位符>`，并写清楚
  （例如 `app.example.com`、`~/.secrets/cf-token`）。
- 一个想法一条命令。不要为了看起来紧凑而把无关命令串在一起。

## 新增文档页

1. 在 `packages/docs/content/docs/` 创建中文源文件。
   - 例如：`packages/docs/content/docs/remote-access.mdx`
2. 文件顶部加 frontmatter：

   ```mdx
   ---
   title: 远程访问
   description: 从本机网络之外访问 Piarium。
   ---
   ```

3. 使用对路由安全的命名：
   - `foo.mdx` -> `/foo/`
   - `folder/index.mdx` -> `/folder/`
   - `folder/bar.mdx` -> `/folder/bar/`
4. 补齐译本——见[本地化](#本地化)。新页面上线前必须包含所有支持语种。
5. 如果侧边栏要链到这一页，同时补侧边栏译文——见[翻译侧边栏](#翻译侧边栏)。
6. 跑校验：

   ```bash
   bun run docs:validate
   ```

## 新增侧边栏分组

编辑 `packages/docs/sidebar.config.json`。

示例：

```json
{
  "label": "进阶",
  "translations": {
    "en": "Advanced"
  },
  "items": [{ "label": "远程访问", "link": "/remote-access/", "translations": { "en": "Remote Access" } }]
}
```

规则：

- 链接带尾部斜杠（`/page/`）
- 每个侧边栏链接都必须对应已有的中文 MDX 文件
- 分组标题要短，并且面向任务

## 图片

图片放在文档内容树里，才会和页面一起同步（同步会复制整个 `content/docs/`，不只是 `.mdx`）。
用**相对路径**引用；Astro 会在构建时优化。

```
content/docs/
  install.mdx          ->  ![桌面应用](./images/desktop.png)
  images/
    desktop.png
```

规则：

- 图片和文档放在一起（例如 `content/docs/images/`）；相对路径 `./images/...` 会在构建时解析并优化
- 必须写有意义的 `alt`（并在各语种页面里翻译）
- **不要**把文档图片放到网站仓库的 `public/`——那不是权威源，同步也不会带走
- 原图保持合理大小；构建会生成响应式变体

译本在图片没有文字时复用同一张共享图。截图里有本地化 UI 文字时，把该语种的图放进对应
locale 目录（例如 `en/images/...`），并让译本指向它。

`docs:validate` 只检查 `.mdx`，图片不会挡住校验。

### 浅色 / 深色变体

要按主题显示不同截图时，准备 `-light` / `-dark` 一对，并分别加上 `oc-light-only` /
`oc-dark-only`。网站已有对应 CSS（跟着 Starlight 的 `data-theme`），正确的那张会显示，
并跟随页内主题切换。

用 `<Image>` 组件，这样图片仍会被优化，同时能加 class。把 import 写在 frontmatter 下面：

```mdx
---
title: 安装
description: ...
---

import { Image } from "astro:assets";
import desktopLight from "./images/desktop-light.png";
import desktopDark from "./images/desktop-dark.png";

<Image src={desktopLight} alt="桌面应用" class="oc-light-only" />
<Image src={desktopDark} alt="桌面应用" class="oc-dark-only" />
```

说明：

- 两张图都和其他文档图片一样放在 `content/docs/`，同步方式相同
- 两张图用同一句 `alt`（并在译本里翻译）
- 只有一张图时，用普通的 `![alt](./path.png)` 即可

## 本地化

文档翻译成与 Piarium 应用相同的语言。**简体中文是源语言，放在 `content/docs/` 根目录。**
其他语言（包括英文）在各自的 locale 目录里镜像同一组文件名。

### 支持的语种

| 语言 | 内容目录 | 侧边栏 `translations` 键 |
| --- | --- | --- |
| 简体中文 | _（根目录，无文件夹）_ | _（写在 `label`，不要写 `zh-CN`）_ |
| English | `en/` | `en` |
| Українська | `uk/` | `uk` |
| Español | `es/` | `es` |
| Português (Brasil) | `pt-br/` | `pt-BR` |
| 한국어 | `ko/` | `ko` |
| Polski | `pl/` | `pl` |
| Français | `fr/` | `fr` |
| 日本語 | `ja/` | `ja` |

> [!IMPORTANT]
> **内容目录**用小写 locale 键（`en`、`pt-br`）；**侧边栏 `translations`** 用 BCP-47
> （`en`、`pt-BR`）。`pt-br` / `pt-BR` 看起来像，但不能互换——Starlight 用不同规则解析。
> 其余语种（`uk`、`es`、`ko`、`pl`、`fr`、`ja`、`en`）两列相同。

以后文档站的 `astro.config.mjs` `locales` 必须与此表一致，并且根 locale 为简体中文。
增删语言时两边一起改。

### 翻译一页

在每个 locale 目录下镜像中文文件，**文件名和相对路径必须完全相同**。Starlight 靠路径匹配译本。

```
content/docs/
  install.mdx              # 简体中文（源语言）
  en/install.mdx           # English
  uk/install.mdx           # Українська
  es/install.mdx           # Español
  pt-br/install.mdx        # Português (Brasil)
  ko/install.mdx           # 한국어
  pl/install.mdx           # Polski
  fr/install.mdx           # Français
  ja/install.mdx           # 日本語

  guides/tunnels.mdx       # 嵌套的中文页
  en/guides/tunnels.mdx    # 对应英文译本
```

每个译本都要有**自己的译文 frontmatter**（校验要求 `title` 和 `description`）：

```mdx
---
title: Install
description: Install Piarium for desktop, web, or VS Code.
---
```

新页面上线前必须补齐所有支持语种。Starlight 在缺译本时可能回退到中文，但新文档页不要依赖这个回退。

### 翻译侧边栏

**不要**为每种语言单独建侧边栏条目，也**不要**在 `link` 上加 locale 前缀——Starlight 会自动加。
在 `sidebar.config.json` 里给每个分组和条目加 `translations`（键用上表的 BCP-47）：

```json
{
  "label": "从这里开始",
  "translations": {
    "en": "Start here",
    "uk": "Почніть тут",
    "es": "Empieza aquí",
    "pt-BR": "Comece aqui",
    "ko": "여기서 시작",
    "pl": "Zacznij tutaj",
    "fr": "Commencer ici",
    "ja": "ここから開始"
  },
  "items": [
    {
      "label": "安装",
      "link": "/install/",
      "translations": {
        "en": "Install",
        "uk": "Встановлення",
        "es": "Instalación",
        "pt-BR": "Instalação",
        "ko": "설치",
        "pl": "Instalacja",
        "fr": "Installation",
        "ja": "インストール"
      }
    }
  ]
}
```

当前语种没有译文时，会回退到中文 `label`。

### 不要翻译这些

- 品牌和产品名：Piarium、Pi、VS Code、PWA、GitHub、Discord、macOS、SSH。只有在写第三方
  配额产品时才保留 `OpenCode Go`。不要重新引入 OpenChamber 或 OpenCode 服务器。
- 代码块、shell 命令、文件路径、flag 和配置键
- 页面文件名和侧边栏 `link`（各语种保持相同）

### 校验

`bun run docs:validate` 会遍历 `content/docs/` 下每一个 `.mdx`——**包括译本**——如果缺
`title` 或 `description`，或侧边栏 `link` 对不上默认（中文）页面，就会失败。加页或翻译后请运行它。

## 发布

目前还没有独立的文档站仓库或 `docs-source.yml` 工作流。先保证本包准确；`bun run docs:validate`
是当前门禁。以后加渲染器时，把 `content/docs/*` 和 `sidebar.config.json` 拷进去，并在
[DEPLOYMENT.md](DEPLOYMENT.md) 写明路径。
