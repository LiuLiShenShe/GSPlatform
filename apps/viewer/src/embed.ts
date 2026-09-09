import { WebPCodec, WorkerQueue } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice, Vec3 } from 'playcanvas';

import { CommandQueue } from './command-queue';
import { ElementType } from './element';
import { Events } from './events';
import { MappedReadFileSystem } from './io';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { Splat } from './splat';

// GSPlatform viewer embed.
//
// This is a viewer-only bootstrap for the platform iframe: no editor UI, no
// tools, no panels. It creates the scene/camera/renderer and exposes a
// postMessage RPC so the platform page can load scenes and control the camera.
// It reuses the SuperSplat Scene/camera/render pipeline unchanged; only the
// surrounding app is missing.

interface GsViewerSceneDescriptor {
    assetUrl: string;
    format: 'sog' | 'ply' | 'splat';
    camera?: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
}

interface GsViewerRequest {
    id: number;
    command: string;
    payload?: unknown;
}

interface GsViewerResponse {
    id: number;
    command: string;
    ok: boolean;
    error?: string;
    payload?: unknown;
}

declare global {
    interface Window {
        scene: Scene;
    }
}

const start = async () => {
    // root events object
    const events = new Events();

    // shared command queue (parity with main.ts)
    const commandQueue = new CommandQueue();

    // configure WebP WASM for SOG format
    WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', document.baseURI).toString();
    WorkerQueue.maxWorkers = 0;

    // the canvas and its container are created by embed.html
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement;
    const loadingText = document.getElementById('loading-text') as HTMLDivElement;

    const setLoading = (visible: boolean, label?: string) => {
        loadingOverlay.classList.toggle('hidden', !visible);
        if (label) loadingText.textContent = label;
    };

    // respond to the parent with the resolved bridge url
    const post = (response: GsViewerResponse) => {
        window.parent.postMessage(response, '*');
    };

    // -- graphics device -------------------------------------------------

    // The SuperSplat render pipeline (StorageBuffer / compute shaders) is
    // WebGPU-only. If the browser lacks navigator.gpu, fail fast with a clear
    // user-facing error rather than letting the engine create a WebGL2 device
    // that the renderer cannot use.
    if (!('gpu' in window.navigator)) {
        console.warn('[gsviewer] navigator.gpu missing');
        post({ id: 0, command: 'init', ok: false, error: 'GRAPHICS_UNSUPPORTED' });
        return;
    }

    // Log adapter availability for diagnostics.
    try {
        const adapter = await window.navigator.gpu.requestAdapter();
        console.warn('[gsviewer] adapter', adapter ? 'found' : 'null');
    } catch { /* ignore */ }

    const graphicsDevice = await createGraphicsDevice(canvas, {
        deviceTypes: ['webgpu'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });
    console.warn('[gsviewer] device', {
        isNull: (graphicsDevice as any).isNull,
        isWebGPU: (graphicsDevice as any).isWebGPU,
        isWebGL2: (graphicsDevice as any).isWebGL2
    });

    if ((graphicsDevice as any).isNull) {
        post({
            id: 0,
            command: 'init',
            ok: false,
            error: 'GRAPHICS_UNSUPPORTED'
        });
        return;
    }

    // -- scene -----------------------------------------------------------

    // If the WebGPU adapter was not actually obtained (e.g. requestAdapter
    // rejected and the engine fell back to WebGL2), the renderer will crash on
    // construct. Report it as GRAPHICS_UNSUPPORTED so the platform shows the
    // right error message instead of an opaque init failure.
    let scene: Scene;
    try {
        scene = new Scene(
            events,
            getSceneConfig([]),
            canvas,
            graphicsDevice,
            commandQueue
        );
    } catch (err) {
        console.warn('[gsviewer] Scene constructor failed:', err instanceof Error ? err.message : String(err));
        post({ id: 0, command: 'init', ok: false, error: 'GRAPHICS_UNSUPPORTED' });
        return;
    }

    // minimal event functions the render loop samples. The editor registers
    // these via registerEditorEvents; the embed just pins the defaults.
    events.function('view.perfOverlay', () => false);
    events.function('view.stochastic', () => 'disabled');
    events.function('camera.controlMode', () => scene.camera.controlMode);

    // view defaults — the render loop invokes these on every frame. The editor
    // populates them via the UI; the viewer pins sensible no-edit defaults.
    events.function('view.editView', () => false);
    events.function('view.outlineSelection', () => false);
    events.function('colorPanel.pending', () => null);
    events.function('selection', () => null);
    events.function('selection.footprint', () => 1);
    events.function('view.bands', () => 1);
    events.function('view.minPixelSize', () => 0);
    events.function('view.gaussians', () => true);
    events.function('view.selectionColor', () => false);
    events.function('view.rings', () => false);
    events.function('view.ringSize', () => 0);
    events.function('view.selectionRings', () => false);
    events.function('view.splatsSelectionBlend', () => 0.5);
    events.function('view.splatsColorBlend', () => 1);
    events.function('view.ringsColorBlend', () => 0.5);
    events.function('view.ringsSelectionBlend', () => 0.5);
    events.function('view.centerSize', () => 1);
    events.function('view.centersColorBlend', () => 1);
    events.function('view.centersSelectionBlend', () => 0.5);
    events.function('camera.showPoses', () => false);
    events.function('view.centers', () => false);
    events.function('view.selectionCenters', () => false);

    const setControlMode = (mode: 'orbit' | 'fly') => {
        if (scene.camera.controlMode !== mode) {
            scene.camera.controlMode = mode;
            events.fire('camera.controlMode', mode);
            post({
                id: 0,
                command: 'cameraMode',
                ok: true,
                payload: { mode }
            });
        }
    };

    events.on('camera.setControlMode', (mode: 'orbit' | 'fly') => {
        setControlMode(mode);
    });

    // colors (parity with main.ts)
    const bgClr = new Color(0, 0, 0, 1);
    events.function('bgClr', () => bgClr);
    events.function('selectedClr', () => new Color(1, 1, 0, 1));
    events.function('unselectedClr', () => new Color(0, 0, 1, 0.5));
    events.function('lockedClr', () => new Color(0, 0, 0, 0.05));

    // start the render loop
    scene.start();
    window.scene = scene;

    // -- fly-mode keyboard navigation -------------------------------------

    // Fly mode in the editor is driven by input events (camera.fly.*) fired by
    // the shortcut manager. The embed has no editor UI, so wire the minimal
    // WASD/QE navigation directly, scoped to the canvas container: keys only
    // affect the scene while the canvas (and therefore this iframe) has focus,
    // so typing in dialogs or other page regions is never hijacked.
    const flyKeys: Record<string, string> = {
        w: 'camera.fly.forward',
        a: 'camera.fly.left',
        s: 'camera.fly.backward',
        d: 'camera.fly.right',
        q: 'camera.fly.down',
        e: 'camera.fly.up'
    };
    const pressedFlyKeys = new Set<string>();
    const onFlyKey = (event: KeyboardEvent, down: boolean) => {
        const label = event.key.toLowerCase();
        const name = flyKeys[label];
        if (!name || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        event.preventDefault();
        if (down) {
            if (!pressedFlyKeys.has(label)) {
                pressedFlyKeys.add(label);
                events.fire(name, true);
            }
        } else {
            if (pressedFlyKeys.delete(label)) {
                events.fire(name, false);
            }
        }
    };
    const onFlyKeyDown = (event: KeyboardEvent) => onFlyKey(event, true);
    const onFlyKeyUp = (event: KeyboardEvent) => onFlyKey(event, false);

    // attach to the canvas container: while fly mode is active the canvas has
    // focus, so key events land here; the 'blur' handler clears held keys so a
    // lost-focus doesn't leave the camera drifting
    window.addEventListener('keydown', onFlyKeyDown);
    window.addEventListener('keyup', onFlyKeyUp);
    window.addEventListener('blur', () => {
        if (pressedFlyKeys.size > 0) {
            [...pressedFlyKeys].forEach((label) => {
                pressedFlyKeys.delete(label);
                events.fire(flyKeys[label], false);
            });
        }
    });

    // -- stats -----------------------------------------------------------

    const getSplatCount = (): number => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        return splats.reduce((total, splat) => total + splat.numSplats, 0);
    };

    // fps measured over a rolling 1s window using rendered frames
    let fps = 0;
    let frameCount = 0;
    let windowStart = performance.now();
    const frameTimeSamples: number[] = [];

    const onPostRender = () => {
        const now = performance.now();
        frameCount++;
        frameTimeSamples.push(now);
        const elapsed = now - windowStart;
        if (elapsed >= 1000) {
            // frames that started within the window; cheap approximation by
            // trimming the queue to samples older than the window
            while (frameTimeSamples.length && frameTimeSamples[0] <= windowStart) {
                frameTimeSamples.shift();
            }
            fps = frameTimeSamples.length;
            windowStart = now;
            frameCount = 0;
            frameTimeSamples.length = 0;
        }
    };
    scene.events.on('postrender', onPostRender);

    // -- context loss ----------------------------------------------------

    canvas.addEventListener('webglcontextlost', (event: Event) => {
        event.preventDefault();
        post({ id: 0, command: 'contextLost', ok: false, error: 'CONTEXT_LOST' });
    });

    // -- load scene ------------------------------------------------------

    const loadScene = async (descriptor: GsViewerSceneDescriptor) => {
        setLoading(true, 'Loading scene…');
        try {
            const baseUrl = new URL('.', new URL(descriptor.assetUrl, window.location.href)).href;
            const fileSystem = new MappedReadFileSystem(baseUrl);
            const filename = descriptor.assetUrl;

            const model = await scene.assetLoader.load(filename, fileSystem, false);
            if (!model) {
                throw new Error('ASSET_INVALID');
            }
            await scene.add(model);

            // frame the loaded scene
            if (descriptor.camera) {
                scene.camera.setPose(
                    new Vec3(...descriptor.camera.position),
                    new Vec3(...descriptor.camera.target),
                    0
                );
                scene.camera.fov = descriptor.camera.fov;
            } else {
                scene.camera.focus();
            }

            post({
                id: 0,
                command: 'sceneLoaded',
                ok: true,
                payload: { splatCount: getSplatCount() }
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            const code =
                message === 'ASSET_INVALID' ? 'ASSET_INVALID' :
                    /fetch|network/i.test(message) ? 'ASSET_FETCH_FAILED' :
                        'ASSET_INVALID';
            post({ id: 0, command: 'sceneLoadFailed', ok: false, error: code });
        } finally {
            setLoading(false);
        }
    };

    // -- reset camera ----------------------------------------------------

    const resetCamera = () => {
        if (scene.getElementsByType(ElementType.splat).length > 0) {
            scene.camera.focus();
        }
    };

    // -- RPC -------------------------------------------------------------

    window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as GsViewerRequest;
        if (!data || typeof data !== 'object' || typeof data.command !== 'string') {
            return;
        }

        switch (data.command) {
            case 'ping':
                post({ id: data.id, command: 'ping', ok: true, payload: { ready: true } });
                break;
            case 'loadScene': {
                const descriptor = data.payload as GsViewerSceneDescriptor;
                if (!descriptor || typeof descriptor.assetUrl !== 'string') {
                    post({ id: data.id, command: 'loadScene', ok: false, error: 'INVALID_DESCRIPTOR' });
                    break;
                }
                loadScene(descriptor).then(() => {
                    post({ id: data.id, command: 'loadScene', ok: true });
                }).catch((error: unknown) => {
                    post({
                        id: data.id,
                        command: 'loadScene',
                        ok: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                });
                break;
            }
            case 'resetCamera':
                resetCamera();
                post({ id: data.id, command: 'resetCamera', ok: true });
                break;
            case 'setCameraMode': {
                const mode = (data.payload as { mode?: string })?.mode;
                if (mode !== 'orbit' && mode !== 'fly') {
                    post({ id: data.id, command: 'setCameraMode', ok: false, error: 'INVALID_MODE' });
                    break;
                }
                setControlMode(mode);
                post({ id: data.id, command: 'setCameraMode', ok: true });
                break;
            }
            case 'resize': {
                // the canvas follows its container via ResizeObserver in Scene;
                // this is an acknowledgement point for the adapter contract.
                post({ id: data.id, command: 'resize', ok: true });
                break;
            }
            case 'getStats':
                post({
                    id: data.id,
                    command: 'getStats',
                    ok: true,
                    payload: {
                        fps: Math.round(fps),
                        frameTimeMs: fps > 0 ? Math.round(1000 / fps * 10) / 10 : 0,
                        splatCount: getSplatCount(),
                        renderer: (graphicsDevice as any).isWebGPU ? 'webgpu' : (graphicsDevice as any).isWebGL2 ? 'webgl2' : 'null'
                    }
                });
                break;
            default:
                post({ id: data.id, command: data.command, ok: false, error: 'UNKNOWN_COMMAND' });
                break;
        }
    });

    // announce readiness
    post({ id: 0, command: 'ready', ok: true });
};

start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    window.parent.postMessage({
        id: 0,
        command: 'init',
        ok: false,
        error: 'VIEWER_INIT_FAILED',
        payload: { message }
    }, '*');
});
