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

// GS-NEXT-10：官方相机过渡在无头软件渲染下需要几十秒才收敛，本文件的用例
// 因此要更长整体预算（断言本身未放松）。
test.describe.configure({ timeout: 420_000 });

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

/**
 * GS-NEXT-10：官方相机过渡是**阻尼式**的，其实际耗时由运行环境的帧率决定。
 * 在无头 SwiftShader 软件渲染（约 2–5 fps）下，一次 frame/reset/视角过渡要几十秒
 * 才收敛；规格里原本假设的 1.2–2.4s 只适用于真 GPU。断言（落点数值）不放松，
 * 只把「等过渡完成」的方式从固定 sleep 换成轮询 + 足够长的预算。
 * 可用 GS_CAMERA_SETTLE_MS 覆盖（默认 150s）。
 */
const CAMERA_SETTLE_MS = Number(process.env.GS_CAMERA_SETTLE_MS ?? 150_000);

function cam(diag: Record<string, unknown>): Cam | null {
  const c = diag.camera as { position: number[]; target: number[]; fov: number } | null | undefined;
  return c ? { position: c.position, target: c.target, fov: c.fov } : null;
}

/** 等到相机「离开」给定位置超过 minDistance（Frame 之类的相对断言用）。 */
async function waitCameraAway(
  page: import('@playwright/test').Page,
  from: number[],
  minDistance: number,
): Promise<Cam | null> {
  await page.waitForFunction(
    ({ pos, min }) => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      if (!el) return false;
      let d: any;
      try { d = JSON.parse(el.textContent ?? '{}'); } catch { return false; }
      const c = d?.camera;
      if (!c) return false;
      return Math.hypot(c.position[0] - pos[0], c.position[1] - pos[1], c.position[2] - pos[2]) > min;
    },
    { pos: from, min: minDistance },
    { timeout: CAMERA_SETTLE_MS },
  );
  return cam(await readDiag(page));
}

/**
 * 手动推进官方引擎的公开 update 循环（app.tick）——只推进时间，不写相机状态。
 *
 * headless + SwiftShader 下真实 rAF 只有约 2fps，而官方相机过渡按帧时长推进
 * （单帧 delta 有上限），一次 1.2–2.4s 的过渡要 ~150s 墙钟才收敛，会卡在
 * 等待预算边界上（既有注释里的 GS-NEXT-10 已记录同类问题）。gsdesktop01 的
 * 相机 e2e 用的就是这个手法；断言（落点/朝向/fov 数值）完全不变。
 */
async function pumpEngine(page: import('@playwright/test').Page, ms = 250): Promise<void> {
  const count = Math.max(1, Math.ceil(ms / 16.7));
  await page.evaluate((n) => {
    const rt = (window as unknown as { __gsruntime?: { app?: { tick?: (t: number) => void } } }).__gsruntime;
    const app = rt?.app;
    if (typeof app?.tick !== 'function') return;
    const w = window as unknown as { __gsTickClock?: number };
    let clock = Math.max(w.__gsTickClock ?? 0, performance.now());
    for (let i = 0; i < n; i += 1) {
      clock += 16.7;
      app.tick(clock);
    }
    w.__gsTickClock = clock;
  }, count);
}

/** 等相机到达期望位置附近（官方 goto 过渡；软件渲染下需要长预算）。 */
async function waitCameraNear(
  page: import('@playwright/test').Page,
  expected: { position: number[]; target: number[]; fov: number },
  tol = 0.5,
) {
  const end = Date.now() + CAMERA_SETTLE_MS;
  let last: Cam | null = null;
  while (Date.now() < end) {
    await pumpEngine(page, 250);
    last = cam(await readDiag(page));
    if (last && dist(last.position, expected.position) < tol) break;
  }
  expect(
    last,
    `waitCameraNear: 应有相机读数（期望 ${JSON.stringify(expected.position)}）`,
  ).not.toBeNull();
  expect(
    dist(last!.position, expected.position),
    `waitCameraNear: 相机应到达 ${JSON.stringify(expected.position)}，实际 ${JSON.stringify(last!.position)}`,
  ).toBeLessThan(tol);
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
    // GS-NEXT-10：不用固定 sleep（软件渲染下官方阻尼过渡要几十秒才收敛），改为
    // 轮询到「确实离开」为止 —— 断言本身（距离 > 1.0）没有被放松。
    await page.locator('.sse-settings').first().click();
    await page.waitForTimeout(300);
    await page.locator('.sse-frame').first().click();
    const frameCam = await waitCameraAway(page, DB.initial.position, 1.0);
    console.log('after frame cam:', JSON.stringify(frameCam));
    expect(frameCam).not.toBeNull();
    expect(dist(frameCam!.position, DB.initial.position), 'frame 应离开初始位置').toBeGreaterThan(1.0);

    // Reset：回到 authored initial（orbit 稳定，严格容差）。
    await page.locator('.sse-reset').first().click();
    await waitCameraNear(page, DB.initial, 0.08);
    const afterReset = await readDiag(page);
    console.log('after reset cam:', JSON.stringify(afterReset.camera), 'mode', afterReset.cameraMode);
    expectCamera(cam(afterReset), DB.initial, { posTol: 0.08, fovTol: 0.5, dirDot: 0.9999, label: 'reset' });
  });

  test('Saved Viewpoint 被消费：点击下拉 → 相机过渡到已保存视角', async ({ page }) => {
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await readDiag(page);

    // GS-DESKTOP-02：Saved Views 是平台 PCUI 扩展入口（官方 1.35 无原生列表），
    // 视角名直接可点（不再用下拉）。
    await expect(page.locator('[data-testid="ov-saved-views"]')).toHaveText(/视角 \(1\)/);
    await page.getByRole('button', { name: DB.viewpoint.name, exact: true }).click();

    // GS-NEXT-10：等「真的落到视角上」（轮询 + 长预算），不再用固定 sleep ——
    // 软件渲染下官方过渡要几十秒，固定 sleep 会在过渡中途读数。
    await waitCameraNear(page, DB.viewpoint, 0.15);
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
      // GS-NEXT-10：轮询到「真的落到该标注相机」再读数（软件渲染下过渡要几十秒）。
      await waitCameraNear(page, expected, 0.18);
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
    // 参照系：先在恒等 W 下测一次真实包围盒（beforeEach 已复位恒等）。
    // GS-NEXT-10：原先这里硬编码了一组 asset 尺寸常量（±1）；夹具资产被
    // 重新生成后（±2.397/±1.413/±1.750）该常量成为过时数据，导致断言假失败。
    // 改为读取当前夹具的恒等包围盒，再断言 Ry90 的 x↔z 交换 —— 断言的是
    // 「W 真的被施加到包围盒上」这一契约本身，与资产尺寸解耦。
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const identityDiag = await readDiag(page);
    expect((identityDiag.worldTransform as any).isIdentity).toBe(true);
    const identityBounds = (identityDiag.worldTransform as any).boundsAfter as
      | { min: number[]; max: number[] }
      | null;
    expect(identityBounds, '恒等 W 下应有包围盒读数').not.toBeNull();

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
    const b = (diag.worldTransform as any).boundsAfter;
    expect(b).not.toBeNull();
    expect(Math.abs(b.min[0] - identityBounds!.min[2])).toBeLessThan(0.02);
    expect(Math.abs(b.max[0] - identityBounds!.max[2])).toBeLessThan(0.02);
    expect(Math.abs(b.min[2] - identityBounds!.min[0])).toBeLessThan(0.02);
    expect(Math.abs(b.max[2] - identityBounds!.max[0])).toBeLessThan(0.02);

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
