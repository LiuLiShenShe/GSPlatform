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
 * 生命周期：mount/sceneId 变化 create，卸载 destroy（幂等）；事件全部经
 * SuperSplatRuntime 订阅，destroy 后无 listener 残留；retry 重走完整 boot。
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
import type { SceneRuntimeDescriptorV1 } from '../../scene-runtime/types';

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
  /** 官方 state.xrMode（vr / ar / null）——运行态真相。 */
  xrMode: 'vr' | 'ar' | null;
  /** 内容加载进度 0..100（官方 onProgress）。 */
  progress: number;
  /** 实际渲染器（xr → webgl / webgl2）。 */
  renderer: string;
  /** 当前帧已渲染 Gaussian 数。 */
  gsplats: number;
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
export function useSuperSplatXR(input: string | SceneRuntimeDescriptorV1 | null): OfficialXRViewerState {
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
  const [xrMode, setXrMode] = useState<'vr' | 'ar' | null>(null);
  const [progress, setProgress] = useState(0);
  const [renderer, setRenderer] = useState('—');
  const [gsplats, setGsplats] = useState(0);
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

    // 输入不可解析（null）→ 直接 error，不创建 viewer。
    if (inputRef.current === null) {
      setStatus('error');
      setError('无法从 URL 推断 splat 格式');
      return;
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
        setIsManifestFallback(fromManifest);

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
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
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
        };

        // 事件全部经 wrapper 订阅（页面不直接监听底层 events）
        unsubsRef.current.push(
          runtime.onLoaded((v) => {
            if (cancelled) return;
            setLoaded(v);
            if (v) {
              try {
                runtime.frameScene(); // 场景加载完成自动取景整个场景
              } catch (frameErr) {
                console.error('[xr] frameScene failed', frameErr);
              }
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

        if (runtime.state.loaded && !cancelled) setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[xr] boot failed', err);
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
  }, [input, reloadKey]);

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

  const startVR = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      await runtime.startVR();
      // 之后的真实状态由 onXRModeChanged 驱动（xrMode → 'vr'）；若 startXR resolve
      // 但事件尚未触发（极少数），兜底置 active。
      hadXRRef.current = true;
      setStatus('xr-active');
    } catch (err) {
      console.error('[xr] startVR failed', err);
      setError(errorMessage(err));
      setStatus('error');
      throw err;
    }
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
    xrMode,
    progress,
    renderer,
    gsplats,
    diagnostics,
    descriptor,
    isManifestFallback,
    error,
    containerRef,
    retry,
    frameScene,
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
