/**
 * FIX-02 §19 —— 真实浏览器验证（headless SwiftShader + 临时 dev proxy :5174）。
 *
 * 场景 fix02-semantics（DB 合同）：
 *   - authored Initial Camera: position [2.5,1.8,6] / target [0,0.6,0] / fov 47
 *   - 3 条标注 A/B/C，各带**不同**相机（position 1.0/4.5、-2.0/5.0、0.5/6.5）
 *   - 1 个已保存视角「正门视角」[3,2,7] / target [0,0.5,0] / fov 52
 *   - Phase A: 恒等世界变换（§4 直接与 DB 数值比较）
 *   - Phase B: 非恒等 W（rotation y=90）→ 实体/相机/包围盒随 W 换算
 *
 * 断言策略（FIX-02 §4「合理浮点误差」）：
 *   - position/fov 数值比较；look 方向比较 **normalized forward**（官方
 *     getCameraPose 的 target 是 position + forward×包围盒深度，不是作者 target
 *     点本身 —— 方向一致即构图一致）。
 *   - 加载瞬间是 'anim'（官方 20s figure8 轨迹，t=0 = authored initial，随后漂移），
 *     因此加载读数用宽松容差；Reset/视角/标注用过渡完成的严格容差。
 *
 * 依赖（仅验证运行时，不入库）：
 *   - 临时 Vite dev server :5174（vite.e2e.local.ts 加 /api → :8001 proxy）
 *   - API :8001（dev bypass，CORS 含 :5174）
 */
import { expect, test } from './fresh-browser';
import { SceneTransformAdapter } from '../src/scene-runtime/SceneTransformAdapter';

const API = 'http://127.0.0.1:8001/api/v1/scenes/fix02-semantics';
const SCENE = 'fix02-semantics';

const DB = {
  initial: { position: [2.5, 1.8, 6.0], target: [0.0, 0.6, 0.0], fov: 47.0 },
  annotations: [
    { title: '标注A', position: [1.0, 1.6, 4.5], target: [-0.5, 0.8, 0.0], fov: 40.0 },
    { title: '标注B', position: [-2.0, 1.5, 5.0], target: [0.2, 0.6, 0.0], fov: 50.0 },
    { title: '标注C', position: [0.5, 1.4, 6.5], target: [0.9, 0.5, 0.0], fov: 60.0 },
  ],
  viewpoint: { name: '正门视角', position: [3.0, 2.0, 7.0], target: [0.0, 0.5, 0.0], fov: 52.0 },
};

interface Cam {
  position: number[];
  target: number[];
  fov: number;
}

function fwd(c: { position: number[]; target: number[] }): number[] {
  const dx = c.target[0] - c.position[0];
  const dy = c.target[1] - c.position[1];
  const dz = c.target[2] - c.position[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  return [dx / len, dy / len, dz / len];
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 断言相机与期望一致（期望经世界变换换算到 RUNTIME 空间）。 */
function expectCamera(
  actual: Cam | null,
  expected: { position: number[]; target: number[]; fov: number },
  opts: { posTol: number; fovTol: number; dirDot: number; label: string },
) {
  expect(actual, `${opts.label}: 应有相机读数`).not.toBeNull();
  const a = actual!;
  expect(dist(a.position, expected.position), `${opts.label}: position`).toBeLessThan(opts.posTol);
  expect(Math.abs(a.fov - expected.fov), `${opts.label}: fov`).toBeLessThan(opts.fovTol);
  expect(
    dot(fwd(a), fwd(expected)),
    `${opts.label}: look 方向`,
  ).toBeGreaterThan(opts.dirDot);
}

async function readDiag(page: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      if (!el) return false;
      try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
    },
    { timeout: 90000 },
  );
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'),
  );
}

function cam(diag: Record<string, unknown>): Cam | null {
  const c = diag.camera as { position: number[]; target: number[]; fov: number } | null | undefined;
  return c ? { position: c.position, target: c.target, fov: c.fov } : null;
}

/** 等相机到达期望位置附近（官方 goto 过渡 1.2–2.4s）。 */
async function waitCameraNear(
  page: import('@playwright/test').Page,
  expected: { position: number[]; target: number[]; fov: number },
  tol = 0.5,
) {
  await page.waitForFunction(
    ({ pos, tol: t }) => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      if (!el) return false;
      let d: any;
      try { d = JSON.parse(el.textContent ?? '{}'); } catch { return false; }
      const c = d?.camera;
      if (!c) return false;
      return Math.hypot(c.position[0] - pos[0], c.position[1] - pos[1], c.position[2] - pos[2]) < t;
    },
    { pos: expected.position, tol },
    { timeout: 15000 },
  );
}

