import type { StreamingMetricsSnapshot } from './types';

/**
 * Rolling counters for streamed SOG loading, sampled by the performance panel
 * and the stability harness. All values are monotonic counters except the
 * derived ratios/rates, which are computed on snapshot.
 */
export class StreamingMetrics {
    private bytesFetched = 0;
    private bytesDecoded = 0;
    private chunksCompleted = 0;
    private chunksFailed = 0;
    private chunksCancelled = 0;
    private cacheHits = 0;
    private cacheMisses = 0;

    /** Timestamps of completed chunk fetches for throughput estimation. */
    private readonly fetchTimes: Array<{ at: number; bytes: number }> = [];

    /** Number of chunks currently resident in GPU memory (tracked externally). */
    private gpuResident = 0;
    private gpuMemoryBytes = 0;
    private readonly throughputWindowMs: number;

    constructor(throughputWindowMs = 10_000) {
        this.throughputWindowMs = throughputWindowMs;
    }

    /** Record a chunk that was served from the network. */
    recordFetch(bytes: number, _durationMs: number): void {
        this.bytesFetched += bytes;
        this.chunksCompleted += 1;
        this.fetchTimes.push({ at: Date.now(), bytes });
        // keep only the window
        const cutoff = Date.now() - this.throughputWindowMs;
        while (this.fetchTimes.length > 0 && this.fetchTimes[0].at < cutoff) {
            this.fetchTimes.shift();
        }
    }

    /** Record a cache hit (returned without network). */
    recordCacheHit(): void {
        this.cacheHits += 1;
    }

    /** Record a cache miss (chunk not yet resident). */
    recordCacheMiss(): void {
        this.cacheMisses += 1;
    }

    /** Record a chunk that failed to fetch/decode. */
    recordFailure(): void {
        this.chunksFailed += 1;
    }

    /** Record a chunk removed from the in-flight queue (LOD switch). */
    recordCancellation(): void {
        this.chunksCancelled += 1;
    }

    /** Record decoded bytes for GPU memory accounting. */
    recordDecode(bytes: number): void {
        this.bytesDecoded += bytes;
    }

    /** Track GPU residency (caller adds/removes resident chunks). */
    setGpuResident(count: number, bytes: number): void {
        this.gpuResident = count;
        this.gpuMemoryBytes = bytes;
    }

    /** Current throughput estimate (bytes/sec) over the rolling window. */
    get throughput(): number {
        const now = Date.now();
        const windowStart = Math.max(0, now - this.throughputWindowMs);
        let bytes = 0;
        for (const t of this.fetchTimes) {
            if (t.at >= windowStart) bytes += t.bytes;
        }
        const span = now - windowStart;
        return span > 0 ? (bytes / span) * 1000 : 0;
    }

    /** Cache hit ratio over the session. */
    get cacheHitRatio(): number {
        const total = this.cacheHits + this.cacheMisses;
        return total > 0 ? this.cacheHits / total : 0;
    }

    /** Take a point-in-time snapshot for the performance panel. */
    snapshot(): StreamingMetricsSnapshot {
        return {
            bytesFetched: this.bytesFetched,
            bytesDecoded: this.bytesDecoded,
            chunksCompleted: this.chunksCompleted,
            chunksFailed: this.chunksFailed,
            chunksCancelled: this.chunksCancelled,
            throughput: this.throughput,
            cacheHitRatio: this.cacheHitRatio,
            gpuResident: this.gpuResident,
            gpuMemoryBytes: this.gpuMemoryBytes
        };
    }

    /** Reset all counters (e.g. on scene change or session restart). */
    reset(): void {
        this.bytesFetched = 0;
        this.bytesDecoded = 0;
        this.chunksCompleted = 0;
        this.chunksFailed = 0;
        this.chunksCancelled = 0;
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.fetchTimes.length = 0;
        this.gpuResident = 0;
        this.gpuMemoryBytes = 0;
    }
}
