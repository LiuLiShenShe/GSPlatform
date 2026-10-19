/** GS-NEXT-09 audit probe: which viewer UI controls actually exist on /scene/:s. */
import { expect, test, chromium } from '@playwright/test';
const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5199';
const SCENE = process.env.PW_SCENE ?? 'fix02-semantics';
const ARGS = ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-webgpu'];
test('viewer ui controls probe', async () => {
  test.setTimeout(200000);
  const b = await chromium.launch({ headless: true, args: ARGS });
  const c = await b.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const p = await c.newPage();
  await p.goto(`/scene/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-testid="scene-viewer-page"]', { timeout: 60000 }).catch(()=>{});
  await p.waitForTimeout(25000);
  const ids = ['ov-frame','ov-reset','ov-saved-views','ov-diagnostics','ov-walk','ov-performance'];
  const out: Record<string, unknown> = {};
  for (const id of ids) out[id] = await p.locator(`[data-testid="${id}"]`).count().catch(()=>-1);
  out.buttons = await p.evaluate(() => Array.from(document.querySelectorAll('button')).map(b=>b.textContent?.trim()).filter(Boolean).slice(0,25));
  const diag0 = await p.evaluate(()=>document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.cam0 = diag0 ? JSON.parse(diag0).camera : null;
  // try frame
  const f = p.locator('[data-testid="ov-frame"]');
  if (await f.count()) { await f.first().click().catch(()=>{}); await p.waitForTimeout(2500); }
  const diagF = await p.evaluate(()=>document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.camAfterFrame = diagF ? JSON.parse(diagF).camera : null;
  const r = p.locator('[data-testid="ov-reset"]');
  if (await r.count()) { await r.first().click().catch(()=>{}); await p.waitForTimeout(2500); }
  const diagR = await p.evaluate(()=>document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.camAfterReset = diagR ? JSON.parse(diagR).camera : null;
  console.log('VIEWERUI_START'); console.log(JSON.stringify(out,null,2)); console.log('VIEWERUI_END');
  await c.close().catch(()=>{}); await b.close().catch(()=>{});
  expect(true).toBe(true);
});
