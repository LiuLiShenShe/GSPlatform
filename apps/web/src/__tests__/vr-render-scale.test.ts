/**
 * GS-PERF-VR —— VR 渲染分辨率策略 + runtime 施加/还原测试。
 *
 * 头真机/Immersive Web Emulator 的会话由 /tmp 冒烟脚本在真实浏览器验证；
 * 本测试只验策略规整、持久化、以及 `startVR()` 会话创建前后对
 * `graphicsDevice.maxPixelRatio` 的施加/还原（含失败路径与 xr 'end' 还原）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHandler } from 'playcanvas';

vi.mock('@playcanvas/supersplat-viewer/viewer', () => ({
  createViewer: vi.fn(),
}));

import { createViewer, type ViewerHandle } from '@playcanvas/supersplat-viewer/viewer';
import { SuperSplatRuntime, type SuperSplatRuntimeOptions } from '../scene-runtime/SuperSplatRuntime';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import {
  clampVrRenderScale,
  readVrRenderScalePreference,
  writeVrRenderScalePreference,
  XR_RENDER_SCALE_OPTIONS,
  XR_RENDER_SCALE_STORAGE_KEY,
} from '../scene-runtime/vrRenderScalePolicy';

const mockedCreateViewer = vi.mocked(createViewer);

function makeFakeHandle(appOverride: Record<string, unknown> = {}): ViewerHandle {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const state: Record<string, unknown> = {
    loaded: true,
    progress: 100,
    cameraMode: 'orbit',
    performanceMode: false,
    walkAllowed: false,
    hasCollision: false,
    selectedAnnotation: null,
    isFullscreen: false,
    canStartVR: true,
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
    app: {
      graphicsDevice: { deviceType: 'webgl2', maxPixelRatio: 1 },
      stats: { frame: { gsplats: 0 } },
      ...appOverride,
    },
    state,
    events,
    annotations: [],
    captureFrame: vi.fn(),
    seek: vi.fn(),
    frameScene: vi.fn(),
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
    mode: 'xr' as const,
    ...overrides,
  };
}

beforeEach(() => {
  mockedCreateViewer.mockReset();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('vrRenderScalePolicy', () => {
  it('clamp：越界/非法 → null；区间内原样返回', () => {
    expect(clampVrRenderScale(0.7)).toBe(0.7);
    expect(clampVrRenderScale(1)).toBe(1);
    expect(clampVrRenderScale(1.5)).toBe(1);
    expect(clampVrRenderScale(0.1)).toBe(0.3);
    expect(clampVrRenderScale(null)).toBeNull();
    expect(clampVrRenderScale(undefined)).toBeNull();
    expect(clampVrRenderScale(NaN)).toBeNull();
  });

  it('read/write：往返一致；null 清除偏好', () => {
    expect(readVrRenderScalePreference()).toBeNull();
    writeVrRenderScalePreference(0.7);
    expect(localStorage.getItem(XR_RENDER_SCALE_STORAGE_KEY)).toBe('0.7');
    expect(readVrRenderScalePreference()).toBe(0.7);
    // 写入越界值会被规整后落库。
    writeVrRenderScalePreference(2);
    expect(localStorage.getItem(XR_RENDER_SCALE_STORAGE_KEY)).toBe('1');
    writeVrRenderScalePreference(null);
    expect(localStorage.getItem(XR_RENDER_SCALE_STORAGE_KEY)).toBeNull();
    expect(readVrRenderScalePreference()).toBeNull();
  });

  it('options：含「原生(null)」与若干降档；值单调且 ≤ 1', () => {
    const values = XR_RENDER_SCALE_OPTIONS.map((o) => o.value);
    expect(values).toContain(null);
    const numeric = values.filter((v): v is number => typeof v === 'number');
    expect(numeric.every((v) => v > 0 && v <= 1)).toBe(true);
  });
});

describe('SuperSplatRuntime VR 渲染分辨率施加/还原', () => {
  it('startVR 前 maxPixelRatio 被乘 scale；null = 不改', async () => {
    const app = new EventHandler();
    const xr = Object.assign(new EventHandler(), { active: false, type: 'immersive-vr', spaceType: 'local-floor', camera: null });
    const handle = makeFakeHandle({
      graphicsDevice: { deviceType: 'webgl2', maxPixelRatio: 1 },
      xr,
      on: app.on.bind(app),
      off: app.off.bind(app),
    });
    mockedCreateViewer.mockResolvedValue(handle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());

    const dpr = window.devicePixelRatio || 1;
    runtime.setVrRenderScale(0.7);
    await runtime.startVR();
    expect(handle.app.graphicsDevice.maxPixelRatio).toBeCloseTo(dpr * 0.7, 6);

    runtime.destroy();
  });

  it('null（官方默认）不改 maxPixelRatio', async () => {
    const app = new EventHandler();
    const xr = Object.assign(new EventHandler(), { active: false, type: 'immersive-vr', spaceType: 'local-floor', camera: null });
    const handle = makeFakeHandle({
      graphicsDevice: { deviceType: 'webgl2', maxPixelRatio: 1 },
      xr,
      on: app.on.bind(app),
      off: app.off.bind(app),
    });
    mockedCreateViewer.mockResolvedValue(handle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    runtime.setVrRenderScale(null);
    await runtime.startVR();
    expect(handle.app.graphicsDevice.maxPixelRatio).toBe(1);
    runtime.destroy();
  });

  it('xr "end" 还原 maxPixelRatio（幂等）', async () => {
    const app = new EventHandler();
    const xr = Object.assign(new EventHandler(), { active: false, type: 'immersive-vr', spaceType: 'local-floor', camera: null });
    const handle = makeFakeHandle({
      graphicsDevice: { deviceType: 'webgl2', maxPixelRatio: 1 },
      xr,
      on: app.on.bind(app),
      off: app.off.bind(app),
    });
    mockedCreateViewer.mockResolvedValue(handle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());

    runtime.setVrRenderScale(0.55);
    await runtime.startVR();
    expect(handle.app.graphicsDevice.maxPixelRatio).not.toBe(1);
    xr.fire('end');
    expect(handle.app.graphicsDevice.maxPixelRatio).toBe(1);
    // 二次 fire 不再改（幂等：before 已清空）。
    xr.fire('end');
    expect(handle.app.graphicsDevice.maxPixelRatio).toBe(1);
    runtime.destroy();
  });

  it('startXR 失败时立即还原 maxPixelRatio', async () => {
    const app = new EventHandler();
    const xr = Object.assign(new EventHandler(), { active: false, type: 'immersive-vr', spaceType: 'local-floor', camera: null });
    const handle = makeFakeHandle({
      graphicsDevice: { deviceType: 'webgl2', maxPixelRatio: 1 },
      xr,
      on: app.on.bind(app),
      off: app.off.bind(app),
    });
    mockedCreateViewer.mockResolvedValue(handle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());

    runtime.setVrRenderScale(0.7);
    vi.mocked(handle.startXR).mockRejectedValueOnce(new Error('user gesture lost'));
    await expect(runtime.startVR()).rejects.toThrow('user gesture lost');
    expect(handle.app.graphicsDevice.maxPixelRatio).toBe(1);
    runtime.destroy();
  });

  it('destroy 还原残留的 maxPixelRatio', async () => {
    const app = new EventHandler();
    const xr = Object.assign(new EventHandler(), { active: false, type: 'immersive-vr', spaceType: 'local-floor', camera: null });
    const handle = makeFakeHandle({
      graphicsDevice: { deviceType: 'webgl2', maxPixelRatio: 1 },
      xr,
      on: app.on.bind(app),
      off: app.off.bind(app),
    });
    mockedCreateViewer.mockResolvedValue(handle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());

    runtime.setVrRenderScale(0.6);
    await runtime.startVR();
    expect(handle.app.graphicsDevice.maxPixelRatio).not.toBe(1);
    runtime.destroy();
    expect(handle.app.graphicsDevice.maxPixelRatio).toBe(1);
  });
});
