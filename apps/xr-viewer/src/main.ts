/**
 * GSPlatform WebXR Viewer — Main Entry Point
 *
 * Initializes a PlayCanvas application with WebXR support for immersive
 * Gaussian scene viewing. Loads the same Scene Manifest / SOG / Streamed SOG
 * format as the desktop SuperSplat viewer.
 *
 * Architecture:
 *   XrRoot
 *     +-- PlayerRig
 *     |     `-- Camera
 *     +-- GaussianWorld
 *     +-- CollisionWorld
 *     +-- AnnotationRoot
 *     `-- XRUiRoot
 */

import { initXrApp } from './xr-app';

const canvas = document.getElementById('xr-canvas') as HTMLCanvasElement;
const statusEl = document.getElementById('status-text') as HTMLDivElement;
const enterVrBtn = document.getElementById('enter-vr-btn') as HTMLButtonElement;
const sceneInfoEl = document.getElementById('scene-info') as HTMLDivElement;
const errorOverlay = document.getElementById('error-overlay') as HTMLDivElement;
const errorMessage = document.getElementById('error-message') as HTMLParagraphElement;

function showError(msg: string) {
    errorMessage.textContent = msg;
    errorOverlay.classList.remove('hidden');
}

try {
    await initXrApp(canvas, {
        statusEl,
        enterVrBtn,
        sceneInfoEl,
        showError,
    });
} catch (err) {
    showError(err instanceof Error ? err.message : String(err));
}
