/**
 * GS-DESKTOP-03 —— 电脑端真实浏览器验收（headful + 真实 GPU）。
 *
 * 用法（在 apps/web 下）：
 *   node e2e/gsdesktop03/run.mjs <phase>
 * phase: 1 camera | 2 ui | 3 save-reset | 4 walk | 5 pcui | 6 annotation | 7 visual
 */
import fs from 'fs';
import {
  BASE, DISPLAY, OUT, capture, diag, dist, launch, log, newPage, openViewer, pose, readJson, runtimeState, shot, waitLoaded, waitRuntime, writeJson,
} from './common.mjs';

const phase = process.argv[2] ?? '1';
const SCENE_A = 'fix02-semantics';       // 单文件 SOG，已存初始相机 + 3 标注 + 1 视角
const SCENE_B = 'gsdesktop01-versions';  // 当前版本为 streamed-sog（lod-meta，3 级 / 4 chunk）
const AUTHORING = `/model/edit/${SCENE_A}`;

const stamp = () => Date.now();

// ------------------------------------------------------------------ phase 1
async function phase1() {
  const browser = await launch();
  const out = { browser: { headless: false, display: DISPLAY, args: 'see common.mjs' }, scenes: {} };
  for (const [key, scene] of [['A', SCENE_A], ['B', SCENE_B]]) {
    const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
    const samples = [];
    const t0 = stamp();
    const chunkUrls = [];
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/assets/') && /\.(sog|json|webp)$/.test(u.split('?')[0])) chunkUrls.push(u.replace(BASE, ''));
    });
    await page.goto(`/scene/${scene}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="ov-diagnostics"]', { timeout: 60_000 });
    let phase1ShotDone = false;
    let posterSeen = false;
    let loadedAt = null;
    for (let i = 0; i < 1200; i++) {
      const d = await diag(page);
      const hasPoster = await page.locator('[data-testid="ov-poster"]').count() > 0
        && await page.locator('[data-testid="ov-poster"]').first().isVisible().catch(() => false);
      if (hasPoster) posterSeen = true;
      samples.push({
        t: stamp() - t0,
        progress: d.progress ?? null,
        loaded: d.loaded ?? false,
        gsplats: d.gsplats ?? null,
        poster: hasPoster,
        camera: d.camera ?? null,
        cameraMode: d.cameraMode ?? null,
        frameCalls: d.frameCalls ?? null,
      });
      if (!phase1ShotDone) {
        await shot(page, key === 'A' ? '01-loading-poster.png' : '01b-loading-poster-B.png');
        phase1ShotDone = true;
      }
      if (d.loaded && loadedAt === null) {
        loadedAt = stamp() - t0;
        await shot(page, key === 'A' ? '02-first-gaussian-frame.png' : '02b-first-gaussian-frame-B.png');
        await capture(page, key === 'A' ? '02-first-gaussian-render.webp' : '02b-first-gaussian-render-B.webp');
        break;
      }
      await page.waitForTimeout(120);
    }
    // 加载完成后取样：2s / 8s
    const atLoaded = await diag(page);
    await page.waitForTimeout(2000);
    const at2 = await diag(page);
    await shot(page, key === 'A' ? '03-loaded-stable-2s.png' : '03b-loaded-stable-2s-B.png');
    await page.waitForTimeout(6000);
    const at8 = await diag(page);
    await shot(page, key === 'A' ? '04-loaded-stable-8s.png' : '04b-loaded-stable-8s-B.png');
    await capture(page, key === 'A' ? '04-loaded-stable-8s-render.webp' : '04b-loaded-stable-8s-render-B.webp');
    out.scenes[key] = {
      sceneId: scene,
      format: at8.format,
      contentUrl: at8.contentUrl,
      posterSeen,
      loadedAtMs: loadedAt,
      atLoaded: { camera: atLoaded.camera, gsplats: atLoaded.gsplats, progress: atLoaded.progress },
      at2s: { camera: at2.camera, gsplats: at2.gsplats },
      at8s: { camera: at8.camera, gsplats: at8.gsplats, cameraMode: at8.cameraMode },
      drift8s: dist(atLoaded.camera?.position, at8.camera?.position),
      driftMode: atLoaded.camera?.target && at8.camera?.target
        ? dist(atLoaded.camera.target, at8.camera.target) : null,
      chunkRequests: [...new Set(chunkUrls)],
      consoleErrors: events.consoleErrors,
      pageErrors: events.pageErrors,
      failedRequests: events.failedRequests,
      samples: samples.filter((s, i) => i % 5 === 0 || s.loaded),
    };
    log(`scene ${key} (${scene}): loaded@${loadedAt}ms format=${at8.format} gsplats=${at8.gsplats} drift=${dist(atLoaded.camera?.position, at8.camera?.position).toFixed(6)} chunks=${new Set(chunkUrls).size}`);
    await context.close();
  }
  writeJson('camera-timeline.json', out);
  await browser.close();
}

// ------------------------------------------------------------------ phase 2
async function phase2() {
  const browser = await launch();
  const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
  const d0 = await openViewer(page, SCENE_A);
  await page.waitForTimeout(1500);
  const result = { sceneId: SCENE_A, initialCamera: d0.camera, steps: [] };
  const record = async (step, extra = {}) => {
    const d = await diag(page);
    result.steps.push({
      step,
      camera: d.camera,
      cameraMode: d.cameraMode,
      showAnnotations: d.showAnnotations,
      performanceMode: d.performanceMode,
      selectedAnnotation: d.selectedAnnotation ?? null,
      isFullscreen: d.isFullscreen ?? null,
      ...extra,
    });
    log(`[${step}] mode=${d.cameraMode} cam=${JSON.stringify(d.camera?.position)} ann=${d.showAnnotations} perf=${d.performanceMode}`);
    return d;
  };

  // 控件可见性 + 命中测试（官方控件中心点是否被宿主遮挡）
  const selectors = {
    controls: '.sse-controlsWrap', orbit: '.sse-orbitCamera', fly: '.sse-flyCamera',
    settings: '.sse-settings', info: '.sse-info', fullscreen: '.sse-enterFullscreen',
    annotationNav: '.sse-annotationNav', hotspot: '.sse-annotation-hotspots .sse-annotation-hotspot',
  };
  const visibility = {};
  for (const [k, sel] of Object.entries(selectors)) {
    const loc = page.locator(sel).first();
    visibility[k] = {
      count: await page.locator(sel).count(),
      visible: await loc.isVisible().catch(() => false),
      box: await loc.boundingBox().catch(() => null),
    };
  }
  result.visibility = visibility;

  const hitTest = async (sel) => {
    const box = await page.locator(sel).first().boundingBox();
    if (!box) return { sel, hit: null };
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return page.evaluate(([sx, sy, target]) => {
      const el = document.elementFromPoint(sx, sy);
      return { sel: target, point: [Math.round(sx), Math.round(sy)], hitTag: el?.tagName ?? null, hitClass: el?.className ?? null, inside: !!el?.closest(target) };
    }, [x, y, sel]);
  };
  result.hitTests = [];
  for (const sel of ['.sse-orbitCamera', '.sse-flyCamera', '.sse-settings', '.sse-info', '.sse-enterFullscreen', '.sse-annotationNav']) {
    result.hitTests.push(await hitTest(sel));
  }

  // 宿主重复控件必须不存在
  result.hostDuplicates = {};
  for (const id of ['ov-frame', 'ov-reset', 'ov-walk', 'ov-performance', 'ov-annotations', 'ov-fullscreen', 'ov-exit-fullscreen', 'ov-camera-mode']) {
    result.hostDuplicates[id] = await page.locator(`[data-testid="${id}"]`).count();
  }

  await shot(page, '05-viewer-official-ui.png');
  await record('initial');

  // Orbit → Fly → Orbit
  await page.locator('.sse-flyCamera').first().click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]').textContent).cameraMode === 'fly', { timeout: 10_000 });
  await record('click-fly');
  await page.locator('.sse-orbitCamera').first().click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]').textContent).cameraMode === 'orbit', { timeout: 10_000 });
  await record('click-orbit');

  // Settings 面板 + Frame / Reset / Annotations / Performance
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-frame', { state: 'visible', timeout: 5000 });
  const panelBox = await page.locator('.sse-settingsPanel').first().boundingBox();
  result.settingsPanel = { box: panelBox, visible: true };
  await shot(page, '06-viewer-settings.png');

  const beforeFrame = (await diag(page)).camera;
  await page.locator('.sse-frame').first().click();
  await page.waitForTimeout(3500);
  const afterFrame = (await diag(page)).camera;
  result.frame = { before: beforeFrame, after: afterFrame, moved: dist(beforeFrame.position, afterFrame.position) };
  await record('click-frame');

  await page.locator('.sse-annotationsRow').first().click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]').textContent).showAnnotations === false, { timeout: 10_000 });
  await record('annotations-off');
  await page.locator('.sse-annotationsRow').first().click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]').textContent).showAnnotations === true, { timeout: 10_000 });
  await record('annotations-on');

  const perfRow = page.locator('.sse-settingsPanel .sse-row, .sse-settingsPanel > *').filter({ hasText: /Performance|性能/i }).first();
  if (await perfRow.count()) {
    await perfRow.click().catch(() => {});
    await page.waitForTimeout(800);
    await record('performance-toggle');
  }

  await page.locator('.sse-reset').first().click();
  await page.waitForTimeout(4000);
  const afterReset = (await diag(page)).camera;
  result.reset = { initialProfile: result.initialCamera, afterReset, error: dist(result.initialCamera.position, afterReset.position) };

  // Info 面板
  await page.locator('.sse-info').first().click();
  await page.waitForTimeout(700);
  result.infoPanel = {
    visible: await page.locator('.sse-infoPanel').first().isVisible().catch(() => false),
    text: (await page.locator('.sse-infoPanel').first().innerText().catch(() => '')).slice(0, 400),
  };
  await shot(page, '07-viewer-info.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 全屏
  await page.locator('.sse-enterFullscreen').first().click();
  await page.waitForTimeout(1500);
  result.fullscreen = await page.evaluate(() => ({
    fullscreenElement: document.fullscreenElement?.className ?? null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  await shot(page, '08-viewer-fullscreen.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  result.fullscreenAfterExit = await page.evaluate(() => ({
    fullscreenElement: document.fullscreenElement?.className ?? null,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  }));

  // 标注导览
  await page.locator('.sse-annotationNext').first().click().catch(async () => {
    await page.locator('.sse-annotationNav').first().click();
  });
  await page.waitForTimeout(3500);
  const nav1 = await diag(page);
  result.annotationNav = { afterNext: { selected: nav1.selectedAnnotation, camera: nav1.camera } };
  await shot(page, '09-viewer-annotation-navigation.png');
  const nextBtn = page.locator('.sse-annotationNext');
  if (await nextBtn.count()) { await nextBtn.first().click(); await page.waitForTimeout(3000); }
  const nav2 = await diag(page);
  result.annotationNav.afterSecondNext = { selected: nav2.selectedAnnotation, camera: nav2.camera };
  const prevBtn = page.locator('.sse-annotationPrev');
  if (await prevBtn.count()) { await prevBtn.first().click(); await page.waitForTimeout(2500); }
  const nav3 = await diag(page);
  result.annotationNav.afterPrev = { selected: nav3.selectedAnnotation, camera: nav3.camera };

  // 画布拖拽未被官方 chrome 拦截（在画布中心拖动，相机应变化）
  const before = (await diag(page)).camera;
  const box = await page.locator('canvas').first().boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  }
  const after = (await diag(page)).camera;
  result.canvasDrag = { before, after, moved: dist(before.position, after.position) };

  result.consoleErrors = events.consoleErrors;
  result.pageErrors = events.pageErrors;
  result.failedRequests = events.failedRequests;
  writeJson('ui-interactions.json', result);
  await context.close();
  await browser.close();
}

// ------------------------------------------------------------------ dispatcher
const phases = { '1': phase1, '2': phase2, '3': phase3, '4': phase4, '5': phase5, '6': phase6, '7': phase7 };
const fn = phases[phase];
if (!fn) { console.error('unknown phase', phase); process.exit(1); }
await fn();
log(`phase ${phase} done`);

// ------------------------------------------------------------------ phase 3
async function phase3() {
  const browser = await launch();
  const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
  const out = { sceneId: SCENE_A, at: new Date().toISOString(), steps: [] };
  out.modals = [];
  const modalText = async () => {
    const loc = page.locator('.ant-modal').first();
    if (!(await page.locator('.ant-modal-wrap').count())) return null;
    return (await loc.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300) || null;
  };
  const noteModal = async (step) => {
    const text = await modalText();
    if (text) { out.modals.push({ step, text }); log(`[modal:${step}] ${text}`); }
    return text;
  };
  const dismissModal = async () => {
    if (!(await page.locator('.ant-modal-wrap').count())) return;
    const ok = page.locator('.ant-modal .ant-btn-primary, .ant-modal .ant-btn').last();
    await ok.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  };
  const snap = async (label, extra = {}) => {
    const camera = await pose(page);
    const st = await runtimeState(page);
    const d = { camera, cameraMode: st?.cameraMode, gsplats: null };
    out.steps.push({ label, t: stamp(), camera, cameraMode: st?.cameraMode, ...extra });
    log(`[${label}] cam=${JSON.stringify(camera?.position)} fov=${camera?.fov}`);
    return d;
  };
  const api = async (p) => {
    const r = await page.request.get(p);
    return r.ok() ? r.json() : { status: r.status() };
  };
  const presentationOf = async () => {
    const p = await api(`/api/v1/scenes/${SCENE_A}/presentation`);
    return p.initialCamera ? p.initialCamera : p;
  };
  const runtimeCam = async () => {
    const r = await api(`/api/v1/scenes/${SCENE_A}/runtime`);
    return r.presentation?.initialCamera ?? null;
  };

  await page.goto(AUTHORING, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__gsauthoringruntime, { timeout: 90_000 });
  await waitRuntime(page);
  // 官方 resetCamera 是过渡动画：等它真正落位再记录 A，否则会读到过渡中间值。
  await page.waitForTimeout(6000);
  const A = (await snap('A-authored-settled')).camera;
  out.A = A;
  out.dbBefore = await presentationOf();
  out.runtimeBefore = await runtimeCam();
  await shot(page, '10-camera-before-edit.png');

  // 鼠标拖动取景到 B（真实鼠标操作，不用 API 改相机）
  // 每次拖动都重新取 canvas 包围盒：右侧属性面板滚动会让页面位移，
  // 用旧坐标会拖到面板上（首轮实测：C 与 B 完全相同 = 拖拽根本没落在画布）。
  const canvas = page.locator('canvas').first();
  const drag = async (dx, dy) => {
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName ?? null, cls: String(el?.className ?? '').slice(0, 60) };
    }, [cx, cy]);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(1400);
    out.steps.push({ label: 'drag', dx, dy, canvasBox: box, hit });
    return hit;
  };
  await drag(-220, -60);
  await page.mouse.wheel(0, -320);   // 拉近
  await page.waitForTimeout(1200);
  const B = (await snap('B-after-drag')).camera;
  out.B = B;
  out.driftAtoB = dist(A.position, B.position);
  await shot(page, '11-camera-position-b.png');

  // 保存为初始视角（PCUI 按钮，按文本定位）
  const saveBtn = page.getByRole('button', { name: '将当前视角设为初始视角' });
  await saveBtn.scrollIntoViewIfNeeded();
  await saveBtn.click();
  await page.waitForTimeout(2500);
  await noteModal('save-initial-view');
  out.dbAfterSave = await presentationOf();
  out.runtimeAfterSave = await runtimeCam();
  out.steps.push({ label: 'after-save', db: out.dbAfterSave, runtime: out.runtimeAfterSave });
  log('db after save', JSON.stringify(out.dbAfterSave), 'runtime', JSON.stringify(out.runtimeAfterSave));
  await shot(page, '12-camera-saved-b.png');
  await dismissModal();

  // 不刷新：再移动到 C
  await drag(260, 90);
  await page.waitForTimeout(1200);
  const C = (await snap('C-before-reset')).camera;
  out.C = C;
  out.driftBtoC = dist(B.position, C.position);

  // 创作页「定位到已保存视角」（Reset 语义）
  const resetBtn = page.getByRole('button', { name: '定位到已保存视角' });
  await resetBtn.scrollIntoViewIfNeeded();
  await resetBtn.click();
  await page.waitForTimeout(4000);
  await noteModal('reset-to-saved');
  await dismissModal();
  const resetSameSession = (await snap('reset-without-reload')).camera;
  out.resetWithoutReload = resetSameSession;
  out.errorToBWithoutReload = dist(resetSameSession.position, B.position);
  out.errorToAWithoutReload = dist(resetSameSession.position, A.position);
  await shot(page, '13-camera-reset-without-reload.png');

  // 官方 Viewer 的 Reset（同一会话，官方设置面板）
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 5000 });
  await page.locator('.sse-reset').first().click();
  await page.waitForTimeout(4000);
  await noteModal('official-reset');
  await dismissModal();
  const officialResetSameSession = (await snap('official-reset-without-reload')).camera;
  out.officialResetWithoutReload = officialResetSameSession;
  out.officialErrorToB = dist(officialResetSameSession.position, B.position);
  out.officialErrorToA = dist(officialResetSameSession.position, A.position);

  // 刷新后：/scene/:id + Reset
  await page.goto(`/scene/${SCENE_A}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="scene-viewer-page"]', { timeout: 60_000 });
  const afterReloadLoad = await waitLoaded(page);
  await page.waitForTimeout(2500);
  out.afterReloadLoad = afterReloadLoad.camera;
  await page.locator('.sse-settings').first().click();
  await page.waitForSelector('.sse-reset', { state: 'visible', timeout: 5000 });
  await page.locator('.sse-reset').first().click();
  await page.waitForTimeout(4500);
  await noteModal('reset-after-reload');
  await dismissModal();
  const resetAfterReload = (await diag(page)).camera;
  out.resetAfterReload = resetAfterReload;
  out.errorToBAfterReload = dist(resetAfterReload.position, B.position);
  out.errorToAAfterReload = dist(resetAfterReload.position, A.position);
  out.steps.push({ label: 'reset-after-reload', camera: resetAfterReload });
  log(`after reload reset: ${JSON.stringify(resetAfterReload.position)} errToB=${out.errorToBAfterReload.toFixed(3)} errToA=${out.errorToAAfterReload.toFixed(3)}`);
  await shot(page, '14-camera-reset-after-reload.png');

  out.consoleErrors = events.consoleErrors;
  out.pageErrors = events.pageErrors;
  out.failedRequests = events.failedRequests;
  writeJson('camera-save-reset.json', out);
  await context.close();
  await browser.close();
}

