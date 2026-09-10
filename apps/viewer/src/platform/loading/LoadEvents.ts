/**
 * LoadEvents — shared types for the progressive-loading protocol.
 *
 * All events carry a `sessionId` so that a stale load session (the user
 * navigated away or switched scenes) can be detected and ignored by the host.
 */

/** LOD tier identifiers, ordered low -> medium -> high. */
export type LODLevel = 'low' | 'medium' | 'high';

export const LOD_LEVELS: readonly LODLevel[] = ['low', 'medium', 'high'];

/**
 * High-level load phase of the progressive state machine. Transitions are
 * driven exclusively by real observable events (fetch bytes, decode
 * completion, GPU application, first rendered frame); no timers are used.
 */
export type LoadPhase =
  | 'PREPARING'
  | 'FETCHING_LOW'
  | 'DECODING_LOW'
  | 'INTERACTIVE_LOW'
  | 'STREAMING_HIGH'
  | 'READY'
  | 'ERROR'
  | 'CANCELLED';

/** Decode/apply stages reported by the viewer embed for a single LOD. */
export type LODStage = 'fetching' | 'decoded' | 'applied' | 'firstFrame';

/** A single LOD tier as described by the scene manifest. */
export interface LODAssetRef {
  level: LODLevel;
  /** Relative asset URL (resolved against the manifest's scene directory). */
  assetUrl: string;
  gaussians: number;
  size: number;
  sha256?: string;
}

/** Error payload for a failed LOD load. */
export interface LODFailure {
  sessionId: string;
  lod: LODLevel;
  /** Short, stable error code, e.g. 'ASSET_FETCH_FAILED'. */
  code: string;
}

/** Live progress event emitted while the host drives a load session. */
export interface LoadProgress {
  sessionId: string;
  /** Aggregated 0..100 total progress (null while indeterminate). */
  percent: number | null;
  /** Current human-readable stage label. */
  phase: LoadPhase;
  /** Bytes read for the LOD currently being fetched. */
  loadedBytes: number;
  /** Total bytes for that LOD, when Content-Length is known. */
  totalBytes: number | null;
  /** True when the current fetch has no Content-Length. */
  indeterminate: boolean;
}
