/**
 * SceneAuthoringPage — scene creation/authoring page.
 *
 * Layout: left = live viewer preview, right = authoring panels
 * (Initial View / World Transform / Cover / Background / Rendering (Post Effects)
 *  / Annotations / Music / Viewpoints).
 *
 * SSV-05 迁移：预览 Viewer 走官方 SuperSplatRuntime（与 Desktop/XR 同一 wrapper，
 * 不再创建第二套 viewer）。相机数据一律经 SuperSplatRuntime 的封装方法
 * getCameraPose()/setCameraPose() 读写 —— 页面不直接触碰 PlayCanvas app。
 * 体验设置字段（初始视角/背景/tonemapping/post effects）保存成功后递增
 * authoring.settingsRevision → 页面用最新官方 settings 重建预览（实时预览 +
 * 刷新后保持）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Spin, Button, Space, Tag, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useSceneAuthoring } from '../features/authoring/useSceneAuthoring';
import { InitialViewPanel } from '../features/authoring/InitialViewPanel';
import { WorldTransformPanel } from '../features/authoring/WorldTransformPanel';
import { CoverPanel } from '../features/authoring/CoverPanel';
import { BackgroundPanel } from '../features/authoring/BackgroundPanel';
import { PostEffectsPanel } from '../features/authoring/PostEffectsPanel';
import { AnnotationPanel } from '../features/authoring/AnnotationPanel';
import { BackgroundMusicPanel } from '../features/authoring/BackgroundMusicPanel';
import { CollisionPanel } from '../features/authoring/CollisionPanel';
import { ViewpointPanel } from '../features/authoring/ViewpointPanel';
import { SuperSplatRuntime } from '../scene-runtime/SuperSplatRuntime';
import { buildExperienceSettings } from '../scene-runtime/experienceAdapter';
import { resolveSceneRuntimeDescriptor } from '../scene-runtime/descriptorResolver';
import type { SceneViewpoint } from '../services/presentationApi';
import type { SceneAnnotation } from '../services/annotationApi';
import {
  listAnnotations,
  createAnnotation as apiCreateAnnotation,
  updateAnnotation as apiUpdateAnnotation,
  deleteAnnotation as apiDeleteAnnotation,
} from '../services/annotationApi';

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
  const runtimeRef = useRef<SuperSplatRuntime | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerReady, setViewerReady] = useState(false);

  // Annotations (Phase 11)
  const [annotations, setAnnotations] = useState<SceneAnnotation[]>([]);
  const [pickingAnnotation, setPickingAnnotation] = useState(false);

  const authoring = useSceneAuthoring(effectiveSceneId);

  // 官方 SuperSplatRuntime 预览（SSV-05）：
  // descriptor → buildExperienceSettings（官方 settings v2）→ SuperSplatRuntime。
  // 体验设置保存成功后 authoring.settingsRevision 递增 → 用最新 settings 重建。
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let runtime: SuperSplatRuntime | null = null;
    setLoading(true);
    setViewerReady(false);

    const boot = async () => {
      try {
        const { descriptor } = await resolveSceneRuntimeDescriptor(effectiveSceneId);
        if (cancelled) return;
        if (!descriptor.content.url) {
          throw new Error('场景尚未发布，无法预览');
        }
        const settings = buildExperienceSettings(descriptor);
        runtime = await SuperSplatRuntime.create({
          container: containerRef.current!,
          contentUrl: descriptor.content.url,
          settings,
          posterUrl: descriptor.scene.posterUrl ?? undefined,
          collisionUrl: descriptor.collision?.url ?? undefined,
          mode: 'desktop',
        });
        if (cancelled) {
          runtime.destroy();
          return;
        }
        runtimeRef.current = runtime;
        // 闭包内保留非空引用（TS 收窄在回调里失效）。
        const active = runtime;
        active.onLoaded((loaded) => {
          if (!cancelled) {
            setViewerReady(loaded);
            // 与 /scene 页一致：loaded 后 frameScene，保证预览区可见场景。
            if (loaded) {
              try {
                active.frameScene();
              } catch (frameErr) {
                console.error('[authoring] frameScene failed', frameErr);
              }
            }
          }
        });
      } catch {
        if (!cancelled) message.error('场景加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void boot();

    return () => {
      cancelled = true;
      runtime?.destroy();
      runtimeRef.current = null;
    };
  }, [effectiveSceneId, authoring.settingsRevision]);

  // Load annotations on mount (Phase 11)
  useEffect(() => {
    let cancelled = false;
    listAnnotations(effectiveSceneId)
      .then((data) => { if (!cancelled) setAnnotations(data); })
      .catch(() => { /* allow editing without backend (dev mode) */ });
    return () => { cancelled = true; };
  }, [effectiveSceneId]);

  // --- Annotation handlers (Phase 11) ---

  const handlePickFromViewer = useCallback(() => {
    setPickingAnnotation(true);
  }, []);

  const handleCancelPick = useCallback(() => {
    setPickingAnnotation(false);
  }, []);

  const handleAnnotationPickClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pickingAnnotation) return;
    const runtime = runtimeRef.current;
    if (!runtime || !viewerReady) {
      message.warning('Viewer 未就绪，无法拾取位置');
      return;
    }
    // 容器内坐标 → NDC（x 向右、y 向上，均为 -1..1）
    const rect = e.currentTarget.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const hit = runtime.pickWorldPosition(ndcX, ndcY);
    if (!hit) {
      message.error('拾取位置失败，请确保场景已加载');
      return;
    }
    const [anchorX, anchorY, anchorZ] = hit.position;
    const ann = await apiCreateAnnotation(effectiveSceneId, { anchorX, anchorY, anchorZ });
    setAnnotations((prev) => [...prev, ann]);
    setPickingAnnotation(false);
    message.success('注解已创建');
  }, [pickingAnnotation, effectiveSceneId, viewerReady]);

  const handleUpdateAnnotation = useCallback(async (id: string, patch: Partial<SceneAnnotation>) => {
    const updated = await apiUpdateAnnotation(effectiveSceneId, id, patch);
    setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }, [effectiveSceneId]);

  const handleDeleteAnnotation = useCallback(async (id: string) => {
    await apiDeleteAnnotation(effectiveSceneId, id);
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, [effectiveSceneId]);

  // 当前相机 pose —— 经 SuperSplatRuntime 封装读取（页面不触碰 app）。
  const getCurrentPose = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || !viewerReady) return null;
    return runtime.getCameraPose();
  }, [viewerReady]);

  const handleSaveAll = useCallback(async () => {
    const pose = await getCurrentPose();
    if (!pose) {
      message.error('保存失败：Viewer 未就绪');
      return;
    }
    try {
      await authoring.setInitialView(pose);
      message.success('已保存（初始视角已更新）');
    } catch {
      message.error('保存失败');
    }
  }, [authoring, getCurrentPose]);

  const handleCaptureCover = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || !viewerReady) return;
    try {
      const result = await runtime.captureScreenshot({ width: 960, height: 540, supersample: 2 });
      if (!result) {
        message.error('截取封面失败，请确认 Viewer 已就绪');
        return;
      }
      const blob = await (await fetch(result.dataUrl)).blob();
      const file = new File([blob], 'cover.webp', { type: 'image/webp' });
      await authoring.uploadCover(file);
      message.success('封面已截取');
    } catch {
      message.error('截取封面失败');
    }
  }, [viewerReady, authoring.uploadCover]);

  const handleNavigateToViewpoint = useCallback(
    (vp: SceneViewpoint) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.setCameraPose({
        position: [vp.position.x, vp.position.y, vp.position.z],
        target: [vp.target.x, vp.target.y, vp.target.z],
        fov: vp.fov,
      });
    },
    [],
  );

  return (
    <div
      className="gs-authoring"
      data-testid="scene-authoring-page"
      style={{
        display: 'flex',
        gap: 16,
        // 顶栏 58px + 内容区上下 padding 24×2；让预览区有真实尺寸
        height: 'calc(100vh - var(--gs-topbar-height, 58px) - 52px)',
      }}
    >
      {/* Viewer preview（官方 SuperSplatRuntime） */}
      <div
        className="gs-authoring__viewer"
        onClick={handleAnnotationPickClick}
        style={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          borderRadius: 8,
          overflow: 'hidden',
          background: '#000',
          cursor: pickingAnnotation ? 'crosshair' : undefined,
        }}
      >
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
      <div
        className="gs-authoring__side"
        aria-label="场景创作面板"
        style={{ width: 380, flexShrink: 0, overflowY: 'auto', maxHeight: '100%' }}
      >
        <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
          <Tag color={viewerReady ? 'green' : 'default'}>
            {viewerReady ? 'Viewer 就绪' : '连接中…'}
          </Tag>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSaveAll}>
            保存当前视角
          </Button>
        </Space>

        <InitialViewPanel
          presentation={authoring.presentation}
          onSetInitialView={authoring.setInitialView}
          onGetCurrentPose={getCurrentPose}
        />
        <PostEffectsPanel
          presentation={authoring.presentation}
          saving={authoring.saving}
          onSetTonemapping={authoring.setTonemapping}
          onSetHighPrecisionRendering={authoring.setHighPrecisionRendering}
          onSetPostEffects={authoring.setPostEffects}
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
        <AnnotationPanel
          annotations={annotations}
          picking={pickingAnnotation}
          onCreate={(x, y, z) => {
            void apiCreateAnnotation(effectiveSceneId, { anchorX: x, anchorY: y, anchorZ: z })
              .then((ann) => setAnnotations((prev) => [...prev, ann]));
          }}
          onUpdate={handleUpdateAnnotation}
          onDelete={handleDeleteAnnotation}
          onPickFromViewer={handlePickFromViewer}
          onCancelPick={handleCancelPick}
        />
        <BackgroundMusicPanel
          presentation={authoring.presentation}
          sceneId={effectiveSceneId}
          onUpdated={() => {
            void authoring.refreshPresentation();
          }}
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
        <CollisionPanel
          sceneId={effectiveSceneId}
          isOwner={true}
        />
      </div>
    </div>
  );
}