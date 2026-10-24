/**
 * SuperSplat UI Compatibility Layer（FIX-03 §11/§12；GS-DESKTOP-02 重写）——
 * 单一文件集中管理所有针对官方 SuperSplat viewer 内部 DOM class 的兼容策略。
 *
 * ⚠️ Pinned to @playcanvas/supersplat-viewer 1.35.0（锁定版本）
 * ⚠️ Internal CSS/DOM dependency —— 官方不保证 .sse-ui / .sse-sceneLayer /
 *    .sse-annotation-hotspot 等 class 是稳定公开 API。
 * ⚠️ 升级依赖前必须重新验证：见 e2e/gsdesktop02-official-ui.spec.ts（真实浏览器）
 *    与 src/__tests__/super-splat-ui-compatibility.test.ts（契约单测，class 变化即 FAIL）。
 *
 * ## GS-DESKTOP-02：恢复官方 Viewer 原生 UI
 *
 * 旧实现（SSV-03 → GS-NEXT-04）隐藏 `.sse-ui` 的**全部直接子元素**（仅放行官方
 * 标注导览器），用宿主自绘 `OfficialViewerToolbar` 替代。GS-DESKTOP-02 起：
 *
 *   1. **官方 chrome 全部保留**：controlsWrap（Orbit/Fly/Walk、Reset、Frame）、
 *      settingsPanel（Performance / Annotations / Gaming controls）、infoPanel、
 *      全屏、AR/VR、annotationNav、hotspots —— 全部是官方 1.35.0 的真实 DOM，
 *      由官方自己构建/绑定事件。宿主不再隐藏、不再复制这些控件。
 *   2. 本层**只保留一条内部 class 规则**：安全闸门。尺度未校准
 *      （needsCalibration）时隐藏官方 Walk 按钮 —— 官方 `walkAllowed` 只判断
 *      「有碰撞数据 + 场景足够大」，不知道 GSPlatform 的 1 unit = 1m 校准语义；
 *      在错误尺度下走路是安全问题。除此之外不改官方任何显隐/布局/事件。
 *   3. 平台级 UI（返回、作品信息、分享、Saved Views、安全提示）必须放在不遮挡
 *      官方控件的位置；官方 `.sse-ui` 自身是 `pointer-events:none`，其子控件才
 *      接收事件，因此平台容器不能覆盖整块画布。
 *
 * 所有内部 class 选择器集中在此（禁止散落其他文件）。
 */
import type { Plugin } from 'vite';

/** 依赖声明（契约测试扫描此常量，升级版本号即触发重新验证）。 */
export const SUPERSPLAT_UI_PINNED_VERSION = '@playcanvas/supersplat-viewer@1.35.0';

/** 内部 class：官方根 UI 容器（全屏/控件/面板的公共父级）。 */
export const OFFICIAL_UI_CHROME_CLASS = 'sse-ui';
/** 内部 class：官方标注导览器（Prev/Next + 序号 + 标题）。 */
export const OFFICIAL_ANNOTATION_NAV_CLASS = 'sse-annotationNav';
/** 内部 class：官方 3D 场景标注层（hotspots + 官方 tooltip）。 */
export const OFFICIAL_SCENE_LAYER_CLASS = 'sse-sceneLayer';
/** 内部 class：官方标注热点元素。 */
export const OFFICIAL_HOTSPOT_CLASS = 'sse-annotation-hotspot';
/** 内部 class：官方标注热点容器。 */
export const OFFICIAL_HOTSPOTS_CONTAINER_CLASS = 'sse-annotation-hotspots';
/** 内部 class：官方 visible tooltip。 */
export const OFFICIAL_TOOLTIP_VISIBLE_CLASS = 'sse-annotation';

