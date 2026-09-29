/**
 * Scene Annotation API service (Phase 11).
 *
 * CRUD for 3D spatial annotations anchored to Gaussian surface positions,
 * plus background audio settings for the scene presentation.
 */
import { httpClient } from './http';

// ------------------------------------------------------------------ //
// Types
// ------------------------------------------------------------------ //

export type AnnotationStyle = 'LEADER_TEXT' | 'NUMBER_POPUP' | 'HIDDEN';
export type AnnotationContentType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'PANORAMA';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SceneAnnotation {
  id: string;
  title: string;
  description: string;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  style: AnnotationStyle;
  contentType: AnnotationContentType;
  textContent: string;
  mediaAssetId?: string;
  textColor: string;
  textSize: number;
  fov: number;
  /** 标注自身相机（FIX-02 §12）—— 拾取锚点时保存的 Viewer pose；null = 未保存。 */
  cameraPosition?: Vec3 | null;
  cameraTarget?: Vec3 | null;
  cameraFov?: number | null;
  orderIndex: number;
  enabled: boolean;
}

export interface BackgroundAudioSettings {
  assetId?: string;
  volume: number;
  loop: boolean;
  enabled: boolean;
}

// ------------------------------------------------------------------ //
// Background Audio
// ------------------------------------------------------------------ //

export async function updateBackgroundAudio(
  sceneId: string,
  patch: Partial<BackgroundAudioSettings>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await httpClient.patch(
    `/scenes/${encodeURIComponent(sceneId)}/presentation/background-audio`,
    patch,
    { signal },
  );
  return response.data;
}

// ------------------------------------------------------------------ //
// Annotations
// ------------------------------------------------------------------ //

export async function listAnnotations(
  sceneId: string,
  signal?: AbortSignal,
): Promise<SceneAnnotation[]> {
  const response = await httpClient.get<SceneAnnotation[]>(
    `/scenes/${encodeURIComponent(sceneId)}/annotations`,
    { signal },
  );
  return response.data;
}

export async function createAnnotation(
  sceneId: string,
  payload: {
    title?: string;
    description?: string;
    anchorX: number;
    anchorY: number;
    anchorZ: number;
    style?: AnnotationStyle;
    contentType?: AnnotationContentType;
    textContent?: string;
    mediaAssetId?: string;
    textColor?: string;
    textSize?: number;
    fov?: number;
    /** 标注自己的相机（§13：拾取时捕获的当前 Viewer pose）。 */
    cameraPosition?: Vec3;
    cameraTarget?: Vec3;
    cameraFov?: number;
  },
  signal?: AbortSignal,
): Promise<SceneAnnotation> {
  const response = await httpClient.post<SceneAnnotation>(
    `/scenes/${encodeURIComponent(sceneId)}/annotations`,
    payload,
    { signal },
  );
  return response.data;
}

export async function updateAnnotation(
  sceneId: string,
  annotationId: string,
  patch: Partial<Pick<
    SceneAnnotation,
    | 'title'
    | 'description'
    | 'anchorX'
    | 'anchorY'
    | 'anchorZ'
    | 'style'
    | 'contentType'
    | 'textContent'
    | 'mediaAssetId'
    | 'textColor'
    | 'textSize'
    | 'fov'
    | 'cameraPosition'
    | 'cameraTarget'
    | 'cameraFov'
    | 'orderIndex'
    | 'enabled'
  >>,
  signal?: AbortSignal,
): Promise<SceneAnnotation> {
  const response = await httpClient.patch<SceneAnnotation>(
    `/scenes/${encodeURIComponent(sceneId)}/annotations/${encodeURIComponent(annotationId)}`,
    patch,
    { signal },
  );
  return response.data;
}

export async function deleteAnnotation(
  sceneId: string,
  annotationId: string,
  signal?: AbortSignal,
): Promise<void> {
  await httpClient.delete(
    `/scenes/${encodeURIComponent(sceneId)}/annotations/${encodeURIComponent(annotationId)}`,
    { signal },
  );
}

export async function reorderAnnotations(
  sceneId: string,
  annotationIds: string[],
  signal?: AbortSignal,
): Promise<SceneAnnotation[]> {
  const response = await httpClient.patch<SceneAnnotation[]>(
    `/scenes/${encodeURIComponent(sceneId)}/annotations/reorder`,
    { annotationIds },
    { signal },
  );
  return response.data;
}
