/** GS-NEXT-09 audit probe: which viewer UI controls actually exist on /scene/:s. */
import { expect, test } from '@playwright/test';
import { LAUNCH_OPTIONS } from './fresh-browser';
// GS-DESKTOP-02：base 必须与 playwright.config.ts 一致（旧默认 :5199 已不存在，
// 会导致探针打开空白页并在软件渲染下崩溃）。允许 PW_BASE_URL 覆盖。
const BASE = process.env.PW_BASE_URL ?? 'http://localhost:5173';
const SCENE = process.env.PW_SCENE ?? 'fix02-semantics';
test('viewer ui controls probe', async ({ browser }) => {
  test.setTimeout(200000);
  // 复用共享 LAUNCH_OPTIONS：必须用完整 Chromium 且带 --disable-gpu-compositing，
  // 否则官方 Viewer 进入按需渲染后冻结/崩溃（GS-NEXT-10 根因）。
  const b = await browser.browserType().launch(LAUNCH_OPTIONS);
  const c = await b.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const p = await c.newPage();
  await p.goto(`/scene/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-testid="scene-viewer-page"]', { timeout: 60000 }).catch(()=>{});
  await p.waitForTimeout(25000);
  // GS-DESKTOP-02：官方原生控件 class 取代宿主 ov-* data-testid。
  const ids = ['.sse-frame','.sse-reset','.sse-settings','[data-testid="ov-diagnostics"]','.sse-fpsCamera','.sse-enterFullscreen'];
  const out: Record<string, unknown> = {};
  for (const id of ids) out[id] = await p.locator(id).count().catch(()=>-1);
  out.buttons = await p.evaluate(() => Array.from(document.querySelectorAll('button')).map(b=>b.textContent?.trim()).filter(Boolean).slice(0,25));
  const diag0 = await p.evaluate(()=>document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.cam0 = diag0 ? JSON.parse(diag0).camera : null;
  // try frame
  await p.locator('.sse-settings').first().click({ timeout: 5000 }).catch(()=>{});
  await p.waitForTimeout(400);
  const f = p.locator('.sse-frame');
  if (await f.count()) { await f.first().click().catch(()=>{}); await p.waitForTimeout(2500); }
  const diagF = await p.evaluate(()=>document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.camAfterFrame = diagF ? JSON.parse(diagF).camera : null;
  const r = p.locator('.sse-reset');
  if (await r.count()) { await r.first().click().catch(()=>{}); await p.waitForTimeout(2500); }
  const diagR = await p.evaluate(()=>document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.camAfterReset = diagR ? JSON.parse(diagR).camera : null;
  console.log('VIEWERUI_START'); console.log(JSON.stringify(out,null,2)); console.log('VIEWERUI_END');
  await c.close().catch(()=>{}); await b.close().catch(()=>{});
  expect(true).toBe(true);
});
