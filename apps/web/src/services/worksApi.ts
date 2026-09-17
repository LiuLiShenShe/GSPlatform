/**
 * 我的作品 API 服务层 — Phase 05 接入真实后端 /me/scenes。
 *
 * 返回类型保持与 Phase 01 fixtures 相同的 WorkSummary 形状。
 */
import { httpClient } from './http';
import type { WorkSummary } from '../fixtures/myWorks';

interface BackendAuthor {
  id: string;
  name: string;
}

interface BackendSceneSummary {
  id: string;
  title: string;
  author: BackendAuthor;
  category: string;
  status: string;
  splatCount: number | null;
  sizeMB: number | null;
  views: number;
  likes: number;
  posterUrl: string | null;
  updatedAt: string | null;
}

// Deterministic SVG poster fallback (same logic as sceneApi).
const PAIRS: [string, string][] = [
  ['#4A6FE3', '#1D4ED8'],
  ['#0EA5A4', '#0D9488'],
  ['#F59E0B', '#D97706'],
  ['#6366F1', '#4F46E5'],
  ['#EC4899', '#DB2777'],
  ['#8B5CF6', '#6D28D9'],
];

function posterSvg(title: string, from: string, to: string): string {
  const encoded = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${from}"/>`,
    `<stop offset="1" stop-color="${to}"/>`,
    `</linearGradient></defs>`,
    `<rect width="480" height="360" fill="url(#bg)"/>`,
    `<text x="24" y="328" font-size="16" fill="rgba(255,255,255,0.7)" font-family="sans-serif">${title}</text>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml;utf8,${encodeURIComponent(encoded)}`;
}

function fallbackPoster(slug: string, title: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  const [from, to] = PAIRS[hash % PAIRS.length];
  return posterSvg(title, from, to);
}

function toWorkSummary(raw: BackendSceneSummary): WorkSummary {
  const statusMap: Record<string, WorkSummary['status']> = {
    DRAFT: 'DRAFT',
    PROCESSING: 'PROCESSING',
    PUBLISHED: 'PUBLISHED',
    FAILED: 'FAILED',
    READY: 'PUBLISHED',
    VALIDATING: 'PROCESSING',
    ARCHIVED: 'FAILED',
  };
  const status = statusMap[raw.status] ?? 'DRAFT';
  const poster = raw.posterUrl ?? fallbackPoster(raw.id, raw.title);
  const updatedAt = raw.updatedAt ?? new Date().toISOString();

  return {
    id: raw.id,
    title: raw.title,
    status,
    updatedAt,
    progress: null,
    sceneId: status === 'PUBLISHED' ? raw.id : null,
    poster,
  };
}

/**
 * 获取当前用户作品列表。
 * 需要开发身份（GS_DEV_IDENTITY_ENABLED=true）或真实会话。
 * Phase 08 支持服务端筛选/搜索/排序。
 */
export interface FetchWorksOptions {
  signal?: AbortSignal;
  limit?: number;
  status?: string;
  search?: string;
  sort?: 'updated' | 'title';
}

export async function fetchMyWorks(options?: FetchWorksOptions): Promise<WorkSummary[]> {
  const params: Record<string, string> = {
    limit: String(options?.limit ?? 100),
  };
  if (options?.status) params.status = options.status;
  if (options?.search) params.search = options.search;
  if (options?.sort) params.sort = options.sort;

  const response = await httpClient.get<{ items: BackendSceneSummary[] }>(
    '/me/scenes',
    {
      signal: options?.signal,
      params,
    },
  );

  return response.data.items.map(toWorkSummary);
}

/** 编辑场景元数据（owner）。optimistic 冲突由 409 返回，页面提示刷新。 */
export async function updateScene(
  slug: string,
  patch: {
    title?: string;
    description?: string | null;
    category?: string;
    visibility?: string;
    expectedUpdatedAt?: string;
  },
): Promise<unknown> {
  const response = await httpClient.patch(
    `/scenes/${encodeURIComponent(slug)}`,
    patch,
  );
  return response.data;
}

/** 归档场景（owner）。 */
export async function archiveScene(slug: string): Promise<void> {
  await httpClient.post(`/scenes/${encodeURIComponent(slug)}/archive`);
}

/** 恢复场景（owner）。 */
export async function restoreScene(slug: string): Promise<void> {
  await httpClient.post(`/scenes/${encodeURIComponent(slug)}/restore`);
}

/** 软删除场景（owner，延迟清理）。 */
export async function deleteScene(slug: string): Promise<void> {
  await httpClient.delete(`/scenes/${encodeURIComponent(slug)}`);
}

export interface JobSummary {
  id: string;
  sceneId: string;
  kind: string;
  status: string;
  progress: number;
  stage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 查看场景的任务（owner）。 */
export async function fetchSceneJobs(slug: string): Promise<JobSummary[]> {
  const response = await httpClient.get<JobSummary[]>(
    `/me/scenes/${encodeURIComponent(slug)}/jobs`,
  );
  return response.data;
}
