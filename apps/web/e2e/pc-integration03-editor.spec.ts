import { chromium, expect, test } from '@playwright/test';

test('real exported edit resumes in platform, publishes under same Scene, renders official Viewer', async () => {
  test.skip(process.env.PC03_E2E !== '1', 'Requires isolated PostgreSQL, real worker and genuine official Editor export');
  const baseURL = process.env.PC03_BASE_URL!;
  const slug = process.env.PC03_SCENE!;
  const sessionId = process.env.PC03_SESSION!;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox',
    '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan',
    '--use-angle=vulkan', '--use-vulkan=native', '--disable-vulkan-surface'] });
  const context = await browser.newContext({ baseURL, viewport: { width: 1500, height: 1000 } });
  try {
    const page = await context.newPage();
    const login = await page.request.post('/api/v1/auth/login', { data: {
      email: process.env.PC03_EMAIL, password: process.env.PC03_PASSWORD,
    } });
    expect(login.status()).toBe(200);
    await expect.poll(async () => (await page.request.get('/api/v1/auth/me')).status()).toBe(200);
    await page.goto(`/scene/${slug}`);
    await page.waitForFunction(() => {
      const value = document.querySelector('[data-testid="ov-diagnostics"]');
      const diagnostic = JSON.parse(value?.textContent ?? '{}');
      return diagnostic.loaded === true && diagnostic.gsplats > 0;
    }, null, { timeout: 120_000 });
    const before = await page.locator('[data-testid="ov-diagnostics"]').textContent();
    expect(JSON.parse(before!).isManifestFallback).toBe(false);
    await page.screenshot({ path: `${process.env.PC03_EVIDENCE}/viewer-before.png` });
    await page.evaluate(({ scene, id }) => localStorage.setItem(`gs-editor-session:${scene}`, id),
      { scene: slug, id: sessionId });
    await page.goto(`/model/edit/${slug}`);
    await expect(page.getByText('高级 Gaussian 编辑', { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`会话 ${sessionId}`))).toBeVisible();
    await page.getByLabel('官方编辑导出文件').setInputFiles(process.env.PC03_EXPORT!);
    const lodAcknowledgement = page.getByRole('checkbox', { name: /确认实际导出来自会话指定的 LOD/ });
    if (await lodAcknowledgement.count()) await lodAcknowledgement.check();
    await page.getByRole('button', { name: /提交编辑结果/ }).click();
    await expect(page.getByText(/新 SceneVersion 已发布：/)).toBeVisible({ timeout: 180_000 });
    const finished = await (await page.request.get(
      `/api/v1/scenes/${slug}/edit-sessions/${sessionId}`)).json();
    expect(finished.status).toBe('COMPLETED');
    expect(finished.sceneSlug).toBe(slug);
    expect(finished.selectedLod).toBe(process.env.PC03_LOD ? Number(process.env.PC03_LOD) : null);
    await page.screenshot({ path: `${process.env.PC03_EVIDENCE}/platform-completed.png` });
    await page.getByRole('link', { name: '在正式 Viewer 查看新版本' }).click();
    await page.waitForFunction(() => {
      const value = document.querySelector('[data-testid="ov-diagnostics"]');
      const diagnostic = JSON.parse(value?.textContent ?? '{}');
      return diagnostic.loaded === true && diagnostic.gsplats > 0;
    }, null, { timeout: 120_000 });
    const loaded = JSON.parse((await page.locator('[data-testid="ov-diagnostics"]').textContent())!);
    expect(loaded.isManifestFallback).toBe(false);
    expect(loaded.format).toBe('lod-meta');
    expect(loaded.contentUrl).toContain('/assets/versions/');
    expect(loaded.walkAllowed).toBe(false);
    await page.screenshot({ path: `${process.env.PC03_EVIDENCE}/viewer-after.png` });
    console.log('PC03_REAL_VIEWER', JSON.stringify({ finished, loaded, before: JSON.parse(before!) }));
    await page.reload();
    await page.waitForFunction(() => JSON.parse(document.querySelector(
      '[data-testid="ov-diagnostics"]')?.textContent ?? '{}').loaded === true,
    null, { timeout: 120_000 });
    const anonymous = await browser.newContext({ baseURL });
    expect((await anonymous.request.get(loaded.contentUrl)).status()).toBe(401);
    await anonymous.close();
  } finally {
    await context.close();
    await browser.close();
  }
});
