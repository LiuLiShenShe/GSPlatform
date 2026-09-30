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
  ANNOTATION_LIMITS,
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
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';

const mockedCreateViewer = vi.mocked(createViewer);

// ─── fake handle（事件语义对齐官方 EventHandler）───────────────────────────
function makeFakeHandle(appOverride: Record<string, unknown> = {}): ViewerHandle {
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
    app: {
      graphicsDevice: { deviceType: 'webgl2' },
      stats: { frame: { gsplats: 123 } },
      ...appOverride,
    },
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

/** 注入的 pose 标注结构（相机 pose 断言用）。 */
interface InjectedPoseAnnotation {
  position: [number, number, number];
  title: string;
  text: string;
  extras: { gsplatform: Record<string, unknown> };
  camera: {
    initial: { position: [number, number, number]; target: [number, number, number]; fov: number };
  };
}

/** 读取官方 annotations 数组中第 idx 条（运行时注入的 pose 标注）。 */
function readInjectedAnnotation(handle: ViewerHandle, idx: number): InjectedPoseAnnotation {
  return (handle.annotations as unknown as InjectedPoseAnnotation[])[idx];
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
    const desc: SceneRuntimeDescriptorV1 = {
      ...runtimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 55 },
        background: { type: 'color', color: { x: 0.1, y: 0.2, z: 0.3 }, url: null },
        tonemapping: 'aces',
        highPrecisionRendering: false,
        postEffects: null,
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
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: { x: 0, y: 1, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 250 },
        background: { type: 'color', color: null, url: null },
        tonemapping: 'aces',
        highPrecisionRendering: false,
        postEffects: null,
      },
    };
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.cameras[0].initial.fov).toBe(CAMERA_FOV_RANGE.max);
  });

  // ─── SSV-05 —— Experience Settings v2 完整映射 ─────────────────────────

  it('映射 tonemapping / highPrecisionRendering / postEffects / skybox（limits 通过）', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: { x: 0, y: 1.2, z: 3.5 }, target: { x: 0, y: 0.8, z: 0 }, fov: 55 },
        background: {
          type: 'equirectangular',
          color: { x: 0.1, y: 0.1, z: 0.1 },
          url: '/api/v1/scenes/r-8c4e2264e86a/presentation/background',
        },
        tonemapping: 'hejl',
        highPrecisionRendering: true,
        postEffects: {
          sharpness: { enabled: true, amount: 0.5 },
          bloom: { enabled: true, intensity: 0.02, blurLevel: 3 },
          grading: { enabled: true, brightness: 1.2, contrast: 1.1, saturation: 1.4, tint: [1, 1, 1] },
          vignette: { enabled: true, intensity: 0.4, inner: 0.3, outer: 0.75, curvature: 1 },
          fringing: { enabled: false, intensity: 0.1 },
        },
      },
    };
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.tonemapping).toBe('hejl');
    expect(settings.highPrecisionRendering).toBe(true);
    expect(settings.background.skyboxUrl).toBe(
      '/api/v1/scenes/r-8c4e2264e86a/presentation/background',
    );
    expect(settings.postEffectSettings.sharpness.amount).toBe(0.5);
    expect(settings.postEffectSettings.bloom.enabled).toBe(true);
    expect(settings.postEffectSettings.bloom.intensity).toBe(0.02);
    expect(settings.postEffectSettings.grading.contrast).toBe(1.1);
  });

  it('post effects 数值越界时 clamp 进官方 POST_EFFECT_RANGES', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: null, target: null, fov: null },
        background: { type: 'color', color: null, url: null },
        tonemapping: 'aces',
        highPrecisionRendering: false,
        postEffects: {
          sharpness: { enabled: true, amount: 99 },
          bloom: { enabled: true, intensity: 5, blurLevel: 100 },
          grading: { enabled: true, brightness: 9, contrast: 0.1, saturation: 7, tint: [2, 2, 2] },
          vignette: { enabled: true, intensity: 7, inner: 99, outer: -3, curvature: 0.001 },
          fringing: { enabled: true, intensity: 999 },
        },
      },
    };
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    const fx = settings.postEffectSettings;
    expect(fx.sharpness.amount).toBe(1);
    expect(fx.bloom.intensity).toBe(0.1);
    expect(fx.bloom.blurLevel).toBe(16);
    expect(fx.grading.brightness).toBe(3);
    expect(fx.grading.contrast).toBe(0.5);
    expect(fx.grading.saturation).toBe(2);
    expect(fx.grading.tint).toEqual([1, 1, 1]);
    expect(fx.vignette.intensity).toBe(1);
    expect(fx.vignette.inner).toBe(3);
    expect(fx.vignette.outer).toBe(0);
    expect(fx.vignette.curvature).toBe(0.01);
    expect(fx.fringing.intensity).toBe(100);
  });

  it('旧场景（postEffects null / tonemapping 未知）落在官方默认，limits 通过', () => {
    // 故意注入非法 tonemapping：adapter 必须容忍并回落官方默认。
    const desc = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        worldTransform: { position: null, rotation: null, scale: null },
        initialCamera: { position: null, target: null, fov: null },
        background: { type: 'color', color: null, url: null },
        tonemapping: 'not-a-curve',
        highPrecisionRendering: false,
        postEffects: null,
      },
    } as unknown as SceneRuntimeDescriptorV1;
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.tonemapping).toBe('linear');
    expect(settings.highPrecisionRendering).toBe(false);
    // 官方默认：五个 effect 全部关闭。
    expect(settings.postEffectSettings.sharpness.enabled).toBe(false);
    expect(settings.postEffectSettings.bloom.enabled).toBe(false);
    expect(settings.postEffectSettings.grading.enabled).toBe(false);
    expect(settings.postEffectSettings.vignette.enabled).toBe(false);
    expect(settings.postEffectSettings.fringing.enabled).toBe(false);
  });

  it('非 equirectangular 背景不写 skyboxUrl', () => {
    const settings = buildExperienceSettings(runtimeDescriptorFixture);
    expect(settings.background.skyboxUrl).toBeUndefined();
  });

  // ─── SSV-06 —— annotations；FIX-03 §5 —— backgroundAudio 不再映射 soundUrl ──

  it('FIX-03 §5：backgroundAudio 由 GSPlatform 控制器管理 → 一律不写官方 soundUrl', () => {
    // 官方 ExperienceSettings 仅 soundUrl 且无 volume/loop/enabled API —— 已停用。
    // 背景音频由页面层 BackgroundAudioController 从 descriptor.backgroundAudio 配置。
    const settings = buildExperienceSettings(runtimeDescriptorFixture);
    expect(settings.soundUrl).toBeUndefined();
  });

  it('backgroundAudio 未启用/无 url → 仍不写 soundUrl（任何情况都停用官方字段）', () => {
    const disabled: SceneRuntimeDescriptorV1 = {
      ...runtimeDescriptorFixture,
      backgroundAudio: { url: '/x.mp3', volume: 1, loop: true, enabled: false },
    };
    expect(buildExperienceSettings(disabled).soundUrl).toBeUndefined();

    const noUrl: SceneRuntimeDescriptorV1 = {
      ...runtimeDescriptorFixture,
      backgroundAudio: { url: null, volume: 1, loop: true, enabled: true },
    };
    expect(buildExperienceSettings(noUrl).soundUrl).toBeUndefined();

    const enabledWithUrl: SceneRuntimeDescriptorV1 = {
      ...runtimeDescriptorFixture,
      backgroundAudio: { url: '/y.mp3', volume: 0.5, loop: true, enabled: true },
    };
    expect(buildExperienceSettings(enabledWithUrl).soundUrl).toBeUndefined();
  });

  it('annotations → 官方 annotations[]（position/title/text/camera/extras 协议）', () => {
    const settings = buildExperienceSettings(runtimeDescriptorFixture);
    const official = settings.annotations;
    expect(official).toHaveLength(1);
    const first = official[0];
    expect(first.position).toEqual([-1.2, 0.3, 0.4]);
    expect(first.title).toBe('水井');
    expect(first.text).toBe('清代古井');
    // extras 固定协议：annotationId 才是数据库 ID（禁止依赖数组 index）。
    expect(first.extras).toEqual({
      gsplatform: { annotationId: 'ann-1', contentType: 'TEXT' },
    });
    // FIX-02 §14：camera 来自该标注**自己**的相机（cameraPosition/Target/Fov），
    // 不再是 settings.cameras[0]。
    expect(first.camera.initial.fov).toBe(45);
    expect(first.camera.initial.position).toEqual([-3.0, 1.9, 2.0]);
    expect(first.camera.initial.target).toEqual([-1.2, 0.4, 0.4]);
  });

  it('3 个标注各自带不同相机 → 3 条官方 annotations 的 camera 互不相同（FIX-02 §15）', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        ...emptyRuntimeDescriptorFixture.presentation,
        // 场景初始相机与任何标注相机都不同。
        initialCamera: { position: { x: 0, y: 10, z: 30 }, target: { x: 0, y: 0, z: 0 }, fov: 50 },
      },
      annotations: [
        {
          id: 'ann-a', title: 'A', description: '',
          anchor: { x: 0, y: 0, z: 0 }, style: 'LEADER_TEXT', contentType: 'TEXT', textContent: '',
          mediaAssetUrl: null, textColor: '#fff', textSize: 14, fov: 60,
          cameraPosition: { x: 1, y: 1, z: 1 }, cameraTarget: { x: 0, y: 1, z: 0 }, cameraFov: 40,
          orderIndex: 0, enabled: true,
        },
        {
          id: 'ann-b', title: 'B', description: '',
          anchor: { x: 1, y: 0, z: 0 }, style: 'LEADER_TEXT', contentType: 'TEXT', textContent: '',
          mediaAssetUrl: null, textColor: '#fff', textSize: 14, fov: 60,
          cameraPosition: { x: 2, y: 2, z: 2 }, cameraTarget: { x: 0, y: 1, z: -1 }, cameraFov: 42,
          orderIndex: 1, enabled: true,
        },
        {
          id: 'ann-c', title: 'C', description: '',
          anchor: { x: -1, y: 0, z: 0 }, style: 'LEADER_TEXT', contentType: 'TEXT', textContent: '',
          mediaAssetUrl: null, textColor: '#fff', textSize: 14, fov: 60,
          cameraPosition: { x: 3, y: 0, z: 3 }, cameraTarget: { x: 0, y: 1, z: 1 }, cameraFov: 38,
          orderIndex: 2, enabled: true,
        },
      ],
      backgroundAudio: null,
    };
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    const cams = settings.annotations.map((a) => a.camera.initial);
    expect(new Set(cams.map((c) => c.position.join(','))).size).toBe(3);
    expect(new Set(cams.map((c) => c.target.join(','))).size).toBe(3);
    expect(new Set(cams.map((c) => c.fov)).size).toBe(3);
    // 任何一条都不等于场景初始相机（settings.cameras[0]）。
    const sceneCam = settings.cameras[0].initial;
    for (const c of cams) {
      expect(c.position.join(',')).not.toBe(sceneCam.position.join(','));
    }
  });

  it('annotation 文本 HTML 被 sanitize（剥离标签/脚本），title/text 截断进官方 limits', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: { ...emptyRuntimeDescriptorFixture.presentation },
      annotations: [
        {
          id: 'ann-xss',
          title: '标题<script>alert(1)</script>',
          description: '',
          anchor: { x: 0, y: 1, z: 0 },
          style: 'LEADER_TEXT',
          contentType: 'TEXT',
          textContent: '<b>加粗</b><em>斜体</em><!-- 注释 --><img src=x onerror=alert(2)> 正文',
          mediaAssetUrl: null,
          textColor: '#fff',
          textSize: 14,
          fov: 999, // 越界 → clamp
          cameraPosition: null,
          cameraTarget: null,
          cameraFov: null,
          orderIndex: 0,
          enabled: true,
        },
      ],
      backgroundAudio: null,
    };
    const settings = buildExperienceSettings(desc);
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    const official = settings.annotations[0];
    expect(official.title).toBe('标题');
    expect(official.text).not.toContain('<');
    expect(official.text).not.toContain('alert');
    expect(official.text).toContain('加粗斜体 正文'); // 标签剥除后相邻文本拼接
    expect(official.camera.initial.fov).toBe(CAMERA_FOV_RANGE.max);
  });

  it('长 title/text 截断进官方 ANNOTATION_LIMITS（titleMax/textMax）', () => {
    const longTitle = '字'.repeat(200);
    const longText = '长'.repeat(500);
    const settings = buildExperienceSettings({
      ...emptyRuntimeDescriptorFixture,
      annotations: [
        {
          id: 'ann-long',
          title: longTitle,
          description: '',
          anchor: { x: 0, y: 1, z: 0 },
          style: 'LEADER_TEXT',
          contentType: 'TEXT',
          textContent: longText,
          mediaAssetUrl: null,
          textColor: '#fff',
          textSize: 14,
          fov: 60,
          cameraPosition: null,
          cameraTarget: null,
          cameraFov: null,
          orderIndex: 0,
          enabled: true,
        },
      ],
      backgroundAudio: null,
    });
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.annotations[0].title.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.titleMax);
    expect(settings.annotations[0].text.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.textMax);
  });

  it('disabled 标注不进入官方 annotations；数量 cap 进官方 maxCount', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `ann-${i}`,
      title: `标注 ${i}`,
      description: '',
      anchor: { x: i, y: 0, z: 0 },
      style: 'LEADER_TEXT' as const,
      contentType: 'TEXT' as const,
      textContent: '',
      mediaAssetUrl: null,
      textColor: '#fff',
      textSize: 14,
      fov: 60,
      cameraPosition: null,
      cameraTarget: null,
      cameraFov: null,
      orderIndex: i,
      enabled: i !== 39, // 最后一个 disabled
    }));
    const settings = buildExperienceSettings({
      ...emptyRuntimeDescriptorFixture,
      annotations: many,
      backgroundAudio: null,
    });
    expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    expect(settings.annotations).toHaveLength(25); // maxCount
    expect(settings.annotations.some((a) => a.title === '标注 39')).toBe(false);
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

  it('ui:true 透传官方 ui 选项，并给容器打作用域 class + 注入 scoped CSS', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const container = document.createElement('div');
    await SuperSplatRuntime.create(defaultOptions({ container, ui: true }));
    const opts = mockedCreateViewer.mock.calls[0][0];
    expect(opts.ui).toBe(true);
    expect(container.classList.contains('gs-supersplat-host')).toBe(true);
    const style = document.getElementById('gs-supersplat-ui-scope');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('.sse-ui');
    expect(style!.textContent).toContain('.sse-sceneLayer');
  });
});

