/**
 * GS-NEXT-12 §A —— 空间配置重新绑定（真实浏览器 / 真实资产）。
 *
 * GS-NEXT-11 的遗留缺陷：版本一切换，空间配置整体 STALE，之后**没有任何**
 * 重新确认入口 —— 用户在当前版本重新保存的初始视角依然被描述符屏蔽，
 * 场景的初始相机、观察点、标注永远回不来（P1）。
 *
 * 本文件验证任务书要求的主链路：
 *   1) 在 A 版本保存初始视角 + 观察点 + 标注；
 *   2) 切换到 B（旧空间配置 STALE，运行态不再下发）；
 *   3) 在 B 重新保存初始视角；
 *   4) 关闭页面 → 重新打开；
 *   5) Web 与 XR 描述符都采用 B 的新视角；
 *   6) A 的旧观察点 / 旧标注不会被错误重新启用。
 *
 * 夹具复用 scripts/gsnext11_seed_versions_fixture.py（A=streamed / B=sog）。
 * 用例本身自建 A 版本的空间数据，因此可重复执行。
 */
import { expect, test } from './fresh-browser';

const SCENE = 'gsnext11-versions';
const API = `/api/v1/scenes/${SCENE}`;
const A_VERSION = 'd1a111111111';
const B_VERSION = 'd1b222222222';

const CAM_A = {
  position: { x: 3.1, y: 1.9, z: 6.4 },
  target: { x: 0.0, y: 0.6, z: 0.0 },
  fov: 46.0,
};
/** B 版本的重新保存视角：与 A 明显不同，且不是默认鸟瞰。 */
const CAM_B = {
  position: { x: -2.6, y: 1.35, z: 3.2 },
  target: { x: 0.2, y: 0.75, z: -0.4 },
  fov: 58.0,
};

type ApiRequest = import('@playwright/test').APIRequestContext;
type Descriptor = any;

/** The viewer's reported target is `position + forward * focusDistance`, so the
 *  stable invariant is the view DIRECTION, not the absolute target point. */
function direction(position: number[], target: number[]): number[] {
  const d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const len = Math.hypot(...d) || 1;
  return d.map((v) => v / len);
}

function expectSameView(cam: any, expected: { position: any; target: any }, precision = 1) {
  expect(cam).not.toBeNull();
  expect(cam.position[0]).toBeCloseTo(expected.position.x, precision);
  expect(cam.position[1]).toBeCloseTo(expected.position.y, precision);
  expect(cam.position[2]).toBeCloseTo(expected.position.z, precision);
  const actual = direction(cam.position, cam.target);
  const wanted = direction(
    [expected.position.x, expected.position.y, expected.position.z],
    [expected.target.x, expected.target.y, expected.target.z],
  );
  const dot = actual[0] * wanted[0] + actual[1] * wanted[1] + actual[2] * wanted[2];
  expect(dot).toBeGreaterThan(0.995);
}

async function versions(request: ApiRequest) {
  const r = await request.get(`${API}/versions`);
  expect(r.status(), 'versions').toBe(200);
  return r.json();
}

async function descriptor(request: ApiRequest): Promise<Descriptor> {
  const r = await request.get(`${API}/runtime`);
  expect(r.status(), 'runtime').toBe(200);
  return r.json();
}

async function activate(request: ApiRequest, versionId: string, expected: string | null) {
  return request.post(`${API}/versions/${versionId}/activate`, {
    data: { expectedCurrentVersionId: expected },
  });
}

/** dev bypass 无 CSRF；null 字段服务端忽略，不要传。 */
async function patchPresentation(request: ApiRequest, body: Record<string, unknown>) {
  const r = await request.patch(`${API}/presentation`, { data: body });
  expect(r.status(), `PATCH /presentation ${JSON.stringify(body)}`).toBe(200);
}

async function clearSpatialAuthoring(request: ApiRequest) {
  const vps = await (await request.get(`${API}/viewpoints`)).json();
  for (const vp of vps) {
    await request.delete(`${API}/viewpoints/${vp.id}`);
  }
  const anns = await (await request.get(`${API}/annotations`)).json();
  for (const ann of anns) {
    await request.delete(`${API}/annotations/${ann.id}`);
  }
}

async function openViewer(page: import('@playwright/test').Page): Promise<Descriptor> {
  await page.goto(`/scene/${SCENE}?diagnostics=1`);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      try {
        const d = JSON.parse(el?.textContent ?? '{}');
        return d.loaded === true && Number(d.gsplats ?? 0) > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 180_000 },
  );
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'));
}

async function openXrPage(page: import('@playwright/test').Page): Promise<Descriptor> {
  await page.goto(`/xr/${SCENE}`);
  await page.waitForSelector('[data-testid="ov-xr-diagnostics"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ov-xr-diagnostics"]');
      try {
        const d = JSON.parse(el?.textContent ?? '{}');
        return d.loaded === true && Number(d.gsplats ?? 0) > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 180_000 },
  );
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-xr-diagnostics"]')!.textContent ?? '{}'));
}

