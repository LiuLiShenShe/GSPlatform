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
// FIX-XR-01: 每次 createViewer 返回的 handle 初始状态（默认 loaded:true 尽快加载，
// 兼容既有测试；异步加载测试置 loaded:false 再手动触发加载完成）。
let nextHandleOptions: { loaded?: boolean; canStartVR?: boolean } = {};

const xrModeCallbacks = new Set<(...args: unknown[]) => void>();

function makeOfficialHandle(options: { loaded?: boolean; canStartVR?: boolean } = {}) {
  const listOptions = {
    // FIX-XR-01: 可控初始加载状态（loaded=false 时模拟真实异步加载；默认尽快加载如旧）
    loaded: options.loaded ?? true,
    canStartVR: options.canStartVR ?? true,
  };
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
      loaded: listOptions.loaded,
      progress: listOptions.loaded ? 100 : 0,
      cameraMode: 'orbit',
      canStartVR: listOptions.canStartVR,
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
    officialHandle = makeOfficialHandle(nextHandleOptions);
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
  nextHandleOptions = {};
  mockNavigatorXR({ exists: true, immersiveVr: true });
});

afterEach(() => {
  (navigator as unknown as { xr?: unknown }).xr = realNavigatorXr;
  xrModeCallbacks.clear();
});

/** FIX-XR-01: 触发异步加载完成 —— state.loaded 翻转 + 官方 loaded:changed 事件。 */
function completeAsyncLoad(): void {
  act(() => {
    setHandleState({ loaded: true, progress: 100 });
    officialHandle.events.fire('loaded:changed', true);
  });
}

