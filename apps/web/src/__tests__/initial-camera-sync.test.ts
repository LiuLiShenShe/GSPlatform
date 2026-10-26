/**
 * GS-DESKTOP-04 §三 —— 初始相机同步策略（同会话保存后官方 Reset 也采用新视角）。
 *
 * ## 官方 1.35.0 事实依据（dist/viewer.js）
 *
 * `CameraManager` 构造时：
 *
 *     const camera0 = settings.cameras[0]?.initial;
 *     const resetCamera = camera0 ? createCamera(new Vec3(camera0.position),
 *         new Vec3(camera0.target), camera0.fov) : frameCamera;
 *
 * `inputEvent 'reset'`（官方 Reset 按钮 / 键盘 `r` / 宿主 `resetCamera()`）：
 *
 *     case 'reset':
 *         ...
 *         controllers.orbit.goto(resetCamera);   // 闭包常量
 *
 * 即 **Reset 目标 = 构造那一刻的 settings.cameras[0].initial**。官方公开句柄
 * （docs/api.md）没有任何 settings 更新 / 初始相机更新入口，因此保存后同会话
 * 更新 Reset 目标的唯一受支持路径 = 用含新视角的 settings 重建 Viewer。
 *
 * ## 本文件锁定的契约
 *
 *  1. 保存成功且描述符采用 → 'resync-needed'（一次）；
 *  2. 同一目标重复评估 → 'already-synced'（不重复重建 → 无 13M 场景无限重载）；
 *  3. 保存失败 / 后端丢弃（描述符无 initialCamera）→ 'ignored'（绝不重建）；
 *  4. 连续保存 B → D：两次都 resync，最终同步目标 = D；
 *  5. 重建后 adopt 会记录新目标，之后同目标评估不再重建。
 */
import { describe, expect, it } from 'vitest';
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import {
  createInitialCameraSync,
  initialCameraKey,
  savedViewMatchesDescriptor,
} from '../scene-runtime/initialCameraSync';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';

const A: CameraPose = { position: [2.5, 1.8, 6.0], target: [0.0, 0.6, 0.0], fov: 47 };
const B: CameraPose = { position: [3.7083, 0.7145, 2.5372], target: [0.0009, 0.6, 0.0006], fov: 47 };
const C: CameraPose = { position: [1.2420, 1.7603, 4.1609], target: [-0.0237, 0.5779, -0.0793], fov: 47 };
const D: CameraPose = { position: [-1.5, 2.2, 5.0], target: [0.1, 0.4, 0.0], fov: 60 };

function descriptorWithCamera(
  initialCamera: SceneRuntimeDescriptorV1['presentation']['initialCamera'],
): SceneRuntimeDescriptorV1 {
  return {
    ...runtimeDescriptorFixture,
    presentation: {
      ...runtimeDescriptorFixture.presentation,
      initialCamera,
    },
  };
}

function descriptorWith(pose: CameraPose | null): SceneRuntimeDescriptorV1 {
  if (!pose) {
    return descriptorWithCamera({ position: null, target: null, fov: null });
  }
  return descriptorWithCamera({
    position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
    target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
    fov: pose.fov,
  });
}

describe('savedViewMatchesDescriptor（后端是否真的采用了该视角）', () => {
  it('描述符等于保存视角 → true', () => {
    expect(savedViewMatchesDescriptor(B, descriptorWith(B))).toBe(true);
  });

  it('描述符仍是旧视角 → false（不得据此重建）', () => {
    expect(savedViewMatchesDescriptor(B, descriptorWith(A))).toBe(false);
  });

  it('描述符没有 initialCamera（空间绑定失效）→ false', () => {
    expect(savedViewMatchesDescriptor(B, descriptorWith(null))).toBe(false);
  });

  it('描述符为 null → false', () => {
    expect(savedViewMatchesDescriptor(B, null)).toBe(false);
  });

  it('浮点尾差在容差内仍算匹配', () => {
    const noisy = descriptorWith({
      ...B,
      position: [3.7083070278167725, 0.71451336145401, 2.537242889404297],
    });
    expect(savedViewMatchesDescriptor(B, noisy)).toBe(true);
  });
});

