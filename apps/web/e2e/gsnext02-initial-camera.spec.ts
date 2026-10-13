/**
 * GS-NEXT-02 §八 —— 初始视角「真实保存 → 回读 → 重新打开」端到端验证。
 *
 * 本文件验证**任务的成功标准本身**（而不只是测试通过）：
 *   用户在创作页把相机移动到一个与默认取景**明显不同**的近距离位置并保存，
 *   重新打开场景时相机必须回到那个位置（Desktop 与 XR 同一份已保存视角）。
 *
 * 断言分层（禁止只凭「保存成功」toast 判定）：
 *   L1 UI    创作页保存成功提示 + 不出现「已保存视角未被运行时采用」告警
 *   L2 API   GET /presentation 读到新值，且**与保存前明显不同**（真的移动过）
 *   L3 desc  GET /runtime 描述符 initialCamera 与 L2 一致（没有陈旧描述符）
 *   L4 view  重新打开 /scene 相机位置 == L2（这是用户真正在意的结果）
 *   L5 XR    /xr 页进入 VR 前的相机同样 == L2（Desktop/XR 共享同一保存视角）
 *
 * 依赖：dev API（dev identity bypass）+ vite dev server。场景 fix02-semantics
 * 为 DB 合同 dev 夹具；每个用例结束后恢复其原始 initialCamera / worldTransform。
 */
import { expect, test } from './fresh-browser';
import { SceneTransformAdapter } from '../src/scene-runtime/SceneTransformAdapter';

const SCENE = 'fix02-semantics';
const API = `/api/v1/scenes/${SCENE}`;

/** 该夹具的出厂 authored 视角（与 fix02-semantics.spec.ts 同一份真值）。 */
const FACTORY = {
  position: [2.5, 1.8, 6.0] as number[],
  target: [0.0, 0.6, 0.0] as number[],
  fov: 47.0,
};

interface Vec3 { x: number; y: number; z: number }
interface Cam { position: number[]; target: number[]; fov: number }
interface Presentation {
  initialCameraPosition: Vec3 | null;
  initialCameraTarget: Vec3 | null;
  initialCameraFov: number | null;
  worldRotation: Vec3 | null;
}

type ApiRequest = import('@playwright/test').APIRequestContext;

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function fwd(c: { position: number[]; target: number[] }): number[] {
  const d = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
  const len = Math.hypot(...d) || 1;
  return d.map(v => v / len);
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

async function getPresentation(request: ApiRequest): Promise<Presentation> {
  const r = await request.get(`${API}/presentation`);
  expect(r.status(), 'GET /presentation').toBe(200);
  return r.json() as Promise<Presentation>;
}

/** PATCH 体验设置（dev bypass 无 CSRF）。null 字段会被服务端忽略，勿传。 */
async function patchPresentation(request: ApiRequest, body: Record<string, unknown>) {
  const r = await request.patch(`${API}/presentation`, { data: body });
  expect(r.status(), `PATCH /presentation ${JSON.stringify(body)}`).toBe(200);
  return r.json() as Promise<Presentation>;
}

async function restore(request: ApiRequest, snapshot: Presentation) {
  await patchPresentation(request, {
    initialCameraPosition: snapshot.initialCameraPosition,
    initialCameraTarget: snapshot.initialCameraTarget,
    initialCameraFov: snapshot.initialCameraFov,
    worldRotation: snapshot.worldRotation ?? { x: 0, y: 0, z: 0 },
  });
}

/** Desktop 场景页诊断（含相机 pose）。 */
async function readDiag(page: import('@playwright/test').Page): Promise<any> {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    if (!el) return false;
    try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
  }, { timeout: 90000 });
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'));
}

function cam(diag: any): Cam | null {
  return diag?.camera ? { position: diag.camera.position, target: diag.camera.target, fov: diag.camera.fov } : null;
}

