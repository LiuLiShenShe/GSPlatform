/**
 * GS-NEXT-05 —— XR Rig 定位数学（`xrRigPose.ts`）。
 *
 * 这是**进入 VR 前的出生对齐**与**会话内导览传送**共用的唯一一份实现
 * （验收项：连续切换 20 次不累积漂移）。用真实 PlayCanvas `Entity` 跑，因为
 * 数学全靠真实四元数/局部变换 —— 假实现会让这份测试变成"测试假代码"。
 */
import { describe, expect, it } from 'vitest';
import { Entity } from 'playcanvas';
import { applyRigPose, isTrackedHeadPose, rigEyePosition, rigNodesFrom } from '../scene-runtime/xrRigPose';

/** 官方层级：Rig（被移动的实体）> Camera（tracking 写入的实体）。 */
function makeRig(eye: [number, number, number] = [0, 1.7, 0], headYaw = 0) {
  const rig = new Entity('rig');
  const camera = new Entity('camera');
  rig.addChild(camera);
  camera.setLocalPosition(eye[0], eye[1], eye[2]);
  camera.setLocalEulerAngles(0, headYaw, 0);
  rig.setPosition(0, 0, 0);
  return { rig, camera, nodes: rigNodesFrom(camera)! };
}

describe('applyRigPose', () => {
  it('把「眼睛」而不是 rig 原点落到保存位置（用户在 rig 里偏移 0.4m 也能精确落位）', () => {
    const { nodes, camera } = makeRig([0.4, 1.7, -0.2], 35);
    const applied = applyRigPose(nodes, { position: [10, 4, 20], target: [9, 4, 20] });
    expect(applied).toBe(true);
    const eye = camera.getPosition();
    expect(eye.x).toBeCloseTo(10, 5);
    expect(eye.y).toBeCloseTo(4, 5);
    expect(eye.z).toBeCloseTo(20, 5);
  });

  it('只对齐水平 yaw：头显自身的 6DoF 局部姿态原样保留', () => {
    const { nodes, camera } = makeRig([0, 1.7, 0], 35);
    applyRigPose(nodes, { position: [0, 0, 0], target: [0, 0, -1] });
    // 头显局部 yaw 仍是 35（只是 rig 抵消了它）。
    expect(camera.getLocalEulerAngles().y).toBeCloseTo(35, 4);
    expect(camera.getLocalPosition().y).toBeCloseTo(1.7, 5);
    // 眼睛世界朝向 = 目标方向 -Z。
    expect(camera.forward.x).toBeCloseTo(0, 4);
    expect(camera.forward.z).toBeCloseTo(-1, 4);
  });

  it('目标方向为水平时同样把头显 yaw 对齐', () => {
    const { nodes, camera } = makeRig([0, 1.7, 0], 0);
    // 目标朝 +X（yaw = +90°）：头显 forward.x 应为 +1。
    applyRigPose(nodes, { position: [0, 0, 0], target: [5, 0, 0] });
    expect(camera.forward.x).toBeCloseTo(1, 4);
    expect(camera.forward.z).toBeCloseTo(0, 4);
  });

  it('目标位置=目标位置（零水平位移）时只修位置，不动 yaw', () => {
    const { nodes } = makeRig([0, 1.7, 0], 0);
    const before = nodes.rig.getRotation().clone();
    applyRigPose(nodes, { position: [3, 1.7, -4], target: [3, 1.7, -4] });
    expect(nodes.rig.getRotation().w).toBeCloseTo(before.w, 6);
    const eye = rigEyePosition(nodes);
    expect(eye.x).toBeCloseTo(3, 5);
    expect(eye.z).toBeCloseTo(-4, 5);
  });

  it('头部位姿未追踪（全零）时拒绝施加 —— 返回 false，调用方必须继续等待', () => {
    const { nodes, camera } = makeRig([0, 0, 0]);
    expect(isTrackedHeadPose(camera.getLocalPosition())).toBe(false);
    expect(applyRigPose(nodes, { position: [10, 4, 20], target: [9, 4, 20] })).toBe(false);
    expect(camera.getPosition().x).toBeCloseTo(0, 6);
  });

  it('坐标非有限（NaN / Infinity）时拒绝施加', () => {
    const { nodes } = makeRig();
    expect(applyRigPose(nodes, { position: [NaN, 4, 20], target: [9, 4, 20] })).toBe(false);
    expect(applyRigPose(nodes, { position: [1, 4, 20], target: [9, Infinity, 20] })).toBe(false);
  });

  it('连续切换 20 次：结果只取决于最后一次目标，不累积漂移（验收 §5-5）', () => {
    const { nodes, camera } = makeRig([0.3, 1.65, -0.15], 20);
    const poses = [
      { position: [2.5, 1.8, 6], target: [0, 0.6, 0] },
      { position: [-2, 1.5, 5], target: [-1, 0.4, 0] },
      { position: [7, 3, -4], target: [1, 1, 1] },
    ];
    for (let i = 0; i < 20; i += 1) {
      const pose = poses[i % poses.length];
      expect(applyRigPose(nodes, pose)).toBe(true);
      const eye = camera.getPosition();
      expect(eye.x).toBeCloseTo(pose.position[0], 5);
      expect(eye.y).toBeCloseTo(pose.position[1], 5);
      expect(eye.z).toBeCloseTo(pose.position[2], 5);
    }
    // 20 次之后再落到第一个目标，与第 1 次的结果逐位相同（无累积误差）。
    const first = poses[0];
    applyRigPose(nodes, first);
    const a = camera.getPosition().clone();
    applyRigPose(nodes, poses[1]);
    applyRigPose(nodes, poses[2]);
    applyRigPose(nodes, poses[0]);
    const b = camera.getPosition();
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
    expect(b.x).toBeCloseTo(first.position[0], 6);
  });

  it('rigNodesFrom：没有父实体时返回 null（不做任何事）', () => {
    const orphan = new Entity('camera');
    expect(rigNodesFrom(orphan)).toBeNull();
  });
});
