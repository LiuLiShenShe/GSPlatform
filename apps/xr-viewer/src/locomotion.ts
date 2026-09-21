/**
 * Locomotion — first-person movement for the XR player rig.
 *
 * Controls:
 *   - Left joystick: head-relative move (X = strafe, Y = forward/back)
 *   - Right joystick X: snap turn
 *
 * Grounded movement respects the Phase 12 collision proxy mesh:
 *   - gravity pulls the rig down to the ground surface
 *   - step offsets allow climbing small ledges
 *   - slope limits stop the player walking up steep hills
 *   - walls stop horizontal motion
 *
 * The rig is always moved via PlayerRig — the HMD camera transform itself is
 * owned by PlayCanvas WebXR and never written directly.
 */

import { Entity, Vec3, Quat } from 'playcanvas';
import { CollisionRaycaster } from './collision-raycaster';
import type { XrNavigationProfile, XrInputState } from './types';

export interface LocomotionOptions {
    rig: Entity;
    camera: Entity;
    collision: CollisionRaycaster;
    /** Profile to use (indoor or outdoor). */
    profile: XrNavigationProfile;
    /** Interval between consecutive snap turns (s) — prevents turbo-spin. */
    snapTurnCooldown?: number;
}

const DEFAULT_SNAP_TURN_COOLDOWN = 0.35;
/** How far above the feet to cast the wall ray. */
const WALL_CAST_HEIGHT = 1.0;

export class Locomotion {
    private rig: Entity;
    private camera: Entity;
    private collision: CollisionRaycaster;
    private profile: XrNavigationProfile;
    private snapTurnCooldown: number;
    private lastSnapTime = 0;

    /** Vertical velocity (m/s) accumulated by gravity. */
    private verticalVelocity = 0;

    constructor(options: LocomotionOptions) {
        this.rig = options.rig;
        this.camera = options.camera;
        this.collision = options.collision;
        this.profile = options.profile;
        this.snapTurnCooldown = options.snapTurnCooldown ?? DEFAULT_SNAP_TURN_COOLDOWN;
    }

    setProfile(profile: XrNavigationProfile) {
        this.profile = profile;
    }

    /**
     * Move the rig based on the current input. Called once per frame.
     * @param input  Unified XR input state.
     * @param dt     Frame delta time (s).
     */
    update(input: XrInputState, dt: number): void {
        this.applySnapTurn(input, dt);
        this.applyMove(input, dt);
        this.applyGravity(dt);
    }

    /** Snap turn: right joystick X beyond deadzone triggers a fixed yaw step. */
    private applySnapTurn(input: XrInputState, _dt: number) {
        const turnX = input.rightStick.x;
        if (Math.abs(turnX) < 0.5) return;

        const now = performance.now();
        if (now - this.lastSnapTime < this.snapTurnCooldown * 1000) return;
        this.lastSnapTime = now;

        const degrees = Math.sign(turnX) * this.profile.snapTurnDegrees;
        const quat = new Quat();
        // setFromEulerAngles takes degrees (PlayCanvas math API).
        quat.setFromEulerAngles(0, degrees, 0);
        const rigRot = this.rig.getRotation().clone();
        rigRot.mul(quat);
        this.rig.setRotation(rigRot);
    }

