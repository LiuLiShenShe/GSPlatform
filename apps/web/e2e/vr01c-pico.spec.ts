import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const small = 'u-a68b94d84538';
const large = 'u-06924576399e';
test.beforeEach(() => { test.skip(!process.env.GS_VR01C_BASE_URL, 'Requires isolated live API, no mocked Gaussian assets'); });

async function state(page: Page) {
  return JSON.parse(await page.getByTestId('ov-xr-diagnostics').textContent() ?? '{}');
}

async function settledCamera(page: Page) {
  let previous: number[] | null = null;
  let stable = 0;
  await expect.poll(async () => {
    const camera = (await state(page)).camera;
    if (!camera) return false;
    const delta = previous ? Math.hypot(...camera.position.map((value: number, index: number) => value - previous![index])) : Infinity;
    previous = camera.position;
    stable = delta < 0.001 ? stable + 1 : 0;
    return stable >= 2;
  }, { timeout: 45000, intervals: [1000] }).toBe(true);
  return (await state(page)).camera;
}

async function exportReport(page: Page) {
  const download = page.waitForEvent('download', { timeout: 10000 });
  await page.getByTestId('diagnostics-export').click();
  const file = await (await download).path();
  expect(file).not.toBeNull();
  const text = await readFile(file!, 'utf8');
  expect(text).not.toMatch(/gs_session|gs_csrf|Authorization|share=|token=|Cookie/);
  return JSON.parse(text);
}

async function evidence(testInfo: TestInfo, name: string, report: object) {
  const path = testInfo.outputPath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

test('small real SOG, official performance A/B, preference and local JSON export', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('performanceMode', 'false'));
  await page.goto(`/xr/${small}?diagnostics=1`);
  await expect.poll(async () => (await state(page)).gsplats, { timeout: 90000 }).toBe(1788);
  await expect(page.getByTestId('performance-mode')).toHaveText('OFF');
  await page.getByTestId('performance-on').click();
  await settledCamera(page);
  await page.getByTestId('performance-off').click();
  const camera = await settledCamera(page);
  await page.getByTestId('performance-on').click();
  await expect(page.getByTestId('performance-mode')).toHaveText('ON');
  expect(await page.evaluate(() => localStorage.getItem('performanceMode'))).toBe('false');
  await page.waitForTimeout(2200);
  await page.getByTestId('performance-off').click();
  await expect(page.getByTestId('performance-mode')).toHaveText('OFF');
  await page.waitForTimeout(2200);
  expect(Math.hypot(...(await state(page)).camera.position.map((value: number, index: number) => value - camera.position[index]))).toBeLessThan(0.01);
  const report = await exportReport(page);
  expect(report.lodCounts).toEqual([1788]);
  expect(report.assetVersion).toBe('21c371259407');
  expect(report.samples.length).toBeGreaterThan(1);
  expect(report.timing.gpuFPS).toBe('unavailable');
  expect(report.recording).toBe(false);
  await evidence(testInfo, 'small-diagnostics.json', report);
});

test('private scene remains denied; failed load still exports local evidence', async ({ page, request }) => {
  const privateScene = 'u-3b48959f67fd';
  expect((await request.get(`/api/v1/scenes/${privateScene}/runtime?diagnostics=1`)).status()).toBe(401);
  await page.goto(`/xr/${privateScene}?diagnostics=1`);
  await expect.poll(async () => (await state(page)).status).toBe('error');
  const report = await exportReport(page);
  expect(report.assetVersion).toBe('unavailable');
  expect(report.runtime).toBe('unavailable');
  expect(report.events.some((entry: { kind: string }) => entry.kind === 'runtime-or-session-error')).toBe(true);
});

test('real small Viewer keeps an authored transformed camera without framing (descriptor fixture only)', async ({ page, request }, testInfo) => {
  const response = await request.get(`/api/v1/scenes/${small}/runtime`);
  expect(response.status()).toBe(200);
  const descriptor = await response.json();
  descriptor.presentation.initialCamera = {
    position: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 2 }, fov: 60,
  };
  descriptor.presentation.worldTransform = {
    position: { x: 3, y: 4, z: 5 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 },
  };
  await page.route(`**/api/v1/scenes/${small}/runtime`, route => route.fulfill({ json: descriptor }));
  await page.goto(`/xr/${small}?diagnostics=1`);
  await expect.poll(async () => (await state(page)).loaded, { timeout: 90000 }).toBe(true);
  const camera = await settledCamera(page);
  expect(Math.hypot(...camera.position.map((value: number, index: number) => value - [9, 8, 3][index]))).toBeLessThan(0.01);
  expect(camera.fov).toBe(60);
  const report = await exportReport(page);
  expect(report.initialCamera).toEqual(descriptor.presentation.initialCamera);
  expect(report.worldTransform).toEqual(descriptor.presentation.worldTransform);
  expect(report.runtime.xr.spawnStatus).toBe('not-entered');
  await evidence(testInfo, 'authored-camera-software.json', { descriptorFixture: true, actualHeadset: false, report });
});

test('historical 13M real descriptor and bounded desktop WebGL2 A/B (not PICO performance)', async ({ page, request }, testInfo) => {
  const runtime = await request.get(`/api/v1/scenes/${large}/runtime`);
  expect(runtime.status()).toBe(200);
  const descriptor = await runtime.json();
  expect(descriptor.content.url).toContain('/da7bf4207044/lod-meta.json');
  const response = await request.get(descriptor.content.url);
  expect(response.status()).toBe(200);
  const metadata = await response.json();
  expect(metadata.counts).toEqual([13090324, 3927097, 1309032]);
  expect(metadata.filenames.length).toBe(259);
  let bytes = 0;
  let requests = 0;
  let aborted = 0;
  const started = Date.now();
  await page.route(`**/api/v1/scenes/${large}/assets/**`, async route => {
    requests += 1;
    if (bytes > 256 * 1024 * 1024 || requests > 1200 || Date.now() - started > 145000) {
      aborted += 1;
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page.on('response', async resource => {
    if (new URL(resource.url()).pathname.includes(`/api/v1/scenes/${large}/assets/`)) {
      bytes += Number((await resource.allHeaders())['content-length'] ?? 0);
    }
  });
  await page.addInitScript(() => localStorage.setItem('performanceMode', 'true'));
  await page.goto(`/xr/${large}?diagnostics=1`);
  await expect.poll(async () => (await state(page)).loaded, { timeout: 100000 }).toBe(true);
  await expect.poll(async () => (await state(page)).gsplats, { timeout: 15000 }).toBeGreaterThan(0);
  await page.getByTestId('performance-off').click();
  await settledCamera(page);
  await page.getByTestId('performance-on').click();
  const camera = await settledCamera(page);
  await expect(page.getByTestId('performance-mode')).toHaveText('ON');
  await page.waitForTimeout(3000);
  await page.getByTestId('performance-off').click();
  await expect(page.getByTestId('performance-mode')).toHaveText('OFF');
  await page.waitForTimeout(4000);
  expect((await state(page)).renderer).toBe('webgl2');
  expect(Math.hypot(...(await state(page)).camera.position.map((value: number, index: number) => value - camera.position[index]))).toBeLessThan(0.01);
  const report = await exportReport(page);
  expect(report.lodCounts).toEqual(metadata.counts);
  expect(report.assetVersion).toBe('da7bf4207044');
  expect(aborted).toBe(0);
  await evidence(testInfo, 'bounded-large-diagnostics.json', { report, requests, bytes, aborted, actualHeadset: false });
  await page.goto('about:blank');
});
