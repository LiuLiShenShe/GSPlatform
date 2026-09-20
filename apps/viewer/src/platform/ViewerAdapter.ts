import type { SceneDescriptor } from './SceneDescriptor';
import { ViewerError, type ViewerErrorCode } from './ViewerError';

/**
 * Live statistics reported by the renderer.
 */
export interface ViewerStats {
    fps: number;
    frameTimeMs: number;
    splatCount: number;
    renderer: 'webgpu' | 'webgl2' | 'null';
}

export type ViewerCameraMode = 'orbit' | 'fly';

/**
 * Current camera pose snapshot. `target` is the orbit focal point; `position`
 * is the PlayCanvas camera entity position, so the host can persist the pose
 * and restore it across route changes (Phase 04 observability/UX).
 */
export interface ViewerCameraPose {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    mode: ViewerCameraMode;
}

export interface CreateViewerOptions {
    /**
     * Base URL of the viewer embed build (defaults to '/viewer/embed.html').
     */
    viewerUrl?: string;
    /**
     * Origin to restrict postMessage traffic to. Defaults to the current origin.
     */
    targetOrigin?: string;
}

/**
 * Events the embed reports asynchronously (not tied to a request).
 */
export interface ViewerEventMap {
    ready: () => void;
    contextLost: () => void;
    /**
     * Posted by the embed when it could not initialise the graphics device
     * or construct the scene pipeline (e.g. GRAPHICS_UNSUPPORTED).
     */
    viewerFailed: (payload: { code: ViewerErrorCode }) => void;
    sceneLoaded: (payload: { splatCount: number }) => void;
    sceneLoadFailed: (payload: { code: ViewerErrorCode }) => void;
    /**
     * Progressive-loading stage report (Phase 03): the embed posts one of
     * these for each LOD a session sends it. The host uses them to settle the
     * corresponding part of its progress aggregation.
     */
    lodState: (payload: { sessionId?: string; lod?: string; stage?: string }) => void;
    /**
     * A single LOD tier failed inside the embed. The host keeps the last
     * interactive LOD and can offer a per-tier retry.
     */
    lodFailed: (payload: { sessionId?: string; lod?: string; code?: string }) => void;
    cameraMode: (payload: { mode: ViewerCameraMode }) => void;
}

export interface ViewerWorldTransform {
    position: [number, number, number] | null;
    rotation: [number, number, number] | null;
    scale: [number, number, number] | null;
}

export interface ViewerBackground {
    type: 'color' | 'equirectangular';
    color?: [number, number, number];
    assetUrl?: string;
}

export interface ViewerScreenshotResult {
    dataUrl: string;
}

export interface ViewerPickResult {
    position: [number, number, number];
}

export interface ViewerHandle {
    /** Load a scene described by the controlled DTO. Aborts on signal. */
    loadScene(descriptor: SceneDescriptor, abortSignal?: AbortSignal): Promise<void>;
    resetCamera(): Promise<void>;
    setCameraMode(mode: ViewerCameraMode): Promise<void>;
    resize(width: number, height: number, devicePixelRatio: number): Promise<void>;
    getStats(): Promise<ViewerStats>;
    /** Snapshot the current camera pose (position/target/fov/mode). */
    getCameraPose(): Promise<{ camera: ViewerCameraPose }>;
    /** Set the camera position/target/fov. */
    setCameraPose(pose: { position?: [number, number, number]; target?: [number, number, number]; fov?: number }): Promise<void>;
    /** Apply world transform (position/rotation/scale) to all splat entities. */
    setWorldTransform(transform: { position?: [number, number, number] | null; rotation?: [number, number, number] | null; scale?: [number, number, number] | null }): Promise<void>;
    /** Get current world transform of the first splat entity. */
    getWorldTransform(): Promise<ViewerWorldTransform>;
    /** Set background color or equirectangular panorama. */
    setBackground(bg: ViewerBackground): Promise<void>;
    /** Capture the canvas as a data URL. */
    captureScreenshot(opts?: { format?: string; quality?: number }): Promise<ViewerScreenshotResult>;
    /** Pick the world-space 3D position at a normalized screen coordinate. */
    pickWorldPosition(x: number, y: number): Promise<ViewerPickResult>;
    destroy(): void;
    /** Subscribe to embed-reported events. Returns unsubscribe. */
    on<T extends keyof ViewerEventMap>(type: T, listener: ViewerEventMap[T]): () => void;
}

