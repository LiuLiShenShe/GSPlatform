/**
 * SceneAuthoringPage — scene creation/authoring page.
 *
 * Layout: left = live viewer preview, right = authoring panels
 * (Initial View / World Transform / Cover / Background / Viewpoints).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Spin, Button, Space, Tag, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { createViewer, type ViewerHandle, type ViewerCameraPose } from '@gsplatform/viewer';
import { resolveProgressiveScene, resolveStreamedScene } from '../services/scenes.local';
import { useSceneAuthoring } from '../features/authoring/useSceneAuthoring';
import { InitialViewPanel } from '../features/authoring/InitialViewPanel';
import { WorldTransformPanel } from '../features/authoring/WorldTransformPanel';
import { CoverPanel } from '../features/authoring/CoverPanel';
import { BackgroundPanel } from '../features/authoring/BackgroundPanel';
import { ViewpointPanel } from '../features/authoring/ViewpointPanel';
import type { SceneViewpoint } from '../services/presentationApi';
import { updatePresentation } from '../services/presentationApi';

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export default function SceneAuthoringPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? 'local-garden';
  useDocumentTitle(effectiveSceneId ? `编辑 ${effectiveSceneId}` : '编辑场景');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerReady, setViewerReady] = useState(false);

  const authoring = useSceneAuthoring(effectiveSceneId);

  // Mount viewer iframe
  useEffect(() => {
    if (!containerRef.current) return;
    let viewer: ViewerHandle | null = null;
    let disposed = false;

    const boot = async () => {
      try {
        viewer = createViewer(containerRef.current!, {});
        viewerRef.current = viewer;

        viewer.on('ready', () => {
          if (!disposed) setViewerReady(true);
        });

        // Load the scene (streamed-SOG preferred, fallback progressive)
        try {
          const streamed = await resolveStreamedScene(effectiveSceneId);
          if (!disposed && viewer) {
            await viewer.loadScene({
              id: streamed.manifest.sceneId,
              title: streamed.manifest.title ?? effectiveSceneId,
              format: 'streamed-sog',
              assetUrl: streamed.entryUrl,
              camera: streamed.manifest.camera ?? undefined,
            });
          }
        } catch {
          // fall back to progressive
          const resolved = await resolveProgressiveScene(effectiveSceneId);
          if (!disposed && viewer) {
            await viewer.loadScene({
              id: resolved.descriptor.id,
              title: resolved.descriptor.title ?? effectiveSceneId,
              format: resolved.descriptor.format,
              assetUrl: resolved.descriptor.assetUrl,
              camera: resolved.descriptor.camera ?? undefined,
            });
          }
        }
      } catch {
        if (!disposed) message.error('场景加载失败');
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void boot();

    return () => {
      disposed = true;
      viewer?.destroy();
      viewerRef.current = null;
    };
  }, [effectiveSceneId]);

  const getCurrentPose = useCallback(async (): Promise<ViewerCameraPose | null> => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady) return null;
    try {
      const { camera } = await viewer.getCameraPose();
      return camera;
    } catch {
      return null;
    }
  }, [viewerReady]);

  const handleSaveAll = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady) return;
    try {
      const { camera } = await viewer.getCameraPose();
      await updatePresentation(effectiveSceneId, {
        initialCameraPosition: { x: camera.position[0], y: camera.position[1], z: camera.position[2] },
        initialCameraTarget: { x: camera.target[0], y: camera.target[1], z: camera.target[2] },
        initialCameraFov: camera.fov,
      });
      message.success('已保存');
    } catch {
      message.error('保存失败');
    }
  }, [viewerReady, effectiveSceneId]);

  const handleCaptureCover = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady) return;
    try {
      const { dataUrl } = await viewer.captureScreenshot({ format: 'webp', quality: 0.9 });
      // Convert dataUrl → File and upload via the cover endpoint.
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], 'cover.webp', { type: 'image/webp' });
      authoring.uploadCover(file);
      message.success('封面已截取');
    } catch {
      message.error('截取封面失败，请确认 Viewer 已就绪');
    }
  }, [viewerReady, authoring.uploadCover]);

  const handleNavigateToViewpoint = useCallback(
    (vp: SceneViewpoint) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      void viewer.setCameraPose({
        position: [vp.position.x, vp.position.y, vp.position.z],
        target: [vp.target.x, vp.target.y, vp.target.z],
        fov: vp.fov,
      });
    },
    [],
  );

  return (
    <div className="gs-authoring" data-testid="scene-authoring-page">
      {/* Viewer preview */}
      <div className="gs-authoring__viewer">
        {loading && (
          <div className="gs-authoring__loading">
            <Spin tip="加载场景…" />
          </div>
        )}
        <div
          ref={containerRef}
          className="gs-authoring__mount"
          style={{ position: 'absolute', inset: 0 }}
        />
      </div>

      {/* Right-hand panels */}
      <div className="gs-authoring__side" aria-label="场景创作面板">
        <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
          <Tag color={viewerReady ? 'green' : 'default'}>
            {viewerReady ? 'Viewer 就绪' : '连接中…'}
          </Tag>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSaveAll}>
            保存
          </Button>
        </Space>

        <InitialViewPanel
          presentation={authoring.presentation}
          onSetInitialView={authoring.setInitialView}
          onGetCurrentPose={getCurrentPose}
        />
        <WorldTransformPanel
          presentation={authoring.presentation}
          onSetWorldRotation={authoring.setWorldRotation}
          onSetWorldScale={authoring.setWorldScale}
        />
        <CoverPanel
          presentation={authoring.presentation}
          onUploadCover={authoring.uploadCover}
          onCaptureCover={handleCaptureCover}
        />
        <BackgroundPanel
          presentation={authoring.presentation}
          onSetBackgroundType={authoring.setBackgroundType}
          onSetBackgroundColor={authoring.setBackgroundColor}
          onUploadBackground={authoring.uploadBackground}
        />
        <ViewpointPanel
          viewpoints={authoring.viewpoints}
          activeViewpointId={authoring.activeViewpointId}
          onAdd={authoring.addViewpoint}
          onDelete={authoring.deleteViewpoint}
          onRename={(id, name) => authoring.updateViewpoint(id, { name })}
          onToggleEnabled={(id, enabled) => authoring.updateViewpoint(id, { enabled })}
          onSetActive={authoring.setActiveViewpoint}
          onGetCurrentPose={getCurrentPose}
          onNavigateToViewpoint={handleNavigateToViewpoint}
        />
      </div>
    </div>
  );
}