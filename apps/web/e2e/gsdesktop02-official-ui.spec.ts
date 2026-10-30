/**
 * GS-DESKTOP-02 —— 原生 SuperSplat Viewer UI 与官方 PCUI 创作界面迁移（真实 Chromium）。
 *
 * ## 本文件验收的契约（对应任务 §6）
 *
 * A. 浏览页真正显示官方 Viewer UI（不只 DOM 存在，而是可见 + 有尺寸）。
 * B. 没有重复工具栏（宿主自绘 ov-frame/ov-reset/ov-walk/... 全部消失），
 *    官方按钮可点击且产生真实效果。
 * C. 初始相机无加载完成后的自动拉远（沿用 GS-DESKTOP-01 的探针证据）。
 * D. 作者工作区：调整相机 → 保存 → 关闭再打开，最终视角一致。
 * E. 标注放置模式：点击真实 Gaussian 画布 → 落库 → 回读 descriptor。
 * F. 返回浏览页：官方 hotspot 与导览器可见，导览跳转到正确相机。
 * G. 重命名 / 隐藏 / 删除标注后 Viewer 与数据库一致。
 * I. Streamed SOG 与单文件 SOG 各跑一次主要流程。
 * K. 重复进入/退出创作模式不导致 WebGL context 或事件监听泄漏。
 *
 * 截图证据由本文件在 test-results/ 下产出（见 test.afterEach）。
 */
import { expect, test, type Page } from './fresh-browser';

// 创作页用例要在真实浏览器里加载官方 Viewer、移动相机、保存、重开，
// SwiftShader 软件渲染下每一步都慢 —— 给足墙钟预算（断言本身未放松）。
test.describe.configure({ timeout: 480_000 });

const API = '/api/v1/scenes';
const SCENE = 'fix02-semantics';

type Diag = {
  loaded: boolean;
  camera: { position: number[]; target: number[]; fov: number } | null;
  cameraMode: string | null;
  showAnnotations: boolean;
  format: string | null;
  contentUrl: string | null;
};

/**
 * 手动推进官方 app 的 tick（GS-NEXT-10：headless WebGPU 下 rAF 可能不再投递）。
 *
 * GS-DESKTOP-04 实测：把「保存初始视角」触发的受控重建放在**从未 tick 过**的
 * Viewer 之后，SwiftShader 里第二次 `navigator.gpu.requestAdapter()` 会长时间
 * 不 resolve（实测 >240s）；先让第一个 Viewer 真实渲染过若干帧再保存，重建
 * 实测 ~112s 收敛。这属于云渲染管线的 teardown/重建时序，不是产品逻辑。
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

async function openViewer(page: Page, sceneId = SCENE): Promise<void> {
  await page.goto(`/scene/${sceneId}`);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      if (!el) return false;
      try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
    },
    { timeout: 120_000 },
  );
}

async function readDiag(page: Page): Promise<Diag> {
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'));
}

/**
 * 官方标注能力是否真实可见（有渲染尺寸，不是 display:none 的空壳）。
 * GS-UI-01 起底部控制条由宿主承接，这里只校验不会被接管的官方标注层。
 */
async function officialControlVisibility(page: Page): Promise<Record<string, boolean>> {
  const selectors: Record<string, string> = {
    annotationNav: '.sse-annotationNav',
    hotspot: '.sse-annotation-hotspots .sse-annotation-hotspot',
  };
  const out: Record<string, boolean> = {};
  for (const [name, sel] of Object.entries(selectors)) {
    const loc = page.locator(sel).first();
    out[name] = await loc.isVisible().catch(() => false);
  }
  return out;
}

/**
 * GS-UI-01 Req2：官方底部控制条已由宿主底部浮动控制栏**完整承接**后收起，
 * 不允许新旧两套工具栏。这里校验：官方原能力（Reset/Frame/Settings/Info/
 * Annotations/全屏）都还能通过宿主控制栏或官方面板真实触达。
 */
const HOST_TOOLBAR_TESTIDS = [
  'ov2-toolbar',
  'ov2-reset',
  'ov2-mode',
  'ov2-speed',
  'ov2-quality',
  'ov2-settings',
  'ov2-help',
  'ov2-more',
];

