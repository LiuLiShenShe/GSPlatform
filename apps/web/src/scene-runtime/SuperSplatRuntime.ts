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
import type { Entity, EventHandler } from 'playcanvas';
import {
  CAMERA_FOV_RANGE,
  DEFAULT_CAMERA_FOV,
  type CameraPose,
} from '@playcanvas/supersplat-viewer/settings';
import { SuperSplatRuntimeError } from './runtimeErrors';
import type { SceneBounds } from './sceneScale';
import { performanceModeTarget, readPerformanceModePreference } from './performanceModePolicy';
import {
  SceneTransformAdapter,
  composeEntityEulerDeg,
  type AdapterVec3,
} from './SceneTransformAdapter';
import type { ScenePickingAdapter } from './ScenePickingAdapter';
import {
  applyUiScopeStyles,
  clickOfficialControl,
  OFFICIAL_INFO_BUTTON_CLASS,
  OFFICIAL_PLAY_BUTTON_CLASS,
  OFFICIAL_SETTINGS_BUTTON_CLASS,
  prepareOfficialUiDefaults,
  setOfficialAnnotationHotspotsHidden,
  setOfficialControlsToolbarHidden,
} from './superSplatUiCompatibility';
import {
  buildXrDestinations,
  destinationIndexByKey,
  stepDestinationIndex,
  INITIAL_DESTINATION_ID,
  type XrDestination,
} from './xrDestinations';
import { applyRigPose, rigNodesFrom } from './xrRigPose';
import {
  buildXrMenuItems,
  createComfortFade,
  createComfortVeil,
  createXrMenuFont,
  ensureXrUiSystems,
  installXrMenu,
  uiLayerId,
  XR_FLOOR_TELEPORT_ALLOWED,
  XR_MENU_ACTIVE_EVENT,
  XR_MENU_EMPTY_LABEL,
  XR_MENU_EVENTS,
  XR_MENU_STICK_RESET,
  XR_MENU_STICK_THRESHOLD,
  XR_MENU_TOGGLE_BUTTONS,
  pickPreferredXrSource,
  shouldHostHandleXrToggle,
  type XrToggleInputSource,
  type ComfortFade,
  type XrMenuFont,
  type XrMenuHandle,
  type XrUiHostApp,
} from './xrMenu';
import type { RuntimeAnnotation, RuntimeViewpoint, RuntimeWorldTransform } from './types';

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
   * 官方 splat 预算（**百万**高斯，覆盖官方 mobile/desktop × performanceMode 表）。
   *
   * 只用于 XR（VR 专用低 LOD）：官方预算表 mobile {low:1,high:2} / desktop
   * {low:2,high:4}，PICO 浏览器 UA 可能被判成 desktop → 预算偏高。VR 入口显式给
   * 一个更低的预算，官方只流式/渲染该预算以内的 LOD（= “VR 专用低 LOD 版”）。
   * 未设置 → 用官方表（Desktop 不受影响）。
   */
  budget?: number;
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
  /**
   * GS-NEXT-05：可作为**会话内导览目的地**的标注（调用方已用
   * `eligibleGuidePoints()` 过滤：停用 / 无作者化相机的不进列表）。
   *
   * 与进入 VR 前那个「出生位置」选择器是**同一份数据**（同 `descriptor.annotations`
   * 过滤结果、同批数据库 ID）—— 菜单里能到的点 = 桌面上能选的点。
   */
  guidePoints?: RuntimeAnnotation[];
  xrInitialCamera?: CameraPose | null;
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

/** 会话内导览菜单诊断读数（GS-NEXT-05；真机 / e2e 取证口）。 */
export interface XrMenuInfo {
  /** unavailable | installed | install-failed | no-navigation */
  state: string;
  /** 官方 XrMenu 实例是否装上（菜单可见还要手柄按 Y）。 */
  menuInstalled: boolean;
  /** 可达目的地数量（已过滤掉停用 / 无作者化相机的）。 */
  destinationCount: number;
  /** 当前目的地下标（-1 = 未指定）。 */
  destinationIndex: number;
  /** 当前目的地 key（`kind:id`）。 */
  currentDestination: string | null;
  /** 菜单首行文本（`序号/总数 · 名称`）。 */
  currentLabel: string;
  /** 官方 XrNavigation 的地面传送当前是否开启（本产品恒为 false，见 XR_FLOOR_TELEPORT_ALLOWED）。 */
  floorTeleportEnabled: boolean;
  /** 官方菜单当前是否可见（`xr:menu:active`）。 */
  menuVisible: boolean;
  /** 舒适过渡是否进行中。 */
  fadePending: boolean;
  /** 本层补装的官方 UI 组件系统（官方 Viewer 默认没装）。 */
  uiSystemsAdded: string[];
}

/**
 * 统一官方 SuperSplat Runtime。
 *
 * 通过 {@link SuperSplatRuntime.create} 构造；页面只能拿到这个封装面的方法，
 * 底层 handle 不对外暴露（除 app 用于读取 renderer / gsplats 诊断）。
 */
export class SuperSplatRuntime implements ScenePickingAdapter {
  /** 引擎 app（只读，用于 renderer 类型 / frame.stats 诊断）。 */
  readonly app: RuntimeEngineApp;
  /** 宿主挂载容器（官方 root / 底部控制条 / 设置入口都在其 DOM 子树内）。 */
  readonly container: HTMLElement;
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
  /**
   * XR 出生位姿（RUNTIME 空间）。GS-NEXT-03 起可在创建后经
   * {@link setXRInitialCamera} 更换（进入 VR 前选择视点）；换位时必须先取消
   * 尚未施加的对齐，否则旧 pose 会在首个 tracked 帧把 Rig 拉到错误出生点。
   */
  private xrInitialCamera: CameraPose | null;
  private cancelXRSpawn: (() => void) | null = null;
  private vrStarting = false;
  private xrSpawnStatus: 'not-authored' | 'not-entered' | 'pending' | 'applied' | 'unavailable' = 'not-authored';

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

  // ------------------------------------------------------------------ //
  // GS-NEXT-05：会话内导览（官方 XrMenu + 官方 XrNavigation 仲裁）
  // ------------------------------------------------------------------ //

  /**
   * authored initial camera（创建时传入，**不变**）。会话内「返回初始位置」
   * 的目标就是它 —— 与进入 VR 前的出生对齐用的是同一份数据。
   */
  private readonly authoredInitialCamera: CameraPose | null;

  /** 会话内导览目的地（= 进入 VR 前那个出生位置选择器的同一份数据）。 */
  private readonly xrGuidePoints: RuntimeAnnotation[];

  /** 当前目的地 key（`buildXrDestinations` 产出；null = 未指定）。 */
  private xrDestinationKey: string | null = null;

