/**
 * Streamed SOG streaming subsystem (Phase 04).
 *
 * Host-side modules that drive progressive loading of a streamed-SOG scene:
 * manifest resolution, priority-ordered chunk requests, LOD selection with
 * hysteresis, bounded caching/residency, and metrics for the performance UI.
 *
 * The actual Range-based file I/O happens inside the viewer embed via
 * splat-transform's UrlReadFileSystem; this subsystem orchestrates *what* gets
 * asked for, *when*, and how the results are budgeted and reported.
 */
export { StreamedSogLoader } from './StreamedSogLoader';
export { StreamScheduler } from './StreamScheduler';
export { LodSelector } from './LodSelector';
export { RequestQueue } from './RequestQueue';
export { ResidencyManager } from './ResidencyManager';
export { BoundedLru } from './BoundedLru';
export { StreamingMetrics } from './StreamingMetrics';

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
} from './types';
