/**
 * GSPlatform Viewer Platform API.
 *
 * This is the only public contract the web app may depend on when integrating
 * the SuperSplat Viewer fork. It exposes a typed, minimal surface for creating
 * a viewer, loading scenes, controlling the camera and reading real stats.
 *
 * The web app never imports PlayCanvas or any viewer internal module.
 */
export { createViewer } from './ViewerAdapter';
export type {
    CreateViewerOptions,
    ViewerCameraMode,
    ViewerCameraPose,
    ViewerEventMap,
    ViewerHandle,
    ViewerStats,
    ViewerWorldTransform,
    ViewerBackground,
    ViewerScreenshotResult
} from './ViewerAdapter';
export type { SceneDescriptor } from './SceneDescriptor';
export { codeToUserMessage, ViewerError } from './ViewerError';
export type { ViewerErrorCode, ViewerErrorDetail } from './ViewerError';

// Progressive loading (Phase 03) — types only; the host page uses these to
// drive multi-LOD sessions through the viewer.
export {
    LoadSession,
    phaseLabel,
    fetchArrayBufferWithProgress
} from './loading/LoadSession';
export type { LoadSessionCallbacks, LoadSessionResult, ProgressiveManifest } from './loading/LoadSession';
export {
    ProgressAggregator
} from './loading/ProgressAggregator';
export { LodSwitcher } from './loading/LodSwitcher';
export type {
    LODAssetRef,
    LODLevel,
    LoadPhase,
    LoadProgress,
    LODStage
} from './loading/LoadEvents';
export { LOD_LEVELS } from './loading/LoadEvents';

// Streamed SOG streaming (Phase 04) — host-side orchestration.
export {
    StreamedSogLoader,
    StreamScheduler,
    LodSelector,
    RequestQueue,
    ResidencyManager,
    BoundedLru,
    StreamingMetrics
} from './streaming';
export type {
    StreamedManifest,
    ChunkKey,
    ChunkRange,
    ChunkPriority,
    ChunkRequestState,
    CacheEntry,
    ResidencyStatus,
    LodDecision,
    QualityMode,
    QualityModeConfig,
    StreamingMetricsSnapshot,
    StreamingEventMap
} from './streaming';
