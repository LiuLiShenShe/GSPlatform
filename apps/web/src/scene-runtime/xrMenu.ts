/**
 * 会话内 XR 菜单（GS-NEXT-05）—— **官方 XrMenu 的最小适配层**。
 *
 * 本文件不含任何自绘渲染：菜单本体是官方 `XrMenu`（`playcanvas@2.22.4`
 * `scripts/esm/xr/xr-menu.mjs`），点击按钮就是官方 `app.fire(eventName)`。
 * 这里只做三件"不改官方源码就绕不过去"的适配，并把它们写清楚：
 *
 * 1. **补装官方 UI 组件系统**。官方 SuperSplat Viewer 的 `App` 只注册了
 *    `Camera/Light/Render/GSplat/Script` 五个系统，**没有** `Element` /
 *    `Screen` / `Button`。而 `XrMenu` 的按钮是 `screen` + `element` + `button`
 *    三个组件 —— `Entity.addComponent` 在系统缺失时**静默返回 null**，于是菜单会
 *    "建出来但不渲染、不拾取、不响应"，而且不报错。这里注册官方组件系统（不改
 *    官方 App 配置，不 fork viewer）。
 * 2. **提供字体**。`XrMenu` 的文字行需要 fontAsset；锁定版 viewer 里没有任何
 *    font 资产，没有它 text 元素不渲染。这里用官方 `CanvasFont`（运行时按
 *    **系统字体栈** 光栅化）注册一个 font asset —— 不引入字体二进制文件，中英文
 *    都能显示（PICO 的 Android 系统浏览器自带 CJK 字体）。
 * 3. **舒适过渡**。锁定版引擎**没有** camera fade（`CameraComponent.fadeIn/fadeOut`
 *    在 2.22.4 已不存在），官方 XR 脚本里也没有任何 blackout 工具。所以用与
 *    XrMenu 完全相同的官方 UI 原语（Screen + Element）做一块全屏黑纱，只在传送
 *    的那 0.4 秒里启用，平时 `enabled=false` 零开销。
 *
 * 明确不做：不改官方包源码、不新建渲染器/导航/手柄系统、不 fork viewer。
 */
import {
  Asset,
  ButtonComponentSystem,
  CanvasFont,
  Color,
  ElementComponentSystem,
  Entity,
  ScreenComponentSystem,
  Vec2,
  Vec4,
  type AppBase,
  type ScriptType,
} from 'playcanvas';
import { XrMenu, type XrMenuItem } from 'playcanvas/scripts/esm/xr/xr-menu.mjs';
import type { XrDestination } from './xrDestinations';

// ------------------------------------------------------------------ //
// 菜单事件名（官方 XrMenu 点击按钮后 app.fire 的名字）
// ------------------------------------------------------------------ //

/** 官方菜单 app 事件名。放在一个对象里，避免调用方拼错字符串。 */
export const XR_MENU_EVENTS = {
  prev: 'gsplatform:xr-menu:prev',
  next: 'gsplatform:xr-menu:next',
  home: 'gsplatform:xr-menu:home',
  exit: 'gsplatform:xr-menu:exit',
} as const;

/** 官方 XrMenu 在显隐变化时广播的事件（官方注释：供导航脚本仲裁用）。 */
export const XR_MENU_ACTIVE_EVENT = 'xr:menu:active';

/**
 * 官方 XrNavigation 的**地面传送**（floor teleport）在本产品中恒为关闭。
 *
 * 理由（三条，都是产品事实，不是省事）：
 *
 * 1. 官方 `XrNavigation` 的地面是一个**平面**：`groundHeight = 0`（源码默认），
 *    没有地面网格、没有尺度校准时它就是 Y=0。点击菜单会同时触发
 *    `selectend` → `handleSelectEnd` → `tryTeleport`（官方只在 `enableTeleport`
 *    为真时传送，正是为了这个冲突），于是在未校准场景里"按一下菜单"会被弹到
 *    Y=0 的平面上 —— 用户会掉到场景外或半埋进去。
 * 2. 本仓已经有同一条门禁：迁移 `ab02cd03ef04` 之后 `physicalWalkAllowed` 要求
 *    `calibration.state == VERIFIED` **且** `metersPerSceneUnit ≈ 1` **且**
 *    `transformIdentity == identity`（`app/services/scene_processing.py`），
 *    而 `SceneProcessingPatch.calibration` **不接受** VERIFIED —— 也就是说今天
 *    没有任何一个场景能证明自己的地面可信。
 * 3. 运行时描述符里根本没有 calibration 字段，XR 页面拿不到可信度证据；
 *    与其猜，不如关掉。
 *
 * 只关这一个官方开关：**摇杆移动 / snap turn / 垂直 snap / 6DoF 全部保留官方
 * 默认行为**（§4 要求"不影响官方摇杆移动和转向"）。将来若描述符真的带上可信
 * 校准，改这一个常量即可（`applyFloorTeleportPolicy` 已经把菜单仲裁写好）。
 */
