/**
 * XR Application — PlayCanvas + WebXR bootstrap for immersive Gaussian scenes.
 *
 * Phase 14 adds PICO interaction to the Phase 13 viewer:
 *
 *   left stick  → head-relative locomotion (with gravity + collision)
 *   right stick → snap turn
 *   A / B       → next / previous viewpoint (Phase 10 data, shared)
 *   trigger     → select annotation (Phase 11 data, shared) → media panel
 *   grip/menu   → dismiss panel
 *
 * Layout:  XrRoot → PlayerRig → Camera (+ FadeScreen child)
 *          GaussianWorld (splats)
 *          CollisionWorld (invisible collision proxy)
 *          AnnotationRoot (3D annotations)
 *          XRUiRoot (media panel)
 */

import {
    AppBase,
    AppOptions,
    CameraComponent,
    CameraComponentSystem,
    Color,
    ContainerHandler,
    ElementComponentSystem,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSplatComponentSystem,
    GSplatHandler,
    LightComponentSystem,
    RenderComponentSystem,
    RESOLUTION_AUTO,
    ScreenComponentSystem,
    TextureHandler,
    createGraphicsDevice,
    XRTYPE_VR,
    XRSPACE_LOCALFLOOR,
} from 'playcanvas';

import { XrSceneLoader } from './scene-loader';
import type { XrSceneDescriptor } from './types';
import { XrInputManager } from './input-manager';
import { CollisionRaycaster } from './collision-raycaster';
import { Locomotion } from './locomotion';
import { FadeOverlay } from './fade-overlay';
import { ViewpointManager } from './viewpoint-manager';
import { Interaction } from './interaction';
import { loadXrData } from './data-loader';
import { INDOOR_PROFILE, OUTDOOR_PROFILE } from './types';

interface XrAppElements {
    statusEl: HTMLDivElement;
    enterVrBtn: HTMLButtonElement;
    sceneInfoEl: HTMLDivElement;
    showError: (msg: string) => void;
}

/**
 * Read the scene descriptor from the URL query string.
 *
 * Expected params:
 *   ?url=<assetUrl>&format=sog|ply|splat|streamed-sog&id=<sceneId>&title=<title>
 */
function readDescriptorFromUrl(): XrSceneDescriptor {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('url') ?? '';
    return {
        id: params.get('id') ?? 'unknown',
        format: (params.get('format') as XrSceneDescriptor['format']) ?? 'sog',
        assetUrl: url,
        title: params.get('title') ?? 'GSPlatform XR Scene',
        collisionUrl: params.get('collisionUrl') ?? undefined,
        collision: params.get('gravity')
            ? {
                gravity: Number(params.get('gravity')),
                slopeLimitDegrees: Number(params.get('slopeLimit') ?? 45),
                stepOffset: Number(params.get('stepOffset') ?? 0.3),
                playerHeight: Number(params.get('playerHeight') ?? 1.7),
            }
            : undefined,
    };
}

/** Pick the locomotion profile from URL or collision params. */
function pickProfile(descriptor: XrSceneDescriptor) {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('profile');
    let profile = requested === 'indoor' ? INDOOR_PROFILE : OUTDOOR_PROFILE;

    // Override with Phase 12 collision parameters if supplied.
    if (descriptor.collision) {
        profile = { ...profile, ...descriptor.collision };
    }
    return profile;
}

/**
 * Initialize the XR application.
 */
