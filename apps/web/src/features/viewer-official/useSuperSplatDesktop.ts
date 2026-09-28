/**
 * Official Desktop Scene Runtime hook（SSV-03）—— `/scene/:sceneId` 默认路径。
 *
 * 数据流（唯一）：
 *   resolveSceneRuntimeDescriptor(sceneId)        （DB 合同，404 回退 manifest）
 *     → buildExperienceSettings(descriptor)        （官方 settings v2）
 *     → SuperSplatRuntime.create({ mode: 'desktop' })（官方 viewer，无 iframe）
 *
 * 生命周期：
 *   - mount / sceneId 变化 → create；旧 runtime 先 destroy（幂等）
 *   - unmount → destroy；无 WebGL context 泄漏
 *   - 所有事件经 SuperSplatRuntime 订阅，destroy 后无 listener 残留
 *   - retry = 重新走完整 boot（reloadKey）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveSceneRuntimeDescriptor } from '../../scene-runtime/descriptorResolver';
import { buildExperienceSettings } from '../../scene-runtime/experienceAdapter';
import { resolveRuntimeAssetUrl } from '../../scene-runtime/assetUrl';
import {
  renderedSplatCount,
  runtimeRenderer,
  SuperSplatRuntime,
  type GsplatformAnnotationRef,
  type RuntimeCameraMode,
} from '../../scene-runtime/SuperSplatRuntime';
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import { SuperSplatRuntimeError } from '../../scene-runtime/runtimeErrors';
import {
  assessSceneScale,
  type SceneScaleAssessment,
} from '../../scene-runtime/sceneScale';
import type { SceneRuntimeDescriptorV1 } from '../../scene-runtime/types';

export type OfficialViewerStatus = 'loading' | 'ready' | 'error';

export interface OfficialDesktopViewerState {
  /** 'loading' 描述解析/创建/加载中；'ready' 首帧后；'error' 任一环节失败。 */
  status: OfficialViewerStatus;
  /** 可展示的错误信息（null = 无）。 */
  error: string | null;
  /** 内容加载进度 0..100（onProgress）。 */
  progress: number;
  /** 实际渲染器（webgl2 / webgpu / unknown）。 */
  renderer: string;
  /** 首帧渲染完成。 */
  loaded: boolean;
  /** 当前帧已渲染 Gaussian 数。 */
  gsplats: number;
  cameraMode: RuntimeCameraMode;
  performanceMode: boolean;
  showAnnotations: boolean;
  isFullscreen: boolean;
  hasCollision: boolean;
  /** 官方 walkAllowed —— 碰撞已加载且场景足够大（官方 state.walkAllowed）。 */
  walkAllowed: boolean;
  /** 碰撞工件格式（voxel = 官方体素，glb = 官方 mesh）。 */
  collisionFormat: string | null;
  /**
   * 尺度诊断（SSV-07 §4）。`needsCalibration` 为真时 Walk 入口禁用 ——
   * 禁止默默用错误尺度走路。
   */
  sceneScale: SceneScaleAssessment;
  canStartVR: boolean;
  /** 当前场景运行时描述（null = 尚未解析/失败）。 */
  descriptor: SceneRuntimeDescriptorV1 | null;
  /** 描述来自 manifest 回退（开发仓库场景）还是 DB 合同。 */
  isManifestFallback: boolean;
  /** 挂到 canvas mount 元素。 */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 当前 live runtime（供诊断/测试）。 */
  runtimeRef: React.RefObject<SuperSplatRuntime | null>;
  /** 重新走完整 boot（销毁重建）。 */
  retry: () => void;
  frameScene: () => void;
  resetCamera: () => void;
  /** 直接把相机摆到给定 pose（官方一次性摆放，用于测试/导航定位）。 */
  setCameraPose: (pose: CameraPose) => void;
  requestFullscreen: () => void;
  /** 退出本 viewer 的全屏。 */
  exitFullscreen: () => void;
  /** 写入官方 state.cameraMode（orbit / fly / …）。 */
  setCameraMode: (mode: RuntimeCameraMode) => void;
  /** 切换 performanceMode（官方 state 写入）。 */
  togglePerformanceMode: () => void;
  /** 切换 annotation 可见性（官方 state 写入）。 */
  toggleAnnotationsVisibility: () => void;
  /** 进入/退出 walk 模式（官方 toggleWalk；walkAllowed 为 false 时无效）。 */
  toggleWalk: () => void;
  /**
   * 官方当前选中 annotation 的 GSPlatform extras 引用（SSV-06）。
   * 页面用它经 annotationId 解析 SceneAnnotation / 打开媒体 Overlay；
   * 关闭 Overlay 不清除本值（不清除官方 selection）。
   */
  selectedGsplatformAnnotation: GsplatformAnnotationRef | null;
}

