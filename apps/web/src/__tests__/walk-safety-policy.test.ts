/**
 * GS-DESKTOP-04 §六 —— Walk 平台安全闸门（唯一权威判定）。
 *
 * ## 官方 1.35.0 事实依据（dist/viewer.js）
 *
 *     const WALK_MIN_HORIZONTAL_RANGE = 5;
 *     const isWalkAllowed = (bbox, collision) =>
 *         !!collision && x * 2 >= WALK_MIN_HORIZONTAL_RANGE && z * 2 >= WALK_MIN_HORIZONTAL_RANGE;
 *
 * `inputEvent 'toggleWalk'`（官方 Walk 按钮 + 键盘 `3`）：
 *
 *     case 'toggleWalk':
 *         if (walkAllowed) { ... }
 *
 * WASD：`requestFirstPerson` → `state.cameraMode = walkAllowed ? 'walk' : 'fly'`。
 * 即**官方所有 walk 入口都只查 `walkAllowed`，而这个值只取决于「有没有碰撞数据 +
 * 场景够不够大」**。宿主拦不住键盘（旧实现只隐藏按钮，实测键盘 3 仍能进 fly/walk）。
 *
 * ## 本模块的策略
 *
 * 平台判定不安全 → **不向官方注入碰撞资源** → 官方 `walkAllowed === false` →
 * 官方自己让所有入口变 no-op。这才是根本修复，不隐藏按钮、不改官方只读状态、
 * 不为测试降低规则。
 *
 * ## 本文件锁定的契约
 *
 *   - 无碰撞 / enabled=false / STALE / URL 缺失 / 官方未 attach / 尺度未校准
 *     → safe=false（对应 reason），且 `resolveWalkCollisionUrl` 返回 undefined；
 *   - 全部通过 → safe=true 且返回碰撞 URL；
 *   - `enabled=false` 已包含后端「未校准」语义（scene_runtime.py 把
 *     physicalWalkAllowed 折进 enabled），因此 UNVERIFIED 场景必然拿不到 URL。
 */
import { describe, expect, it } from 'vitest';
import {
  decideWalkSafety,
  resolveWalkCollisionUrl,
  shouldBlockWalkEntry,
  walkAllowedByPlatform,
} from '../scene-runtime/walkSafetyPolicy';
import { assessSceneScale } from '../scene-runtime/sceneScale';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';

const COLLISION_URL = '/api/v1/scenes/x/collision.glb';

const METER_BOUNDS = { min: [-5, 0, -5], max: [5, 3, 5], size: [10, 3, 10] };
const CM_BOUNDS = { min: [0, 0, 0], max: [0.5, 0.4, 0.5], size: [0.5, 0.4, 0.5] };

const meterScale = assessSceneScale(METER_BOUNDS);
const cmScale = assessSceneScale(CM_BOUNDS);

function descriptorWithCollision(
  overrides: { enabled?: boolean; stale?: boolean; url?: string | null } = {},
): SceneRuntimeDescriptorV1 {
  const { enabled = true, stale = false, url = COLLISION_URL } = overrides;
  return {
    ...runtimeDescriptorFixture,
    collision: {
      url,
      format: 'glb',
      mode: 'OUTDOOR',
      gravity: 9.81,
      slopeLimitDegrees: 45,
      stepOffset: 0.3,
      playerHeight: 1.8,
      enabled,
      stale,
      worldTransformHash: null,
    },
  };
}

