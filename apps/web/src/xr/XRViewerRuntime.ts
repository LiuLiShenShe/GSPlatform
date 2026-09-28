/**
 * WebXR 修复任务 — 独立 XR Runtime 封装（§5/§6/§9）。
 *
 * 使用官方 @playcanvas/supersplat-viewer 的 createViewer，强制 WebGL
 * 渲染器（WebXR 必须 WebGL；WebGPU 下 supersplat-viewer 明确不支持
 * AR/VR）。XR 启动只接受直接用户点击 → startXR 的单次调用链：
 *
 *   button click → viewer.startXR('vr')
 *
 * 不经过 iframe / postMessage / setTimeout 中间跳。
 */
import { createViewer, type ViewerHandle } from '@playcanvas/supersplat-viewer/viewer';

/** XR 会话模式（与 supersplat-viewer 的 state.xrMode 对齐）。 */
export type XRMode = 'ar' | 'vr' | null;

/** XR Runtime 对外暴露的最小面。 */
export interface XRViewerRuntime {
  /** 引擎 app（用于读取 renderer 类型）。 */
  readonly app: ViewerHandle['app'];
  /** 只读 Observable state（loaded / canStartVR / xrMode 等）。 */
  readonly state: ViewerHandle['state'];
  /** 订阅 state 变化。 */
  readonly events: ViewerHandle['events'];
  /** 场景首帧渲染完成前 resolve 的 promise（可用 loaded 状态替代）。 */
  loadedPromise: Promise<void>;
  /**
   * 订阅真实 XR 会话状态变化。回调收到 'vr' | 'ar' | null。
   *
   * 内部绑定 supersplat-viewer 的 `xrMode:changed` 事件 —— 该事件由
   * PlayCanvas XrManager 的 'start' / 'end' 驱动，因此用户从头显系统菜单
   * 或浏览器 UI 退出 XR 时同样会触发（state.xrMode → null），不依赖
   * startXR/endXR 的 promise。返回 unsubscribe 函数。
   */
  onXRModeChanged(callback: (mode: XRMode) => void): () => void;
  /**
   * 将相机取景到整个场景（官方 handle.frameScene()）：
   * 以场景 bbox 为中心自动计算相机（沿 (2,1,2) 方向、距离由
   * bbox.halfExtents 与 fov 得出），切换到 orbit 模式并启动过渡。
   * 必须在 state.loaded 之后调用。用于修正 DEFAULT_SETTINGS 不提供
   * 固定相机时（cameras: []）初始相机的兜底，以及用户手动重新取景。
   */
  frameScene: () => void;
  /** 用户手势内调用：请求 immersive-vr 会话。 */
  startVR: () => Promise<void>;
  /** 结束当前 XR 会话。 */
  endXR: () => Promise<void>;
  /** 释放所有资源。 */
  destroy: () => void;
}

export interface CreateXRRuntimeOptions {
  /** 挂载容器元素。 */
  container: HTMLElement;
  /** splat URL（scene.sog / scene.ply）。 */
  contentUrl: string;
  /** 内容文件名，用于推断格式。 */
  contentFilename?: string;
  /** 可选：覆盖默认 settings（避免每次请求 404 settings.json）。 */
  settings?: object;
}

/**
 * 最小 settings 对象：黑色背景，无后处理。
 *
 * 重要：cameras 为空数组（不提供固定 initial camera）。官方 supersplat-viewer
 * 在 `settings.cameras[0]` 缺失时回退到 `createFrameCamera(bbox, fov)` —— 自动
 * 以场景 bounding box 计算相机（viewer.js CameraManager 构造：`resetCamera =
 * camera0 ? 固定相机 : frameCamera`）。固定的 initial camera 会把所有场景都
 * 放到同一个视角，bbox 不在该位置附近时直接黑屏。因此让官方按 bbox 自动取景，
 * 并在 loaded 后调用 frameScene() 由官方把相机对准整个场景。
 */
const DEFAULT_SETTINGS: object = {
  version: 2,
  tonemapping: 'none',
  highPrecisionRendering: false,
  background: { color: [0, 0, 0] },
  postEffectSettings: {
    sharpness: { enabled: false, amount: 0 },
    bloom: { enabled: false, intensity: 1, blurLevel: 2 },
    grading: { enabled: false, brightness: 0, contrast: 1, saturation: 1, tint: [1, 1, 1] },
    vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
    fringing: { enabled: false, intensity: 0.5 },
  },
  animTracks: [],
  // 不提供固定相机 → supersplat-viewer 按场景 bbox 自动取景（见上方说明）。
  cameras: [],
  annotations: [],
  startMode: 'default',
};

/**
 * 创建独立 XR Viewer runtime。
 * 强制 renderer:'webgl'；ui:false（自定义入口按钮，诊断面板不属于 viewer）。
 */
export async function createXRRuntime(
  options: CreateXRRuntimeOptions,
): Promise<XRViewerRuntime> {
  let handle: ViewerHandle;

  try {
    handle = await createViewer({
      container: options.container,
      contentUrl: options.contentUrl,
      contentFilename: options.contentFilename,
      renderer: 'webgl', // 第一阶段强制 WebGL（§6）
      ui: false,
      settings: options.settings ?? DEFAULT_SETTINGS,
    });
  } catch (err) {
    console.error('[xr] createViewer failed', err);
    throw err instanceof Error ? err : new Error(String(err));
  }

  const loadedPromise = new Promise<void>((resolve) => {
    if (handle.state.loaded) {
      resolve();
      return;
    }
    const evt = handle.events.on('loaded:changed', (value: boolean) => {
      if (value) {
        evt.off();
        resolve();
      }
    });
  });

  /**
   * 订阅真实 XR 会话状态。绑定 supersplat-viewer 的 `xrMode:changed` 事件：
   * xr start → 'vr'/'ar'，xr end（含系统菜单退出）→ null。
   * 返回 unsubscribe。
   */
  const onXRModeChanged = (callback: (mode: XRMode) => void): (() => void) => {
    const evt = handle.events.on('xrMode:changed', (mode: string | null) => {
      callback(mode === 'vr' || mode === 'ar' ? mode : null);
    });
    return () => evt.off();
  };

  return {
    app: handle.app,
    state: handle.state,
    events: handle.events,
    loadedPromise,
    onXRModeChanged,
    frameScene: () => handle.frameScene(),
    startVR: () => handle.startXR('vr'),
    endXR: () => handle.endXR(),
    destroy: () => handle.destroy(),
  };
}

/** 从 handle.app 读取实际渲染器类型（webgl / webgpu）。 */
export function runtimeRenderer(app: XRViewerRuntime['app']): string {
  const deviceType = app?.graphicsDevice?.deviceType;
  return deviceType ?? 'unknown';
}

/**
 * 当前已渲染的 Gaussian 数量（PlayCanvas `app.stats.frame.gsplats`）。
 * 引擎每帧更新：首帧渲染完成前为 0。用于区分「场景已加载但 camera/frustum
 * 不对（gsplats 停在 0 或很小）」与「场景内容为空」。
 */
export function renderedSplatCount(app: XRViewerRuntime['app']): number {
  const gsplats = app?.stats?.frame?.gsplats;
  return typeof gsplats === 'number' && Number.isFinite(gsplats) ? gsplats : 0;
}