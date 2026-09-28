import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { findScene } from '../services/sceneApi';
import type { SceneSummary } from '../fixtures/scenes';
import { ViewerCanvas } from '../features/viewer/ViewerCanvas';
import { ViewerToolbar } from '../features/viewer/ViewerToolbar';
import { useViewerLifecycle } from '../features/viewer/useViewerLifecycle';
import { ViewerRightPanel } from '../features/viewer-shell/ViewerRightPanel';
import { OfficialViewerCanvas } from '../features/viewer-official/OfficialViewerCanvas';
import { OfficialViewerToolbar } from '../features/viewer-official/OfficialViewerToolbar';
import { useSuperSplatDesktop } from '../features/viewer-official/useSuperSplatDesktop';

/**
 * 全屏 Scene Viewer 页面（SSV-03 迁移后）。
 *
 * 默认走官方 SuperSplat runtime（无 iframe）：
 *   React → getSceneRuntime(sceneId) → SuperSplatRuntime(mode='desktop')
 *
 * 开发/回退：`?runtime=legacy` 切回旧 fork ViewerAdapter 链路（ViewerCanvas/
 * ViewerToolbar/useViewerLifecycle 原样保留，未删除未修改）。生产 UI 不提供
 * 该切换按钮；SSV-09 删除 legacy 分支。
 */
export default function SceneViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? 'local-garden';
  useDocumentTitle(effectiveSceneId ? `场景 ${effectiveSceneId}` : '场景');

  const [searchParams] = useSearchParams();
  const isLegacy = searchParams.get('runtime') === 'legacy';

  if (isLegacy) {
    return <LegacyDesktopViewer sceneId={effectiveSceneId} />;
  }
  return <OfficialDesktopViewer sceneId={effectiveSceneId} />;
}

/** 官方 SuperSplat runtime 默认路径（SSV-03）。 */
function OfficialDesktopViewer({ sceneId }: { sceneId: string }) {
  const state = useSuperSplatDesktop(sceneId);

  // 场景信息面板（作者/收藏/分享/问 AI/详情）：与 legacy 一致保留，
  // 走既有 findScene，不属于 runtime 层职责。
  const [scene, setScene] = useState<SceneSummary | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    findScene(sceneId, controller.signal).then(setScene);
    return () => controller.abort();
  }, [sceneId]);

  return (
    <div className="gs-viewer-scene" data-testid="scene-viewer-page" data-runtime="official">
      <div className="gs-viewer__mount">
        <OfficialViewerCanvas state={state} />
        <ViewerRightPanel scene={scene} />
        {/* 视觉隐藏的真实运行态读数（e2e 取证：renderer / 已渲染 Gaussian 数 / 首帧） */}
        <span
          data-testid="ov-diagnostics"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {JSON.stringify({
            renderer: state.renderer,
            gsplats: state.gsplats,
            loaded: state.loaded,
            progress: Math.round(state.progress),
            cameraMode: state.cameraMode,
            performanceMode: state.performanceMode,
            showAnnotations: state.showAnnotations,
            contentUrl: state.descriptor?.content.url ?? null,
            format: state.descriptor?.content.format ?? null,
            isManifestFallback: state.isManifestFallback,
            error: state.error,
          })}
        </span>
      </div>
      <OfficialViewerToolbar state={state} />
    </div>
  );
}

/** legacy fork ViewerAdapter 路径（`?runtime=legacy`，SSV-09 删除）。 */
function LegacyDesktopViewer({ sceneId }: { sceneId: string }) {
  const lifecycle = useViewerLifecycle(sceneId);

  const [scene, setScene] = useState<SceneSummary | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    findScene(sceneId, controller.signal).then((result) => {
      setScene(result);
    });
    return () => controller.abort();
  }, [sceneId]);

  return (
    <div className="gs-viewer-scene" data-testid="scene-viewer-page" data-runtime="legacy">
      <div className="gs-viewer__mount">
        <ViewerCanvas lifecycle={lifecycle} />
        <ViewerRightPanel scene={scene} />
      </div>
      <ViewerToolbar lifecycle={lifecycle} />
    </div>
  );
}
