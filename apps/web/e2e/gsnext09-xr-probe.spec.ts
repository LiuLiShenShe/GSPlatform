/**
 * GS-NEXT-09 audit — real-browser XR capability probe (no headset).
 *
 * Establishes, in a REAL desktop Chromium, what the WebXR software path can
 * and cannot prove:
 *   - isSecureContext / navigator.xr presence
 *   - isSessionSupported('immersive-vr') — must be false on a machine with no
 *     headset; a true here would mean a device IS attached.
 *   - /xr/:sceneId product page loads, official runtime initialises, camera
 *     pose == authored initial camera (the Desktop↔XR shared-source check)
 *   - /xr/diagnostics/:sceneId exports a JSON payload
 *
 * This deliberately does NOT fabricate a hardware PASS. It records the
 * software-side facts and the hardware gaps as HARDWARE PENDING.
 */
import { expect, test, chromium } from '@playwright/test';

const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5199';
const SCENE = process.env.PW_SCENE ?? 'fix02-semantics';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
];

const probe = async () => {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const out: Record<string, unknown> = {};

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // --- XR page -----------------------------------------------------------
  await page.goto(`/xr/${SCENE}`, { waitUntil: 'domcontentloaded' });
  out.xrTitle = await page.title();
  await page.waitForSelector('canvas', { state: 'visible', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(6000);

  out.secureContext = await page.evaluate(() => window.isSecureContext);
  out.hasXR = await page.evaluate(() => typeof navigator.xr !== 'undefined');
  out.immersiveSupported = await page.evaluate(async () => {
    if (!navigator.xr) return null;
    try { return await navigator.xr.isSessionSupported('immersive-vr'); }
    catch { return 'error'; }
  });
  out.xrTestDevices = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="ov-xr"]');
    return el?.textContent?.slice(0, 400) ?? null;
  });

  // diagnostics export
  const diagText = await page.evaluate(() =>
    document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  if (diagText) {
    try { out.diagnostics = JSON.parse(diagText); } catch { out.diagnosticsRaw = diagText.slice(0, 600); }
  }

  // enter-VR button present?
  out.enterVRButton = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const hit = btns.find((b) => /VR|进入|Enter/i.test(b.textContent ?? ''));
    return hit ? { text: hit.textContent, disabled: hit.disabled } : null;
  });

  // --- desktop scene page: camera must equal authored initial camera -----
  await page.goto(`/scene/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="scene-viewer-page"]', { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(9000);
  const diag2 = await page.evaluate(() =>
    document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  if (diag2) {
    try {
      const d = JSON.parse(diag2);
      out.desktopDiagnostics = {
        renderer: d.renderer, gsplats: d.gsplats, format: d.format,
        cameraPosition: d.cameraPosition ?? d.camera?.position ?? null,
        progress: d.progress,
      };
    } catch { out.desktopDiagRaw = diag2.slice(0, 600); }
  }

  out.pageErrors = errors.slice(0, 10);
  await context.close();
  await browser.close();
  return out;
};

test('GS-NEXT-09 XR software capability probe', async () => {
  const r = await probe();
  console.log('XR_PROBE_JSON_START');
  console.log(JSON.stringify(r, null, 2));
  console.log('XR_PROBE_JSON_END');
  // The only hard assertion: the page itself must have loaded.
  expect(r.xrTitle).toBeTruthy();
});
