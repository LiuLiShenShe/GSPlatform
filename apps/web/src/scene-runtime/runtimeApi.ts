/**
 * Runtime 描述 API（SSV-01）—— 唯一入口 getSceneRuntime(sceneId)。
 *
 * 后续所有 Runtime 页面（Desktop / XR / Share）只能通过本方法拿运行时描述，
 * 禁止各自重新查询 / 拼接 Scene 数据。
 */
import axios from 'axios';
import { httpClient, toApiError } from '../services/http';
import type { SceneRuntimeDescriptorV1 } from './types';

export const RUNTIME_ENDPOINT = '/scenes/{sceneId}/runtime';

/** getSceneRuntime 的可恢复失败分类。 */
export type RuntimeErrorKind =
  | 'SCENE_NOT_FOUND' // 404 —— 场景不存在
  | 'UNAUTHORIZED' // 401 —— 私密场景需要登录
  | 'FORBIDDEN' // 403 —— 登录但无权限（非所有者/未发布）
  | 'NETWORK' // 网络 / 超时 / 5xx
  | 'PARSE'; // 响应不是合法 SceneRuntimeDescriptorV1

export class RuntimeApiError extends Error {
  readonly kind: RuntimeErrorKind;
  readonly status: number | null;

  constructor(kind: RuntimeErrorKind, status: number | null, message: string) {
    super(message);
    this.name = 'RuntimeApiError';
    this.kind = kind;
    this.status = status;
  }
}

function classify(status: number | null): RuntimeErrorKind {
  if (status === 404) return 'SCENE_NOT_FOUND';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  return 'NETWORK';
}

/** 仅按结构校验必填字段，避免把非 runtime 响应误当合法描述。 */
function isValidDescriptor(data: unknown): data is SceneRuntimeDescriptorV1 {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.schemaVersion !== 1) return false;
  if (typeof d.scene !== 'object' || d.scene === null) return false;
  if (typeof d.content !== 'object' || d.content === null) return false;
  if (typeof d.presentation !== 'object' || d.presentation === null) return false;
  return Array.isArray(d.viewpoints) && Array.isArray(d.annotations);
}

/**
 * 获取场景运行时描述。
 *
 * - 200 → SceneRuntimeDescriptorV1
 * - 404 / 401 / 403 → RuntimeApiError（可恢复，页面据 kind 分派 UI）
 * - 网络失败 → RuntimeApiError(kind='NETWORK')
 *
 * 注：401 会先被全局拦截器处理（http.ts 对非 /xr/* 路径跳转登录）。
 * 这是私密场景「需要登录」的正确门禁行为，不是 redirect loop。
 */
export async function getSceneRuntime(sceneId: string): Promise<SceneRuntimeDescriptorV1> {
  const url = RUNTIME_ENDPOINT.replace('{sceneId}', encodeURIComponent(sceneId));
  try {
    const { data } = await httpClient.get<unknown>(url);
    if (!isValidDescriptor(data)) {
      throw new RuntimeApiError('PARSE', 200, `运行时描述结构非法: ${url}`);
    }
    return data;
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      throw error;
    }
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? null;
      const normalized = toApiError(error);
      throw new RuntimeApiError(classify(status), status, normalized.message);
    }
    throw new RuntimeApiError('NETWORK', null, '获取运行时描述失败');
  }
}
