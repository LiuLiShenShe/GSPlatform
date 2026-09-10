import { useNavigate } from 'react-router-dom';
import type { ViewerLifecycleState } from './useViewerLifecycle';
import { ViewerErrorState } from './ViewerErrorState';
import { LoadingOverlay } from './loading/LoadingOverlay';

interface ViewerCanvasProps {
  lifecycle: ViewerLifecycleState;
}

/**
 * Canvas 挂载区：把 containerRef 绑到真实 3D 容器上。
 *
 * 加载期显示真实进度 Poster + 进度条（Phase 03），低 LOD 首帧后退场，
 * 错误时显示可恢复错误；不使用伪进度或 CSS 动画驱动的假百分比。
 */
export function ViewerCanvas({ lifecycle }: ViewerCanvasProps) {
  const {
    containerRef,
    status,
    error,
    errorCode,
    retry,
    progress,
    phase,
    loadedBytes,
    totalBytes,
    indeterminate,
    currentLod,
    posterUrl,
    placeholderColor,
    overlayVisible,
    cancelLoad,
  } = lifecycle;
  const navigate = useNavigate();

  // The hook keeps the overlay mounted for a short dissolve window at 100%
  // after READY; error/cancelled paths hide it via status/phase as before.
  const showOverlay =
    overlayVisible &&
    (status === 'loading' ||
      (status === 'ready' && phase !== 'ERROR' && phase !== 'CANCELLED'));

  return (
    <div className="gs-viewer__canvas" data-testid="viewer-mount">
      <div ref={containerRef} className="gs-viewer__canvas-host" data-testid="viewer-canvas-host" />

      {showOverlay && (
        <LoadingOverlay
          percent={progress}
          phase={phase}
          loadedBytes={loadedBytes}
          totalBytes={totalBytes}
          indeterminate={indeterminate}
          posterUrl={posterUrl}
          placeholderColor={placeholderColor}
          onCancel={cancelLoad}
          onBack={() => navigate('/')}
          currentLod={currentLod}
        />
      )}

      {status === 'error' && (
        <ViewerErrorState
          errorCode={errorCode}
          message={error}
          onRetry={retry}
          onBack={() => navigate('/')}
        />
      )}
    </div>
  );
}
