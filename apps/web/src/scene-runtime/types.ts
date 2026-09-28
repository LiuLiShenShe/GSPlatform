/**
 * SceneRuntimeDescriptorV1 — GSPlatform 唯一运行时场景合同（SSV-01）。
 *
 * 与后端 `GET /api/v1/scenes/{scene_id}/runtime` 返回结构一致
 * （apps/api/app/schemas/scene_runtime.py）。Desktop / XR / Share 的所有
 * Runtime 页面只允许通过 getSceneRuntime() 拿这个描述，不得各自重新查询、
 * 拼接 Scene 数据。
 */

/** 3D 向量（x/y/z 浮点）。 */
export interface RuntimeVec3 {
  x: number;
  y: number;
  z: number;
}

/** 场景身份块（id = 业务 slug）。 */
export interface RuntimeScene {
  id: string;
  name: string;
  posterUrl: string | null;
}

/**
 * 可加载内容。
 * url 为 Viewer 可直接访问的同源资产 URL（/api/... 或 /local-scenes/...），
 * 绝不是服务器本地文件路径。format 依据实际资产文件名/元数据推导：
 * sog | ply | compressed-ply | meta | lod-meta。
 * 场景尚无已发布版本时为 null。
 */
export interface RuntimeContent {
  url: string | null;
  format: string | null;
}

/** 世界变换（不修改原始 SOG）。 */
export interface RuntimeWorldTransform {
  position: RuntimeVec3 | null;
  rotation: RuntimeVec3 | null;
  scale: RuntimeVec3 | null;
}

/** 初始相机。 */
export interface RuntimeInitialCamera {
  position: RuntimeVec3 | null;
  target: RuntimeVec3 | null;
  fov: number | null;
}

/** 背景：纯色或等距柱状全景资源。 */
export interface RuntimeBackground {
  type: string; // 'color' | 'equirectangular'
  color: RuntimeVec3 | null;
  url: string | null;
}

/** 展示设置块 —— 来自 ScenePresentation 模型。 */
export interface RuntimePresentation {
  worldTransform: RuntimeWorldTransform;
  initialCamera: RuntimeInitialCamera;
  background: RuntimeBackground;
}

/** 已保存相机视角。 */
export interface RuntimeViewpoint {
  id: string;
  name: string;
  position: RuntimeVec3;
  target: RuntimeVec3;
  fov: number;
  orderIndex: number;
  enabled: boolean;
}

/** 3D 热点标注，锚定在 Gaussian 表面。 */
export interface RuntimeAnnotation {
  id: string;
  title: string;
  description: string;
  anchor: RuntimeVec3;
  style: string; // LEADER_TEXT | NUMBER_POPUP | HIDDEN
  contentType: string; // TEXT | IMAGE | VIDEO | AUDIO | PANORAMA
  textContent: string;
  /** 媒体资产 URL；媒体服务机制接入（SSV-06）前为 null。 */
  mediaAssetUrl: string | null;
  textColor: string;
  textSize: number;
  fov: number;
  orderIndex: number;
  enabled: boolean;
}

/** 背景音频 + 播放设置。 */
export interface RuntimeBackgroundAudio {
  url: string | null;
  volume: number;
  loop: boolean;
  enabled: boolean;
}

/** 碰撞 runtime 块 —— 仅在存在已构建网格时填充。 */
export interface RuntimeCollision {
  url: string | null;
  format: string; // 'glb' | 'voxel'
  mode: string; // INDOOR | OUTDOOR
  gravity: number;
  slopeLimitDegrees: number;
  stepOffset: number;
  playerHeight: number;
  enabled: boolean;
}

/** 统一运行时场景合同（schemaVersion = 1）。 */
export interface SceneRuntimeDescriptorV1 {
  schemaVersion: number;
  scene: RuntimeScene;
  content: RuntimeContent;
  presentation: RuntimePresentation;
  viewpoints: RuntimeViewpoint[];
  annotations: RuntimeAnnotation[];
  backgroundAudio: RuntimeBackgroundAudio | null;
  collision: RuntimeCollision | null;
}

/** 内容格式联合类型（与后端 content_format_from_filename 对齐）。 */
export type RuntimeContentFormat = 'sog' | 'ply' | 'compressed-ply' | 'meta' | 'lod-meta';
