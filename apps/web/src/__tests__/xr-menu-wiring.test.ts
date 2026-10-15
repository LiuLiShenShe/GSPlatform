/**
 * GS-NEXT-05 —— 官方 XrMenu 会话内导览的**接线**测试（`SuperSplatRuntime` 侧）。
 *
 * 分工：
 *   - 目的地准入规则 → `xr-destinations.test.ts`（纯函数）
 *   - Rig 定位数学（含 20 次不漂移） → `xr-rig-pose.test.ts`（真实 Entity）
 *   - 菜单行 / 舒适过渡状态机 → `xr-menu.test.ts`
 *   - **本文件**：runtime 与官方脚本的接线 —— 装在哪、事件怎么来、仲裁怎么落、
 *     销毁是否干净。
 *
 * 这里 mock 掉 `xrMenu` 里三个需要真实 graphicsDevice/Canvas2D 的重活
 * （官方组件系统、CanvasFont、菜单实例、黑纱），保留真实的
 * Rig 定位数学与目的地规则 —— mock 掉的东西正是真实浏览器用例
 * （`e2e/gsnext05-xr-menu.spec.ts`）逐条取证的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Entity, EventHandler } from 'playcanvas';

vi.mock('@playcanvas/supersplat-viewer/viewer', () => ({ createViewer: vi.fn() }));

vi.mock('../scene-runtime/xrMenu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scene-runtime/xrMenu')>();
  return {
    ...actual,
    ensureXrUiSystems: vi.fn(() => ['screen', 'element', 'button']),
    createXrMenuFont: vi.fn(() => ({
      asset: { id: 999 },
      font: {},
      destroy: vi.fn(),
    })),
    installXrMenu: vi.fn(() => ({
      script: {},
      setCurrentLabel: vi.fn(() => true),
      isPointerOverMenu: vi.fn(() => false),
      destroy: vi.fn(),
    })),
    createComfortVeil: vi.fn(() => ({
      setOpacity: vi.fn(),
      setEnabled: vi.fn(),
      destroy: vi.fn(),
    })),
    // 黑纱状态机在 xr-menu.test.ts 里单独测；这里用"可控立即执行"版本接线。
    createComfortFade: vi.fn(() => ({
      run: vi.fn((midpoint: () => void) => {
        lastMidpoint = midpoint;
        return true;
      }),
      pending: false,
      reset: vi.fn(),
      destroy: vi.fn(),
    })),
    uiLayerId: vi.fn(() => 4),
  };
});

import { createViewer, type ViewerHandle } from '@playcanvas/supersplat-viewer/viewer';
import { SuperSplatRuntime } from '../scene-runtime/SuperSplatRuntime';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import { destinationKey, INITIAL_DESTINATION_ID } from '../scene-runtime/xrDestinations';
import {
  installXrMenu,
  createXrMenuFont,
  createComfortFade,
  XR_MENU_ACTIVE_EVENT,
  XR_MENU_EVENTS,
} from '../scene-runtime/xrMenu';
import type { RuntimeAnnotation, RuntimeViewpoint } from '../scene-runtime/types';

const mockedCreateViewer = vi.mocked(createViewer);
const mockedInstall = vi.mocked(installXrMenu);
const mockedFont = vi.mocked(createXrMenuFont);
const mockedFade = vi.mocked(createComfortFade);

/** 最近一次 fade 的 midpoint（测试手动触发，模拟"全黑那一帧"）。 */
let lastMidpoint: (() => void) | null = null;

/** 官方 XrNavigation 的最小替身（只暴露本层允许碰的那个开关）。 */
interface NavStub {
  enableTeleport: boolean;
  enableMove: boolean;
  turnMode: string;
  enableSnapVertical: boolean;
}

const AUTHORED = { position: [0, 1.2, 3.5] as [number, number, number], target: [0, 0.8, 0] as [number, number, number], fov: 55 };
const VP: RuntimeViewpoint = {
  id: 'vp-1',
  name: '入口',
  position: { x: 0, y: 1.6, z: 3.5 },
  target: { x: 0, y: 1.0, z: 0 },
  fov: 55,
  orderIndex: 0,
  enabled: true,
};
/** 带作者化相机的标注（官方 settings 侧有一份 RUNTIME 空间的 camera.initial）。 */
const GP: RuntimeAnnotation = {
  id: 'ann-1',
  title: '水井',
  description: '',
  anchor: { x: 0, y: 0, z: 0 },
  style: 'LEADER_TEXT',
  contentType: 'TEXT',
  textContent: '',
  mediaAssetUrl: null,
  textColor: '#FFF',
  textSize: 14,
  fov: 60,
  cameraPosition: { x: -3, y: 1.9, z: 2 },
  cameraTarget: { x: -1.2, y: 0.4, z: 0.4 },
  cameraFov: 45,
  orderIndex: 0,
  enabled: true,
};