// 兜底：每个测试前把世界变换复位恒等（World Transform 测试会在自身内设非恒等并
// finally 复位；此处保证任一测试失败不会把非恒等 W 泄漏给后续测试）。
// 注意：presentation PATCH 忽略 null（None=「不变」），故用显式 {0,0,0} ——
// adapter 归一化为恒等（isIdentity=true）。
test.beforeEach(async () => {
  await fetch(`${API}/presentation`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worldRotation: { x: 0, y: 0, z: 0 } }),
  });
});

test.describe('FIX-02 §19 Desktop（authored camera / frame / reset / viewpoint / annotations）', () => {
  test('加载即用 authored Initial Camera（position/fov/look 与 DB 一致，未被 frameScene 覆盖）', async ({ page }) => {
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });
    const diag = await readDiag(page);
    console.log('load diag mode/camera:', diag.cameraMode, JSON.stringify(diag.camera));
    // 动画轨迹 t=0 = authored initial，随后 figure8 漂移 → 宽松容差。
    expectCamera(cam(diag), DB.initial, { posTol: 0.35, fovTol: 0.6, dirDot: 0.99, label: 'load' });
    // 世界变换恒等 → 诊断原样报告。
    expect((diag.worldTransform as any).isIdentity).toBe(true);
  });

  test('Frame Scene 取景整个场景；Reset 恢复 authored Initial（严格数值）', async ({ page }) => {
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await readDiag(page);

    // Frame：相机应离开 authored 初始构图（取景整个场景）。
    await page.click('[data-testid="ov-frame"]');
    await page.waitForTimeout(1800);
    const afterFrame = await readDiag(page);
    const frameCam = cam(afterFrame);
    console.log('after frame cam:', JSON.stringify(frameCam));
    expect(frameCam).not.toBeNull();
    expect(dist(frameCam!.position, DB.initial.position), 'frame 应离开初始位置').toBeGreaterThan(1.0);

    // Reset：回到 authored initial（orbit 稳定，严格容差）。
    await page.click('[data-testid="ov-reset"]');
    await page.waitForTimeout(2000);
    const afterReset = await readDiag(page);
    console.log('after reset cam:', JSON.stringify(afterReset.camera), 'mode', afterReset.cameraMode);
    expectCamera(cam(afterReset), DB.initial, { posTol: 0.08, fovTol: 0.5, dirDot: 0.9999, label: 'reset' });
  });

  test('Saved Viewpoint 被消费：点击下拉 → 相机过渡到已保存视角', async ({ page }) => {
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await readDiag(page);

    const btn = page.locator('[data-testid="ov-saved-views"]');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText(/视角 \(1\)/);
    await btn.click();
    await page.getByText(DB.viewpoint.name, { exact: true }).click();

    await waitCameraNear(page, DB.viewpoint, 0.6);
    await page.waitForTimeout(1200); // 让过渡完全稳定
    const diag = await readDiag(page);
    console.log('after viewpoint cam:', JSON.stringify(diag.camera));
    expectCamera(cam(diag), DB.viewpoint, { posTol: 0.15, fovTol: 1.0, dirDot: 0.999, label: 'viewpoint' });
  });

  test('3 条标注各自相机：A→A / B→B / C→C（互不相同，≠ 场景初始）', async ({ page }) => {
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await readDiag(page);

    const hotspots = page.locator('.sse-annotation-hotspots .sse-annotation-hotspot');
    await expect(hotspots).toHaveCount(3, { timeout: 30000 });

    const landings: number[][] = [];
    for (let i = 0; i < 3; i += 1) {
      const expected = DB.annotations[i];
      await hotspots.nth(i).evaluate((el) => (el as HTMLElement).click());
      await waitCameraNear(page, expected, 0.6);
      await page.waitForTimeout(1500); // 过渡稳定
      const diag = await readDiag(page);
      const pose = cam(diag);
      console.log(`annotation ${i} (${expected.title}) cam:`, JSON.stringify(pose));
      expectCamera(pose, expected, { posTol: 0.18, fovTol: 1.2, dirDot: 0.999, label: `annotation ${i}` });
      landings.push(pose!.position);
    }
    // 三个落点两两不同。
    for (let a = 0; a < 3; a += 1) {
      for (let b = a + 1; b < 3; b += 1) {
        expect(dist(landings[a], landings[b]), `annotation ${a} vs ${b} 相机应不同`).toBeGreaterThan(0.5);
      }
      expect(dist(landings[a], DB.initial.position), `annotation ${a} 相机 ≠ 场景初始`).toBeGreaterThan(0.5);
    }
  });
});

