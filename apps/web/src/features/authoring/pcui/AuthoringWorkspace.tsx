/**
 * PcuiAuthoringWorkspace —— 官方 PlayCanvas PCUI 创作工作区（GS-DESKTOP-02 §3）。
 *
 * 布局参考官方 SuperSplat Studio：
 *   顶部：返回 / 作品名称 / 保存 / 预览 / 官方 Gaussian Editor / 版本 / 碰撞
 *   左侧：场景 / 标注 / 视角 分组
 *   中间：官方 SuperSplat Viewer 实时场景（唯一的 3D 视图）
 *   右侧：当前选中项的属性（PCUI 控件）
 *
 * 不复制 Studio 源码（Studio 不是可直接自托管的产品）；这里用官方 npm 包
 * `@playcanvas/pcui`（MIT）构建工作区，数据全部来自 GSPlatform 既有 API。
 * 相机/标注/观察点的业务规则仍在页面层（SceneAuthoringPage）与 scene-runtime。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Tabs } from 'antd';
import {
  BooleanInput,
  ColorPicker,
  Divider,
  Label,
  SelectInput,
  SliderInput,
  TextInput,
} from '@playcanvas/pcui/react';
import { PcuiField } from './PcuiField';
import { PcuiButton } from './PcuiButton';
import { PcuiNumericInput } from './PcuiNumericInput';
import {
  findForwardCanvas,
  forwardPickPointer,
  forwardPickWheel,
  isPickDrag,
  samplePickPointer,
  type PickPointerSample,
} from '../pickPointerForwarding';
import { AnnotationProperties } from './AnnotationProperties';
import { ViewpointProperties } from './ViewpointProperties';
import type { SceneAnnotation } from '../../../services/annotationApi';
import type { ScenePresentation, SceneViewpoint, Vec3 } from '../../../services/presentationApi';
import type { AuthoringCameraPose } from '../authoringTypes';
import type { RuntimePostEffects, RuntimeTonemapping } from '../../../scene-runtime/types';
import type { RuntimeInitialCameraUse } from '../../../scene-runtime/initialCameraPolicy';
import { CAMERA_FOV_RANGE, POST_EFFECT_RANGES } from '@playcanvas/supersplat-viewer/settings';
import type { CameraSyncStatus } from '../../../scene-runtime/initialCameraSync';

/** FOV clamp 进官方 authoring 界（与 experienceAdapter 用的是同一份范围数据）。 */
function clampFov(fov: number): number {
  if (!Number.isFinite(fov)) return CAMERA_FOV_RANGE.max;
  return Math.min(Math.max(Math.round(fov), CAMERA_FOV_RANGE.min), CAMERA_FOV_RANGE.max);
}

export type SceneSection = 'camera' | 'world' | 'background' | 'postfx' | 'cover' | 'audio';
export type WorkspaceSelection =
  | { kind: 'scene'; section: SceneSection }
  | { kind: 'annotation'; id: string }
  | { kind: 'viewpoint'; id: string };

export type ManagementKind = 'editor' | 'calibration' | 'versions' | 'collision';

/** GS-UI-01 Req3/4：右侧属性面板的可折叠分区（场景设置 / 标注管理 / 视角管理）。 */
export type RightPanelTab = 'scene' | 'annotation' | 'viewpoint';

const TONEMAPPING_OPTIONS = [
  { t: 'None', v: 'none' },
  { t: 'Linear', v: 'linear' },
  { t: 'Filmic', v: 'filmic' },
  { t: 'Hejl', v: 'hejl' },
  { t: 'ACES', v: 'aces' },
  { t: 'ACES2', v: 'aces2' },
  { t: 'Neutral', v: 'neutral' },
];

const DEFAULT_FX = (): RuntimePostEffects => ({
  sharpness: { enabled: false, amount: 0 },
  bloom: { enabled: false, intensity: 0.05, blurLevel: 2 },
  grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] },
  vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
  fringing: { enabled: false, intensity: 0.5 },
});

export interface AuthoringWorkspaceProps {
  sceneId: string;
  viewerReady: boolean;
  loading: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 标注放置模式：点击 viewer 画布时回调（页面登记 pendingPick，不直接落库）。 */
  onViewerClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** GS-UI-01 修复（需求 2）：点击后的坐标轴标记预览（RUNTIME 空间锚点 + 屏幕坐标）。 */
  pendingPick: { runtime: { x: number; y: number; z: number }; screen: { x: number; y: number } } | null;
  /** 确认放置：把预览锚点落库为标记点。 */
  onConfirmPick: () => void;
  /** 取消放置：保留拾取模式，可改点别处。 */
  onCancelPick: () => void;
  /** RUNTIME 点 → 容器 CSS 像素投影（轴标记 gizmo 用；页面注入，不在此复制相机数学）。 */
  projectPoint: (
    point: [number, number, number],
  ) => { x: number; y: number; inFront: boolean } | null;
  /**
   * GS-UI-01 修复（需求 4）：标注（SCENE 锚点）→ 容器 CSS 像素投影。
   * 创作页宿主标记点层每帧用它摆放标记；新增标注无需重建 Viewer 即可显示。
   */
  projectAnnotationPoint: (
    annotation: SceneAnnotation,
  ) => { x: number; y: number; inFront: boolean } | null;
  /**
   * GS-UI-01 修复（需求 3）：属性面板文本输入框聚焦/失焦 —— 页面据此关闭
   * 官方 Viewer 键盘输入，避免打字触发 W/A/S/D、1/2/3 等快捷键。
   */
  onEditorInputActiveChange: (active: boolean) => void;
  selection: WorkspaceSelection;
  onSelect: (selection: WorkspaceSelection) => void;

