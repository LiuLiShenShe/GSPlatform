/**
 * Official XR 诊断页（SSV-04）—— `/xr/test`。
 *
 * 保留作为 diagnostics 页面，但同样必须调用 SuperSplatRuntime(mode='xr')，
 * 禁止第二套 Viewer 创建逻辑（旧 createXRRuntime 已删除）。
 *
 * 运行态真相来自官方 state：canStartVR / canStartAR / xrMode / loaded。
 * 场景：?scene=<url> ?? env VITE_XR_TEST_SCENE_URL ?? /local-scenes/local-garden/scene.sog
 * 无 iframe / postMessage / setTimeout 中间跳。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { descriptorFromSceneUrl } from '../scene-runtime/descriptorResolver';
import { useSuperSplatXR } from '../features/viewer-official/useSuperSplatXR';
import { useDocumentTitle } from '../hooks/useBreakpoints';

/** 场景 URL 解析：query ?? env ?? fallback（与旧 /xr/test 一致，读当前 location）。 */
function resolveTestScene(search: string): string {
  const params = new URLSearchParams(search);
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

export default function XRTestPage() {
  useDocumentTitle('XR 测试');
  const location = useLocation();
  const testScene = useMemo(() => resolveTestScene(location.search), [location.search]);

  // URL 调试场景：能推断格式就合成描述走官方链路，否则给 hook 传 null 显示错误。
  const testDescriptor = useMemo(() => {
    try {
      return descriptorFromSceneUrl('xr-test', testScene);
    } catch {
      return null;
    }
  }, [testScene]);
  const { containerRef, ...state } = useSuperSplatXR(testDescriptor);

  const [frameSceneCount, setFrameSceneCount] = useState(0);
  const prevLoadedRef = useRef(false);

  // 自动取景计数展示（框架在 onLoaded 内已 frameScene）
  useEffect(() => {
    if (state.loaded && !prevLoadedRef.current) {
      setFrameSceneCount((n) => n + 1);
    }
    prevLoadedRef.current = state.loaded;
  }, [state.loaded]);

  const canEnter = (state.status === 'ready' || state.status === 'xr-ended') && state.canStartVR;

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
        WebXR state: {state.status.toUpperCase()} | XR mode: {state.xrMode ?? 'null'}
      </div>

      <table className="xr-page__table">
        <tbody>
          <tr>
            <td>Secure Context</td>
            <td data-testid="diag-secure-context">{state.diagnostics.secureContext ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>navigator.xr</td>
            <td data-testid="diag-navigator-xr">{state.diagnostics.navigatorXR ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>Immersive VR (browser)</td>
            <td data-testid="diag-immersive-vr">{state.diagnostics.immersiveVrSupported ? 'supported' : 'unsupported'}</td>
          </tr>
          <tr>
            <td>Immersive AR (browser)</td>
            <td data-testid="diag-immersive-ar">{state.diagnostics.immersiveArSupported ? 'supported' : 'unsupported'}</td>
          </tr>
          <tr>
            <td>Test Scene URL</td>
            <td data-testid="diag-scene-url">{testScene}</td>
          </tr>
          <tr>
            <td>Scene</td>
            <td data-testid="diag-scene-state">
              {state.descriptor
                ? `${state.descriptor.scene.name} (${state.descriptor.content.format ?? '—'})${state.isManifestFallback ? ' [manifest]' : ''}`
                : state.status === 'error'
                  ? `FAILED — ${state.error}`
                  : 'LOADING'}
            </td>
          </tr>
          <tr>
            <td>actual renderer</td>
            <td data-testid="diag-renderer">{state.renderer}</td>
          </tr>
          <tr>
            <td>state.loaded</td>
            <td data-testid="diag-state-loaded">{state.loaded ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>state.canStartVR</td>
            <td data-testid="diag-can-start-vr">{state.canStartVR ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>state.xrMode</td>
            <td data-testid="diag-xr-mode">{state.xrMode ?? 'null'}</td>
          </tr>
          <tr>
            <td>frame.gsplats</td>
            <td data-testid="diag-gsplats">{state.gsplats}</td>
          </tr>
          <tr>
            <td>Frame Scene runs</td>
            <td data-testid="diag-frame-scene-count">{frameSceneCount}</td>
          </tr>
        </tbody>
      </table>

      <div className="xr-page__mount" ref={containerRef} data-testid="xr-mount" />

      {state.status === 'error' && (
        <div className="xr-page__err" data-testid="xr-scene-error">{state.error}</div>
      )}

      <button
        className="xr-page__btn"
        onClick={() => void state.startVR().catch(() => undefined)}
        disabled={!canEnter}
        data-testid="enter-vr-btn"
      >
        Enter VR
      </button>
      <button
        className="xr-page__btn"
        onClick={state.frameScene}
        disabled={!(state.status === 'ready' || state.status === 'xr-ended')}
        data-testid="frame-scene-btn"
      >
        Frame Scene
      </button>
      <button
        className="xr-page__btn"
        onClick={() => void state.endXR().catch(() => undefined)}
        disabled={state.xrMode === null}
        data-testid="exit-vr-btn"
      >
        Exit VR
      </button>

      {state.status === 'xr-ended' && (
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