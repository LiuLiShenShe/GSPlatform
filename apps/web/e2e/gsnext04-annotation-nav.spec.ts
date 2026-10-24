/**
 * GS-NEXT-04 —— 官方标注导览能力（真实浏览器 + 真实 API）。
 *
 * 两条能力线，都不新写 UI：
 *   Desktop：官方 `.sse-annotationNav`（Prev/Next + 序号 + 标题）被放行，
 *            点击走官方 `selectAnnotation` + 官方 CameraManager 过渡。
 *   XR：进入 VR 前用与 GS-NEXT-03 同构的「出生位置」选择器挑**导览点**，
 *       pose 直接取官方 `annotations[i].camera.initial`。
 *
 * 断言刻意**用官方导览器自己的 DOM**（序号 / 标题）来判定「当前选中哪一条」，
 * 而不是绕过 UI 去读内部状态 —— 这样才算真的验证了官方 UI 可用。
 *
 * 依赖：HEAD API（隔离库）+ vite dev；场景 fix02-semantics（DB 合同夹具）：
 *   3 条标注 标注A/B/C，各带**不同**的作者化相机，锚点各异；世界变换恒等。
 */
import { expect, test } from './fresh-browser';

const SCENE = 'fix02-semantics';
const API = `/api/v1/scenes/${SCENE}`;

