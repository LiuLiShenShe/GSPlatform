import type { LODAssetRef, LODLevel, LODStage, LoadPhase, LoadProgress } from './LoadEvents';
import { LodSwitcher } from './LodSwitcher';
import { ProgressAggregator } from './ProgressAggregator';
import type { ViewerHandle } from '../ViewerAdapter';

/** Minimal view of a progressive scene manifest consumed by the session. */
export interface ProgressiveManifest {
    id: string;
    lods: LODAssetRef[];
    camera?: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
}

export interface LoadSessionCallbacks {
    /** Every progress settlement (throttled by the caller if needed). */
    onProgress(progress: LoadProgress): void;
    /** A single LOD crossed a decode/apply/firstFrame stage. */
    onStage?(sessionId: string, lod: LODLevel, stage: LODStage): void;
}

export interface LoadSessionOptions {
    /**
     * Host-side bound on the embed's loadScene ACK (ms). The embed posts the
     * ACK only after its whole loadScene completes, which includes its own
     * 10 s firstFrame wait. In headless SwiftShader that iframe timer can
     * stall (P03-001); the host never blocks on it longer than this.
     */
    ackGraceMs?: number;
    /**
     * Bound on the firstFrame stage (ms), mirroring the embed's own 10 s
     * frame-wait fallback (viewer/src/embed.ts FRAME_TIMEOUT_MS) with margin.
     * A frame the embed would have declared on timeout is settled here by the
     * host instead of hanging the session forever.
     */
    firstFrameGraceMs?: number;
}

export type LoadSessionResult =
    | { status: 'ready'; lod: LODLevel }
    | { status: 'error'; lod: LODLevel; code: string }
    | { status: 'cancelled' }
    | { status: 'not_found'; code: string };

/**
 * LoadSession — drives one progressive scene load through the ViewerHandle.
 *
 * The host page pre-fetches each LOD file itself so it can report REAL byte
 * progress (Content-Length driven), then hands the bytes to the embed which
 * decodes/applies them and reports decoded/applied/firstFrame. Every step is
 * therefore event-driven; no fabricated percentages from timers.
 *
 * One caveat is *bounded* (not fabricated): the embed commits to declaring
 * `firstFrame` within its own frame-wait bound (postrender OR a 10s grace,
 * see viewer/src/embed.ts FRAME_TIMEOUT_MS). In headless SwiftShader the
 * iframe's timer queue can stall (P03-001 family), so the host enforces that
 * same bound here where host timers demonstrably run. This does not invent a
 * presented frame — it honours the embed's own documented fallback for a
 * frame the compositor cannot prove.
 *
 * Failure policy: if medium/high fails, the last interactive LOD stays on
 * screen and the session resolves as `error` (host keeps the interactive LOD
 * and offers a retry). Low failure is fatal because there is nothing to show.
 *
 * Session events carry `sessionId`; after `cancel()` or unmount the host must
 * ignore stale events from previous sessions.
 */
export class LoadSession {
    /** Default host-side bound on the embed's loadScene ACK (see LoadSessionOptions). */
    private static readonly DEFAULT_ACK_GRACE_MS = 15_000;
    /** Default host-side bound on the firstFrame stage (see LoadSessionOptions). */
    private static readonly DEFAULT_FIRST_FRAME_GRACE_MS = 15_000;

    private readonly aggregator = new ProgressAggregator();
    private readonly ackGraceMs: number;
    private readonly firstFrameGraceMs: number;
    private readonly switcher: LodSwitcher;
    private readonly viewer: ViewerHandle;
    private readonly manifest: ProgressiveManifest;
    private readonly sessionId: string;
    private readonly callbacks: LoadSessionCallbacks;
    private readonly offLodState: () => void;
    private readonly offLodFailed: () => void;
    private readonly stageWaiters = new Map<string, { resolve:() => void; reject: (e: Error) => void }>();
    private cancelled = false;
    private settledLod: LODLevel | null = null;

    constructor(
        viewer: ViewerHandle,
        manifest: ProgressiveManifest,
        sessionId: string,
        callbacks: LoadSessionCallbacks,
        options: LoadSessionOptions = {}
    ) {
        this.viewer = viewer;
        this.manifest = manifest;
        this.sessionId = sessionId;
        this.callbacks = callbacks;
        this.ackGraceMs = options.ackGraceMs ?? LoadSession.DEFAULT_ACK_GRACE_MS;
        this.firstFrameGraceMs = options.firstFrameGraceMs ?? LoadSession.DEFAULT_FIRST_FRAME_GRACE_MS;
        this.switcher = new LodSwitcher(manifest.lods);

        // The embed reports per-LOD decode stages; we resolve the waits in
        // applyLod below. Stale sessions (different sessionId) are ignored.
        this.offLodState = this.viewer.on('lodState', (payload?: unknown) => {
            const ev = payload as { sessionId?: string; lod?: LODLevel; stage?: LODStage } | undefined;
            if (!ev || ev.sessionId !== this.sessionId || !ev.lod || !ev.stage) {
                return;
            }
            this.settleStage(ev.lod, ev.stage);
        });

        // If a LOD fails inside the embed (decode/render error), the stage
        // waiters will never resolve on their own — reject them so the session
        // fails fast instead of hanging on a stuck overlay.
        this.offLodFailed = this.viewer.on('lodFailed', (payload?: unknown) => {
            const ev = payload as { sessionId?: string; lod?: LODLevel; code?: string } | undefined;
            if (!ev || ev.sessionId !== this.sessionId || !ev.lod) {
                return;
            }
            const error = new Error(ev.code ?? 'ASSET_INVALID');
            for (const stage of ['decoded', 'applied', 'firstFrame'] as const) {
                const key = `${ev.lod}:${stage}`;
                const waiter = this.stageWaiters.get(key);
                if (waiter) {
                    this.stageWaiters.delete(key);
                    waiter.reject(error);
                }
            }
        });
    }

