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

/** 场景 gsplat 包围盒访问器（避免依赖 playcanvas 具体类型）。 */
interface GsplatAabbLike {
  center?: { x: number; y: number; z: number };
}

interface GsplatEntityLike {
  gsplat?: { instance?: { aabb?: GsplatAabbLike } };
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
export class SuperSplatRuntime {
  /** 引擎 app（只读，用于 renderer 类型 / frame.stats 诊断）。 */
  readonly app: RuntimeEngineApp;
  /** 官方 Observable state（只读视图；写入被官方忽略/覆盖）。 */
  readonly state: ViewerState;
  /** 官方 annotations（settings 顺序，只读）。 */
  readonly annotations: ViewerHandle['annotations'];

  /** 当前运行模式（renderer 策略）。 */
  readonly mode: RuntimeMode;

  private readonly handle: ViewerHandle;
  private readonly unsubscribers: Set<() => void> = new Set();
  private destroyed = false;

  private constructor(handle: ViewerHandle, viewerOptions: CreateViewerOptions) {
    this.handle = handle;
    this.mode = viewerOptions.renderer === 'webgl' ? 'xr' : 'desktop';
    this.app = handle.app;
    this.state = handle.state;
    this.annotations = handle.annotations;
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
    const forward = camera.getForward();
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
   * 直接把相机摆到给定 pose（position + lookAt target + fov）。
   *
   * 用于编辑页视角导航 / 恢复已保存视角。注意：官方 OrbitController 在下一次
   * 输入时会重新接管相机；本方法只负责一次性摆放，不承诺接管控制器。
   */
  setCameraPose(pose: CameraPose): void {
    const camera = this.cameraEntity();
    if (!camera?.camera) return;
    camera.setPosition(pose.position[0], pose.position[1], pose.position[2]);
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    camera.camera.fov = clampFov(pose.fov);
  }

  /**
   * 拾取 NDC 坐标（-1..1，x 向右、y 向上）对应的 3D 世界位置。
   *
   * 实现：从相机位置沿解投影后的视线方向取「场景包围盒中心深度」的点 ——
   * 作为标注锚点的合理近似（精确到 splat 表面的 GPU 拾取不在官方公开 API 内，
   * SSV-06 标注迁移时按需增强）。相机缺失/未就绪返回 null。
   */
  pickWorldPosition(x: number, y: number): { position: [number, number, number] } | null {
    const camera = this.cameraEntity();
    if (!camera?.camera) return null;
    const position = camera.getPosition();
    const forward = camera.getForward();
    const right = camera.getRight();
    const up = camera.getUp();
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
    getPosition(): { x: number; y: number; z: number };
    getForward(): { x: number; y: number; z: number };
    getRight(): { x: number; y: number; z: number };
    getUp(): { x: number; y: number; z: number };
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
            getPosition(): { x: number; y: number; z: number };
            getForward(): { x: number; y: number; z: number };
            getRight(): { x: number; y: number; z: number };
            getUp(): { x: number; y: number; z: number };
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

  /** 相机到场景 gsplat 包围盒中心的距离（焦点深度）；缺失时回退固定距离。 */
  private cameraFocusDistance(from: { x: number; y: number; z: number }): number {
    try {
      const root = this.requireLive().app?.root as
        | { findByName(name: string): unknown | null }
        | undefined;
      const splat = root?.findByName('gsplat') as GsplatEntityLike | null | undefined;
      const center = splat?.gsplat?.instance?.aabb?.center;
      if (center && Number.isFinite(center.x + center.y + center.z)) {
        const dx = center.x - from.x;
        const dy = center.y - from.y;
        const dz = center.z - from.z;
        const dist = Math.hypot(dx, dy, dz);
        if (Number.isFinite(dist) && dist > 0) return dist;
      }
    } catch {
      // 未加载 / 已销毁 —— 走回退距离。
    }
    return CAMERA_POSE_FALLBACK_DISTANCE;
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
  } as CreateViewerOptions;
}

/**
 * 官方 UI 作用域（SSV-06）：
 *
 * 官方 annotation hotspots / tooltip（Annotations 类）只在官方 UI 层
 * （initUI）内构建，因此开启 ui:true；同时给容器打上作用域 class 并注入一次性
 * CSS，隐藏官方冗余 chrome（.sse-ui：控件栏 / 海报 / 加载条 / annotation 导航 /
 * 设置面板 / 帮助），只保留 .sse-sceneLayer（标注热点 + tooltip）与 canvas。
 * 这样宿主自绘控件，而官方标注层独立工作，且不 fork viewer。
 */
const UI_SCOPE_CLASS = 'gs-supersplat-host';
let uiScopeStyle: HTMLStyleElement | null = null;

function applyUiScopeStyles(container: HTMLElement): void {
  container.classList.add(UI_SCOPE_CLASS);
  if (uiScopeStyle) return;
  uiScopeStyle = document.createElement('style');
  uiScopeStyle.id = 'gs-supersplat-ui-scope';
  uiScopeStyle.textContent = [
    `.${UI_SCOPE_CLASS} .sse-ui { display: none !important; }`,
    `.${UI_SCOPE_CLASS} .sse-sceneLayer { display: block !important; }`,
  ].join('\n');
  document.head.appendChild(uiScopeStyle);
}

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