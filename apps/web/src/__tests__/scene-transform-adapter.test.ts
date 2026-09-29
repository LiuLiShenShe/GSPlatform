/**
 * FIX-02 §18 — SceneTransformAdapter 单测。
 *
 * 覆盖 spec §18 要求的：世界变换 point 换算、逆换算、scale、rotation、viewpoint
 * 换算、annotation-specific camera；另与官方 playcanvas Quat 对拍锁定 euler 约定
 * 互逆（composeEntityEulerDeg 依赖它保证「施加到实体的旋转」与「adapter 内换算」
 * 严格一致 —— 否则相机与移动后的高斯脱粘）。
 */
import { describe, expect, it } from 'vitest';
import { Quat } from 'playcanvas';
import {
  SceneTransformAdapter,
  composeEntityEulerDeg,
  eulerFromQuatDeg,
  quatFromEulerDeg,
  type AdapterCameraPose,
} from '../scene-runtime/SceneTransformAdapter';
import type { RuntimeWorldTransform } from '../scene-runtime/types';

const IDENTITY_WT: RuntimeWorldTransform = {
  position: null,
  rotation: null,
  scale: null,
};

const T: RuntimeWorldTransform = {
  position: { x: 10, y: 0, z: 5 },
  rotation: { x: 0, y: 90, z: 0 }, // 绕 Y 90°：x→z, z→-x（右手系 YXZ）
  scale: { x: 2, y: 3, z: 4 },
};

describe('euler 约定对齐官方 playcanvas', () => {
  it('quatFromEulerDeg / eulerFromQuatDeg 与 playcanvas setFromEulerAngles/getEulerAngles 一致', () => {
    const cases: [number, number, number][] = [
      [0, 0, 90],
      [90, 0, 0],
      [0, 90, 0],
      [30, 45, 60],
      [-90, 0, 180],
      [0, 180, 0],
      [15, -70, 120],
    ];
    for (const e of cases) {
      const q = quatFromEulerDeg(...e);
      const out = eulerFromQuatDeg(q);
      const pcQ = new Quat().setFromEulerAngles(...e);
      const pcE = pcQ.getEulerAngles();
      expect(out[0]).toBeCloseTo(pcE.x, 6);
      expect(out[1]).toBeCloseTo(pcE.y, 6);
      expect(out[2]).toBeCloseTo(pcE.z, 6);
    }
  });

  it('恒等世界变换 → 实体 Euler 保持官方烘焙 [0,0,180]（存量场景零改动）', () => {
    expect(composeEntityEulerDeg(IDENTITY_WT)).toEqual([0, 0, 180]);
    expect(composeEntityEulerDeg(null)).toEqual([0, 0, 180]);
  });

  it('composeEntityEulerDeg(W) = playcanvas Ry(W.y)*Rx(W.x)*Rz(W.z) ∘ Rz180', () => {
    const wt: RuntimeWorldTransform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 10, y: 30, z: -20 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const mine = composeEntityEulerDeg(wt);
    const qW = new Quat().setFromEulerAngles(wt.rotation!.x, wt.rotation!.y, wt.rotation!.z);
    const qZ180 = new Quat().setFromEulerAngles(0, 0, 180);
    const composed = qW.clone().mul(qZ180);
    const pcE = composed.getEulerAngles();
    expect(mine[0]).toBeCloseTo(pcE.x, 5);
    expect(mine[1]).toBeCloseTo(pcE.y, 5);
    expect(mine[2]).toBeCloseTo(pcE.z, 5);
  });
});

