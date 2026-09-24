import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves streamed-SOG scene assets (`/local-scenes/*`) straight from the
 * git-ignored `scenes/` tree on disk, with HTTP Range support.
 */
const serveLocalScenes = (): Plugin => {
  const scenesRoot = path.resolve(__dirname, '../../scenes')

  return {
    name: 'gs-xr-serve-local-scenes',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '')
        if (!url.startsWith('/local-scenes/')) {
          next()
          return
        }

        // Strip the prefix and resolve against the scenes directory
        const rel = url.replace(/^\/local-scenes\//, '').split('?')[0]
        const filePath = path.join(scenesRoot, rel)

        // Follow symlinks (the `current` symlink points to version dirs)
        let stat: fs.Stats
        try {
          stat = fs.lstatSync(filePath)
          if (stat.isSymbolicLink()) {
            const link = fs.readlinkSync(filePath)
            stat = fs.statSync(path.resolve(path.dirname(filePath), link))
          }
        } catch {
          next()
          return
        }

        if (stat.isDirectory()) {
          next()
          return
        }

        const ext = path.extname(filePath)
        const mimeMap: Record<string, string> = {
          '.json': 'application/json',
          '.sog': 'application/octet-stream',
          '.ply': 'application/octet-stream',
          '.splat': 'application/octet-stream',
          '.glb': 'model/gltf-binary',
          '.jpg': 'image/jpeg',
          '.png': 'image/png',
        }
        const mime = mimeMap[ext] ?? 'application/octet-stream'

        // CORS for local development
        const origin = req.headers.origin as string | undefined
        if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin)
          res.setHeader('Vary', 'Origin')
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Origin, Content-Type')
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Type', mime)

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }

        // Range request support
        const rangeHeader = (req.headers.range as string | undefined) ?? ''
        if (rangeHeader) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
          if (m) {
            const size = stat.size
            const startStr = m[1]
            const endStr = m[2]
            let start: number
            let end: number
            if (startStr === '') {
              start = Math.max(0, size - Number(endStr))
              end = size - 1
            } else {
              start = Number(startStr)
              end = endStr === '' ? size - 1 : Number(endStr)
            }
            if (start <= end && start < size) {
              end = Math.min(end, size - 1)
              res.statusCode = 206
              res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
              res.setHeader('Content-Length', end - start + 1)
              const stream = fs.createReadStream(filePath, { start, end })
              stream.pipe(res)
              return
            }
          }
          // Unsatisfiable range
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${stat.size}`)
          res.end()
          return
        }

        // Full response
        res.setHeader('Content-Length', stat.size)
        const stream = fs.createReadStream(filePath)
        stream.pipe(res)
      })
    },
  }
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
  },
  server: {
    port: 5180,
    strictPort: false,
    fs: {
      strict: false,
    },
    // WebXR requires a secure context; serve HTTPS with a local self-signed
    // cert so headsets can enter VR from non-localhost IPs (e.g. LAN).
    https: {
      key: fs.readFileSync(path.resolve(__dirname, '.certs/key.pem')),
      cert: fs.readFileSync(path.resolve(__dirname, '.certs/cert.pem')),
    },
  },
  plugins: [serveLocalScenes()],
})
