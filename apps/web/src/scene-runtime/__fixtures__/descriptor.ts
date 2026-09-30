/**
 * SceneRuntimeDescriptorV1 fixture（SSV-01）—— 与后端真实响应结构一致的类型级样例。
 *
 * 供 runtimeApi 解析测试与后续 Runtime 页面（SSV-02+）测试复用，
 * 避免每个测试重复拼 JSON。
 */
import type { SceneRuntimeDescriptorV1 } from '../types';

/** 完整场景样例（社区流式场景，含标注/视角/背景音频）。 */
export const runtimeDescriptorFixture: SceneRuntimeDescriptorV1 = {
  schemaVersion: 1,
  scene: {
    id: 'r-8c4e2264e86a',
    name: 'Phase07 E2E photos',
    posterUrl: '/local-scenes/r-8c4e2264e86a/poster.webp',
  },
  content: {
    url: '/local-scenes/r-8c4e2264e86a/versions/b2cc7bb1594d/lod-meta.json',
    format: 'lod-meta',
  },
  presentation: {
    worldTransform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    initialCamera: {
      position: { x: 0, y: 1.2, z: 3.5 },
      target: { x: 0, y: 0.8, z: 0 },
      fov: 55,
    },
    background: {
      type: 'color',
      color: { x: 0.02, y: 0.02, z: 0.02 },
      url: null,
    },
    // 官方 ExperienceSettings v2 渲染字段（SSV-05）
    tonemapping: 'aces',
    highPrecisionRendering: false,
    postEffects: {
      sharpness: { enabled: true, amount: 0.35 },
      bloom: { enabled: false, intensity: 0.02, blurLevel: 2 },
      grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] },
      vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
      fringing: { enabled: false, intensity: 0.5 },
    },
  },
  viewpoints: [
    {
      id: 'vp-1',
      name: '入口',
      position: { x: 0, y: 1.6, z: 3.5 },
      target: { x: 0, y: 1.0, z: 0 },
      fov: 55,
      orderIndex: 0,
      enabled: true,
    },
  ],
  annotations: [
    {
      id: 'ann-1',
      title: '水井',
      description: '古井',
      anchor: { x: -1.2, y: 0.3, z: 0.4 },
      style: 'LEADER_TEXT',
      contentType: 'TEXT',
      textContent: '清代古井',
      mediaAssetUrl: null,
      textColor: '#FFFFFF',
      textSize: 14,
      fov: 60,
      // FIX-02 §12：标注自身相机（拾取时保存的 Viewer pose）—— 与场景初始相机不同。
      cameraPosition: { x: -3.0, y: 1.9, z: 2.0 },
      cameraTarget: { x: -1.2, y: 0.4, z: 0.4 },
      cameraFov: 45,
      orderIndex: 0,
      enabled: true,
    },
  ],
  backgroundAudio: {
    url: '/api/v1/scenes/r-8c4e2264e86a/presentation/background-audio',
    volume: 0.5,
    loop: true,
    enabled: true,
  },
  collision: {
    url: '/api/v1/scenes/r-8c4e2264e86a/collision/mesh',
    format: 'glb',
    mode: 'OUTDOOR',
    gravity: 9.81,
    slopeLimitDegrees: 45,
    stepOffset: 0.3,
    playerHeight: 1.8,
    enabled: true,
    stale: false,
    worldTransformHash: null,
  },
};

/** 空白场景样例（无视角/标注/音频/碰撞 —— null / [] 语义）。 */
export const emptyRuntimeDescriptorFixture: SceneRuntimeDescriptorV1 = {
  schemaVersion: 1,
  scene: { id: 'scene-empty', name: '空白场景', posterUrl: null },
  content: { url: null, format: null },
  presentation: {
    worldTransform: { position: null, rotation: null, scale: null },
    initialCamera: { position: null, target: null, fov: null },
    background: { type: 'color', color: null, url: null },
    tonemapping: 'aces',
    highPrecisionRendering: false,
    postEffects: null,
  },
  viewpoints: [],
  annotations: [],
  backgroundAudio: null,
  collision: null,
};