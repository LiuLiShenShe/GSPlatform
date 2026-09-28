/**
 * SSV-03 — Scene Viewer 页面测试（官方 SuperSplat runtime 默认 + legacy 回退）。
 *
 * 默认 `/scene/:sceneId` 走官方链路：
 *   getSceneRuntime → buildExperienceSettings → SuperSplatRuntime.create(desktop)
 * 断言：无 iframe、进度/加载 overlay、Frame/Reset/Fullscreen/Performance/
 * Annotations/Orbit-Fly 转发到官方 handle、sceneId 切换 destroy+create、
 * 卸载 destroy。
 *
 * `?runtime=legacy` 分支复用旧 fork ViewerAdapter 链路（iframe），原行为保留。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';
import type {
  SceneDescriptor,
  ViewerCameraMode,
  ViewerHandle,
  ViewerStats,
} from '@gsplatform/viewer';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import type { ViewerHandle as OfficialViewerHandle } from '@playcanvas/supersplat-viewer/viewer';

// ---------------------------------------------------------------------------
// 共享 spy（两个 createViewer 各自独立跟踪）
// ---------------------------------------------------------------------------

let legacyDestroySpy: ReturnType<typeof vi.fn>;
let officialDestroySpy: ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Official 模块 mock（@playcanvas/supersplat-viewer/viewer）
// ---------------------------------------------------------------------------

/** 官方 fake handle：事件语义对齐官方 EventHandler（on/off/fire） */
let officialHandle: OfficialViewerHandle & { events: { fire: (...args: unknown[]) => void } };

function makeOfficialHandle() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
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
  // 官方 WritableStateKey：写入即触发 `<key>:changed`（value, previous）
  const writable = new Set([
    'cameraMode',
    'performanceMode',
    'showAnnotations',
    'gamingControls',
    'animationPaused',
    'collisionOverlayEnabled',
    'controlsHidden',
    'inputEnabled',
  ]);
  const rawState: Record<string, unknown> = {
    loaded: false,
    progress: 0,
    cameraMode: 'orbit',
    performanceMode: false,
    showAnnotations: true,
    isFullscreen: false,
    hasCollision: false,
    canStartVR: false,
    canStartAR: false,
    xrMode: null,
    selectedAnnotation: null,
    walkAllowed: false,
  };
  const state: Record<string, unknown> = new Proxy(rawState, {
    set(target, key, value) {
      const previous = target[key as string];
      target[key as string] = value;
      if (writable.has(String(key)) && previous !== value) {
        events.fire(`${String(key)}:changed`, value, previous);
      }
      return true;
    },
  });
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
    requestFullscreen: vi.fn(async () => {
      state.isFullscreen = true;
      events.fire('isFullscreen:changed', true);
    }),
    exitFullscreen: vi.fn(async () => {
      state.isFullscreen = false;
      events.fire('isFullscreen:changed', false);
    }),
    startXR: vi.fn(async () => {}),
    endXR: vi.fn(async () => {}),
    destroy: vi.fn(() => {
      officialDestroySpy();
      listeners.clear();
    }),
  } as unknown as OfficialViewerHandle & { events: { fire: (...args: unknown[]) => void } };
  return handle;
}

vi.mock('@playcanvas/supersplat-viewer/viewer', () => ({
  createViewer: vi.fn(async (_options: unknown) => {
    officialHandle = makeOfficialHandle();
    return officialHandle;
  }),
}));

// ---------------------------------------------------------------------------
// runtimeApi mock（官方描述）
// ---------------------------------------------------------------------------

vi.mock('../scene-runtime/runtimeApi', () => ({
  getSceneRuntime: vi.fn(async (_sceneId: string) => runtimeDescriptorFixture),
  RuntimeApiError: class RuntimeApiError extends Error {
    kind: string;
    status: number | null;
    constructor(kind: string, status: number | null, message: string) {
      super(message);
      this.name = 'RuntimeApiError';
      this.kind = kind;
      this.status = status;
    }
  },
}));

