/**
 * VR 专用低 LOD —— 官方 splat 预算决策（GS-UI-01 后续）。
 *
 * 为什么需要：官方 viewer 的 splat 预算表是 mobile {low:1M, high:2M} /
 * desktop {low:2M, high:4M}，按 `performanceMode` 取 low/high；PICO 等头显
 * 浏览器 UA 有时会被判成 desktop → 预算偏高。对 1309 万 splat / 3.2GB 的
 * 场景，头显要按相机可见性逐块流式拉取，头部晃动时未加载的分块就是黑背景，
 * 且越用越卡（渐进流式 + 热降频）。
 *
 * 做法：XR 入口显式传 `budget`（官方 viewer option，单位=百万高斯，覆盖上面
 * 那张表）。官方只流式/渲染预算以内的 LOD —— 对 13,090,324 splats 的 7 级
 * LOD（13M / 6.5M / 3.3M / 1.6M / 818k / 409k / 204k），0.5M 预算大约落在
 * 3.125% 那一档（≈40.9 万），即用户认可的「VR 专用低 LOD 版」。
 *
 * 可调：`/xr/<sceneId>?budget=0.75`（百万）覆盖默认，方便真机现场比较。
 * 非法/缺失 → 回默认值；Desktop 不经过这里（不传 budget，用官方表）。
 */

/** VR 默认 splat 预算（百万高斯）——约 3.125% LOD 档。 */
export const XR_DEFAULT_SPLAT_BUDGET_MILLIONS = 0.5;

/**
 * 解析 XR 预算：URL `?budget=<百万>` 优先，非法值回默认。
 *
 * 只接受有限正数；`0`/负数/非数字一律回默认（官方对 `<=0` 视为未设置，这里
 * 提前归一，避免“看起来设了其实没生效”）。
 */
export function resolveXrSplatBudget(search: string): number {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get('budget');
  } catch {
    return XR_DEFAULT_SPLAT_BUDGET_MILLIONS;
  }
  if (raw === null || raw.trim() === '') return XR_DEFAULT_SPLAT_BUDGET_MILLIONS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : XR_DEFAULT_SPLAT_BUDGET_MILLIONS;
}
