/**
 * AnnotationMediaOverlay（SSV-06 §五）—— GSPlatform 媒体标注 Overlay。
 *
 * 官方 viewer 只处理 hotspot + camera navigation（annotation.camera），不渲染
 * IMAGE/VIDEO/AUDIO/PANORAMA 媒体本身；媒体内容由本统一组件渲染：
 *
 *   - 数据源：当前选中官方 annotation 的 extras.gsplatform.annotationId →
 *     在描述里解析对应 SceneAnnotation（**禁止**用官方数组 index 当数据库 ID）。
 *   - 关闭 Overlay **不**清除 annotation selection（父组件只调 onClose，
 *     不调 runtime.clearAnnotation）。
 *   - 切换 annotation 时父组件用 key={annotationId} 重挂本组件 → Overlay 自动更新。
 *   - TEXT 标注不经过本组件（官方 annotation panel 直接显示，HTML 已由 adapter
 *     sanitize）。
 */
import { useEffect, useMemo } from 'react';
import { resolveRuntimeAssetUrl } from '../../scene-runtime/assetUrl';
import type { GsplatformAnnotationRef } from '../../scene-runtime/SuperSplatRuntime';
import type { SceneRuntimeDescriptorV1 } from '../../scene-runtime/types';

export type MediaAnnotationContentType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'PANORAMA';

const MEDIA_TYPES: readonly MediaAnnotationContentType[] = [
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'PANORAMA',
];

export interface AnnotationMediaOverlayProps {
  /** 当前选中的标注（extras 引用）；null → 不渲染。 */
  annotation: GsplatformAnnotationRef | null;
  /** 场景运行时描述（按 annotationId 解析媒体 URL / 标题 / 描述）。 */
  descriptor: SceneRuntimeDescriptorV1 | null;
  /** 关闭 Overlay。不得在此调 clearAnnotation（关闭不删 selection）。 */
  onClose: () => void;
}

/** 标注的媒体类型标签（UI 展示用）。 */
export const MEDIA_TYPE_LABELS: Record<MediaAnnotationContentType, string> = {
  IMAGE: '图片',
  VIDEO: '视频',
  AUDIO: '音频',
  PANORAMA: '360° 全景',
};

export function AnnotationMediaOverlay({
  annotation,
  descriptor,
  onClose,
}: AnnotationMediaOverlayProps) {
  // 按 extras.gsplatform.annotationId 解析数据（官方 index 只用于事件定位）。
  const gsAnnotation = useMemo(() => {
    if (!annotation || !descriptor) return null;
    return descriptor.annotations.find((a) => a.id === annotation.annotationId) ?? null;
  }, [annotation, descriptor]);

  const contentType = annotation?.contentType ?? gsAnnotation?.contentType ?? null;
  const isMedia =
    annotation !== null && contentType !== null && MEDIA_TYPES.includes(contentType as MediaAnnotationContentType);

  const mediaUrl = useMemo(
    () => resolveRuntimeAssetUrl(gsAnnotation?.mediaAssetUrl ?? null),
    [gsAnnotation],
  );

  // Esc 关闭（与官方用 Esc 取消选择共存：Overlay 优先，光标在 Overlay 上时）。
  useEffect(() => {
    if (!isMedia) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMedia, onClose]);

  if (!isMedia || !gsAnnotation) return null;
  const type = contentType as MediaAnnotationContentType;

  return (
    <div
      className="gs-annotation-media-overlay"
      data-testid={`annotation-media-overlay-${gsAnnotation.id}`}
      data-content-type={type}
      onClick={onClose}
      role="dialog"
      aria-label={gsAnnotation.title || '媒体标注'}
    >
      <div className="gs-annotation-media-overlay__card" onClick={(e) => e.stopPropagation()}>
        <div className="gs-annotation-media-overlay__header">
          <span className="gs-annotation-media-overlay__badge">{MEDIA_TYPE_LABELS[type]}</span>
          <span className="gs-annotation-media-overlay__title">{gsAnnotation.title}</span>
          <button
            type="button"
            className="gs-annotation-media-overlay__close"
            data-testid="annotation-media-overlay-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="gs-annotation-media-overlay__body">
          {type === 'VIDEO'
            ? (mediaUrl
                ? (
                  <video
                    className="gs-annotation-media-overlay__media"
                    src={mediaUrl}
                    controls
                    autoPlay
                    muted
                    playsInline
                    data-testid="annotation-media-video"
                  />
                )
                : <MissingMedia />)
            : type === 'AUDIO'
              ? (mediaUrl
                  ? (
                    <audio
                      className="gs-annotation-media-overlay__media"
                      src={mediaUrl}
                      controls
                      autoPlay
                      data-testid="annotation-media-audio"
                    />
                  )
                  : <MissingMedia />)
              : (mediaUrl
                  ? (
                    <img
                      className="gs-annotation-media-overlay__media"
                      src={mediaUrl}
                      alt={gsAnnotation.title}
                      data-testid="annotation-media-image"
                    />
                  )
                  : <MissingMedia />)}
          {gsAnnotation.description && (
            <p className="gs-annotation-media-overlay__desc">{gsAnnotation.description}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MissingMedia() {
  return (
    <div className="gs-annotation-media-overlay__missing" data-testid="annotation-media-missing">
      该标注尚未上传媒体文件
    </div>
  );
}