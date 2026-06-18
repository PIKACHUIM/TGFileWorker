import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
