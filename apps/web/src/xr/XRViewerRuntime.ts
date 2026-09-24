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

/** 最小 settings 对象：默认相机视角 + 黑色背景，无后处理。 */
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
  cameras: [
    {
      initial: { position: [0, 1.2, 3.5], target: [0, 0.8, 0], fov: 55 },
    },
  ],
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

  return {
    app: handle.app,
    state: handle.state,
    events: handle.events,
    loadedPromise,
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