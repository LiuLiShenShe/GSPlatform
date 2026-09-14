import type { CacheEntry } from './types';

/**
 * Bounded LRU cache for decoded splat chunk data.
 *
 * Implements a strict capacity bound over total *decoded* bytes (GPU memory
 * estimate), not just entry count, so that a burst of high-LOD chunks cannot
 * grow the JS heap or GPU resources without limit (Phase 04 checklist E).
 *
 * Eviction strategy: least-recently-accessed first. On memory pressure the
 * streaming subsystem prefers to evict high-LOD (higher index) entries first,
 * keeping low LOD interactive; this is controlled by passing a `priorityRank`
 * on access (see {@link record}).
 */
export class BoundedLru {
    private readonly maxBytes: number;
    private readonly map = new Map<string, CacheEntry>();
    private totalBytes = 0;

    /**
     * @param maxBytes - Hard cap on total decoded bytes stored.
     */
    constructor(maxBytes: number) {
        this.maxBytes = maxBytes;
    }

    /** Current total decoded bytes stored. */
    get size(): number {
        return this.totalBytes;
    }

    /** Number of entries currently stored. */
    get count(): number {
        return this.map.size;
    }

    /** Capacity of the cache in bytes. */
    get capacity(): number {
        return this.maxBytes;
    }

    /**
     * Look up an entry by key, marking it most-recently-used.
     * Returns undefined if the key is absent.
     */
    get(key: string): CacheEntry | undefined {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        entry.lastAccess = Date.now();
        // delete + set to move it to the tail (most-recently-used)
        this.map.delete(key);
        this.map.set(key, entry);
        return entry;
    }

    /**
     * Check whether a key exists without altering recency order.
     */
    has(key: string): boolean {
        return this.map.has(key);
    }

    /**
     * Insert or update an entry. Evicts least-recently-used entries until the
     * total size fits within `maxBytes`. If a single entry is larger than the
     * capacity it is still stored (can't refuse a legitimately-big chunk), but
     * it immediately becomes the sole entry.
     */
    set(entry: CacheEntry): void {
        const existing = this.map.get(entry.key);
        if (existing) {
            this.totalBytes -= existing.decodedBytes;
            this.map.delete(entry.key);
        }
        entry.lastAccess = Date.now();
        this.map.set(entry.key, entry);
        this.totalBytes += entry.decodedBytes;
        this.evict();
    }

    /**
     * Remove a specific entry, returning true if it was present.
     */
    delete(key: string): boolean {
        const entry = this.map.get(key);
        if (!entry) return false;
        this.totalBytes -= entry.decodedBytes;
        this.map.delete(key);
        return true;
    }

    /**
     * Remove all entries.
     */
    clear(): void {
        this.map.clear();
        this.totalBytes = 0;
    }

    /**
     * Evict entries until total bytes fit within capacity. Entries whose
     * `lod` is >= `highLodThreshold` (default 1) are preferred for eviction,
     * keeping the low LOD interactive under memory pressure (checklist E).
     */
    evict(highLodThreshold = 1): CacheEntry[] {
        const evicted: CacheEntry[] = [];
        while (this.totalBytes > this.maxBytes && this.map.size > 0) {
            // find least-recently-used entry, preferring high LOD
            let victim: CacheEntry | null = null;
            let victimLastAccess = Number.POSITIVE_INFINITY;
            let fallbackLastAccess = Number.POSITIVE_INFINITY;
            let fallback: CacheEntry | null = null;
            for (const entry of this.map.values()) {
                if (entry.lastAccess < victimLastAccess) {
                    victimLastAccess = entry.lastAccess;
                    victim = entry;
                }
                if (entry.lod >= highLodThreshold && entry.lastAccess < fallbackLastAccess) {
                    fallbackLastAccess = entry.lastAccess;
                    fallback = entry;
                }
            }
            const chosen = (victim && victim.lod >= highLodThreshold) ?
                victim :
                (fallback ?? victim);
            if (!chosen) break;
            this.map.delete(chosen.key);
            this.totalBytes -= chosen.decodedBytes;
            evicted.push(chosen);
        }
        return evicted;
    }

    /**
     * The keys currently held, oldest-first (recency order).
     */
    keys(): string[] {
        return [...this.map.keys()];
    }
}
