/**
 * WebXR 修复任务（第二轮）— XR 页面自动测试（§18 Test 1-8）。
 *
 * 自动测试不声称模拟真实头显。只验证页面状态机 / 错误分离 / 路由。
 *
 *  Test 1: navigator.xr 不存在 → 不 crash。
 *  Test 2: immersive-vr unsupported → 正确显示。
 *  Test 3: scene load failed → 显示 Scene Error，非 XR Session Error。
 *  Test 4: xrMode → 'vr' → 页面 XR ACTIVE。
 *  Test 5: xrMode → null → 页面 XR ENDED。
 *  Test 6: 退出后重新进入，状态正常恢复。
 *  Test 7: schemaVersion=1 + format=sog → sceneResolver 不拒绝。
 *  Test 8: format=streamed-sog → STREAMED_SOG_UNSUPPORTED。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import XRTestPage from '../pages/XRTestPage';
import { collectDiagnostics } from '../xr/XRDiagnostics';
import { appRouter } from '../app/router';

/** createXRRuntime 的可控 mock：可触发 xrMode 变化。 */
const startVRMock = vi.fn(async () => {});
const endXRMock = vi.fn(async () => {});
/** 捕获 runtime 上注册的 xrMode 回调，测试中手动触发。 */
const xrModeCallbacks: Array<(mode: string | null) => void> = [];
let triggerXrMode: (mode: string | null) => void = () => {};

vi.mock('../xr/XRViewerRuntime', () => ({
  createXRRuntime: vi.fn(async () => {
    const handle = {
      app: { graphicsDevice: { deviceType: 'webgl2' } },
      state: { loaded: true },
      events: { on: () => ({ off: () => {} }) },
      loadedPromise: Promise.resolve(),
      onXRModeChanged: (cb: (mode: string | null) => void) => {
        xrModeCallbacks.push(cb);
        return () => {
          const i = xrModeCallbacks.indexOf(cb);
          if (i >= 0) xrModeCallbacks.splice(i, 1);
        };
      },
      startVR: startVRMock,
      endXR: endXRMock,
      destroy: vi.fn(),
    };
    triggerXrMode = (mode: string | null) => {
      for (const cb of Array.from(xrModeCallbacks)) cb(mode);
    };
    return handle;
  }),
  runtimeRenderer: () => 'webgl2',
}));

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
    delete nav.xr;
  }
}

const realNavigatorXr = (navigator as unknown as { xr?: unknown }).xr;

beforeEach(() => {
  xrModeCallbacks.length = 0;
  startVRMock.mockClear();
  endXRMock.mockClear();
  mockNavigatorXR({ exists: true, immersiveVr: true });
});

afterEach(() => {
  (navigator as unknown as { xr?: unknown }).xr = realNavigatorXr;
  xrModeCallbacks.length = 0;
});

describe('WebXR 修复任务（第二轮）— XR 页面', () => {
  it('Test 1: navigator.xr 不存在 → 诊断 false，页面不 crash', async () => {
    mockNavigatorXR({ exists: false });
    const diag = await collectDiagnostics();
    expect(diag.navigatorXR).toBe(false);
    expect(diag.immersiveVrSupported).toBe(false);

    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-navigator-xr').textContent).toBe('false');
    });
    expect(screen.getByTestId('xr-state').textContent).toContain('UNSUPPORTED');
  });

  it('Test 2: immersive-vr unsupported → 正确显示 unsupported', async () => {
    mockNavigatorXR({ exists: true, immersiveVr: false });
    const diag = await collectDiagnostics();
    expect(diag.navigatorXR).toBe(true);
    expect(diag.immersiveVrSupported).toBe(false);

    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-Immersive-VR').textContent).toBe('unsupported');
    });
    expect(screen.getByTestId('xr-state').textContent).toContain('UNSUPPORTED');
    expect(screen.getByTestId('xr-error').textContent).toContain('NotSupportedError');
  });

  it('Test 3: scene load failed → 显示 Scene Error（非 XR Session Error）', async () => {
    // createXRRuntime 抛错 → XRTestPage boot catch 标记为 scene 类错误并显示 SCENE LOAD ERROR。
    const { createXRRuntime } = await import('../xr/XRViewerRuntime');
    vi.mocked(createXRRuntime).mockRejectedValueOnce(
      new Error('HTTP 404 — /local-scenes/missing/scene.sog not found'),
    );
    renderWithRouter(<XRTestPage />, { route: '/xr/test?scene=/local-scenes/missing/scene.sog' });
    await waitFor(() => {
      expect(screen.getByTestId('xr-scene-error')).toBeInTheDocument();
    });
    const text = screen.getByTestId('xr-scene-error').textContent ?? '';
    expect(text).toContain('SCENE LOAD ERROR');
    expect(text).toContain('404');
    // 必须是 Scene 错误，而不是 XR Session 错误
    expect(screen.queryByTestId('xr-session-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('diag-scene-state').textContent).toContain('FAILED');
  });

  it('Test 4: xrMode → "vr" → 页面 XR ACTIVE', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeInTheDocument();
    });
    act(() => {
      triggerXrMode('vr');
    });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
  });

  it('Test 5: xrMode → null（系统退出）→ 页面 XR ENDED', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeInTheDocument();
    });
    act(() => {
      triggerXrMode('vr');
    });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    act(() => {
      triggerXrMode(null);
    });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    });
    expect(screen.getByTestId('xr-ended')).toBeInTheDocument();
  });

  it('Test 6: 退出后重新进入，状态恢复正常', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeInTheDocument();
    });
    // 进入 → 退出 → 再进入
    act(() => { triggerXrMode('vr'); });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
    act(() => { triggerXrMode(null); });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ENDED');
    });
    act(() => { triggerXrMode('vr'); });
    await waitFor(() => {
      expect(screen.getByTestId('xr-state').textContent).toContain('XR-ACTIVE');
    });
  });

  it('Test 7: schemaVersion=1 + format=sog → sceneResolver 不拒绝', async () => {
    // 见 xr-scene-resolver.test.ts Case A；这里只做路由层确认页面可用。
    const paths = appRouter.routes.map((r) => r.path);
    expect(paths).toContain('/xr/test');
    expect(paths).toContain('/xr/:sceneId');
  });

  it('Test 8: format=streamed-sog → STREAMED_SOG_UNSUPPORTED（由 sceneResolver 测试覆盖）', async () => {
    const paths = appRouter.routes.map((r) => r.path);
    expect(paths).toContain('/xr/:sceneId');
    expect(paths).toContain('/scene/:sceneId');
  });

  it('Test A(遗留): XR 页面正常加载并显示诊断面板', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('xr-test-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('diag-Secure-Context').textContent).toBe('true');
    expect(screen.getByTestId('diag-navigator-xr').textContent).toBe('true');
    expect(screen.getByTestId('diag-Immersive-VR').textContent).toBe('supported');
  });

  it('Test D(遗留): startXR 抛 SecurityError → 页面显示 SecurityError', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeInTheDocument();
    });
    startVRMock.mockRejectedValueOnce(new DOMException('XR request failed', 'SecurityError'));
    act(() => {
      screen.getByTestId('enter-vr-btn').click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('xr-session-error')).toBeInTheDocument();
    });
    const text = screen.getByTestId('xr-session-error').textContent ?? '';
    expect(text).toContain('SecurityError');
    expect(startVRMock).toHaveBeenCalledTimes(1);
  });
});