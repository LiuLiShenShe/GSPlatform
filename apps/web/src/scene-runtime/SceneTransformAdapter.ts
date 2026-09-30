/**
 * SceneTransformAdapter — 世界变换的统一 scene↔runtime 坐标换算（FIX-02 §5-§9）。
 *
 * 坐标系契约（方案A：runtime Scene Root Transform）：
 *   - SCENE 空间：作者/运行时保存坐标的空间（= 默认引擎世界空间，即世界变换
 *     恒等时作者所见空间）。初始相机、标注锚点 + 各自相机、视角点的 position /
 *     target 全部存这个空间。worldTransform 恒等时 = 旧行为，零回归。
 *   - RUNTIME 空间：gsplat 实体被世界变换 W 摆放后的引擎世界空间。
 *     runtime = W(scene)。
 *
 * 一致性保证：
 *   - 运行时把 W 施加到官方 gsplat 实体上（与官方烘焙的 180°Z 旋转合成，
 *     composeEntityEuler() 见下），场景轮廓移到 W(scene)；
 *   - 初始相机 / 标注 anchors + cameras / viewpoints 全部经本层 scene→runtime
 *     换算，与移动后的场景保持粘合；
 *   - 作者侧捕获（getCameraPose / pickApproximateWorldPosition 是 runtime 空间读数）经
 *     runtime→scene 存回 SCENE 空间 —— 世界变换变化后存量坐标依然钉在原内容上。
 *
 * 由此 Gaussian/Annotations/Viewpoints/Camera 共用同一 W，不做部分变换、不散落
 * 私有 hack。walk/collision 的体素/网格由冻结版官方 viewer 内部消费，无法经公开
 * API 施加同一变换 —— 非恒等 W 下 walk 对齐受限于官方 runtime（见 FIX-02 报告
 * KNOWN LIMITATIONS）；本层仍提供碰撞相关换算（eye height / spawn 缩放）。
 *
 * 旋转约定：Euler **度数**，顺序与官方 playcanvas setEulerAngles /
 * getEulerAngles 一致（YXZ intrinsic，yaw-pitch-roll）。quatFromEulerDeg /
 * eulerFromQuatDeg 严格互逆。
 */
import type { RuntimeViewpoint, RuntimeWorldTransform } from './types';

/** 三维向量（适配器自身结构，避免依赖 playcanvas 具体类型）。 */
export interface AdapterVec3 {
  x: number;
  y: number;
  z: number;
}

/** 相机 pose（与官方 CameraPose 同形）。 */
export interface AdapterCameraPose {
  position: AdapterVec3;
  target: AdapterVec3;
  fov: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** 列主序 4x4 矩阵（[m0..m15]，同官方 Mat4.data 布局）。 */
export type Mat4 = number[];

const IDENTITY_MAT4: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function almostEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// ------------------------------------------------------------------ #
// Quat / Mat 数学（纯函数，与 playcanvas YXZ euler 约定一致）
// ------------------------------------------------------------------ #

/** 由 Euler 度数（YXZ，pitch=x / yaw=y / roll=z）构造单位四元数。 */
export function quatFromEulerDeg(x: number, y: number, z: number): [number, number, number, number] {
  const hx = (x * DEG2RAD) * 0.5;
  const hy = (y * DEG2RAD) * 0.5;
  const hz = (z * DEG2RAD) * 0.5;
  const sx = Math.sin(hx), cx = Math.cos(hx);
  const sy = Math.sin(hy), cy = Math.cos(hy);
  const sz = Math.sin(hz), cz = Math.cos(hz);
  // q = Ry(y) * Rx(x) * Rz(z) —— playcanvas quatFromEuler 同式。
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ] as [number, number, number, number];
}

/** 四元数乘积（Hamilton）。 */
function quatMul(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * 由四元数求 Euler 度数（逆变换 quatFromEulerDeg）。
 *
 * 严格对齐官方 playcanvas Quat.getEulerAngles（含 y=±90° 简并分支）——
 * 互逆性由单测锁定（composeEntityEulerDeg 依赖这一点保证旋转一致）。
 */
export function eulerFromQuatDeg(q: [number, number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const a2 = 2 * (qw * qy - qx * qz);
  let x3: number, y2: number, z2: number;
  if (a2 <= -0.99999) {
    x3 = 2 * Math.atan2(qx, qw);
    y2 = -Math.PI * 0.5;
    z2 = 0;
  } else if (a2 >= 0.99999) {
    x3 = 2 * Math.atan2(qx, qw);
    y2 = Math.PI * 0.5;
    z2 = 0;
  } else {
    x3 = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
    y2 = Math.asin(a2);
    z2 = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
  }
  return [x3 * RAD2DEG, y2 * RAD2DEG, z2 * RAD2DEG];
}

/** 由 T + R(euler deg) + S 构造列主序 4x4。 */
function mat4FromTRS(
  pos: AdapterVec3,
  rot: AdapterVec3,
  scale: AdapterVec3,
): Mat4 {
  const [qx, qy, qz, qw] = quatFromEulerDeg(rot.x, rot.y, rot.z);
  const { x: sx, y: sy, z: sz } = scale;
  const [tX, tY, tZ] = [pos.x, pos.y, pos.z];

  // 旋转矩阵（四元数→3x3），列主序。
  const m00 = 1 - 2 * (qy * qy + qz * qz);
  const m01 = 2 * (qx * qy - qz * qw);
  const m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw);
  const m11 = 1 - 2 * (qx * qx + qz * qz);
  const m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw);
  const m21 = 2 * (qy * qz + qx * qw);
  const m22 = 1 - 2 * (qx * qx + qy * qy);

  return [
    m00 * sx, m10 * sx, m20 * sx, 0,
    m01 * sy, m11 * sy, m21 * sy, 0,
    m02 * sz, m12 * sz, m22 * sz, 0,
    tX, tY, tZ, 1,
  ];
}

