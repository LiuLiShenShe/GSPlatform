/**
 * 本地场景 manifest 解析。
 * Phase 02 使用 Git 忽略的 `scenes/<sceneId>/` 目录作为真实测试资产来源，
 * 通过受控 SceneDescriptor 描述资产，校验和与来源记录在场景目录中。
 *
 * 后端 /api/v1 接入后（Phase 03+），此模块由真实 API 替换；本文件只负责
 * 把本地 manifest 解析为 ViewerAdapter 可消费的 DTO，不伪造任何渲染结果。
 */
import type { SceneDescriptor, ViewerErrorCode } from '@gsplatform/viewer';

export interface LocalSceneResolution {
  descriptor: SceneDescriptor;
  /** manifest 原文中的 sha256（可能缺失，展示用途）。 */
  recordedSha256?: string;
}

/** 本地解析错误码是 ViewerErrorCode 的子集。 */
export type LocalSceneErrorCode = Extract<ViewerErrorCode, 'SCENE_NOT_FOUND' | 'ASSET_FETCH_FAILED'>;

export class LocalSceneError extends Error {
  readonly code: LocalSceneErrorCode;

  constructor(code: LocalSceneErrorCode, message: string) {
    super(message);
    this.name = 'LocalSceneError';
    this.code = code;
  }
}

/** 在开发服务中，场景目录位于 /local-scenes/<sceneId>/。 */
const manifestUrl = (sceneId: string): string =>
  `/local-scenes/${encodeURIComponent(sceneId)}/manifest.json`;

/**
 * 解析本地 manifest 为受控 SceneDescriptor。
 * 404（SCENE_NOT_FOUND）与网络失败（ASSET_FETCH_FAILED）分别抛出可恢复错误。
 */
export async function resolveLocalScene(
  sceneId: string,
  signal?: AbortSignal,
): Promise<LocalSceneResolution> {
  const url = manifestUrl(sceneId);
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new LocalSceneError(
      'ASSET_FETCH_FAILED',
      `无法请求场景清单 ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new LocalSceneError(
      response.status === 404 ? 'SCENE_NOT_FOUND' : 'ASSET_FETCH_FAILED',
      `场景清单请求失败 ${url}: HTTP ${response.status}`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单不是有效 JSON: ${url}`);
  }

  // 校验并构造受控 DTO —— 只接受 manifest 中明确声明的字段
  const format = raw.format;
  if (format !== 'sog' && format !== 'ply' && format !== 'splat') {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单缺少合法 format: ${url}`);
  }

  const assetUrl = raw.assetUrl;
  if (typeof assetUrl !== 'string' || !assetUrl.startsWith('/')) {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单缺少合法的 assetUrl: ${url}`);
  }

  const camera = parseCamera(raw.camera);
  const descriptor: SceneDescriptor = {
    id: typeof raw.id === 'string' ? raw.id : sceneId,
    title: typeof raw.title === 'string' ? raw.title : sceneId,
    format,
    assetUrl,
    posterUrl: typeof raw.posterUrl === 'string' ? raw.posterUrl : undefined,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
    camera,
  };

  return {
    descriptor,
    recordedSha256: descriptor.sha256,
  };
}

function parseCamera(
  raw: unknown,
): SceneDescriptor['camera'] {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const position = asVec3(obj.position);
  const target = asVec3(obj.target);
  const fov = typeof obj.fov === 'number' && Number.isFinite(obj.fov) ? obj.fov : undefined;
  if (position && target && fov) {
    return { position, target, fov };
  }
  return undefined;
}

function asVec3(value: unknown): [number, number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return value as [number, number, number];
  }
  return undefined;
}