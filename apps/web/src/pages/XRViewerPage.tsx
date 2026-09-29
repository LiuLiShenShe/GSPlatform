/**
 * Official XR 场景正式页（FIX-04 §2/§3/§4）—— `/xr/:sceneId`。
 *
 * 与 Desktop 共用同一套 descriptor / settings / content / collision / events：
 *   resolveSceneRuntimeDescriptor(sceneId)
 *     → buildExperienceSettings(descriptor)
 *     → SuperSplatRuntime.create({ mode: 'xr' })   // renderer 强制 'webgl'
 * 禁止第二套 XR runtime。
 *
 * 正式页面（不再是开发诊断页）：
 *   - Viewer 铺满 100vw/100vh viewport；
 *   - UI 只保留：Scene Name / Enter VR / Exit VR（必要时）/ Back / Loading / Error /
 *     进入 VR 前的极简说明；
 *   - 所有工程诊断迁到 `/xr/test` 与 `/xr/diagnostics/:sceneId`（绿色 monospace
 *     面板不在此显示）。
 *
 * 运行态真相完全来自官方 state（canStartVR / xrMode / loaded）。Enter VR = 用户
 * 手势 → runtime.startVR()；退出 = runtime.endXR()（或系统菜单 → onXRModeChanged）。
 * 无 iframe / postMessage / setTimeout 中间跳。
 *
 * 媒体 Overlay（SSV-06/FIX-03）是 **2D 页面层 HTML Overlay**：在进入沉浸会话前 /
 * 退出后可用；沉浸会话内 WebXR 渲染 3D 场景，浏览器 HTML 不会出现在头显视野中
 * （产品行为 = 退出沉浸后使用 2D Overlay，见验收报告 §MEDIA）。
 */
import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSuperSplatXR } from '../features/viewer-official/useSuperSplatXR';
import { AnnotationMediaOverlay } from '../features/viewer-official/AnnotationMediaOverlay';
import { useBackgroundAudio } from '../hooks/useBackgroundAudio';
import { useDocumentTitle } from '../hooks/useBreakpoints';

