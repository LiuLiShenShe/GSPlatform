/**
 * 场景数据 fixture 适配层。
 * 明确标注：本模块是 Phase 01 的本地替代实现，用于验证前端 UI，
 * 不向最终用户或 Phase Report 伪装为后端完成证据。
 */
import { sceneFixtures, type SceneSummary } from '../fixtures/scenes';

/** 500ms 延迟模拟网络响应，同时支持 AbortController 取消。 */
export function fetchSceneList(options?: {
  signal?: AbortSignal;
  delay?: number;
}): Promise<SceneSummary[]> {
  const delay = options?.delay ?? 500;
  return new Promise<SceneSummary[]>((resolve, reject) => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        resolve(sceneFixtures);
      }
    }, delay);

    options?.signal?.addEventListener('abort', () => {
      cancelled = true;
      clearTimeout(timer);
      reject(new DOMException('请求已取消', 'AbortError'));
    });
  });
}

/** 按 ID 查找单个场景（同步，仅用于 Viewer 页面 fixture 展示）。 */
export function findScene(sceneId: string): SceneSummary | undefined {
  return sceneFixtures.find(
    (s) => s.id === sceneId || s.id === 'local-fixture',
  );
}