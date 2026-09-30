/**
 * SSV-07 §3/§4 —— OfficialViewerToolbar Walk 按钮。
 *
 * Walk 入口只做三件事：显示官方 walkAllowed / 调官方 toggleWalk / 显示官方
 * cameraMode；尺度异常（needsCalibration）时禁用 —— 不默默用错误尺度走路。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OfficialViewerToolbar } from '../features/viewer-official/OfficialViewerToolbar';
import type { OfficialDesktopViewerState } from '../features/viewer-official/useSuperSplatDesktop';
import type { RuntimeCameraMode } from '../scene-runtime/SuperSplatRuntime';

function fakeState(overrides: Partial<OfficialDesktopViewerState> = {}): OfficialDesktopViewerState {
  return {
    status: 'ready',
    error: null,
    progress: 100,
    renderer: 'webgl2',
    loaded: true,
    gsplats: 100,
    cameraMode: 'orbit' as RuntimeCameraMode,
    performanceMode: false,
    showAnnotations: true,
    isFullscreen: false,
    hasCollision: true,
    walkAllowed: true,
    collisionStale: false,
    effectiveWalkAllowed: true,
    collisionFormat: 'voxel',
    sceneScale: { horizontalExtent: 10, verticalExtent: 3, status: 'ok', needsCalibration: false },
    canStartVR: false,
    descriptor: null,
    isManifestFallback: false,
    containerRef: { current: null },
    runtimeRef: { current: null },
    retry: vi.fn(),
    frameScene: vi.fn(),
    resetCamera: vi.fn(),
    setCameraPose: vi.fn(),
    selectViewpoint: vi.fn(),
    viewpoints: [],
    requestFullscreen: vi.fn(),
    exitFullscreen: vi.fn(),
    setCameraMode: vi.fn(),
    togglePerformanceMode: vi.fn(),
    toggleAnnotationsVisibility: vi.fn(),
    toggleWalk: vi.fn(),
    selectedGsplatformAnnotation: null,
    ...overrides,
  };
}

describe('Walk button (SSV-07 §3 / §4)', () => {
  it('walkAllowed 且尺度正常 → 可点击；点击调用 toggleWalk', () => {
    const toggleWalk = vi.fn();
    render(<OfficialViewerToolbar state={fakeState({ toggleWalk })} />);
    const button = screen.getByTestId('ov-walk');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(toggleWalk).toHaveBeenCalledTimes(1);
  });

  it('walkAllowed=false（无碰撞/场景过小）→ 禁用', () => {
    render(<OfficialViewerToolbar state={fakeState({ walkAllowed: false })} />);
    expect(screen.getByTestId('ov-walk')).toBeDisabled();
  });

  it('尺度异常（needsCalibration）→ 禁用，即使官方 walkAllowed', () => {
    render(
      <OfficialViewerToolbar
        state={fakeState({
          sceneScale: { horizontalExtent: 0.4, verticalExtent: 0.3, status: 'too-small', needsCalibration: true },
        })}
      />,
    );
    expect(screen.getByTestId('ov-walk')).toBeDisabled();
  });

  it('FIX-05 §24：碰撞 STALE（世界变换构建后改变）→ 禁用，即使官方 walkAllowed', () => {
    render(
      <OfficialViewerToolbar
        state={fakeState({
          walkAllowed: true,
          collisionStale: true,
          effectiveWalkAllowed: false,
        })}
      />,
    );
    const button = screen.getByTestId('ov-walk');
    expect(button).toBeDisabled();
  });

  it('FIX-05 §24：碰撞未 STALE → 可点击（有效 walk 允许）', () => {
    const toggleWalk = vi.fn();
    render(
      <OfficialViewerToolbar
        state={fakeState({ walkAllowed: true, collisionStale: false, effectiveWalkAllowed: true, toggleWalk })}
      />,
    );
    const button = screen.getByTestId('ov-walk');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(toggleWalk).toHaveBeenCalledTimes(1);
  });

  it('cameraMode=walk → 按钮呈激活态（Walk ✓）', () => {
    render(<OfficialViewerToolbar state={fakeState({ cameraMode: 'walk' as RuntimeCameraMode })} />);
    expect(screen.getByTestId('ov-walk')).toHaveTextContent('Walk ✓');
  });
});
