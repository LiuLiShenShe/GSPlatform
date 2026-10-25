/**
 * Initial Camera 同步策略（GS-DESKTOP-04 §三）—— 同会话保存初始视角后，
 * 让**官方 Viewer 自己的 Reset** 也采用新视角。
 *
 * ## 为什么保存后官方 Reset 仍回旧视角（报告 §9 问题 1）
 *
 * 官方 `CameraManager` 构造时把 `settings.cameras[0].initial` 固化成一个
 * **闭包常量**：
 *
 *     const resetCamera = camera0
 *         ? createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov)
 *         : frameCamera;
 *
 * 之后 `inputEvent 'reset'`（官方 Reset 按钮、键盘 `r`、宿主 `resetCamera()`）
 * 一律走 `controllers.orbit.goto(resetCamera)` —— 用的就是**构造那一刻**的
 * pose。官方 1.35.0 没有 `updateSettings()` / `setInitialCamera()` 之类公开接口
 * （公开 handle 见 docs/api.md：只有 frameScene / resetCamera / toggleWalk /
 * selectAnnotation / setMoveInput / seek / XR / fullscreen / destroy），
 * `settings` 与 `CameraManager` 都在公开句柄之外。
 *
 * 因此「保存成功后同会话更新官方 Reset 目标」在官方公开 API 内**没有轻量实现**：
 * 只能重建 Viewer，让新的 `settings.cameras[0].initial` 重新被 CameraManager
 * 采用。本模块把这个重建约束写成可单测的纯规则。
 *
 * ## 重建纪律（任务 §三 的硬约束）
 *
 *   - 一次成功保存最多触发一次重建（`syncedKey` 去重）；
 *   - 只在**后端描述符确认采用新视角**之后重建（`savedViewMatchesDescriptor`）；
 *   - 保存失败绝不重建（调用点不评估，旧视角保持为 Reset 目标）；
 *   - 不重置 React 页面：只换 Viewer 子树；
 *   - 不改变 SceneVersion / 标注 / 观察点 / 媒体资产（全部来自同一个描述符）；
 *   - 不会因为 `settingsRevision` 等其他 state 更新进入循环（只有初始相机
 *     key 变化才可能返回 resync-needed）。
 */
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import type { SceneRuntimeDescriptorV1 } from './types';

/** 描述符初始相机的稳定 key（用于「这次保存是否需要重建」去重）。 */
export function initialCameraKey(descriptor: SceneRuntimeDescriptorV1 | null): string {
  const cam = descriptor?.presentation.initialCamera;
  if (!cam?.position || !cam?.target) return 'absent';
  const p = cam.position;
  const t = cam.target;
  const fov = typeof cam.fov === 'number' && Number.isFinite(cam.fov) ? cam.fov : 'na';
  return `${p.x},${p.y},${p.z}|${t.x},${t.y},${t.z}|${fov}`;
}

/** 已保存视角（SCENE 空间）是否等于描述符里的初始相机。 */
export function savedViewMatchesDescriptor(
  saved: CameraPose,
  descriptor: SceneRuntimeDescriptorV1 | null,
  tolerance = 1e-4,
): boolean {
  const cam = descriptor?.presentation.initialCamera;
  if (!cam?.position || !cam?.target) return false;
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  return (
    near(saved.position[0], cam.position.x) &&
    near(saved.position[1], cam.position.y) &&
    near(saved.position[2], cam.position.z) &&
    near(saved.target[0], cam.target.x) &&
    near(saved.target[1], cam.target.y) &&
    near(saved.target[2], cam.target.z)
  );
}

export type InitialCameraSyncVerdict =
  /** 后端已采用该视角、而当前 Viewer 仍停在旧目标 → 需要一次受控重建。 */
  | 'resync-needed'
  /** 当前 Viewer 已经以该视角为 Reset 目标（无需重建）。 */
  | 'already-synced'
  /** 后端没有采用这个视角（保存失败 / 空间绑定失效）→ 绝不重建。 */
  | 'ignored';

/**
 * 页面侧的同步状态（给用户明确反馈，不静默跳相机）。
 *   idle     — 无同步动作
 *   syncing  — 正在受控重建 Viewer 以采用新保存视角
 *   synced   — 新视角已被官方 Reset 采用
 *   failed   — 重建失败（保留重试入口）
 */
export type CameraSyncStatus = 'idle' | 'syncing' | 'synced' | 'failed';

/**
 * 初始相机同步状态机（纯逻辑；页面负责驱动重建）。
 *
 * `syncedKey` = **当前活着的 Viewer 构造时采用的** `settings.cameras[0].initial`。
 * 调用点在每次 Viewer `loaded` 后回填（{@link InitialCameraSync.adopt}），
 * 在每次保存成功后评估（{@link InitialCameraSync.evaluate}）。
 */
export interface InitialCameraSync {
  evaluate(saved: CameraPose, descriptor: SceneRuntimeDescriptorV1 | null): InitialCameraSyncVerdict;
  /** 新 Viewer 已 loaded：把它的初始相机记为已同步目标。 */
  adopt(descriptor: SceneRuntimeDescriptorV1 | null): void;
  /** 保存失败：不改变已同步目标（旧视角仍是官方 Reset 目标）。 */
  markSaveFailed(): void;
  /** 当前 Viewer 的 Reset 目标 key。 */
  syncedKey(): string | null;
}

export function createInitialCameraSync(): InitialCameraSync {
  let synced: string | null = null;
  return {
    evaluate(saved, descriptor) {
      if (!savedViewMatchesDescriptor(saved, descriptor)) return 'ignored';
      const key = initialCameraKey(descriptor);
      if (synced === key) return 'already-synced';
      return 'resync-needed';
    },
    adopt(descriptor) {
      synced = initialCameraKey(descriptor);
    },
    markSaveFailed() {
      // 保存失败不推进任何状态：官方 Reset 仍旧目标（需求 §四）。
    },
    syncedKey() {
      return synced;
    },
  };
}
