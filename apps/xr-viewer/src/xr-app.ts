/**
 * XR Application — PlayCanvas + WebXR bootstrap for immersive Gaussian scenes.
 *
 * Creates the PlayCanvas AppBase, sets up WebXR session management, and loads
 * scenes from the same manifest format used by the desktop viewer.
 */

import {
    AppBase,
    AppOptions,
    CameraComponent,
    CameraComponentSystem,
    Color,
    ContainerHandler,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSplatComponentSystem,
    GSplatHandler,
    LightComponentSystem,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    TextureHandler,
    createGraphicsDevice,
    XRTYPE_VR,
    XRSPACE_LOCALFLOOR,
} from 'playcanvas';

import { XrSceneLoader } from './scene-loader';
import type { XrSceneDescriptor } from './types';

interface XrAppElements {
    statusEl: HTMLDivElement;
    enterVrBtn: HTMLButtonElement;
    sceneInfoEl: HTMLDivElement;
    showError: (msg: string) => void;
}

// Default scene descriptor — overridden by URL query params or postMessage.
const DEFAULT_DESCRIPTOR: XrSceneDescriptor = {
    id: 'demo',
    format: 'sog',
    assetUrl: '',
    title: 'GSPlatform XR Scene',
};

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
    };
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
    //     |     `-- Camera
    //     +-- GaussianWorld (splats go here)
    //     +-- CollisionWorld (invisible collision proxy)
    //     +-- AnnotationRoot (3D annotations)
    //     `-- XRUiRoot (2D UI panels in VR)

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

    // --- Light ---
    const light = new Entity('ambient-light');
    light.addComponent('light', { type: 'ambient', color: new Color(1, 1, 1) });
    app.root.addChild(light);

    // --- WebXR setup ---
    const xr = app.xr!;

    statusEl.textContent = 'Checking WebXR support…';

    if (!xr.supported) {
        statusEl.textContent = 'WebXR not supported by this browser.';
        enterVrBtn.disabled = true;
        sceneInfoEl.textContent = 'WebXR unavailable — desktop mode only.';
        // Still allow desktop viewing without VR
        return initDesktopOnly(app, canvas, statusEl, sceneInfoEl);
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

    // --- Load scene from URL ---
    const descriptor = readDescriptorFromUrl();

    if (descriptor.assetUrl) {
        statusEl.textContent = `Loading scene: ${descriptor.title}…`;

        try {
            const loader = new XrSceneLoader(app);
            await loader.loadScene(gaussianWorld, descriptor);
            statusEl.textContent = 'Scene loaded.';
            sceneInfoEl.textContent += `  |  Scene: ${descriptor.title}`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showError(`Failed to load scene: ${msg}`);
        }
    } else {
        statusEl.textContent = 'Ready — no scene specified.';
        sceneInfoEl.textContent += '  |  Pass ?url=<sog-url> to load a scene.';
    }
}

/**
 * Desktop-only fallback — no WebXR, just a basic orbit camera.
 */
async function initDesktopOnly(
    app: AppBase,
    canvas: HTMLCanvasElement,
    statusEl: HTMLDivElement,
    sceneInfoEl: HTMLDivElement,
) {
    statusEl.textContent = 'Desktop mode (no VR).';

    // Simple keyboard orbit as fallback
    let angle = 0;
    app.on('update', (dt: number) => {
        angle += dt * 0.3;
        const camera = app.root.findByName('Camera');
        if (camera) {
            camera.setPosition(
                Math.sin(angle) * 3,
                1.7,
                Math.cos(angle) * 3,
            );
            camera.lookAt(0, 1.7, 0);
        }
    });
}
