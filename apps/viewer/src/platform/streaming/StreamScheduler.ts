import { LodSelector } from './LodSelector';
import { RequestQueue } from './RequestQueue';
import { ResidencyManager } from './ResidencyManager';
import { StreamingMetrics } from './StreamingMetrics';
import type { ChunkKey, QualityMode, StreamedManifest, StreamingEventMap } from './types';

/**
 * Orchestrates the streaming pipeline for a single streamed-SOG scene.
 *
 * Responsibilities (Phase 04 checklist C / D / E):
 *   - Maintain a priority queue of chunk requests, reordered when the camera
 *     moves or the LOD target changes.
 *   - Deduplicate concurrent requests for the same chunk.
 *   - Bound in-flight requests, decoded bytes, and GPU uploads.
 *   - Cancel or deprioritize stale requests when the camera moves fast.
 *   - Apply exponential backoff with jitter on transient failures.
 *   - Emit progress / metrics events to the web-app UI.
 */
export class StreamScheduler {
    private manifest: StreamedManifest | null = null;
    private readonly queue = new RequestQueue();
    private readonly events = new Map<string, Set<(payload: any) => void>>();
    private abortControllers = new Map<string, AbortController>();

    /** Concurrency and cache managers. */
    readonly metrics = new StreamingMetrics();
    readonly lodSelector: LodSelector;
    readonly residency: ResidencyManager;

    /** Maximum concurrent fetch requests. */
    maxConcurrent = 4;
    /** Maximum total bytes fetched but not yet decoded. */
    inflightBudget = 4 * 1024 * 1024;

    /** Active retry state per key: { retries, backoffMs }. */
    private readonly retries = new Map<string, { count: number; delayMs: number }>();
    private readonly maxRetries = 3;
    private readonly baseBackoffMs = 200;

    /** Abort controller for the whole session. */
    private sessionAbort: AbortController | null = null;

    constructor(lodCounts: number[]) {
        this.lodSelector = new LodSelector(lodCounts);
        this.residency = new ResidencyManager(64 * 1024 * 1024); // 64 MB CPU cache
    }

    // -- events --------------------------------------------------------------

    on<K extends keyof StreamingEventMap>(type: K, listener: (payload: StreamingEventMap[K]) => void): () => void {
        let set = this.events.get(type);
        if (!set) {
            set = new Set();
            this.events.set(type, set);
        }
        set.add(listener as (payload: any) => void);
        return () => {
            set.delete(listener as (payload: any) => void);
        };
    }

    private emit<K extends keyof StreamingEventMap>(type: K, payload: StreamingEventMap[K]): void {
        const set = this.events.get(type);
        if (set) for (const fn of set) fn(payload);
    }

    // -- public API ----------------------------------------------------------

    /**
     * Attach a parsed manifest. Starts the initial prefetch for the lowest LOD
     * and emits `manifestReady`.
     */
    setManifest(manifest: StreamedManifest): void {
        this.manifest = manifest;
        this.emit('manifestReady', {
            sceneId: manifest.sceneId,
            lodLevels: manifest.stream.lodLevels,
            counts: manifest.stream.counts
        });
        this.prefetchInitial(manifest);
    }

    /**
     * Feed a frame-time sample to the LOD selector. Call once per frame.
     */
    feedFrameTime(frameTimeMs: number): void {
        this.lodSelector.feedFrame(frameTimeMs);
    }

    /**
     * Signal camera motion state. The scheduler uses this to deprioritize
     * stale high-LOD requests and to stabilize the LOD target.
     */
    signalCameraMotion(moving: boolean): void {
        this.lodSelector.signalCameraMotion(moving);
        if (moving) this.cancelStaleRequests();
    }

    /**
     * Switch quality mode. The scheduler re-scores the pending queue and
     * adjusts concurrency/prefetch budgets.
     */
    setQuality(mode: QualityMode): void {
        this.lodSelector.setMode(mode);
        this.maxConcurrent = this.lodSelector.modeConfig.maxConcurrent;
        this.inflightBudget = this.lodSelector.modeConfig.prefetchBudget;
    }

    /**
     * Check the LOD selector and reprioritize the queue. Intended to be called
     * at a low rate (e.g. every 200ms, not every frame).
     */
    tick(): void {
        if (!this.manifest) return;
        this.lodSelector.decide();
        this.reschedulePending();
        this.drainQueue();
    }

    /**
     * Abort all in-flight requests (e.g. on scene change or route leave).
     */
    abort(): void {
        this.sessionAbort?.abort();
        this.sessionAbort = null;
        for (const ctrl of this.abortControllers.values()) {
            ctrl.abort();
            this.metrics.recordCancellation();
        }
        this.abortControllers.clear();
        this.queue.clear();
        this.retries.clear();
    }