export async function initXrApp(canvas: HTMLCanvasElement, elements: XrAppElements) {
    const { statusEl, enterVrBtn, sceneInfoEl, showError } = elements;

    statusEl.textContent = 'Creating graphics device…';

    // --- Graphics device (WebGPU preferred, WebGL2 fallback) ---
    const gfxOptions = {
        deviceTypes: ['webgpu', 'webgl2'],
        xrCompatible: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance' as const,
    };

    let graphicsDevice: Awaited<ReturnType<typeof createGraphicsDevice>>;
    try {
        graphicsDevice = await createGraphicsDevice(canvas, gfxOptions);
    } catch {
        showError('WebGPU / WebGL2 not available in this browser.');
        return;
    }

    if ((graphicsDevice as any).isNull) {
        showError('Graphics device creation returned null.');
        return;
    }

    statusEl.textContent = 'Initializing engine…';

    // --- PlayCanvas App ---
    const createOptions = new AppOptions();
    createOptions.graphicsDevice = graphicsDevice;

    createOptions.componentSystems = [
        RenderComponentSystem,
        CameraComponentSystem,
        LightComponentSystem,
        GSplatComponentSystem,
        ScreenComponentSystem,
        ElementComponentSystem,
    ];
    createOptions.resourceHandlers = [TextureHandler, ContainerHandler, GSplatHandler];

    const app = new AppBase(canvas);
    app.init(createOptions);
    app.start();

    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    // Handle resize
    const onResize = () => app.resizeCanvas();
    window.addEventListener('resize', onResize);
    app.on('destroy', () => window.removeEventListener('resize', onResize));

    // --- Scene hierarchy ---
    //
    //   XrRoot
    //     +-- PlayerRig (camera rig)
    //     |     `-- Camera (+ FadeScreen child)
    //     +-- GaussianWorld (splats go here)
    //     +-- CollisionWorld (invisible collision proxy)
    //     +-- AnnotationRoot (3D annotations)
    //     `-- XRUiRoot (media panel)

    const xrRoot = new Entity('XrRoot');
    app.root.addChild(xrRoot);

    const playerRig = new Entity('PlayerRig');
    xrRoot.addChild(playerRig);

    const cameraEntity = new Entity('Camera');
    cameraEntity.addComponent('camera', {
        clearColor: new Color(0, 0, 0, 1),
        fov: 70,
        nearClip: 0.1,
        farClip: 1000,
    });
    playerRig.addChild(cameraEntity);

    // Position camera at typical standing height
    playerRig.setPosition(0, 1.7, 0);

    const gaussianWorld = new Entity('GaussianWorld');
    xrRoot.addChild(gaussianWorld);

    const collisionWorld = new Entity('CollisionWorld');
    xrRoot.addChild(collisionWorld);

    const annotationRoot = new Entity('AnnotationRoot');
    xrRoot.addChild(annotationRoot);

    const xrUiRoot = new Entity('XRUiRoot');
    xrRoot.addChild(xrUiRoot);

    // Gaussian splats render via their own shader pipeline — no scene light
    // entity needed. (PlayCanvas 2.22 dropped LIGHTTYPE_AMBIENT.)

    // --- Phase 14 subsystem wiring ---
    const fadeOverlay = new FadeOverlay(app, cameraEntity);
    fadeOverlay.setOpacity(0);

    const collision = new CollisionRaycaster(app);
    const inputManager = new XrInputManager(app);
    const profile = pickProfile(readDescriptorFromUrl());
    const locomotion = new Locomotion({
        rig: playerRig,
        camera: cameraEntity,
        collision,
        profile,
    });
    const viewpointManager = new ViewpointManager({
        rig: playerRig,
        camera: cameraEntity,
        fade: fadeOverlay,
        collision,
        profile,
    });
    const interaction = new Interaction({
        app,
        camera: cameraEntity,
        rig: playerRig,
        annotationRoot,
        uiRoot: xrUiRoot,
    });

    // Scene descriptor is needed by both the headless and XR paths.
    const descriptor = readDescriptorFromUrl();

    // --- WebXR setup ---
    const xr = app.xr;

    statusEl.textContent = 'Checking WebXR support…';

    if (!xr) {
        statusEl.textContent = 'WebXR manager unavailable (headless).';
        enterVrBtn.disabled = true;
        sceneInfoEl.textContent = `WebXR unavailable — desktop mode only. | ${app.graphicsDevice.width}×${app.graphicsDevice.height}`;
        // Load scene + data anyway for testing
        await loadDescriptors(app, gaussianWorld, sceneInfoEl, descriptor, collision, viewpointManager, interaction);
        // Simple orbit for headless
        let angle = 0;
        app.on('update', (dt: number) => {
            angle += dt * 0.3;
            const cam = app.root.findByName('Camera');
            if (cam) { cam.setPosition(Math.sin(angle)*3, 1.7, Math.cos(angle)*3); cam.lookAt(0, 1.7, 0); }
        });
        return;
    }

    const vrAvailable = xr.isAvailable(XRTYPE_VR);
    sceneInfoEl.textContent = vrAvailable
        ? `WebXR VR: available  |  ${app.graphicsDevice.width}×${app.graphicsDevice.height}`
        : `WebXR VR: unavailable  |  ${app.graphicsDevice.width}×${app.graphicsDevice.height}`;

    statusEl.textContent = vrAvailable ? 'Ready — click "Enter VR"' : 'VR device not detected.';

    // --- Enter VR button ---
    enterVrBtn.disabled = !vrAvailable;
    enterVrBtn.textContent = vrAvailable ? 'Enter VR' : 'VR Not Available';

    const cameraComp = cameraEntity.camera!;
    enterVrBtn.addEventListener('click', () => {
        if (xr.supported && xr.isAvailable(XRTYPE_VR)) {
            xr.start(cameraComp, XRTYPE_VR, XRSPACE_LOCALFLOOR);
        }
    });

    // --- XR session events ---
    xr.on('start', () => {
        statusEl.textContent = 'VR Session Active';
        enterVrBtn.textContent = 'Exit VR';
        enterVrBtn.onclick = () => xr.end();
    });

    xr.on('end', () => {
        statusEl.textContent = 'VR Session Ended';
        enterVrBtn.textContent = 'Enter VR';
        enterVrBtn.disabled = !xr.isAvailable(XRTYPE_VR);
        enterVrBtn.onclick = () => {
            if (xr.isAvailable(XRTYPE_VR)) {
                xr.start(cameraComp, XRTYPE_VR, XRSPACE_LOCALFLOOR);
            }
        };
    });

    xr.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        statusEl.textContent = `XR Error: ${msg}`;
        console.error('[xr] session error:', err);
    });

    // --- Load scene + shared data (viewpoints, annotations, audio) ---
    await loadDescriptors(app, gaussianWorld, sceneInfoEl, descriptor, collision, viewpointManager, interaction);

    // --- Per-frame update ---
    app.on('update', (dt: number) => {
        const active = xr.session != null;
        if (!active) return;

        const input = inputManager.update(dt);
        locomotion.update(input, dt);
        viewpointManager.handleInput(input);
        viewpointManager.update(dt);
        interaction.update(input, dt);
    });
}