const STATS_POLL_MS = 1000;

function errorMessage(err: unknown): string {
  if (err instanceof SuperSplatRuntimeError) return `SuperSplatRuntimeError(${err.kind}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useSuperSplatDesktop(sceneId: string): OfficialDesktopViewerState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SuperSplatRuntime | null>(null);
  const unsubsRef = useRef<(() => void)[]>([]);
  const pollRef = useRef<number | null>(null);
  const sceneIdRef = useRef(sceneId);
  sceneIdRef.current = sceneId;

  const [status, setStatus] = useState<OfficialViewerStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [renderer, setRenderer] = useState('—');
  const [loaded, setLoaded] = useState(false);
  const [gsplats, setGsplats] = useState(0);
  const [cameraMode, setCameraModeState] = useState<RuntimeCameraMode>('orbit');
  const [performanceMode, setPerformanceModeState] = useState(false);
  const [showAnnotations, setShowAnnotationsState] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasCollision, setHasCollision] = useState(false);
  const [walkAllowed, setWalkAllowed] = useState(false);
  const [collisionFormat, setCollisionFormat] = useState<string | null>(null);
  const [sceneScale, setSceneScale] = useState<SceneScaleAssessment>({
    horizontalExtent: 0,
    verticalExtent: 0,
    status: 'too-small',
    needsCalibration: true,
  });
  const [canStartVR, setCanStartVR] = useState(false);
  const [descriptor, setDescriptor] = useState<SceneRuntimeDescriptorV1 | null>(null);
  const [isManifestFallback, setIsManifestFallback] = useState(false);
  const [selectedGsplatformAnnotation, setSelectedGsplatformAnnotation] =
    useState<GsplatformAnnotationRef | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // create / destroy-on-change / destroy-on-unmount（StrictMode-safe）
  useEffect(() => {
    if (!sceneId || !containerRef.current) return;
    let cancelled = false;
    const mount = containerRef.current;

    const boot = async () => {
      setStatus('loading');
      setError(null);
      setProgress(0);
      setLoaded(false);
      setGsplats(0);
      setSelectedGsplatformAnnotation(null);
      try {
        // 1) 描述：DB 合同优先，仓库级场景 manifest 回退
        const { descriptor: desc, fromManifest } = await resolveSceneRuntimeDescriptor(sceneIdRef.current);
        if (cancelled) return;
        setDescriptor(desc);
        setIsManifestFallback(fromManifest);
        setCollisionFormat(desc.collision?.enabled ? desc.collision.format ?? null : null);

        if (!desc.content.url) {
          setStatus('error');
          setError('场景尚未发布内容（content.url 为 null）');
          return;
        }

        // 2) Experience Settings v2（官方 validateSettings 通过）
        const settings = buildExperienceSettings(desc);
        if (cancelled) return;

        // 3) 官方 SuperSplat Runtime（desktop → auto renderer，无 iframe）
        //    ui:true = 官方 annotation hotspots/tooltip 层（SSV-06；多余 chrome
        //    由 wrapper 的 scoped CSS 隐藏）。
        //    collisionUrl：仅在 collision.enabled 时传入 —— 关闭碰撞的场景
        //    不向官方 viewer 注入碰撞数据（SSV-07 §2，避免默默开启 walk）。
        //    且必须解析为绝对 URL（开发跨源 :5173 → :8001 无 /api 代理，官方
        //    viewer 直接 fetch 相对路径会 404 —— SSV-06 同款问题）。
        const runtime = await SuperSplatRuntime.create({
          container: mount,
          contentUrl: desc.content.url,
          settings,
          posterUrl: desc.scene.posterUrl ?? undefined,
          collisionUrl: desc.collision?.enabled
            ? resolveRuntimeAssetUrl(desc.collision.url) ?? undefined
            : undefined,
          mode: 'desktop',
          ui: true,
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        // DEV-only 调试把柄（生产构建 import.meta.env.DEV=false，不输出）。
        // e2e 用 window.__gsruntime 直接探查官方 app/实体树。
        if (import.meta.env.DEV) {
          (window as unknown as { __gsruntime?: unknown }).__gsruntime = runtime;
        }
        const refresh = () => {
          if (cancelled) return;
          setRenderer(runtimeRenderer(runtime.app));
          setGsplats(renderedSplatCount(runtime.app));
          setLoaded(runtime.state.loaded);
          setProgress(runtime.state.progress);
          setCameraModeState(runtime.state.cameraMode);
          setPerformanceModeState(runtime.state.performanceMode);
          setShowAnnotationsState(runtime.state.showAnnotations);
          setIsFullscreen(runtime.state.isFullscreen);
          setHasCollision(runtime.state.hasCollision);
          setWalkAllowed(runtime.state.walkAllowed);
          setCanStartVR(runtime.state.canStartVR);
          // SSV-07 §4：每次取帧重算尺度诊断（包围盒来自 gsplat 实例）。
          // sceneScale.needsCalibration → Walk 入口禁用 + UI 告警。
          setSceneScale(assessSceneScale(runtime.getSceneBounds()));
          if (runtime.state.loaded && !cancelled) setStatus('ready');
        };

        // 事件全部经 wrapper 订阅（页面不直接监听底层 events）
        unsubsRef.current.push(
          runtime.onLoaded((v) => {
            if (cancelled) return;
            setLoaded(v);
            if (v) {
              try {
                runtime.frameScene(); // 保证场景可见（官方需要 loaded）
              } catch (frameErr) {
                console.error('[viewer] frameScene failed', frameErr);
              }
            }
            refresh();
          }),
          runtime.onProgress((p) => {
            if (cancelled) return;
            setProgress(p);
          }),
          runtime.onCameraModeChanged((m) => {
            if (cancelled) return;
            setCameraModeState(m);
          }),
          // SSV-06：官方选中标注变化 → 读取 extras.gsplatform.annotationId
          // （页面经 annotationId 解析，不用数组 index 当数据库 ID）。
          runtime.onSelectedAnnotationChanged(() => {
            if (cancelled) return;
            setSelectedGsplatformAnnotation(runtime.selectedGsplatformAnnotation);
          }),
        );

        // 轮询真实引擎状态（renderer / gsplats / fullscreen / …）
        refresh();
        pollRef.current = window.setInterval(refresh, STATS_POLL_MS);

        // 若创建时已首帧（小场景瞬时加载），状态由 refresh 置 ready。
      } catch (err) {
        if (cancelled) return;
        console.error('[viewer] boot failed', err);
        setStatus('error');
        setError(errorMessage(err));
      }
    };

    void boot();

    return () => {
      cancelled = true;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      unsubsRef.current.forEach((unsub) => unsub());
      unsubsRef.current = [];
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, [sceneId, reloadKey]);

  // ------------------------------------------------------------------ #
  // 动作（写入官方 state 或转发官方方法）
  // ------------------------------------------------------------------ #

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const frameScene = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.loaded) return;
    try {
      runtime.frameScene();
    } catch (err) {
      console.error('[viewer] frameScene failed', err);
    }
  }, []);

  const resetCamera = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.loaded) return;
    try {
      runtime.resetCamera();
    } catch (err) {
      console.error('[viewer] resetCamera failed', err);
    }
  }, []);

  const setCameraPose = useCallback((pose: CameraPose) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      runtime.setCameraPose(pose);
    } catch (err) {
      console.error('[viewer] setCameraPose failed', err);
    }
  }, []);

  const requestFullscreen = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    void runtime.requestFullscreen().catch((err) => console.error('[viewer] fullscreen failed', err));
  }, []);

  const exitFullscreen = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    void runtime.exitFullscreen().catch((err) => console.error('[viewer] exit fullscreen failed', err));
  }, []);

  const setCameraMode = useCallback((mode: RuntimeCameraMode) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.state.cameraMode = mode; // 官方 writable key，触发 cameraMode:changed
  }, []);

  const togglePerformanceMode = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.state.performanceMode = !runtime.state.performanceMode; // writable key
  }, []);

  const toggleAnnotationsVisibility = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.state.showAnnotations = !runtime.state.showAnnotations; // writable key
  }, []);

  const toggleWalk = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.loaded || !runtime.walkAllowed) return;
    try {
      runtime.toggleWalk(); // 官方 walk 模式（不做自建物理/控制器）
    } catch (err) {
      console.error('[viewer] toggleWalk failed', err);
    }
  }, []);

  return {
    status,
    error,
    progress,
    renderer,
    loaded,
    gsplats,
    cameraMode,
    performanceMode,
    showAnnotations,
    isFullscreen,
    hasCollision,
    walkAllowed,
    collisionFormat,
    sceneScale,
    canStartVR,
    descriptor,
    isManifestFallback,
    containerRef,
    runtimeRef,
    retry,
    frameScene,
    resetCamera,
    setCameraPose,
    requestFullscreen,
    exitFullscreen,
    setCameraMode,
    togglePerformanceMode,
    toggleAnnotationsVisibility,
    toggleWalk,
    selectedGsplatformAnnotation,
  };
}