    /**
     * Full reset (new scene).
     */
    reset(): void {
        this.abort();
        this.manifest = null;
        this.metrics.reset();
        this.residency.reset();
    }

    // -- internals -----------------------------------------------------------

    /** Prefetch the lowest LOD chunks for fast interactive first frame. */
    private prefetchInitial(manifest: StreamedManifest): void {
        const counts = manifest.stream.counts;
        if (counts.length === 0) return;
        // schedule the lowest LOD (index 0) first
        const totalChunks = this.estimateChunkCount(counts[0]);
        for (let i = 0; i < totalChunks; i++) {
            const key = `0_${i}`;
            if (this.residency.getStatus(key) !== 'absent') continue;
            this.enqueue(key, { lod: 0, chunk: i }, 1000);
        }
    }

    /** Estimate how many chunk units a given LOD level has (heuristic). */
    private estimateChunkCount(count: number): number {
        // approx 2K gaussians per chunk, like the build script's balanced profile
        return Math.max(1, Math.ceil(count / 2000));
    }

    private enqueue(key: string, chunk: ChunkKey, priority: number): void {
        if (this.residency.isCached(key) || this.residency.isGpuResident(key)) return;
        this.queue.push(key, chunk, priority);
    }

    /** Re-score all pending requests based on the current LOD target. */
    private reschedulePending(): void {
        const target = this.lodSelector.targetLod;
        const keys = this.queue.keys();
        for (const key of keys) {
            // parse lod from key "lod_chunk"
            const lod = parseInt(key.split('_')[0], 10);
            const priority = lod <= target ? 1000 : 100; // target LOD gets top priority
            this.queue.push(key, { lod, chunk: 0 }, priority);
        }
    }

    /** Cancel requests for LODs above the current target (camera moved fast). */
    private cancelStaleRequests(): void {
        const target = this.lodSelector.targetLod;
        for (const key of this.queue.keys()) {
            const lod = parseInt(key.split('_')[0], 10);
            if (lod > target + 1) {
                const ctrl = this.abortControllers.get(key);
                ctrl?.abort();
                this.abortControllers.delete(key);
                this.queue.remove(key);
                this.metrics.recordCancellation();
            }
        }
    }

    /** Pop pending requests and start fetches up to the concurrency limit. */
    private drainQueue(): void {
        while (this.abortControllers.size < this.maxConcurrent) {
            const next = this.queue.pop();
            if (!next) break;
            this.startFetch(next.key, next.chunk);
        }
    }

    /** Fetch a single chunk with retry / backoff / abort support. */
    private startFetch(key: string, chunk: ChunkKey): void {
        if (!this.manifest) return;
        const ctrl = new AbortController();
        this.abortControllers.set(key, ctrl);
        this.queue.setState(key, { state: 'fetching', startedAt: Date.now() });

        try {
            // For now, the actual fetch is done inside the viewer embed via
            // UrlReadFileSystem — the scheduler's job is bookkeeping. We
            // simulate the fetch event so the metrics/progress update correctly.
            // The real chunk data flows through splat-transform inside the embed;
            // this path is for observing progress when the embed posts lodState
            // events back. See StreamedSogLoader for the real integration.
            //
            // Until the viewer exposes a per-chunk fetch hook, we mark the
            // chunk as "done" immediately so the host-side metrics stay in sync
            // with the lodState events the embed emits. This will be replaced
            // by the real fetch flow once the viewer embed exposes a
            // `loadChunk(key)` RPC or the scheduler drives fetches directly.
            this.residency.markDecoding(key);
            this.metrics.recordFetch(0, 0);
            this.residency.markCached({ key, bytes: new ArrayBuffer(0), decodedBytes: 0, lastAccess: Date.now(), lod: chunk.lod });
            this.residency.markResident(key);
            this.emit('chunkFetched', { lod: chunk.lod, chunk: chunk.chunk, bytes: 0, duration: 0 });
            this.emit('chunkDecoded', { lod: chunk.lod, chunk: chunk.chunk, decodedBytes: 0 });
            this.abortControllers.delete(key);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.abortControllers.delete(key);
            this.metrics.recordFailure();

            // retry with exponential backoff + jitter
            const state = this.retries.get(key) ?? { count: 0, delayMs: this.baseBackoffMs };
            if (state.count < this.maxRetries) {
                state.count += 1;
                state.delayMs = Math.min(state.delayMs * 2, 5000) + Math.random() * 200;
                this.retries.set(key, state);
                setTimeout(() => {
                    this.queue.push(key, chunk, 500);
                    this.drainQueue();
                }, state.delayMs);
            } else {
                this.emit('streamingError', { chunk, error: msg, retryable: false });
                this.retries.delete(key);
            }
        }
    }
}
