/**
 * GS-NEXT-03 §五 —— 官方 Viewpoint 快速切换（真实浏览器验证）。
 *
 * 验证四类要求（Case 1-4），全部经**真实 UI 或真实 API**（无 mock Gaussian 资产）：
 *   Case 1 创建视点 → 保存 → 刷新 → 点击 → 相机恢复该位置；
 *   Case 2 A/B/C 依次切换 —— 动画正常、无跳飞、无鸟瞰；
 *   Case 3 Desktop 消费视点；
 *   Case 4 XR 进入 VR 前选择视点 → 出生位姿 = 该视点（软件证据；真机 PENDING）。
 *
 * 「无跳飞 / 动画正常」用**过渡轨迹**判定：相机切换是官方 CameraManager 的约 1s
 * 过渡动画（官方 viewer 内 `startTransition(duration=1)`，from=点击瞬间位姿）。因此
 * 打开 `?diagnostics=1`（工程读数通道，采样率提到 20Hz；生产节奏不变），在切换
 * 期间连续采样相机位置：
 *   - 连续性：相邻样本位移 ≪ 全程距离（瞬间传送会违反）；
 *   - 有界：任何样本都不离开 A/B 的邻域（跳到远处取景/鸟瞰会违反）。
 *
 * 依赖：HEAD API（隔离库）+ vite dev。场景 fix02-semantics 为 DB 合同夹具。
 */
import { expect, test } from './fresh-browser';

const SCENE = 'fix02-semantics';
const API = `/api/v1/scenes/${SCENE}`;

/**
 * GS-NEXT-10：官方相机过渡是**阻尼式**的，耗时随环境帧率变化。
 * 在无头软件渲染下要几十秒才收敛，这里给足预算（断言本身未放松）。
 */
// GS-NEXT-10 实测（full Chromium, 58 rAF/s）：官方 `selectAnnotation` 是
// 阻尼式过渡（OrbitController damping 0.95/帧），落位到 0.15 只需几秒，但
// 收敛到 0.05 还要再走一段长尾（实测 A→B 约 60s）。断言容差不变，只给足
// 等待预算。
const CAMERA_SETTLE_MS = Number(process.env.GS_CAMERA_SETTLE_MS ?? 420_000);

// GS-NEXT-10：整体用例预算同步放宽（软件渲染 + 真实浏览器）。
// Case 1 要跑两次完整 Viewer 加载（创作页 + 消费页）再等一次落位；在软件渲染
// + 高负载机器上实测 >600s，故给 900s 预算（断言不变）。
test.describe.configure({ timeout: 1_500_000 });

/** 该夹具出厂的 authored 初始视角（无 authored 相机时的官方取景是另一个位置）。 */
const AUTHORED = { position: [2.5, 1.8, 6.0], fov: 47 };

interface Cam { position: number[]; target: number[]; fov: number }

type ApiRequest = import('@playwright/test').APIRequestContext;
type Page = import('@playwright/test').Page;

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 打开场景页并等 Viewer 就绪（诊断模式下采样率更高）。 */
async function openScene(page: Page, withDiagnostics = false): Promise<void> {
  await page.goto(`/scene/${SCENE}${withDiagnostics ? '?diagnostics=1' : ''}`);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    if (!el) return false;
    try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
  }, { timeout: 90000 });
}

async function readDiag(page: Page): Promise<any> {
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'));
}

function cam(diag: any): Cam | null {
  return diag?.camera
    ? { position: diag.camera.position, target: diag.camera.target, fov: diag.camera.fov }
    : null;
}

/** 等相机稳定在目标位置附近（官方过渡完成后；软件渲染下需要长预算）。 */
async function waitCameraNear(page: Page, expected: number[], tol: number, timeout = CAMERA_SETTLE_MS) {
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
    { pos: expected, tol },
    { timeout },
  );
}

/** 在过渡期间以固定间隔连续采样相机位置（判定动画连续性 / 无跳飞）。 */
async function sampleCameraTrack(page: Page, durationMs: number): Promise<number[][]> {
  return page.evaluate((dur) => new Promise<number[][]>((resolve) => {
    const out: number[][] = [];
    const t0 = performance.now();
    const step = () => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      try {
        const c = JSON.parse(el?.textContent ?? '{}').camera;
        if (c) out.push(c.position);
      } catch { /* 读数瞬时不可用：跳过该样本 */ }
      if (performance.now() - t0 < dur) requestAnimationFrame(step);
      else resolve(out);
    };
    requestAnimationFrame(step);
  }), durationMs);
}

