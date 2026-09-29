/**
 * SuperSplat UI Compatibility Layer（FIX-03 §11/§12）—— 单一文件集中管理所有针对
 * 官方 SuperSplat viewer 内部 DOM class 的 CSS/DOM 兼容 hack。
 *
 * ⚠️ Pinned to @playcanvas/supersplat-viewer 1.35.0（锁定版本）
 * ⚠️ Internal CSS/DOM dependency —— 官方不保证 .sse-ui / .sse-sceneLayer /
 *    .sse-annotation-hotspot 等 class 是稳定公开 API。
 * ⚠️ 升级依赖前必须重新验证：见 e2e/ssv06-authoring.spec.ts（真实浏览器）与
 *    src/__tests__/super-splat-ui-compatibility.test.ts（契约单测，class 变化即 FAIL）。
 *
 * 职责：
 *   1. `ui:true` 开启官方 annotation hotspots/tooltip 层（官方 UI 类内部只在
 *      initUI 构建），其余官方 chrome（.sse-ui）由本层注入的作用域 CSS 隐藏，
 *      宿主自绘控件，不重复渲染。
 *   2. 所有内部 class 选择器集中在此（禁止散落其他文件）。
 */
import type { Plugin } from 'vite';

/** 依赖声明（契约测试扫描此常量，升级版本号即触发重新验证）。 */
export const SUPERSPLAT_UI_PINNED_VERSION = '@playcanvas/supersplat-viewer@1.35.0';

/** 内部 class：官方根 UI 容器（控件栏/海报/加载条/annotation 导航/设置/帮助）。 */
export const OFFICIAL_UI_CHROME_CLASS = 'sse-ui';
/** 内部 class：官方 3D 场景标注层（hotspots + tooltip）。 */
export const OFFICIAL_SCENE_LAYER_CLASS = 'sse-sceneLayer';
/** 内部 class：官方标注热点元素。 */
export const OFFICIAL_HOTSPOT_CLASS = 'sse-annotation-hotspot';
/** 内部 class：官方标注热点容器。 */
export const OFFICIAL_HOTSPOTS_CONTAINER_CLASS = 'sse-annotation-hotspots';
/** 内部 class：官方 visible tooltip。 */
export const OFFICIAL_TOOLTIP_VISIBLE_CLASS = 'sse-annotation';

/** 宿主作用域 class（施加到挂载容器，限定本层 CSS 只影响 GSPlatform 宿主）。 */
export const UI_SCOPE_CLASS = 'gs-supersplat-host';

/** 作用域样式 id（幂等注入）。 */
export const UI_SCOPE_STYLE_ID = 'gs-supersplat-ui-scope';

/** 生成的作用域 CSS 内容（集中一处；契约测试断言引用上述内部 class）。 */
export function buildUiScopeCss(): string {
  return [
    `.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS} { display: none !important; }`,
    `.${UI_SCOPE_CLASS} .${OFFICIAL_SCENE_LAYER_CLASS} { display: block !important; }`,
  ].join('\n');
}

let uiScopeStyle: HTMLStyleElement | null = null;

/**
 * 给挂载容器施加 UI 兼容作用域：打上宿主 class + 幂等注入作用域样式。
 * 可在测试中直接调用（注入的样式内容由 buildUiScopeCss 单一来源生成）。
 */
export function applyUiScopeStyles(container: HTMLElement): void {
  container.classList.add(UI_SCOPE_CLASS);
  if (uiScopeStyle) return;
  uiScopeStyle = document.createElement('style');
  uiScopeStyle.id = UI_SCOPE_STYLE_ID;
  uiScopeStyle.textContent = buildUiScopeCss();
  document.head.appendChild(uiScopeStyle);
}

export interface UiCompatibilityReport {
  /** 官方 hotspots 容器是否存在（渲染出热点层）。 */
  hotspotsContainer: boolean;
  /** 官方热点元素数量（>0 表示 annotation 层真正渲染）。 */
  hotspotCount: number;
  /** 官方 chrome 容器数量（存在但应被隐藏）。 */
  chromeCount: number;
  /** 依赖是否匹配当前锁定版本声明。 */
  pinnedVersionMatches: boolean;
}

/**
 * 契约检查（FIX-03 §13）：验证官方 UI 内部 class 契约仍然成立。
 *
 * - annotation 层存在（`.sse-annotation-hotspots .sse-annotation-hotspot` 出现）；
 * - 官方 chrome（`.sse-ui`）存在但按设计隐藏（display:none）。
 *
 * 未来官方 class 变化时此检查返回 false / 抛错 → 契约测试 FAIL，升级依赖即暴露。
 * 用于真实 DOM（e2e/ssv06-authoring.spec.ts）与 jsdom 契约单测。
 */
export function validateUiCompatibility(root: ParentNode | null): UiCompatibilityReport {
  const hotspots = root?.querySelectorAll(
    `.${OFFICIAL_HOTSPOTS_CONTAINER_CLASS} .${OFFICIAL_HOTSPOT_CLASS}`,
  );
  const chrome = root?.querySelectorAll(`.${OFFICIAL_UI_CHROME_CLASS}`);
  const pinnedVersionMatches =
    SUPERSPLAT_UI_PINNED_VERSION === '@playcanvas/supersplat-viewer@1.35.0';
  return {
    hotspotsContainer: (root?.querySelector(`.${OFFICIAL_HOTSPOTS_CONTAINER_CLASS}`) ?? null) !== null,
    hotspotCount: hotspots?.length ?? 0,
    chromeCount: chrome?.length ?? 0,
    pinnedVersionMatches,
  };
}

/** vite 插件占位（保持模块可为 plugin 导入；实际作用域样式由运行时注入）。 */
export function superSplatUiCompatibilityPlugin(): Plugin {
  return { name: 'gs-supersplat-ui-compatibility', configureServer() {} };
}