describe('decideWalkSafety', () => {
  it('无碰撞块 → no-collision，不安全', () => {
    const d = decideWalkSafety({ descriptor: { ...runtimeDescriptorFixture, collision: null } });
    expect(d.safe).toBe(false);
    expect(d.reason).toBe('no-collision');
    expect(shouldBlockWalkEntry(d)).toBe(true);
  });

  it('碰撞未启用（含后端「未校准」折入）→ collision-disabled', () => {
    const d = decideWalkSafety({
      descriptor: descriptorWithCollision({ enabled: false }),
      officialHasCollision: false,
      sceneScale: meterScale,
    });
    expect(d.safe).toBe(false);
    expect(d.reason).toBe('collision-disabled');
    expect(d.collisionEnabled).toBe(false);
  });

  it('碰撞 STALE（世界变换/版本/空间绑定变更）→ collision-stale', () => {
    const d = decideWalkSafety({
      descriptor: descriptorWithCollision({ stale: true }),
      officialHasCollision: true,
      sceneScale: meterScale,
    });
    expect(d.safe).toBe(false);
    expect(d.reason).toBe('collision-stale');
  });

  it('碰撞 URL 缺失 → collision-url-missing', () => {
    const d = decideWalkSafety({
      descriptor: descriptorWithCollision({ url: null }),
      officialHasCollision: false,
      sceneScale: meterScale,
    });
    expect(d.safe).toBe(false);
    expect(d.reason).toBe('collision-url-missing');
  });

  it('官方尚未 attach 碰撞 → collision-not-attached', () => {
    const d = decideWalkSafety({
      descriptor: descriptorWithCollision(),
      officialHasCollision: false,
      sceneScale: meterScale,
    });
    expect(d.safe).toBe(false);
    expect(d.reason).toBe('collision-not-attached');
  });

  it('尺度未校准（厘米数据被当米用）→ scene-scale-uncalibrated', () => {
    const d = decideWalkSafety({
      descriptor: descriptorWithCollision(),
      officialHasCollision: true,
      sceneScale: cmScale,
    });
    expect(d.safe).toBe(false);
    expect(d.reason).toBe('scene-scale-uncalibrated');
  });

  it('创建前（尚无官方状态/尺度）→ 允许注入（预加载判定只看描述符）', () => {
    // 这是 Viewer 创建时唯一可用的信息：官方 hasCollision 只有加载完成后才
    // 存在。此时只能看描述符（enabled && !stale），加载后再用完整条件复核，
    // 不通过则受控重建撤销碰撞。
    const d = decideWalkSafety({ descriptor: descriptorWithCollision() });
    expect(d.safe).toBe(true);
  });

  it('全部条件满足 → ok，安全', () => {
    const d = decideWalkSafety({
      descriptor: descriptorWithCollision(),
      officialHasCollision: true,
      sceneScale: meterScale,
    });
    expect(d.safe).toBe(true);
    expect(d.reason).toBe('ok');
    expect(shouldBlockWalkEntry(d)).toBe(false);
    expect(walkAllowedByPlatform({
      descriptor: descriptorWithCollision(),
      officialHasCollision: true,
      sceneScale: meterScale,
    })).toBe(true);
  });

  it('没有描述符 → 不安全', () => {
    expect(decideWalkSafety({ descriptor: null }).safe).toBe(false);
  });
});

describe('resolveWalkCollisionUrl（唯一的 walk 安全闸门实现）', () => {
  it('不安全 → 不注入任何碰撞资源（官方 walkAllowed 因此恒为 false）', () => {
    const desc = descriptorWithCollision();
    expect(
      resolveWalkCollisionUrl({
        descriptor: desc,
        officialHasCollision: false,
        sceneScale: meterScale,
      }),
    ).toBeUndefined();
    expect(
      resolveWalkCollisionUrl({
        descriptor: desc,
        officialHasCollision: true,
        sceneScale: cmScale,
      }),
    ).toBeUndefined();
    expect(
      resolveWalkCollisionUrl({
        descriptor: descriptorWithCollision({ stale: true }),
        officialHasCollision: true,
        sceneScale: meterScale,
      }),
    ).toBeUndefined();
  });

  it('安全 → 注入碰撞 URL', () => {
    expect(
      resolveWalkCollisionUrl({
        descriptor: descriptorWithCollision(),
        officialHasCollision: true,
        sceneScale: meterScale,
      }),
    ).toBe(COLLISION_URL);
  });

  it('碰撞已启用但官方没 attach → 不给 URL（加载早期不得提前放行）', () => {
    expect(
      resolveWalkCollisionUrl({
        descriptor: descriptorWithCollision(),
        officialHasCollision: false,
        sceneScale: meterScale,
      }),
    ).toBeUndefined();
  });
});
