/**
 * Data Loader — fetches the scene's shared Phase 10/11/12 data from the
 * GSPlatform API, or from inline URL parameters for local development.
 *
 * The XR viewer deliberately reuses the exact same viewpoint / annotation /
 * presentation endpoints as the desktop viewer — there is no separate XR
 * data store.
 *
 * API base is passed via `?apiUrl=` (e.g. https://platform.example.com/api/v1)
 * and the scene id/slug via `?id=` or `?sceneId=`.
 */

import type { XrAnnotation, XrBackgroundAudio, XrViewpoint } from './types';

export interface XrApiData {
    viewpoints: XrViewpoint[];
    annotations: XrAnnotation[];
    backgroundAudio: XrBackgroundAudio | null;
    /** Collision enabled flag from presentation. */
    collisionEnabled: boolean;
}

const API_PREFIX = '/api/v1';

function decodeInlineArray<T>(param: string | null, fallback: T[]): T[] {
    if (!param) return fallback;
    try {
        const json = decodeURIComponent(param);
        return JSON.parse(json) as T[];
    } catch {
        console.warn('[xr-data] failed to parse inline array param');
        return fallback;
    }
}

function mapViewpoint(vp: any): XrViewpoint {
    return {
        id: String(vp.id),
        name: String(vp.name ?? 'Viewpoint'),
        position: { x: vp.position.x, y: vp.position.y, z: vp.position.z },
        target: { x: vp.target.x, y: vp.target.y, z: vp.target.z },
        fov: Number(vp.fov ?? 60),
        orderIndex: Number(vp.orderIndex ?? 0),
        enabled: Boolean(vp.enabled ?? true),
    };
}

function mapAnnotation(ann: any): XrAnnotation {
    return {
        id: String(ann.id),
        title: String(ann.title ?? ''),
        description: String(ann.description ?? ''),
        anchorX: Number(ann.anchorX ?? 0),
        anchorY: Number(ann.anchorY ?? 0),
        anchorZ: Number(ann.anchorZ ?? 0),
        style: (ann.style ?? 'LEADER_TEXT') as XrAnnotation['style'],
        contentType: (ann.contentType ?? 'TEXT') as XrAnnotation['contentType'],
        textContent: String(ann.textContent ?? ''),
        mediaAssetId: ann.mediaAssetId ? String(ann.mediaAssetId) : undefined,
        textColor: String(ann.textColor ?? '#FFFFFF'),
        textSize: Number(ann.textSize ?? 14),
        fov: Number(ann.fov ?? 60),
        orderIndex: Number(ann.orderIndex ?? 0),
        enabled: Boolean(ann.enabled ?? true),
    };
}

export async function loadXrData(): Promise<XrApiData> {
    const params = new URLSearchParams(window.location.search);
    const apiUrl = params.get('apiUrl');
    const sceneId = params.get('sceneId') ?? params.get('id');

    // Inline data (local development / offline).
    const inlineViewpoints = decodeInlineArray<XrViewpoint>(params.get('viewpoints'), []);
    const inlineAnnotations = decodeInlineArray<XrAnnotation>(params.get('annotations'), []);

    // If an API base + scene id are provided, fetch from the same backend
    // the desktop viewer uses.
    if (apiUrl && sceneId) {
        try {
            const [vpRes, annRes, presRes] = await Promise.allSettled([
                fetch(`${apiUrl}${API_PREFIX}/scenes/${encodeURIComponent(sceneId)}/viewpoints`),
                fetch(`${apiUrl}${API_PREFIX}/scenes/${encodeURIComponent(sceneId)}/annotations`),
                fetch(`${apiUrl}${API_PREFIX}/scenes/${encodeURIComponent(sceneId)}/presentation`),
            ]);

            const viewpoints: XrViewpoint[] = [];
            const annotations: XrAnnotation[] = [];

            if (vpRes.status === 'fulfilled' && vpRes.value.ok) {
                const list = await vpRes.value.json();
                viewpoints.push(...(Array.isArray(list) ? list.map(mapViewpoint) : []));
            } else {
                console.warn('[xr-data] viewpoints fetch failed; using inline', vpRes.status === 'rejected' ? vpRes.reason : vpRes.value?.status);
                viewpoints.push(...inlineViewpoints);
            }

            if (annRes.status === 'fulfilled' && annRes.value.ok) {
                const list = await annRes.value.json();
                annotations.push(...(Array.isArray(list) ? list.map(mapAnnotation) : []));
            } else {
                console.warn('[xr-data] annotations fetch failed; using inline', annRes.status === 'rejected' ? annRes.reason : annRes.value?.status);
                annotations.push(...inlineAnnotations);
            }

            let backgroundAudio: XrBackgroundAudio | null = null;
            let collisionEnabled = false;

            if (presRes.status === 'fulfilled' && presRes.value.ok) {
                const pres = await presRes.value.json();
                collisionEnabled = Boolean(pres.collisionEnabled);
                if (pres.backgroundAudioEnabled) {
                    // Background audio is served by the presentation router.
                    backgroundAudio = {
                        url: `${apiUrl}${API_PREFIX}/scenes/${encodeURIComponent(sceneId)}/presentation/background-audio`,
                        volume: Number(pres.backgroundAudioVolume ?? 0.5),
                        loop: Boolean(pres.backgroundAudioLoop ?? true),
                        enabled: true,
                    };
                }
            }

            return { viewpoints, annotations, backgroundAudio, collisionEnabled };
        } catch (err) {
            console.warn('[xr-data] API load failed; falling back to inline:', err);
        }
    }

    return {
        viewpoints: inlineViewpoints,
        annotations: inlineAnnotations,
        backgroundAudio: null,
        collisionEnabled: false,
    };
}
