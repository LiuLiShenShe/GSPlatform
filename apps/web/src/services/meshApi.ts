import { httpClient } from './http';

export interface MeshState {
  currentVersionId: string | null;
  available: boolean;
  reason?: string | null;
  algorithm?: '2dgs-tsdf' | 'nksr' | null;
  job?: {
    id: string; status: string; stage: string | null; progress: number;
    errorMessage?: string | null;
    result?: { vertices: number; faces: number; units: string; downloadUrl: string; meshModelId?: string; previewUrl?: string } | null;
  } | null;
}

const path = (sceneId: string) => `/scenes/${encodeURIComponent(sceneId)}/mesh`;
export const fetchMesh = async (sceneId: string) =>
  (await httpClient.get<MeshState>(path(sceneId))).data;
export const createMesh = async (sceneId: string, version: string) =>
  (await httpClient.post<MeshState>(path(sceneId), { expectedCurrentVersion: version })).data;
export const cancelMesh = async (sceneId: string, jobId: string) =>
  (await httpClient.post<MeshState>(`${path(sceneId)}/${encodeURIComponent(jobId)}/cancel`)).data;

export async function downloadMesh(sceneId: string, jobId: string) {
  const response = await httpClient.get(`${path(sceneId)}/${encodeURIComponent(jobId)}/download`,
    { responseType: 'blob', timeout: 0 });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sceneId}-mesh-meters.ply`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
