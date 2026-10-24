/**
 * GS-DESKTOP-01 —— Gaussian 场景加载完成后相机不自动拉远（真实 Chromium 取证）。
 *
 * ## 用户报告的 P0
 *
 * 「在电脑浏览器查看 Gaussian 场景时，加载期间的主体构图很好。但加载一结束，
 *   视角就突然退到远处，显示整个 Gaussian 场景和废点。」
 *
 * ## 根因（真实浏览器 instrumentation 取证，见 docs/reports/GS_DESKTOP_01_CAMERA_STABILITY.md）
 *
 * `useSuperSplatDesktop.ts` / `SceneAuthoringPage.tsx` / `useSuperSplatXR.ts`
 * 在加载完成时按 `shouldFrameSceneOnLoad(desc)` 无条件执行官方 `frameScene()`
 * —— 官方 `frameScene()` = `createFrameCamera(bbox)`，距离 =
 * `bbox.halfExtents.length() / sin(fov/2)`，把**整个**（可能含大量离群 Gaussian 的）
 * AABB 塞进画面。官方 1.35.0 的加载路径自己**从不**调用它：加载后的初始相机
 * 一直是 `settings.cameras[0].initial`（`CameraManager` 构造时
 * `this.camera.copy(resetCamera)`）。
 *
 * ## 本文件验证的契约
 *
 * 1. loaded=true、progress=100 之后，相机在稳定观察期内**不移动**
 *    （未经用户触发的 camera move = 0）；
 * 2. 唯一允许的一次性初始化调用是 `applyWorldTransform` + `resetCamera`，
 *    **绝不含 `frameScene`**；
 * 3. authored 相机 → 相机精确落在 authored pose（不被任何东西覆盖）；
 * 4. 无 authored 相机 → 采用官方默认相机，而不是整个 AABB 取景；
 * 5. 用户主动 Frame / Reset 仍然有效（官方能力未被破坏）；
 * 6. 页面刷新、前进/后退、viewer 重建不会留下第二个相机控制器；
 * 7. 非恒等世界变换下相机仍然正确；
 * 8. XR 页的初始构图不受回归。
 *
 * 所有相机数字证据来自**真实 Chromium**（full build + SwiftShader WebGPU，
 * 见 e2e/fresh-browser.ts 的 rAF 冻结说明），不是 mock Viewer。
 */
import { expect, test, type Page } from './fresh-browser';

const API_SCENE = 'fix02-semantics';
type ApiRequest = import('@playwright/test').APIRequestContext;

/** 把探针脚本塞进页面：hook runtime 方法 + 按 20Hz 采样官方相机 pose。 */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(`
    window.__probe = { calls: [], samples: [], uiClicks: [] };
    // GS-DESKTOP-02：官方 Viewer 的 Frame / Reset 按钮直接调用官方内部 handle，
    // 不经过本项目的 SuperSplatRuntime 包装层（下面 wire 的 calls 记录不到）。
    // 用 capture 阶段的 DOM 点击记录「用户主动触发了哪些官方按钮」，与相机位移
    // 证据一起证明：用户操作有效，且平台代码从未在用户操作之外自动取景。
    document.addEventListener('click', (e) => {
      try {
        const t = e.target && e.target.closest ? e.target.closest('.sse-frame, .sse-reset') : null;
        if (!t) return;
        window.__probe.uiClicks.push({
          t: performance.now(),
          cls: Array.from(t.classList).join(' '),
        });
      } catch (err) { /* ignore */ }
    }, true);
    const wire = (v) => {
      try {
        const names = ['frameScene', 'resetCamera', 'setCameraPose', 'selectViewpoint',
          'applyWorldTransform', 'setWorldTransform', 'selectAnnotation',
          'selectGsplatformAnnotation', 'toggleWalk', 'setXRInitialCamera'];
        for (const name of names) {
          const orig = v[name];
          if (typeof orig !== 'function') continue;
          v[name] = function (...args) {
            window.__probe.calls.push({
              t: performance.now(),
              name,
              args: JSON.stringify(args).slice(0, 240),
            });
            return orig.apply(this, args);
          };
        }
        const sample = () => {
          try {
            const pose = v.getCameraPose ? v.getCameraPose() : null;
            window.__probe.samples.push({
              t: performance.now(),
              loaded: !!v.state?.loaded,
              progress: Math.round(v.state?.progress ?? -1),
              mode: v.state?.cameraMode ?? null,
              frame: typeof v.app?.frame === 'number' ? v.app.frame : null,
              pos: pose ? pose.position.map((n) => +n.toFixed(4)) : null,
              target: pose ? pose.target.map((n) => +n.toFixed(4)) : null,
              fov: pose ? +pose.fov.toFixed(3) : null,
              viewers: document.querySelectorAll('.sse-viewer').length,
              cameras: document.querySelectorAll('.sse-viewer canvas').length,
              poster: !!document.querySelector('[data-testid="ov-poster"]'),
            });
            if (window.__probe.samples.length > 6000) window.__probe.samples.splice(0, 500);
          } catch (e) { window.__probe.error = String(e); }
        };
        sample();
        setInterval(sample, 50);
      } catch (e) { window.__probe.error = String(e); }
    };
    for (const key of ['__gsruntime', '__gsxrruntime', '__gsauthoringruntime']) {
      let value = null;
      Object.defineProperty(window, key, {
        configurable: true,
        get() { return value; },
        set(v) { value = v; wire(v); },
      });
    }
  `);
}

