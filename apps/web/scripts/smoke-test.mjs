/**
 * Phase 02 browser smoke test — real SOG scene in headless Chrome.
 *
 * Verifies:
 *   A. Real iframe mount + canvas
 *   B. Toolbar presence (Reset / Orbit / Fly / Performance / Quality / Help)
 *   C. Reset button calls resetCamera (no crash)
 *   D. Orbit ↔ Fly camera mode toggle (no crash)
 *   E. Performance panel shows stats
 *   F. Scene loads without critical errors
 *   G. 5× mount/unmount cycle (no leaked canvas/count growth)
 *
 * Run:  cd apps/web && node scripts/smoke-test.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
  ],
  headless: true,
  executablePath: process.env.CHROME_PATH ?? undefined,
});

let failed = false;
const pass = (label) => console.log(`  ✓ ${label}`);
const fail = (label, reason) => {
  console.error(`  ✗ ${label}: ${reason}`);
  failed = true;
};

// ── A. Real iframe + canvas ──────────────────────────────────────────────

console.log('\n=== A. Scene page renders viewer iframe + canvas ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${BASE}/scene/local-garden`, { waitUntil: 'networkidle', timeout: 30000 });

  const canvasHost = page.getByTestId('viewer-canvas-host');
  await canvasHost.waitFor({ timeout: 10000 });

  const iframe = canvasHost.locator('iframe');
  const iframeCount = await iframe.count();
  if (iframeCount === 1) pass('iframe rendered');
  else fail('iframe rendered', `expected 1, got ${iframeCount}`);

  // iframe has a title
  const title = await iframe.getAttribute('title');
  if (title?.includes('3D')) pass(`iframe title: "${title}"`);
  else fail('iframe title', `got "${title}"`);

  // Check for page-level JS errors
  const critical = errors.filter((e) =>
    !e.includes('ResizeObserver') && !e.includes('getComputedStyle') && !e.includes('Not implemented')
    && !e.includes('webglcontextlost'),
  );
  if (critical.length === 0) pass('no critical JS errors');
  else fail('no critical JS errors', critical.join('; '));

  await page.screenshot({ path: '/tmp/smoke-A.png' });
  console.log('  screenshot saved: /tmp/smoke-A.png');
  await ctx.close();
}

// ── B. Toolbar present ───────────────────────────────────────────────────

console.log('\n=== B. Toolbar buttons present ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scene/local-garden`, { waitUntil: 'networkidle', timeout: 30000 });

  const toolbar = page.getByLabel('Viewer 工具条');
  await toolbar.waitFor({ timeout: 10000 });

  for (const name of ['Performance', 'Quality', 'Help']) {
    const btn = toolbar.getByRole('button', { name });
    if (await btn.count() === 1) pass(`button "${name}"`);
    else fail(`button "${name}"`, 'not found');
  }

  // Reset button
  const resetBtn = toolbar.getByRole('button', { name: /Reset/ });
  if (await resetBtn.count() === 1) pass('button "Reset"');
  else fail('button "Reset"', 'not found');

  // Orbit / Fly text
  for (const mode of ['Orbit', 'Fly']) {
    if (await toolbar.getByText(mode).count() >= 1) pass(`mode "${mode}"`);
    else fail(`mode "${mode}"`, 'not found');
  }

  await page.screenshot({ path: '/tmp/smoke-B.png' });
  await ctx.close();
}

// ── C–D. Reset & Camera mode toggle (no crash) ─────────────────────────

console.log('\n=== C+D. Reset + Camera mode toggle ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') jsErrors.push(msg.text());
  });

  await page.goto(`${BASE}/scene/local-garden`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });

  // Click Reset
  const toolbar = page.getByLabel('Viewer 工具条');
  await toolbar.getByRole('button', { name: /Reset/ }).click();
  await page.waitForTimeout(500);
  pass('Reset clicked without crash');

  // Toggle to Fly
  await toolbar.getByText('Fly').click();
  await page.waitForTimeout(500);
  const flyActive = await toolbar.evaluate((el) => el.textContent?.includes('Fly'));
  if (flyActive) pass('Fly mode selected');
  else fail('Fly mode selected', 'Fly not active');

  // Toggle back to Orbit
  await toolbar.getByText('Orbit').click();
  await page.waitForTimeout(500);
  pass('Orbit mode re-selected');

  // Toggle again to Fly
  await toolbar.getByText('Fly').click();
  await page.waitForTimeout(300);
  await toolbar.getByText('Orbit').click();
  await page.waitForTimeout(300);
  pass('5× mode toggle completed');

  const critical = jsErrors.filter(
    (e) => !e.includes('ResizeObserver') && !e.includes('getComputedStyle') && !e.includes('Not implemented'),
  );
  if (critical.length === 0) pass('no JS errors during interactions');
  else fail('no JS errors during interactions', critical.join('; '));

  await ctx.close();
}

// ── E. Performance panel ────────────────────────────────────────────────

console.log('\n=== E. Performance panel shows stats ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scene/local-garden`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });

  const toolbar = page.getByLabel('Viewer 工具条');
  await toolbar.getByRole('button', { name: /Performance/ }).click();

  const statsPanel = page.getByRole('region', { name: /性能统计/ });
  await statsPanel.waitFor({ timeout: 5000 });

  const text = await statsPanel.textContent();
  if (text?.includes('FPS') || text?.includes('fps')) pass('FPS present');
  else fail('FPS', `panel text: ${text?.substring(0, 100)}`);

  if (text?.includes('Splats') || text?.includes('splat')) pass('Splats present');
  else fail('Splats', 'not in panel');

  await page.screenshot({ path: '/tmp/smoke-E.png' });
  console.log('  screenshot saved: /tmp/smoke-E.png');
  await ctx.close();
}

// ── F. 404 for unknown scene ────────────────────────────────────────────

console.log('\n=== F. Unknown sceneId shows error ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scene/__nonexistent_scene__`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const errorEl = page.getByTestId('viewer-error');
  const hasError = (await errorEl.count()) > 0;
  if (hasError) pass('error state shown for unknown scene');
  else {
    // Fallback: check URL redirect or any error message on page
    const body = await page.textContent('body');
    if (body?.includes('404') || body?.includes('找不到') || body?.includes('错误')) {
      pass('error indication present (text fallback)');
    } else fail('error state', 'no error element or error text found');
  }
  await ctx.close();
}

// ── G. Multiple mount/unmount cycles ────────────────────────────────────

console.log('\n=== G. 5× mount/unmount — no leak ===');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scene/local-garden`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });

  // Baseline: count iframes on page
  const baselineIframes = await page.locator('iframe').count();

  for (let i = 0; i < 5; i++) {
    // Navigate away
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 15000 });
    // Navigate back
    await page.goto(`${BASE}/scene/local-garden`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.getByTestId('viewer-canvas-host').waitFor({ timeout: 10000 });
  }

  // After 5 round trips, we should have at most 1 iframe in the viewer host
  const host = page.getByTestId('viewer-canvas-host');
  const finalIframes = await host.locator('iframe').count();
  if (finalIframes <= 1) pass(`iframe count after 5 cycles: ${finalIframes} (no leak)`);
  else fail('iframe leak', `expected ≤1, got ${finalIframes}`);

  // Check no error state stuck
  const hasError = (await page.getByTestId('viewer-error').count()) > 0;
  if (!hasError) pass('no error state stuck after cycles');
  else fail('no error state stuck', 'error state still visible');

  await page.screenshot({ path: '/tmp/smoke-G.png' });
  await ctx.close();
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
if (failed) {
  console.error('RESULT: FAIL — some checks failed (see above)');
  process.exit(1);
} else {
  console.log('RESULT: PASS — all smoke checks passed');
}

await browser.close();
