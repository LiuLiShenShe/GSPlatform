import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { findScene } from '../services/sceneApi';
import type { SceneSummary } from '../fixtures/scenes';
import { ViewerRightPanel } from '../features/viewer-shell/ViewerRightPanel';
import { OfficialViewerCanvas } from '../features/viewer-official/OfficialViewerCanvas';
import { OfficialViewerToolbar } from '../features/viewer-official/OfficialViewerToolbar';
import { AnnotationMediaOverlay } from '../features/viewer-official/AnnotationMediaOverlay';
import { useSuperSplatDesktop } from '../features/viewer-official/useSuperSplatDesktop';
import { useBackgroundAudio } from '../hooks/useBackgroundAudio';
import { SCENE_SCALE_WARNING } from '../scene-runtime/sceneScale';

/**
 * 全屏 Scene Viewer 页面（SSV-09 起仅官方 runtime）。
 *
 * 官方 SuperSplat runtime 是唯一路径（无 iframe、无 legacy 回退）：
 *   React → getSceneRuntime(sceneId) → SuperSplatRuntime(mode='desktop')
 *
 * SSV-09 删除 `?runtime=legacy` 回退（旧 fork ViewerAdapter 链路）与
 * `features/viewer/`、`services/scenes.local.ts`，生产 Web 不再引用 apps/viewer。
 */
export default function SceneViewerPage() {
  const { sceneId } = useParams<{ sceneId: string }>();
  const effectiveSceneId = sceneId ?? 'local-garden';
  useDocumentTitle(effectiveSceneId ? `场景 ${effectiveSceneId}` : '场景');

  return <OfficialDesktopViewer sceneId={effectiveSceneId} />;
}

/** 官方 SuperSplat runtime 唯一路径。 */
function OfficialDesktopViewer({ sceneId }: { sceneId: string }) {
  const state = useSuperSplatDesktop(sceneId);
  const [searchParams] = useSearchParams();

  // FIX-03 §5/§6/§7：背景音频由 GSPlatform 自建控制器管理（官方 soundUrl 无
  // volume/loop/enabled API，已停用）。descriptor 就绪后自动配置；场景切换/卸载释放。
  const backgroundAudio = useBackgroundAudio(state.descriptor?.backgroundAudio ?? null, sceneId);

  // 场景信息面板（作者/收藏/分享/问 AI/详情）：与 legacy 一致保留，
  // 走既有 findScene，不属于 runtime 层职责。
  const [scene, setScene] = useState<SceneSummary | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    findScene(sceneId, controller.signal).then(setScene);
    return () => controller.abort();
  }, [sceneId]);

  // SSV-06：媒体 Overlay 由官方选中标注驱动；关闭 Overlay 不清除官方 selection
  // （不清空 selectedGsplatformAnnotation，只在本地关闭；切换标注重新打开并自动更新）。
  const [overlayOpen, setOverlayOpen] = useState(false);
  const selectedAnnotation = state.selectedGsplatformAnnotation;
  useEffect(() => {
    if (selectedAnnotation) setOverlayOpen(true);
  }, [selectedAnnotation]);

  // SSV-07 实测：`?spawn=x,y,z` 在加载完成后把相机摆到指定世界位置（面向
  // +z）。开发/测试用 —— 无该参数时无任何行为差异。
  const spawn = searchParams.get('spawn');
  useEffect(() => {
    if (!state.loaded || !spawn) return;
    const [px, py, pz] = spawn.split(',').map(Number);
    if ([px, py, pz].every(Number.isFinite)) {
      state.setCameraPose({ position: [px, py, pz], target: [px, py + 0.1, pz + 0.5], fov: 85 });
    }
  }, [state.loaded, spawn]);

  return (
    <div className="gs-viewer-scene" data-testid="scene-viewer-page" data-runtime="official">
      <div className="gs-viewer__mount">
        <OfficialViewerCanvas state={state} />
        {/* SSV-07 §4：尺度异常告警 —— 禁止默默用错误尺度走路（Walk 也已禁用） */}
        {state.loaded && state.sceneScale.needsCalibration && (
          <div
            className="gs-viewer__scale-warning"
            data-testid="ov-scale-warning"
            role="alert"
          >
            {SCENE_SCALE_WARNING}
            <span className="gs-viewer__scale-warning-detail">
              (水平范围 ≈ {state.sceneScale.horizontalExtent.toFixed(2)} 单位)
            </span>
          </div>
        )}
        <AnnotationMediaOverlay
          annotation={overlayOpen ? selectedAnnotation : null}
          descriptor={state.descriptor}
          onClose={() => {
            // FIX-03 §7：关闭 Overlay 时恢复背景音频（卸载 audio/video 元素不保证
            // 触发 pause 事件 —— 关闭必须显式 resume）。
            setOverlayOpen(false);
            backgroundAudio.resume();
          }}
          onPlaybackChange={(isPlaying) =>
            isPlaying ? backgroundAudio.pause() : backgroundAudio.resume()
          }
        />
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
            // SSV-07：walk/碰撞/尺度真相 + 相机位置（e2e 取证用）
            walkAllowed: state.walkAllowed,
            hasCollision: state.hasCollision,
            collisionFormat: state.collisionFormat,
            sceneScale: {
              status: state.sceneScale.status,
              horizontalExtent: Number(state.sceneScale.horizontalExtent.toFixed(3)),
              verticalExtent: Number(state.sceneScale.verticalExtent.toFixed(3)),
            },
            // FIX-02 §4/§9：完整相机 pose（position/target/fov）+ 世界变换诊断。
            // e2e 刷新 /scene/:sceneId 后与数据库相机比较；worldTransform 报告
            // 归一化 W，sceneBounds 反映施加后的包围盒（entity 世界变换读取）。
            camera: (() => {
              try {
                const runtime = state.runtimeRef.current;
                if (!runtime) return null;
                const pose = runtime.getCameraPose();
                return pose
                  ? {
                      position: pose.position.map((v) => Number(v.toFixed(4))),
                      target: pose.target.map((v) => Number(v.toFixed(4))),
                      fov: Number(pose.fov.toFixed(2)),
                    }
                  : null;
              } catch {
                return null;
              }
            })(),
            worldTransform: (() => {
              try {
                const runtime = state.runtimeRef.current;
                if (!runtime) return null;
                const info = runtime.worldTransformInfo();
                const bounds = runtime.getSceneBounds();
                return {
                  position: Object.fromEntries(
                    Object.entries(info.position).map(([k, v]) => [k, Number(v.toFixed(4))]),
                  ),
                  rotation: Object.fromEntries(
                    Object.entries(info.rotation).map(([k, v]) => [k, Number(v.toFixed(4))]),
                  ),
                  scale: Object.fromEntries(
                    Object.entries(info.scale).map(([k, v]) => [k, Number(v.toFixed(4))]),
                  ),
                  isIdentity: info.isIdentity,
                  boundsAfter: bounds
                    ? {
                        min: bounds.min.map((v) => Number(v.toFixed(3))),
                        max: bounds.max.map((v) => Number(v.toFixed(3))),
                      }
                    : null,
                };
              } catch {
                return null;
              }
            })(),
          })}
        </span>
      </div>
      <OfficialViewerToolbar state={state} />
    </div>
  );
}
