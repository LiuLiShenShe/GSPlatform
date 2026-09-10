/**
 * 本地场景 manifest 解析。
 * Phase 02 使用 Git 忽略的 `scenes/<sceneId>/` 目录作为真实测试资产来源，
 * 通过受控 SceneDescriptor 描述资产，校验和与来源记录在场景目录中。
 *
 * Phase 03 扩展：manifest 含 low/medium/high 三档 LOD 与 poster 信息，
 * 本模块返回 `ProgressiveSceneResolution` 供渐进加载会话消费。
 *
 * 后端 /api/v1 接入后（Phase 05+），此模块由真实 API 替换；本文件只负责
 * 把本地 manifest 解析为 ViewerAdapter 可消费的 DTO，不伪造任何渲染结果。
 */
import type { LODAssetRef, SceneDescriptor, ViewerErrorCode } from '@gsplatform/viewer';

export interface LocalSceneResolution {
  descriptor: SceneDescriptor;
  /** manifest 原文中的 sha256（可能缺失，展示用途）。 */
  recordedSha256?: string;
}

/** Phase 03 渐进加载场景解析结果：既有单资产描述符，又含 LOD 分层。 */
export interface ProgressiveSceneResolution {
  descriptor: SceneDescriptor;
  lods: LODAssetRef[];
  posterUrl: string | null;
  placeholderColor?: string;
  camera: SceneDescriptor['camera'];
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
export const manifestUrl = (sceneId: string): string =>
  `/local-scenes/${encodeURIComponent(sceneId)}/manifest.json`;

/** 拉取并校验场景 manifest JSON（HTTP 层，供两套解析共用）。 */
async function fetchManifestRaw(sceneId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
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

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单不是有效 JSON: ${url}`);
  }
}

/**
 * 解析本地 manifest 为受控 SceneDescriptor。
 * 404（SCENE_NOT_FOUND）与网络失败（ASSET_FETCH_FAILED）分别抛出可恢复错误。
 */
export async function resolveLocalScene(
  sceneId: string,
  signal?: AbortSignal,
): Promise<LocalSceneResolution> {
  const raw = await fetchManifestRaw(sceneId, signal);

  // 校验并构造受控 DTO —— 只接受 manifest 中明确声明的字段
  const format = raw.format;
  if (format !== 'sog' && format !== 'ply' && format !== 'splat') {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单缺少合法 format: ${manifestUrl(sceneId)}`);
  }

  const assetUrl = raw.assetUrl;
  if (typeof assetUrl !== 'string' || !assetUrl.startsWith('/')) {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单缺少合法的 assetUrl: ${manifestUrl(sceneId)}`);
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

/**
 * Phase 03 渐进加载解析：读取含 low/medium/high LOD 与 poster 的 manifest。
 * 兼容旧的单资产 manifest（无 `lod` 数组）——此时按单个 high 档处理。
 */
export async function resolveProgressiveScene(
  sceneId: string,
  signal?: AbortSignal,
): Promise<ProgressiveSceneResolution> {
  const url = manifestUrl(sceneId);
  const raw = await fetchManifestRaw(sceneId, signal);

  const format = raw.format;
  if (format !== 'sog' && format !== 'ply' && format !== 'splat') {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单缺少合法 format: ${url}`);
  }

  const camera = parseCamera(raw.camera);

  // LOD 分层：manifest.lod 数组优先；否则退回单资产 high 档。
  const lods: LODAssetRef[] = parseLods(raw, format, sceneId);
  const primaryAssetUrl = lods[lods.length - 1]?.assetUrl ?? '';

  const descriptor: SceneDescriptor = {
    id: typeof raw.id === 'string' ? raw.id : sceneId,
    title: typeof raw.title === 'string' ? raw.title : sceneId,
    format,
    assetUrl: primaryAssetUrl,
    posterUrl: undefined,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
    camera,
  };

  // poster：manifest.poster.url（相对路径）或旧 posterUrl 字段。
  const posterRaw = raw.poster as Record<string, unknown> | undefined;
  const posterUrlValue =
    (typeof posterRaw?.url === 'string' ? posterRaw.url : undefined) ??
    (typeof raw.posterUrl === 'string' ? raw.posterUrl : undefined);
  const placeholderColor =
    typeof posterRaw?.placeholderColor === 'string' ? posterRaw.placeholderColor : undefined;

  return {
    descriptor,
    lods,
    posterUrl: posterUrlValue ? resolveAssetUrl(sceneId, posterUrlValue) : null,
    placeholderColor,
    camera,
    recordedSha256: descriptor.sha256,
  };
}

/** 把 manifest 中的相对资源路径解析为站点绝对路径。 */
function resolveAssetUrl(sceneId: string, assetUrl: string): string {
  if (assetUrl.startsWith('/') || /^[a-z]+:/i.test(assetUrl)) {
    return assetUrl;
  }
  return `/local-scenes/${encodeURIComponent(sceneId)}/${assetUrl.replace(/^\.\//, '')}`;
}

/** 解析 LOD 数组；非法项被过滤，空数组视为不可用并抛错。 */
function parseLods(raw: Record<string, unknown>, _format: string, sceneId: string): LODAssetRef[] {
  const rawLods = raw.lod;
  if (!Array.isArray(rawLods) || rawLods.length === 0) {
    // 兼容旧 manifest：单资产即 high。
    const assetUrl = raw.assetUrl;
    if (typeof assetUrl === 'string' && assetUrl.startsWith('/')) {
      return [{
        level: 'high',
        assetUrl,
        gaussians: typeof raw.sourceGaussians === 'number' ? raw.sourceGaussians : 0,
        size: typeof raw.sourceSize === 'number' ? raw.sourceSize : 0,
        sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
      }];
    }
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单缺少 lod 数组: ${manifestUrl(sceneId)}`);
  }

  const lods: LODAssetRef[] = [];
  for (const item of rawLods) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const level = obj.level;
    const assetUrl = obj.assetUrl;
    if (level !== 'low' && level !== 'medium' && level !== 'high') continue;
    if (typeof assetUrl !== 'string' || !assetUrl) continue;
    lods.push({
      level,
      assetUrl: resolveAssetUrl(sceneId, assetUrl),
      gaussians: typeof obj.gaussians === 'number' ? obj.gaussians : 0,
      size: typeof obj.size === 'number' ? obj.size : 0,
      sha256: typeof obj.sha256 === 'string' ? obj.sha256 : undefined,
    });
  }

  // 要求 low 档必须存在（否则无法渐进交互）；format 与清单保持一致。
  if (lods.length === 0 || !lods.some((l) => l.level === 'low')) {
    throw new LocalSceneError('ASSET_FETCH_FAILED', `场景清单 LOD 无效: ${manifestUrl(sceneId)}`);
  }
  return lods;
}

function parseCamera(
  raw: unknown,
): SceneDescriptor['camera'] {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;  const position = asVec3(obj.position);
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