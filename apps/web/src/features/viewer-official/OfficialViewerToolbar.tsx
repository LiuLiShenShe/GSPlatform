/**
 * Official Desktop Viewer 工具条（SSV-03）—— 恢复 SSV-03 必须可见的功能。
 *
 *   Reset                    → runtime.resetCamera()
 *   Orbit / Fly Segmented    → 写入官方 state.cameraMode（writable key）
 *   Performance 模式         → 写入官方 state.performanceMode
 *   Annotations 可见性       → 写入官方 state.showAnnotations
 *   Frame Scene              → runtime.frameScene()
 *   Fullscreen               → runtime.requestFullscreen()
 *   Saved Views（FIX-02 §10）→ 列出已保存视角；点击 → state.selectViewpoint(id)
 *                              （官方 selectAnnotation 过渡，不经 app 实体树）
 *
 * 用 antd 与 legacy ViewerToolbar 保持视觉一致。data-testid 供 smoke 断言。
 */
import { Button, Dropdown, Segmented, Space, Tooltip } from 'antd';
import {
  AimOutlined,
  CameraOutlined,
  CompressOutlined,
  EyeOutlined,
  FullscreenOutlined,
  RestOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { RuntimeCameraMode } from '../../scene-runtime/SuperSplatRuntime';
import type { OfficialDesktopViewerState } from './useSuperSplatDesktop';

interface OfficialViewerToolbarProps {
  state: OfficialDesktopViewerState;
}

export function OfficialViewerToolbar({ state }: OfficialViewerToolbarProps) {
  const { loaded, cameraMode, performanceMode, showAnnotations } = state;

  const setMode = (mode: string | number) => {
    state.setCameraMode(mode as RuntimeCameraMode);
  };

  // SSV-07 §3：Walk 只走官方 toggleWalk / walkAllowed / cameraMode。
  // §4：尺度异常（needsCalibration）时禁走 —— 不默默用错误尺度走路。
  const walkEnabled =
    loaded && state.walkAllowed && !state.sceneScale.needsCalibration;
  const walking = cameraMode === 'walk';

  // FIX-02 §10：Saved Views —— enabled 视角（按 orderIndex 排序）可点击导航。
  const savedViews = state.viewpoints.filter((vp) => vp.enabled !== false);
  const savedViewsItems = savedViews.map((vp) => ({
    key: vp.id,
    label: vp.name || '未命名视角',
    onClick: () => {
      state.selectViewpoint(vp.id);
    },
  }));

  return (
    <footer className="gs-viewer__bottom-toolbar" aria-label="Official Viewer 工具条">
      <Space size={6} wrap>
        <Tooltip
          title={
            walking
              ? '退出 Walk（恢复 walk 前模式）'
              : !state.walkAllowed
                ? '需要碰撞数据（场景未提供碰撞或场景过小）'
                : state.sceneScale.needsCalibration
                  ? '场景尺度需要校准（Scene scale needs calibration）'
                  : '进入 Walk 模式（官方碰撞 + 重力 + WASD）'
          }
        >
          <Button
            type={walking ? 'primary' : 'default'}
            disabled={!walkEnabled}
            onClick={state.toggleWalk}
            data-testid="ov-walk"
          >
            {walking ? 'Walk ✓' : 'Walk'}
          </Button>
        </Tooltip>

        <Tooltip title="重新取景整个场景">
          <Button
            icon={<AimOutlined aria-hidden />}
            disabled={!loaded}
            onClick={state.frameScene}
            data-testid="ov-frame"
          >
            Frame
          </Button>
        </Tooltip>

        <Tooltip title="恢复初始相机视角">
          <Button
            icon={<RestOutlined aria-hidden />}
            disabled={!loaded}
            onClick={state.resetCamera}
            data-testid="ov-reset"
          >
            Reset
          </Button>
        </Tooltip>

        {/* FIX-02 §10：Saved Views（视角真正被消费 —— 经 wrapper selectViewpoint） */}
        <Dropdown
          menu={{ items: savedViewsItems }}
          disabled={!loaded || savedViews.length === 0}
          trigger={['click']}
        >
          <Button
            icon={<CameraOutlined aria-hidden />}
            disabled={!loaded || savedViews.length === 0}
            data-testid="ov-saved-views"
          >
            视角 ({savedViews.length})
          </Button>
        </Dropdown>

        <span data-testid="ov-camera-mode">
          <Segmented
            options={[
              { label: 'Orbit', value: 'orbit' },
              { label: 'Fly', value: 'fly' },
            ]}
            value={cameraMode === 'fly' ? 'fly' : 'orbit'}
            onChange={setMode}
            disabled={!loaded}
          />
        </span>

        <Tooltip title="性能模式（半分辨率渲染）">
          <Button
            icon={<ThunderboltOutlined aria-hidden />}
            type={performanceMode ? 'primary' : 'default'}
            disabled={!loaded}
            onClick={state.togglePerformanceMode}
            data-testid="ov-performance"
          >
            Performance
          </Button>
        </Tooltip>

        <Tooltip title="显示/隐藏标注热点">
          <Button
            icon={showAnnotations ? <EyeOutlined aria-hidden /> : <EyeOutlined style={{ opacity: 0.4 }} aria-hidden />}
            disabled={!loaded}
            onClick={state.toggleAnnotationsVisibility}
            data-testid="ov-annotations"
          >
            Annotations
          </Button>
        </Tooltip>

        <Tooltip title="进入全屏">
          <Button
            icon={<FullscreenOutlined aria-hidden />}
            disabled={!loaded}
            onClick={state.requestFullscreen}
            data-testid="ov-fullscreen"
          >
            Fullscreen
          </Button>
        </Tooltip>

        {state.isFullscreen && (
          <Tooltip title="退出全屏">
            <Button
              icon={<CompressOutlined aria-hidden />}
              onClick={state.exitFullscreen}
              data-testid="ov-exit-fullscreen"
            />
          </Tooltip>
        )}
      </Space>
    </footer>
  );
}