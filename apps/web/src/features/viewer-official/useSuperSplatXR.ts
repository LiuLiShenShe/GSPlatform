/**
 * Official XR Scene Runtime hook（SSV-04）—— `/xr/:sceneId` 默认路径。
 *
 * 与 Desktop 共用同一套 descriptor / settings / content / collision / events：
 *   resolveSceneRuntimeDescriptor(sceneId)
 *     → buildExperienceSettings(descriptor)
 *     → SuperSplatRuntime.create({ mode: 'xr' })   // renderer 强制 'webgl'
 *
 * 运行态真相完全来自官方 state：canStartVR / canStartAR / xrMode / loaded /
 * progress。页面不维护重复的 navigator.xr 状态机作为真相源；navigator.xr 只作
 * 诊断展示（XRDiagnostics）。
 *
 * 状态机（FIX-XR-01）：checking → loading → ready → xr-active → xr-ended → ready。
 * ready 只由官方 runtime 实际加载状态驱动（runtime.state.loaded）：
 *   - onLoaded(true) 事件 → syncReady()；
 *   - 状态轮询（refresh）观察到 loaded=true → syncReady()（事件丢失兜底）；
 *   - syncReady 仅从 loading 单向迁移到 ready，绝不覆盖 xr-active / xr-ended /
 *     error；loaded=false 不提前 ready。浏览器 WebXR 能力不直接置 ready。
 *
 * 生命周期：mount/sceneId 变化 create，卸载 destroy（幂等）；事件全部经
 * SuperSplatRuntime 订阅，destroy 后无 listener 残留，旧 runtime 的晚到事件
 * 经 cancelled 守卫丢弃；retry 重走完整 boot。
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
} from '../../scene-runtime/SuperSplatRuntime';
import { SuperSplatRuntimeError } from '../../scene-runtime/runtimeErrors';
import { hasAuthoredInitialCamera, shouldFrameSceneOnLoad } from '../../scene-runtime/initialCameraPolicy';
import { eligibleGuidePoints } from '../../scene-runtime/guidePoints';
import { RuntimePerformanceDiagnostics } from '../../scene-runtime/RuntimePerformanceDiagnostics';
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import type { RuntimeAnnotation, RuntimeViewpoint, SceneRuntimeDescriptorV1 } from '../../scene-runtime/types';

export type OfficialXRStatus =
  | 'checking'
  | 'unsupported'
  | 'loading'
  | 'ready'
  | 'xr-active'
  | 'xr-ended'
  | 'error';

export interface OfficialXRViewerState {
  /** 页面状态机（含 XR 会话呈现层）。 */
  status: OfficialXRStatus;
  /** 可从官方 state 读取的 XR 运行态真相。 */
  loaded: boolean;
  canStartVR: boolean;
  canStartAR: boolean;
  /** 官方 state.hasCollision —— 碰撞资产已加载（SSV-07 §8，不破坏 XR）。 */
  hasCollision: boolean;
  /** 官方 state.walkAllowed（VR 中同样为碰撞+尺度判定）。 */
  walkAllowed: boolean;
  /** FIX-05 §22-§25：碰撞是否 STALE（世界变换在构建后改变）。 */
  collisionStale: boolean;
  /**
   * FIX-05 §24：有效 walk 允许 = 官方 walkAllowed AND 碰撞未 STALE
   * （官方 runtime 无法可靠重变换碰撞几何 —— 变换改变后碰撞与场景不再对齐）。
   */
  effectiveWalkAllowed: boolean;
  /** 官方 state.xrMode（vr / ar / null）——运行态真相。 */
  xrMode: 'vr' | 'ar' | null;
  /** 内容加载进度 0..100（官方 onProgress）。 */
  progress: number;
  /** 实际渲染器（xr → webgl / webgl2）。 */
  renderer: string;
  /** 当前帧已渲染 Gaussian 数。 */
  gsplats: number;
  performanceMode: boolean;
  setPerformanceMode: (enabled: boolean) => void;
  performanceRecorder: RuntimePerformanceDiagnostics | null;
  /** 浏览器 WebXR 能力诊断（仅展示，非真相源）。 */
  diagnostics: { secureContext: boolean; navigatorXR: boolean; immersiveVrSupported: boolean; immersiveArSupported: boolean };
  /** 场景运行时描述（null = 尚未解析/失败）。 */
  descriptor: SceneRuntimeDescriptorV1 | null;
  /** 描述来自 manifest 回退还是 DB 合同。 */
  isManifestFallback: boolean;
  /** 错误信息（null = 无）。 */
  error: string | null;
  /** 挂到 canvas mount 元素。 */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 重新走完整 boot（销毁重建）。 */
  retry: () => void;
  frameScene: () => void;
  /**
   * GS-NEXT-03：可用的已保存视角（enabled），与 Desktop 工具栏的 Saved Views
   * **同一份数据**（同来自 `descriptor.viewpoints`）。
   */
  viewpoints: RuntimeViewpoint[];
  /** 进入 VR 前当前选中的视点（null = 未选 = 用 authored 初始视角）。 */
  selectedViewpointId: string | null;
  /**
   * 选择进入 VR 时的出生视点。传 id = 选中该视点并用官方过渡把相机导航过去；
   * 传 null = 回到 authored 初始视角。返回是否成功（未知 / disabled → false）。
   */
  selectViewpoint: (viewpointId: string | null) => boolean;
  /**
   * GS-NEXT-04：可作为 XR 出生位姿的**导览点**（Annotation-backed）。
   *
   * 与 Desktop 的官方热点、与 `descriptor.annotations` **同一份数据、同一批
   * 数据库 ID**；只保留作者真的存过相机的（见 `scene-runtime/guidePoints.ts`）。
   */
  guidePoints: RuntimeAnnotation[];
  /** 进入 VR 前当前选中的导览点（null = 未选）。与 `selectedViewpointId` 互斥。 */
  selectedGuidePointId: string | null;
  /**
   * 选择进入 VR 时的出生导览点。传 id = 官方过渡把相机导航到该标注的相机、并把
   * 同一 pose 设为 XR 出生位姿；传 null = 回到 authored 初始视角。
   * 返回是否成功（未知 / 无自有相机 → false，不改出生位姿）。
   */
  selectGuidePoint: (annotationId: string | null) => boolean;
  /** XR 出生位姿状态（诊断用）：not-authored / not-entered / pending / applied / unavailable。 */
  xrSpawnStatus: string;
  /**
   * 当前相机 pose（FIX-02 §16 —— 进入 VR 前的初始构图可读，与 Desktop
   * `ov-diagnostics.camera` 同源，用于核对 XR 与 Desktop 使用同一 authored
   * Initial Camera / 世界变换）。经 SuperSplatRuntime 封装读取（页面不碰 app）。
   */
  getCameraPose: () => CameraPose | null;
  cameraPose: CameraPose | null;
  /** 用户手势内调用：官方 startXR('vr')。 */
  startVR: () => Promise<void>;
  /** 结束当前 XR 会话。 */
  endXR: () => Promise<void>;
  /**
   * 官方当前选中 annotation 的 GSPlatform extras 引用（SSV-06）。
   * 经 annotationId 解析 SceneAnnotation / 打开媒体 Overlay。
   */
  selectedGsplatformAnnotation: GsplatformAnnotationRef | null;
}