  // annotations
  annotations: SceneAnnotation[];
  annotationsSaving: boolean;
  picking: boolean;
  onStartPicking: () => void;
  onCancelPicking: () => void;
  onSaveAnnotation: (id: string, patch: Partial<SceneAnnotation>) => Promise<void>;
  onDeleteAnnotation: (id: string) => Promise<void>;
  onMoveAnnotation: (id: string, direction: -1 | 1) => Promise<void>;
  onNavigateAnnotation: (id: string) => void;
  onCaptureAnnotationCamera: (id: string) => Promise<void>;

  // presentation
  presentation: ScenePresentation | null;
  authoringSaving: boolean;
  initialViewUse: RuntimeInitialCameraUse;
  onResetToSaved: () => void;
  onSaveCurrentAsInitial: () => Promise<void>;
  onSetFov: (fov: number) => void;
  /** GS-DESKTOP-04 §三：新初始视角同步进当前 Viewer 的状态。 */
  cameraSync: CameraSyncStatus;
  cameraSyncError: string | null;
  /** 同步失败后的重试入口（不清数据，只重读描述符再同步）。 */
  onRetryCameraSync: () => void;
  cameraEdit: boolean;
  onEnterCameraEdit: () => void;
  onApplyCameraEdit: () => Promise<void>;
  onCancelCameraEdit: () => void;

  onSetWorldRotation: (v: Vec3) => Promise<void>;
  onSetWorldScale: (v: Vec3) => Promise<void>;
  onSetBackgroundType: (type: 'color' | 'equirectangular') => Promise<void>;
  onSetBackgroundColor: (color: Vec3) => Promise<void>;
  onUploadBackground: (file: File) => Promise<void>;
  onSetTonemapping: (value: RuntimeTonemapping) => Promise<void>;
  onSetHighPrecisionRendering: (value: boolean) => Promise<void>;
  onSetPostEffects: (fx: RuntimePostEffects) => Promise<void>;
  onUploadCover: (file: File) => Promise<void>;
  onCaptureCover: () => Promise<void>;

  // background audio
  onUploadAudio: (file: File) => Promise<void>;
  onUpdateAudio: (patch: {
    volume?: number;
    loop?: boolean;
    enabled?: boolean;
  }) => Promise<void>;

  // viewpoints
  viewpoints: SceneViewpoint[];
  activeViewpointId: string | null;
  onAddViewpointFromCurrent: (name: string) => Promise<void>;
  onRenameViewpoint: (id: string, name: string) => Promise<void>;
  onToggleViewpoint: (id: string, enabled: boolean) => Promise<void>;
  onDeleteViewpoint: (id: string) => Promise<void>;
  onMoveViewpoint: (id: string, direction: -1 | 1) => Promise<void>;
  onUpdateViewpointPose: (id: string, pose: AuthoringCameraPose) => Promise<void>;
  onNavigateViewpoint: (vp: SceneViewpoint) => void;
  onSetActiveViewpoint: (id: string | null) => void;
  /** 读取当前 Viewer 相机（SCENE 空间），供「用当前视角更新」。 */
  getCurrentPose: () => Promise<AuthoringCameraPose | null>;

  // platform chrome
  onBack: () => void;
  onPreview: () => void;
  onOpenManagement: (kind: ManagementKind) => void;
}

