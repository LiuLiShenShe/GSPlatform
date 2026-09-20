/**
 * Scene descriptor DTO — controlled input for scene loading.
 * All fields are validated by the adapter before being forwarded to the renderer.
 * No arbitrary URLs are passed directly; only this DTO is accepted.
 */
export interface SceneDescriptor {
  /** Unique scene identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Scene format: 'sog' | 'ply' | 'splat' | 'streamed-sog'. */
  format: 'sog' | 'ply' | 'splat' | 'streamed-sog';
  /** Absolute or relative URL to the scene asset file. */
  assetUrl: string;
  /** Optional poster image URL (used for preloading in future phases). */
  posterUrl?: string;
  /** SHA-256 checksum of the asset file. */
  sha256?: string;
  /** Optional initial camera pose. */
  camera?: {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
  };
  /**
   * Progressive-loading metadata (Phase 03).
   * `lod` names which quality tier this descriptor represents and `sessionId`
   * lets the embed correlation events back to the load session that issued
   * the load. Both are optional so pre-existing callers keep working.
   */
  lod?: 'low' | 'medium' | 'high';
  sessionId?: string;
  /**
   * Collision mesh URL (Phase 12). The viewer loads this GLB as an invisible
   * physics proxy for walkable collision. When present, the fly-mode camera
   * controller respects gravity, slope limits, step offsets, and player height.
   */
  collisionUrl?: string;
  /** Collision physics parameters (Phase 12). */
  collision?: {
    gravity: number;
    slopeLimitDegrees: number;
    stepOffset: number;
    playerHeight: number;
  };
}