/** 官方 annotation 数组（handle.annotations）：带 GSPlatform extras 协议。 */
function officialAnnotations(): unknown[] {
  return [
    {
      position: [0, 0, 0],
      title: '水井',
      text: '',
      camera: { initial: { position: [-3, 1.9, 2], target: [-1.2, 0.4, 0.4], fov: 45 } },
      extras: { gsplatform: { annotationId: 'ann-1', contentType: 'TEXT' } },
    },
  ];
}

interface Harness {
  app: EventHandler;
  xr: EventHandler & { active: boolean; type: string; camera: Entity | null };
  rig: Entity;
  camera: Entity;
  nav: NavStub;
  updateListeners: () => number;
}

function makeHarness(): Harness {
  const root = new Entity('root');
  const rig = new Entity('xr-rig');
  const camera = new Entity('camera');
  root.addChild(rig);
  rig.addChild(camera);
  camera.setLocalPosition(0, 1.7, 0);
  const nav: NavStub = { enableTeleport: true, enableMove: true, turnMode: 'snap', enableSnapVertical: true };
  (rig as unknown as { script: unknown }).script = {
    get: (name: string) => (name === 'xrNavigation' ? nav : null),
    create: vi.fn(),
    destroy: vi.fn(() => true),
  };
  const xr = Object.assign(new EventHandler(), {
    active: false,
    type: 'immersive-vr',
    spaceType: 'local-floor',
    camera,
  });
  const app = Object.assign(new EventHandler(), {
    graphicsDevice: { deviceType: 'webgl2' },
    stats: { frame: { gsplats: 1 } },
    root,
    systems: {} as Record<string, unknown>,
    assets: { add: vi.fn(), remove: vi.fn(() => true), filter: vi.fn(() => []) },
    scene: { layers: { getLayerByName: () => ({ id: 4 }) } },
    xr,
  });
  return { app, xr, rig, camera, nav, updateListeners: () => 0 };
}

async function createXR(overrides: Record<string, unknown> = {}) {
  const h = makeHarness();
  const handle = {
    app: h.app,
    state: {
      loaded: true,
      progress: 100,
      cameraMode: 'orbit',
      performanceMode: false,
      walkAllowed: false,
      hasCollision: false,
      selectedAnnotation: null,
      isFullscreen: false,
      canStartVR: true,
      canStartAR: false,
      xrMode: null,
    },
    events: new EventHandler(),
    annotations: officialAnnotations(),
    captureFrame: vi.fn(),
    seek: vi.fn(),
    frameScene: vi.fn(),
    resetCamera: vi.fn(),
    toggleWalk: vi.fn(),
    selectAnnotation: vi.fn(),
    setMoveInput: vi.fn(),
    requestFullscreen: vi.fn(),
    exitFullscreen: vi.fn(),
    startXR: vi.fn(async () => {
      h.xr.active = true;
      h.xr.fire('start');
    }),
    endXR: vi.fn(async () => {
      h.xr.active = false;
      h.xr.fire('end');
    }),
    destroy: vi.fn(),
  } as unknown as ViewerHandle;
  mockedCreateViewer.mockResolvedValue(handle);
  const runtime = await SuperSplatRuntime.create({
    container: document.createElement('div'),
    contentUrl: '/local-scenes/r-8c4e2264e86a/versions/b/lod-meta.json',
    settings: buildExperienceSettings(runtimeDescriptorFixture),
    mode: 'xr',
    xrInitialCamera: AUTHORED,
    viewpoints: [VP],
    guidePoints: [GP],
    ...overrides,
  });
  return { runtime, harness: h, handle };
}

beforeEach(() => {
  mockedCreateViewer.mockReset();
  mockedInstall.mockClear();
  mockedFont.mockClear();
  mockedFade.mockClear();
  lastMidpoint = null;
});