  /** 官方 XrMenu 句柄（未安装 = null，见 {@link xrMenuInfo}）。 */
  private xrMenu: XrMenuHandle | null = null;
  /** 官方菜单字体资产（随 runtime 一起释放）。 */
  private xrMenuFont: XrMenuFont | null = null;
  /** 舒适过渡（黑纱）状态机。 */
  private xrFade: ComfortFade | null = null;
  /** 官方 XrNavigation 实例（floor teleport 仲裁 + 菜单打开时暂停摇杆输入）。 */
  private xrNavigation: {
    enableTeleport: boolean;
    enableMove: boolean;
    enableSnapVertical: boolean;
  } | null = null;
  /** 官方导航的原始开关（菜单关闭时精确恢复；不猜测官方默认值）。 */
  private xrNavBaseline = { enableMove: true, enableSnapVertical: true };
  /** 官方菜单当前是否可见（`xr:menu:active` 维护）。 */
  private xrMenuVisible = false;
  /**
   * 目的地变化订阅者（GS-NEXT-05）：会话内用手柄菜单切换目的地后，页面上的
   * 「选中观察点 / 选中导览点」也必须跟着走 —— 否则 DOM 上显示的选中项与
   * 实际所在位置不一致（与 GS-NEXT-04 放行官方导览器时遇到的同一类假状态）。
   */
  private readonly xrDestinationListeners = new Set<(key: string | null) => void>();
  /** 本层补装的官方 UI 组件系统名（诊断用；官方 App 默认没装）。 */
  private xrUiSystemsAdded: string[] = [];
  /** 宿主兜底开关的"上一帧按下"状态（按输入源对象身份隔离；避免跨源串边沿）。 */
  private readonly xrTogglePressed = new WeakMap<object, boolean>();
  /** 菜单打开时摇杆切换的滞回状态（每个输入源独立）。 */
  private readonly xrStickState = new WeakMap<object, 'neutral' | 'left' | 'right'>();
  /** 菜单安装/使用状态（诊断取证口；不可用时不影响进入 VR 与桌面导航）。 */
  private xrMenuState: 'unavailable' | 'installed' | 'install-failed' | 'no-navigation' = 'unavailable';