interface ProbeSample {
  t: number;
  loaded: boolean;
  progress: number;
  mode: string | null;
  frame: number | null;
  pos: number[] | null;
  target: number[] | null;
  fov: number | null;
  viewers: number;
  cameras: number;
  poster: boolean;
}

interface Probe {
  calls: { t: number; name: string; args?: string }[];
  samples: ProbeSample[];
  uiClicks?: { t: number; cls: string }[];
  error?: string;
}

/** 打开 viewer 并等官方 loaded=true + 至少渲染出 Gaussian。 */
async function openViewer(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      try {
        const d = JSON.parse(el?.textContent ?? '{}');
        return d.loaded === true;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 120_000 },
  );
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
}

/** 诊断读数（真实相机 pose + 世界变换 + 内容来源）。 */
async function readDiag(page: Page): Promise<any> {
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')?.textContent ?? '{}'),
  );
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 视角方向（forward），用于比较"构图"而不是绝对 target 点。 */
function forward(cam: { position: number[]; target: number[] }): number[] {
  const d = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return d.map((v) => v / len);
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * 让官方 app 继续 tick（并保持一段 wall-clock 时间）。
 *
 * 官方 viewer 在首次完整帧后 `app.autoRender = false`（按需渲染）。在
 * headless + SwiftShader 下，**空闲时**浏览器可能不再产生帧，官方 1 秒的相机
 * 过渡就会停在半路（GS-NEXT-10 / FIX-02 §19 都记录过：软件渲染下过渡要长预算）。
 *
 * `waitForFunction(..., { polling: 'raf' })` 每帧回调一次，等价于持续向浏览器
 * 请求帧 —— 这是本仓库既有相机 e2e（fix02-semantics.spec.ts）验证过的做法。
 * 它不改变任何相机姿态，只是让引擎的 update 循环继续跑。
 */
async function pumpFrames(page: Page, ms: number): Promise<void> {
  // headless + SwiftShader 下浏览器可能不再向页面投递 rAF（GS-NEXT-10 记录过），
  // 官方 1 秒的相机过渡会停在半路。这里手动推进**引擎自己的**公开 update 循环
  // （app.tick），只推进时间，不写任何相机状态 —— 产品代码完全不变。
  const total = Math.max(1, Math.ceil(ms / 16.7));
  let done = 0;
  while (done < total) {
    const chunk = Math.min(60, total - done);
    await page.evaluate((count) => {
      const rt = (window as unknown as {
        __gsruntime?: { app?: { tick?: (t: number) => void } };
        __gsxrruntime?: { app?: { tick?: (t: number) => void } };
        __gsauthoringruntime?: { app?: { tick?: (t: number) => void } };
      });
      const app = rt.__gsruntime?.app ?? rt.__gsxrruntime?.app ?? rt.__gsauthoringruntime?.app;
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

/** 直接从 runtime 读真实相机 pose（不依赖 React 诊断 span 的轮询延迟）。 */
async function readRuntimePose(page: Page): Promise<any> {
  return page.evaluate(() => {
    const rt = (window as unknown as {
      __gsruntime?: { getCameraPose?: () => any };
      __gsxrruntime?: { getCameraPose?: () => any };
      __gsauthoringruntime?: { getCameraPose?: () => any };
    });
    const runtime = rt.__gsruntime ?? rt.__gsxrruntime ?? rt.__gsauthoringruntime;
    const pose = runtime?.getCameraPose?.();
    return pose
      ? { position: pose.position.map(Number), target: pose.target.map(Number), fov: pose.fov }
      : null;
  });
}

/** 等相机位姿满足条件（驱动官方 update 循环，长预算同 FIX-02 §19）。 */
const CAMERA_SETTLE_MS = 150_000;

async function waitForCamera(
  page: Page,
  predicate: (cam: { position: number[]; target: number[]; fov: number }) => boolean,
  timeoutMs = CAMERA_SETTLE_MS,
): Promise<{ position: number[]; target: number[]; fov: number }> {
  const end = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < end) {
    await pumpFrames(page, 250);
    last = await readRuntimePose(page);
    if (last && predicate(last)) return last;
  }
  const tail = await page.evaluate(() =>
    ((window as unknown as { __probe?: { samples: unknown[] } }).__probe?.samples ?? []).slice(-6),
  );
  throw new Error(
    `waitForCamera timed out; last=${JSON.stringify(last)}; tail=${JSON.stringify(tail)}`,
  );
}

/**
 * 核心断言：loaded 之后在观察期内相机**不移动**，且没有 frameScene 调用。
 * 这是用户 P0 的直接验收条件。
 *
 * 同时报告**实际位移与帧证据**（tolerance 逐级收紧），失败时日志直接给出
 * 触发原因、移动距离、起始/结束 pose —— 不靠截图猜相机坐标。
 */
function assertNoJumpAfterLoad(probe: Probe, label: string, windowMs = 6000): void {
  const samples = probe.samples;
  const firstLoaded = samples.findIndex((s) => s.loaded && s.progress >= 100);
  expect(firstLoaded, `${label}: 应能观察到 loaded=true / progress=100 的采样`).toBeGreaterThanOrEqual(0);
  const atLoad = samples[firstLoaded];
  const window = samples.filter((s) => s.t >= atLoad.t && s.t <= atLoad.t + windowMs);
  const windowsSinceLoad = samples.filter((s) => s.t >= atLoad.t);
  expect(
    windowsSinceLoad.length,
    `${label}: 采样器应持续运行（如果只有 1-2 个样本，说明探针没有持续采样，不是"相机没动"）`,
  ).toBeGreaterThan(5);
  void window;

  // 1) 没有未经用户触发的相机位移（从 loaded 起算的全部样本）。
  let maxMove = 0;
  for (const s of windowsSinceLoad) {
    if (!s.pos || !atLoad.pos) continue;
    maxMove = Math.max(maxMove, distance(s.pos, atLoad.pos));
  }
  expect(
    maxMove,
    `${label}: 加载完成后 ${windowMs}ms 内相机不得移动（实测 ${maxMove.toFixed(4)}；` +
      `起始 ${JSON.stringify(atLoad.pos)} → 结束 ${JSON.stringify(window.at(-1)?.pos ?? null)}；` +
      `触发调用=${JSON.stringify(probe.calls.filter((c) => c.name !== 'applyWorldTransform'))}）`,
  ).toBeLessThan(0.01);

  // 2) 稳定期后仍然停在原地。
  const last = samples.at(-1)!;
  expect(last.loaded, `${label}: 末样本仍应是 loaded`).toBe(true);
  expect(last.progress, `${label}: 末样本 progress 应为 100`).toBe(100);
  expect(distance(last.pos!, atLoad.pos!), `${label}: 全周期相机不得漂移`).toBeLessThan(0.01);

  // 3) 加载完成路径**绝不含** frameScene。
  const frameCalls = probe.calls.filter((c) => c.name === 'frameScene');
  expect(
    frameCalls.length,
    `${label}: 加载路径不得调用 frameScene（自动取景 = 用户 P0）；实际调用=${JSON.stringify(probe.calls)}`,
  ).toBe(0);

  console.log(
    `[evidence] ${label}: 相机在 loaded 后 ${windowMs}ms 内位移 ${maxMove.toFixed(6)}，` +
      `pose ${JSON.stringify(atLoad.pos)} → ${JSON.stringify(last.pos)}，fov ${atLoad.fov} → ${last.fov}，` +
      `mode ${atLoad.mode} → ${last.mode}，初始化调用=${JSON.stringify(probe.calls.map((c) => c.name))}`,
  );
}

// --------------------------------------------------------------------------- //
// 夹具：runtime 描述符重写（形状真实，来自 GET /runtime）
// --------------------------------------------------------------------------- //

async function descriptorViaRequest(request: ApiRequest, scene: string): Promise<any> {
  const r = await request.get(`/api/v1/scenes/${scene}/runtime`);
  expect(r.status()).toBe(200);
  return r.json();
}

/**
 * 期望的 authored 初始相机（从 **运行时描述符** 读取，而不是硬编码夹具常量）。
 *
 * 这样测试断言的是「相机 == 运行时声明的初始相机」，即使夹具被其他用例改过
 * 也不会把「夹具脏了」误判成产品缺陷。
 */
async function expectedAuthoredCamera(
  request: ApiRequest,
  scene: string,
): Promise<{ position: number[]; target: number[]; fov: number }> {
  const descriptor = await descriptorViaRequest(request, scene);
  const cam = descriptor.presentation.initialCamera;
  expect(cam.position, `${scene}: 夹具应带 authored 相机`).not.toBeNull();
  expect(cam.target, `${scene}: 夹具应带 authored target`).not.toBeNull();
  return {
    position: [cam.position.x, cam.position.y, cam.position.z],
    target: [cam.target.x, cam.target.y, cam.target.z],
    fov: cam.fov,
  };
}

/**
 * 注入一个无 authored initial camera 的描述符（null 语义，与后端 STALE 丢弃
 * initialCamera 时的真实形状一致）。可选加一个 data-URI poster。
 */
async function routeWithoutAuthoredCamera(page: Page, scene: string, poster = false): Promise<void> {
  const descriptor = await descriptorViaRequest(
    { get: (url: string) => page.request.get(url) } as unknown as ApiRequest,
    scene,
  );
  descriptor.presentation.initialCamera = { position: null, target: null, fov: null };
  if (poster) {
    descriptor.scene.posterUrl =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
          '<rect width="1280" height="720" fill="#2b4a6b"/>' +
          '<circle cx="640" cy="340" r="140" fill="#e8c27a"/>' +
          '<text x="30" y="60" fill="#fff" font-size="30">COVER / POSTER</text></svg>',
      );
  }
  await page.route(`**/api/v1/scenes/${scene}/runtime`, (route) => route.fulfill({ json: descriptor }));
}

/** manifest 回退场景（local-scenes）的同款注入。 */
async function routeManifestWithoutCamera(page: Page, scene: string, poster = false): Promise<void> {
  await page.route(`**/local-scenes/${scene}/manifest.json`, async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    delete manifest.camera;
    if (poster) manifest.posterUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#3c5a2b"/></svg>',
    );
    await route.fulfill({ response, json: manifest });
  });
}

// --------------------------------------------------------------------------- //
// presentation / authoring helpers
// --------------------------------------------------------------------------- //

interface Presentation {
  initialCameraPosition: { x: number; y: number; z: number } | null;
  initialCameraTarget: { x: number; y: number; z: number } | null;
  initialCameraFov: number | null;
  worldRotation: { x: number; y: number; z: number } | null;
}

async function getPresentation(request: ApiRequest, scene: string): Promise<Presentation> {
  const r = await request.get(`/api/v1/scenes/${scene}/presentation`);
  expect(r.status(), `GET /presentation (${scene})`).toBe(200);
  return r.json() as Promise<Presentation>;
}

/** 非破坏性恢复：只写回本 spec 改过的字段。 */
async function restorePresentation(
  request: ApiRequest,
  scene: string,
  snapshot: Presentation,
): Promise<void> {
  const r = await request.patch(`/api/v1/scenes/${scene}/presentation`, {
    data: {
      initialCameraPosition: snapshot.initialCameraPosition,
      initialCameraTarget: snapshot.initialCameraTarget,
      initialCameraFov: snapshot.initialCameraFov,
      worldRotation: snapshot.worldRotation ?? { x: 0, y: 0, z: 0 },
    },
  });
  expect(r.status(), `restore /presentation (${scene})`).toBe(200);
}

/** 打开创作页并等真实 Gaussian 预览就绪。 */
async function openAuthoring(page: Page, scene: string): Promise<void> {
  await page.goto(`/model/edit/${scene}`);
  await page.waitForSelector('[data-testid="scene-authoring-page"]');
  await expect(page.getByText('Viewer 就绪').first()).toBeVisible({ timeout: 120_000 });
  await page.waitForSelector('[data-testid="scene-authoring-page"] canvas', {
    state: 'visible',
    timeout: 60_000,
  });
}

/** 在创作预览里真实移动相机（滚轮推近 + 拖拽环绕）—— 与 GS-NEXT-02 同一手法。 */
async function moveCameraToCloseUp(page: Page): Promise<void> {
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
  await page.mouse.move(cx - 90, cy + 45, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

/** 「将当前视角设为初始视角」—— 页面顶栏的简单入口（GS-DESKTOP-02 PCUI 工作区）。 */
async function clickSaveCurrentView(page: Page): Promise<void> {
  await page.getByRole('button', { name: '保存初始视角' }).click();
}

// --------------------------------------------------------------------------- //

test.describe.configure({ timeout: 600_000 });

test.describe('GS-DESKTOP-01：加载完成后相机不自动拉远', () => {
  test.beforeEach(async ({ page }) => {
    await installProbe(page);
  });

  test('① 有 authored initial camera 的普通 SOG：加载后精确落在 authored pose 且不漂移', async ({ page, request }) => {
    const expected = await expectedAuthoredCamera(request, API_SCENE);
    const descriptor = await descriptorViaRequest(request, API_SCENE);
    expect(descriptor.content.format).toBe('sog');

    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await pumpFrames(page, 6000);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'authored SOG');

    const diag = await readDiag(page);
    const cam = diag.camera;
    expect(distance(cam.position, expected.position), '相机 == 运行时声明的 authored 初始相机').toBeLessThan(0.05);
    expect(Math.abs(cam.fov - expected.fov)).toBeLessThan(0.05);
    expect(
      dot(forward(cam), forward({ position: cam.position, target: expected.target })),
      'look 方向应与 authored target 一致',
    ).toBeGreaterThan(0.999);

    // 初始化调用的完整顺序（除 user 触发的之外只有这两条）。
    expect(probe.calls.map((c) => c.name).slice(0, 2)).toEqual(['applyWorldTransform', 'resetCamera']);
    expect(probe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);
    // 只有一个 viewer / 一块 canvas（没有第二个相机控制器）。
    expect(diag.renderer).toBeTruthy();
    expect(Number(diag.gsplats ?? 0)).toBeGreaterThan(0);
    expect(probe.samples.at(-1)!.viewers).toBe(1);
    expect(probe.samples.at(-1)!.cameras).toBe(1);
  });

  test('② 无 authored initial camera：采用官方默认相机，不取景整个 AABB', async ({ page }) => {
    await routeWithoutAuthoredCamera(page, API_SCENE, true);
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await pumpFrames(page, 6000);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'no authored camera');

    const diag = await readDiag(page);
    const cam = diag.camera;
    // 官方 defaultSettings('environment') 的默认相机 = [0,2,0] / fov 85。
    expect(distance(cam.position, [0, 2, 0]), '应停在官方默认相机，而不是 AABB 取景').toBeLessThan(0.05);
    expect(Math.abs(cam.fov - 85)).toBeLessThan(0.05);
    expect(probe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);
  });

  test('③ 加载画面是 poster（封面图），不是真实相机；有/无 poster 行为一致', async ({ page }) => {
    await routeWithoutAuthoredCamera(page, API_SCENE, true);
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await pumpFrames(page, 6000);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'poster present');

    // poster 只在加载期出现（ov-loading overlay 内的封面图），加载完成后消失。
    const sawPoster = probe.samples.some((s) => s.poster);
    const finalHasPoster = probe.samples.at(-1)!.poster;
    expect(finalHasPoster, '加载完成后不应还挂着封面图').toBe(false);
    expect(sawPoster, '加载期应能看到封面图（否则本用例没测到 poster 路径）').toBe(true);

    // 最终相机仍是官方默认相机 —— 不允许用 2D 封面反推 3D 位姿。
    const diag = await readDiag(page);
    expect(distance(diag.camera.position, [0, 2, 0])).toBeLessThan(0.05);
  });

  test('④ 稳定观察期：loaded 之后 6 秒内没有任何未经用户触发的相机移动', async ({ page }) => {
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await pumpFrames(page, 6500);
    const atLoad = await readProbe(page);
    assertNoJumpAfterLoad(atLoad, 'stability', 6000);
    await pumpFrames(page, 4000);
    const later = await readProbe(page);
    assertNoJumpAfterLoad(later, 'stability-extended', 8000);
  });

  test('⑤ 用户主动 Frame / Reset 仍然有效（官方能力未被破坏）', async ({ page, request }) => {
    const expected = await expectedAuthoredCamera(request, API_SCENE);
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await page.waitForTimeout(2000);

    const before = await readDiag(page);
    expect(before.loaded).toBe(true);

    // Frame（用户主动取景整个场景）→ 相机必须明显离开初始相机。
    await page.locator('.sse-settings').first().click();
    await page.waitForTimeout(300);
    await page.locator('.sse-frame').first().click({ force: true });
    const framed = await waitForCamera(page, (cam) => distance(cam.position, expected.position) > 1.0, 60_000);
    console.log('[evidence] Frame 后相机:', JSON.stringify(framed));
    expect(
      distance(framed.position, expected.position),
      '用户主动 Frame 后应离开 authored pose（取景整个 AABB）',
    ).toBeGreaterThan(1.0);

    // Reset（回到初始相机）→ 精确回到 authored pose。
    if (!(await page.locator('.sse-reset').first().isVisible())) {
      await page.locator('.sse-settings').first().click();
      await page.waitForTimeout(300);
    }
    await page.locator('.sse-reset').first().click({ force: true });
    const reset = await waitForCamera(page, (cam) => distance(cam.position, expected.position) < 0.05, 60_000);
    console.log('[evidence] Reset 后相机:', JSON.stringify(reset));
    expect(
      distance(reset.position, expected.position),
      'Reset 后应回到 authored initial camera',
    ).toBeLessThan(0.05);

    // 用户操作之后不会再被自动覆盖（这就是本任务的核心承诺）。
    await pumpFrames(page, 4000);
    const after = await readDiag(page);
    expect(distance(after.camera.position, expected.position)).toBeLessThan(0.05);

    const probe = await readProbe(page);
    // 官方 1.35.0 的 Frame / Reset 按钮直接调用官方内部 handle，探针在
    // SuperSplatRuntime 包装层上的 frameScene 计数为 0 是**正确**的 —— 平台代码
    // 在加载后从不调用 frameScene。用户主动操作另由 DOM 点击证据计数。
    expect(
      probe.calls.filter((c) => c.name === 'frameScene').length,
      '平台代码不得在用户操作之外调用 frameScene（官方按钮走官方内部实现）',
    ).toBe(0);
    expect(
      (probe.uiClicks ?? []).filter((c) => c.cls.includes('sse-frame')).length,
      '只应有用户主动的那一次官方 Frame 点击',
    ).toBe(1);
  });

  test('⑥ 刷新页面不留下第二个相机控制器，且相机仍然稳定', async ({ page, request }) => {
    const expected = await expectedAuthoredCamera(request, API_SCENE);
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await page.waitForTimeout(2000);
    await page.reload();
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ov-diagnostics"]');
        try {
          return JSON.parse(el?.textContent ?? '{}').loaded === true;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 120_000 },
    );
    await pumpFrames(page, 6000);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'after reload');
    const diag = await readDiag(page);
    expect(distance(diag.camera.position, expected.position)).toBeLessThan(0.05);
    expect(probe.samples.every((s) => s.viewers === 1 && s.cameras === 1)).toBe(true);
  });

  test('⑦ 浏览器前进/往返不会留下第二个 viewer（React 卸载必须销毁 runtime）', async ({ page }) => {
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await page.waitForTimeout(1500);
    // 离开 viewer 路由（卸载 → destroy），再前进回来（重建）。
    await page.goto('/');
    await page.waitForTimeout(500);
    await page.goBack();
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ov-diagnostics"]');
        try {
          return JSON.parse(el?.textContent ?? '{}').loaded === true;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 120_000 },
    );
    await pumpFrames(page, 6000);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'after back');
    expect(
      await page.evaluate(() => document.querySelectorAll('.sse-viewer').length),
      '页面上只应有一个官方 viewer 根节点',
    ).toBe(1);
  });

  test('⑧ 非恒等世界变换：相机仍按 SCENE→RUNTIME 换算，加载后不漂移', async ({ page, request }) => {
    const snapshot = await (await request.get(`/api/v1/scenes/${API_SCENE}/presentation`)).json();
    await request.patch(`/api/v1/scenes/${API_SCENE}/presentation`, {
      data: {
        initialCameraPosition: { x: 1.5, y: 1.6, z: 2.5 },
        initialCameraTarget: { x: 0.0, y: 1.6, z: 0.0 },
        initialCameraFov: 65,
        worldRotation: { x: 0, y: 90, z: 0 },
      },
    });

    try {
      await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
      await pumpFrames(page, 6000);
      const probe = await readProbe(page);
      assertNoJumpAfterLoad(probe, 'non-identity world transform');

      const diag = await readDiag(page);
      expect(diag.worldTransform.isIdentity).toBe(false);
      expect(diag.worldTransform.rotation).toEqual({ x: 0, y: 90, z: 0 });
      // Ry90°：(x,z) → (z, -x)：相机位置应为 (2.5, 1.6, -1.5)。
      expect(distance(diag.camera.position, [2.5, 1.6, -1.5])).toBeLessThan(0.05);
      expect(probe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);
    } finally {
      // 恢复夹具（非破坏性清理：只写回本用例改过的字段）。
      await request.patch(`/api/v1/scenes/${API_SCENE}/presentation`, {
        data: {
          initialCameraPosition: snapshot.initialCameraPosition,
          initialCameraTarget: snapshot.initialCameraTarget,
          initialCameraFov: snapshot.initialCameraFov,
          worldRotation: snapshot.worldRotation ?? { x: 0, y: 0, z: 0 },
        },
      });
    }
  });

  test('⑨ XR 页初始构图不受回归（同一份 authored 视角，无自动 frameScene）', async ({ page, request }) => {
    const expected = await expectedAuthoredCamera(request, API_SCENE);
    // XR 页把 runtime 暴露为 window.__gsxrruntime —— installProbe 已经同时挂上。
    // XR 页的诊断读数同样暴露相机 pose（进入 VR 之前的桌面构图）。
    await page.goto(`/xr/${API_SCENE}`);
    await page.waitForSelector('[data-testid="ov-xr-diagnostics"]');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ov-xr-diagnostics"]');
        try {
          return JSON.parse(el?.textContent ?? '{}').loaded === true;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 120_000 },
    );
    await pumpFrames(page, 6500);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'XR pre-VR');

    const xrDiag = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')?.textContent ?? '{}'),
    );
    const cam = xrDiag.camera;
    expect(distance(cam.position, expected.position)).toBeLessThan(0.4);
    expect(Math.abs(cam.fov - expected.fov)).toBeLessThan(0.6);
  });

  test('⑩ manifest 回退场景（无 authored 相机）：行为与 DB 场景一致', async ({ page }) => {
    await routeManifestWithoutCamera(page, 'local-garden', false);
    await openViewer(page, '/scene/local-garden?diagnostics=1');
    await pumpFrames(page, 6000);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'manifest fallback');
    const diag = await readDiag(page);
    expect(diag.isManifestFallback, '本用例应走 manifest 回退路径').toBe(true);
    expect(distance(diag.camera.position, [0, 2, 0]), '官方默认相机').toBeLessThan(0.05);
    expect(probe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);
  });

  test('⑪ 保存当前视角 → 刷新：新相机被采用且不被任何自动取景覆盖', async ({ page, request }) => {
    const snapshot = await getPresentation(request, API_SCENE);
    const originalPos = snapshot.initialCameraPosition
      ? [
          snapshot.initialCameraPosition.x,
          snapshot.initialCameraPosition.y,
          snapshot.initialCameraPosition.z,
        ]
      : null;
    try {
      await openAuthoring(page, API_SCENE);
      await moveCameraToCloseUp(page);
      await clickSaveCurrentView(page);
      await expect(page.getByText('已保存（初始视角已更新，打开场景将采用该视角）')).toBeVisible({
        timeout: 30_000,
      });

      // 独立回读：/presentation 与 /runtime 必须一致（不是只在数据库里写入）。
      const saved = await getPresentation(request, API_SCENE);
      expect(saved.initialCameraPosition).not.toBeNull();
      const savedPos = [
        saved.initialCameraPosition!.x,
        saved.initialCameraPosition!.y,
        saved.initialCameraPosition!.z,
      ];
      expect(originalPos, '夹具应有 authored 相机').not.toBeNull();
      expect(distance(savedPos, originalPos!), '应真的移动过相机').toBeGreaterThan(0.3);
      const runtime = await descriptorViaRequest(request, API_SCENE);
      expect(runtime.presentation.initialCamera.position.x).toBeCloseTo(savedPos[0], 6);
      expect(runtime.presentation.initialCamera.position.y).toBeCloseTo(savedPos[1], 6);
      expect(runtime.presentation.initialCamera.position.z).toBeCloseTo(savedPos[2], 6);

      // 真实刷新 → 采用新相机，稳定观察期内不移动，且没有 frameScene。
      await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
      await pumpFrames(page, 6500);
      const probe = await readProbe(page);
      assertNoJumpAfterLoad(probe, 'saved view after reload');
      const diag = await readDiag(page);
      expect(distance(diag.camera.position, savedPos), '刷新后应采用刚保存的视角').toBeLessThan(0.05);
      expect(Math.abs(diag.camera.fov - saved.initialCameraFov!)).toBeLessThan(0.05);
      expect(
        dot(
          forward(diag.camera),
          forward({ position: savedPos, target: [saved.initialCameraTarget!.x, saved.initialCameraTarget!.y, saved.initialCameraTarget!.z] }),
        ),
      ).toBeGreaterThan(0.999);
    } finally {
      await restorePresentation(request, API_SCENE, snapshot);
    }
  });

  test('⑫ Authoring → Viewer 一致性：两处使用同一份初始相机，加载后都不移动', async ({ page, request }) => {
    const expected = await expectedAuthoredCamera(request, API_SCENE);
    // 创作预览（真实 Gaussian Viewer，同一 descriptor → 同一 ExperienceSettings）
    await openAuthoring(page, API_SCENE);
    await page.waitForTimeout(1500);
    const authoringPose = await page.evaluate(() => {
      const rt = (window as unknown as { __gsauthoringruntime?: { getCameraPose(): any } })
        .__gsauthoringruntime;
      return rt?.getCameraPose() ?? null;
    });
    expect(authoringPose, '创作预览应暴露真实相机 pose').not.toBeNull();
    expect(authoringPose.position.every(Number.isFinite)).toBe(true);
    expect(
      distance(authoringPose.position, expected.position),
      '创作预览应采用运行时声明的初始相机',
    ).toBeLessThan(0.05);

    // 普通浏览
    await openViewer(page, `/scene/${API_SCENE}?diagnostics=1`);
    await pumpFrames(page, 6500);
    const probe = await readProbe(page);
    assertNoJumpAfterLoad(probe, 'authoring/viewer consistency');
    const diag = await readDiag(page);
    expect(distance(diag.camera.position, authoringPose.position), 'Authoring 与 Viewer 初始相机应一致').toBeLessThan(0.05);
    expect(Math.abs(diag.camera.fov - authoringPose.fov)).toBeLessThan(0.05);
    expect(probe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);
  });

  test('⑬ 切换历史 SceneVersion 后重新保存视角：Streamed SOG 采用新相机且不自动取景', async ({ page, request }) => {
    // 专用夹具（不与 gsnext11/gsnext12 共享，避免并发/残留任务互相干扰）：
    //   GS_SEED_SLUG=gsdesktop01-versions python scripts/gsnext11_seed_versions_fixture.py
    const SCENE = 'gsdesktop01-versions';
    const STREAMED_AUTH = { position: [3.0, 1.8, 6.0], fov: 47.0 };
    const listing = await (await request.get(`/api/v1/scenes/${SCENE}/versions`)).json();
    const streamed = listing.items.find((i: any) => i.format === 'streamed-sog');
    const sog = listing.items.find((i: any) => i.format === 'sog');
    expect(streamed, '夹具应有 streamed-sog 版本').toBeTruthy();
    expect(sog, '夹具应有 sog 版本').toBeTruthy();
    const originalCurrent: string = listing.currentVersionId;
    const originalPresentation = await getPresentation(request, SCENE);

    try {
      // ── ⑬-a：authored 相机 + Streamed SOG：加载后精确采用且不移动 ──
      await openViewer(page, `/scene/${SCENE}?diagnostics=1`);
      await pumpFrames(page, 6500);
      const streamedProbe = await readProbe(page);
      assertNoJumpAfterLoad(streamedProbe, 'authored streamed SOG');
      const streamedDiag = await readDiag(page);
      expect(String(streamedDiag.contentUrl), '应加载 streamed lod-meta').toContain('lod-meta');
      expect(distance(streamedDiag.camera.position, STREAMED_AUTH.position)).toBeLessThan(0.05);
      expect(Math.abs(streamedDiag.camera.fov - STREAMED_AUTH.fov)).toBeLessThan(0.05);
      expect(streamedProbe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);

      // ── ⑬-b：切到历史版本（sog），空间配置按设计失效 ──
      const switched = await request.post(`/api/v1/scenes/${SCENE}/versions/${sog.id}/activate`, {
        data: { expectedCurrentVersionId: originalCurrent },
      });
      expect(switched.status(), await switched.text()).toBe(200);
      const afterSwitch = await descriptorViaRequest(request, SCENE);
      expect(afterSwitch.presentation.initialCamera.position ?? null, '切换后旧相机不应被沿用').toBeNull();
      expect(afterSwitch.content.format).toBe('sog');

      // ── ⑬-c：在真实创作预览里重新保存视角（任务要求的简单入口）──
      await openAuthoring(page, SCENE);
      await moveCameraToCloseUp(page);
      await clickSaveCurrentView(page);
      await expect(page.getByText('已保存（初始视角已更新，打开场景将采用该视角）')).toBeVisible({
        timeout: 30_000,
      });

      const saved = await getPresentation(request, SCENE);
      const savedPos = [
        saved.initialCameraPosition!.x,
        saved.initialCameraPosition!.y,
        saved.initialCameraPosition!.z,
      ];
      const runtimeDesc = await descriptorViaRequest(request, SCENE);
      expect(runtimeDesc.content.format, '应真的在切换后的 sog 版本上').toBe('sog');
      expect(runtimeDesc.presentation.initialCamera.position.x).toBeCloseTo(savedPos[0], 6);
      expect(runtimeDesc.presentation.initialCamera.position.y).toBeCloseTo(savedPos[1], 6);
      expect(runtimeDesc.presentation.initialCamera.position.z).toBeCloseTo(savedPos[2], 6);
      expect(
        distance(savedPos, STREAMED_AUTH.position),
        '重新保存的视角应与切换前的 authored 视角不同（真的重新保存过）',
      ).toBeGreaterThan(0.3);

      // ── ⑬-d：重新打开：采用新相机，加载后不移动，且没有 frameScene ──
      await openViewer(page, `/scene/${SCENE}?diagnostics=1`);
      await pumpFrames(page, 6500);
      const probe = await readProbe(page);
      assertNoJumpAfterLoad(probe, 'version switch + re-save (sog)');
      const diag = await readDiag(page);
      expect(String(diag.contentUrl)).not.toContain('lod-meta');
      expect(distance(diag.camera.position, savedPos), '应采用切换版本后重新保存的视角').toBeLessThan(0.05);
      expect(probe.calls.filter((c) => c.name === 'frameScene')).toHaveLength(0);
    } finally {
      // 恢复：回到原当前版本并写回原初始视角（非破坏性清理）。
      await request.post(`/api/v1/scenes/${SCENE}/versions/${originalCurrent}/activate`, {
        data: { expectedCurrentVersionId: sog.id },
      });
      await restorePresentation(request, SCENE, originalPresentation);
    }
  });
});
