import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createViewer,
  ViewerError,
  codeToUserMessage,
  LoadSession,
  StreamedSogLoader,
  type ViewerCameraMode,
  type ViewerErrorCode,
  type ViewerHandle,
  type ViewerStats,
  type LoadPhase,
  type LODLevel,
  type QualityMode,
  type StreamingMetricsSnapshot,
} from '@gsplatform/viewer';
import {
  resolveProgressiveScene,
  resolveStreamedScene,
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
  /** Phase 03: real progressive progress (null while preparing) */
  progress: number | null;
  /** current phase label from the state machine */
  phase: LoadPhase;
  /** bytes read for the LOD currently being fetched */
  loadedBytes: number;
  totalBytes: number | null;
  indeterminate: boolean;
  /** best LOD currently interactive on screen */
  currentLod: LODLevel | null;
  /** poster image URL for the loading backdrop (null => gradient fallback) */
  posterUrl: string | null;
  placeholderColor?: string;
  /** loading overlay should stay mounted (dismissed shortly after READY). */
  overlayVisible: boolean;
  setCameraMode: (mode: ViewerCameraMode) => void;
  resetCamera: () => void;
  retry: () => void;
  /** Cancel the in-flight progressive load (leaves best LOD interactive). */
  cancelLoad: () => void;

  // Phase 04 — streamed-SOG fields
  /** Whether the current scene is streamed-SOG format. */
  isStreamed: boolean;
  /** Current quality mode (eco / balanced / quality). */
  qualityMode: QualityMode;
  /** Switch quality mode at runtime. */
  setQualityMode: (mode: QualityMode) => void;
  /** Latest streaming metrics snapshot (null until streaming is active). */
  streamingMetrics: StreamingMetricsSnapshot | null;
}

const STATS_POLL_MS = 1000;

/**
 * Owns the ViewerAdapter lifecycle for one SceneViewerPage mount.
 *
 * - creates the viewer iframe once, on mount
 * - resolves the progressive scene manifest (low/medium/high LODs + poster)
 * - drives a LoadSession: real byte progress during fetch, decoded/applied/
 *   firstFrame events from the embed settle each weight segment
 * - poll real stats from the renderer once interactive
 * - destroys the viewer on unmount / sceneId change (idempotent)
 * - never touches PlayCanvas internals; only the typed adapter contract
 */