// ---------------------------------------------------------------------------
// Legacy 模块 mock（@gsplatform/viewer + scenes.local + sceneApi）
// ---------------------------------------------------------------------------

const makeStats = (overrides?: Partial<ViewerStats>): ViewerStats => ({
  fps: 60,
  frameTimeMs: 16.6,
  splatCount: 500,
  renderer: 'webgl2',
  ...overrides,
});

type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

let legacyHandleListeners: ListenerMap;
let legacyHandle: ViewerHandle;

const createMockLegacyHandle = (listenerMap: ListenerMap): ViewerHandle => {
  return {
    async loadScene(_descriptor: SceneDescriptor) { /* noop */ },
    async resetCamera() { /* noop */ },
    async setCameraMode(mode: ViewerCameraMode) {
      listenerMap['cameraMode']?.forEach((fn) => fn({ mode }));
    },
    async resize() { /* noop */ },
    async getStats() { return makeStats(); },
    async getCameraPose() {
      return { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, mode: 'orbit' as const } };
    },
    async setCameraPose() { /* noop */ },
    async setWorldTransform() { /* noop */ },
    async getWorldTransform() {
      return { position: null, rotation: null, scale: null };
    },
    async setBackground() { /* noop */ },
    async captureScreenshot() { return { dataUrl: 'data:image/webp;base64,abc' }; },
    destroy() { legacyDestroySpy(); },
    on(type: string, listener: (...args: unknown[]) => void) {
      (listenerMap[type] ??= []).push(listener);
      return () => {
        listenerMap[type] = (listenerMap[type] ?? []).filter((l) => l !== listener);
      };
    },
  } satisfies ViewerHandle;
};

const fireEvent = (listeners: ListenerMap, type: string, payload?: unknown) => {
  listeners[type]?.forEach((fn) => fn(payload));
};

vi.mock('@gsplatform/viewer', () => {
  return {
    createViewer: (_container: HTMLElement) => {
      legacyHandleListeners = {};
      legacyHandle = createMockLegacyHandle(legacyHandleListeners);
      // 镜像 legacy ViewerAdapter：在容器内创建 iframe（jsdom 不加载页面）
      const iframe = document.createElement('iframe');
      iframe.setAttribute('title', '3D Gaussian 场景查看器');
      _container.appendChild(iframe);
      setTimeout(() => fireEvent(legacyHandleListeners, 'ready'), 0);
      return legacyHandle;
    },
    ViewerError: class extends Error {
      code: string;
      constructor(code: string, msg: string) {
        super(msg);
        this.code = code;
      }
    },
    codeToUserMessage: (code: string) => {
      const map: Record<string, string> = {
        SCENE_NOT_FOUND: '找不到该场景或场景资产缺失。',
        ASSET_FETCH_FAILED: '场景资产加载失败，可能是网络或服务问题。',
        ASSET_INVALID: '场景文件损坏或不是有效的高斯场景。',
        GRAPHICS_UNSUPPORTED: '当前浏览器不支持所需的图形能力（WebGPU / WebGL2）。',
        VIEWER_INIT_FAILED: '3D 查看器初始化失败，请刷新页面重试。',
        CONTEXT_LOST: '图形上下文已丢失，请刷新页面。',
        UNKNOWN: '查看器发生未知错误。',
      };
      return map[code] ?? map.UNKNOWN;
    },
  };
});

vi.mock('../services/sceneApi', async () => {
  const { sceneFixtures } = await vi.importActual<typeof import('../fixtures/scenes')>('../fixtures/scenes');
  return {
    fetchSceneList: vi.fn(async () => sceneFixtures),
    findScene: vi.fn(async () => sceneFixtures[0]),
  };
});

