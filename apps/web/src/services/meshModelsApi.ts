import { httpClient } from './http';

export interface MeshModel {
  id: string; title: string; sceneId: string; sceneSlug: string; sceneTitle: string;
  sourceVersionId: string; isCurrentSource: boolean; algorithm: 'nksr' | '2dgs-tsdf';
  units: 'm' | 'scene'; vertices: number; faces: number; sizeBytes: number;
  sha256: string; createdAt: string; downloadUrl: string; previewUrl: string; jobId: string | null;
}
export interface MeshModelsList { items: MeshModel[]; total: number; page: number; pageSize: number }
export const fetchMeshModels = async (params: { q?: string; algorithm?: string; sort?: string; page?: number }, signal?: AbortSignal) =>
  (await httpClient.get<MeshModelsList>('/mesh-models', { params, signal })).data;
export const fetchMeshModel = async (id: string, signal?: AbortSignal) =>
  (await httpClient.get<MeshModel>(`/mesh-models/${encodeURIComponent(id)}`, { signal })).data;
export const fetchMeshFile = async (id: string, signal?: AbortSignal, onProgress?: (percent: number) => void) =>
  (await httpClient.get<ArrayBuffer>(`/mesh-models/${encodeURIComponent(id)}/file`, {
    signal, responseType: 'arraybuffer', timeout: 0,
    onDownloadProgress: event => { if (event.total) onProgress?.(Math.round(event.loaded / event.total * 100)); },
  })).data;
export async function downloadMeshModel(model: MeshModel) {
  const data = await fetchMeshFile(model.id);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${model.title}-${model.units === 'm' ? 'meters' : 'scene-units'}.ply`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