const STATS_POLL_MS = 1000;

function errorMessage(err: unknown): string {
  if (err instanceof SuperSplatRuntimeError) return `SuperSplatRuntimeError(${err.kind}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * @param input - 场景输入：
 *   - string：sceneId，走 DB 合同（404 回退 manifest）
 *   - SceneRuntimeDescriptorV1：直接用给定描述（/xr/test 的 URL 调试场景）
 *   - null：输入本身不可解析（如 URL 推断格式失败），直接进入 error 且不创建 viewer
 */
export function useSuperSplatXR(input: string | SceneRuntimeDescriptorV1 | null, recordPerformance = false): OfficialXRViewerState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SuperSplatRuntime | null>(null);
  const unsubsRef = useRef<(() => void)[]>([]);
  const pollRef = useRef<number | null>(null);
  const inputRef = useRef<string | SceneRuntimeDescriptorV1 | null>(input);
  inputRef.current = input;

  const [status, setStatus] = useState<OfficialXRStatus>('checking');
  const [loaded, setLoaded] = useState(false);
  const [canStartVR, setCanStartVR] = useState(false);
  const [canStartAR, setCanStartAR] = useState(false);
  const [hasCollision, setHasCollision] = useState(false);
  const [walkAllowed, setWalkAllowed] = useState(false);
  const [collisionStale, setCollisionStale] = useState(false);
  const [xrMode, setXrMode] = useState<'vr' | 'ar' | null>(null);
  const [progress, setProgress] = useState(0);
  const [renderer, setRenderer] = useState('—');
  const [gsplats, setGsplats] = useState(0);
  const [performanceMode, setPerformanceModeState] = useState(false);
  const [performanceRecorder, setPerformanceRecorder] = useState<RuntimePerformanceDiagnostics | null>(null);
  const [cameraPose, setCameraPoseState] = useState<CameraPose | null>(null);
  /*
   * GS-NEXT-03：进入 VR 前选择的视点。
   * `authoredInitialRef` 保存创建 runtime 时用的出生 pose（「初始视角」选项的
   * 回退目标）—— 不能事后重新解析 settings 得到它。
   */
  const authoredInitialRef = useRef<CameraPose | null>(null);
  const [selectedViewpointId, setSelectedViewpointId] = useState<string | null>(null);
  /* GS-NEXT-04：出生导览点。与视点互斥 —— 二者写的是同一个「出生位姿」，
   * 同时选中会让「选了哪个出生点」变得不可知。 */
  const [selectedGuidePointId, setSelectedGuidePointId] = useState<string | null>(null);
  const [xrSpawnStatus, setXrSpawnStatus] = useState<string>('not-authored');
  const recorderRef = useRef<RuntimePerformanceDiagnostics | null>(null);
  const [diagnostics, setDiagnostics] = useState<OfficialXRViewerState['diagnostics']>({
    secureContext: false,
    navigatorXR: false,
    immersiveVrSupported: false,
    immersiveArSupported: false,
  });
  const [descriptor, setDescriptor] = useState<SceneRuntimeDescriptorV1 | null>(null);
  const [isManifestFallback, setIsManifestFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGsplatformAnnotation, setSelectedGsplatformAnnotation] =
    useState<GsplatformAnnotationRef | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 进入过 XR 标记（用 ref 避免闭包捕获旧 state）：用于「系统退出 → xr-ended」判定
  const hadXRRef = useRef(false);

  // 浏览器能力诊断（仅展示；运行态真相 = 官方 state）
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const diag = await collectBrowserDiagnostics();
        if (!cancelled) setDiagnostics(diag);
      } catch {
        /* 诊断失败不影响 viewer 启动 */
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;
    let cancelled = false;
    const recorder = recordPerformance ? new RuntimePerformanceDiagnostics() : null;
    recorderRef.current = recorder;
    setPerformanceRecorder(recorder);
    recorder?.start();
    const metadataAbort = new AbortController();
    let metadataTimeout: ReturnType<typeof setTimeout> | undefined;

    // 输入不可解析（null）→ 直接 error，不创建 viewer。
    if (inputRef.current === null) {
      setStatus('error');
      setError('无法从 URL 推断 splat 格式');
      recorder?.failure();
      return () => recorder?.destroy();
    }

    const boot = async () => {
      setStatus('loading');
      setError(null);
      setLoaded(false);
      setGsplats(0);
      setXrMode(null);
      setSelectedGsplatformAnnotation(null);
      try {
        // 1) 描述：sceneId → DB 合同 (404 回退 manifest)；否则直接用传入的
        //    descriptor（/xr/test 的 URL 调试场景合成最小描述，仍走同一条
        //    adapter + create 链路，非第二套 Viewer 创建逻辑）。
        // 顶部 useEffect 已断言 inputRef.current 非 null，这里显式断言。
        const current = inputRef.current as string | SceneRuntimeDescriptorV1;
        const { descriptor: desc, fromManifest } =
          typeof current === 'string'
            ? await resolveSceneRuntimeDescriptor(current)
            : { descriptor: current, fromManifest: false };
        if (cancelled) return;
        setDescriptor(desc);
        recorder?.setDescriptor(desc);
        if (recorder && desc.content.format === 'lod-meta' && desc.content.url) {
          metadataTimeout = setTimeout(() => metadataAbort.abort(), 15000);
          void fetch(desc.content.url, { credentials: 'same-origin', cache: 'force-cache', signal: metadataAbort.signal })
            .then(async response => {
              if (!response.ok || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) return;
              const text = await response.text();
              if (text.length <= 4 * 1024 * 1024 && !cancelled) recorder.setLodCounts(JSON.parse(text).counts);
            }).catch(() => undefined).finally(() => clearTimeout(metadataTimeout));
        }
        setIsManifestFallback(fromManifest);
        // FIX-05 §23-§25：碰撞 STALE = 世界变换在构建后改变（描述符已计算）。
        setCollisionStale(desc.collision?.stale ?? false);

        if (!desc.content.url) {
          setStatus('error');
          setError('场景尚未发布内容（content.url 为 null）');
          return;
        }

        // 2) Experience Settings v2（与 Desktop 同一 adapter）
        const settings = buildExperienceSettings(desc);
        if (cancelled) return;

        // 3) 官方 SuperSplat Runtime（mode:'xr' → renderer 强制 'webgl'）
        //    ui:true = 官方 annotation hotspots/tooltip 层（SSV-06）。
        //    collisionUrl 解析为绝对 URL（同 Desktop，SSV-07 §8：碰撞资产
        //    不得破坏 XR 加载 —— 官方 VR 路径同样消费碰撞数据）。
        const runtime = await SuperSplatRuntime.create({
          container: mount,
          contentUrl: desc.content.url,
          settings,
          posterUrl: desc.scene.posterUrl ?? undefined,
          collisionUrl: desc.collision?.enabled
            ? resolveRuntimeAssetUrl(desc.collision.url) ?? undefined
            : undefined,
          mode: 'xr',
          ui: true,
          // FIX-02 §5/§16：世界变换与已保存视角在 Desktop/XR 走同一 runtime 逻辑。
          worldTransform: desc.presentation.worldTransform,
          viewpoints: desc.viewpoints,
          xrInitialCamera: hasAuthoredInitialCamera(desc) ? settings.cameras[0]?.initial ?? null : null,
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        // GS-NEXT-03：「初始视角」选项的回退目标 = 创建时的 authored 出生 pose。
        authoredInitialRef.current = hasAuthoredInitialCamera(desc)
          ? settings.cameras[0]?.initial ?? null
          : null;
        setSelectedViewpointId(null);
        setSelectedGuidePointId(null);
        runtimeRef.current = runtime;
        recorder?.attach(runtime);
        // FIX-XR-01: 官方 loaded=true 而页面仍 loading → 收敛 ready。
        // 只从 loading 单向迁移；绝不覆盖 xr-active / xr-ended / error。
        // 依据 = 官方 runtime 实际加载状态（runtime.state.loaded），不是浏览器
        // WebXR 能力（能力仅作诊断展示，不能直接把页面置 ready）。
        let initialized = false;
        const syncReady = () => {
          if (!runtime.state.loaded) return;
          if (!initialized) {
            initialized = true;
            runtime.applyWorldTransform();
            if (shouldFrameSceneOnLoad(desc)) runtime.frameScene();
            else runtime.resetCamera();
          }
          setStatus((prev) => (prev === 'loading' ? 'ready' : prev));
        };
        const refresh = () => {
          if (cancelled) return;
          setRenderer(runtimeRenderer(runtime.app));
          setLoaded(runtime.state.loaded);
          setCanStartVR(runtime.state.canStartVR);
          setCanStartAR(runtime.state.canStartAR);
          setHasCollision(runtime.state.hasCollision);
          setWalkAllowed(runtime.state.walkAllowed);
          setXrMode(runtime.state.xrMode);
          setProgress(runtime.state.progress);
          setGsplats(renderedSplatCount(runtime.app));
          setPerformanceModeState(runtime.getPerformanceMode());
          setCameraPoseState(runtime.getCameraPose());
          // GS-NEXT-03：XR 出生位姿状态（not-authored = 未指定出生点）。
          setXrSpawnStatus((runtime.getXRState() as { spawnStatus?: string }).spawnStatus ?? 'unavailable');
          // FIX-XR-01: 轮询兜底 —— 若加载完成事件未被组件接收到（真实设备上
          // 存在事件与 state 竞态），状态轮询观察到 loaded=true 时也收敛 ready。
          syncReady();
        };

        // 事件全部经 wrapper 订阅（页面不直接监听底层 events）
        unsubsRef.current.push(
          runtime.onLoaded((v) => {
            if (cancelled) return;
            setLoaded(v);
            if (v) {
              // FIX-02 §16：XR 与 Desktop 同一套规则 —— 世界变换先执行；
              // authored Initial Camera 存在 → 不自动 frameScene；
              // 否则 frameScene()（进入 XR 前的桌面构图 = authored 初始相机）。
              // FIX-XR-01: 官方 loaded 事件为真 → loading → ready。
              syncReady();
            }
            refresh();
          }),
          runtime.onProgress((p) => {
            if (cancelled) return;
            setProgress(p);
          }),
          runtime.onXRModeChanged((m) => {
            if (cancelled) return;
            setXrMode(m);
            // 运行态真相 = 官方 xrMode；页面据此驱动呈现层状态
            if (m === 'vr' || m === 'ar') {
              hadXRRef.current = true;
              setStatus('xr-active');
            } else if (hadXRRef.current) {
              setStatus('xr-ended');
            }
          }),
          // SSV-06：官方选中标注变化 → extras.gsplatform.annotationId。
          runtime.onSelectedAnnotationChanged(() => {
            if (cancelled) return;
            setSelectedGsplatformAnnotation(runtime.selectedGsplatformAnnotation);
          }),
        );

        refresh();
        pollRef.current = window.setInterval(refresh, STATS_POLL_MS);

        // FIX-XR-01: 创建时已加载完成的同步场景 → 直接收敛 ready（guard 同 refresh）。
        if (runtime.state.loaded && !cancelled) syncReady();
      } catch (err) {
        if (cancelled) return;
        console.error('[xr] boot failed', err);
        setStatus('error');
        setError(errorMessage(err));
        recorder?.failure();
      }
    };

    void boot();

    return () => {
      cancelled = true;
      metadataAbort.abort();
      clearTimeout(metadataTimeout);
      recorder?.destroy();
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      unsubsRef.current.forEach((unsub) => unsub());
      unsubsRef.current = [];
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, [input, reloadKey, recordPerformance]);

  // ------------------------------------------------------------------ #
  // 动作（用户手势内直接 startXR —— 不经 iframe/postMessage/setTimeout）
  // ------------------------------------------------------------------ #

  const retry = useCallback(() => {
    hadXRRef.current = false;
    setReloadKey((k) => k + 1);
  }, []);

  const frameScene = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.loaded) return;
    try {
      runtime.frameScene();
    } catch (err) {
      console.error('[xr] frameScene failed', err);
    }
  }, []);

  // FIX-02 §16：进入 VR 前的初始构图可读（与 Desktop ov-diagnostics.camera 同源）。
  const getCameraPose = useCallback((): CameraPose | null => {
    const runtime = runtimeRef.current;
    if (!runtime) return null;
    try {
      return runtime.getCameraPose();
    } catch {
      return null;
    }
  }, []);

  /**
   * GS-NEXT-03：进入 VR 前选择视点（Desktop 侧同一份已保存视角）。
   *
   * - `viewpointId !== null`：官方过渡把相机导航到该视点（`selectViewpoint`），
   *   **并**把同一个 RUNTIME pose 设为 XR 出生位姿 —— 用户在桌面模式看到的位置
   *   就是进 VR 后的出生点。两者都走 wrapper，页面不碰相机。
   * - `viewpointId === null`：回到 authored 初始视角（无 authored → null，
   *   即保持官方 Y=0 出生语义）。
   *
   * 返回是否成功选中（未知 / disabled 视点 → false，不改出生位姿）。
   */
  const selectViewpoint = useCallback((viewpointId: string | null): boolean => {
    const runtime = runtimeRef.current;
    if (!runtime) return false;
    if (viewpointId === null) {
      runtime.setXRInitialCamera(authoredInitialRef.current);
      if (authoredInitialRef.current) runtime.resetCamera();
      setSelectedViewpointId(null);
      setSelectedGuidePointId(null);
      setCameraPoseState(runtime.getCameraPose());
      setXrSpawnStatus((runtime.getXRState() as { spawnStatus?: string }).spawnStatus ?? 'unavailable');
      return true;
    }
    // 换位顺序：先取 pose（未知 id → 直接失败），再导航，最后设出生位姿。
    const pose = runtime.viewpointRuntimePose(viewpointId);
    if (!pose) return false;
    if (!runtime.selectViewpoint(viewpointId)) return false;
    runtime.setXRInitialCamera(pose);
    setSelectedViewpointId(viewpointId);
    // GS-NEXT-04：与导览点互斥（同一个出生位姿槽位）。
    setSelectedGuidePointId(null);
    setXrSpawnStatus((runtime.getXRState() as { spawnStatus?: string }).spawnStatus ?? 'unavailable');
    return true;
  }, []);

  /**
   * GS-NEXT-04：进入 VR 前选择**导览点**（Annotation-backed 出生位姿）。
   *
   * 与视点的唯一差别是 pose 的来源：
   *   - 视点：来自 `descriptor.viewpoints`，需 wrapper 用 SceneTransformAdapter 换算；
   *   - 导览点：直接读官方 `settings.annotations[i].camera.initial` —— 该值**已经**
   *     由 `experienceAdapter` 换算成 RUNTIME 空间，这里绝不再换算第二次。
   *
   * 导航用官方 `selectAnnotation(index)`（官方过渡动画 + 官方 hotspot 选中态），
   * 页面不碰相机。未知 ID / 缺自有相机 → 返回 false 且**不改**出生位姿
   * （见 `scene-runtime/guidePoints.ts` 的准入理由）。
   */
  const selectGuidePoint = useCallback((annotationId: string | null): boolean => {
    const runtime = runtimeRef.current;
    if (!runtime) return false;
    if (annotationId === null) {
      runtime.setXRInitialCamera(authoredInitialRef.current);
      if (authoredInitialRef.current) runtime.resetCamera();
      setSelectedGuidePointId(null);
      setSelectedViewpointId(null);
      setCameraPoseState(runtime.getCameraPose());
      setXrSpawnStatus((runtime.getXRState() as { spawnStatus?: string }).spawnStatus ?? 'unavailable');
      return true;
    }
    const pose = runtime.annotationRuntimePose(annotationId);
    if (!pose) return false;
    // 官方导航路径：selectAnnotation 走官方 CameraManager 过渡，并置位官方选中态。
    if (!runtime.selectGsplatformAnnotation(annotationId)) return false;
    runtime.setXRInitialCamera(pose);
    setSelectedGuidePointId(annotationId);
    setSelectedViewpointId(null); // 与视点互斥
    setXrSpawnStatus((runtime.getXRState() as { spawnStatus?: string }).spawnStatus ?? 'unavailable');
    return true;
  }, []);

  const startVR = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      recorderRef.current?.markXRRequest();
      await runtime.startVR();
      // 之后的真实状态由 onXRModeChanged 驱动（xrMode → 'vr'）；若 startXR resolve
      // 但事件尚未触发（极少数），兜底置 active。
      hadXRRef.current = true;
      setStatus('xr-active');
    } catch (err) {
      console.error('[xr] startVR failed', err);
      setError(errorMessage(err));
      setStatus('error');
      recorderRef.current?.failure();
      throw err;
    }
  }, []);

  const setPerformanceMode = useCallback((enabled: boolean) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    // GS-NEXT-02 §五.5：XR 的手动切换与 Desktop 一样经官方 state 写入并持久化
    // （官方 persistPreferences 写同一個 `performanceMode` 偏好 key）—— 消除
    // 之前 `{persist:false}` 造成的"桌面记得、XR 不记得"的不一致。默认值本身
    // 仍由 SuperSplatRuntime 在创建时以 persist:false 施加一次（见该处注释）。
    runtime.setPerformanceMode(enabled);
    setPerformanceModeState(runtime.getPerformanceMode());
  }, []);

  const endXR = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      await runtime.endXR();
      setStatus('xr-ended');
    } catch (err) {
      console.error('[xr] endXR failed', err);
      setError(errorMessage(err));
      setStatus('error');
      recorderRef.current?.failure();
      throw err;
    }
  }, []);

  return {
    status,
    loaded,
    canStartVR,
    canStartAR,
    hasCollision,
    walkAllowed,
    collisionStale,
    effectiveWalkAllowed: walkAllowed && !collisionStale,
    xrMode,
    progress,
    renderer,
    gsplats,
    performanceMode,
    setPerformanceMode,
    performanceRecorder,
    diagnostics,
    descriptor,
    isManifestFallback,
    error,
    containerRef,
    retry,
    frameScene,
    viewpoints: (descriptor?.viewpoints ?? []).filter((vp) => vp.enabled !== false),
    selectedViewpointId,
    selectViewpoint,
    // GS-NEXT-04：导览点与官方热点、descriptor.annotations 同一批 DB ID；
    // 只保留作者真的存过相机的（无相机的老热点不冒充导览目的地）。
    guidePoints: eligibleGuidePoints(descriptor?.annotations ?? []),
    selectedGuidePointId,
    selectGuidePoint,
    xrSpawnStatus,
    getCameraPose,
    cameraPose,
    startVR,
    endXR,
    selectedGsplatformAnnotation,
  };
}

/** 浏览器侧 WebXR 能力诊断（仅展示，非运行态真相；真相 = 官方 state）。 */
async function collectBrowserDiagnostics(): Promise<OfficialXRViewerState['diagnostics']> {
  const navigatorAny = navigator as unknown as {
    xr?: { isSessionSupported: (mode: string) => Promise<boolean> };
  };
  const out: OfficialXRViewerState['diagnostics'] = {
    secureContext: window.isSecureContext,
    navigatorXR: Boolean(navigatorAny.xr),
    immersiveVrSupported: false,
    immersiveArSupported: false,
  };
  if (navigatorAny.xr) {
    try {
      out.immersiveVrSupported = await navigatorAny.xr.isSessionSupported('immersive-vr');
    } catch (err) {
      console.error('[xr] isSessionSupported(immersive-vr) failed', err);
    }
    try {
      out.immersiveArSupported = await navigatorAny.xr.isSessionSupported('immersive-ar');
    } catch (err) {
      console.error('[xr] isSessionSupported(immersive-ar) failed', err);
    }
  }
  return out;
}
