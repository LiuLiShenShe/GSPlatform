/**
 * SSV-02 — SuperSplatRuntime wrapper + Experience Adapter V1 测试。
 *
 * 官方 `/viewer` 模块用模块 mock（fake handle，事件语义对齐官方
 * `<key>:changed` (value, previous)）；`/settings` 用真实模块 ——
 * buildExperienceSettings 产物经真实 validateSettings(limits) 校验。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@playcanvas/supersplat-viewer/viewer', () => ({
  createViewer: vi.fn(),
}));

import { createViewer, type ViewerHandle } from '@playcanvas/supersplat-viewer/viewer';
import {
  CAMERA_FOV_RANGE,
  validateSettings,
} from '@playcanvas/supersplat-viewer/settings';
import {
  rendererForMode,
  SuperSplatRuntime,
  type SuperSplatRuntimeOptions,
} from '../scene-runtime/SuperSplatRuntime';
import { SuperSplatRuntimeError } from '../scene-runtime/runtimeErrors';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';
import {
  emptyRuntimeDescriptorFixture,
  runtimeDescriptorFixture,
} from '../scene-runtime/__fixtures__/descriptor';

const mockedCreateViewer = vi.mocked(createViewer);

// ─── fake handle（事件语义对齐官方 EventHandler）───────────────────────────
function makeFakeHandle(): ViewerHandle {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const state: Record<string, unknown> = {
    loaded: false,
    progress: 0,
    cameraMode: 'orbit',
    performanceMode: false,
    walkAllowed: false,
    hasCollision: false,
    selectedAnnotation: null,
    isFullscreen: false,
    canStartVR: false,
    canStartAR: false,
    xrMode: null,
  };
  const events = {
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    fire(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
  };
  const handle = {
    app: { graphicsDevice: { deviceType: 'webgl2' }, stats: { frame: { gsplats: 123 } } },
    state,
    events,
    annotations: [],
    captureFrame: vi.fn(),
    seek: vi.fn(),
    frameScene: vi.fn(() => {
      if (!state.loaded) throw new Error('frameScene: requires state.loaded');
    }),
    resetCamera: vi.fn(),
    toggleWalk: vi.fn(),
    selectAnnotation: vi.fn(),
    setMoveInput: vi.fn(),
    requestFullscreen: vi.fn(async () => {}),
    exitFullscreen: vi.fn(async () => {}),
    startXR: vi.fn(async () => {}),
    endXR: vi.fn(async () => {}),
    destroy: vi.fn(() => {
      listeners.clear();
    }),
  } as unknown as ViewerHandle;
  return handle;
}

function defaultOptions(overrides: Partial<SuperSplatRuntimeOptions> = {}) {
  return {
    container: document.createElement('div'),
    contentUrl: '/local-scenes/r-8c4e2264e86a/versions/b/lod-meta.json',
    settings: buildExperienceSettings(runtimeDescriptorFixture),
    mode: 'desktop' as const,
    ...overrides,
  };
}

beforeEach(() => {
  mockedCreateViewer.mockReset();
});

describe('Experience Adapter V1', () => {
  it('产物通过官方 validateSettings({ limits: true })', () => {
    const settings = buildExperienceSettings(runtimeDescriptorFixture);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.version).toBe(2);
  });

  it('映射 background color 与 initial camera', () => {
    const desc = {
      ...runtimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 55 },
        background: { type: 'color', color: { x: 0.1, y: 0.2, z: 0.3 }, url: null },
      },
    };
    const settings = buildExperienceSettings(desc);
    expect(settings.background.color).toEqual([0.1, 0.2, 0.3]);
    expect(settings.cameras).toHaveLength(1);
    expect(settings.cameras[0].initial.position).toEqual([1, 2, 3]);
    expect(settings.cameras[0].initial.fov).toBe(55);
  });

  it('无 initial camera 时保留官方 default（cameras 非空，limits 通过）', () => {
    const settings = buildExperienceSettings(emptyRuntimeDescriptorFixture);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
  });

  it('fov 越界时 clamp 进官方 authoring 界（limits: true 仍通过）', () => {
    const desc = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: { x: 0, y: 1, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 250 },
        background: { type: 'color', color: null, url: null },
      },
    };
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.cameras[0].initial.fov).toBe(CAMERA_FOV_RANGE.max);
  });
});

describe('Renderer Policy', () => {
  it('desktop 选择 auto（renderer 不传 → 官方默认 webgpu + 自动 fallback）', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    await SuperSplatRuntime.create(defaultOptions({ mode: 'desktop' }));
    expect(mockedCreateViewer).toHaveBeenCalledTimes(1);
    const opts = mockedCreateViewer.mock.calls[0][0];
    expect(opts.renderer).toBeUndefined();
    expect(rendererForMode('desktop')).toBeUndefined();
  });

  it('xr 选择 webgl', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({ mode: 'xr' }));
    const opts = mockedCreateViewer.mock.calls[0][0];
    expect(opts.renderer).toBe('webgl');
    expect(rendererForMode('xr')).toBe('webgl');
    expect(runtime.mode).toBe('xr');
  });

  it('desktop 模式创建时同时传递 contentUrl / settings / collisionUrl / posterUrl', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    await SuperSplatRuntime.create(
      defaultOptions({
        collisionUrl: '/api/v1/scenes/x/collision/mesh',
        posterUrl: '/local-scenes/x/poster.webp',
      }),
    );
    const opts = mockedCreateViewer.mock.calls[0][0];
    expect(opts.contentUrl).toBe('/local-scenes/r-8c4e2264e86a/versions/b/lod-meta.json');
    expect(opts.settings).toBeDefined();
    expect(opts.collisionUrl).toBe('/api/v1/scenes/x/collision/mesh');
    expect(opts.posterUrl).toBe('/local-scenes/x/poster.webp');
    expect(opts.ui).toBe(false);
  });
});

describe('destroy', () => {
  it('幂等：连续两次 destroy 不抛错，官方 destroy 仅调用一次', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    runtime.destroy();
    runtime.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroy 后访问 state / 动作抛 SuperSplatRuntimeError(DESTROYED)', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    runtime.destroy();
    expect(() => runtime.loaded).toThrow(SuperSplatRuntimeError);
    expect(() => runtime.frameScene()).toThrow(
      expect.objectContaining({ kind: 'DESTROYED' }),
    );
  });
});

describe('事件订阅', () => {
  it('unsubscribe 后不再收到事件', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const cb = vi.fn();
    const unsubscribe = runtime.onLoaded(cb);
    (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire(
      'loaded:changed',
      true,
    );
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(true);

    unsubscribe();
    (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire(
      'loaded:changed',
      false,
    );
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('destroy 后触发事件不再调用回调（listener 不残留）', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const loadedCb = vi.fn();
    const xrCb = vi.fn();
    const cameraCb = vi.fn();
    runtime.onLoaded(loadedCb);
    runtime.onXRModeChanged(xrCb);
    runtime.onCameraModeChanged(cameraCb);
    runtime.destroy();
    (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire(
      'loaded:changed',
      true,
    );
    (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire(
      'xrMode:changed',
      'vr',
    );
    (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire(
      'cameraMode:changed',
      'walk',
    );
    expect(loadedCb).not.toHaveBeenCalled();
    expect(xrCb).not.toHaveBeenCalled();
    expect(cameraCb).not.toHaveBeenCalled();
  });

  it('onProgress / onSelectedAnnotationChanged 用对应 key 的事件', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const progressCb = vi.fn();
    const selectedCb = vi.fn();
    runtime.onProgress(progressCb);
    runtime.onSelectedAnnotationChanged(selectedCb);
    const fire = (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire;
    fire('progress:changed', 42);
    fire('selectedAnnotation:changed', 2);
    expect(progressCb).toHaveBeenCalledWith(42);
    expect(selectedCb).toHaveBeenCalledWith(2);
  });
});

describe('frameScene 行为', () => {
  it('loaded 之前调用 frameScene → 抛错（官方契约传播）', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(() => runtime.frameScene()).toThrow(/loaded/i);
  });

  it('loaded 之后 frameScene 正常调用', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    (fake.state as Record<string, unknown>).loaded = true;
    runtime.frameScene();
    expect(fake.frameScene).toHaveBeenCalledTimes(1);
  });
});

describe('动作转发', () => {
  it('selectAnnotation / clearAnnotation / toggleWalk / setMoveInput 转发到官方 handle', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    runtime.selectAnnotation(1);
    expect(fake.selectAnnotation).toHaveBeenCalledWith(1);
    runtime.clearAnnotation();
    expect(fake.selectAnnotation).toHaveBeenCalledWith(null);
    runtime.toggleWalk();
    expect(fake.toggleWalk).toHaveBeenCalledTimes(1);
    runtime.setMoveInput(0.5, -0.3);
    expect(fake.setMoveInput).toHaveBeenCalledWith(0.5, -0.3);
  });

  it('startVR / startAR / endXR / requestFullscreen / exitFullscreen 转发', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    await runtime.startVR();
    expect(fake.startXR).toHaveBeenCalledWith('vr');
    await runtime.startAR();
    expect(fake.startXR).toHaveBeenCalledWith('ar');
    await runtime.endXR();
    expect(fake.endXR).toHaveBeenCalledTimes(1);
    await runtime.requestFullscreen();
    expect(fake.requestFullscreen).toHaveBeenCalledTimes(1);
    await runtime.exitFullscreen();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe('descriptor → runtime 映射', () => {
  it('descriptor.content.url 作为 contentUrl 传入官方 createViewer', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const contentUrl = runtimeDescriptorFixture.content.url!;
    await SuperSplatRuntime.create(defaultOptions({ contentUrl }));
    const opts = mockedCreateViewer.mock.calls[0][0];
    expect(opts.contentUrl).toBe(contentUrl);
  });
});

describe('state 读取', () => {
  it('读取官方 state 快照', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    (fake.state as Record<string, unknown>).progress = 77;
    expect(runtime.progress).toBe(77);
    expect(runtime.loaded).toBe(false);
    expect(runtime.cameraMode).toBe('orbit');
  });
});
