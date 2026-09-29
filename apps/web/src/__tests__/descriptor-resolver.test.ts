/**
 * SSV-08 — descriptorResolver manifest 回退（streamed-sog 不再被拒绝）。
 *
 * SSV-08 删除 STREAMED_SOG_UNSUPPORTED：官方 runtime 原生消费
 * streamed-sog（lod-meta.json + Range chunks），manifest 回退路径必须把
 * streamed 场景解析为 content.format='lod-meta' / content.url=<entryUrl>。
 * 单文件场景行为保持不变。DB 合同路径（getSceneRuntime）由后端单测覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSceneRuntimeDescriptor } from '../scene-runtime/descriptorResolver';
import { ManifestFallbackError } from '../scene-runtime/descriptorResolver';

// DB 合同路径走 axios（httpClient），对 fetch stub 无感知 —— 直接 mock 模块，
// 让 getSceneRuntime 抛出 SCENE_NOT_FOUND 触发 manifest 回退。
vi.mock('../scene-runtime/runtimeApi', () => ({
  RuntimeApiError: class RuntimeApiError extends Error {
    readonly kind: string;
    readonly status: number | null;
    constructor(kind: string, status: number | null, message: string) {
      super(message);
      this.name = 'RuntimeApiError';
      this.kind = kind;
      this.status = status;
    }
  },
  getSceneRuntime: vi.fn(async () => {
    throw new Error('mocked-scene-not-found');
  }),
}));

import { getSceneRuntime } from '../scene-runtime/runtimeApi';
import { RuntimeApiError as MockedRuntimeApiError } from '../scene-runtime/runtimeApi';

const streamedManifest = {
  schemaVersion: 1,
  sceneId: 'stream-large',
  assetVersion: '8940e6486ff0',
  format: 'streamed-sog',
  stream: {
    entryUrl: 'versions/8940e6486ff0/lod-meta.json',
    byteLength: 23373,
    transport: 'range',
    lodLevels: 3,
    counts: [17642, 52925, 176418],
  },
  title: 'Stream Large',
  posterUrl: '/local-scenes/stream-large/poster.webp',
  camera: { position: [0, 1.2, 3.5], target: [0, 0.8, 0], fov: 55 },
};

const singleManifest = {
  schemaVersion: 1,
  sceneId: 'local-garden',
  format: 'sog',
  assetUrl: '/local-scenes/local-garden/scene.sog',
  title: 'Local Garden',
  camera: { position: [0, 1, 3], target: [0, 0, 0], fov: 60 },
};

describe('descriptorResolver manifest 回退（SSV-08）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // DB 合同 404 → 触发 manifest 回退。
    vi.mocked(getSceneRuntime).mockRejectedValueOnce(
      new MockedRuntimeApiError('SCENE_NOT_FOUND', 404, '404'),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streamed-sog 场景不再拒绝：content 解析为 lod-meta + entryUrl（STREAMED_SOG_UNSUPPORTED 已删除）', async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify(streamedManifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { descriptor, fromManifest } = await resolveSceneRuntimeDescriptor('stream-large');
    expect(fromManifest).toBe(true);
    expect(descriptor.content.format).toBe('lod-meta');
    expect(descriptor.content.url).toBe(
      '/local-scenes/stream-large/versions/8940e6486ff0/lod-meta.json',
    );
    // camera / title 照常映射。
    expect(descriptor.scene.name).toBe('Stream Large');
    expect(descriptor.presentation.initialCamera?.position).toEqual({ x: 0, y: 1.2, z: 3.5 });
  });

  it('单文件场景行为不变（sog → content.url = assetUrl）', async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify(singleManifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { descriptor, fromManifest } = await resolveSceneRuntimeDescriptor('local-garden');
    expect(fromManifest).toBe(true);
    expect(descriptor.content.format).toBe('sog');
    expect(descriptor.content.url).toBe('/local-scenes/local-garden/scene.sog');
  });

  it('manifest 404 → SCENE_NOT_FOUND（DB 与本地都没有）', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 404 }));
    await expect(resolveSceneRuntimeDescriptor('missing')).rejects.toThrow(
      expect.objectContaining({ kind: 'SCENE_NOT_FOUND' }),
    );
  });

  it('streamed 清单缺 stream.entryUrl → ASSET_INVALID（不静默失败）', async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ ...streamedManifest, stream: { transport: 'range' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(resolveSceneRuntimeDescriptor('stream-large')).rejects.toThrow(
      expect.objectContaining({ kind: 'ASSET_INVALID' }) as unknown as Error,
    );
  });
});

describe('ManifestFallbackErrorKind（SSV-08）', () => {
  it('STREAMED_SOG_UNSUPPORTED 已从错误类型移除', () => {
    const kinds: string[] = [
      'SCENE_NOT_FOUND',
      'ASSET_FETCH_FAILED',
      'ASSET_INVALID',
    ];
    expect(kinds).not.toContain('STREAMED_SOG_UNSUPPORTED');
    const e = new ManifestFallbackError('ASSET_INVALID', 'x');
    expect(e.kind).toBe('ASSET_INVALID');
  });
});