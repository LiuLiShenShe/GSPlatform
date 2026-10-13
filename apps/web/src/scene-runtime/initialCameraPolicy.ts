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

/**
 * GS-NEXT-02：创作页「已保存」是否**真的**被运行时采用。
 *
 * 保存接口只写 `scene_presentations`（创作页面板读的那张表），而 Desktop / XR
 * 真正渲染的是 `SceneRuntimeDescriptor`。两者在一种情况下会分叉：场景空间状态
 * 被标记为 STALE（几何变更发布）时，描述符会**有意地**丢弃 initialCamera，
 * 于是「面板显示已保存、每个场景打开却仍是官方 frameScene 鸟瞰」。
 *
 * 因此创作页不得只看自己的乐观 state 就宣称保存成功，必须比对运行时描述符。
 * 本函数只陈述事实，不猜测 STALE 的成因（描述符里没有该字段）。
 */
export type RuntimeInitialCameraUse =
  /** 从未保存 → 走官方 frameScene fallback（符合预期）。 */
  | { status: 'absent' }
  /** 已保存且运行时正在采用。 */
  | { status: 'authored' }
  /** 已保存，但当前运行时描述符没有它 → 打开场景仍会取景而非使用作者视角。 */
  | { status: 'ignored' };

/**
 * 比对「已保存的初始视角」与「运行时描述符」。
 *
 * @param savedPosition - `GET /presentation` 返回的 initialCameraPosition（null = 未保存）。
 * @param descriptor - 当前 `resolveSceneRuntimeDescriptor` 的结果（null = 尚未解析）。
 */
export function runtimeInitialCameraUse(
  savedPosition: { x: number; y: number; z: number } | null | undefined,
  descriptor: SceneRuntimeDescriptorV1 | null,
): RuntimeInitialCameraUse {
  if (!savedPosition) return { status: 'absent' };
  return hasAuthoredInitialCamera(descriptor) ? { status: 'authored' } : { status: 'ignored' };
}
