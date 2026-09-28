/**
 * useSceneAuthoring hook — owns the full presentation + viewpoint state
 * for the authoring page. Reads from API on mount, exposes setters
 * that persist changes, and signals the page when an experience-setting
 * field changes so the preview runtime can be recreated with fresh
 * official settings (SSV-05: settings v2 live preview + save/reload).
 *
 * The hook never touches the PlayCanvas app; camera data flows through
 * SuperSplatRuntime's encapsulated getCameraPose()/setCameraPose().
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import type {
  RuntimePostEffects,
  RuntimeTonemapping,
} from '../../scene-runtime/types';
import type { ScenePresentation, SceneViewpoint, Vec3 } from '../../services/presentationApi';
import {
  getPresentation,
  updatePresentation,
  uploadCover as apiUploadCover,
  uploadBackground as apiUploadBackground,
  listViewpoints,
  createViewpoint as apiCreateViewpoint,
  updateViewpoint as apiUpdateViewpoint,
  deleteViewpoint as apiDeleteViewpoint,
  reorderViewpoints as apiReorderViewpoints,
} from '../../services/presentationApi';

export interface AuthoringState {
  // Presentation
  presentation: ScenePresentation | null;
  saving: boolean;
  lastSaved: Date | null;
  /** 体验设置字段（初始视角/背景/tonemapping/post effects）保存成功的次数；
   *  页面据此重建预览 runtime 以反映最新官方 settings。 */
  settingsRevision: number;

  // Viewpoints
  viewpoints: SceneViewpoint[];
  activeViewpointId: string | null;

  // Actions — presentation
  setWorldPosition: (v: Vec3) => Promise<void>;
  setWorldRotation: (v: Vec3) => Promise<void>;
  setWorldScale: (v: Vec3) => Promise<void>;
  setInitialView: (pose: CameraPose) => Promise<void>;
  setBackgroundType: (type: 'color' | 'equirectangular') => Promise<void>;
  setBackgroundColor: (color: Vec3) => Promise<void>;
  setTonemapping: (value: RuntimeTonemapping) => Promise<void>;
  setHighPrecisionRendering: (value: boolean) => Promise<void>;
  setPostEffects: (fx: RuntimePostEffects) => Promise<void>;
  uploadCover: (file: File) => Promise<void>;
  uploadBackground: (file: File, lat?: number, lon?: number) => Promise<void>;

  // Actions — viewpoints
  addViewpoint: (name: string, pose: CameraPose) => Promise<void>;
  updateViewpoint: (id: string, patch: Partial<Pick<SceneViewpoint, 'name' | 'position' | 'target' | 'fov' | 'enabled'>>) => Promise<void>;
  deleteViewpoint: (id: string) => Promise<void>;
  reorderViewpoints: (ids: string[]) => Promise<void>;
  setActiveViewpoint: (id: string | null) => void;

  /** 重新拉取 presentation（背景音频等面板自行发起更新后同步 UI）。 */
  refreshPresentation: () => Promise<void>;
}

