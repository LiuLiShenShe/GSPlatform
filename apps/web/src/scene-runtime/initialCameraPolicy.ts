/**
 * Initial Camera 策略（FIX-02 §2-§3；GS-DESKTOP-01 重写）—— Desktop / Authoring /
 * XR 三个入口的**唯一**起始相机规则。
 *
 * ## 规则（固定，禁止在调用点重写）
 *
 * 加载完成时只做一次初始化：施加世界变换，然后 `resetCamera()`。
 * **绝不自动 `frameScene()`。**
 *
 * - 有 authored Initial Camera（position 与 target 都存在）→
 *   `buildExperienceSettings` 把它写进 `settings.cameras[0].initial`，官方
 *   CameraManager 在构造时 `this.camera.copy(resetCamera)` 采用它；
 *   `resetCamera()` 只是把官方状态收敛到「初始视角」（同一姿态 → 无位移）。
 * - 没有 authored Initial Camera → `settings.cameras[0].initial` 保持官方
 *   `defaultSettings(fit)` 的默认相机；`resetCamera()` 收敛到它。
 *   **不取景整个 AABB** —— 官方 `frameScene()` 用 `createFrameCamera(bbox)`
 *   把整个（可能含大量离群 Gaussian 的）包围盒塞进画面，正是用户报告的
 *   「加载一结束视角突然退到远处、显示整个场景和废点」。
 *
 * ## 为什么不能自动 `frameScene()`（官方 1.35.0 实测依据）
 *
 * `@playcanvas/supersplat-viewer@1.35.0` `dist/viewer.js`：
 *
 * - `CameraManager` 构造时：
 *   `const camera0 = settings.cameras[0]?.initial;`
 *   `const resetCamera = camera0 ? createCamera(...) : frameCamera;`
 *   `this.camera.copy(resetCamera);`
 *   即：**加载后的初始相机就是 `settings.cameras[0].initial`**，官方从不主动
 *   取景。`frameCamera`（`createFrameCamera(bbox, fov)`，距离 =
 *   `bbox.halfExtents.length() / sin(fov/2)`）只被 `inputEvent 'frame'` 使用。
 * - `defaultSettings('environment')` 始终提供
 *   `cameras: [{ initial: { position: [0,2,0], target: [2,2,0], fov: 85 } }]`，
 *   所以 adapter 没有 authored 相机时，官方用的是这个**官方默认相机**，
 *   不是 AABB 取景。
 * - 官方在 `firstFrame` 时把 `state.animationPaused` 置回 `false`；
 *   不调用 `resetCamera()` 的话，相机随后会沿官方自动动画轨道移动。
 *   `resetCamera()`（官方 'reset' 输入事件）会切到 orbit 并回到
 *   `settings.cameras[0].initial`，这是一次性的、用户也随时可再触发的操作。
 *
 * `frameScene()` 仍然是**用户主动**操作：官方原生工具条 `Frame` 按钮 →
 * 官方 `viewer.frameScene()`。官方 `Reset` 按钮 → 官方 `resetCamera()` →
 * 回到有效初始相机。（GS-DESKTOP-02 起宿主不再自绘工具条。）
 *
 * §3 显式语义：判定只看 position/target 是否为 null，**绝不**用
 * `position != [0,0,0]` 之类的猜测（作者可能真的把相机放在原点）。
 */
import type { SceneRuntimeDescriptorV1 } from './types';

/** 描述里是否存在 authored 初始相机（position + target 都非 null）。 */
export function hasAuthoredInitialCamera(descriptor: SceneRuntimeDescriptorV1 | null): boolean {
  if (!descriptor) return false;
  const cam = descriptor.presentation.initialCamera;
  return Boolean(cam.position && cam.target);
}

/** 加载完成时实际采用的初始相机来源。 */
export type InitialCameraSource =
  /** 作者保存的初始视角（`settings.cameras[0].initial` 来自描述符）。 */
  | 'authored'
  /** 官方 `defaultSettings(fit)` 的默认相机（未保存初始视角）。 */
  | 'official-default';

/** 本次加载会采用哪种初始相机（只陈述事实，不猜坐标）。 */
export function initialCameraSource(
  descriptor: SceneRuntimeDescriptorV1 | null,
): InitialCameraSource {
  return hasAuthoredInitialCamera(descriptor) ? 'authored' : 'official-default';
}

/**
 * 运行时最小接口（结构类型）—— 只允许做这两件官方公开操作，故意不暴露
 * 引擎 app / CameraManager，避免调用点绕开本策略去写相机。
 */
export interface InitialCameraRuntime {
  /** 把描述符的世界变换施加到 gsplat 实体（幂等）。 */
  applyWorldTransform(): unknown;
  /** 官方 `resetCamera()`：回到有效初始相机（= `settings.cameras[0].initial`）。 */
  resetCamera(): void;
}

/**
 * 加载完成的**唯一**相机初始化（Desktop / Authoring / XR 共用）。
 *
 * 顺序有意义：先施加世界变换（相机本身已在 RUNTIME 空间，不受影响），
 * 再让官方把相机收敛到初始视角。整个过程只有这一次，不会随轮询 / progress /
 * React 重渲染再次执行（调用点负责 one-shot 门闩）。
 *
 * @returns 本次采用的初始相机来源（供诊断 / 测试断言）。
 */
export function applyInitialCameraPolicy(
  runtime: InitialCameraRuntime,
  descriptor: SceneRuntimeDescriptorV1 | null,
): InitialCameraSource {
  runtime.applyWorldTransform();
  runtime.resetCamera();
  return initialCameraSource(descriptor);
}

/**
 * GS-NEXT-02：创作页「已保存」是否**真的**被运行时采用。
 *
 * 保存接口只写 `scene_presentations`（创作页面板读的那张表），而 Desktop / XR
 * 真正渲染的是 `SceneRuntimeDescriptor`。两者在一种情况下会分叉：场景空间状态
 * 被标记为 STALE（几何变更发布）时，描述符会**有意地**丢弃 initialCamera，
 * 于是「面板显示已保存、每个场景打开却仍是官方默认相机」。
 *
 * 因此创作页不得只看自己的乐观 state 就宣称保存成功，必须比对运行时描述符。
 * 本函数只陈述事实，不猜测 STALE 的成因（描述符里没有该字段）。
 */
export type RuntimeInitialCameraUse =
  /** 从未保存 → 走官方默认相机（符合预期）。 */
  | { status: 'absent' }
  /** 已保存且运行时正在采用。 */
  | { status: 'authored' }
  /** 已保存，但当前运行时描述符没有它 → 打开场景仍用官方默认相机。 */
  | { status: 'ignored' };

/**
 * 比对「已保存的初始视角」与「运行时描述符」。
 *
 * 注意：这里只回答「描述符里**存在** authored 相机吗」（面板提示用），
 * **不是**保存确认。保存后的完整姿态确认（position + target + FOV）一律走
 * `initialCameraSync.savedViewMatchesDescriptor()`，两处不得混用。
 *
 * @param savedPosition - `GET /presentation` 返回的 initialCameraPosition（null = 未保存）。
 * @param descriptor - 当前 `resolveSceneRuntimeDescriptor` 的结果（null = 尚未解析）。
 */
export function runtimeInitialCameraUse(
  savedPosition: { x: number; y: number; z: number } | null | undefined,
  descriptor: SceneRuntimeDescriptorV1 | null,
): RuntimeInitialCameraUse {
  if (!savedPosition) return { status: 'absent' };
  return hasAuthoredInitialCamera(descriptor) ? { status: 'authored' } : { status: 'ignored' };
}