async function currentIds(request: ApiRequest) {
  const listing = await versions(request);
  const a = listing.items.find((i: any) => i.assetVersion === A_VERSION)!;
  const b = listing.items.find((i: any) => i.assetVersion === B_VERSION)!;
  return { listing, a, b };
}

test.describe.configure({ timeout: 600_000 });

test('A→B→在 B 重新保存初始视角→重开页面：Web 与 XR 都采用 B 的新视角', async ({ page, request }) => {
  // ── 0) 确定状态：A 为当前版本，清掉旧用例留下的空间数据 ──
  let { listing, a, b } = await currentIds(request);
  if (listing.currentVersionId !== a.id) {
    const resp = await activate(request, a.id, listing.currentVersionId);
    expect(resp.status(), await resp.text()).toBe(200);
  }
  await clearSpatialAuthoring(request);

  // ── 1) 在 A 版本保存初始视角 + 观察点 + 标注 ──
  await patchPresentation(request, {
    initialCameraPosition: CAM_A.position,
    initialCameraTarget: CAM_A.target,
    initialCameraFov: CAM_A.fov,
  });
  const vpResp = await request.post(`${API}/viewpoints`, {
    data: { name: 'A 专属视角', position: CAM_A.position, target: CAM_A.target, fov: 50 },
  });
  expect(vpResp.status(), await vpResp.text()).toBe(201);
  const vpA = await vpResp.json();
  const annResp = await request.post(`${API}/annotations`, {
    data: { title: 'A 专属标注', anchorX: 0.5, anchorY: 1.0, anchorZ: 0.3 },
  });
  expect(annResp.status(), await annResp.text()).toBe(201);
  const annA = await annResp.json();

  const before = await descriptor(request);
  expect(before.presentation.initialCamera?.position).toEqual(CAM_A.position);
  expect(before.viewpoints.map((v: any) => v.id)).toEqual([vpA.id]);
  expect(before.annotations.map((v: any) => v.id)).toEqual([annA.id]);

  // ── 2) 切到 B：旧空间配置 STALE，运行态不再下发 ──
  const switched = await activate(request, b.id, a.id);
  expect(switched.status(), await switched.text()).toBe(200);
  const switchBody = await switched.json();
  expect(switchBody.spatial.state).toBe('STALE');
  expect(switchBody.spatial.pendingFeatures).toEqual(
    expect.arrayContaining(['initialCamera', 'viewpoints', 'annotations']),
  );

  const afterSwitch = await descriptor(request);
  expect(afterSwitch.presentation.initialCamera?.position ?? null).toBeNull();
  expect(afterSwitch.viewpoints).toEqual([]);
  expect(afterSwitch.annotations).toEqual([]);
  // A 的旧观察点没有被删，只是不参与当前版本。
  const vpList = await (await request.get(`${API}/viewpoints`)).json();
  expect(vpList.map((v: any) => v.id)).toEqual([vpA.id]);

  // ── 3) 在 B 重新保存初始视角（唯一的重新确认动作）──
  await patchPresentation(request, {
    initialCameraPosition: CAM_B.position,
    initialCameraTarget: CAM_B.target,
    initialCameraFov: CAM_B.fov,
  });

  // ── 4) 关闭页面 → 重新打开 Web Viewer ──
  const webDiag = await openViewer(page);
  expectSameView(webDiag.camera, CAM_B);
  expect(String(webDiag.contentUrl)).toContain(B_VERSION);

  // ── 5) XR 诊断页用同一份描述符：同一视角、同一资产 ──
  const xrDiag = await openXrPage(page);
  expectSameView(xrDiag.camera, CAM_B);
  expect(xrDiag.contentUrl).toBe(String(webDiag.contentUrl));
  // A 的旧观察点仍未启用：预进入态视点数为 0。
  expect(Number(xrDiag.viewpointCount ?? 0)).toBe(0);

  // ── 6) 版本列表如实报告分项状态 ──
  const after = await versions(request);
  expect(after.currentVersionId).toBe(b.id);
  expect(after.spatial.state).toBe('STALE');
  expect(after.spatial.pendingFeatures).toEqual(
    expect.arrayContaining(['viewpoints', 'annotations']),
  );
  expect(after.spatial.pendingFeatures).not.toContain('initialCamera');
  expect(after.spatial.confirmedFeatures).toContain('initialCamera');

  // ── 7) 清理：删除本用例创建的 A 版本空间数据（历史数据语义不删除）──
  await request.delete(`${API}/viewpoints/${vpA.id}`);
  await request.delete(`${API}/annotations/${annA.id}`);

  // 把当前版本恢复成本用例开始时的状态，避免污染共用夹具的其它用例
  // （GS-NEXT-11 的 Viewer 用例以“A 为当前版本”为前提）。
  const restoreId = listing.currentVersionId;
  if (restoreId) {
    const now = await versions(request);
    if (now.currentVersionId !== restoreId) {
      const restored = await activate(request, restoreId, now.currentVersionId);
      expect(restored.status(), await restored.text()).toBe(200);
    }
    expect((await versions(request)).currentVersionId).toBe(restoreId);
  }
});
