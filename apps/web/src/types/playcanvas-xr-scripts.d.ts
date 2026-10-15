/**
 * 官方 XR 脚本（`playcanvas@2.22.4`）的类型声明 —— GS-NEXT-05。
 *
 * **为什么需要手写**：`playcanvas` 包的 `exports` 里 `./scripts/*` 只映射到
 * `./scripts/*`（无 `types`），所以 `import { XrMenu } from
 * 'playcanvas/scripts/esm/xr/xr-menu.mjs'` 在 TS 下没有声明可用。
 *
 * **这个文件描述的是锁定版本 2.22.4 的真实 API**，逐条对照
 * `node_modules/.pnpm/playcanvas@2.22.4/.../scripts/esm/xr/xr-menu.mjs` 抄写，
 * 不是按新版 PlayCanvas 的印象编的。升级 playcanvas 时必须重新核对
 * （尤其是：`menuItems` 的 number 行、`labelTextOpacity`、`isPointerOverMenu`）。
 */
declare module 'playcanvas/scripts/esm/xr/xr-menu.mjs' {
  import type { Asset, Color, Entity, Script, Vec2, Vec3 } from 'playcanvas';

  /** 菜单行定义（2.22.4：交互按钮 `{label,eventName}` / 只读标签 `{label}` / 数字行）。 */
  export interface XrMenuItem {
    label?: string;
    value?: string;
    eventName?: string;
    type?: string;
    decEvent?: string;
    incEvent?: string;
  }

  /**
   * 官方 XrMenu（2.22.4）。
   *
   * 关键事实（本轮实测/读源码确认）：
   * - 菜单用引擎自己的 Screen/Element/Button 组件渲染 → **宿主 app 必须注册
   *   `ScreenComponentSystem` / `ElementComponentSystem` / `ButtonComponentSystem`**，
   *   否则 `Entity.addComponent` 静默返回 null，菜单变成"建了但不渲染"的死对象。
   * - 文本行需要 fontAsset；没有字体资产时 element 的 text 不会被渲染。
   * - 手柄模式下按 `toggleButtonIndex`（默认 4）切换显隐，菜单锚在手柄 grip 上。
   * - 点击会 `app.fire(item.eventName)`；`selectstart` 也会点当前 hover 按钮。
   * - 显隐变化时 `app.fire('xr:menu:active', visible)`（官方注释明确说明这是
   *   给导航脚本做仲裁用的）。
   * - `xr.on('end')` 时自动隐藏并清理；实例唯一 ⇒ 反复开关不会重复订阅。
   */
  export class XrMenu extends Script {
    static scriptName: string;

    menuItems: XrMenuItem[];
    clickSound: Asset | null;
    fontAsset: Asset | null;
    menuOffset: Vec3;
    buttonSpacing: number;
    buttonWidth: number;
    buttonHeight: number;
    fontSize: number;
    menuScale: number;
    followSpeed: number;
    palmUpThreshold: number;
    toggleButtonIndex: number;
    preferredHand: string;
    touchDistance: number;
    pressCooldown: number;
    buttonColor: Color;
    hoverColor: Color;
    pressColor: Color;
    textColor: Color;
    labelTextOpacity: number;
    buttonTexture: Asset | null;
    fadeDuration: number;
    alwaysVisible: boolean;
    followDistance: number;
    followOffset: Vec2;

    /** 按 menuItems 下标改文字（会写回 menuItems，跨重建存活）。 */
    setItemLabel(index: number, text: string): boolean;

    /** 数字行读数。 */
    setItemValue(index: number, value: string): boolean;

    /** 运行时整体缩放（补偿 XR framebuffer 降分辨率）。 */
    setMenuScale(value: number): void;

    /** 当前是否有指针射线停在可交互按钮上（官方给导航脚本做仲裁用）。 */
    readonly isPointerOverMenu: boolean;
  }
}
