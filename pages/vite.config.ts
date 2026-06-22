import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  server: {
    proxy: {
      '/api': 'http://localhost:8789'
    }
  },
  build: {
    outDir: '../works/dist-client',
    emptyOutDir: true
  }
})
