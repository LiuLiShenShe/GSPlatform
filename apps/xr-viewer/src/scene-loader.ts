/**
 * Scene Loader — loads Gaussian Splat assets into the XR scene.
 *
 * Supports the same formats as the desktop viewer:
 *   - .sog  (PlayCanvas SOG — loaded as gsplat asset)
 *   - .ply  (raw gaussian splat PLY)
 *   - .splat (raw splat)
 *   - streamed-sog (LOD manifest — loads the highest-quality tier)
 *
 * The loader attaches loaded splats under the GaussianWorld entity so the
 * Scene Manifest / view mesh hierarchy matches the desktop viewer.
 */

import { AppBase, Asset, Entity } from 'playcanvas';
import type { XrSceneDescriptor } from './types';

/**
 * Determine the streamed-SOG manifest URL from a descriptor. The manifest
 * (lod-meta.json) lists per-tier chunk units; we resolve the highest-tier
 * primary splat URL for now — full Range-streaming LOD refinement in XR is
 * deferred pending headset bandwidth profiling.
 *
 * lod-meta.json format (from splat-transform):
 *   {
 *     version, count, counts: [lo0, lod1, lod2],
 *     lodLevels, filenames: [...],
 *     tree: { children: [...] }
 *   }
 *
 * The highest LOD uses the file at index 0 in `filenames` (e.g. "2_0/meta.json")
 * which points to the most detailed chunk set.
 */
async function resolveStreamedSogUrl(baseUrl: string, url: string): Promise<string | null> {
    try {
        const manifestRes = await fetch(url);
        if (!manifestRes.ok) {
            console.warn('[xr-loader] lod-meta.json fetch failed:', manifestRes.status);
            return null;
        }
        const manifest = await manifestRes.json();
        const filenames: string[] = manifest.filenames ?? [];
        if (filenames.length === 0) {
            return null;
        }
        // The first filename in the list is the highest-LOD primary chunk.
        const primaryChunk = filenames[0];
        // The chunk URL is relative to the lod-meta.json's directory.
        return new URL(primaryChunk, baseUrl).href;
    } catch (err) {
        console.warn('[xr-loader] failed to resolve streamed SOG:', err);
        return null;
    }
}

export class XrSceneLoader {
    private app: AppBase;

    constructor(app: AppBase) {
        this.app = app;
    }

    /**
     * Load a scene into the given parent entity (GaussianWorld).
     * Returns a promise resolving when the splat is attached.
     */
    async loadScene(parent: Entity, descriptor: XrSceneDescriptor): Promise<Entity> {
        let assetUrl = descriptor.assetUrl;
        let format = descriptor.format;

        // Streamed SOG: resolve the manifest down to a static splat URL.
        if (format === 'streamed-sog') {
            const baseUrl = descriptor.baseUrl ?? new URL('.', new URL(assetUrl, window.location.href)).href;
            const resolved = await resolveStreamedSogUrl(baseUrl, assetUrl);
            if (resolved) {
                assetUrl = resolved;
                format = 'sog';
            } else {
                console.warn('[xr-loader] streamed SOG resolution failed; treating as .sog');
                format = 'sog';
            }
        }

        // Normalize the URL as an absolute URL.
        const absoluteUrl = new URL(assetUrl, window.location.href).href;

        const splatEntity = await this.loadSplat(absoluteUrl, format);
        parent.addChild(splatEntity);

        // Apply manifest camera pose if present.
        if (descriptor.camera) {
            const rig = this.app.root.findByName('PlayerRig');
            if (rig) {
                // Reuse the manifest camera position so the initial view
                // matches the desktop viewer.
                const [x, y, z] = descriptor.camera.position;
                rig.setPosition(x, y, z);
            }
        }

        // Load collision mesh if provided.
        if (descriptor.collisionUrl) {
            await this.loadCollision(descriptor.collisionUrl, descriptor.collision);
        }

        return splatEntity;
    }

    /**
     * Load a single splat asset and attach it under a new entity.
     *
     * Uses PlayCanvas's gsplat asset loading for all formats:
     *   - .sog, .ply, .splat are all loaded as 'gsplat' assets
     *   - The GSplatComponentSystem renders them
     */
    private async loadSplat(url: string, format: XrSceneDescriptor['format']): Promise<Entity> {
        const entity = new Entity(`xr-splat-${format}`);

        // PlayCanvas can load .sog, .ply, and .splat as gsplat assets.
        const asset = new Asset(`splat-${Date.now()}`, 'gsplat', { url });
        this.app.assets.add(asset);

        await new Promise<void>((resolve, reject) => {
            asset.once('load', () => {
                // Add the gsplat component with the loaded asset.
                entity.addComponent('gsplat', { asset });
                resolve();
            });
            asset.once('error', (err: unknown) => reject(err));
            this.app.assets.load(asset);
        });

        return entity;
    }

    /**
     * Load a collision GLB into the CollisionWorld, invisible.
     * The collision mesh is a physics/raycast proxy for walkable scenes.
     */
    private async loadCollision(url: string, params?: XrSceneDescriptor['collision']): Promise<void> {
        try {
            const absoluteUrl = new URL(url, window.location.href).href;
            const asset = new Asset(
                `collision-${Date.now()}`,
                'container',
                { url: absoluteUrl },
            );
            this.app.assets.add(asset);
            await new Promise<void>((resolve, reject) => {
                asset.once('load', () => {
                    const collisionWorld = this.app.root.findByName('CollisionWorld');
                    if (collisionWorld) {
                        // Instantiate the container, then hide all render
                        // components — the mesh is a physics/raycast proxy.
                        const resource = asset.resource as any;
                        const instance = resource?.instantiateRenderEntity?.();
                        if (instance) {
                            collisionWorld.addChild(instance);
                            // Hide all render components (invisible collision proxy).
                            const renderers = instance.findComponents?.('render') ?? [];
                            for (const renderer of renderers) {
                                renderer.enabled = false;
                            }
                        }
                    }
                    resolve();
                });
                asset.once('error', (err: unknown) => reject(err));
                this.app.assets.load(asset);
            });
        } catch (err) {
            // Collision loading is best-effort — log and continue.
            console.warn('[xr-loader] collision load failed:', err);
        }
    }
}
