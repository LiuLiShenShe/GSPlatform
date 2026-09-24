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
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { collectDiagnostics, formatDiagnostics } from '../xr/XRDiagnostics';
import { createXRRuntime, runtimeRenderer, type XRViewerRuntime } from '../xr/XRViewerRuntime';
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

export default function XRTestPage() {
  useDocumentTitle('XR 测试');
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<XRViewerRuntime | null>(null);
  // 订阅句柄：组件卸载时必须 unsubscribe，避免 listener leak（§4）。
  const unsubRef = useRef<(() => void) | null>(null);
  // 进入过 XR 的标志，用 ref 避免闭包捕获旧 state。
  const hadXRRef = useRef(false);

  const [state, setState] = useState<XRState>('checking');
  const [lines, setLines] = useState<{ key: string; value: string }[]>([]);
  const [viewerLoaded, setViewerLoaded] = useState(false);
  const [renderer, setRenderer] = useState<string | null>(null);
  const [lastError, setLastError] = useState<{
    kind: 'scene' | 'webxr' | 'session';
    name: string;
    message: string;
  } | null>(null);
  const [sceneState, setSceneState] = useState<SceneLoadingState>({ status: 'loading' });
  const [xrMode, setXrMode] = useState<string | null>(null);

  // ---- 步骤 0:能力诊断 ----
  useEffect(() => {
    void collectDiagnostics().then((diag) => {
      setLines(formatDiagnostics(diag).map(([key, value]) => ({ key, value })));
    });
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

        // 场景首帧渲染完成 → Scene READY（§9）。
        await runtime.loadedPromise;
        if (cancelled) return;
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

  // Enter VR 启用条件：Viewer READY + Scene READY + WebXR supported（§15）。
  const sceneReady = sceneState.status === 'ready';
  const canEnter =
    state === 'viewer-ready' &&
    viewerLoaded &&
    sceneReady;

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
            <td>Viewer</td>
            <td>{viewerLoaded ? 'READY' : 'loading'}</td>
          </tr>
          <tr>
            <td>Renderer</td>
            <td data-testid="diag-renderer">{renderer ?? '—'}</td>
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