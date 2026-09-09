import path from 'node:path'
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The viewer platform adapter is the only viewer source the web app
      // imports; it is pure TS with no PlayCanvas dependency.
      '@gsplatform/viewer': path.resolve(__dirname, '../viewer/src/platform'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})