/**
 * Load the scene splat + collision mesh and the shared Phase 10/11 data
 * (viewpoints, annotations, background audio). Shared by both the XR and
 * headless paths.
 */
async function loadDescriptors(
    app: AppBase,
    gaussianWorld: Entity,
    sceneInfoEl: HTMLDivElement,
    descriptor: XrSceneDescriptor,
    collision: CollisionRaycaster,
    viewpointManager: ViewpointManager,
    interaction: Interaction,
) {
    if (descriptor.assetUrl) {
        try {
            const loader = new XrSceneLoader(app);
            await loader.loadScene(gaussianWorld, descriptor);

            // Index the collision mesh now that it's loaded (if any).
            collision.collectMeshInstances();
            console.log(`[xr] collision mesh instances: ${collision.count}`);

            sceneInfoEl.textContent += `  |  Scene: ${descriptor.title}`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[xr] scene load failed:', err);
            sceneInfoEl.textContent += `  |  Scene load FAILED: ${msg}`;
        }
    }

    // Load shared Phase 10/11/12 data (viewpoints, annotations, audio).
    try {
        const data = await loadXrData();
        viewpointManager.setViewpoints(data.viewpoints);
        interaction.setAnnotations(data.annotations);
        if (data.backgroundAudio) {
            interaction.setBackgroundAudio(data.backgroundAudio);
        }
        sceneInfoEl.textContent += `  |  VPs: ${viewpointManager.count}  |  Annot: ${data.annotations.length}`;
    } catch (err) {
        console.warn('[xr] shared data load failed:', err);
    }
}