describe('完整姿态契约（position + target + FOV，follow-up §三）', () => {
  const saved: CameraPose = { position: [3.7, 0.7, 2.5], target: [0.0, 0.6, 0.0], fov: 47 };

  it('position 正确、target 错误 → 拒绝', () => {
    const desc = descriptorWithCamera({
      position: { x: 3.7, y: 0.7, z: 2.5 },
      target: { x: 0.5, y: 0.6, z: 0.0 },
      fov: 47,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(false);
  });

  it('position、target 正确但 FOV 错误 → 拒绝（旧 FOV 不算已采用）', () => {
    const desc = descriptorWithCamera({
      position: { x: 3.7, y: 0.7, z: 2.5 },
      target: { x: 0.0, y: 0.6, z: 0.0 },
      fov: 85,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(false);
  });

  it('描述符 FOV 为 null → 不能确认完整姿态已被采用', () => {
    const desc = descriptorWithCamera({
      position: { x: 3.7, y: 0.7, z: 2.5 },
      target: { x: 0.0, y: 0.6, z: 0.0 },
      fov: null,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(false);
  });

  it('描述符 FOV 为非有限数 → 不能确认', () => {
    const desc = descriptorWithCamera({
      position: { x: 3.7, y: 0.7, z: 2.5 },
      target: { x: 0.0, y: 0.6, z: 0.0 },
      fov: Number.NaN,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(false);
  });

  it('完整姿态匹配 → 允许同步', () => {
    const desc = descriptorWithCamera({
      position: { x: 3.7, y: 0.7, z: 2.5 },
      target: { x: 0.0, y: 0.6, z: 0.0 },
      fov: 47,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(true);
  });

  it('position / target / FOV 的合理浮点尾差仍匹配', () => {
    // 用运算生成尾差（避免写出会丢精度的字面量）：远小于 1e-4 / 1e-3 容差。
    const desc = descriptorWithCamera({
      position: { x: 3.7 + 1e-9, y: 0.7 - 1e-9, z: 2.5 + 1e-9 },
      target: { x: 1e-12, y: 0.6 + 1e-9, z: -1e-12 },
      fov: 47 + 1e-9,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(true);
  });

  it('FOV 尾差超出容差（0.01°）→ 拒绝', () => {
    const desc = descriptorWithCamera({
      position: { x: 3.7, y: 0.7, z: 2.5 },
      target: { x: 0.0, y: 0.6, z: 0.0 },
      fov: 47.01,
    });
    expect(savedViewMatchesDescriptor(saved, desc)).toBe(false);
  });
});

describe('initialCameraKey（Reset 目标去重）', () => {
  it('同 pose 不同对象 → 同 key', () => {
    expect(initialCameraKey(descriptorWith(B))).toBe(initialCameraKey(descriptorWith(B)));
  });

  it('不同 pose → 不同 key', () => {
    expect(initialCameraKey(descriptorWith(A))).not.toBe(initialCameraKey(descriptorWith(B)));
  });

  it('FOV 变化也算不同目标', () => {
    expect(initialCameraKey(descriptorWith(B))).not.toBe(
      initialCameraKey(descriptorWith({ ...B, fov: 50 })),
    );
  });

  it('无 initialCamera → "absent"', () => {
    expect(initialCameraKey(descriptorWith(null))).toBe('absent');
  });
});

describe('createInitialCameraSync（一次保存最多一次受控重建）', () => {
  it('A→B 保存→C：需要一次重建', () => {
    const sync = createInitialCameraSync();
    // 当前 Viewer 的 Reset 目标 = A（初始加载时 adopt 的）
    sync.adopt(descriptorWith(A));
    expect(sync.evaluate(B, descriptorWith(B))).toBe('resync-needed');
  });

  it('同一目标重复评估不会重复重建（13M 场景不得无限重载）', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(A));
    expect(sync.evaluate(B, descriptorWith(B))).toBe('resync-needed');
    expect(sync.evaluate(B, descriptorWith(B))).toBe('resync-needed');
    // 重建完成、新 Viewer loaded 后 adopt → 之后同一目标不再重建
    sync.adopt(descriptorWith(B));
    expect(sync.evaluate(B, descriptorWith(B))).toBe('already-synced');
    expect(sync.syncedKey()).toBe(initialCameraKey(descriptorWith(B)));
  });

  it('保存失败（后端没采用）→ ignored，绝不重建', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(A));
    expect(sync.evaluate(B, descriptorWith(A))).toBe('ignored');
    sync.markSaveFailed();
    expect(sync.evaluate(B, descriptorWith(A))).toBe('ignored');
    // 官方 Reset 目标仍应是 A
    expect(sync.syncedKey()).toBe(initialCameraKey(descriptorWith(A)));
  });

  it('描述符丢弃 initialCamera（空间绑定失效）→ ignored', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(A));
    expect(sync.evaluate(B, descriptorWith(null))).toBe('ignored');
  });

  it('连续快速保存 B → D：两次都 resync，最终目标是 D', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(A));
    // 第一次保存 B
    expect(sync.evaluate(B, descriptorWith(B))).toBe('resync-needed');
    sync.adopt(descriptorWith(B));
    // 第二次保存 D（重建尚未完成也会各自推进一次）
    expect(sync.evaluate(D, descriptorWith(D))).toBe('resync-needed');
    sync.adopt(descriptorWith(D));
    expect(sync.evaluate(D, descriptorWith(D))).toBe('already-synced');
    expect(sync.syncedKey()).toBe(initialCameraKey(descriptorWith(D)));
  });

  it('只改 FOV 的保存也算新的 Reset 目标', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(B));
    expect(sync.evaluate({ ...B, fov: 50 }, descriptorWith({ ...B, fov: 50 }))).toBe(
      'resync-needed',
    );
  });

  it('后端未采用新 FOV（描述符仍是旧 FOV）→ ignored，不得 synced / 不得重建', () => {
    const sync = createInitialCameraSync();
    // 当前 Viewer 的 Reset 目标 = B（fov 47）
    sync.adopt(descriptorWith(B));
    // 用户保存 { ...B, fov: 60 }，但后端描述符仍是 B
    expect(sync.evaluate({ ...B, fov: 60 }, descriptorWith(B))).toBe('ignored');
    sync.markSaveFailed();
    expect(sync.evaluate({ ...B, fov: 60 }, descriptorWith(B))).toBe('ignored');
    // 同步目标不得被推进到新 FOV，旧目标仍是 B
    expect(sync.syncedKey()).toBe(initialCameraKey(descriptorWith(B)));
  });

  it('后端描述符 FOV 为 null（后端未采用 FOV）→ ignored，不得重建', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(B));
    const partial = descriptorWithCamera({
      position: { x: B.position[0], y: B.position[1], z: B.position[2] },
      target: { x: B.target[0], y: B.target[1], z: B.target[2] },
      fov: null,
    });
    expect(sync.evaluate(B, partial)).toBe('ignored');
  });

  it('FOV 单独改变且后端已采用 → resync-needed（进入 synced）', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(B));
    const next: CameraPose = { ...B, fov: 60 };
    expect(sync.evaluate(next, descriptorWith(next))).toBe('resync-needed');
    sync.adopt(descriptorWith(next));
    expect(sync.evaluate(next, descriptorWith(next))).toBe('already-synced');
    expect(sync.syncedKey()).toBe(initialCameraKey(descriptorWith(next)));
  });

  it('C 与 B 不同：不得把 C 当成已同步目标', () => {
    const sync = createInitialCameraSync();
    sync.adopt(descriptorWith(B));
    expect(sync.evaluate(C, descriptorWith(C))).toBe('resync-needed');
    expect(sync.evaluate(C, descriptorWith(C))).toBe('resync-needed');
    sync.adopt(descriptorWith(C));
    expect(sync.evaluate(B, descriptorWith(B))).toBe('resync-needed');
  });
});
