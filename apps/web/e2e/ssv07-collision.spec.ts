/**
 * SSV-07 浏览器验证 —— 官方碰撞数据 + Walk 门控契约。
 *
 * 场景 r-8c4e2264e86a 已构建**真实**碰撞（splat-transform voxel，OUTDOOR 模式）：
 *   voxel gridBounds（collision.voxel.json）：
 *     x ∈ [-4.6, 3.6]  y ∈ [-1.4, 2.6]  z ∈ [7.2, 14.6]
 * 实例：walkAllowed/hasCollision/collisionFormat 来自 ov-diagnostics；
 * camera.position 是 ov-diagnostics 暴露的官方相机 pose（FIX-02 起为
 * camera: {position, target, fov}）。
 *
 * ## 2026-10-14 修订（原用例断言 walkAllowed=true，现已过时）
 *
 * 迁移 `ab02cd03ef04`（独立场景处理策略）之后，「是否允许物理行走」多了一道**真实
 * 尺度**前置条件（`app/services/scene_processing.py`）：
 *
 *     physicalWalkAllowed = calibration.state == "VERIFIED"
 *                            AND metersPerSceneUnit ≈ 1.0
 *                            AND transformIdentity == "identity"
 *
 * 而 `SceneProcessingPatch.calibration` 只接受 `UNVERIFIED | ASSUMED` ——
 * **VERIFIED 不能由 API 自称**（`apps/api/tests/test_collision_policy.py` 的标题就是
 * "no fake VERIFIED fixture"）。本夹具从未做过校准，因此：
 *
 *   - 描述符仍带碰撞资产（`collision.url` = collision.voxel.json，format = voxel）；
 *   - 但 `enabled` 为 false → wrapper **不注入** collisionUrl（SSV-07 §2 的既定行为：
 *     不给未开启碰撞的场景偷偷开启 walk）；
 *   - 官方 viewer 因此 `hasCollision=false`、`walkAllowed=false`，Walk 按钮禁用。
 *
 * 因此原用例里「进入 Walk → 移动 → 碰撞阻止穿墙」的断言**已无法诚实执行**：要让它们
 * 通过就必须伪造一条 VERIFIED 校准，而那正是本仓禁止的事。此处改为断言**当前真实契约**
 * （资产已构建 / walk 被诚实拒绝 / 尺度评估仍然有效），并把「物理行走 + 碰撞」列为
 * **已知覆盖缺口**：需要产品侧先有真实的校准工作流（可产出 VERIFIED），该层 e2e 才
 * 可能诚实地跑起来。后端侧的正确性由 `tests/test_collision_policy.py` 覆盖。
 */
import { expect, test } from './fresh-browser';

async function readDiag(page: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    if (!el) return false;
    try {
      return JSON.parse(el.textContent ?? '{}').loaded === true;
    } catch {
      return false;
    }
  }, { timeout: 90000 });
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'),
  );
}

test.describe('SSV-07 Desktop walk（官方碰撞 voxel）', () => {
  test('未校准场景：碰撞资产已构建，但 walk 被诚实拒绝（详见文件头「2026-10-14 修订」）', async ({ page, request }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[page-error]', msg.text());
    });
    page.on('crash', () => console.log('[page-crash] RENDERER CRASH'));
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));

    // ① 资产侧：碰撞确实**已构建并可用**（不是「根本没有碰撞」）。
    const desc = await (await request.get('/api/v1/scenes/r-8c4e2264e86a/runtime')).json();
    console.log('descriptor collision:', JSON.stringify(desc.collision));
    expect(desc.collision, '描述符必须带碰撞资产').not.toBeNull();
    expect(desc.collision.format).toBe('voxel');
    expect(desc.collision.stale).toBe(false);

    // ② 策略侧：未校准 → enabled=false，且原因可解释。
    const proc = await (await request.get('/api/v1/scenes/r-8c4e2264e86a/processing')).json();
    console.log('calibration:', JSON.stringify(proc.calibration));
    expect(proc.calibration.state, '未做校准 → 不得自称 VERIFIED').not.toBe('VERIFIED');
    expect(proc.calibration.physicalWalkAllowed).toBe(false);
    expect(desc.collision.enabled).toBe(false);

    // ③ 运行时侧：不注入 collisionUrl → 官方未消费碰撞，walk 关闭且按钮禁用。
    await page.goto('/scene/r-8c4e2264e86a?spawn=0,3,10');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });

    const diag = await readDiag(page);
    console.log(
      'diag walkAllowed/hasCollision/format:',
      diag.walkAllowed, diag.hasCollision, diag.collisionFormat,
    );
    expect(diag.walkAllowed).toBe(false);
    expect(diag.hasCollision).toBe(false);
    expect(diag.collisionFormat).toBeNull();
    expect(diag.cameraMode, '不应被偷偷置于 walk 模式').not.toBe('walk');

    // ④ 尺度评估与校准是两件事：未校准不代表尺度异常，仍应给出 ok 评估。
    expect((diag.sceneScale as { status: string }).status).toBe('ok');

    // ⑤ GS-DESKTOP-02：Walk 入口是官方 `.sse-fpsCamera`。无碰撞数据时官方
    //    walkAllowed=false，按钮被官方自己隐藏 —— 不再有宿主自绘 Walk 按钮。
    await expect(page.locator('.sse-fpsCamera')).toHaveCount(1);
    const walkHidden = await page.locator('.sse-fpsCamera').first()
      .evaluate((el) => el.classList.contains('sse-hidden') || !(el as HTMLElement).offsetParent);
    expect(walkHidden, '无碰撞数据时官方 Walk 按钮应隐藏').toBe(true);
  });

  test('无碰撞场景 → walkAllowed=false 且 Walk 按钮禁用', async ({ page }) => {
    // local-garden：manifest 回退场景，无碰撞资产 → 官方 walkAllowed=false。
    await page.goto('/scene/local-garden');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const diag = await readDiag(page);
    console.log('local-garden walkAllowed/hasCollision:', diag.walkAllowed, diag.hasCollision);
    expect(diag.walkAllowed).toBe(false);
    expect(diag.hasCollision).toBe(false);
    await expect(page.locator('.sse-fpsCamera')).toHaveCount(1);
    const walkHidden = await page.locator('.sse-fpsCamera').first()
      .evaluate((el) => el.classList.contains('sse-hidden') || !(el as HTMLElement).offsetParent);
    expect(walkHidden, '无碰撞数据时官方 Walk 按钮应隐藏').toBe(true);
  });
});

test.describe('SSV-07 XR（§8：碰撞资产不得破坏 XR 加载）', () => {
  test('XR 加载成功且碰撞门控与桌面一致（未校准 → walk 关闭，XR 不受影响）', async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[xr-page-error]', msg.text());
    });
    await page.goto('/xr/r-8c4e2264e86a');
    await page.waitForSelector('[data-testid="xr-mount"]');
    // §8 本阶段不做 XR locomotion —— 只确认碰撞资产不破坏 XR 加载：
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );
    const hasCollision = await page
      .locator('[data-testid="diag-has-collision"]')
      .textContent();
    const walkAllowed = await page
      .locator('[data-testid="diag-walk-allowed"]')
      .textContent();
    console.log('XR diag-has-collision:', hasCollision, 'diag-walk-allowed:', walkAllowed);
    // 未校准 → 与桌面同一份门控结果（不是在 XR 上另开一条例外）。
    expect((hasCollision ?? '').trim()).toBe('false');
    expect((walkAllowed ?? '').trim()).toBe('false');
  });
});