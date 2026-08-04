import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer/offline'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/offline'),
    emptyOutDir: true,
    cssCodeSplit: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/offline/index.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'dashboard-viewer.js',
        chunkFileNames: 'dashboard-viewer-chunk-[hash].js',
        assetFileNames: 'dashboard-viewer.[ext]'
      }
    }
  }
})
