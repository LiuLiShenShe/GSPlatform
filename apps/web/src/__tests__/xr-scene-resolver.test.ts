/**
 * WebXR 修复任务（第二轮）— sceneResolver 测试（§12）。
 *
 * 关键回归：schemaVersion=1 只是 manifest schema 版本，不等价于 streamed-sog。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSceneForXR } from '../xr/sceneResolver';
import { XRSceneError } from '../xr/xrTypes';

const realFetch = globalThis.fetch;

/** 让 fetch 返回指定 JSON body（模拟 manifest）。 */
function mockManifest(body: unknown, ok = true, status = 200): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  // 每个测试都显式设置 mock，避免依赖上一个
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('sceneResolver — streamed-sog 判定（§11/§12）', () => {
  it('Case A: { schemaVersion: 1, format: "sog", assetUrl } → 允许（不误判 streamed）', async () => {
    mockManifest({
      id: 'legacy-schema1',
      title: 'Legacy schema1',
      format: 'sog',
      assetUrl: '/local-scenes/legacy-schema1/scene.sog',
    });
    const scene = await resolveSceneForXR('legacy-schema1');
    expect(scene.sceneId).toBe('legacy-schema1');
    expect(scene.contentUrl).toBe('/local-scenes/legacy-schema1/scene.sog');
    expect(scene.streamed).toBe(false);
  });

  it('Case B: { schemaVersion: 1, format: "streamed-sog" } → STREAMED_SOG_UNSUPPORTED', async () => {
    mockManifest({
      schemaVersion: 1,
      sceneId: 'streamed-scene',
      format: 'streamed-sog',
      stream: { entryUrl: 'versions/abc/lod-meta.json' },
    });
    await expect(resolveSceneForXR('streamed-scene')).rejects.toMatchObject({
      name: 'XRSceneError',
      code: 'STREAMED_SOG_UNSUPPORTED',
    });
  });

  it('Case C: 普通 legacy scene（无 schemaVersion）→ 正常返回', async () => {
    mockManifest({
      id: 'local-garden',
      title: '示例庭院',
      format: 'sog',
      assetUrl: '/local-scenes/local-garden/scene.sog',
      camera: { position: [0, 1.2, 3.5], target: [0, 0.8, 0], fov: 55 },
    });
    const scene = await resolveSceneForXR('local-garden');
    expect(scene.title).toBe('示例庭院');
    expect(scene.contentFilename).toBe('scene.sog');
  });

  it('Case D: stream 字段存在但无 format=streamed-sog → 仍判定为流式（字段真实存在）', async () => {
    mockManifest({
      schemaVersion: 1,
      format: 'sog',
      stream: { entryUrl: 'versions/xyz/lod-meta.json' },
    });
    await expect(resolveSceneForXR('has-stream')).rejects.toMatchObject({
      code: 'STREAMED_SOG_UNSUPPORTED',
    });
  });

  it('Case E: HTTP 404 → SCENE_NOT_FOUND', async () => {
    mockManifest({}, false, 404);
    await expect(resolveSceneForXR('missing')).rejects.toMatchObject({
      name: 'XRSceneError',
      code: 'SCENE_NOT_FOUND',
    });
  });

  it('Case F: 缺少 assetUrl → ASSET_FETCH_FAILED', async () => {
    mockManifest({ format: 'sog' });
    let caught: unknown;
    try {
      await resolveSceneForXR('no-asset');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(XRSceneError);
    expect((caught as XRSceneError).code).toBe('ASSET_FETCH_FAILED');
  });
});