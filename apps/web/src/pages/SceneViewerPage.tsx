import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { findScene } from '../services/sceneApi';
import { ViewerBottomToolbar } from '../features/viewer-shell/ViewerBottomToolbar';
import { ViewerRightPanel } from '../features/viewer-shell/ViewerRightPanel';

/**
 * 全屏 Scene Viewer 页面外壳。
 * 本阶段不绘制任何伪造的高斯场景或伪进度；仅提供真实挂载容器与工具外壳。
 */
export default function SceneViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  useDocumentTitle(sceneId ? `场景 ${sceneId}` : '场景');

  const scene = sceneId ? findScene(sceneId) : undefined;

  return (
    <div className="gs-viewer-scene" data-testid="scene-viewer-page">
      <div className="gs-viewer__mount" data-testid="viewer-mount">
        <div className="gs-viewer__mount-text">
          <strong>Viewer 挂载区域</strong>
          <br />
          Phase 02 将在此集成 SuperSplat Viewer fork 并真实加载 SOG 场景（
          {scene ? scene.title : `本地 fixture: ${sceneId}`}）。
          <br />
          当前阶段不渲染任何伪造的 3D 场景或伪进度。
        </div>
        <ViewerRightPanel scene={scene} />
      </div>
      <ViewerBottomToolbar />
    </div>
  );
}