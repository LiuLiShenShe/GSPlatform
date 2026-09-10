import type { LODAssetRef, LODLevel, LoadPhase } from './LoadEvents';

/**
 * ProgressAggregator — converts real load events into a monotonic 0..100
 * percentage using documented per-stage weights.
 *
 * The weights come from the Phase 03 spec. Each weight segment can only
 * advance when its corresponding REAL event fires:
 *
 *   manifest + poster readiness     0% ->  5%   (manifestReady)
 *   low fetch                       5% -> 30%   (fetch bytes / total)
 *   low decode + apply             30% -> 42%   (decoded, applied)
 *   first low frame                42% -> 45%   (firstFrame)
 *   medium fetch/decode/apply      45% -> 70%   (regular settle)
 *   high fetch                     70% -> 92%   (fetch bytes / total)
 *   high decode/apply/first frame  92% -> 100%  (decoded, applied, firstFrame)
 *
 * - When Content-Length is unknown the fetch segments emit `percent: null`
 *   (indeterminate) instead of fabricating an exact number.
 * - `getPhase()` maps the current point to the highest reached phase, which
 *   is what the UI uses as its stage label.
 * - The aggregate is monotonic: `advance` never lowers the reported value.
 */
export class ProgressAggregator {
    /** 0..100 value of the currently reported aggregate. */
    private _percent: number | null = null;
    private _indeterminate = false;
    private _phase: LoadPhase = 'PREPARING';

    // Current fetch bookkeeping (bytes based on Content-Length when known).
    private _fetchingLod: LODLevel | null = null;
    private _fetchTotal: number | null = null;
    private _fetchLoaded = 0;
    // Completion markers per LOD (a LOD is fully settled only after firstFrame).
    private readonly _settled = new Set<LODLevel>();
    private _lowInteractive = false;

    // ---- public API -----------------------------------------------------

    get percent(): number | null {
        return this._indeterminate ? null : this._percent;
    }

    get phase(): LoadPhase {
        return this._phase;
    }

    get loadedBytes(): number {
        return this._fetchLoaded;
    }

    get totalBytes(): number | null {
        return this._fetchTotal;
    }

    get indeterminate(): boolean {
        return this._indeterminate;
    }

    /** Manifest fetched & validated; poster readied (5%). */
    manifestReady(): void {
        this.settle('manifest');
    }

    /** The given LOD's read phase has started. */
    fetchStart(lod: LODLevel, totalBytes: number | null): void {
        this._fetchingLod = lod;
        this._fetchTotal = totalBytes ?? null;
        this._fetchLoaded = 0;
        // Without Content-Length we cannot prove a percentage; mark the whole
        // session indeterminate until that LOD is fetched.
        this._indeterminate = totalBytes == null;
        this.updatePhase();
    }

    /** Bytes read so far for the LOD currently being fetched. */
    fetchProgress(lod: LODLevel, loadedBytes: number, observedTotal?: number | null): void {
        this._fetchLoaded = loadedBytes;
        // The real response's Content-Length (observedTotal) supersedes the
        // placeholder total from fetchStart. A null/undefined observed total
        // means the response had no Content-Length: stay indeterminate rather
        // than fabricating a percentage from manifest-side metadata.
        if (observedTotal != null && observedTotal > 0) {
            this._fetchTotal = observedTotal;
            this._indeterminate = false;
        }
        if (this._indeterminate || this._fetchTotal == null) {
            this.updatePhase();
            return;
        }
        // Only the currently-fetching LOD's segment is driven this way.
        const { start, end } = this.fetchSegment(lod);
        const ratio = Math.min(loadedBytes / this._fetchTotal, 1);
        // When the ratio is 1 the fetch is done; the decode/apply events take it further.
        this._percent = this.clamp(start + (end - start) * Math.min(ratio, 0.999));
        this.updatePhase();
    }

    /** A LOD finished its read phase (bytes fully fetched). */
    fetchComplete(lod: LODLevel): void {
        if (this._fetchingLod === lod) {
            this._fetchingLod = null;
            this._fetchTotal = null;
            this._fetchLoaded = 0;
        }
        this._indeterminate = false;
        this.updatePhase();
    }

    /** The viewer finished decoding the LOD payload. */
    decoded(lod: LODLevel): void {
        const { start, end } = this.decodeSegment(lod);
        this._percent = this.clamp(start + (end - start) * 0.5);
        this.updatePhase();
    }

    /** The LOD was atomically applied to the renderer. */
    applied(lod: LODLevel): void {
        if (lod === 'low') {
            this._lowInteractive = true;
        }
        const { end } = this.decodeSegment(lod);
        this._percent = this.clamp(end);
        this.updatePhase();
    }

    /** The first frame containing this LOD was actually presented. */
    firstFrame(lod: LODLevel): void {
        // The segment that the first frame unlocks depends on how far along
        // the pipeline has already advanced.
        this._settled.add(lod);
        if (lod === 'low') {
            this._percent = this.clamp(45);
            this._lowInteractive = true;
        }
        // medium/high firstFrame moves the tail of the fetch/decode segment.
        if (lod === 'medium') {
            this._percent = this.clamp(70);
        }
        if (lod === 'high') {
            this._percent = this.clamp(100);
        }
        this.updatePhase();
    }

    /** Error or cancel — the aggregate freezes; UI shows error/retry separately. */
    fail(): void {
        this._indeterminate = false;
        this.updatePhase();
    }

    /** Reset for a fresh load session. */
    reset(): void {
        this._percent = null;
        this._indeterminate = false;
        this._phase = 'PREPARING';
        this._fetchingLod = null;
        this._fetchTotal = null;
        this._fetchLoaded = 0;
        this._settled.clear();
        this._lowInteractive = false;
    }

    // ---- internals ------------------------------------------------------

    private clamp(v: number): number {
        const prev = this._percent ?? 0;
        return Math.max(prev, Math.min(100, v));
    }

    private settle(kind: 'manifest'): void {
        if (kind === 'manifest') {
            this._indeterminate = false;
            this._percent = this.clamp(5);
            this.updatePhase();
        }
    }

    /** Fetch segment weights [start, end). */
    private fetchSegment(lod: LODLevel): { start: number; end: number } {
        switch (lod) {
            case 'low': return { start: 5, end: 30 };
            case 'medium': return { start: 45, end: 55 };
            case 'high': return { start: 70, end: 92 };
        }
    }

    /** Decode+apply segment start; applied() settles at `end`. */
    private decodeSegment(lod: LODLevel): { start: number; end: number } {
        switch (lod) {
            case 'low': return { start: 30, end: 42 };
            case 'medium': return { start: 55, end: 70 };
            case 'high': return { start: 92, end: 97 };
        }
    }

    /**
     * The highest phase we can rationally claim given the events observed.
     * Follows the exact order of the Phase 03 state diagram; a phase is only
     * reportable once its driving events have fired.
     */
    private updatePhase(): void {
        if (this._settled.has('high')) {
            this._phase = 'READY';
        } else if (this._settled.has('medium')) {
            this._phase = 'STREAMING_HIGH';
        } else if (this._lowInteractive || this._settled.has('low')) {
            this._phase = 'INTERACTIVE_LOW';
        } else if (this._percent != null && this._percent >= 30) {
            this._phase = 'DECODING_LOW';
        } else {
            this._phase = 'FETCHING_LOW';
        }
    }

    /** Convenience: describe what a manifest's LOD list offers (unused directly). */
    static validateLods(lods: LODAssetRef[]): LODAssetRef[] {
        return lods.filter(l => l.assetUrl && typeof l.gaussians === 'number');
    }
}
