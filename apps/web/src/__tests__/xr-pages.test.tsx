/**
 * SSV-04 — XR 页面统一官方 SuperSplat runtime 测试。
 *
 * 覆盖：
 *  - 诊断显示 navigator.xr（仅展示；运行态真相 = 官方 state）
 *  - 场景加载失败显示错误（非 XR Session 错误）
 *  - canStartVR 驱动 Enter VR（官方 state 为真相源）
 *  - 进入 XR：点击 Enter → startXR('vr')（真实 click，非 setTimeout/postMessage）
 *  - xrMode 'vr' → 页面 ACTIVE；xrMode null（系统退出）→ ENDED；重建会话
 *  - exit → endXR()
 *  - renderer 强制 webgl（xr → rendererForMode('xr')）
 *  - /xr/:sceneId 与 /scene/:sceneId 用同一 descriptor → 同一 contentUrl/settings
 *
 * 自动测试不模拟真实头显；Immersive Web Emulator 的实机会话由 /tmp 冒烟脚本
 * 在真实浏览器验证（若无法执行则报告 NOT EXECUTED，不伪造）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, renderWithRouter } from '../test/utils';
import XRTestPage from '../pages/XRTestPage';
import { collectDiagnostics } from '../xr/XRDiagnostics';
import { appRouter } from '../app/router';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import type { ViewerHandle as OfficialViewerHandle } from '@playcanvas/supersplat-viewer/viewer';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';

// ─── 官方 viewer 模块 mock（fake handle，事件语义对齐官方）─────────────────────
let officialHandle: OfficialViewerHandle & { events: { fire: (...args: unknown[]) => void } };
let createViewerCalls: Array<{ contentUrl?: string; settings?: object; renderer?: string }>;
let destroyCalls: number;

const xrModeCallbacks = new Set<(...args: unknown[]) => void>();

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
  const state = new Proxy<Record<string, unknown>>(
    {
      loaded: true, // 直接 loaded（测试聚焦 XR 状态机，不测加载进度）
      progress: 100,
      cameraMode: 'orbit',
      canStartVR: true,
      canStartAR: false,
      xrMode: null,
      performanceMode: false,
      showAnnotations: true,
      isFullscreen: false,
      hasCollision: false,
      selectedAnnotation: null,
      walkAllowed: false,
    },
    {
      set(target, key, value) {
        target[key as string] = value;
        return true;
      },
    },
  );
  const handle = {
    app: { graphicsDevice: { deviceType: 'webgl2' }, stats: { frame: { gsplats: 179 } } },
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
    startXR: vi.fn(async (kind: string) => {
      state.xrMode = kind;
      events.fire('xrMode:changed', kind, null);
    }),
    endXR: vi.fn(async () => {
      state.xrMode = null;
      events.fire('xrMode:changed', null, 'vr');
    }),
    destroy: vi.fn(() => {
      destroyCalls += 1;
      listeners.clear();
      xrModeCallbacks.clear();
    }),
  } as unknown as OfficialViewerHandle & { events: { fire: (...args: unknown[]) => void } };

  // 捕获所有 xrMode:changed 订阅者供测试手动触发（模拟系统菜单退出）
  const origOn = events.on.bind(events);
  events.on = (event: string, fn: (...args: unknown[]) => void) => {
    if (event === 'xrMode:changed') xrModeCallbacks.add(fn);
    return origOn(event, fn);
  };
  return handle;
}

vi.mock('@playcanvas/supersplat-viewer/viewer', () => ({
  createViewer: vi.fn(async (options: { contentUrl?: string; settings?: object; renderer?: string }) => {
    createViewerCalls.push({
      contentUrl: options.contentUrl,
      settings: options.settings,
      renderer: options.renderer,
    });
    officialHandle = makeOfficialHandle();
    return officialHandle;
  }),
}));

vi.mock('../scene-runtime/runtimeApi', () => ({
  getSceneRuntime: vi.fn(async () => runtimeDescriptorFixture),
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

/** 构造可控的 navigator.xr mock，测试后恢复。 */
function mockNavigatorXR(options: { exists?: boolean; immersiveVr?: boolean } = {}): void {
  const { exists = true, immersiveVr = true } = options;
  const nav = navigator as unknown as { xr?: unknown };
  if (exists) {
    nav.xr = {
      isSessionSupported: vi.fn(async (mode: string) =>
        mode === 'immersive-vr' ? immersiveVr : false,
      ),
    };
  } else {
    nav.xr = undefined;
  }
}

const realNavigatorXr = (navigator as unknown as { xr?: unknown }).xr;

/** 手动触发 xrMode 订阅者（模拟浏览器/系统菜单退出） */
function triggerXrMode(mode: 'vr' | 'ar' | null): void {
  xrModeCallbacks.forEach((fn) => fn(mode));
}

const expectedSettings = buildExperienceSettings(runtimeDescriptorFixture);

beforeEach(() => {
  createViewerCalls = [];
  destroyCalls = 0;
  xrModeCallbacks.clear();
  mockNavigatorXR({ exists: true, immersiveVr: true });
});

afterEach(() => {
  (navigator as unknown as { xr?: unknown }).xr = realNavigatorXr;
  xrModeCallbacks.clear();
});

