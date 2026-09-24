/**
 * WebXR 修复任务 — XR 页面自动测试（§19）。
 *
 * 自动测试不声称模拟真实头显。只验证：
 *   Test A: XR 页面正常加载（诊断面板渲染）。
 *   Test B: navigator.xr 不存在 → 诊断为 false，页面不 crash。
 *   Test C: isSessionSupported('immersive-vr') = false → unsupported。
 *   Test D: startXR 抛 SecurityError → 页面显示 SecurityError。
 *   Test E: /xr/:sceneId 路由可访问。
 *   Test F: 普通 Desktop Viewer 路由未被破坏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import XRTestPage from '../pages/XRTestPage';
import { collectDiagnostics } from '../xr/XRDiagnostics';
import { appRouter } from '../app/router';

/** createXRRuntime 的可控 mock：startVR 可按需抛错。 */
const startVRMock = vi.fn(async () => {});
const endXRMock = vi.fn(async () => {});

vi.mock('../xr/XRViewerRuntime', () => ({
  createXRRuntime: vi.fn(async () => ({
    app: { graphicsDevice: { deviceType: 'webgl2' } },
    state: { loaded: true },
    events: { on: () => ({ off: () => {} }) },
    loadedPromise: Promise.resolve(),
    startVR: startVRMock,
    endXR: endXRMock,
    destroy: vi.fn(),
  })),
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
  startVRMock.mockClear();
  endXRMock.mockClear();
  mockNavigatorXR({ exists: true, immersiveVr: true });
});

afterEach(() => {
  (navigator as unknown as { xr?: unknown }).xr = realNavigatorXr;
});

describe('WebXR 修复任务 — XR 页面', () => {
  it('Test A: /xr/test 页面正常加载并显示诊断面板', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('xr-test-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('xr-state').textContent).toMatch(/WebXR state: [A-Z]+/);
    expect(screen.getByTestId('diag-Secure-Context').textContent).toBe('true');
    expect(screen.getByTestId('diag-navigator-xr').textContent).toBe('true');
    expect(screen.getByTestId('diag-Immersive-VR').textContent).toBe('supported');
  });

  it('Test B: navigator.xr 不存在 → 诊断为 false，不 crash', async () => {
    mockNavigatorXR({ exists: false });
    const diag = await collectDiagnostics();
    expect(diag.navigatorXR).toBe(false);
    expect(diag.immersiveVrSupported).toBe(false);

    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('diag-navigator-xr').textContent).toBe('false');
    });
    // unsupported + SecurityError/NotSupportedError 显示在页面
    expect(screen.getByTestId('xr-error').textContent).toContain('NotSupportedError');
  });

  it('Test C: isSessionSupported=false → unsupported 状态', async () => {
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

  it('Test D: startXR 抛 SecurityError → 页面显示 SecurityError', async () => {
    renderWithRouter(<XRTestPage />, { route: '/xr/test' });
    await waitFor(() => {
      expect(screen.getByTestId('enter-vr-btn')).toBeInTheDocument();
    });

    startVRMock.mockRejectedValueOnce(new DOMException('XR request failed', 'SecurityError'));
    act(() => {
      screen.getByTestId('enter-vr-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('xr-error')).toBeInTheDocument();
    });
    const errText = screen.getByTestId('xr-error').textContent ?? '';
    expect(errText).toContain('SecurityError');
    expect(errText).toContain('XR request failed');
    expect(startVRMock).toHaveBeenCalledTimes(1);
  });

  it('Test E: /xr/:sceneId 与 /xr/test 路由可访问', () => {
    const paths = appRouter.routes.map((r) => r.path);
    expect(paths).toContain('/xr/:sceneId');
    expect(paths).toContain('/xr/test');
  });

  it('Test F: 普通 Desktop Viewer 路由未被破坏', () => {
    const paths = appRouter.routes.map((r) => r.path);
    expect(paths).toContain('/scene/:sceneId');
    expect(paths).toContain('/login');
    expect(paths).toContain('*');
  });
});