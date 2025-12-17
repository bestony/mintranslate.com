import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import mdx from 'fumadocs-mdx/vite'
import * as MdxConfig from './source.config'

const config = defineConfig({
  resolve: {
    alias: [{ find: /^ollama$/, replacement: 'ollama/browser' }],
  },
  plugins: [
    devtools(),
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    mdx(MdxConfig),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
