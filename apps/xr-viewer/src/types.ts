/**
 * Shared types for the XR Viewer.
 */

// -------------------------------------------------------------------
// Scene descriptor (matches desktop viewer format)
// -------------------------------------------------------------------

/** Scene descriptor — mirrors the desktop viewer's format. */
export interface XrSceneDescriptor {
    /** Unique scene identifier. */
    id: string;
    /** Human-readable title. */
    title: string;
    /** Scene format: 'sog' | 'ply' | 'splat' | 'streamed-sog'. */
    format: 'sog' | 'ply' | 'splat' | 'streamed-sog';
    /** Absolute or relative URL to the scene asset file. */
    assetUrl: string;
    /** Optional poster image URL. */
    posterUrl?: string;
    /** Optional initial camera pose. */
    camera?: {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
    };
    /** Progressive-loading tier label. */
    lod?: 'low' | 'medium' | 'high';
    /** Correlation id echoed back in lodState events. */
    sessionId?: string;
    /** Base URL for streamed-SOG resolution. */
    baseUrl?: string;
    /** Collision mesh URL (Phase 12). */
    collisionUrl?: string;
    /** Collision physics parameters (Phase 12). */
    collision?: {
        gravity: number;
        slopeLimitDegrees: number;
        stepOffset: number;
        playerHeight: number;
    };
}

// -------------------------------------------------------------------
// Viewpoints (Phase 10 — shared with desktop)
// -------------------------------------------------------------------

/** Camera viewpoint — same shape as API SceneViewpointOut. */
export interface XrViewpoint {
    id: string;
    name: string;
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    fov: number;
    orderIndex: number;
    enabled: boolean;
}

// -------------------------------------------------------------------
// Annotations (Phase 11)
// -------------------------------------------------------------------

/** 3D annotation — same shape as API SceneAnnotationOut. */
export interface XrAnnotation {
    id: string;
    title: string;
    description: string;
    anchorX: number;
    anchorY: number;
    anchorZ: number;
    style: 'LEADER_TEXT' | 'NUMBER_POPUP' | 'HIDDEN';
    contentType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'PANORAMA';
    textContent: string;
    mediaAssetId?: string;
    mediaUrl?: string;  // resolved URL (injected by loader or caller)
    textColor: string;
    textSize: number;
    fov: number;
    orderIndex: number;
    enabled: boolean;
}

// -------------------------------------------------------------------
// Navigation profiles (indoor / outdoor)
// -------------------------------------------------------------------

export interface XrNavigationProfile {
    /** Movement speed (m/s). */
    moveSpeed: number;
    /** Snap turn angle (degrees). */
    snapTurnDegrees: number;
    /** Step height that can be climbed without jumping (m). */
    stepOffset: number;
    /** Player eye height from ground (m). */
    playerHeight: number;
    /** Gravity acceleration (m/s²). */
    gravity: number;
}

export const INDOOR_PROFILE: XrNavigationProfile = {
    moveSpeed: 2.0,
    snapTurnDegrees: 45,
    stepOffset: 0.25,
    playerHeight: 1.7,
    gravity: 9.81,
};

export const OUTDOOR_PROFILE: XrNavigationProfile = {
    moveSpeed: 3.5,
    snapTurnDegrees: 30,
    stepOffset: 0.4,
    playerHeight: 1.8,
    gravity: 9.81,
};

// -------------------------------------------------------------------
// Background audio (Phase 11)
// -------------------------------------------------------------------

export interface XrBackgroundAudio {
    url: string;
    volume: number;
    loop: boolean;
    enabled: boolean;
}

// -------------------------------------------------------------------
// Input state (polled per frame)
// -------------------------------------------------------------------

export interface XrStickInput {
    x: number; // -1..1
    y: number; // -1..1
}

export interface XrButtonState {
    pressed: boolean;       // current frame
    justPressed: boolean;   // rising edge this frame
    value: number;          // 0..1 analog
}

export interface XrInputState {
    leftStick: XrStickInput;
    rightStick: XrStickInput;
    trigger: XrButtonState;
    grip: XrButtonState;
    aButton: XrButtonState;  // right controller
    bButton: XrButtonState;  // right controller
    menuButton: XrButtonState;
    leftPresent: boolean;
    rightPresent: boolean;
}

// -------------------------------------------------------------------
// Viewer statistics
// -------------------------------------------------------------------

/** Viewer statistics reported by the renderer. */
export interface XrViewerStats {
    fps: number;
    frameTimeMs: number;
    splatCount: number;
    renderer: 'webgpu' | 'webgl2' | 'null';
}
