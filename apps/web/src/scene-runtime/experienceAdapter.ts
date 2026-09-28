/**
 * Experience Adapter V1（SSV-02）—— 把 SceneRuntimeDescriptorV1 映射为官方
 * ExperienceSettings v2。
 *
 * 使用官方 `@playcanvas/supersplat-viewer/settings` 的 defaultSettings() 与
 * validateSettings()（基于锁定版本 1.35.0 的类型），不手写 schema、不 fork。
 *
 * 本阶段最低映射：
 *   - background color（存在时）
 *   - initial camera（存在时；fov 被 clamp 到官方 authoring 界内）
 *   其余（sound / annotation / anim）暂不映射，保持官方默认。
 *   collision 独立传递（ViewerAssets.collisionUrl），不属于 settings。
 */
import {
  CAMERA_FOV_RANGE,
  DEFAULT_CAMERA_FOV,
  defaultSettings,
  validateSettings,
  type ExperienceSettings,
} from '@playcanvas/supersplat-viewer/settings';
import type { SceneRuntimeDescriptorV1 } from './types';

/** 把描述里的 Vec3 归一化 0..1 RGB 映射为官方 [r, g, b] 元组。 */
function toRgbTuple(color: { x: number; y: number; z: number } | null): [number, number, number] | null {
  if (!color) return null;
  return [color.x, color.y, color.z];
}

/**
 * 生成合法 ExperienceSettings v2。
 *
 * @param descriptor - SSV-01 运行时场景合同。
 * @param fit - 无初始相机时官方 default 相机的摆放方式（默认 environment）。
 * @throws 若产物无法通过官方 validateSettings(settings, { limits: true })。
 */
export function buildExperienceSettings(
  descriptor: SceneRuntimeDescriptorV1,
  fit: 'environment' | 'object' = 'environment',
): ExperienceSettings {
  const settings = defaultSettings(fit);

  // 1) background color —— 存在时覆盖官方默认。
  const bgColor = toRgbTuple(descriptor.presentation.background.color);
  if (bgColor) {
    settings.background.color = bgColor;
  }

  // 2) initial camera —— 描述里同时有 position + target 才映射；
  //    fov 存在则 clamp 进官方 authoring 界（limits: true 校验要求）。
  const cam = descriptor.presentation.initialCamera;
  if (cam.position && cam.target) {
    const fov = cam.fov ?? DEFAULT_CAMERA_FOV;
    const clampedFov = Math.min(Math.max(fov, CAMERA_FOV_RANGE.min), CAMERA_FOV_RANGE.max);
    settings.cameras = [
      {
        initial: {
          position: [cam.position.x, cam.position.y, cam.position.z],
          target: [cam.target.x, cam.target.y, cam.target.z],
          fov: clampedFov,
        },
      },
    ];
  }

  // 3) sound / annotations / anim —— 本阶段不映射（保持官方默认）。

  // 官方校验：作者侧限值全开，任何字段越界立即抛错。
  validateSettings(settings, { limits: true });
  return settings;
}
