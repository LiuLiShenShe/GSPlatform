/**
 * XR Rig 定位数学（GS-NEXT-03 出生对齐 + GS-NEXT-05 会话内传送）—— **单一实现**。
 *
 * 为什么独立成文件：进入 VR 前的出生对齐（`prepareXRSpawn`）与会话内的导览点切换
 * 必须用**完全同一套**数学。两处各写一份就必然漂移，而且漂移方向相反时极难察觉
 * （出生点差 0.5 m、传送后差一个身位都不会报错）。
 *
 * 关键事实（读官方 `XrNavigation.tryTeleport` + `SuperSplatRuntime.prepareXRSpawn`
 * 核对后固定下来的语义）：
 *
 * 1. **只移动官方 XR Camera 的父 Rig**（`xr.camera.parent`），绝不写头显 Camera
 *    自身 —— 后者的变换每帧被 WebXR tracking pose 覆盖，写了也留不住。
 * 2. 目标是**保存的 eye position**（不是 rig 原点）。用户在 Rig 里的局部偏移
 *    （头显在 rig 中偏移 head local position）必须补偿掉：
 *    `rigPos = target − rigRot · headLocal`。官方 `tryTeleport` 用的是同一招
 *    （"correct under rig yaw"），所以传送后头显**眼睛**落在保存位置，而不是
 *    rig 原点。
 * 3. 只对齐**水平 yaw**：把 rig 的 yaw 设为 `目标yaw − 当前头姿yaw`。头显自身的
 *    pitch/roll/6DoF 局部姿态原样保留（`camera.getLocalPosition()` / 局部旋转不变）。
 * 4. 位姿必须可信才写：坐标全有限，且头部位姿**非零**（local-floor 参考空间下
 *    tracking 原点未确定时头部位姿为 0，在它上面算朝向会得到错误出生朝向）。
 *
 * 不做的事：这里**不**新建任何相机/导航系统，也不重写官方 XrNavigation 的
 * 摇杆移动、snap turn —— 那些仍由官方脚本独占。
 */
import { Vec3, type Entity, type Quat, type Vec3 as Vec3Type } from 'playcanvas';

/** 供本模块使用的最小相机 pose（与官方 `CameraPose` 形状一致）。 */
export interface RigTargetPose {
  position: readonly number[] | number[];
  target: readonly number[] | number[];
}

/** Rig + 头显相机：只声明用到的成员（PlayCanvas Entity 直接满足）。 */
export interface XrRigNodes {
  /** 官方 XR Camera 的父实体（XrNavigation 所在实体 = 移动的实体）。 */
  rig: {
    getPosition(): Vec3Type;
    getRotation(): Quat;
    setEulerAngles(x: number, y: number, z: number): void;
    setPosition(x: number, y: number, z: number): void;
  };
  /** 官方 XR Camera（tracking pose 由 WebXR 每帧写入，不可覆写）。 */
  camera: {
    getLocalPosition(): Vec3Type;
    getLocalRotation(): Quat;
  };
}

/** 头部位姿是否可信（有限且非零）。 */
export function isTrackedHeadPose(local: { x: number; y: number; z: number }): boolean {
  if (![local.x, local.y, local.z].every(Number.isFinite)) return false;
  // local / local-floor 参考空间下头部位姿的高度分量恒 > 0；全零 = tracking 原点未定。
  return Math.hypot(local.x, local.y, local.z) > 1e-4;
}

/**
 * 把头显（eye）落到 `pose.position` 并朝向 `pose.target` 的**水平**方向。
 *
 * @returns 是否真的施加了。false = 位姿不可信（未追踪 / 坐标非有限），
 *   调用方**必须继续等待**而不是重试（一次性对齐场景下重试就等于永久错过）。
 */
export function applyRigPose(nodes: XrRigNodes, pose: RigTargetPose): boolean {
  const local = nodes.camera.getLocalPosition();
  if (![...pose.position, ...pose.target, local.x, local.y, local.z].every(Number.isFinite)) return false;
  if (!isTrackedHeadPose(local)) return false;
  const directionX = pose.target[0] - pose.position[0];
  const directionZ = pose.target[2] - pose.position[2];
  if (Math.hypot(directionX, directionZ) > 1e-6) {
    const headForward = nodes.camera.getLocalRotation().transformVector(Vec3.FORWARD, new Vec3());
    const headYaw = Math.atan2(-headForward.x, -headForward.z);
    // rig yaw = 目标 yaw − 头显自身 yaw（头显局部姿态保持不变 ⇒ 6DoF 不受影响）。
    nodes.rig.setEulerAngles(0, (Math.atan2(-directionX, -directionZ) - headYaw) * 180 / Math.PI, 0);
  }
  const offset = nodes.rig.getRotation().transformVector(local, new Vec3());
  nodes.rig.setPosition(pose.position[0] - offset.x, pose.position[1] - offset.y, pose.position[2] - offset.z);
  return true;
}

/**
 * 当前 Rig 下"眼睛"的世界位置（用于断言/诊断：传送后应当精确等于目标 position）。
 */
export function rigEyePosition(nodes: XrRigNodes): { x: number; y: number; z: number } {
  const offset = nodes.rig.getRotation().transformVector(nodes.camera.getLocalPosition(), new Vec3());
  const rigPos = nodes.rig.getPosition() as { x: number; y: number; z: number };
  return { x: rigPos.x + offset.x, y: rigPos.y + offset.y, z: rigPos.z + offset.z };
}

/** 便捷：构造 Rig 节点（官方 XR Camera 的父子关系）。 */
export function rigNodesFrom(camera: Entity): XrRigNodes | null {
  const rig = camera.parent;
  if (!rig) return null;
  return {
    rig: rig as unknown as XrRigNodes['rig'],
    camera: camera as unknown as XrRigNodes['camera'],
  };
}
