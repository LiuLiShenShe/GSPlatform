/** GS-NEXT-09: capture /xr/diagnostics/:scene real DOM diagnostics evidence. */
import { expect, test, chromium } from '@playwright/test';
const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5174';
const ARGS = ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-webgpu','--enable-features=Vulkan'];
const scenes = (process.env.PW_SCENES ?? 'u-a68b94d84538,u-c71ec45417a0').split(',');
for (const scene of scenes) {
  test(`xr diagnostics ${scene}`, async () => {
    test.setTimeout(240000);
    const b = await chromium.launch({ headless: true, args: ARGS });
    const c = await b.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
    const p = await c.newPage();
    await p.goto(`/xr/diagnostics/${scene}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(30000);
    const rows = await p.evaluate(() => {
      const o: Record<string,string> = {};
      document.querySelectorAll('[data-testid]').forEach((e) => {
        const id = e.getAttribute('data-testid')!;
        if (/^diag-|ov-xr/.test(id)) o[id] = (e.textContent ?? '').slice(0, 400);
      });
      return o;
    });
    console.log(`XRDIAG_START ${scene}`); console.log(JSON.stringify(rows, null, 2)); console.log('XRDIAG_END');
    await c.close().catch(()=>{}); await b.close().catch(()=>{});
    expect(true).toBe(true);
  });
}
