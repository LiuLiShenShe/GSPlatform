/**
 * SuperSplatRuntime —— GSPlatform 唯一官方 SuperSplat Runtime 封装（SSV-02）。
 *
 * - Desktop / XR 所有后续页面必须经过此层；页面不得直接调用
 *   `@playcanvas/supersplat-viewer/viewer` 的 createViewer。
 * - 基于锁定版本 1.35.0 的官方类型（viewer.d.ts / settings.d.ts），不复制官方源码。
 * - 事件订阅全部由本层封装，页面不直接监听底层 events；destroy() 后无 listener 残留。
 *
 * Renderer Policy（固定）：
 *   - mode === 'desktop' → renderer 不传（官方默认 webgpu，自动 fallback WebGL）
 *   - mode === 'xr'      → renderer: 'webgl'（禁止 XR 默认走 WebGPU）
 */
import {
  createViewer,
  type CreateViewerOptions,
  type ViewerHandle,
  type ViewerState,
  type XrMode,
} from '@playcanvas/supersplat-viewer/viewer';
// 官方 viewer 样式（.sse-viewer 根容器 100%×100%、canvas 绝对定位填充）。
// 不导入则官方根容器无尺寸，画布停留在默认 300×150，场景只在左上角一小块显示。
import '@playcanvas/supersplat-viewer/viewer.css';
import {
  CAMERA_FOV_RANGE,
  DEFAULT_CAMERA_FOV,
  type CameraPose,
} from '@playcanvas/supersplat-viewer/settings';
import { SuperSplatRuntimeError } from './runtimeErrors';
import type { SceneBounds } from './sceneScale';
import {
  SceneTransformAdapter,
  composeEntityEulerDeg,
  type AdapterVec3,
} from './SceneTransformAdapter';
import type { ScenePickingAdapter } from './ScenePickingAdapter';
import { applyUiScopeStyles } from './superSplatUiCompatibility';
import type { RuntimeViewpoint, RuntimeWorldTransform } from './types';

/**
 * 相机封装（SSV-05 §5）目标距离策略。
 *
 * 官方引擎相机实体不暴露 orbit 焦点距离（距离存在内部 CameraManager 中），
 * 但实际 view 完全由 position + forward 方向 + fov 决定 —— target 距离只影响
 * 重新进入时的 orbit 半径。这里取「相机到场景包围盒中心的距离」作为焦点深度，
 * 沿真实 forward 方向重建 target（等价于官方 calcFocusPoint 的语义），
 * 未加载/未找到时回退固定距离。见 {@link CameraPose}。
 */
const CAMERA_POSE_FALLBACK_DISTANCE = 3;

/**
 * FIX-05 §27：setCameraPose 注入隐藏 pose 标注的**固定** key —— 反复调用只
 * 复用同一条临时条目（更新 pose、保持 index 稳定），不会按调用次数堆积隐藏
 * 标注。区别于已保存视角的稳定 key（``viewpoint:<id>``）。
 */
const TEMP_CAMERA_POSE_KEY = '__gsplatform_temp_camera_pose__';

/** 场景 gsplat 包围盒访问器（避免依赖 playcanvas 具体类型）。 */
interface GsplatAabbLike {
  center?: { x: number; y: number; z: number };
  halfExtents?: { x: number; y: number; z: number };
}

interface GsplatEntityLike {
  // 官方 1.35.0：场景包围盒取 gsplatComponent.customAabb（经实体世界变换），
  // 不是 instance.aabb —— instance.aabb 在 playcanvas 2.22 下为 null。
  gsplat?: { customAabb?: GsplatAabbLike };
  getWorldTransform?: () => { data: ArrayLike<number> };
}

/** 运行模式：决定 Renderer Policy。 */
export type RuntimeMode = 'desktop' | 'xr';

/** 引擎 app 类型（官方未从 /viewer 导出 AppBase，用 handle 成员推导）。 */
export type RuntimeEngineApp = ViewerHandle['app'];

/** 相机模式（官方类型 CameraMode 未从 /viewer 导出，用 state 成员推导）。 */
export type RuntimeCameraMode = ViewerState['cameraMode'];

/** 创建参数（官方 ViewerAssets + renderer policy）。 */
export interface SuperSplatRuntimeOptions {
  /** 挂载容器（宿主决定尺寸，viewer 填满）。 */
  container: HTMLElement;
  /** splat URL（来自 SceneRuntimeDescriptorV1.content.url）。 */
  contentUrl: string;
  /** 内容文件名（URL 无可用扩展名时用于推断格式）。 */
  contentFilename?: string;
  /** ExperienceSettings v2（由 buildExperienceSettings 产出）。 */
  settings: object;
  /** Poster URL（加载期间显示）。 */
  posterUrl?: string;
  /** Collision 数据 URL（walk 模式；独立于 settings 传递）。 */
  collisionUrl?: string;
  /** 运行模式 → renderer 策略。 */
  mode: RuntimeMode;
  /**
   * 是否启用官方 UI 层（SSV-06：官方 annotation hotspots / tooltip 只在
   * ``ui:true`` 时由 initUI 构建）。默认 false = headless，宿主自绘 UI。
   * 开启后本层注入作用域 CSS，隐藏官方冗余 chrome（.sse-ui），只保留标注层
   * （.sse-sceneLayer）—— 官方控件不重复渲染。
   */
  ui?: boolean;
  /**
   * 世界变换（FIX-02 §5-§9，方案A）。与描述符 presentation.worldTransform
   * 一致；scene↔runtime 换算与 gsplat 实体施加统一经 SceneTransformAdapter。
   * null/恒等 → 实体保持官方初始（存量场景零改动）。
   */
  worldTransform?: RuntimeWorldTransform | null;
  /**
   * 已保存视角（FIX-02 §10）。enabled 视角经 selectViewpoint(id) 导航到其相机；
   * 数据仅供视角导航，绝不注入官方 settings.annotations（官方 v2 无 viewpoints
   * 字段，注入会生成多余 hotspot）。
   */
  viewpoints?: RuntimeViewpoint[];
}

