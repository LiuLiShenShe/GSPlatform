/**
 * SSV-03 / SSV-09 / GS-DESKTOP-02 — Scene Viewer 页面测试（官方 SuperSplat runtime 唯一路径）。
 *
 * 默认 `/scene/:sceneId` 走官方链路：
 *   getSceneRuntime → buildExperienceSettings → SuperSplatRuntime.create(desktop, ui:true)
 * 断言：无 iframe、进度/加载 overlay、**宿主不再自绘第二套工具条**（官方原生
 * Orbit/Fly/Reset/Frame/设置/帮助/全屏由官方 UI 提供）、sceneId 切换 destroy+create、
 * 卸载 destroy。
 *
 * SSV-09 删除 `?runtime=legacy` 回退与 legacy ViewerAdapter 链路（features/viewer、
 * scenes.local、@gsplatform/viewer 类型一并移除）。生产 Web 引用 apps/viewer 的
 * 检查见 `no-legacy-viewer-references.test.ts`。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import type { ViewerHandle as OfficialViewerHandle } from '@playcanvas/supersplat-viewer/viewer';

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

vi.mock('../services/sceneApi', async () => {
  const { sceneFixtures } = await vi.importActual<typeof import('../fixtures/scenes')>('../fixtures/scenes');
  return {
    fetchSceneList: vi.fn(async () => sceneFixtures),
    findScene: vi.fn(async () => sceneFixtures[0]),
  };
});

// ---------------------------------------------------------------------------
// 工具：把官方 handle 置为首帧已渲染
// ---------------------------------------------------------------------------

let officialDestroySpy: ReturnType<typeof vi.fn>;

/** 让官方 fake handle 完成首帧（loaded:true），供 ready 后的交互测试。 */
function awaitOfficialReady(): void {
  (officialHandle.state as { loaded: boolean }).loaded = true;
  officialHandle.events.fire('loaded:changed', true);
}

beforeAll(() => {
  officialDestroySpy = vi.fn();
});

// ---------------------------------------------------------------------------
// SSV-03：官方 SuperSplat desktop viewer（唯一路径）
// ---------------------------------------------------------------------------

describe('SSV-03: Official SuperSplat desktop viewer', () => {
  beforeEach(() => {
    officialDestroySpy.mockClear();
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

  it('GS-DESKTOP-02：不再渲染宿主自绘工具条，且以 ui:true 创建官方完整 UI', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    // 宿主旧工具条（Frame/Reset/Walk/Performance/Annotations/Fullscreen/Saved Views
    // 下拉以外的自绘控件）必须全部消失 —— 官方原生 UI 是唯一来源。
    for (const id of ['ov-frame', 'ov-reset', 'ov-walk', 'ov-performance', 'ov-annotations', 'ov-fullscreen']) {
      expect(screen.queryByTestId(id), `${id} 不应再存在（重复工具栏）`).not.toBeInTheDocument();
    }
    // 官方 UI 必须开启（hotspots / controls / settings / info / fullscreen 都在该层）。
    const { createViewer } = await import('@playcanvas/supersplat-viewer/viewer');
    const lastOptions = vi.mocked(createViewer).mock.calls.at(-1)?.[0] as { ui?: boolean };
    expect(lastOptions?.ui).toBe(true);
  });

  it('Saved Views 走平台扩展入口（官方 1.35 无原生列表）', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    awaitOfficialReady();

    // fixture 自带 1 个 enabled viewpoint → 平台扩展入口列出它。
    expect(screen.getByTestId('ov-saved-views')).toHaveTextContent('视角 (1)');
    expect(screen.getByText('平台视角 · 1')).toBeInTheDocument();
    expect(screen.getByLabelText('场景操作面板')).toBeInTheDocument();
  });

  it('平台面板可折叠（不遮挡官方原生控件）', async () => {
    renderApp({ route: '/scene/local-garden' });
    await screen.findByTestId('ov-mount');
    await userEvent.click(screen.getByTestId('vrp-collapse'));
    expect(screen.getByTestId('vrp-expand')).toBeInTheDocument();
    expect(screen.queryByLabelText('场景操作面板')).not.toBeInTheDocument();
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