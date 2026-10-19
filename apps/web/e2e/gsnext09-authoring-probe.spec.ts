/**
 * GS-NEXT-09 — authoring page (/model/edit/:scene) software probe.
 *
 * Determines, in a real browser:
 *   - does the authoring page load ("Viewer 就绪" + canvas)?
 *   - is the Save-initial-view control present?
 *   - does the renderer survive, or crash (SwiftShader WebGPU)?
 * Audit-only; no product assertions.
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

test('authoring page probe', async () => {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  let crashed = false;
  page.on('crash', () => { crashed = true; });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

  const out: Record<string, unknown> = {};
  await page.goto(`/model/edit/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  out.authoringPage = await page.evaluate(() => !!document.querySelector('[data-testid="scene-authoring-page"]'));
  out.viewerReadyText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).some((e) => e.textContent === 'Viewer 就绪'));
  out.canvas = await page.evaluate(() => !!document.querySelector('[data-testid="scene-authoring-page"] canvas'));
  out.saveButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .map((b) => b.textContent)
      .filter((t) => /视角|保存|更新/.test(t ?? ''))
      .slice(0, 8));

  // exercise the canvas a little
  const box = await page.locator('[data-testid="scene-authoring-page"] canvas').boundingBox().catch(() => null);
  if (box) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    try {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(500);
      await page.mouse.down();
      await page.mouse.move(cx - 60, cy + 30, { steps: 8 });
      await page.mouse.up();
      out.interactionSurvived = true;
    } catch (e) {
      out.interactionSurvived = `failed: ${e}`;
    }
  }

  await page.waitForTimeout(3000);
  out.crashed = crashed;
  out.pageErrors = errs.slice(0, 8);
  out.aliveAtEnd = !page.isClosed();

  console.log('AUTHZ_PROBE_START');
  console.log(JSON.stringify(out, null, 2));
  console.log('AUTHZ_PROBE_END');

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  expect(true).toBe(true);
});