/** Desktop 工具栏：Saved Views 下拉 → 点选某个视点。 */
async function clickSavedView(page: Page, name: string): Promise<void> {
  await page.click('[data-testid="ov-saved-views"]');
  // 菜单项是 antd Dropdown portal（.ant-dropdown-menu-title-content）。先等它
  // 真正可见再点 —— 软件渲染下菜单动画/主线程繁忙会让「找到即点」偶发超时，
  // 这是测试交互时序，不是产品行为（点击后相机确实导航）。
  const item = page.getByText(name, { exact: true });
  await expect(item).toBeVisible({ timeout: 30000 });
  await item.click({ timeout: 30000 });
}

/** 读某视点的 SCENE 空间 pose（用于计算期望）。 */
async function viewpointPose(request: ApiRequest, id: string) {
  const r = await request.get(`${API}/viewpoints`);
  expect(r.status()).toBe(200);
  const list = await r.json();
  const vp = list.find((v: { id: string }) => v.id === id);
  expect(vp, `视点 ${id} 应存在`).toBeTruthy();
  return { id: vp.id, name: vp.name, position: vp.position as { x: number; y: number; z: number } };
}

async function createViewpoint(
  request: ApiRequest,
  name: string,
  position: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  fov: number,
) {
  const r = await request.post(`${API}/viewpoints`, {
    data: { name, position, target, fov },
  });
  expect(r.status(), `创建视点 ${name}`).toBe(201);
  return (await r.json()) as { id: string };
}

/** 删除本 spec 创建的视点（保留夹具自带的「正门视角」）。 */
async function cleanupViewpoints(request: ApiRequest, ids: string[]): Promise<void> {
  for (const id of ids) {
    await request.delete(`${API}/viewpoints/${id}`);
  }
}

const created: string[] = [];

/** 本 spec 创建的视点名前缀（beforeEach 清理，保证用例可重复运行）。 */
const TEST_NAME_PREFIXES = ['GS-NEXT-03 视点A', 'NEXT03-', 'SEQ-', 'XR-出生点'];

/** 清掉历史失败运行遗留的同名视点（只删本 spec 的名字，绝不碰夹具自带的「正门视角」）。 */
async function purgeTestViewpoints(request: ApiRequest): Promise<void> {
  const r = await request.get(`${API}/viewpoints`);
  if (!r.ok()) return;
  const list = await r.json();
  for (const vp of list as { id: string; name: string }[]) {
    if (TEST_NAME_PREFIXES.some((p) => vp.name.startsWith(p))) {
      await request.delete(`${API}/viewpoints/${vp.id}`);
    }
  }
}

test.beforeEach(async ({ request }) => {
  await purgeTestViewpoints(request);
});

test.afterEach(async ({ request }) => {
  const ids = created.splice(0, created.length);
  if (ids.length) await cleanupViewpoints(request, ids);
});

