import path from 'node:path'
import fs from 'node:fs'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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

// DEV ONLY — the scene asset root for local development.
//
// This middleware answers `/local-scenes/<sceneId>/<rel>` straight from the
// git-ignored `scenes/` tree.  It is a *development* convenience: production
// serves scene bytes through the API's authorized `/api/v1/scenes/.../assets`
// endpoint (FastAPI policy + Nginx X-Accel-Redirect); Nginx has NO public
// `/local-scenes/` alias.  The repo-level dev scenes that have no DB row
// (local-garden / ssv08-*) keep working here, and this middleware is hardened
// exactly like the API path so a dev server can never serve files it should
// not (FIX-01 P0-2).
//
// Security model (FIX-01 §8-§10):
//   1. The sceneId must match the same slug grammar the API accepts —
//      `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.  Anything else → 403.
//   2. URL-encoded components are decoded exactly once; a value that still
//      contains `%` after that (double-encoding) or any `%`/`\`/NUL is
//      rejected with 400 — no second decode is ever performed.
//   3. Path containment is verified with `fs.realpathSync` on the final
//      target against the real scene root (and the real published-storage
//      root, because `versions/<ver>` legitimately symlinks into it), using a
//      component-aware check — never a bare `startsWith`.
//   4. Range semantics: 206 + Content-Range, 416 for invalid ranges, HEAD
//      with length, and byte streams that never return the whole file for a
//      partial request.
const serveStreamedScenes = (): Plugin => {
  const scenesRoot = path.resolve(import.meta.dirname, '../../scenes')
  // Mirrors the API's settings.storage_root / GS_STORAGE_ROOT (dev default),
  // where published versions live; `scenes/<slug>/versions/<ver>` symlinks
  // point there.  Only `<storage>/published` is trusted.
  const publishedRoot = path.resolve(
    process.env.GS_STORAGE_ROOT ?? '/home/test/gsplatform-data',
    'published',
  )

  const SCENE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

  /** Decode a percent-encoded component exactly once; null on any error. */
  const decodeOnce = (raw: string): string | null => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }

  /** Component-aware containment: *child* inside *parent* (or equal). */
  const isWithin = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  const reject = (res: ServerResponse, code: number) => {
    res.statusCode = code
    res.end('forbidden')
  }

  // Accepted range → { start, end }, null → 416 (invalid / multi-range).
  const parseRange = (header: string, size: number) => {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header)
    if (!m) return null
    const [, startStr, endStr] = m
    if (startStr === '' && endStr === '') return null
    let start: number
    let end: number
    if (startStr === '') {
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

    // CORS (dev-only): restricted to local frontend origins; mirrors prod nginx.
    const origin = req.headers.origin as string | undefined
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Origin, Content-Type')

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
        const rawUrl = req.url ?? ''
        if (!rawUrl.startsWith('/local-scenes/')) { next(); return }
        const url = rawUrl.replace(/^\/local-scenes/, '').split('?')[0]
        const segments = url.split('/').filter(Boolean)
        if (segments.length === 0) { next(); return }

        // 1) sceneId: slug grammar + single decode.  Anything else is a
        //    traversal/encoding attack → 403 (mirrors the API policy).
        const sceneId = decodeOnce(segments[0])
        if (sceneId === null || !SCENE_SLUG_RE.test(sceneId)) {
          reject(res, 403)
          return
        }

        // 2) rel segments: single decode; reject remaining `%` (double
        //    encoding), separators, `.`/`..`, decoded slashes and NUL → 400.
        const relSegments: string[] = []
        for (const seg of segments.slice(1)) {
          const decoded = decodeOnce(seg)
          if (
            decoded === null ||
            decoded === '' ||
            decoded === '.' ||
            decoded === '..' ||
            decoded.includes('%') ||
            decoded.includes('/') ||
            decoded.includes('\\') ||
            decoded.includes('\u0000')
          ) {
            reject(res, 400)
            return
          }
          relSegments.push(decoded)
        }
        const rel = relSegments.join('/')

        // 3) realpath containment (FIX-01 §9).  The scene dir and the target
        //    are both fully resolved first, then the final real path is
        //    verified against the trusted roots component-wise.  Failures
        //    are REJECTED (never the SPA fallback): a traversal attempt or a
        //    missing asset under /local-scenes must not answer 200.
        let realSceneRoot: string
        try {
          realSceneRoot = fs.realpathSync(path.join(scenesRoot, sceneId))
        } catch {
          reject(res, 404)
          return
        }
        const resolved = path.resolve(realSceneRoot, rel)
        let realResolved: string
        try {
          realResolved = fs.realpathSync(resolved)
        } catch {
          reject(res, 404)
          return
        }

        const trusted: string[] = [realSceneRoot]
        try {
          const realPublished = fs.realpathSync(publishedRoot)
          if (!trusted.includes(realPublished)) trusted.push(realPublished)
        } catch {
          /* storage root missing in dev — scene root is the only trust anchor */
        }
        if (!trusted.some((root) => isWithin(realResolved, root))) {
          // Symlink escape: /etc, a sibling scene, anywhere else.
          reject(res, 403)
          return
        }

        let stat: fs.Stats
        try {
          stat = fs.statSync(realResolved) // no further symlink to follow
        } catch {
          reject(res, 404)
          return
        }
        if (!stat.isFile()) {
          reject(res, 404)
          return
        }
        send(req, res, realResolved, stat, rel)
      })
    },
  }
}

// The Cloudflare quick tunnel (Quest/PICO WebXR real-device debugging) must be
// OPT-IN: it makes the dev origin reachable from the public internet, so it is
// gated behind GS_ENABLE_DEV_TUNNEL=1.  Never default it on, never use
// `allowedHosts: true` (FIX-01 P0-2).  Production is Nginx + a real domain —
// untouched by this flag.
const devTunnelEnabled = process.env.GS_ENABLE_DEV_TUNNEL === '1'

export default defineConfig({
  plugins: [react(), serveStreamedScenes()],
  optimizeDeps: {
    // antd's locale files are CJS; without this Vite's optimizer skips them
    // and `antd/locale/zh_CN` 404s on a cold dev start.
    include: ['antd/locale/zh_CN'],
  },
  server: {
    port: 5173,
    strictPort: false,
    // DEVELOP ONLY —— 把 `/api/*` 代理到本地 FastAPI (:8001)，与生产（Nginx
    // 同源 /api）路由一致。FIX-01 把场景资产迁到授权的
    // `/api/v1/scenes/<slug>/assets/...` 之后，官方 viewer 按相对 URL 请求它们；
    // 没有该代理时 Vite 的 SPA fallback 会对每个 /api 路径回 200 HTML，DB 场景
    // 在 dev 浏览器里永远加载不出来（e2e §19 依赖此代理）。
    // 应用自身走 http.ts 的绝对 :8001 + CORS，不经此代理，互不影响。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: false,
      },
    },
    // DEV ONLY tunnel gate (see comment above).
    allowedHosts: devTunnelEnabled ? ['.trycloudflare.com'] : undefined,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})