/**
 * SSV-06 — AnnotationMediaOverlay 组件测试。
 *
 * 覆盖：IMAGE/VIDEO/AUDIO/PANORAMA 渲染、TEXT 不渲染、关闭回调、
 * 缺失媒体提示、切换标注自动更新（key 重挂）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnnotationMediaOverlay } from '../features/viewer-official/AnnotationMediaOverlay';
import type { GsplatformAnnotationRef } from '../scene-runtime/SuperSplatRuntime';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';

function makeDescriptor(annotations: SceneRuntimeDescriptorV1['annotations']): SceneRuntimeDescriptorV1 {
  return {
    schemaVersion: 1,
    scene: { id: 'scene-ov', name: '测试场景', posterUrl: null },
    content: { url: '/local-scenes/scene-ov/versions/v/lod-meta.json', format: 'lod-meta' },
    presentation: {
      worldTransform: { position: null, rotation: null, scale: null },
      initialCamera: { position: { x: 0, y: 1, z: 3 }, target: { x: 0, y: 0, z: 0 }, fov: 55 },
      background: { type: 'color', color: null, url: null },
      tonemapping: 'aces',
      highPrecisionRendering: false,
      postEffects: null,
    },
    viewpoints: [],
    annotations,
    backgroundAudio: null,
    collision: null,
  };
}

function mediaAnnotation(
  id: string,
  contentType: string,
  extra: Partial<SceneRuntimeDescriptorV1['annotations'][number]> = {},
): SceneRuntimeDescriptorV1['annotations'][number] {
  return {
    id,
    title: `${contentType} 标注`,
    description: '描述文本',
    anchor: { x: 0, y: 1, z: 0 },
    style: 'LEADER_TEXT',
    contentType,
    textContent: '',
    mediaAssetUrl: `/api/v1/scenes/scene-ov/annotations/${id}/media`,
    textColor: '#fff',
    textSize: 14,
    fov: 60,
    orderIndex: 0,
    enabled: true,
    ...extra,
  };
}

describe('AnnotationMediaOverlay', () => {
  it('IMAGE 标注 → 渲染 <img>，src 解析为绝对 API URL，标题/徽标正确', () => {
    const ann: GsplatformAnnotationRef = {
      index: 0,
      annotationId: 'ann-img',
      contentType: 'IMAGE',
    };
    const { container } = render(
      <AnnotationMediaOverlay
        annotation={ann}
        descriptor={makeDescriptor([mediaAnnotation('ann-img', 'IMAGE')])}
        onClose={() => undefined}
      />,
    );
    expect(container.querySelector('[data-testid="annotation-media-image"]')).not.toBeNull();
    const img = screen.getByTestId('annotation-media-image') as HTMLImageElement;
    expect(img.src).toBe('http://localhost:8001/api/v1/scenes/scene-ov/annotations/ann-img/media');
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('IMAGE 标注')).toBeInTheDocument();
    expect(screen.getByText('描述文本')).toBeInTheDocument();
  });

  it('VIDEO / AUDIO 标注 → 渲染对应媒体元素', () => {
    const descriptor = makeDescriptor([
      mediaAnnotation('ann-video', 'VIDEO'),
      mediaAnnotation('ann-audio', 'AUDIO'),
    ]);
    const { rerender } = render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-video', contentType: 'VIDEO' }}
        descriptor={descriptor}
        onClose={() => undefined}
      />,
    );
    const video = screen.getByTestId('annotation-media-video') as HTMLVideoElement;
    expect(video.src).toContain('/annotations/ann-video/media');

    rerender(
      <AnnotationMediaOverlay
        annotation={{ index: 1, annotationId: 'ann-audio', contentType: 'AUDIO' }}
        descriptor={descriptor}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('annotation-media-audio')).not.toBeNull();
  });

  it('PANORAMA 标注 → 走图片渲染（Overlay 展示全景资产）', () => {
    render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-pano', contentType: 'PANORAMA' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-pano', 'PANORAMA')])}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('annotation-media-image')).not.toBeNull();
    expect(screen.getByText('360° 全景')).toBeInTheDocument();
  });

  it('TEXT 标注 → 不渲染 Overlay（官方 annotation panel 直接显示）', () => {
    const { container } = render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-text', contentType: 'TEXT' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-text', 'TEXT')])}
        onClose={() => undefined}
      />,
    );
    expect(container.querySelector('.gs-annotation-media-overlay')).toBeNull();
  });

  it('选中为空 → 不渲染', () => {
    const { container } = render(
      <AnnotationMediaOverlay
        annotation={null}
        descriptor={makeDescriptor([mediaAnnotation('ann-img', 'IMAGE')])}
        onClose={() => undefined}
      />,
    );
    expect(container.querySelector('.gs-annotation-media-overlay')).toBeNull();
  });

  it('关闭按钮 → onClose 回调（不触碰 runtime selection）', async () => {
    const onClose = vi.fn();
    render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-img', contentType: 'IMAGE' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-img', 'IMAGE')])}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByTestId('annotation-media-overlay-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('媒体缺失 → 显示“尚未上传媒体文件”', () => {
    render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-nomedia', contentType: 'VIDEO' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-nomedia', 'VIDEO', { mediaAssetUrl: null })])}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('annotation-media-missing')).toBeInTheDocument();
  });
});
