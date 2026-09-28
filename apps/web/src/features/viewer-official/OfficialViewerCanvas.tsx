/**
 * Official Desktop Viewer 挂载区（SSV-03）—— 无 iframe。
 *
 * containerRef 直接挂到官方 SuperSplat viewer 的宿主 div；
 * 加载期显示真实 onProgress 进度 + poster；错误时显示可恢复错误。
 * 复用 legacy 的容器/进度 CSS 类名，不引入新布局体系。
 */
import { Progress } from 'antd';
import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { OfficialDesktopViewerState } from './useSuperSplatDesktop';

interface OfficialViewerCanvasProps {
  state: OfficialDesktopViewerState;
}

export function OfficialViewerCanvas({ state }: OfficialViewerCanvasProps) {
  const { status, error, retry, progress, loaded, descriptor } = state;
  const navigate = useNavigate();

  const posterUrl = descriptor?.scene.posterUrl ?? null;
  const showOverlay = status === 'loading' && !loaded;

  return (
    <div className="gs-viewer__canvas" data-testid="ov-mount">
      {/* 官方 viewer 宿主：SuperSplatRuntime.create 在此渲染（非 iframe） */}
      <div ref={state.containerRef} className="gs-viewer__canvas-host" data-testid="ov-canvas-host" />

      {showOverlay && (
        <div className="gs-viewer__overlay" data-testid="ov-loading">
          {posterUrl && (
            <div className="gs-viewer__poster-backdrop">
              <img className="gs-viewer__poster-img" src={posterUrl} alt="" data-testid="ov-poster" />
            </div>
          )}
          <div className="gs-viewer__progressive-center">
            <div className="gs-viewer__progressive-title" data-testid="ov-status-text">
              场景加载中…
            </div>
            <Progress
              className="gs-viewer__progressive-bar"
              percent={Math.round(progress)}
              showInfo={false}
              strokeColor="#4a90d9"
            />
            <div className="gs-viewer__progressive-bytes" data-testid="ov-progress">
              {Math.round(progress)}%
            </div>
            <div className="gs-viewer__progressive-actions">
              <Button onClick={() => navigate('/')}>返回</Button>
            </div>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="gs-viewer__overlay" data-testid="ov-error">
          <div className="gs-viewer__progressive-center">
            <div className="gs-viewer__progressive-title">场景加载失败</div>
            <div className="gs-viewer__error-detail">{error}</div>
            <div className="gs-viewer__progressive-actions">
              <Button type="primary" onClick={retry} data-testid="ov-retry">
                重试
              </Button>
              <Button onClick={() => navigate('/')}>返回</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
