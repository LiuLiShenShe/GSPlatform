import path from 'node:path'
import fs from 'node:fs'
import type { ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const publicDir = path.join(import.meta.dirname, 'public')

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}

/**
 * Serves the prebuilt SuperSplat viewer embed (`/viewer/*`) straight from disk.
 *
 * Vite dev's transform middleware interprets `.js` requests that use module
 * fetch semantics (`Sec-Fetch-Dest: script`) as source modules. The viewer
 * build in `public/viewer/` is a prebuilt artifact, not a Vite source module,
 * so those requests fall through to a 404. Intercepting the `/viewer/` prefix
 * before transform middleware routes every embed asset (embed.html, embed.js,
 * index.css, wasm, …) to the static file instead.
 */
const serveViewerEmbed = (): Plugin => ({
  name: 'gs-serve-viewer-embed',
  configureServer(server) {
    const sendStatic = (res: ServerResponse, url: string) => {
      // Connect strips the mount prefix (`/viewer`) from req.url, so
      // url arrives as `/embed.js`, not `/viewer/embed.js`.  Reconstruct
      // the full path under public/ by prepending `viewer`.
      const file = path.join(publicDir, 'viewer', url)
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return false
      }
      const ext = path.extname(file)
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
      res.statusCode = 200
      res.setHeader('Content-Type', mime)
      res.write(fs.readFileSync(file))
      res.end()
      return true
    }
    // Registered synchronously inside configureServer so this runs BEFORE
    // Vite's internal transform middleware. Vite interprets `.js` module
    // requests as source modules and 404s artifacts that are not in its
    // module graph; intercepting /viewer/* here short-circuits that.
    server.middlewares.use('/viewer', (req, res, next) => {
      const url = (req.url ?? '').split('?')[0]
      if (sendStatic(res, url)) return
      next()
    })
  },
})

export default defineConfig({
  plugins: [react(), serveViewerEmbed()],
  optimizeDeps: {
    // antd's locale files are CJS; without this Vite's optimizer skips them
    // and `antd/locale/zh_CN` 404s on a cold dev start.
    include: ['antd/locale/zh_CN'],
  },
  resolve: {
    alias: {
      // The viewer platform adapter is the only viewer source the web app
      // imports; it is pure TS with no PlayCanvas dependency.
      '@gsplatform/viewer': path.resolve(import.meta.dirname, '../viewer/src/platform'),
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