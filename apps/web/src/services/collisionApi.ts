/**
 * Collision API service (Phase 12).
 *
 * CRUD for collision assets and physics parameters for a given scene.
 */
import { httpClient } from './http';

export interface CollisionAsset {
  id: string;
  sceneId: string;
  mode: 'INDOOR' | 'OUTDOOR';
  status: 'NONE' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  assetId?: string;
  jobId?: string;
  gravity: number;
  slopeLimitDegrees: number;
  stepOffset: number;
  playerHeight: number;
  collisionEnabled: boolean;
  errorMessage?: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollisionBuildRequest {
  mode: 'INDOOR' | 'OUTDOOR';
  gravity?: number;
  slopeLimitDegrees?: number;
  stepOffset?: number;
  playerHeight?: number;
}

export interface CollisionUpdateRequest {
  gravity?: number;
  slopeLimitDegrees?: number;
  stepOffset?: number;
  playerHeight?: number;
  collisionEnabled?: boolean;
}

export interface CollisionBuildResponse {
  jobId: string;
  status: string;
  message: string;
}

// ------------------------------------------------------------------ //
// Read collision status
// ------------------------------------------------------------------ //

export async function getCollision(
  sceneId: string,
  signal?: AbortSignal,
): Promise<CollisionAsset> {
  const response = await httpClient.get<CollisionAsset>(
    `/scenes/${encodeURIComponent(sceneId)}/collision`,
    { signal },
  );
  return response.data;
}

// ------------------------------------------------------------------ //
// Build collision
// ------------------------------------------------------------------ //

export async function buildCollision(
  sceneId: string,
  request: CollisionBuildRequest,
  signal?: AbortSignal,
): Promise<CollisionBuildResponse> {
  const response = await httpClient.post<CollisionBuildResponse>(
    `/scenes/${encodeURIComponent(sceneId)}/collision/build`,
    request,
    { signal },
  );
  return response.data;
}

// ------------------------------------------------------------------ //
// Update collision params
// ------------------------------------------------------------------ //

export async function updateCollision(
  sceneId: string,
  request: CollisionUpdateRequest,
  signal?: AbortSignal,
): Promise<CollisionAsset> {
  const response = await httpClient.patch<CollisionAsset>(
    `/scenes/${encodeURIComponent(sceneId)}/collision`,
    request,
    { signal },
  );
  return response.data;
}

// ------------------------------------------------------------------ //
// Rebuild collision
// ------------------------------------------------------------------ //

export async function rebuildCollision(
  sceneId: string,
  signal?: AbortSignal,
): Promise<CollisionBuildResponse> {
  const response = await httpClient.post<CollisionBuildResponse>(
    `/scenes/${encodeURIComponent(sceneId)}/collision/rebuild`,
    {},
    { signal },
  );
  return response.data;
}
