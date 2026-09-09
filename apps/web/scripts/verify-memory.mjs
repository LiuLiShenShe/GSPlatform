import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// 10x mount/unmount cycle
await page.goto('http://localhost:5173/scene/local-garden', { waitUntil: 'networkidle', timeout: 30000 });
await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });

const baseline = await page.evaluate(() => ({
  iframes: document.querySelectorAll('iframe').length,
  canvases: document.querySelectorAll('canvas').length,
  heapMB: performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 'na',
}));

for (let i = 0; i < 10; i++) {
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.goto('http://localhost:5173/scene/local-garden', { waitUntil: 'networkidle', timeout: 15000 });
  await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });
}

const after = await page.evaluate(() => ({
  iframes: document.querySelectorAll('iframe').length,
  canvases: document.querySelectorAll('canvas').length,
  heapMB: performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 'na',
}));
console.log('baseline:', JSON.stringify(baseline));
console.log('after 10 cycles:', JSON.stringify(after));
console.log('leak check:', after.iframes <= 1 && after.canvases <= 2 ? 'PASS (no iframe/canvas growth)' : 'FAIL');
await browser.close();
