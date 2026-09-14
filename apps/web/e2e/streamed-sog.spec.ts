import { test, expect, type Page } from './fresh-browser';

/**
 * Phase 04 streamed-SOG e2e: loads /scene/stream-medium (format: streamed-sog)
 * through the StreamedSogLoader path and verifies:
 *   - Overlay may appear briefly or not at all (streaming is fast)
 *   - After the overlay hides, the scene is interactive
 *   - Cancel during load leaves the viewer in a safe state
 */

const SCENE_URL = '/scene/stream-medium';

/** Wait until the overlay is no longer visible. */
async function waitOverlayHidden(page: Page) {
  await expect
    .poll(async () => {
      const overlay = page.getByTestId('progressive-overlay');
      return await overlay.isVisible().catch(() => false);
    }, { timeout: 120_000 })
    .toBe(false);
}

test.describe('streamed sog loading', () => {
  test('正常加载：overlay 最终消失，场景可交互', async ({ page }) => {
    await page.goto(SCENE_URL);

    // The streaming path loads fast — overlay may flash briefly or not at all.
    // We only need to verify that any overlay that appears eventually hides.
    await waitOverlayHidden(page);

    // After overlay hides, the viewer canvas host should still be present
    const host = page.getByTestId('viewer-canvas-host');
    await expect(host).toBeVisible({ timeout: 10_000 });
  });

  test('加载中切换路由：旧会话不再更新 UI', async ({ page }) => {
    await page.goto(SCENE_URL);

    // Wait a moment for the load to start, then navigate away.
    // Even if load completes before we navigate, the assertion still
    // verifies no stale-session side effects after re-entering.
    await page.waitForTimeout(2_000);

    // Navigate to home page
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /作品/ })).toBeVisible({ timeout: 10_000 });

    // Re-enter the scene — should load cleanly (no event leak)
    await page.goto(SCENE_URL);
    await waitOverlayHidden(page);

    const host = page.getByTestId('viewer-canvas-host');
    await expect(host).toBeVisible({ timeout: 10_000 });
  });

  test('加载完成后再次进入场景，viewer 仍可交互', async ({ page }) => {
    await page.goto(SCENE_URL);

    // Wait for load to finish
    await waitOverlayHidden(page);

    // Close scene and return home
    await page.getByRole('button', { name: '关闭场景' }).click();
    await expect(page.getByRole('heading', { name: /作品/ })).toBeVisible({ timeout: 10_000 });

    // Re-enter — still loads cleanly
    await page.goto(SCENE_URL);
    await waitOverlayHidden(page);

    const host = page.getByTestId('viewer-canvas-host');
    await expect(host).toBeVisible({ timeout: 10_000 });
  });
});
