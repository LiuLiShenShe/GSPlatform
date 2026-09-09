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

const camInfo = () => page.evaluate(() => {
  const w = document.querySelector('iframe')?.contentWindow;
  const cam = w?.scene?.camera;
  if (!cam) return null;
  const mc = cam.mainCamera;
  // inspect structure
  const info = { hasMainCamera: !!mc, keys: mc ? Object.keys(mc).slice(0, 15) : null };
  // Try to get position via entity or getPosition
  try {
    if (mc?.entity) {
      info.pos = [mc.entity.getPosition().x, mc.entity.getPosition().y, mc.entity.getPosition().z].map(v => +v.toFixed(3));
    } else if (mc?.getPosition) {
      info.pos = [mc.getPosition().x, mc.getPosition().y, mc.getPosition().z].map(v => +v.toFixed(3));
    }
  } catch (e) { info.posErr = e.message.slice(0, 100); }
  // lookTarget
  try {
    const t = cam.lookCameraPos; // fallback
    if (t) info.look = [t.x, t.y, t.z].map(v => +v.toFixed(3));
  } catch {}
  return info;
});

console.log('cam1:', JSON.stringify(await camInfo()));

// Interact: orbit drag
const iframeEl = page.locator('iframe');
const frame = iframeEl.contentFrame();
const canvas = frame.locator('#canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width/2, cy = box.y + box.height/2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 100, cy + 50, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(600);
console.log('after drag:', JSON.stringify(await camInfo()));

// Reset
await page.getByRole('button', { name: /Reset/ }).click();
await page.waitForTimeout(900);
console.log('after reset:', JSON.stringify(await camInfo()));
await browser.close();
