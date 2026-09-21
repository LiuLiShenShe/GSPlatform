/**
 * ViewpointManager — navigate between the scene's saved viewpoints (Phase 10).
 *
 * Controls:
 *   - A button: next viewpoint
 *   - B button: previous viewpoint
 *
 * Transition: fade out → move the rig to the viewpoint position → face the
 * viewpoint target → fade in.  A cooldown + rising-edge lock prevents a held
 * A/B button from firing dozens of transitions per frame.
 *
 * Viewpoints are the SAME data as the desktop viewer (shared Phase 10
 * format) — the XR viewer never saves its own separate set.
 */

import { CameraComponent, Entity, Vec3 } from 'playcanvas';
import { FadeOverlay } from './fade-overlay';
import { CollisionRaycaster } from './collision-raycaster';
import type { XrInputState, XrNavigationProfile, XrViewpoint } from './types';

export interface ViewpointManagerOptions {
    rig: Entity;
    camera: Entity;
    fade: FadeOverlay;
    collision: CollisionRaycaster;
    profile: XrNavigationProfile;
    /** Minimum seconds between two transitions. */
    cooldown?: number;
    /** Seconds for fade-out and fade-in each. */
    fadeDuration?: number;
}

type TransitionState = 'idle' | 'fadingOut' | 'moving' | 'fadingIn';

export class ViewpointManager {
    private rig: Entity;
    private camera: Entity;
    private fade: FadeOverlay;
    private collision: CollisionRaycaster;
    private profile: XrNavigationProfile;
    private cooldown: number;
    private fadeDuration: number;

    private viewpoints: XrViewpoint[] = [];
    private index = 0;
    private state: TransitionState = 'idle';
    private fadeTimer = 0;
    private lastTriggerTime = 0;

    constructor(options: ViewpointManagerOptions) {
        this.rig = options.rig;
        this.camera = options.camera;
        this.fade = options.fade;
        this.collision = options.collision;
        this.profile = options.profile;
        this.cooldown = options.cooldown ?? 1.2;
        this.fadeDuration = options.fadeDuration ?? 0.5;
    }

    setViewpoints(viewpoints: XrViewpoint[]) {
        const enabled = viewpoints.filter(vp => vp.enabled);
        // Keep orderIndex ordering if provided, else insertion order.
        enabled.sort((a, b) => a.orderIndex - b.orderIndex);
        this.viewpoints = enabled;
        this.index = 0;
    }

    get count(): number {
        return this.viewpoints.length;
    }

    get currentIndex(): number {
        return this.index;
    }

    get current(): XrViewpoint | null {
        return this.viewpoints[this.index] ?? null;
    }

    /**
     * Called every frame. Drives the fade transition animation.
     */
    update(dt: number) {
        if (this.state === 'idle') return;

        this.fadeTimer -= dt;

        if (this.state === 'fadingOut' && this.fadeTimer <= 0) {
            // Fade-out complete: snap the rig to the viewpoint.
            const vp = this.viewpoints[this.index];
            if (vp) this.applyViewpoint(vp);
            this.state = 'moving';
            this.fadeTimer = 0.05; // brief pause while blacked out
        } else if (this.state === 'moving' && this.fadeTimer <= 0) {
            this.state = 'fadingIn';
            this.fadeTimer = this.fadeDuration;
        } else if (this.state === 'fadingIn') {
            const t = Math.max(0, this.fadeTimer / this.fadeDuration);
            this.fade.setOpacity(t);
            if (this.fadeTimer <= 0) {
                this.state = 'idle';
                this.fade.setOpacity(0);
            }
        } else if (this.state === 'fadingOut') {
            const t = Math.max(0, this.fadeTimer / this.fadeDuration);
            this.fade.setOpacity(1 - t);
        }
    }

    /** Handle viewpoint controls from input. */
    handleInput(input: XrInputState) {
        if (this.viewpoints.length === 0) return;
        if (this.state !== 'idle') return; // lock during transition

        const now = performance.now();
        if (now - this.lastTriggerTime < this.cooldown * 1000) return;

        if (input.aButton.justPressed) {
            this.next();
            this.lastTriggerTime = now;
        } else if (input.bButton.justPressed) {
            this.previous();
            this.lastTriggerTime = now;
        }
    }

    /** Next viewpoint (wraps around). */
    next() {
        if (this.viewpoints.length === 0) return;
        this.index = (this.index + 1) % this.viewpoints.length;
        this.startTransition();
    }

    /** Previous viewpoint (wraps around). */
    previous() {
        if (this.viewpoints.length === 0) return;
        this.index = (this.index - 1 + this.viewpoints.length) % this.viewpoints.length;
        this.startTransition();
    }

    private startTransition() {
        this.state = 'fadingOut';
        this.fadeTimer = this.fadeDuration;
    }

    /**
     * Move the rig to the viewpoint position and face the target.
     *
     * The rig is the FEET reference; the HMD camera transform is owned by
     * WebXR and never written directly.  We drop the rig onto the collision
     * surface (if available) so the eye height ends up correct.
     */
    private applyViewpoint(vp: XrViewpoint) {
        const feet = new Vec3(vp.position.x, vp.position.y, vp.position.z);

        // If collision mesh is available, drop to the ground surface so the
        // eye (headset) sits at the saved camera height above the floor.
        if (this.collision.ready) {
            const probe = new Vec3(vp.position.x, vp.position.y + 0.2, vp.position.z);
            const hit = this.collision.castGround(probe, this.profile.playerHeight + 2);
            if (hit) {
                feet.y = hit.point.y;
            }
        }

        this.rig.setPosition(feet);

        // Face the viewpoint target (horizontal yaw only).
        const target = new Vec3(vp.target.x, vp.target.y, vp.target.z);
        const dirX = target.x - feet.x;
        const dirZ = target.z - feet.z;
        const yaw = Math.atan2(dirX, dirZ) * (180 / Math.PI);
        // PlayCanvas: yaw 0 faces -Z; atan2(dx, dz) gives the -Z heading.
        this.rig.setEulerAngles(0, yaw, 0);

        // Apply saved FOV to the camera.
        const cameraComp = this.camera.camera as CameraComponent | null;
        if (cameraComp && vp.fov > 0) {
            cameraComp.fov = vp.fov;
        }
    }
}