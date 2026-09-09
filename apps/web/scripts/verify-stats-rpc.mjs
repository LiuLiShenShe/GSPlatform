import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto('http://localhost:5173/scene/local-garden', { waitUntil: 'networkidle', timeout: 30000 });
await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });
await page.waitForTimeout(10000);

// Interact to make renderer produce frames
const iframeEl = await page.$('iframe');
const frame = await iframeEl.contentFrame();
const canvas = frame.locator('#canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width/2, cy = box.y + box.height/2;

// Hold drag for ~1.5 seconds (moving) so fps window fills
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 0; i < 90; i++) {
  await page.mouse.move(cx + Math.sin(i/8)*25, cy + Math.cos(i/10)*15, { steps: 1 });
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(2500);

// Pull stats via getStats RPC - actually query the iframe internal window counters
const stats = await page.evaluate(() => {
  const w = document.querySelector('iframe').contentWindow;
  const s = w.scene;
  const splatEls = s.elements.filter(e => e.type === 'splat');
  // emulate the embed's own getStats payload logic
  let fps = 0;
  const f = s.__embedFps();  // not available; fallback below
  return {
    rpcSplatCount: splatEls.reduce((t, e) => t + (e.numSplats || 0), 0),
    numPlacements: s.projectedSplatRenderer.placements?.length,
    renderer: 'webgpu',
    deviceIsWebGPU: w.gsDeviceIsWebGPU,
  };
}).catch(() => ({ error: 'rpc check failed' }));

// Read the Performance panel that polls getStats every 1s
const toolbar = page.getByLabel('Viewer 工具条');
await toolbar.getByRole('button', { name: /Performance/ }).click();
await page.waitForTimeout(2500);
const panelHtml = await page.getByRole('region', { name: /性能统计/ }).innerHTML();
const getVal = (label) => {
  const m = panelHtml.match(new RegExp(label + '<\\/span><\\/th><td[^>]*><span>([^<]*)<\\/span>'));
  return m ? m[1] : '(empty)';
};
console.log('=== Performance panel (real getStats poll) ===');
console.log('FPS:', getVal('FPS'));
console.log('Frame time:', getVal('Frame time'));
console.log('Splats:', getVal('Splats'));
console.log('Renderer:', getVal('Renderer'));
console.log('panelHtml len:', panelHtml.length);

await browser.close();