/** 点变换：p' = M * p（应用 T·R·S）。 */
function transformPoint(m: Mat4, p: AdapterVec3): AdapterVec3 {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  };
}

/** 方向变换：d' = R*S * d（无平移）。 */
function transformDirection(m: Mat4, d: AdapterVec3): AdapterVec3 {
  return {
    x: m[0] * d.x + m[4] * d.y + m[8] * d.z,
    y: m[1] * d.x + m[5] * d.y + m[9] * d.z,
    z: m[2] * d.x + m[6] * d.y + m[10] * d.z,
  };
}

/** 4x4 求逆（列主序；仿射 T·R·S 通用）。 */
function mat4Invert(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0 || !Number.isFinite(det)) {
    // 奇异（如某轴 scale=0）：返回恒等，绝不传播 NaN。
    return IDENTITY_MAT4.slice();
  }
  const invDet = 1 / det;
  const out: Mat4 = Array.from({ length: 16 }, () => 0);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
  out[1] = (-a01 * b11 + a02 * b10 - a03 * b09) * invDet;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
  out[3] = (-a21 * b05 + a22 * b04 - a23 * b03) * invDet;
  out[4] = (-a10 * b11 + a12 * b08 - a13 * b07) * invDet;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
  out[6] = (-a30 * b05 + a32 * b02 - a33 * b01) * invDet;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
  out[9] = (-a00 * b10 + a01 * b08 - a03 * b06) * invDet;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
  out[11] = (-a20 * b04 + a21 * b02 - a23 * b00) * invDet;
  out[12] = (-a10 * b09 + a11 * b07 - a12 * b06) * invDet;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
  out[14] = (-a30 * b03 + a31 * b01 - a32 * b00) * invDet;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
  return out;
}

// ------------------------------------------------------------------ #
// Adapter
// ------------------------------------------------------------------ #

/** 归一化的世界变换（null 组件 → 恒等）。 */
export interface NormalizedWorldTransform {
  position: AdapterVec3;
  rotation: AdapterVec3;
  scale: AdapterVec3;
  isIdentity: boolean;
}

function normalizeWorldTransform(wt: RuntimeWorldTransform | null | undefined): NormalizedWorldTransform {
  const position = {
    x: wt?.position?.x ?? 0,
    y: wt?.position?.y ?? 0,
    z: wt?.position?.z ?? 0,
  };
  const rotation = {
    x: wt?.rotation?.x ?? 0,
    y: wt?.rotation?.y ?? 0,
    z: wt?.rotation?.z ?? 0,
  };
  const scale = {
    x: wt?.scale?.x ?? 1,
    y: wt?.scale?.y ?? 1,
    z: wt?.scale?.z ?? 1,
  };
  const isIdentity =
    almostEqual(position.x, 0) && almostEqual(position.y, 0) && almostEqual(position.z, 0) &&
    almostEqual(rotation.x, 0) && almostEqual(rotation.y, 0) && almostEqual(rotation.z, 0) &&
    almostEqual(scale.x, 1) && almostEqual(scale.y, 1) && almostEqual(scale.z, 1);
  return { position, rotation, scale, isIdentity };
}

/**
 * 世界变换适配器。
 *
 * 构造即归一化；恒等变换走快速通道（本层全透传，对存量场景零行为变化）。
 * 实例不可变 —— same W 的所有换算共享一个实例（buildExperienceSettings /
 * 页面捕获 / 诊断共用，避免 7× 重复实例）。
 */
export class SceneTransformAdapter {
  readonly position: AdapterVec3;
  readonly rotation: AdapterVec3;
  readonly scale: AdapterVec3;
  readonly isIdentity: boolean;

  private readonly m: Mat4;
  private readonly mInv: Mat4;

  private constructor(norm: NormalizedWorldTransform) {
    this.position = norm.position;
    this.rotation = norm.rotation;
    this.scale = norm.scale;
    this.isIdentity = norm.isIdentity;
    this.m = mat4FromTRS(norm.position, norm.rotation, norm.scale);
    this.mInv = mat4Invert(this.m);
  }

  /** 恒等变换适配器（未设置世界变换）。 */
  static identity(): SceneTransformAdapter {
    return new SceneTransformAdapter(normalizeWorldTransform(null));
  }

