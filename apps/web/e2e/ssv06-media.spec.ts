/**
 * SSV-06 临时浏览器验证（验证后删除）—— Desktop / XR 官方 hotspots + 媒体 Overlay。
 *
 * 标注顺序（settings.annotations 顺序，与 descriptor 一致）：
 *   index 0 = TEXT, 1 = IMAGE, 2 = VIDEO, 3 = AUDIO, 4 = PANORAMA
 */
import { expect, test } from './fresh-browser';

test.describe('SSV-06 annotation media (real scene r-8c4e2264e86a)', () => {
  test('Desktop: 官方 hotspot 层存在；TEXT 用官方 tooltip；点击 IMAGE 热点 → 媒体 Overlay', async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[page-error]', msg.text());
    });
    await page.goto('/scene/r-8c4e2264e86a');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ov-diagnostics"]');
        if (!el) return false;
        try {
          return JSON.parse(el.textContent ?? '{}').loaded === true;
        } catch {
          return false;
        }
      },
      { timeout: 90000 },
    );

    // 官方 annotation 层（ui:true + scoped CSS 隐藏 chrome 后保留）。
    const hotspots = page.locator('.sse-annotation-hotspots .sse-annotation-hotspot');
    await expect(hotspots).toHaveCount(5, { timeout: 30000 });

    // 官方 chrome 被 scoped CSS 隐藏（.sse-ui display:none）。
    const uiVisible = await page.locator('.sse-ui').first().isVisible().catch(() => false);
    console.log('official .sse-ui visible (expect false):', uiVisible);
    expect(uiVisible).toBe(false);

    // TEXT 热点（index 0）→ 官方 tooltip 直接显示，不打开媒体 Overlay。
    const textHotspot = hotspots.nth(0);
    await textHotspot.evaluate((el) => (el as HTMLElement).click());
    await page.waitForFunction(
      () => document.querySelector('.sse-annotation.sse-visible') !== null,
      { timeout: 10000 },
    );
    const tooltipText = await page
      .locator('.sse-annotation.sse-visible .sse-annotation-text')
      .first()
      .textContent()
      .catch(() => null);
    console.log('TEXT tooltip text (expect sanitized 正文):', JSON.stringify(tooltipText));
    expect(tooltipText).toBe('被 sanitize 的正文');
    const overlayAfterText = await page
      .locator('[data-testid^="annotation-media-overlay-"]')
      .count();
    expect(overlayAfterText).toBe(0);

    // 点击 IMAGE 热点（index 1）→ 官方 camera navigation + 媒体 Overlay。
    await hotspots.nth(1).evaluate((el) => (el as HTMLElement).click());
    await page.waitForSelector('[data-testid^="annotation-media-overlay-"]', { timeout: 15000 });
    const overlay = page.locator('[data-testid^="annotation-media-overlay-"]').first();
    expect(await overlay.getAttribute('data-content-type')).toBe('IMAGE');
    await expect(page.locator('[data-testid="annotation-media-image"]')).toBeVisible();

    // 关闭 Overlay 不清除官方 selection：热点仍为 active（官方选中态保留）。
    // 注：重新点击“同一个”已选热点不会再次触发 selectedAnnotation:changed（官方
    // Observable 仅在值变化时发事件）——这由官方决定，非 GSPlatform 职责。
    await page.click('[data-testid="annotation-media-overlay-close"]');
    await page.waitForFunction(
      () => !document.querySelector('.gs-annotation-media-overlay'),
      { timeout: 10000 },
    );
    const stillActive = await page
      .locator('.sse-annotation-hotspot.sse-active')
      .count();
    console.log('official selection still active after close (expect >=1):', stillActive);
    expect(stillActive).toBeGreaterThanOrEqual(1);

    // 关闭后再点“另一个”媒体热点 → Overlay 重新打开并自动更新（AUDIO）。
    await hotspots.nth(3).evaluate((el) => (el as HTMLElement).click());
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid^="annotation-media-overlay-"]');
        return el !== null && el.getAttribute('data-content-type') === 'AUDIO';
      },
      { timeout: 15000 },
    );
    console.log('re-open with different annotation after close: OK');
    await page.click('[data-testid="annotation-media-overlay-close"]');
  });

  test('Desktop: 切换标注 Overlay 自动更新（VIDEO → AUDIO → PANORAMA）', async ({ page }) => {
    await page.goto('/scene/r-8c4e2264e86a');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ov-diagnostics"]');
        if (!el) return false;
        try {
          return JSON.parse(el.textContent ?? '{}').loaded === true;
        } catch {
          return false;
        }
      },
      { timeout: 90000 },
    );
    const hotspots = page.locator('.sse-annotation-hotspots .sse-annotation-hotspot');
    await expect(hotspots).toHaveCount(5, { timeout: 30000 });

    for (const [idx, type] of [
      [2, 'VIDEO'],
      [3, 'AUDIO'],
      [4, 'PANORAMA'],
    ] as const) {
      await hotspots.nth(idx).evaluate((el) => (el as HTMLElement).click());
      await page.waitForFunction(
        (t) => {
          const el = document.querySelector('[data-testid^="annotation-media-overlay-"]');
          return el !== null && el.getAttribute('data-content-type') === t;
        },
        type,
        { timeout: 15000 },
      );
      console.log(`switch to ${type}: OK`);
    }
    // FIX-03 §2/§4：最后停在 PANORAMA —— 验证真实 360° 渲染器（three.js canvas）
    // 已挂载且未进入错误态（不是退化成 <img>）。
    await page.waitForFunction(
      () => {
        const stage = document.querySelector('.gs-panorama__stage');
        const hasCanvas = stage !== null && stage.querySelector('canvas') !== null;
        const hasError = document.querySelector('[data-testid="panorama-error"]') !== null;
        return hasCanvas && !hasError;
      },
      { timeout: 30000 },
    );
    console.log('PANORAMA real 360° canvas mounted (no error state): OK');
    await page.click('[data-testid="annotation-media-overlay-close"]');
  });
});

test.describe('SSV-06 XR annotation layer', () => {
  test('XR: 官方 hotspot 层存在，点击媒体热点 → Overlay 渲染', async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[xr-page-error]', msg.text());
    });
    await page.goto('/xr/r-8c4e2264e86a');
    await page.waitForSelector('[data-testid="xr-mount"]');
    // 官方 selectAnnotation 需要 state.loaded（XR 页经 diag-state-loaded 暴露）。
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );
    const hotspots = page.locator('.sse-annotation-hotspots .sse-annotation-hotspot');
    await expect(hotspots).toHaveCount(5, { timeout: 60000 });
    console.log('XR hotspot count: 5, state.loaded=true');

    // IMAGE 热点（index 1）→ Overlay。
    await hotspots.nth(1).evaluate((el) => (el as HTMLElement).click());
    await page.waitForSelector('[data-testid^="annotation-media-overlay-"]', { timeout: 15000 });
    expect(await page.locator('[data-testid^="annotation-media-overlay-"]').first().getAttribute('data-content-type')).toBe('IMAGE');
    console.log('XR overlay opened OK');
    await page.click('[data-testid="annotation-media-overlay-close"]');
  });
});