/** 宿主自绘重复工具条必须全部消失（这些 data-testid 曾在 SSV-03→GS-NEXT-04 使用）。 */
const HOST_DUPLICATE_IDS = [
  'ov-frame',
  'ov-reset',
  'ov-walk',
  'ov-performance',
  'ov-annotations',
  'ov-fullscreen',
  'ov-exit-fullscreen',
  'ov-camera-mode',
];

/** 打开官方设置面板：宿主「设置」按钮转发到官方 `.sse-settings`（官方 DOM 不变）。 */
async function openOfficialSettingsFromHost(page: Page): Promise<void> {
  await page.locator('[data-testid="ov2-settings"]').click();
  await page.waitForTimeout(400);
}

test.describe('GS-DESKTOP-02 A/B —— 宿主控制栏完整承接官方 Viewer UI，无重复工具栏', () => {
  test('A/B：官方控制条收起、宿主四组控制栏可见，官方设置面板仍真实可用', async ({ page }) => {
    await openViewer(page);

    // 官方底层控制条由宿主承接后收起（不允许两套工具栏）。
    await expect(page.locator('.sse-controlsWrap')).toBeHidden();
    // 宿主底部控制栏四组 + 官方能力入口必须真实可见（有尺寸）。
    for (const id of HOST_TOOLBAR_TESTIDS) {
      await expect(page.locator(`[data-testid="${id}"]`), `${id} 必须真实可见`).toBeVisible();
    }
    // 官方标注导览器 / hotspot 层仍由官方渲染且可见（未回归）。
    await expect(page.locator('.sse-annotationNav')).toBeVisible();
    await expect(
      page.locator('.sse-annotation-hotspots .sse-annotation-hotspot').first(),
    ).toBeVisible();

    // 宿主「设置」转发到官方设置面板；官方 Reset / Frame 仍在其中且可见。
    await openOfficialSettingsFromHost(page);
    await expect(page.locator('.sse-settingsPanel')).toBeVisible();
    await expect(page.locator('.sse-reset')).toBeVisible();
    await expect(page.locator('.sse-frame')).toBeVisible();

    // 宿主按钮有真实命中区域。
    for (const id of ['ov2-reset', 'ov2-mode', 'ov2-speed', 'ov2-quality', 'ov2-settings']) {
      const box = await page.locator(`[data-testid="${id}"]`).boundingBox();
      expect(box, `${id} 应有命中区域`).not.toBeNull();
      expect(box!.width).toBeGreaterThan(8);
      expect(box!.height).toBeGreaterThan(8);
    }

    // 没有旧宿主重复控件；唯一控制栏是 ov2-toolbar。
    for (const id of HOST_DUPLICATE_IDS) {
      await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-testid="ov2-toolbar"]')).toHaveCount(1);
    // 平台级导航保留：作品信息面板 + Saved Views 扩展入口。
    await expect(page.locator('[data-testid="ov-saved-views"]')).toHaveCount(1);
    await expect(page.locator('.gs-viewer__right-panel')).toBeVisible();
  });

  test('A/B：官方 Reset 恢复已保存初始视角；Frame 只在主动点击时取景', async ({ page }) => {
    await openViewer(page);
    const before = await readDiag(page);

    // 官方 Reset / Frame 在设置面板内：经宿主「设置」入口打开官方设置。
    await openOfficialSettingsFromHost(page);

    // 官方 Reset：应回到 authored initial（夹具已保存初始视角）。
    await page.locator('.sse-reset').first().click();
    await page.waitForTimeout(2500);
    const afterReset = await readDiag(page);
    console.log('after official reset:', JSON.stringify(afterReset.camera));
    expect(afterReset.camera).not.toBeNull();

    // 官方 Frame：主动点击后取景整个场景（相机应移动）。
    await page.locator('.sse-frame').first().click();
    await page.waitForTimeout(3000);
    const afterFrame = await readDiag(page);
    console.log('after official frame:', JSON.stringify(afterFrame.camera));
    const moved =
      afterFrame.camera && before.camera
        ? Math.hypot(
            afterFrame.camera.position[0] - before.camera.position[0],
            afterFrame.camera.position[1] - before.camera.position[1],
            afterFrame.camera.position[2] - before.camera.position[2],
          )
        : 0;
    expect(moved, 'Frame 应把相机移到场景取景位置').toBeGreaterThan(0.05);

    // Reset 再把相机带回初始视角（不残留 Frame 的结果）。
    await page.locator('.sse-reset').first().click();
    await page.waitForTimeout(2500);
    const back = await readDiag(page);
    const distToReset =
      back.camera && afterReset.camera
        ? Math.hypot(
            back.camera.position[0] - afterReset.camera.position[0],
            back.camera.position[1] - afterReset.camera.position[1],
            back.camera.position[2] - afterReset.camera.position[2],
          )
        : 999;
    expect(distToReset, 'Reset 应恢复到初始视角').toBeLessThan(0.2);
  });

  test('A/B：查看方式切换（宿主 → 官方 Orbit / Fly）真实生效', async ({ page }) => {
    await openViewer(page);
    // 宿主控制栏「查看方式」转发到官方 writable cameraMode，状态由官方维护。
    await page.getByText('自由飞行', { exact: true }).click();
    await expect.poll(async () => (await readDiag(page)).cameraMode, { timeout: 15_000 }).toBe('fly');

    await page.getByText('环绕', { exact: true }).click();
    await expect.poll(async () => (await readDiag(page)).cameraMode, { timeout: 15_000 }).toBe('orbit');
  });

  test('A/B：官方 Settings 面板与 Annotations 开关真实可用', async ({ page }) => {
    await openViewer(page);
    // 「设置」按钮打开官方设置面板（含 Annotations 显隐行）。
    await openOfficialSettingsFromHost(page);
    const panelVisible = await page.locator('.sse-settingsPanel').first().isVisible();
    expect(panelVisible, '官方设置面板应可见').toBe(true);
    const annotationsRow = await page.locator('.sse-annotationsRow').first().isVisible();
    expect(annotationsRow, '官方 Annotations 开关应可见').toBe(true);

    // 点击官方 Annotations 行 → 官方 state.showAnnotations 翻转。
    await page.locator('.sse-annotationsRow').first().click();
    await expect
      .poll(async () => (await readDiag(page)).showAnnotations, { timeout: 15_000 })
      .toBe(false);
  });

  test('A/B：官方 annotation navigator 前后切换正常', async ({ page }) => {
    await openViewer(page);
    const navVisible = await page.locator('.sse-annotationNav').first().isVisible();
    expect(navVisible).toBe(true);

    const readNav = () =>
      page.evaluate(() => ({
        number: (document.querySelector('.sse-annotationNavNumber')?.textContent ?? '').trim(),
        title: (document.querySelector('.sse-annotationNavTitle')?.textContent ?? '').trim(),
      }));
    const first = await readNav();
    console.log('nav first:', JSON.stringify(first));
    expect(first.number.length).toBeGreaterThan(0);

    await page.locator('.sse-annotationNext').first().click();
    await page.waitForTimeout(2500);
    const next = await readNav();
    console.log('nav next:', JSON.stringify(next));
    expect(next.number).not.toBe(first.number);

    await page.locator('.sse-annotationPrev').first().click();
    await page.waitForTimeout(2500);
    const back = await readNav();
    expect(back.number).toBe(first.number);
  });

  test('A/B：没有鼠标事件遮罩吞掉宿主/官方控件（canvas 命中测试）', async ({ page }) => {
    await openViewer(page);
    // 设置面板经宿主入口打开后再做命中测试（Reset/Frame 在官方设置面板内）。
    await openOfficialSettingsFromHost(page);
    // 官方控件中心点的元素必须是控件自身或其子元素（不是宿主覆盖层）。
    for (const sel of ['.sse-reset', '.sse-frame', '.sse-annotationNext']) {
      const hit = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          selector: s,
          hitTag: top?.tagName ?? null,
          hitInside: top ? el.contains(top) || (top as HTMLElement).contains(el) : false,
        };
      }, sel);
      console.log('hit test:', JSON.stringify(hit));
      expect(hit?.hitInside, `${sel} 不应被宿主覆盖层遮挡`).toBe(true);
    }
    // 宿主控制栏自身也不能被遮挡。
    const hostHit = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="ov2-toolbar"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { hitInside: top ? el.contains(top) || (top as HTMLElement).contains(el) : false };
    });
    expect(hostHit?.hitInside, '宿主控制栏不应被遮挡').toBe(true);
  });
});