describe('identity 快速通道（零回归）', () => {
  const id = SceneTransformAdapter.fromWorldTransform(IDENTITY_WT);
  it('isIdentity 为真且全部换算透传', () => {
    expect(id.isIdentity).toBe(true);
    expect(id.sceneToRuntimePoint({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
    expect(id.runtimeToScenePoint({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
    expect(id.sceneToRuntimeDirection({ x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
    expect(id.sceneToRuntimePlayerHeight(1.7)).toBe(1.7);
  });
});

describe('scene↔runtime 点换算', () => {
  const a = SceneTransformAdapter.fromWorldTransform(T);
  it('scale × rotation × translation 正向换算（与 playcanvas Mat4.transformPoint 对拍）', () => {
    const out = a.sceneToRuntimePoint({ x: 1, y: 2, z: 3 });
    // playcanvas: Ry90, scale(2,3,4), pos(10,0,5) → (1,2,3) = (22, 6, 3)
    expect(out.x).toBeCloseTo(22, 6);
    expect(out.y).toBeCloseTo(6, 6);
    expect(out.z).toBeCloseTo(3, 6);
  });

  it('逆换算 = 正向的反函数（round-trip）', () => {
    const p = { x: 7.5, y: -1.25, z: 13.5 };
    const rt = a.sceneToRuntimePoint(p);
    const back = a.runtimeToScenePoint(rt);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
    expect(back.z).toBeCloseTo(p.z, 6);
  });

  it('方向换算不含平移（与 playcanvas transformVector 对拍）', () => {
    const out = a.sceneToRuntimeDirection({ x: 1, y: 0, z: 0 });
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(-2, 6);
  });
});

describe('camera / viewpoint 换算', () => {
  const a = SceneTransformAdapter.fromWorldTransform(T);
  const cam: AdapterCameraPose = {
    position: { x: 0, y: 1.7, z: 0 },
    target: { x: 0, y: 1, z: -5 },
    fov: 70,
  };
  it('camera position/target 同用 point 换算，fov 不变', () => {
    const out = a.sceneToRuntimeCamera(cam);
    expect(out.fov).toBe(70);
    // position (0,1.7,0) → (10, 5.1, 5)
    expect(out.position.x).toBeCloseTo(10, 6);
    expect(out.position.y).toBeCloseTo(5.1, 6);
    expect(out.position.z).toBeCloseTo(5, 6);
    // target (0,1,-5) → x=10+4*(-5)=-10, y=3, z=5
    expect(out.target.x).toBeCloseTo(-10, 6);
    expect(out.target.y).toBeCloseTo(3, 6);
    expect(out.target.z).toBeCloseTo(5, 6);
  });

  it('viewpoint 换算 = camera 换算', () => {
    const vp = { position: cam.position, target: cam.target, fov: cam.fov };
    const out = a.sceneToRuntimeViewpoint(vp);
    expect(out.position).toEqual(a.sceneToRuntimeCamera(cam).position);
    expect(out.target).toEqual(a.sceneToRuntimeCamera(cam).target);
  });

  it('runtime→scene camera 是 scene→runtime 的反函数', () => {
    const rt = a.sceneToRuntimeCamera(cam);
    const back = a.runtimeToSceneCamera(rt);
    expect(back.position.x).toBeCloseTo(cam.position.x, 6);
    expect(back.position.y).toBeCloseTo(cam.position.y, 6);
    expect(back.position.z).toBeCloseTo(cam.position.z, 6);
    expect(back.target.x).toBeCloseTo(cam.target.x, 6);
    expect(back.fov).toBe(70);
  });
});

describe('scale 的一致性', () => {
  it('非均匀 scale 独立作用于各轴', () => {
    const a = SceneTransformAdapter.fromWorldTransform(T);
    expect(a.sceneToRuntimePoint({ x: 1, y: 1, z: 1 }).y).toBeCloseTo(3, 6);
    expect(a.sceneToRuntimePoint({ x: 1, y: 1, z: 1 }).x).toBeCloseTo(14, 6); // 10+4*1
  });

  it('playerHeight 按 worldScale.y 缩放', () => {
    const a = SceneTransformAdapter.fromWorldTransform(T);
    expect(a.sceneToRuntimePlayerHeight(1.7)).toBeCloseTo(5.1, 6);
  });

  it('恒等 scaleFactor = 1', () => {
    expect(SceneTransformAdapter.identity().scaleFactor()).toBe(1);
  });
});

describe('fromWorldTransform 归一化', () => {
  it('null 组件 → 恒等（position 0 / rotation 0 / scale 1）', () => {
    const a = SceneTransformAdapter.fromWorldTransform(null);
    expect(a.isIdentity).toBe(true);
    expect(a.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(a.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('部分组件 → 其余取恒等', () => {
    const a = SceneTransformAdapter.fromWorldTransform({ position: { x: 1, y: 0, z: 0 }, rotation: null, scale: null });
    expect(a.isIdentity).toBe(false);
    expect(a.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(a.sceneToRuntimePoint({ x: 0, y: 0, z: 0 }).x).toBeCloseTo(1, 6);
  });
});
