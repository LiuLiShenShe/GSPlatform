import { expect, test } from './fresh-browser';

test('Authoring preview: 官方 hotspot 层存在（ui:true + scoped CSS）', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
  await page.goto('/model/edit/r-8c4e2264e86a');
  await page.waitForSelector('[data-testid="scene-authoring-page"]');
  await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });
  // 等官方 runtime 就绪（Tag: Viewer 就绪）并渲染出 hotspot 层。
  await page.waitForFunction(
    () => !!document.querySelector('.sse-annotation-hotspots .sse-annotation-hotspot'),
    { timeout: 90000 },
  );
  const count = await page.locator('.sse-annotation-hotspots .sse-annotation-hotspot').count();
  console.log('authoring preview hotspot count:', count);
  expect(count).toBeGreaterThan(0);
  // 官方 chrome 隐藏
  const uiVisible = await page.locator('.sse-ui').first().isVisible().catch(() => false);
  expect(uiVisible).toBe(false);
});
