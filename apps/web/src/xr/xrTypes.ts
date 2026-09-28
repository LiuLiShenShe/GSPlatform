/**
 * WebXR 修复任务 — XR 类型定义。
 *
 * 本任务只负责一条独立的最小 WebXR 路径：
 *   GSPlatform Scene → 独立 XR Runtime → WebGL → WebXR → immersive-vr
 *
 * 第一阶段明确不做：Streamed SOG / LOD / annotation / collision / locomotion
 * / XR UI / skybox / audio。类型只覆盖最小链路需要的东西。
 */

/** XR 页面整体状态机（§11）。 */
export type XRState =
  | 'checking'
  | 'unsupported'
  | 'loading-viewer'
  | 'viewer-ready'
  | 'starting-xr'
  | 'xr-active'
  | 'xr-ended'
  | 'error';

/** 浏览器侧 WebXR 能力诊断结果（§7）。 */
export interface XRDiagnostics {
  secureContext: boolean;
  navigatorXR: boolean;
  userAgent: string;
  protocol: string;
  origin: string;
  topLevel: boolean;
  immersiveVrSupported: boolean;
  immersiveArSupported: boolean;
  // 注意：Viewer/Renderer/loaded 是渲染器运行时状态，在 runtime 创建前
  // 必然是 false/null，不属于浏览器能力诊断；由页面在 runtime 创建后
  // 直接读取并单独展示（runtimeRenderer / state.loaded / canStartVR /
  // renderedSplatCount）。
}

/**
 * 场景解析结果：XR 页面复用现有 Desktop Viewer 的同一套 manifest，
 * 不做第二套 Scene 数据模型（§10）。
 */
export interface XRSceneResolution {
  /** 场景 ID。 */
  sceneId: string;
  /** 场景标题（来自 manifest 或 fallback）。 */
  title: string;
  /** 直接可加载的 splat URL（manifest.assetUrl 或 streamed-sog 解析）。 */
  contentUrl: string;
  /** 内容文件名，supersplat-viewer 用它推断格式（.sog / .ply）。 */
  contentFilename?: string;
  /** 是否为 streamed-sog —— 第一阶段不支持，需明确提示。 */
  streamed: boolean;
}

/** 场景解析错误码。 */
export type XRSceneErrorCode =
  | 'SCENE_NOT_FOUND'
  | 'ASSET_FETCH_FAILED'
  | 'STREAMED_SOG_UNSUPPORTED';

/** 携带错误码的场景解析错误。 */
export class XRSceneError extends Error {
  readonly code: XRSceneErrorCode;

  constructor(code: XRSceneErrorCode, message: string) {
    super(message);
    this.name = 'XRSceneError';
    this.code = code;
  }
}
