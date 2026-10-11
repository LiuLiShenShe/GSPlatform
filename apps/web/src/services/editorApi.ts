import { httpClient } from './http';
import type { UploadSessionInfo } from '../features/upload/ResumableUploader';

export interface EditSource {
  sceneId: string;
  sceneTitle: string;
  currentVersionId: string | null;
  assetVersion: string | null;
  format: string | null;
  counts: number[];
  editorEnabled: boolean;
  maxGaussians: number;
  spatialState: string | null;
}

export interface EditSession {
  id: string;
  sceneSlug: string;
  sceneTitle: string;
  sourceVersionId: string;
  sourceAssetVersion: string;
  sourceKind: 'FULL_RESOLUTION_SOURCE' | 'SELECTED_STREAMED_LOD';
  sourceCounts: number[];
  selectedLod: number | null;
  editorUpstreamCommit: string;
  editorBuildIdentity: string;
  status: string;
  expiresAt: string;
  editorUrl: string;
  uploadId: string | null;
  resultVersionId: string | null;
  resultCounts?: number[] | null;
  errorCode: string | null;
  stage: string | null;
  progress: number;
}

const scenePath = (slug: string) => `/scenes/${encodeURIComponent(slug)}`;
const sessionPath = (slug: string, id: string) => `${scenePath(slug)}/edit-sessions/${encodeURIComponent(id)}`;

export async function fetchEditSource(slug: string): Promise<EditSource> {
  return (await httpClient.get(`${scenePath(slug)}/edit-source`)).data;
}

export async function createEditSession(slug: string, source: EditSource, lod: number,
  acknowledged: boolean): Promise<EditSession> {
  return (await httpClient.post(`${scenePath(slug)}/edit-sessions`, {
    expectedCurrentVersion: source.currentVersionId,
    selectedLod: source.format === 'streamed-sog' ? lod : null,
    acknowledgeLodSource: acknowledged,
    acknowledgeBrowserMemory: acknowledged,
  })).data;
}

export async function fetchEditSession(slug: string, id: string): Promise<EditSession> {
  return (await httpClient.get(sessionPath(slug, id))).data;
}

export async function cancelEditSession(slug: string, id: string): Promise<EditSession> {
  return (await httpClient.post(`${sessionPath(slug, id)}/cancel`)).data;
}

export async function createEditUpload(slug: string, session: EditSession,
  file: File): Promise<UploadSessionInfo> {
  const format = file.name.split('.').pop()?.toLowerCase();
  if (format !== 'ply' && format !== 'sog') throw new Error('请选择官方导出的 PLY 或 SOG，不接受 .ssproj');
  if (file.size > 1024 * 1024 * 1024) throw new Error('浏览器安全提交上限为 1 GiB，请减少所选 LOD 或导出大小');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return (await httpClient.post(`${sessionPath(slug, session.id)}/uploads`, {
    filename: file.name, format, size: file.size, sha256,
    selectedLod: session.selectedLod,
    acknowledgeSelectedLod: true,
  })).data;
}

export function officialEditorUrl(session: EditSession): string {
  const address = new URL(session.editorUrl, window.location.origin);
  if (address.origin !== window.location.origin || address.pathname !== '/gaussian-editor/') {
    throw new Error('拒绝非受控同源编辑器地址');
  }
  return address.href;
}