/** 创作页等预览 Viewer 就绪（右侧 Tag 变「Viewer 就绪」）。 */
async function openAuthoring(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/model/edit/${SCENE}`);
  await page.waitForSelector('[data-testid="scene-authoring-page"]');
  await expect(page.getByText('Viewer 就绪').first()).toBeVisible({ timeout: 90000 });
  await page.waitForSelector('[data-testid="scene-authoring-page"] canvas', { state: 'visible', timeout: 60000 });
}

/**
 * 在创作页真实地移动相机（滚轮推近 + 拖拽环绕）——模拟用户「把相机挪到一个
 * 近距离位置」的操作。返回值无意义，只为把官方 OrbitController 驱动起来。
 */
async function moveCameraToCloseUp(page: import('@playwright/test').Page): Promise<void> {
  const box = (await page.locator('[data-testid="scene-authoring-page"] canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  // 推近：官方 OrbitController 以滚轮改变 orbit distance（近距离）。
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
  }
  // 环绕：改变朝向，避免只缩放、视角与默认完全同轴。
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy + 45, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(1500); // 等官方过渡稳定
}

/** 点击「更新为当前视角 / 设为初始视角」（两种文案都接受）。 */
async function clickSaveInitialView(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /更新为当前视角|设为初始视角/ }).click();
}

let snapshot: Presentation;

test.beforeEach(async ({ request }) => {
  snapshot = await getPresentation(request);
  // 世界变换复位恒等（World Transform 用例自行设非恒等并在自身复位）。
  await patchPresentation(request, { worldRotation: { x: 0, y: 0, z: 0 } });
});

test.afterEach(async ({ request }) => {
  await restore(request, snapshot);
});

test.describe('GS-NEXT-02 核心：保存近距离视角 → 重新打开恢复该位置', () => {
  test('L1-L4：创作页保存的近距离视角，重新打开场景被真正采用', async ({ page, request }) => {
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 160)); });

    // ── 前置：记录默认取景（官方 frameScene 产物）与出厂 authored 视角 ──
    await openAuthoring(page);
    await moveCameraToCloseUp(page);

    // ── L1：UI 保存 ──
    await clickSaveInitialView(page);
    // 保存成功的唯一合法 UI 依据 = 页面回读描述符后确认运行时采用（verify）。
    await expect(page.getByText('已保存（初始视角已更新，打开场景将采用该视角）')).toBeVisible({ timeout: 30000 });
    // 不得出现「数据库有、运行时没用」的告警。
    await expect(page.locator('[data-testid="initial-view-runtime-mismatch"]')).toHaveCount(0);

    // ── L2：API 真的持久化了，且与出厂值明显不同（证明相机确实被移动过）──
    const saved = await getPresentation(request);
    expect(saved.initialCameraPosition, 'initialCameraPosition 应已持久化').not.toBeNull();
    expect(saved.initialCameraTarget).not.toBeNull();
    expect(saved.initialCameraFov).not.toBeNull();
    const savedPos = [
      saved.initialCameraPosition!.x,
      saved.initialCameraPosition!.y,
      saved.initialCameraPosition!.z,
    ];
    expect(
      dist(savedPos, FACTORY.position),
      `保存的位置应与出厂视角明显不同（实际 ${JSON.stringify(savedPos)}）`,
    ).toBeGreaterThan(0.5);
    console.log('saved position:', JSON.stringify(savedPos), 'fov', saved.initialCameraFov);

    // ── L3：运行时描述符与 L2 一致（不存在陈旧描述符）──
    const runtimeResponse = await request.get(`${API}/runtime`);
    expect(runtimeResponse.status()).toBe(200);
    const runtime = await runtimeResponse.json();
    expect(runtime.presentation.initialCamera.position.x).toBeCloseTo(savedPos[0], 6);
    expect(runtime.presentation.initialCamera.position.y).toBeCloseTo(savedPos[1], 6);
    expect(runtime.presentation.initialCamera.position.z).toBeCloseTo(savedPos[2], 6);
    expect(runtime.presentation.initialCamera.fov).toBeCloseTo(saved.initialCameraFov!, 6);

    // ── L4：重新打开场景，相机真的在那里（用户真正的成功标准）──
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const diag = await readDiag(page);
    const actual = cam(diag)!;
    expect(actual, '应有相机读数').not.toBeNull();
    console.log('reloaded camera:', JSON.stringify(actual), 'mode', diag.cameraMode);
    expect(
      dist(actual.position, savedPos),
      '重新打开应恢复已保存的位置',
    ).toBeLessThan(0.05);
    expect(Math.abs(actual.fov - saved.initialCameraFov!), 'fov 应一致').toBeLessThan(0.01);
    // 构图方向一致（官方 getCameraPose 的 target 是 position+forward×AABB 深度，
    // 不是作者 target 点本身 —— 方向一致即构图一致）。
    expect(
      dot(fwd(actual), fwd({ position: savedPos, target: [saved.initialCameraTarget!.x, saved.initialCameraTarget!.y, saved.initialCameraTarget!.z] })),
      'look 方向',
    ).toBeGreaterThan(0.999);
    // 关键否定断言：不得退回出厂/官方鸟瞰构图。
    expect(dist(actual.position, FACTORY.position), '不得退回出厂视角').toBeGreaterThan(0.5);
  });

  test('L1-L4：保存后刷新创作页，面板与运行时都显示已保存视角（保存→刷新→重开）', async ({ page, request }) => {
    await openAuthoring(page);
    await moveCameraToCloseUp(page);
    await clickSaveInitialView(page);
    await expect(page.getByText('已保存（初始视角已更新，打开场景将采用该视角）')).toBeVisible({ timeout: 30000 });
    const saved = await getPresentation(request);
    const savedPos = [saved.initialCameraPosition!.x, saved.initialCameraPosition!.y, saved.initialCameraPosition!.z];

    // 刷新（重新拉取 presentation + 重建预览 runtime）。
    await openAuthoring(page);
    await expect(page.getByText(/^Position: \(/)).toBeVisible();
    const panelText = (await page.getByText(/^Position: \(/).first().textContent()) ?? '';
    console.log('panel after reload:', panelText);
    // 面板显示的应是已保存的（经 server 读取，非乐观 state）。
    const nums = panelText.match(/-?\d+\.\d+/g)?.map(Number) ?? [];
    expect(nums.length).toBeGreaterThanOrEqual(3);
    for (const i of [0, 1, 2]) {
      expect(Math.abs(nums[i] - savedPos[i]), `面板位置 ${i} 应为已保存值`).toBeLessThan(0.01);
    }
    await expect(page.locator('[data-testid="initial-view-runtime-mismatch"]')).toHaveCount(0);
  });

  test('L5：Desktop 与 XR 共用同一个已保存视角', async ({ page, request }) => {
    const closeUp = {
      position: { x: 0.45, y: -0.35, z: 0.60 },
      target: { x: 0.45, y: -0.35, z: -0.40 },
      fov: 74,
    };
    await patchPresentation(request, {
      initialCameraPosition: closeUp.position,
      initialCameraTarget: closeUp.target,
      initialCameraFov: closeUp.fov,
    });

    // Desktop
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const desktop = cam(await readDiag(page))!;
    expect(dist(desktop.position, [closeUp.position.x, closeUp.position.y, closeUp.position.z])).toBeLessThan(0.05);

    // XR（进入 VR 之前的初始构图，与 Desktop 同一份已保存视角）
    await page.goto(`/xr/${SCENE}`);
    await page.waitForSelector('[data-testid="xr-mount"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );
    const txt = ((await page.locator('[data-testid="diag-camera"]').textContent()) ?? '').trim();
    console.log('XR pre-VR camera:', txt);
    const parts = txt.split('/').map(s => s.trim());
    const pos = parts[0].split(',').map(s => parseFloat(s.trim()));
    const fov = parseFloat(parts[2]);
    expect(
      dist(pos, [closeUp.position.x, closeUp.position.y, closeUp.position.z]),
      'XR 页应使用与 Desktop 相同的已保存视角',
    ).toBeLessThan(0.4);
    expect(Math.abs(fov - closeUp.fov)).toBeLessThan(0.6);
  });

  test('已保存视角在非恒等 World Transform 下正确换算（SCENE 空间 → RUNTIME）', async ({ page, request }) => {
    const closeUp = {
      position: { x: 1.5, y: 1.6, z: 2.5 },
      target: { x: 0.0, y: 1.6, z: 0.0 },
      fov: 65,
    };
    await patchPresentation(request, {
      initialCameraPosition: closeUp.position,
      initialCameraTarget: closeUp.target,
      initialCameraFov: closeUp.fov,
      worldRotation: { x: 0, y: 90, z: 0 },
    });
    const adapter = SceneTransformAdapter.fromWorldTransform({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 90, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    const expected = adapter.sceneToRuntimeCamera({
      position: closeUp.position,
      target: closeUp.target,
      fov: closeUp.fov,
    });
    console.log('expected runtime camera:', JSON.stringify(expected));

    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const actual = cam(await readDiag(page))!;
    expect(
      dist(actual.position, [expected.position.x, expected.position.y, expected.position.z]),
      '非恒等 W 下的 RUNTIME 相机位置',
    ).toBeLessThan(0.05);
    expect(dot(fwd(actual), fwd({ position: [expected.target.x, expected.target.y, expected.target.z], target: actual.target })), 'look 方向').toBeGreaterThan(0.999);
  });
});

test.describe('GS-NEXT-02 §五 Performance Mode 默认 ON（Desktop/XR 一致）', () => {
  test('XR：无偏好时默认 ON（且不写入偏好）；手动 OFF 被持久化并在重开后保持', async ({ page }) => {
    // 首次打开：清除偏好键 = 模拟从未选择过。
    await page.goto(`/xr/${SCENE}?diagnostics=1`);
    await page.evaluate(() => localStorage.removeItem('performanceMode'));
    await page.reload();
    await page.waitForSelector('[data-testid="performance-mode"]');

    // §五.1 默认 ON；§五.3 默认值不写入 localStorage（默认 ≠ 用户偏好）。
    await expect(page.getByTestId('performance-mode')).toHaveText('ON');
    expect(await page.evaluate(() => localStorage.getItem('performanceMode'))).toBeNull();

    // §五.4 手动 OFF → 经官方 persistPreferences 持久化。
    await page.getByTestId('performance-off').click();
    await expect(page.getByTestId('performance-mode')).toHaveText('OFF');
    expect(await page.evaluate(() => localStorage.getItem('performanceMode'))).toBe('false');

    // §五.5 重开场景仍是用户的选择（Desktop/XR 共用同一偏好 key）。
    await page.reload();
    await page.waitForSelector('[data-testid="performance-mode"]');
    await expect(page.getByTestId('performance-mode')).toHaveText('OFF');

    // §五.3 清除偏好 = 恢复产品默认 ON。
    await page.evaluate(() => localStorage.removeItem('performanceMode'));
    await page.reload();
    await page.waitForSelector('[data-testid="performance-mode"]');
    await expect(page.getByTestId('performance-mode')).toHaveText('ON');
    await page.evaluate(() => localStorage.removeItem('performanceMode'));
  });
});

test.describe('GS-NEXT-02 回退与失败可见性', () => {
  test('无 authored 相机 → 回退官方 frameScene（描述符契约夹具）', async ({ page, request }) => {
    // 说明：这里用「描述符契约夹具」覆盖**无 authored 相机**这一分支。
    // DB 合同无法把 initialCamera 置空（PATCH 把 null 视为「不变」，且该分支的
    // DB 侧前置条件由后端单测覆盖），因此拦截 runtime 响应喂一个真实形状的
    // 无相机描述符 —— 走的是与线上一致的 resolve → settings → runtime 链路。
    const runtimeResponse = await request.get(`${API}/runtime`);
    expect(runtimeResponse.status()).toBe(200);
    const descriptor = await runtimeResponse.json();
    descriptor.presentation.initialCamera = { position: null, target: null, fov: null };
    await page.route(`**/api/v1/scenes/${SCENE}/runtime`, route => route.fulfill({ json: descriptor }));

    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const diag = await readDiag(page);
    const actual = cam(diag)!;
    console.log('no-authored camera:', JSON.stringify(actual));
    // 回退 = 官方 frameScene：取景整个 AABB，不是任何 authored 视角。
    expect(dist(actual.position, FACTORY.position), '应离开 authored 视角（已取景全场景）').toBeGreaterThan(1.0);
    // 读数须为有限值（frameScene 产物应是一个合法相机位姿，而非 NaN/空场景噪声）。
    expect(actual.position.every(Number.isFinite), 'frameScene 相机位置应为有限值').toBe(true);
    expect(actual.fov).toBeGreaterThan(0);
    console.log('fallback fov:', actual.fov, 'cameraMode:', diag.cameraMode);
  });

  test('保存失败时：面板回滚到服务器真相并明确报错（不得留下「假保存」）', async ({ page, request }) => {
    await openAuthoring(page);
    await moveCameraToCloseUp(page);

    // 让 PATCH 失败（模拟非所有者 403 —— 用户最可能遇到的失败）。
    await page.route(`**/api/v1/scenes/${SCENE}/presentation`, async route => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: '无权编辑该场景' } });
        return;
      }
      await route.continue();
    });

    const before = await getPresentation(request);
    await clickSaveInitialView(page);

    // 失败必须可见。
    await expect(page.getByText(/保存初始视角失败|保存失败/)).toBeVisible({ timeout: 30000 });
    // 不得出现成功提示。
    await expect(page.getByText('已保存（初始视角已更新，打开场景将采用该视角）')).toHaveCount(0);

    const after = await getPresentation(request);
    expect(
      JSON.stringify(after.initialCameraPosition),
      '服务端数据不应改变',
    ).toBe(JSON.stringify(before.initialCameraPosition));

    // 面板不得停留在从未持久化的乐观值上（乐观更新已回滚 → 重新读服务器）。
    await page.waitForTimeout(500);
    const panelText = (await page.getByText(/^Position: \(|^未设置$/).first().textContent()) ?? '';
    const originalPos = [
      before.initialCameraPosition!.x,
      before.initialCameraPosition!.y,
      before.initialCameraPosition!.z,
    ];
    if (panelText.startsWith('Position')) {
      const nums = panelText.match(/-?\d+\.\d+/g)?.map(Number) ?? [];
      for (const i of [0, 1, 2]) {
        expect(Math.abs(nums[i] - originalPos[i]), '面板应回滚到服务器值').toBeLessThan(0.01);
      }
    } else {
      expect(panelText.trim()).toBe('未设置');
    }
  });
});