type ApiRequest = import('@playwright/test').APIRequestContext;
type Page = import('@playwright/test').Page;

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function openViewer(page: Page): Promise<void> {
  await page.goto(`/scene/${SCENE}`);
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

/** 官方导览器读数：序号文本 + 标题文本（读的是官方自己渲染的内容）。 */
async function readNav(page: Page): Promise<{ visible: boolean; number: string; title: string }> {
  return page.evaluate(() => {
    const nav = document.querySelector('.sse-ui > .sse-annotationNav');
    const num = document.querySelector('.sse-annotationNavNumber');
    const title = document.querySelector('.sse-annotationNavTitle');
    return {
      visible: !!nav && !nav.classList.contains('sse-hidden'),
      number: (num?.textContent ?? '').trim(),
      title: (title?.textContent ?? '').trim(),
    };
  });
}

async function clickNav(page: Page, which: 'prev' | 'next'): Promise<void> {
  await page.click(`.sse-annotation${which === 'prev' ? 'Prev' : 'Next'}`);
}

/**
 * 手动推进官方引擎的公开 update 循环（app.tick）——只推进时间，不写相机状态。
 *
 * headless + SwiftShader 下真实 rAF 只有约 2fps，官方相机过渡按帧时长推进，
 * 一次 1.2–2.4s 的过渡要 ~150s 墙钟才收敛（GS-NEXT-10 / gsdesktop01 已记录）。
 * 断言（落点数值）不变，只把等待方式换成「推进引擎时间 + 轮询」。
 */
async function pumpEngine(page: Page, ms = 250): Promise<void> {
  const count = Math.max(1, Math.ceil(ms / 16.7));
  await page.evaluate((n) => {
    const rt = (window as unknown as {
      __gsruntime?: { app?: { tick?: (t: number) => void } };
      __gsxrruntime?: { app?: { tick?: (t: number) => void } };
    });
    const app = rt.__gsruntime?.app ?? rt.__gsxrruntime?.app;
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

/** 等官方相机过渡完成并落在期望位置附近。 */
async function waitCameraNear(page: Page, expected: number[], tol = 0.06) {
  const end = Date.now() + 90_000;
  let last: number[] | null = null;
  while (Date.now() < end) {
    await pumpEngine(page, 250);
    const cam = (await readDiag(page)).camera as { position: number[] } | null;
    last = cam?.position ?? null;
    if (last && dist(last, expected) < tol) return;
  }
  expect(
    last && dist(last, expected),
    `相机应过渡到 ${JSON.stringify(expected)}，实际 ${JSON.stringify(last)}`,
  ).toBeLessThan(tol);
}

test.describe('GS-NEXT-04 Desktop —— 放行的官方标注导览器', () => {
  test('官方 Prev/Next 导览器：可见、序号/标题跟随、相机官方过渡到各标注相机', async ({ page }) => {
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 140)); });

    const res = await page.request.get(`${API}/annotations`);
    expect(res.status()).toBe(200);
    const anns = (await res.json()) as { id: string; title: string; enabled: boolean; orderIndex: number; cameraPosition: { x: number; y: number; z: number } }[];
    const live = anns.filter((a) => a.enabled !== false).sort((a, b) => a.orderIndex - b.orderIndex);
    // 官方导览器要求 ≥2 条才有 Prev/Next；本夹具 3 条。
    expect(live.length).toBeGreaterThanOrEqual(3);
    const cam = (i: number) => [live[i].cameraPosition.x, live[i].cameraPosition.y, live[i].cameraPosition.z];

    await openViewer(page);

    // ① 导览器已放行且可见（官方按「loaded && showAnnotations && ≥2 条」决定）
    await page.waitForFunction(() => {
      const nav = document.querySelector('.sse-ui > .sse-annotationNav');
      return !!nav && !nav.classList.contains('sse-hidden');
    }, { timeout: 30000 });
    let nav = await readNav(page);
    console.log('nav initial:', JSON.stringify(nav));
    expect(nav.visible).toBe(true);
    expect(nav.number).toBe('1');
    expect(nav.title).toBe(live[0].title);

    // ② Next → 第 2 条：序号/标题更新 + 相机官方过渡到该标注的作者化相机
    await clickNav(page, 'next');
    await page.waitForFunction(
      (t) => document.querySelector('.sse-annotationNavTitle')?.textContent?.trim() === t,
      live[1].title,
      { timeout: 20000 },
    );
    await waitCameraNear(page, cam(1));
    nav = await readNav(page);
    console.log('nav after next:', JSON.stringify(nav), 'cam', JSON.stringify((await readDiag(page)).camera.position));
    expect(nav.number).toBe('2');
    expect(nav.title).toBe(live[1].title);
    expect(dist((await readDiag(page)).camera.position, cam(1))).toBeLessThan(0.06);
    // 三条标注相机互不相同 → 确实在切换，不是原地不动
    expect(dist(cam(0), cam(1))).toBeGreaterThan(0.5);

    // ③ Next ×2 到第 3 条并**回绕**到第 1 条（官方循环导航）
    await clickNav(page, 'next');
    await waitCameraNear(page, cam(2));
    await clickNav(page, 'next');
    await page.waitForFunction(
      () => document.querySelector('.sse-annotationNavNumber')?.textContent?.trim() === '1',
      undefined,
      { timeout: 20000 },
    );
    await waitCameraNear(page, cam(0));

    // ④ Prev 从第 1 条回绕到第 3 条
    await clickNav(page, 'prev');
    await page.waitForFunction(
      () => document.querySelector('.sse-annotationNavNumber')?.textContent?.trim() === '3',
      undefined,
      { timeout: 20000 },
    );
    await waitCameraNear(page, cam(2));
  });

  test('GS-DESKTOP-02：官方原生 chrome 可见，且不拦截 canvas 拖拽', async ({ page }) => {
    await openViewer(page);

    // ① GS-DESKTOP-02：官方 chrome 现在可见（原生 UI 完整保留）。
    await expect(page.locator('.sse-controlsWrap')).toBeVisible();
    // 官方控件中心点不被宿主覆盖层遮挡（否则会吃掉 canvas 鼠标事件）。
    const hit = await page.evaluate(() => {
      const el = document.querySelector('.sse-controlsWrap');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { tag: top?.tagName ?? null, inside: !!top && (el.contains(top) || (top as HTMLElement).contains(el)) };
    });
    expect(hit?.inside).toBe(true);

    // ② canvas 拖拽仍然驱动官方相机（证明没有额外 overlay 吞事件）
    const before = (await readDiag(page)).camera.position;
    const box = (await page.locator('[data-testid="scene-viewer-page"] canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 140, cy + 30, { steps: 14 });
    await page.mouse.up();
    await page.waitForFunction(
      (prev: number[]) => {
        const el = document.querySelector('[data-testid="ov-diagnostics"]');
        if (!el) return false;
        const c = JSON.parse(el.textContent ?? '{}').camera;
        if (!c) return false;
        return Math.hypot(c.position[0] - prev[0], c.position[1] - prev[1], c.position[2] - prev[2]) > 0.05;
      },
      before,
      { timeout: 15000 },
    );
  });
});

test.describe('GS-NEXT-04 XR —— 进入 VR 前选择导览点', () => {
  test('导览点用官方标注相机作为出生位姿；与观察点互斥', async ({ page }) => {
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 140)); });

    const res = await page.request.get(`${API}/annotations`);
    const anns = (await res.json()) as { id: string; title: string; enabled: boolean; orderIndex: number; cameraPosition: { x: number; y: number; z: number } }[];
    const live = anns.filter((a) => a.enabled !== false).sort((a, b) => a.orderIndex - b.orderIndex);
    const target = live[1];
    const expectPos = [target.cameraPosition.x, target.cameraPosition.y, target.cameraPosition.z];

    await page.goto(`/xr/${SCENE}`);
    await page.waitForSelector('[data-testid="xr-mount"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
      { timeout: 90000 },
    );

    const read = () => page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));

    const before = await read();
    console.log('XR before:', JSON.stringify(before.camera), 'gp=', before.guidePointCount);

    // ① 导览点分组出现，数量 = 具备自有相机的 enabled 标注数
    await expect(page.getByTestId('xr-guidepoint-group')).toBeVisible();
    expect(before.guidePointCount).toBe(live.length);
    await expect(page.getByTestId(`xr-guidepoint-${target.id}`)).toBeVisible();
    // 起点未选 = authored 初始视角
    await expect(page.getByTestId('xr-viewpoint-initial')).toHaveAttribute('aria-pressed', 'true');

    // ② 选中导览点 → 官方相机导航到该标注相机 + 出生位姿随之改变
    await page.getByTestId(`xr-guidepoint-${target.id}`).click();
    await page.waitForFunction(
      (pos: number[]) => {
        const d = JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}');
        return d.camera && Math.hypot(
          d.camera.position[0] - pos[0], d.camera.position[1] - pos[1], d.camera.position[2] - pos[2]) < 0.06;
      },
      expectPos,
      { timeout: 25000 },
    );
    const after = await read();
    console.log('XR after gp:', JSON.stringify(after.camera), after.selectedGuidePointId, after.xrSpawnStatus);

    expect(after.selectedGuidePointId).toBe(target.id);
    expect(after.xrSpawnStatus).not.toBe('not-authored'); // 出生位姿已被配置
    expect(dist(after.camera.position, expectPos)).toBeLessThan(0.06);
    expect(dist(before.camera.position, after.camera.position)).toBeGreaterThan(0.5);
    await expect(page.getByTestId(`xr-guidepoint-${target.id}`)).toHaveAttribute('aria-pressed', 'true');

    // ③ 与观察点互斥：改选观察点后导览点选中态被清掉
    const vpRes = await page.request.get(`${API}/viewpoints`);
    const vps = (await vpRes.json()) as { id: string; position: { x: number; y: number; z: number } }[];
    expect(vps.length).toBeGreaterThan(0);
    await page.getByTestId(`xr-viewpoint-${vps[0].id}`).click();
    const afterVp = await read();
    expect(afterVp.selectedViewpointId).toBe(vps[0].id);
    expect(afterVp.selectedGuidePointId).toBeNull();
    await expect(page.getByTestId(`xr-guidepoint-${target.id}`)).toHaveAttribute('aria-pressed', 'false');

    // ④ 回到「初始视角」→ 两者都清空，出生位姿 = authored 初始视角
    await page.getByTestId('xr-viewpoint-initial').click();
    const reset = await read();
    expect(reset.selectedViewpointId).toBeNull();
    expect(reset.selectedGuidePointId).toBeNull();
  });

  test('无自有相机的标注**不得**出现在导览点分组（不得回落成初始视角假承诺）', async ({ page, request }: { page: Page; request: ApiRequest }) => {
    const created = await request.post(`${API}/annotations`, {
      data: {
        title: 'GS-NEXT-04 无相机热点',
        anchorX: 1, anchorY: 1, anchorZ: 1,
        style: 'LEADER_TEXT', contentType: 'TEXT', textContent: 'no camera',
      },
    });
    expect(created.status()).toBe(201);
    const createdId = (await created.json() as { id: string }).id;

    try {
      await page.goto(`/xr/${SCENE}`);
      await page.waitForSelector('[data-testid="xr-mount"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="diag-state-loaded"]')?.textContent?.trim() === 'true',
        { timeout: 90000 },
      );
      // 它确实是场景里的标注，但不得被当成导览点。
      const res = await request.get(`${API}/annotations`);
      const all = (await res.json()) as { id: string; cameraPosition: unknown }[];
      expect(all.some((a) => a.id === createdId)).toBe(true);
      await expect(page.getByTestId('xr-guidepoint-group')).toBeVisible();
      await expect(page.getByTestId(`xr-guidepoint-${createdId}`)).toHaveCount(0);
      const diag = await page.evaluate(() =>
        JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
      const eligible = all.filter((a) => a.cameraPosition != null).length;
      expect(diag.guidePointCount).toBe(eligible);
    } finally {
      await request.delete(`${API}/annotations/${createdId}`);
    }
  });
});