export function PcuiAuthoringWorkspace(props: AuthoringWorkspaceProps) {
  const {
    sceneId,
    selection,
    onSelect,
    annotations,
    viewpoints,
    pendingPick,
    onConfirmPick,
    onCancelPick,
    projectPoint,
    projectAnnotationPoint,
    onEditorInputActiveChange,
  } = props;
  const selectedAnnotation = useMemo(
    () => (selection.kind === 'annotation'
      ? annotations.find((a) => a.id === selection.id) ?? null
      : null),
    [selection, annotations],
  );
  const selectedViewpoint = useMemo(
    () => (selection.kind === 'viewpoint'
      ? viewpoints.find((v) => v.id === selection.id) ?? null
      : null),
    [selection, viewpoints],
  );

  // GS-UI-01 Req3：右侧面板标签页。选择变化（kind 改变）时自动跟随；
  // 用户手动切换标签页只影响面板展示，不伪造 selection。
  const [tab, setTab] = useState<RightPanelTab>(selection.kind);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setTab(selection.kind);
  }, [selection.kind]);

  // GS-UI-01 修复（需求 3）：属性面板里任何文本框聚焦 → 关闭官方 Viewer 键盘
  // 输入（页面写 state.inputEnabled）。focusout 落到另一个输入框时不恢复，
  // 避免在标题/正文之间切换时短暂放开快捷键。
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = workspaceRef.current;
    if (!root) return;
    const isTextField = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable === true;
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isTextField(event.target)) onEditorInputActiveChange(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!isTextField(event.target)) return;
      // 焦点移动到另一个文本输入框 → 继续保持关闭。
      if (isTextField(event.relatedTarget)) return;
      onEditorInputActiveChange(false);
    };
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [onEditorInputActiveChange]);

  const sceneSections: Array<[SceneSection, string]> = [
    ['camera', '初始相机'],
    ['world', '世界方向'],
    ['background', '背景'],
    ['postfx', '后期效果'],
    ['cover', '封面'],
    ['audio', '背景音乐'],
  ];

  // ------------------------------------------------------------------ //
  // GS-UI-01 后续修正：拾取模式的手势判别（拖动=转视角 / 单击=落点）。
  //
  // overlay 仍盖住画布（保证「单击」不会落到官方 canvas 上触发官方
  // click-focus —— 官方会把相机目标移到点击点，作者摆好的视角就没了），
  // 但「拖动」会把指针位移**合成转发**给官方画布，让作者在拾取时也能
  // 转视角、缩放，去检查落点是否在想要的表面上。
  // ------------------------------------------------------------------ //
  const pickGesture = useRef<{
    start: PickPointerSample | null;
    dragging: boolean;
    forwarded: boolean;
  }>({ start: null, dragging: false, forwarded: false });

  const handlePickPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 真实指针捕获：拖出 viewer 也能收到 pointerup（避免官方相机停在拖拽态）。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件 / 不支持指针捕获的环境：忽略（转发收尾靠 pointercancel）。
    }
    pickGesture.current = { start: samplePickPointer(event), dragging: false, forwarded: false };
  };

  const handlePickPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = pickGesture.current;
    if (!gesture.start) return;
    const sample = samplePickPointer(event);
    if (!gesture.dragging) {
      if (!isPickDrag(gesture.start, sample)) return;
      gesture.dragging = true;
      const canvas = findForwardCanvas(props.containerRef.current);
      if (!canvas) return;
      // 从**起点**补发 pointerdown，后续位移才是相对起点的真实拖动。
      forwardPickPointer(canvas, 'pointerdown', gesture.start);
      gesture.forwarded = true;
    }
    const canvas = findForwardCanvas(props.containerRef.current);
    if (canvas && gesture.forwarded) forwardPickPointer(canvas, 'pointermove', sample);
  };

  const endPickGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = pickGesture.current;
    if (!gesture.start) return;
    const canvas = findForwardCanvas(props.containerRef.current);
    if (canvas && gesture.forwarded) {
      // button:-1 → 官方输入源收尾，但不触发 click-focus。
      forwardPickPointer(canvas, 'pointerup', samplePickPointer(event));
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 忽略。
    }
    gesture.start = null;
    gesture.dragging = false;
    // 保留 forwarded 给紧随其后的 click 消费：拖动结束的 click 不落点。
  };

  const handlePickClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const gesture = pickGesture.current;
    // 一次拖动结束后的 click 属于「转视角」，不落点。
    if (gesture.forwarded) {
      gesture.forwarded = false;
      return;
    }
    props.onViewerClick(event);
  };

  const handlePickWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const canvas = findForwardCanvas(props.containerRef.current);
    if (canvas) forwardPickWheel(canvas, event);
  };

  return (
    <div className="gs-workspace" data-testid="scene-authoring-page" ref={workspaceRef}>
      <header className="gs-workspace__topbar">
        <PcuiButton text="← 返回" onClick={props.onBack} />
        <Label class="gs-workspace__name" text={sceneId} />
        <Label
          class="gs-workspace__status"
          text={props.viewerReady ? 'Viewer 就绪' : '加载中…'}
        />
        <span className="gs-workspace__spacer" />
        <PcuiButton
          text={props.authoringSaving ? '保存中…' : '保存初始视角'}
          enabled={props.viewerReady && !props.authoringSaving}
          onClick={() => void props.onSaveCurrentAsInitial()}
        />
        <PcuiButton text="预览" onClick={props.onPreview} />
        <PcuiButton text="Gaussian 编辑" onClick={() => props.onOpenManagement('editor')} />
        <PcuiButton text="尺度标定" onClick={() => props.onOpenManagement('calibration')} />
        <PcuiButton text="版本历史" onClick={() => props.onOpenManagement('versions')} />
        <PcuiButton text="碰撞" onClick={() => props.onOpenManagement('collision')} />
        <PcuiButton
          text={collapsed ? '展开属性面板' : '收起属性面板'}
          onClick={() => setCollapsed((value) => !value)}
        />
      </header>

      <div className="gs-workspace__body">
        {/* 中：官方 viewer + 相机编辑 / 标注拾取状态 */}
        <div
          className={`gs-workspace__viewer${props.picking ? ' gs-workspace__viewer--picking' : ''}${
            props.cameraEdit ? ' gs-workspace__viewer--camera-edit' : ''
          }`}
          data-testid="authoring-viewer"
        >
          {props.loading && <div className="gs-workspace__loading">加载场景…</div>}
          <div ref={props.containerRef} className="gs-workspace__mount" data-testid="authoring-mount" />
          {/* GS-UI-01 修复（需求 2）：拾取模式下的透明指针捕获层 —— 单击只解析
              锚点（不会落到官方 canvas 触发 click-focus），拖动/滚轮则**合成转发**
              给官方画布，拾取时仍能转视角、缩放（见 pickPointerForwarding）。 */}
          {props.picking && (
            <div
              className="gs-pick-overlay"
              data-testid="annotation-pick-overlay"
              onClick={handlePickClick}
              onPointerDown={handlePickPointerDown}
              onPointerMove={handlePickPointerMove}
              onPointerUp={endPickGesture}
              onPointerCancel={endPickGesture}
              onWheel={handlePickWheel}
            />
          )}
          {/* GS-UI-01 修复（需求 4）：宿主标记点层 —— 直接投影所有标注锚点，
              新增/删除即时可见，无需重建 Viewer（官方 hotspot 层已在创作页隐藏）。 */}
          {!props.picking && annotations.length > 0 && (
            <AnnotationMarkersOverlay
              annotations={annotations}
              selectedId={selection.kind === 'annotation' ? selection.id : null}
              projectPoint={projectAnnotationPoint}
            />
          )}
          {props.cameraEdit && (
            <>
              <div className="gs-camera-edit-frame" aria-hidden />
              <div className="gs-camera-edit-badge" data-testid="camera-edit-badge">
                <span>相机编辑模式</span>
                <PcuiButton text="Apply" onClick={() => void props.onApplyCameraEdit()} />
                <PcuiButton text="Cancel" onClick={props.onCancelCameraEdit} />
              </div>
            </>
          )}
          {props.picking && (
            <div className="gs-pick-badge" data-testid="annotation-pick-badge">
              点击 Gaussian 表面放置标注（近似锚点）；拖动/滚轮可先调整视角
              <PcuiButton text="取消" onClick={props.onCancelPicking} />
            </div>
          )}
          {pendingPick && (
            <AnnotationPickMarker
              anchor={pendingPick.runtime}
              fallback={pendingPick.screen}
              projectPoint={projectPoint}
              onConfirm={onConfirmPick}
              onCancel={onCancelPick}
            />
          )}
        </div>

        {/* 右：属性面板（分区标签页 + 折叠，Req3 §5.1） */}
        {!collapsed && (
          <aside
            className="gs-workspace__right"
            data-testid="authoring-panel"
            aria-label="场景属性面板"
          >
            <Tabs
              className="gs-workspace__tabs"
              activeKey={tab}
              onChange={(next) => {
                setTab(next as RightPanelTab);
                // 切到「场景设置」时必须有一份场景分区选择，否则面板无内容。
                if (next === 'scene' && selection.kind !== 'scene') {
                  onSelect({ kind: 'scene', section: 'camera' });
                }
              }}
              items={[
                {
                  key: 'scene',
                  label: '场景设置',
                  // 保留各分区 DOM/草稿状态，切换标签不丢未提交输入。
                  forceRender: true,
                  children: (
                    <>
                      <div className="gs-workspace__chips" role="group" aria-label="场景设置分区">
                        {sceneSections.map(([section, label]) => (
                          <button
                            key={section}
                            type="button"
                            className={
                              selection.kind === 'scene' && selection.section === section
                                ? 'gs-workspace__chip gs-workspace__chip--active'
                                : 'gs-workspace__chip'
                            }
                            aria-pressed={selection.kind === 'scene' && selection.section === section}
                            onClick={() => onSelect({ kind: 'scene', section })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {selection.kind === 'scene' && (
                        <SceneProperties {...props} section={selection.section} />
                      )}
                    </>
                  ),
                },
                {
                  key: 'annotation',
                  label: '标注管理',
                  // 保留各分区 DOM/草稿状态，切换标签不丢未提交输入。
                  forceRender: true,
                  children: (
                    <div className="gs-workspace__panel-list">
                      <PcuiButton
                        class="gs-workspace__item"
                        text={props.picking ? '正在拾取…（取消）' : '＋ 添加标注'}
                        onClick={props.picking ? props.onCancelPicking : props.onStartPicking}
                      />
                      {annotations.length === 0 && (
                        <Label class="gs-props__hint" text="还没有标注；点「＋ 添加标注」后在画面中点击放置。" />
                      )}
                      {annotations
                        .slice()
                        .sort((a, b) => a.orderIndex - b.orderIndex)
                        .map((a) => (
                          <div key={a.id} className="gs-workspace__row">
                            <PcuiButton
                              class={
                                selection.kind === 'annotation' && selection.id === a.id
                                  ? 'gs-workspace__item--active'
                                  : 'gs-workspace__item'
                              }
                              text={`${a.title || '(未命名)'}${a.enabled ? '' : ' · 隐藏'}`}
                              onClick={() => onSelect({ kind: 'annotation', id: a.id })}
                            />
                            <PcuiButton
                              text={a.enabled ? '◉' : '○'}
                              onClick={() => void props.onSaveAnnotation(a.id, { enabled: !a.enabled })}
                            />
                          </div>
                        ))}
                    </div>
                  ),
                },
                {
                  key: 'viewpoint',
                  label: '视角管理',
                  // 保留各分区 DOM/草稿状态，切换标签不丢未提交输入。
                  forceRender: true,
                  children: (
                    <div className="gs-workspace__panel-list">
                      <AddViewpointRow
                        disabled={!props.viewerReady}
                        onAdd={props.onAddViewpointFromCurrent}
                      />
                      {viewpoints.length === 0 && (
                        <Label class="gs-props__hint" text="还没有观察点；移动相机后点「保存当前视角」。" />
                      )}
                      {viewpoints
                        .slice()
                        .sort((a, b) => a.orderIndex - b.orderIndex)
                        .map((vp) => (
                          <div key={vp.id} className="gs-workspace__row">
                            <PcuiButton
                              class={
                                selection.kind === 'viewpoint' && selection.id === vp.id
                                  ? 'gs-workspace__item--active'
                                  : 'gs-workspace__item'
                              }
                              text={`${vp.name || '(未命名)'}${vp.enabled ? '' : ' · 隐藏'}`}
                              onClick={() => onSelect({ kind: 'viewpoint', id: vp.id })}
                            />
                            <PcuiButton
                              text={vp.enabled ? '◉' : '○'}
                              onClick={() => void props.onToggleViewpoint(vp.id, !vp.enabled)}
                            />
                          </div>
                        ))}
                    </div>
                  ),
                },
              ]}
            />
            {tab === 'annotation' && selectedAnnotation && (
              <AnnotationProperties
                annotation={selectedAnnotation}
                saving={props.annotationsSaving}
                onSave={props.onSaveAnnotation}
                onDelete={props.onDeleteAnnotation}
                onMove={props.onMoveAnnotation}
                onNavigate={props.onNavigateAnnotation}
                onCaptureCamera={props.onCaptureAnnotationCamera}
              />
            )}
            {tab === 'viewpoint' && selectedViewpoint && (
              <ViewpointProperties
                viewpoint={selectedViewpoint}
                saving={props.authoringSaving}
                onRename={props.onRenameViewpoint}
                onToggleEnabled={props.onToggleViewpoint}
                onDelete={props.onDeleteViewpoint}
                onMove={props.onMoveViewpoint}
                onNavigate={props.onNavigateViewpoint}
                onGetCurrentPose={props.getCurrentPose}
                onUpdatePose={props.onUpdateViewpointPose}
                onSetActive={props.onSetActiveViewpoint}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}


// ------------------------------------------------------------------ //
// 标注放置预览：SuperSplat 风格 XYZ 轴标记（GS-UI-01 修复 / 需求 2）
// ------------------------------------------------------------------ //

/** 轴 gizmo 的轴长（RUNTIME 空间单位）。 */
const PICK_AXIS_LENGTH = 0.25;

/**
 * 点击位置的坐标轴标记预览（世界轴，不是屏幕固定图标）。
 *
 * 从锚点沿**世界 X/Y/Z** 各延伸 PICK_AXIS_LENGTH，把原点与三个轴端点经官方
 * 相机投影到屏幕，画三条 2D 线段（红 X / 绿 Y / 蓝 Z）—— 与 SuperSplat
 * 「点击位置出现 XYZ 轴点」一致：相机移动时标记也跟着 3D 落点走。
 * 确认/取消按钮固定在标记旁。
 *
 * 投影回调由页面注入（`projectPoint`），不在这里复制相机数学。
 */
function AnnotationPickMarker({
  anchor,
  fallback,
  projectPoint,
  onConfirm,
  onCancel,
}: {
  anchor: { x: number; y: number; z: number };
  /** 点击时的屏幕坐标 —— 投影不可用（相机缺失/点在相机后）时的兜底位置。 */
  fallback: { x: number; y: number };
  /** RUNTIME 点 → 容器 CSS 像素；null = 相机不可用。 */
  projectPoint: (
    point: [number, number, number],
  ) => { x: number; y: number; inFront: boolean } | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [view, setView] = useState<{
    origin: { x: number; y: number; inFront: boolean } | null;
    axes: Array<{ x2: number; y2: number; color: string; label: string }>;
  }>({ origin: null, axes: [] });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const origin = projectPoint([anchor.x, anchor.y, anchor.z]);
      let next: { origin: { x: number; y: number; inFront: boolean } | null; axes: typeof view.axes };
      if (origin?.inFront) {
        const tips: Array<{ dx: number; dy: number; dz: number; color: string; label: string }> = [
          { dx: PICK_AXIS_LENGTH, dy: 0, dz: 0, color: '#ff4d4f', label: 'X' },
          { dx: 0, dy: PICK_AXIS_LENGTH, dz: 0, color: '#52c41a', label: 'Y' },
          { dx: 0, dy: 0, dz: PICK_AXIS_LENGTH, color: '#1677ff', label: 'Z' },
        ];
        const axes = tips
          .map((t) => {
            const p = projectPoint([anchor.x + t.dx, anchor.y + t.dy, anchor.z + t.dz]);
            if (!p || !p.inFront) return null;
            return {
              x2: p.x - origin.x,
              y2: p.y - origin.y,
              color: t.color,
              label: t.label,
            };
          })
          .filter((a): a is { x2: number; y2: number; color: string; label: string } => a !== null);
        next = { origin, axes };
      } else {
        next = { origin: origin?.inFront ? origin : null, axes: [] };
      }
      // 相机静止时投影值不变 —— 跳过 setState，避免每帧无谓的 React 重渲染。
      setView((prev) =>
        prev.origin?.x === next.origin?.x &&
        prev.origin?.y === next.origin?.y &&
        prev.origin?.inFront === next.origin?.inFront &&
        prev.axes.length === next.axes.length &&
        prev.axes.every((a, i) => a.x2 === next.axes[i]?.x2 && a.y2 === next.axes[i]?.y2 && a.color === next.axes[i]?.color && a.label === next.axes[i]?.label)
          ? prev
          : next,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchor.x, anchor.y, anchor.z, projectPoint]);

  const origin = view.origin;
  // 投影不可用（相机缺失 / 锚点落到相机身后）时，用点击屏幕坐标兜底，
  // 而不是退化到 (0,0)（否则只剩一个白点贴在 viewer 左上角）。
  const pos = origin ?? fallback;
  return (
    <div
      className="gs-pick-marker"
      data-testid="annotation-pick-marker"
      style={{ left: pos.x, top: pos.y }}
    >
      <svg className="gs-pick-marker__axes" width="1" height="1" aria-hidden>
        {view.axes.map((a) => (
          <g key={a.label}>
            <line x1={0} y1={0} x2={a.x2} y2={a.y2} stroke={a.color} strokeWidth={3} strokeLinecap="round" />
            <circle cx={a.x2} cy={a.y2} r={3} fill={a.color} />
            <text x={a.x2 + 4} y={a.y2 - 4} fill={a.color} fontSize={11}>{a.label}</text>
          </g>
        ))}
        <circle r={5} fill="#fff" stroke="#333" strokeWidth={1.5} />
      </svg>
      <div className="gs-pick-marker__actions">
        <PcuiButton text="设为标记点" onClick={onConfirm} />
        <PcuiButton text="重选" onClick={onCancel} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ //
// 宿主标记点层（GS-UI-01 修复 / 需求 4）
// ------------------------------------------------------------------ //

/**
 * 创作页的持久标记点层：把**所有**标注的 SCENE 锚点经官方相机投影到屏幕，
 * 渲染成**纯视觉**标记（pointer-events:none —— 选择/编辑走右侧标注列表，
 * 绝不拦截相机输入）。新增 / 删除 / 改名都即时反映（数据来自 annotations
 * state），不需要重建 Viewer —— 这正是解决「添加标记后刷新 viewer」与
 * 「标记点创建后看不到」两个问题的方式。
 *
 * 官方 hotspot 层在创作页被隐藏（行内 display:none），因此不会重复显示；
 * /scene 浏览页仍使用官方 hotspot，不受影响。
 *
 * 投影回调由页面注入（含世界变换换算），这里不复制相机数学。
 */
function AnnotationMarkersOverlay({
  annotations,
  selectedId,
  projectPoint,
}: {
  annotations: SceneAnnotation[];
  selectedId: string | null;
  /** 标注 → 容器 CSS 像素；null = 相机不可用。 */
  projectPoint: (
    annotation: SceneAnnotation,
  ) => { x: number; y: number; inFront: boolean } | null;
}) {
  const [marks, setMarks] = useState<Array<{ id: string; title: string; x: number; y: number }>>([]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const ordered = annotations.slice().sort((a, b) => a.orderIndex - b.orderIndex);
    const tick = (now: number) => {
      // ~20fps：标记层不需要每帧更新，降低 setState 频率。
      if (now - last > 50) {
        last = now;
        const next: Array<{ id: string; title: string; x: number; y: number }> = [];
        for (const a of ordered) {
          const p = projectPoint(a);
          if (p && p.inFront) {
            next.push({ id: a.id, title: a.title || '(未命名)', x: p.x, y: p.y });
          }
        }
        // 相机静止时投影不变 —— 跳过 setState，避免 20fps 无谓重渲染。
        setMarks((prev) =>
          prev.length === next.length &&
          prev.every((m, i) => m.id === next[i].id && m.title === next[i].title && m.x === next[i].x && m.y === next[i].y)
            ? prev
            : next,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [annotations, projectPoint]);

  return (
    <div className="gs-annotation-markers" data-testid="authoring-annotation-markers">
      {marks.map((m, i) => (
        <div
          key={m.id}
          className={
            m.id === selectedId
              ? 'gs-annotation-marker gs-annotation-marker--active'
              : 'gs-annotation-marker'
          }
          style={{ left: m.x, top: m.y }}
          data-testid="authoring-annotation-marker"
          data-annotation-id={m.id}
          title={m.title}
          aria-hidden
        >
          <span className="gs-annotation-marker__index">{i + 1}</span>
          <span className="gs-annotation-marker__label">{m.title}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ //
// 视角新增行
// ------------------------------------------------------------------ //
// ------------------------------------------------------------------ //
// 视角新增行
// ------------------------------------------------------------------ //

function AddViewpointRow({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  return (
    <div className="gs-workspace__row gs-workspace__add">
      <TextInput
        value={name}
        placeholder="视角名称"
        onChange={(v: string) => setName(v)}
      />
      <PcuiButton
        text="保存当前视角"
        enabled={!disabled}
        onClick={() => {
          void onAdd(name.trim() || '未命名视角');
          setName('');
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ //
// 场景属性
// ------------------------------------------------------------------ //

interface SceneProps extends AuthoringWorkspaceProps {
  section: SceneSection;
}

function SceneProperties(props: SceneProps) {
  switch (props.section) {
    case 'camera':
      return <CameraProperties {...props} />;
    case 'world':
      return <WorldProperties {...props} />;
    case 'background':
      return <BackgroundProperties {...props} />;
    case 'postfx':
      return <PostEffectsProperties {...props} />;
    case 'cover':
      return <CoverProperties {...props} />;
    case 'audio':
      return <AudioProperties {...props} />;
  }
}

function CameraProperties(props: SceneProps) {
  const initial = props.presentation?.initialCameraPosition;
  const fov = props.presentation?.initialCameraFov ?? 75;
  const syncing = props.cameraSync === 'syncing';
  return (
    <div className="gs-props" data-testid="scene-properties-camera">
      <Label class="gs-props__title" text="初始相机" />
      {initial ? (
        <PcuiField label="已保存位置">
          <Label text={`(${initial.x.toFixed(2)}, ${initial.y.toFixed(2)}, ${initial.z.toFixed(2)})`} />
        </PcuiField>
      ) : (
        <Label class="gs-props__hint" text="尚未设置：打开场景使用官方默认相机" />
      )}
      <PcuiField label="Lens (FOV)">
        <PcuiNumericInput
          value={fov}
          min={CAMERA_FOV_RANGE.min}
          max={CAMERA_FOV_RANGE.max}
          precision={0}
          step={CAMERA_FOV_RANGE.step}
          // 官方 authoring 界 10–120°：越界值在提交前 clamp，避免把非法 FOV
          // 写进 settings（官方 validateSettings(limits:true) 会整场景拒绝）。
          onChange={(v: number) => props.onSetFov(clampFov(v))}
        />
      </PcuiField>
      <div className="gs-props__row">
        <PcuiButton text="定位到已保存视角" enabled={!syncing} onClick={props.onResetToSaved} />
        <PcuiButton
          text={props.cameraEdit ? '编辑中…' : '编辑相机'}
          enabled={!props.cameraEdit && !syncing}
          onClick={props.onEnterCameraEdit}
        />
      </div>
      <PcuiButton
        class="gs-props__primary"
        text={syncing ? '正在同步初始视角…' : '将当前视角设为初始视角'}
        enabled={props.viewerReady && !props.authoringSaving && !syncing}
        onClick={() => void props.onSaveCurrentAsInitial()}
      />
      <Label
        class="gs-props__hint"
        text="编辑模式下可直接在 Viewer 中 Orbit / Pan / Zoom 取景，再点 Apply。"
      />
      {syncing && (
        <div className="gs-props__alert gs-props__alert--info" data-testid="camera-sync-progress">
          正在把新初始视角同步到 Viewer（官方 Reset 也会一起更新）……
        </div>
      )}
      {props.cameraSync === 'failed' && (
        <div className="gs-props__alert" data-testid="camera-sync-failed">
          新初始视角已保存，但同步到当前 Viewer 失败
          {props.cameraSyncError ? `（${props.cameraSyncError}）` : ''}。
          <div className="gs-props__row" style={{ marginTop: 6 }}>
            <PcuiButton text="重新同步" onClick={props.onRetryCameraSync} />
          </div>
        </div>
      )}
      {props.initialViewUse.status === 'ignored' && (
        <div className="gs-props__alert" data-testid="initial-view-runtime-mismatch">
          已保存的初始视角未被运行时采用（场景几何变更后空间绑定失效）。请重新保存。
        </div>
      )}
      {props.initialViewUse.status === 'absent' && (
        <div className="gs-props__alert gs-props__alert--info" data-testid="initial-view-not-authored">
          未设置初始视角；加载时的封面图是 2D 图片，不是相机视角。
        </div>
      )}
    </div>
  );
}

function WorldProperties(props: SceneProps) {
  const rot = props.presentation?.worldRotation ?? { x: 0, y: 0, z: 0 };
  const scale = props.presentation?.worldScale ?? { x: 1, y: 1, z: 1 };
  const [draftRot, setDraftRot] = useState<Vec3>(rot);
  const [draftScale, setDraftScale] = useState<Vec3>(scale);
  return (
    <div className="gs-props" data-testid="scene-properties-world">
      <Label class="gs-props__title" text="世界方向 / 缩放" />
      {(['x', 'y', 'z'] as const).map((axis) => (
        <PcuiField key={`rot-${axis}`} label={`旋转 ${axis.toUpperCase()} (°)`}>
          <PcuiNumericInput
            value={draftRot[axis]}
            min={-180}
            max={180}
            precision={1}
            step={1}
            onChange={(v: number) => setDraftRot({ ...draftRot, [axis]: v })}
          />
        </PcuiField>
      ))}
      {(['x', 'y', 'z'] as const).map((axis) => (
        <PcuiField key={`scale-${axis}`} label={`缩放 ${axis.toUpperCase()}`}>
          <PcuiNumericInput
            value={draftScale[axis]}
            min={0.01}
            max={100}
            precision={3}
            step={0.1}
            onChange={(v: number) => setDraftScale({ ...draftScale, [axis]: v })}
          />
        </PcuiField>
      ))}
      <div className="gs-props__row">
        <PcuiButton
          text="应用"
          onClick={() => {
            void props.onSetWorldRotation(draftRot);
            void props.onSetWorldScale(draftScale);
          }}
        />
        <PcuiButton
          text="重置"
          onClick={() => {
            setDraftRot({ x: 0, y: 0, z: 0 });
            setDraftScale({ x: 1, y: 1, z: 1 });
            void props.onSetWorldRotation({ x: 0, y: 0, z: 0 });
            void props.onSetWorldScale({ x: 1, y: 1, z: 1 });
          }}
        />
      </div>
      <Label
        class="gs-props__hint"
        text="世界变换在构建后改变会使碰撞 STALE（Walk 会被禁用），需重新构建碰撞。"
      />
    </div>
  );
}

function BackgroundProperties(props: SceneProps) {
  const presentation = props.presentation;
  const type = presentation?.backgroundType ?? 'color';
  const color = presentation?.backgroundColor;
  const fileRef = useRef<HTMLInputElement>(null);
  const rgb: number[] = color
    ? [color.x * 255, color.y * 255, color.z * 255, 1]
    : [0, 0, 0, 1];
  return (
    <div className="gs-props" data-testid="scene-properties-background">
      <Label class="gs-props__title" text="背景" />
      <PcuiField label="类型">
        <SelectInput
          value={type}
          options={[
            { t: '纯色', v: 'color' },
            { t: '全景 (equirectangular)', v: 'equirectangular' },
          ]}
          onChange={(v: string) => void props.onSetBackgroundType(v as 'color' | 'equirectangular')}
        />
      </PcuiField>
      {type === 'color' && (
        <PcuiField label="颜色">
          <ColorPicker
            value={rgb}
            onChange={(value: number[]) => {
              void props.onSetBackgroundColor({
                x: value[0] / 255,
                y: value[1] / 255,
                z: value[2] / 255,
              });
            }}
          />
        </PcuiField>
      )}
      {type === 'equirectangular' && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void props.onUploadBackground(file);
              e.target.value = '';
            }}
          />
          <PcuiButton text="上传全景图" onClick={() => fileRef.current?.click()} />
          <Label
            class="gs-props__hint"
            text={presentation?.backgroundAssetId ? '已设置全景背景（重新上传承接替换）' : '未设置全景背景'}
          />
        </>
      )}
    </div>
  );
}

function PostEffectsProperties(props: SceneProps) {
  const saved = props.presentation?.postEffects ?? DEFAULT_FX();
  const [fx, setFx] = useState<RuntimePostEffects>(saved);
  const tonemapping = props.presentation?.tonemapping ?? 'aces';
  const highPrecision = Boolean(props.presentation?.highPrecisionRendering);

  const set = <K extends keyof RuntimePostEffects>(key: K, value: RuntimePostEffects[K]) =>
    setFx({ ...fx, [key]: value });

  const rows: Array<{ key: keyof RuntimePostEffects; label: string; params: Array<[string, { min: number; max: number; step: number }]> }> = [
    { key: 'sharpness', label: 'Sharpness', params: [['amount', POST_EFFECT_RANGES.sharpness.amount]] },
    {
      key: 'bloom',
      label: 'Bloom',
      params: [
        ['intensity', POST_EFFECT_RANGES.bloom.intensity],
        ['blurLevel', POST_EFFECT_RANGES.bloom.blurLevel],
      ],
    },
    {
      key: 'grading',
      label: 'Grading',
      params: [
        ['brightness', POST_EFFECT_RANGES.grading.brightness],
        ['contrast', POST_EFFECT_RANGES.grading.contrast],
        ['saturation', POST_EFFECT_RANGES.grading.saturation],
      ],
    },
    {
      key: 'vignette',
      label: 'Vignette',
      params: [
        ['intensity', POST_EFFECT_RANGES.vignette.intensity],
        ['inner', POST_EFFECT_RANGES.vignette.inner],
        ['outer', POST_EFFECT_RANGES.vignette.outer],
        ['curvature', POST_EFFECT_RANGES.vignette.curvature],
      ],
    },
    { key: 'fringing', label: 'Fringing', params: [['intensity', POST_EFFECT_RANGES.fringing.intensity]] },
  ];

  return (
    <div className="gs-props" data-testid="scene-properties-postfx">
      <Label class="gs-props__title" text="渲染 / 后期效果" />
      <PcuiField label="Tonemapping">
        <SelectInput
          value={tonemapping}
          options={TONEMAPPING_OPTIONS}
          onChange={(v: string) => void props.onSetTonemapping(v as RuntimeTonemapping)}
        />
      </PcuiField>
      <PcuiField label="高精度渲染">
        <BooleanInput
          type="toggle"
          value={highPrecision}
          onChange={(v: boolean) => void props.onSetHighPrecisionRendering(v)}
        />
      </PcuiField>
      {rows.map((row) => {
        const effect = fx[row.key] as unknown as Record<string, number | boolean>;
        return (
          <div key={row.key} className="gs-props__effect">
            <div className="gs-props__effect-head">
              <Label text={row.label} />
              <BooleanInput
                type="toggle"
                value={Boolean(effect.enabled)}
                onChange={(v: boolean) =>
                  set(row.key, { ...(fx[row.key] as object), enabled: v } as never)
                }
              />
            </div>
            {row.params.map(([param, range]) => (
              <SliderInput
                key={param}
                value={Number(effect[param] ?? 0)}
                min={range.min}
                max={range.max}
                sliderMin={range.min}
                sliderMax={range.max}
                step={range.step}
                precision={3}
                enabled={Boolean(effect.enabled)}
                onChange={(v: number) =>
                  set(row.key, { ...(fx[row.key] as object), [param]: v } as never)
                }
              />
            ))}
          </div>
        );
      })}
      <PcuiButton
        class="gs-props__wide"
        text="应用后期效果"
        onClick={() => void props.onSetPostEffects(fx)}
      />
    </div>
  );
}

function CoverProperties(props: SceneProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="gs-props" data-testid="scene-properties-cover">
      <Label class="gs-props__title" text="封面" />
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void props.onUploadCover(file);
          e.target.value = '';
        }}
      />
      <div className="gs-props__row">
        <PcuiButton text="上传图片" onClick={() => fileRef.current?.click()} />
        <PcuiButton text="从画面截取" onClick={() => void props.onCaptureCover()} />
      </div>
      {props.presentation?.coverUrl && (
        <img className="gs-props__cover" src={props.presentation.coverUrl} alt="cover preview" />
      )}
    </div>
  );
}

function AudioProperties(props: SceneProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="audio/*"
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void props.onUploadAudio(file);
        e.target.value = '';
      }}
    />
  );
  return (
    <div className="gs-props" data-testid="scene-properties-audio">
      <Label class="gs-props__title" text="背景音乐" />
      {fileInput}
      <PcuiField label="状态">
        <Label
          text={props.presentation?.backgroundAudioAssetId ? '已设置音频' : '未设置'}
        />
      </PcuiField>
      <PcuiButton text="上传音频" onClick={() => fileRef.current?.click()} />
      <PcuiField label="音量">
        <SliderInput
          min={0}
          max={1}
          step={0.05}
          precision={2}
          value={props.presentation?.backgroundAudioVolume ?? 0.5}
          onChange={(v: number) => void props.onUpdateAudio({ volume: v })}
        />
      </PcuiField>
      <PcuiField label="循环">
        <BooleanInput
          type="toggle"
          value={props.presentation?.backgroundAudioLoop ?? true}
          onChange={(v: boolean) => void props.onUpdateAudio({ loop: v })}
        />
      </PcuiField>
      <PcuiField label="启用">
        <BooleanInput
          type="toggle"
          value={props.presentation?.backgroundAudioEnabled ?? false}
          onChange={(v: boolean) => void props.onUpdateAudio({ enabled: v })}
        />
      </PcuiField>
      <Divider />
      <Label
        class="gs-props__hint"
        text="背景音频由平台控制器管理（官方 settings.soundUrl 无 volume/loop 能力）。"
      />
    </div>
  );
}
