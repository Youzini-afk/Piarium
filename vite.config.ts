import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { themeStoragePlugin } from './vite-theme-plugin'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const packageNameFromModuleId = (id: string): string | null => {
  const normalized = id.replace(/\\/g, '/')
  const match = normalized.split('node_modules/').at(-1)
  if (!match) return null
  const segments = match.split('/')
  return match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0] || null
}

export default defineConfig({
  plugins: [
    react(),
    themeStoragePlugin(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        manualChunks(id) {
          if (id.includes('vite/preload-helper')) return 'vite-preload-helper'
          if (!id.includes('node_modules')) return undefined

          const packageName = packageNameFromModuleId(id)
          if (!packageName) return undefined

          if (
            packageName === '@shikijs/langs' ||
            packageName === '@shikijs/themes' ||
            packageName === '@codemirror/legacy-modes' ||
            packageName === '@pierre/diffs'
          ) {
            return undefined
          }

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react'
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand'
          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown'
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui'
          if (packageName.includes('react-syntax-highlighter') || packageName.includes('highlight.js')) return 'vendor-syntax'

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-')
          return `vendor-${sanitized}`
        },
      },
    },
  },
})