describe('SSV-06 官方选中标注 extras 解析', () => {
  it('selectedGsplatformAnnotation 读取 extras.gsplatform.annotationId（不用数组 index 当 ID）', async () => {
    const fake = makeFakeHandle();
    (fake as unknown as { annotations: unknown[] }).annotations = [
      {
        position: [0, 0, 0],
        title: '媒体标注',
        text: '',
        camera: { initial: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 } },
        extras: { gsplatform: { annotationId: 'ann-uuid-1', contentType: 'VIDEO' } },
      },
      {
        position: [1, 0, 0],
        title: '纯文本',
        text: '',
        camera: { initial: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 } },
        extras: { gsplatform: { annotationId: 'ann-uuid-2', contentType: 'TEXT' } },
      },
    ];
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.selectedGsplatformAnnotation).toBeNull();

    const fire = (fake.events as unknown as { fire: (e: string, ...a: unknown[]) => void }).fire;
    const setSelected = (v: number | null) => {
      // 官方 State.selectedAnnotation 声明为只读（须经 selectAnnotation），
      // 测试里直接改底层 state 快照模拟事件来源。
      (fake.state as { selectedAnnotation: number | null }).selectedAnnotation = v;
    };
    setSelected(0);
    fire('selectedAnnotation:changed', 0);
    expect(runtime.selectedGsplatformAnnotation).toEqual({
      index: 0,
      annotationId: 'ann-uuid-1',
      contentType: 'VIDEO',
    });

    setSelected(1);
    fire('selectedAnnotation:changed', 1);
    expect(runtime.selectedGsplatformAnnotation?.annotationId).toBe('ann-uuid-2');

    // 清除选中 → null（页面据此关闭 Overlay；关闭 Overlay 不清除 selection）。
    setSelected(null);
    fire('selectedAnnotation:changed', null);
    expect(runtime.selectedGsplatformAnnotation).toBeNull();
  });

  it('选中非 GSPlatform 标注（无 extras 协议）→ null', async () => {
    const fake = makeFakeHandle();
    (fake as unknown as { annotations: unknown[] }).annotations = [
      { position: [0, 0, 0], title: 'x', text: '', camera: { initial: { position: [0, 0, 0], target: [0, 0, 1], fov: 60 } } },
    ];
    (fake.state as { selectedAnnotation: number | null }).selectedAnnotation = 0;
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.selectedGsplatformAnnotation).toBeNull();
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

  it('startVR / startAR / endXR / requestFullscreen / exitFullscreen 转发', async () => {    const fake = makeFakeHandle();
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

// ─── SSV-05 §5 —— 相机 / 截图 / 拾取封装（页面不直接触碰 app）─────────────
/**
 * 假引擎相机实体：position (1,2,3)、forward (0,0,-1)、fov 55；
 * 假 gsplat 包围盒中心 (0,1,0) → 焦点深度 = √11。
 */
interface CameraEntityLike {
  camera: { fov: number };
  setPosition: ReturnType<typeof vi.fn>;
  lookAt: ReturnType<typeof vi.fn>;
}

function makeCameraHandle(): ViewerHandle & { cameraEntity: CameraEntityLike } {
  let pos = { x: 1, y: 2, z: 3 };
  const cameraEntity = {
    // 方向/上/右是 Entity（GraphNode）上的 Vec3 只读属性（SSV-07 探针实测）。
    camera: { fov: 55 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    getPosition: vi.fn(() => ({ x: pos.x, y: pos.y, z: pos.z })),
    setPosition: vi.fn((x: number, y: number, z: number) => {
      pos = { x, y, z };
    }),
    lookAt: vi.fn(),
  };
  // 官方 1.35.0：包围盒取 gsplatComponent.customAabb（非 instance.aabb），
  // 并经实体世界变换。身份矩阵 → 世界包围盒 = customAabb 原值。
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const gsplat = {
    gsplat: { customAabb: { center: { x: 0, y: 1, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } } },
    getWorldTransform: () => ({ data: identity }),
  };
  const root = {
    findByName: vi.fn((name: string) => {
      if (name === 'camera') return cameraEntity;
      if (name === 'gsplat') return gsplat;
      return null;
    }),
  };
  const handle = makeFakeHandle({ root, graphicsDevice: { deviceType: 'webgl2', width: 800, height: 600 } });
  (handle.state as Record<string, unknown>).loaded = true;
  return Object.assign(handle, { cameraEntity });
}

const SQRT11 = Math.sqrt(11);

describe('相机 pose 封装（SSV-05）', () => {
  it('getCameraPose 读取引擎相机实体 position/fov，target 沿 forward + 场景中心深度', async () => {
    const fake = makeCameraHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const pose = runtime.getCameraPose();
    expect(pose).not.toBeNull();
    expect(pose!.position).toEqual([1, 2, 3]);
    expect(pose!.fov).toBe(55);
    // target = position + forward×√11（相机到 gsplat 中心 (0,1,0) 的距离）
    expect(pose!.target[0]).toBeCloseTo(1, 5);
    expect(pose!.target[1]).toBeCloseTo(2, 5);
    expect(pose!.target[2]).toBeCloseTo(3 - SQRT11, 5);
  });

  it('相机实体缺失时 getCameraPose 返回 null（不抛错）', async () => {
    const fake = makeFakeHandle(); // app 无 root
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.getCameraPose()).toBeNull();
  });

  it('getCameraPose 对 fov 做官方界 clamp（limits 外的引擎值也安全）', async () => {
    const fake = makeCameraHandle();
    (fake.cameraEntity.camera as { fov: number }).fov = 250;
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.getCameraPose()!.fov).toBe(120);
  });

  it('setCameraPose 经注入标注 selectAnnotation 导航（官方公开 API 唯一 pose 路径，FIX-02 §10）', async () => {
    const fake = makeCameraHandle();
    (fake.annotations as unknown as unknown[]).length = 0; // 官方 annotations 数组引用
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    runtime.setCameraPose({ position: [0, 1, 0], target: [0, 1, -5], fov: 200 });
    // 注入一条隐藏标注（extras 无 annotationId → 不被当真实标注）并 select 它。
    expect(fake.selectAnnotation).toHaveBeenCalledTimes(1);
    const idx = (fake.selectAnnotation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const injected = readInjectedAnnotation(fake, idx);
    expect(injected.camera.initial.position).toEqual([0, 1, 0]);
    expect(injected.camera.initial.target).toEqual([0, 1, -5]);
    expect(injected.camera.initial.fov).toBe(120); // clamp 进官方界
  });

  it('FIX-05 §26-§28：setCameraPose 100 次只保留 1 条临时标注（固定 key 复用）', async () => {
    const fake = makeCameraHandle();
    (fake.annotations as unknown as unknown[]).length = 0;
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    for (let i = 0; i < 100; i += 1) {
      runtime.setCameraPose({ position: [0, i / 2, 0], target: [0, 1, -5], fov: 60 });
    }
    expect(fake.selectAnnotation).toHaveBeenCalledTimes(100);
    // 隐藏临时标注至多 1 条（每次复用同一条，不随调用次数增长）。
    const injectedCount = (fake.annotations as unknown as Array<Record<string, unknown>>)
      .filter((a) => (a.extras as { gsplatform?: unknown } | undefined)?.gsplatform !== undefined)
      .filter((a) => a.title === '')
      .length;
    expect(injectedCount).toBe(1);
    // select 的始终是那同一条（index 稳定）。
    const indexes = (fake.selectAnnotation as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as number,
    );
    expect(new Set(indexes).size).toBe(1);
  });

  it('pickApproximateWorldPosition(0,0) 中心 = 相机正前方焦点深度点', async () => {
    const fake = makeCameraHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const hit = runtime.pickApproximateWorldPosition(0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.position[0]).toBeCloseTo(1, 5);
    expect(hit!.position[1]).toBeCloseTo(2, 5);
    expect(hit!.position[2]).toBeCloseTo(3 - SQRT11, 5);
  });

  it('pickApproximateWorldPosition 相机缺失时返回 null', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.pickApproximateWorldPosition(0, 0)).toBeNull();
  });
});

describe('captureScreenshot 封装（SSV-05 封面截取）', () => {
  it('未 loaded 时返回 null 且不调用官方 captureFrame', async () => {
    const fake = makeCameraHandle();
    (fake.state as Record<string, unknown>).loaded = false;
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const result = await runtime.captureScreenshot();
    expect(result).toBeNull();
    expect(fake.captureFrame).not.toHaveBeenCalled();
  });

  it('官方 RGBA base64 → 浏览器可解码 dataURL（转发尺寸/supersample）', async () => {
    const fake = makeCameraHandle();
    (fake.captureFrame as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      width: 1,
      height: 1,
      data: btoa('\x00\x00\x00\xff'),
    });
    mockedCreateViewer.mockResolvedValueOnce(fake as unknown as ViewerHandle);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    const ctxStub = {
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: vi.fn(),
    };
    // jsdom 的 canvas.toDataURL 无实现（返回 null）——桩出解码后的 dataURL。
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub as never);
    const dataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/webp;base64,cover');
    try {
      const result = await runtime.captureScreenshot({ width: 320, height: 180, supersample: 2 });
      expect(fake.captureFrame).toHaveBeenCalledWith({ width: 320, height: 180, supersample: 2 });
      expect(result).toEqual({ dataUrl: 'data:image/webp;base64,cover' });
      expect(ctxStub.putImageData).toHaveBeenCalledTimes(1);
      expect(dataUrlSpy).toHaveBeenCalledWith('image/webp', 0.9);
    } finally {
      spy.mockRestore();
      dataUrlSpy.mockRestore();
    }
  });
});

