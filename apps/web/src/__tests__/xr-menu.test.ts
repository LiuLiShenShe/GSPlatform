/**
 * GS-NEXT-05 —— 官方 XrMenu 适配层（`xrMenu.ts`）纯逻辑 + 舒适过渡状态机。
 *
 * 这里**不测渲染**（真实安装/渲染由 Playwright 真实浏览器用例取证，见
 * `e2e/gsnext05-xr-menu.spec.ts`）。本文件锁三件容易回归的事：
 *   1. 补装官方 UI 组件系统（幂等，官方 App 默认没装）；
 *   2. 菜单行的构成（静态，不做动态列表框架；没有初始位置就不给"返回初始位置"）；
 *   3. 舒适过渡的时序（淡出 → 定位 → 淡入；一次只允许一个在途；只订阅一次 update）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  anchorXrMenuToView,
  buildXrMenuItems,
  createComfortFade,
  ensureXrUiSystems,
  isGamepadButtonPressed,
  menuGlyphSource,
  pickPreferredXrSource,
  shouldHostHandleXrToggle,
  XR_FLOOR_TELEPORT_ALLOWED,
  XR_MENU_EMPTY_LABEL,
  XR_MENU_EVENTS,
  XR_MENU_VIEW_ANCHOR,
  type ComfortVeilSurface,
  type XrToggleInputSource,
} from '../scene-runtime/xrMenu';
import type { AppBase, Entity } from 'playcanvas';
import type { XrMenu } from 'playcanvas/scripts/esm/xr/xr-menu.mjs';
import { Quat, Vec3 } from 'playcanvas';
import { INITIAL_DESTINATION_ID } from '../scene-runtime/xrDestinations';

/** 假 app：只需 systems 的一小部分（真实系统类要真 graphicsDevice，构造不了）。 */
function fakeApp() {
  const systems: Record<string, unknown> = {};
  return {
    systems: Object.assign(systems, {
      add(system: unknown) {
        systems[(system as { id: string }).id] = system;
      },
    }) as Record<string, unknown> & { add(s: unknown): void },
  };
}

/** 假系统工厂（保留真实系统的 id 语义：重名的那一个不该被再次 add）。 */
const FAKE_SYSTEMS: ReadonlyArray<readonly [string, new (app: AppBase) => unknown]> = [
  ['screen', class { id = 'screen'; } as unknown as new (app: AppBase) => unknown],
  ['element', class { id = 'element'; } as unknown as new (app: AppBase) => unknown],
  ['button', class { id = 'button'; } as unknown as new (app: AppBase) => unknown],
];

function fakeSurface() {
  const calls: { opacity: number; enabled: boolean }[] = [];
  const surface: ComfortVeilSurface = {
    setOpacity(value) {
      calls.push({ opacity: value, enabled: false });
    },
    setEnabled(enabled) {
      calls.push({ opacity: 0, enabled });
    },
    destroy() {},
  };
  return { surface, calls };
}