/** 选中官方 annotation 中带 GSPlatform extras 协议的引用（SSV-06 §二）。 */
export interface GsplatformAnnotationRef {
  /** 官方 settings.annotations 数组下标（仅事件定位用，禁止当数据库 ID）。 */
  index: number;
  /** extras.gsplatform.annotationId —— 数据库 SceneAnnotation.id。 */
  annotationId: string;
  /** extras.gsplatform.contentType —— TEXT|IMAGE|VIDEO|AUDIO|PANORAMA。 */
  contentType: string;
}

/** 事件回调参数（与官方 `<key>:changed` 的 (value, previous) 对齐）。 */
export type LoadedCallback = (loaded: boolean) => void;
export type ProgressCallback = (progress: number) => void;
export type XRModeCallback = (mode: XrMode | null) => void;
export type SelectedAnnotationCallback = (index: number | null) => void;
export type CameraModeCallback = (mode: RuntimeCameraMode) => void;

/**
 * 统一官方 SuperSplat Runtime。
 *
 * 通过 {@link SuperSplatRuntime.create} 构造；页面只能拿到这个封装面的方法，
 * 底层 handle 不对外暴露（除 app 用于读取 renderer / gsplats 诊断）。
 */
export class SuperSplatRuntime implements ScenePickingAdapter {
  /** 引擎 app（只读，用于 renderer 类型 / frame.stats 诊断）。 */
  readonly app: RuntimeEngineApp;
  /** 官方 Observable state（只读视图；写入被官方忽略/覆盖）。 */
  readonly state: ViewerState;
  /** 官方 annotations（settings 顺序，只读）。 */
  readonly annotations: ViewerHandle['annotations'];

  /** 当前运行模式（renderer 策略）。 */
  readonly mode: RuntimeMode;

  /**
   * 当前生效的世界变换适配器（FIX-02）。场景→runtime 换算（settings 构建/
   * selectViewpoint）与 runtime→scene 反向换算（作者捕获）共用；作者侧世界变换
   * 滑块变化经 {@link setWorldTransform} 更新 —— 捕获/导航始终用**当前** W，
   * 不会在滑块拖动后继续用过期 W。恒等时全部透传。
   */
  get worldTransform(): SceneTransformAdapter {
    return this.activeTransform;
  }

  private activeTransform: SceneTransformAdapter;

  private readonly handle: ViewerHandle;
  private readonly unsubscribers: Set<() => void> = new Set();
  private destroyed = false;

  /** 已保存视角（仅导航数据；不注入官方 annotations）。 */
  private readonly viewpoints: RuntimeViewpoint[];

  /**
   * 运行时注入的 pose 导航标注（FIX-02 §10/A6 调查结论：官方公开 API 无任意
   * pose setter；唯一受支持路径 = selectAnnotation → annotation.camera.initial）。
   * 注入发生在导航时刻（官方 UI 热点已在 createViewer 时构建完毕），因此不会
   * 生成多余 hotspot。key = 视角 id（``viewpoint:<id>``，稳定）或固定临时 key
   * （FIX-05 §27：``__gsplatform_temp_camera_pose__``，反复 setCameraPose 复用
   * 同一条 → 隐藏标注不随调用次数增长）。
   */
  private readonly injectedPoseAnnotations: { key: string; index: number }[] = [];

  /**
   * 加载后实体原始 TRS（FIX-05 §18-21）。首次观察到 gsplat 实体时捕获，之后
   * 恒等 W 用它复位、非恒等 W 用它作合成基底 —— 不再假设基底恒等。null = 尚未
   * 捕获（实体未出现）。
   */
  private baseGsplatTransform: {
    position: AdapterVec3;
    rotation: AdapterVec3;
    scale: AdapterVec3;
  } | null = null;

  private constructor(handle: ViewerHandle, viewerOptions: CreateViewerOptions) {
    this.handle = handle;
    this.mode = viewerOptions.renderer === 'webgl' ? 'xr' : 'desktop';
    this.app = handle.app;
    this.state = handle.state;
    this.annotations = handle.annotations;
    const options = viewerOptions as CreateViewerOptions & {
      worldTransform?: RuntimeWorldTransform | null;
      viewpoints?: RuntimeViewpoint[];
    };
    this.activeTransform = SceneTransformAdapter.fromWorldTransform(options.worldTransform);
    this.viewpoints = options.viewpoints ?? [];
  }

