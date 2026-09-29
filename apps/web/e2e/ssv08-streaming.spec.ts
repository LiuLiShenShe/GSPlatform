/**
 * SSV-08 — 官方 LOD runtime（streamed SOG）桌面 + XR 验证。
 *
 * 场景（git-ignored scenes/ 树，dev 环境本地存在）：
 *   ssv08-large  —— streamed-sog（1.8M gaussians / 3 LOD，官方 lod-meta + Range chunks）
 *   ssv08-single  —— 同一内容的单文件 .sog（whole-blob 对照）
 *
 * 断言聚焦「官方 runtime 原生消费 LOD」：descriptor 走 manifest 回退
 * （DB 无此场景 → STREAMED_SOG_UNSUPPORTED 已删除，见 descriptorResolver），
 * content.format=lod-meta + content.url=*.lod-meta.json，官方 viewer 发出
 * 分段 chunk 请求并渲染。性能数据（首帧/gsplats/峰值内存/FPS）记录在
 * docs/reports/SSV_08_REPORT.md（探针采集，非本文件断言）。
 */
import { expect, test } from './fresh-browser';

async function readDiag(page: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  // 正常场景等 loaded；大 LOD 场景在 headless SwiftShader 软件渲染下渐进流式
  // 很慢（Vite dev 中间件逐文件 + 软件 WebP 解码），首帧可达分钟级 —— 断言
  // 用「已进入流式（progress ≥ 1 且 gsplats > 0）」而不是完整首帧。
  const el = '[data-testid="ov-diagnostics"]';
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
    el,
    { timeout: 180000 },
  );
  return page.evaluate(() =>
    JSON.parse(document.querySelector('[data-testid="ov-diagnostics"]')!.textContent ?? '{}'),
  );
}

test.describe('SSV-08 Desktop LOD runtime（WebGPU）', () => {
  test('streamed-sog 场景经 manifest 回退解析为 lod-meta 并被官方 viewer 消费', async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('[page-error]', m.text());
    });
    // 统计官方 viewer 发起的 chunk 请求（*.webp / meta.json / lod-meta.json）。
    const chunkReqs: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/local-scenes/ssv08-large/') && /\.(webp|json)$/.test(u)) {
        chunkReqs.push(new URL(u).pathname);
      }
    });

    await page.goto('/scene/ssv08-large');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    await page.waitForSelector('canvas', { state: 'visible', timeout: 90000 });
    const diag = await readDiag(page);
    console.log('diag renderer/gsplats/format:', diag.renderer, diag.gsplats, diag.format);
    expect(diag.renderer).toBe('webgpu');
    expect(diag.isManifestFallback).toBe(true); // DB 404 → manifest 回退（不再拒绝）
    expect(diag.format).toBe('lod-meta');
    expect(diag.contentUrl as string).toContain('lod-meta.json');
    expect((diag.gsplats as number) ?? 0).toBeGreaterThan(0);

    // 等流式继续：chunk 请求应已发生（官方 Range 分段）。
    await page.waitForTimeout(3000);
    console.log('chunkRequests:', chunkReqs.length, 'sample:', chunkReqs.slice(0, 3));
    expect(chunkReqs.length).toBeGreaterThan(0);
    expect(chunkReqs.some((p) => p.endsWith('lod-meta.json'))).toBe(true);
  });

  test('单文件 .sog（同一内容）也经官方 runtime 加载', async ({ page }) => {
    await page.goto('/scene/ssv08-single');
    await page.waitForSelector('[data-testid="scene-viewer-page"][data-runtime="official"]');
    const diag = await readDiag(page);
    expect(diag.format).toBe('sog');
    expect((diag.gsplats as number) ?? 0).toBeGreaterThan(1_000_000); // whole-blob 全量
  });
});

test.describe('SSV-08 XR（WebGL，§8 测试对象）', () => {
  test('LOD 场景在 XR 页面（强制 WebGL）加载且不破坏会话', async ({ page }) => {
    await page.goto('/xr/ssv08-large');
    await page.waitForSelector('[data-testid="xr-mount"]');
    // 软件 WebGL 下渐进流式同样慢 —— 断言流式已激活（gsplats > 0）。
    await page.waitForFunction(
      () => {
        const t = document.querySelector('[data-testid="diag-gsplats"]');
        const n = Number(t?.textContent?.trim() ?? 0);
        return n > 0;
      },
      undefined,
      { timeout: 180000 },
    );
    const renderer = await page.locator('[data-testid="diag-renderer"]').textContent();
    const gsplats = await page.locator('[data-testid="diag-gsplats"]').textContent();
    console.log('XR renderer:', renderer, 'gsplats:', gsplats);
    // XR 强制 WebGL（playcanvas 设备类型为 webgl2），不是 webgpu。
    expect((renderer ?? '').trim()).toMatch(/^webgl/i);
    expect(Number((gsplats ?? '0').trim())).toBeGreaterThan(0);
  });
});
