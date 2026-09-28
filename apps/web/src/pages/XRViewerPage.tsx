/**
 * Official XR 场景页（SSV-04）—— `/xr/:sceneId`。
 *
 * 与 Desktop 共用同一套 descriptor / settings / content / collision / events：
 *   resolveSceneRuntimeDescriptor(sceneId)
 *     → buildExperienceSettings(descriptor)
 *     → SuperSplatRuntime.create({ mode: 'xr' })   // renderer 强制 'webgl'
 *
 * 运行态真相（canStartVR / canStartAR / xrMode / loaded）完全来自官方 state；
 * navigator.xr 只作诊断展示。Enter VR = 用户手势 → runtime.startVR()；
 * 退出 = runtime.endXR()（或浏览器/系统菜单退出 → onXRModeChanged）。
 * 无 iframe / postMessage / setTimeout 中间跳。
 */
import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSuperSplatXR } from '../features/viewer-official/useSuperSplatXR';
import { AnnotationMediaOverlay } from '../features/viewer-official/AnnotationMediaOverlay';
import { useDocumentTitle } from '../hooks/useBreakpoints';

export default function XRViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? '';
  useDocumentTitle(effectiveSceneId ? `XR 场景 ${effectiveSceneId}` : 'XR 场景');

  const state = useSuperSplatXR(effectiveSceneId);

  // SSV-06：媒体 Overlay（关闭不清除官方 selection；切换标注自动更新）。
  const [overlayOpen, setOverlayOpen] = useState(false);
  const selectedAnnotation = state.selectedGsplatformAnnotation;
  useEffect(() => {
    if (selectedAnnotation) setOverlayOpen(true);
  }, [selectedAnnotation]);

  const canEnter = state.status === 'ready' || state.status === 'xr-ended';
  // 运行态真相驱动按钮；浏览器能力诊断仅展示。
  const enterReady = canEnter && state.canStartVR;

  return (
    <div className="xr-page" data-testid="xr-viewer-page">
      <style>{`
        .xr-page { color: #0f0; font-family: monospace; padding: 16px; min-height: 100vh; background: #111; }
        .xr-page h1 { font-size: 18px; margin-bottom: 8px; }
        .xr-page__state { font-weight: bold; margin-bottom: 12px; }
        .xr-page__table td { padding: 2px 12px 2px 0; vertical-align: top; }
        .xr-page__mount { width: 100%; height: 320px; margin: 12px 0; border: 1px dashed #444; position: relative; }
        .xr-page__btn { background: #4a90d9; color: #fff; border: none; padding: 10px 20px; font-size: 16px; border-radius: 6px; cursor: pointer; margin: 4px; }
        .xr-page__btn:disabled { opacity: .4; cursor: not-allowed; }
        .xr-page__err { color: #f55; white-space: pre-wrap; margin-top: 12px; border: 1px solid #f55; padding: 8px; }
        .xr-page__ok { color: #5f5; white-space: pre-wrap; margin-top: 12px; border: 1px solid #5f5; padding: 8px; }
        .xr-page__hint { color: #888; font-size: 12px; margin-top: 12px; }
        .xr-page__link { color: #4a90d9; }
      `}</style>

      <h1>XR Scene: {effectiveSceneId}</h1>
      <div className="xr-page__state" data-testid="xr-state">
        WebXR state: {state.status.toUpperCase()} | XR mode: {state.xrMode ?? 'null'}
      </div>

      <table className="xr-page__table">
        <tbody>
          <tr>
            <td>Secure Context</td>
            <td>{state.diagnostics.secureContext ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>navigator.xr</td>
            <td data-testid="diag-navigator-xr">
              {state.diagnostics.navigatorXR ? 'true' : 'false'}
            </td>
          </tr>
          <tr>
            <td>Immersive VR (browser)</td>
            <td>{state.diagnostics.immersiveVrSupported ? 'supported' : 'unsupported'}</td>
          </tr>
          <tr>
            <td>Immersive AR (browser)</td>
            <td>{state.diagnostics.immersiveArSupported ? 'supported' : 'unsupported'}</td>
          </tr>
          <tr>
            <td>Scene URL</td>
            <td data-testid="diag-scene-url">
              {state.descriptor?.content.url ?? '—'}
            </td>
          </tr>
          <tr>
            <td>Scene</td>
            <td>
              {state.descriptor
                ? `${state.descriptor.scene.name} (${state.descriptor.content.format ?? '—'})${state.isManifestFallback ? ' [manifest]' : ''}`
                : '—'}
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
            <td>state.hasCollision</td>
            <td data-testid="diag-has-collision">{state.hasCollision ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>state.walkAllowed</td>
            <td data-testid="diag-walk-allowed">{state.walkAllowed ? 'true' : 'false'}</td>
          </tr>
          <tr>
            <td>frame.gsplats</td>
            <td data-testid="diag-gsplats">{state.gsplats}</td>
          </tr>
        </tbody>
      </table>

      <div className="xr-page__mount" ref={state.containerRef} data-testid="xr-mount">
        <AnnotationMediaOverlay
          annotation={overlayOpen ? selectedAnnotation : null}
          descriptor={state.descriptor}
          onClose={() => setOverlayOpen(false)}
        />
      </div>

      {state.status === 'error' && (
        <div className="xr-page__err" data-testid="xr-load-error">{state.error}</div>
      )}

      <button
        className="xr-page__btn"
        onClick={() => void state.startVR().catch(() => undefined)}
        disabled={!enterReady}
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