/**
 * 分享 API 服务层 — Phase 08 真实后端 /shares。
 * 创建分享（返回原始 token 一次）、列表、撤销。
 */
import { httpClient } from './http';

export interface CreateShareResult {
  token: string | null;
  shareUrl: string;
  expiresAt: string | null;
  revoked: boolean;
}

export interface ShareLinkOut {
  id: string;
  sceneSlug: string;
  createdAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
}

/** 创建分享链接（owner only）。 */
export async function createShare(
  sceneSlug: string,
  hours?: number,
): Promise<CreateShareResult> {
  const res = await httpClient.post<CreateShareResult>(
    `/shares/scenes/${encodeURIComponent(sceneSlug)}`,
    hours ? { hours } : {},
  );
  return res.data;
}

/** 列出场景的活跃分享（owner only）。 */
export async function listShares(sceneSlug: string): Promise<ShareLinkOut[]> {
  const res = await httpClient.get<{ items: ShareLinkOut[] }>(
    `/shares/scenes/${encodeURIComponent(sceneSlug)}`,
  );
  return res.data.items;
}

/** 撤销分享（owner only）。 */
export async function revokeShare(sceneSlug: string, shareId: string): Promise<void> {
  await httpClient.delete(
    `/shares/${encodeURIComponent(shareId)}/scenes/${encodeURIComponent(sceneSlug)}`,
  );
}

/** 解析分享 token —— 访客入口（不需要登录）。 */
export async function resolveShareToken(token: string, signal?: AbortSignal): Promise<{
  scene: Record<string, unknown>;
  shareId: string;
  expiresAt: string | null;
}> {
  const res = await httpClient.get(`/shares/resolve/${encodeURIComponent(token)}`, {
    signal,
  });
  return res.data as { scene: Record<string, unknown>; shareId: string; expiresAt: string | null };
}