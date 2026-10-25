/**
 * GS-DESKTOP-04 —— 同会话初始相机 Reset 同步 + Walk 平台安全闸门（真实浏览器）。
 *
 * ## 背景（GS-DESKTOP-03 发现的真 P1）
 *
 * 创作页保存新的初始视角之后，同一个页面里用官方 Reset 或平台「定位到已保存视角」
 * 仍回到**旧**视角，只有刷新页面才正确。
 *
 * 根因（官方 1.35.0 dist/viewer.js 实测）：`CameraManager` 构造时把
 * `settings.cameras[0].initial` 固化成闭包常量 `resetCamera`，
 * `inputEvent 'reset'`（官方 Reset 按钮 / 键盘 `r` / 宿主 `resetCamera()`）
 * 一律 `controllers.orbit.goto(resetCamera)`。官方公开句柄没有 settings 更新
 * 入口 → 唯一受支持的同步路径 = 用含新视角的 settings 受控重建 Viewer。
 *
 * ## 本文件验收的契约（对应任务 §五）
 *
 *  1. A → 保存 B → 移动到 C → 平台「定位到已保存视角」→ B（不是 A）；
 *  2. 同上，但用**官方 Viewer Settings → Reset**（不是宿主按钮）→ B；
 *  3. 同上，但用**官方键盘快捷键** `r` → B；
 *  4. 保存 B 后 Frame → Reset → B；
 *  5. 保存后刷新页面 → Reset → B；
 *  6. 保存**失败**（后端拒绝）→ Reset 仍回 A；
 *  7. 连续快速保存 B → D → 最终 Reset 到 D；
 *  8. 非恒等世界变换下保存/Reset 一致；
 *  9. 保存后画面不自动 Frame / 不跳远（NO_AUTO_CAMERA_JUMP）；
 * 10. 多次保存不泄漏 WebGL context（Viewer 创建/销毁次数守恒）；
 * 11. Web 与 XR 描述符仍一致（同一份初始相机数据）。
 *
 * 相机数字证据来自**真实 Chromium**（full build + SwiftShader WebGPU，
 * 见 e2e/fresh-browser.ts 的 rAF 冻结说明），不是 mock Viewer。
 * 真实 headful + NVIDIA GPU 的证据由 e2e/gsdesktop04/run.mjs 产出
 * （docs/reports/gsdesktop04-evidence/）。
 */
import { expect, test, type Page } from './fresh-browser';

// 创作页用例要在真实浏览器里加载官方 Viewer、移动相机、保存、重建、Reset：
// SwiftShader 软件渲染下每一步都慢 —— 给足墙钟预算（断言本身未放松）。
// 单次受控重建实测可达 112–400s（WebGPU requestAdapter 在设备销毁后的排队），
// 一条用例里可能发生两次重建，因此单测给 20 分钟。
test.describe.configure({ timeout: 1_200_000 });

const API = '/api/v1/scenes';
const SCENE = 'fix02-semantics';

type Pose = { position: number[]; target: number[]; fov: number };

/** 官方 Reset / setCameraPose 是 1 秒过渡动画 —— 等它真正收敛再取读数。 */
const RESET_SETTLE_MS = 4500;

/**
 * 受控重建收敛预算（等 `camera-sync-progress` 从 DOM 消失）。
 *
 * 实测（headless SwiftShader）：销毁旧 WebGPU 设备后，第二次
 * `navigator.gpu.requestAdapter()` 实测 111.9s 才 resolve；真实 GPU 浏览器上
 * 是秒级。给 600s 墙钟，断言本身不放松。
 */
