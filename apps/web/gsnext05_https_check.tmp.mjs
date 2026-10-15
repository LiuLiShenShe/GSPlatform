// 一次性取证脚本（不入库）：确认 HTTPS 隧道下 /xr 页面与 GS-NEXT-05 诊断读数可用。
import { chromium } from 'playwright';
const BASE = process.argv[2];
const SCENE = process.argv[3] ?? 'fix02-semantics';
const LAUNCH_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
  '--no-sandbox',
];
const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errs.push(`pageerror ${String(e).slice(0, 160)}`));
const t0 = Date.now();
await page.goto(`${BASE}/xr/${SCENE}`, { waitUntil: 'commit', timeout: 300000 });
await page.waitForSelector('[data-testid="xr-mount"]', { timeout: 300000 });
await page.waitForFunction(
  () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
  { timeout: 300000 },
);
const read = async (id) => (await page.getByTestId(id).textContent().catch(() => null))?.trim();
const out = {
  url: page.url(),
  secureContext: await page.evaluate(() => window.isSecureContext),
  userAgentIsMobile: await page.evaluate(() => /Android/i.test(navigator.userAgent)),
  loadedMs: Date.now() - t0,
  xrMenuState: await read('diag-xr-menu-state'),
  xrMenuInstalled: await read('diag-xr-menu-installed'),
  xrMenuDestinations: await read('diag-xr-menu-destinations'),
  xrMenuCurrent: await read('diag-xr-menu-current'),
  floorTeleport: await read('diag-xr-floor-teleport'),
  canStartVR: await read('diag-can-start-vr'),
  diagnostics: await page.evaluate(() => JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')?.textContent ?? '{}')),
};
console.log(JSON.stringify({ ...out, diagnostics: undefined, diagKeys: Object.keys(out.diagnostics ?? {}) }, null, 2));
console.log('viewpoints=', out.diagnostics?.viewpointCount, 'guidePoints=', out.diagnostics?.guidePointCount, 'gsplats=', out.diagnostics?.gsplats);
console.log('errors=', errs.slice(0, 5));
await browser.close();
