/**
 * Walk 平台安全闸门（GS-DESKTOP-04 §六）—— **唯一**权威判定。
 *
 * ## 问题
 *
 * 官方 `isWalkAllowed(bbox, collision)` 只判断「碰撞数据已加载 且 场景水平范围
 * ≥ 5 单位」。它**完全不知道** GSPlatform 的物理尺度校准语义：一个把厘米数据当
 * 米导出的场景，同样会有「足够大」的包围盒，于是官方认为可以走路，而用户的
 * 步幅/视高/重力与视觉彻底对不上。旧实现只做两件事：
 *
 *   1. 宿主在 scale.needsCalibration 时给容器加 `gs-walk-blocked` class，
 *      用 CSS `display:none` 隐藏官方 Walk 按钮；
 *   2. 宿主的 `toggleWalk()` 入口自己检查条件。
 *
 * 但**键盘 `3` / WASD / 官方按钮**都直接走官方内部 `state.walkAllowed`，
 * 宿主拦不住 —— 于是「按钮看不见了，键盘仍能进不安全的 Walk」。
 *
 * ## 本模块的判定（自下而上，逐条 fail-closed）
 *
 *   A. 描述符没有碰撞块 / `collision.enabled === false` → 不安全。
 *      后端 `_build_collision` 已经把 `collision_enabled AND physicalWalkAllowed
 *      AND physicalScaleVerified` 折进 `enabled`（见 apps/api/app/services/
 *      scene_runtime.py），所以 `enabled === false` 已包含「未校准」。
 *   B. 碰撞 STALE（世界变换/版本/空间绑定变更）→ 不安全（官方 runtime 无法
 *      对已构建碰撞可靠地重施加变换）。
 *   C. 碰撞资产 URL 缺失 → 没有可注入官方的碰撞资源 → 不安全。
 *   D. 官方 `state.hasCollision === false`（碰撞尚未 attach）→ 不安全。
 *      官方在 splat 加载完成后才 `attachCollision`，此时 `state.walkAllowed`
 *      才可能变 true。
 *   E. 平台尺度诊断 `needsCalibration`（包围盒不像米级）→ 不安全。
 *
 * 只有 A–E 全部通过，才允许**把碰撞资源交给官方 Viewer**。也就是说平台不再
 * 「隐藏按钮假装安全」，而是从根源上保证官方 `walkAllowed` 本身就是 false：
 * 没有碰撞数据注入 → 官方 `isWalkAllowed(bbox, null) === false` →
 * 键盘 `3` / WASD / 官方按钮 / 宿主 `toggleWalk()` 全部无效（官方
 * `case 'toggleWalk': if (walkAllowed)` 自己就是 no-op）。
 *
 * ## 禁止事项（本任务明确要求）
 *
 *   - 不隐藏按钮当修复（键盘路径绕得过）；
 *   - 不修改官方 Viewer 只读 state；
 *   - 不为测试降低安全规则。
 */
import type { SceneRuntimeDescriptorV1 } from './types';
import { assessSceneScale, type SceneScaleAssessment } from './sceneScale';

/** 平台判定「当前是否可以安全向官方 Viewer 注入可行走碰撞资源」。 */
export interface WalkSafetyInput {
  descriptor: SceneRuntimeDescriptorV1 | null;
  /** 官方 `state.hasCollision`（null = 尚未取得官方状态）。 */
  officialHasCollision?: boolean | null;
  /** 平台尺度诊断（null = 尚未取得包围盒）。 */
  sceneScale?: SceneScaleAssessment | null;
}

export type WalkSafetyReason =
  /** 场景没有碰撞块（从未构建）。 */
  | 'no-collision'
  /** 碰撞未启用：后端已把「未校准 / 非物理标定」折进 enabled。 */
  | 'collision-disabled'
  /** 碰撞 STALE：世界变换 / 版本 / 空间绑定在构建后改变。 */
  | 'collision-stale'
  /** 碰撞资产 URL 缺失 —— 没有可注入官方的资源。 */
  | 'collision-url-missing'
  /** 官方尚未 attach 碰撞数据（`state.hasCollision === false`）。 */
  | 'collision-not-attached'
  /** 平台尺度诊断认为包围盒不像米级尺度。 */
  | 'scene-scale-uncalibrated'
  /** 全部条件满足。 */
  | 'ok';