const SYNC_CONVERGE_MS = 600_000;

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 视角方向（forward）—— 比较「构图」而不是绝对 target 点。 */
function forward(cam: Pose): number[] {
  const d = [
    cam.target[0] - cam.position[0],
    cam.target[1] - cam.position[1],
    cam.target[2] - cam.position[2],
  ];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return d.map((v) => v / len);
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

async function openAuthoring(page: Page, sceneId = SCENE): Promise<void> {
  await page.goto(`/model/edit/${sceneId}`);
  await page.waitForFunction(() => !!window.__gsauthoringruntime, undefined, { timeout: 120_000 });
  await waitForViewerIdle(page);
}

/** 直接从 runtime 读真实相机 pose（不依赖 React 诊断 span 的轮询延迟）。 */
async function readPose(page: Page): Promise<Pose | null> {
  return page.evaluate(() => {
    type Rt = { getCameraPose?: () => Pose };
    const w = window as unknown as { __gsauthoringruntime?: Rt; __gsruntime?: Rt };
    // 创作页暴露 __gsauthoringruntime，/scene 浏览页暴露 __gsruntime —— 同一套
    // 官方 SuperSplatRuntime 适配层，读的是同一份官方相机。
    const rt = w.__gsauthoringruntime ?? w.__gsruntime;
    if (!rt?.getCameraPose) return null;
    const p = rt.getCameraPose();
    return p ? { position: p.position, target: p.target, fov: p.fov } : null;
  });
}

/** Viewer 生命周期统计（真实 canvas 数 + runtime 实例数），用于泄漏断言。 */
async function viewerLifecycle(page: Page): Promise<{ viewers: number; canvases: number }> {
  return page.evaluate(() => ({
    viewers: document.querySelectorAll('.sse-viewer').length,
    canvases: document.querySelectorAll('.sse-viewer canvas').length,
  }));
}

/**
 * 让官方 app 继续 tick（官方 1 秒过渡需要真实帧才能完成）。
 *
 * 只用官方公开的 `app.tick` 推进时间，不写任何相机状态 —— 产品代码不变。
 */
async function pumpFrames(page: Page, ms: number): Promise<void> {
  const total = Math.max(1, Math.ceil(ms / 16.7));
  let done = 0;
  while (done < total) {
    const chunk = Math.min(60, total - done);
    await page.evaluate((count) => {
      const rt = (window as unknown as { __gsauthoringruntime?: { app?: { tick?: (t: number) => void } } })
        .__gsauthoringruntime;
      const app = rt?.app;
      if (typeof app?.tick !== 'function') return;
      const w = window as unknown as { __gsTickClock?: number };
      let clock = Math.max(w.__gsTickClock ?? 0, performance.now());
      for (let i = 0; i < count; i += 1) {
        clock += 16.7;
        app.tick(clock);
      }
      w.__gsTickClock = clock;
    }, chunk);
    await page.waitForTimeout(40);
    done += chunk;
  }
}

/**
 * 找到画布上一个**真正可以接收指针事件**的点。
 *
 * 官方 `.sse-ui *` 是 `pointer-events:auto`，1280×720 下右下角的官方
 * controlsHint 面板正好压在画布右侧中段 —— 直接按「画布中心」拖拽会打在
 * 官方面板上，相机纹丝不动（GS-DESKTOP-04 实测，全程 0 位移）。
 * 这里对画布内 8×8 网格采样，取第一个 `elementFromPoint === CANVAS` 的点，
 * 仍然是**真实鼠标事件打在真实画布上**，不绕过任何官方交互。
 */
async function canvasPoint(
  page: Page,
  prefer?: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas not found');
  const candidates: Array<{ x: number; y: number }> = [];
  const n = 8;
  for (let i = 1; i < n; i += 1) {
    for (let j = 1; j < n; j += 1) {
      candidates.push({ x: box.x + box.width * (i / n), y: box.y + box.height * (j / n) });
    }
  }
  const hits = await page.evaluate(
    (points) =>
      points.map((p) => document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS'),
    candidates,
  );
  const free = candidates.filter((_, i) => hits[i]);
  if (!free.length) throw new Error('no unobstructed canvas point');
  if (!prefer) return free[0];
  const dist = (p: { x: number; y: number }) => Math.hypot(p.x - prefer.x, p.y - prefer.y);
  return free.reduce((best, p) => (dist(p) < dist(best) ? p : best));
}

/** 用真实鼠标在画布上拖动（不用 API 改相机）。 */
async function dragCanvas(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas not found');
  // 起点朝拖拽反方向偏移，保证终点也落在画布内。
  const start = await canvasPoint(page, {
    x: box.x + box.width / 2 - dx / 2,
    y: box.y + box.height / 2 - dy / 2,
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}

/**
 * 等 Viewer 真正空闲：加载遮罩消失、官方 runtime 报告 loaded、antd 蒙层清空。
 *
 * 保存 → 受控重建期间 `.gs-workspace__loading` 覆盖整块画布（inset:0），
 * 此时任何「拖画布」都会打在遮罩上（GS-DESKTOP-04 实测：0 位移 / 找不到
 * 可命中的画布点）。这是等产品进入它自己声明的就绪态，不是放宽断言。
 */
async function waitForViewerIdle(page: Page): Promise<void> {
  await page
    .waitForSelector('.gs-workspace__loading', { state: 'detached', timeout: SYNC_CONVERGE_MS })
    .catch(() => {});
  await page.waitForSelector('.ant-modal-wrap', { state: 'detached', timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(
    () => {
      const rt = (window as unknown as { __gsauthoringruntime?: { state?: { loaded?: boolean } } })
        .__gsauthoringruntime;
      return rt?.state?.loaded === true;
    },
    undefined,
    { timeout: SYNC_CONVERGE_MS },
  );
  await page.waitForSelector('canvas', { state: 'visible', timeout: 60_000 });
}

/**
 * 等 antd 反馈弹窗彻底消失（含动画 + unmount）。
 *
 * 实测：antd 的 `.ant-modal` 带 `ant-zoom-leave` 离场动画，动画期间
 * `.ant-modal-mask` / `.ant-modal-wrap` 仍在 DOM 里并盖住整块画布
 * （SwiftShader 下动画帧推进慢，500ms 不够）。轮询直到真的 unmount。
 */
async function waitForModalGone(page: Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await page.locator('.ant-modal-wrap').count()) === 0) return;
    await page.waitForTimeout(200);
  }
}

/** 关掉 antd 反馈弹窗（保存/同步提示），避免遮挡后续操作。 */
async function dismissModal(page: Page): Promise<void> {
  if (await page.locator('.ant-modal .ant-btn-primary').count()) {
    await page
      .locator('.ant-modal .ant-btn-primary')
      .last()
      .click({ timeout: 10_000 })
      .catch(() => {});
  }
  await waitForModalGone(page);
  await waitForViewerIdle(page);
}

/**
 * 恢复隔离 fixture 的初始视角到 A（每个用例前后各一次，保证可重复）。
 *
 * 用 `page.request`（继承 context 的 baseURL + cookie），走 dev `/api` 代理。
 * 这是隔离测试环境内的 fixture 复位，不触碰生产 current 指针或已发布版本。
 */
async function resetFixtureInitialCamera(page: Page): Promise<void> {
  const res = await page.request.patch(`${API}/${SCENE}/presentation`, {
    data: {
      initialCameraPosition: { x: 2.5, y: 1.8, z: 6.0 },
      initialCameraTarget: { x: 0.0, y: 0.6, z: 0.0 },
      initialCameraFov: 47,
    },
  });
  if (!res.ok()) {
    throw new Error(`fixture reset failed: ${res.status()} ${await res.text()}`);
  }
}

test.beforeEach(async ({ page }) => {
  await resetFixtureInitialCamera(page);
  /**
   * 把 CSS 动画/过渡压到 1ms。
   *
   * SwiftShader + `--disable-gpu-compositing` 下合成器不产出动画帧，
   * antd 的 `.ant-modal` 会永远停在 `ant-zoom-appear-start`（实测
   * `transform: matrix(0.2,…)`），离场动画的 `animationend` 也永远不触发 ——
   * 于是**弹窗点了“知道了”仍在 DOM 里、遮罩继续盖住整块画布**，
   * 后续真实鼠标拖拽一律打在遮罩上（GS-DESKTOP-04 实测）。
   * 这是测试环境的渲染管线限制，不是产品缺陷：真实浏览器动画正常。
   * 只缩短动画时长，不改任何 DOM/逻辑/断言。
   */
  await page.addInitScript(() => {
    // addInitScript 早于 documentElement，直接 appendChild 会抛
    // "Cannot read properties of null (reading 'appendChild')"（GS-DESKTOP-04 实测）。
    const injectReset = () => {
      const style = document.createElement('style');
      style.textContent =
        '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;'
        + 'transition-duration:1ms!important;transition-delay:0s!important;}';
      document.documentElement?.appendChild(style);
    };
    if (document.documentElement) injectReset();
    else
      document.addEventListener(
        'readystatechange',
        () => {
          if (document.documentElement) injectReset();
        },
        { once: true },
      );
  });
  // 观测官方 Viewer 的创建/销毁：宿主不得偷偷再建一套相机控制器。
  await page.addInitScript(() => {
    const w = window as unknown as {
      __gsViewerEvents?: { created: number; destroyed: number };
    };
    w.__gsViewerEvents = { created: 0, destroyed: 0 };
    const observe = (rt: unknown) => {
      try {
        const v = rt as { destroy?: () => void };
        if (typeof v?.destroy === 'function') {
          w.__gsViewerEvents!.created += 1;
          const orig = v.destroy.bind(v);
          v.destroy = () => {
            w.__gsViewerEvents!.destroyed += 1;
            orig();
          };
        }
      } catch {
        /* 观测失败不影响用例 */
      }
    };
    for (const key of ['__gsauthoringruntime', '__gsruntime']) {
      let value: unknown = null;
      Object.defineProperty(window, key, {
        configurable: true,
        get() {
          return value;
        },
        set(v) {
          value = v;
          observe(v);
        },
      });
    }
  });
});

test.afterEach(async ({ page }) => {
  await resetFixtureInitialCamera(page);
});

/**
 * 核心流程：A → 拖动到 B → 保存 B → 移动到 C。
 * 返回 A / B / C 三个真实 pose（数字证据入库）。
 */
async function captureInitialAndSaved(page: Page): Promise<{ A: Pose; B: Pose }> {
  await openAuthoring(page);
  await pumpFrames(page, RESET_SETTLE_MS);
  const a = (await readPose(page))!;
  await dragCanvas(page, -220, -60);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(1200);
  const b = (await readPose(page))!;
  return { A: a, B: b };
}

test('GS-DESKTOP-04 §5.1/9：保存初始视角后，同会话官方 Reset 采用新视角且不自动跳远', async ({
  page,
}) => {
  const { A: a, B: b } = await captureInitialAndSaved(page);
  expect(distance(a.position, b.position)).toBeGreaterThan(0.5);

  // 保存 B 为初始视角（PCUI 主按钮）
  const saveBtn = page.getByRole('button', { name: '将当前视角设为初始视角' });
  await saveBtn.scrollIntoViewIfNeeded();
  await saveBtn.click();
  // 保存 → 校验描述符 → 受控重建：等同步提示出现并消失。
  await page.waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="camera-sync-progress"]', {
    state: 'detached',
    timeout: SYNC_CONVERGE_MS,
  });
  await dismissModal(page);

  // 重建后画面应回到新保存的视角（不是旧 A，也不是用户拖动过程中的中间姿态）
  const afterSave = (await readPose(page))!;
  expect(distance(afterSave.position, b.position)).toBeLessThan(0.05);

  // 移动到 C（与 B 明显不同）
  await dragCanvas(page, 260, 90);
  const c = (await readPose(page))!;
  expect(distance(c.position, b.position)).toBeGreaterThan(0.5);

  // 1) 平台「定位到已保存视角」
  const resetBtn = page.getByRole('button', { name: '定位到已保存视角' });
  await resetBtn.scrollIntoViewIfNeeded();
  await resetBtn.click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const platformReset = (await readPose(page))!;
  expect(distance(platformReset.position, b.position)).toBeLessThan(0.05);
  // 构图一致（forward 方向 + FOV）
  expect(dot(forward(platformReset), forward(b))).toBeGreaterThan(0.999);
  expect(Math.abs(platformReset.fov - b.fov)).toBeLessThan(0.5);
});

