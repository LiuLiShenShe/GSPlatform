/**
 * FIX-02 §2/§3/§18 —— 初始相机策略。
 *
 * 规则（Desktop 与 XR 相同）：
 *   - Scene 有 authored Initial Camera（position+target 成对存在，显式 null 语义，
 *     绝不是 `position != [0,0,0]` 猜测）→ Viewer loaded 后**不自动 frameScene**，
 *     使用 authored initial camera（必要时 runtime.resetCamera() 恢复）。
 *   - 无 authored camera → frameScene 取景整个场景。
 *
 * 本文件锁定策略判定；加载时机用法（onLoaded hooked）由 runtime 页面验证。
 */
import { describe, expect, it } from 'vitest';
import {
  hasAuthoredInitialCamera,
  runtimeInitialCameraUse,
  shouldFrameSceneOnLoad,
} from '../scene-runtime/initialCameraPolicy';
import { emptyRuntimeDescriptorFixture, runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';

describe('FIX-02 initial camera policy（hasAuthoredInitialCamera）', () => {
  it('position+target 成对存在 → 判定为 authored（显式语义，非 [0,0,0] 猜测）', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        ...emptyRuntimeDescriptorFixture.presentation,
        initialCamera: { position: { x: 0, y: 1.6, z: 3 }, target: { x: 0, y: 0, z: 0 }, fov: 55 },
      },
    };
    expect(hasAuthoredInitialCamera(desc)).toBe(true);
    expect(shouldFrameSceneOnLoad(desc)).toBe(false);
  });

  it('position 恰为 [0,0,0] 但 target 成对 → 仍是 authored（不靠零值猜测）', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        ...emptyRuntimeDescriptorFixture.presentation,
        initialCamera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 }, fov: 55 },
      },
    };
    expect(hasAuthoredInitialCamera(desc)).toBe(true);
    expect(shouldFrameSceneOnLoad(desc)).toBe(false);
  });

  it('target 缺失（null）→ 无 authored camera → 应 frameScene', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        ...emptyRuntimeDescriptorFixture.presentation,
        initialCamera: { position: { x: 5, y: 2, z: 5 }, target: null, fov: 55 },
      },
    };
    expect(hasAuthoredInitialCamera(desc)).toBe(false);
    expect(shouldFrameSceneOnLoad(desc)).toBe(true);
  });

  it('position 缺失（null）→ 无 authored camera → 应 frameScene', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        ...emptyRuntimeDescriptorFixture.presentation,
        initialCamera: { position: null, target: { x: 0, y: 0, z: 0 }, fov: 55 },
      },
    };
    expect(hasAuthoredInitialCamera(desc)).toBe(false);
    expect(shouldFrameSceneOnLoad(desc)).toBe(true);
  });

  it('descriptor 为 null（加载失败/未就绪）→ 不误判为 authored', () => {
    expect(hasAuthoredInitialCamera(null)).toBe(false);
    expect(shouldFrameSceneOnLoad(null)).toBe(true);
  });

  it('标准 fixture 的作者初始终端不受影响（行为对存量场景零变化）', () => {
    // runtimeDescriptorFixture 带完整 initialCamera —— 视为 authored、
    // 不自动 frameScene；测试夹具语义不变。
    expect(hasAuthoredInitialCamera(runtimeDescriptorFixture)).toBe(true);
  });
});

describe('GS-NEXT-02 已保存初始视角是否被运行时采用（runtimeInitialCameraUse）', () => {
  const saved = { x: 0.4, y: -0.2, z: 0.14 };

  it('从未保存（presentation 无 initialCameraPosition）→ absent（走官方 frameScene，符合预期）', () => {
    expect(runtimeInitialCameraUse(null, runtimeDescriptorFixture)).toEqual({ status: 'absent' });
    expect(runtimeInitialCameraUse(undefined, runtimeDescriptorFixture)).toEqual({ status: 'absent' });
  });

  it('未保存且描述符尚未解析 → 仍是 absent（不误报为 ignored）', () => {
    expect(runtimeInitialCameraUse(null, null)).toEqual({ status: 'absent' });
  });

  it('已保存 + 描述符带 authored camera → authored（运行时正在采用该视角）', () => {
    const desc: SceneRuntimeDescriptorV1 = {
      ...emptyRuntimeDescriptorFixture,
      presentation: {
        ...emptyRuntimeDescriptorFixture.presentation,
        initialCamera: { position: saved, target: { x: 0, y: 0, z: -1 }, fov: 60 },
      },
    };
    expect(runtimeInitialCameraUse(saved, desc)).toEqual({ status: 'authored' });
  });

  it('已保存 + 描述符丢弃了 initialCamera（空间绑定 STALE）→ ignored（面板显示已保存但打开场景仍取景）', () => {
    // 复现 PICO 复测现象：`scene_presentations` 有值，但描述符 initialCamera
    // 为 null（空 fixture 即此形态）—— 这正是"保存成功却仍是鸟瞰"的根因。
    expect(runtimeInitialCameraUse(saved, emptyRuntimeDescriptorFixture)).toEqual({ status: 'ignored' });
  });

  it('已保存但描述符为 null（解析失败/未就绪）→ ignored（不谎报成功）', () => {
    expect(runtimeInitialCameraUse(saved, null)).toEqual({ status: 'ignored' });
  });
});