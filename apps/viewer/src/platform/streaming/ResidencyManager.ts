import { BoundedLru } from './BoundedLru';
import type { CacheEntry, ResidencyStatus } from './types';

/**
 * Tracks the residency lifecycle of every chunk the host has seen:
 *
 *   absent → cached → decoding → resident
 *                                  ↘ evicted
 *
 * The ResidencyManager owns a single BoundedLru for the CPU cache and
 * exposes helper queries the streaming scheduler needs for prioritization
 * ("is chunk X already resident?", "how many high-LOD bytes are resident?",
 *  "evict everything except the current view").
 */
export class ResidencyManager {
    private readonly cache: BoundedLru;
    private readonly statuses = new Map<string, ResidencyStatus>();

    /** How many chunks are currently GPU-resident. */
    private gpuResidentCount = 0;
    /** Approximate GPU bytes (decoded sizes summed). */
    private gpuResidentBytes = 0;

    /**
     * @param cacheCapacityBytes - Maximum total decoded bytes in the LRU.
     */
    constructor(cacheCapacityBytes: number) {
        this.cache = new BoundedLru(cacheCapacityBytes);
    }

    // -- queries -------------------------------------------------------------

    /** Status of a chunk (absent if never seen). */
    getStatus(key: string): ResidencyStatus {
        return this.statuses.get(key) ?? 'absent';
    }

    /** Whether the chunk is in the CPU cache (decoded bytes present). */
    isCached(key: string): boolean {
        return this.cache.has(key);
    }

    /** Whether the chunk is considered GPU-resident (rendered). */
    isGpuResident(key: string): boolean {
        return this.statuses.get(key) === 'resident';
    }

    get gpuResident(): number {
        return this.gpuResidentCount;
    }

    get gpuMemoryBytes(): number {
        return this.gpuResidentBytes;
    }

    /** Total bytes currently held in the CPU LRU. */
    get cpuCacheBytes(): number {
        return this.cache.size;
    }

    /** Number of entries in the CPU LRU. */
    get cpuCacheCount(): number {
        return this.cache.count;
    }

    // -- mutations -----------------------------------------------------------

    /** A chunk's bytes arrived from the network; store in the CPU cache. */
    markCached(entry: CacheEntry): void {
        this.cache.set(entry);
        this.statuses.set(entry.key, 'cached');
    }

    /** The chunk is currently being decoded (GPU upload pending). */
    markDecoding(key: string): void {
        this.statuses.set(key, 'decoding');
    }

    /** The chunk has been uploaded to GPU and is now rendered. */
    markResident(key: string): void {
        const entry = this.cache.get(key);
        if (entry) {
            this.gpuResidentCount += 1;
            this.gpuResidentBytes += entry.decodedBytes;
        }
        this.statuses.set(key, 'resident');
    }

    /** The chunk is no longer rendered (e.g. moved off-screen). */
    markEvicted(key: string): void {
        const entry = this.cache.get(key);
        if (entry) {
            this.gpuResidentCount = Math.max(0, this.gpuResidentCount - 1);
            this.gpuResidentBytes = Math.max(0, this.gpuResidentBytes - entry.decodedBytes);
        }
        this.cache.delete(key);
        this.statuses.delete(key);
    }

    /** Evict high-LOD entries until the budget is met, returning their keys. */
    evictHighLod(): string[] {
        const evicted = this.cache.evict(1);
        for (const e of evicted) {
            this.gpuResidentCount = Math.max(0, this.gpuResidentCount - 1);
            this.gpuResidentBytes = Math.max(0, this.gpuResidentBytes - e.decodedBytes);
            this.statuses.delete(e.key);
        }
        return evicted.map(e => e.key);
    }

    /** Full reset (scene change). */
    reset(): void {
        this.cache.clear();
        this.statuses.clear();
        this.gpuResidentCount = 0;
        this.gpuResidentBytes = 0;
    }
}
