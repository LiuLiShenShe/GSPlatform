/**
 * 会话内导览目的地（GS-NEXT-05）—— **纯数据规则**，不含任何引擎 / UI 代码。
 *
 * 这份列表就是进入 VR 前那个「出生位置」选择器（GS-NEXT-03/04）用的同一批数据：
 *   [初始视角（若有 authored initial camera）] + [已保存观察点] + [导览点]
 * 因此**菜单里能到的点 = 桌面下拉里能选的点**，不会出现"菜单里多了一个选择器上
 * 没有的点"这种无法解释的状态。
 *
 * 准入（GS-NEXT-05 §5-9：删除 / 停用 / 无 authored camera 的目的地不得被提供）：
 *   - 初始视角：没有 authored initial camera 就没有"初始观察位置"可回；
 *   - 观察点：`enabled !== false`（与 Desktop 工具栏 Saved Views 同规则）；
 *   - 导览点：调用方必须已过 `eligibleGuidePoints()`（有作者化相机 + 未停用）。
 *     运行期还有第二道：目的地必须能解析出 RUNTIME 空间 pose，否则跳过
 *     （见 `SuperSplatRuntime.xrDestinations()`）。
 */
import type { RuntimeAnnotation, RuntimeViewpoint } from './types';

/** 初始观察位置的稳定 ID（非数据库 ID；该目的地不来自任何表）。 */
export const INITIAL_DESTINATION_ID = 'xr-initial';

export type XrDestinationKind = 'initial' | 'viewpoint' | 'guide-point';

export interface XrDestination {
  /** `${kind}:${id}` —— 跨类唯一（观察点与标注理论上可能撞 id，加前缀杜绝）。 */
  key: string;
  kind: XrDestinationKind;
  /** 数据库 ID（`initial` 为哨兵常量）。 */
  id: string;
  /** 菜单显示名（作者原文；缺失时用兜底名，不做二次翻译）。 */
  label: string;
}

/** 目的地 key（`kind:id`）—— 页面与 runtime 之间只传这个字符串，不传下标。 */
export function destinationKey(kind: XrDestinationKind, id: string): string {
  return `${kind}:${id}`;
}

export interface BuildXrDestinationsInput {
  /** 是否存在 authored initial camera（false = 无"初始观察位置"）。 */
  hasInitialCamera: boolean;
  initialLabel?: string;
  viewpoints: readonly RuntimeViewpoint[];
  /** 已由 `eligibleGuidePoints()` 过滤过的导览点（保持作者排序）。 */
  guidePoints: readonly RuntimeAnnotation[];
}

export function buildXrDestinations(input: BuildXrDestinationsInput): XrDestination[] {
  const out: XrDestination[] = [];
  if (input.hasInitialCamera) {
    out.push({
      key: destinationKey('initial', INITIAL_DESTINATION_ID),
      kind: 'initial',
      id: INITIAL_DESTINATION_ID,
      label: input.initialLabel ?? '初始位置',
    });
  }
  for (const vp of input.viewpoints) {
    // 与 Desktop Saved Views 同规则：停用的视角不提供（描述符里 enabled 为 false）。
    if (vp.enabled === false) continue;
    const label = vp.name?.trim();
    if (!label) continue; // 无名视角在菜单里无法与其它条目区分 → 不提供
    out.push({ key: destinationKey('viewpoint', vp.id), kind: 'viewpoint', id: vp.id, label });
  }
  for (const ann of input.guidePoints) {
    if (ann.enabled === false) continue;
    const label = ann.title?.trim();
    if (!label) continue;
    out.push({ key: destinationKey('guide-point', ann.id), kind: 'guide-point', id: ann.id, label });
  }
  return out;
}

/**
 * 上一个 / 下一个（环形，越界回绕 —— 与官方 Desktop 标注导览器
 * `(i±1+n)%n` 同一语义）。
 *
 * 空列表 / 单元素：永远返回 0，避免 `-1` 这种"没有目的地"被当成合法下标。
 */
export function stepDestinationIndex(count: number, current: number, step: 1 | -1): number {
  if (!Number.isInteger(count) || count <= 0) return 0;
  if (count === 1) return 0;
  const base = Number.isInteger(current) && current >= 0 && current < count ? current : 0;
  return (base + step + count) % count;
}

/** 目的地在列表中的下标；找不到返回 -1（按 key 匹配，不按下标持久化）。 */
export function destinationIndexByKey(list: readonly XrDestination[], key: string): number {
  return list.findIndex((d) => d.key === key);
}
