import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createViewer,
  ViewerError,
  codeToUserMessage,
  type ViewerCameraMode,
  type ViewerErrorCode,
  type ViewerHandle,
  type ViewerStats,
} from '@gsplatform/viewer';
import {
  resolveLocalScene,
  LocalSceneError,
} from '../../services/scenes.local';

export interface ViewerLifecycleState {
  /** container ref must be attached to the canvas mount element */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 'idle' before the viewer iframe is ready; 'loading' while the scene loads */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** resolved error (or null) */
  error: string | null;
  errorCode: ViewerErrorCode | null;
  /** latest stats polled from the renderer */
  stats: ViewerStats | null;
  /** current camera mode */
  cameraMode: ViewerCameraMode;
  /** true once the iframe reports ready */
  viewerReady: boolean;
  setCameraMode: (mode: ViewerCameraMode) => void;
  resetCamera: () => void;
  retry: () => void;
}

const STATS_POLL_MS = 1000;

/**
 * Owns the ViewerAdapter lifecycle for one SceneViewerPage mount.
 *
 * - creates the viewer iframe once, on mount
 * - resolves the local scene manifest and loads the scene
 * - polls real stats from the renderer
 * - destroys the viewer on unmount / sceneId change (idempotent)
 * - never touches PlayCanvas internals; only the typed adapter contract
 */
export function useViewerLifecycle(sceneId: string): ViewerLifecycleState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const sceneIdRef = useRef(sceneId);
  sceneIdRef.current = sceneId;

  const [status, setStatus] = useState<ViewerLifecycleState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ViewerErrorCode | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [cameraMode, setCameraModeState] = useState<ViewerCameraMode>('orbit');
  const [viewerReady, setViewerReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // create / destroy the viewer iframe (idempotent; StrictMode-safe)
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let viewer: ViewerHandle | null = null;
    let aborted = false;

    const boot = async () => {
      setStatus('idle');
      setError(null);
      setErrorCode(null);
      setStats(null);
      setViewerReady(false);

      viewer = createViewer(containerRef.current!, {});
      viewerRef.current = viewer;

      const offReady = viewer.on('ready', () => {
        if (!aborted) setViewerReady(true);
      });
      const offViewerFailed = viewer.on('viewerFailed', ({ code }) => {
        if (!aborted) {
          setStatus('error');
          setErrorCode(code);
          setError(codeToUserMessage(code));
        }
      });
      const offContextLost = viewer.on('contextLost', () => {
        if (!aborted) {
          setStatus('error');
          setErrorCode('CONTEXT_LOST');
          setError(codeToUserMessage('CONTEXT_LOST'));
        }
      });

      // resolve the manifest, then load the scene
      try {
        const resolution = await resolveLocalScene(sceneIdRef.current);
        if (aborted) return;
        setStatus('loading');

        const controller = new AbortController();
        try {
          await viewer.loadScene(resolution.descriptor, controller.signal);
          if (!aborted) {
            setStatus('ready');
          }
        } catch (err) {
          if (controller.signal.aborted || aborted) {
            // superseded by a newer scene or unmount: ignore silently
          } else if (err instanceof ViewerError) {
            setStatus('error');
            setErrorCode(err.code);
            setError(codeToUserMessage(err.code));
          } else {
            setStatus('error');
            setErrorCode('UNKNOWN');
            setError(codeToUserMessage('UNKNOWN'));
          }
        }
      } catch (err) {
        if (aborted) return;
        if (err instanceof LocalSceneError) {
          setStatus('error');
          setErrorCode(err.code);
          setError(
            err.code === 'SCENE_NOT_FOUND'
              ? codeToUserMessage('SCENE_NOT_FOUND')
              : codeToUserMessage('ASSET_FETCH_FAILED'),
          );
        } else {
          setStatus('error');
          setErrorCode('UNKNOWN');
          setError(codeToUserMessage('UNKNOWN'));
        }
      }

      return () => {
        offReady();
        offViewerFailed();
        offContextLost();
      };
    };

    void boot().then((cleanup) => cleanup?.());

    return () => {
      aborted = true;
      viewer?.destroy();
      viewerRef.current = null;
    };
  }, [sceneId, reloadKey]);

  // poll real stats from the renderer once ready
  useEffect(() => {
    if (!viewerReady || status !== 'ready') {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      try {
        const s = await viewer.getStats();
        if (!cancelled) setStats(s);
      } catch {
        // transient: ignore until next poll
      }
    };

    void poll();
    timer = setInterval(() => void poll(), STATS_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [viewerReady, status]);

  const setCameraMode = useCallback((mode: ViewerCameraMode) => {
    setCameraModeState(mode);
    void viewerRef.current?.setCameraMode(mode);
  }, []);

  const resetCamera = useCallback(() => {
    void viewerRef.current?.resetCamera();
  }, []);

  const retry = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  return {
    containerRef,
    status,
    error,
    errorCode,
    stats,
    cameraMode,
    viewerReady,
    setCameraMode,
    resetCamera,
    retry,
  };
}