/**
 * Scene version history API (GS-NEXT-11).
 *
 * Both endpoints are strictly owner-scoped. The list deliberately exposes only
 * real fields (version id, created time, format, size, gaussian count) — never
 * storage paths or private resource URLs.
 */
import { httpClient } from './http';

export interface SceneVersionItem {
  id: string;
  assetVersion: string;
  format: string;
  sizeBytes: number;
  sha256: string | null;
  gaussianCount: number | null;
  lodLevels: number | null;
  createdAt: string;
  isCurrent: boolean;
  manifestReady: boolean;
  assetsReady: boolean;
  entryName: string | null;
}

export interface SpatialBinding {
  state: 'VALID' | 'STALE' | 'NONE';
  boundVersionId: string | null;
  requiresConfirmation: boolean;
  staleAt: string | null;
  /** GS-NEXT-12: monotonic invalidation revision. */
  revision?: number;
  /** Features still awaiting re-confirmation on the current version. */
  pendingFeatures?: string[];
  /** Features already trusted for the current version. */
  confirmedFeatures?: string[];
}

export interface SceneVersionList {
  items: SceneVersionItem[];
  meta: { limit: number; nextCursor: string | null; total: number | null };
  currentVersionId: string | null;
  spatial: SpatialBinding;
}

export interface VersionActivateResult {
  message: string;
  sceneId: string;
  previousVersionId: string | null;
  currentVersionId: string;
  changed: boolean;
  spatial: SpatialBinding;
  collisionPolicy: string | null;
  affectedSpatialFeatures: string[];
}

export async function listSceneVersions(
  sceneId: string,
  options?: { limit?: number; cursor?: string | null; signal?: AbortSignal },
): Promise<SceneVersionList> {
  const params: Record<string, string | number> = {};
  if (options?.limit) params.limit = options.limit;
  if (options?.cursor) params.cursor = options.cursor;
  const response = await httpClient.get<SceneVersionList>(
    `/scenes/${encodeURIComponent(sceneId)}/versions`,
    { params, signal: options?.signal },
  );
  return response.data;
}

/**
 * Re-activate (roll back to) an existing immutable version.
 *
 * `expectedCurrentVersionId` is the optimistic-concurrency token: the id the
 * client believes is current. A 409 means someone else moved the pointer first
 * and the panel must refresh instead of retrying blindly.
 */
export async function activateSceneVersion(
  sceneId: string,
  versionId: string,
  expectedCurrentVersionId: string | null,
  signal?: AbortSignal,
): Promise<VersionActivateResult> {
  const response = await httpClient.post<VersionActivateResult>(
    `/scenes/${encodeURIComponent(sceneId)}/versions/${encodeURIComponent(versionId)}/activate`,
    { expectedCurrentVersionId },
    { signal },
  );
  return response.data;
}