describe('SSV-07 walk / collision / scale', () => {
  it('getSceneBounds 从 gsplat customAabb + 世界变换读取世界包围盒', async () => {
    // 身份世界变换 → 世界包围盒 = customAabb 原值。
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const root = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? {
              gsplat: {
                customAabb: {
                  center: { x: 0, y: 1, z: 10 },
                  halfExtents: { x: 4, y: 1.5, z: 3 },
                },
              },
              getWorldTransform: () => ({ data: identity }),
            }
          : null,
    };
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.getSceneBounds()).toEqual({
      min: [-4, -0.5, 7],
      max: [4, 2.5, 13],
      size: [8, 3, 6],
    });
  });

  it('getSceneBounds 应用 gsplat 世界变换（旋转 180° 绕 Z）', async () => {
    // m[0..3]=列0 … m[12..15]=列3。180° 绕 Z：x→-x, y→-y, z 不变。
    const rotZ180 = [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const root = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? {
              gsplat: {
                customAabb: {
                  center: { x: 1, y: 0, z: 10 },
                  halfExtents: { x: 2, y: 1, z: 3 },
                },
              },
              getWorldTransform: () => ({ data: rotZ180 }),
            }
          : null,
    };
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    // 中心 (1,0,10) → (-1,0,10)；extents 不变 → min [-3,-1,7] max [1,1,13]。
    expect(runtime.getSceneBounds()).toEqual({
      min: [-3, -1, 7],
      max: [1, 1, 13],
      size: [4, 2, 6],
    });
  });

  it('getSceneBounds 无 customAabb / 无世界变换 / 未加载时返回 null', async () => {
    const fake = makeFakeHandle({
      root: { findByName: () => null },
    });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.getSceneBounds()).toBeNull();

    // customAabb 存在但没有世界变换 → null（不伪造尺度）。
    const noTransformRoot = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? { gsplat: { customAabb: { center: { x: 0, y: 1, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } } } }
          : null,
    };
    const fake2 = makeFakeHandle({ root: noTransformRoot });
    mockedCreateViewer.mockResolvedValueOnce(fake2);
    const runtime2 = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime2.getSceneBounds()).toBeNull();
  });

  it('walkAllowed / hasCollision / cameraMode 读取官方 state', async () => {
    const fake = makeFakeHandle();
    const writable = fake.state as {
      walkAllowed?: boolean;
      hasCollision?: boolean;
      cameraMode?: unknown;
    };
    writable.walkAllowed = true;
    writable.hasCollision = true;
    writable.cameraMode = 'walk';
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.walkAllowed).toBe(true);
    expect(runtime.hasCollision).toBe(true);
    expect(runtime.cameraMode).toBe('walk');
  });
});

