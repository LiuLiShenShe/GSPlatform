import axios from 'axios';

/**
 * 项目自有 HTTP 客户端。
 * 后端 /api/v1 接入后，所有页面通过此实例发出请求；
 * Phase 01 页面仅使用 fixture 适配层（services/sceneApi.ts）验证 UI。
 */
export const httpClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8001/api/v1',
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

export interface ApiError {
  status: number | null;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 将 Axios / DOMException / 其他未知异常归一化为统一的 ApiError 结构，
 * 供页面 state 消费，不在 UI 中泄露栈信息或请求细节。
 */
export function toApiError(error: unknown): ApiError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? null;
    const code: string | undefined =
      typeof error.response?.data === 'object' && error.response?.data !== null
        ? (error.response.data as Record<string, unknown>).code as string | undefined
        : undefined;
    const message =
      typeof error.response?.data === 'object' && error.response?.data !== null
        ? ((error.response.data as Record<string, unknown>).message as string | undefined)
        : undefined;

    if (error.code === 'ERR_CANCELED' || error.name === 'AbortError') {
      return { status: null, code: 'CANCELLED', message: '请求已取消' };
    }

    return {
      status,
      code: code ?? (status != null ? `HTTP_${String(status)}` : 'NETWORK_ERROR'),
      message:
        message ??
        (status != null
          ? `请求失败（${String(status)}）`
          : '网络错误，请稍后重试'),
    };
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return { status: null, code: 'CANCELLED', message: '请求已取消' };
  }

  return { status: null, code: 'UNKNOWN_ERROR', message: '发生未知错误' };
}