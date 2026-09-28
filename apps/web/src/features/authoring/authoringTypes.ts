/**
 * Authoring 共享类型（SSV-05）。
 *
 * 相机 pose 复用官方 ExperienceSettings 的 CameraPose（{ position, target, fov }，
 * 无 legacy 的 mode 字段）—— 与 SuperSplatRuntime.getCameraPose() 的返回
 * 类型完全一致，编辑页不直接触碰 PlayCanvas app。
 */
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';

export type { CameraPose as AuthoringCameraPose };