export function useSceneAuthoring(sceneId: string): AuthoringState {
  const [presentation, setPresentation] = useState<ScenePresentation | null>(null);
  const [viewpoints, setViewpoints] = useState<SceneViewpoint[]>([]);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [activeViewpointId, setActiveViewpointId] = useState<string | null>(null);

  const sceneIdRef = useRef(sceneId);
  sceneIdRef.current = sceneId;

  // Load on mount
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [pres, vps] = await Promise.all([
          getPresentation(sceneId),
          listViewpoints(sceneId),
        ]);
        if (!cancelled) {
          setPresentation(pres);
          setViewpoints(vps);
        }
      } catch {
        // allow editing without backend (dev mode)
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [sceneId]);

  // --- Presentation setters (optimistic) ---

  const savePresentation = useCallback(async (patch: Partial<ScenePresentation>) => {
    setSaving(true);
    try {
      const updated = await updatePresentation(sceneIdRef.current, patch);
      setPresentation(updated);
      setLastSaved(new Date());
      return updated;
    } finally {
      setSaving(false);
    }
  }, []);

  /** 体验设置字段保存成功 → 递增 revision，通知页面重建预览。 */
  const saveExperience = useCallback(
    async (patch: Partial<ScenePresentation>) => {
      const updated = await savePresentation(patch);
      setSettingsRevision((r) => r + 1);
      return updated;
    },
    [savePresentation],
  );

  const setWorldPosition = useCallback(async (v: Vec3) => {
    setPresentation(p => p ? { ...p, worldPosition: v } : p);
    await savePresentation({ worldPosition: v });
  }, [savePresentation]);

  const setWorldRotation = useCallback(async (v: Vec3) => {
    setPresentation(p => p ? { ...p, worldRotation: v } : p);
    await savePresentation({ worldRotation: v });
  }, [savePresentation]);

  const setWorldScale = useCallback(async (v: Vec3) => {
    setPresentation(p => p ? { ...p, worldScale: v } : p);
    await savePresentation({ worldScale: v });
  }, [savePresentation]);

  const setInitialView = useCallback(async (pose: CameraPose) => {
    const patch: Partial<ScenePresentation> = {
      initialCameraPosition: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
      initialCameraTarget: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      initialCameraFov: pose.fov,
    };
    setPresentation(p => p ? { ...p, ...patch } : p);
    await saveExperience(patch);
  }, [saveExperience]);

  const setBackgroundType = useCallback(async (type: 'color' | 'equirectangular') => {
    setPresentation(p => p ? { ...p, backgroundType: type } : p);
    await saveExperience({ backgroundType: type });
  }, [saveExperience]);

  const setBackgroundColor = useCallback(async (color: Vec3) => {
    setPresentation(p => p ? { ...p, backgroundColor: color } : p);
    await saveExperience({ backgroundColor: color });
  }, [saveExperience]);

  const setTonemapping = useCallback(async (value: RuntimeTonemapping) => {
    setPresentation(p => p ? { ...p, tonemapping: value } : p);
    await saveExperience({ tonemapping: value });
  }, [saveExperience]);

  const setHighPrecisionRendering = useCallback(async (value: boolean) => {
    setPresentation(p => p ? { ...p, highPrecisionRendering: value } : p);
    await saveExperience({ highPrecisionRendering: value });
  }, [saveExperience]);

  const setPostEffects = useCallback(async (fx: RuntimePostEffects) => {
    setPresentation(p => p ? { ...p, postEffects: fx } : p);
    await saveExperience({ postEffects: fx });
  }, [saveExperience]);

  const uploadCover = useCallback(async (file: File) => {
    setSaving(true);
    try {
      const updated = await apiUploadCover(sceneIdRef.current, file);
      setPresentation(updated);
      setLastSaved(new Date());
    } finally {
      setSaving(false);
    }
  }, []);

  const uploadBackground = useCallback(async (file: File, lat?: number, lon?: number) => {
    setSaving(true);
    try {
      const updated = await apiUploadBackground(sceneIdRef.current, file, { latitude: lat, longitude: lon });
      setPresentation(updated);
      setLastSaved(new Date());
      setSettingsRevision((r) => r + 1); // skybox → 重建预览
    } finally {
      setSaving(false);
    }
  }, []);

  // --- Viewpoints ---

  const addViewpoint = useCallback(async (name: string, pose: CameraPose) => {
    const vp = await apiCreateViewpoint(sceneIdRef.current, {
      name,
      position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
      target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      fov: pose.fov,
    });
    setViewpoints(vps => [...vps, vp]);
  }, []);

  const updateViewpoint = useCallback(async (id: string, patch: Partial<Pick<SceneViewpoint, 'name' | 'position' | 'target' | 'fov' | 'enabled'>>) => {
    const updated = await apiUpdateViewpoint(sceneIdRef.current, id, patch);
    setViewpoints(vps => vps.map(vp => vp.id === id ? updated : vp));
  }, []);

  const deleteViewpoint = useCallback(async (id: string) => {
    await apiDeleteViewpoint(sceneIdRef.current, id);
    setViewpoints(vps => vps.filter(vp => vp.id !== id));
    if (activeViewpointId === id) setActiveViewpointId(null);
  }, [activeViewpointId]);

  const reorderViewpoints = useCallback(async (ids: string[]) => {
    const reordered = await apiReorderViewpoints(sceneIdRef.current, ids);
    setViewpoints(reordered);
  }, []);

  /** 重新拉取 presentation（背景音频更新后同步 UI；不触发预览重建）。 */
  const refreshPresentation = useCallback(async () => {
    try {
      const pres = await getPresentation(sceneIdRef.current);
      setPresentation(pres);
    } catch {
      // allow editing without backend (dev mode)
    }
  }, []);

  return {
    presentation,
    saving,
    lastSaved,
    settingsRevision,
    viewpoints,
    activeViewpointId,
    setWorldPosition,
    setWorldRotation,
    setWorldScale,
    setInitialView,
    setBackgroundType,
    setBackgroundColor,
    setTonemapping,
    setHighPrecisionRendering,
    setPostEffects,
    uploadCover,
    uploadBackground,
    addViewpoint,
    updateViewpoint,
    deleteViewpoint,
    reorderViewpoints,
    setActiveViewpoint: setActiveViewpointId,
    refreshPresentation,
  };
}