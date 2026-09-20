/**
 * useSceneAuthoring hook — owns the full presentation + viewpoint state
 * for the authoring page. Reads from API on mount, exposes setters
 * that persist changes, and provides a bridge to the viewer's camera.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerHandle, ViewerCameraPose } from '@gsplatform/viewer';
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

  // Viewpoints
  viewpoints: SceneViewpoint[];
  activeViewpointId: string | null;

  // Viewer bridge
  viewerReady: boolean;

  // Actions — presentation
  setWorldPosition: (v: Vec3) => Promise<void>;
  setWorldRotation: (v: Vec3) => Promise<void>;
  setWorldScale: (v: Vec3) => Promise<void>;
  setInitialView: (pose: ViewerCameraPose) => Promise<void>;
  setBackgroundType: (type: 'color' | 'equirectangular') => Promise<void>;
  setBackgroundColor: (color: Vec3) => Promise<void>;
  uploadCover: (file: File) => Promise<void>;
  uploadBackground: (file: File, lat?: number, lon?: number) => Promise<void>;

  // Actions — viewpoints
  addViewpoint: (name: string, pose: ViewerCameraPose) => Promise<void>;
  updateViewpoint: (id: string, patch: Partial<Pick<SceneViewpoint, 'name' | 'position' | 'target' | 'fov' | 'enabled'>>) => Promise<void>;
  deleteViewpoint: (id: string) => Promise<void>;
  reorderViewpoints: (ids: string[]) => Promise<void>;
  setActiveViewpoint: (id: string | null) => void;

  // Viewer integration
  applyPresentation: () => void;
}

export function useSceneAuthoring(sceneId: string): AuthoringState {
  const [presentation, setPresentation] = useState<ScenePresentation | null>(null);
  const [viewpoints, setViewpoints] = useState<SceneViewpoint[]>([]);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [activeViewpointId, setActiveViewpointId] = useState<string | null>(null);
  const [_viewerReady, _setViewerReady] = useState(false);

  const viewerRef = useRef<ViewerHandle | null>(null);
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
    } finally {
      setSaving(false);
    }
  }, []);

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

  const setInitialView = useCallback(async (pose: ViewerCameraPose) => {
    const patch: Partial<ScenePresentation> = {
      initialCameraPosition: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
      initialCameraTarget: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      initialCameraFov: pose.fov,
    };
    setPresentation(p => p ? { ...p, ...patch } : p);
    await savePresentation(patch);
  }, [savePresentation]);

  const setBackgroundType = useCallback(async (type: 'color' | 'equirectangular') => {
    setPresentation(p => p ? { ...p, backgroundType: type } : p);
    await savePresentation({ backgroundType: type });
  }, [savePresentation]);

  const setBackgroundColor = useCallback(async (color: Vec3) => {
    setPresentation(p => p ? { ...p, backgroundColor: color } : p);
    await savePresentation({ backgroundColor: color });
  }, [savePresentation]);

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
    } finally {
      setSaving(false);
    }
  }, []);

  // --- Viewpoints ---

  const addViewpoint = useCallback(async (name: string, pose: ViewerCameraPose) => {
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

  // --- Viewer integration ---

  const applyPresentation = useCallback(() => {
    const viewer = viewerRef.current;
    const pres = presentation;
    if (!viewer || !pres) return;

    // Apply initial camera
    if (pres.initialCameraPosition && pres.initialCameraTarget && pres.initialCameraFov) {
      // viewer.setCameraPose(...) — handled by the page via postMessage
    }

    // World transform is applied via RPC command (setWorldTransform)
    // Background is applied via RPC command (setBackground)
  }, [presentation]);

  return {
    presentation,
    saving,
    lastSaved,
    viewpoints,
    activeViewpointId,
    viewerReady: _viewerReady,
    setWorldPosition,
    setWorldRotation,
    setWorldScale,
    setInitialView,
    setBackgroundType,
    setBackgroundColor,
    uploadCover,
    uploadBackground,
    addViewpoint,
    updateViewpoint,
    deleteViewpoint,
    reorderViewpoints,
    setActiveViewpoint: setActiveViewpointId,
    applyPresentation,
  };
}
