/**
 * 免费计算（Compute）API 服务层 — Phase 07 接入 /api/v1/compute。
 *
 * 与现有 services（sceneApi / worksApi）保持一致：复用项目 httpClient，
 * 不做任何本地兜底数据，失败时抛出原始错误由页面层归一化展示。
 */
import { httpClient } from '../../services/http';

// ── DTO 形状（与后端 Phase 07 schemas 对齐） ────────────────────────────────

export interface ComputeCapabilities {
  ok: boolean;
  tools: Record<string, string | null>;
  gpu: {
    available: boolean;
    name: string;
    vramMb: number;
  };
  problems: string[];
}

export type ProfileName = 'draft' | 'standard' | 'high';

export interface ComputeProfile {
  name: ProfileName;
  version: number;
  /** 单个任务的素材总量上限（字节）。 */
  maxInputBytes: number;
  maxImages: number;
  maxVideoSeconds: number;
  /** gsplat 训练迭代数（用于向用户展示档位差异）。 */
  iterations: number;
  stages: string[];
}

export interface ReconstructRequest {
  uploadIds: string[];
  profile: string;
  sceneTitle: string;
  description?: string | null;
  visibility?: string;
}

export interface ReconstructResponse {
  jobId: string;
  status: string;
  stage: string | null;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  sceneId: string | null;
}

export interface ComputeJob {
  id: string;
  sceneId: string;
  kind: string;
  status: string;
  progress: number;
  stage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── 接口函数 ────────────────────────────────────────────────────────────────

/** GET /compute/capabilities — GPU / 工具链能力探测，problems 为空表示健康。 */
export async function fetchCapabilities(
  signal?: AbortSignal,
): Promise<ComputeCapabilities> {
  const resp = await httpClient.get<ComputeCapabilities>(
    '/compute/capabilities',
    { signal },
  );
  return resp.data;
}

/**
 * GET /compute/profiles — 质量档位列表。
 * 正常返回裸数组；个别后端包装为 {items} 时用容错展开（防御式）。
 */
export async function fetchProfiles(
  signal?: AbortSignal,
): Promise<ComputeProfile[]> {
  const resp = await httpClient.get<ComputeProfile[] | { items: ComputeProfile[] }>(
    '/compute/profiles',
    { signal },
  );
  const data = resp.data;
  return Array.isArray(data) ? data : (data.items ?? []);
}

/** POST /compute/reconstruct — 提交重建任务（202 返回 jobId）。 */
export async function submitReconstruction(
  req: ReconstructRequest,
  signal?: AbortSignal,
): Promise<ReconstructResponse> {
  const resp = await httpClient.post<ReconstructResponse>(
    '/compute/reconstruct',
    req,
    { signal },
  );
  return resp.data;
}

/** POST /compute/jobs/{jobId}/cancel — 请求取消任务，返回取消后的任务状态。 */
export async function cancelJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<ComputeJob> {
  const resp = await httpClient.post<ComputeJob>(
    `/compute/jobs/${encodeURIComponent(jobId)}/cancel`,
    {},
    { signal },
  );
  return resp.data;
}

/** GET /jobs/{jobId} — 既有任务详情接口（轮询进度用）。 */
export async function fetchJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<ComputeJob> {
  const resp = await httpClient.get<ComputeJob>(
    `/jobs/${encodeURIComponent(jobId)}`,
    { signal },
  );
  return resp.data;
}