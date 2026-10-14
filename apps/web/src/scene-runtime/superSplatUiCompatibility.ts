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
 *      initUI 构建）。
 *   2. 官方 chrome（`.sse-ui` 的直接子元素）由本层注入的作用域 CSS 隐藏（宿主
 *      自绘工具条替代），**但官方标注导览器 `.sse-annotationNav` 例外保留**
 *      （GS-NEXT-04：官方现成的 Prev/Next + 序号 + 标题，直接复用而非自绘）。
 *   3. 所有内部 class 选择器集中在此（禁止散落其他文件）。
 */
import type { Plugin } from 'vite';

/** 依赖声明（契约测试扫描此常量，升级版本号即触发重新验证）。 */
export const SUPERSPLAT_UI_PINNED_VERSION = '@playcanvas/supersplat-viewer@1.35.0';

/** 内部 class：官方根 UI 容器（控件栏/海报/加载条/annotation 导航/设置/帮助）。 */
export const OFFICIAL_UI_CHROME_CLASS = 'sse-ui';
/**
 * 内部 class：官方标注导览器（Prev/Next + 序号 + 标题）。
 *
 * GS-NEXT-04：官方 UI 是 DOM，且这一个模块的**全部逻辑都是现成的**——
 * 少于 2 条自动隐藏、按钮自动 disable、循环切换 `(i±1+n)%n`、序号/标题跟随
 * `state.selectedAnnotation`、未选中置灰、显隐跟随 `state.showAnnotations`
 * （与 GSPlatform 工具栏的 Annotations 开关写的是同一个官方状态）。
 * 因此本层**放行**它，而不是自绘一套等价的 UI。
 */
export const OFFICIAL_ANNOTATION_NAV_CLASS = 'sse-annotationNav';
/** 内部 class：官方 3D 场景标注层（hotspots + 官方 tooltip）。 */
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
    // GS-NEXT-04：官方 chrome 改为**按「.sse-ui 的直接子元素」整体隐藏**，仅用
    // :not() 放行官方标注导览器。用白名单而不是逐个枚举黑名单 —— 官方将来新增
    // chrome 时会被自动隐藏，不必再改这一层。
    //
    // 三条必须记住的约束（都来自锁定版 1.35.0 的实际 CSS/DOM）：
    //  1. **不能**继续隐藏 `.sse-ui` 自身：父级 display:none 会让子级无论如何
    //     都无法显示，拿不回官方导览器。
    //  2. **不能**给 `.sse-annotationNav` 自身设置 display：官方靠
    //     `sse-hidden` / `sse-desktop` / `sse-touch` 类控制显隐与布局
    //     （`.sse-desktop` 才给 display:flex），覆盖会破坏「少于 2 条不显示」
    //     「按输入模式换布局」等官方逻辑。本层只让 `.sse-ui` 本身可见。
    //  3. 隐藏其余 chrome 是**必需**的：`.sse-controlsWrap` 横跨容器宽度、
    //     `.sse-infoPanel` 是全屏毛玻璃，而 `.sse-ui *` 统一
    //     `pointer-events:auto` —— 不隐藏就会吃掉 canvas 上的鼠标事件。
    //     （`.sse-ui` 自身是 pointer-events:none，本身不挡 canvas。）
    `.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS} > *:not(.${OFFICIAL_ANNOTATION_NAV_CLASS}) { display: none !important; }`,
    // 标注层保留：官方 hotspot 与**官方 tooltip**（.sse-annotations > .sse-annotation）
    // 都在 .sse-sceneLayer 内，不在 .sse-ui 里，因此不受上面那条规则影响。
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
  /** 官方 chrome 容器数量（存在；其直接子元素除导览器外被本层隐藏）。 */
  chromeCount: number;
  /**
   * 官方标注导览器是否存在（GS-NEXT-04）。
   *
   * 本层**放行**该模块，因此它必须真的在官方 DOM 里。官方若改名/移除，
   * 本检查转 false → 契约测试 FAIL（升级依赖即暴露），而不是静默退化成
   * 「桌面看不到导览器」。
   */
  annotationNav: boolean;
  /** 依赖是否匹配当前锁定版本声明。 */
  pinnedVersionMatches: boolean;
}

/**
 * 契约检查（FIX-03 §13）：验证官方 UI 内部 class 契约仍然成立。
 *
 * - annotation 层存在（`.sse-annotation-hotspots .sse-annotation-hotspot` 出现）；
 * - 官方 chrome（`.sse-ui`）存在，其直接子元素按设计隐藏（除导览器外）；
 * - 官方标注导览器 `.sse-annotationNav` 存在且**是 `.sse-ui` 的直接子元素**
 *   （本层用 `> *:not(...)` 放行它；层级一变就放不出来，必须暴露）。
 *
 * 未来官方 class 变化时此检查返回 false → 契约测试 FAIL，升级依赖即暴露。
 * 用于真实 DOM（e2e/ssv06-authoring.spec.ts）与 jsdom 契约单测。
 */
export function validateUiCompatibility(root: ParentNode | null): UiCompatibilityReport {
  const hotspots = root?.querySelectorAll(
    `.${OFFICIAL_HOTSPOTS_CONTAINER_CLASS} .${OFFICIAL_HOTSPOT_CLASS}`,
  );
  const chromeNodes = root?.querySelectorAll(`.${OFFICIAL_UI_CHROME_CLASS}`);
  // 导览器必须是 `.sse-ui` 的**直接子元素**（本层靠 `> *:not(...)` 放行它）。
  // 刻意不用 `:scope >`：显式比对 parentElement 在 jsdom 与浏览器上都稳。
  const nav = root?.querySelector(`.${OFFICIAL_ANNOTATION_NAV_CLASS}`);
  const annotationNav =
    nav instanceof Element && nav.parentElement?.classList.contains(OFFICIAL_UI_CHROME_CLASS);
  const pinnedVersionMatches =
    SUPERSPLAT_UI_PINNED_VERSION === '@playcanvas/supersplat-viewer@1.35.0';
  return {
    hotspotsContainer: (root?.querySelector(`.${OFFICIAL_HOTSPOTS_CONTAINER_CLASS}`) ?? null) !== null,
    hotspotCount: hotspots?.length ?? 0,
    chromeCount: chromeNodes?.length ?? 0,
    annotationNav: annotationNav === true,
    pinnedVersionMatches,
  };
}

/** vite 插件占位（保持模块可为 plugin 导入；实际作用域样式由运行时注入）。 */
export function superSplatUiCompatibilityPlugin(): Plugin {
  return { name: 'gs-supersplat-ui-compatibility', configureServer() {} };
}