  /** 由 runtime 描述的世界变换构造（null 组件 → 恒等）。 */
  static fromWorldTransform(wt: RuntimeWorldTransform | null | undefined): SceneTransformAdapter {
    return new SceneTransformAdapter(normalizeWorldTransform(wt));
  }

  /** 原始世界变换（用于诊断输出 / 实体应用）。 */
  toDescriptorWorldTransform(): RuntimeWorldTransform {
    return {
      position: { ...this.position },
      rotation: { ...this.rotation },
      scale: { ...this.scale },
    };
  }

  // ---- scene → runtime ----

  sceneToRuntimePoint(p: AdapterVec3): AdapterVec3 {
    if (this.isIdentity) return { x: p.x, y: p.y, z: p.z };
    return transformPoint(this.m, p);
  }

  sceneToRuntimeDirection(d: AdapterVec3): AdapterVec3 {
    if (this.isIdentity) return { x: d.x, y: d.y, z: d.z };
    return transformDirection(this.m, d);
  }

  sceneToRuntimeCamera(cam: AdapterCameraPose): AdapterCameraPose {
    return {
      position: this.sceneToRuntimePoint(cam.position),
      target: this.sceneToRuntimePoint(cam.target),
      fov: cam.fov, // 变换不改变视野角
    };
  }

  sceneToRuntimeViewpoint(
    vp: Pick<RuntimeViewpoint, 'position' | 'target' | 'fov'>,
  ): AdapterCameraPose {
    return this.sceneToRuntimeCamera({
      position: vp.position,
      target: vp.target,
      fov: vp.fov,
    });
  }

  /** eye height / player height 的 y 轴缩放因子（worldScale.y）。 */
  sceneToRuntimePlayerHeight(height: number): number {
    return height * Math.abs(this.scale.y);
  }

  /** 尺度缩放（volumetric，walk 碰撞精度诊断用）。 */
  scaleFactor(): number {
    return (Math.abs(this.scale.x) + Math.abs(this.scale.y) + Math.abs(this.scale.z)) / 3;
  }

  // ---- runtime → scene（作者捕获反向换算） ----

  runtimeToScenePoint(p: AdapterVec3): AdapterVec3 {
    if (this.isIdentity) return { x: p.x, y: p.y, z: p.z };
    return transformPoint(this.mInv, p);
  }

  runtimeToSceneDirection(d: AdapterVec3): AdapterVec3 {
    if (this.isIdentity) return { x: d.x, y: d.y, z: d.z };
    return transformDirection(this.mInv, d);
  }

  runtimeToSceneCamera(cam: AdapterCameraPose): AdapterCameraPose {
    return {
      position: this.runtimeToScenePoint(cam.position),
      target: this.runtimeToScenePoint(cam.target),
      fov: cam.fov,
    };
  }
}

/** 官方 gsplat 实体烘焙的固定 180°Z 旋转（SSV-02/主包 1.35.0 加载器固有）。 */
const OFFICIAL_GSPLAT_BAKED_ROT_DEG: [number, number, number] = [0, 0, 180];

/**
 * 计算施加到 gsplat 实体的**局部 Euler 度数**：W ∘ base。
 *
 * 官方加载器把实体初始化为 euler(0,0,180)（Z-up→Y-up 翻转）—— 这就是默认
 * base（OFFICIAL_GSPLAT_BAKED_ROT_DEG）。世界变换 W 要在默认世界空间（合成
 * 基底之后）生效，所以最终局部旋转 = W.rot ∘ base.rot（先 base 内转、再 W
 * 外转）。位置 = W.pos、缩放 = W.scale（base 的 Rz180 缩放为 1）。
 *
 * FIX-05 §18-21：恒等 W 时返回 base 本身（此前写死 Rz180，等于假定 base 恒等；
 * 现在允许显式传入实体加载时的原始旋转），对存量场景行为不变。
 *
 * @param baseEuler 实体加载时的基准局部 Euler 度数（默认官方烘焙 Rz180）。
 * @returns [x, y, z] 度数，直接喂 setLocalEulerAngles。
 */
export function composeEntityEulerDeg(
  wt: RuntimeWorldTransform | null | undefined,
  baseEuler: [number, number, number] = OFFICIAL_GSPLAT_BAKED_ROT_DEG,
): [number, number, number] {
  const norm = normalizeWorldTransform(wt);
  if (norm.isIdentity) {
    return [...baseEuler] as [number, number, number];
  }
  const qW = quatFromEulerDeg(norm.rotation.x, norm.rotation.y, norm.rotation.z);
  const qBase = quatFromEulerDeg(...baseEuler);
  const qTotal = quatMul(qW, qBase);
  return eulerFromQuatDeg(qTotal);
}

/** 归一化世界变换（供诊断输出原始 position/rotation/scale）。 */
export function normalizeWorldTransformForDiagnostics(
  wt: RuntimeWorldTransform | null | undefined,
): RuntimeWorldTransform {
  const norm = normalizeWorldTransform(wt);
  return {
    position: { ...norm.position },
    rotation: { ...norm.rotation },
    scale: { ...norm.scale },
  };
}