import { expect, test } from '@playwright/test';

const scene = process.env.GS_VR01B_PUBLIC_SCENE;
const privateScene = process.env.GS_VR01B_PRIVATE_SCENE;
const configured = Boolean(process.env.GS_VR01B_BASE_URL && scene && privateScene);

test.beforeEach(() => {
  test.skip(!configured, 'Requires explicitly configured isolated live scenes; no mocked assets');
});

test('real regular SOG descriptor, authorized public bytes and Range', async ({ request }, testInfo) => {
  expect((await request.get('/api/v1/auth/me')).status()).toBe(401);
  const response = await request.get(`/api/v1/scenes/${scene}/runtime`);
  expect(response.status()).toBe(200);
  const descriptor = await response.json();
  expect(descriptor.content.format).toBe('sog');
  expect(descriptor.content.url).toMatch(/\/assets\/versions\/[0-9a-f]+\/scene\.sog$/);
  const asset = await request.get(descriptor.content.url);
  expect(asset.status()).toBe(200);
  expect((await asset.body()).length).toBeGreaterThan(100);
  const range = await request.get(descriptor.content.url, { headers: { Range: 'bytes=0-31' } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(32);
  await testInfo.attach('regular-descriptor.json', {
    body: JSON.stringify(descriptor, null, 2), contentType: 'application/json',
  });
});

test('real private regular scene and assets stay inaccessible', async ({ page, request }) => {
  for (const path of ['', '/runtime', '/assets/current/scene.sog']) {
    expect((await request.get(`/api/v1/scenes/${privateScene}${path}`)).status()).toBe(401);
  }
  await page.goto(`/xr/${privateScene}`);
  await expect.poll(async () => JSON.parse(await page.getByTestId('ov-xr-diagnostics')
    .textContent() ?? '{}').status).toBe('error');
  const state = JSON.parse(await page.getByTestId('ov-xr-diagnostics').textContent() ?? '{}');
  expect(state.loaded).toBe(false);
  expect(state.isManifestFallback).toBe(false);
});

for (const route of ['scene', 'xr', 'xr/diagnostics']) {
  test(`real regular SOG full count on /${route}`, async ({ page }, testInfo) => {
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.includes(`/api/v1/scenes/${scene}/`) && response.status() >= 400
        && !(response.status() === 404 && path.endsWith('/assets/poster.webp'))) {
        failures.push(`${response.status()} ${path}`);
      }
    });
    await page.goto(`/${route}/${scene}`);
    const runtimeResponse = await page.request.get(`/api/v1/scenes/${scene}/runtime`);
    expect(runtimeResponse.status()).toBe(200);
    const descriptor = await runtimeResponse.json();
    const selector = route === 'scene' ? 'ov-diagnostics' : 'ov-xr-diagnostics';
    const diagnosticRead = async () => route === 'xr/diagnostics'
      ? { loaded: await page.getByTestId('diag-state-loaded').textContent() === 'true',
        gsplats: Number(await page.getByTestId('diag-gsplats').textContent()),
        format: descriptor.content.format, contentUrl: descriptor.content.url,
        isManifestFallback: (await page.getByTestId('diag-scene-state').textContent())?.includes('[manifest]') }
      : JSON.parse(await page.getByTestId(selector).textContent() ?? '{}');
    await expect.poll(async () => (await diagnosticRead()).gsplats, { timeout: 180_000 }).toBe(1788);
    const samples = [];
    for (let iteration = 0; iteration < 4; iteration += 1) {
      await page.waitForTimeout(2000);
      samples.push(await diagnosticRead());
    }
    for (const diagnostic of samples) {
      expect(diagnostic.loaded).toBe(true);
      expect(diagnostic.gsplats).toBe(1788);
      expect(diagnostic.format).toBe('sog');
      expect(diagnostic.isManifestFallback).toBe(false);
      expect(diagnostic.contentUrl).toContain('/assets/versions/');
    }
    if (route !== 'scene') {
      await expect(page.getByTestId('diag-renderer')).toHaveText('webgl2');
    }
    expect(failures).toEqual([]);
    await testInfo.attach('sustained-count.json', {
      body: JSON.stringify({ samples, failures }, null, 2), contentType: 'application/json',
    });
    await testInfo.attach('loaded.png', { body: await page.screenshot(), contentType: 'image/png' });
  });
}

test('historical streamed descriptor and chunk stay readable', async ({ request }) => {
  const response = await request.get('/api/v1/scenes/u-06924576399e/runtime');
  expect(response.status()).toBe(200);
  const descriptor = await response.json();
  expect(descriptor.content.format).toBe('lod-meta');
  expect(descriptor.content.url).toContain('/da7bf4207044/lod-meta.json');
  const resource = await request.get(descriptor.content.url);
  expect(resource.status()).toBe(200);
  const metadata = await resource.json();
  expect(metadata.counts[0]).toBe(13_090_324);
  expect(metadata.filenames.length).toBe(259);
  const chunk = await request.get(descriptor.content.url.replace('lod-meta.json', metadata.filenames[0]));
  expect(chunk.status()).toBe(200);
});

test('immutable old streamed version still loads in the pinned official Viewer', async ({ page }, testInfo) => {
  await page.goto('/xr/test');
  await page.evaluate(async () => {
    const viewerUrl = '/node_modules/.vite/deps/@playcanvas_supersplat-viewer_viewer.js';
    const settingsUrl = '/node_modules/.vite/deps/@playcanvas_supersplat-viewer_settings.js';
    const { createViewer } = await import(viewerUrl);
    const { defaultSettings } = await import(settingsUrl);
    const settings = defaultSettings();
    settings.cameras = [{ initial: {
      position: [4.495, 2.8424, 14.9418], target: [0.0149, 0.5283, 10.3137], fov: 85,
    } }];
    document.body.innerHTML = '<div id="legacy" style="width:960px;height:720px"></div>';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/node_modules/@playcanvas/supersplat-viewer/dist/viewer.css';
    document.head.append(link);
    const handle = await createViewer({ container: document.getElementById('legacy'), settings,
      contentUrl: '/api/v1/scenes/u-a68b94d84538/assets/versions/c10c127b4574/lod-meta.json',
      renderer: 'webgl', ui: false, noanim: true });
    Object.assign(window, { legacyHandle: handle });
  });
  await page.waitForFunction(() => {
    const handle = (window as unknown as { legacyHandle?: { state: { loaded: boolean };
      app: { stats: { frame: { gsplats: number } } } } }).legacyHandle;
    return handle?.state.loaded && handle.app.stats.frame.gsplats > 0;
  }, null, { timeout: 180_000 });
  await testInfo.attach('legacy-loaded.png', { body: await page.screenshot(), contentType: 'image/png' });
});
