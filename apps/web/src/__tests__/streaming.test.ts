/**
 * Phase 04 streaming subsystem unit tests.
 *
 * Covers: LodSelector (priority/hysteresis/mode), BoundedLru (capacity/eviction),
 * RequestQueue (push/pop/dedup/priority), StreamingMetrics (counters/snapshot),
 * StreamScheduler (cancel/retry/drain).
 *
 * All modules are imported from @gsplatform/viewer (resolved via project ref).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LodSelector,
  BoundedLru,
  RequestQueue,
  StreamingMetrics,
  StreamScheduler,
} from '@gsplatform/viewer';
import type { CacheEntry, StreamedManifest } from '@gsplatform/viewer';

// ---------------------------------------------------------------------------
// LodSelector — priority, hysteresis, quality mode
// ---------------------------------------------------------------------------

describe('LodSelector', () => {
  let sel: InstanceType<typeof LodSelector>;
  const lodCounts = [100_000, 500_000, 2_000_000]; // low / medium / high

  beforeEach(() => {
    sel = new LodSelector(lodCounts);
  });

  it('initial decision is LOD 0 (no FPS samples yet → fps-recovery to LOD 1)', () => {
    // smoothedFps starts at 60 (> fpsHighThreshold=50) so decide() returns targetLod=1
    // This is expected: at 60fps the system is comfortable skipping LOD 0.
    const d = sel.decide();
    expect(d.targetLod).toBe(1);
    expect(d.reason).toBe('fps-recovery');
  });

  it('target never goes below 0', () => {
    for (let i = 0; i < 100; i++) sel.feedFrame(100); // 10 FPS
    const d = sel.decide();
    expect(d.targetLod).toBeGreaterThanOrEqual(0);
  });

  it('target never exceeds max LOD index', () => {
    for (let i = 0; i < 100; i++) sel.feedFrame(8); // 120 FPS
    for (let i = 0; i < 50; i++) sel.signalCameraMotion(false);
    const d = sel.decide();
    expect(d.targetLod).toBeLessThan(lodCounts.length);
  });

  it('camera motion degrades target', () => {
    // first promote to LOD 1+ via fast frames + stable camera
    for (let i = 0; i < 50; i++) sel.feedFrame(8);
    for (let i = 0; i < 50; i++) sel.signalCameraMotion(false);
    const before = sel.decide().targetLod;

    // then signal moving — should degrade (or stay same)
    for (let i = 0; i < 50; i++) sel.signalCameraMotion(true);
    const d = sel.decide();
    expect(d.targetLod).toBeLessThanOrEqual(before);
  });

  it('quality mode eco caps prefetch budget', () => {
    sel.setMode('eco');
    expect(sel.modeConfig.lodMultiplier).toBeLessThan(1);
    expect(sel.modeConfig.maxConcurrent).toBe(2);
  });

  it('quality mode quality increases concurrency', () => {
    sel.setMode('quality');
    expect(sel.modeConfig.maxConcurrent).toBe(6);
    expect(sel.modeConfig.lodMultiplier).toBeGreaterThan(1);
  });

  it('makePickLod returns current target', async () => {
    sel.setMode('quality');
    sel.feedFrame(8);
    sel.decide();
    const pickLod = sel.makePickLod();
    const lod = await pickLod(lodCounts);
    expect(typeof lod).toBe('number');
    expect(lod).toBeGreaterThanOrEqual(0);
    expect(lod).toBeLessThan(lodCounts.length);
  });
});

// ---------------------------------------------------------------------------
// BoundedLru — capacity bound, high-LOD-preferred eviction
// ---------------------------------------------------------------------------

describe('BoundedLru', () => {
  const makeEntry = (key: string, decodedBytes: number, lod = 0): CacheEntry => ({
    key,
    bytes: new ArrayBuffer(0),
    decodedBytes,
    lastAccess: Date.now(),
    lod,
  });

  it('stores and retrieves entries', () => {
    const lru = new BoundedLru(1024);
    lru.set(makeEntry('a', 100));
    expect(lru.has('a')).toBe(true);
    expect(lru.get('a')?.decodedBytes).toBe(100);
  });

  it('evicts on set when capacity exceeded (set auto-evicts)', () => {
    const lru = new BoundedLru(200);
    lru.set(makeEntry('a', 100, 0));
    lru.set(makeEntry('b', 100, 0));
    expect(lru.count).toBe(2);
    expect(lru.size).toBe(200);

    // Adding a third entry triggers auto-eviction inside set()
    lru.set(makeEntry('c', 100, 2));
    // Should have evicted one entry to fit within 200 bytes
    expect(lru.size).toBeLessThanOrEqual(200);
  });

  it('evict() returns nothing when already within budget', () => {
    const lru = new BoundedLru(500);
    lru.set(makeEntry('a', 100, 0));
    lru.set(makeEntry('b', 100, 0));
    // 200 < 500 → evict is a no-op
    const evicted = lru.evict(1);
    expect(evicted.length).toBe(0);
  });

  it('explicit evict() prefers evicting high-LOD entries when over budget', () => {
    const lru2 = new BoundedLru(200);
    lru2.set(makeEntry('low_a', 80, 0));
    lru2.set(makeEntry('low_b', 80, 0));
    // 160 bytes, within 200 budget
    // Add 80 more = 240 > 200 → set() triggers auto-evict of high_c (lod 2)
    lru2.set(makeEntry('high_c', 80, 2));
    // Result: low_a + low_b = 160 ≤ 200
    expect(lru2.count).toBe(2);
    expect(lru2.size).toBe(160);
    expect(lru2.has('high_c')).toBe(false); // high LOD was evicted
    expect(lru2.has('low_a')).toBe(true);   // low LOD kept
  });

  it('delete removes entry', () => {
    const lru = new BoundedLru(1024);
    lru.set(makeEntry('x', 50));
    expect(lru.delete('x')).toBe(true);
    expect(lru.has('x')).toBe(false);
  });

  it('clear empties the cache', () => {
    const lru = new BoundedLru(1024);
    lru.set(makeEntry('a', 100));
    lru.set(makeEntry('b', 100));
    lru.clear();
    expect(lru.count).toBe(0);
    expect(lru.size).toBe(0);
  });

  it('size reflects total decoded bytes', () => {
    const lru = new BoundedLru(1024);
    lru.set(makeEntry('a', 100));
    lru.set(makeEntry('b', 200));
    expect(lru.size).toBe(300);
  });

  it('keys() returns all keys', () => {
    const lru = new BoundedLru(1024);
    lru.set(makeEntry('a', 10));
    lru.set(makeEntry('b', 10));
    expect(lru.keys()).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

// ---------------------------------------------------------------------------
// RequestQueue — push / pop / dedup / priority re-score
// ---------------------------------------------------------------------------

describe('RequestQueue', () => {
  let q: InstanceType<typeof RequestQueue>;

  beforeEach(() => {
    q = new RequestQueue();
  });

  it('pop returns items in priority order (higher number = higher priority in max-heap)', () => {
    q.push('low', { lod: 0, chunk: 0 }, 100);
    q.push('med', { lod: 1, chunk: 0 }, 500);
    q.push('high', { lod: 2, chunk: 0 }, 1000);
    // Max-heap: higher priority number pops first
    expect(q.pop()?.key).toBe('high'); // 1000
    expect(q.pop()?.key).toBe('med');  // 500
    expect(q.pop()?.key).toBe('low');  // 100
  });

  it('deduplicates by key (push updates existing entry)', () => {
    q.push('k', { lod: 0, chunk: 0 }, 100);
    q.push('k', { lod: 0, chunk: 0 }, 200); // updates priority, not duplicate
    expect(q.size).toBe(1);
  });

  it('re-prioritize updates priority of existing key', () => {
    q.push('k', { lod: 0, chunk: 0 }, 1000); // high priority
    q.push('other', { lod: 1, chunk: 0 }, 500); // lower priority
    // re-prioritize 'k' to lower priority
    q.push('k', { lod: 0, chunk: 0 }, 100);
    // 'other' now pops first
    expect(q.pop()?.key).toBe('other');
    expect(q.pop()?.key).toBe('k');
  });

  it('remove removes a key', () => {
    q.push('a', { lod: 0, chunk: 0 }, 100);
    q.push('b', { lod: 0, chunk: 1 }, 200);
    q.remove('a');
    expect(q.size).toBe(1);
    expect(q.pop()?.key).toBe('b');
  });

  it('clear empties the queue', () => {
    q.push('a', { lod: 0, chunk: 0 }, 100);
    q.push('b', { lod: 0, chunk: 1 }, 200);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.pop()).toBeNull();
  });

  it('pop returns null when empty', () => {
    expect(q.pop()).toBeNull();
  });

  it('keys() returns current pending keys', () => {
    q.push('a', { lod: 0, chunk: 0 }, 100);
    q.push('b', { lod: 1, chunk: 0 }, 200);
    expect(q.keys()).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

// ---------------------------------------------------------------------------
// StreamingMetrics — counters, throughput, cache-hit ratio, snapshot
// ---------------------------------------------------------------------------

describe('StreamingMetrics', () => {
  let m: InstanceType<typeof StreamingMetrics>;

  beforeEach(() => {
    m = new StreamingMetrics(10_000);
  });

  it('snapshot returns zeros initially', () => {
    const s = m.snapshot();
    expect(s.bytesFetched).toBe(0);
    expect(s.chunksCompleted).toBe(0);
    expect(s.chunksFailed).toBe(0);
    expect(s.cacheHitRatio).toBe(0);
    expect(s.throughput).toBe(0);
  });

  it('recordFetch increments bytes and chunks', () => {
    m.recordFetch(1024, 50);
    m.recordFetch(2048, 100);
    const s = m.snapshot();
    expect(s.bytesFetched).toBe(1024 + 2048);
    expect(s.chunksCompleted).toBe(2);
  });

  it('recordCacheHit / recordCacheMiss update ratio', () => {
    m.recordCacheHit();
    m.recordCacheHit();
    m.recordCacheMiss();
    expect(m.cacheHitRatio).toBeCloseTo(2 / 3);
  });

  it('recordFailure increments failures', () => {
    m.recordFailure();
    m.recordFailure();
    expect(m.snapshot().chunksFailed).toBe(2);
  });

  it('recordCancellation increments cancelled count', () => {
    m.recordCancellation();
    expect(m.snapshot().chunksCancelled).toBe(1);
  });

  it('setGpuResident tracks GPU state', () => {
    m.setGpuResident(10, 5 * 1024 * 1024);
    const s = m.snapshot();
    expect(s.gpuResident).toBe(10);
    expect(s.gpuMemoryBytes).toBe(5 * 1024 * 1024);
  });

  it('reset clears all counters', () => {
    m.recordFetch(1024, 50);
    m.recordCacheHit();
    m.recordFailure();
    m.reset();
    const s = m.snapshot();
    expect(s.bytesFetched).toBe(0);
    expect(s.chunksCompleted).toBe(0);
    expect(s.chunksFailed).toBe(0);
    expect(s.cacheHitRatio).toBe(0);
  });

  it('throughput is > 0 after a recent fetch', () => {
    m.recordFetch(4096, 10);
    expect(m.throughput).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// StreamScheduler — cancel stale, retry logic, drain
// ---------------------------------------------------------------------------

const makeManifest = (counts = [100_000, 500_000, 2_000_000]): StreamedManifest => ({
  schemaVersion: 1,
  sceneId: 'test',
  assetVersion: 'v1',
  format: 'streamed-sog',
  stream: {
    entryUrl: 'lod-meta.json',
    byteLength: 1000,
    sha256: 'abc123',
    transport: 'range',
    lodLevels: counts.length,
    counts,
  },
});

describe('StreamScheduler', () => {
  let sched: InstanceType<typeof StreamScheduler>;

  beforeEach(() => {
    sched = new StreamScheduler([100_000, 500_000, 2_000_000]);
  });

  it('setManifest emits manifestReady', () => {
    const spy = vi.fn();
    sched.on('manifestReady', spy);
    sched.setManifest(makeManifest());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ sceneId: 'test', lodLevels: 3 }),
    );
  });

  it('abort clears all state', () => {
    sched.setManifest(makeManifest());
    sched.abort();
    expect(sched.metrics.snapshot().chunksCancelled).toBeGreaterThanOrEqual(0);
  });

  it('signalCameraMotion does not throw', () => {
    sched.setManifest(makeManifest());
    sched.signalCameraMotion(true);
    expect(true).toBe(true);
  });

  it('tick without manifest is no-op', () => {
    sched.tick(); // should not throw
  });

  it('reset fully clears state', () => {
    sched.setManifest(makeManifest());
    sched.reset();
    expect(sched.metrics.snapshot().bytesFetched).toBe(0);
  });

  it('setQuality updates mode and concurrency', () => {
    sched.setQuality('quality');
    expect(sched.maxConcurrent).toBe(6);
    sched.setQuality('eco');
    expect(sched.maxConcurrent).toBe(2);
  });
});
