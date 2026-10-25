/**
 * SceneAuthoringPage — 场景创作页（GS-DESKTOP-02 §3：官方 PlayCanvas PCUI 工作区）。
 *
 * 布局：官方 PCUI 工作区（顶栏 / 左分组 / 中间官方 Viewer / 右侧属性）。
 * 中间的唯一 3D 视图是官方 SuperSplat viewer（SSV-05：不再创建第二套 viewer）。
 *
 * 数据与规则（不变，只是 UI 换成官方 PCUI）：
 *   - 相机数据一律经 SuperSplatRuntime 的封装方法读写（页面不直接触碰 app）；
 *   - 标注 / 视角 / 体验设置 / 世界变换 / 封面 / 背景音频仍走既有 GSPlatform API；
 *   - 保存成功后回读真实 Runtime Descriptor 再宣称成功（GS-NEXT-02）；
 *   - 预览 runtime 只在「描述符相关 revision」变化时重建；属性编辑不重建
 *     （避免相机跳回已保存视角）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Drawer, Modal } from 'antd';
import { PcuiAuthoringWorkspace, type ManagementKind, type WorkspaceSelection } from '../features/authoring/pcui/AuthoringWorkspace';
import { useSceneAuthoring } from '../features/authoring/useSceneAuthoring';
import { GaussianEditorPanel } from '../features/authoring/GaussianEditorPanel';
import { VersionPanel } from '../features/authoring/VersionPanel';
import { CollisionPanel } from '../features/authoring/CollisionPanel';
import { SuperSplatRuntime } from '../scene-runtime/SuperSplatRuntime';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';
import { resolveSceneRuntimeDescriptor } from '../scene-runtime/descriptorResolver';
import {
  runtimeInitialCameraUse,
  applyInitialCameraPolicy,
} from '../scene-runtime/initialCameraPolicy';
// GS-DESKTOP-04 §三：保存成功后让**官方自己的 Reset** 也采用新视角。
// 官方 1.35.0 把 `settings.cameras[0].initial` 在 CameraManager 构造时固化成
// 闭包常量，公开 API 没有运行时更新入口；唯一受支持路径 = 用包含新视角的
// settings 受控重建 Viewer。规则（去重/失败不重建/只换 Viewer 子树）集中在
// initialCameraSync.ts，本页只负责驱动。
import { createInitialCameraSync, type CameraSyncStatus } from '../scene-runtime/initialCameraSync';
import { decideWalkSafety } from '../scene-runtime/walkSafetyPolicy';
import { resolveRuntimeAssetUrl } from '../scene-runtime/assetUrl';import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';
import type { AuthoringCameraPose } from '../features/authoring/authoringTypes';
import type { SceneViewpoint } from '../services/presentationApi';
import type { SceneAnnotation } from '../services/annotationApi';
import {
  listAnnotations,
  createAnnotation as apiCreateAnnotation,
  updateAnnotation as apiUpdateAnnotation,
  deleteAnnotation as apiDeleteAnnotation,
  reorderAnnotations,
} from '../services/annotationApi';
import { updateBackgroundAudio } from '../services/annotationApi';

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/**
 * GS-DESKTOP-04 §三：初始相机同步状态（给用户明确反馈，不静默跳相机）。
 *
 * 类型与判定规则同源：`scene-runtime/initialCameraSync.ts`。
 */

/** 两个相机 pose 是否视为同一构图（位置/朝向/FOV）。 */
function cameraPoseEquals(a: CameraPose, b: CameraPose, tolerance = 1e-3): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= tolerance;
  return (
    near(a.position[0], b.position[0]) &&
    near(a.position[1], b.position[1]) &&
    near(a.position[2], b.position[2]) &&
    near(a.target[0], b.target[0]) &&
    near(a.target[1], b.target[1]) &&
    near(a.target[2], b.target[2]) &&
    near(a.fov, b.fov)
  );
}

