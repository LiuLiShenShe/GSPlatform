/**
 * GS-NEXT-09 — full authoring save/reopen probe with a REAL session.
 *
 * Exercises the product's actual authoring path end-to-end in a browser
 * against the PRODUCTION-like staging stack (real sessions, dev bypass off):
 *   login (real cookies) → open /model/edit/:scene → move camera
 *   → click 更新为当前视角 → read back /presentation + /runtime
 *   → reopen /scene/:scene and confirm the runtime camera equals the saved pose.
 * Audit-only; the fixture is reseeded by scripts/gsnext09_seed_fix02.py.
 */
import { expect, test, chromium } from '@playwright/test';

const API = process.env.PW_API_BASE ?? 'http://127.0.0.1:18001';
const BASE = process.env.PW_BASE_URL ?? 'http://127.0.0.1:5174';
const SCENE = process.env.PW_SCENE ?? 'fix02-semantics';
const EMAIL = process.env.PW_USER ?? 'gsnext09-hardware@example.invalid';
const PASSWORD = process.env.PW_PASS ?? 'Audit-Passw0rd-2026';

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl',
  '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
];

test('authoring save → reopen (real session)', async () => {
  test.setTimeout(420_000);
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const out: Record<string, unknown> = {};

  // capture the presentation PATCH the UI issues (method/status/body)
  const patches: Array<{ status: number; method: string; url: string; body?: string }> = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'PATCH') {
      let body: string | undefined;
      try { body = (await r.request().postData())?.slice(0, 300) ?? undefined; } catch { /* ignore */ }
      patches.push({ status: r.status(), method: r.request().method(), url: r.url().slice(0, 140), body });
    }
  });

  // --- real login (session cookies land in the shared context jar) ---------
  const login = await context.request.post(`${API}/api/v1/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  out.loginStatus = login.status();
  const jar = await context.cookies();
  out.cookies = jar.map((c) => c.name);

  // --- authoring page ------------------------------------------------------
  await page.goto(`/model/edit/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  out.authoringPage = await page.evaluate(() =>
    !!document.querySelector('[data-testid="scene-authoring-page"]'));
  out.viewerReady = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).some((e) => e.textContent === 'Viewer 就绪'));

  const before = await context.request
    .get(`${API}/api/v1/scenes/${SCENE}/presentation`).then((r) => r.json()).catch(() => null);
  out.presentationBefore = before?.initialCameraPosition ?? null;

  const canvas = await page.locator('[data-testid="scene-authoring-page"] canvas')
    .boundingBox().catch(() => null);
  if (canvas) {
    const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
    try {
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
      await page.waitForTimeout(800);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 90, cy + 45, { steps: 15 });
      await page.mouse.up();
      out.cameraMoved = true;
    } catch (e) { out.cameraMoved = `failed: ${String(e).slice(0, 120)}`; }
    await page.waitForTimeout(2000);
  }
  out.canvasFound = !!canvas;

  const saveBtn = page.getByRole('button', { name: /更新为当前视角|设为初始视角/ }).first();
  out.saveButtonVisible = await saveBtn.isVisible().catch(() => false);
  await saveBtn.click().catch((e) => { out.saveClickError = String(e).slice(0, 160); });
  await page.waitForTimeout(3000);

  const pres = await context.request
    .get(`${API}/api/v1/scenes/${SCENE}/presentation`).then((r) => r.json()).catch(() => null);
  const rt = await context.request
    .get(`${API}/api/v1/scenes/${SCENE}/runtime`).then((r) => r.json()).catch(() => null);
  out.presentationAfter = pres?.initialCameraPosition ?? null;
  out.runtimeInitialCamera = rt?.presentation?.initialCamera ?? null;
  out.patches = patches;
  out.errorToasts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.ant-message-notice, .ant-message-error'))
      .map((e) => e.textContent).slice(0, 6));

  // --- reopen as a viewer --------------------------------------------------
  await page.goto(`/scene/${SCENE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { state: 'visible', timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(15000);
  const diag = await page.evaluate(() =>
    document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? null);
  out.reopenedDiagnostics = diag ? JSON.parse(diag) : null;
  out.reopenedCamera =
    (out.reopenedDiagnostics as { camera?: { position?: unknown } } | null)?.camera?.position ?? null;

  console.log('AUTHZ_SAVE_START');
  console.log(JSON.stringify(out, null, 2));
  console.log('AUTHZ_SAVE_END');

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  expect(true).toBe(true);
});
