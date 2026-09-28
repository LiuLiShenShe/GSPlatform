/**
 * SSV-02 — /runtime-test/:sceneId 官方 SuperSplat Runtime Smoke 页。
 *
 * 数据流（唯一路径）：
 *   getSceneRuntime(sceneId)
 *     → buildExperienceSettings(descriptor)
 *     → SuperSplatRuntime.create({ mode: 'desktop' })
 *
 * 显示诊断：sceneId / content URL / format / renderer / loaded / progress /
 * frame.gsplats / cameraMode / walkAllowed / canStartVR。
 * 所有事件都经 SuperSplatRuntime 订阅（不直接监听底层 events）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getSceneRuntime, RuntimeApiError } from '../scene-runtime/runtimeApi';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';
import {
  renderedSplatCount,
  runtimeRenderer,
  SuperSplatRuntime,
} from '../scene-runtime/SuperSplatRuntime';
import { SuperSplatRuntimeError } from '../scene-runtime/runtimeErrors';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';
import { useDocumentTitle } from '../hooks/useBreakpoints';

interface Diagnostics {
  sceneId: string;
  contentUrl: string | null;
  format: string | null;
  renderer: string;
  loaded: boolean;
  progress: number;
  gsplats: number;
  cameraMode: string;
  walkAllowed: boolean;
  canStartVR: boolean;
  xrMode: string | null;
  hasCollision: boolean;
}

export default function RuntimeTestPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? '';
  useDocumentTitle(`Runtime Test ${effectiveSceneId}`);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SuperSplatRuntime | null>(null);
  const unsubsRef = useRef<(() => void)[]>([]);
  const pollRef = useRef<number | null>(null);

  const [descriptor, setDescriptor] = useState<SceneRuntimeDescriptorV1 | null>(null);
  const [renderer, setRenderer] = useState<string>('—');
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [gsplats, setGsplats] = useState(0);
  const [cameraMode, setCameraMode] = useState('—');
  const [walkAllowed, setWalkAllowed] = useState(false);
  const [canStartVR, setCanStartVR] = useState(false);
  const [xrMode, setXrMode] = useState<string | null>(null);
  const [hasCollision, setHasCollision] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameSceneCount, setFrameSceneCount] = useState(0);

  const refreshFromRuntime = (runtime: SuperSplatRuntime) => {
    setRenderer(runtimeRenderer(runtime.app));
    setLoaded(runtime.state.loaded);
    setProgress(runtime.state.progress);
    setCameraMode(runtime.state.cameraMode);
    setWalkAllowed(runtime.state.walkAllowed);
    setCanStartVR(runtime.state.canStartVR);
    setXrMode(runtime.state.xrMode);
    setHasCollision(runtime.state.hasCollision);
    setGsplats(renderedSplatCount(runtime.app));
  };

  useEffect(() => {
    if (!effectiveSceneId) return;
    let cancelled = false;
    const mount = mountRef.current;

    const boot = async () => {
      try {
        // 1) 唯一运行时合同
        const desc = await getSceneRuntime(effectiveSceneId);
        if (cancelled) return;
        setDescriptor(desc);
        if (!desc.content.url) {
          setError('场景尚未发布内容（content.url 为 null）');
          return;
        }

        // 2) Experience Settings v2（官方 validateSettings 已通过）
        const settings = buildExperienceSettings(desc);
        if (!mount) return;

        // 3) 官方 SuperSplat Runtime（desktop → auto renderer）
        const runtime = await SuperSplatRuntime.create({
          container: mount,
          contentUrl: desc.content.url,
          settings,
          posterUrl: desc.scene.posterUrl ?? undefined,
          collisionUrl: desc.collision?.url ?? undefined,
          mode: 'desktop',
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        refreshFromRuntime(runtime);

        // 事件全部经 wrapper 订阅，返回 unsubscribe；卸载一起清理
        unsubsRef.current.push(
          runtime.onLoaded((v) => {
            if (cancelled) return;
            setLoaded(v);
            refreshFromRuntime(runtime);
            if (v) {
              try {
                runtime.frameScene();
                setFrameSceneCount((n) => n + 1);
              } catch (frameErr) {
                console.error('[runtime-test] frameScene failed', frameErr);
              }
            }
          }),
          runtime.onProgress((p) => {
            if (cancelled) return;
            setProgress(p);
          }),
          runtime.onCameraModeChanged((m) => {
            if (cancelled) return;
            setCameraMode(m);
          }),
          runtime.onXRModeChanged((m) => {
            if (cancelled) return;
            setXrMode(m);
          }),
        );

        // 轮询真实引擎状态：renderer / gsplats / walkAllowed / canStartVR
        const tick = () => {
          if (cancelled) return;
          const r = runtimeRef.current;
          if (!r) return;
          refreshFromRuntime(r);
        };
        tick();
        pollRef.current = window.setInterval(tick, 1000);
      } catch (err) {
        if (cancelled) return;
        console.error('[runtime-test] boot failed', err);
        if (err instanceof RuntimeApiError) {
          setError(`RuntimeApiError(${err.kind}, ${err.status ?? '-'}): ${err.message}`);
        } else if (err instanceof SuperSplatRuntimeError) {
          setError(`SuperSplatRuntimeError(${err.kind}): ${err.message}`);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
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
  }, [effectiveSceneId]);

  const diag: Diagnostics = {
    sceneId: effectiveSceneId,
    contentUrl: descriptor?.content.url ?? null,
    format: descriptor?.content.format ?? null,
    renderer,
    loaded,
    progress,
    gsplats,
    cameraMode,
    walkAllowed,
    canStartVR,
    xrMode,
    hasCollision,
  };

  const runtime = runtimeRef.current;

  return (
    <div className="rt-page" data-testid="runtime-test-page">
      <style>{`
        .rt-page { color: #0f0; font-family: monospace; padding: 16px; min-height: 100vh; background: #111; }
        .rt-page h1 { font-size: 18px; margin-bottom: 8px; }
        .rt-page__mount { width: 100%; height: 480px; margin: 12px 0; border: 1px dashed #444; position: relative; }
        .rt-page__field { display: flex; }
        .rt-page__field > dt { width: 170px; color: #8f8; }
        .rt-page__field > dd { margin: 0 0 2px; }
        .rt-page__btn { background: #4a90d9; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; margin: 4px; }
        .rt-page__btn:disabled { opacity: .4; cursor: not-allowed; }
        .rt-page__err { color: #f55; white-space: pre-wrap; border: 1px solid #f55; padding: 8px; }
        .rt-page__link { color: #4a90d9; }
      `}</style>

      <h1>SuperSplat Runtime Test — {effectiveSceneId}</h1>

      {error && <div className="rt-page__err" data-testid="rt-error">{error}</div>}

      <dl>
        {(
          [
            ['sceneId', diag.sceneId],
            ['content URL', diag.contentUrl ?? '—'],
            ['format', diag.format ?? '—'],
            ['renderer', diag.renderer],
            ['loaded', String(diag.loaded)],
            ['progress', `${diag.progress.toFixed(0)}%`],
            ['frame.gsplats', String(diag.gsplats)],
            ['cameraMode', diag.cameraMode],
            ['walkAllowed', String(diag.walkAllowed)],
            ['canStartVR', String(diag.canStartVR)],
            ['xrMode', diag.xrMode ?? 'null'],
            ['hasCollision', String(diag.hasCollision)],
            ['frameScene runs', String(frameSceneCount)],
          ] as [string, string][]
        ).map(([k, v]) => (
          <div className="rt-page__field" key={k}>
            <dt>{k}</dt>
            <dd data-testid={`rt-${k}`}>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="rt-page__mount" ref={mountRef} data-testid="rt-mount" />

      <button
        className="rt-page__btn"
        disabled={!runtime || !runtime.loaded}
        onClick={() => {
          try {
            runtime?.frameScene();
            setFrameSceneCount((n) => n + 1);
          } catch (e) {
            console.error('[runtime-test] frameScene failed', e);
          }
        }}
      >
        Frame Scene
      </button>
      <button
        className="rt-page__btn"
        disabled={!runtime || !runtime.loaded}
        onClick={() => runtime?.resetCamera()}
      >
        Reset Camera
      </button>
      <button
        className="rt-page__btn"
        disabled={!runtime || !runtime.walkAllowed}
        onClick={() => runtime?.toggleWalk()}
      >
        Toggle Walk
      </button>
      <button
        className="rt-page__btn"
        disabled={!runtime || !runtime.loaded}
        onClick={() => {
          void runtime?.requestFullscreen().catch((e) => console.error(e));
        }}
      >
        Fullscreen
      </button>
      <button
        className="rt-page__btn"
        disabled={!runtime || !runtime.canStartVR}
        onClick={() => {
          void runtime?.startVR().catch((e) => console.error(e));
        }}
      >
        Enter VR
      </button>

      <div className="rt-page__hint">
        <Link className="rt-page__link" to={`/scene/${effectiveSceneId}`}>Desktop Viewer</Link>
        {' · '}
        <Link className="rt-page__link" to={`/xr/${effectiveSceneId}`}>XR 页面</Link>
      </div>
    </div>
  );
}