# [MinTranslate.com](https://mintranslate.com)
> 中文 Readme 见 [Readme.zh.md](readme.zh.md)

<img width="500" align="right" src="/public/images/docs/homepage.png" alt="MinTranslate screenshot"/>

MinTranslate is a minimal translator app powered by **TanStack AI**. It runs translation requests **directly from your browser** to the AI Provider you configure (OpenAI / Anthropic / Gemini / Ollama).

> Note: MinTranslate does **not** proxy or store your translation text on a server by default. Provider settings and history are stored in your browser storage.

## Features

- Auto-translate as you type (debounced) + manual trigger (`⌘/Ctrl + Enter`)
- Multiple Providers:
  - OpenAI (optional Base URL for OpenAI-compatible endpoints)
  - Anthropic
  - Google Gemini
  - Ollama (local models, no API key required)
- Supported translation languages: `zh`, `en`, `fr`, `ja`, `es`
- Local translation history (`/history`) with export/clear
- Editable system prompt (`/settings`)
- Built-in docs (Fumadocs) and search API (`/docs`, `/api/search`)

## Tech Stack

- React 19 + Vite
- TanStack Start + TanStack Router (file-based routes)
- TanStack AI (provider adapters)
- TanStack Store + TanStack React DB (IndexedDB persistence for history)
- Tailwind CSS v4 + Radix UI (shadcn-style primitives)
- i18next (UI i18n)
- Vitest + Testing Library, Biome

## Getting Started (Local Dev)

Prerequisites:

- Bun (this repo uses `.bun-version`)

Run:

```bash
bun install
bun run dev
```

Then open `http://localhost:3000`.

For more details, see https://minTranslate.com/en/docs/development/contributing

## Contributors

<a href="https://github.com/bestony/mintranslate.com/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=bestony/mintranslate.com" />
</a>

Made with [contrib.rocks](https://contrib.rocks).

## License

AGPL-3.0. See `LICENSE`.
