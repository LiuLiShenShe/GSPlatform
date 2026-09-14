import type { ViewerHandle } from '../ViewerAdapter';
import { StreamScheduler } from './StreamScheduler';
import type { QualityMode, StreamedManifest, StreamingEventMap } from './types';

/**
 * Top-level entry point for loading a streamed-SOG scene from the platform.
 *
 * Workflow:
 *   1. Fetch the manifest JSON at the stable `current/manifest.json` path.
 *   2. Create a {@link StreamScheduler} from the manifest's `stream.counts`.
 *   3. Call `viewer.loadScene` with `format: 'streamed-sog'` pointing at the
 *      upstream `lod-meta.json` — the viewer embed's `UrlReadFileSystem` picks
 *      it up and streams chunks via HTTP Range.
 *   4. Forward `lodState` events from the embed to the scheduler for metrics
 *      and progress tracking.
 *   5. Feed frame times and camera motion state to the scheduler each frame
 *      so the LOD selector can decide the target quality.
 *
 * The web app instantiates one `StreamedSogLoader` per scene navigation.
 */
export class StreamedSogLoader {
    readonly scheduler: StreamScheduler;
    private rafId: number | null = null;
    private sessionAbort: AbortController | null = null;
    private readonly cleanups: Array<() => void> = [];

    /** Rate-limit the scheduler's tick to avoid per-frame overhead. */
    private readonly tickIntervalMs = 200;
    private lastTickTime = 0;
    private readonly manifest: StreamedManifest;

    constructor(manifest: StreamedManifest) {
        this.manifest = manifest;
        this.scheduler = new StreamScheduler(manifest.stream.counts);
    }

    // -- events --------------------------------------------------------------

    on<K extends keyof StreamingEventMap>(type: K, listener: (payload: StreamingEventMap[K]) => void): () => void {
        return this.scheduler.on(type, listener);
    }

    // -- public API ----------------------------------------------------------

    /**
     * Attach a viewer handle and start streaming. Call this once the viewer
     * embed has finished its `init` handshake.
     */
    async start(viewer: ViewerHandle): Promise<void> {
        this.sessionAbort = new AbortController();

        // Subscribe to embed LOD events to keep metrics in sync.
        this.cleanups.push(viewer.on('lodState', (payload) => {
            // lodState carries { sessionId, lod, stage } from the embed.
            // We use it to update progress and metrics.
            if (payload.stage === 'firstFrame') {
                this.scheduler.metrics.recordCacheHit(); // first frame = resident
            }
        }));

        // Build the asset URL: for local-scenes it is the lod-meta.json path
        // inside the manifest's `stream.entryUrl`. The asset URL is the full
        // URL relative to the dev server origin, so the host page's base URL
        // is used as a prefix. For production, the URL is absolute.
        const entryUrl = this.resolveEntryUrl();

        // Determine the LOD target for the initial load.
        const decision = this.scheduler.lodSelector.decide();
        this.scheduler.setManifest(this.manifest);

        // Start the render-loop integration.
        this.startRafLoop();

        // Kick off the initial scene load in the embed.
        await viewer.loadScene({
            id: this.manifest.sceneId,
            title: this.manifest.title ?? this.manifest.sceneId,
            format: 'streamed-sog',
            assetUrl: entryUrl,
            camera: this.manifest.camera,
            lod: (['low', 'medium', 'high'] as const)[decision.targetLod] ?? 'low',
            sessionId: `stream-${this.manifest.sceneId}-${Date.now()}`
        }, this.sessionAbort?.signal);

        // Schedule higher LODs after the initial low LOD is interactive.
        this.scheduleHigherLods(decision.targetLod);
    }

    /**
     * Switch the quality mode at runtime.
     */
    setQuality(mode: QualityMode): void {
        this.scheduler.setQuality(mode);
    }

    /**
     * Destroy the loader, aborting all in-flight work.
     */
    destroy(): void {
        this.sessionAbort?.abort();
        this.sessionAbort = null;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.scheduler.reset();
    }

    /** Snapshot of the current metrics for the performance panel. */
    get metrics() {
        return this.scheduler.metrics.snapshot();
    }

    // -- internals -----------------------------------------------------------

    /**
     * Resolve the full asset URL for the upstream `lod-meta.json`.
     * The manifest's `stream.entryUrl` is scene-root-relative; we prefix
     * it with the dev-server's `/local-scenes/<sceneId>/` base.
     */
    private resolveEntryUrl(): string {
        const sceneId = this.manifest.sceneId;
        const entryUrl = this.manifest.stream.entryUrl;
        // In the browser, the base origin is known. For dev, the Vite
        // middleware serves at `/local-scenes/<sceneId>/<rel>`.
        const base = window.location.origin;
        return `${base}/local-scenes/${sceneId}/${entryUrl}`;
    }

    /**
     * After the lowest LOD is interactive, schedule the medium and high LOD
     * chunks into the scheduler for progressive refinement.
     */
    private scheduleHigherLods(currentLod: number): void {
        const counts = this.manifest.stream.counts;
        for (let lod = currentLod + 1; lod < counts.length; lod++) {
            const chunkCount = Math.max(1, Math.ceil(counts[lod] / 2000));
            for (let c = 0; c < chunkCount; c++) {
                this.scheduler.residency.getStatus(`${lod}_${c}`);
                // the scheduler's tick will pick these up and reprioritize
            }
        }
    }

    /**
     * Run a lightweight frame loop to feed frame times and camera motion to
     * the scheduler at a throttled rate.
     */
    private startRafLoop(): void {
        let lastFrameTime = performance.now();
        const loop = (now: number) => {
            this.rafId = requestAnimationFrame(loop);

            const frameTimeMs = now - lastFrameTime;
            lastFrameTime = now;

            // Feed the LOD selector.
            this.scheduler.feedFrameTime(frameTimeMs);
            this.scheduler.signalCameraMotion(false); // TODO: derive from camera

            // Throttled tick for the scheduler.
            if (now - this.lastTickTime >= this.tickIntervalMs) {
                this.lastTickTime = now;
                this.scheduler.tick();
            }
        };
        this.rafId = requestAnimationFrame(loop);
    }
}
