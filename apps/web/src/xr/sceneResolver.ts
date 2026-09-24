/**
 * WebXR 修复任务 — 场景解析（§10）。
 *
 * XR 页面复用 Desktop Viewer 同一套 manifest（/local-scenes/<id>/manifest.json），
 * 不做第二套 Scene 数据模型。第一阶段不支持 streamed-sog / LOD ——
 * 检测到 streamed-sog 时明确抛错，而不是假装加载。
 */
import { XRSceneError, type XRSceneResolution } from './xrTypes';

const manifestUrl = (sceneId: string): string =>
  `/local-scenes/${encodeURIComponent(sceneId)}/manifest.json`;

/**
 * 解析一个场景到可直接加载的 splat URL。
 *
 * 支持 manifest 结构：
 *   { id, title, format: 'sog'|'ply'|'splat', assetUrl, camera?, ... }
 *
 * 拒绝（第一阶段明确不做）：
 *   { schemaVersion, format: 'streamed-sog', stream: {...} }
 */
export async function resolveSceneForXR(sceneId: string): Promise<XRSceneResolution> {
  const url = manifestUrl(sceneId);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new XRSceneError(
      'ASSET_FETCH_FAILED',
      `无法获取场景 manifest: ${url}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (!response.ok) {
    throw new XRSceneError('SCENE_NOT_FOUND', `场景不存在: ${sceneId}（HTTP ${response.status}）`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    throw new XRSceneError(
      'ASSET_FETCH_FAILED',
      `场景 manifest 不是合法 JSON: ${url}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }

  // streamed-sog：第一阶段不支持。
  if (raw.format === 'streamed-sog' || raw.schemaVersion === 1) {
    throw new XRSceneError(
      'STREAMED_SOG_UNSUPPORTED',
      `场景 ${sceneId} 为 streamed-sog（LOD 流式格式），第一阶段 XR 仅支持单文件 SOG/PLY。`,
    );
  }

  const format = raw.format;
  if (format !== 'sog' && format !== 'ply' && format !== 'splat') {
    throw new XRSceneError(
      'ASSET_FETCH_FAILED',
      `场景清单缺少合法 format: ${url}（实际: ${String(format)}）`,
    );
  }

  const assetUrl = typeof raw.assetUrl === 'string' ? raw.assetUrl : undefined;
  if (!assetUrl) {
    throw new XRSceneError('ASSET_FETCH_FAILED', `场景清单缺少 assetUrl: ${url}`);
  }

  const title = typeof raw.title === 'string' ? raw.title : sceneId;
  const filename = assetUrl.split('/').pop() || undefined;

  return {
    sceneId,
    title,
    contentUrl: assetUrl,
    contentFilename: filename,
    streamed: false,
  };
}
