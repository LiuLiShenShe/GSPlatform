/**
 * 导览点（Annotation-backed guide point）准入规则（GS-NEXT-04）。
 *
 * **为什么单独成文件**：这条规则是产品语义，不是视图逻辑 —— 它决定哪些标注
 * 可以作为「进入 VR 的出生位姿」。放在页面里会被悄悄改掉；独立出来才能被单测
 * 锁死（VR-03 §8 要求 1：老的无相机热点**不能**静默变成 XR 传送节点）。
 *
 * 关键事实：`experienceAdapter.buildAnnotations()` 对**未作者化相机**的标注，会把
 * 其 `camera.initial` 逐条回落到**场景初始相机**。也就是说官方层面它们的相机
 * 看起来是「有」的，但那是共享默认值，不是作者为这条热点选的构图。若拿它当
 * 出生位姿，用户点「导览点」却被放到初始视角 —— 一个不报错的假承诺。
 *
 * 因此准入只看**数据事实**：标注必须同时具备
 *   1. `enabled !== false`（停用的热点不进运行时）；
 *   2. `cameraPosition` 与 `cameraTarget` 都存在（作者确实为它存过 Viewer 相机）。
 *
 * 相机数值本身的有限性 / fov 越界由运行时再兜一道
 * （`SuperSplatRuntime.annotationRuntimePose` 返回 null 时调用方必须当作失败），
 * 这里是第一道、也是语义上的那一道。
 */
import type { RuntimeAnnotation } from './types';

/**
 * 可作为 XR 出生位姿的导览点（保持描述符原顺序 = 作者排序）。
 *
 * 只读不改；返回原数组的过滤结果，不复制元素（元素本身是只读用法）。
 */
export function eligibleGuidePoints(annotations: RuntimeAnnotation[]): RuntimeAnnotation[] {
  return annotations.filter(
    (a) => a.enabled !== false && Boolean(a.cameraPosition) && Boolean(a.cameraTarget),
  );
}

/** 该标注是否可作为导览点（与 {@link eligibleGuidePoints} 同规则，供页面按需判断）。 */
export function isEligibleGuidePoint(annotation: RuntimeAnnotation): boolean {
  return annotation.enabled !== false && Boolean(annotation.cameraPosition) && Boolean(annotation.cameraTarget);
}