test.describe('GS-NEXT-03 Case 1/3 —— 创建、保存、刷新后恢复（Desktop）', () => {
  test('Case 1：创作页把当前相机存为视点 → 刷新 → 点击 Saved View → 相机恢复到该位置', async ({ page, request }) => {
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 140)); });

    // ── 作者侧：移动相机 → 用真实当前 pose 创建视点 ──
    await page.goto(`/model/edit/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await expect(page.getByText('Viewer 就绪').first()).toBeVisible({ timeout: 90000 });
    await page.waitForSelector('[data-testid="scene-authoring-page"] canvas', { state: 'visible', timeout: 60000 });

    const box = (await page.locator('[data-testid="scene-authoring-page"] canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(120);
    }
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 80, cy + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    const NAME = 'GS-NEXT-03 视点A';
    // ViewpointPanel 作用域（顶栏与初始视角面板的按钮文案不同，避免 strict 冲突）
    const panel = page.locator('.authoring-panel', { has: page.getByText('观察点') });
    await panel.getByPlaceholder('视角名称').fill(NAME);
    await panel.getByRole('button', { name: '保存当前视角' }).click();
    await page.waitForFunction(
      (n) => [...document.querySelectorAll('.authoring-panel *')]
        .some((el) => el.textContent?.trim() === n),
      NAME,
      { timeout: CAMERA_SETTLE_MS },
    );

    // ── 落库核对：视点用的是真实当前 pose（Scene 空间），不是固定偏移 ──
    const list = await (await request.get(`${API}/viewpoints`)).json();
    const vp = list.find((v: { name: string }) => v.name === NAME);
    expect(vp, '视点应已创建').toBeTruthy();
    created.push(vp.id);
    const pos = [vp.position.x, vp.position.y, vp.position.z];
    console.log('created viewpoint at', JSON.stringify(pos), 'fov', vp.fov);
    // 明显不同于出厂初始视角（相机确实被移动过）
    expect(dist(pos, AUTHORED.position), '新视点应不同于出厂初始视角').toBeGreaterThan(0.5);
    expect(vp.fov).toBeGreaterThan(0);

    // ── 刷新创作页（保存→刷新→重开），面板显示的是服务器值 ──
    // GS-NEXT-10：dev server 在首屏大体积 chunk 仍在下载时，reload 可能撞上
    // "net::ERR_ABORTED / frame detached"（导航被新加载的模块打断）。这是
    // 开发服务器 + 软件渲染的加载竞争，与被测的「保存→刷新→重开」语义无关。
    // 用 goto 回到同一路由做同等强度的刷新验证，不降低断言。
    await page.goto(`/model/edit/${SCENE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await expect(page.getByText(NAME, { exact: true })).toBeVisible({ timeout: 60000 });

    // ── Desktop：点击 Saved View → 相机恢复到该位置 ──
    await openScene(page);
    // 起点检查（不用「等相机停在 authored 位置」：官方加载瞬间处于 anim 模式并沿
    // 20s 轨迹漂移，等它回到 authored 会随机器负载随机超时 —— 这不是被测行为）。
    // 真正要证明的是：点击后相机落到**刚存的视点**，且起点本来不在那里。
    const before = cam(await readDiag(page))!;
    console.log('before select cam:', JSON.stringify(before));
    expect(dist(before.position, pos), '点击前相机不应已在该视点位置').toBeGreaterThan(0.3);
    await clickSavedView(page, NAME);
    await waitCameraNear(page, pos, 0.05);
    const after = cam(await readDiag(page))!;
    console.log('after select cam:', JSON.stringify(after));
    expect(dist(after.position, pos), '相机应恢复到已保存视点位置').toBeLessThan(0.05);
    expect(Math.abs(after.fov - vp.fov), 'fov 应一致').toBeLessThan(0.01);
    // 不得停在官方鸟瞰取景
    expect(dist(after.position, AUTHORED.position)).toBeGreaterThan(0.5);
  });

  test('Case 3：Desktop Saved Views 列出全部 enabled 视点，disabled 视点不出现', async ({ page, request }) => {
    const a = await createViewpoint(request, 'NEXT03-A', { x: 1.2, y: 1.5, z: 2.2 }, { x: 0, y: 1.2, z: 0 }, 50);
    const b = await createViewpoint(request, 'NEXT03-B', { x: -1.4, y: 1.3, z: 3.0 }, { x: 0, y: 1.0, z: 0 }, 55);
    created.push(a.id, b.id);
    // 置为 disabled：应从列表消失，且点击无效
    const off = await createViewpoint(request, 'NEXT03-OFF', { x: 0.5, y: 2.0, z: 1.0 }, { x: 0, y: 1, z: 0 }, 60);
    created.push(off.id);
    const patch = await request.patch(`${API}/viewpoints/${off.id}`, { data: { enabled: false } });
    expect(patch.status()).toBe(200);

    await openScene(page);
    await page.click('[data-testid="ov-saved-views"]');
    // 夹具自带 1 个 + 本用例 2 个 enabled
    await expect(page.getByText('NEXT03-A', { exact: true })).toBeVisible();
    await expect(page.getByText('NEXT03-B', { exact: true })).toBeVisible();
    await expect(page.getByText('NEXT03-OFF', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/视角 \(\d+\)/)).toBeVisible();
  });
});

