import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import mdx from 'fumadocs-mdx/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import * as MdxConfig from './source.config'

const config = defineConfig({
  resolve: {
    alias: [{ find: /^ollama$/, replacement: 'ollama/browser' }],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/')

          if (normalizedId.includes('/src/components/ui/')) return 'ui-primitives'
          if (normalizedId.includes('/src/stores/')) return 'app-store'
          if (normalizedId.includes('/src/db/')) return 'app-db'

          if (!normalizedId.includes('/node_modules/')) return

          if (
            normalizedId.includes('/node_modules/react/') ||
            normalizedId.includes('/node_modules/react-dom/') ||
            normalizedId.includes('/node_modules/scheduler/')
          )
            return 'vendor-react'

          if (
            normalizedId.includes('/node_modules/@tanstack/react-router/') ||
            normalizedId.includes('/node_modules/@tanstack/router-core/') ||
            normalizedId.includes('/node_modules/@tanstack/router-generator/') ||
            normalizedId.includes('/node_modules/@tanstack/react-start/') ||
            normalizedId.includes('/node_modules/@tanstack/start-')
          )
            return 'vendor-tanstack-router'

          if (normalizedId.includes('/node_modules/@tanstack/react-db/'))
            return 'vendor-tanstack-db'

          if (normalizedId.includes('/node_modules/@tanstack/ai'))
            return 'vendor-tanstack-ai'

          if (
            normalizedId.includes('/node_modules/@tanstack/react-store/') ||
            normalizedId.includes('/node_modules/@tanstack/store/')
          )
            return 'vendor-tanstack-store'

          if (normalizedId.includes('/node_modules/@tanstack/')) return 'vendor-tanstack'
          if (normalizedId.includes('/node_modules/@radix-ui/')) return 'vendor-radix'

          if (
            normalizedId.includes('/node_modules/i18next/') ||
            normalizedId.includes('/node_modules/react-i18next/')
          )
            return 'vendor-i18n'

          if (
            normalizedId.includes('/node_modules/fumadocs-') ||
            normalizedId.includes('/node_modules/fumadocs-core/') ||
            normalizedId.includes('/node_modules/fumadocs-ui/')
          )
            return 'vendor-docs'

          if (
            normalizedId.includes('/node_modules/lucide-react/') ||
            normalizedId.includes('/node_modules/sonner/') ||
            normalizedId.includes('/node_modules/vaul/') ||
            normalizedId.includes('/node_modules/cmdk/') ||
            normalizedId.includes('/node_modules/embla-carousel-react/') ||
            normalizedId.includes('/node_modules/next-themes/')
          )
            return 'vendor-ui'
        },
      },
    },
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
    process.env.ANALYZE &&
      visualizer({
        open: true,
        brotliSize: true,
        filename: 'report.html',
      }),
  ],
})

export default config