// ------------------------------------------------------------------ phase 4
async function phase4() {
  const browser = await launch();
  const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
  const d0 = await openViewer(page, SCENE_A);
  await page.waitForTimeout(2000);
  const out = { sceneId: SCENE_A, preconditions: null, steps: [], keyboard: [] };

  const state = async () => page.evaluate(() => {
    const rt = window.__gsruntime;
    return {
      cameraMode: rt.state.cameraMode,
      walkAllowed: rt.state.walkAllowed,
      hasCollision: rt.state.hasCollision,
      collisionStale: rt.state.collisionStale,
      inputEnabled: rt.state.inputEnabled,
      gamingControls: rt.state.gamingControls,
    };
  });
  const walkBtn = page.locator('.sse-fpsCamera').first();
  const gate = async () => page.evaluate(() => {
    const host = document.querySelector('.gs-supersplat-host');
    const btn = document.querySelector('.sse-fpsCamera');
    return {
      hostHasGateClass: host?.classList.contains('gs-walk-blocked') ?? null,
      hostClass: host?.className ?? null,
      walkButtonDisplay: btn ? getComputedStyle(btn).display : null,
      walkButtonClass: btn?.className ?? null,
      walkShortcutInInfo: document.querySelector('.sse-infoPanel')?.textContent?.includes('行走') ?? null,
    };
  });

  // 官方 policy：碰撞资产存在但校准未 VERIFIED → collision.enabled=false
  const runtime = await (await page.request.get(`/api/v1/scenes/${SCENE_A}/runtime`)).json();
  const processing = await (await page.request.get(`/api/v1/scenes/${SCENE_A}/processing`)).json().catch(() => null);
  out.preconditions = {
    collision: runtime.collision ?? null,
    calibration: processing?.calibration ?? null,
    diagnostics: {
      walkAllowed: d0.walkAllowed, hasCollision: d0.hasCollision,
      collisionStale: d0.collisionStale, sceneScale: d0.sceneScale,
    },
  };

  out.steps.push({ step: 'initial', state: await state(), gate: await gate() });
  await shot(page, '15-walk-blocked-ui.png');

  // 让画布获得键盘焦点，再按官方快捷键
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);

  const press = async (key, label) => {
    const before = await state();
    await page.keyboard.press(key);
    await page.waitForTimeout(1200);
    const after = await state();
    out.keyboard.push({ label, key, before, after });
    log(`[key ${key}] ${before.cameraMode} → ${after.cameraMode} (walkAllowed=${after.walkAllowed})`);
    return after;
  };

  // 控制组：官方键盘确实生效（2 = fly）——证明按键没有被宿主吞掉
  await press('2', 'official-shortcut-fly (control)');
  await press('1', 'official-shortcut-orbit (control)');
  // Walk 相关入口
  await press('3', 'walk-shortcut');
  await press('w', 'wasd-w');
  await press('a', 'wasd-a');
  // 平台自己的 toggleWalk API（有 host 守卫）
  const apiWalk = await page.evaluate(() => {
    const rt = window.__gsruntime;
    const before = rt.state.cameraMode;
    rt.toggleWalk();
    return { before, after: rt.state.cameraMode, walkAllowed: rt.state.walkAllowed };
  });
  out.hostApiToggleWalk = apiWalk;
  log('[host toggleWalk]', JSON.stringify(apiWalk));
  await page.waitForTimeout(1200);
  await shot(page, '16-walk-keyboard-test.png');

  out.finalState = await state();
  out.finalGate = await gate();
  out.officialGateSource = {
    note: '官方 isWalkAllowed(bbox, collision) = 有碰撞 且 水平范围 >= 5 单位；键盘 3 / WASD 与官方 toggleWalk() 都只查 state.walkAllowed',
    hostGate: '宿主仅给挂载容器加 gs-walk-blocked class，用 CSS display:none 隐藏 .sse-fpsCamera，不拦键盘',
  };
  out.consoleErrors = events.consoleErrors;
  out.pageErrors = events.pageErrors;
  writeJson('walk-safety.json', out);
  await context.close();
  await browser.close();
}