export const XR_FLOOR_TELEPORT_ALLOWED = false;

/** 菜单行下标（0 = 当前目的地只读标签）。 */
export const XR_MENU_CURRENT_INDEX = 0;

/** 系统字体栈 —— 不打包字体文件，中英文都走浏览器/系统字体。 */
export const XR_MENU_FONT_STACK =
  'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

/** font asset 名（注册进 app.assets 后官方 XrMenu 会自己 fallback 找到它）。 */
const XR_MENU_FONT_ASSET = 'gsplatform-xr-menu-font';

/**
 * 行高/字号比官方默认值放大：默认 `buttonWidth=0.075 m / fontSize=8` 折算下来
 * 一个按钮只有约 9 个字宽，中文标签会被挤掉。这是官方**属性配置**，不是自绘。
 */
const MENU_LAYOUT = {
  buttonWidth: 0.16,
  buttonHeight: 0.026,
  buttonSpacing: 0.006,
  fontSize: 14,
  menuScale: 1,
  /** 手柄上默认切菜单的按键（官方默认 4 = 左摇杆 Y 键）。 */
  toggleButtonIndex: 4,
} as const;

// ------------------------------------------------------------------ //
// 1) 官方 UI 组件系统
// ------------------------------------------------------------------ //

/** 本层只需要 app 的极小一部分（便于单测替换）。 */
export interface XrUiHostApp {
  systems: { add(system: unknown): void; [id: string]: unknown };
  assets: {
    add(asset: unknown): void;
    remove(asset: unknown): boolean;
    filter(fn: (asset: Asset) => boolean): Asset[];
  };
  scene: { layers: { getLayerByName(name: string): { id: number } | undefined } };
  root: Entity;
  on(event: string, fn: (dt: number) => void): unknown;
  off(event: string, fn: (dt: number) => void): unknown;
}

/** 官方 UI 组件系统工厂（顺序无关；id 用于幂等判断）。 */
export const XR_UI_SYSTEM_FACTORIES: ReadonlyArray<readonly [string, new (app: AppBase) => unknown]> = [
  ['screen', ScreenComponentSystem],
  ['element', ElementComponentSystem],
  ['button', ButtonComponentSystem],
];

/**
 * 注册官方 UI 组件系统（Screen / Element / Button）。
 *
 * 幂等：已注册的名字直接跳过（`systems.add` 对重名会抛）。返回新增的名字列表，
 * 便于诊断（空数组 = 官方 App 已经带这套系统，或已被别的实例装过）。
 *
 * `factories` 可注入（单测里真实的 `ScreenComponentSystem` 需要真实
 * graphicsDevice，无法用假 app 构造）。
 */
export function ensureXrUiSystems(
  app: XrUiHostApp,
  factories: ReadonlyArray<readonly [string, new (app: AppBase) => unknown]> = XR_UI_SYSTEM_FACTORIES,
): string[] {
  const added: string[] = [];
  for (const [id, SystemCtor] of factories) {
    if (app.systems[id]) continue;
    app.systems.add(new SystemCtor(app as unknown as AppBase));
    added.push(id);
  }
  return added;
}

// ------------------------------------------------------------------ //
// 2) 官方 CanvasFont（系统字体栈）
// ------------------------------------------------------------------ //

export interface XrMenuFont {
  /** 注册进 app.assets 的 font 资产（供 XrMenu 的 fontAsset 属性用）。 */
  asset: Asset;
  /** 底层 CanvasFont（换文字时需要 updateTextures 生成新字形）。 */
  font: CanvasFont;
  destroy(): void;
}