// ─── FIX-02 —— 世界变换施加 / 视角导航 / per-annotation camera ──────────────
describe('FIX-02 world transform', () => {
  it('恒等世界变换 applyWorldTransform 恢复加载基准 TRS（FIX-05 §18-§21 复位）', async () => {
    const setLocalEulerAngles = vi.fn();
    const setLocalPosition = vi.fn();
    const setLocalScale = vi.fn();
    const sync = vi.fn();
    const root = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? {
              setLocalEulerAngles,
              setLocalPosition,
              setLocalScale,
              getLocalPosition: () => ({ x: 0, y: 0, z: 0 }),
              getLocalEulerAngles: () => ({ x: 0, y: 0, z: 180 }),
              getLocalScale: () => ({ x: 1, y: 1, z: 1 }),
              sync,
            }
          : null,
    };
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    // FIX-05：恒等 W 不再「早退 no-op」，而是显式恢复加载基准 TRS
    // （保证此后设过非恒等 W 后再改回恒等能真正复位）。
    expect(runtime.applyWorldTransform()).toBe(true);
    expect(setLocalPosition).toHaveBeenCalledWith(0, 0, 0);
    expect(setLocalEulerAngles).toHaveBeenCalledWith(0, 0, 180);
    expect(setLocalScale).toHaveBeenCalledWith(1, 1, 1);
  });

  it('非恒等 W 施加到 gsplat 实体（位置/旋转合成/缩放），幂等', async () => {
    const setLocalEulerAngles = vi.fn();
    const setLocalPosition = vi.fn();
    const setLocalScale = vi.fn();
    const sync = vi.fn();
    const root = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? {
              setLocalEulerAngles,
              setLocalPosition,
              setLocalScale,
              getLocalPosition: () => ({ x: 0, y: 0, z: 0 }),
              getLocalEulerAngles: () => ({ x: 0, y: 0, z: 180 }),
              getLocalScale: () => ({ x: 1, y: 1, z: 1 }),
              sync,
            }
          : null,
    };
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const wt = { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } };
    const runtime = await SuperSplatRuntime.create(defaultOptions({ worldTransform: wt }));
    expect(runtime.applyWorldTransform()).toBe(true);
    expect(setLocalPosition).toHaveBeenCalledWith(2, 0, 0);
    expect(setLocalScale).toHaveBeenCalledWith(2, 2, 2);
    // 恒等旋转 + 官方 Rz180 合成 → 仍为 [0,0,180]
    expect(setLocalEulerAngles).toHaveBeenCalledWith(0, 0, 180);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('实体缺失时 applyWorldTransform 返回 false（不抛错）', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({
      worldTransform: { position: { x: 1, y: 0, z: 0 }, rotation: null, scale: null },
    }));
    expect(runtime.applyWorldTransform()).toBe(false);
  });

  it('worldTransformInfo 报告归一化 position/rotation/scale', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({
      worldTransform: { position: { x: 1, y: 2, z: 3 }, rotation: null, scale: { x: 2, y: 1, z: 1 } },
    }));
    expect(runtime.worldTransformInfo()).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 2, y: 1, z: 1 },
      isIdentity: false,
    });
  });

  it('setWorldTransform 更新活动适配器并重新施加到实体（此后换算用新 W）', async () => {
    const setLocalEulerAngles = vi.fn();
    const setLocalPosition = vi.fn();
    const setLocalScale = vi.fn();
    const sync = vi.fn();
    const root = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? {
              setLocalEulerAngles,
              setLocalPosition,
              setLocalScale,
              getLocalPosition: () => ({ x: 0, y: 0, z: 0 }),
              getLocalEulerAngles: () => ({ x: 0, y: 0, z: 180 }),
              getLocalScale: () => ({ x: 1, y: 1, z: 1 }),
              sync,
            }
          : null,
    };
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    // 初始为恒等 W。
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.worldTransform.isIdentity).toBe(true);
    // 切到非恒等 W：适配器 + 实体同步更新。
    expect(runtime.setWorldTransform({ position: { x: 3, y: 0, z: 0 }, rotation: null, scale: null })).toBe(true);
    expect(runtime.worldTransform.isIdentity).toBe(false);
    expect(runtime.worldTransform.sceneToRuntimePoint({ x: 0, y: 0, z: 0 })).toEqual({ x: 3, y: 0, z: 0 });
    expect(setLocalPosition).toHaveBeenCalledWith(3, 0, 0);
    // 传 null → 恢复恒等；FIX-05 §18-§21：恒等 W 显式复位实体到加载基准 TRS。
    expect(runtime.setWorldTransform(null)).toBe(true);
    expect(runtime.worldTransform.isIdentity).toBe(true);
    expect(setLocalPosition).toHaveBeenLastCalledWith(0, 0, 0);
    expect(setLocalEulerAngles).toHaveBeenLastCalledWith(0, 0, 180);
    expect(setLocalScale).toHaveBeenLastCalledWith(1, 1, 1);
  });

  it('setWorldTransform 实体未就绪时更新适配器并返回 false（不抛错）', async () => {
    const fake = makeFakeHandle();
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    expect(runtime.setWorldTransform({ position: { x: 0, y: 5, z: 0 }, rotation: null, scale: null })).toBe(false);
    // 适配器已更新 → 下次 applyWorldTransform 会用新 W。
    expect(runtime.worldTransform.sceneToRuntimePoint({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 5, z: 0 });
  });
});

