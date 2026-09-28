/**
 * WebXR 修复任务（第二轮）— /xr/test 诊断页。
 *
 * 显示真实浏览器 WebXR 能力 + 场景加载状态 + real XR session 状态。
 *
 * 场景 URL 解析优先级（§7）：
 *   1. URL query `?scene=<url>`
 *   2. env VITE_XR_TEST_SCENE_URL
 *   3. fallback /local-scenes/local-garden/scene.sog
 *
 * XR 状态真实同步（§3/§4）：订阅 supersplat-viewer 的 xrMode:changed，
 * 用户从头显系统菜单 / 浏览器 UI 退出 XR 时自动变回 xr-ended。
 *
 * 黑屏修复（第三轮）：创建 viewer 时 settings.cameras 为空数组，官方按场景
 * bbox 自动取景；loaded 后再调用官方 frameScene() 把相机对准整个场景。
 * Frame Scene 按钮可随时重新取景。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { collectDiagnostics, formatDiagnostics } from '../xr/XRDiagnostics';
import {
  createXRRuntime,
  renderedSplatCount,
  runtimeRenderer,
  type XRViewerRuntime,
} from '../xr/XRViewerRuntime';
import type { XRState } from '../xr/xrTypes';
import { useDocumentTitle } from '../hooks/useBreakpoints';

/** 场景 URL 解析：query ?? env ?? fallback（§7）。 */
function resolveTestScene(): string {
  const params = new URLSearchParams(window.location.search);
  const queryScene = params.get('scene');
  if (queryScene && queryScene.trim().length > 0) {
    return queryScene.trim();
  }
  const envScene = import.meta.env.VITE_XR_TEST_SCENE_URL as string | undefined;
  if (envScene && envScene.trim().length > 0) {
    return envScene.trim();
  }
  return '/local-scenes/local-garden/scene.sog';
}

const TEST_SCENE = resolveTestScene();

/** 场景加载状态（§9）。 */
type SceneLoadingState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'failed'; error: string };

/** 渲染器运行时实时状态（与浏览器能力诊断分离展示，避免相互矛盾）。 */
interface RendererRuntimeInfo {
  stateLoaded: boolean;
  canStartVR: boolean;
  gsplats: number;
}