export default function XRViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? '';
  useDocumentTitle(effectiveSceneId ? `XR 场景 ${effectiveSceneId}` : 'XR 场景');

  const state = useSuperSplatXR(effectiveSceneId);

  // FIX-03 §5/§6/§7：背景音频（XR 页同样由 GSPlatform 控制器管理，官方 soundUrl 停用）。
  const backgroundAudio = useBackgroundAudio(state.descriptor?.backgroundAudio ?? null, effectiveSceneId);

  // SSV-06：媒体 Overlay（2D 页面层，关闭不清除官方 selection；切换标注自动更新）。
  const [overlayOpen, setOverlayOpen] = useState(false);
  const selectedAnnotation = state.selectedGsplatformAnnotation;
  useEffect(() => {
    if (selectedAnnotation) setOverlayOpen(true);
  }, [selectedAnnotation]);

  const canEnter = state.status === 'ready' || state.status === 'xr-ended';
  // 运行态真相驱动按钮；浏览器能力诊断仅隐藏展示。
  const enterReady = canEnter && state.canStartVR;
  const inXR = state.xrMode !== null;
  const sceneName = state.descriptor?.scene.name ?? effectiveSceneId;

  return (
    <div className="gs-xr" data-testid="xr-viewer-page" data-runtime="official">
      {/* 3D 场景铺满 viewport */}
      <div className="gs-xr__mount" ref={state.containerRef} data-testid="xr-mount" />

      {/* 极简 UI（产品层，非工程面板） */}
      <header className="gs-xr__topbar">
        <span className="gs-xr__scene-name" data-testid="xr-scene-name">{sceneName}</span>
        <div className="gs-xr__topbar-right">
          {inXR && (
            <button
              type="button"
              className="gs-xr__btn gs-xr__btn--exit"
              onClick={() => void state.endXR().catch(() => undefined)}
              data-testid="exit-vr-btn"
            >
              退出 VR
            </button>
          )}
          <Link className="gs-xr__back" to={`/scene/${effectiveSceneId}`} data-testid="xr-back-link">
            ← Back
          </Link>
        </div>
      </header>

      {/* 状态层（Loading / Error / 说明 / 已退出） */}
      {state.status === 'loading' && (
        <div className="gs-xr__overlay" data-testid="xr-loading">
          <div className="gs-xr__spinner" />
          <p className="gs-xr__overlay-text">场景加载中… {Math.round(state.progress)}%</p>
        </div>
      )}
      {state.status === 'unsupported' && (
        <div className="gs-xr__overlay" data-testid="xr-unsupported">
          <p className="gs-xr__overlay-text">当前浏览器不支持 WebXR</p>
        </div>
      )}
      {state.status === 'error' && (
        <div className="gs-xr__overlay" data-testid="xr-load-error">
          <p className="gs-xr__overlay-text gs-xr__overlay-text--error">{state.error}</p>
          <button
            type="button"
            className="gs-xr__btn"
            onClick={state.retry}
            data-testid="xr-retry-btn"
          >
            重试
          </button>
        </div>
      )}
      {state.status === 'xr-ended' && (
        <div className="gs-xr__overlay" data-testid="xr-ended">
          <p className="gs-xr__overlay-text">已退出 VR —— 可重新进入</p>
        </div>
      )}

      {/* Enter VR（用户手势）—— 居中大按钮；进入前显示极简说明 */}
      {!inXR && (state.status === 'ready' || state.status === 'xr-ended') && (
        <div className="gs-xr__enter" data-testid="xr-enter-zone">
          {state.status === 'ready' && (
            <p className="gs-xr__hint" data-testid="xr-hint">戴上头显，点击进入沉浸式体验</p>
          )}
          <button
            type="button"
            className="gs-xr__btn gs-xr__btn--enter"
            onClick={() => void state.startVR().catch(() => undefined)}
            disabled={!enterReady}
            data-testid="enter-vr-btn"
          >
            进入 VR
          </button>
        </div>
      )}

      {/* 2D 媒体 Overlay（SSV-06/FIX-03，沉浸会话外使用） */}
      <AnnotationMediaOverlay
        annotation={overlayOpen ? selectedAnnotation : null}
        descriptor={state.descriptor}
        onClose={() => {
          // FIX-03 §7：关闭 Overlay 时恢复背景音频（卸载不保证触发 pause 事件）。
          setOverlayOpen(false);
          backgroundAudio.resume();
        }}
        onPlaybackChange={(isPlaying) =>
          isPlaying ? backgroundAudio.pause() : backgroundAudio.resume()
        }
      />

      {/* 视觉隐藏的运行态读数（e2e 取证：renderer / gsplats / canStartVR / camera /
          collision / walk / 资产 URL / 浏览器能力）。正式用户界面不显示工程面板。 */}
      <span className="gs-xr__diag" data-testid="ov-xr-diagnostics">
        {JSON.stringify({
          status: state.status,
          loaded: state.loaded,
          canStartVR: state.canStartVR,
          canStartAR: state.canStartAR,
          xrMode: state.xrMode,
          renderer: state.renderer,
          gsplats: state.gsplats,
          progress: Math.round(state.progress),
          hasCollision: state.hasCollision,
          walkAllowed: state.walkAllowed,
          secureContext: state.diagnostics.secureContext,
          navigatorXR: state.diagnostics.navigatorXR,
          immersiveVrSupported: state.diagnostics.immersiveVrSupported,
          contentUrl: state.descriptor?.content.url ?? null,
          format: state.descriptor?.content.format ?? null,
          isManifestFallback: state.isManifestFallback,
          error: state.error,
          camera: (() => {
            const pose = state.getCameraPose();
            return pose
              ? {
                  position: pose.position.map((v) => Number(v.toFixed(4))),
                  target: pose.target.map((v) => Number(v.toFixed(4))),
                  fov: Number(pose.fov.toFixed(2)),
                }
              : null;
          })(),
        })}
      </span>
      {/* 逐个 diag-* 隐藏 span（e2e 既有契约：ssv06/ssv07/ssv08/fix02 读 textContent） */}
      <span className="gs-xr__diag" data-testid="diag-state-loaded">{state.loaded ? 'true' : 'false'}</span>
      <span className="gs-xr__diag" data-testid="diag-renderer">{state.renderer}</span>
      <span className="gs-xr__diag" data-testid="diag-can-start-vr">{state.canStartVR ? 'true' : 'false'}</span>
      <span className="gs-xr__diag" data-testid="diag-can-start-ar">{state.canStartAR ? 'true' : 'false'}</span>
      <span className="gs-xr__diag" data-testid="diag-xr-mode">{state.xrMode ?? 'null'}</span>
      <span className="gs-xr__diag" data-testid="diag-gsplats">{state.gsplats}</span>
      <span className="gs-xr__diag" data-testid="diag-has-collision">{state.hasCollision ? 'true' : 'false'}</span>
      <span className="gs-xr__diag" data-testid="diag-walk-allowed">{state.walkAllowed ? 'true' : 'false'}</span>
      <span className="gs-xr__diag" data-testid="diag-scene-url">{state.descriptor?.content.url ?? ''}</span>
      <span className="gs-xr__diag" data-testid="diag-navigator-xr">{state.diagnostics.navigatorXR ? 'true' : 'false'}</span>
      <span className="gs-xr__diag" data-testid="diag-camera">
        {(() => {
          const pose = state.getCameraPose();
          return pose
            ? `${pose.position.map((v) => Number(v.toFixed(3))).join(', ')} / ${pose.target.map((v) => Number(v.toFixed(3))).join(', ')} / ${Number(pose.fov.toFixed(2))}`
            : '—';
        })()}
      </span>
    </div>
  );
}