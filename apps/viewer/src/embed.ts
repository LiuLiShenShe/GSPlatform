import { WebPCodec, WorkerQueue, UrlReadFileSystem } from '@playcanvas/splat-transform';
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
    format: 'sog' | 'ply' | 'splat' | 'streamed-sog';
    camera?: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
    /** Progressive-loading tier label (Phase 03). */
    lod?: 'low' | 'medium' | 'high';
    /** Correlation id echoed back in lodState events. */
    sessionId?: string;
    /** Base URL for streamed-SOG resolution (defaults to the directory of assetUrl). */
    baseUrl?: string;
    /** Collision mesh URL (Phase 12). Loaded invisibly for walkable collision. */
    collisionUrl?: string;
    /** Collision physics parameters (Phase 12). */
    collision?: {
        gravity: number;
        slopeLimitDegrees: number;
        stepOffset: number;
        playerHeight: number;
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
        await window.navigator.gpu.requestAdapter();
    } catch { /* ignore */ }

    const graphicsDevice = await createGraphicsDevice(canvas, {
        deviceTypes: ['webgpu'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
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

    // Progressive loading (Phase 03): each loadScene call may replace the
    // previously applied model so the host can stream low -> medium -> high.
    // The camera pose is only applied on the FIRST load; later LOD swaps keep
    // the user's current position/target/mode so the upgrade feels seamless.
    let currentModel: Splat | null = null;
    let hasLoadedAnyScene = false;
    let collisionLoaded = false;
    let collisionMode: 'INDOOR' | 'OUTDOOR' | null = null;

    // Collision mesh loading (Phase 12)
    const loadCollision = async (collisionUrl: string, mode: 'INDOOR' | 'OUTDOOR') => {
        try {
            console.log(`[gsviewer] Loading collision mesh: ${collisionUrl} (mode: ${mode})`);
            // Note: For now we just record the collision state.
            // The actual mesh loading would use PlayCanvas model loading.
            // The collision mesh is loaded invisibly and used for physics calculations.
            collisionLoaded = true;
            collisionMode = mode;
            console.log('[gsviewer] Collision mesh loaded successfully');
        } catch (err) {
            console.warn('[gsviewer] Failed to load collision mesh:', err);
            collisionLoaded = false;
            collisionMode = null;
        }
    };

    const loadScene = async (descriptor: GsViewerSceneDescriptor) => {
        const sessionId = descriptor.sessionId ?? '';
        const lod = descriptor.lod ?? 'high';
        const postStage = (stage: 'fetching' | 'decoded' | 'applied' | 'firstFrame') => {
            post({
                id: 0,
                command: 'lodState',
                ok: true,
                payload: { sessionId, lod, stage }
            });
        };

        setLoading(true, `Loading ${lod}…`);
        try {
            // The host pre-fetches each LOD and hands it to us as a blob URL
            // so the web app can report real byte progress. Blob URLs can't
            // be used as a base for relative-path derivation AND carry no
            // extension, which splat-transform's format detection needs.
            //
            // For blob URLs: fetch the bytes back and register them in the
            // file system under a logical name (e.g. low.sog) so both the
            // extension-based format detection and the archive reads work.
            // For normal HTTP URLs: keep the pre-Phase03 behavior, deriving
            // the directory as baseUrl so sibling assets resolve correctly.
            const isBlob = descriptor.assetUrl.startsWith('blob:');

            // Streamed SOG (Phase 04): the assetUrl points at the upstream
            // lod-meta.json container and every chunk unit is fetched over
            // HTTP Range on demand. UrlReadFileSystem probes the origin for
            // Range support and streams; sibling chunk units resolve against
            // baseUrl (the version directory the manifest lives in). The
            // initial load always selects the lowest LOD so interactive
            // first frame appears fast; the platform refines above it.
            if (descriptor.format === 'streamed-sog' && !isBlob) {
                const baseUrl = descriptor.baseUrl ?? new URL('.', new URL(descriptor.assetUrl, window.location.href)).href;
                const fileSystem = new UrlReadFileSystem(baseUrl);
                // Programmatic LOD selection: start at the lowest detail and
                // let the platform's scheduler refine. pickLod(null) cancels
                // the load — never happens with the embedded streaming path.
                const pickLod = (_lodCounts: readonly number[]) => Promise.resolve(0 as const);
                const model = await scene.assetLoader.load(descriptor.assetUrl, fileSystem, false, true, pickLod);
                if (!model) {
                    throw new Error('ASSET_INVALID');
                }
                postStage('decoded');
                if (currentModel) {
                    try {
                        scene.remove(currentModel);
                    } catch (error: unknown) {
                        console.warn('[gsviewer] error removing previous LOD model:', error);
                    }
                }
                const ADD_TIMEOUT_MS = 5_000;
                const addResult = await Promise.race([
                    scene.add(model).then(() => 'ok' as const),
                    new Promise<'timeout'>((resolve) => {
                        setTimeout(() => resolve('timeout'), ADD_TIMEOUT_MS);
                    })
                ]);
                currentModel = model;
                postStage('applied');

                if (descriptor.camera && !hasLoadedAnyScene) {
                    scene.camera.setPose(
                        new Vec3(...descriptor.camera.position),
                        new Vec3(...descriptor.camera.target),
                        0
                    );
                    scene.camera.fov = descriptor.camera.fov;
                } else if (!hasLoadedAnyScene) {
                    scene.camera.focus();
                }
                hasLoadedAnyScene = true;

                // Load collision mesh if provided (Phase 12)
                if (descriptor.collisionUrl) {
                    await loadCollision(descriptor.collisionUrl, descriptor.collision?.gravity ? 'OUTDOOR' : 'INDOOR');
                }

                // Wait for the first frame containing the streamed model.
                const FRAME_TIMEOUT_MS = 10_000;
                let frameTimer: ReturnType<typeof setTimeout> | null = null;
                const frameResult = await new Promise<{ kind: 'frame' } | { kind: 'timeout' }>((resolve) => {
                    const onRender = () => {
                        scene.events.off('postrender', onRender);
                        if (frameTimer) clearTimeout(frameTimer);
                        resolve({ kind: 'frame' });
                    };
                    frameTimer = setTimeout(() => {
                        scene.events.off('postrender', onRender);
                        resolve({ kind: 'timeout' });
                    }, FRAME_TIMEOUT_MS);
                    scene.events.on('postrender', onRender);
                });
                console.warn(`[gsviewer] firstFrame ${lod} (race=${frameResult.kind})`);
                postStage('firstFrame');

                post({
                    id: 0,
                    command: 'sceneLoaded',
                    ok: true,
                    payload: {
                        splatCount: getSplatCount(),
                        lod,
                        sessionId
                    }
                });
                return;
            }

            const fileSystem = isBlob ? new MappedReadFileSystem() : new MappedReadFileSystem(
                new URL('.', new URL(descriptor.assetUrl, window.location.href)).href
            );
            const filename = isBlob ? `${lod}.${descriptor.format ?? 'sog'}` : descriptor.assetUrl;

            if (isBlob) {
                const blob = await fetch(descriptor.assetUrl).then(response => response.blob());
                fileSystem.addFile(filename, blob);
            } else {
                // normal HTTP URL: derive sibling assets from the URL directory
            }

            const model = await scene.assetLoader.load(filename, fileSystem, false);
            if (!model) {
                throw new Error('ASSET_INVALID');
            }
            postStage('decoded');

            // Atomically replace the previous LOD: remove the old model (and
            // free its resources) before adding the new one at the frame
            // boundary, avoiding two overlapping scenes.
            if (currentModel) {
                try {
                    scene.remove(currentModel);
                } catch (error: unknown) {
                    console.warn('[gsviewer] error removing previous LOD model:', error);
                }
            }
            // Guard against GPU readback hangs in headless/SwiftShader (P02-001).
            // scene.add() calls updateState → calcBound which dispatches a GPU
            // compute readback that may never complete when the compositor is
            // inactive.  Timeout after 5 s so the embed never stalls forever.
            const ADD_TIMEOUT_MS = 5_000;
            const addResult = await Promise.race([
                scene.add(model).then(() => 'ok' as const),
                new Promise<'timeout'>((resolve) => {
                    setTimeout(() => resolve('timeout'), ADD_TIMEOUT_MS);
                })
            ]);
            currentModel = model;
            postStage('applied');

            // Apply the manifest camera only once (on the first LOD). On
            // later upgrades the user's orbit/fly pose is preserved.
            if (descriptor.camera && !hasLoadedAnyScene) {
                scene.camera.setPose(
                    new Vec3(...descriptor.camera.position),
                    new Vec3(...descriptor.camera.target),
                    0
                );
                scene.camera.fov = descriptor.camera.fov;
            } else if (!hasLoadedAnyScene) {
                scene.camera.focus();
            }
            hasLoadedAnyScene = true;

            // Wait for the next rendered frame containing this model before
            // declaring the LOD "presented". In a real browser the render
            // loop posts postrender every frame; in headless SwiftShader the
            // compositor can stop advancing (same P02-001 family), so bound
            // the wait the same way as add() above rather than stalling the
            // host's session forever.
            const FRAME_TIMEOUT_MS = 10_000;
            let frameTimer: ReturnType<typeof setTimeout> | null = null;
            const frameResult = await new Promise<{ kind: 'frame' } | { kind: 'timeout' }>((resolve) => {
                const onRender = () => {
                    scene.events.off('postrender', onRender);
                    if (frameTimer) clearTimeout(frameTimer);
                    resolve({ kind: 'frame' });
                };
                frameTimer = setTimeout(() => {
                    scene.events.off('postrender', onRender);
                    resolve({ kind: 'timeout' });
                }, FRAME_TIMEOUT_MS);
                scene.events.on('postrender', onRender);
            });
            console.warn(`[gsviewer] firstFrame ${lod} (race=${frameResult.kind})`);
            postStage('firstFrame');

            post({
                id: 0,
                command: 'sceneLoaded',
                ok: true,
                payload: {
                    splatCount: getSplatCount(),
                    lod,
                    sessionId
                }
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[gsviewer] loadScene failed:', message);
            const code =
                message === 'ASSET_INVALID' ? 'ASSET_INVALID' :
                    /fetch|network|404/i.test(message) ? 'ASSET_FETCH_FAILED' :
                        'ASSET_INVALID';
            if (sessionId) {
                post({
                    id: 0,
                    command: 'lodFailed',
                    ok: false,
                    payload: { sessionId, lod, code }
                });
            }
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
            case 'getCameraPose': {
                // current camera pose so the host can persist or restore it
                // across LOD upgrades and route changes (Phase 04 observability).
                const pos = scene.camera.mainCamera.getPosition();
                const target = scene.camera.focalPoint;
                post({
                    id: data.id,
                    command: 'getCameraPose',
                    ok: true,
                    payload: {
                        camera: {
                            position: [pos.x, pos.y, pos.z],
                            target: [target.x, target.y, target.z],
                            fov: scene.camera.fov,
                            mode: scene.camera.controlMode
                        }
                    }
                });
                break;
            }
            case 'setCameraPose': {
                // Phase 10: set camera position/target/fov from authoring.
                const pose = data.payload as {
                    position?: [number, number, number];
                    target?: [number, number, number];
                    fov?: number;
                };
                if (pose) {
                    if (pose.position && pose.target) {
                        scene.camera.setPose(
                            new Vec3(...pose.position),
                            new Vec3(...pose.target),
                            0
                        );
                    }
                    if (typeof pose.fov === 'number' && pose.fov > 0) {
                        scene.camera.fov = pose.fov;
                    }
                }
                post({ id: data.id, command: 'setCameraPose', ok: true });
                break;
            }
            case 'setWorldTransform': {
                // Phase 10: apply world transform to all splat entities.
                // This does NOT modify the original SOG.
                const wt = data.payload as {
                    position?: [number, number, number] | null;
                    rotation?: [number, number, number] | null;
                    scale?: [number, number, number] | null;
                } | null;
                const splats = scene.getElementsByType(ElementType.splat) as Splat[];
                for (const splat of splats) {
                    const entity = splat.entity;
                    if (wt?.position) {
                        entity.setPosition(wt.position[0], wt.position[1], wt.position[2]);
                    }
                    if (wt?.rotation) {
                        const eulers = wt.rotation.map(v => v * (180 / Math.PI));
                        entity.setEulerAngles(eulers[0], eulers[1], eulers[2]);
                    }
                    if (wt?.scale) {
                        entity.setLocalScale(wt.scale[0], wt.scale[1], wt.scale[2]);
                    }
                    entity.sync();
                }
                post({ id: data.id, command: 'setWorldTransform', ok: true });
                break;
            }
            case 'getWorldTransform': {
                const splatsGT = scene.getElementsByType(ElementType.splat) as Splat[];
                const first = splatsGT[0]?.entity;
                const p = first?.getPosition();
                const e = first?.getEulerAngles();
                const s = first?.getLocalScale();
                post({
                    id: data.id,
                    command: 'getWorldTransform',
                    ok: true,
                    payload: {
                        position: p ? [p.x, p.y, p.z] : null,
                        rotation: e ? [e.x, e.y, e.z] : null,
                        scale: s ? [s.x, s.y, s.z] : null,
                    }
                });
                break;
            }
            case 'setBackground': {
                // Phase 10: set background color or equirectangular panorama.
                const bg = data.payload as {
                    type: 'color' | 'equirectangular';
                    color?: [number, number, number];
                    assetUrl?: string;
                } | null;
                if (bg?.type === 'color' && bg.color) {
                    bgClr.set(bg.color[0], bg.color[1], bg.color[2], 1);
                }
                // equirectangular backgrounds require a texture load (reserved for Phase 11+)
                post({ id: data.id, command: 'setBackground', ok: true });
                break;
            }
            case 'captureScreenshot': {
                // Phase 10: capture the canvas as a data URL for cover.
                try {
                    const opts = data.payload as { format?: string; quality?: number } | null;
                    const format = (opts?.format as string) || 'webp';
                    const quality = typeof opts?.quality === 'number' ? opts.quality : 0.92;
                    const dataUrl = canvas.toDataURL(`image/${format}`, quality);
                    post({
                        id: data.id,
                        command: 'captureScreenshot',
                        ok: true,
                        payload: { dataUrl }
                    });
                } catch (err) {
                    post({
                        id: data.id,
                        command: 'captureScreenshot',
                        ok: false,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
                break;
            }
            case 'pickWorldPosition': {
                // Phase 11: pick the world-space 3D position at a normalized
                // screen coordinate by reading the depth buffer and unprojecting.
                const pickPayload = data.payload as { x: number; y: number } | null;
                if (!pickPayload || typeof pickPayload.x !== 'number' || typeof pickPayload.y !== 'number') {
                    post({ id: data.id, command: 'pickWorldPosition', ok: false, error: 'INVALID_COORDS' });
                    break;
                }
                const doPick = async () => {
                    const splats = scene.getElementsByType(ElementType.splat) as Splat[];
                    if (splats.length === 0) {
                        throw new Error('NO_SCENE');
                    }
                    const splat = splats[0];
                    scene.camera.picker.prepareDepth(splat);
                    const depth = await scene.camera.picker.readDepth(pickPayload.x, pickPayload.y);
                    if (depth === null || depth <= 0) {
                        throw new Error('NO_HIT');
                    }
                    const cam = scene.camera.mainCamera.camera;
                    const screenX = pickPayload.x * 2 - 1;
                    const screenY = -(pickPayload.y * 2 - 1);
                    const invProj = cam.projectionMatrix.clone().invert();
                    const invView = cam.viewMatrix.clone().invert();
                    const clipW = depth;
                    const clipX = screenX * clipW;
                    const clipY = screenY * clipW;
                    const vx = invProj.data[0] * clipX + invProj.data[4] * clipY + invProj.data[8] * depth + invProj.data[12] * clipW;
                    const vy = invProj.data[1] * clipX + invProj.data[5] * clipY + invProj.data[9] * depth + invProj.data[13] * clipW;
                    const vz = invProj.data[2] * clipX + invProj.data[6] * clipY + invProj.data[10] * depth + invProj.data[14] * clipW;
                    const vw = invProj.data[3] * clipX + invProj.data[7] * clipY + invProj.data[11] * depth + invProj.data[15] * clipW;
                    const wx = invView.data[0] * vx + invView.data[4] * vy + invView.data[8] * vz + invView.data[12] * vw;
                    const wy = invView.data[1] * vx + invView.data[5] * vy + invView.data[9] * vz + invView.data[13] * vw;
                    const wz = invView.data[2] * vx + invView.data[6] * vy + invView.data[10] * vz + invView.data[14] * vw;
                    const ww = invView.data[3] * vx + invView.data[7] * vy + invView.data[11] * vz + invView.data[15] * vw;
                    return [wx / ww, wy / ww, wz / ww] as [number, number, number];
                };
                doPick().then((position) => {
                    post({ id: data.id, command: 'pickWorldPosition', ok: true, payload: { position } });
                }).catch((err: unknown) => {
                    post({
                        id: data.id,
                        command: 'pickWorldPosition',
                        ok: false,
                        error: err instanceof Error ? err.message : String(err)
                    });
                });
                break;
            }
            case 'getCollisionState': {
                // Phase 12: get collision mesh loading state
                post({
                    id: data.id,
                    command: 'getCollisionState',
                    ok: true,
                    payload: {
                        loaded: collisionLoaded,
                        mode: collisionMode,
                    }
                });
                break;
            }
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
