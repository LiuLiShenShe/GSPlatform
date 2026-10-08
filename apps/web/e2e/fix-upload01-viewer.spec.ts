/**
 * FIX-UPLOAD-01 §23 — 真实 Viewer browser load（DB-backed published scene）。
 *
 * 断言：通过 HTTP 上传 + 真实 Celery publish 产生的 DB 场景
 * ``u-48d08a87c1c1``（§21 真实 E2E 产物）在官方 viewer 中真实加载 ——
 * descriptor 从 DB 解析（非 manifest 回退），content.url 指向
 * ``/api/v1/scenes/.../assets/versions/.../lod-meta.json``，官方 runtime
 * 消费 SOG chunk 请求并渲染出 gsplats>0，同时 runtime 携带 voxel 碰撞
 * 描述（enabled=false，非 stale）。这是「真实 viewer browser load」门禁。
 */
import { expect, test } from './fresh-browser';

test.describe('FIX-UPLOAD-01 Viewer load（DB 发布场景）', () => {
  test('真实 E2E 发布的 streamed-sog 场景被官方 viewer 加载并渲染', async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('[page-error]', m.text());
    });
    const chunkReqs: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/api/v1/scenes/u-48d08a87c1c1/') && /\.(webp|json|bin)$/.test(u)) {
        chunkReqs.push(new URL(u).pathname);
      }
    });

    await page.goto('/scene/u-48d08a87c1c1');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]', {
      timeout: 60000,
    });
    await page.waitForSelector('canvas', { state: 'visible', timeout: 90000 });

    // 进入流式：progress ≥ 1 且 gsplats > 0（headless SwiftShader 软件渲染下
    // 59,400 gaussians 真实渲染，非 mock）。
    const diagEl = '[data-testid="ov-diagnostics"]';
    await page.waitForFunction(
      (sel) => {
        const node = document.querySelector(sel);
        if (!node) return false;
        try {
          const j = JSON.parse(node.textContent ?? '{}');
          return j.progress > 0 && (j.gsplats ?? 0) > 0;
        } catch {
          return false;
        }
      },
      diagEl,
      { timeout: 180000 },
    );
    const diag = await page.evaluate(() =>
      JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'),
    );
    console.log('diag:', JSON.stringify(diag).slice(0, 600));
    expect(diag.renderer).toBe('webgpu');
    expect(diag.isManifestFallback).toBe(false); // DB 发布场景，非 manifest 回退
    expect(diag.format).toBe('lod-meta');
    expect(diag.contentUrl as string).toContain('assets/versions/f68200c27c63/lod-meta.json');
    expect((diag.gsplats as number) ?? 0).toBeGreaterThan(0);

    // 官方 runtime 应已发出分段 chunk 请求（*.webp / *.json）。
    await page.waitForTimeout(3000);
    console.log('chunkRequests:', chunkReqs.length, 'sample:', chunkReqs.slice(0, 4));
    expect(chunkReqs.length).toBeGreaterThan(0);

    // 碰撞真相随 ov-diagnostics 下发。默认策略 collision_enabled=false：
    // viewer 不启用碰撞（hasCollision=false / collisionFormat=null），但碰撞
    // 已构建且与当前版本一致（collisionStale=false —— sourceVersion 绑定，
    // 由 runtime descriptor 对 DB 真实校验）。walk 因未启用而禁用（诚实默认）。
    console.log(
      'collision:',
      diag.hasCollision,
      diag.collisionFormat,
      'stale=' + diag.collisionStale,
      'effectiveWalkAllowed=' + diag.effectiveWalkAllowed,
    );
    expect(diag.collisionStale).toBe(false); // 构建产物非 stale（版本绑定生效）
    expect(diag.effectiveWalkAllowed).toBe(false); // collision_enabled=false 默认策略 → walk 禁用
  });
});
