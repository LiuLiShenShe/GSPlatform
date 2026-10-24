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
import { useMemo, useRef, useState } from 'react';
import {
  BooleanInput,
  ColorPicker,
  Divider,
  Label,
  NumericInput,
  Panel,
  SelectInput,
  SliderInput,
  TextInput,
} from '@playcanvas/pcui/react';
import { PcuiField } from './PcuiField';
import { PcuiButton } from './PcuiButton';
import { AnnotationProperties } from './AnnotationProperties';
import { ViewpointProperties } from './ViewpointProperties';
import type { SceneAnnotation } from '../../../services/annotationApi';
import type { ScenePresentation, SceneViewpoint, Vec3 } from '../../../services/presentationApi';
import type { AuthoringCameraPose } from '../authoringTypes';
import type { RuntimePostEffects, RuntimeTonemapping } from '../../../scene-runtime/types';
import type { RuntimeInitialCameraUse } from '../../../scene-runtime/initialCameraPolicy';
import { POST_EFFECT_RANGES } from '@playcanvas/supersplat-viewer/settings';

export type SceneSection = 'camera' | 'world' | 'background' | 'postfx' | 'cover' | 'audio';
export type WorkspaceSelection =
  | { kind: 'scene'; section: SceneSection }
  | { kind: 'annotation'; id: string }
  | { kind: 'viewpoint'; id: string };

export type ManagementKind = 'editor' | 'versions' | 'collision';

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
  /** 标注放置模式：点击 viewer 画布时回调（页面负责 NDC → 近似锚点）。 */
  onViewerClick: (event: React.MouseEvent<HTMLDivElement>) => void;
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
  const { sceneId, selection, onSelect, annotations, viewpoints } = props;
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

  return (
    <div className="gs-workspace" data-testid="scene-authoring-page">
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
        <PcuiButton text="版本历史" onClick={() => props.onOpenManagement('versions')} />
        <PcuiButton text="碰撞" onClick={() => props.onOpenManagement('collision')} />
      </header>

      <div className="gs-workspace__body">
        {/* 左：场景 / 标注 / 视角 */}
        <div className="gs-workspace__left">
          <Panel headerText="场景" collapsible>
            {(
              [
                ['camera', '初始相机'],
                ['world', '世界方向'],
                ['background', '背景'],
                ['postfx', '后期效果'],
                ['cover', '封面'],
                ['audio', '背景音乐'],
              ] as [SceneSection, string][]
            ).map(([section, label]) => (
              <PcuiButton
                key={section}
                class={
                  selection.kind === 'scene' && selection.section === section
                    ? ['gs-workspace__item', 'gs-workspace__item--active']
                    : 'gs-workspace__item'
                }
                text={label}
                onClick={() => onSelect({ kind: 'scene', section })}
              />
            ))}
          </Panel>

          <Panel headerText="标注" collapsible>
            <PcuiButton
              class="gs-workspace__item"
              text={props.picking ? '正在拾取…（取消）' : '＋ 添加标注'}
              onClick={props.picking ? props.onCancelPicking : props.onStartPicking}
            />
            {annotations
              .slice()
              .sort((a, b) => a.orderIndex - b.orderIndex)
              .map((a) => (
                <div key={a.id} className="gs-workspace__row">
                  <PcuiButton
                    class={
                      selection.kind === 'annotation' && selection.id === a.id
                        ? ['gs-workspace__item', 'gs-workspace__item--active']
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
          </Panel>

          <Panel headerText="视角" collapsible>
            <AddViewpointRow
              disabled={!props.viewerReady}
              onAdd={props.onAddViewpointFromCurrent}
            />
            {viewpoints
              .slice()
              .sort((a, b) => a.orderIndex - b.orderIndex)
              .map((vp) => (
                <div key={vp.id} className="gs-workspace__row">
                  <PcuiButton
                    class={
                      selection.kind === 'viewpoint' && selection.id === vp.id
                        ? ['gs-workspace__item', 'gs-workspace__item--active']
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
          </Panel>
        </div>

        {/* 中：官方 viewer + 相机编辑 / 标注拾取状态 */}
        <div
          className={`gs-workspace__viewer${props.picking ? ' gs-workspace__viewer--picking' : ''}${
            props.cameraEdit ? ' gs-workspace__viewer--camera-edit' : ''
          }`}
          data-testid="authoring-viewer"
          onClick={props.onViewerClick}
        >
          {props.loading && <div className="gs-workspace__loading">加载场景…</div>}
          <div ref={props.containerRef} className="gs-workspace__mount" data-testid="authoring-mount" />
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
              点击 Gaussian 表面放置标注（近似锚点）
              <PcuiButton text="取消" onClick={props.onCancelPicking} />
            </div>
          )}
        </div>

        {/* 右：属性 */}
        <div className="gs-workspace__right">
          {selection.kind === 'annotation' && selectedAnnotation && (
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
          {selection.kind === 'viewpoint' && selectedViewpoint && (
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
          {selection.kind === 'scene' && (
            <SceneProperties {...props} section={selection.section} />
          )}
        </div>
      </div>
    </div>
  );
}

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
        <NumericInput
          value={fov}
          min={10}
          max={120}
          precision={0}
          step={1}
          onChange={(v: number) => props.onSetFov(v)}
        />
      </PcuiField>
      <div className="gs-props__row">
        <PcuiButton text="定位到已保存视角" onClick={props.onResetToSaved} />
        <PcuiButton
          text={props.cameraEdit ? '编辑中…' : '编辑相机'}
          enabled={!props.cameraEdit}
          onClick={props.onEnterCameraEdit}
        />
      </div>
      <PcuiButton
        class="gs-props__wide"
        text="将当前视角设为初始视角"
        enabled={props.viewerReady && !props.authoringSaving}
        onClick={() => void props.onSaveCurrentAsInitial()}
      />
      <Label
        class="gs-props__hint"
        text="编辑模式下可直接在 Viewer 中 Orbit / Pan / Zoom 取景，再点 Apply。"
      />
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
          <NumericInput
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
          <NumericInput
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
