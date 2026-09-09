/**
 * GSPlatform Viewer Platform API.
 *
 * This is the only public contract the web app may depend on when integrating
 * the SuperSplat Viewer fork. It exposes a typed, minimal surface for creating
 * a viewer, loading scenes, controlling the camera and reading real stats.
 *
 * The web app never imports PlayCanvas or any viewer internal module.
 */
export { createViewer } from './ViewerAdapter';
export type {
    CreateViewerOptions,
    ViewerCameraMode,
    ViewerEventMap,
    ViewerHandle,
    ViewerStats
} from './ViewerAdapter';
export type { SceneDescriptor } from './SceneDescriptor';
export { codeToUserMessage, ViewerError } from './ViewerError';
export type { ViewerErrorCode, ViewerErrorDetail } from './ViewerError';
