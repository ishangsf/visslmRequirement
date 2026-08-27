import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const SVAR_REMOTE_FONT_URL = 'https://cdn.svar.dev/fonts/'
const SVAR_REMOTE_FONT_FACE = /@font-face\s*\{[^{}]*https:\/\/cdn\.svar\.dev\/fonts\/[^{}]*\}/g

function stripSvarRemoteFontFaces(): Plugin {
  return {
    name: 'strip-svar-remote-font-faces',
    enforce: 'pre',
    transform(source, id) {
      const cleanId = id.split('?', 1)[0]
      if (!cleanId.endsWith('.css') || !id.includes('@svar-ui') || !source.includes(SVAR_REMOTE_FONT_URL)) {
        return null
      }

      const sanitized = source.replace(SVAR_REMOTE_FONT_FACE, '')
      if (sanitized.includes(SVAR_REMOTE_FONT_URL)) {
        throw new Error(`Unable to remove every SVAR remote font reference from ${id}`)
      }

      return {
        code: sanitized,
        map: null
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'database-bootstrap-worker': resolve(__dirname, 'src/main/database-bootstrap-worker.ts'),
          'embedding-worker': resolve(__dirname, 'src/main/embedding-worker.ts')
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [stripSvarRemoteFontFaces(), react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replaceAll('\\', '/')
            if (normalizedId.includes('/src/renderer/src/dashboard/DashboardStudio.')) {
              return 'page-dashboard-studio'
            }
            if (normalizedId.includes('/src/renderer/src/project-management/ProjectManagementPage.')) {
              return 'page-project-management'
            }
            if (normalizedId.includes('/node_modules/echarts/')) {
              return 'vendor-echarts'
            }
            if (normalizedId.includes('/node_modules/react-markdown/') || normalizedId.includes('/node_modules/remark-gfm/')) {
              return 'vendor-markdown'
            }
            return undefined
          }
        }
      }
    },
    server: {
      host: '127.0.0.1'
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    }
  }
})
