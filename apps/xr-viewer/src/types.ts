/**
 * Shared types for the XR Viewer.
 */

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

/** Viewer statistics reported by the renderer. */
export interface XrViewerStats {
    fps: number;
    frameTimeMs: number;
    splatCount: number;
    renderer: 'webgpu' | 'webgl2' | 'null';
}