/** 假 app 事件总线（只统计订阅次数与手动 pump）。 */
function fakeEventBus() {
  const listeners: Array<(dt: number) => void> = [];
  const app = {
    on(event: string, fn: (dt: number) => void) {
      if (event === 'update') listeners.push(fn);
    },
    off(_event: string, fn: (dt: number) => void) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return { app, tick(dt: number) { [...listeners].forEach((fn) => fn(dt)); }, count: () => listeners.length };
}

describe('ensureXrUiSystems', () => {
  it('官方 Viewer 的 App 默认没有 Element/Screen/Button —— 一次补齐三个官方系统', () => {
    const app = fakeApp();
    expect(ensureXrUiSystems(app as never, FAKE_SYSTEMS)).toEqual(['screen', 'element', 'button']);
    expect(app.systems.element).toBeTruthy();
    expect(app.systems.screen).toBeTruthy();
    expect(app.systems.button).toBeTruthy();
  });

  it('幂等：已注册的不再 add（systems.add 对重名会抛，重复调用必须跳过）', () => {
    const app = fakeApp();
    ensureXrUiSystems(app as never, FAKE_SYSTEMS);
    expect(ensureXrUiSystems(app as never, FAKE_SYSTEMS)).toEqual([]);
    expect(ensureXrUiSystems(app as never, FAKE_SYSTEMS)).toEqual([]);
  });
});

describe('buildXrMenuItems', () => {
  it('常规形态：当前 + 上一个 + 下一个 + 返回初始位置 + 退出 VR', () => {
    const items = buildXrMenuItems([
      { key: 'initial:xr-initial', kind: 'initial', id: INITIAL_DESTINATION_ID, label: '初始位置' },
      { key: 'guide-point:a', kind: 'guide-point', id: 'a', label: 'A' },
      { key: 'guide-point:b', kind: 'guide-point', id: 'b', label: 'B' },
    ]);
    expect(items.map((i) => i.eventName ?? null)).toEqual([
      null, // 只读标签行
      XR_MENU_EVENTS.prev,
      XR_MENU_EVENTS.next,
      XR_MENU_EVENTS.home,
      XR_MENU_EVENTS.exit,
    ]);
    expect(items[0].label).toBe(''); // 首行由 setCurrentLabel 填
  });

  it('没有初始观察位置时不给"返回初始位置"（不留死按钮）', () => {
    const items = buildXrMenuItems([
      { key: 'guide-point:a', kind: 'guide-point', id: 'a', label: 'A' },
      { key: 'guide-point:b', kind: 'guide-point', id: 'b', label: 'B' },
    ]);
    expect(items.map((i) => i.eventName ?? null)).toEqual([null, XR_MENU_EVENTS.prev, XR_MENU_EVENTS.next, XR_MENU_EVENTS.exit]);
  });

  it('只有一个目的地时退化为「当前 + 退出 VR」（上/下一点没有意义）', () => {
    const items = buildXrMenuItems([
      { key: 'initial:xr-initial', kind: 'initial', id: INITIAL_DESTINATION_ID, label: '初始位置' },
    ]);
    expect(items.map((i) => i.eventName ?? null)).toEqual([null, XR_MENU_EVENTS.home, XR_MENU_EVENTS.exit]);
  });

  it('0 个目的地时仍给出可解释的首行 + 退出 VR（Y 键必须有可见反馈）', () => {
    const items = buildXrMenuItems([], XR_MENU_EMPTY_LABEL);
    expect(items.map((i) => i.eventName ?? null)).toEqual([null, XR_MENU_EVENTS.exit]);
    expect(items[0].label).toBe(XR_MENU_EMPTY_LABEL);
  });

  it('菜单文字全部进字形源（官方 CanvasFont 不会自动补字形）', () => {
    const items = buildXrMenuItems([
      { key: 'initial:xr-initial', kind: 'initial', id: INITIAL_DESTINATION_ID, label: '初始位置' },
      { key: 'guide-point:a', kind: 'guide-point', id: 'a', label: '水井' },
      { key: 'guide-point:b', kind: 'guide-point', id: 'b', label: '石桥' },
    ]);
    const glyphs = menuGlyphSource(items);
    expect(glyphs).toContain('上一个');
    expect(glyphs).toContain('返回初始位置');
    expect(glyphs).toContain('0123456789'); // 序号读数要能画出来
  });
});

describe('XR_FLOOR_TELEPORT_ALLOWED', () => {
  it('恒为 false —— 未校准场景不得出现 Y=0 地面传送（GS-NEXT-05 §4）', () => {
    expect(XR_FLOOR_TELEPORT_ALLOWED).toBe(false);
  });
});

describe('宿主侧菜单开关兜底（PICO 盲区）', () => {
  const src = (
    handedness: string,
    grip: unknown,
    buttons: Array<{ pressed?: boolean; value?: number }> = []
  ): XrToggleInputSource => ({ handedness, grip, gamepad: { buttons } as unknown as Gamepad });

  it('按钮按下判定：pressed 或 value>0.5 都算，缺失/null 不算', () => {
    expect(isGamepadButtonPressed({ pressed: true } as GamepadButton)).toBe(true);
    expect(isGamepadButtonPressed({ pressed: false, value: 0.8 } as GamepadButton)).toBe(true);
    expect(isGamepadButtonPressed({ pressed: false, value: 0.3 } as GamepadButton)).toBe(false);
    expect(isGamepadButtonPressed(null)).toBe(false);
    expect(isGamepadButtonPressed(undefined)).toBe(false);
  });

  it('首选输入源：优先 left，其次任一非 none，全 none 返回 null', () => {
    const left = src('left', {});
    const right = src('right', {});
    const none = src('none', {});
    expect(pickPreferredXrSource([right, left])).toBe(left);
    expect(pickPreferredXrSource([none, right])).toBe(right);
    expect(pickPreferredXrSource([none, none])).toBeNull();
    expect(pickPreferredXrSource([])).toBeNull();
  });

  it('官方能处理的组合交给官方；其余盲区由宿主接管', () => {
    const left = src('left', {}, [{}, {}, {}, {}, { pressed: true }]);
    const right = src('right', {}, [{}, {}, {}, {}, { pressed: true }]);
    // 未按下 → 谁都不管
    expect(shouldHostHandleXrToggle(src('left', {}), 4, left)).toBe(false);
    // 官方组合：首选手柄 + grip + buttons[4] → 留给官方
    expect(shouldHostHandleXrToggle(left, 4, left)).toBe(false);
    // 非首选的手 → 宿主接管
    expect(shouldHostHandleXrToggle(right, 4, left)).toBe(true);
    // 首选手柄无 grip（官方不会跑 _updateControllerMode）→ 宿主接管
    const noGripLeft = src('left', null, [{}, {}, {}, {}, { pressed: true }]);
    expect(shouldHostHandleXrToggle(noGripLeft, 4, noGripLeft)).toBe(true);
    // 首选手柄按 buttons[3]（官方只用 4）→ 宿主接管
    expect(shouldHostHandleXrToggle(src('left', {}, [{}, {}, {}, { pressed: true }, {}]), 3, left)).toBe(true);
  });
});

describe('anchorXrMenuToView（菜单显示在视角右前方，不贴手柄）', () => {
  it('锚点 = 相机前 distance + 右 offsetX + 下 offsetY，并与官方 followCamera 参数一致', () => {
    const camera = {
      getPosition: () => new Vec3(1, 2, 3),
      getRotation: () => new Quat(),
      forward: new Vec3(0, 0, -1),
      right: new Vec3(1, 0, 0),
      up: new Vec3(0, 1, 0),
    } as unknown as Entity;
    const script = { followDistance: 0 } as unknown as XrMenu;
    anchorXrMenuToView(script, camera);
    const anchor = (
      script as unknown as { _getAnchor: () => { position: Vec3; rotation: Quat } | null }
    )._getAnchor();
    expect(anchor).not.toBeNull();
    expect(anchor!.position.x).toBeCloseTo(1 + XR_MENU_VIEW_ANCHOR.offsetX, 6);
    expect(anchor!.position.y).toBeCloseTo(2 + XR_MENU_VIEW_ANCHOR.offsetY, 6);
    expect(anchor!.position.z).toBeCloseTo(3 - XR_MENU_VIEW_ANCHOR.distance, 6);
    expect((script as unknown as { followDistance: number }).followDistance).toBe(
      XR_MENU_VIEW_ANCHOR.distance
    );
    expect(
      (script as unknown as { followOffset: { x: number; y: number } }).followOffset.x
    ).toBeCloseTo(XR_MENU_VIEW_ANCHOR.offsetX, 6);
  });

  it('相机 pose 非有限时返回 null（不把菜单钉到无穷远）', () => {
    const camera = {
      getPosition: () => new Vec3(NaN, 0, 0),
      getRotation: () => new Quat(),
      forward: new Vec3(0, 0, -1),
      right: new Vec3(1, 0, 0),
      up: new Vec3(0, 1, 0),
    } as unknown as Entity;
    const script = {} as unknown as XrMenu;
    anchorXrMenuToView(script, camera);
    const anchor = (script as unknown as { _getAnchor: () => unknown })._getAnchor();
    expect(anchor).toBeNull();
  });
});

describe('createComfortFade', () => {
  it('淡出完成后才执行定位，然后淡入并回到全透明', () => {
    const bus = fakeEventBus();
    const { surface, calls } = fakeSurface();
    const fade = createComfortFade(bus.app, surface, { fadeOutSeconds: 0.1, fadeInSeconds: 0.1 });
    const midpoint = vi.fn();
    expect(fade.run(midpoint)).toBe(true);
    expect(midpoint).not.toHaveBeenCalled();

    bus.tick(0.05); // 半程：还没全黑
    expect(midpoint).not.toHaveBeenCalled();
    bus.tick(0.06); // 到 1.1 > 1 → 全黑，定位在此刻发生
    expect(midpoint).toHaveBeenCalledTimes(1);
    expect(fade.pending).toBe(true);

    bus.tick(0.11);
    expect(fade.pending).toBe(false);
    expect(calls.at(-1)).toEqual({ opacity: 0, enabled: false });
  });

  it('过渡中拒绝新请求（不排队：用户看不清下一个位置）', () => {
    const bus = fakeEventBus();
    const { surface } = fakeSurface();
    const fade = createComfortFade(bus.app, surface, { fadeOutSeconds: 0.1, fadeInSeconds: 0.1 });
    const first = vi.fn();
    const second = vi.fn();
    expect(fade.run(first)).toBe(true);
    expect(fade.run(second)).toBe(false);
    bus.tick(0.2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('一次只订阅一个 update（反复传送不会累积监听器）', () => {
    const bus = fakeEventBus();
    const { surface } = fakeSurface();
    const fade = createComfortFade(bus.app, surface, { fadeOutSeconds: 0.1, fadeInSeconds: 0.1 });
    expect(bus.count()).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      fade.run(() => undefined);
      bus.tick(0.3);
    }
    expect(bus.count()).toBe(1);
  });

  it('定位抛错不会把状态机卡在全黑', () => {
    const bus = fakeEventBus();
    const { surface, calls } = fakeSurface();
    const fade = createComfortFade(bus.app, surface, { fadeOutSeconds: 0.1, fadeInSeconds: 0.1 });
    fade.run(() => {
      throw new Error('rig missing');
    });
    bus.tick(0.2);
    bus.tick(0.2);
    expect(fade.pending).toBe(false);
    expect(calls.at(-1)).toEqual({ opacity: 0, enabled: false });
  });

  it('reset（XR 会话结束）立刻撤销黑纱；destroy 摘掉订阅并销毁表面', () => {
    const bus = fakeEventBus();
    const destroyed = { value: false };
    const surface: ComfortVeilSurface = {
      setOpacity() {},
      setEnabled() {},
      destroy() {
        destroyed.value = true;
      },
    };
    const fade = createComfortFade(bus.app, surface);
    fade.run(() => undefined);
    fade.reset();
    expect(fade.pending).toBe(false);
    fade.destroy();
    expect(bus.count()).toBe(0);
    expect(destroyed.value).toBe(true);
  });
});
