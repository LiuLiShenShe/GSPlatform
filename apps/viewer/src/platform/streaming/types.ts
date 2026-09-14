/**
 * Shared types for the Streamed SOG streaming subsystem.
 *
 * These types are host-side (not inside the viewer embed). They describe the
 * manifest layout, scheduling decisions, cache entries, and metrics that the
 * web app and the streaming scheduler consume.
 */

// ---------------------------------------------------------------------------
// Manifest types (mirrors the JSON produced by build_streamed_sog.sh)
// ---------------------------------------------------------------------------

/** The business manifest wrapping the upstream lod-meta.json. */
export interface StreamedManifest {
    schemaVersion: 1;
    sceneId: string;
    assetVersion: string;
    format: 'streamed-sog';
    stream: {
        entryUrl: string;
        byteLength: number;
        sha256: string;
        transport: 'range';
        lodLevels: number;
        counts: number[];
    };
    title?: string;
    posterUrl?: string;
    camera?: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
}

// ---------------------------------------------------------------------------
// Chunk / LOD identifiers
// ---------------------------------------------------------------------------

/**
 * A chunk unit is the smallest transferable unit inside a LOD level.
 * The upstream lod-meta.json `filenames` array lists chunk directories,
 * each containing a `meta.json` and webp files.
 */
export interface ChunkKey {
    /** LOD level index (0 = lowest quality). */
    lod: number;
    /** Chunk index within the LOD level. */
    chunk: number;
}

/** Absolute byte range of a single chunk's data inside the lod-meta.json. */
export interface ChunkRange {
    offset: number;
    length: number;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Priority score for a pending chunk request. Lower numeric value = higher
 * priority (processed first by the min-heap in RequestQueue).
 */
export interface ChunkPriority {
    /** Base priority: screen contribution × quality weight × motion stability. */
    base: number;
    /** Cost estimate: chunk byte length / estimated network throughput. */
    cost: number;
    /** Final priority = base / cost (higher = more urgent). */
    score: number;
}

/** The state machine for an in-flight chunk request. */
export type ChunkRequestState =
    | { state: 'pending' }
    | { state: 'fetching'; startedAt: number }
    | { state: 'decoding'; startedAt: number }
    | { state: 'done' }
    | { state: 'failed'; error: string; retryCount: number }
    | { state: 'cancelled' };

// ---------------------------------------------------------------------------
// Cache / Residency
// ---------------------------------------------------------------------------

/** A single entry in the bounded LRU cache. */
export interface CacheEntry {
    key: string;
    /** Compressed bytes received from the network. */
    bytes: ArrayBuffer;
    /** Approximate decoded size in bytes (GPU memory estimate). */
    decodedBytes: number;
    /** Timestamp of last access (for LRU eviction). */
    lastAccess: number;
    /** LOD level this entry belongs to. */
    lod: number;
}

/** Residency status of a chunk in the streaming pipeline. */
export type ResidencyStatus =
    | 'absent'
    | 'cached'
    | 'decoding'
    | 'resident'
    | 'evicted';

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Snapshot of streaming metrics for a single session. */
export interface StreamingMetricsSnapshot {
    /** Total bytes fetched from the network. */
    bytesFetched: number;
    /** Bytes decoded (decompressed). */
    bytesDecoded: number;
    /** Number of chunk requests completed. */
    chunksCompleted: number;
    /** Number of chunk requests that failed. */
    chunksFailed: number;
    /** Number of requests cancelled (e.g. by LOD switch). */
    chunksCancelled: number;
    /** Current network throughput estimate (bytes/sec). */
    throughput: number;
    /** Cache hit ratio (hits / (hits + misses)). */
    cacheHitRatio: number;
    /** Number of chunks currently resident in GPU memory. */
    gpuResident: number;
    /** Estimated GPU memory usage (bytes). */
    gpuMemoryBytes: number;
}

// ---------------------------------------------------------------------------
// LOD selection
// ---------------------------------------------------------------------------

/** Result of a LOD selection decision. */
export interface LodDecision {
    /** The target LOD index (0 = lowest, 2 = highest). */
    targetLod: number;
    /** The maximum LOD index that can be fetched within the budget. */
    maxFetchableLod: number;
    /** Reason for the decision (for observability). */
    reason:
        | 'initial'
        | 'fps-drop'
        | 'fps-recovery'
        | 'memory-pressure'
        | 'camera-stable'
        | 'camera-moving'
        | 'quality-mode-change'
        | 'user-request';
}

// ---------------------------------------------------------------------------
// Quality modes
// ---------------------------------------------------------------------------

/** The three quality modes exposed to the user. */
export type QualityMode = 'eco' | 'balanced' | 'quality';

/** Configuration for a quality mode. */
export interface QualityModeConfig {
    /** Multiplier for the LOD selection threshold (1 = balanced). */
    lodMultiplier: number;
    /** Maximum number of concurrent fetch requests. */
    maxConcurrent: number;
    /** Maximum bytes to prefetch ahead of the current view. */
    prefetchBudget: number;
    /** Whether to allow GPU eviction of high-LOD chunks. */
    allowEviction: boolean;
}

// ---------------------------------------------------------------------------
// Loader events
// ---------------------------------------------------------------------------

/** Helper: extract the payload type from a listener signature. */
export type ListenerPayload<T> = T extends (payload: infer P) => void ? P : never;

/**
 * Events emitted by the streaming loader to the web app.
 * Values are the payload shapes — the scheduler's `on` and `emit` helpers
 * wrap them into listener signatures automatically.
 */
export interface StreamingEventMap {
    /** Manifest fetched and parsed. */
    manifestReady: { sceneId: string; lodLevels: number; counts: number[] };
    /** A chunk has been fetched from the network. */
    chunkFetched: ChunkKey & { bytes: number; duration: number };
    /** A chunk has been decoded and is ready for GPU upload. */
    chunkDecoded: ChunkKey & { decodedBytes: number };
    /** A LOD level has been fully populated (all chunks resident). */
    lodReady: { lod: number; totalChunks: number };
    /** Overall progress updated (0–1). */
    progress: { loaded: number; total: number; ratio: number };
    /** Streaming error (non-fatal, e.g. single chunk failed). */
    streamingError: { chunk: ChunkKey; error: string; retryable: boolean };
}