/**
 * 创建并注册菜单字体。
 *
 * 用官方 `CanvasFont` + **系统字体栈**：不打包字体二进制，代价是首次生成字形图集
 * 时要过一遍 Canvas2D（几十个字符，毫秒级）。
 */
export function createXrMenuFont(app: XrUiHostApp): XrMenuFont {
  const font = new CanvasFont(app as unknown as AppBase, {
    fontName: XR_MENU_FONT_STACK,
    fontWeight: 'normal',
    // 光栅化尺寸要 ≥ 实际显示尺寸，否则字形被放大后发虚（X Menu 用 fontSize=14）。
    fontSize: 48,
    color: new Color(1, 1, 1),
    width: 512,
    height: 512,
    padding: 4,
  });
  const asset = new Asset(XR_MENU_FONT_ASSET, 'font', undefined, undefined, {});
  asset.resource = font;
  app.assets.add(asset);
  return {
    asset,
    font,
    destroy() {
      if (app.assets.remove(asset)) font.destroy();
    },
  };
}

// ------------------------------------------------------------------ //
// 3) 菜单行
// ------------------------------------------------------------------ //

/**
 * 菜单行（**静态**，XrMenu 2.22.4 没有动态重建 UI 的官方路径）。
 *
 * 最小集：当前目的地（只读）/ 上一个 / 下一个 / 返回初始位置 / 退出 VR。
 * 没有「初始观察位置」时不提供"返回初始位置"（点了无处可回 = 假按钮）。
 * 只有一个目的地时退化为「当前 + 退出 VR」。
 */
export function buildXrMenuItems(destinations: readonly XrDestination[]): XrMenuItem[] {
  const items: XrMenuItem[] = [{ label: '' }];
  if (destinations.length >= 2) {
    items.push({ label: '上一个', eventName: XR_MENU_EVENTS.prev });
    items.push({ label: '下一个', eventName: XR_MENU_EVENTS.next });
  }
  if (destinations.some((d) => d.kind === 'initial')) {
    items.push({ label: '返回初始位置', eventName: XR_MENU_EVENTS.home });
  }
  items.push({ label: '退出 VR', eventName: XR_MENU_EVENTS.exit });
  return items;
}

/**
 * 确保字体图集包含 `text` 里的字形。
 *
 * **必须区分两个官方 API**（`playcanvas@2.22.4` `canvas-font.js` 实测）：
 * - 首次填充只能用 `createTextures()` —— `updateTextures()` 内部直接读
 *   `this.data.chars`，而全新 CanvasFont 的 `data` 还是 `{}`（`chars` 未定义），
 *   会抛 `Cannot read properties of undefined`；
 * - 之后再补字形用 `updateTextures()`（增量，不会丢掉已生成的字形）。
 */
function ensureGlyphs(font: CanvasFont, text: string): void {
  const hasAtlas = Boolean((font.data as { chars?: unknown } | null | undefined)?.chars);
  if (hasAtlas) font.updateTextures(text);
  else font.createTextures(text);
}

/** 全部静态文字 + 数字（字形预生成用；换语言时也走这里）。 */
export function menuGlyphSource(items: readonly XrMenuItem[]): string {
  const extra = '0123456789 / -·<>';
  return items.map((i) => i.label ?? '').join('') + extra;
}

// ------------------------------------------------------------------ //
// 4) 安装官方 XrMenu
// ------------------------------------------------------------------ //

export interface XrMenuHandle {
  /** 官方 XrMenu 实例（供 setItemLabel / isPointerOverMenu）。 */
  readonly script: XrMenu;
  /** 当前目的地只读标签所在行。 */
  setCurrentLabel(text: string): boolean;
  /** 指针是否停在菜单按钮上（官方 getter；导航仲裁用）。 */
  isPointerOverMenu(): boolean;
  destroy(): void;
}

/**
 * 在官方 XR Rig（`xr.camera.parent`）上创建官方 XrMenu。
 *
 * 官方约定（2.22.4 源码注释）：XrMenu 应挂在与 XrSession 同一个实体上，即
 * **相机父实体**；Viewer 已经在该实体上 `addComponent('script')` 并创建了
 * XrControllers / XrNavigation，我们只是再加一个官方脚本。
 */