export function useViewerLifecycle(sceneId: string): ViewerLifecycleState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const sceneIdRef = useRef(sceneId);
  sceneIdRef.current = sceneId;

  const [status, setStatus] = useState<ViewerLifecycleState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ViewerErrorCode | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [cameraMode, setCameraModeState] = useState<ViewerCameraMode>('orbit');
  const [viewerReady, setViewerReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Phase 03 progressive-loading state
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('PREPARING');
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [indeterminate, setIndeterminate] = useState(false);
  const [currentLod, setCurrentLod] = useState<LODLevel | null>(null);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [placeholderColor, setPlaceholderColor] = useState<string | undefined>(undefined);

  // Phase 04 — streamed-SOG state
  const [isStreamed, setIsStreamed] = useState(false);
  const [qualityMode, setQualityModeState] = useState<QualityMode>('balanced');
  const [streamingMetrics, setStreamingMetrics] = useState<StreamingMetricsSnapshot | null>(null);
  const streamedLoaderRef = useRef<StreamedSogLoader | null>(null);

  /** True while the loading overlay should stay mounted. */
  const [overlayVisible, setOverlayVisible] = useState(true);
  /** Delayed unmount so the user (and tests) can observe the completed 100%. */
  const dissolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // create / destroy the viewer iframe (idempotent; StrictMode-safe)
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let viewer: ViewerHandle | null = null;
    let aborted = false;
    let loadController: AbortController | null = null;
    const boot = async () => {
      setStatus('idle');
      setError(null);
      setErrorCode(null);
      setStats(null);
      setViewerReady(false);
      setProgress(null);
      setPhase('PREPARING');
      setLoadedBytes(0);
      setTotalBytes(null);
      setIndeterminate(false);
      setCurrentLod(null);
      setPosterUrl(null);
      setPlaceholderColor(undefined);
      setOverlayVisible(true);
      if (dissolveTimerRef.current) {
        clearTimeout(dissolveTimerRef.current);
        dissolveTimerRef.current = null;
      }

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

      try {
        // Phase 04: try the streamed-SOG manifest path first. If the manifest
        // format is 'streamed-sog', drive the StreamedSogLoader instead of
        // the Phase 03 progressive LoadSession (blob-per-LOD).
        const sessionId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        let streamedResolution;
        try {
          streamedResolution = await resolveStreamedScene(sceneIdRef.current);
        } catch (err) {
          // Not a streamed-SOG manifest (older scene) — fall through to the
          // progressive path. Only treat it as an error if the manifest was
          // actually streamed-sog but malformed.
          streamedResolution = null;
          if (err instanceof LocalSceneError && err.code === 'ASSET_FETCH_FAILED') {
            // re-throw only fatal fetch failures; format mismatches are fine
            throw err;
          }
        }

        if (streamedResolution) {
          if (aborted) return;
          setStatus('loading');
          setIsStreamed(true);
          setPosterUrl(streamedResolution.manifest.posterUrl ?? null);

          const loader = new StreamedSogLoader(streamedResolution.manifest);
          streamedLoaderRef.current = loader;
          loadController = new AbortController();
          loadControllerRef.current = loadController;

          // feed streaming metrics to the UI on a low-frequency timer
          const metricsTimer = window.setInterval(() => {
            if (aborted) return;
            setStreamingMetrics(loader.scheduler.metrics.snapshot());
          }, STATS_POLL_MS);

          // subscribe to progress / readiness events for the status overlay
          const offProgress = loader.on('progress', (p) => {
            if (aborted) return;
            setProgress(p.ratio * 100);
            setLoadedBytes(p.loaded);
            setTotalBytes(p.total);
            setIndeterminate(false);
          });
          const offChunk = loader.on('chunkDecoded', (_p) => {
            // each decoded chunk nudges interactivity; update currentLod based
            // on the streaming target for display purposes
            setCurrentLod('low');
          });

          await loader.start(viewer);

          // streamed scenes are interactive immediately after the low LOD
          // first frame; report ready and dissolve the overlay quickly.
          if (aborted) { clearInterval(metricsTimer); offProgress(); offChunk(); return; }
          setStatus('ready');
          setPhase('READY');
          setProgress(99);
          dissolveTimerRef.current = setTimeout(() => {
            if (!aborted) { setOverlayVisible(false); setProgress(100); }
            dissolveTimerRef.current = null;
          }, 400);

          return () => {
            clearInterval(metricsTimer);
            offProgress();
            offChunk();
            loader.destroy();
            streamedLoaderRef.current = null;
            loadController?.abort();
            loadControllerRef.current = null;
            offReady();
            offViewerFailed();
            offContextLost();
          };
        }

        // Resolve the progressive manifest (fetch + validation), then drive a
        // LoadSession for the LOD tiers.

        loadController = new AbortController();
        loadControllerRef.current = loadController;
        const resolution = await resolveProgressiveScene(sceneIdRef.current, loadController.signal);
        const session = new LoadSession(
          viewer,
          {
            id: resolution.descriptor.id,
            lods: resolution.lods,
            camera: resolution.camera ?? undefined,
          },
          sessionId,
          {
            onProgress: (p) => {
              if (aborted || p.sessionId !== sessionId) return;
              setProgress(p.percent);
              setPhase(p.phase);
              setLoadedBytes(p.loadedBytes);
              setTotalBytes(p.totalBytes);
              setIndeterminate(p.indeterminate);
            },
            onStage: (_s, lod) => {
              if (!aborted) setCurrentLod(lod);
            },
          },
        );

        const result = await session.start(loadController.signal);
        if (aborted) return;

        if (result.status === 'ready') {
          // Keep the overlay mounted a moment at a real 100% so the
          // completion state is perceivable (and verifiable in e2e) before
          // it dissolves to the interactive scene.
          setStatus('ready');
          setPhase('READY');
          setProgress(100);
          dissolveTimerRef.current = setTimeout(() => {
            if (!aborted) setOverlayVisible(false);
            dissolveTimerRef.current = null;
          }, 800);
        } else if (result.status === 'error') {
          // medium/high failure: low remains interactive. Keep the viewer on
          // screen but flag the degraded state in the phase.
          setPhase('ERROR');
          setStatus('ready');
          setError(
            result.lod === 'low'
              ? codeToUserMessage('ASSET_FETCH_FAILED')
              : `高质量 LOD 加载失败，已保留低清可交互版本（${result.code}）`,
          );
          setErrorCode(result.code === 'SCENE_NOT_FOUND' ? 'SCENE_NOT_FOUND' : 'ASSET_FETCH_FAILED');
        } else if (result.status === 'cancelled') {
          setPhase('CANCELLED');
          // no error surface; a newer scene or unmount superseded it
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

      return () => {
        offReady();
        offViewerFailed();
        offContextLost();
      };
    };

    void boot().then((cleanup) => cleanup?.());

    return () => {
      aborted = true;
      if (dissolveTimerRef.current) {
        clearTimeout(dissolveTimerRef.current);
        dissolveTimerRef.current = null;
      }
      loadController?.abort();
      loadControllerRef.current = null;
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

  const cancelLoad = useCallback(() => {
    loadControllerRef.current?.abort();
  }, []);

  const setQualityMode = useCallback((mode: QualityMode) => {
    setQualityModeState(mode);
    streamedLoaderRef.current?.setQuality(mode);
  }, []);

  return {
    containerRef,
    status,
    error,
    errorCode,
    stats,
    cameraMode,
    viewerReady,
    progress,
    phase,
    loadedBytes,
    totalBytes,
    indeterminate,
    currentLod,
    posterUrl,
    placeholderColor,
    overlayVisible,
    setCameraMode,
    resetCamera,
    retry,
    cancelLoad,
    // Phase 04 streamed fields
    isStreamed,
    qualityMode,
    setQualityMode,
    streamingMetrics,
  };
}
