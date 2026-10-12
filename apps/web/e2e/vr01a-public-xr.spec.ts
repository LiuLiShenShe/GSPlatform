import { expect, test } from '@playwright/test';

const scene = process.env.GS_VR01A_PUBLIC_SCENE;
const privateScene = process.env.GS_VR01A_PRIVATE_SCENE;
const configured = Boolean(process.env.GS_VR01A_BASE_URL);

test('Private scene denied without cookies, including protected assets', async ({ page, request }) => {
  test.skip(!configured || !privateScene, 'Requires an explicitly configured live private scene');
  const path = `/api/v1/scenes/${privateScene}`;
  for (const suffix of ['', '/runtime', '/assets/manifest.json']) {
    expect((await request.get(path + suffix)).status()).toBe(401);
  }
  const responses: number[] = [];
  page.on('response', response => {
    if (response.url().includes(`${path}/runtime`)) responses.push(response.status());
  });
  await page.goto(`/xr/${privateScene}`);
  await expect.poll(() => responses).toContain(401);
  await expect.poll(async () => {
    const text = await page.getByTestId('ov-xr-diagnostics').textContent();
    return JSON.parse(text ?? '{}').status;
  }).toBe('error');
  const diagnostic = JSON.parse(await page.getByTestId('ov-xr-diagnostics').textContent() ?? '{}');
  expect(diagnostic.loaded).toBe(false);
  expect(diagnostic.isManifestFallback).toBe(false);
});

test('Anonymous public scene returns the formal database descriptor', async ({ request }, testInfo) => {
  test.skip(!configured || !scene, 'Requires an explicitly configured live public scene');
  expect((await request.get('/api/v1/auth/me')).status()).toBe(401);
  const detail = await request.get(`/api/v1/scenes/${scene}`);
  expect(detail.status()).toBe(200);
  expect((await detail.json()).visibility).toBe('PUBLIC');
  const runtime = await request.get(`/api/v1/scenes/${scene}/runtime`);
  expect(runtime.status()).toBe(200);
  const descriptor = await runtime.json();
  expect(descriptor.scene.id).toBe(scene);
  expect(descriptor.content.format).toBe('lod-meta');
  expect(descriptor.content.url).toMatch(new RegExp(`^/api/v1/scenes/${scene}/assets/versions/[^/]+/lod-meta.json$`));
  const resource = await request.get(descriptor.content.url);
  expect(resource.status()).toBe(200);
  await testInfo.attach('formal-descriptor.json', {
    body: JSON.stringify(descriptor, null, 2), contentType: 'application/json',
  });
});

test('Formal XR diagnostics initializes WebGL2 and loads real SOG', async ({ page }, testInfo) => {
  test.skip(!configured || !scene, 'Requires an explicitly configured live public scene');
  const failures: string[] = [];
  const assets: { path: string; status: number }[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.includes(`/api/v1/scenes/${scene}/`)) {
      assets.push({ path, status: response.status() });
      if (response.status() >= 400) failures.push(`${response.status()} ${path}`);
    }
  });
  await page.goto(`/xr/diagnostics/${scene}`);
  await expect(page.getByTestId('diag-state-loaded')).toHaveText('true', { timeout: 180_000 });
  expect(Number(await page.getByTestId('diag-gsplats').textContent())).toBeGreaterThan(0);
  await expect(page.getByTestId('diag-renderer')).toHaveText('webgl');
  await expect(page.getByTestId('diag-secure-context')).toHaveText('true');
  await expect(page.getByTestId('diag-scene-state')).not.toContainText('[manifest]');
  expect(await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return Boolean(canvas?.getContext('webgl2'));
  })).toBe(true);
  expect(assets.some(asset => asset.path.endsWith('/runtime') && asset.status === 200)).toBe(true);
  expect(assets.some(asset => /\/\d+_\d+\/.*\.webp$/.test(asset.path) && [200, 206].includes(asset.status))).toBe(true);
  expect(failures).toEqual([]);
  await testInfo.attach('xr-diagnostics.json', {
    body: JSON.stringify({ assets, failures, gsplats: Number(await page.getByTestId('diag-gsplats').textContent()) }),
    contentType: 'application/json',
  });
});

test('Anonymous formal XR streamed SOG Viewer loads without manifest fallback', async ({ page, context }, testInfo) => {
  test.skip(!configured || !scene, 'Requires an explicitly configured live public scene');
  const failures: string[] = [];
  const assets: { path: string; status: number }[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.includes(`/api/v1/scenes/${scene}/`)) {
      assets.push({ path, status: response.status() });
      if (response.status() >= 400) failures.push(`${response.status()} ${path}`);
    }
  });
  await page.goto(`/xr/${scene}`);
  await expect.poll(async () => {
    const text = await page.getByTestId('ov-xr-diagnostics').textContent();
    return JSON.parse(text ?? '{}').loaded;
  }, { timeout: 180_000 }).toBe(true);
  const diagnostics = JSON.parse(await page.getByTestId('ov-xr-diagnostics').textContent() ?? '{}');
  expect(diagnostics.renderer).toBe('webgl');
  expect(diagnostics.gsplats).toBeGreaterThan(0);
  expect(diagnostics.isManifestFallback).toBe(false);
  expect(diagnostics.contentUrl).toContain(`/api/v1/scenes/${scene}/assets/versions/`);
  expect(assets.some(asset => asset.path.endsWith('/runtime') && asset.status === 200)).toBe(true);
  expect(assets.some(asset => /\/\d+_\d+\/.*\.webp$/.test(asset.path) && [200, 206].includes(asset.status))).toBe(true);
  expect((await context.cookies()).some(cookie => cookie.name === 'gs_session')).toBe(false);
  expect(failures).toEqual([]);
  await testInfo.attach('anonymous-xr-viewer.json', {
    body: JSON.stringify({ diagnostics, assets, failures }, null, 2), contentType: 'application/json',
  });
});
