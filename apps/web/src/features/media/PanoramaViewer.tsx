/**
 * PanoramaViewer（FIX-03 §2/§3/§4）—— 真实 Equirectangular 360° Viewer。
 *
 * 技术选型（§3）：`@photo-sphere-viewer/core`（MIT，维护良好，与 `three` 0.185.1 锁定）。
 *   - package: @photo-sphere-viewer/core@5.15.1（精确锁定）
 *   - license: MIT
 *   - reason: 轻量、成熟、支持 2:1 equirectangular 球面映射、drag/touch、FOV zoom、
 *     fullscreen；未手写 WebGL panorama engine（§3 允许依赖时禁止自写）。
 *
 * 能力（§2）：
 *   - 2:1 equirectangular 球面映射（PSV 默认 EquirectangularAdapter）；
 *   - mouse/touch drag（PSV 内置 drag + inertia）；
 *   - FOV zoom（鼠标滚轮 / 双指 + navbar 缩放按钮，minFov..maxFov）；
 *   - fullscreen（PSV navbar 内置全屏按钮 → requestFullscreen）。
 *
 * 资源释放（§4）：unmount → viewer.destroy()（释放 WebGL context / 事件监听 /
 * 纹理），容器清空。加载失败 → error 态（显示占位，不伪造 360°）。
 */
import { useEffect, useRef, useState } from 'react';
import { Viewer, type ViewerConfig } from '@photo-sphere-viewer/core';

export interface PanoramaViewerProps {
  /** 等距柱状 360° 图片 URL（2:1）。null → 不渲染。 */
  mediaUrl: string | null;
  /** 无障碍 / 标题展示。 */
  title?: string;
}

export const PANORAMA_FOV_RANGE = { min: 40, max: 110 } as const;

export function PanoramaViewer({ mediaUrl, title }: PanoramaViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!mediaUrl || !containerRef.current) return undefined;
    const container = containerRef.current;
    // 重置状态（切换标注重挂组件时清错误）。
    setError(null);
    setReady(false);

    const config: ViewerConfig = {
      container,
      panorama: mediaUrl,
      // 2:1 equirectangular 是 PSV 默认 adapter（EquirectangularAdapter）—— 不显式传。
      minFov: PANORAMA_FOV_RANGE.min,
      maxFov: PANORAMA_FOV_RANGE.max,
      mousewheel: true,
      touchmoveTwoFingers: true,
      moveSpeed: 1,
      navbar: ['zoom', 'fullscreen'],
      lang: {
        zoom: '缩放',
        fullscreen: '全屏',
        moveUp: '上移',
        moveDown: '下移',
        moveLeft: '左移',
        moveRight: '右移',
        default: '默认视图',
      },
    };
    let viewer: Viewer;
    try {
      viewer = new Viewer(config);
      viewerRef.current = viewer;
      viewer.addEventListener('ready', () => setReady(true), { once: true });
      viewer.addEventListener('panorama-error', (e: unknown) => {
        // PSV 5.x PanoramaErrorEvent：payload.error 为 Error 实例。
        const message =
          e && typeof e === 'object' && 'error' in e && (e as { error: unknown }).error instanceof Error
            ? (e as { error: Error }).error.message
            : errorMessage(e);
        setError(message);
      });
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    }

    // 释放：WebGL context / 事件监听 / 纹理 / DOM（§4）。
    return () => {
      viewerRef.current = null;
      try {
        viewer.destroy();
      } catch {
        // destroy 幂等/异常安全。
      }
      // 清空容器（PSV destroy 后残留的子节点不保证清空）。
      while (container.firstChild) container.removeChild(container.firstChild);
    };
  }, [mediaUrl]);

  if (!mediaUrl) return null;

  return (
    <div className="gs-panorama" data-testid="annotation-media-panorama">
      <div ref={containerRef} className="gs-panorama__stage" aria-label={title ?? '360° 全景'} />
      {error ? (
        <div className="gs-panorama__error" data-testid="panorama-error">
          360° 全景加载失败（{error}）
        </div>
      ) : !ready ? (
        <div className="gs-panorama__loading" data-testid="panorama-loading">
          360° 全景加载中…
        </div>
      ) : null}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