export interface WalkSafetyDecision {
  /** 是否允许把碰撞资源注入官方 Viewer（= 允许官方 walk）。 */
  safe: boolean;
  /** 判定原因（safe 为 false 时给出第一条失败条件，便于诊断/测试断言）。 */
  reason: WalkSafetyReason;
  /** 后端 `collision.enabled` 原值（诊断）。 */
  collisionEnabled: boolean;
  /** 后端 `collision.stale` 原值（诊断）。 */
  collisionStale: boolean;
}

/**
 * 判定当前是否可以向官方 Viewer 注入可行走碰撞资源。纯函数，便于单测。
 *
 * `officialHasCollision` / `sceneScale` 省略 = 该信息尚未取得（创建前）：
 * 此时只按描述符判定 —— 加载后用完整条件复核，不通过则受控重建撤销碰撞。
 */
export function decideWalkSafety(input: WalkSafetyInput): WalkSafetyDecision {
  const collision = input.descriptor?.collision ?? null;
  const decision: WalkSafetyDecision = {
    safe: false,
    reason: 'no-collision',
    collisionEnabled: collision?.enabled ?? false,
    collisionStale: collision?.stale ?? false,
  };
  if (!collision) return decision;
  if (!collision.enabled) {
    decision.reason = 'collision-disabled';
    return decision;
  }
  if (collision.stale) {
    decision.reason = 'collision-stale';
    return decision;
  }
  if (!collision.url) {
    decision.reason = 'collision-url-missing';
    return decision;
  }
  if (input.officialHasCollision === false) {
    decision.reason = 'collision-not-attached';
    return decision;
  }
  const scale = input.sceneScale ?? null;
  if (scale && scale.needsCalibration) {
    decision.reason = 'scene-scale-uncalibrated';
    return decision;
  }
  return { ...decision, safe: true, reason: 'ok' };
}

/**
 * 计算本次 Viewer 创建时应传给官方的 `collisionUrl`。
 *
 * 不安全 → `undefined`：**不向官方注入任何碰撞资源**，官方
 * `isWalkAllowed(bbox, null)` 因此为 false，键盘 / 官方按钮 / 宿主 API 全部
 * 无法进入 walk。这是平台侧唯一的 walk 安全闸门实现方式。
 */
export function resolveWalkCollisionUrl(input: WalkSafetyInput): string | undefined {
  const collision = input.descriptor?.collision ?? null;
  if (!collision?.url) return undefined;
  return decideWalkSafety(input).safe ? collision.url : undefined;
}

/**
 * 宿主安全闸门 class（`gs-walk-blocked`）是否应施加。
 *
 * 仅供 UI 提示用（向用户说明为什么不能走）。它**不再是**安全机制 —— 真正的
 * 闸门是上面「不注入碰撞资源」。保留 class 只是让尺度未校准时官方 Walk 按钮
 * 不再出现，避免用户点一个注定无效的按钮。
 */
export function shouldBlockWalkEntry(decision: WalkSafetyDecision): boolean {
  return !decision.safe;
}

/** 尺度未校准时的官方 walk 按钮提示（UI 文案）。 */
export const WALK_ENTRY_BLOCKED_REASON = 'scene-scale-needs-calibration';

/**
 * 便捷：由描述符 + 官方状态 + 尺度诊断一次得出「是否允许 walk」。
 *
 * 页面用它在 `setWalkGateBlocked` 与 `toggleWalk` 之间共用同一个判定，
 * 避免两处条件漂移（旧实现的漂移正是键盘能绕过按钮的原因之一）。
 */
export function walkAllowedByPlatform(input: WalkSafetyInput): boolean {
  return decideWalkSafety(input).safe;
}

/** 尺度评估的再导出（避免调用点同时 import 两个模块）。 */
export { assessSceneScale };
export type { SceneScaleAssessment };
