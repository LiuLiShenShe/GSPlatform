/**
 * 运行时描述解析（SSV-03）—— Desktop 页面取描述的唯一入口。
 *
 * 优先走 SSV-01 数据库合同 `getSceneRuntime`；404（非 DB 场景，如仓库级
 * 开发场景 local-garden / progressive-test）时回退到 manifest 解析，
 * 产出同一结构的最小 SceneRuntimeDescriptorV1。其余错误原样抛出。
 */
import { getSceneRuntime, RuntimeApiError } from './runtimeApi';
import type { SceneRuntimeDescriptorV1 } from './types';

/** manifest 解析失败分类。 */
export type ManifestFallbackErrorKind = 'SCENE_NOT_FOUND' | 'ASSET_FETCH_FAILED' | 'ASSET_INVALID' | 'STREAMED_SOG_UNSUPPORTED';

export class ManifestFallbackError extends Error {
  readonly kind: ManifestFallbackErrorKind;

  constructor(kind: ManifestFallbackErrorKind, message: string) {
    super(message);
    this.name = 'ManifestFallbackError';
    this.kind = kind;
  }
}

const manifestUrl = (sceneId: string): string =>
  `/local-scenes/${encodeURIComponent(sceneId)}/manifest.json`;

/** 文件扩展名 → content format（与后端 content_format_from_filename 对齐）。 */
function formatFromFilename(filename: string): string | null {
  const name = filename.toLowerCase();
  if (name.endsWith('.lod-meta.json')) return 'lod-meta';
  if (name.endsWith('.meta.json')) return 'meta';
  if (name.endsWith('.compressed.ply')) return 'compressed-ply';
  if (name.endsWith('.sog')) return 'sog';
  if (name.endsWith('.ply')) return 'ply';
  return null;
}

/** 解析结果：描述 + 来源标记（manifest 回退 vs DB 合同）。 */
export interface ResolvedSceneRuntimeDescriptor {
  descriptor: SceneRuntimeDescriptorV1;
  /** true = 来自本地 manifest 回退（仓库级开发场景）；false = DB 合同。 */
  fromManifest: boolean;
}

/**
 * 解析场景运行时描述。
 *
 * @param sceneId - 业务 slug。
 * @returns 优先 DB 合同描述；DB 404 且本地 manifest 存在时返回 manifest 描述。
 * @throws 网络错误 / 描述非法 / manifest 缺失或流式（流式须走 DB 合同）。
 */
export async function resolveSceneRuntimeDescriptor(
  sceneId: string,
): Promise<ResolvedSceneRuntimeDescriptor> {
  try {
    return { descriptor: await getSceneRuntime(sceneId), fromManifest: false };
  } catch (error) {
    if (error instanceof RuntimeApiError && error.kind === 'SCENE_NOT_FOUND') {
      return { descriptor: await resolveFromManifest(sceneId), fromManifest: true };
    }
    throw error;
  }
}

/** 从 /local-scenes/<id>/manifest.json 组装最小描述（仓库级开发场景）。 */
async function resolveFromManifest(sceneId: string): Promise<SceneRuntimeDescriptorV1> {
  const url = manifestUrl(sceneId);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new ManifestFallbackError(
      'ASSET_FETCH_FAILED',
      `无法请求场景清单 ${url}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (!response.ok) {
    throw new ManifestFallbackError(
      'SCENE_NOT_FOUND',
      `场景不存在（DB 与本地 manifest 均未找到）: ${sceneId}（HTTP ${response.status}）`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ManifestFallbackError('ASSET_INVALID', `场景清单不是合法 JSON: ${url}`);
  }

  const isStreamed = raw.format === 'streamed-sog' || typeof raw.stream === 'object';
  if (isStreamed) {
    throw new ManifestFallbackError(
      'STREAMED_SOG_UNSUPPORTED',
      `场景 ${sceneId} 为 streamed-sog：非 DB 场景，请先通过上传/发布流程入 DB 后访问。`,
    );
  }
  const format = raw.format;
  if (format !== 'sog' && format !== 'ply' && format !== 'splat') {
    throw new ManifestFallbackError('ASSET_INVALID', `场景清单缺少合法 format: ${url}`);
  }
  const assetUrl = typeof raw.assetUrl === 'string' ? raw.assetUrl : undefined;
  if (!assetUrl) {
    throw new ManifestFallbackError('ASSET_INVALID', `场景清单缺少 assetUrl: ${url}`);
  }

  const title = typeof raw.title === 'string' ? raw.title : sceneId;
  const posterUrl = typeof raw.posterUrl === 'string' ? raw.posterUrl : null;
  const filename = assetUrl.split('/').pop() ?? '';

  // manifest.camera 为 [x,y,z] 数组形式
  const cam = (raw.camera ?? {}) as { position?: number[]; target?: number[]; fov?: number };
  const hasCamera =
    Array.isArray(cam.position) && Array.isArray(cam.target) &&
    cam.position.length === 3 && cam.target.length === 3;

  return {
    schemaVersion: 1,
    scene: { id: sceneId, name: title, posterUrl },
    content: { url: assetUrl, format: formatFromFilename(filename) },
    presentation: {
      worldTransform: { position: null, rotation: null, scale: null },
      initialCamera: hasCamera
        ? {
            position: { x: cam.position![0], y: cam.position![1], z: cam.position![2] },
            target: { x: cam.target![0], y: cam.target![1], z: cam.target![2] },
            fov: typeof cam.fov === 'number' ? cam.fov : null,
          }
        : { position: null, target: null, fov: null },
      background: { type: 'color', color: null, url: null },
    },
    viewpoints: [],
    annotations: [],
    backgroundAudio: null,
    collision: null,
  };
}