export default function XRTestPage() {
  useDocumentTitle('XR 测试');
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<XRViewerRuntime | null>(null);
  // 订阅句柄：组件卸载时必须 unsubscribe，避免 listener leak（§4）。
  const unsubRef = useRef<(() => void) | null>(null);
  // 进入过 XR 的标志，用 ref 避免闭包捕获旧 state。
  const hadXRRef = useRef(false);
  // gsplats 轮询定时器句柄。
  const pollRef = useRef<number | null>(null);

  const [state, setState] = useState<XRState>('checking');
  const [lines, setLines] = useState<{ key: string; value: string }[]>([]);
  const [viewerLoaded, setViewerLoaded] = useState(false);
  const [renderer, setRenderer] = useState<string | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RendererRuntimeInfo>({
    stateLoaded: false,
    canStartVR: false,
    gsplats: 0,
  });
  const [lastError, setLastError] = useState<{
    kind: 'scene' | 'webxr' | 'session';
    name: string;
    message: string;
  } | null>(null);
  const [sceneState, setSceneState] = useState<SceneLoadingState>({ status: 'loading' });
  const [xrMode, setXrMode] = useState<string | null>(null);
  const [frameSceneCount, setFrameSceneCount] = useState(0);

  // ---- 步骤 0:能力诊断 ----
  useEffect(() => {
    void collectDiagnostics().then((diag) => {
      setLines(formatDiagnostics(diag).map(([key, value]) => ({ key, value })));
    });
  }, []);

  // ---- 轮询渲染器实时状态（loaded / canStartVR / gsplats）----
  useEffect(() => {
    const tick = () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      // 避免 React 频繁重渲染：值不变就跳过。
      setRuntimeInfo((prev) => {
        const next = {
          stateLoaded: runtime.state.loaded,
          canStartVR: runtime.state.canStartVR,
          gsplats: renderedSplatCount(runtime.app),
        };
        return prev.stateLoaded === next.stateLoaded &&
          prev.canStartVR === next.canStartVR &&
          prev.gsplats === next.gsplats
          ? prev
          : next;
      });
    };
    tick();
    pollRef.current = window.setInterval(tick, 1000);
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  // ---- 步骤 1:加载 viewer（场景 + 订阅真实 XR 状态）----
  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return;

    const boot = async () => {
      try {
        const diag = await collectDiagnostics();
        if (cancelled) return;
        if (!diag.secureContext) {
          setState('unsupported');
          setLastError({
            kind: 'webxr',
            name: 'SecurityError',
            message: 'WebXR requires a secure context. Please access this page over HTTPS.',
          });
          return;
        }
        if (!diag.immersiveVrSupported) {
          setState('unsupported');
          setLastError({
            kind: 'webxr',
            name: 'NotSupportedError',
            message: 'immersive-vr not supported by this browser / device.',
          });
          return;
        }

        setState('loading-viewer');
        setSceneState({ status: 'loading' });
        const runtime = await createXRRuntime({
          container: mount,
          contentUrl: TEST_SCENE,
          contentFilename: 'scene.sog',
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        setRenderer(runtimeRenderer(runtime.app));
        setViewerLoaded(true);

        // 真实 XR 状态订阅：系统菜单退出同样触发（mode → null）。
        const unsub = runtime.onXRModeChanged((mode) => {
          if (cancelled) return;
          setXrMode(mode);
          if (mode === 'vr' || mode === 'ar') {
            hadXRRef.current = true;
            setState('xr-active');
          } else if (hadXRRef.current) {
            setState('xr-ended');
          }
        });
        unsubRef.current = unsub;

        // 场景首帧渲染完成 → 官方 frameScene() 取景整个场景 → Scene READY（§9）。
        await runtime.loadedPromise;
        if (cancelled) return;
        try {
          runtime.frameScene();
        } catch (frameErr) {
          console.error('[xr-test] frameScene failed after load', frameErr);
        }
        setFrameSceneCount((n) => n + 1);
        setSceneState({ status: 'ready' });
        setState('viewer-ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[xr-test] boot failed', err);
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // 区分场景加载失败 vs WebXR 失败（§8）
        setSceneState({ status: 'failed', error: message });
        setLastError({ kind: 'scene', name: 'SceneLoadError', message });
        setState('error');
      }
    };

    void boot();
    return () => {
      cancelled = true;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      unsubRef.current?.();
      unsubRef.current = null;
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, []);

  // ---- 步骤 2:用户点击 → startXR('vr')（§16 直接用户手势）----
  const enterVR = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setLastError(null);
    setState('starting-xr');
    try {
      await runtime.startVR();
      // 完成由 onXRModeChanged 驱动：xrMode → 'vr' 时置 xr-active。
      // 若 startXR resolve 但事件未触发（极少数），兜底置 active。
      hadXRRef.current = true;
      setState('xr-active');
    } catch (err) {
      console.error('[xr-test] XR START FAILED', err);
      const detail =
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'UnknownError', message: String(err) };
      setLastError({ kind: 'session', ...detail });
      setState('error');
    }
  };

  const exitVR = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      await runtime.endXR();
      setState('xr-ended');
    } catch (err) {
      console.error('[xr-test] XR END FAILED', err);
      const detail =
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'UnknownError', message: String(err) };
      setLastError({ kind: 'session', ...detail });
      setState('error');
    }
  };

  /** 手动重新取景：官方 frameScene()（相机对准整个场景 bbox）。 */
  const frameScene = () => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtime.state.loaded) return;
    try {
      runtime.frameScene();
      setFrameSceneCount((n) => n + 1);
    } catch (err) {
      console.error('[xr-test] manual frameScene failed', err);
      setLastError({
        kind: 'scene',
        name: 'FrameSceneError',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Enter VR 启用条件：Viewer READY + Scene READY + WebXR supported（§15）。
  const sceneReady = sceneState.status === 'ready';
  const canEnter = state === 'viewer-ready' && viewerLoaded && sceneReady;

  return (
    <div className="xr-page" data-testid="xr-test-page">
      <style>{`
        .xr-page { color: #0f0; font-family: monospace; padding: 16px; min-height: 100vh; background: #111; }
        .xr-page h1 { font-size: 18px; margin-bottom: 8px; }
        .xr-page__state { font-weight: bold; margin-bottom: 12px; }
        .xr-page__table td { padding: 2px 12px 2px 0; vertical-align: top; }
        .xr-page__mount { width: 100%; height: 240px; margin: 12px 0; border: 1px dashed #444; position: relative; }
        .xr-page__btn { background: #4a90d9; color: #fff; border: none; padding: 10px 20px; font-size: 16px; border-radius: 6px; cursor: pointer; margin: 4px; }
        .xr-page__btn:disabled { opacity: .4; cursor: not-allowed; }
        .xr-page__err { color: #f55; white-space: pre-wrap; margin-top: 12px; border: 1px solid #f55; padding: 8px; }
        .xr-page__ok { color: #5f5; white-space: pre-wrap; margin-top: 12px; border: 1px solid #5f5; padding: 8px; }
        .xr-page__hint { color: #888; font-size: 12px; margin-top: 12px; }
        .xr-page__link { color: #4a90d9; }
      `}</style>

      <h1>WebXR Diagnostic (/xr/test)</h1>
      <div className="xr-page__state" data-testid="xr-state">
        WebXR state: {state.toUpperCase()} | XR mode: {xrMode ?? 'null'}
      </div>

      <table className="xr-page__table">
        <tbody>
          {lines.map((line) => (
            <tr key={line.key}>
              <td>{line.key}</td>
              <td data-testid={`diag-${line.key.replace(/[^a-z0-9]/gi, '-')}`}>{line.value}</td>
            </tr>
          ))}
          <tr>
            <td>Test Scene URL</td>
            <td data-testid="diag-scene-url">{TEST_SCENE}</td>
          </tr>
          <tr>
            <td>Scene</td>
            <td data-testid="diag-scene-state">
              {sceneState.status === 'loading' && 'LOADING'}
              {sceneState.status === 'ready' && 'READY'}
              {sceneState.status === 'failed' && `FAILED — ${sceneState.error}`}
            </td>
          </tr>
          <tr>
            <td>Viewer loaded</td>
            <td data-testid="diag-viewer-loaded">
              {viewerLoaded ? 'READY' : 'loading'}
            </td>
          </tr>
          <tr>
            <td>actual renderer</td>
            <td data-testid="diag-renderer">{renderer ?? '—'}</td>
          </tr>
          <tr>
            <td>state.loaded</td>
            <td data-testid="diag-state-loaded">{runtimeInfo.stateLoaded ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>state.canStartVR</td>
            <td data-testid="diag-can-start-vr">{runtimeInfo.canStartVR ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>frame.gsplats</td>
            <td data-testid="diag-gsplats">{runtimeInfo.gsplats}</td>
          </tr>
          <tr>
            <td>Frame Scene runs</td>
            <td data-testid="diag-frame-scene-count">{frameSceneCount}</td>
          </tr>
          <tr>
            <td>Last XR error</td>
            <td data-testid="diag-last-error">
              {lastError ? `${lastError.kind} :: ${lastError.name}: ${lastError.message}` : 'none'}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="xr-page__mount" ref={mountRef} data-testid="xr-mount" />

      {state === 'unsupported' && lastError?.kind === 'webxr' && (
        <div className="xr-page__err" data-testid="xr-error">
          WebXR support failure
          {'\n'}
          {lastError.name}: {lastError.message}
        </div>
      )}

      {sceneState.status === 'failed' && (
        <div className="xr-page__err" data-testid="xr-scene-error">
          SCENE LOAD ERROR
          {'\n'}
          Scene URL: {TEST_SCENE}
          {'\n'}
          Error: {sceneState.error}
        </div>
      )}

      {(state === 'error' || state === 'starting-xr') && lastError?.kind === 'session' && (
        <div className="xr-page__err" data-testid="xr-session-error">
          XR SESSION START FAILED
          {'\n'}
          {lastError.name}: {lastError.message}
        </div>
      )}

      <button
        className="xr-page__btn"
        onClick={() => void enterVR()}
        disabled={!canEnter}
        data-testid="enter-vr-btn"
      >
        Enter VR
      </button>
      <button
        className="xr-page__btn"
        onClick={frameScene}
        disabled={!(state === 'viewer-ready' || state === 'xr-ended')}
        data-testid="frame-scene-btn"
      >
        Frame Scene
      </button>
      {state === 'xr-active' && (
        <button
          className="xr-page__btn"
          onClick={() => void exitVR()}
          data-testid="exit-vr-btn"
        >
          Exit VR
        </button>
      )}

      {state === 'xr-ended' && (
        <div className="xr-page__ok" data-testid="xr-ended">
          XR SESSION ENDED — click Enter VR to re-enter
        </div>
      )}

      <div className="xr-page__hint">
        <Link className="xr-page__link" to="/">
          首页
        </Link>
        {' · '}
        <Link className="xr-page__link" to="/xr/local-garden">
          /xr/local-garden
        </Link>
      </div>
    </div>
  );
}