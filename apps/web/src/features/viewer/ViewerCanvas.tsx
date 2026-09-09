import { Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { ViewerLifecycleState } from './useViewerLifecycle';
import { ViewerErrorState } from './ViewerErrorState';

interface ViewerCanvasProps {
  lifecycle: ViewerLifecycleState;
}

/**
 * Canvas 挂载区：把 containerRef 绑到真实 3D 容器上。
 * 加载时显示真实加载提示（无伪进度条），错误时显示可恢复错误。
 */
export function ViewerCanvas({ lifecycle }: ViewerCanvasProps) {
  const { containerRef, status, error, errorCode, retry } = lifecycle;
  const navigate = useNavigate();

  return (
    <div className="gs-viewer__canvas" data-testid="viewer-mount">
      <div ref={containerRef} className="gs-viewer__canvas-host" data-testid="viewer-canvas-host" />

      {status === 'loading' && (
        <div className="gs-viewer__overlay" data-testid="viewer-loading">
          <Spin size="large" />
          <span>场景加载中…</span>
        </div>
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