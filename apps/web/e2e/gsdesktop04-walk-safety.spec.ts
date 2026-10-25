/**
 * GS-DESKTOP-04 §六 —— Walk 平台安全闸门（真实浏览器，隔离 fixture）。
 *
 * ## 官方 1.35.0 事实依据（dist/viewer.js 实测）
 *
 *     const WALK_MIN_HORIZONTAL_RANGE = 5;
 *     const isWalkAllowed = (bbox, collision) =>
 *         !!collision && x * 2 >= 5 && z * 2 >= 5;
 *
 *     case 'toggleWalk': if (walkAllowed) { state.cameraMode = 'walk' }
 *
 * WASD：`requestFirstPerson` → `state.cameraMode = walkAllowed ? 'walk' : 'fly'`。
 *
 * 即**官方所有 walk 入口都只查 `walkAllowed`，而这个值只取决于「有没有碰撞数据 +
 * 场景够不够大」**。宿主无法改写官方只读 state；隐藏按钮会被键盘 `3` / WASD
 * 绕开（GS-NEXT-07 实测）。
 *
 * ## 本文件验收的契约
 *
 * 夹具（scripts/gsdesktop04_seed_walk_fixture.py）用**真实 splat-transform
 * 生成的碰撞资产** + 同一份真实场景内容（水平足迹 7.61 × 6.89 ≥ 官方 5）：
 *
 *   - ``gsdesktop04-walk-safe``        校准 VERIFIED / 恒等变换 / 未 STALE
 *                                     → 官方自己也会说 walkAllowed=true，
 *                                       平台必须允许 walk；
 *   - ``gsdesktop04-walk-stale``      碰撞在构建后世界变换改变（STALE）
 *                                     → 官方仍会允许，平台必须**拒绝**；
 *   - ``gsdesktop04-walk-uncalibrated`` 物理尺度从未校准（UNVERIFIED）
 *                                     → 官方仍会允许，平台必须**拒绝**。
 *
 * 拒绝的证据不是「按钮看不见」，而是**官方 `state.walkAllowed === false`**
 * —— 平台不把碰撞资源交给官方 viewer（collisionUrl 不注入），于是键盘 `3`、
 * WASD、官方按钮、宿主 `toggleWalk()` 全部变成官方自己的 no-op。
 *
 * 另外锁定：合法场景的 walk 仍然可用（不能为了安全把功能砍掉）。
 */
import { expect, test, type Page } from './fresh-browser';

test.describe.configure({ timeout: 480_000 });

const SAFE = 'gsdesktop04-walk-safe';
const STALE = 'gsdesktop04-walk-stale';
const UNCAL = 'gsdesktop04-walk-uncalibrated';