// ─── FIX-05 §18-§21 —— 世界变换复位 / 基准 TRS 捕获 ─────────────────────────
describe('FIX-05 world transform reset (base capture)', () => {
  /** 共享的实体 mock：加载基准 = 官方 Rz180 非恒等（position 0 / euler 0,0,180 / scale 1）。 */
  function entityWithBase(
    base: { pos: { x: number; y: number; z: number }; rot: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } },
  ) {
    const setLocalPosition = vi.fn();
    const setLocalEulerAngles = vi.fn();
    const setLocalScale = vi.fn();
    const sync = vi.fn();
    const root = {
      findByName: (name: string) =>
        name === 'gsplat'
          ? {
              setLocalPosition,
              setLocalEulerAngles,
              setLocalScale,
              getLocalPosition: () => ({ ...base.pos }),
              getLocalEulerAngles: () => ({ ...base.rot }),
              getLocalScale: () => ({ ...base.scale }),
              sync,
            }
          : null,
    };
    return { setLocalPosition, setLocalEulerAngles, setLocalScale, sync, root };
  }

  const OFFICIAL_BASE = {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 180 },
    scale: { x: 1, y: 1, z: 1 },
  };

  it('base 非恒等（官方 Rz180）→ W 旋转 90° 合成 → W 改回恒等恢复 base', async () => {
    const { setLocalPosition, setLocalEulerAngles, setLocalScale, root } = entityWithBase(OFFICIAL_BASE);
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    // 旋转 90°（Y 轴）+ 平移：合成 = W ∘ base。
    expect(runtime.setWorldTransform({ position: null, rotation: { x: 0, y: 90, z: 0 }, scale: null })).toBe(true);
    expect(setLocalEulerAngles).toHaveBeenCalledTimes(1);
    // 第二次同一 W（幂等）：仍合成，不叠加。
    expect(runtime.setWorldTransform({ position: null, rotation: { x: 0, y: 90, z: 0 }, scale: null })).toBe(true);
    expect(setLocalEulerAngles).toHaveBeenCalledTimes(2);
    // 改回恒等 → 显式恢复加载基准（FIX-05 §18-§21 核心断言）。
    expect(runtime.setWorldTransform(null)).toBe(true);
    expect(setLocalPosition).toHaveBeenLastCalledWith(0, 0, 0);
    expect(setLocalEulerAngles).toHaveBeenLastCalledWith(0, 0, 180);
    expect(setLocalScale).toHaveBeenLastCalledWith(1, 1, 1);
  });

  it('base 非恒等（任意旋转）→ 合成 → 恒等恢复 base 非恒等', async () => {
    const base = { pos: { x: 5, y: 2, z: 0 }, rot: { x: 0, y: 45, z: 0 }, scale: { x: 2, y: 2, z: 2 } };
    const { setLocalPosition, setLocalEulerAngles, setLocalScale, root } = entityWithBase(base);
    const fake = makeFakeHandle({ root });
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions());
    // W = 平移 + 缩放，无旋转 → 合成位置 = W.position + R(W)·S(W)·base.position
    // = (10,0,0) + 3*(5,2,0) = (25,6,0)。
    expect(runtime.setWorldTransform({ position: { x: 10, y: 0, z: 0 }, rotation: null, scale: { x: 3, y: 3, z: 3 } })).toBe(true);
    expect(setLocalPosition).toHaveBeenCalledWith(25, 6, 0);
    expect(setLocalScale).toHaveBeenCalledWith(6, 6, 6); // W.scale * base.scale
    // 改回恒等 → 恢复 base 非恒等（position/rotation/scale 全部回原值）。
    expect(runtime.setWorldTransform(null)).toBe(true);
    expect(setLocalPosition).toHaveBeenLastCalledWith(5, 2, 0);
    expect(setLocalEulerAngles).toHaveBeenLastCalledWith(0, 45, 0);
    expect(setLocalScale).toHaveBeenLastCalledWith(2, 2, 2);
  });
});

