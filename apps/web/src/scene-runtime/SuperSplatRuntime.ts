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
import { SuperSplatRuntimeError } from './runtimeErrors';

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
    // headless：UI 由宿主绘制（诊断面板 / 控件）
    ui: false,
    // Renderer Policy：
    //   desktop → undefined（官方默认 webgpu，引擎自动 fallback WebGL，即“auto”）
    //   xr      → 'webgl'（禁止 XR 默认走 WebGPU）
    renderer: rendererForMode(options.mode),
  } as CreateViewerOptions;
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