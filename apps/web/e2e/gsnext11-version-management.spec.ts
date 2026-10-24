/**
 * GS-NEXT-11 §7 — 场景版本管理与安全回滚（真实浏览器 / 真实资产）。
 *
 * 夹具（scripts/gsnext11_seed_versions_fixture.py）：
 *   - A = streamed-sog（真实 lod-meta.json + chunk 目录）
 *   - B = sog（真实单文件 scene.sog）
 * 两者都是真实可加载的不可变版本；初始 current = A。
 *
 * 覆盖：
 *   1. 版本列表（当前版本标记、两个真实版本）；
 *   2. 回滚 A → B 后，下一次独立请求与 Web Viewer 都真的加载 B；
 *   3. 历史版本字节在切换前后保持不变；
 *   4. B → A 再切回，Viewer 真的加载回 A；
 *   5. 切换后空间配置 STALE：descriptor 不再下发 initialCamera / viewpoints，
 *      Web 与 XR 共用同一 descriptor（同一 contentUrl）；
 *   6. 创作页版本面板：列表 / 当前标记 / 确认切换 / 成功提示 / 空间重确认提示。
 */
import { createHash } from 'node:crypto';
import { expect, test } from './fresh-browser';

const SCENE = 'gsnext11-versions';
const API = `/api/v1/scenes/${SCENE}`;
const A_VERSION = 'd1a111111111';
const B_VERSION = 'd1b222222222';
const A_ENTRY_BYTES = 476;
const B_ENTRY_BYTES = 292618;

type VersionItem = {
  id: string;
  assetVersion: string;
  format: string;
  isCurrent: boolean;
  assetsReady: boolean;
  manifestReady: boolean;
  gaussianCount: number | null;
};

async function versions(request: import('@playwright/test').APIRequestContext) {
  const r = await request.get(`${API}/versions`);
  expect(r.status(), 'versions').toBe(200);
  return r.json() as Promise<{
    items: VersionItem[];
    currentVersionId: string | null;
    spatial: { state: string; requiresConfirmation: boolean };
  }>;
}

async function descriptor(request: import('@playwright/test').APIRequestContext) {
  const r = await request.get(`${API}/runtime`);
  expect(r.status(), 'runtime').toBe(200);
  return r.json();
}

async function activate(
  request: import('@playwright/test').APIRequestContext,
  versionId: string,
  expectedCurrentVersionId: string | null,
) {
  return request.post(`${API}/versions/${versionId}/activate`, {
    data: { expectedCurrentVersionId },
  });
}

