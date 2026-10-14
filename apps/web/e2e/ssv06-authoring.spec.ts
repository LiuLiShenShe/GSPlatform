import { expect, test } from './fresh-browser';

/**
 * SSV-06 + GS-NEXT-04 —— 官方 UI 兼容层的真实浏览器契约。
 *
 * GS-NEXT-04 之前：`ui:true` 只用来拿官方 hotspot，`.sse-ui` 整层隐藏。
 * GS-NEXT-04 起：`.sse-ui` 本身可见，但它的**直接子元素除官方标注导览器外**
 * 全部隐藏（`> *:not(.sse-annotationNav)`）—— 拿回官方现成的导览器，而不是自绘。
 *
 * 因此本用例断言的是新契约的三件事：
 *   1. 官方 hotspot 层真实渲染（SSV-06 能力没被回归掉）；
 *   2. 官方 chrome 控件（工具条/设置面板/info 面板）**不可见**（宿主自绘替代，
 *      且它们会吃掉 canvas 鼠标事件，必须继续隐藏）；
 *   3. 官方标注导览器 `.sse-annotationNav` **可见**（GS-NEXT-04 的产出）。
 */
test('Authoring preview: 官方 hotspot 层存在，且 chrome 隐藏 / 导览器放行（GS-NEXT-04）', async ({ page }) => {
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

  // ① 官方 chrome 控件仍然不可见（GSPlatform 自绘工具条替代）。
  for (const sel of ['.sse-controlsWrap', '.sse-settingsPanel', '.sse-infoPanel']) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    expect(visible, `${sel} 必须保持隐藏`).toBe(false);
  }

  // ② 官方标注导览器已放行（GS-NEXT-04）。它挂在 .sse-ui 下且是直接子元素。
  const navCount = await page.locator('.sse-ui > .sse-annotationNav').count();
  console.log('official annotationNav present:', navCount);
  expect(navCount).toBe(1);

  // ③ 其余直接子元素仍然被隐藏：抽样 controlsWrap 可见性（最宽的一条，
  //    若它可见会横跨容器宽度并吃掉 canvas 拖拽）。
  const chromeVisible = await page
    .locator('.sse-ui > *:not(.sse-annotationNav)')
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length);
  console.log('visible official chrome children:', chromeVisible);
  expect(chromeVisible).toBe(0);
});