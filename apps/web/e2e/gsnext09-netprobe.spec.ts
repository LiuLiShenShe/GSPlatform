/**
 * GS-NEXT-09 — capture failing network requests + viewer boot state on the
 * desktop scene page. Audit-only diagnostic; no product assertions.
 */
import { expect, test, chromium } from '@playwright/test';

const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5199';
const SCENE = process.env.PW_SCENE ?? 'fix02-semantics';

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl',
  '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
];

test('capture desktop scene network + boot state', async () => {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const responses: Array<{ status: number; url: string }> = [];
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) responses.push({ status: r.status(), url: r.url() });
  });
  page.on('requestfailed', (r) => failures.push(`${r.failure()?.errorText} ${r.url()}`));

  await page.goto(`/scene/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(45000);

  let diag: unknown = null;
  try {
    const t = await page.evaluate(() => document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
    diag = t ? JSON.parse(t) : null;
  } catch (e) { diag = `parse-error: ${e}`; }

  console.log('NET_JSON_START');
  console.log(JSON.stringify({
    canvasPresent: await page.evaluate(() => !!document.querySelector('canvas')),
    viewerPagePresent: await page.evaluate(() => !!document.querySelector('[data-testid="scene-viewer-page"]')),
    badResponses: responses.slice(0, 40),
    requestFailures: failures.slice(0, 20),
    diag,
  }, null, 2));
  console.log('NET_JSON_END');

  await context.close();
  await browser.close();
  expect(true).toBe(true);
});
