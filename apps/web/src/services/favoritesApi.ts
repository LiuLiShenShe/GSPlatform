/**
 * 收藏 API 服务层 — Phase 08 真实后端 /favorites。
 * 幂等 add/remove，乐观更新由页面层处理。
 */
import { httpClient } from './http';
import { toApiError } from './http';

export interface FavoriteStatusResult {
  favorited: boolean;
  changed: boolean;
}

/** 添加收藏（幂等）。 */
export async function addFavorite(sceneSlug: string): Promise<FavoriteStatusResult> {
  const res = await httpClient.put<FavoriteStatusResult>(
    `/favorites/${encodeURIComponent(sceneSlug)}`,
  );
  return res.data;
}

/** 取消收藏（幂等）。 */
export async function removeFavorite(sceneSlug: string): Promise<FavoriteStatusResult> {
  const res = await httpClient.delete<FavoriteStatusResult>(
    `/favorites/${encodeURIComponent(sceneSlug)}`,
  );
  return res.data;
}

/** 批量查询收藏状态（SceneCard / Viewer 同步用）。 */
export async function fetchFavoriteStatus(
  slugs: string[],
  signal?: AbortSignal,
): Promise<Record<string, boolean>> {
  if (slugs.length === 0) return {};
  const res = await httpClient.get<Record<string, boolean>>('/favorites/status', {
    params: slugs.map((s) => `slugs=${encodeURIComponent(s)}`).join('&'),
    signal,
  });
  return res.data;
}

/**
 * 收藏列表 — 返回场景 DTO（新版带 isFavorited 字段）。
 */
export interface FavoriteSceneSummary {
  id: string;
  title: string;
  authorName?: string;
  posterUrl: string | null;
}

export async function fetchFavorites(signal?: AbortSignal): Promise<FavoriteSceneSummary[]> {
  try {
    const res = await httpClient.get<Array<Record<string, unknown>>>('/favorites', {
      signal,
    });
    return res.data.map((raw) => ({
      id: String(raw.id ?? ''),
      title: String(raw.title ?? ''),
      authorName: extractAuthorName(raw.author),
      posterUrl: raw.posterUrl ? String(raw.posterUrl) : null,
    }));
  } catch (error) {
    throw toApiError(error);
  }
}

function extractAuthorName(author: unknown): string | undefined {
  if (author && typeof author === 'object') {
    const a = author as Record<string, unknown>;
    if (typeof a.name === 'string') return a.name;
  }
  return undefined;
}