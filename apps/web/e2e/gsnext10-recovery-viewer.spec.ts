/**
 * GS-NEXT-10 §五 —— 软删除 → 恢复 → Web Viewer 正常加载（真实浏览器）。
 *
 * 覆盖恢复链路：
 *   1. descriptor 基线（版本内容 + 视角 ID 集合）；
 *   2. 所有者软删除 200，重复删除幂等 200；
 *   3. 删除后：所有者 detail 404、runtime 404、回收站列表可见且 isDeleted=true；
 *   4. 授权恢复 200，**紧接着**的第一次 detail 读取就 200（读己所写）；
 *   5. 恢复后：Web Viewer 用真实 SOG 正常加载（无 mock）；
 *   6. descriptor 与删除前逐字节一致，且 approach 视角未被改动
 *      （历史 SceneVersion / current 指针未被恢复动作碰过）。
 *
 * 顺序说明：删除放在 Viewer 加载**之前**。`soft_delete` 在场景存在活动作业时
 * 按设计返回 409（「场景仍有正在运行的任务，无法删除」），而 Viewer 侧可能触发
 * 构建作业；把删除放在加载之前，这条恢复链路不受作业状态影响，用例可重复执行。
 * 删除前后的对比因此用 descriptor（版本内容 + 视角集合），而不是「先打开一次
 * Viewer」。
 *
 * 前置：夹具由 scripts/gsnext10_seed_recovery_fixture.py 播种到隔离库
 * （自带 scene-origin 根；脚本会清掉该场景的历史作业行）。
 */
import { expect, test } from './fresh-browser';

const SCENE = 'gsnext10-recovery';
const API = `/api/v1/scenes/${SCENE}`;

async function runtime(request: import('@playwright/test').APIRequestContext) {
  const r = await request.get(`${API}/runtime`);
  expect(r.status(), 'runtime descriptor').toBe(200);
  return r.json();
}

async function viewerLoaded(page: import('@playwright/test').Page) {
  // ?diagnostics=1：诊断读数按 50ms 采样（生产 1s）；否则 loaded=true 会先于
  // gsplats 读数刷新，出现「已加载但 gsplats 仍是 0」的假读数。
  await page.goto(`/scene/${SCENE}?diagnostics=1`);
  await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
  await page.waitForSelector('canvas', { state: 'visible', timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ov-diagnostics"]');
      try {
        const d = JSON.parse(el?.textContent ?? '{}');
        return d.loaded === true && Number(d.gsplats ?? 0) > 0;
      } catch { return false; }
    },
    undefined,
    { timeout: 180_000 },
  );
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'));
}

test.describe.configure({ timeout: 600_000 });

test('软删除 → 授权恢复 → Web Viewer 正常加载，且历史版本与 current 指针不变', async ({ page, request }) => {
  // ── 0) 删除前基线（descriptor 层；改动了什么一眼可查）──
  const before = await runtime(request);
  const beforeContent = JSON.stringify(before.content ?? {});
  const beforeViewpoints = (before.viewpoints ?? []).map((v: { id: string }) => v.id);
  expect(beforeViewpoints.length, '夹具应自带一个视角').toBeGreaterThan(0);

  // ── 1) 所有者软删除：200；立即重复删除幂等 200 ──
  const del = await request.delete(API);
  expect(del.status(), '软删除').toBe(200);
  const delAgain = await request.delete(API);
  expect(delAgain.status(), '重复删除应幂等').toBe(200);

  // ── 2) 已删除：所有者详情 404、runtime 404，但回收站能看到（可找回）──
  expect((await request.get(API)).status()).toBe(404);
  expect((await request.get(`${API}/runtime`)).status()).toBe(404);

  const bin = await request.get('/api/v1/me/scenes?includeDeleted=true&limit=100');
  expect(bin.status()).toBe(200);
  const mine = ((await bin.json()).items as { id: string; isDeleted?: boolean }[])
    .filter((s) => s.id === SCENE);
  expect(mine.length, '回收站应能看到自己的已删除作品').toBe(1);
  expect(mine[0].isDeleted).toBe(true);
  // 非所有者的 403 与「他人看不出已删除场景」由后端集成测试用真实第二用户覆盖
  // （apps/api/tests/test_gsnext10_recovery.py）；浏览器进程只绑一个 dev 身份。

  // ── 3) 所有者恢复：200；紧接着的第一次读就是活的 ──
  expect((await request.post(`${API}/restore`, { data: {} })).status(), '恢复').toBe(200);
  expect((await request.get(API)).status(), '恢复后详情应立即可读').toBe(200);

  // ── 4) 恢复后 descriptor 与删除前一致（版本/视角未变）──
  const after = await runtime(request);
  expect(JSON.stringify(after.content ?? {}), 'current 指针对应的内容不应改变').toBe(beforeContent);
  expect((after.viewpoints ?? []).map((v: { id: string }) => v.id)).toEqual(beforeViewpoints);

  // ── 5) 恢复后：Web Viewer 用真实 SOG 正常加载 ──
  const diag = await viewerLoaded(page);
  console.log('after restore: loaded=', diag.loaded, 'gsplats=', diag.gsplats, 'format=', diag.format);
  expect(diag.loaded).toBe(true);
  expect(Number(diag.gsplats ?? 0)).toBeGreaterThan(0);
  expect(String(diag.format)).toBe('sog');
});