// ------------------------------------------------------------------ phase 5
async function phase5() {
  const browser = await launch();
  const out = { viewports: [] };
  for (const [w, h] of [[1920, 1080], [1280, 720]]) {
    const { context, page, events } = await newPage(browser, { width: w, height: h });
    await page.goto(AUTHORING, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__gsauthoringruntime, { timeout: 90_000 });
    await waitRuntime(page);
    await page.waitForTimeout(4000);
    const tag = `${w}x${h}`;
    const metrics = await page.evaluate(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      const text = (el) => (el.textContent ?? '').trim();
      const panels = q('.pcui-panel');
      const panelTitles = q('.pcui-panel-header-title').map(text);
      const inputs = q('input');
      const buttons = q('button');
      const disabledButtons = buttons.filter((b) => b.classList.contains('pcui-disabled'));
      const duplicateTitles = panelTitles.filter((t, i) => panelTitles.indexOf(t) !== i);
      const overflow = q('.gs-workspace__item, .pcui-button, .pcui-label').filter((el) => el.scrollWidth > el.clientWidth + 1);
      const viewer = document.querySelector('[data-testid="ov-canvas-host"]');
      const controls = document.querySelector('.sse-controlsWrap');
      const rightPanel = document.querySelector('.gs-workspace__right');
      const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
      const intersects = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return {
        viewport: [window.innerWidth, window.innerHeight],
        docScrollWidth: document.documentElement.scrollWidth,
        horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        horizontalScrollCount: q('.gs-workspace, .gs-workspace__body').filter((el) => el.scrollWidth > el.clientWidth + 1).length,
        panels: panels.length,
        panelTitles,
        duplicateTitles,
        inputs: inputs.length,
        buttons: buttons.length,
        disabledButtons: disabledButtons.length,
        overflowCount: overflow.length,
        overflowSamples: overflow.slice(0, 8).map((el) => ({ tag: el.tagName, text: text(el).slice(0, 30), cls: String(el.className).slice(0, 40) })),
        viewerRect: rect(viewer),
        controlsRect: rect(controls),
        rightPanelRect: rect(rightPanel),
        viewerOverlapsOfficialControls: intersects(rect(viewer), rect(controls)) && false,
        rightPanelCoversControls: intersects(rect(rightPanel), rect(controls)),
        inputDuplicateCount: inputs.length - new Set(inputs.map((i) => i.id || i.name || i.placeholder)).size,
        labels: q('.pcui-label').map(text).slice(0, 40),
        statusText: text(document.querySelector('.gs-workspace__status') ?? document.createElement('span')),
      };
    });
    await shot(page, `17-authoring-${tag}.png`);
    if (w === 1920) await shot(page, '17-authoring-1920x1080.png');
    if (w === 1280) await shot(page, '18-authoring-1280x720.png');

    // 三块属性面板
    await page.getByRole('button', { name: '初始相机', exact: true }).click();
    await page.waitForTimeout(600);
    await shot(page, w === 1920 ? '19-authoring-camera-properties.png' : `19b-camera-${tag}.png`);
    await page.getByRole('button', { name: '标注A', exact: false }).first().click();
    await page.waitForTimeout(600);
    await shot(page, w === 1920 ? '20-authoring-annotation-properties.png' : `20b-annotation-${tag}.png`);
    await page.getByRole('button', { name: '正门视角', exact: false }).first().click();
    await page.waitForTimeout(600);
    await shot(page, w === 1920 ? '21-authoring-viewpoint-properties.png' : `21b-viewpoint-${tag}.png`);

    out.viewports.push({ tag, metrics, consoleErrors: events.consoleErrors, pageErrors: events.pageErrors });
    await context.close();
  }
  writeJson('pcui-visual.json', out);
  await browser.close();
}