  // ------------------------------------------------------------------ #
  // 创建 / 销毁
  // ------------------------------------------------------------------ #

  /**
   * 创建官方 runtime。
   *
   * @param options - 见 {@link SuperSplatRuntimeOptions}。
   * @returns resolve 为已就绪的 SuperSplatRuntime（场景尚在加载，loaded 可能为 false）。
   */
  static async create(options: SuperSplatRuntimeOptions): Promise<SuperSplatRuntime> {
    if (options.ui) {
      applyUiScopeStyles(options.container);
    }
    const viewerOptions = toCreateViewerOptions(options);
    const handle = await createViewer(viewerOptions);
    return new SuperSplatRuntime(handle, viewerOptions);
  }

  /** 释放一切（engine / graphics context / 全部 listener / 容器子树）。幂等。 */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    // 先摘掉本层订阅，再销毁 handle（handle.destroy 本身也清理官方内部 listener）。
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers.clear();
    this.handle.destroy();
  }

  // ------------------------------------------------------------------ #
  // state 读取
  // ------------------------------------------------------------------ #

  get loaded(): boolean {
    return this.requiredState().loaded;
  }

  get progress(): number {
    return this.requiredState().progress;
  }

  get cameraMode(): RuntimeCameraMode {
    return this.requiredState().cameraMode;
  }

  get performanceMode(): boolean {
    return this.requiredState().performanceMode;
  }

  get walkAllowed(): boolean {
    return this.requiredState().walkAllowed;
  }

  get hasCollision(): boolean {
    return this.requiredState().hasCollision;
  }

  get selectedAnnotation(): number | null {
    return this.requiredState().selectedAnnotation;
  }

  /**
   * 当前选中官方 annotation 的 GSPlatform extras 引用（SSV-06 §二）。
   *
   * 读取官方 annotation.extras.gsplatform.annotationId —— 页面用它解析数据库
   * SceneAnnotation，**禁止**用官方数组 index 当数据库 ID。无选中 / 非
   * GSPlatform 标注（无 extras 协议）返回 null。
   */
  get selectedGsplatformAnnotation(): GsplatformAnnotationRef | null {
    const index = this.requiredState().selectedAnnotation;
    if (index === null || index < 0) return null;
    const ann = this.annotations[index];
    const extras = ann?.extras as
      | { gsplatform?: { annotationId?: unknown; contentType?: unknown } }
      | undefined;
    const annotationId = extras?.gsplatform?.annotationId;
    if (typeof annotationId !== 'string' || annotationId.length === 0) return null;
    const contentType =
      typeof extras?.gsplatform?.contentType === 'string'
        ? (extras.gsplatform.contentType as string)
        : 'TEXT';
    return { index, annotationId, contentType };
  }

  get isFullscreen(): boolean {
    return this.requiredState().isFullscreen;
  }

  get canStartVR(): boolean {
    return this.requiredState().canStartVR;
  }

  get canStartAR(): boolean {
    return this.requiredState().canStartAR;
  }

  get xrMode(): XrMode | null {
    return this.requiredState().xrMode;
  }

  // ------------------------------------------------------------------ #
  // 动作
  // ------------------------------------------------------------------ #

  /** 取景整个场景（切 orbit）。需要 state.loaded；未加载/已销毁时官方抛错。 */
  frameScene(): void {
    this.requireLive().frameScene();
  }

  /** 重置当前相机（恢复初始视角 / fly-walk 出生点）。需要 state.loaded。 */
  resetCamera(): void {
    this.requireLive().resetCamera();
  }

  /** 进入原生全屏（需用户手势）。 */
  requestFullscreen(): Promise<void> {
    return this.requireLive().requestFullscreen();
  }

  /** 退出本 viewer 的全屏。 */
  exitFullscreen(): Promise<void> {
    return this.requireLive().exitFullscreen();
  }

  /** 从用户手势启动 immersive-vr 会话（需要 canStartVR）。 */
  startVR(): Promise<void> {
    return this.requireLive().startXR('vr');
  }

  /** 从用户手势启动 immersive-ar 会话（需要 canStartAR）。 */
  startAR(): Promise<void> {
    return this.requireLive().startXR('ar');
  }

  /** 结束当前 XR 会话（空闲时为 no-op）。 */
  endXR(): Promise<void> {
    return this.requireLive().endXR();
  }

  /** 进入/退出 walk 模式（walkAllowed 为 false 时无效）。需要 state.loaded。 */
  toggleWalk(): void {
    this.requireLive().toggleWalk();
  }

  /** 选中第 index 个 annotation 并过渡到其相机（0-based）。需要 state.loaded。 */
  selectAnnotation(index: number): void {
    this.requireLive().selectAnnotation(index);
  }

  /** 清除 annotation 选中但不移动相机。需要 state.loaded。 */
  clearAnnotation(): void {
    this.requireLive().selectAnnotation(null);
  }

  /** 保持相机相对移动输入：x 向右，z 向前，范围 -1..1；(0,0) 停止。需要 state.loaded。 */
  setMoveInput(x: number, z: number): void {
    this.requireLive().setMoveInput(x, z);
  }

  // ------------------------------------------------------------------ #
  // 相机封装（SSV-05 §5）—— 页面禁止直接触碰 PlayCanvas app，
  // 相机数据一律经本层读取/写入
  // ------------------------------------------------------------------ #

  /**
   * 场景 gsplat 世界包围盒（SSV-07 §4 尺度诊断）。
   *
   * 1 Scene Unit = 1 meter；页面用 {@link assessSceneScale} 判断尺度是否
   * 明显异常，异常时提示「Scene scale needs calibration」并禁走。
   * 未加载 / 实体缺失返回 null。
   */
  getSceneBounds(): SceneBounds | null {
    const aabb = this.gsplatAabb();
    if (!aabb?.center || !aabb.halfExtents) return null;
    const cx = aabb.center.x;
    const cy = aabb.center.y;
    const cz = aabb.center.z;
    const hx = aabb.halfExtents.x;
    const hy = aabb.halfExtents.y;
    const hz = aabb.halfExtents.z;
    if (![cx, cy, cz, hx, hy, hz].every(Number.isFinite)) return null;
    return {
      min: [cx - hx, cy - hy, cz - hz],
      max: [cx + hx, cy + hy, cz + hz],
      size: [hx * 2, hy * 2, hz * 2],
    };
  }

  /**
   * 当前相机 pose（position / target / fov）。
   *
   * position 与 fov 直接从引擎相机实体读取（可公开获得的真实数据）；
   * target 沿真实 forward 方向、深度取「相机到场景包围盒中心的距离」
   * （未加载时回退固定距离），与官方 calcFocusPoint 语义一致 ——
   * 不自行发明相机姿态。场景未加载 / 相机实体缺失时返回 null。
   */
  getCameraPose(): CameraPose | null {
    const camera = this.cameraEntity();
    if (!camera?.camera) return null;
    const position = camera.getPosition();
    const forward = camera.forward;
    const distance = this.cameraFocusDistance(position);
    return {
      position: [position.x, position.y, position.z],
      target: [
        position.x + forward.x * distance,
        position.y + forward.y * distance,
        position.z + forward.z * distance,
      ],
      fov: clampFov(camera.camera.fov),
    };
  }

  /**
   * 把相机过渡到给定 pose（position + lookAt target + fov）。
   *
   * FIX-02 §10 调查结论：官方 1.35.0 **没有**公开的 setCameraPose —— 直接写引擎
   * 相机实体（findByName('camera').setPosition）会被官方 CameraManager 每帧
   * `applyCamera` 覆盖（viewer.ts update → applyCamera），一次都留不住。唯一受支持
   * 的任意 pose 路径 = `selectAnnotation(i)` → `annotation.camera.initial`
   * （camera-manager.selectAnnotation 切 orbit + goto 该 pose，官方过渡动画）。
   * 因此本方法把 pose 包成一个**运行时注入的隐藏标注**（extras 不含 annotationId
   * → 不会被解析为真实标注 / 不触发媒体 Overlay），再 select 它的 index。
   *
   * 用于 /scene 视角导航、已保存视角、?spawn= 测试定位、authoring 定位。
   */
  setCameraPose(pose: CameraPose): void {
    // FIX-05 §26-§28：固定临时 key —— 100 次调用至多 1 条隐藏临时标注（更新
    // 复用），不随调用次数增长；已保存视角仍用稳定 `viewpoint:<id>` key。
    this.navigateToPose(pose, TEMP_CAMERA_POSE_KEY);
  }

  /**
   * 导航到已保存视角的相机（FIX-02 §10）。经 SceneTransformAdapter 换算到
   * RUNTIME 空间后（视角数据与 gsplat/标注/初始相机共用同一世界变换），复用同一
   * 注入标注再 select → 官方过渡到该相机。返回是否成功找到并导航。
   */
  selectViewpoint(viewpointId: string): boolean {
    const vp = this.viewpoints.find((v) => v.id === viewpointId && v.enabled !== false);
    if (!vp) return false;
    const rt = this.worldTransform.sceneToRuntimeCamera({
      position: vp.position,
      target: vp.target,
      fov: vp.fov,
    });
    // adapter 返回 {x,y,z} 结构 → 官方 CameraPose 用数组元组。
    this.navigateToPose(
      {
        position: [rt.position.x, rt.position.y, rt.position.z],
        target: [rt.target.x, rt.target.y, rt.target.z],
        fov: rt.fov,
      },
      `viewpoint:${vp.id}`,
    );
    return true;
  }

  /** 已保存视角列表（只读副本语义）。 */
  getViewpoints(): readonly RuntimeViewpoint[] {
    return this.viewpoints;
  }

  /**
   * 施加世界变换到官方 gsplat 实体（方案A runtime Scene Root Transform，
   * FIX-02 §5-§9；FIX-05 §18-§21 修复复位）。
   *
   * 语义：首次观察到实体时捕获其加载后的原始 TRS 为 baseGsplatTransform；
   * 之后每次调用都施加 ``actualTransform = W ∘ base``（恒等 W = 恢复 base）——
   * 不再假定 base 恒等，也不存在「恒等早退」导致变换后无法复位的问题。
   *
   * 旋转合成（composeEntityEulerDeg）：W.rot ∘ base.rot（官方烘焙 Rz180 为
   * 默认 base）；位置 = W 作用于 base 原点；缩放按轴相乘（对齐轴时精确）。
   *
   * 幂等：重复调用安全；base 只捕获一次（首次实体出现时，即官方 onLoaded 装配
   * 完成、尚未施加任何 W 的 pristine 状态）。
   */
  applyWorldTransform(): boolean {
    const gsplat = this.gsplatEntity();
    if (!gsplat) return false; // 加载中/实体未就绪
    if (this.baseGsplatTransform === null) {
      // 捕获基准：此后 setWorldTransform / setWorldTransform(null) 都能复位。
      this.baseGsplatTransform = this.captureBaseTransform(gsplat);
    }
    const base = this.baseGsplatTransform;
    if (this.worldTransform.isIdentity) {
      // FIX-05 §18-21：恒等 W → 恢复实体原始 TRS（此前 early-return 留旧位）。
      gsplat.setLocalPosition(base.position.x, base.position.y, base.position.z);
      gsplat.setLocalEulerAngles(base.rotation.x, base.rotation.y, base.rotation.z);
      gsplat.setLocalScale(base.scale.x, base.scale.y, base.scale.z);
      gsplat.sync?.();
      return true;
    }
    const { position, rotation, scale } = this.worldTransform;
    const composedPos = this.worldTransform.sceneToRuntimePoint(base.position);
    const euler = composeEntityEulerDeg(
      { position, rotation, scale },
      [base.rotation.x, base.rotation.y, base.rotation.z],
    );
    gsplat.setLocalPosition(composedPos.x, composedPos.y, composedPos.z);
    gsplat.setLocalEulerAngles(euler[0], euler[1], euler[2]);
    gsplat.setLocalScale(scale.x * base.scale.x, scale.y * base.scale.y, scale.z * base.scale.z);
    gsplat.sync?.();
    return true;
  }

  /** 捕获实体当前局部 TRS（只读，拷贝值不让调用方改到实体）。 */
  private captureBaseTransform(gsplat: {
    getLocalPosition(): { x: number; y: number; z: number };
    getLocalEulerAngles(): { x: number; y: number; z: number };
    getLocalScale(): { x: number; y: number; z: number };
  }): { position: AdapterVec3; rotation: AdapterVec3; scale: AdapterVec3 } {
    const p = gsplat.getLocalPosition();
    const r = gsplat.getLocalEulerAngles();
    const s = gsplat.getLocalScale();
    return {
      position: { x: p.x, y: p.y, z: p.z },
      rotation: { x: r.x, y: r.y, z: r.z },
      scale: { x: s.x, y: s.y, z: s.z },
    };
  }

  /** 世界变换诊断：原始 position/rotation/scale + 施加后的场景包围盒。 */
  worldTransformInfo(): {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    isIdentity: boolean;
  } {
    return {
      position: { ...this.worldTransform.position },
      rotation: { ...this.worldTransform.rotation },
      scale: { ...this.worldTransform.scale },
      isIdentity: this.worldTransform.isIdentity,
    };
  }

  /**
   * 更新 **当前生效** 的世界变换（FIX-02 §9 作者侧实时预览）。
   *
   * 覆盖调度器：更新内部适配器（此后所有 scene→runtime / runtime→scene 换算、
   * selectViewpoint / 捕获反向换算都走**新** W —— 滑块拖动后不再用过期 W），
   * 并把实体（若已出现）就地重新施加。可传 null → 恢复恒等。
   *
   * 返回 false 表示实体尚未出现（加载中），适配器仍已更新 —— 下一次
   * {@link applyWorldTransform}（onLoaded / 重建时）会读到新 W。
   */
  setWorldTransform(wt: RuntimeWorldTransform | null): boolean {
    this.activeTransform = SceneTransformAdapter.fromWorldTransform(wt);
    return this.applyWorldTransform();
  }

  /**
   * 把一个 RUNTIME 空间 pose 导航到位（官方 selectAnnotation 过渡）。
   * 内部：把 pose 包成注入标注 → selectAnnotation(index)。不等待动画。
   */
  private navigateToPose(pose: CameraPose, key: string): void {
    if (!this.requiredState().loaded) return; // 未加载时官方抛错，静默跳过
    const index = this.ensurePoseAnnotation(pose, key);
    this.handle.selectAnnotation(index);
  }

  /** 在官方 annotations 数组尾部注入（或复用）一个隐藏 pose 标注，返回其 index。 */
  private ensurePoseAnnotation(pose: CameraPose, key: string): number {
    // handle.annotations 与官方 settings.annotations 同一数组引用（官方
    // viewer.selectAnnotation 按 index 读该数组），导航时追加的条目在官方 UI
    // 热点构建完成后注入 → 不会生成多余 hotspot。
    const arr = this.handle.annotations as unknown as Array<{
      position: [number, number, number];
      title: string;
      text: string;
      extras: { gsplatform: { viewpointId?: string } };
      camera: { initial: { position: [number, number, number]; target: [number, number, number]; fov: number } };
    }>;
    const existing = this.injectedPoseAnnotations.find((e) => e.key === key);
    const entry = {
      position: [pose.position[0], pose.position[1], pose.position[2]] as [number, number, number],
      title: '',
      text: '',
      // extras 不含 annotationId → selectedGsplatformAnnotation 解析为 null
      // （不会被当成真实标注 / 不触发媒体 Overlay）。
      extras: { gsplatform: {} },
      camera: {
        initial: {
          position: [pose.position[0], pose.position[1], pose.position[2]] as [number, number, number],
          target: [pose.target[0], pose.target[1], pose.target[2]] as [number, number, number],
          fov: clampFov(pose.fov),
        },
      },
    };
    if (existing) {
      // 复用同一条（更新 pose），保持 index 稳定。
      (arr as Array<unknown>)[existing.index] = entry;
      return existing.index;
    }
    arr.push(entry);
    const index = arr.length - 1;
    this.injectedPoseAnnotations.push({ key, index });
    return index;
  }

  /**
   * 近似拾取 NDC 坐标（-1..1，x 向右、y 向上）对应的 3D 世界位置。
   *
   * FIX-05 §29-§30：**不保证命中 splat 表面**。实现只是沿解投影视线取「场景
   * 包围盒中心深度」的点 —— 作为标注锚点的近似（bbox 深度近似，非 GPU 表面
   * 拾取；官方 1.35.0 公开 API 无精确拾取）。未来精确接口见
   * {@link ScenePickingAdapter.pickSurfaceWorldPosition}。相机缺失/未就绪返回 null。
   */
  pickApproximateWorldPosition(x: number, y: number): { position: [number, number, number] } | null {
    const camera = this.cameraEntity();
    if (!camera?.camera) return null;
    const position = camera.getPosition();
    const forward = camera.forward;
    const right = camera.right;
    const up = camera.up;
    const tanY = Math.tan((clampFov(camera.camera.fov) * Math.PI) / 360);
    const tanX = tanY * this.canvasAspect();
    const dx = forward.x + right.x * (x * tanX) + up.x * (y * tanY);
    const dy = forward.y + right.y * (x * tanX) + up.y * (y * tanY);
    const dz = forward.z + right.z * (x * tanX) + up.z * (y * tanY);
    const len = Math.hypot(dx, dy, dz);
    if (!len || !Number.isFinite(len)) return null;
    const scale = this.cameraFocusDistance(position) / len;
    return {
      position: [
        position.x + dx * scale,
        position.y + dy * scale,
        position.z + dz * scale,
      ],
    };
  }

  /**
   * 离屏渲染当前场景（含 post effects）并返回 base64 dataURL。
   *
   * 底层走官方 handle.captureFrame()（官方 supersample 缩样管线）；官方返回
   * 原始 RGBA base64，本层经 2D canvas 转成浏览器可解码的图片 dataURL。
   * 场景未加载返回 null（不抛错）。
   */
  async captureScreenshot(options?: {
    width?: number;
    height?: number;
    supersample?: number;
    format?: 'image/webp' | 'image/png' | 'image/jpeg';
    quality?: number;
  }): Promise<{ dataUrl: string } | null> {
    const handle = this.requireLive();
    if (!handle.state.loaded) return null;
    try {
      const result = await handle.captureFrame({
        width: options?.width,
        height: options?.height,
        supersample: options?.supersample,
      });
      // 官方 captureFrame 返回 btoa 的原始 RGBA 字节（非 PNG 编码）。
      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const canvas = document.createElement('canvas');
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.createImageData !== 'function') return null;
      const image = ctx.createImageData(result.width, result.height);
      image.data.set(bytes);
      ctx.putImageData(image, 0, 0);
      return { dataUrl: canvas.toDataURL(options?.format ?? 'image/webp', options?.quality ?? 0.9) };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ #
  // 事件订阅（页面禁止直接监听底层 events）
  // ------------------------------------------------------------------ #

  /** 首帧渲染完成订阅（loaded:false → true）。返回 unsubscribe。 */
  onLoaded(callback: LoadedCallback): () => void {
    return this.subscribe('loaded', (value: boolean) => callback(value));
  }

  /** 内容加载进度订阅（0..100）。返回 unsubscribe。 */
  onProgress(callback: ProgressCallback): () => void {
    return this.subscribe('progress', (value: number) => callback(value));
  }

  /** 真实 XR 会话状态订阅（vr / ar / null，含系统菜单退出）。返回 unsubscribe。 */
  onXRModeChanged(callback: XRModeCallback): () => void {
    return this.subscribe('xrMode', (value: XrMode | null) => callback(value));
  }

  /** 选中 annotation 变化订阅（index | null）。返回 unsubscribe。 */
  onSelectedAnnotationChanged(callback: SelectedAnnotationCallback): () => void {
    return this.subscribe('selectedAnnotation', (value: number | null) => callback(value));
  }

  /** 相机模式变化订阅（orbit / anim / fly / walk）。返回 unsubscribe。 */
  onCameraModeChanged(callback: CameraModeCallback): () => void {
    return this.subscribe('cameraMode', (value: RuntimeCameraMode) => callback(value));
  }

  // ------------------------------------------------------------------ #
  // 内部
  // ------------------------------------------------------------------ #

  private subscribe<T>(key: string, fn: (value: T) => void): () => void {
    const handle = this.requireLive();
    const event = `${key}:changed`;
    const listener = (value: unknown) => fn(value as T);
    handle.events.on(event, listener);
    const unsubscribe = () => handle.events.off(event, listener);
    this.unsubscribers.add(unsubscribe);
    return () => {
      this.unsubscribers.delete(unsubscribe);
      unsubscribe();
    };
  }

  private requireLive(): ViewerHandle {
    if (this.destroyed) {
      throw new SuperSplatRuntimeError('DESTROYED', 'runtime 已销毁');
    }
    return this.handle;
  }

  private requiredState(): ViewerState {
    return this.requireLive().state;
  }

  /** 引擎相机实体（官方 viewer 固定命名为 'camera'）。缺失/已销毁返回 null。 */
  private cameraEntity(): {
    camera?: { fov: number };
    // 方向/上/右在 Entity 上是 Vec3 只读属性（playcanvas GraphNode.forward /
    // right / up），不是方法 —— SSV-07 探针实测修正。
    forward: { x: number; y: number; z: number };
    right: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
    getPosition(): { x: number; y: number; z: number };
    setPosition(x: number, y: number, z: number): void;
    lookAt(x: number, y: number, z: number): void;
  } | null {
    try {
      const root = this.requireLive().app?.root as
        | { findByName(name: string): unknown | null }
        | undefined;
      const entity = root?.findByName('camera') as
        | {
            camera?: { fov: number };
            forward: { x: number; y: number; z: number };
            right: { x: number; y: number; z: number };
            up: { x: number; y: number; z: number };
            getPosition(): { x: number; y: number; z: number };
            setPosition(x: number, y: number, z: number): void;
            lookAt(x: number, y: number, z: number): void;
          }
        | null
        | undefined;
      return entity?.camera ? entity : null;
    } catch {
      return null;
    }
  }

  /** 官方 gsplat 实体访问器（FIX-02 §5：世界变换施加目标）。缺失返回 null。 */
  private gsplatEntity(): {
    setLocalPosition(x: number, y: number, z: number): void;
    setLocalEulerAngles(x: number, y: number, z: number): void;
    setLocalScale(x: number, y: number, z: number): void;
    // FIX-05 §18-21：读取加载后的基准 TRS（恒等 W 复位用）。
    getLocalPosition(): { x: number; y: number; z: number };
    getLocalEulerAngles(): { x: number; y: number; z: number };
    getLocalScale(): { x: number; y: number; z: number };
    sync?(): void;
  } | null {
    try {
      const root = this.requireLive().app?.root as
        | { findByName(name: string): unknown | null }
        | undefined;
      const entity = root?.findByName('gsplat') as
        | {
            setLocalPosition(x: number, y: number, z: number): void;
            setLocalEulerAngles(x: number, y: number, z: number): void;
            setLocalScale(x: number, y: number, z: number): void;
            getLocalPosition(): { x: number; y: number; z: number };
            getLocalEulerAngles(): { x: number; y: number; z: number };
            getLocalScale(): { x: number; y: number; z: number };
            sync?(): void;
          }
        | null
        | undefined;
      return entity ?? null;
    } catch {
      return null;
    }
  }

  /** 相机到场景 gsplat 包围盒中心的距离（焦点深度）；缺失时回退固定距离。 */
  private cameraFocusDistance(from: { x: number; y: number; z: number }): number {
    const aabb = this.gsplatAabb();
    const center = aabb?.center;
    if (center && Number.isFinite(center.x + center.y + center.z)) {
      const dx = center.x - from.x;
      const dy = center.y - from.y;
      const dz = center.z - from.z;
      const dist = Math.hypot(dx, dy, dz);
      if (Number.isFinite(dist) && dist > 0) return dist;
    }
    return CAMERA_POSE_FALLBACK_DISTANCE;
  }

  /**
   * gsplat 世界包围盒（官方 1.35.0 语义）。
   *
   * 官方 viewer 计算场景包围盒：`sceneBound.setFromTransformedAabb(
   * gsplatComponent.customAabb, entity.getWorldTransform())` —— 用实体世界
   * 变换把 customAabb 的 8 个角变换后重新贴合。这里复刻同一数学（不 import
   * playcanvas BoundingBox，纯算术），供尺度诊断 / 相机焦点深度使用。
   * 缺失或变换矩阵不可用返回 null。
   */
  private gsplatAabb(): GsplatAabbLike | null {
    try {
      const root = this.requireLive().app?.root as
        | { findByName(name: string): unknown | null }
        | undefined;
      const splat = root?.findByName('gsplat') as GsplatEntityLike | null | undefined;
      const box = splat?.gsplat?.customAabb;
      if (!box?.center || !box.halfExtents) return null;
      const { center, halfExtents } = box;
      const { x: cx, y: cy, z: cz } = center;
      const { x: hx, y: hy, z: hz } = halfExtents;
      const m = splat?.getWorldTransform?.()?.data;
      if (!m || m.length < 16) return null;
      // pc.Mat4.data 是列主序 16 元：m[0..3]=列0 … m[12..15]=列3（平移）。
      // 变换 8 个角 → 重新贴合最小/最大 → center/halfExtents。
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const corners: Array<[number, number, number]> = [
        [cx - hx, cy - hy, cz - hz],
        [cx + hx, cy - hy, cz - hz],
        [cx - hx, cy + hy, cz - hz],
        [cx + hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz],
        [cx + hx, cy - hy, cz + hz],
        [cx - hx, cy + hy, cz + hz],
        [cx + hx, cy + hy, cz + hz],
      ];
      for (const [px, py, pz] of corners) {
        const ox = m[0] * px + m[4] * py + m[8] * pz + m[12];
        const oy = m[1] * px + m[5] * py + m[9] * pz + m[13];
        const oz = m[2] * px + m[6] * py + m[10] * pz + m[14];
        if (ox < minX) minX = ox;
        if (oy < minY) minY = oy;
        if (oz < minZ) minZ = oz;
        if (ox > maxX) maxX = ox;
        if (oy > maxY) maxY = oy;
        if (oz > maxZ) maxZ = oz;
      }
      if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
      return {
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
        halfExtents: { x: (maxX - minX) / 2, y: (maxY - minY) / 2, z: (maxZ - minZ) / 2 },
      };
    } catch {
      return null;
    }
  }

  /** 画布宽高比（用于解投影）；不可用时回退 1。 */
  private canvasAspect(): number {
    try {
      const device = this.requireLive().app?.graphicsDevice as
        | { width?: number; height?: number }
        | undefined;
      if (
        device &&
        typeof device.width === 'number' &&
        typeof device.height === 'number' &&
        device.width > 0 &&
        device.height > 0
      ) {
        return device.width / device.height;
      }
    } catch {
      // 已销毁 —— 回退 1。
    }
    return 1;
  }
}

