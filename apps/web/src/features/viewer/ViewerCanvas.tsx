import { useNavigate } from 'react-router-dom';
import type { ViewerLifecycleState } from './useViewerLifecycle';
import { ViewerErrorState } from './ViewerErrorState';
import { LoadingOverlay } from './loading/LoadingOverlay';
import { StreamingStatus, type StreamingPhase } from './StreamingStatus';

interface ViewerCanvasProps {
  lifecycle: ViewerLifecycleState;
}

/** Map the load phase to the streamed-status indicator phase. */
function streamPhase(lifecycle: ViewerLifecycleState): StreamingPhase {
  const { status, phase } = lifecycle;
  if (status === 'error') return 'error';
  if (phase === 'READY' || status === 'ready') return 'initial-view-ready';
  if (status === 'loading') return 'interactive-ready';
  return 'loading-manifest';
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
    isStreamed,
    streamingMetrics,
    qualityMode,
  } = lifecycle;
  const navigate = useNavigate();

  // The hook keeps the overlay mounted for a short dissolve window at 100%
  // after READY; error/cancelled paths hide it via status/phase as before.
  const showOverlay =
    overlayVisible &&
    (status === 'loading' ||
      (status === 'ready' && phase !== 'ERROR' && phase !== 'CANCELLED'));

  // Streamed scenes get a compact phase/residency badge (Phase 04 checklist G).
  const residentChunks = streamingMetrics?.gpuResident ?? 0;
  const targetChunks = streamingMetrics?.chunksCompleted ?? 0;

  return (
    <div className="gs-viewer__canvas" data-testid="viewer-mount">
      <div ref={containerRef} className="gs-viewer__canvas-host" data-testid="viewer-canvas-host" />

      {isStreamed && !showOverlay && (
        <div className="gs-viewer__stream-status" style={{ position: 'absolute', top: 12, left: 12, zIndex: 5 }}>
          <StreamingStatus
            phase={streamPhase(lifecycle)}
            progress={progress != null ? progress / 100 : 0}
            residentChunks={residentChunks}
            targetChunks={Math.max(1, targetChunks)}
            qualityLabel={qualityMode === 'eco' ? '省流' : qualityMode === 'quality' ? '高质量' : '自动'}
            errorMessage={error ?? undefined}
          />
        </div>
      )}

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
