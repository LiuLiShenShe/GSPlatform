/**
 * Initial Camera 策略（FIX-02 §2-§3）—— Desktop / XR / Authoring 同一套规则。
 *
 * 规则（固定，禁止在调用点重写）：
 *   1. 场景有 **authored Initial Camera**（initialCamera.position 与 target 都存在）
 *      → Viewer loaded 后 **不自动 frameScene**，直接用 authored 相机。
 *      官方 1.35.0 语义：settings.cameras[0].initial 在加载时被 cameraManager
 *      `this.camera.copy(resetCamera)` 采用；官方**不会**在 load 时 frameScene。
 *      「回到初始视角」= runtime.resetCamera()（恢复 cameras[0].initial）。
 *   2. 场景**没有** authored Initial Camera（任一为 null）→ frameScene() 取景。
 *
 * §3 显式语义：判定只看 position/target 是否为 null，**绝不**用
 * `position != [0,0,0]` 之类的猜测（作者可能真的把相机放在原点）。
 */
import type { SceneRuntimeDescriptorV1 } from './types';

/** 描述里是否存在 authored 初始相机（position + target 都非 null）。 */
export function hasAuthoredInitialCamera(descriptor: SceneRuntimeDescriptorV1 | null): boolean {
  if (!descriptor) return false;
  const cam = descriptor.presentation.initialCamera;
  return Boolean(cam.position && cam.target);
}

/** authored 初始相机 → load 后需要 frameScene（= 没有 authored 相机）。 */
export function shouldFrameSceneOnLoad(descriptor: SceneRuntimeDescriptorV1 | null): boolean {
  return !hasAuthoredInitialCamera(descriptor);
}
