import { expect, test } from './fresh-browser';

/**
 * SSV-06 + GS-DESKTOP-02 —— 官方 UI 兼容层的真实浏览器契约。
 *
 * GS-DESKTOP-02 起官方 Viewer 原生 UI **完整保留**（不再隐藏 chrome、宿主不再
 * 自绘第二套工具条）。因此本用例断言三件事：
 *   1. 官方 hotspot 层真实渲染（SSV-06 能力没被回归掉）；
 *   2. 官方原生控件（工具条 / 设置面板 / info 面板）**可见**，且宿主没有复制
 *      它们（没有两套相机/显示控件）；
 *   3. 官方标注导览器 `.sse-annotationNav` 可见（GS-NEXT-04 的产出保持不回归）。
 */
test('Authoring preview: 官方 hotspot 层存在，且 chrome 隐藏 / 导览器放行（GS-NEXT-04）', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
  await page.goto('/model/edit/fix02-semantics');
  await page.waitForSelector('[data-testid="scene-authoring-page"]');
  await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });
  // GS-DESKTOP-02：官方 chrome 在官方 `loaded` 之前是 `.sse-hidden`；必须等
  // 真实加载完成（创作页状态标签），否则会在加载期断言到隐藏的 chrome。
  await page.waitForFunction(
    () => document.body.textContent?.includes('Viewer 就绪') ?? false,
    { timeout: 120_000 },
  );
  // 等官方 runtime 就绪（Tag: Viewer 就绪）并渲染出 hotspot 层。
  await page.waitForFunction(
    () => !!document.querySelector('.sse-annotation-hotspots .sse-annotation-hotspot'),
    { timeout: 90000 },
  );
  const count = await page.locator('.sse-annotation-hotspots .sse-annotation-hotspot').count();
  console.log('authoring preview hotspot count:', count);
  expect(count).toBeGreaterThan(0);

  // ① GS-DESKTOP-02：官方 chrome 现在必须**可见**（原生 UI 恢复），且宿主不再
  //    自绘第二套工具条（ov-* 控件全部消失）。
  for (const sel of ['.sse-controlsWrap', '.sse-settings', '.sse-info']) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    expect(visible, `${sel} 现在必须可见`).toBe(true);
  }
  for (const id of ['ov-frame', 'ov-reset', 'ov-walk', 'ov-annotations']) {
    await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(0);
  }

  // ② 官方标注导览器已放行（GS-NEXT-04）。它挂在 .sse-ui 下且是直接子元素。
  const navCount = await page.locator('.sse-ui > .sse-annotationNav').count();
  console.log('official annotationNav present:', navCount);
  expect(navCount).toBe(1);

  // ③ 官方 chrome 不被宿主覆盖层遮挡：controlsWrap 中心点命中自身。
  const hit = await page.evaluate(() => {
    const el = document.querySelector('.sse-controlsWrap');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { tag: top?.tagName ?? null, inside: !!top && (el.contains(top) || (top as HTMLElement).contains(el)) };
  });
  console.log('controlsWrap hit test:', JSON.stringify(hit));
  expect(hit?.inside).toBe(true);
});