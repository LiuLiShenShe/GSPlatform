/**
 * GS-DESKTOP-04 —— 真实 GPU 浏览器取证（headful + Xvfb :98 + ANGLE/Vulkan NVIDIA）。
 *
 * 与 Playwright spec 的分工：
 *   - spec（headless + SwiftShader）负责**断言**：Reset 目标、walk 闸门、泄漏；
 *   - 本脚本负责**取证**：真实 GPU 合成出来的截图、相机时间线、Viewer 创建/销毁
 *     计数、前后相机 JSON。SwiftShader 下 WebGL canvas 不进截图合成（GS-DESKTOP-03
 *     根因），所以画质/画面证据必须走这条路。
 *
 * 用法（在 apps/web 下，需先 `Xvfb :98 -screen 0 1920x1080x24 &`）：
 *   node e2e/gsdesktop04/run.mjs            # 全部阶段
 *   node e2e/gsdesktop04/run.mjs camera     # 只跑相机同步
 *   node e2e/gsdesktop04/run.mjs walk       # 只跑 walk 闸门
 *
 * 输出：docs/reports/gsdesktop04-evidence/（可用 GSD04_OUT 覆盖）
 */
import path from 'path';

process.env.GSD03_OUT ??= path.resolve(
  import.meta.dirname,
  '../../../../docs/reports/gsdesktop04-evidence',
);

const {
  BASE, DISPLAY, OUT, capture, dist, launch, newPage, pose, runtimeState,
  shot, waitLoaded, waitRuntime, writeJson, ensureOut,
} = await import('../gsdesktop03/common.mjs');

const AUTHORING_SCENE = 'fix02-semantics'; // authored 初始相机 A = (2.5, 1.8, 6.0)
const SAFE = 'gsdesktop04-walk-safe';
const STALE = 'gsdesktop04-walk-stale';
const UNCAL = 'gsdesktop04-walk-uncalibrated';

const phase = process.argv[2] ?? 'all';

/** 让官方 app 继续 tick（headful 下 rAF 正常，但显式推进更稳）。 */
async function pump(page, ms) {
  const total = Math.max(1, Math.ceil(ms / 16.7));
  await page.evaluate((count) => {
    const rt = window.__gsruntime ?? window.__gsauthoringruntime;
    const app = rt?.app;
    if (typeof app?.tick !== 'function') return;
    const w = window;
    let clock = Math.max(w.__gsTickClock ?? 0, performance.now());
    for (let i = 0; i < count; i += 1) {
      clock += 16.7;
      app.tick(clock);
    }
    w.__gsTickClock = clock;
  }, total);
}

/** 找到一个真能被画布接收指针的点（官方 controlsHint 面板会挡住默认中心）。 */
async function canvasPoint(page) {
  const box = await page.locator('canvas').first().boundingBox();
  const pts = [];
  for (let i = 1; i < 8; i += 1) {
    for (let j = 1; j < 8; j += 1) {
      pts.push({ x: box.x + (box.width * i) / 8, y: box.y + (box.height * j) / 8 });
    }
  }
  const hits = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS'),
    pts,
  );
  const free = pts.filter((_, i) => hits[i]);
  if (!free.length) throw new Error('no unobstructed canvas point');
  return free[0];
}

async function drag(page, dx, dy) {
  const box = await page.locator('canvas').first().boundingBox();
  const p = await canvasPoint(page);
  const sx = Math.min(Math.max(p.x, box.x + 30), box.x + box.width - 30);
  const sy = Math.min(Math.max(p.y, box.y + 30), box.y + box.height - 30);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx, sy + dy, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}

async function waitIdle(page) {
  await page
    .waitForSelector('.gs-workspace__loading', { state: 'detached', timeout: 600_000 })
    .catch(() => {});
  await waitRuntime(page, 240_000);
  await page.waitForSelector('canvas', { state: 'visible', timeout: 60_000 });
}

