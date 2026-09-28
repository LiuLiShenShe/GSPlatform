/**
 * SSV-01 — runtimeApi 解析测试。
 *
 * 覆盖：合法描述解析、结构非法（PARSE）、404 / 401 / 403 分类、
 * 网络失败（NETWORK）、URL 组装。httpClient 用模块 mock，避免真实网络。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

vi.mock('../services/http', () => ({
  httpClient: { get: vi.fn() },
  toApiError: (error: unknown) => {
    // 归一化错误形状（不依赖真实 axios，仅读 response.status）。
    const resp = (error as { response?: { status?: number } }).response;
    const status = resp?.status ?? null;
    return {
      status,
      code: status != null ? `HTTP_${String(status)}` : 'NETWORK_ERROR',
      message: status != null ? `请求失败（${String(status)}）` : '网络错误',
    };
  },
}));

import { httpClient } from '../services/http';
import { RuntimeApiError, getSceneRuntime } from '../scene-runtime/runtimeApi';
import {
  emptyRuntimeDescriptorFixture,
  runtimeDescriptorFixture,
} from '../scene-runtime/__fixtures__/descriptor';

const mockedGet = vi.mocked(httpClient.get);

/** 简易 AxiosError 形状：axios.isAxiosError 仅检查 isAxiosError 属性。 */
class AxiosFakeError extends Error {
  response: { status: number; data: { code: string; message: string } };
  isAxiosError = true;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.response = {
      status,
      data: { code: `HTTP_${String(status)}`, message: `请求失败（${String(status)}）` },
    };
  }
}

function mockResponse(status: number, data: unknown) {
  mockedGet.mockResolvedValueOnce({
    data,
    status,
    statusText: '',
    headers: {},
    config: {},
  } as never);
}

function mockAxiosError(status: number) {
  mockedGet.mockRejectedValueOnce(new AxiosFakeError(status));
}

function mockNetworkError() {
  mockedGet.mockRejectedValueOnce(new axios.AxiosError('Network Error'));
}

beforeEach(() => {
  mockedGet.mockReset();
});

describe('getSceneRuntime — URL 与合法解析', () => {
  it('使用 /scenes/{sceneId}/runtime 端点并正确编码 sceneId', async () => {
    mockResponse(200, runtimeDescriptorFixture);
    await getSceneRuntime('r-8c4e2264e86a');
    expect(mockedGet).toHaveBeenCalledWith('/scenes/r-8c4e2264e86a/runtime');

    mockResponse(200, runtimeDescriptorFixture);
    await getSceneRuntime('a b/c');
    expect(mockedGet).toHaveBeenCalledWith('/scenes/a%20b%2Fc/runtime');
  });

  it('200 → 返回合法 SceneRuntimeDescriptorV1（字段齐全）', async () => {
    mockResponse(200, runtimeDescriptorFixture);
    const desc = await getSceneRuntime('r-8c4e2264e86a');
    expect(desc.schemaVersion).toBe(1);
    expect(desc.scene.id).toBe('r-8c4e2264e86a');
    expect(desc.content.format).toBe('lod-meta');
    expect(desc.viewpoints).toHaveLength(1);
    expect(desc.annotations).toHaveLength(1);
    expect(desc.backgroundAudio?.enabled).toBe(true);
    expect(desc.collision?.format).toBe('glb');
  });

  it('200 + null/[] 语义 → 空白场景同样合法', async () => {
    mockResponse(200, emptyRuntimeDescriptorFixture);
    const desc = await getSceneRuntime('scene-empty');
    expect(desc.viewpoints).toEqual([]);
    expect(desc.annotations).toEqual([]);
    expect(desc.backgroundAudio).toBeNull();
    expect(desc.collision).toBeNull();
    expect(desc.content.url).toBeNull();
  });
});

describe('getSceneRuntime — 失败分类', () => {
  it('404 → RuntimeApiError(kind=SCENE_NOT_FOUND)', async () => {
    mockAxiosError(404);
    await expect(getSceneRuntime('no-such')).rejects.toMatchObject({
      name: 'RuntimeApiError',
      kind: 'SCENE_NOT_FOUND',
      status: 404,
    });
  });

  it('401 → RuntimeApiError(kind=UNAUTHORIZED)', async () => {
    mockAxiosError(401);
    await expect(getSceneRuntime('private-scene')).rejects.toMatchObject({
      kind: 'UNAUTHORIZED',
      status: 401,
    });
  });

  it('403 → RuntimeApiError(kind=FORBIDDEN)', async () => {
    mockAxiosError(403);
    await expect(getSceneRuntime('private-other')).rejects.toMatchObject({
      kind: 'FORBIDDEN',
      status: 403,
    });
  });

  it('500 / 网络错误 → RuntimeApiError(kind=NETWORK)', async () => {
    mockAxiosError(500);
    await expect(getSceneRuntime('boom')).rejects.toMatchObject({
      kind: 'NETWORK',
      status: 500,
    });

    mockNetworkError();
    await expect(getSceneRuntime('boom2')).rejects.toMatchObject({
      kind: 'NETWORK',
      status: null,
    });
  });

  it('schemaVersion 非 1 → RuntimeApiError(kind=PARSE)', async () => {
    mockResponse(200, { ...runtimeDescriptorFixture, schemaVersion: 2 });
    await expect(getSceneRuntime('old')).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('缺少 presentation 字段 → RuntimeApiError(kind=PARSE)', async () => {
    mockResponse(200, {
      schemaVersion: 1,
      scene: runtimeDescriptorFixture.scene,
      content: runtimeDescriptorFixture.content,
      viewpoints: [],
      annotations: [],
    });
    await expect(getSceneRuntime('bad')).rejects.toMatchObject({ kind: 'PARSE' });
  });
});

describe('RuntimeApiError', () => {
  it('暴露 kind 与 status 供页面分派', () => {
    const err = new RuntimeApiError('FORBIDDEN', 403, '该场景不可见或未发布');
    expect(err.kind).toBe('FORBIDDEN');
    expect(err.status).toBe(403);
    expect(err).toBeInstanceOf(Error);
  });
});
