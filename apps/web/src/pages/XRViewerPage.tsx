/**
 * WebXR 修复任务 — /xr/:sceneId 独立 XR 场景页（§5/§9/§10/§11/§12）。
 *
 * 不用 iframe / postMessage：直接在本页创建 supersplat-viewer XR runtime，
 * 场景加载完成后显示 Enter VR 按钮，用户点击 → startXR('vr')。
 *
 * 明确不做（§23）：streamed-sog / LOD / annotation / collision /
 * locomotion / XR UI / skybox / audio。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collectDiagnostics, formatDiagnostics } from '../xr/XRDiagnostics';
import { createXRRuntime, runtimeRenderer, type XRViewerRuntime } from '../xr/XRViewerRuntime';
import { resolveSceneForXR } from '../xr/sceneResolver';
import { XRSceneError, type XRSceneResolution, type XRState } from '../xr/xrTypes';
import { useDocumentTitle } from '../hooks/useBreakpoints';

export default function XRViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? '';
  useDocumentTitle(effectiveSceneId ? `XR 场景 ${effectiveSceneId}` : 'XR 场景');

  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<XRViewerRuntime | null>(null);

  const [state, setState] = useState<XRState>('checking');
  const [diagLines, setDiagLines] = useState<{ key: string; value: string }[]>([]);
  const [scene, setScene] = useState<XRSceneResolution | null>(null);
  const [renderer, setRenderer] = useState<string | null>(null);
  const [lastError, setLastError] = useState<{ name: string; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 解析场景 + 加载 XR viewer（独立 runtime，非 iframe）。
  useEffect(() => {
    if (!effectiveSceneId) return;
    let cancelled = false;
    const mount = mountRef.current;

    const boot = async () => {
      try {
        const diag = await collectDiagnostics();
        if (cancelled) return;
        setDiagLines(formatDiagnostics(diag).map(([key, value]) => ({ key, value })));

        if (!diag.secureContext) {
          setState('unsupported');
          setLastError({
            name: 'SecurityError',
            message: 'WebXR requires a secure context. Please access this page over HTTPS.',
          });
          return;
        }

        const resolution = await resolveSceneForXR(effectiveSceneId);
        if (cancelled) return;
        setScene(resolution);

        if (!mount) {
          setState('error');
          return;
        }
        setState('loading-viewer');
        const runtime = await createXRRuntime({
          container: mount,
          contentUrl: resolution.contentUrl,
          contentFilename: resolution.contentFilename,
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        setRenderer(runtimeRenderer(runtime.app));
        runtime.loadedPromise.then(() => {
          if (cancelled) return;
          setState('viewer-ready');
        });
      } catch (err) {
        if (cancelled) return;
        console.error('XR VIEWER BOOT FAILED', err);
        if (err instanceof XRSceneError) {
          setLoadError(`${err.code}: ${err.message}`);
        } else {
          setLoadError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        }
        setState('error');
      }
    };

    void boot();
    return () => {
      cancelled = true;
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, [effectiveSceneId]);

  // 用户手势内直接 startXR('vr') —— 不经过任何异步 RPC 中间跳。
  const enterVR = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    setLastError(null);
    setState('starting-xr');
    try {
      await runtime.startVR();
      setState('xr-active');
    } catch (err) {
      console.error('XR START FAILED', err);
      setLastError(
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'UnknownError', message: String(err) },
      );
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
      console.error('XR END FAILED', err);
      setLastError(
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'UnknownError', message: String(err) },
      );
      setState('error');
    }
  };

  const canEnter = state === 'viewer-ready' || state === 'xr-ended';

  return (
    <div className="xr-page" data-testid="xr-viewer-page">
      <style>{`
        .xr-page { color: #0f0; font-family: monospace; padding: 16px; min-height: 100vh; background: #111; }
        .xr-page h1 { font-size: 18px; margin-bottom: 8px; }
        .xr-page__state { font-weight: bold; margin-bottom: 12px; }
        .xr-page__mount { width: 100%; height: 320px; margin: 12px 0; border: 1px dashed #444; position: relative; }
        .xr-page__btn { background: #4a90d9; color: #fff; border: none; padding: 10px 20px; font-size: 16px; border-radius: 6px; cursor: pointer; margin: 4px; }
        .xr-page__btn:disabled { opacity: .4; cursor: not-allowed; }
        .xr-page__err { color: #f55; white-space: pre-wrap; margin-top: 12px; border: 1px solid #f55; padding: 8px; }
        .xr-page__hint { color: #888; font-size: 12px; margin-top: 12px; }
        .xr-page__table td { padding: 2px 12px 2px 0; vertical-align: top; }
        .xr-page__link { color: #4a90d9; }
      `}</style>

      <h1>XR Scene: {effectiveSceneId}</h1>
      <div className="xr-page__state" data-testid="xr-state">
        WebXR state: {state.toUpperCase()}
      </div>

      <table className="xr-page__table">
        <tbody>
          {diagLines.map((line) => (
            <tr key={line.key}>
              <td>{line.key}</td>
              <td>{line.value}</td>
            </tr>
          ))}
          <tr>
            <td>Scene</td>
            <td>{scene ? `${scene.title} (${scene.contentFilename ?? '—'})` : '—'}</td>
          </tr>
          <tr>
            <td>Renderer</td>
            <td data-testid="diag-renderer">{renderer ?? '—'}</td>
          </tr>
        </tbody>
      </table>

      <div className="xr-page__mount" ref={mountRef} data-testid="xr-mount" />

      {loadError && (
        <div className="xr-page__err" data-testid="xr-load-error">{loadError}</div>
      )}

      {canEnter && (
        <button
          className="xr-page__btn"
          onClick={() => void enterVR()}
          data-testid="enter-vr-btn"
        >
          Enter VR
        </button>
      )}
      {state === 'xr-active' && (
        <button
          className="xr-page__btn"
          onClick={() => void exitVR()}
          data-testid="exit-vr-btn"
        >
          Exit VR
        </button>
      )}

      {lastError && state === 'error' && (
        <div className="xr-page__err" data-testid="xr-error">
          Error name: {lastError.name}
          {'\n'}
          Error message: {lastError.message}
        </div>
      )}

      <div className="xr-page__hint">
        <Link className="xr-page__link" to={`/scene/${effectiveSceneId}`}>
          返回 Desktop Viewer
        </Link>
        {' · '}
        <Link className="xr-page__link" to="/xr/test">
          打开 /xr/test 诊断页
        </Link>
      </div>
    </div>
  );
}