    async start(signal: AbortSignal): Promise<LoadSessionResult> {
        if (signal.aborted) {
            return { status: 'cancelled' };
        }
        const onAbort = () => {
            this.cancelled = true;
            this.failAllWaits(new Error('cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        try {
            // Manifest is the session's 0->5% segment.
            this.aggregator.manifestReady();
            this.emitProgress();

            for (const lod of this.manifest.lods) {
                if (this.cancelled || signal.aborted) {
                    return { status: 'cancelled' };
                }
                const result = await this.loadOne(lod, signal);
                if (this.cancelled || signal.aborted) {
                    // A cancel may surface as a fetch/apply error mid-LOD;
                    // the user-facing outcome is always `cancelled`.
                    return { status: 'cancelled' };
                }
                if (result.status === 'error') {
                    // medium/high failure: keep the last interactive LOD.
                    return this.lowFailedFatal(result.code, lod.level);
                }
            }

            this.aggregator.firstFrame('high');
            this.emitProgress();
            return { status: 'ready', lod: this.settledLod ?? 'high' };
        } catch (error: unknown) {
            if (this.cancelled || signal.aborted) {
                return { status: 'cancelled' };
            }
            const code = error instanceof Error ? error.message : String(error);
            return this.lowFailedFatal(code, 'low');
        } finally {
            signal.removeEventListener('abort', onAbort);
            this.offLodState();
            this.offLodFailed();
        }
    }

    cancel(): void {
        this.cancelled = true;
        this.failAllWaits(new Error('cancelled'));
    }

    private lowFailedFatal(code: string, lod: LODLevel): LoadSessionResult {
        // If low itself failed there is nothing interactive to keep.
        if (lod === 'low' || this.switcher.currentLevel === null) {
            return { status: 'error', lod, code };
        }
        // Otherwise degrade: keep the best settled LOD.
        return { status: 'error', lod: this.switcher.currentLevel, code };
    }

    private async loadOne(
        lod: LODAssetRef,
        signal: AbortSignal
    ): Promise<{ status: 'ok' } | { status: 'error'; code: string }> {
        // Start indeterminate-safe: whether this fetch has a provable total is
        // only known once the response headers arrive. The observed total (real
        // Content-Length) is forwarded on every progress tick; null keeps the
        // session indeterminate (no fabricated percentage from manifest size).
        this.aggregator.fetchStart(lod.level, null);
        this.emitProgress();

        const url = lod.assetUrl;
        let bytes: Uint8Array;
        try {
            bytes = await fetchArrayBufferWithProgress(url, lod.level, (loaded, observedTotal) => {
                this.aggregator.fetchProgress(lod.level, loaded, observedTotal);
                this.emitProgress();
            }, signal);
        } catch (error: unknown) {
            const aborted = signal.aborted || this.cancelled;
            if (aborted) {
                return { status: 'error', code: 'aborted' };
            }
            const msg = error instanceof Error ? error.message : String(error);
            return { status: 'error', code: /404|not found/i.test(msg) ? 'SCENE_NOT_FOUND' : 'ASSET_FETCH_FAILED' };
        }
        this.aggregator.fetchComplete(lod.level);
        this.emitProgress();

        // Hand the bytes to the viewer. The embed decodes, applies and reports
        // decoded/applied/firstFrame; applyLod waits for firstFrame.
        try {
            await this.applyLod(lod, bytes, signal);
        } catch (error: unknown) {
            const aborted = signal.aborted || this.cancelled;
            if (aborted) {
                return { status: 'error', code: 'aborted' };
            }
            const msg = error instanceof Error ? error.message : String(error);
            return { status: 'error', code: msg || 'ASSET_INVALID' };
        }
        return { status: 'ok' };
    }

    private async applyLod(lod: LODAssetRef, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        // The embed reports decoded/applied/firstFrame asynchronously via
        // lodState events. It bounds its own firstFrame wait (postrender or
        // 10 s grace); in headless SwiftShader that iframe timer queue can
        // stall (P03-001), which would also delay the loadScene ACK (posted
        // after the wait). Race both against host-side grace timers so the
        // session can never hang on an embed that will not report — the grace
        // honours the embed's own documented fallback (presented OR elapsed).
        const waits = [
            this.waitForStage(lod.level, 'decoded', signal),
            this.waitForStage(lod.level, 'applied', signal),
            this.waitForStage(lod.level, 'firstFrame', signal)
        ];

        try {
            // Step 1 — ACK: the embed posts it only after its firstFrame wait
            // resolves; don't wait for that indefinitely.
            const ackPromise = this.viewer.loadScene(
                {
                    id: this.manifest.id,
                    title: this.manifest.id,
                    format: 'sog',
                    assetUrl: url,
                    camera: this.manifest.camera,
                    lod: lod.level,
                    sessionId: this.sessionId
                },
                signal
            );
            const ackGrace = this.delay(this.ackGraceMs);
            const ackResult = await Promise.race([ackPromise.then(() => 'ack' as const), ackGrace]);
            if (ackResult !== 'ack') {
                // The embed is silent — let the decode stage listeners drive
                // whatever they can; firstFrame settles via the grace below.
                ackPromise.catch(() => {});
            }

            // Step 2 — decoded + applied: real events the embed fires promptly
            // before the firstFrame wait; require them so the bar still moves
            // through the per-stage documented weights.
            await Promise.all([waits[0], waits[1]]);
            // Step 3 — firstFrame: the embed commits to settling it within its
            // own frame-wait bound (embed FRAME_TIMEOUT_MS). Enforce the same
            // bound here where host timers are reliable.
            const frameGrace = this.delay(this.firstFrameGraceMs);
            const frameResult = await Promise.race([waits[2].then(() => 'frame' as const), frameGrace]);
            if (frameResult !== 'frame') {
                this.settleStage(lod.level, 'firstFrame');
            }
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // -- stage settlement ---------------------------------------------------

    /**
     * Settle a stage for a LOD through the same path the lodState event
     * handler uses — identical aggregator weight, switcher transition and
     * waiter resolution whether the real event arrived or the host-side grace
     * fired. The host grace mirrors the embed's own documented fallback
     * (presented OR grace elapsed) but executes where timers are reliable
     * (P02-001/P03-001 family).
     */
    private settleStage(lod: LODLevel, stage: LODStage): void {
        const key = `${lod}:${stage}`;
        const waiter = this.stageWaiters.get(key);
        if (!waiter) {
            return; // already settled by the real event, or not awaited
        }
        this.stageWaiters.delete(key);
        this.callbacks.onStage?.(this.sessionId, lod, stage);
        if (stage === 'decoded') {
            this.aggregator.decoded(lod);
        } else if (stage === 'applied') {
            this.aggregator.applied(lod);
        } else if (stage === 'firstFrame') {
            this.aggregator.firstFrame(lod);
            this.switcher.settle(lod);
            this.settledLod = lod;
        }
        this.emitProgress();
        waiter.resolve();
    }

    // -- helpers ------------------------------------------------------------

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    private waitForStage(lod: LODLevel, stage: LODStage, signal: AbortSignal): Promise<void> {
        const key = `${lod}:${stage}`;
        if (signal.aborted) {
            return Promise.reject(new Error('aborted'));
        }
        return new Promise<void>((resolve, reject) => {
            this.stageWaiters.set(key, { resolve, reject });
        });
    }

    private failAllWaits(error: Error): void {
        this.stageWaiters.forEach(waiter => waiter.reject(error));
        this.stageWaiters.clear();
    }

    private emitProgress(): void {
        this.callbacks.onProgress({
            sessionId: this.sessionId,
            percent: this.aggregator.percent,
            phase: this.aggregator.phase,
            loadedBytes: this.aggregator.loadedBytes,
            totalBytes: this.aggregator.totalBytes,
            indeterminate: this.aggregator.indeterminate
        });
    }
}

/**
 * Fetch a LOD file while reporting byte progress. When Content-Length is
 * known, `total` is a real number; otherwise the caller sees `total: null`
 * and must show indeterminate progress rather than a fabricated percentage.
 */
export async function fetchArrayBufferWithProgress(
    url: string,
    _lod: LODLevel,
    onProgress: (loaded: number, total: number | null) => void,
    signal?: AbortSignal
): Promise<Uint8Array> {
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('Content-Length') ?? NaN);
    const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;

    if (!response.body) {
        const buffer = await response.arrayBuffer();
        onProgress(buffer.byteLength, total);
        return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/** Label helper for UI strings. */
export const phaseLabel = (phase: LoadPhase): string => {
    switch (phase) {
        case 'PREPARING': return '正在准备场景';
        case 'FETCHING_LOW': return '下载低清场景';
        case 'DECODING_LOW': return '解码低清场景';
        case 'INTERACTIVE_LOW': return '低清可交互 · 正在提升质量';
        case 'STREAMING_HIGH': return '正在提升质量';
        case 'READY': return '加载完成';
        case 'ERROR': return '加载失败';
        case 'CANCELLED': return '已取消加载';
    }
};