// --- 官方原生控件（GS-DESKTOP-02：宿主不再复制，只做契约检查） --------------
/** 底部工具条容器（Orbit/Fly/Walk/Reset/Frame/Play/全屏/…）。 */
export const OFFICIAL_CONTROLS_CLASS = 'sse-controlsWrap';
/** Reset 按钮 → 官方 resetCamera()（回到 authored initial view）。 */
export const OFFICIAL_RESET_BUTTON_CLASS = 'sse-reset';
/** Frame 按钮 → 官方 frameScene()（只在用户主动点击时取景）。 */
export const OFFICIAL_FRAME_BUTTON_CLASS = 'sse-frame';
/** Orbit / Fly / Walk 相机模式按钮。 */
export const OFFICIAL_ORBIT_BUTTON_CLASS = 'sse-orbitCamera';
export const OFFICIAL_FLY_BUTTON_CLASS = 'sse-flyCamera';
export const OFFICIAL_WALK_BUTTON_CLASS = 'sse-fpsCamera';
/** Settings 按钮 + 面板（Performance / Annotations / Gaming controls）。 */
export const OFFICIAL_SETTINGS_BUTTON_CLASS = 'sse-settings';
export const OFFICIAL_SETTINGS_PANEL_CLASS = 'sse-settingsPanel';
/** Annotations 显隐行（设置面板内）。 */
export const OFFICIAL_ANNOTATIONS_ROW_CLASS = 'sse-annotationsRow';
/** Info / Help 按钮 + 面板。 */
export const OFFICIAL_INFO_BUTTON_CLASS = 'sse-info';
export const OFFICIAL_INFO_PANEL_CLASS = 'sse-infoPanel';
/** 全屏按钮。 */
export const OFFICIAL_FULLSCREEN_BUTTON_CLASS = 'sse-enterFullscreen';

/** 宿主作用域 class（施加到挂载容器，限定本层 CSS 只影响 GSPlatform 宿主）。 */
export const UI_SCOPE_CLASS = 'gs-supersplat-host';
/** 安全闸门 class：尺度未校准 → 隐藏官方 Walk 按钮（本层唯一的隐藏规则）。 */
export const WALK_BLOCKED_CLASS = 'gs-walk-blocked';

/** 作用域样式 id（幂等注入）。 */
export const UI_SCOPE_STYLE_ID = 'gs-supersplat-ui-scope';