async function viewerLoaded(page: import('@playwright/test').Page) {
  await page.goto(`/scene/${SCENE}?diagnostics=1`);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
  await page.waitForSelector('canvas', { state: 'visible', timeout: 90_000 });
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

test.describe.configure({ timeout: 600_000 });

test('回滚到历史版本后 Web Viewer 真的加载该版本，且历史字节不变', async ({ page, request }) => {
  // 收敛到夹具文档化的初始状态（A 为当前版本）。GS-NEXT-12 的空间重绑定
  // 用例会切换并恢复版本，单靠执行顺序不能保证这里读到 A；与下一个用例
  // 一样先归一化，断言本身不放松。
  let initial = await versions(request);
  const aId = initial.items.find((i) => i.assetVersion === A_VERSION)!.id;
  if (initial.currentVersionId !== aId) {
    const normalized = await activate(request, aId, initial.currentVersionId);
    expect(normalized.status(), await normalized.text()).toBe(200);
    initial = await versions(request);
  }
  expect(initial.items).toHaveLength(2);
  const a = initial.items.find((i) => i.assetVersion === A_VERSION)!;
  const b = initial.items.find((i) => i.assetVersion === B_VERSION)!;
  expect(a.assetsReady && b.assetsReady).toBe(true);
  expect(initial.currentVersionId).toBe(a.id);

  // ── 1) 当前 = A：Viewer 加载的是 A 的真实 streamed SOG ──
  const beforeA = await descriptor(request);
  expect(beforeA.content.url).toContain(`versions/${A_VERSION}/lod-meta.json`);
  const viewerA = await viewerLoaded(page);
  expect(viewerA.format).toBe('lod-meta');
  expect(String(viewerA.contentUrl)).toContain(A_VERSION);
  expect(Number(viewerA.gsplats)).toBeGreaterThan(0);

  // 历史资产的基线（A 与 B 的入口字节）。
  const aBytesBefore = await (await request.get(`${API}/assets/versions/${A_VERSION}/lod-meta.json`)).body();
  const bBytesBefore = await (await request.get(`${API}/assets/versions/${B_VERSION}/scene.sog`)).body();
  expect(aBytesBefore.length).toBe(A_ENTRY_BYTES);
  expect(bBytesBefore.length).toBe(B_ENTRY_BYTES);
  const bShaBefore = createHash('sha256').update(bBytesBefore).digest('hex');

  // ── 2) 回滚 A → B（客户端带 expectedCurrentVersionId）──
  const switched = await activate(request, b.id, a.id);
  expect(switched.status(), await switched.text()).toBe(200);
  const switchBody = await switched.json();
  expect(switchBody.changed).toBe(true);
  expect(switchBody.previousVersionId).toBe(a.id);
  expect(switchBody.currentVersionId).toBe(b.id);
  expect(switchBody.spatial.state).toBe('STALE');
  expect(switchBody.spatial.requiresConfirmation).toBe(true);
  expect(switchBody.affectedSpatialFeatures).toEqual(
    expect.arrayContaining(['initialCamera', 'viewpoints']),
  );

  // ── 3) 下一次独立请求读到 B；descriptor 与 XR 同源 ──
  const afterList = await versions(request);
  expect(afterList.currentVersionId).toBe(b.id);
  expect(afterList.items.find((i) => i.id === b.id)!.isCurrent).toBe(true);

  const afterB = await descriptor(request);
  expect(afterB.content.url).toContain(`versions/${B_VERSION}/scene.sog`);
  expect(afterB.content.format).toBe('sog');
  // STALE 保护：初始视角 / 视点不再下发（保存的数据仍在数据库里）。
  expect(afterB.presentation.initialCamera?.position ?? null).toBeNull();
  expect(afterB.viewpoints).toEqual([]);

  // ── 4) Web Viewer 真的加载 B 的真实单文件 SOG ──
  const viewerB = await viewerLoaded(page);
  expect(viewerB.format).toBe('sog');
  expect(String(viewerB.contentUrl)).toContain(B_VERSION);
  expect(Number(viewerB.gsplats)).toBeGreaterThan(50_000);

  // ── 5) 历史版本字节未被改动（内容寻址，不可变）──
  const aBytesAfter = await (await request.get(`${API}/assets/versions/${A_VERSION}/lod-meta.json`)).body();
  const bBytesAfter = await (await request.get(`${API}/assets/versions/${B_VERSION}/scene.sog`)).body();
  expect(aBytesAfter.equals(aBytesBefore)).toBe(true);
  expect(bBytesAfter.equals(bBytesBefore)).toBe(true);
  expect(createHash('sha256').update(bBytesAfter).digest('hex')).toBe(bShaBefore);

  // ── 6) 再切回 A：Viewer 真的回到 A ──
  const back = await activate(request, a.id, b.id);
  expect(back.status(), await back.text()).toBe(200);
  const backBody = await back.json();
  expect(backBody.currentVersionId).toBe(a.id);
  const afterA = await descriptor(request);
  expect(afterA.content.url).toContain(`versions/${A_VERSION}/lod-meta.json`);
  const viewerA2 = await viewerLoaded(page);
  expect(viewerA2.format).toBe('lod-meta');
  expect(String(viewerA2.contentUrl)).toContain(A_VERSION);
  // 回滚后碰撞/行走不得自动恢复为可用（STALE 保护持续生效）。
  expect(afterA.collision?.enabled ?? false).toBe(false);
});

test('创作页版本面板：列表、确认切换、成功反馈与空间重确认提示', async ({ page, request }) => {
  // 收敛到确定状态（A 为当前版本）。
  const now = await versions(request);
  if (now.currentVersionId !== now.items.find((i) => i.assetVersion === A_VERSION)?.id) {
    const aId = now.items.find((i) => i.assetVersion === A_VERSION)!.id;
    const resp = await activate(request, aId, now.currentVersionId);
    expect(resp.status(), await resp.text()).toBe(200);
  }

  await page.goto(`/model/edit/${SCENE}`);
  await page.waitForSelector('[data-testid="scene-authoring-page"]');
  // GS-DESKTOP-02：版本/回滚属于**平台管理**，已从创作页内联面板迁到
  // 顶栏「版本历史」抽屉（功能与断言不变，只是入口位置不同）。
  await page.getByRole('button', { name: '版本历史' }).click();
  const panel = page.getByTestId('version-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText('历史版本')).toBeVisible();

  const items = panel.locator('[data-testid^="version-item-"]');
  await expect(items).toHaveCount(2, { timeout: 30_000 });
  const current = panel.locator('[data-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current.getByText('当前版本')).toBeVisible();

  // 切换按钮只出现在非当前版本上。
  const currentId = (await current.getAttribute('data-testid'))!.replace('version-item-', '');
  const activateButtons = panel.locator('[data-testid^="version-activate-"]');
  await expect(activateButtons).toHaveCount(1);
  const targetId = (await activateButtons.first().getAttribute('data-testid'))!
    .replace('version-activate-', '');
  expect(targetId).not.toBe(currentId);

  await activateButtons.first().click();
  // 明确的二次确认（不会「点一下就切」）。
  const confirm = page.locator('.ant-popconfirm-buttons .ant-btn-primary');
  await expect(confirm).toBeVisible();
  await confirm.click();

  // 成功反馈 + 列表重新读取（当前标记移动）走的是服务器真相。
  await expect(panel.getByTestId('version-feedback')).toContainText('已切换', { timeout: 30_000 });
  await expect(panel.locator(`[data-testid="version-item-${targetId}"][data-current="true"]`)).toBeVisible({ timeout: 30_000 });
  // 空间配置需要重新确认的提示必须出现。
  await expect(panel.getByTestId('version-spatial-stale')).toBeVisible();
});