describe('官方 XrMenu 安装（GS-NEXT-05 §2）', () => {
  it('挂在官方 XR Rig（相机父实体）上，并把目的地列表交给官方菜单', async () => {
    const { harness } = await createXR();
    expect(mockedInstall).toHaveBeenCalledTimes(1);
    const call = mockedInstall.mock.calls[0][0];
    expect(call.rig).toBe(harness.rig);
    expect(call.items.map((i) => i.eventName ?? null)).toEqual([
      null,
      XR_MENU_EVENTS.prev,
      XR_MENU_EVENTS.next,
      XR_MENU_EVENTS.home,
      XR_MENU_EVENTS.exit,
    ]);
    // 菜单用系统字体栈（不打包字体文件）+ 预生成字形
    expect(call.font.font).toBeDefined();
  });

  it('没有 authored 初始相机 → 菜单行里没有"返回初始位置"', async () => {
    await createXR({ xrInitialCamera: null });
    const call = mockedInstall.mock.calls[0][0];
    expect(call.items.some((i) => i.eventName === XR_MENU_EVENTS.home)).toBe(false);
  });

  it('无任何目的地时不装菜单（不给全是死按钮的菜单），进入 VR 仍然可用', async () => {
    const { runtime } = await createXR({ xrInitialCamera: null, viewpoints: [], guidePoints: [] });
    expect(mockedInstall).not.toHaveBeenCalled();
    expect(runtime.xrMenuInfo().state).toBe('empty');
    expect(runtime.xrMenuInfo().destinationCount).toBe(0);
    expect(runtime.loaded).toBe(true);
  });
});

describe('地板传送仲裁（GS-NEXT-05 §4）', () => {
  it('官方 XrNavigation 的 floor teleport 恒为关闭，其余开关一个都不碰', async () => {
    const { harness } = await createXR();
    expect(harness.nav.enableTeleport).toBe(false);
    // 摇杆移动 / snap turn / 垂直 snap 保持官方默认值
    expect(harness.nav.enableMove).toBe(true);
    expect(harness.nav.turnMode).toBe('snap');
    expect(harness.nav.enableSnapVertical).toBe(true);
  });

  it('菜单打开 / 指针停在按钮上时也不会打开地板传送', async () => {
    const { harness, runtime } = await createXR();
    harness.app.fire(XR_MENU_ACTIVE_EVENT, true);
    expect(runtime.xrMenuInfo().menuVisible).toBe(true);
    expect(harness.nav.enableTeleport).toBe(false);
    harness.app.fire(XR_MENU_ACTIVE_EVENT, false);
    expect(runtime.xrMenuInfo().menuVisible).toBe(false);
    expect(harness.nav.enableTeleport).toBe(false);
  });
});

describe('目的地准入（GS-NEXT-05 §5-9）', () => {
  it('初始位置 + 观察点 + 导览点共 3 个（按数据库 ID，不是数组下标）', async () => {
    const { runtime } = await createXR();
    const info = runtime.xrMenuInfo();
    expect(info.destinationCount).toBe(3);
    expect(info.currentDestination).toBe(destinationKey('initial', INITIAL_DESTINATION_ID));
    expect(info.currentLabel).toContain('初始位置');
  });

  it('标注在官方数组里查不到（已删除 / 无 extras 协议）→ 不提供该导览点', async () => {
    const { runtime } = await createXR({
      guidePoints: [{ ...GP, id: 'ann-gone' }],
    });
    const info = runtime.xrMenuInfo();
    expect(info.destinationCount).toBe(2);
    expect(info.currentDestination).not.toContain('ann-gone');
  });

  it('停用的观察点不提供', async () => {
    const { runtime } = await createXR({ viewpoints: [{ ...VP, enabled: false }] });
    expect(runtime.xrMenuInfo().destinationCount).toBe(2);
  });

  it('setXRDestination 对未知 key 只会落到 0 号，不会崩', async () => {
    const { runtime } = await createXR();
    runtime.setXRDestination('guide-point:不存在');
    expect(runtime.xrMenuInfo().currentDestination).toBe(destinationKey('initial', INITIAL_DESTINATION_ID));
  });
});

