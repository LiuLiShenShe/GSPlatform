/**
 * 场景尺度诊断（SSV-07 §4）—— 1 Scene Unit = 1 meter。
 *
 * 官方 walk / fly 的物理（capsule、重力、坡度、台阶）全部以「场景单位即米」
 * 为前提。若场景包围盒的水平范围明显不是米级尺度（例如摄影数据集导出成厘米、
 * 或者整场景被缩放成亚米模型），走路的步幅/视高会与视觉完全对不上 ——
 * 这属于**尺度校准问题**，不能默默用错误尺度走路。
 *
 * 本模块只做**分类诊断**（纯函数，便于单测）；是否允许进入 walk 由页面在
 * `needsCalibration` 为真时禁用 Walk 入口，而不是改写官方相机行为。
 */

/** 场景世界包围盒（与官方 gsplat aabb 一致的 xyz 三元组）。 */
export interface SceneBounds {
  min: [number, number, number];
  max: [number, number, number];
  /** 逐轴边长（max - min）。 */
  size: [number, number, number];
}

export type SceneScaleStatus = 'ok' | 'too-small' | 'too-large';

export interface SceneScaleAssessment {
  /** 最大水平边长（X 与 Z 取大者）—— 官方 walk 门槛用的量级。 */
  horizontalExtent: number;
  /** 垂直边长。 */
  verticalExtent: number;
  status: SceneScaleStatus;
  /** 明显偏离米级尺度 —— UI 必须提示「场景尺度需要校准」。 */
  needsCalibration: boolean;
}

/** 低于此水平范围（米）视为「不像按米建模」—— 走路尺度不可信。 */
export const SCENE_SCALE_MIN_METERS = 1;
/** 高于此水平范围（米）视为尺度异常放大（同上）。 */
export const SCENE_SCALE_MAX_METERS = 1000;

/** 尺度告警文案（UI 直接展示，英文短语与规格一致）。 */
export const SCENE_SCALE_WARNING = 'Scene scale needs calibration';

/**
 * 分类场景尺度。包围盒缺失（非有限值）时按 needsCalibration 处理，不静默放行。
 */
export function assessSceneScale(bounds: SceneBounds | null): SceneScaleAssessment {
  const horizontalExtent = bounds ? Math.max(bounds.size[0], bounds.size[2]) : 0;
  const verticalExtent = bounds ? bounds.size[1] : 0;
  const valid =
    bounds !== null &&
    Number.isFinite(horizontalExtent) &&
    Number.isFinite(verticalExtent) &&
    horizontalExtent > 0;
  if (!valid) {
    return {
      horizontalExtent,
      verticalExtent,
      status: 'too-small',
      needsCalibration: true,
    };
  }
  const status: SceneScaleStatus =
    horizontalExtent < SCENE_SCALE_MIN_METERS
      ? 'too-small'
      : horizontalExtent > SCENE_SCALE_MAX_METERS
        ? 'too-large'
        : 'ok';
  return {
    horizontalExtent,
    verticalExtent,
    status,
    needsCalibration: status !== 'ok',
  };
}
