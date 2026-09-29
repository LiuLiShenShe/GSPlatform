/**
 * SSV-06 + FIX-03 — AnnotationMediaOverlay 组件测试。
 *
 * 覆盖：IMAGE/VIDEO/AUDIO/PANORAMA 渲染、TEXT 不渲染、关闭回调、
 * 缺失媒体提示、切换标注自动更新（key 重挂）、
 * FIX-03 §4/§7：PANORAMA 走真实 PanoramaViewer、AUDIO/VIDEO 播放态 → onPlaybackChange。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnnotationMediaOverlay } from '../features/viewer-official/AnnotationMediaOverlay';
import type { GsplatformAnnotationRef } from '../scene-runtime/SuperSplatRuntime';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';

// FIX-03 §4：PANORAMA 分支挂载真实 PanoramaViewer —— mock PSV Viewer 避免 jsdom
// 下真实 WebGL 初始化（该 mock 同时被 panorama-viewer.test.tsx 复用语义）。
vi.mock('@photo-sphere-viewer/core', () => ({
  Viewer: class {
    listeners: Record<string, Array<(e?: unknown) => void>> = {};
    addEventListener(type: string, cb: (e?: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    destroy() {
      this.listeners = {};
    }
  },
}));

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

  it('PANORAMA 标注 → 渲染真实 360° PanoramaViewer（FIX-03 §2/§4，非 <img>）', () => {
    render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-pano', contentType: 'PANORAMA' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-pano', 'PANORAMA')])}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('annotation-media-panorama')).not.toBeNull();
    expect(screen.queryByTestId('annotation-media-image')).toBeNull();
    expect(screen.getByText('360° 全景')).toBeInTheDocument();
  });

  it('FIX-03 §7：AUDIO 播放 → onPlaybackChange(true)；暂停/结束 → (false)', () => {
    const onPlaybackChange = vi.fn();
    const { rerender } = render(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-audio', contentType: 'AUDIO' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-audio', 'AUDIO')])}
        onClose={() => undefined}
        onPlaybackChange={onPlaybackChange}
      />,
    );
    const audio = screen.getByTestId('annotation-media-audio') as HTMLAudioElement;
    fireEvent.play(audio);
    expect(onPlaybackChange).toHaveBeenLastCalledWith(true);
    fireEvent.pause(audio);
    expect(onPlaybackChange).toHaveBeenLastCalledWith(false);
    fireEvent.play(audio);
    fireEvent.ended(audio);
    expect(onPlaybackChange).toHaveBeenLastCalledWith(false);

    rerender(
      <AnnotationMediaOverlay
        annotation={{ index: 0, annotationId: 'ann-video', contentType: 'VIDEO' }}
        descriptor={makeDescriptor([mediaAnnotation('ann-video', 'VIDEO')])}
        onClose={() => undefined}
        onPlaybackChange={onPlaybackChange}
      />,
    );
    const video = screen.getByTestId('annotation-media-video') as HTMLVideoElement;
    fireEvent.play(video);
    expect(onPlaybackChange).toHaveBeenLastCalledWith(true);
    fireEvent.pause(video);
    expect(onPlaybackChange).toHaveBeenLastCalledWith(false);
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
