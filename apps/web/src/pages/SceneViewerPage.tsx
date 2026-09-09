import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { findScene } from '../services/sceneApi';
import { ViewerCanvas } from '../features/viewer/ViewerCanvas';
import { ViewerToolbar } from '../features/viewer/ViewerToolbar';
import { useViewerLifecycle } from '../features/viewer/useViewerLifecycle';
import { ViewerRightPanel } from '../features/viewer-shell/ViewerRightPanel';

/**
 * 全屏 Scene Viewer 页面。
 * 通过 ViewerAdapter 挂载 SuperSplat Viewer fork 并真实加载 SOG 场景；
 * 不再绘制任何伪造的高斯场景或伪进度。
 */
export default function SceneViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? 'local-garden';
  useDocumentTitle(effectiveSceneId ? `场景 ${effectiveSceneId}` : '场景');

  const lifecycle = useViewerLifecycle(effectiveSceneId);
  const scene = findScene(effectiveSceneId);

  return (
    <div className="gs-viewer-scene" data-testid="scene-viewer-page">
      <div className="gs-viewer__mount">
        <ViewerCanvas lifecycle={lifecycle} />
        <ViewerRightPanel scene={scene} />
      </div>
      <ViewerToolbar lifecycle={lifecycle} />
    </div>
  );
}