// ------------------------------------------------------------------ phase 6
async function phase6() {
  const browser = await launch();
  const { context, page, events } = await newPage(browser, { width: 1600, height: 1000 });
  const out = { sceneId: SCENE_A, at: new Date().toISOString(), steps: [] };
  const log = (s) => { out.steps.push(s); console.log(JSON.stringify(s)); };

  await page.goto(AUTHORING, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__gsauthoringruntime, { timeout: 90_000 });
  await waitRuntime(page);
  await page.waitForTimeout(2500);

  const annotationsBefore = await (await page.request.get(`/api/v1/scenes/${SCENE_A}/annotations`)).json();
  out.annotationsBefore = annotationsBefore.map((a) => ({ id: a.id, title: a.title, enabled: a.enabled }));

  // 进入拾取模式
  await page.getByRole('button', { name: '＋ 添加标注' }).click();
  await page.waitForTimeout(500);
  await shot(page, '22-annotation-pick-mode.png');

  // 点击真实 Gaussian 画布
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2 + 60;
  const cy = box.y + box.height / 2 - 40;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(3500);

  // 记录 antd 反馈（成功/失败）
  const modal = await page.locator('.ant-modal').first().innerText().catch(() => null);
  out.createModal = modal ? modal.replace(/\s+/g, ' ').slice(0, 200) : null;
  if (modal) await page.locator('.ant-modal .ant-btn').last().click().catch(() => {});
  await page.waitForTimeout(500);

  const annotationsAfterCreate = await (await page.request.get(`/api/v1/scenes/${SCENE_A}/annotations`)).json();
  out.annotationsAfterCreate = annotationsAfterCreate.map((a) => ({ id: a.id, title: a.title, enabled: a.enabled, anchor: a.anchor, cameraPosition: a.cameraPosition }));
  log({ step: 'created', count: annotationsAfterCreate.length, modal: out.createModal });

  // 选中新建标注，编辑标题与正文后保存
  const created = annotationsAfterCreate[annotationsAfterCreate.length - 1];
  out.createdId = created?.id ?? null;
  if (created) {
    await page.getByRole('button', { name: /标注|未命名/ }).last().click().catch(async () => {});
    await page.waitForTimeout(800);
    // 右侧标题输入框
    const titleInput = page.locator('.gs-props input, .pcui-textinput input').first();
    await titleInput.click({ timeout: 10000 }).catch(() => {});
    await page.keyboard.press('Control+A');
    await page.keyboard.type('GS-DESKTOP-03 测试标注');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '保存修改' }).click().catch(() => {});
    await page.waitForTimeout(2500);
    const afterEdit = await (await page.request.get(`/api/v1/scenes/${SCENE_A}/annotations`)).json();
    const edited = afterEdit.find((a) => a.id === created.id);
    out.afterEdit = { id: edited?.id, title: edited?.title, description: edited?.description };
    log({ step: 'renamed', title: edited?.title });
    await shot(page, '23-annotation-created.png');
  }

  // 浏览页：官方 hotspot + 内容 + 导览
  await page.goto(`/scene/${SCENE_A}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="scene-viewer-page"]', { timeout: 60_000 });
  await waitLoaded(page);
  await page.waitForTimeout(2500);
  const viewerState = await page.evaluate(() => {
    const rt = window.__gsruntime;
    const hotspots = Array.from(document.querySelectorAll('.sse-annotation-hotspots .sse-annotation-hotspot'));
    return {
      hotspotCount: hotspots.length,
      hotspotTexts: hotspots.map((h) => (h.textContent ?? '').trim()).slice(0, 6),
      showAnnotations: rt.state.showAnnotations,
      annotations: rt.annotations.map((a) => a.title),
    };
  });
  out.viewerHotspots = viewerState;
  log({ step: 'viewer-hotspots', ...viewerState });
  await shot(page, '24-annotation-hotspot.png');

  // 点击第一个 hotspot → 官方 tooltip / overlay
  const hotspot = page.locator('.sse-annotation-hotspots .sse-annotation-hotspot').first();
  if (await hotspot.count()) {
    await hotspot.click();
    await page.waitForTimeout(1800);
    out.hotspotClick = await page.evaluate(() => ({
      tooltip: document.querySelector('.sse-annotation')?.textContent?.slice(0, 120) ?? null,
      overlay: document.querySelector('.gs-annotation-overlay, [class*="overlay"]')?.textContent?.slice(0, 120) ?? null,
      selected: window.__gsruntime?.selectedAnnotation ?? null,
      selectedTitle: window.__gsruntime?.selectedGsplatformAnnotation?.title ?? null,
    }));
    log({ step: 'hotspot-click', ...out.hotspotClick });
    await shot(page, '25-annotation-navigation.png');
  }

  // 官方导览 Next / Prev
  const nav = await page.evaluate(async () => {
    const rt = window.__gsruntime;
    const res = [];
    for (let i = 0; i < rt.annotations.length; i += 1) {
      rt.selectAnnotation(i);
      await new Promise((r) => setTimeout(r, 1200));
      res.push({ i, selected: rt.selectedAnnotation, title: rt.annotations[i]?.title });
    }
    return res;
  });
  out.officialNavigation = nav;
  log({ step: 'official-navigation', nav });

  // 隐藏标注（数据库 enabled=false）→ hotspot 数量跟随
  if (out.createdId) {
    const patch = await page.request.patch(`/api/v1/scenes/${SCENE_A}/annotations/${out.createdId}`, { data: { enabled: false } });
    out.hideStatus = patch.status();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitLoaded(page);
    await page.waitForTimeout(2000);
    out.afterHide = await page.evaluate(() => ({
      hotspotCount: document.querySelectorAll('.sse-annotation-hotspots .sse-annotation-hotspot').length,
      showAnnotations: window.__gsruntime.state.showAnnotations,
    }));
    log({ step: 'hidden', ...out.afterHide });
  }

  // 删除测试标注（恢复夹具到 3 条）
  if (out.createdId) {
    const del = await page.request.delete(`/api/v1/scenes/${SCENE_A}/annotations/${out.createdId}`);
    out.deleteStatus = del.status();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitLoaded(page);
    await page.waitForTimeout(2000);
    out.afterDelete = await page.evaluate(() => ({
      hotspotCount: document.querySelectorAll('.sse-annotation-hotspots .sse-annotation-hotspot').length,
    }));
    const final = await (await page.request.get(`/api/v1/scenes/${SCENE_A}/annotations`)).json();
    out.annotationsFinal = final.map((a) => ({ id: a.id, title: a.title }));
    log({ step: 'deleted', ...out.afterDelete, finalCount: final.length });
  }

  out.consoleErrors = events.consoleErrors;
  out.pageErrors = events.pageErrors;
  writeJson('annotation-flow.json', out);
  await context.close();
  await browser.close();
}

// ------------------------------------------------------------------ phase 7
async function phase7() {
  // 历史 13M 场景（Building-Reupload-Control, u-c71ec45417a0）只读展示：
  // 该内容由另一个只读 API 实例（18098，连历史库 + storage）提供，
  // 前端用隔离 vite（5188）代理。全程只读：不写 DB、不改相机/版本/标注。
  const HISTORICAL_BASE = process.env.GSD03_HIST_BASE ?? 'http://localhost:5188';
  const HISTORICAL = process.env.GSD03_HIST_SCENE ?? 'u-c71ec45417a0';
  const browser = await launch();
  const { context, page, events } = await newPage(browser, { width: 1600, height: 1000, base: HISTORICAL_BASE });
  const out = { sceneId: HISTORICAL, base: HISTORICAL_BASE, steps: [], lod: [] };
  const chunks = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/assets/versions/') && /\/(meta\.json|means_l\.webp|scales|quats)/.test(u)) chunks.push(u.split('/').slice(-2).join('/'));
  });

  const t0 = stamp();
  await page.goto(`/scene/${HISTORICAL}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    try { return el && JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
  }, { timeout: 300_000 });
  const loadMs = stamp() - t0;
  // LOD 渐进：加载后 10 秒内的 splat 数（距离 LOD 会继续流入）
  for (let i = 0; i < 10; i += 1) {
    const d = await diag(page);
    out.lod.push({ t: stamp() - t0, gsplats: d.gsplats, progress: d.progress });
    await page.waitForTimeout(1000);
  }
  const d0 = await diag(page);
  out.load = { loadMs, gsplats: d0.gsplats, format: d0.format, renderer: d0.renderer, camera: d0.camera, bounds: d0.worldTransform?.boundsAfter };
  log('13M load', JSON.stringify(out.load));

  const statsOf = async (dataUrl) => page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let sum = 0, sum2 = 0, dark = 0, colored = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum; sum2 += lum * lum;
      if (lum < 8) dark += 1;
      if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 12) colored += 1;
    }
    const mean = sum / n;
    return { width: c.width, height: c.height, meanLum: +mean.toFixed(2), stdLum: +Math.sqrt(sum2 / n - mean * mean).toFixed(2), darkRatio: +(dark / n).toFixed(4), coloredRatio: +(colored / n).toFixed(4) };
  }, dataUrl);

  const captureWithStats = async (name, extra = {}) => {
    const result = await page.evaluate(() => window.__gsruntime.captureScreenshot({
      width: 1600, height: 1000, supersample: 1, format: 'image/webp', quality: 0.85,
    }));
    if (!result?.dataUrl) { out.steps.push({ name, error: 'capture-null', ...extra }); return; }
    const stats = await statsOf(result.dataUrl);
    // 证据统一 WebP q85（见 common.mjs 的说明）；文件编号不变。
    const file = name.replace(/\.png$/, '.webp');
    fs.writeFileSync(`${OUT}/${file}`, Buffer.from(result.dataUrl.split(',')[1], 'base64'));
    const d = await diag(page);
    out.steps.push({ name, camera: d.camera, gsplats: d.gsplats, stats, ...extra });
    log(`[capture ${name}] gsplats=${d.gsplats}`, JSON.stringify(stats));
  };

  await page.waitForTimeout(2000);
  await captureWithStats('26-gaussian-initial.png', { label: 'initial (authored camera)' });
  await shot(page, '26-gaussian-initial-page.png');

  // 靠近主体：沿视线前进 65%
  const cam0 = (await diag(page)).camera;
  const near = cam0.position.map((v, i) => v + (cam0.target[i] - v) * 0.65);
  await page.evaluate((pose) => {
    window.__gsruntime.setCameraPose({ position: pose.position, target: pose.target, fov: pose.fov });
  }, { position: near, target: cam0.target, fov: cam0.fov });
  await page.waitForTimeout(6000);
  await captureWithStats('27-gaussian-close.png', { label: 'close (65% toward target)' });

  // 侧面：绕 target 旋转 60°
  const [px, py, pz] = cam0.position;
  const [tx, ty, tz] = cam0.target;
  const ang = Math.PI / 3;
  const dx = px - tx, dz = pz - tz;
  const side = [tx + dx * Math.cos(ang) - dz * Math.sin(ang), py, tz + dx * Math.sin(ang) + dz * Math.cos(ang)];
  await page.evaluate((pose) => {
    window.__gsruntime.setCameraPose({ position: pose.position, target: pose.target, fov: pose.fov });
  }, { position: side, target: cam0.target, fov: cam0.fov });
  await page.waitForTimeout(6000);
  await captureWithStats('28-gaussian-side.png', { label: 'side (orbit 60°)' });

  // 最远处：后退 2.5 倍
  const far = cam0.position.map((v, i) => v + (v - cam0.target[i]) * 1.6);
  await page.evaluate((pose) => {
    window.__gsruntime.setCameraPose({ position: pose.position, target: pose.target, fov: pose.fov });
  }, { position: far, target: cam0.target, fov: cam0.fov });
  await page.waitForTimeout(5000);
  await captureWithStats('28b-gaussian-far.png', { label: 'far (2.6x distance)' });

  // 官方 Frame（用户主动点击）→ 全景
  const openSettings = async (target) => {
    if (!(await page.locator(target).first().isVisible().catch(() => false))) {
      await page.locator('.sse-settings').first().click();
    }
    await page.waitForSelector(target, { state: 'visible', timeout: 8000 });
  };
  await openSettings('.sse-frame');
  await page.locator('.sse-frame').first().click();
  await page.waitForTimeout(7000);
  await captureWithStats('29-gaussian-frame.png', { label: 'official Frame' });
  await shot(page, '30-gaussian-frame-page.png');

  // 官方 Reset → authored 相机
  await openSettings('.sse-reset');
  await page.locator('.sse-reset').first().click();
  await page.waitForTimeout(7000);
  await captureWithStats('30-gaussian-reset.png', { label: 'official Reset' });
  const dEnd = await diag(page);
  out.reset = { camera: dEnd.camera, initial: cam0, sameAsInitial: dist(dEnd.camera.position, cam0.position) < 0.5 };

  out.chunkRequests = [...new Set(chunks)];
  out.chunkRequestCount = chunks.length;
  out.consoleErrors = events.consoleErrors;
  out.pageErrors = events.pageErrors;
  out.failedRequests = events.failedRequests;
  writeJson('visual-quality.json', out);
  await context.close();
  await browser.close();
}