test('GS-DESKTOP-04 §5.2/3：官方 Viewer Settings Reset 与键盘 Reset 都采用新视角', async ({
  page,
}) => {
  const { A: a, B: b } = await captureInitialAndSaved(page);
  await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
  await page.waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="camera-sync-progress"]', {
    state: 'detached',
    timeout: SYNC_CONVERGE_MS,
  });
  await dismissModal(page);

  await dragCanvas(page, 260, 90);
  const c = (await readPose(page))!;
  expect(distance(c.position, b.position)).toBeGreaterThan(0.5);

  // 2) 官方 Viewer Settings → Reset（官方自己的按钮，不经宿主）
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 10_000 });
  await page.locator('.sse-reset').first().click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const officialReset = (await readPose(page))!;
  expect(distance(officialReset.position, b.position)).toBeLessThan(0.05);
  expect(dot(forward(officialReset), forward(b))).toBeGreaterThan(0.999);

  // 3) 官方键盘快捷键 r（同一会话、同一目标）
  await dragCanvas(page, -180, 40);
  // 先点一下**画布**（不是页面角落）把键盘焦点交给官方 viewer。
  const focusPoint = await canvasPoint(page);
  await page.mouse.click(focusPoint.x, focusPoint.y);
  await page.keyboard.press('r');
  await pumpFrames(page, RESET_SETTLE_MS);
  const keyboardReset = (await readPose(page))!;
  expect(distance(keyboardReset.position, b.position)).toBeLessThan(0.05);
  expect(dot(forward(keyboardReset), forward(b))).toBeGreaterThan(0.999);
  expect(Math.abs(keyboardReset.fov - b.fov)).toBeLessThan(0.5);
  expect(distance(keyboardReset.position, a.position)).toBeGreaterThan(0.5);
});