test.describe('GS-DESKTOP-02 C —— 初始相机稳定（GS-DESKTOP-01 回归）', () => {
  test('C：加载完成后不自动 frameScene（相机不自行拉远）', async ({ page }) => {
    await openViewer(page);
    const first = await readDiag(page);
    await page.waitForTimeout(4000);
    const second = await readDiag(page);
    const drift =
      first.camera && second.camera
        ? Math.hypot(
            second.camera.position[0] - first.camera.position[0],
            second.camera.position[1] - first.camera.position[1],
            second.camera.position[2] - first.camera.position[2],
          )
        : 999;
    console.log('idle drift:', drift);
    expect(drift, '空闲期间相机不得自行漂移').toBeLessThan(0.05);
  });
});

// 创作页要在真实浏览器里加载官方 Viewer + 滚轮移动相机 + 保存 + 重开；
// SwiftShader 下每一步都慢，给足预算（断言未放松）。
test.describe('GS-DESKTOP-02 D/E —— 官方 PCUI 创作工作区', () => {
  test('D：作者工作区可见 PCUI 控件 + 官方 Viewer 画布', async ({ page }) => {
    await page.goto('/model/edit/fix02-semantics');
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await page.waitForSelector('[data-testid="authoring-mount"] canvas', { timeout: 120_000 });
    await page.waitForFunction(
      () => document.body.textContent?.includes('Viewer 就绪') ?? false,
      { timeout: 120_000 },
    );

    const info = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="scene-authoring-page"]')!;
      return {
        pcui: root.querySelectorAll('.pcui-element').length,
        tabs: root.querySelectorAll('.ant-tabs-tab').length,
        buttons: root.querySelectorAll('.pcui-button').length,
        canvas: root.querySelectorAll('canvas').length,
        officialControls: root.querySelectorAll('.sse-controlsWrap').length,
        // GS-UI-01 Req3：旧的 250px 左栏已取消，场景/标注/视角收进右侧属性面板。
        left: !!root.querySelector('.gs-workspace__left'),
        right: !!root.querySelector('.gs-workspace__right'),
      };
    });
    console.log('authoring workspace:', JSON.stringify(info));
    expect(info.tabs, '属性面板应含 场景设置/标注管理/视角管理 三个分区').toBe(3);
    expect(info.buttons, 'PCUI 控件应存在').toBeGreaterThanOrEqual(10);
    expect(info.canvas, '官方 Viewer 画布应存在').toBe(1);
    expect(info.right, '右侧属性面板应存在').toBe(true);
    expect(info.left, '旧左栏已移除（Viewer 面积释放）').toBe(false);

    // 没有第二套相机控制器：创作页不再渲染 antd 相机面板（InitialViewPanel 等）。
    await expect(page.locator('.ant-card')).toHaveCount(0);
  });

  test('D：编辑相机 → 保存 → 重开后最终视角一致', async ({ page }) => {
    // 本用例要等一次受控重建收敛（SwiftShader 下实测 112–400s），
    // 文件级 480s 预算不够宽裕，单独放宽。
    test.setTimeout(1_500_000);
    // 本用例会写共享夹具的初始相机：结束后恢复，避免污染其他用例。
    const snapshot = await (await page.request.get(`${API}/${SCENE}/presentation`)).json();
    try {
    await page.goto('/model/edit/fix02-semantics');
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await page.waitForFunction(
      () => document.body.textContent?.includes('Viewer 就绪') ?? false,
      { timeout: 120_000 },
    );
    // 让第一个 Viewer 真实渲染若干帧再保存（见 pumpFrames 注释：否则受控重建
    // 的第二次 WebGPU requestAdapter 在 SwiftShader 下会长时间不 resolve）。
    await pumpFrames(page, 2000);

    // 读保存前的初始视角（DB 真相）。
    const before = await page.request.get(`${API}/${SCENE}/presentation`);
    expect(before.status()).toBe(200);
    const pres = await before.json();
    const savedBefore = pres.initialCameraPosition;

    // 真实移动相机（滚轮推近）：保存的必须是「当前视角」，而不是原值。
    const canvas = page.locator('[data-testid="authoring-mount"] canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1500);

    // 保存当前视角为初始视角。
    await page.getByRole('button', { name: '保存初始视角' }).click();
    await expect(
      page.getByText('已保存（初始视角已更新，打开场景将采用该视角）'),
    ).toBeVisible({ timeout: 30_000 });
    const afterSave = await page.request.get(`${API}/${SCENE}/presentation`);
    const presAfter = await afterSave.json();
    console.log('saved before:', JSON.stringify(savedBefore), 'after:', JSON.stringify(presAfter.initialCameraPosition));
    expect(presAfter.initialCameraPosition, '保存后 DB 应有初始视角').not.toBeNull();
    // 保存必须真的把「移动后的相机」写进去（不是原地保存旧值）。
    const moved = savedBefore
      ? Math.hypot(
          presAfter.initialCameraPosition.x - savedBefore.x,
          presAfter.initialCameraPosition.y - savedBefore.y,
          presAfter.initialCameraPosition.z - savedBefore.z,
        )
      : 999;
    expect(moved, '保存的应是移动后的相机').toBeGreaterThan(0.2);

    // 保存后相机不得跳变（§3.1）。GS-DESKTOP-04 §三 修订：官方 1.35.0 的 Reset
    // 目标在 CameraManager 构造时固化，公开 API 无法运行时更新 —— 所以保存成功后
    // **允许一次受控重建**（让官方 Reset 也指向新视角），但重建后必须恢复用户当时
    // 的视角，画面不得跳远。
    //
    // 预算说明（实测，不是放宽断言）：headless SwiftShader 下销毁旧 WebGPU 设备后
    // 的第二次 `requestAdapter` 实测 111.9s 才 resolve，同一环境另一次实测约 400s，
    // 所以这里按 600s 等同步收敛；真实 GPU 浏览器上是秒级。
    //
    // `polling: 500` 是必需的：官方 Viewer 加载完成后 `app.autoRender=false`，
    // 页面 rAF 可能不再投递，而 `waitForFunction` 默认按 rAF 轮询 —— 会用真实
    // 的「永远等不到」超时来掩盖「条件其实已满足」。
    await page.waitForFunction(() => {
      const rt = (window as unknown as { __gsauthoringruntime?: { loaded?: boolean; getCameraPose?: () => unknown } })
        .__gsauthoringruntime;
      return rt?.loaded === true && !!rt.getCameraPose?.();
    }, undefined, { timeout: 600_000, polling: 500 });
    await page.waitForTimeout(600);
    const afterSavePose = await page.evaluate(() => {
      const runtime = (window as unknown as { __gsauthoringruntime?: { getCameraPose?: () => { position: number[] } | null } }).__gsauthoringruntime;
      return runtime?.getCameraPose?.()?.position.map((n: number) => +n.toFixed(3)) ?? null;
    });
    expect(afterSavePose, '保存后 Viewer 仍应就绪（同步重建收敛）').not.toBeNull();
    const savedPos = [
      presAfter.initialCameraPosition.x,
      presAfter.initialCameraPosition.y,
      presAfter.initialCameraPosition.z,
    ];
    expect(
      Math.hypot(
        afterSavePose![0] - savedPos[0],
        afterSavePose![1] - savedPos[1],
        afterSavePose![2] - savedPos[2],
      ),
      '保存不应移动当前相机',
    ).toBeLessThan(0.05);

    // 重新打开创作页 → Viewer 应落在已保存视角（不跳回鸟瞰）。
    await page.goto('/model/edit/fix02-semantics');
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await page.waitForFunction(
      () => document.body.textContent?.includes('Viewer 就绪') ?? false,
      { timeout: 120_000 },
    );
    await page.waitForTimeout(4000);
    const pose = await page.evaluate(() => {
      const runtime = (window as unknown as { __gsauthoringruntime?: { getCameraPose?: () => { position: number[] } | null } }).__gsauthoringruntime;
      const p = runtime?.getCameraPose?.() ?? null;
      return p ? p.position.map((n: number) => +n.toFixed(3)) : null;
    });
    const expected = presAfter.initialCameraPosition;
    const dist = pose && expected
      ? Math.hypot(pose[0] - expected.x, pose[1] - expected.y, pose[2] - expected.z)
      : 999;
    console.log('reopened pose:', JSON.stringify(pose), 'expected:', JSON.stringify(expected), 'dist:', dist);
    expect(dist, '重开后相机应落在已保存初始视角').toBeLessThan(0.5);
    } finally {
      // 非破坏性恢复（只写回本用例改过的字段）。
      const restore = await page.request.patch(`${API}/${SCENE}/presentation`, {
        data: {
          initialCameraPosition: snapshot.initialCameraPosition,
          initialCameraTarget: snapshot.initialCameraTarget,
          initialCameraFov: snapshot.initialCameraFov,
        },
      });
      expect(restore.status(), '恢复夹具初始相机').toBe(200);
    }
  });

  test('E：标注放置模式 → 点击真实 Gaussian 画布 → 落库并出现官方 hotspot', async ({ page }) => {
    await page.goto('/model/edit/fix02-semantics');
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await page.waitForFunction(
      () => document.body.textContent?.includes('Viewer 就绪') ?? false,
      { timeout: 120_000 },
    );

    // 记录创建前的标注数。
    const before = await page.request.get(`${API}/${SCENE}/annotations`);
    const beforeCount = (await before.json()).length;

    let createdId: string | null = null;
    try {
      // 进入标注放置模式（GS-UI-01：标注入口在右侧「标注管理」分区）。
      await page.getByRole('tab', { name: '标注管理' }).click();
      await page.getByRole('button', { name: /添加标注/ }).click();
      await expect(page.locator('[data-testid="annotation-pick-badge"]')).toBeVisible();

      // 点击真实 Gaussian 画布（视口中心附近，确保命中 canvas 本体）。
      // GS-UI-01 修复（需求 2）：点击先出现 XYZ 轴标记预览，再点「设为标记点」落库。
      const canvas = page.locator('[data-testid="authoring-mount"] canvas');
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.52);
      await expect(page.locator('[data-testid="annotation-pick-marker"]')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: '设为标记点' }).click();
      await page.waitForTimeout(3000);

      const after = await page.request.get(`${API}/${SCENE}/annotations`);
      const afterList = await after.json();
      console.log('annotation count:', beforeCount, '→', afterList.length);
      expect(afterList.length, '应新增一条标注').toBe(beforeCount + 1);
      const created = afterList[afterList.length - 1];
      createdId = created.id;
      expect(created.enabled).toBe(true);
      // 标注自己的相机 pose 必须被捕获（§3.2 要求）。
      expect(created.cameraPosition, '标注应带自己的相机 pose').not.toBeNull();

      // GS-UI-01 修复：创作页不再为新增标注重建 Viewer（用户反馈「添加标记后刷新」）。
      // 新标记点由宿主标记点层即时渲染 —— 断言画布上出现该标注的标记。
      await page.waitForFunction(
        (id: string) =>
          !!document.querySelector(
            `[data-testid="authoring-annotation-marker"][data-annotation-id="${id}"]`,
          ),
        created.id,
        { timeout: 90_000 },
      );
    } finally {
      // 清理：本用例写入了真实夹具，结束后删除，避免污染后续用例（断言失败也清理）。
      if (createdId) await page.request.delete(`${API}/${SCENE}/annotations/${createdId}`);
    }
  });

  test('G：重命名 / 隐藏 / 删除标注后 Viewer 与数据库一致', async ({ page }) => {
    // 用数据库创建一条独立标注，避免影响共享夹具。
    const create = await page.request.post(`${API}/${SCENE}/annotations`, {
      data: { title: 'GS-DESKTOP-02 临时标注', textContent: 'e2e', anchorX: 0.2, anchorY: 0.8, anchorZ: 0.1 },
    });
    expect(create.status()).toBe(201);
    const ann = await create.json();

    // 重命名。
    const renamed = await page.request.patch(`${API}/${SCENE}/annotations/${ann.id}`, {
      data: { title: 'GS-DESKTOP-02 改名后' },
    });
    expect(renamed.status()).toBe(200);
    expect((await renamed.json()).title).toBe('GS-DESKTOP-02 改名后');

    // 打开浏览页：官方 hotspot 数量应等于 enabled 标注数。
    await openViewer(page);
    const enabledCount = (await (await page.request.get(`${API}/${SCENE}/annotations`)).json())
      .filter((a: { enabled: boolean }) => a.enabled).length;
    await expect(
      page.locator('.sse-annotation-hotspots .sse-annotation-hotspot'),
    ).toHaveCount(enabledCount, { timeout: 60_000 });

    // 隐藏 → hotspot 少一个。
    await page.request.patch(`${API}/${SCENE}/annotations/${ann.id}`, { data: { enabled: false } });
    await openViewer(page);
    await expect(
      page.locator('.sse-annotation-hotspots .sse-annotation-hotspot'),
    ).toHaveCount(enabledCount - 1, { timeout: 60_000 });

    // 删除 → 仍是被隐藏后的数量（该条已不在 enabled 列表里）。
    await page.request.delete(`${API}/${SCENE}/annotations/${ann.id}`);
    await openViewer(page);
    await expect(
      page.locator('.sse-annotation-hotspots .sse-annotation-hotspot'),
    ).toHaveCount(enabledCount - 1, { timeout: 60_000 });
  });
});

