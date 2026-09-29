/**
 * Official XR 诊断页（FIX-04 §3）—— `/xr/test` 与 `/xr/diagnostics/:sceneId`。
 *
 * 所有工程诊断集中在 **这里**（正式 /xr/:sceneId 不显示工程面板）：
 *   Secure Context / navigator.xr / Immersive VR / UA / renderer / frame.gsplats /
 *   runtime state / asset URL / collision / walk / 进入 VR 前相机 pose。
 *
 * 同样必须调用 SuperSplatRuntime(mode='xr')，禁止第二套 Viewer 创建逻辑。
 * 运行态真相来自官方 state：canStartVR / canStartAR / xrMode / loaded。
 *
 * 场景：
 *   - `/xr/diagnostics/:sceneId`：DB 合同场景（与正式 /xr/:sceneId 同链路）
 *   - `/xr/test`：`?scene=<url>` ?? env VITE_XR_TEST_SCENE_URL ??
 *     /local-scenes/local-garden/scene.sog（URL 调试场景）
 * 无 iframe / postMessage / setTimeout 中间跳。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
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
  const { sceneId } = useParams<{ sceneId?: string }>();
  const routeSceneId = sceneId && sceneId.length > 0 ? sceneId : null;
  const testScene = useMemo(() => resolveTestScene(location.search), [location.search]);

  // 路由场景（/xr/diagnostics/:sceneId）→ DB 合同链路；否则 URL 调试场景合成描述。
  const testDescriptor = useMemo(() => {
    if (routeSceneId) return undefined; // 走 DB 合同（useSuperSplatXR 传 sceneId）
    try {
      return descriptorFromSceneUrl('xr-test', testScene);
    } catch {
      return null;
    }
  }, [routeSceneId, testScene]);

  const input = routeSceneId ?? testDescriptor ?? null;
  const { containerRef, ...state } = useSuperSplatXR(input);

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

      <h1>WebXR Diagnostic {routeSceneId ? `/xr/diagnostics/${routeSceneId}` : '(/xr/test)'}</h1>
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
            <td data-testid="diag-scene-url">{routeSceneId ?? testScene}</td>
          </tr>
          <tr>
            <td>User Agent</td>
            <td data-testid="diag-user-agent">{typeof navigator !== 'undefined' ? navigator.userAgent : '—'}</td>
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
            <td>state.canStartAR</td>
            <td data-testid="diag-can-start-ar">{state.canStartAR ? 'true' : 'false'}</td>
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
            <td>state.hasCollision</td>
            <td data-testid="diag-has-collision">{state.hasCollision ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>state.walkAllowed</td>
            <td data-testid="diag-walk-allowed">{state.walkAllowed ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>Camera (pre-XR)</td>
            <td data-testid="diag-camera">
              {(() => {
                const pose = state.getCameraPose();
                return pose
                  ? `${pose.position
                      .map((v) => Number(v.toFixed(3)))
                      .join(', ')} / ${pose.target.map((v) => Number(v.toFixed(3))).join(', ')} / ${Number(pose.fov.toFixed(2))}`
                  : '—';
              })()}
            </td>
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
        {routeSceneId ? (
          <>
            <Link className="xr-page__link" to={`/scene/${routeSceneId}`}>
              Desktop Viewer
            </Link>
            {' · '}
            <Link className="xr-page__link" to={`/xr/${routeSceneId}`}>
              正式 XR 页
            </Link>
          </>
        ) : (
          <>
            <Link className="xr-page__link" to="/">
              首页
            </Link>
            {' · '}
            <Link className="xr-page__link" to="/xr/local-garden">
              /xr/local-garden
            </Link>
          </>
        )}
      </div>
    </div>
  );
}