test.describe('FIX-02 §5/§9 World Transform（非恒等 W 真正执行）', () => {
  test('rotation y=90：实体/相机/包围盒随 W 统一换算', async ({ page }) => {
    // Phase A 恒等 → 非恒等 W（dev bypass 无 CSRF）。
    const patch = await fetch(`${API}/presentation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worldRotation: { x: 0, y: 90, z: 0 } }),
    });
    expect(patch.ok, 'presentation PATCH 应成功').toBe(true);

    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const diag = await readDiag(page);
    console.log('W diag worldTransform:', JSON.stringify(diag.worldTransform));
    expect((diag.worldTransform as any).isIdentity).toBe(false);
    expect((diag.worldTransform as any).rotation).toEqual({ x: 0, y: 90, z: 0 });

    // 期望：RUNTIME 空间 = W(scene)（adapter 换算，与单元测试同数学）。
    const adapter = SceneTransformAdapter.fromWorldTransform({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 90, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    const expectedCam = adapter.sceneToRuntimeCamera({
      position: { x: DB.initial.position[0], y: DB.initial.position[1], z: DB.initial.position[2] },
      target: { x: DB.initial.target[0], y: DB.initial.target[1], z: DB.initial.target[2] },
      fov: DB.initial.fov,
    });
    console.log('expected transformed camera:', JSON.stringify(expectedCam));
    expectCamera(cam(diag), {
      position: [expectedCam.position.x, expectedCam.position.y, expectedCam.position.z],
      target: [expectedCam.target.x, expectedCam.target.y, expectedCam.target.z],
      fov: expectedCam.fov,
    }, { posTol: 0.12, fovTol: 0.6, dirDot: 0.9999, label: 'W-transformed initial' });

    // 包围盒随实体世界变换移动：Ry90 后 min/max 的 x 轴 = 恒等时的 z 轴
    // （角点归属互换，数值上 x↔z 交换），不再是恒等轮廓。
    const IDENTITY_BOUNDS = { min: [-1, -1.499, -0.982], max: [1, 0.499, 0.996] };
    const b = (diag.worldTransform as any).boundsAfter;
    expect(b).not.toBeNull();
    expect(Math.abs(b.min[0] - IDENTITY_BOUNDS.min[2])).toBeLessThan(0.02);
    expect(Math.abs(b.max[0] - IDENTITY_BOUNDS.max[2])).toBeLessThan(0.02);
    expect(Math.abs(b.min[2] - IDENTITY_BOUNDS.min[0])).toBeLessThan(0.02);
    expect(Math.abs(b.max[2] - IDENTITY_BOUNDS.max[0])).toBeLessThan(0.02);

    // 清理：恢复恒等 W（断言失败也执行）。
    await fetch(`${API}/presentation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worldRotation: { x: 0, y: 0, z: 0 } }),
    });
  });
});

test.describe('FIX-02 §16 XR 预览（进入 VR 前初始构图 = authored initial）', () => {
  test('XR 页（强制 WebGL）加载后 camera pose 与 DB authored initial 一致', async ({ page }) => {
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 140)); });
    await page.goto(`/xr/${SCENE}`);
    await page.waitForSelector('[data-testid="xr-mount"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );
    const renderer = (await page.locator('[data-testid="diag-renderer"]').textContent()) ?? '';
    console.log('XR renderer:', renderer.trim());
    expect(renderer.trim()).toMatch(/^webgl/i);
    const txt = (await page.locator('[data-testid="diag-camera"]').textContent()) ?? '';
    console.log('XR pre-VR camera:', txt.trim());
    const parts = txt.trim().split('/').map((s) => s.trim());
    expect(parts.length).toBe(3);
    const pos = parts[0].split(',').map((s) => parseFloat(s.trim()));
    const fov = parseFloat(parts[2]);
    // 进入 VR 前的初始构图 = authored initial（anim t=0，宽松容差）。
    expect(dist(pos, DB.initial.position)).toBeLessThan(0.4);
    expect(Math.abs(fov - DB.initial.fov)).toBeLessThan(0.6);
  });
});
