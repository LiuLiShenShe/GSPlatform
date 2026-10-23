/**
 * GS-DESKTOP-01 —— 初始相机策略（Desktop / Authoring / XR 唯一权威来源）。
 *
 * ## 契约变更（旧契约 → 新契约，附官方 1.35.0 实测依据）
 *
 * 旧契约（FIX-02/GS-NEXT-02）：
 *   - 无 authored initial camera → 加载完成后 ``frameScene()`` 取景整个场景。
 *
 * 新契约（GS-DESKTOP-01，用户 P0 修复）：
 *   - 加载完成后**只** ``applyWorldTransform()`` + ``resetCamera()``；
 *     **任何情况下都不自动 ``frameScene()``**。
 *   - 无 authored 相机 → 采用官方 ``defaultSettings('environment')`` 的默认相机
 *     （``cameras[0].initial``），而不是整个 AABB 取景。
 *
 * 依据（``@playcanvas/supersplat-viewer@1.35.0`` ``dist/viewer.js``）：
 *   - ``CameraManager`` 构造时 ``this.camera.copy(resetCamera)``，其中
 *     ``resetCamera = camera0 ? createCamera(camera0...) : frameCamera``，而
 *     ``defaultSettings()`` **始终**提供 ``cameras[0].initial``，所以加载后的
 *     官方初始相机一直是 ``settings.cameras[0].initial``。
 *   - ``frameCamera = createFrameCamera(bbox, fov)``（距离 =
 *     ``bbox.halfExtents.length() / sin(fov/2)``）只被 ``inputEvent 'frame'``
 *     消费 —— 即官方的 Frame 操作，加载路径不会调用它。
 *   - 真机复现（fix02-semantics，无 authored 相机）：加载完成时相机在
 *     官方默认 ``[0,2,0]``，自动 frameScene 后 1 秒内被拉到
 *     ``[3.2433,1.7331,3.3158]``（位移 4.65），正是「视角突然退到远处」。
 *
 * 本文件锁定策略判定与「加载只做 reset 不做 frame」这一调用契约；真实浏览器
 * 行为由 apps/web/e2e/gsdesktop01-camera-stability.spec.ts 验证。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyInitialCameraPolicy,
  hasAuthoredInitialCamera,
  initialCameraSource,
  runtimeInitialCameraUse,
  type InitialCameraRuntime,
} from '../scene-runtime/initialCameraPolicy';
import { emptyRuntimeDescriptorFixture, runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';

/** 记录调用顺序的假 runtime（额外挂 frameScene 用于断言"绝不自动取景"）。 */
function makeRuntime() {
  const calls: string[] = [];
  const runtime = {
    applyWorldTransform: vi.fn(() => {
      calls.push('applyWorldTransform');
      return true;
    }),
    resetCamera: vi.fn(() => {
      calls.push('resetCamera');
    }),
    // 结构类型之外多挂一个：如果实现偷偷调用它，断言会失败。
    frameScene: vi.fn(() => {
      calls.push('frameScene');
    }),
  };
  return { runtime, calls };
}

function withInitialCamera(
  initialCamera: SceneRuntimeDescriptorV1['presentation']['initialCamera'],
): SceneRuntimeDescriptorV1 {
  return {
    ...emptyRuntimeDescriptorFixture,
    presentation: { ...emptyRuntimeDescriptorFixture.presentation, initialCamera },
  };
}