describe('菜单事件 → 舒适过渡 → Rig 定位（GS-NEXT-05 §3）', () => {
  it('下一个：先淡出、全黑时移动 Rig、淡入；顺序与官方事件绑定', async () => {
    const { runtime, harness } = await createXR();
    const fade = mockedFade.mock.results[0].value as { run: ReturnType<typeof vi.fn> };
    harness.xr.active = true;
    harness.xr.type = 'immersive-vr';

    harness.app.fire(XR_MENU_EVENTS.next);
    // 过渡还没跑完 → rig 未动（用户看不到世界跳变）
    expect(harness.camera.getPosition().x).toBeCloseTo(0, 6);
    expect(runtime.xrMenuInfo().currentDestination).toBe(destinationKey('viewpoint', 'vp-1'));

    lastMidpoint?.();
    const eye = harness.camera.getPosition();
    expect(eye.x).toBeCloseTo(VP.position.x, 4);
    expect(eye.y).toBeCloseTo(VP.position.y, 4);
    expect(eye.z).toBeCloseTo(VP.position.z, 4);
    // 6DoF 保留：头显局部位置不变
    expect(harness.camera.getLocalPosition().y).toBeCloseTo(1.7, 5);
    expect(fade.run).toHaveBeenCalledTimes(1);
  });

  it('上一个 / 下一个环形：initial → vp → ann → initial（验收 §5-2/§5-3）', async () => {
    const { runtime, harness } = await createXR();
    harness.xr.active = true;
    const order = [
      'viewpoint:vp-1',
      'guide-point:ann-1',
      `initial:${INITIAL_DESTINATION_ID}`,
    ];
    const seen: string[] = [];
    for (const step of ['next', 'next', 'next'] as const) {
      harness.app.fire(XR_MENU_EVENTS[step]);
      lastMidpoint?.();
      seen.push(runtime.xrMenuInfo().currentDestination ?? '');
    }
    expect(seen).toEqual(order);
  });

  it('返回初始位置：回到 authored 初始相机，并把出生位姿一并更新', async () => {
    const { runtime, harness } = await createXR();
    harness.xr.active = true;
    harness.app.fire(XR_MENU_EVENTS.next);
    lastMidpoint?.();
    harness.app.fire(XR_MENU_EVENTS.home);
    lastMidpoint?.();
    const eye = harness.camera.getPosition();
    expect(eye.x).toBeCloseTo(AUTHORED.position[0], 4);
    expect(eye.y).toBeCloseTo(AUTHORED.position[1], 4);
    expect(eye.z).toBeCloseTo(AUTHORED.position[2], 4);
    const xrState = runtime.getXRState() as { spawnStatus: string };
    expect(xrState.spawnStatus).toBe('not-entered');
  });

  it('退出 VR：只登记出生位姿，不移动 Rig（不在会话内就不动官方相机）', async () => {
    const { runtime, harness } = await createXR();
    harness.xr.active = false;
    const before = harness.camera.getPosition().clone();
    expect(runtime.gotoXrDestination(destinationKey('viewpoint', 'vp-1'))).toBe(true);
    expect(harness.camera.getPosition().equals(before)).toBe(true);
    expect(runtime.xrMenuInfo().currentDestination).toBe(destinationKey('viewpoint', 'vp-1'));
  });

  it('目的地解析不出 pose 时拒绝传送（返回 false，不改状态）', async () => {
    const { runtime, harness } = await createXR();
    harness.xr.active = true;
    expect(runtime.gotoXrDestination('guide-point:ann-gone')).toBe(false);
    expect(runtime.xrMenuInfo().currentDestination).toBe(destinationKey('initial', INITIAL_DESTINATION_ID));
  });

  it('退出 VR 按钮走现有 Viewer 退出入口（官方 endXR），不自建会话控制', async () => {
    const { harness, handle } = await createXR();
    harness.xr.active = true;
    harness.app.fire(XR_MENU_EVENTS.exit);
    await Promise.resolve();
    expect(vi.mocked(handle.endXR)).toHaveBeenCalled();
  });
});

describe('生命周期与清理（GS-NEXT-05 §4/§5-8）', () => {
  it('XR 结束时撤销黑纱、复位菜单可见态', async () => {
    const { runtime, harness } = await createXR();
    const fade = mockedFade.mock.results[0].value as { reset: ReturnType<typeof vi.fn> };
    harness.app.fire(XR_MENU_ACTIVE_EVENT, true);
    expect(runtime.xrMenuInfo().menuVisible).toBe(true);
    harness.xr.fire('end');
    expect(fade.reset).toHaveBeenCalled();
    expect(runtime.xrMenuInfo().menuVisible).toBe(false);
  });

  it('销毁：菜单 / 字体 / 黑纱都释放；菜单事件不再触发（无多重订阅）', async () => {
    const { runtime, harness } = await createXR();
    const menu = mockedInstall.mock.results[0].value as { destroy: ReturnType<typeof vi.fn> };
    const font = mockedFont.mock.results[0].value as { destroy: ReturnType<typeof vi.fn> };
    const fade = mockedFade.mock.results[0].value as { destroy: ReturnType<typeof vi.fn> };
    runtime.destroy();
    expect(menu.destroy).toHaveBeenCalledTimes(1);
    expect(font.destroy).toHaveBeenCalledTimes(1);
    expect(fade.destroy).toHaveBeenCalledTimes(1);
    const before = mockedFade.mock.results[0].value.run.mock.calls.length;
    harness.app.fire(XR_MENU_EVENTS.next);
    expect(mockedFade.mock.results[0].value.run.mock.calls.length).toBe(before);
  });

  it('反复开关菜单 / 重新触发 install 不会重复安装或重复订阅', async () => {
    const { harness } = await createXR();
    for (let i = 0; i < 20; i += 1) {
      harness.app.fire(XR_MENU_ACTIVE_EVENT, i % 2 === 0);
    }
    harness.xr.fire('available');
    harness.xr.fire('available');
    expect(mockedInstall).toHaveBeenCalledTimes(1);
  });
});
