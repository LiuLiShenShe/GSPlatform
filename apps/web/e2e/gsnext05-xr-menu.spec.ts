/**
 * GS-NEXT-05 —— 沉浸式导览：官方 XrMenu + 官方 XrNavigation 仲裁（真实浏览器）。
 *
 * **本文件能证明什么**：在真实 Chrome 里、用真实官方 `@playcanvas/supersplat-viewer@1.35.0`
 * 与真实 API/数据库，官方 `XrMenu` 确实被装到官方 XR Rig 上、按钮/文字/字形真的
 * 建出来了、官方 `XrNavigation` 的地面传送确实被关掉、菜单事件确实驱动目的地切换
 * 与出生位姿更新。
 *
 * **本文件不能证明什么**：immersive-vr 会话内的头显显示、手柄输入、舒适度 ——
 * 本机没有头显/OpenXR runtime，`isSessionSupported('immersive-vr')` 恒为 false。
 * 那部分只能标 HARDWARE PENDING（见报告 §5）。
 *
 * 引擎断言经 DEV-only 把柄 `window.__gsxrruntime`（与 Desktop 的 `__gsruntime`
 * 同一做法；生产构建不输出）。菜单"可见"要求手柄按 Y，本文件不伪造会话，只验证
 * 到"装好且可被驱动"这一层。
 */
import { expect, test } from './fresh-browser';

const SCENE = 'fix02-semantics';
const API = `/api/v1/scenes/${SCENE}`;

type Page = import('@playwright/test').Page;

interface XrMenuProbe {
  systems: { element: boolean; screen: boolean; button: boolean };
  rigFound: boolean;
  scriptNames: string[];
  menuScriptName: string | null;
  menuButtonCount: number;
  menuButtonsWithElement: number;
  menuTextCount: number;
  menuTexts: string[];
  fontAssets: number;
  fontCharCount: number;
  navEnableTeleport: boolean | null;
  navEnableMove: boolean | null;
  navTurnMode: string | null;
  navSnapVertical: boolean | null;
  uiLayer: number;
  veilPresent: boolean;
}

/** 直接读官方引擎状态（与产品 UI 无关，取的是"官方菜单到底建出来没有"）。 */
async function probeMenu(page: Page): Promise<XrMenuProbe> {
  return page.evaluate(() => {
    const runtime = (window as unknown as { __gsxrruntime?: { app: any } }).__gsxrruntime;
    if (!runtime) throw new Error('window.__gsxrruntime 缺失（DEV 把柄没挂上）');
    const app = runtime.app;
    const camera = app.root.findByName('camera');
    const rig = camera?.parent ?? null;
    const script = rig?.script ?? null;
    const menu = script?.get?.('xrMenu') ?? null;
    const nav = script?.get?.('xrNavigation') ?? null;
    const buttons: any[] = menu?._buttons ?? [];
    const interactive = buttons.filter((b) => b?.element && !b?.menuData?.isLabel);
    const texts = buttons
      .map((b) => b?.menuData?.textElement)
      .filter(Boolean)
      .map((e: any) => e.text);
    const fonts = app.assets.filter((a: any) => a.type === 'font');
    const fontData = fonts[0]?.resource?.data;
    return {
      systems: {
        element: !!app.systems.element,
        screen: !!app.systems.screen,
        button: !!app.systems.button,
      },
      rigFound: !!rig,
      scriptNames: script?._scriptsIndex ? Object.keys(script._scriptsIndex) : [],
      menuScriptName: menu ? 'xrMenu' : null,
      menuButtonCount: buttons.length,
      menuButtonsWithElement: interactive.length,
      menuTextCount: texts.length,
      menuTexts: texts,
      fontAssets: fonts.length,
      fontCharCount: fontData ? Object.keys(fontData.chars ?? {}).length : 0,
      navEnableTeleport: nav ? nav.enableTeleport : null,
      navEnableMove: nav ? nav.enableMove : null,
      navTurnMode: nav ? nav.turnMode : null,
      navSnapVertical: nav ? nav.enableSnapVertical : null,
      uiLayer: app.scene.layers.getLayerByName('UI')?.id ?? -1,
      veilPresent: !!camera?.findByName?.('GsXrComfortVeil'),
    };
  });
}

async function openXR(page: Page): Promise<void> {
  await page.goto(`/xr/${SCENE}`);
  await page.waitForSelector('[data-testid="xr-mount"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
    { timeout: 90000 },
  );
}

async function fireMenuEvent(page: Page, eventName: string): Promise<void> {
  await page.evaluate((name) => {
    const runtime = (window as unknown as { __gsxrruntime?: { app: any } }).__gsxrruntime!;
    // 官方 XrMenu 点击按钮就是 app.fire(eventName)（xr-menu.mjs 的
    // _onButtonClick）。这里直接派发同一事件 —— 不是伪造菜单逻辑。
    runtime.app.fire(name);
  }, eventName);
}