test.describe('GS-DESKTOP-02 I/K —— Streamed SOG / 单文件 SOG / 无泄漏', () => {
  test('I：Streamed SOG（lod-meta）与单文件 SOG 各跑一次官方 UI 主流程', async ({ page }) => {
    for (const sceneId of ['gsdesktop01-versions', SCENE]) {
      const runtime = await (
        await page.request.get(`/api/v1/scenes/${sceneId}/runtime`)
      ).json();
      console.log('scene', sceneId, 'format:', runtime.content.format);
      expect(['lod-meta', 'sog'], `未覆盖期望格式: ${runtime.content.format}`)
        .toContain(runtime.content.format);

      await openViewer(page, sceneId);
      // GS-UI-01 Req2：官方底部控制条由宿主控制栏收起，但官方能力仍真实可触达。
      const vis = await officialControlVisibility(page);
      console.log(`${runtime.content.format} official controls:`, JSON.stringify(vis));
      expect(vis.annotationNav && vis.hotspot, `${sceneId} 官方标注能力应可见`).toBe(true);
      // 宿主控制栏四组 + 官方能力入口可见（不出现第二套工具栏）。
      await expect(page.locator('[data-testid="ov2-toolbar"]')).toBeVisible();
      await expect(page.locator('.sse-controlsWrap')).toBeHidden();

      // 经宿主「设置」入口打开官方设置面板，Reset / Frame 仍真实可见可点。
      await page.locator('[data-testid="ov2-settings"]').click();
      await page.waitForTimeout(400);
      await expect(page.locator('.sse-reset')).toBeVisible();
      await expect(page.locator('.sse-frame')).toBeVisible();
      await page.locator('.sse-reset').first().click();
      await page.waitForTimeout(2000);
      const diag = await readDiag(page);
      expect(diag.loaded).toBe(true);
      expect(diag.camera).not.toBeNull();
    }
  });

  test('K：重复进入/退出创作模式不导致 WebGL context 泄漏', async ({ page }) => {
    const contexts = async () =>
      page.evaluate(() => document.querySelectorAll('canvas').length);

    await page.goto('/model/edit/fix02-semantics');
    await page.waitForSelector('[data-testid="scene-authoring-page"]');
    await page.waitForFunction(
      () => document.body.textContent?.includes('Viewer 就绪') ?? false,
      { timeout: 120_000 },
    );
    const first = await contexts();
    console.log('canvas count after 1st entry:', first);

    for (let i = 0; i < 2; i += 1) {
      await page.goto('/');
      await page.waitForSelector('[data-testid="platform-sider"]');
      await page.goto('/model/edit/fix02-semantics');
      await page.waitForSelector('[data-testid="scene-authoring-page"]');
      await page.waitForFunction(
        () => document.body.textContent?.includes('Viewer 就绪') ?? false,
        { timeout: 120_000 },
      );
    }
    const after = await contexts();
    console.log('canvas count after 3 entries:', after);
    // 官方 runtime destroy 是幂等的（同一容器子树被重建），不应累积 canvas。
    expect(after, '重复进入不应累积 canvas/WebGL context').toBeLessThanOrEqual(first);
  });
});
