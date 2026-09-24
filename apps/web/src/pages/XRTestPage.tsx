/**
 * WebXR 修复任务 — /xr/test 诊断页（§7/§8/§11）。
 *
 * 页面直接可视化显示 WebXR 能力状态，供 Quest / PICO 头显内直接查看。
 * 不做任何场景加载 —— 只验证"能否真实创建 immersive-vr XRSession"链路。
 */
import { useEffect, useRef, useState } from 'react';
import {
  collectDiagnostics,
  formatDiagnostics,
} from '../xr/XRDiagnostics';
import { createXRRuntime, runtimeRenderer } from '../xr/XRViewerRuntime';
import type { XRState } from '../xr/xrTypes';
import { useDocumentTitle } from '../hooks/useBreakpoints';

const TEST_SOG = '/local-scenes/local-garden/scene.sog';

export default function XRTestPage() {
  useDocumentTitle('XR 测试');
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Awaited<ReturnType<typeof createXRRuntime>> | null>(null);

  const [state, setState] = useState<XRState>('checking');
  const [lines, setLines] = useState<{ key: string; value: string }[]>([]);
  const [viewerLoaded, setViewerLoaded] = useState(false);
  const [renderer, setRenderer] = useState<string | null>(null);
  const [lastError, setLastError] = useState<{ name: string; message: string } | null>(null);

  // ---- 步骤 1:能力诊断 + 加载 viewer ----
  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;

    const boot = async () => {
      try {
        const diag = await collectDiagnostics();
        if (cancelled) return;
        setLines(formatDiagnostics(diag).map(([key, value]) => ({ key, value })));

        if (!diag.secureContext) {
          setState('unsupported');
          setLastError({
            name: 'SecurityError',
            message: 'WebXR requires a secure context. Please access this page over HTTPS.',
          });
          return;
        }
        if (!diag.immersiveVrSupported) {
          setState('unsupported');
          setLastError({
            name: 'NotSupportedError',
            message: 'immersive-vr not supported by this browser / device.',
          });
          return;
        }

        if (!mount) {
          setState('error');
          return;
        }
        setState('loading-viewer');
        const runtime = await createXRRuntime({
          container: mount,
          contentUrl: TEST_SOG,
          contentFilename: 'scene.sog',
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        setRenderer(runtimeRenderer(runtime.app));

        runtime.loadedPromise.then(() => {
          if (cancelled) return;
          setViewerLoaded(true);
          setState('viewer-ready');
        });
      } catch (err) {
        if (cancelled) return;
        console.error('XR TEST BOOT FAILED', err);
        setState('error');
        setLastError(
          err instanceof Error
            ? { name: err.name, message: err.message }
            : { name: 'UnknownError', message: String(err) },
        );
      }
    };

    void boot();
    return () => {
      cancelled = true;
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, []);

  // ---- 步骤 2:用户点击 → startXR('vr') ----
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
      const detail =
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: 'UnknownError', message: String(err) };
      setLastError(detail);
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
        .xr-page__hint { color: #888; font-size: 12px; margin-top: 12px; }
      `}</style>

      <h1>WebXR Diagnostic (/xr/test)</h1>
      <div className="xr-page__state" data-testid="xr-state">
        WebXR state: {state.toUpperCase()}
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
            <td>Viewer</td>
            <td>{viewerLoaded ? 'READY' : 'loading'}</td>
          </tr>
          <tr>
            <td>Renderer</td>
            <td data-testid="diag-renderer">{renderer ?? '—'}</td>
          </tr>
        </tbody>
      </table>

      <div className="xr-page__mount" ref={mountRef} data-testid="xr-mount" />

      {state === 'unsupported' && lastError && (
        <div className="xr-page__err" data-testid="xr-error">
          Error name: {lastError.name}
          {'\n'}
          Error message: {lastError.message}
        </div>
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
        预期：Secure Context = true · navigator.xr = true · Immersive VR = supported ·
        Renderer = WebGL2 · 点击 Enter VR 后状态变为 XR SESSION ACTIVE。
      </div>
    </div>
  );
}
