/**
 * Performance Mode 默认策略（GS-NEXT-02 §五）。
 *
 * 唯一偏好来源 = 官方 localStorage key ``performanceMode``（官方
 * ``readPreferences`` / ``persistPreferences`` 读写；**禁止**另建第二套存储）。
 * 本层只决定"打开一个场景时官方 ``state.performanceMode`` 的初值"，绝不重写官方
 * Gaussian Budget / LOD / renderer，也不重建 Viewer。
 *
 * 固定策略：
 *   1. 用户已有显式偏好（key 存在）→ 尊重它（Desktop / XR 共用同一份偏好）。
 *   2. 无偏好（首次打开）→ GSPlatform 产品默认 = **ON**。
 *   3. 默认值只在 runtime 创建时施加**一次**，且**不写入** localStorage
 *      （``persist: false``）—— 手动 OFF 后不会被初始化逻辑反复强制打开，也不会
 *      把"产品默认"伪造成"用户偏好"。
 *   4. 用户手动切换经官方 state 写入并由官方 ``persistPreferences`` 持久化，
 *      因此刷新/重开仍是用户的选择；清除该 key = 恢复产品默认（ON）。
 */

/** 官方 localStorage key（与 1.35.0 `readPreferences` 完全一致）。 */
export const PERFORMANCE_MODE_STORAGE_KEY = 'performanceMode';

/** GSPlatform 产品默认：Performance Mode 默认 ON。 */
export const GSPLATFORM_PERFORMANCE_MODE_DEFAULT = true;

/**
 * 读取用户显式偏好。
 *
 * @returns true/false = 用户显式选择；null = 从未选择（含 storage 不可用）。
 */
export function readPerformanceModePreference(): boolean | null {
  try {
    const raw = localStorage.getItem(PERFORMANCE_MODE_STORAGE_KEY);
    if (raw === null) return null;
    return raw === 'true';
  } catch {
    // 嵌入式文档可能禁用 storage；按"无偏好"处理，绝不因存储不可用而失败。
    return null;
  }
}

/** 无显式偏好时的初值（= 产品默认）。 */
export function resolveInitialPerformanceMode(): boolean {
  return readPerformanceModePreference() ?? GSPLATFORM_PERFORMANCE_MODE_DEFAULT;
}

/**
 * 是否需要施加默认值（纯函数，便于单测）。
 *
 * @param current - 官方 state 当前值（官方 readPreferences 已按存储/移动端判定）。
 * @param preference - 用户显式偏好（null = 无）。
 * @returns 目标值；与 current 相同则 null（无需写入）。
 */
export function performanceModeTarget(current: boolean, preference: boolean | null): boolean | null {
  const target = preference ?? GSPLATFORM_PERFORMANCE_MODE_DEFAULT;
  return target === current ? null : target;
}
