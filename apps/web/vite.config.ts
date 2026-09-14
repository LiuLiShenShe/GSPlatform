import path from 'node:path'
import fs from 'node:fs'
import type { ServerResponse, IncomingMessage } from 'node:http'
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
  '.webp': 'image/webp',
  '.sog': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.spz': 'application/octet-stream',
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
    //
    // NOTE: mount at root and match the prefix manually — Vite 8's Connect
    // stack doesn't dispatch path-prefix mounts (`use('/viewer', …)` never
    // fires), so the same pattern as gs-serve-streamed-scenes is used here.
    server.middlewares.use((req, res, next) => {
      const rawUrl = (req.url ?? '')
      if (!rawUrl.startsWith('/viewer/')) { next(); return }
      const url = rawUrl.replace(/^\/viewer/, '').split('?')[0]
      if (sendStatic(res, url)) return
      next()
    })
  },
})

/**
 * Serves streamed-SOG scene assets (`/local-scenes/*`) straight from the
 * git-ignored `scenes/` tree on disk, with REAL HTTP Range semantics.
 *
 * Why not rely on Vite's static `public/` serving?
 *   1. The scene's `current` symlink points into a versioned subdirectory;
 *      `cpSync` copies it as an absolute link that escapes Vite's public
 *      root, so the SPA fallback answers `200 text/html` instead of the file.
 *   2. Phase 04 requires the origin to truthfully support Range: 206 with
 *      correct Content-Range, 416 for invalid ranges, HEAD with length, and
 *      byte streams that never return the whole file for a partial request.
 *
 * This middleware answers `/local-scenes/<sceneId>/<rel>` directly from
 * `scenes/<sceneId>/<rel>`, following the `current` symlink, and implements
 * single-range requests (the only form splat-transform's UrlReadFileSystem
 * issues). Multi-range is answered with 416 (unsupported) rather than a
 * silently-wrong body — the upstream client never sends it.
 */
const serveStreamedScenes = (): Plugin => {
  const scenesRoot = path.resolve(import.meta.dirname, '../../scenes')

  const parseRange = (header: string, size: number) => {
    // Only a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix`
    // range is supported. Anything else returns null (→ 416).
    const m = /^bytes=(\d*)-(\d*)$/.exec(header)
    if (!m) return null
    const [, startStr, endStr] = m
    if (startStr === '' && endStr === '') return null
    let start: number
    let end: number
    if (startStr === '') {
      // suffix range: last N bytes
      const suffix = Number(endStr)
      if (!Number.isFinite(suffix) || suffix <= 0) return null
      start = Math.max(0, size - suffix)
      end = size - 1
    } else {
      start = Number(startStr)
      end = endStr === '' ? size - 1 : Number(endStr)
      if (!Number.isFinite(start) || (endStr !== '' && !Number.isFinite(end))) return null
      if (start > end || start >= size) return null // unsatisfiable → 416
      end = Math.min(end, size - 1)
    }
    return { start, end }
  }

  const send = (req: IncomingMessage, res: ServerResponse, file: string, stat: fs.Stats, rel: string) => {
    const ext = path.extname(file)
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
    const rangeHeader = (req.headers.range as string | undefined) ?? ''

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', mime)

    // CORS (checklist F4): dev-only, restricted to local frontend origins.
    // Same-origin page loads need no CORS at all; cross-origin fetches from
    // any non-localhost origin get no ACAO header and are refused by the
    // browser. This mirrors the prod nginx `scenes-streaming.conf` allowlist.
    const origin = req.headers.origin as string | undefined
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Origin, Content-Type')

    // Cache policy (checklist F3): the business manifest lives at a stable
    // path (`current/manifest.json`) so it gets a short cache; everything
    // under a content-hashed `versions/<sha>/` dir is immutable by
    // construction (a new build lands in a new dir, `current` is repointed).
    const isManifest = path.basename(rel) === 'manifest.json'
    res.setHeader(
      'Cache-Control',
      isManifest ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    )

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // Without a Range header: full 200 (still Accept-Ranges advertised).
    if (!rangeHeader) {
      res.statusCode = 200
      res.setHeader('Content-Length', stat.size)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      fs.createReadStream(file).pipe(res)
      return
    }

    const range = parseRange(rangeHeader, stat.size)
    if (!range) {
      // 416: Range Not Satisfiable, with the actual file size.
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${stat.size}`)
      res.end()
      return
    }
    const { start, end } = range
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
    res.setHeader('Content-Length', end - start + 1)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(file, { start, end }).pipe(res)
  }

  return {
    name: 'gs-serve-streamed-scenes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Mount at root and manually match /local-scenes prefix to avoid
        // potential issues with Connect path-prefix matching in Vite 8.
        const rawUrl = (req.url ?? '')
        if (!rawUrl.startsWith('/local-scenes/')) { next(); return }
        // Strip the /local-scenes prefix; Connect does NOT strip for root mounts.
        const url = rawUrl.replace(/^\/local-scenes/, '').split('?')[0]
        // Resolve sceneId + rel, refusing any path escaping the scenes root.
        const segments = url.split('/').filter(Boolean)
        if (segments.length === 0) {
          next()
          return
        }
        const sceneId = decodeURIComponent(segments[0])
        const rel = segments.slice(1).map(decodeURIComponent).join('/')
        const resolved = path.resolve(scenesRoot, sceneId, rel)
        const safe = resolved.startsWith(path.resolve(scenesRoot, sceneId) + path.sep)
        if (!safe) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        let stat: fs.Stats
        try {
          stat = fs.statSync(resolved) // follows the `current` symlink
        } catch {
          next() // let Vite's SPA fallback / 404 handle it
          return
        }
        if (!stat.isFile()) {
          next()
          return
        }
        send(req, res, resolved, stat, rel)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), serveViewerEmbed(), serveStreamedScenes()],
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