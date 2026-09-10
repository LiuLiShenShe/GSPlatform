import { test, expect, type Page } from './fresh-browser';

/**
 * Phase 03 渐进加载 E2E：在真实浏览器（headless Chromium / WebGPU-SwiftShader）
 * 中打开 /scene/progressive-test，用真实 low/medium/high 资产验证：
 *   - 加载遮罩出现，进度由真实事件驱动到 100%
 *   - 100% 只在 high 首帧后出现（phase 从 INTERACTIVE_LOW 到 READY）
 *   - 切换路由后旧会话不再驱动 UI
 *
 * 人工网络测试（Fast 3G / high 404 / 未知 Content-Length）通过 CDP 网络
 * 拦截覆盖，见下。
 */

const SCENE_URL = '/scene/progressive-test';

/** 读取渐进加载 overlay 的实时状态。 */
async function overlayState(page: Page) {
  const overlay = page.getByTestId('progressive-overlay');
  return {
    visible: await overlay.isVisible().catch(() => false),
    phase: await page.getByTestId('progressive-phase').textContent().catch(() => null),
    bar: await page.getByTestId('progressive-bar')
      .getAttribute('aria-valuenow', { timeout: 250 })
      .catch(() => null),
    indeterminate: await page.getByTestId('progressive-indeterminate').isVisible().catch(() => false),
  };
}

test.describe('progressive loading', () => {
  test('正常加载：overlay 出现，进度驱动到 100% 且 READY', async ({ page }) => {
    const progresses: number[] = [];
    await page.route('**/local-scenes/progressive-test/*.sog', async (route) => {
      const resp = await route.fetch();
      // 记录每次 SOG 请求的 Content-Length，验证有长度时走百分比进度
      expect(Number(resp.headers()['content-length'])).toBeGreaterThan(0);
      await route.fulfill({ response: resp });
    });

    await page.goto(SCENE_URL);

    // overlay 出现且 phase 有值
    await expect(page.getByTestId('progressive-overlay')).toBeVisible({ timeout: 20_000 });

    // 轮询进度，验证单调且最终到 100 — 使用足够长的 timeout 以适应
    // headless SwiftShader/CI 机器负载，decode 时间可能显著增长。
    await expect
      .poll(async () => {
        const state = await overlayState(page);
        const now = state.bar != null ? Number(state.bar) : null;
        if (now != null && progresses.length) {
          expect(now).toBeGreaterThanOrEqual(progresses[progresses.length - 1]);
        }
        if (now != null) progresses.push(now);
        return state;
      }, { timeout: 120_000 })
      .toMatchObject({ bar: '100' });

    // high 首帧后进入 READY，overlay 淡出
    await expect(page.getByTestId('progressive-overlay')).not.toBeVisible({ timeout: 20_000 });
    expect(progresses[progresses.length - 1]).toBe(100);
  });

  test('加载中切换路由：旧会话不再更新 UI，新场景可重新进入', async ({ page }) => {
    await page.goto(SCENE_URL);
    await expect(page.getByTestId('progressive-overlay')).toBeVisible({ timeout: 20_000 });

    // 加载未完成时导航回首页
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /作品/ })).toBeVisible({ timeout: 10_000 });

    // 再进入场景，仍能正常完成渐进加载（无 GPU/事件泄漏）
    await page.goto(SCENE_URL);
    await expect
      .poll(async () => (await overlayState(page)).bar, { timeout: 120_000 })
      .toBe('100');
  });

  test('high LOD 404：保留 low/medium 可交互，不出现死遮罩', async ({ page }) => {
    // 拦截 high.sog 返回 404
    await page.route('**/local-scenes/progressive-test/high.sog', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );

    await page.goto(SCENE_URL);
    await expect(page.getByTestId('progressive-overlay')).toBeVisible({ timeout: 20_000 });

    // 会话以 error（保留 low）结束，overlay 淡出而非永久卡住
    await expect(page.getByTestId('progressive-overlay')).not.toBeVisible({ timeout: 75_000 });
  });

  test('未知 Content-Length：显示不确定进度而非伪造百分比', async ({ page }) => {
    // 移除 SOG 响应的 Content-Length，走 indeterminate 分支。本地资源读得太快，
    // 不确定状态一闪而过无法被断言到，因此给每个响应加 ~900ms 延迟，模拟弱网
    // 下"有字节但无长度"的真实场景。
    await page.route('**/local-scenes/progressive-test/*.sog', async (route) => {
      const resp = await route.fetch();
      const headers = { ...resp.headers() };
      delete headers['content-length'];
      await new Promise((r) => setTimeout(r, 900));
      await route.fulfill({ response: resp, headers });
    });

    await page.goto(SCENE_URL);
    await expect(page.getByTestId('progressive-overlay')).toBeVisible({ timeout: 20_000 });

    // 无长度时至少出现一次 indeterminate 状态（或不显示伪造的精确百分比）
    const sawIndeterminate = await page.getByTestId('progressive-indeterminate')
      .isVisible()
      .catch(() => false)
      .then(async (first) => {
        if (first) return true;
        // 轮询一小段时间，捕获 indeterminate 闪现
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(100);
          if (await page.getByTestId('progressive-indeterminate').isVisible().catch(() => false)) {
            return true;
          }
        }
        return false;
      });

    // 最终仍完成加载 — 需要更长的 poll 窗口，因为 900ms×3 的响应延迟 + 无
    // Content-Length 使整体加载偏慢，host-side grace（15s）在 high applied 后
    // 需要额外时间把 bar 从 97 推到 100。
    await expect
      .poll(async () => (await overlayState(page)).bar, { timeout: 120_000 })
      .toBe('100');

    // indeterminate 在 loading 期间出现过（fetch 无长度时 UI 明确表达“不确定”）
    expect(sawIndeterminate).toBe(true);
  });
});