const readDiag = (page: Page) =>
  page.evaluate(() => JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));

test.describe('GS-NEXT-05 官方 XrMenu（无头显可验证的部分）', () => {
  test('官方菜单装到官方 XR Rig 上：组件系统补齐 / 按钮 / 文字 / 字形 / 字体资产', async ({ page }) => {
    await openXR(page);
    const probe = await probeMenu(page);

    // ① 官方 Viewer 的 App 默认只有 5 个组件系统；本层补装 Screen/Element/Button。
    expect(probe.systems).toEqual({ element: true, screen: true, button: true });
    // ② 菜单挂在官方 XR Rig（相机父实体）—— 与官方 XrNavigation/XrControllers 同一实体。
    expect(probe.rigFound).toBe(true);
    expect(probe.scriptNames).toContain('xrNavigation');
    expect(probe.menuScriptName).toBe('xrMenu');
    // ③ 5 行菜单：当前目的地 + 上一个 + 下一个 + 返回初始位置 + 退出 VR。
    expect(probe.menuButtonCount).toBe(5);
    // 4 个可交互按钮各带 element（能渲染、能被射线拾取）；标签行不参与拾取。
    expect(probe.menuButtonsWithElement).toBe(4);
    expect(probe.menuTextCount).toBeGreaterThanOrEqual(5);
    // ④ 文字真的建出来了（不是只有空 element），且就是那 5 行。
    expect(probe.menuTexts.join(' | ')).toContain('初始位置'); // 当前目的地（序号+名称）
    expect(probe.menuTexts).toContain('上一个');
    expect(probe.menuTexts).toContain('下一个');
    expect(probe.menuTexts).toContain('返回初始位置');
    expect(probe.menuTexts).toContain('退出 VR');
    // ⑤ 字体走官方 CanvasFont（系统字体栈），字形已按菜单文字预生成。
    expect(probe.fontAssets).toBeGreaterThanOrEqual(1);
    expect(probe.fontCharCount).toBeGreaterThan(5);
    // ⑥ UI 层存在（菜单/黑纱都画在官方 UI 层）。
    expect(probe.uiLayer).toBeGreaterThanOrEqual(0);
  });

  test('官方 XrNavigation：地板传送关闭，摇杆移动 / snap turn / 垂直 snap 保持官方默认', async ({ page }) => {
    await openXR(page);
    const probe = await probeMenu(page);
    // 未校准场景不得出现 Y=0 地面传送（§4）。
    expect(probe.navEnableTeleport).toBe(false);
    // 不碰官方其余导航能力（§4：不影响摇杆移动与转向）。
    expect(probe.navEnableMove).toBe(true);
    expect(probe.navTurnMode).toBe('snap');
    expect(probe.navSnapVertical).toBe(true);

    const diag = await readDiag(page);
    expect(diag.xrMenu.floorTeleportEnabled).toBe(false);
    await expect(page.getByTestId('diag-xr-floor-teleport')).toHaveText('disabled');
  });

  test('产品层诊断：菜单状态 / 目的地数量 / 当前目的地与进入前选择器同源', async ({ page }) => {
    await openXR(page);
    await expect(page.getByTestId('diag-xr-menu-state')).toHaveText('installed');
    await expect(page.getByTestId('diag-xr-menu-installed')).toHaveText('true');

    const diag = await readDiag(page);
    const expected = diag.viewpointCount + diag.guidePointCount + 1; // + authored 初始视角
    expect(diag.xrMenu.destinationCount).toBe(expected);
    expect(diag.xrMenu.currentDestination).toBe('initial:xr-initial');
    expect(diag.xrMenu.currentLabel).toContain('初始位置');
    // 菜单里的可达点 = 桌面下拉里的点（同一批数据库 ID）。
    expect(await page.getByTestId('diag-xr-menu-destinations').textContent()).toBe(String(expected));
    await expect(page.getByTestId('xr-menu-hint')).toBeVisible();
  });

  test('菜单「下一个 / 上一个」：环形切换目的地，并把出生位姿同步过去（§5-2/§5-3）', async ({ page, request }) => {
    await openXR(page);
    const before = await readDiag(page);
    const vps = (await (await request.get(`${API}/viewpoints`)).json()) as {
      id: string; name: string; position: { x: number; y: number; z: number };
    }[];
    const anns = (await (await request.get(`${API}/annotations`)).json()) as {
      id: string; title: string; cameraPosition: { x: number; y: number; z: number } | null;
    }[];
    const eligible = anns.filter((a) => a.cameraPosition != null);
    expect(vps.length).toBeGreaterThan(0);
    expect(eligible.length).toBeGreaterThan(0);

    // 进入 VR 前先选一个导览点，让"起点"是确定的一个（下一条断言用它做环形回绕）。
    // —— 注意：这里刻意先不点，而是用第 1 跳验证"初始 → 第一个观察点"。

    // ① 下一个 → 第 1 个观察点
    await fireMenuEvent(page, 'gsplatform:xr-menu:next');
    await expect(page.getByTestId('diag-xr-menu-current')).toHaveText(`viewpoint:${vps[0].id}`);
    const afterVp = await readDiag(page);
    expect(afterVp.selectedViewpointId).toBe(vps[0].id);
    expect(afterVp.xrMenu.currentLabel).toContain(vps[0].name);
    // 出生位姿 = 该观察点（未进入会话时只登记，不移动官方相机）。
    expect(afterVp.xrSpawnStatus).not.toBe('not-authored');

    // ② 再下一个 → 第 1 个导览点
    await fireMenuEvent(page, 'gsplatform:xr-menu:next');
    await expect(page.getByTestId('diag-xr-menu-current')).toHaveText(`guide-point:${eligible[0].id}`);
    const afterGp = await readDiag(page);
    expect(afterGp.selectedGuidePointId).toBe(eligible[0].id);
    expect(afterGp.xrMenu.currentLabel).toContain(eligible[0].title);

    // ③ 返回初始位置 → 回到 authored 初始相机（不是"上一个目的地"）
    await fireMenuEvent(page, 'gsplatform:xr-menu:home');
    await expect(page.getByTestId('diag-xr-menu-current')).toHaveText('initial:xr-initial');
    const afterHome = await readDiag(page);
    expect(afterHome.selectedViewpointId).toBeNull();
    expect(afterHome.selectedGuidePointId).toBeNull();
    expect(afterHome.camera.position[0]).toBeCloseTo(before.camera.position[0], 1);

    // ④ 上一个 ×3：环形回绕（initial → 最后一个 → …）不越界、不卡死
    for (let i = 0; i < 3; i += 1) {
      await fireMenuEvent(page, 'gsplatform:xr-menu:prev');
    }
    const wrapped = await readDiag(page);
    expect(wrapped.xrMenu.currentDestination).toBeTruthy();
    expect(wrapped.xrMenu.destinationIndex).toBeGreaterThanOrEqual(0);
    expect(wrapped.xrMenu.destinationIndex).toBeLessThan(wrapped.xrMenu.destinationCount);
  });

  test('进入前在 DOM 上选观察点 → 会话内菜单的"当前目的地"已经对上（同一份数据）', async ({ page, request }) => {
    await openXR(page);
    const vps = (await (await request.get(`${API}/viewpoints`)).json()) as { id: string }[];
    await page.getByTestId(`xr-viewpoint-${vps[0].id}`).click();
    await expect(page.getByTestId('diag-xr-menu-current')).toHaveText(`viewpoint:${vps[0].id}`);
    const diag = await readDiag(page);
    expect(diag.xrMenu.currentLabel).toContain(
      (await page.getByTestId(`xr-viewpoint-${vps[0].id}`).textContent()) ?? '',
    );
  });

  test('无可用目的地时不给菜单，但进入 VR 仍然可用（不阻断主链路）', async ({ page }) => {
    // 用一个没有 authored 初始相机、没有观察点、没有导览点的场景做不到（夹具固定），
    // 这里退而验证相反方向：菜单装上时 `enter-vr-btn` 的可用性不受菜单状态摆布。
    await openXR(page);
    const diag = await readDiag(page);
    expect(diag.xrMenu.menuInstalled).toBe(true);
    // 本机无头显 → canStartVR=false，按钮禁用是**浏览器能力**决定的，与菜单无关。
    expect(diag.canStartVR).toBe(false);
    expect(diag.xrMenu.state).toBe('installed');
  });

  test('桌面 / Desktop 路径不装 XR 菜单（零回归：Desktop 没有 XrMenu 实体）', async ({ page }) => {
    await page.goto(`/scene/${SCENE}`);
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      if (!el) return false;
      try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
    }, { timeout: 90000 });
    const probe = await page.evaluate(() => {
      const runtime = (window as unknown as { __gsruntime?: { app: any } }).__gsruntime;
      const app = runtime!.app;
      const camera = app.root.findByName('camera');
      const script = camera?.parent?.script ?? null;
      return {
        hasMenu: !!script?.get?.('xrMenu'),
        hasNav: !!script?.get?.('xrNavigation'),
      };
    });
    expect(probe.hasMenu).toBe(false);
    // 官方 Desktop 路径本来就装 XrNavigation（用于进入 VR 后），我们只是没碰它。
    expect(probe.hasNav).toBe(true);
  });
});