  private constructor(handle: ViewerHandle, viewerOptions: CreateViewerOptions) {
    this.handle = handle;
    this.mode = viewerOptions.renderer === 'webgl' ? 'xr' : 'desktop';
    this.app = handle.app;
    this.container = viewerOptions.container;
    this.state = handle.state;
    this.annotations = handle.annotations;
    const options = viewerOptions as CreateViewerOptions & {
      worldTransform?: RuntimeWorldTransform | null;
      viewpoints?: RuntimeViewpoint[];
      guidePoints?: RuntimeAnnotation[];
      xrInitialCamera?: CameraPose | null;
    };
    this.activeTransform = SceneTransformAdapter.fromWorldTransform(options.worldTransform);
    this.viewpoints = options.viewpoints ?? [];
    this.xrGuidePoints = options.guidePoints ?? [];
    this.xrInitialCamera = options.xrInitialCamera ?? null;
    this.authoredInitialCamera = options.xrInitialCamera ?? null;
    if (this.xrInitialCamera) this.xrSpawnStatus = 'not-entered';
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
      // GS-UI-01：官方操作说明浮层默认收起（用户已有偏好时不覆盖）。
      prepareOfficialUiDefaults();
      applyUiScopeStyles(options.container);
    }
    const viewerOptions = toCreateViewerOptions(options);
    const handle = await createViewer(viewerOptions);
    const runtime = new SuperSplatRuntime(handle, viewerOptions);
    // GS-NEXT-02 §五：Performance Mode 默认策略（首次默认 ON，显式偏好优先）。
    // 只在此处施加一次；绝不进入轮询/重建，用户手动切换不会被覆盖。
    runtime.applyPerformanceModeDefault();
    // GS-NEXT-05：官方 XrMenu 只在 XR 模式安装（Desktop 不需要、也不该多一层 UI）。
    // 失败**不抛** —— 菜单不可用时进入 VR 与桌面导航必须照常工作。
    if (runtime.mode === 'xr') runtime.initXRNavigation();
    return runtime;
  }

  /**
   * 施加 Performance Mode 默认策略（GS-NEXT-02 §五）。
   *
   * - 用户有显式偏好 → 官方 `readPreferences` 已在创建时采用，这里是 no-op。
   * - 无偏好 → 写入官方 `state.performanceMode = ON`，但用 `persist:false`
   *   保持 localStorage 里"无偏好"的事实（默认 ≠ 用户偏好）。
   *
   * 只在创建时调用一次：会话内用户手动 OFF 不会被重新强制打开。
   */
  private applyPerformanceModeDefault(): void {
    const preference = readPerformanceModePreference();
    const target = performanceModeTarget(this.requiredState().performanceMode, preference);
    if (target === null) return;
    this.setPerformanceMode(target, { persist: false });
  }

  /** 释放一切（engine / graphics context / 全部 listener / 容器子树）。幂等。 */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.cancelXRSpawn?.();
    // GS-NEXT-05：先拆舒适过渡（它持有 app 'update' 订阅 + 相机下的黑纱实体），
    // 再销毁官方菜单脚本（官方脚本自己摘 xr / xr.input 监听），最后摘字体资产。
    this.xrFade?.destroy();
    this.xrFade = null;
    this.xrMenu?.destroy();
    this.xrMenu = null;
    this.xrMenuFont?.destroy();
    this.xrMenuFont = null;
    this.xrNavigation = null;
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

  get showAnnotations(): boolean {
    return this.requiredState().showAnnotations;
  }

  get hasAnimation(): boolean {
    return this.requiredState().hasAnimation;
  }

  get hasAR(): boolean {
    return this.requiredState().hasAR;
  }

  get hasVR(): boolean {
    return this.requiredState().hasVR;
  }

  getPerformanceMode(): boolean {
    return this.requiredState().performanceMode;
  }

  setPerformanceMode(enabled: boolean, options: { persist?: boolean } = {}): void {
    const state = this.requiredState();
    let preference: string | null | undefined;
    if (options.persist === false) {
      try { preference = localStorage.getItem('performanceMode'); } catch { preference = undefined; }
    }
    try {
      state.performanceMode = enabled;
    } finally {
      if (preference !== undefined) {
        try {
          if (preference === null) localStorage.removeItem('performanceMode');
          else localStorage.setItem('performanceMode', preference);
        } catch { preference = undefined; }
      }
    }
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
  async startVR(): Promise<void> {
    const handle = this.requireLive();
    if (this.vrStarting || handle.app.xr?.active) return handle.startXR('vr');
    this.vrStarting = true;
    if (!handle.app.xr?.active) this.prepareXRSpawn();
    try {
      await handle.startXR('vr');
    } catch (error) {
      this.cancelXRSpawn?.();
      throw error;
    } finally {
      this.vrStarting = false;
    }
  }

  getXRState(): object {
    const xr = this.requireLive().app.xr;
    const camera = xr?.camera;
    const parent = camera?.parent;
    const vector = (value: { x: number; y: number; z: number } | undefined) =>
      value ? [value.x, value.y, value.z] : 'unavailable';
    return {
      active: xr?.active ?? false,
      referenceSpace: xr?.spaceType ?? 'unavailable',
      rigPosition: vector(parent?.getPosition()),
      rigEuler: vector(parent?.getEulerAngles()),
      headLocalPosition: vector(camera?.getLocalPosition()),
      headWorldPosition: vector(camera?.getPosition()),
      spawnStatus: this.xrSpawnStatus,
      // GS-NEXT-05：会话内导览菜单诊断（真机 / e2e 取证口）。
      xrMenu: this.xrMenuInfo(),
    };
  }

  getSingleFileGaussianCount(): number | null {
    const component = this.requireLive().app.root.findComponents('gsplat')[0] as
      { resource?: { numSplats?: number } } | undefined;
    const count = component?.resource?.numSplats;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  onPerformanceModeChanged(callback: (enabled: boolean) => void): () => void {
    return this.subscribe('performanceMode', callback);
  }

  onEngineEvent(event: 'frameupdate' | 'frameend', callback: (duration?: number) => void): () => void {
    return this.subscribeEngine(this.requireLive().app, event, callback);
  }

  private subscribeEngine(target: EventHandler, event: string, callback: Parameters<EventHandler['on']>[1]): () => void {
    target.on(event, callback);
    const unsubscribe = () => target.off(event, callback);
    this.unsubscribers.add(unsubscribe);
    return () => {
      this.unsubscribers.delete(unsubscribe);
      unsubscribe();
    };
  }

  private prepareXRSpawn(): void {
    this.cancelXRSpawn?.();
    const pose = this.xrInitialCamera;
    if (!pose) return;
    const xr = this.app.xr;
    if (!xr) {
      this.xrSpawnStatus = 'unavailable';
      return;
    }
    this.xrSpawnStatus = 'pending';
    const cleanup: (() => void)[] = [];
    const cancel = () => {
      cleanup.forEach(unsubscribe => unsubscribe());
      if (this.xrSpawnStatus === 'pending') this.xrSpawnStatus = 'unavailable';
      this.cancelXRSpawn = null;
    };
    this.cancelXRSpawn = cancel;
    cleanup.push(this.subscribeEngine(xr, 'end', cancel));
    cleanup.push(this.subscribeEngine(xr, 'update', () => {
      const camera = xr.camera;
      /*
       * GS-NEXT-02：对齐前必须满足全部前置条件，且**不满足时必须继续等待**
       * （注销只发生在真正施加之后 —— 否则首个未就绪帧就把一次性对齐机会丢掉，
       * 用户永久停在官方 Y=0 出生点）。注意 `finally` 只在"已施加/已失败"时
       * 注销：在 `try` 里 `return` 也会跑 `finally`，那会把这个坑重新引入。
       */
      if (xr.type !== 'immersive-vr' || !camera) return;
      const nodes = rigNodesFrom(camera);
      if (!nodes) return;
      // GS-NEXT-05：与「会话内导览传送」**共用同一套** Rig 定位数学
      // （scene-runtime/xrRigPose.ts）。返回 false = 位姿不可信（未追踪 / 非有限）
      // → 保持 pending 继续等。抛错同样结束等待，但记日志而不是让异常逃进
      // 引擎的 XR update 循环（那会让之后每一帧都重复抛）。
      let applied = false;
      let failed = false;
      try {
        applied = applyRigPose(nodes, pose);
      } catch (error) {
        failed = true;
        console.warn('[xr] Rig 出生对齐失败', error);
      }
      if (applied) this.xrSpawnStatus = 'applied';
      if (applied || failed) cancel();
    }));
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

  // ------------------------------------------------------------------ #
  // GS-UI-01：官方 chrome 宿主入口 —— 承接（而非复制）官方原生能力
  // ------------------------------------------------------------------ #

  /**
   * 底部控制条显隐（GS-UI-01：宿主工具条接管底部控制时收起官方控制条）。
   * 行内 style，不改官方 DOM 结构 / 事件 / 契约（.sse-* 的 CSS display:none
   * 规则数量仍只有 Walk 安全闸门一条）。
   */
  setOfficialControlsToolbarHidden(hidden: boolean): void {
    setOfficialControlsToolbarHidden(this.container, hidden);
  }

  /**
   * 官方标注热点层显隐（GS-UI-01 修复：创作页改用宿主标记点，避免与官方
   * hotspot 重复，也避免新增标注必须重建 Viewer 才能更新官方热点层）。
   *
   * 用行内 style `display:none`，不改官方 DOM 结构 —— 官方契约探测
   * （`validateUiCompatibility` 的 hotspotCount）与 e2e 的 DOM 计数仍成立，
   * 只是编辑器里不显示这一层。**仅创作页使用**；/scene 浏览页仍用官方热点。
   */
  setOfficialHotspotsHidden(hidden: boolean): void {
    setOfficialAnnotationHotspotsHidden(this.container, hidden);
  }

  /**
   * 官方键盘/指针输入开关（GS-UI-01 修复：在属性面板输入框里打字时不能触发
   * Viewer 快捷键 —— W/A/S/D、1/2/3、V/G/H/F/R/Space 等）。
   *
   * 官方 1.35 的快捷键全部由 `state.inputEnabled` 统一路由（ModeShortcuts
   * 直接读它；KeyboardMouseDevice 的键盘 meta patch 也用 `() => state.inputEnabled`）。
   * 写这个官方公开可写 state 即让键盘事件对 Viewer 无效；恢复后一切照旧。
   */
  setInputEnabled(enabled: boolean): void {
    try {
      this.requiredState().inputEnabled = enabled;
    } catch {
      // 已销毁：无操作。
    }
  }

  /**
   * 打开官方设置面板（Performance / Annotations / Gaming controls）。
   * 以程序方式点击官方按钮 —— 官方自己维护选中态与事件。
   */
  openOfficialSettingsPanel(): boolean {
    return clickOfficialControl(this.container, OFFICIAL_SETTINGS_BUTTON_CLASS);
  }

  /**
   * 打开 / 关闭官方操作说明浮层（快捷键帮助）。官方 toggle 语义：
   * 已展开时点击会收起，由官方按钮自己维护状态。
   */
  toggleOfficialHelpPanel(): boolean {
    return clickOfficialControl(this.container, OFFICIAL_INFO_BUTTON_CLASS);
  }

  /** 官方播放 / 暂停（仅带动画的场景；官方自己处理进入 anim 模式）。 */
  toggleOfficialAnimation(): boolean {
    return clickOfficialControl(this.container, OFFICIAL_PLAY_BUTTON_CLASS);
  }

  /**
   * 移动速度乘数（GS-UI-01 底部工具栏「调节速度」）。
   *
   * 官方 1.35.0 没有公开的速度设置 API（`InputController.moveSpeed` 是内部
   * 属性，`handle` 不暴露）。官方唯一公开的运行时速度通道是引擎
   * `app.timeScale`（官方 `app.on('update', dt)` 的 deltaTime 全部源自
   * `dt *= timeScale`，相机控制器输入同源缩放）。这里写引擎公开字段
   * `app.timeScale`，不触碰官方内部对象；undefined/非法值回 1（原速）。
   * 范围 0.25–3，超出 clamp。
   */
  setMoveSpeedMultiplier(multiplier: number): void {
    const clamped =
      Number.isFinite(multiplier) && multiplier > 0
        ? Math.min(Math.max(multiplier, 0.25), 3)
        : 1;
    if (this.app && typeof this.app.timeScale === 'number') {
      this.app.timeScale = clamped;
    }
  }

  getMoveSpeedMultiplier(): number {
    const value = this.app?.timeScale;
    return typeof value === 'number' && Number.isFinite(value) ? value : 1;
  }

  /** 选中第 index 个 annotation 并过渡到其相机（0-based）。需要 state.loaded。 */
  selectAnnotation(index: number): void {
    this.requireLive().selectAnnotation(index);
  }

  /** 清除 annotation 选中但不移动相机。需要 state.loaded。 */
  clearAnnotation(): void {
    this.requireLive().selectAnnotation(null);
  }

  /**
   * 按 **GSPlatform 数据库 ID** 选中标注（GS-NEXT-04），并过渡到其相机。
   *
   * 与 {@link selectAnnotation} 的区别：入参是稳定的数据库 ID 而不是官方数组
   * 下标（禁止把 index 当 ID —— 下标会随「停用某条标注」而整体错位）。
   * 找不到（含非 GSPlatform 标注）返回 false 且不做任何事。
   */
  selectGsplatformAnnotation(annotationId: string): boolean {
    const index = this.annotationIndexById(annotationId);
    if (index < 0) return false;
    this.requireLive().selectAnnotation(index);
    return true;
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
    // GS-NEXT-04：切到「观察点」时先清掉官方标注选中态 —— 二者共用同一个
    // 「当前停在哪里」的语义（官方 tooltip / 媒体 Overlay / 导览器序号都读它）。
    // 不清的话，相机已经到观察点了，导览器却还显示着上一个导览点的标题。
    // 官方 selectAnnotation 要求 loaded；未加载时保持旧行为（不做这次清理）。
    if (this.requiredState().loaded) this.requireLive().selectAnnotation(null);
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
   * 取某个已保存视角在 **RUNTIME** 空间的相机 pose（GS-NEXT-03）。
   *
   * 与 {@link selectViewpoint} 使用**完全同一套**换算（`worldTransform`
   * `sceneToRuntimeCamera` + `clampFov`）—— 使用者不该自己重算坐标变换。
   * 用于「进入 VR 前选择视点」：把该 pose 设为 XR 出生位姿后，用户看到自己在
   * 桌面模式被导航到哪个位置，进 VR 后就出生在那里。enabled=false / id 不存在
   * 时返回 null（与 selectViewpoint 的查找规则一致）。
   */
  viewpointRuntimePose(viewpointId: string): CameraPose | null {
    const vp = this.viewpoints.find((v) => v.id === viewpointId && v.enabled !== false);
    if (!vp) return null;
    const rt = this.worldTransform.sceneToRuntimeCamera({
      position: vp.position,
      target: vp.target,
      fov: vp.fov,
    });
    return {
      position: [rt.position.x, rt.position.y, rt.position.z],
      target: [rt.target.x, rt.target.y, rt.target.z],
      fov: rt.fov,
    };
  }

  /**
   * 某条 GSPlatform 标注在 **RUNTIME** 空间的相机 pose（GS-NEXT-04）。
   *
   * 直接读官方 `settings.annotations[i].camera.initial` —— 该值**已经**由
   * `experienceAdapter.buildAnnotations()` 从 `SceneAnnotation` 的自有相机经
   * `SceneTransformAdapter` 换算到 RUNTIME 空间（未作者化相机时官方回落场景
   * 初始相机）。因此这里**绝不做第二次换算**（两套数学必然漂移）。
   *
   * 与 {@link viewpointRuntimePose} 的区别：视角来自描述符 viewpoints（需要我们
   * 换算）；标注来自官方 settings（官方已经换算好了）。
   *
   * 未知 / 非 GSPlatform 标注（无 extras 协议）→ null。调用方应先用
   * `eligibleGuidePoints()` 过滤「自有相机齐全」的标注，避免把「回落到初始相机」
   * 的老热点当成真实导览目的地（VR-03 §8 要求 1）。
   */
  annotationRuntimePose(annotationId: string): CameraPose | null {
    const index = this.annotationIndexById(annotationId);
    if (index < 0) return null;
    const initial = this.annotations[index]?.camera?.initial;
    if (!initial) return null;
    const { position, target, fov } = initial;
    if (![...position, ...target].every(Number.isFinite) || !Number.isFinite(fov)) return null;
    return { position: [...position], target: [...target], fov };
  }

  /** GSPlatform 标注 ID → 官方 settings.annotations 下标；找不到返回 -1。 */
  private annotationIndexById(annotationId: string): number {
    return this.annotations.findIndex((ann) => {
      const extras = ann?.extras as { gsplatform?: { annotationId?: unknown } } | undefined;
      return extras?.gsplatform?.annotationId === annotationId;
    });
  }

  /**
   * 更换 XR 出生位姿（GS-NEXT-03，进入 VR 前选择视点；GS-NEXT-04 扩展到导览点）。
   *
   * 位姿为 **RUNTIME** 空间（与 authored initial camera 同空间）；传 null =
   * 「不在任何指定位置出生」，等价于没有 authored 相机（保持官方 Y=0 语义）。
   *
   * 必须在 `startXR` **之前**调用（`prepareXRSpawn` 在 `startVR()` 内读取该字段）。
   * 若此时已有尚未施加的对齐在等首个 tracked 帧，先取消它 —— 否则会在旧 pose
   * 上出生，随后再被新 pose 覆盖（竞态）。
   */
  setXRInitialCamera(pose: CameraPose | null): void {
    if (this.destroyed) return;
    // 已有 pending 对齐 → 取消（其 cancel 会把 status 打回 unavailable）。
    this.cancelXRSpawn?.();
    this.xrInitialCamera = pose;
    this.xrSpawnStatus = pose ? 'not-entered' : 'not-authored';
  }

  // ------------------------------------------------------------------ #
  // GS-NEXT-05：会话内导览（官方 XrMenu 目的地切换 + 官方 XrNavigation 仲裁）
  // ------------------------------------------------------------------ #

  /**
   * 安装官方 XrMenu 并接上仲裁（**只在 XR 模式、创建时调用一次**）。
   *
   * 幂等：重复调用不会重复订阅 / 重复建菜单。任何一步失败都只是把
   * {@link xrMenuInfo} 的 state 打成一个非 `installed` 值 —— 绝不抛错，
   * 因为"菜单不可用"不该让"进入 VR"和桌面导航一起挂掉。
   *
   * 订阅一律在此处注册一次（不在每次开关菜单时注册）：官方 XrMenu 是**唯一实例**，
   * 反复用 Y 键开关不会新增订阅 —— 这正是验收项「菜单重复开关不产生多重事件订阅」。
   */
  private initXRNavigation(): void {
    if (this.mode !== 'xr' || this.destroyed) return;
    const xr = this.immersiveXR();
    // 官方 AppBase 一定是 EventHandler；这里做一道防御：没有事件总线就没有菜单
    // 事件可用（不可用 ≠ 抛错，桌面导航与进入 VR 必须照常）。
    const hasBus =
      typeof (this.app as unknown as { on?: unknown }).on === 'function' &&
      typeof (this.app as unknown as { off?: unknown }).off === 'function';
    if (!xr || !hasBus) {
      this.xrMenuState = 'unavailable';
      return;
    }
    // 官方菜单点击 → 导览动作（官方 XrMenu 用 app.fire(eventName) 派发）。
    this.subscribeEngine(this.app, XR_MENU_EVENTS.prev, () => this.stepXrDestination(-1));
    this.subscribeEngine(this.app, XR_MENU_EVENTS.next, () => this.stepXrDestination(1));
    this.subscribeEngine(this.app, XR_MENU_EVENTS.home, () => this.gotoXrDestination(`initial:${INITIAL_DESTINATION_ID}`));
    this.subscribeEngine(this.app, XR_MENU_EVENTS.exit, () => void this.endXR().catch(() => undefined));
    // 官方菜单显隐 → 重新仲裁 floor teleport（官方注释明确给的协调事件）。
    this.subscribeEngine(this.app, XR_MENU_ACTIVE_EVENT, (visible: unknown) => {
      this.xrMenuVisible = visible === true;
      this.applyFloorTeleportPolicy();
    });
    // 会话结束：撤掉黑纱、清菜单可见态、把 floor teleport 重新仲裁回基线。
    this.subscribeEngine(xr as unknown as EventHandler, 'end', () => {
      this.xrFade?.reset();
      this.xrMenuVisible = false;
      this.applyFloorTeleportPolicy();
    });
    // XR 会话可用后再兜一次安装（相机 Rig 在某些时序下创建得比 createViewer 早/晚）。
    this.subscribeEngine(xr as unknown as EventHandler, 'available', () => this.installOfficialXrMenu());
    /*
     * 宿主兜底开关：官方 XrMenu 只轮询「首选手柄的 buttons[4]」，且要求
     * handedness 可识别 + grip 存在。PICO 真机上这三点都不保证成立，导致按 Y
     * 毫无反应。这里每帧补一层**只覆盖官方盲区**的轮询（见
     * `shouldHostHandleXrToggle`），官方能处理时一律留给官方，避免双重翻转。
     *
     * 挂在 app 的引擎帧循环而不是 xr：官方一次性的出生对齐订阅（`xr.on('update')`）
     * 在施加后会摘掉自己并断言 `xr` 无残留监听；这里不掺和那条生命周期。
     */
    this.subscribeEngine(this.app, 'update', (dt: unknown) =>
      this.pollXrMenuToggle(typeof dt === 'number' ? dt : 0)
    );
    this.installOfficialXrMenu();
  }

  /**
   * 创建官方 XrMenu（挂官方 XR Rig = `xr.camera.parent`）+ 舒适过渡黑纱。
   *
   * 见 `scene-runtime/xrMenu.ts` 头部：官方 Viewer 的 App 没注册 Element/Screen/
   * Button 组件系统、也没有任何 font 资产 —— 这两件事不补，官方菜单会"建出来但
   * 不渲染、不响应"且不报错。
   */
  private installOfficialXrMenu(): void {
    if (this.destroyed || this.xrMenu) return;
    const app = this.app as unknown as XrUiHostApp & { root: Entity };
    let rig: Entity | null = null;
    try {
      rig = (app.root.findByName('camera')?.parent as Entity | null) ?? null;
    } catch {
      rig = null;
    }
    if (!rig?.script) {
      // 官方 XrNavigation / XrControllers 就挂在这个实体上；没有它就没有官方导航可仲裁。
      this.xrMenuState = 'no-navigation';
      return;
    }
    const nav = readNavigationScript(rig);
    if (nav) {
      // 第一次观测到官方导航时记录原始开关，作为菜单关闭后的恢复基线
      // （重复安装时不要再采样，否则会把"菜单打开的暂停态"当成基线）。
      if (!this.xrNavigation) {
        this.xrNavBaseline = {
          enableMove: nav.enableMove !== false,
          enableSnapVertical: nav.enableSnapVertical !== false,
        };
      }
      this.xrNavigation = nav;
    }
    this.applyFloorTeleportPolicy();
    /*
     * 不管有没有可达目的地都安装菜单。
     *
     * 早期版本在 0 目的地时直接 return（state='empty'），本意是不给"全是死按钮"
     * 的菜单；真实后果是**手柄 Y 键完全没有反馈** —— 用户无法区分"菜单没装"和
     * "按键不对"，而绝大多数场景确实没有导览点/观察点。现在 0 目的地时菜单首行
     * 显示 {@link XR_MENU_EMPTY_LABEL}，并保留「退出 VR」，Y 键永远有可见反馈。
     */
    try {
      this.xrUiSystemsAdded = ensureXrUiSystems(app);
      this.xrMenuFont = createXrMenuFont(app);
      const items = buildXrMenuItems(this.xrDestinations(), XR_MENU_EMPTY_LABEL);
      // 相机先查好：传给菜单做"锚在相机前右侧"（不再贴手柄），也用于黑纱。
      const camera = app.root.findByName('camera') as Entity | null;
      this.xrMenu = installXrMenu({ app, rig, font: this.xrMenuFont, items, camera });
      const surface = camera ? createComfortVeil(camera, uiLayerId(app)) : null;
      this.xrFade = surface ? createComfortFade(this.app, surface) : null;
      this.xrMenuState = this.xrMenu ? 'installed' : 'install-failed';
      this.updateXrMenuLabel();
    } catch (err) {
      this.xrMenuState = 'install-failed';
      console.warn('[xr] XrMenu 安装失败（不影响进入 VR 与桌面导航）', err);
    }
  }

  /**
   * 宿主侧菜单开关兜底 —— **只处理官方盲区**。
   *
   * 官方 XrMenu 需要「首选输入源 + grip + `buttons[4]`」三者齐备才会轮询开关
   * （见 `xrMenu.ts` 的 `shouldHostHandleXrToggle`）。PICO 上 handedness 可能
   * 全为 `'none'`、键位可能不是 4、或用户按的是另一只手 —— 这些情况下官方
   * 什么也不做，表现就是"按 Y 没反应"。这里补的仍是**官方自己的**开关：
   * 写 `_activeInputSource` 让菜单吸附到当前手柄，再调官方 `_setMenuVisible`。
   *
   * 官方能处理时（首选手柄的按钮 4）一律跳过 → 不会双重翻转。
   */
  private pollXrMenuToggle(dt: number): void {
    const menu = this.xrMenu;
    const xr = (
      this.app as unknown as {
        xr?: { active?: boolean; input?: { inputSources?: unknown[] } };
      }
    ).xr;
    if (!menu || !xr?.active) return;
    const sources = (xr.input?.inputSources ?? []) as XrToggleInputSource[];
    const preferred = pickPreferredXrSource(sources);
    const script = menu.script;
    for (const source of sources) {
      let hostHandles = false;
      for (const index of XR_MENU_TOGGLE_BUTTONS) {
        if (shouldHostHandleXrToggle(source, index, preferred)) {
          hostHandles = true;
          break;
        }
      }
      const wasPressed = this.xrTogglePressed.get(source) ?? false;
      this.xrTogglePressed.set(source, hostHandles);
      if (!hostHandles || wasPressed) continue;
      if (script._menuVisible === true) {
        script._setMenuVisible(false);
      } else {
        script._activeInputSource = source;
        script._setMenuVisible(true);
      }
    }

    /*
     * 菜单可见时：摇杆左右直接切换导览点（不用瞄准菜单按钮）。
     * 官方导航的摇杆输入已在 `applyFloorTeleportPolicy` 里暂停，不会同时移动/转向。
     */
    if (!this.xrMenuVisible) return;
    for (const source of sources) {
      const axis = source.gamepad?.axes?.[2];
      if (typeof axis !== 'number' || !Number.isFinite(axis)) continue;
      const state = this.xrStickState.get(source) ?? 'neutral';
      if (axis >= XR_MENU_STICK_THRESHOLD && state !== 'right') {
        this.xrStickState.set(source, 'right');
        this.stepXrDestination(1);
      } else if (axis <= -XR_MENU_STICK_THRESHOLD && state !== 'left') {
        this.xrStickState.set(source, 'left');
        this.stepXrDestination(-1);
      } else if (Math.abs(axis) <= XR_MENU_STICK_RESET) {
        this.xrStickState.set(source, 'neutral');
      }
    }
    /*
     * 没有首选输入源（handedness 全 `none`）时官方不会跑 `_followAnchor`，
     * 菜单会停在世界空间、转头就飘出视野 → 宿主自己让它跟随相机。
     */
    if (!preferred) script._followCamera(dt);
  }

  /**
   * 会话内导览目的地（**已解析过 pose 的**）。
   *
   * 与进入 VR 前那个出生位置选择器同一份数据；额外过一道"pose 能否解析" ——
   * 停用 / 删除 / 无作者化相机（STALE 之类）的目的地在这里被挡掉，
   * 不会变成一个点了没反应的菜单项。
   */
  xrDestinations(): XrDestination[] {
    const list = buildXrDestinations({
      hasInitialCamera: this.authoredInitialCamera !== null,
      viewpoints: this.viewpoints,
      guidePoints: this.xrGuidePoints,
    });
    return list.filter((dest) => this.destinationPose(dest) !== null);
  }

  /** 指定"当前目的地"（key 来自 {@link xrDestinations}）。仅登记，不移动。 */
  setXRDestination(key: string | null): void {
    if (this.xrDestinationKey === key) {
      // 仍然刷新一次标签（菜单可能在之后才装上）。
      this.updateXrMenuLabel();
      return;
    }
    this.xrDestinationKey = key;
    this.updateXrMenuLabel();
    this.notifyXRDestination(key);
  }

  /**
   * 订阅目的地变化（页面据此同步「选中观察点 / 选中导览点」）。
   *
   * 必须在 create 的**同一个**订阅集合里注销，destroy 后不留 listener。
   */
  onXRDestinationChanged(callback: (key: string | null) => void): () => void {
    this.xrDestinationListeners.add(callback);
    const unsubscribe = () => {
      this.xrDestinationListeners.delete(callback);
    };
    this.unsubscribers.add(unsubscribe);
    return () => {
      this.unsubscribers.delete(unsubscribe);
      unsubscribe();
    };
  }

  private notifyXRDestination(key: string | null): void {
    // 拷贝一份再回调：回调里可能增删订阅者。
    // oxlint-disable-next-line unicorn/no-useless-spread -- 这里的拷贝是语义需要的（迭代期间集合可变）
    for (const listener of [...this.xrDestinationListeners]) {
      try {
        listener(key);
      } catch (err) {
        console.warn('[xr] 目的地变化回调异常', err);
      }
    }
  }

  /**
   * 环形切换目的地（菜单「上一个 / 下一个」）。返回是否真的发起了传送。
   *
   * 舒适过渡进行中时的请求会被**丢弃**（不排队）：一次 0.4 秒的过渡里用户不可能
   * 看清下一个位置，排队只会让传送滞后于按键。
   */
  stepXrDestination(step: 1 | -1): boolean {
    const list = this.xrDestinations();
    if (list.length < 2) return false;
    const current = destinationIndexByKey(list, this.xrDestinationKey ?? '');
    const next = stepDestinationIndex(list.length, current, step);
    return this.gotoXrDestination(list[next].key);
  }

  /**
   * 导航到某个目的地。返回是否成功。
   *
   * - **会话内**（immersive-vr 且 tracking 可信）：黑纱淡出 → 移动官方 XR Rig →
   *   淡入。移动的是 `xr.camera.parent`，头显自身 pose 不写（写了也留不住）。
   * - **未进入会话**：只登记出生位姿（与 GS-NEXT-03/04 的进入前选择语义一致）。
   *
   * 每次成功导航都会把出生位姿一并更新为该目的地 —— 退出再进入 VR 时回到离开的
   * 位置，与桌面选择器保持同一个真相源。
   */
  gotoXrDestination(key: string): boolean {
    const dest = this.xrDestinations().find((d) => d.key === key);
    if (!dest) return false;
    const pose = this.destinationPose(dest);
    if (!pose) return false;
    if (!this.isImmersiveVRActive()) {
      this.setXRDestination(key);
      this.setXRInitialCamera(pose);
      return true;
    }
    const move = () => this.applyRigPoseForPose(pose);
    const started = this.xrFade ? this.xrFade.run(move) : (move(), true);
    if (!started) return false;
    this.setXRDestination(key);
    this.setXRInitialCamera(pose);
    return true;
  }

  /** 诊断读数（e2e / 真机取证口）。 */
  xrMenuInfo(): XrMenuInfo {
    const list = this.xrDestinations();
    const index = destinationIndexByKey(list, this.xrDestinationKey ?? '');
    const dest = index >= 0 ? list[index] : list[0] ?? null;
    return {
      state: this.xrMenuState,
      menuInstalled: this.xrMenu !== null,
      destinationCount: list.length,
      destinationIndex: index,
      currentDestination: dest?.key ?? null,
      currentLabel: dest ? destinationLabel(dest, index, list.length) : '',
      floorTeleportEnabled: this.xrNavigation?.enableTeleport ?? false,
      menuVisible: this.xrMenuVisible,
      fadePending: this.xrFade?.pending ?? false,
      uiSystemsAdded: this.xrUiSystemsAdded,
    };
  }

  /** 目的地 → RUNTIME 空间 pose。**不新建换算**：全部复用既有方法。 */
  private destinationPose(dest: XrDestination): CameraPose | null {
    switch (dest.kind) {
      case 'initial':
        /*
         * 必须用**创建时**的 authored initial camera，不能用 `this.xrInitialCamera`
         * —— 后者每次传送都会被改写成"刚去过的那个目的地"，于是"返回初始位置"
         * 会变成"回到上一个目的地"（会话内第 2 跳就退化成原地打转）。
         * 这个坑由 `xr-menu-wiring.test.ts` 的环形用例锁住。
         */
        return this.authoredInitialCamera;
      case 'viewpoint':
        return this.viewpointRuntimePose(dest.id);
      case 'guide-point':
        return this.annotationRuntimePose(dest.id);
    }
  }

  /** 更新菜单首行（只读标签）：`序号/总数 · 名称`。 */
  private updateXrMenuLabel(): void {
    const list = this.xrDestinations();
    const index = destinationIndexByKey(list, this.xrDestinationKey ?? '');
    const dest = index >= 0 ? list[index] : list[0] ?? null;
    if (!dest || !this.xrMenu) return;
    this.xrMenu.setCurrentLabel(destinationLabel(dest, index, list.length));
  }

  /** 会话内传送：把 pose 落到官方 XR Rig（与出生对齐共用同一套数学）。 */
  private applyRigPoseForPose(pose: CameraPose): boolean {
    const xr = this.immersiveXR();
    const camera = xr?.camera;
    if (!camera) return false;
    const nodes = rigNodesFrom(camera);
    if (!nodes) return false;
    return applyRigPose(nodes, pose);
  }

  /**
   * 官方 XrNavigation 仲裁（GS-NEXT-05 §4 + 菜单打开时的输入接管）。
   *
   * 1. **floor teleport 恒关**：官方 `XrNavigation` 的 `handleSelectEnd` 只在
   *    `enableTeleport` 为真时传送（`xr-navigation.mjs` 源码注释："Otherwise a
   *    select/pinch gesture (e.g. used to click a UI element) would still snap the
   *    rig to the floor point under the ray"）—— 这就是菜单点击与地面传送的冲突点。
   *    未校准场景绝不允许出现 Y=0 地面传送（三条理由见 `XR_FLOOR_TELEPORT_ALLOWED`）。
   * 2. **菜单可见时暂停摇杆移动 / 转向 / 垂直 snap**：菜单打开后摇杆被宿主拿去
   *    切换导览点（左/右 = 上/下一个），不能让官方导航再拿同一根摇杆去移动/转
   *    向。关闭时精确恢复官方默认值（`readNavigationScript` 记录的基线）。
   *
   * 除上述两处外，6DoF 与官方其余能力原样保留。
   */
  private applyFloorTeleportPolicy(): void {
    const nav = this.xrNavigation;
    if (!nav) return;
    const pointerOnMenu = this.xrMenu?.isPointerOverMenu() ?? false;
    const allowed = XR_FLOOR_TELEPORT_ALLOWED && !this.xrMenuVisible && !pointerOnMenu;
    nav.enableTeleport = allowed;
    // 菜单可见 → 暂停官方摇杆输入（宿主用摇杆切换导览点）；隐藏 → 恢复基线。
    nav.enableMove = this.xrMenuVisible ? false : this.xrNavBaseline.enableMove;
    nav.enableSnapVertical = this.xrMenuVisible ? false : this.xrNavBaseline.enableSnapVertical;
  }

  /** 官方 XrManager 读取（窄类型，避免在方法签名里散播官方内部类型）。 */
  private immersiveXR(): {
    active: boolean;
    type: string;
    camera: Entity | null;
    on?: (event: string, fn: (...args: unknown[]) => void) => unknown;
  } | null {
    const xr = (this.app as unknown as { xr?: unknown }).xr;
    return (xr as ReturnType<SuperSplatRuntime['immersiveXR']>) ?? null;
  }

  private isImmersiveVRActive(): boolean {
    const xr = this.immersiveXR();
    return Boolean(xr?.active && xr.type === 'immersive-vr' && xr.camera);
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
   * FIX-05 §29-§30：官方 1.35.0 公开 API 无 GPU splat 表面拾取。这里**不再**取
   * 「包围盒中心深度」的固定平面（那样标注会浮在离表面很远的同一深度上，看起来
   * 不在点击位置）——改为把点击视线与**场景包围盒**做最近正交点求解：
   * 命中时取包围盒表面的入射点（即点击方向真正穿入高斯体积的位置），
   * 视线与包围盒无交点（点在空白处）时回退到包围盒中心深度。
   *
   * 仍然是「近似锚点」，不是逐 splat 的精确表面命中；但锚点会落在点击方向上的
   * 高斯体表附近，而不是一个与点击位置无关的平面。相机缺失/未就绪返回 null。
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
    // 单位视线方向
    const dir: [number, number, number] = [dx / len, dy / len, dz / len];

    // ① 优先：视线与场景包围盒的最近入射点（点击方向真正进入高斯体表的位置）。
    const box = this.gsplatAabb();
    if (box?.center && box.halfExtents) {
      const hit = rayAabbEntry(
        [position.x, position.y, position.z],
        dir,
        box.center,
        box.halfExtents,
      );
      if (hit) return { position: hit };
    }

    // ② 回退：视线未与包围盒相交（点在空白处）→ 包围盒中心深度。
    const scale = this.cameraFocusDistance(position);
    return {
      position: [
        position.x + dir[0] * scale,
        position.y + dir[1] * scale,
        position.z + dir[2] * scale,
      ],
    };
  }

  /**
   * 把 **RUNTIME 空间**点投影到 viewer 容器的 CSS 像素坐标（用于标注放置的
   * 世界轴 gizmo 叠加层）。与 {@link pickApproximateWorldPosition} 互逆：
   * 用同一相机 position / forward / right / up / fov / aspect 做解投影。
   *
   * 返回 `inFront=false` 表示点在相机背后（此时 x/y 无意义，调用方应隐藏）。
   * 相机缺失/未就绪返回 null。坐标单位 = 容器 CSS 像素（canvas 铺满容器）。
   */
  projectRuntimePointToScreen(
    point: [number, number, number],
  ): { x: number; y: number; inFront: boolean } | null {
    const camera = this.cameraEntity();
    if (!camera?.camera) return null;
    const pos = camera.getPosition();
    const f = camera.forward;
    const r = camera.right;
    const u = camera.up;
    const relX = point[0] - pos.x;
    const relY = point[1] - pos.y;
    const relZ = point[2] - pos.z;
    const depth = relX * f.x + relY * f.y + relZ * f.z;
    if (!(depth > 1e-6)) return { x: 0, y: 0, inFront: false };
    const tanY = Math.tan((clampFov(camera.camera.fov) * Math.PI) / 360);
    const tanX = tanY * this.canvasAspect();
    const ndcX = (relX * r.x + relY * r.y + relZ * r.z) / (depth * tanX);
    const ndcY = (relX * u.x + relY * u.y + relZ * u.z) / (depth * tanY);
    const css = this.canvasCssSize();
    if (!css) return { x: 0, y: 0, inFront: false };
    return {
      x: ((ndcX + 1) / 2) * css.width,
      y: ((1 - ndcY) / 2) * css.height,
      inFront: true,
    };
  }

  /** 画布 CSS 尺寸（容器像素；canvas 铺满 viewer 容器）。 */
  private canvasCssSize(): { width: number; height: number } | null {
    try {
      const canvas = this.requireLive().app?.graphicsDevice?.canvas as
        | { clientWidth?: number; clientHeight?: number }
        | undefined;
      if (!canvas) return null;
      const width = canvas.clientWidth ?? 0;
      const height = canvas.clientHeight ?? 0;
      if (!(width > 0 && height > 0)) return null;
      return { width, height };
    } catch {
      return null;
    }
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

/**
 * 官方 XrNavigation 脚本实例读取（GS-NEXT-05 仲裁对象）。
 *
 * 官方 Viewer 在相机父实体上 `script.create(XrNavigation)`，脚本名固定为
 * `xrNavigation`（源码 `static scriptName = 'xrNavigation'`）。
 */
function readNavigationScript(
  rig: Entity
): { enableTeleport: boolean; enableMove: boolean; enableSnapVertical: boolean } | null {
  const script = rig.script?.get?.('xrNavigation') as {
    enableTeleport?: unknown;
    enableMove?: unknown;
    enableSnapVertical?: unknown;
  } | null;
  if (!script || typeof script.enableTeleport !== 'boolean') return null;
  // **返回官方脚本本体（不是副本）**：仲裁要写回真实实例，副本改了没用。
  return script as { enableTeleport: boolean; enableMove: boolean; enableSnapVertical: boolean };
}

/** 菜单首行文本：`序号/总数 · 名称`（作者原文，不翻译）。 */
function destinationLabel(dest: XrDestination, index: number, total: number): string {
  // index 为 -1（尚未指定）= 显示第 1 项，不显示 0。
  const at = index >= 0 ? index + 1 : 1;
  const prefix = total > 1 ? `${at}/${total} · ` : '';
  return `${prefix}${dest.label}`;
}

function clampFov(fov: number): number {
  const value = Number.isFinite(fov) ? fov : DEFAULT_CAMERA_FOV;
  return Math.min(Math.max(value, CAMERA_FOV_RANGE.min), CAMERA_FOV_RANGE.max);
}

/**
 * 视线（origin + t·dir，dir 已归一化）与轴对齐包围盒的最近入射点。
 *
 * 用 slab 法：对每轴算 [tmin, tmax]，取三轴 tmin 的最大值 = 入射参数、
 * tmax 的最小值 = 出射参数。t1 ≤ t0 或 t0 < 0 且 t1 < 0（整段射线在盒前）→ 无交点。
 * 相机在盒内时 t0 < 0，取起点本身（t=0）作为入射点 —— 视线从盒内出发。
 * box 坐标任意空间；与调用方（RUNTIME 空间）一致即可。
 */
function rayAabbEntry(
  origin: [number, number, number],
  dir: [number, number, number],
  center: { x: number; y: number; z: number },
  halfExtents: { x: number; y: number; z: number },
): [number, number, number] | null {
  const min = [center.x - halfExtents.x, center.y - halfExtents.y, center.z - halfExtents.z];
  const max = [center.x + halfExtents.x, center.y + halfExtents.y, center.z + halfExtents.z];
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const o = origin[i];
    const d = dir[i];
    if (Math.abs(d) < 1e-9) {
      // 与该轴垂直：若原点不在该轴 slab 内，整条射线错过包围盒。
      if (o < min[i] || o > max[i]) return null;
    } else {
      const inv = 1 / d;
      let near = (min[i] - o) * inv;
      let far = (max[i] - o) * inv;
      if (near > far) {
        const tmp = near;
        near = far;
        far = tmp;
      }
      if (near > t0) t0 = near;
      if (far < t1) t1 = far;
      if (t0 > t1) return null;
    }
  }
  // t0 = 入射距离。`t0 <= 0` 表示相机在包围盒内（或盒子整体在相机身后）——
  // 此时“入射点”会落在相机脚下/身后，解投影 depth≈0，轴标记会被丢到屏幕
  // 左上角（用户实测：白点出现在左上角）。返回 null，交给调用方用“包围盒
  // 中心深度”回退，保证锚点永远落在相机前方。
  if (!(t0 > 1e-6)) return null;
  return [origin[0] + dir[0] * t0, origin[1] + dir[1] * t0, origin[2] + dir[2] * t0];
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
    // GS-DESKTOP-02：ui:true 表示**完整官方 UI**（工具条 / 设置 / 帮助 /
    // 全屏 / annotation hotspots + 导览器）。宿主不再隐藏或复制这些控件；
    // 唯一的内部 class 规则是集中在 superSplatUiCompatibility.ts 的 Walk 安全闸门。
    ui: options.ui ?? false,
    // Renderer Policy：
    //   desktop → undefined（官方默认 webgpu，引擎自动 fallback WebGL，即“auto”）
    //   xr      → 'webgl'（禁止 XR 默认走 WebGPU）
    renderer: rendererForMode(options.mode),
    // FIX-02 §5-§9 / §10：透传给运行时构造（scene↔runtime 换算 + 视角导航）。
    worldTransform: options.worldTransform ?? null,
    viewpoints: options.viewpoints ?? [],
    // GS-NEXT-05：会话内导览目的地（与进入 VR 前的出生位置选择器同一份数据）。
    guidePoints: options.guidePoints ?? [],
    xrInitialCamera: options.xrInitialCamera ?? null,
    // GS-UI-01 后续（VR 专用低 LOD）：显式 splat 预算，覆盖官方表。
    budget: options.budget,
  } as CreateViewerOptions;
}

// ------------------------------------------------------------------ #
// 官方 UI 内部 class 兼容（FIX-03 §11/§12；GS-DESKTOP-02）—— 全部集中在
// scene-runtime/superSplatUiCompatibility.ts（禁止散落）：
//   Pinned to @playcanvas/supersplat-viewer@1.35.0（内部 CSS 依赖）
// 官方 UI 完整保留（工具条 / 设置 / 帮助 / 全屏 / hotspots / 导览器）；
// 本层只叠加一条 Walk 安全闸门（尺度未校准 → 隐藏官方 Walk 入口）。
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