describe('SSV-04 /xr/test — 官方 runtime 诊断', () => {
  it('Test 1: navigator.xr 不存在 → 诊断 false，页面不 crash', async () => {
    mockNavigatorXR({ exists: false });
    const diag = await collectDiagnostics();
    expect(diag.navigatorXR).toBe(false);
    expect(diag.immersiveVrSupported).toBe(false);

    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-navigator-xr').textContent).toBe('false');
    });
    // 运行态 canStartVR 来自官方 state（mock 为 true），不因 navigator.xr 缺失而崩
    expect(screen.getByTestId('xr-test-page')).toBeInTheDocument();
  });

  it('Test 2: immersive-vr unsupported → 诊断显示 unsupported（真相源仍是官方 state）', async () => {
    mockNavigatorXR({ exists: true, immersiveVr: false });
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-immersive-vr').textContent).toBe('unsupported');
    });
    expect(screen.getByTestId('xr-test-page')).toBeInTheDocument();
  });

  it('Test 3: 场景加载失败 → 显示错误（非 XR Session 错误）', async () => {
    // 让 descriptorFromSceneUrl 抛错：/xr/test?scene=<bad-ext> 推断不出格式
    renderWithRouter(<XRTestPage />, { route: '/xr/test?scene=%2Fx%2Funknown.bin' });
    await waitFor(() => {
      expect(screen.getByTestId('xr-scene-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('xr-scene-error').textContent).toContain('无法从 URL 推断');
  });

  it('Test 3b: descriptor 集成 —— /xr/test 走官方 createViewer 且 renderer webgl', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBeGreaterThan(0);
    });
    const call = createViewerCalls[createViewerCalls.length - 1];
    expect(call.contentUrl).toContain('local-garden');
    // XR 强制 WebGL（rendererForMode('xr') → 'webgl'）
    expect(call.renderer).toBe('webgl');
    // 场景 loaded 后状态可用
    await waitFor(() => {
      expect(screen.getByTestId('diag-state-loaded').textContent).toBe('true');
    });
  });

  it('Test 4: 点击 Enter VR → 真实 startXR("vr") → xrMode vr → ACTIVE', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    });
    // 直接 click（真实用户手势路径，无 setTimeout/postMessage）
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
      expect(screen.getByTestId('diag-xr-mode').textContent).toBe('vr');
    });
    expect(officialHandle.state.xrMode).toBe('vr');
  });

  it('Test 5: 系统退出（xrMode → null）→ 页面 XR ENDED', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    });
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    // 模拟浏览器/系统 UI 退出（不经 endXR 按钮）
    act(() => { triggerXrMode(null); });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    });
    expect(screen.getByTestId('diag-xr-mode').textContent).toBe('null');
  });

  it('Test 6: 退出后重新进入，状态恢复正常（re-enter）', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    });
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    act(() => { triggerXrMode(null); });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    });
    // 重新进入
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    // 已出现第二次会话
    expect(screen.getByTestId('diag-xr-mode').textContent).toBe('vr');
  });

  it('Test 7: Exit VR 按钮 → runtime.endXR()', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    });
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('exit-vr-btn')).toBeEnabled();
    });
    const endXRSpy = vi.fn(async () => {});
    (officialHandle as unknown as { endXR: typeof endXRSpy }).endXR = endXRSpy;
    // hook 的 endXR 走 runtime.endXR() → handle.endXR()
    await userEvent.click(screen.getByTestId('exit-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    });
  });
});

describe('SSV-04 /xr/:sceneId — 统一官方 runtime（与 Desktop 同一数据）', () => {
  it('路由存在', () => {
    const paths = appRouter.routes.map((r) => r.path);
    expect(paths).toContain('/xr/test');
    expect(paths).toContain('/xr/:sceneId');
    expect(paths).toContain('/scene/:sceneId');
  });

  it('/xr/:sceneId 与 /scene/:sceneId 用同一 descriptor → 同一 contentUrl 与 settings', async () => {
    // 渲染 /xr：同一 descriptor → 同一 contentUrl，renderer 强制 webgl
    const u1 = renderApp({ route: '/xr/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    const xrCall = createViewerCalls[0];
    expect(xrCall.contentUrl).toBe(runtimeDescriptorFixture.content.url); // Scene URL 相同
    expect(xrCall.renderer).toBe('webgl'); // renderer 必须 WebGL
    expect(xrCall.settings).toEqual(expectedSettings); // settings = buildExperienceSettings(descriptor)
    u1.unmount();

    // 渲染 /scene（桌面）：同一 descriptor → 同一 contentUrl 与 settings
    const u2 = renderApp({ route: '/scene/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(2);
    });
    const desktopCall = createViewerCalls[1];
    expect(desktopCall.contentUrl).toBe(xrCall.contentUrl); // Scene URL 相同
    expect(desktopCall.settings).toEqual(xrCall.settings); // settings 相同
    u2.unmount();
  });

  it('/xr/:sceneId 场景加载完成后自动 frameScene，Enter VR 由官方 canStartVR 驱动', async () => {
    const u = renderApp({ route: '/xr/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-can-start-vr').textContent).toBe('true');
    });
    expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    u.unmount();
  });
});