export function installXrMenu(params: {
  app: XrUiHostApp;
  rig: Entity;
  font: XrMenuFont;
  items: XrMenuItem[];
}): XrMenuHandle | null {
  const { app, rig, font, items } = params;
  if (!app.systems.element || !app.systems.screen || !app.systems.button) return null;
  const scriptComponent = rig.script;
  if (!scriptComponent) return null;
  // 预生成字形：否则元素创建时字体图集还是空的（CanvasFont 不会自动补字形）。
  ensureGlyphs(font.font, menuGlyphSource(items));
  /*
   * 类型说明：`playcanvas@2.22.4` 的官方 XrMenu 继承的是**旧版 `Script` 基类**
   * （`scripts/esm/xr/xr-menu.mjs` 里 `class XrMenu extends Script`），而
   * `ScriptComponent.create` 的 TS 签名要求 `typeof ScriptType`。运行时两者都走
   * `create(nameOrType)` 的同一分支（按 `static scriptName` 注册，`properties`
   * 直接 `Object.assign` 到实例上），所以这里显式断言一次即可，不需要（也不该）
   * 在声明里把 XrMenu 谎报成 ScriptType。
   */
  const script = scriptComponent.create(XrMenu as unknown as typeof ScriptType, {
    properties: {
      menuItems: items,
      fontAsset: font.asset,
      buttonWidth: MENU_LAYOUT.buttonWidth,
      buttonHeight: MENU_LAYOUT.buttonHeight,
      buttonSpacing: MENU_LAYOUT.buttonSpacing,
      fontSize: MENU_LAYOUT.fontSize,
      menuScale: MENU_LAYOUT.menuScale,
      toggleButtonIndex: MENU_LAYOUT.toggleButtonIndex,
    },
  }) as XrMenu | null;
  if (!script) return null;
  return {
    script,
    setCurrentLabel(text: string): boolean {
      // 新文字可能含未光栅化的字形（中文字名）→ 先补图集再改文字。
      ensureGlyphs(font.font, text);
      return script.setItemLabel(XR_MENU_CURRENT_INDEX, text);
    },
    isPointerOverMenu(): boolean {
      return script.isPointerOverMenu;
    },
    destroy() {
      // 官方脚本在 destroy 时会摘掉自己的 xr / xr.input 监听并销毁菜单实体。
      scriptComponent.destroy(XrMenu as unknown as typeof ScriptType);
    },
  };
}

// ------------------------------------------------------------------ //
// 5) 舒适过渡（淡出 → 定位 → 淡入）
// ------------------------------------------------------------------ //

