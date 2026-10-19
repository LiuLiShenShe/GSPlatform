/**
 * GS-NEXT-09 — large streamed-sog scene (historical Building) real-browser
 * load + streaming + performance probe. Audit-only, no product assertions.
 *
 * Scene: u-c71ec45417a0 — streamed-sog, 13,090,324 gaussians, 7 LOD levels,
 * 373 chunks (see docs/reports/GS_NEXT_06_BUILDING_REUPLOAD_AB.md).
 */
import { expect, test, chromium } from '@playwright/test';

const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5199';
const SCENE = process.env.PW_SCENE ?? 'u-c71ec45417a0';

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl',
  '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
];

test('large streamed-sog load probe', async () => {
  test.setTimeout(600_000);
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const chunkRequests: string[] = [];
  const bad: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes(`/scenes/${SCENE}/assets/`) && /\.(webp|json)$/.test(u)) chunkRequests.push(new URL(u).pathname);
  });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(0, 160)}`); });

  const started = Date.now();
  await page.goto(`/scene/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="scene-viewer-page"]', { timeout: 120_000 }).catch(() => {});
  await page.waitForSelector('canvas', { state: 'visible', timeout: 120_000 }).catch(() => {});

  // Poll the diagnostics node until the official runtime has real gaussians.
  let diag: Record<string, unknown> | null = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() =>
      document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
    if (txt) {
      try {
        const d = JSON.parse(txt);
        if ((d.gsplats ?? 0) > 0 && (d.progress ?? 0) > 0) { diag = d; break; }
      } catch { /* keep polling */ }
    }
    await page.waitForTimeout(3000);
  }
  const elapsed = Date.now() - started;

  console.log('LARGE_PROBE_START');
  console.log(JSON.stringify({
    scene: SCENE,
    elapsedMs: elapsed,
    chunkRequests: chunkRequests.length,
    sampleChunks: chunkRequests.slice(0, 5),
    lodMetaRequested: chunkRequests.some((p) => p.endsWith('lod-meta.json')),
    badResponses: bad.slice(0, 10),
    diag: diag ? {
      renderer: diag.renderer, gsplats: diag.gsplats, format: diag.format,
      progress: diag.progress, loaded: diag.loaded, error: diag.error,
      performanceMode: diag.performanceMode,
      cameraPosition: (diag.camera as { position?: unknown } | undefined)?.position ?? null,
      contentUrl: diag.contentUrl,
    } : null,
  }, null, 2));
  console.log('LARGE_PROBE_END');

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  expect(true).toBe(true);
});