/** 平台把碰撞交给官方所需的描述符条件（后端 runtime 合同的平台侧复述）。 */
async function readRuntime(page: Page, scene: string) {
  const res = await page.request.get(`/api/v1/scenes/${scene}/runtime`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** 真实浏览器里读官方只读 state + 宿主判定（不写任何官方字段）。 */
async function readViewerState(page: Page) {
  return page.evaluate(() => {
    const rt = (
      window as unknown as {
        __gsruntime?: {
          state?: {
            loaded?: boolean;
            hasCollision?: boolean;
            walkAllowed?: boolean;
            cameraMode?: string;
          };
          getCameraPose?: () => { position: number[]; target: number[]; fov: number } | null;
          getSceneBounds?: () => { min: number[]; max: number[]; size: number[] } | null;
        };
      }
    ).__gsruntime;
    if (!rt?.state) return null;
    const bounds = rt.getSceneBounds ? rt.getSceneBounds() : null;
    return {
      loaded: !!rt.state.loaded,
      hasCollision: !!rt.state.hasCollision,
      walkAllowed: !!rt.state.walkAllowed,
      cameraMode: rt.state.cameraMode ?? null,
      bounds: bounds
        ? { size: bounds.size.map((n) => +n.toFixed(4)), min: bounds.min, max: bounds.max }
        : null,
      pose: rt.getCameraPose ? rt.getCameraPose() : null,
    };
  });
}

/** 让官方 app 继续 tick（官方过渡动画需要真实帧）。 */
async function pumpFrames(page: Page, ms: number): Promise<void> {
  const total = Math.max(1, Math.ceil(ms / 16.7));
  let done = 0;
  while (done < total) {
    const chunk = Math.min(60, total - done);
    await page.evaluate((count) => {
      const rt = (window as unknown as { __gsruntime?: { app?: { tick?: (t: number) => void } } })
        .__gsruntime;
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

async function openScene(page: Page, scene: string): Promise<void> {
  await page.goto(`/scene/${scene}`);
  await page.waitForFunction(() => !!window.__gsruntime, undefined, { timeout: 180_000 });
  await page.waitForFunction(
    () => (window as unknown as { __gsruntime?: { state?: { loaded?: boolean } } }).__gsruntime
      ?.state?.loaded === true,
    undefined,
    { timeout: 180_000 },
  );
  await pumpFrames(page, 2500);
}

/** 找一个能真正命中画布的点（官方 controlsHint 面板会挡住默认中心）。 */
async function canvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('canvas not found');
  const n = 8;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < n; i += 1) {
    for (let j = 1; j < n; j += 1) {
      points.push({ x: box.x + box.width * (i / n), y: box.y + box.height * (j / n) });
    }
  }
  const hits = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS'),
    points,
  );
  const free = points.filter((_, i) => hits[i]);
  if (!free.length) throw new Error('no unobstructed canvas point');
  return free[0];
}

/**
 * 尝试进入 walk —— 逐条走**所有官方入口**，任何一条成功即算违规。
 *
 *  1) 官方 UI Walk 按钮（`.sse-fpsCamera`）；
 *  2) 官方键盘快捷键 `3`（ModeShortcuts → inputEvent 'toggleWalk'）；
 *  3) WASD 移动输入（requestFirstPerson → walk/fly）；
 *  4) 宿主 `toggleWalk()`（经 SuperSplatRuntime 适配层）。
 *
 * 返回实际生效的入口（null = 一条都没进 walk）。
 */
async function tryEnterWalk(
  page: Page,
): Promise<{ via: 'ui' | 'keyboard' | 'wasd' | 'host'; mode: string } | null> {
  // 1) 官方 UI 按钮（官方自己构建/绑定事件，宿主只读）
  const walkBtn = page.locator('.sse-fpsCamera').first();
  if (await walkBtn.count()) {
    await walkBtn.click({ timeout: 10_000 }).catch(() => {});
    await pumpFrames(page, 1200);
    const mode = (await readViewerState(page))?.cameraMode;
    if (mode === 'walk') return { via: 'ui', mode };
  }

  // 2) 官方键盘快捷键 3（不需要焦点在特定元素，但先点画布最接近真实用户）
  const point = await canvasPoint(page);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('3');
  await pumpFrames(page, 1200);
  let mode = (await readViewerState(page))?.cameraMode;
  if (mode === 'walk') return { via: 'keyboard', mode };

  // 3) WASD：官方 first-person 移动输入
  await page.keyboard.down('KeyW');
  await pumpFrames(page, 900);
  await page.keyboard.up('KeyW');
  await pumpFrames(page, 600);
  mode = (await readViewerState(page))?.cameraMode;
  if (mode === 'walk') return { via: 'wasd', mode };

  // 4) 宿主 toggleWalk()（走 SuperSplatRuntime 公开 API）
  await page.evaluate(() => {
    const rt = (window as unknown as { __gsruntime?: { toggleWalk?: () => void } }).__gsruntime;
    rt?.toggleWalk?.();
  });
  await pumpFrames(page, 1200);
  mode = (await readViewerState(page))?.cameraMode;
  if (mode === 'walk') return { via: 'host', mode };

  return null;
}

test.describe('GS-DESKTOP-04 §六：Walk 平台安全闸门', () => {
  test('夹具自检：真实碰撞资产可用，官方原始逻辑本可判定 walkAllowed=true', async ({
    page,
  }) => {
    for (const scene of [SAFE, STALE, UNCAL]) {
      const runtime = await readRuntime(page, scene);
      expect(runtime.collision, `${scene} 必须有真实碰撞资产`).toBeTruthy();
      expect(runtime.collision.url, `${scene} 碰撞 URL 必须可服务`).toContain('collision');
      expect(runtime.content.format).toBe('lod-meta');
    }

    // 官方门槛：水平足迹 ≥ 5 才能 walk。夹具内容 7.61 × 6.89 满足。
    await openScene(page, SAFE);
    const state = await readViewerState(page);
    expect(state).not.toBeNull();
    const x = state!.bounds ? state!.bounds.size[0] : 0;
    const z = state!.bounds ? state!.bounds.size[2] : 0;
    expect(x, '官方 walk 门槛：水平 X 足迹 ≥ 5').toBeGreaterThanOrEqual(5);
    expect(z, '官方 walk 门槛：水平 Z 足迹 ≥ 5').toBeGreaterThanOrEqual(5);
    // safe 夹具：平台信任 → 官方真的拿到碰撞数据 → walkAllowed=true。
    // 这一条同时证明「不是夹具太小导致走不了路」。
    expect(state!.walkAllowed, 'safe 夹具官方 walkAllowed 必须为 true').toBe(true);
    expect(state!.hasCollision).toBe(true);
  });

  test('safe 夹具：合法校准场景仍能通过官方 UI / 键盘 3 / WASD / 宿主 API 进入 walk', async ({
    page,
  }) => {
    await openScene(page, SAFE);
    const entry = await tryEnterWalk(page);
    expect(entry, '已校准 + 已绑定 + 未 STALE 的场景必须允许 walk').not.toBeNull();
    expect(entry!.mode).toBe('walk');
    // 真实相机模式确实切到了 walk（不是 fly 兜底）
    const after = await readViewerState(page);
    expect(after?.cameraMode).toBe('walk');
  });

  test('stale 夹具：碰撞 STALE 时任何官方入口都进不去 walk', async ({ page }) => {
    const runtime = await readRuntime(page, STALE);
    // 平台判定不可信的那个条件确实成立（不是夹具造假）。
    expect(runtime.collision.enabled).toBe(true);
    expect(runtime.collision.stale).toBe(true);
    expect(runtime.collision.url).toBeTruthy();

    await openScene(page, STALE);
    const state = await readViewerState(page);
    expect(state).not.toBeNull();
    expect(state!.loaded).toBe(true);
    // 根因证据：平台没有把碰撞资源交给官方 viewer。
    expect(state!.hasCollision, 'STALE 碰撞不得注入官方 viewer').toBe(false);
    expect(state!.walkAllowed, '官方 walkAllowed 必须为 false').toBe(false);

    const entry = await tryEnterWalk(page);
    expect(entry, 'STALE 场景下快捷键/按钮/宿主 API 均不得进入 walk').toBeNull();
    expect((await readViewerState(page))?.cameraMode).not.toBe('walk');
  });

  test('uncalibrated 夹具：物理尺度未校准时任何官方入口都进不去 walk', async ({ page }) => {
    const runtime = await readRuntime(page, UNCAL);
    // 后端把「未校准」折进 enabled=false（scene_processing.physicalWalkAllowed）。
    expect(runtime.collision.enabled).toBe(false);
    expect(runtime.collision.url).toBeTruthy();

    await openScene(page, UNCAL);
    const state = await readViewerState(page);
    expect(state).not.toBeNull();
    expect(state!.loaded).toBe(true);
    expect(state!.hasCollision, '未校准场景不得注入官方 viewer').toBe(false);
    expect(state!.walkAllowed).toBe(false);

    const entry = await tryEnterWalk(page);
    expect(entry, '未校准场景下快捷键/按钮/宿主 API 均不得进入 walk').toBeNull();
    expect((await readViewerState(page))?.cameraMode).not.toBe('walk');
  });
});