/** 生成的作用域 CSS 内容（集中一处；契约测试断言引用上述内部 class）。 */
export function buildUiScopeCss(): string {
  return [
    // GS-DESKTOP-02：**只有一条**内部 class 规则 —— 安全闸门。
    // 尺度未校准（1 unit ≠ 1m）时官方 Walk 入口必须消失：官方 walkAllowed 只
    // 看「有碰撞 + 场景足够大」，不包含 GSPlatform 的校准语义。这是安全要求，
    // 不是外观偏好；规则集中在此文件，禁止散落到其他 CSS。
    `.${UI_SCOPE_CLASS}.${WALK_BLOCKED_CLASS} .${OFFICIAL_WALK_BUTTON_CLASS} { display: none !important; }`,
    // 官方 hotspot 层显式保留（防止宿主全局 CSS 的 display 规则误伤）。
    `.${UI_SCOPE_CLASS} .${OFFICIAL_SCENE_LAYER_CLASS} { display: block; }`,
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

/**
 * 安全闸门：尺度未校准 / 碰撞 STALE 时隐藏官方 Walk 入口。
 *
 * 只切换宿主 class，不触碰官方 DOM / state —— 校准恢复后官方按钮原样回来。
 */
export function setWalkGateBlocked(container: HTMLElement | null, blocked: boolean): void {
  if (!container) return;
  container.classList.toggle(WALK_BLOCKED_CLASS, blocked);
}

/** 官方原生控件是否都在（升级依赖后 class 改名即暴露）。 */
export interface OfficialControlsReport {
  /** 底部工具条容器。 */
  controls: boolean;
  /** Reset（回到 authored initial view）。 */
  reset: boolean;
  /** Frame（用户主动取景）。 */
  frame: boolean;
  /** Orbit / Fly / Walk 相机模式。 */
  orbit: boolean;
  fly: boolean;
  walk: boolean;
  /** Settings + Annotations 显隐。 */
  settings: boolean;
  annotationsToggle: boolean;
  /** Info / Help。 */
  info: boolean;
  /** 全屏。 */
  fullscreen: boolean;
}

export interface UiCompatibilityReport {
  /** 官方 hotspots 容器是否存在（渲染出热点层）。 */
  hotspotsContainer: boolean;
  /** 官方热点元素数量（>0 表示 annotation 层真正渲染）。 */
  hotspotCount: number;
  /** 官方 chrome 容器数量。 */
  chromeCount: number;
  /** 官方标注导览器是否存在。 */
  annotationNav: boolean;
  /** 官方原生控件清单（GS-DESKTOP-02：全部应由官方实现）。 */
  officialControls: OfficialControlsReport;
  /** 依赖是否匹配当前锁定版本声明。 */
  pinnedVersionMatches: boolean;
}

function has(root: ParentNode | null, selector: string): boolean {
  return (root?.querySelector(selector) ?? null) !== null;
}

/**
 * 契约检查：验证官方 UI 内部 class 契约仍然成立。
 *
 * GS-DESKTOP-02 起断言的是「官方原生 UI 完整」：hotspots、导览器、工具条、
 * Reset/Frame/Orbit/Fly/Walk、设置面板、Annotations 开关、Info、全屏。
 * 未来官方 class 变化时此检查返回 false → 契约测试 FAIL，升级依赖即暴露。
 * 用于真实 DOM（e2e/gsdesktop02-official-ui.spec.ts）与 jsdom 契约单测。
 */
export function validateUiCompatibility(root: ParentNode | null): UiCompatibilityReport {
  const hotspots = root?.querySelectorAll(
    `.${OFFICIAL_HOTSPOTS_CONTAINER_CLASS} .${OFFICIAL_HOTSPOT_CLASS}`,
  );
  const chromeNodes = root?.querySelectorAll(`.${OFFICIAL_UI_CHROME_CLASS}`);
  const pinnedVersionMatches =
    SUPERSPLAT_UI_PINNED_VERSION === '@playcanvas/supersplat-viewer@1.35.0';
  return {
    hotspotsContainer: has(root, `.${OFFICIAL_HOTSPOTS_CONTAINER_CLASS}`),
    hotspotCount: hotspots?.length ?? 0,
    chromeCount: chromeNodes?.length ?? 0,
    annotationNav: has(root, `.${OFFICIAL_ANNOTATION_NAV_CLASS}`),
    officialControls: {
      controls: has(root, `.${OFFICIAL_CONTROLS_CLASS}`),
      reset: has(root, `.${OFFICIAL_RESET_BUTTON_CLASS}`),
      frame: has(root, `.${OFFICIAL_FRAME_BUTTON_CLASS}`),
      orbit: has(root, `.${OFFICIAL_ORBIT_BUTTON_CLASS}`),
      fly: has(root, `.${OFFICIAL_FLY_BUTTON_CLASS}`),
      walk: has(root, `.${OFFICIAL_WALK_BUTTON_CLASS}`),
      settings: has(root, `.${OFFICIAL_SETTINGS_BUTTON_CLASS}`),
      annotationsToggle: has(root, `.${OFFICIAL_ANNOTATIONS_ROW_CLASS}`),
      info: has(root, `.${OFFICIAL_INFO_BUTTON_CLASS}`),
      fullscreen: has(root, `.${OFFICIAL_FULLSCREEN_BUTTON_CLASS}`),
    },
    pinnedVersionMatches,
  };
}

/** vite 插件占位（保持模块可为 plugin 导入；实际作用域样式由运行时注入）。 */
export function superSplatUiCompatibilityPlugin(): Plugin {
  return { name: 'gs-supersplat-ui-compatibility', configureServer() {} };
}