export default function SceneAuthoringPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? 'local-garden';
  useDocumentTitle(effectiveSceneId ? `编辑 ${effectiveSceneId}` : '编辑场景');
  const navigate = useNavigate();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SuperSplatRuntime | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerReady, setViewerReady] = useState(false);

  // SSV-06 §七：标注创建/更新/删除后递增，预览 runtime 用最新 descriptor 重建，
  // 官方 hotspot 才出现（预览必须使用官方 hotspot）。
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [annotationOrderRevision, setAnnotationOrderRevision] = useState(0);

  // Annotations (Phase 11)
  const [annotations, setAnnotations] = useState<SceneAnnotation[]>([]);
  const [annotationsSaving, setAnnotationsSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  // GS-NEXT-02：当前预览 runtime 使用的描述符（用于「已保存≠运行时采用」提示）。
  const [activeDescriptor, setActiveDescriptor] = useState<SceneRuntimeDescriptorV1 | null>(null);

  // GS-NEXT-11：版本切换成功后递增 —— 描述符/预览必须重新读取（不做乐观假设）。
  const [versionRevision, setVersionRevision] = useState(0);

  // GS-DESKTOP-02 §3.1：相机编辑模式（官方 Studio 语义：编辑中 / Apply / Cancel）。
  const [cameraEdit, setCameraEdit] = useState(false);

  // GS-DESKTOP-04 §三：初始相机同会话同步。
  // 官方 1.35.0 的 Reset 目标在 CameraManager 构造时固化，公开 API 无运行时
  // 更新入口 → 保存成功且描述符确认采用后，做**一次**受控 Viewer 重建。
  // `cameraResyncKey` 只由本页的保存路径递增（绝不由轮询/其他 state 驱动），
  // 因此不存在重建循环。
  const [cameraResyncKey, setCameraResyncKey] = useState(0);
  const [cameraSync, setCameraSync] = useState<CameraSyncStatus>('idle');
  const [cameraSyncError, setCameraSyncError] = useState<string | null>(null);
  const cameraSyncState = useRef(createInitialCameraSync());
  /** 重建后要恢复的「用户当时所在视角」（与保存目标不同时才有值）。 */
  const cameraRestorePoseRef = useRef<CameraPose | null>(null);
  /** 上一次真正写入成功的「版本 + pose」签名（GS-DESKTOP-04 §三/§四：一次用户
   *  动作最多一次保存 / 一次重建；同签名重复触发直接 no-op）。 */
  const lastSavedPayloadRef = useRef<string | null>(null);

  const authoring = useSceneAuthoring(effectiveSceneId);

  // 已保存的初始视角是否真的被运行时采用（见 initialCameraPolicy 说明）。
  const initialViewUse = runtimeInitialCameraUse(
    authoring.presentation?.initialCameraPosition,
    activeDescriptor,
  );

  // 官方 SuperSplatRuntime 预览（SSV-05）：
  // descriptor → buildExperienceSettings（官方 settings v2）→ SuperSplatRuntime。
  // 体验设置保存成功后 authoring.settingsRevision 递增 → 用最新 settings 重建。
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let runtime: SuperSplatRuntime | null = null;
    setLoading(true);
    setViewerReady(false);

    const boot = async () => {
      try {
        const { descriptor } = await resolveSceneRuntimeDescriptor(effectiveSceneId);
        if (cancelled) return;
        if (!descriptor.content.url) {
          throw new Error('场景尚未发布，无法预览');
        }
        setActiveDescriptor(descriptor);
        const settings = buildExperienceSettings(descriptor);
        // GS-DESKTOP-04 §六：创作页预览与 /scene 走**同一个** walk 安全闸门。
        // 平台判定不安全（未校准 / STALE / 未 attach）就不注入碰撞资源，
        // 官方 walkAllowed 因此为 false —— 预览里同样不能靠键盘 3 走进不安全 Walk。
        const previewWalkSafety = decideWalkSafety({ descriptor });
        runtime = await SuperSplatRuntime.create({
          container: containerRef.current!,
          contentUrl: descriptor.content.url,
          settings,
          posterUrl: descriptor.scene.posterUrl ?? undefined,
          collisionUrl: previewWalkSafety.safe
            ? resolveRuntimeAssetUrl(descriptor.collision?.url) ?? undefined
            : undefined,
          mode: 'desktop',
          // SSV-06：官方 annotation hotspots/tooltip 层（预览必须使用官方 hotspot）。
          ui: true,
          // FIX-02 §5：作者预览与 /scene 施加**同一**世界变换（W），所见即所得。
          worldTransform: descriptor.presentation.worldTransform,
          viewpoints: descriptor.viewpoints,
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        // DEV-only 调试把柄（生产构建 import.meta.env.DEV=false，不输出）。
        // 与 /scene 的 window.__gsruntime、/xr 的 window.__gsxrruntime 同一做法：
        // e2e 直接读取预览 runtime 的真实相机 pose（不触碰 React 内部状态）。
        if (import.meta.env.DEV) {
          (window as unknown as { __gsauthoringruntime?: unknown }).__gsauthoringruntime = runtime;
        }
        // 闭包内保留非空引用（TS 收窄在回调里失效）。
        const active = runtime;
        let initialized = false;
        const syncLoaded = (loaded: boolean) => {
          if (!cancelled) {
            setViewerReady(loaded);
            if (loaded && !initialized) {
              initialized = true;
              // GS-DESKTOP-01：创作预览与 /scene 走**完全相同**的起始相机规则
              // （单一权威来源 initialCameraPolicy.applyInitialCameraPolicy）——
              // 世界变换 + resetCamera()。authored Initial Camera 存在 → 保持作者
              // 已保存的初始构图；不存在 → 官方默认相机，**不取景整个 AABB**。
              applyInitialCameraPolicy(active, descriptor);
              // GS-DESKTOP-04：这个 Viewer 的官方 Reset 目标就此固定为
              // `settings.cameras[0].initial`（= 本次描述符里的初始相机）。
              cameraSyncState.current.adopt(descriptor);
              // 重建后**恢复用户当时的视角**：保存动作不得让画面跳远。
              // 恢复走官方唯一受支持的任意 pose 路径（selectAnnotation 过渡），
              // 不写官方内部状态。
              const restore = cameraRestorePoseRef.current;
              if (restore) {
                cameraRestorePoseRef.current = null;
                try {
                  active.setCameraPose(restore);
                } catch {
                  /* 恢复失败不影响 Reset 目标已正确这一事实 */
                }
              }
              setCameraSync('synced');
              setCameraSyncError(null);
            }
          }
        };
        active.onLoaded(syncLoaded);
        syncLoaded(active.loaded);
      } catch (err) {
        if (!cancelled) {
          // GS-DESKTOP-04 §三：同步重建失败必须**明确提示**并保留重试入口，
          // 不能显示「已保存成功」。旧 Viewer 已被本 effect 的清理函数销毁，
          // 这里只更新状态；页面提供「重新同步」按钮。
          setCameraSync('failed');
          setCameraSyncError(err instanceof Error ? err.message : String(err));
          // 首次加载失败仍是致命错误（没有可用的 Viewer）。
          if (cameraSyncState.current.syncedKey() === null) {
            Modal.error({ content: '场景加载失败' });
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void boot();

    return () => {
      cancelled = true;
      runtime?.destroy();
      runtimeRef.current = null;
      // DEV-only 调试把柄必须一并清掉：headless SwiftShader 下保留一个已销毁
      // runtime 的强引用会阻止 WebGPU 设备释放，随后的页面跳转会卡死
      // （GS-NEXT-10 / fresh-browser.ts 记录的同类问题）。
      if (import.meta.env.DEV) {
        (window as unknown as { __gsauthoringruntime?: unknown }).__gsauthoringruntime = null;
      }
    };
  }, [effectiveSceneId, authoring.settingsRevision, annotationRevision, annotationOrderRevision, versionRevision, cameraResyncKey]);

  // Load annotations on mount (Phase 11)
  useEffect(() => {
    let cancelled = false;
    listAnnotations(effectiveSceneId)
      .then((data) => { if (!cancelled) setAnnotations(data); })
      .catch(() => { /* allow editing without backend (dev mode) */ });
    return () => { cancelled = true; };
  }, [effectiveSceneId]);

  // ------------------------------------------------------------------ //
  // 相机：读 / 写（经 SuperSplatRuntime 封装；页面不触碰 app）
  // ------------------------------------------------------------------ //

  /**
   * 读取**最新**运行时描述符（GS-DESKTOP-04 §四：保存后必须以后端为准，
   * 不得把旧版本的视角绑定到新 SceneVersion）。
   */
  const currentDescriptor = useCallback(async (): Promise<SceneRuntimeDescriptorV1 | null> => {
    try {
      const { descriptor } = await resolveSceneRuntimeDescriptor(effectiveSceneId);
      setActiveDescriptor(descriptor);
      return descriptor;
    } catch {
      return null;
    }
  }, [effectiveSceneId]);

  /**
   * 当前相机 pose —— 经 SuperSplatRuntime 封装读取（页面不触碰 app）。
   * FIX-02 §5：引擎返回 RUNTIME 空间（世界变换已施加）—— 存回 SCENE 空间，
   * 使初始视角/视角点在世界变换变化后仍钉在同一内容上。
   */
  const getCurrentPose = useCallback(async (): Promise<CameraPose | null> => {
    const runtime = runtimeRef.current;
    if (!runtime) return null;
    let pose = null;
    try {
      // 以 runtime 自己的 loaded 状态为准，而不是 React state：PCUI 事件处理器
      // 在挂载时冻结闭包（见 PcuiButton 注释），若在这里读 viewerReady 会永远
      // 读到挂载时的 false。
      if (!runtime.loaded) return null;
      pose = runtime.getCameraPose();
    } catch {
      return null;
    }
    if (!pose) return null;
    const scene = runtime.worldTransform.runtimeToSceneCamera({
      position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
      target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      fov: pose.fov,
    });
    return {
      position: [scene.position.x, scene.position.y, scene.position.z],
      target: [scene.target.x, scene.target.y, scene.target.z],
      fov: scene.fov,
    };
  }, []);

  /** 定位到已保存初始视角（Reset 语义：官方 resetCamera 收敛到 authored 相机）。 */
  const handleResetToSaved = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.loaded) return;
    try {
      runtime.resetCamera();
    } catch { /* 未就绪：无操作 */ }
  }, []);

  /**
   * GS-NEXT-02 + GS-DESKTOP-04：保存后**必须**回读运行时描述符再宣称成功，
   * 并据其结果决定是否需要把新视角同步进当前 Viewer。
   *
   * `setInitialView` 只写 `scene_presentations`；真正渲染的描述符在场景空间状态
   * 被标记为失效时会**有意地**丢弃 initialCamera —— 那时「面板显示已保存」而
   * 「打开场景仍是官方鸟瞰」。这里把两者对齐：只有描述符真的带上这个视角才
   * 宣称成功，并且**只有这时**才允许触发同步重建；否则明确告知失败原因，
   * 官方 Reset 继续指向旧视角（不会把未采用的视角当成新目标）。
   *
   * @returns true = 后端已采用该视角（可安全触发同步）。
   */
  const verifyInitialViewUsed = useCallback(async (saved: CameraPose): Promise<boolean> => {
    let fresh: SceneRuntimeDescriptorV1 | null = null;
    try {
      fresh = (await resolveSceneRuntimeDescriptor(effectiveSceneId)).descriptor;
      setActiveDescriptor(fresh);
    } catch {
      Modal.warning({ content: '初始视角已保存，但未能读取运行时描述符，无法确认是否已采用；当前 Viewer 的 Reset 仍是旧视角' });
      return false;
    }
    const use = runtimeInitialCameraUse(
      { x: saved.position[0], y: saved.position[1], z: saved.position[2] },
      fresh,
    );
    if (use.status !== 'authored') {
      Modal.error({
        content:
          '初始视角已写入数据库，但运行时未采用它：打开场景仍会使用官方默认相机。'
          + '这通常是因为场景几何变更后空间绑定被判定为失效，需要重新校验后再次保存。',
      });
      return false;
    }
    return true;
  }, [effectiveSceneId]);

  /**
   * 保存成功后把新视角同步进**当前** Viewer（一次受控重建）。
   *
   * 只有两个条件同时成立才重建：
   *   1. 后端描述符确认采用（verifyInitialViewUsed === true）；
   *   2. 当前 Viewer 的 Reset 目标 key ≠ 新视角（initialCameraSync 判定）。
   * 满足时记录用户当前所在视角，重建完成后恢复它 —— 保存动作不会造成跳远。
   */
  const syncInitialCameraIfNeeded = useCallback(
    async (saved: CameraPose, descriptor: SceneRuntimeDescriptorV1 | null) => {
      const verdict = cameraSyncState.current.evaluate(saved, descriptor);
      if (verdict === 'ignored') {
        // 已在 verifyInitialViewUsed 中明确报错；这里不做任何重建。
        return;
      }
      if (verdict === 'already-synced') {
        setCameraSync('synced');
        setCameraSyncError(null);
        Modal.success({ content: '已保存（初始视角已更新，打开场景将采用该视角）' });
        return;
      }
      // resync-needed：记录「用户当时在哪」，避免重建后画面跳远。
      const current = await getCurrentPose();
      cameraRestorePoseRef.current = current && !cameraPoseEquals(current, saved) ? current : null;
      setCameraSync('syncing');
      setCameraSyncError(null);
      // 一条消息说清两件事：视角**已保存**、且正在把这个新目标同步进当前 Viewer。
      // 同步进度/失败由面板里的 `camera-sync-progress` / `camera-sync-failed` 承载，
      // 不在弹窗里重复（GS-DESKTOP-04 §七：不堆叠弹窗）。
      Modal.success({
        content: '已保存（初始视角已更新，打开场景将采用该视角）。正在把新初始视角同步到当前 Viewer —— 官方 Reset 目标会一起更新…',
        okText: '知道了',
      });
      setCameraResyncKey((k) => k + 1);
    },
    [getCurrentPose],
  );

  /** 初始视角面板的保存走同一条「保存 → 校验运行时 → 同步 Viewer」链路。 */
  const handleSaveCurrentAsInitial = useCallback(async () => {
    // GS-DESKTOP-04 §四：同步重建进行中不并发保存（描述符可能与正在装载的
    // Viewer 不一致）。
    if (cameraSync === 'syncing') {
      Modal.warning({ content: '正在同步初始视角，请稍候再保存' });
      return;
    }
    const pose = await getCurrentPose();
    if (!pose) {
      Modal.error({ content: '保存失败：Viewer 未就绪' });
      return;
    }
    // GS-DESKTOP-04 §四：保存期间版本可能切换。记录当前版本，保存后用**新读到的**
    // 描述符校验：若版本已变（描述符 content 变了），这个视角属于旧内容，
    // 绝不把它同步成新版本的 Reset 目标。
    const before = activeDescriptor?.content?.url ?? null;
    // GS-DESKTOP-04 §三/§四：同一个 pose + 同一个版本重复保存是 no-op —— 不写库、
    // 不重建、不弹窗。典型来源是 PCUI 控件的 prop 回显（见 PcuiNumericInput）与
    // 双击；一次用户动作最多触发 **一次** Viewer 重建。
    const payloadKey = [
      before ?? '',
      pose.position.join(','),
      pose.target.join(','),
      pose.fov,
    ].join('|');
    if (lastSavedPayloadRef.current === payloadKey) return;
    try {
      await authoring.setInitialView(pose);
    } catch {
      // 保存失败：不推进同步状态，官方 Reset 仍是旧视角（需求 §四）。
      cameraSyncState.current.markSaveFailed();
      setCameraSync('idle');
      Modal.error({
        content: '保存失败：请确认你对该场景有编辑权限，且 Viewer 已就绪',
      });
      return;
    }
    const adopted = await verifyInitialViewUsed(pose);
    setCameraEdit(false);
    if (!adopted) {
      lastSavedPayloadRef.current = null;
      setCameraSync('idle');
      return;
    }
    lastSavedPayloadRef.current = payloadKey;
    const fresh = await currentDescriptor();
    if (before !== null && fresh && fresh.content.url !== before) {
      Modal.error({
        content: '保存期间场景版本已切换：这个视角属于旧版本，已不同步到当前 Viewer。请重新保存。',
      });
      setCameraSync('idle');
      return;
    }
    await syncInitialCameraIfNeeded(pose, fresh);
  }, [authoring, getCurrentPose, verifyInitialViewUsed, syncInitialCameraIfNeeded, currentDescriptor, cameraSync, activeDescriptor]);

  /** 相机编辑模式：进入 → 复位到已保存视角 → 用户取景 → Apply / Cancel。 */
  const handleEnterCameraEdit = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.loaded) {
      Modal.warning({ content: 'Viewer 未就绪，无法编辑相机' });
      return;
    }
    handleResetToSaved();
    setCameraEdit(true);
  }, [handleResetToSaved]);

  const handleApplyCameraEdit = useCallback(async () => {
    await handleSaveCurrentAsInitial();
  }, [handleSaveCurrentAsInitial]);

  const handleCancelCameraEdit = useCallback(() => {
    // Cancel 不保存，但把相机退回已保存视角（官方 Studio 同语义）。
    handleResetToSaved();
    setCameraEdit(false);
  }, [handleResetToSaved]);

  const handleSetFov = useCallback(async (fov: number) => {
    const pose = await getCurrentPose();
    if (!pose) return;
    const next: CameraPose = { ...pose, fov };
    // 与保存视角同一条防线：同样的 FOV + 同样的版本不重复写入 / 不重复重建。
    const payloadKey = [
      activeDescriptor?.content?.url ?? '',
      next.position.join(','),
      next.target.join(','),
      next.fov,
    ].join('|');
    if (lastSavedPayloadRef.current === payloadKey) return;
    try {
      await authoring.setInitialView(next);
    } catch {
      cameraSyncState.current.markSaveFailed();
      Modal.error({ content: '保存 FOV 失败' });
      return;
    }
    lastSavedPayloadRef.current = payloadKey;
    const adopted = await verifyInitialViewUsed(next);
    if (!adopted) {
      lastSavedPayloadRef.current = null;
      return;
    }
    const fresh = await currentDescriptor();
    await syncInitialCameraIfNeeded(next, fresh);
  }, [authoring, getCurrentPose, verifyInitialViewUsed, syncInitialCameraIfNeeded, currentDescriptor, activeDescriptor]);

  /**
   * 重新同步入口（任务 §三：重建失败必须保留可重试入口）。
   * 不清除已保存的视角、不改任何数据；只重新读取描述符并再走一次重建。
   */
  const handleRetryCameraSync = useCallback(async () => {
    if (!authoring.presentation?.initialCameraPosition) {
      Modal.warning({ content: '尚未保存初始视角，无需同步' });
      return;
    }
    const fresh = await currentDescriptor();
    if (!fresh) {
      Modal.error({ content: '无法读取运行时描述符，请稍后重试' });
      return;
    }
    // 尽量保住用户当前所在视角，重建后恢复。
    cameraRestorePoseRef.current = await getCurrentPose();
    setCameraSync('syncing');
    setCameraSyncError(null);
    setCameraResyncKey((k) => k + 1);
  }, [authoring.presentation, currentDescriptor, getCurrentPose]);

  const handleCaptureCover = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || !viewerReady) {
      Modal.error({ content: '截取封面失败，请确认 Viewer 已就绪' });
      return;
    }
    try {
      const result = await runtime.captureScreenshot({ width: 960, height: 540, supersample: 2 });
      if (!result) {
        Modal.error({ content: '截取封面失败，请确认 Viewer 已就绪' });
        return;
      }
      const blob = await (await fetch(result.dataUrl)).blob();
      const file = new File([blob], 'cover.webp', { type: 'image/webp' });
      await authoring.uploadCover(file);
      Modal.success({ content: '封面已截取' });
    } catch {
      Modal.error({ content: '截取封面失败' });
    }
  }, [viewerReady, authoring.uploadCover]);

  const handleNavigateViewpoint = useCallback((vp: SceneViewpoint) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // FIX-02 §5/§11：视角点存 SCENE 空间 —— 定位时经 adapter 换算到 RUNTIME。
    const rt = runtime.worldTransform.sceneToRuntimeCamera({
      position: vp.position,
      target: vp.target,
      fov: vp.fov,
    });
    runtime.setCameraPose({
      position: [rt.position.x, rt.position.y, rt.position.z],
      target: [rt.target.x, rt.target.y, rt.target.z],
      fov: rt.fov,
    });
  }, []);

  // ------------------------------------------------------------------ //
  // 标注（§3.2）：真实 3D 拾取 → 数据库 → 官方 hotspot → 官方导览器
  // ------------------------------------------------------------------ //

  /** 标注放置模式下的 viewer 点击：NDC → 近似锚点 → 捕获作者相机 → 落库。 */
  const handleViewerClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!picking) return;
    const runtime = runtimeRef.current;
    if (!runtime || !viewerReady) {
      Modal.warning({ content: 'Viewer 未就绪，无法拾取位置' });
      return;
    }
    // 容器内坐标 → NDC（x 向右、y 向上，均为 -1..1）
    const rect = e.currentTarget.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const hit = runtime.pickApproximateWorldPosition(ndcX, ndcY);
    if (!hit) {
      Modal.error({ content: '拾取位置失败，请确保场景已加载' });
      return;
    }
    // FIX-05 §29：拾取为「近似锚点」（bbox 深度近似，不保证命中 splat 表面）——
    // UI 中明示，避免把近似值当成精确表面坐标。
    // FIX-02 §5/§13：拾取点是引擎（RUNTIME）空间 —— 存回 SCENE 空间。
    const sceneAnchor = runtime.worldTransform.runtimeToScenePoint({
      x: hit.position[0],
      y: hit.position[1],
      z: hit.position[2],
    });
    // §13：同时保存作者当前 Viewer 相机（标注自己的相机 pose，SCENE 空间）。
    const enginePose = runtime.getCameraPose();
    let camera: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; fov: number } | null = null;
    if (enginePose) {
      camera = runtime.worldTransform.runtimeToSceneCamera({
        position: { x: enginePose.position[0], y: enginePose.position[1], z: enginePose.position[2] },
        target: { x: enginePose.target[0], y: enginePose.target[1], z: enginePose.target[2] },
        fov: enginePose.fov,
      });
    }
    try {
      const ann = await apiCreateAnnotation(effectiveSceneId, {
        anchorX: sceneAnchor.x,
        anchorY: sceneAnchor.y,
        anchorZ: sceneAnchor.z,
        ...(camera
          ? { cameraPosition: camera.position, cameraTarget: camera.target, cameraFov: camera.fov }
          : {}),
      });
      setAnnotations((prev) => [...prev, ann]);
      setAnnotationRevision((n) => n + 1);
      setPicking(false);
      Modal.success({ content: '标注已创建（锚点为近似位置，可在属性区继续编辑）' });
    } catch {
      Modal.error({ content: '创建标注失败，请重试' });
    }
  }, [picking, effectiveSceneId, viewerReady]);

  const handleSaveAnnotation = useCallback(async (id: string, patch: Partial<SceneAnnotation>) => {
    setAnnotationsSaving(true);
    try {
      const updated = await apiUpdateAnnotation(effectiveSceneId, id, patch);
      setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a)));
      setAnnotationRevision((n) => n + 1);
    } catch {
      Modal.error({ content: '保存标注失败，请重试' });
    } finally {
      setAnnotationsSaving(false);
    }
  }, [effectiveSceneId]);

  const handleDeleteAnnotation = useCallback(async (id: string) => {
    try {
      await apiDeleteAnnotation(effectiveSceneId, id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setAnnotationRevision((n) => n + 1);
    } catch {
      Modal.error({ content: '删除标注失败，请重试' });
    }
  }, [effectiveSceneId]);

  const handleMoveAnnotation = useCallback(async (id: string, direction: -1 | 1) => {
    const sorted = annotations.slice().sort((a, b) => a.orderIndex - b.orderIndex);
    const index = sorted.findIndex((a) => a.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    const next = sorted.map((a) => a.id);
    [next[index], next[target]] = [next[target], next[index]];
    try {
      const reordered = await reorderAnnotations(effectiveSceneId, next);
      setAnnotations(reordered);
      setAnnotationOrderRevision((n) => n + 1);
    } catch {
      Modal.error({ content: '排序失败，请重试' });
    }
  }, [annotations, effectiveSceneId]);

  /** 定位：经官方 hotspot 选中该标注（官方相机过渡）。 */
  const handleNavigateAnnotation = useCallback((id: string) => {
    runtimeRef.current?.selectGsplatformAnnotation(id);
  }, []);

  /** 用当前 Viewer 相机覆盖标注自己的相机 pose。 */
  const handleCaptureAnnotationCamera = useCallback(async (id: string) => {
    const pose = await getCurrentPose();
    if (!pose) {
      Modal.warning({ content: 'Viewer 未就绪，无法捕获相机' });
      return;
    }
    await handleSaveAnnotation(id, {
      cameraPosition: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
      cameraTarget: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      cameraFov: pose.fov,
    });
    Modal.success({ content: '已用当前视角更新该标注的相机' });
  }, [getCurrentPose, handleSaveAnnotation]);

  // ------------------------------------------------------------------ //
  // 观察点（§3.3）：Viewpoint 与 Annotation 是不同数据对象，不合并
  // ------------------------------------------------------------------ //

  const handleAddViewpointFromCurrent = useCallback(async (name: string) => {
    const pose = await getCurrentPose();
    if (!pose) {
      Modal.warning({ content: 'Viewer 未就绪，无法保存视角' });
      return;
    }
    try {
      await authoring.addViewpoint(name, pose);
      Modal.success({ content: `视角「${name}」已保存` });
    } catch {
      Modal.error({ content: '保存视角失败，请重试' });
    }
  }, [authoring, getCurrentPose]);

  const handleUpdateViewpointPose = useCallback(async (id: string, pose: AuthoringCameraPose) => {
    try {
      await authoring.updateViewpoint(id, {
        position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
        target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
        fov: pose.fov,
      });
    } catch {
      Modal.error({ content: '更新视角失败，请重试' });
    }
  }, [authoring]);

  const handleMoveViewpoint = useCallback(async (id: string, direction: -1 | 1) => {
    const sorted = authoring.viewpoints.slice().sort((a, b) => a.orderIndex - b.orderIndex);
    const index = sorted.findIndex((v) => v.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    const ids = sorted.map((v) => v.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await authoring.reorderViewpoints(ids);
    } catch {
      Modal.error({ content: '排序失败，请重试' });
    }
  }, [authoring]);

  // ------------------------------------------------------------------ //
  // 平台级入口（§3.5 / §4：Editor / 版本 / 碰撞）
  // ------------------------------------------------------------------ //

  const [management, setManagement] = useState<ManagementKind | null>(null);
  const handleOpenManagement = useCallback((kind: ManagementKind) => {
    setManagement(kind);
  }, []);

  /**
   * GS-NEXT-11 §6：切换历史版本成功后必须重新读取真实状态，并明确提示
   * 「哪些空间配置需要重新确认」——空间配置属于场景而不是版本，切换几何体后
   * 运行时按保守策略停用它们。
   */
  const handleVersionSwitched = useCallback(
    (result: { currentVersionId: string; spatialStale: boolean }) => {
      setVersionRevision((n) => n + 1);
      void authoring.refreshPresentation();
      void listAnnotations(effectiveSceneId)
        .then((data) => setAnnotations(data))
        .catch(() => { /* 预览仍可使用，不阻塞版本切换结果 */ });
      if (result.spatialStale) {
        Modal.warning({
          content: '版本已切换：空间配置（初始视角 / 观察点 / 标注 / 碰撞）需要重新确认。',
        });
      }
    },
    [authoring, effectiveSceneId],
  );

  const [selection, setSelection] = useState<WorkspaceSelection>({
    kind: 'scene',
    section: 'camera',
  });

  const handleUploadBackground = useCallback(async (file: File) => {
    try {
      await authoring.uploadBackground(file);
      Modal.success({ content: '全景背景已上传' });
    } catch {
      Modal.error({ content: '上传背景失败' });
    }
  }, [authoring]);

  const handleUploadCover = useCallback(async (file: File) => {
    try {
      await authoring.uploadCover(file);
      Modal.success({ content: '封面已更新' });
    } catch {
      Modal.error({ content: '上传封面失败' });
    }
  }, [authoring]);

  const handleUploadAudio = useCallback(async (file: File) => {
    try {
      const form = new FormData();
      form.append('file', file);
      const resp = await fetch('/api/v1/upload', {
        method: 'POST',
        body: form,
        headers: { 'X-CSRF-Token': localStorage.getItem('csrf') ?? '' },
      });
      if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
      const data = await resp.json();
      const assetId: string | undefined = data?.asset?.id ?? data?.assetId;
      if (!assetId) throw new Error('upload response missing asset id');
      await updateBackgroundAudio(effectiveSceneId, { assetId });
      await authoring.refreshPresentation();
      Modal.success({ content: '背景音乐已上传' });
    } catch {
      Modal.error({ content: '背景音乐上传失败' });
    }
  }, [authoring, effectiveSceneId]);

  const handleUpdateAudio = useCallback(async (patch: {
    volume?: number;
    loop?: boolean;
    enabled?: boolean;
  }) => {
    try {
      await updateBackgroundAudio(effectiveSceneId, patch);
      await authoring.refreshPresentation();
    } catch {
      Modal.error({ content: '更新背景音乐失败' });
    }
  }, [authoring, effectiveSceneId]);

  /** GS-NEXT-11 §6：版本切换成功后必须重新读取真实状态（通过路由返回本页时）。 */
  useEffect(() => {
    void authoring.refreshPresentation();
  }, [versionRevision]);

  const handleSetWorldScale = useCallback(
    async (v: { x: number; y: number; z: number }) => {
      try {
        await authoring.setWorldScale(v);
      } catch {
        Modal.error({ content: '保存世界缩放失败' });
      }
    },
    [authoring],
  );

  return (
    <>
      <PcuiAuthoringWorkspace
      sceneId={effectiveSceneId}
      viewerReady={viewerReady}
      loading={loading}
      containerRef={containerRef}
      selection={selection}
      onSelect={setSelection}
      annotations={annotations}
      annotationsSaving={annotationsSaving}
      picking={picking}
      onStartPicking={() => setPicking(true)}
      onCancelPicking={() => setPicking(false)}
      onSaveAnnotation={handleSaveAnnotation}
      onDeleteAnnotation={handleDeleteAnnotation}
      onMoveAnnotation={handleMoveAnnotation}
      onNavigateAnnotation={handleNavigateAnnotation}
      onCaptureAnnotationCamera={handleCaptureAnnotationCamera}
      onViewerClick={handleViewerClick}
      presentation={authoring.presentation}
      authoringSaving={authoring.saving}
      initialViewUse={initialViewUse}
      onResetToSaved={handleResetToSaved}
      onSaveCurrentAsInitial={handleSaveCurrentAsInitial}
      onSetFov={handleSetFov}
      cameraSync={cameraSync}
      cameraSyncError={cameraSyncError}
      onRetryCameraSync={handleRetryCameraSync}
      cameraEdit={cameraEdit}
      onEnterCameraEdit={handleEnterCameraEdit}
      onApplyCameraEdit={handleApplyCameraEdit}
      onCancelCameraEdit={handleCancelCameraEdit}
      onSetWorldRotation={authoring.setWorldRotation}
      onSetWorldScale={handleSetWorldScale}
      onSetBackgroundType={authoring.setBackgroundType}
      onSetBackgroundColor={authoring.setBackgroundColor}
      onUploadBackground={handleUploadBackground}
      onSetTonemapping={authoring.setTonemapping}
      onSetHighPrecisionRendering={authoring.setHighPrecisionRendering}
      onSetPostEffects={authoring.setPostEffects}
      onUploadCover={handleUploadCover}
      onCaptureCover={handleCaptureCover}
      onUploadAudio={handleUploadAudio}
      onUpdateAudio={handleUpdateAudio}
      viewpoints={authoring.viewpoints}
      activeViewpointId={authoring.activeViewpointId}
      onAddViewpointFromCurrent={handleAddViewpointFromCurrent}
      onRenameViewpoint={(id, name) => authoring.updateViewpoint(id, { name })}
      onToggleViewpoint={(id, enabled) => authoring.updateViewpoint(id, { enabled })}
      onDeleteViewpoint={authoring.deleteViewpoint}
      onMoveViewpoint={handleMoveViewpoint}
      onUpdateViewpointPose={handleUpdateViewpointPose}
      onNavigateViewpoint={handleNavigateViewpoint}
      onSetActiveViewpoint={authoring.setActiveViewpoint}
      getCurrentPose={getCurrentPose}
      onBack={() => navigate(-1)}
      onPreview={() => navigate(`/scene/${effectiveSceneId}`)}
      onOpenManagement={handleOpenManagement}
      />
      {/* §3.5 / §4：平台管理入口（不属于官方 Viewer/Editor）。
          既有安全面板原样保留，只改变入口位置。 */}
      <Drawer
        title={
          management === 'editor'
            ? 'Gaussian 几何编辑（官方 SuperSplat Editor v3.5.2）'
            : management === 'versions'
              ? '版本历史'
              : '碰撞与 Walk 安全'
        }
        placement="right"
        width={480}
        open={management !== null}
        onClose={() => setManagement(null)}
        destroyOnHidden={false}
      >
        {management === 'editor' && <GaussianEditorPanel sceneId={effectiveSceneId} />}
        {management === 'versions' && (
          <VersionPanel sceneId={effectiveSceneId} onSwitched={handleVersionSwitched} />
        )}
        {management === 'collision' && <CollisionPanel sceneId={effectiveSceneId} isOwner={true} />}
      </Drawer>
    </>
  );
}
