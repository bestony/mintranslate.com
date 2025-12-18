# [MinTranslate.com](https://mintranslate.com)

<img width="500" align="right" src="/public/images/docs/homepage.png" alt="MinTranslate 截图"/>

MinTranslate 是一个由 **TanStack AI** 驱动的极简翻译应用。它会将翻译请求**直接从你的浏览器**发送到你配置的 AI 服务提供商（OpenAI / Anthropic / Gemini / Ollama）。

> 注意：默认情况下，MinTranslate **不会**通过服务器代理或存储你的翻译文本。服务提供商配置与历史记录会保存在你的浏览器存储中。

## 功能

- 输入即自动翻译（防抖）+ 手动触发（`⌘/Ctrl + Enter`）
- 多服务提供商支持：
  - OpenAI（可选 Base URL，用于 OpenAI 兼容的端点）
  - Anthropic
  - Google Gemini
  - Ollama（本地模型，无需 API key）
- 支持的翻译语言：`zh`, `en`, `fr`, `ja`, `es`
- 本地翻译历史（`/history`），支持导出/清空
- 可编辑 system prompt（`/settings`）
- 内置文档（Fumadocs）与搜索 API（`/docs`, `/api/search`）

## 技术栈

- React 19 + Vite
- TanStack Start + TanStack Router（基于文件的路由）
- TanStack AI（Provider 适配器）
- TanStack Store + TanStack React DB（翻译历史用 IndexedDB 持久化）
- Tailwind CSS v4 + Radix UI（shadcn 风格基础组件）
- i18next（UI 国际化）
- Vitest + Testing Library、Biome

## 快速开始（本地开发）

前置条件：

- Bun（本仓库使用 `.bun-version`）

运行：

```bash
bun install
bun run dev
```

然后打开 `http://localhost:3000`。

更多详情请见：https://minTranslate.com/en/docs/development/contributing

## 许可

AGPL-3.0。详见 `LICENSE`。