describe('FIX-02 viewpoints', () => {
  it('selectViewpoint 把视角 pose 经世界变换换算后注入标注并 select', async () => {
    const fake = makeFakeHandle();
    (fake.state as Record<string, unknown>).loaded = true;
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({
      worldTransform: { position: { x: 10, y: 0, z: 0 }, rotation: null, scale: null },
      viewpoints: [
        { id: 'vp-a', name: 'A', position: { x: 0, y: 1.6, z: 0 }, target: { x: 0, y: 1, z: -2 }, fov: 55, orderIndex: 0, enabled: true },
      ],
    }));
    expect(runtime.getViewpoints()).toHaveLength(1);
    expect(runtime.selectViewpoint('vp-a')).toBe(true);
    expect(fake.selectAnnotation).toHaveBeenCalledTimes(1);
    const idx = (fake.selectAnnotation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const injected = readInjectedAnnotation(fake, idx);
    // position (0,1.6,0) → +10 → (10,1.6,0)
    expect(injected.camera.initial.position).toEqual([10, 1.6, 0]);
    expect(injected.camera.initial.target).toEqual([10, 1, -2]);
    expect(injected.camera.initial.fov).toBe(55);
    // extras 无 annotationId → 不会被当真实标注
    expect(injected.extras).toEqual({ gsplatform: {} });
  });

  it('selectViewpoint 找不到 / disabled 视角返回 false', async () => {
    const fake = makeFakeHandle();
    (fake.state as Record<string, unknown>).loaded = true;
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({
      viewpoints: [{ id: 'vp-off', name: '关', position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 1 }, fov: 60, orderIndex: 0, enabled: false }],
    }));
    expect(runtime.selectViewpoint('vp-off')).toBe(false);
    expect(runtime.selectViewpoint('no-such')).toBe(false);
    expect(fake.selectAnnotation).not.toHaveBeenCalled();
  });

  it('重复 select 同一视角复用同一条注入标注（index 稳定，不重复追加）', async () => {
    const fake = makeFakeHandle();
    (fake.state as Record<string, unknown>).loaded = true;
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({
      viewpoints: [{ id: 'vp-1', name: 'A', position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 1 }, fov: 60, orderIndex: 0, enabled: true }],
    }));
    runtime.selectViewpoint('vp-1');
    runtime.selectViewpoint('vp-1');
    expect(fake.selectAnnotation).toHaveBeenCalledTimes(2);
    const i0 = (fake.selectAnnotation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const i1 = (fake.selectAnnotation as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(i0).toBe(i1);
    expect((fake.annotations as unknown as unknown[]).length).toBe(1);
  });

  it('未加载时 selectViewpoint 静默跳过（不抛错）', async () => {
    const fake = makeFakeHandle(); // loaded=false
    mockedCreateViewer.mockResolvedValueOnce(fake);
    const runtime = await SuperSplatRuntime.create(defaultOptions({
      viewpoints: [{ id: 'vp-1', name: 'A', position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 1 }, fov: 60, orderIndex: 0, enabled: true }],
    }));
    expect(runtime.selectViewpoint('vp-1')).toBe(true);
    expect(fake.selectAnnotation).not.toHaveBeenCalled();
  });
});
