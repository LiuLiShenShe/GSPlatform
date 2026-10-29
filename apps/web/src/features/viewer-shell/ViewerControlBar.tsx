/**
 * GS-UI-01 — 场景浏览器底部中央浮动控制栏。
 *
 * 四组固定顺序（左 → 右）：回到起点 / 查看方式 / 调节速度 / 画质模式，
 * 之后是官方能力入口（设置、帮助）与溢出菜单（适应场景、标注显隐、播放、
 * 全屏、VR）。
 *
 * 所有操作都转发到**现有真实实现**：
 *   - 回到起点 → 官方 `resetCamera()`（= 当前 SceneVersion 已保存初始相机，
 *     GS-DESKTOP-04 的 position/target/FOV 同步语义不变）；
 *   - 查看方式 → 官方 `state.cameraMode`（orbit / fly / walk），walk 必须通过
 *     平台 Walk 安全闸门；
 *   - 调节速度 → 官方引擎 timeScale（移动控制器消费的同一 deltaTime）；
 *   - 画质模式 → 官方 `state.performanceMode`（高清 = 关，流畅 = 开）。
 * 不新建任何相机控制器、速度变量或分辨率算法。
 */
import { Button, Dropdown, Popover, Segmented, Slider, Tooltip } from 'antd';
import {
  DashboardOutlined,
  EnvironmentOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  LeftOutlined,
  MoreOutlined,
  QuestionCircleOutlined,
  RightOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import type { RuntimeCameraMode } from '../../scene-runtime/SuperSplatRuntime';

/** 官方 Fly 相机的基准前进速度（viewer.js InputController.moveSpeed = 4）。 */
const FLY_BASE_MS = 4;
/** 官方 Walk 相机的基准地面速度（viewer.js WalkController.moveGroundSpeed = 7）。 */
const WALK_BASE_MS = 7;

type NavigationMode = 'orbit' | 'fly' | 'walk';

export interface ViewerControlBarProps {
  cameraMode: RuntimeCameraMode;
  performanceMode: boolean;
  moveSpeedMultiplier: number;
  showAnnotations: boolean;
  isFullscreen: boolean;
  /** 平台 Walk 闸门：碰撞已构建 + 未 STALE + 尺度可信。 */
  walkAllowed: boolean;
  hasAnimation: boolean;
  canStartVR: boolean;
  onReset: () => void;
  onCameraMode: (mode: NavigationMode) => void;
  onMoveSpeed: (multiplier: number) => void;
  onPerformanceMode: (enabled: boolean) => void;
  onFrame: () => void;
  onToggleAnnotations: () => void;
  onOpenSettings: () => void;
  onToggleHelp: () => void;
  onToggleAnimation: () => void;
  onToggleFullscreen: () => void;
  onEnterVR: () => void;
  /**
   * GS-UI-01 修复：标记点快速切换（对应官方 annotationNav 的 Prev/Next +
   * 标题）。为空时不渲染该组。选中项驱动官方 `selectAnnotation`（相机过渡）。
   */
  annotations?: Array<{ id: string; title: string }>;
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (annotationId: string) => void;
  /** viewer 尚未就绪时禁用全部操作（不假装可用）。 */
  disabled?: boolean;
}

function speedLabel(mode: RuntimeCameraMode, multiplier: number): string {
  const base = mode === 'walk' ? WALK_BASE_MS : FLY_BASE_MS;
  const value = base * multiplier;
  return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(1);
}

export function ViewerControlBar(props: ViewerControlBarProps) {
  const {
    cameraMode,
    performanceMode,
    moveSpeedMultiplier,
    showAnnotations,
    isFullscreen,
    walkAllowed,
    hasAnimation,
    canStartVR,
    annotations = [],
    selectedAnnotationId = null,
    onSelectAnnotation,
    disabled = false,
  } = props;

  const activeMode: NavigationMode | undefined =
    cameraMode === 'orbit' || cameraMode === 'fly' || cameraMode === 'walk'
      ? cameraMode
      : undefined;

  const speedText =
    cameraMode === 'orbit'
      ? `${moveSpeedMultiplier.toFixed(2).replace(/0$/, '')}×`
      : `${moveSpeedMultiplier.toFixed(2).replace(/0$/, '')}× · ${speedLabel(
          cameraMode,
          moveSpeedMultiplier,
        )} m/s`;

  // 标记点快速切换：与官方 annotationNav 的 Prev/Next 同一语义（按数组环切）。
  const annotationIndex =
    selectedAnnotationId === null
      ? -1
      : annotations.findIndex((a) => a.id === selectedAnnotationId);
  const annotationLabel =
    annotationIndex >= 0
      ? `${annotationIndex + 1}/${annotations.length} · ${annotations[annotationIndex].title || '(未命名)'}`
      : `标记点 (${annotations.length})`;
  const stepAnnotation = (step: 1 | -1): void => {
    if (annotations.length === 0) return;
    const next =
      annotationIndex < 0
        ? step === 1
          ? 0
          : annotations.length - 1
        : (annotationIndex + step + annotations.length) % annotations.length;
    onSelectAnnotation?.(annotations[next].id);
  };

  const moreItems = [
    { key: 'frame', label: '适应场景' },
    {
      key: 'annotations',
      label: showAnnotations ? '隐藏标注' : '显示标注',
    },
    ...(hasAnimation ? [{ key: 'play', label: '播放 / 暂停动画' }] : []),
    { type: 'divider' as const },
    {
      key: 'fullscreen',
      label: isFullscreen ? '退出全屏' : '全屏',
      icon: isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />,
    },
    ...(canStartVR ? [{ key: 'vr', label: '进入 VR' }] : []),
  ];

  const onMoreClick = ({ key }: { key: string }): void => {
    switch (key) {
      case 'frame':
        props.onFrame();
        break;
      case 'annotations':
        props.onToggleAnnotations();
        break;
      case 'play':
        props.onToggleAnimation();
        break;
      case 'fullscreen':
        props.onToggleFullscreen();
        break;
      case 'vr':
        props.onEnterVR();
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="gs-viewer-toolbar"
      role="toolbar"
      aria-label="场景查看控制"
      data-testid="ov2-toolbar"
    >
      {/* ① 回到起点 */}
      <Tooltip title="恢复当前版本已保存的初始视角（位置 / 目标 / FOV）">
        <Button
          className="gs-viewer-toolbar__button"
          type="text"
          icon={<UndoOutlined aria-hidden />}
          onClick={props.onReset}
          disabled={disabled}
          data-testid="ov2-reset"
        >
          <span className="gs-viewer-toolbar__label">回到起点</span>
        </Button>
      </Tooltip>

      <span className="gs-viewer-toolbar__divider" aria-hidden />

      {/* ② 查看方式（官方 orbit / fly / walk，不另立一套状态） */}
      <div className="gs-viewer-toolbar__group" aria-label="查看方式">
        <Segmented<NavigationMode>
          className="gs-viewer-toolbar__segmented"
          size="small"
          value={activeMode}
          onChange={(mode) => {
            if (mode === 'walk' && !walkAllowed) return;
            props.onCameraMode(mode);
          }}
          options={[
            { label: '环绕', value: 'orbit' },
            {
              label: (
                <span title="自由飞行（官方 Fly 相机，即小鸟飞行）">自由飞行</span>
              ),
              value: 'fly',
            },
            {
              label: walkAllowed ? '地面行走' : '地面行走（不可用）',
              value: 'walk',
              disabled: !walkAllowed,
            },
          ]}
          data-testid="ov2-mode"
        />
      </div>

      <span className="gs-viewer-toolbar__divider" aria-hidden />

      {/* ③ 调节速度（官方 timeScale 通道，即时影响移动） */}
      <Popover
        trigger="click"
        placement="top"
        getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
        title="调节速度"
        content={
          <div className="gs-viewer-toolbar__speed-panel">
            <div className="gs-viewer-toolbar__speed-value">
              {cameraMode === 'orbit'
                ? `旋转速度 ${moveSpeedMultiplier.toFixed(2)}×`
                : `移动速度 ${moveSpeedMultiplier.toFixed(2)}× · ${speedLabel(
                    cameraMode,
                    moveSpeedMultiplier,
                  )} m/s`}
            </div>
            <Slider
              min={0.5}
              max={3}
              step={0.25}
              value={moveSpeedMultiplier}
              onChange={(value) => props.onMoveSpeed(value)}
              tooltip={{ formatter: (value) => `${Number(value).toFixed(2)}×` }}
              aria-label="移动速度倍率"
              data-testid="ov2-speed-slider"
            />
            <div className="gs-viewer-toolbar__speed-hint">
              官方默认：自由飞行约 {FLY_BASE_MS} m/s，地面行走约 {WALK_BASE_MS} m/s。
            </div>
            <Button size="small" onClick={() => props.onMoveSpeed(1)}>
              恢复 1.00×
            </Button>
          </div>
        }
      >
        <Button
          className="gs-viewer-toolbar__button"
          type="text"
          icon={<DashboardOutlined aria-hidden />}
          disabled={disabled}
          data-testid="ov2-speed"
        >
          <span className="gs-viewer-toolbar__label">{speedText}</span>
        </Button>
      </Popover>

      <span className="gs-viewer-toolbar__divider" aria-hidden />

      {/* ④ 画质模式（官方 performanceMode：高清 = 关，流畅 = 开） */}
      <div className="gs-viewer-toolbar__group" aria-label="画质模式">
        <Segmented
          size="small"
          value={performanceMode ? 'smooth' : 'hd'}
          onChange={(value) => props.onPerformanceMode(value === 'smooth')}
          options={[
            { label: '高清', value: 'hd' },
            { label: '流畅', value: 'smooth' },
          ]}
          data-testid="ov2-quality"
        />
      </div>

      <span className="gs-viewer-toolbar__divider" aria-hidden />

      {/* GS-UI-01 修复：标记点快速切换 —— 对应官方 annotationNav 的 Prev/Next + 标题。
          官方 1.35 在 annotations.length < 2 时会把 annotationNav 隐藏，单标记点
          场景因此看不到切换入口；宿主这一组保证有标记点时即可切换（环切）。 */}
      {annotations.length > 0 && (
        <div className="gs-viewer-toolbar__group" aria-label="标记点快速切换">
          <Tooltip title="上一个标记点">
            <Button
              className="gs-viewer-toolbar__icon"
              type="text"
              icon={<LeftOutlined aria-hidden />}
              onClick={() => stepAnnotation(-1)}
              disabled={disabled}
              aria-label="上一个标记点"
              data-testid="ov2-annotation-prev"
            />
          </Tooltip>
          <Dropdown
            menu={{
              items: annotations.map((a) => ({ key: a.id, label: a.title || '(未命名)' })),
              onClick: ({ key }) => onSelectAnnotation?.(key),
              selectedKeys: selectedAnnotationId ? [selectedAnnotationId] : [],
            }}
            placement="top"
            getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
            trigger={['click']}
          >
            <Button
              className="gs-viewer-toolbar__button"
              type="text"
              icon={<EnvironmentOutlined aria-hidden />}
              disabled={disabled}
              aria-label="标记点列表"
              data-testid="ov2-annotation-current"
            >
              <span className="gs-viewer-toolbar__label">{annotationLabel}</span>
            </Button>
          </Dropdown>
          <Tooltip title="下一个标记点">
            <Button
              className="gs-viewer-toolbar__icon"
              type="text"
              icon={<RightOutlined aria-hidden />}
              onClick={() => stepAnnotation(1)}
              disabled={disabled}
              aria-label="下一个标记点"
              data-testid="ov2-annotation-next"
            />
          </Tooltip>
        </div>
      )}

      <span className="gs-viewer-toolbar__divider" aria-hidden />

      {/* 其余官方能力：设置 / 帮助 / 溢出 */}
      <Tooltip title="官方设置（性能、标注、游戏控制）">
        <Button
          className="gs-viewer-toolbar__icon"
          type="text"
          icon={<SettingOutlined aria-hidden />}
          aria-label="打开官方设置"
          onClick={props.onOpenSettings}
          disabled={disabled}
          data-testid="ov2-settings"
        />
      </Tooltip>
      <Tooltip title="快捷键与操作说明">
        <Button
          className="gs-viewer-toolbar__icon"
          type="text"
          icon={<QuestionCircleOutlined aria-hidden />}
          aria-label="打开快捷键帮助"
          onClick={props.onToggleHelp}
          disabled={disabled}
          data-testid="ov2-help"
        />
      </Tooltip>
      <Dropdown
        menu={{ items: moreItems, onClick: onMoreClick }}
        placement="topRight"
        getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
        trigger={['click']}
      >
        <Button
          className="gs-viewer-toolbar__icon"
          type="text"
          icon={<MoreOutlined aria-hidden />}
          aria-label="更多场景操作"
          disabled={disabled}
          data-testid="ov2-more"
        />
      </Dropdown>
      <span className="gs-viewer-toolbar__badge" aria-hidden>
        <ThunderboltOutlined />
      </span>
    </div>
  );
}
