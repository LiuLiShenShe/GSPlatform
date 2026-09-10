import type { LODAssetRef, LODLevel } from './LoadEvents';

export interface LodSwitchDecision {
    /** The LOD that should be active on screen next. */
    next: LODLevel | null;
    /** True if an in-flight higher LOD failed and we are keeping the best one we have. */
    degraded: boolean;
}

/**
 * LodSwitcher — decides, per failure/cancel point, which LOD should remain
 * active. The rule enforced here matches the Phase 03 spec:
 *
 *   - the best settled LOD is always kept;
 *   - a failing higher LOD must never tear down an already-interactive lower
 *     LOD;
 *   - when medium/high fails the session simply stops upgrading (degraded),
 *     the last settled LOD stays on screen and a retry can resume from it.
 */
export class LodSwitcher {
    private readonly settled = new Set<LODLevel>();
    readonly lods: LODAssetRef[];

    constructor(lods: LODAssetRef[]) {
        this.lods = lods;
        for (const lod of this.lods) {
            if (lod.level === 'low') {
                this.settled.add('low');
            }
        }
    }

    /**
     * The currently-settled LOD level (the one guaranteed to be interactive).
     * Starts at 'low'; moves up only when a higher LOD settles.
     */
    get currentLevel(): LODLevel | null {
        const order: LODLevel[] = ['low', 'medium', 'high'];
        let best: LODLevel | null = null;
        for (const level of order) {
            if (this.settled.has(level)) {
                best = level;
            }
        }
        return best;
    }

    /** Mark a LOD as fully settled (applied + first frame). */
    settle(level: LODLevel): void {
        this.settled.add(level);
    }

    /**
     * Decide what happens after a LOD failed to load/apply.
     * Returns the level to keep active. Retry resumes from the same level.
     */
    onFailure(failedLevel: LODLevel): LodSwitchDecision {
        // keep the best settled level; failure of a higher tier just means we
        // stop upgrading.
        const keep = this.currentLevel;
        return {
            next: keep,
            degraded: keep !== null && orderOf(keep) < orderOf(failedLevel)
        };
    }

    /** Whether we can still attempt a higher LOD than the given one. */
    hasHigher(than: LODLevel | null): boolean {
        if (than == null) {
            return this.lods.length > 0;
        }
        return orderOf(than) < orderOf('high');
    }
}

function orderOf(level: LODLevel): number {
    switch (level) {
        case 'low': return 0;
        case 'medium': return 1;
        case 'high': return 2;
    }
}
