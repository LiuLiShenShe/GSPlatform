import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const msgs = [];
page.on('console', (msg) => msgs.push('[' + msg.type() + '] ' + msg.text().slice(0, 200)));

await page.goto('http://localhost:5173/scene/local-garden', { waitUntil: 'networkidle', timeout: 30000 });
await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });
// wait for loadScene to complete
await page.waitForTimeout(12000);

// Check the iframe internal state
const iframeState = await page.evaluate(() => {
  const iframe = document.querySelector('iframe');
  const w = iframe?.contentWindow;
  if (!w) return { error: 'no iframe' };
  const s = w.scene;
  if (!s) return { error: 'no scene in iframe' };
  const splatEls = s.elements.filter((e) => e.type === 'splat');
  return {
    splatCount: splatEls.reduce((t, e) => t + (e.numSplats || 0), 0),
    numPlacements: s.projectedSplatRenderer.placements?.length,
    appFrame: s.app.frame,
    hasCanvas: !!iframe.contentDocument?.getElementById('canvas'),
  };
});
console.log('=== iframe state after ready-gating fix ===');
console.log(JSON.stringify(iframeState, null, 2));

// Open Performance panel
const toolbar = page.getByLabel('Viewer 工具条');
await toolbar.getByRole('button', { name: /Performance/ }).click();
await page.waitForTimeout(2000);
const panelHtml = await page.getByRole('region', { name: /性能统计/ }).innerHTML();
console.log('=== Panel splat value ===');
const splatMatch = panelHtml.match(/Splats<\/span><\/th><td[^>]*><span>([^<]*)<\/span>/);
console.log('splat value:', splatMatch ? splatMatch[1] : 'not found');
const fipsMatch = panelHtml.match(/FPS<\/span><\/th><td[^>]*><span>([^<]*)<\/span>/);
console.log('fps value:', fipsMatch ? fipsMatch[1] : 'not found');

console.log('=== console (non-log) ===');
msgs.filter(m => !m.startsWith('[log]')).slice(0, 10).forEach(m => console.log(m));

await page.screenshot({ path: '/tmp/scene-loaded-final.png' });
await browser.close();