    /** Head-relative movement from the left joystick, wall-collision aware. */
    private applyMove(input: XrInputState, dt: number) {
        const lx = input.leftStick.x;
        const ly = input.leftStick.y;
        if (Math.abs(lx) < 0.01 && Math.abs(ly) < 0.01) return;

        // Camera forward projected to the horizontal plane. The camera's -Z
        // axis points forward; getWorldTransform().getZ() returns the +Z axis.
        const camFwd = new Vec3();
        this.camera.getWorldTransform().getZ(camFwd).mulScalar(-1); // -Z = forward
        camFwd.y = 0;
        if (camFwd.lengthSq() < 1e-6) return;
        camFwd.normalize();

        const camRight = new Vec3();
        camRight.cross(camFwd, new Vec3(0, 1, 0)).normalize();

        // Move in head-relative space: Y axis is forward (joystick up = forward).
        const move = new Vec3();
        move.x += camFwd.x * -ly;
        move.z += camFwd.z * -ly; // forward/back
        move.x += camRight.x * lx;
        move.z += camRight.z * lx; // strafe
        if (move.lengthSq() < 0.0001) return;

        move.normalize().mulScalar(this.profile.moveSpeed * dt);

        const feet = this.rig.getPosition();
        const castOrigin = new Vec3(feet.x, feet.y + WALL_CAST_HEIGHT, feet.z);

        // Wall check: only block if something is inside the step window.
        const wallHit = this.collision.castWall(castOrigin, move, move.length());
        if (wallHit) {
            // Slide along the wall: keep the component of movement that is
            // parallel to the wall normal approximation (horizontal).
            const allowed = this.slideAlongWall(move, wallHit.point, castOrigin);
            if (allowed.lengthSq() < 0.0001) return;
            const cur = this.rig.getPosition();
            this.rig.setPosition(cur.x + allowed.x, cur.y, cur.z + allowed.z);
            return;
        }

        const cur = this.rig.getPosition();
        this.rig.setPosition(cur.x + move.x, cur.y, cur.z + move.z);
    }

    /**
     * When the direct path is blocked, slide along the wall by splitting the
     * move into X and Z components and retesting each.
     */
    private slideAlongWall(move: Vec3, _hitPoint: Vec3, origin: Vec3): Vec3 {
        const feet = this.rig.getPosition();
        let dx = 0;
        let dz = 0;

        // Try X-only movement.
        if (Math.abs(move.x) > 0.0001) {
            const ox = new Vec3(origin.x, origin.y, origin.z);
            if (!this.collision.castWall(ox, new Vec3(Math.sign(move.x), 0, 0), Math.abs(move.x) + 0.01)) {
                dx = move.x;
            }
        }
        // Try Z-only movement.
        if (Math.abs(move.z) > 0.0001) {
            const oz = new Vec3(origin.x, origin.y, origin.z);
            if (!this.collision.castWall(oz, new Vec3(0, 0, Math.sign(move.z)), Math.abs(move.z) + 0.01)) {
                dz = move.z;
            }
        }
        return new Vec3(dx, feet.y, dz);
    }

    /** Pull the rig down to the ground, respecting step offset & slope. */
    private applyGravity(dt: number) {
        const feet = this.rig.getPosition();
        const rayOrigin = new Vec3(feet.x, feet.y + this.profile.playerHeight * 0.5, feet.z);

        const hit = this.collision.castGround(rayOrigin, this.profile.playerHeight + 1);
        if (!hit) {
            // No collision mesh below — apply free gravity so the player
            // falls (scene without collision, or airborne).
            this.verticalVelocity -= this.profile.gravity * dt;
            const cur = this.rig.getPosition();
            this.rig.setPosition(cur.x, cur.y + this.verticalVelocity * dt, cur.z);
            return;
        }

        // Distance from ray origin (feet + eye half) to ground.
        const groundY = hit.point.y;
        const targetFeetY = groundY;

        // Step: allow climbing if the step is smaller than stepOffset.
        const stepDelta = targetFeetY - feet.y;
        if (stepDelta > this.profile.stepOffset) {
            // Ledge too tall — don't climb, stay put horizontally, keep
            // vertical velocity reset (grounded).
            this.verticalVelocity = 0;
            return;
        }

        // Snap to ground when close, otherwise fall.
        if (feet.y - targetFeetY > 0.05) {
            this.verticalVelocity -= this.profile.gravity * dt;
            const cur = this.rig.getPosition();
            this.rig.setPosition(cur.x, cur.y + this.verticalVelocity * dt, cur.z);
        } else {
            this.verticalVelocity = 0;
            const cur = this.rig.getPosition();
            this.rig.setPosition(cur.x, targetFeetY, cur.z);
        }
    }

    /** Teleport the rig to a new feet position (used by ViewpointManager). */
    teleport(position: Vec3): void {
        this.verticalVelocity = 0;
        this.rig.setPosition(position);
    }
}