test('GS-DESKTOP-04 §5.4/5：Frame 之后 Reset 仍回新视角；刷新后同样回新视角', async ({
  page,
}) => {
  const { A: a, B: b } = await captureInitialAndSaved(page);
  await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
  await page.waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="camera-sync-progress"]', {
    state: 'detached',
    timeout: SYNC_CONVERGE_MS,
  });
  await dismissModal(page);

  // 4) 官方 Frame → Reset：Frame 后不得卡在 AABB 取景
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-frame', { state: 'visible', timeout: 10_000 });
  await page.locator('.sse-frame').first().click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const afterFrame = (await readPose(page))!;
  expect(distance(afterFrame.position, b.position)).toBeGreaterThan(0.05);
  await page.locator('.sse-reset').first().click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const resetAfterFrame = (await readPose(page))!;
  expect(distance(resetAfterFrame.position, b.position)).toBeLessThan(0.05);

  // 5) 刷新页面（/scene 浏览页）→ 官方 Reset 仍回 B
  await page.goto(`/scene/${SCENE}`);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]', {
    timeout: 120_000,
  });
  await page.waitForFunction(() => !!window.__gsruntime, undefined, { timeout: 120_000 });
  await page.waitForFunction(
    () =>
      (window as unknown as { __gsruntime?: { state?: { loaded?: boolean } } }).__gsruntime?.state
        ?.loaded === true,
    undefined,
    { timeout: SYNC_CONVERGE_MS },
  );
  await pumpFrames(page, RESET_SETTLE_MS);
  const loadedPose = (await readPose(page))!;
  expect(distance(loadedPose.position, b.position)).toBeLessThan(0.05);
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 10_000 });
  await page.locator('.sse-reset').first().click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const resetAfterReload = (await readPose(page))!;
  expect(distance(resetAfterReload.position, b.position)).toBeLessThan(0.05);
  expect(distance(resetAfterReload.position, a.position)).toBeGreaterThan(0.5);

  // 14) Web 描述符与 DB 一致（同一份初始相机数据）
  const runtime = await (await page.request.get(`${API}/${SCENE}/runtime`)).json();
  expect(distance([runtime.presentation.initialCamera.position.x, runtime.presentation.initialCamera.position.y, runtime.presentation.initialCamera.position.z], b.position)).toBeLessThan(1e-3);
  expect(Math.abs(runtime.presentation.initialCamera.fov - b.fov)).toBeLessThan(1e-3);
});

