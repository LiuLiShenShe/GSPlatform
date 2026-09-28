/**
 * Runtime 资源 URL 解析（SSV-06）。
 *
 * descriptor 里的媒体 / 背景音频 URL 是后端下发的相对路径
 * （`/api/v1/scenes/{slug}/annotations/{id}/media`、`.../presentation/background-audio`），
 * 同一 Web origin（生产静态与 API 同源）时可直接使用；但开发/跨域时前端与 API
 * 端口不同，相对路径会被解析到前端 origin 导致 404。因此统一在此把 `/api/...`
 * 解析为绝对 URL（基于 VITE_API_BASE_URL 的 origin），供 adapter 的 soundUrl 与
 * AnnotationMediaOverlay 的媒体源共用。绝对 URL / data: / blob: 原样返回。
 */

const FALLBACK_API_BASE = 'http://localhost:8001/api/v1';

function apiOrigin(): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? FALLBACK_API_BASE;
  try {
    return new URL(base, typeof window !== 'undefined' ? window.location.origin : undefined)
      .origin;
  } catch {
    return 'http://localhost:8001';
  }
}

/** 把后端下发的资源路径解析为可直接 fetch 的绝对 URL。 */
export function resolveRuntimeAssetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  return `${apiOrigin()}${path.startsWith('/') ? '' : '/'}${path}`;
}