/** Viewer 创建/销毁计数：宿主每次保存最多重建一次，且必须销毁旧的。 */
async function installLifecycleProbe(page) {
  await page.addInitScript(() => {
    // addInitScript 在 documentElement 出现之前执行；必须等它存在再插 style，
    // 否则会抛 "Cannot read properties of null (reading 'appendChild')" 并中断
    // 后面的生命周期探针（GS-DESKTOP-04 取证时踩到过）。
    const injectReset = () => {
      const style = document.createElement('style');
      style.textContent =
        '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;'
        + 'transition-duration:1ms!important;transition-delay:0s!important;}';
      document.documentElement?.appendChild(style);
    };
    if (document.documentElement) injectReset();
    else document.addEventListener('readystatechange', () => {
      if (document.documentElement) injectReset();
    }, { once: true });
    const w = window;
    w.__gsLifecycle = { created: 0, destroyed: 0 };
    const observe = (rt) => {
      try {
        if (typeof rt?.destroy !== 'function') return;
        w.__gsLifecycle.created += 1;
        const orig = rt.destroy.bind(rt);
        rt.destroy = () => {
          w.__gsLifecycle.destroyed += 1;
          orig();
        };
      } catch {
        /* 观测失败不影响取证 */
      }
    };
    for (const key of ['__gsruntime', '__gsauthoringruntime']) {
      let value = null;
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
}

// ---------------------------------------------------------------- phase camera
async function phaseCamera() {
  const browser = await launch();
  const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
  await installLifecycleProbe(page);
  const result = { scene: AUTHORING_SCENE, steps: [], beforeAfter: {}, lifecycle: null, screenshots: [] };

  await page.goto(`/model/edit/${AUTHORING_SCENE}`, { waitUntil: 'domcontentloaded' });
  await waitIdle(page);
  await pump(page, 3000);
  await shot(page, 'camera-01-loaded-A.png');
  const A = await pose(page);
  result.steps.push({ step: 'loaded', pose: A });

  await drag(page, -240, -70);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(1000);
  const B = await pose(page);
  result.steps.push({ step: 'moved-to-B', pose: B });
  await shot(page, 'camera-02-at-B.png');

  // 保存 B 为初始视角（PCUI 主按钮）
  await page.getByRole('button', { name: '将当前视角设为初始视角' }).click();
  await page
    .waitForSelector('[data-testid="camera-sync-progress"]', { timeout: 180_000 })
    .catch(() => {});
  await page
    .waitForSelector('[data-testid="camera-sync-progress"]', { state: 'detached', timeout: 600_000 })
    .catch(() => {});
  await waitIdle(page);
  const afterSave = await pose(page);
  result.steps.push({ step: 'after-save-sync', pose: afterSave });
  await shot(page, 'camera-03-after-save-sync.png');

  // 关掉提示弹窗
  if (await page.locator('.ant-modal .ant-btn-primary').count()) {
    await page.locator('.ant-modal .ant-btn-primary').last().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(600);
  }

  // 移动到 C
  await drag(page, 280, 100);
  const C = await pose(page);
  result.steps.push({ step: 'moved-to-C', pose: C });
  await shot(page, 'camera-04-at-C.png');

  // 官方 Reset（Viewer Settings → Reset）
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 15_000 });
  await page.locator('.sse-reset').first().click();
  await pump(page, 4500);
  await page.waitForTimeout(1200);
  const afterReset = await pose(page);
  result.steps.push({ step: 'official-reset', pose: afterReset });
  await shot(page, 'camera-05-official-reset.png');
  await capture(page, 'camera-05-official-reset-render.webp');

  // 键盘 r
  await drag(page, -200, 60);
  await page.keyboard.press('r');
  await pump(page, 4500);
  await page.waitForTimeout(1200);
  const afterKey = await pose(page);
  result.steps.push({ step: 'keyboard-r-reset', pose: afterKey });
  await shot(page, 'camera-06-keyboard-r-reset.png');

  result.beforeAfter = {
    A,
    B,
    afterSave,
    C,
    afterReset,
    afterKey,
    deltaB_afterSave: dist(B?.position, afterSave?.position),
    deltaB_afterReset: dist(B?.position, afterReset?.position),
    deltaB_afterKey: dist(B?.position, afterKey?.position),
    deltaA_afterReset: dist(A?.position, afterReset?.position),
  };
  result.lifecycle = await page.evaluate(() => window.__gsLifecycle ?? null);
  result.lifecycleLive = {
    viewers: await page.locator('.sse-viewer').count(),
    canvases: await page.locator('.sse-viewer canvas').count(),
  };
  result.events = events;

  // 描述符（DB 侧）与运行时一致
  result.descriptor = await (await page.request.get(`/api/v1/scenes/${AUTHORING_SCENE}/runtime`)).json();
  writeJson('camera-sync.json', result);
  console.log('camera deltas:', {
    afterSave: result.beforeAfter.deltaB_afterSave,
    afterReset: result.beforeAfter.deltaB_afterReset,
    afterKey: result.beforeAfter.deltaB_afterKey,
    oldViewAfterReset: result.beforeAfter.deltaA_afterReset,
  });
  console.log('lifecycle:', result.lifecycle, result.lifecycleLive);
  await context.close();
  await browser.close();
}

// ------------------------------------------------------------------ phase walk
async function phaseWalk() {
  const browser = await launch();
  const out = { scenes: {}, checks: [] };
  for (const [key, scene, expectWalk] of [
    ['safe', SAFE, true],
    ['stale', STALE, false],
    ['uncalibrated', UNCAL, false],
  ]) {
    const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
    await installLifecycleProbe(page);
    await page.goto(`/scene/${scene}`, { waitUntil: 'domcontentloaded' });
    await waitLoaded(page, 240_000);
    await pump(page, 2500);
    await page.waitForTimeout(800);

    const before = await runtimeState(page);
    await shot(page, `walk-${key}-01-loaded.png`);
    await capture(page, `walk-${key}-01-loaded-render.webp`);

    // 官方 UI Walk 按钮是否可见
    const walkBtn = page.locator('.sse-fpsCamera').first();
    const walkBtnVisible = (await walkBtn.count())
      ? await walkBtn.isVisible().catch(() => false)
      : false;

    // 键盘 3
    const p = await canvasPoint(page);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('3');
    await pump(page, 1500);
    await page.waitForTimeout(600);
    const afterKey = await runtimeState(page);
    await shot(page, `walk-${key}-02-after-key-3.png`);

    // 官方 UI 按钮（force：即使被宿主安全提示隐藏也要证明官方自己是 no-op）
    let afterUi = null;
    if (await walkBtn.count()) {
      await walkBtn.click({ force: true, timeout: 10_000 }).catch(() => {});
      await pump(page, 1500);
      await page.waitForTimeout(500);
      afterUi = await runtimeState(page);
      await shot(page, `walk-${key}-03-after-ui-button.png`);
    }

    // 宿主 toggleWalk()
    await page.evaluate(() => (window.__gsruntime ?? window.__gsauthoringruntime)?.toggleWalk?.());
    await pump(page, 1500);
    await page.waitForTimeout(500);
    const afterHost = await runtimeState(page);
    await shot(page, `walk-${key}-04-after-host-toggle.png`);

    const entered = [afterKey, afterUi, afterHost].some((s) => s?.cameraMode === 'walk');
    out.scenes[key] = {
      scene,
      expectedWalkAllowed: expectWalk,
      before,
      walkBtnVisible,
      afterKey,
      afterUi,
      afterHost,
      enteredWalk: entered,
      events,
    };
    out.checks.push({
      scene: key,
      walkAllowed: before?.walkAllowed ?? null,
      hasCollision: before?.hasCollision ?? null,
      walkButtonVisible: walkBtnVisible,
      enteredWalk: entered,
      ok: expectWalk ? entered && before?.walkAllowed === true : !entered && before?.walkAllowed === false,
    });
    console.log(
      `${key}: walkAllowed=${before?.walkAllowed} hasCollision=${before?.hasCollision} `
      + `btnVisible=${walkBtnVisible} enteredWalk=${entered} ok=${out.checks.at(-1).ok}`,
    );
    await context.close();
  }
  writeJson('walk-gate.json', out);
  await browser.close();
}

ensureOut();
console.log(`evidence dir: ${OUT}`);
console.log(`display: ${DISPLAY} base: ${BASE}`);
if (phase === 'all' || phase === 'camera') await phaseCamera();
if (phase === 'all' || phase === 'walk') await phaseWalk();
console.log('done');