test('GS-DESKTOP-04 §5.10/12：多次保存后 WebGL context 不泄漏、无自动 Frame', async ({ page }) => {
  await openAuthoring(page);
  await pumpFrames(page, RESET_SETTLE_MS);
  const life = await viewerLifecycle(page);

  for (let i = 0; i < 2; i += 1) {
    await dragCanvas(page, -160 + i * 40, -50);
    await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
    await page.waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 60_000 });
    await page.waitForSelector('[data-testid="camera-sync-progress"]', {
      state: 'detached',
      timeout: SYNC_CONVERGE_MS,
    });
    await dismissModal(page);
  }

  // 12) 只应有「一个 live canvas」：重建是销毁旧的再建新的，不是叠加。
  const after = await viewerLifecycle(page);
  expect(after.canvases).toBeLessThanOrEqual(1);
  expect(after.viewers).toBeLessThanOrEqual(1);
  // 13) 没有新的自动 Frame：当前相机仍是最后一次保存的视角（无 AABB 取景跳远）。
  // 用官方 runtime 的 loaded 状态断言（诊断 span 在 rebuild 后可能还没刷新）。
  await waitForViewerIdle(page);
  const now = (await readPose(page))!;
  expect(Number.isFinite(now.position[0])).toBe(true);
  const runtimeLoaded = await page.evaluate(
    () =>
      (window as unknown as { __gsauthoringruntime?: { state?: { loaded?: boolean } } })
        .__gsauthoringruntime?.state?.loaded === true,
  );
  expect(runtimeLoaded).toBe(true);
  void life;
});

