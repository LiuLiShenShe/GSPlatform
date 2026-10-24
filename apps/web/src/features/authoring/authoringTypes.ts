/**
 * AuthoringCameraPose —— 创作页相机 pose 的可序列化形状。
 *
 * 与官方 `CameraPose`（tuple 数组）一致，但作者侧读写（SCENE 空间）统一用
 * 这个别名，避免每个面板各自定义结构。
 */
export interface AuthoringCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}