interface EmbedRequest {
    id: number;
    command: string;
    payload?: unknown;
}

interface EmbedResponse {
    id: number;
    command: string;
    ok: boolean;
    error?: string;
    payload?: unknown;
}

const normalizeCode = (raw: string | undefined): ViewerErrorCode => {
    switch (raw) {
        case 'SCENE_NOT_FOUND':
        case 'ASSET_FETCH_FAILED':
        case 'ASSET_INVALID':
        case 'GRAPHICS_UNSUPPORTED':
        case 'VIEWER_INIT_FAILED':
        case 'CONTEXT_LOST':
            return raw;
        default:
            return 'UNKNOWN';
    }
};

/**
 * Creates a ViewerHandle by mounting the viewer embed build in an iframe and
 * driving it through postMessage. The web app never touches PlayCanvas or the
 * viewer internals directly; this adapter is the only contract it relies on.
 */
export const createViewer = (
    container: HTMLElement,
    options: CreateViewerOptions = {}
): ViewerHandle => {
    const viewerUrl = options.viewerUrl ?? '/viewer/embed.html';
    const targetOrigin = options.targetOrigin ?? window.location.origin;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('src', viewerUrl);
    iframe.setAttribute('title', '3D Gaussian 场景查看器');
    iframe.setAttribute('allow', 'fullscreen');
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    container.appendChild(iframe);

    let nextId = 1;
    let destroyed = false;
    const pending = new Map<number, { resolve:(v: EmbedResponse) => void, reject: (e: Error) => void }>();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    // The embed registers its RPC message listener only at the very end of
    // start(), after async graphics device + Scene construction. A command sent
    // before that point is silently dropped, so requests must wait until the
    // embed posts 'ready'. The 'ready' message also acts as the error boundary:
    // an init failure ('init' ok:false) rejects this promise and fails pending
    // sends fast instead of leaving them hanging forever.
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // Mark the promise handled so a rejection with no send() awaiting it (e.g.
    // the viewer is destroyed before any command is sent) does not surface as
    // an unhandled rejection. callers awaiting readyPromise still observe the
    // rejection through their own await.
    readyPromise.catch(() => {});
    let ready = false;

    const emit = (type: string, payload?: unknown) => {
        const set = listeners.get(type);
        if (set) {
            set.forEach(fn => (fn as (p?: unknown) => void)(payload));
        }
    };

    const handleMessage = (event: MessageEvent) => {
        // only accept traffic from our own iframe
        const source = event.source;
        if (source !== iframe.contentWindow) {
            return;
        }

        const data = event.data as EmbedResponse;
        if (!data || typeof data !== 'object' || typeof data.command !== 'string') {
            return;
        }

        if (data.command === 'ready') {
            ready = true;
            resolveReady();
            emit('ready');
            return;
        }
        if (data.command === 'contextLost') {
            emit('contextLost');
            return;
        }
        if (data.command === 'init' && !data.ok) {
            // the embed failed before posting 'ready' (e.g. no WebGPU). Surface
            // it as an event so the host can show the error state, and fail any
            // sends still waiting on ready so they don't hang forever.
            if (!ready) {
                rejectReady(new ViewerError(normalizeCode(data.error), 'viewer init failed'));
            }
            emit('viewerFailed', { code: normalizeCode(data.error) });
            return;
        }
        if (data.command === 'sceneLoaded') {
            emit('sceneLoaded', data.payload);
            return;
        }
        if (data.command === 'sceneLoadFailed') {
            emit('sceneLoadFailed', data.payload);
            return;
        }
        if (data.command === 'cameraMode') {
            emit('cameraMode', data.payload);
            return;
        }
        if (data.command === 'lodState') {
            emit('lodState', data.payload);
            return;
        }
        if (data.command === 'lodFailed') {
            emit('lodFailed', data.payload);
            return;
        }

        const entry = pending.get(data.id);
        if (!entry) {
            return;
        }
        pending.delete(data.id);
        if (data.ok) {
            entry.resolve(data);
        } else {
            entry.reject(new ViewerError(normalizeCode(data.error), data.error ?? 'viewer command failed'));
        }
    };

    window.addEventListener('message', handleMessage);

    const send = async (command: string, payload?: unknown): Promise<EmbedResponse> => {
        if (destroyed) {
            throw new ViewerError('VIEWER_INIT_FAILED', 'viewer destroyed');
        }
        // wait for the embed to be listening; if init fails or the viewer is
        // destroyed first this throws (see readyPromise rejection above)
        await readyPromise;
        if (destroyed) {
            throw new ViewerError('VIEWER_INIT_FAILED', 'viewer destroyed');
        }
        const id = nextId++;
        const request: EmbedRequest = { id, command, payload };
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            iframe.contentWindow?.postMessage(request, targetOrigin);
        });
    };

    const viewer: ViewerHandle = {
        async loadScene(descriptor: SceneDescriptor, abortSignal?: AbortSignal) {
            if (abortSignal?.aborted) {
                throw new ViewerError('ASSET_FETCH_FAILED', 'load aborted');
            }
            const loadPromise = send('loadScene', descriptor);
            if (abortSignal) {
                const abort = () => {
                    pending.clear(); // embed has no cancellation; drop the wait
                    // note: the load still completes inside the iframe and a
                    // sceneLoaded event may arrive - handled by on()
                };
                abortSignal.addEventListener('abort', abort, { once: true });
                try {
                    await loadPromise;
                } finally {
                    abortSignal.removeEventListener('abort', abort);
                }
            } else {
                await loadPromise;
            }
        },
        resetCamera(): Promise<void> {
            return send('resetCamera').then(() => {});
        },
        setCameraMode(mode: ViewerCameraMode): Promise<void> {
            return send('setCameraMode', { mode }).then(() => {});
        },
        resize(width: number, height: number, devicePixelRatio: number): Promise<void> {
            return send('resize', { width, height, devicePixelRatio }).then(() => {});
        },
        async getStats() {
            const res = await send('getStats');
            return res.payload as ViewerStats;
        },
        async getCameraPose() {
            const res = await send('getCameraPose');
            return res.payload as { camera: ViewerCameraPose };
        },
        async setCameraPose(pose: { position?: [number, number, number]; target?: [number, number, number]; fov?: number }) {
            await send('setCameraPose', pose);
        },
        async setWorldTransform(transform: { position?: [number, number, number] | null; rotation?: [number, number, number] | null; scale?: [number, number, number] | null }) {
            await send('setWorldTransform', transform);
        },
        async getWorldTransform() {
            const res = await send('getWorldTransform');
            return res.payload as ViewerWorldTransform;
        },
        async setBackground(bg: ViewerBackground) {
            await send('setBackground', bg);
        },
        async captureScreenshot(opts?: { format?: string; quality?: number }) {
            const res = await send('captureScreenshot', opts ?? {});
            return res.payload as ViewerScreenshotResult;
        },
        async pickWorldPosition(x: number, y: number) {
            const res = await send('pickWorldPosition', { x, y });
            return res.payload as ViewerPickResult;
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            if (!ready) {
                rejectReady(new ViewerError('VIEWER_INIT_FAILED', 'viewer destroyed'));
            }
            window.removeEventListener('message', handleMessage);
            pending.forEach(entry => entry.reject(new ViewerError('VIEWER_INIT_FAILED', 'viewer destroyed')));
            pending.clear();
            listeners.clear();
            iframe.remove();
        },
        on(type, listener) {
            let set = listeners.get(type);
            if (!set) {
                set = new Set();
                listeners.set(type, set);
            }
            set.add(listener as (...args: unknown[]) => void);
            return () => {
                set.delete(listener as (...args: unknown[]) => void);
            };
        }
    };

    return viewer;
};