/** FIX-XR-01: 官方 ViewerState 的 loaded/progress 只读 —— 测试经受控转写修改。 */
function setHandleState(patch: { loaded?: boolean; progress?: number }): void {
  const state = (officialHandle as unknown as { state: Record<string, unknown> }).state;
  if (patch.loaded !== undefined) state.loaded = patch.loaded;
  if (patch.progress !== undefined) state.progress = patch.progress;
}

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

  // ------------------------------------------------------------------ //
  // FIX-04 §2/§3 —— 正式页产品化 + 诊断迁移
  // ------------------------------------------------------------------ //

  it('FIX-04 §2: /xr/:sceneId 是正式产品页（极简 UI，工程诊断表不显示）', async () => {
    const u = renderApp({ route: '/xr/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-state-loaded').textContent).toBe('true');
    });
    // 极简产品 UI：Scene Name / Enter VR / Back（退出 VR 仅在会话中显示）
    expect(screen.getByTestId('xr-scene-name')).toBeInTheDocument();
    expect(screen.getByTestId('enter-vr-btn')).toBeInTheDocument();
    expect(screen.getByTestId('xr-back-link')).toBeInTheDocument();
    expect(screen.getByTestId('xr-hint')).toBeInTheDocument();
    // 正式页不显示开发诊断面板（绿色 monospace 表格 / .xr-page）
    expect(document.querySelector('.xr-page__table')).toBeNull();
    expect(document.querySelector('.xr-page')).toBeNull();
    // 进入 VR 前隐藏 Exit VR（仅在会话中显示）
    expect(screen.queryByTestId('exit-vr-btn')).toBeNull();
    u.unmount();
  });

  it('FIX-04 §2: 诊断读数经视觉隐藏 span 暴露（e2e 取证契约保留，不可见）', async () => {
    const u = renderApp({ route: '/xr/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-state-loaded').textContent).toBe('true');
    });
    for (const id of [
      'diag-state-loaded',
      'diag-renderer',
      'diag-can-start-vr',
      'diag-gsplats',
      'diag-has-collision',
      'diag-walk-allowed',
      'diag-camera',
    ]) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute('class')).toContain('gs-xr__diag');
    }
    // 汇总诊断 JSON（含 renderer / gsplats / camera）
    const json = JSON.parse(screen.getByTestId('ov-xr-diagnostics').textContent ?? '{}');
    expect(json.renderer).toBe('webgl2');
    expect(json.canStartVR).toBe(true);
    u.unmount();
  });

  it('FIX-04 §3: /xr/diagnostics/:sceneId 路由存在并走 DB 合同同链路（renderer webgl）', async () => {
    const paths = appRouter.routes.map((r) => r.path);
    expect(paths).toContain('/xr/diagnostics/:sceneId');

    const u = renderApp({ route: '/xr/diagnostics/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    const call = createViewerCalls[0];
    expect(call.contentUrl).toBe(runtimeDescriptorFixture.content.url);
    expect(call.renderer).toBe('webgl');
    // 诊断页完整工程读数（UA / collision / walk / camera）
    await waitFor(() => {
      expect(screen.getByTestId('diag-user-agent').textContent?.length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('diag-has-collision')).toBeInTheDocument();
    expect(screen.getByTestId('diag-walk-allowed')).toBeInTheDocument();
    u.unmount();
  });
});

// ────────────────────────────────────────────────────────────────────────── //
// FIX-XR-01 —— 异步加载状态机（PICO Neo3 真实故障复现）
// 真实设备：loaded=true / canStartVR=true 但页面停留在 LOADING，Enter/Frame 不可用。
// 根因：Runtime.onLoaded(true) 只更新 loaded 不迁移 status loading → ready。
// 以下全部使用可控异步 mock（createViewer 返回 loaded:false，随后
// completeAsyncLoad() 触发官方 loaded:changed），禁止直接初始 loaded:true 绕绿。
// ────────────────────────────────────────────────────────────────────────── //
describe('FIX-XR-01 — 异步加载 → READY 状态机（真实异步 mock，非立即 loaded）', () => {
  /* Test 1：异步加载完成 → READY → Enter/Frame Scene 可用 */
  it('Test 1: onLoaded(true) 后 loading → ready，Enter VR / Frame Scene 可用', async () => {
    nextHandleOptions = { loaded: false };
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    // 初始 fully loaded=false → 页面必须仍在 LOADING（不得提前 ready）
    expect(screen.getByTestId('xr-state').textContent).toContain('LOADING');
    expect(screen.getByTestId('enter-vr-btn')).toBeDisabled();
    expect(screen.getByTestId('frame-scene-btn')).toBeDisabled();

    completeAsyncLoad(); // state.loaded=false→true + loaded:changed(true)

    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('READY');
    });
    expect(screen.getByTestId('diag-state-loaded').textContent).toBe('true');
    expect(screen.getByTestId('diag-can-start-vr').textContent).toBe('true');
    expect(screen.getByTestId('frame-scene-btn')).toBeEnabled();
    expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    // 未进入 XR：Exit VR 仍禁用（xrMode null）
    expect(screen.getByTestId('exit-vr-btn')).toBeDisabled();
  });

  /* Test 2：loaded=true 但官方 canStartVR=false → READY 但不能进入（不绕过官方能力） */
  it('Test 2: canStartVR=false 时 READY 但 Enter VR 禁用（官方能力为真相）', async () => {
    nextHandleOptions = { loaded: true, canStartVR: false };
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-can-start-vr').textContent).toBe('false');
    });
    // loaded=true 的单个 create() 后一次性 ready 检查 → 状态 READY
    expect(screen.getByTestId('xr-state').textContent).toContain('READY');
    expect(screen.getByTestId('frame-scene-btn')).toBeEnabled();
    // 官方 canStartVR=false → Enter VR 必须禁用（绝不因页面 ready 就放行）
    expect(screen.getByTestId('enter-vr-btn')).toBeDisabled();
  });

  /* Test 3：loaded 事件未到达（仅 state.loaded 被轮询观察到）→ refresh 兜底 READY */
  it('Test 3: 加载事件未触发、仅轮询观察到 loaded → refresh 兜底 READY（fake timers）', async () => {
    nextHandleOptions = { loaded: false };
    vi.useFakeTimers();
    try {
      renderWithRouter(<XRTestPage />, { route: '/xr/test' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // flush boot promise chain
      });
      expect(screen.getByTestId('xr-state').textContent).toContain('LOADING');
      // 加载完成但 loaded:changed 事件缺失（只翻官方 state，不 fire 事件）
      act(() => {
        setHandleState({ loaded: true, progress: 100 });
      });
      // 超过 STATS_POLL_MS=1000 的轮询周期 → refresh() 观察到 loaded
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(screen.getByTestId('xr-state').textContent).toContain('READY');
      expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  /* Test 4：进入 XR 后 refresh / onLoaded(true) 不得将 XR-ACTIVE 改回 READY */
  it('Test 4: xr-active 后 onLoaded(true)/refresh 不得覆盖为 READY', async () => {
    nextHandleOptions = { loaded: false };
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    completeAsyncLoad();
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('READY');
    });
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
      expect(screen.getByTestId('diag-xr-mode').textContent).toBe('vr');
    });
    // 已 active；再触发 onLoaded(true) + 轮询 refresh —— 必须仍 XR-ACTIVE
    completeAsyncLoad();
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    expect(screen.getByTestId('diag-xr-mode').textContent).toBe('vr');
  });

  /* Test 5：退出后 refresh 不得将 XR-ENDED 改回 READY，且允许再次进入 */
  it('Test 5: xr-ended 后 refresh 不得覆盖，且可再次 Enter', async () => {
    nextHandleOptions = { loaded: false };
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    completeAsyncLoad();
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('READY');
    });
    await userEvent.click(screen.getByTestId('enter-vr-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    act(() => {
      triggerXrMode(null); // 系统退出
    });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    });
    // ended 后再触发 loaded(true)/refresh —— 必须仍 XR-ENDED，不得回 READY
    completeAsyncLoad();
    expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    // 允许再次进入
    expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
  });

  /* Test 6：旧 Runtime 卸载/销毁后，晚到的 onLoaded(true) 不得重建/污染 */
  it('Test 6: 卸载后旧 runtime 的晚到 loaded 事件不重建 viewer、不污染新页面', async () => {
    nextHandleOptions = { loaded: false };
    const A = renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    A.unmount(); // 销毁 A 的 runtime（cancelled + unsub + destroy）
    const createdBefore = createViewerCalls.length;
    // A 的 onLoaded(true) 晚到（旧 handle 仍可 fire）→ 不得重建、不得污染
    act(() => {
      setHandleState({ loaded: true });
      officialHandle.events.fire('loaded:changed', true);
    });
    expect(createViewerCalls.length).toBe(createdBefore); // 没有重建 viewer
    // B 页面新挂载：A 的晚到事件不得提前把 B 弄成 READY/B 正常异步
    const B = renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(createdBefore + 1);
    });
    expect(screen.getByTestId('xr-state').textContent).toContain('LOADING');
    completeAsyncLoad(); // B 自己真正加载完成 → READY
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('READY');
    });
    B.unmount();
  });

  /* §8：正式页 /xr/:sceneId 同样异步加载 → ready → Enter VR 可点击 */
  it('正式页 /xr/:sceneId：异步加载后 ready，Enter VR 可点击', async () => {
    nextHandleOptions = { loaded: false };
    const u = renderApp({ route: '/xr/r-8c4e2264e86a' });
    await waitFor(() => {
      expect(createViewerCalls.length).toBe(1);
    });
    // 正式页加载中（Loading 覆盖层可见、无 Enter）
    expect(screen.getByTestId('xr-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('enter-vr-btn')).toBeNull();
    completeAsyncLoad();
    await waitFor(() => {
      expect(screen.getByTestId('diag-state-loaded').textContent).toBe('true');
    });
    const json = JSON.parse(screen.getByTestId('ov-xr-diagnostics').textContent ?? '{}');
    expect(json.status).toBe('ready');
    expect(json.loaded).toBe(true);
    expect(json.canStartVR).toBe(true);
    expect(screen.getByTestId('enter-vr-btn')).toBeEnabled();
    u.unmount();
  });
});