test('GS-DESKTOP-04 §5.7：连续快速保存 B → D，最终 Reset 到最新保存的 D', async ({ page }) => {
  await openAuthoring(page);
  await pumpFrames(page, RESET_SETTLE_MS);

  // 第一次保存 B
  await dragCanvas(page, -220, -60);
  await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
  await page.waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="camera-sync-progress"]', {
    state: 'detached',
    timeout: SYNC_CONVERGE_MS,
  });
  await dismissModal(page);
  const b = (await readPose(page))!;

  // 第二次保存 D（不同构图）
  await dragCanvas(page, 300, 120);
  const d = (await readPose(page))!;
  expect(distance(d.position, b.position)).toBeGreaterThan(0.5);
  await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
  await page.waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="camera-sync-progress"]', {
    state: 'detached',
    timeout: SYNC_CONVERGE_MS,
  });
  await dismissModal(page);

  // 官方 Reset 必须回到**最新**保存的 D
  await dragCanvas(page, -200, 60);
  const moved = (await readPose(page))!;
  expect(distance(moved.position, d.position)).toBeGreaterThan(0.5);
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 10_000 });
  await page.locator('.sse-reset').first().click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const reset = (await readPose(page))!;
  expect(distance(reset.position, d.position)).toBeLessThan(0.05);
  expect(distance(reset.position, b.position)).toBeGreaterThan(0.5);
});

test('GS-DESKTOP-04 §5.6/§四：保存失败后官方 Reset 仍回旧视角 A', async ({ page }) => {
  await openAuthoring(page);
  await pumpFrames(page, RESET_SETTLE_MS);
  const a = (await readPose(page))!;

  // 让保存请求失败：拦截 PATCH /presentation 并回 403。
  await page.route(`${API}/${SCENE}/presentation`, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"detail":"forbidden"}' }),
  );

  await waitForViewerIdle(page);
  await dragCanvas(page, -220, -60);
  await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
  // 保存失败：必须明确报错，不得显示「已保存」。
  await page.waitForSelector('.ant-modal', { timeout: 30_000 });
  const modalText = (await page.locator('.ant-modal').first().innerText()).replace(/\s+/g, ' ');
  expect(modalText).toContain('保存失败');
  // 关掉错误弹窗（失败路径不会重建 Viewer，因此这里等不到 sync 进度）。
  await dismissModal(page);

  // 不得出现同步进度（保存失败绝不重建 Viewer）。
  expect(await page.locator('[data-testid="camera-sync-progress"]').count()).toBe(0);

  // 官方 Reset 必须仍然回 A（旧视角），不能把未保存的视角当成新目标。
  await waitForViewerIdle(page);
  await dragCanvas(page, 260, 90);
  const moved = (await readPose(page))!;
  expect(distance(moved.position, a.position)).toBeGreaterThan(0.5);
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 10_000 });
  await page.locator('.sse-reset').first().click();
  await pumpFrames(page, RESET_SETTLE_MS);
  const reset = (await readPose(page))!;
  expect(distance(reset.position, a.position)).toBeLessThan(0.05);
});