test.describe('GS-NEXT-03 Case 2 —— A/B/C 依次切换：动画正常、无跳飞、无鸟瞰', () => {
  test('依次切换三个视点，逐个精确落位，过渡轨迹连续且不离开邻域', async ({ page, request }) => {
    // 三个刻意分散的 pose（互不相同、都不在官方取景位置）
    const a = await createViewpoint(request, 'SEQ-A', { x: 1.6, y: 1.4, z: 2.4 }, { x: 0, y: 1.0, z: 0 }, 50);
    const b = await createViewpoint(request, 'SEQ-B', { x: -1.8, y: 1.2, z: 1.6 }, { x: 0, y: 0.9, z: 0 }, 55);
    const c = await createViewpoint(request, 'SEQ-C', { x: 0.3, y: 2.2, z: -1.4 }, { x: 0.2, y: 1.4, z: 0.5 }, 60);
    created.push(a.id, b.id, c.id);
    const P: Record<string, number[]> = {
      'SEQ-A': [1.6, 1.4, 2.4],
      'SEQ-B': [-1.8, 1.2, 1.6],
      'SEQ-C': [0.3, 2.2, -1.4],
    };

    // 诊断模式：读数采样提到 20Hz，才能观察过渡轨迹本身
    await openScene(page, true);
    // 先落到 A（起点确定）
    await clickSavedView(page, 'SEQ-A');
    await waitCameraNear(page, P['SEQ-A'], 0.05);
    console.log('at A:', JSON.stringify(cam(await readDiag(page))!.position));

    for (const from of ['SEQ-A', 'SEQ-B', 'SEQ-C']) {
      const to = from === 'SEQ-A' ? 'SEQ-B' : from === 'SEQ-B' ? 'SEQ-C' : 'SEQ-A';
      const total = dist(P[from], P[to]);
      // 点击后立刻开始采样（覆盖官方约 1s 过渡）
      const sampling = sampleCameraTrack(page, 2200);
      await clickSavedView(page, to);
      const track = await sampling;

      // ── 无跳飞：相邻样本位移远小于全程距离（瞬间传送会违反）──
      let maxStep = 0;
      for (let i = 1; i < track.length; i += 1) maxStep = Math.max(maxStep, dist(track[i], track[i - 1]));
      // ── 无鸟瞰/不跳远：任何样本都不离开起点邻域 ──
      const maxAway = Math.max(...track.map((p) => dist(p, P[from])));
      console.log(`${from} → ${to}: samples=${track.length} total=${total.toFixed(2)} maxStep=${maxStep.toFixed(3)} maxAway=${maxAway.toFixed(2)}`);

      expect(track.length, '应采到多个过渡样本（诊断模式采样）').toBeGreaterThan(5);
      expect(maxStep, `${from} → ${to} 单帧位移（不应瞬移）`).toBeLessThan(total * 0.5);
      expect(maxAway, `${from} → ${to} 不应离开起点邻域（无鸟瞰/无跳远）`).toBeLessThan(total * 1.2);
      // 所有样本有限值
      expect(track.every((p) => p.length === 3 && p.every(Number.isFinite))).toBe(true);

      // ── 精确落位（过渡完成）──
      await waitCameraNear(page, P[to], 0.05);
      const at = cam(await readDiag(page))!;
      expect(dist(at.position, P[to]), `${from} → ${to} 落位`).toBeLessThan(0.05);
      // 切换后相机停在 orbit（不是被官方动画带走的 anim 模式）
      expect((await readDiag(page)).cameraMode).toBe('orbit');
      // 不得退化为官方鸟瞰取景
      expect(dist(at.position, AUTHORED.position), `${to} 不应退回官方取景`).toBeGreaterThan(0.5);
    }
  });
});

