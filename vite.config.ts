import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'safari16',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000
  },
  server: { port: 5183 }
})
