import { httpClient } from './http';

export interface MeshModel {
  glbStatus?: string;
  id: string; title: string; sceneId: string; sceneSlug: string; sceneTitle: string;
  sourceVersionId: string; isCurrentSource: boolean; algorithm: 'nksr' | '2dgs-tsdf';
  units: 'cm' | 'm' | 'scene'; vertices: number; faces: number; sizeBytes: number;
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
  anchor.href = url; anchor.download = `${model.title}-${model.units === 'cm' ? 'centimeters' : model.units === 'm' ? 'meters' : 'scene-units'}.ply`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export interface GlbMetadata {
  sourceUnits?: 'cm' | 'm'; unitConversionScale?: number;
  sourceToAssetMatrix: number[][]; sourceBounds: number[][]; assetBounds: number[][];
  dimensionsMeters: number[]; pivotPolicy: string; vertices: number; faces: number;
  validator: { issues: { numErrors: number; numWarnings: number } };
}
export interface GlbVariant {
  retryable?: boolean;
  id: string; status: 'QUEUED'|'RUNNING'|'READY'|'FAILED'; format: 'glb'; sourcePlySha256: string;
  sha256: string|null; sizeBytes: number|null; converterVersion: string; transformVersion: string;
  orientationEvidence: { upAxis: string }; rotation: number[][]; errorCode: string|null;
  metadata: GlbMetadata|null; downloadUrl: string|null;
}
export interface GlbState { eligible: boolean; reason: string|null; orientations: {upAxis:string;rotation:number[][]}[]; variants: GlbVariant[] }
export const fetchGlbState=async(id:string,signal?:AbortSignal)=>(await httpClient.get<GlbState>(`/mesh-models/${id}/glb`,{signal})).data;
export const generateGlb=async(model:MeshModel,upAxis:string)=>(await httpClient.post<GlbVariant>(`/mesh-models/${model.id}/glb`,{sourcePlySha256:model.sha256,upAxis,confirmOrientation:true})).data;
export const fetchGlbFile=async(id:string,variantId:string|undefined,signal?:AbortSignal,onProgress?:(percent:number)=>void)=>(await httpClient.get<ArrayBuffer>(`/mesh-models/${id}/files/glb`,{params:{variantId},responseType:'arraybuffer',timeout:0,signal,onDownloadProgress:e=>{if(e.total)onProgress?.(Math.round(e.loaded/e.total*100));}})).data;
export async function downloadGlb(id:string,variantId:string){
  const data=await fetchGlbFile(id,variantId);const url=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=`mesh-${id}-${variantId}.glb`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
