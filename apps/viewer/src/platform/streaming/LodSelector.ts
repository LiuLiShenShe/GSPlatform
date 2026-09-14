import type { LodDecision, QualityMode, QualityModeConfig } from './types';

/** Default quality-mode configurations. */
const MODE_PRESETS: Record<QualityMode, QualityModeConfig> = {
    eco: {
        lodMultiplier: 0.5,
        maxConcurrent: 2,
        prefetchBudget: 2 * 1024 * 1024,
        allowEviction: true
    },
    balanced: {
        lodMultiplier: 1,
        maxConcurrent: 4,
        prefetchBudget: 8 * 1024 * 1024,
        allowEviction: true
    },
    quality: {
        lodMultiplier: 1.5,
        maxConcurrent: 6,
        prefetchBudget: 16 * 1024 * 1024,
        allowEviction: false
    }
};

/**
 * Decides which LOD level to request based on:
 *   - current FPS and frame time (dynamic quality)
 *   - quality mode chosen by the user (eco / balanced / quality)
 *   - camera motion (hysteresis: moving → degrade, stable → upgrade)
 *   - memory budget
 *
 * The selector maintains internal hysteresis state so that small
 * oscillations in FPS or camera speed don't cause rapid up/down switching.
 */
export class LodSelector {
    private readonly lodCounts: number[];
    private currentTarget = 0;
    private currentMode: QualityMode = 'balanced';

    /** FPS / frame-time smoothing state (exponential moving average). */
    private smoothedFps = 60;
    private smoothedFrameTimeMs = 16.7;
    private readonly emaFactor = 0.1;

    /** Hysteresis state for motion-based switching. */
    private cameraStableMs = 0;
    private readonly cameraStableThresholdMs = 500;
    private cameraMovingMs = 0;
    private readonly cameraMovingThresholdMs = 200;

    /** Low-FPS / high-FPS thresholds for switching (low = downgrade, high = upgrade). */
    private readonly fpsLowThreshold = 30;
    private readonly fpsHighThreshold = 50;

    /**
     * @param lodCounts - Upstream counts per LOD level, length = lodLevels.
     */
    constructor(lodCounts: number[]) {
        this.lodCounts = lodCounts;
    }

    /** Current quality mode preset. */
    get modeConfig(): QualityModeConfig {
        return MODE_PRESETS[this.currentMode];
    }

    /** Current target LOD index. */
    get targetLod(): number {
        return this.currentTarget;
    }

    /**
     * Feed a new frame-time sample. Call once per frame (or at a sample
     * rate) to keep the EMA up to date.
     */
    feedFrame(frameTimeMs: number): void {
        this.smoothedFrameTimeMs =
            this.smoothedFrameTimeMs * (1 - this.emaFactor) + frameTimeMs * this.emaFactor;
        this.smoothedFps = this.smoothedFrameTimeMs > 0 ? 1000 / this.smoothedFps : 60;
    }

    /**
     * Signal that the camera started or stopped moving.
     * `moving` = true when the user is actively orbiting/panning/zooming.
     */
    signalCameraMotion(moving: boolean): void {
        if (moving) {
            this.cameraStableMs = 0;
            this.cameraMovingMs += 16; // approx one frame
        } else {
            this.cameraMovingMs = 0;
            this.cameraStableMs += 16;
        }
    }

    /**
     * Switch quality mode.
     */
    setMode(mode: QualityMode): void {
        this.currentMode = mode;
    }

    /**
     * Decide the next LOD target and explain why.
     * Call this every frame (or every N frames) after updating FPS and
     * camera state.
     */
    decide(): LodDecision {
        const lodLevels = this.lodCounts.length;
        if (lodLevels === 0) {
            return { targetLod: 0, maxFetchableLod: 0, reason: 'initial' };
        }

        const maxLod = lodLevels - 1;

        // -- memory-pressure based downgrade --
        // (caller can inject this via override; for now just honour the mode)
        const config = this.modeConfig;

        // -- motion-based switching with hysteresis --
        const isMoving = this.cameraMovingMs > this.cameraMovingThresholdMs;
        const isStable = this.cameraStableMs > this.cameraStableThresholdMs;

        // -- FPS-based dynamic target --
        let fpsTarget = this.currentTarget;

        if (this.smoothedFps < this.fpsLowThreshold) {
            fpsTarget = Math.max(0, fpsTarget - 1);
        } else if (this.smoothedFps > this.fpsHighThreshold) {
            fpsTarget = Math.min(maxLod, fpsTarget + 1);
        }

        // -- camera motion: degrade while moving, upgrade when stable --
        let reason: LodDecision['reason'] = 'initial';
        let target = fpsTarget;

        if (isMoving && target > 0) {
            target = Math.max(0, target - 1);
            reason = 'camera-moving';
        } else if (isStable && target < maxLod && this.smoothedFps >= this.fpsHighThreshold) {
            target = Math.min(maxLod, target + 1);
            reason = 'camera-stable';
        } else if (this.smoothedFps < this.fpsLowThreshold) {
            target = Math.max(0, fpsTarget);
            reason = 'fps-drop';
        } else if (this.smoothedFps > this.fpsHighThreshold) {
            target = Math.min(maxLod, fpsTarget);
            reason = 'fps-recovery';
        }

        // apply quality mode multiplier (used to scale the "ready" threshold,
        // not the actual LOD index directly — the multiplier adjusts whether
        // we consider a level "good enough" for the current mode)
        // In eco mode we don't prefetch beyond the current target.
        const effectiveTarget = config.lodMultiplier < 1 ?
            Math.min(target, Math.max(0, target)) : // eco keeps it tight
            target;

        this.currentTarget = effectiveTarget;

        return {
            targetLod: effectiveTarget,
            maxFetchableLod: config.allowEviction ? maxLod : effectiveTarget,
            reason
        };
    }

    /**
     * Create a deterministic `pickLod` callback for the viewer embed.
     * When the embed calls it with lodCounts, it always selects the current
     * target. Used for the initial load where the embed defers to the host.
     */
    makePickLod(): (lodCounts: readonly number[]) => Promise<number> {
        return () => Promise.resolve(this.currentTarget);
    }
}