describe('initial camera 判定（hasAuthoredInitialCamera）', () => {
  it('position+target 成对存在 → authored（显式语义，非 [0,0,0] 猜测）', () => {
    expect(hasAuthoredInitialCamera(runtimeDescriptorFixture)).toBe(true);
    expect(initialCameraSource(runtimeDescriptorFixture)).toBe('authored');
  });

  it('position 恰为 [0,0,0] 但 target 成对 → 仍是 authored（不靠零值猜测）', () => {
    const desc = withInitialCamera({
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: -1 },
      fov: 55,
    });
    expect(hasAuthoredInitialCamera(desc)).toBe(true);
  });

  it.each([
    ['target 缺失', { position: { x: 5, y: 2, z: 5 }, target: null, fov: 55 }],
    ['position 缺失', { position: null, target: { x: 0, y: 0, z: 0 }, fov: 55 }],
    ['两者都缺失', { position: null, target: null, fov: null }],
  ] as const)('%s → 无 authored 相机 → official-default', (_label, cam) => {
    const desc = withInitialCamera(cam);
    expect(hasAuthoredInitialCamera(desc)).toBe(false);
    expect(initialCameraSource(desc)).toBe('official-default');
  });

  it('descriptor 为 null（加载失败/未就绪）→ 不误判为 authored', () => {
    expect(hasAuthoredInitialCamera(null)).toBe(false);
    expect(initialCameraSource(null)).toBe('official-default');
  });
});

describe('加载完成契约（applyInitialCameraPolicy）', () => {
  it('authored：施加世界变换后 resetCamera，且绝不 frameScene', () => {
    const { runtime, calls } = makeRuntime();
    const source = applyInitialCameraPolicy(runtime, runtimeDescriptorFixture);
    expect(source).toBe('authored');
    expect(calls).toEqual(['applyWorldTransform', 'resetCamera']);
    expect(runtime.frameScene).not.toHaveBeenCalled();
  });

  it('无 authored：同样只 resetCamera（官方默认相机），绝不 frameScene', () => {
    const { runtime, calls } = makeRuntime();
    const source = applyInitialCameraPolicy(runtime, emptyRuntimeDescriptorFixture);
    expect(source).toBe('official-default');
    expect(calls).toEqual(['applyWorldTransform', 'resetCamera']);
    expect(runtime.frameScene).not.toHaveBeenCalled();
  });

  it('descriptor 缺失：仍只 resetCamera，绝不 frameScene', () => {
    const { runtime, calls } = makeRuntime();
    expect(applyInitialCameraPolicy(runtime, null)).toBe('official-default');
    expect(calls).toEqual(['applyWorldTransform', 'resetCamera']);
  });

  it('结构上不可能自动取景：策略接口不接受 frameScene', () => {
    // 运行时类型只暴露 applyWorldTransform / resetCamera —— 调用点绕不开策略。
    const typed: InitialCameraRuntime = {
      applyWorldTransform: () => true,
      resetCamera: () => undefined,
    };
    expect(() => applyInitialCameraPolicy(typed, emptyRuntimeDescriptorFixture)).not.toThrow();
  });
});

describe('GS-NEXT-02 已保存初始视角是否被运行时采用（runtimeInitialCameraUse）', () => {
  const saved = { x: 0.4, y: -0.2, z: 0.14 };

  it('从未保存 → absent（打开场景使用官方默认相机，符合预期）', () => {
    expect(runtimeInitialCameraUse(null, runtimeDescriptorFixture)).toEqual({ status: 'absent' });
    expect(runtimeInitialCameraUse(undefined, runtimeDescriptorFixture)).toEqual({ status: 'absent' });
  });

  it('未保存且描述符尚未解析 → 仍是 absent（不误报为 ignored）', () => {
    expect(runtimeInitialCameraUse(null, null)).toEqual({ status: 'absent' });
  });

  it('已保存 + 描述符带 authored camera → authored（运行时正在采用该视角）', () => {
    const desc = withInitialCamera({
      position: saved,
      target: { x: 0, y: 0, z: -1 },
      fov: 60,
    });
    expect(runtimeInitialCameraUse(saved, desc)).toEqual({ status: 'authored' });
  });

  it('已保存 + 描述符丢弃了 initialCamera（空间绑定 STALE）→ ignored（面板显示已保存但打开场景仍是默认相机）', () => {
    expect(runtimeInitialCameraUse(saved, emptyRuntimeDescriptorFixture)).toEqual({ status: 'ignored' });
  });

  it('已保存但描述符为 null（解析失败/未就绪）→ ignored（不谎报成功）', () => {
    expect(runtimeInitialCameraUse(saved, null)).toEqual({ status: 'ignored' });
  });
});
