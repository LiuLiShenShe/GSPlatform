/**
 * Scene Presentation API service (Phase 10).
 *
 * CRUD for presentation settings (camera, transform, background, cover)
 * and viewpoints for a given scene.
 */
import { httpClient } from './http';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ScenePresentation {
  worldPosition?: Vec3;
  worldRotation?: Vec3;
  worldScale?: Vec3;
  initialCameraPosition?: Vec3;
  initialCameraTarget?: Vec3;
  initialCameraFov?: number;
  backgroundType: 'color' | 'equirectangular';
  backgroundColor?: Vec3;
  backgroundAssetId?: string;
  backgroundMetadata?: Record<string, unknown>;
  coverAssetId?: string;
  coverUrl?: string;
  backgroundAudioAssetId?: string;
  backgroundAudioVolume: number;
  backgroundAudioLoop: boolean;
  backgroundAudioEnabled: boolean;
}

export interface SceneViewpoint {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
  orderIndex: number;
  enabled: boolean;
}

// ------------------------------------------------------------------ //
// Presentation settings
// ------------------------------------------------------------------ //

export async function getPresentation(
  sceneId: string,
  signal?: AbortSignal,
): Promise<ScenePresentation> {
  const response = await httpClient.get<ScenePresentation>(
    `/scenes/${encodeURIComponent(sceneId)}/presentation`,
    { signal },
  );
  return response.data;
}

export async function updatePresentation(
  sceneId: string,
  patch: Partial<Omit<ScenePresentation, 'coverUrl' | 'backgroundAssetId' | 'coverAssetId'>>,
  signal?: AbortSignal,
): Promise<ScenePresentation> {
  const response = await httpClient.patch<ScenePresentation>(
    `/scenes/${encodeURIComponent(sceneId)}/presentation`,
    patch,
    { signal },
  );
  return response.data;
}

// ------------------------------------------------------------------ //
// Cover & Background image upload
// ------------------------------------------------------------------ //

export async function uploadCover(
  sceneId: string,
  file: File,
  signal?: AbortSignal,
): Promise<ScenePresentation> {
  const form = new FormData();
  form.append('file', file);
  const response = await httpClient.post<ScenePresentation>(
    `/scenes/${encodeURIComponent(sceneId)}/presentation/cover`,
    form,
    { signal, headers: { 'Content-Type': 'multipart/form-data' } },
  );
  return response.data;
}

export async function uploadBackground(
  sceneId: string,
  file: File,
  opts?: { latitude?: number; longitude?: number; signal?: AbortSignal },
): Promise<ScenePresentation> {
  const form = new FormData();
  form.append('file', file);
  if (opts?.latitude !== undefined) form.append('latitude', String(opts.latitude));
  if (opts?.longitude !== undefined) form.append('longitude', String(opts.longitude));
  const response = await httpClient.post<ScenePresentation>(
    `/scenes/${encodeURIComponent(sceneId)}/presentation/background`,
    form,
    { signal: opts?.signal, headers: { 'Content-Type': 'multipart/form-data' } },
  );
  return response.data;
}

// ------------------------------------------------------------------ //
// Viewpoints
// ------------------------------------------------------------------ //

export async function listViewpoints(
  sceneId: string,
  signal?: AbortSignal,
): Promise<SceneViewpoint[]> {
  const response = await httpClient.get<SceneViewpoint[]>(
    `/scenes/${encodeURIComponent(sceneId)}/viewpoints`,
    { signal },
  );
  return response.data;
}

export async function createViewpoint(
  sceneId: string,
  payload: { name: string; position: Vec3; target: Vec3; fov: number },
  signal?: AbortSignal,
): Promise<SceneViewpoint> {
  const response = await httpClient.post<SceneViewpoint>(
    `/scenes/${encodeURIComponent(sceneId)}/viewpoints`,
    payload,
    { signal },
  );
  return response.data;
}

export async function updateViewpoint(
  sceneId: string,
  viewpointId: string,
  patch: Partial<Pick<SceneViewpoint, 'name' | 'position' | 'target' | 'fov' | 'orderIndex' | 'enabled'>>,
  signal?: AbortSignal,
): Promise<SceneViewpoint> {
  const response = await httpClient.patch<SceneViewpoint>(
    `/scenes/${encodeURIComponent(sceneId)}/viewpoints/${encodeURIComponent(viewpointId)}`,
    patch,
    { signal },
  );
  return response.data;
}

export async function deleteViewpoint(
  sceneId: string,
  viewpointId: string,
  signal?: AbortSignal,
): Promise<void> {
  await httpClient.delete(
    `/scenes/${encodeURIComponent(sceneId)}/viewpoints/${encodeURIComponent(viewpointId)}`,
    { signal },
  );
}

export async function reorderViewpoints(
  sceneId: string,
  viewpointIds: string[],
  signal?: AbortSignal,
): Promise<SceneViewpoint[]> {
  const response = await httpClient.patch<SceneViewpoint[]>(
    `/scenes/${encodeURIComponent(sceneId)}/viewpoints/reorder`,
    { viewpointIds },
    { signal },
  );
  return response.data;
}
