/**
 * XR 类型定义（SSV-04 精简）。
 *
 * 旧的独立 XR Runtime（XRViewerRuntime / sceneResolver）已删除，/xr/* 统一走
 * SuperSplatRuntime。本文件只保留浏览器 WebXR **能力诊断**类型（仅展示用；
 * 运行态真相是官方 state：canStartVR / canStartAR / xrMode）。不再维护第二套
 * Scene 数据模型——场景描述由 scene-runtime 合同（SceneRuntimeDescriptorV1）
 * 提供，与 Desktop 完全一致。
 */

/** 浏览器侧 WebXR 能力诊断结果（§7）——非运行态真相。 */
export interface XRDiagnostics {
  secureContext: boolean;
  navigatorXR: boolean;
  userAgent: string;
  protocol: string;
  origin: string;
  topLevel: boolean;
  immersiveVrSupported: boolean;
  immersiveArSupported: boolean;
  // 注意：Renderer / loaded / canStartVR 等是渲染器运行时状态，由官方 state 提供，
  // 不属于浏览器能力诊断，也不在这里收集（runtime 创建前恒为 false）。
}