function clampFov(fov: number): number {
  const value = Number.isFinite(fov) ? fov : DEFAULT_CAMERA_FOV;
  return Math.min(Math.max(value, CAMERA_FOV_RANGE.min), CAMERA_FOV_RANGE.max);
}

// ------------------------------------------------------------------ #
// Renderer Policy（固定）
// ------------------------------------------------------------------ #

/**
 * 依运行模式决定官方 renderer 参数：
 *   desktop → undefined（官方默认 webgpu，引擎自动 fallback WebGL —— “auto”）
 *   xr      → 'webgl'（禁止 XR 默认走 WebGPU）
 */
export function rendererForMode(mode: RuntimeMode): 'webgl' | undefined {
  return mode === 'xr' ? 'webgl' : undefined;
}

function toCreateViewerOptions(options: SuperSplatRuntimeOptions): CreateViewerOptions {
  return {
    container: options.container,
    contentUrl: options.contentUrl,
    contentFilename: options.contentFilename,
    settings: options.settings,
    posterUrl: options.posterUrl,
    collisionUrl: options.collisionUrl,
    // SSV-03 起 headless：默认不渲染官方控件（宿主自绘）。
    // SSV-06 起可选 ui:true：官方 annotation hotspots / tooltip 需要官方 UI 层，
    // 开启后由 applyUiScopeStyles 隐藏多余 chrome，只保留 .sse-sceneLayer。
    ui: options.ui ?? false,
    // Renderer Policy：
    //   desktop → undefined（官方默认 webgpu，引擎自动 fallback WebGL，即“auto”）
    //   xr      → 'webgl'（禁止 XR 默认走 WebGPU）
    renderer: rendererForMode(options.mode),
    // FIX-02 §5-§9 / §10：透传给运行时构造（scene↔runtime 换算 + 视角导航）。
    worldTransform: options.worldTransform ?? null,
    viewpoints: options.viewpoints ?? [],
  } as CreateViewerOptions;
}

// ------------------------------------------------------------------ #
// 官方 UI 内部 class 兼容（FIX-03 §11/§12）—— 全部集中在
// scene-runtime/superSplatUiCompatibility.ts（禁止散落）：
//   Pinned to @playcanvas/supersplat-viewer@1.35.0（内部 CSS 依赖）
// 只保留官方 annotations 层（.sse-sceneLayer），隐藏官方冗余 chrome（.sse-ui）
// —— 宿主自绘控件，不重复渲染，且不 fork viewer。
// ------------------------------------------------------------------ #

// ------------------------------------------------------------------ #
// 诊断辅助（供 runtime 页面读取真实引擎状态）
// ------------------------------------------------------------------ #

/** 当前实际渲染器类型（webgl / webgpu）。 */
export function runtimeRenderer(app: RuntimeEngineApp): string {
  return app?.graphicsDevice?.deviceType ?? 'unknown';
}

/** 当前帧已渲染 Gaussian 数（首帧前为 0）。 */
export function renderedSplatCount(app: RuntimeEngineApp): number {
  const gsplats = app?.stats?.frame?.gsplats;
  return typeof gsplats === 'number' && Number.isFinite(gsplats) ? gsplats : 0;
}