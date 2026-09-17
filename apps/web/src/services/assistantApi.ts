/**
 * 问 AI API 服务层 — Phase 08 服务端 SceneAssistantService。
 * 前端不持有任何模型密钥；只把问题发给后端。
 */
import { httpClient } from './http';

export interface AssistantResponse {
  answer: string;
  sources: string[];
  model: string;
  durationMs: number;
  contextSkipped: string[];
}

export async function askSceneAssistant(
  sceneSlug: string,
  question: string,
  signal?: AbortSignal,
): Promise<AssistantResponse> {
  const res = await httpClient.post<AssistantResponse>(
    '/assistant/ask',
    { sceneSlug, question },
    { signal },
  );
  return res.data;
}