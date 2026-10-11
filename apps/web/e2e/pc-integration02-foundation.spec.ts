import { readFileSync } from 'node:fs';
import { expect, test } from './fresh-browser';
import type { Page } from '@playwright/test';

test.describe('PC-INTEGRATION-02 isolated real foundation', () => {
  test.skip(process.env.PC02_E2E !== '1', 'Requires an explicitly isolated API, broker and small real asset');
  test.describe.configure({ mode: 'serial' });

  let publishedScene = process.env.PC02_EXISTING_SCENE ?? '';
  let accountEmail = process.env.PC02_ACCOUNT_EMAIL ?? '';
  const password = 'pc02-isolated-test-password';

  async function signIn(page: Page): Promise<void> {
    const response = await page.request.post('/api/v1/auth/login', {
      data: { email: accountEmail, password },
    });
    expect(response.status()).toBe(200);
    await expect.poll(async () => (await page.request.get('/api/v1/auth/me')).status(),
      { timeout: 10_000 }).toBe(200);
  }

  async function headers(page: Page): Promise<Record<string, string>> {
    const cookies = await page.context().cookies();
    return { 'X-CSRF-Token': cookies.find((cookie) => cookie.name === 'gs_csrf')?.value ?? '' };
  }

  async function diagnostics(page: Page, selector: string): Promise<Record<string, unknown>> {
    await page.waitForFunction((target) => {
      const element = document.querySelector(target);
      if (!element) return false;
      const value = JSON.parse(element.textContent ?? '{}');
      return value.loaded === true && value.gsplats > 0;
    }, selector, { timeout: 180_000 });
    return page.locator(selector).evaluate((element) => JSON.parse(element.textContent ?? '{}'));
  }

  test('real PLY upload publishes without collision, ends polling, and renders official Streamed SOG', async ({ page }) => {
    accountEmail = `pc02-${Date.now()}@example.com`;
    const registered = await page.request.post('/api/v1/auth/register', {
      data: { email: accountEmail, password, displayName: 'PC02 isolated acceptance' },
    });
    expect(registered.status()).toBe(200);
    const source = process.env.PC02_PLY;
    expect(source).toBeTruthy();
    let statusRequests = 0;
    page.on('request', (request) => {
      if (/\/uploads\/[^/]+\/status$/.test(request.url())) statusRequests += 1;
    });
    await page.goto('/upload');
    await page.getByLabel('作品标题').fill('PC02 real Gaussian PLY');
    await page.getByRole('combobox', { name: '分类', exact: true }).click();
    await page.getByText('实验', { exact: true }).last().click();
    await page.locator('input[type=file]').first().setInputFiles(source!);
    await page.getByRole('button', { name: /校验并发布/ }).click();
    await expect(page.getByText('碰撞非必需', { exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText(/碰撞未启用，可按需生成/)).toBeVisible();
    await expect(page.getByText('发布成功', { exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText('等待碰撞任务调度', { exact: true })).toHaveCount(0);
    const stableRequestCount = statusRequests;
    await page.waitForTimeout(7_000);
    expect(statusRequests).toBe(stableRequestCount);
    const sceneLink = page.locator('a[href^="/scene/"]').last();
    const href = await sceneLink.getAttribute('href');
    publishedScene = href!.split('/').at(-1)!;
    const descriptor = await (await page.request.get(`/api/v1/scenes/${publishedScene}/runtime`)).json();
    expect(descriptor.collision).toBe(null);
    await sceneLink.click();
    const loaded = await diagnostics(page, '[data-testid="ov-diagnostics"]');
    expect(['webgpu', 'webgl', 'webgl2']).toContain(loaded.renderer);
    expect(loaded.isManifestFallback).toBe(false);
    expect(loaded.format).toBe('lod-meta');
    expect(loaded.contentUrl).toContain('/assets/versions/');
    expect(loaded.walkAllowed).toBe(false);
    console.log('PC02_DESKTOP', JSON.stringify({ scene: publishedScene, diagnostics: loaded }));
    await page.goto('/works');
    await expect(page.locator('[data-testid="scene-viewer-page"]')).toHaveCount(0);
  });

  test('same immutable SceneVersion loads through the official WebGL XR software route', async ({ page }) => {
    await signIn(page);
    await page.goto(`/xr/${publishedScene}`);
    const loaded = await diagnostics(page, '[data-testid="ov-xr-diagnostics"]');
    expect(['webgl', 'webgl2']).toContain(loaded.renderer);
    expect(loaded.walkAllowed).toBe(false);
    await expect(page.getByTestId('xr-viewer-page')).toHaveAttribute('data-runtime', 'official');
    console.log('PC02_XR_SOFTWARE', JSON.stringify(loaded));
  });

  test('separate approved nonphysical small ZIP scene builds and rebuilds real version-safe collision', async ({ page }) => {
    await signIn(page);
    const zipPath = process.env.PC02_STREAMED_ZIP;
    expect(zipPath).toBeTruthy();
    const payload = readFileSync(zipPath!);
    const csrf = await headers(page);
    const created = await page.request.post('/api/v1/uploads', {
      headers: csrf,
      data: { filename: 'approved-small.zip', format: 'zip', size: payload.length,
        mime_type: 'application/zip', title: 'PC02 explicit nonphysical collision',
        category: 'experiment', visibility: 'PRIVATE', scene_type: 'GREENHOUSE_SCENE' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const upload = await created.json();
    const appended = await page.request.patch(`/api/v1/uploads/${upload.uploadId}`, {
      headers: { ...csrf, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, data: payload,
    });
    expect(appended.status()).toBe(200);
    const completed = await page.request.post(`/api/v1/uploads/${upload.uploadId}/complete`, {
      headers: csrf, data: { expected_size: payload.length },
    });
    expect(completed.status()).toBe(200);
    const scene = (await completed.json()).sceneSlug;
    await expect.poll(async () => (await (await page.request.get(
      `/api/v1/uploads/${upload.uploadId}/status`,
    )).json()).publishStatus, { timeout: 120_000 }).toBe('SUCCEEDED');
    const status = await (await page.request.get(`/api/v1/uploads/${upload.uploadId}/status`)).json();
    expect(status.collisionRequired).toBe(false);
    expect(status.collisionJobId).toBe(null);
    const refused = await page.request.post(`/api/v1/scenes/${scene}/collision/build`, {
      headers: csrf, data: { mode: 'OUTDOOR' },
    });
    expect(refused.status()).toBe(409);
    const admitted = await page.request.post(`/api/v1/scenes/${scene}/collision/build`, {
      headers: csrf, data: { mode: 'OUTDOOR', acknowledge_unverified_scale: true },
    });
    expect(admitted.status()).toBe(200);
    await expect.poll(async () => (await (await page.request.get(
      `/api/v1/scenes/${scene}/collision`,
    )).json()).status, { timeout: 180_000 }).toBe('SUCCEEDED');
    const runtime = await (await page.request.get(`/api/v1/scenes/${scene}/runtime`)).json();
    expect(runtime.collision.enabled).toBe(false);
    expect(runtime.collision.format).toBe('voxel');
    expect(runtime.collision.stale).toBe(false);
    const voxel = await page.request.get(runtime.collision.url);
    expect(voxel.status()).toBe(200);
    expect((await voxel.json()).nodeCount).toBeGreaterThan(0);
    expect((await page.request.get(runtime.collision.url.replace('.voxel.json', '.voxel.bin'))).status()).toBe(200);
    const glb = await page.request.get(`/api/v1/scenes/${scene}/collision/collision.glb`);
    expect(glb.status()).toBe(200);
    expect((await glb.body()).subarray(0, 4).toString()).toBe('glTF');
    const anonymous = await page.context().browser()!.newContext();
    expect((await anonymous.request.get(
      `${process.env.PW_BASE_URL ?? 'http://localhost:5173'}${runtime.collision.url}`,
    )).status()).toBe(401);
    await anonymous.close();
    const rebuilt = await page.request.post(`/api/v1/scenes/${scene}/collision/rebuild`, {
      headers: csrf, data: { acknowledge_unverified_scale: true },
    });
    expect(rebuilt.status()).toBe(200);
    expect((await rebuilt.json()).job_id).not.toBe((await admitted.json()).job_id);
    await expect.poll(async () => (await (await page.request.get(
      `/api/v1/scenes/${scene}/collision`,
    )).json()).status, { timeout: 180_000 }).toBe('SUCCEEDED');
    await page.goto(`/scene/${scene}`);
    const loaded = await diagnostics(page, '[data-testid="ov-diagnostics"]');
    expect(loaded.walkAllowed).toBe(false);
    console.log('PC02_MANUAL_COLLISION', JSON.stringify({ scene, runtime, diagnostics: loaded }));
  });
});