test.describe('GS-NEXT-03 Case 4 —— XR 进入 VR 前选择视点', () => {
  test('选择视点 → 桌面模式相机导航到该视点，且 XR 出生位姿随之改变', async ({ page, request }) => {
    const vp = await createViewpoint(request, 'XR-出生点', { x: 0.9, y: 1.5, z: 1.8 }, { x: 0, y: 1.1, z: 0 }, 58);
    created.push(vp.id);

    await page.goto(`/xr/${SCENE}`);
    await page.waitForSelector('[data-testid="xr-mount"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );

    // 进入前显示视点选择器（夹具自带 1 个 + 本用例 1 个）
    const picker = page.locator('[data-testid="xr-viewpoint-picker"]');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId(`xr-viewpoint-${vp.id}`)).toBeVisible();
    // 未选 = authored 初始视角（aria-pressed）
    await expect(page.getByTestId('xr-viewpoint-initial')).toHaveAttribute('aria-pressed', 'true');

    const before = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
    console.log('XR before:', JSON.stringify(before.camera), before.xrSpawnStatus);

    // 选中视点 → 相机被导航过去（官方过渡），出生位姿同步改变
    await page.getByTestId(`xr-viewpoint-${vp.id}`).click();
    await page.waitForFunction(
      (target) => {
        const d = JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}');
        return d.camera && Math.hypot(
          d.camera.position[0] - target[0],
          d.camera.position[1] - target[1],
          d.camera.position[2] - target[2],
        ) < 0.05;
      },
      [0.9, 1.5, 1.8],
      { timeout: CAMERA_SETTLE_MS },
    );

    const after = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
    console.log('XR after:', JSON.stringify(after.camera), after.xrSpawnStatus, after.selectedViewpointId);

    // 1) 桌面模式构图 = 该视点（世界变换恒等 → SCREEN 空间即 RUNTIME 空间）
    expect(dist(after.camera.position, [0.9, 1.5, 1.8]), 'XR 页应导航到所选视点').toBeLessThan(0.05);
    expect(Math.abs(after.camera.fov - 58)).toBeLessThan(0.6);
    // 2) 出生位姿已指定（不是 not-authored），且记录了选中的视点
    expect(after.selectedViewpointId).toBe(vp.id);
    expect(after.xrSpawnStatus, '选中视点后应已配置 XR 出生位姿').not.toBe('not-authored');
    // 3) 与切换前不同（出生点确实变了）
    expect(dist(before.camera.position, after.camera.position)).toBeGreaterThan(0.5);

    // 回到「初始视角」→ authored 相机复位
    await page.getByTestId('xr-viewpoint-initial').click();
    await page.waitForFunction(
      (target) => {
        const d = JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}');
        return d.camera && Math.hypot(
          d.camera.position[0] - target[0],
          d.camera.position[1] - target[1],
          d.camera.position[2] - target[2],
        ) < 0.6;
      },
      AUTHORED.position,
      { timeout: CAMERA_SETTLE_MS },
    );
    const reset = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
    expect(reset.selectedViewpointId).toBeNull();
    expect(reset.xrSpawnStatus).not.toBe('not-authored');
    console.log('XR reset:', JSON.stringify(reset.camera), reset.xrSpawnStatus);
  });

  test('Case 4：无 authored 相机的场景 —— 选中视点才产生出生位姿（not-authored → not-entered）', async ({ page, request }) => {
    // 用描述符契约夹具把 initialCamera 置空（DB 侧 PATCH 把 null 视为「不变」，
    // 无法经 API 清空 —— 与 GS-NEXT-02 回退用例同一处理）。视点数据仍来自真实 DB。
    const runtimeResponse = await request.get(`${API}/runtime`);
    expect(runtimeResponse.status()).toBe(200);
    const descriptor = await runtimeResponse.json();
    descriptor.presentation.initialCamera = { position: null, target: null, fov: null };
    await page.route(`**/api/v1/scenes/${SCENE}/runtime`, route => route.fulfill({ json: descriptor }));

    await page.goto(`/xr/${SCENE}`);
    await page.waitForSelector('[data-testid="xr-mount"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );
    const picker = page.locator('[data-testid="xr-viewpoint-picker"]');
    await expect(picker).toBeVisible();

    const before = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
    // 无 authored 相机 → 没有出生位姿（保持官方 Y=0 语义）
    expect(before.xrSpawnStatus).toBe('not-authored');

    // 选中任一 enabled 视点（夹具自带「正门视角」，无需新建）
    const vp = await viewpointPose(request, (await (await request.get(`${API}/viewpoints`)).json())
      .find((v: { enabled: boolean }) => v.enabled !== false).id);
    await page.getByTestId(`xr-viewpoint-${vp.id}`).click();

    // 选中后出生位姿**变成已指定** —— 这只能来自 setXRInitialCamera（spawn 被真正配置）
    await page.waitForFunction(() => {
      const d = JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}');
      return d.xrSpawnStatus === 'not-entered';
    }, undefined, { timeout: CAMERA_SETTLE_MS });
    // spawn 状态即时更新，但官方过渡动画约 1s —— 等相机真正到位再比对
    await page.waitForFunction(
      (target) => {
        const d = JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}');
        return d.camera && Math.hypot(
          d.camera.position[0] - target[0],
          d.camera.position[1] - target[1],
          d.camera.position[2] - target[2],
        ) < 0.05;
      },
      [vp.position.x, vp.position.y, vp.position.z],
      { timeout: CAMERA_SETTLE_MS },
    );

    const after = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
    console.log('no-authored XR spawn:', before.xrSpawnStatus, '→', after.xrSpawnStatus,
      JSON.stringify(after.camera));
    expect(after.selectedViewpointId).toBe(vp.id);
    expect(dist(after.camera.position, [vp.position.x, vp.position.y, vp.position.z])).toBeLessThan(0.05);
  });
});