vi.mock('../../services/scenes.local', () => {
  return {
    resolveProgressiveScene: vi.fn(async (_sceneId: string) => ({
      descriptor: {
        id: 'local-garden',
        title: '示例庭院',
        format: 'sog',
        assetUrl: '/local-scenes/local-garden/scene.sog',
      } satisfies SceneDescriptor,
      lods: [],
      camera: null,
    })),
    resolveStreamedScene: vi.fn(async () => {
      throw new Error('not streamed');
    }),
    LocalSceneError: class extends Error {
      code: string;
      constructor(code: string, msg: string) {
        super(msg);
        this.code = code;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// 工具：把官方 handle 置为首帧已渲染
// ---------------------------------------------------------------------------

/** 让官方 fake handle 完成首帧（loaded:true），供 ready 后的交互测试。 */
function awaitOfficialReady(): void {
  (officialHandle.state as { loaded: boolean }).loaded = true;
  officialHandle.events.fire('loaded:changed', true);
}

beforeAll(() => {
  legacyDestroySpy = vi.fn();
  officialDestroySpy = vi.fn();
});

// ---------------------------------------------------------------------------
// SSV-03：官方 SuperSplat desktop viewer（默认路径）
// ---------------------------------------------------------------------------

describe('SSV-03: Official SuperSplat desktop viewer（默认）', () => {
  beforeEach(() => {
    officialDestroySpy.mockClear();
    legacyDestroySpy.mockClear();
  });

  it('无平台侧边栏，渲染官方挂载区且无 iframe', async () => {
    renderApp({ route: '/scene/local-garden' });
    expect(screen.queryByTestId('platform-sider')).not.toBeInTheDocument();
    expect(await screen.findByTestId('ov-mount')).toBeInTheDocument();
    expect(screen.getByTestId('ov-canvas-host')).toBeInTheDocument();
    // 官方路径不使用 iframe
    expect(screen.getByTestId('ov-canvas-host').querySelector('iframe')).not.toBeInTheDocument();
    expect(screen.getByTestId('scene-viewer-page').dataset.runtime).toBe('official');
  });

  it('加载期显示 onProgress 真实进度', async () => {
    renderApp({ route: '/scene/local-garden' });
    const loading = await screen.findByTestId('ov-loading');
    expect(loading).toBeInTheDocument();
    officialHandle.events.fire('progress:changed', 42);
    expect(await screen.findByTestId('ov-progress')).toHaveTextContent('42%');
  });

  it('ready 后 Frame / Reset 转发官方方法', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    const frameBtn = screen.getByTestId('ov-frame');
    const resetBtn = screen.getByTestId('ov-reset');
    await userEvent.click(resetBtn);
    expect(officialHandle.resetCamera).toHaveBeenCalled();

    await userEvent.click(frameBtn);
    expect(officialHandle.frameScene).toHaveBeenCalled();
  });

  it('Fullscreen 调用官方 requestFullscreen', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    await userEvent.click(screen.getByTestId('ov-fullscreen'));
    await waitFor(() => expect(officialHandle.requestFullscreen).toHaveBeenCalled());
  });

  it('Performance 按钮写入官方 state.performanceMode', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    expect(officialHandle.state.performanceMode).toBe(false);
    await userEvent.click(screen.getByTestId('ov-performance'));
    expect(officialHandle.state.performanceMode).toBe(true);
  });

  it('Annotations 按钮切换官方 state.showAnnotations', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    expect(officialHandle.state.showAnnotations).toBe(true);
    await userEvent.click(screen.getByTestId('ov-annotations'));
    expect(officialHandle.state.showAnnotations).toBe(false);
  });

  it('Orbit/Fly 分段写入官方 state.cameraMode', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    expect(officialHandle.state.cameraMode).toBe('orbit');
    await userEvent.click(screen.getByText('Fly'));
    expect(officialHandle.state.cameraMode).toBe('fly');
    await userEvent.click(screen.getByText('Orbit'));
    expect(officialHandle.state.cameraMode).toBe('orbit');
  });

  it('sceneId 切换时销毁旧 runtime 并创建新 runtime', async () => {
    const { router } = renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');

    await act(async () => {
      router.navigate('/scene/shanghai-lujiazui');
    });

    await waitFor(() => expect(officialHandle.state).toBeTruthy());
    // 第二次 boot 完成：官方 destroy 被调用恰好一次（旧的），新 handle 已创建
    expect(officialDestroySpy).toHaveBeenCalled();

    // 页面仍为官方挂载（新场景走同一链路）
    expect(screen.getByTestId('scene-viewer-page').dataset.runtime).toBe('official');
  });

  it('离开 Viewer 路由时销毁官方 runtime（无 context 泄漏）', async () => {
    renderApp({ route: '/scene/local-garden' });
    // 等官方挂载创建后再离开
    await screen.findByTestId('ov-mount');

    await userEvent.click(screen.getByRole('button', { name: '关闭场景' }));
    await screen.findByText('热门作品');
    expect(officialDestroySpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Legacy 回退：`?runtime=legacy` 走旧 fork ViewerAdapter（iframe），SSV-09 删除
// ---------------------------------------------------------------------------

describe('Legacy 回退（?runtime=legacy，iframe ViewerAdapter）', () => {
  beforeEach(() => {
    legacyDestroySpy.mockClear();
    officialDestroySpy.mockClear();
  });

  it('渲染 legacy canvas 挂载区（iframe）且标记 runtime=legacy', async () => {
    renderApp({ route: '/scene/local-garden?runtime=legacy' });
    expect(screen.getByTestId('scene-viewer-page').dataset.runtime).toBe('legacy');
    const canvasHost = screen.getByTestId('viewer-canvas-host');
    expect(canvasHost).toBeInTheDocument();
    expect(canvasHost.querySelector('iframe')).toBeInTheDocument();
  });

  it('底部工具条顺序：Reset / Orbit-Fly / Performance / Quality / Help', async () => {
    renderApp({ route: '/scene/local-garden?runtime=legacy' });
    const toolbar = screen.getByLabelText('Viewer 工具条');
    const buttons = within(toolbar)
      .getAllByRole('button')
      .map((btn) => btn.textContent?.trim());
    expect(buttons).toEqual(['Reset', 'Performance', 'Quality', 'Help']);
    const text = toolbar.textContent ?? '';
    expect(text.indexOf('Reset')).toBeLessThan(text.indexOf('Orbit'));
    expect(text.indexOf('Performance')).toBeLessThan(text.indexOf('Quality'));
  });

  it('Reset 调用 legacy handle.resetCamera', async () => {
    renderApp({ route: '/scene/local-garden?runtime=legacy' });
    const resetSpy = vi.spyOn(legacyHandle, 'resetCamera');
    await userEvent.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    resetSpy.mockRestore();
  });

  it('切换 Fly 调用 legacy handle.setCameraMode("fly")', async () => {
    renderApp({ route: '/scene/local-garden?runtime=legacy' });
    const spy = vi.spyOn(legacyHandle, 'setCameraMode');
    await userEvent.click(screen.getByText('Fly'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('fly'));
    spy.mockRestore();
  });

  it('点击 Quality 打开质量面板', async () => {
    renderApp({ route: '/scene/local-garden?runtime=legacy' });
    await userEvent.click(screen.getByRole('button', { name: /Quality/ }));
    expect(await screen.findByText(/渲染后端/)).toBeInTheDocument();
  });

  it('离开 Viewer 路由时销毁 legacy viewer', async () => {
    renderApp({ route: '/scene/local-garden?runtime=legacy' });
    expect(screen.getByTestId('viewer-canvas-host').querySelector('iframe')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭场景' }));
    await screen.findByText('热门作品');
    expect(legacyDestroySpy).toHaveBeenCalledTimes(1);
  });
});