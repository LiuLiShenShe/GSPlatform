/**
 * ScenePickingAdapter —— 场景拾取适配器契约（FIX-05 §29-§30）。
 *
 * 真实 Gassian 表面拾取（精确命中 splat）需要 GPU 拾取管线，而官方 SuperSplat
 * 1.35.0 的公开 API **没有**暴露它。本层因此只承诺「近似拾取」：
 *
 *   - {@link pickApproximateWorldPosition} —— 现成实现（bbox 深度近似）：
 *     从相机沿视线方向取「场景包围盒中心深度」的点。**不保证命中 splat 表面**，
 *     标注锚点因此应在 Authoring UI 标注为「近似锚点」。
 *   - {@link pickSurfaceWorldPosition} —— 预留扩展接口：未来官方公开 GPU 拾取
 *     或自建命中测试时实现，**禁止**现在就伪造一个「精确」算法冒充真拾取。
 *
 * 所有方法都返回引擎（RUNTIME）空间坐标；作者侧捕获经 SceneTransformAdapter
 * 反向换算到 SCENE 空间后再存库。
 */

/** 一次近似拾取的结果（RUNTIME 空间）。 */
export interface ScenePickResult {
  position: [number, number, number];
}

/** 拾取 NDC 坐标（-1..1，x 向右、y 向上）对应的 3D 世界位置。 */
export type ScenePickCoordinate = {
  x: number;
  y: number;
};

export interface ScenePickingAdapter {
  /**
   * 近似拾取：沿视线在场景包围盒中心深度取点。
   *
   * **不保证命中 splat 表面** —— 精确到 Gassian 表面的 GPU 拾取不在官方公开
   * API 内（FIX-05 §29）。相机缺失/未就绪返回 null。
   */
  pickApproximateWorldPosition(x: number, y: number): ScenePickResult | null;

  /**
   * 预留：精确表面拾取接口（未来官方/自建管线就绪时实现）。
   *
   * 未实现时该方法不存在 —— 调用方必须按「近似」语义使用
   * {@link pickApproximateWorldPosition}，不得假装精确。
   */
  pickSurfaceWorldPosition?(x: number, y: number): ScenePickResult | null;
}
