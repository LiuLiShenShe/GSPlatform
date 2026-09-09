/**
 * 我的作品 fixture 适配层 —— 仅供 Phase 01 UI 验证。
 */
import { myWorksFixtures, type WorkSummary } from '../fixtures/myWorks';

/** 400ms 延迟模拟 API 响应。 */
export function fetchMyWorks(options?: {
  signal?: AbortSignal;
  delay?: number;
}): Promise<WorkSummary[]> {
  const delay = options?.delay ?? 400;
  return new Promise<WorkSummary[]>((resolve, reject) => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) resolve(myWorksFixtures);
    }, delay);

    options?.signal?.addEventListener('abort', () => {
      cancelled = true;
      clearTimeout(timer);
      reject(new DOMException('请求已取消', 'AbortError'));
    });
  });
}