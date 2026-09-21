/**
 * Collision Raycaster — raycast against the invisible collision proxy mesh
 * loaded by Phase 12 to enforce gravity, step-climb, slope limits and wall
 * collisions for XR locomotion.
 *
 * After the collision GLB is loaded under the CollisionWorld entity, call
 * `collectMeshInstances()` to index every MeshInstance.  Then each frame
 * call `castGround` / `castWall` / `cast` to query the collision mesh.
 *
 * This module performs its own per-triangle raycast (Möller–Trumbore) against
 * the mesh's vertex / index buffers, transforming vertices into world space
 * per query via MeshInstance.node.getWorldTransform().
 * MeshInstance.aabb provides the world-space AABB for fast rejection.
 */

import {
    AppBase,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    Ray,
    Vec3,
} from 'playcanvas';

export interface CastResult {
    /** World-space point of the hit. */
    point: Vec3;
    /** Distance from the ray origin. */
    distance: number;
    /** The mesh instance that was hit. */
    meshInstance: MeshInstance;
}

interface IndexedMesh {
    mi: MeshInstance;
    /** Local-space vertex positions (x,y,z interleaved). */
    positions: number[];
    /** Triangle index buffer (0-based indices into positions). */
    indices: number[] | null;
}

export class CollisionRaycaster {
    private app: AppBase;
    private meshes: IndexedMesh[] = [];
    private _ready = false;

    constructor(app: AppBase) {
        this.app = app;
    }

    /** Gather all MeshInstances under the CollisionWorld entity. */
    collectMeshInstances(): void {
        this.meshes = [];
        const collisionWorld = this.app.root.findByName('CollisionWorld') as Entity | null;
        if (collisionWorld) {
            this.walk(collisionWorld);
        }
        this._ready = this.meshes.length > 0;
    }

    private walk(entity: Entity): void {
        const render = entity.findComponent('render') as any | null;
        if (render) {
            for (const mi of render.meshInstances ?? []) {
                const mesh = mi.mesh as Mesh | undefined;
                if (!mesh) continue;
                const indexed = this.indexMesh(mi as MeshInstance, mesh);
                if (indexed) this.meshes.push(indexed);
            }
        }
        if (entity.children) {
            for (const child of entity.children) {
                if (child instanceof Entity) this.walk(child);
            }
        }
    }

    /** Read vertex / index data once. */
    private indexMesh(mi: MeshInstance, mesh: Mesh): IndexedMesh | null {
        const positions: number[] = [];
        const count = mesh.getPositions(positions);
        if (count === 0) return null;

        const indices: number[] = [];
        const indexCount = mesh.getIndices(indices);
        if (indexCount === 0) return null;

        return { mi, positions, indices };
    }

    get ready(): boolean {
        return this._ready;
    }

    get count(): number {
        return this.meshes.length;
    }

    /**
     * Cast a ray and return the closest hit against any collision mesh.
     * Returns null on miss.
     */
    cast(ray: Ray, maxDistance = Infinity): CastResult | null {
        let closest: CastResult | null = null;

        for (const sm of this.meshes) {
            if (!sm.mi.aabb.intersectsRay(ray)) continue;

            const hit = this.castMesh(sm, ray);
            if (hit && hit.distance < maxDistance) {
                if (!closest || hit.distance < closest.distance) {
                    closest = hit;
                }
            }
        }
        return closest;
    }

    /** Cast a ray straight down from `origin` to find the ground surface. */
    castGround(origin: Vec3, maxFall = 10): CastResult | null {
        const dir = new Vec3(0, -1, 0);
        const ray = new Ray(origin, dir);
        return this.cast(ray, maxFall);
    }

    /** Cast a horizontal ray to detect a wall / obstacle at chest height. */
    castWall(origin: Vec3, direction: Vec3, maxDistance = 0.5): CastResult | null {
        const norm = new Vec3();
        norm.copy(direction).normalize();
        const ray = new Ray(origin, norm);
        return this.cast(ray, maxDistance);
    }

    /** Per-triangle Möller–Trumbore against one indexed mesh. */
    private castMesh(sm: IndexedMesh, ray: Ray): CastResult | null {
        const worldMat = sm.mi.node.getWorldTransform();
        const pos = sm.positions;
        const idx = sm.indices!;

        const v0 = new Vec3();
        const v1 = new Vec3();
        const v2 = new Vec3();
        const tmp = new Vec3();
        const hitPoint = new Vec3();
        const closestPoint = new Vec3();

        let closestT = Infinity;

        const triCount = idx.length / 3;
        for (let t = 0; t < triCount; t++) {
            const i0 = idx[t * 3] * 3;
            const i1 = idx[t * 3 + 1] * 3;
            const i2 = idx[t * 3 + 2] * 3;

            tmp.set(pos[i0], pos[i0 + 1], pos[i0 + 2]);
            worldMat.transformPoint(tmp, v0);
            tmp.set(pos[i1], pos[i1 + 1], pos[i1 + 2]);
            worldMat.transformPoint(tmp, v1);
            tmp.set(pos[i2], pos[i2 + 1], pos[i2 + 2]);
            worldMat.transformPoint(tmp, v2);

            const tHit = moellerTrumbore(ray, v0, v1, v2, hitPoint);
            if (tHit !== null && tHit < closestT) {
                closestT = tHit;
                closestPoint.copy(hitPoint);
            }
        }

        if (closestT === Infinity) return null;
        return {
            point: closestPoint,
            distance: closestT,
            meshInstance: sm.mi,
        };
    }

    destroy(): void {
        this.meshes = [];
        this._ready = false;
    }
}

/** Möller–Trumbore ray-triangle intersection. Returns t or null. */
function moellerTrumbore(
    ray: Ray,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    out: Vec3,
): number | null {
    const edge1 = b.clone().sub(a);
    const edge2 = c.clone().sub(a);
    const pvec = new Vec3();
    pvec.cross(ray.direction, edge1);
    const det = edge2.dot(pvec);
    if (Math.abs(det) < 1e-8) return null;
    const invDet = 1 / det;
    const tvec = ray.origin.clone().sub(a);
    const u = tvec.dot(pvec) * invDet;
    if (u < 0 || u > 1) return null;
    const qvec = new Vec3();
    qvec.cross(tvec, edge2);
    const v = ray.direction.dot(qvec) * invDet;
    if (v < 0 || u + v > 1) return null;
    const t = edge1.dot(qvec) * invDet;
    if (t < 0) return null;
    out.copy(a).add(edge1.mulScalar(u)).add(edge2.mulScalar(v));
    return t;
}