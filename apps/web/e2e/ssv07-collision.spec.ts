/**
 * SSV-07 临时浏览器验证（验证后删除）—— 官方碰撞 + Walk 模式。
 *
 * 场景 r-8c4e2264e86a 已构建真实碰撞（splat-transform voxel，OUTDOOR 模式）：
 *   voxel gridBounds（collision.voxel.json）：
 *     x ∈ [-4.6, 3.6]  y ∈ [-1.4, 2.6]  z ∈ [7.2, 14.6]
 * 实例：walkAllowed/hasCollision/collisionFormat 来自 ov-diagnostics；
 * cameraPosition 也是 ov-diagnostics 暴露的官方 camera pose。
 */
import { expect, test } from './fresh-browser';

const GRID = { xMin: -4.6, xMax: 3.6, yMin: -1.4, yMax: 2.6, zMin: 7.2, zMax: 14.6 };

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

function cameraPosition(diag: Record<string, unknown>): [number, number, number] | null {
  const p = diag.cameraPosition as number[] | null | undefined;
  return p && p.length === 3 ? [p[0], p[1], p[2]] : null;
}

test.describe('SSV-07 Desktop walk（官方碰撞 voxel）', () => {
  test('walkAllowed=true；进入 Walk 移动；碰撞阻止穿出 voxel 网格；退出恢复', async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[page-error]', msg.text());
    });
    page.on('crash', () => console.log('[page-crash] RENDERER CRASH'));
    page.on('pageerror', (err) => console.log('[pageerror]', err.message));
    // 把相机直接放进场景上方（官方 frame 相机在包围盒外，walk 会坠落）——
    // ?spawn= 是测试定位参数，见 SceneViewerPage。
    await page.goto('/scene/r-8c4e2264e86a?spawn=0,3,10');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });

    const diag0 = await readDiag(page);
    console.log(
      'diag0 walkAllowed/hasCollision/format:', diag0.walkAllowed, diag0.hasCollision, diag0.collisionFormat,
    );
    expect(diag0.walkAllowed).toBe(true);
    expect(diag0.hasCollision).toBe(true);
    expect(diag0.collisionFormat).toBe('voxel');
    expect((diag0.sceneScale as { status: string }).status).toBe('ok');

    // 等渐进式 splat 加载继续流式（headless SwiftShader 下过早交互会让 GPU
    // 进程崩溃 —— 探针实测 loaded 后多等 ~1s 即稳定）。
    await page.waitForTimeout(1500);

    // 尺度正常 → 无校准告警。
    await expect(page.locator('[data-testid="ov-scale-warning"]')).toHaveCount(0);

    // Walk 按钮可用。
    const walkBtn = page.locator('[data-testid="ov-walk"]');
    await expect(walkBtn).toBeEnabled();

    // 进入 Walk：真实按钮点击（onClick = runtime.toggleWalk —— 官方 toggleWalk）。
    await walkBtn.click();
    await page.waitForFunction(
      () => JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? '{}').cameraMode === 'walk',
      { timeout: 15000 },
    );
    console.log('walk mode entered OK');

    // 等 capsule 在重力下落在 voxel 表面（官方胶囊物理，不做任何自建控制器）。
    await page.waitForTimeout(2500);
    const diag1 = await readDiag(page);
    const p1 = cameraPosition(diag1);
    console.log('settled pos:', p1);
    expect(p1).not.toBeNull();
    // 落定后 y 在网格范围内（没有穿地/坠落，也没漂浮）。
    expect(p1![1]).toBeGreaterThan(GRID.yMin - 0.2);
    expect(p1![1]).toBeLessThan(GRID.yMax + 0.5);

    // 前移（KeyW ~700ms，官方 walk 键盘输入）。
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(700);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    const diag2 = await readDiag(page);
    const p2 = cameraPosition(diag2);
    console.log('after W pos:', p2);
    expect(p2).not.toBeNull();
    const moved = Math.hypot(p2![0] - p1![0], p2![1] - p1![1], p2![2] - p1![2]);
    console.log('W moved distance:', moved.toFixed(3));
    expect(moved).toBeGreaterThan(0.15); // 确实在走

    // 在同一次 walk 会话中继续前顶 1.5s：碰撞必须阻止穿出 voxel 网格
    // （capsule 会被推近 z=7.2 侧墙并被撞停，停在网格范围内、高度不塌）。
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    const diag3 = await readDiag(page);
    const p3 = cameraPosition(diag3);
    console.log('after long W pos:', p3);
    expect(p3).not.toBeNull();
    expect(p3![0]).toBeGreaterThanOrEqual(GRID.xMin - 0.3);
    expect(p3![0]).toBeLessThanOrEqual(GRID.xMax + 0.3);
    expect(p3![2]).toBeGreaterThanOrEqual(GRID.zMin - 0.3);
    expect(p3![2]).toBeLessThanOrEqual(GRID.zMax + 0.3);
    // 高度不塌（碰撞撑住 capsule，没有穿模掉出网格）。
    expect(p3![1]).toBeGreaterThan(GRID.yMin - 0.2);

    // 退出 Walk → 恢复 walk 前模式（orbit/fly，不再是 walk）。
    // 退出走官方 toggleWalk（window.__gsruntime）：重复 hover 真实按钮会让
    // antd Tooltip 挡住点击区（Playwright actionability 卡住），且 SwiftShader
    // 下长时间 walk 后 DOM 点击偶发 GPU 进程退出。按钮行为本体（onClick=
    // toggleWalk / enabled 门控）已由工具栏单测 + 「无碰撞场景禁用」e2e 覆盖。
    const toggleWalk = () =>
      page.evaluate(() => {
        (window as unknown as { __gsruntime?: { toggleWalk(): void } }).__gsruntime?.toggleWalk();
      });
    await toggleWalk();
    await page.waitForFunction(
      () => JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? '{}').cameraMode !== 'walk',
      { timeout: 15000 },
    );
    const diagExit = await readDiag(page);
    console.log('exit walk cameraMode:', diagExit.cameraMode);
    expect(diagExit.cameraMode).not.toBe('walk');
  });

  test('无碰撞场景 → walkAllowed=false 且 Walk 按钮禁用', async ({ page }) => {
    // local-garden：manifest 回退场景，无碰撞资产 → 官方 walkAllowed=false。
    await page.goto('/scene/local-garden');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const diag = await readDiag(page);
    console.log('local-garden walkAllowed/hasCollision:', diag.walkAllowed, diag.hasCollision);
    expect(diag.walkAllowed).toBe(false);
    expect(diag.hasCollision).toBe(false);
    await expect(page.locator('[data-testid="ov-walk"]')).toBeDisabled();
  });
});

test.describe('SSV-07 XR（§8：碰撞资产不得破坏 XR 加载）', () => {
  test('XR 加载成功且碰撞数据被官方消费（hasCollision/walkAllowed）', async ({ page }) => {
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
    expect((hasCollision ?? '').trim()).toBe('true');
    expect((walkAllowed ?? '').trim()).toBe('true');
  });
});