/** 全屏黑纱的可见面（便于单测替换成假面，状态机与渲染分开）。 */
export interface ComfortVeilSurface {
  setOpacity(value: number): void;
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

/** UI 像素 → 米（与官方 XrMenu 同一个 `_uiScale`）。 */
const VEIL_UI_SCALE = 0.001;
/** 黑纱距眼距离（米）。必须在 nearClip(0.1) 之外，否则整块被裁掉。 */
const VEIL_DISTANCE = 0.2;

/**
 * 在 XR Camera 上挂一块全屏黑纱（官方 Screen + Element 原语）。
 *
 * - 挂在**相机**下（不是 Rig）：用户的头在 Rig 里移动，挂在 Rig 上会露出边缘。
 * - `screen` 默认 scaleMode=NONE ⇒ `scale` 恒为 1，物理尺寸完全由实体局部缩放
 *   决定，行为可预测（官方 XrMenu 的 `scaleBlend` 在同一默认值下是空操作）。
 * - UI 平面法线是实体局部 +Z，相机前向是 -Z ⇒ 屏幕要绕 Y 转 180°。
 */
export function createComfortVeil(camera: Entity, uiLayerId: number): ComfortVeilSurface | null {
  const screen = new Entity('GsXrComfortVeil');
  camera.addChild(screen);
  screen.setLocalPosition(0, 0, -VEIL_DISTANCE);
  screen.setLocalEulerAngles(0, 180, 0);
  screen.setLocalScale(VEIL_UI_SCALE, VEIL_UI_SCALE, VEIL_UI_SCALE);
  screen.addComponent('screen', {
    referenceResolution: new Vec2(1000, 1000),
    screenSpace: false,
  });
  const quad = new Entity('GsXrComfortVeilQuad');
  screen.addChild(quad);
  quad.addComponent('element', {
    type: 'image',
    anchor: new Vec4(0.5, 0.5, 0.5, 0.5),
    pivot: new Vec2(0.5, 0.5),
    // 0.2 m 处需要覆盖 >100° 视野 ⇒ 0.9 m 见方（±66°）。
    width: 900,
    height: 900,
    color: new Color(0, 0, 0),
    opacity: 0,
    useInput: false,
    layers: [uiLayerId],
  });
  const element = quad.element;
  if (!screen.screen || !element) {
    // 组件系统缺失（理论上 ensureXrUiSystems 已装好）→ 不留半成品实体。
    screen.destroy();
    return null;
  }
  element.opacity = 0;
  screen.enabled = false;
  return {
    setOpacity(value: number) {
      const clamped = Math.max(0, Math.min(1, value));
      element.opacity = clamped;
      screen.enabled = clamped > 0;
    },
    setEnabled(enabled: boolean) {
      screen.enabled = enabled;
      if (!enabled) element.opacity = 0;
    },
    destroy() {
      screen.destroy();
    },
  };
}

export interface ComfortFade {
  /** 淡出 → 执行 `midpoint`（一次性定位）→ 淡入。忙时返回 false（丢弃请求）。 */
  run(midpoint: () => void): boolean;
  /** 是否正在过渡（诊断用）。 */
  readonly pending: boolean;
  /** 立刻结束过渡并回到全透明（XR 会话结束时必须调）。 */
  reset(): void;
  destroy(): void;
}

export interface ComfortFadeOptions {
  fadeOutSeconds?: number;
  fadeInSeconds?: number;
}

/**
 * 淡出/淡入状态机。
 *
 * 只在**创建时**订阅一次 `app.on('update')` —— 每次传送都新建订阅是官方 XrMenu
 * 文档里明确警告的"重复订阅"坑（本项目 §5-8 验收项）。
 */
export function createComfortFade(
  app: { on(event: string, fn: (dt: number) => void): unknown; off(event: string, fn: (dt: number) => void): unknown },
  surface: ComfortVeilSurface,
  options: ComfortFadeOptions = {},
): ComfortFade {
  const fadeOut = Math.max(0.05, options.fadeOutSeconds ?? 0.14);
  const fadeIn = Math.max(0.05, options.fadeInSeconds ?? 0.24);
  let phase: 'idle' | 'out' | 'in' = 'idle';
  let opacity = 0;
  let midpoint: (() => void) | null = null;

  const tick = (dt: number) => {
    if (phase === 'idle') return;
    const step = phase === 'out' ? dt / fadeOut : -dt / fadeIn;
    opacity = Math.max(0, Math.min(1, opacity + step));
    surface.setOpacity(opacity);
    if (phase === 'out' && opacity >= 1) {
      // 全黑这一帧执行定位：用户看不到世界跳变。
      const apply = midpoint;
      midpoint = null;
      try {
        apply?.();
      } catch {
        // 定位失败不能把状态机卡在 out（否则黑纱永远不撤）。
      }
      phase = 'in';
      return;
    }
    if (phase === 'in' && opacity <= 0) {
      phase = 'idle';
      surface.setEnabled(false);
    }
  };
  app.on('update', tick);
  return {
    run(next: () => void): boolean {
      if (phase !== 'idle') return false;
      phase = 'out';
      opacity = 0;
      midpoint = next;
      surface.setEnabled(true);
      return true;
    },
    get pending(): boolean {
      return phase !== 'idle';
    },
    reset() {
      phase = 'idle';
      opacity = 0;
      midpoint = null;
      surface.setOpacity(0);
      surface.setEnabled(false);
    },
    destroy() {
      app.off('update', tick);
      phase = 'idle';
      midpoint = null;
      surface.destroy();
    },
  };
}

/** 便捷：从 app 的场景层里取 UI 层 id（官方 XrMenu 同一来源）。 */
export function uiLayerId(app: XrUiHostApp): number {
  return app.scene.layers.getLayerByName('UI')?.id ?? 0;
}
