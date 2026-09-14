/**
 * 场景数据 API 服务层 — Phase 05 接入真实后端 /api/v1/scenes。
 *
 * 返回类型保持与 Phase 01 fixtures 相同的 SceneSummary 形状，
 * 以便页面层无需修改。DTO 转换在此模块完成：
 *   - ASCII category key → 中文标签
 *   - author 对象 → author 字符串
 *   - posterUrl null → 本地 SVG fallback
 */
import { httpClient } from './http';
import type { SceneSummary } from '../fixtures/scenes';

const CATEGORY_MAP: Record<string, SceneSummary['category']> = {
  urban: '城市',
  architecture: '建筑',
  interior: '室内',
  nature: '自然',
  portrait: '人物',
  experiment: '实验',
};

const STATUS_MAP: Record<string, SceneSummary['status']> = {
  READY: 'READY',
  PROCESSING: 'PROCESSING',
  FAILED: 'FAILED',
  PUBLISHED: 'PUBLISHED',
  DRAFT: 'PROCESSING',
  VALIDATING: 'PROCESSING',
  ARCHIVED: 'FAILED',
};

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
}

// Deterministic SVG poster fallback (project-owned, no third-party assets).
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

function toSceneSummary(raw: BackendSceneSummary): SceneSummary {
  const category = CATEGORY_MAP[raw.category] ?? '实验';
  const status = STATUS_MAP[raw.status] ?? 'READY';
  return {
    id: raw.id,
    title: raw.title,
    author: raw.author?.name ?? '未知',
    category,
    splatCount: raw.splatCount ?? 0,
    sizeMB: raw.sizeMB ?? 0,
    views: raw.views,
    likes: raw.likes,
    status,
    poster: raw.posterUrl ?? fallbackPoster(raw.id, raw.title),
  };
}

/**
 * 获取公开场景列表（首页目录）。
 * 页面层按需传入已有选项；无参数时默认 limit=100 覆盖首页网格。
 */
export async function fetchSceneList(options?: {
  signal?: AbortSignal;
  limit?: number;
  category?: string;
  sort?: string;
}): Promise<SceneSummary[]> {
  const params: Record<string, string> = {
    limit: String(options?.limit ?? 100),
  };
  if (options?.category) params.category = options.category;
  if (options?.sort) params.sort = options.sort;

  const response = await httpClient.get<{ items: BackendSceneSummary[] }>(
    '/scenes',
    { signal: options?.signal, params },
  );
  return response.data.items.map(toSceneSummary);
}

/**
 * 按 ID（slug）查找单个场景（异步，用于 Viewer 页面）。
 */
export async function findScene(
  sceneId: string,
  signal?: AbortSignal,
): Promise<SceneSummary | undefined> {
  try {
    const response = await httpClient.get<BackendSceneSummary>(
      `/scenes/${encodeURIComponent(sceneId)}`,
      { signal },
    );
    return toSceneSummary(response.data);
  } catch {
    return undefined;
  }
}