import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';
import type { SceneDescriptor, ViewerCameraMode, ViewerHandle, ViewerStats } from '@gsplatform/viewer';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const makeStats = (overrides?: Partial<ViewerStats>): ViewerStats => ({
  fps: 60,
  frameTimeMs: 16.6,
  splatCount: 500,
  renderer: 'webgl2',
  ...overrides,
});

/** tracks all registered listeners so the mock can fire events. */
type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

const createMockHandle = (listenerMap: ListenerMap): ViewerHandle => {
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
    destroy() { destroySpy(); },
    on(type: string, listener: (...args: unknown[]) => void) {
      (listenerMap[type] ??= []).push(listener);
      return () => {
        listenerMap[type] = (listenerMap[type] ?? []).filter((l) => l !== listener);
      };
    },
  } satisfies ViewerHandle;
};

const destroySpy = vi.fn();

/** fire all listeners for an event. */
const fireEvent = (listeners: ListenerMap, type: string, payload?: unknown) => {
  listeners[type]?.forEach((fn) => fn(payload));
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let handleListeners: ListenerMap;
/** most recently created mock handle (assigned by the createViewer mock). */
let handle: ViewerHandle;

vi.mock('@gsplatform/viewer', async () => {
  return {
    createViewer: (container: HTMLElement) => {
      handleListeners = {};
      handle = createMockHandle(handleListeners);
      // Mirror the adapter: the real createViewer mounts an <iframe> in the
      // container. jsdom doesn't load the page, but the element must exist so
      // component tests can assert the mount surface is present.
      const iframe = document.createElement('iframe');
      iframe.setAttribute('title', '3D Gaussian 场景查看器');
      container.appendChild(iframe);
      // Simulate the embed's async `ready` event.
      // By the time the timeout fires, the lifecycle hook has subscribed via
      // viewer.on('ready', cb), so the listener gets invoked.
      setTimeout(() => fireEvent(handleListeners, 'ready'), 0);
      return handle;
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
    resolveLocalScene: vi.fn(async (_sceneId: string) => ({
      descriptor: {
        id: 'local-garden',
        title: '示例庭院',
        format: 'sog',
        assetUrl: '/local-scenes/local-garden/scene.sog',
      } satisfies SceneDescriptor,
      recordedSha256: 'abc123',
    })),
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
// Tests
// ---------------------------------------------------------------------------

describe('Phase 02: Scene Viewer 集成', () => {
  beforeEach(() => {
    destroySpy.mockClear();
    return () => {
      vi.clearAllMocks();
    };
  });

  it('无平台侧边栏，渲染 canvas 挂载区（iframe）', () => {
    renderApp({ route: '/scene/local-garden' });
    expect(screen.queryByTestId('platform-sider')).not.toBeInTheDocument();
    const canvasHost = screen.getByTestId('viewer-canvas-host');
    expect(canvasHost).toBeInTheDocument();
    // createViewer 在挂载区内创建 iframe
    expect(canvasHost.querySelector('iframe')).toBeInTheDocument();
  });

  it('底部工具条顺序：Reset / Orbit-Fly / Performance / Quality / Help', () => {
    renderApp({ route: '/scene/local-garden' });
    const toolbar = screen.getByLabelText('Viewer 工具条');
    const buttons = within(toolbar)
      .getAllByRole('button')
      .map((btn) => btn.textContent?.trim());
    expect(buttons).toEqual(['Reset', 'Performance', 'Quality', 'Help']);
    const text = toolbar.textContent ?? '';
    expect(text.indexOf('Reset')).toBeLessThan(text.indexOf('Orbit'));
    expect(text.indexOf('Performance')).toBeLessThan(text.indexOf('Quality'));
    // Orbit 是默认选中模式（Segmented 非按钮 role，检查 aria-pressed/checked via class）
    expect(screen.getByText('Orbit')).toBeInTheDocument();
    expect(screen.getByText('Fly')).toBeInTheDocument();
  });

  it('Reset 按钮可点击，调用 viewer.resetCamera', async () => {
    renderApp({ route: '/scene/local-garden' });
    const resetSpy = vi.spyOn(handle, 'resetCamera');
    await userEvent.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    resetSpy.mockRestore();
  });

  it('切换 Fly 调用 setCameraMode("fly")', async () => {
    renderApp({ route: '/scene/local-garden' });
    const spy = vi.spyOn(handle, 'setCameraMode');
    await userEvent.click(screen.getByText('Fly'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('fly'));
    spy.mockRestore();
  });

  it('点击 Performance 打开性能面板', async () => {
    renderApp({ route: '/scene/local-garden' });
    await userEvent.click(screen.getByRole('button', { name: /Performance/ }));
    const stats = await screen.findByRole('region', { name: /性能统计/ });
    expect(stats).toBeInTheDocument();
    expect(stats.textContent).toContain('FPS');
    expect(stats.textContent).toContain('Splats');
  });

  it('点击 Help 打开操作说明', async () => {
    renderApp({ route: '/scene/local-garden' });
    await userEvent.click(screen.getByRole('button', { name: /Help/ }));
    expect(await screen.findByText(/Orbit（轨道）模式/)).toBeInTheDocument();
    expect(screen.getByText(/WASD 移动/)).toBeInTheDocument();
  });

  it('点击 Quality 打开质量面板', async () => {
    renderApp({ route: '/scene/local-garden' });
    await userEvent.click(screen.getByRole('button', { name: /Quality/ }));
    expect(await screen.findByText(/渲染后端/)).toBeInTheDocument();
    expect(screen.getByText(/渐进加载/)).toBeInTheDocument();
  });

  it('场景标题显示 sceneId，关闭按钮回首页', async () => {
    renderApp({ route: '/scene/local-garden' });
    expect(screen.getByText('场景 local-garden')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭场景' }));
    expect(await screen.findByText('热门作品')).toBeInTheDocument();
  });

  it('右侧面板按钮顺序固定，详情可打开（fixture 场景）', async () => {
    // local-garden 是真实测试场景但不属于首页 fixture；详情弹窗需要 fixture 数据
    renderApp({ route: '/scene/shanghai-lujiazui' });
    const panel = screen.getByLabelText('场景操作面板');
    const buttons = within(panel)
      .getAllByRole('button')
      .map((btn) => btn.textContent?.trim());
    expect(buttons).toEqual(['作者', '收藏', '分享', '问 AI', '详情']);
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(await screen.findByText('高斯点数')).toBeInTheDocument();
  });

  it('离开 Viewer 路由时销毁 Viewer 实例', async () => {
    renderApp({ route: '/scene/local-garden' });
    // 等 iframe 创建后离开
    expect(screen.getByTestId('viewer-canvas-host').querySelector('iframe')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭场景' }));
    await screen.findByText('热门作品');
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});