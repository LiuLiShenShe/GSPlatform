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
  /** Scene format: 'sog' | 'ply' | 'splat'. */
  format: 'sog' | 'ply' | 'splat';
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
}
