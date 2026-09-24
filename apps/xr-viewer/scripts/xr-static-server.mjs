/**
 * Lightweight HTTPS static server for the XR viewer production build.
 *
 * Serves:
 *   /                     -> apps/xr-viewer/dist  (production build)
 *   /local-scenes/<path>  -> scenes/ directory    (SOG/PLY/GLB/manifest, with Range support)
 *
 * Uses the same self-signed cert as the dev server (.certs/). Runs with a
 * small memory footprint so it survives Vite being OOM-killed on low-memory
 * hosts — this is the recommended way to serve the viewer for VR testing.
 *
 * Usage:  node scripts/xr-static-server.mjs  (then open https://<ip>:5180/...)
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const DIST = path.join(repoRoot, 'apps/xr-viewer/dist');
const SCENES = path.join(repoRoot, 'scenes');
const CERT = path.join(__dirname, '../.certs/cert.pem');
const KEY = path.join(__dirname, '../.certs/key.pem');
const PORT = Number(process.env.XR_SERVER_PORT ?? 5180);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.sog': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

function send(res, status, body, type, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type ?? MIME['.html'],
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  res.end(body);
}

function streamFile(res, filePath) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';

  // Range support (needed by SOG chunk streaming)
  const range = res.req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const size = stat.size;
      const start = m[1] === '' ? Math.max(0, size - Number(m[2] ?? 0)) : Number(m[1]);
      const end = m[2] === '' ? size - 1 : Number(m[2]);
      if (start < size && start <= end) {
        const e = Math.min(end, size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${e}/${size}`,
          'Content-Length': e - start + 1,
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath, { start, end: e }).pipe(res);
        return true;
      }
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return true;
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size,
    'Cache-Control': pagesNoCache(ext),
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function pagesNoCache(ext) {
  return ext === '.html' || ext === '.json' ? 'no-cache' : 'public, max-age=0';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Origin, Content-Type');
  res.setHeader('Vary', 'Origin');
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  try {
    // /local-scenes/* -> scenes/ tree (SOG / PLY / GLB / manifest)
    if (pathname.startsWith('/local-scenes/')) {
      const rel = pathname.slice('/local-scenes/'.length);
      const filePath = path.resolve(SCENES, rel);
      if (!filePath.startsWith(SCENES + path.sep) && filePath !== SCENES) {
        send(res, 403, 'Forbidden');
        return;
      }
      if (streamFile(res, filePath)) return;
      send(res, 404, 'Not found');
      return;
    }

    // fallback -> dist/ (SPA)
    let filePath = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(DIST + path.sep)) {
      send(res, 403, 'Forbidden');
      return;
    }
    if (!streamFile(res, filePath)) {
      // SPA fallback to index.html (same as Vite)
      streamFile(res, path.join(DIST, 'index.html') );
    }
  } catch (err) {
    send(res, 500, `Server error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

https.createServer(
  {
    cert: fs.readFileSync(CERT),
    key: fs.readFileSync(KEY),
  },
  (req, res) => server.emit('request', req, res),
).listen(PORT, '0.0.0.0', () => {
  console.log(`[xr-static] serving dist/ + scenes/ over HTTPS on https://0.0.0.0:${PORT} (pid ${process.pid})`);
});