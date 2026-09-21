/**
 * Interaction — annotation selection, media panel, and background audio.
 *
 * XR ray:  each frame the dominant hand's ray is tested against annotation
 * world-space anchor positions.  A hit triggers the media panel; pressing
 * Trigger (or B) dismisses it.
 *
 * Media panel:  a world-space PlayCanvas UI panel in the XRUiRoot showing
 * title, description and optional image/video/audio — identical to the
 * desktop viewer's annotation panel, sharing the same Phase 11 data.
 *
 * Background audio:  HTMLAudioElement playing the scene's background track,
 * started after the first XR session or user gesture.
 */

import {
    AppBase,
    CameraComponent,
    Color,
    ElementComponent,
    Entity,
    Quat,
    Ray,
    ScreenComponent,
    Vec2,
    Vec3,
    Vec4,
    XrInputSource,
} from 'playcanvas';
import type { XrAnnotation, XrInputState, XrBackgroundAudio } from './types';

/** Maximum distance from a ray to an annotation to be considered "pointed at". */
const HIT_RADIUS = 0.15;
/** UI panel width / height in world units. */
const PANEL_WIDTH = 1.6;
const PANEL_HEIGHT = 0.9;
/** Panel distance from the camera (metres). */
const PANEL_DISTANCE = 1.8;
/** Seconds the panel auto-hides if no interaction. */
const PANEL_TIMEOUT = 12;

export interface InteractionOptions {
    app: AppBase;
    camera: Entity;
    rig: Entity;
    annotationRoot: Entity;
    uiRoot: Entity;
}

export class Interaction {
    private app: AppBase;
    private camera: Entity;
    private rig: Entity;
    private annotationRoot: Entity;
    private uiRoot: Entity;
    private annotations: XrAnnotation[] = [];
    private panelEntity: Entity | null = null;
    private panelVisible = false;
    private panelTimer = 0;
    private selected: XrAnnotation | null = null;

    private bgAudio: HTMLAudioElement | null = null;

    constructor(options: InteractionOptions) {
        this.app = options.app;
        this.camera = options.camera;
        this.rig = options.rig;
        this.annotationRoot = options.annotationRoot;
        this.uiRoot = options.uiRoot;
    }

    // -------------------------------------------------------------------
    // Data
    // -------------------------------------------------------------------

    setAnnotations(annotations: XrAnnotation[]) {
        this.annotations = annotations.filter(a => a.enabled);
    }

    setBackgroundAudio(audio: XrBackgroundAudio | null) {
        if (!audio || !audio.url || !audio.enabled) {
            this.stopBackgroundAudio();
            return;
        }
        if (this.bgAudio) {
            this.bgAudio.src = audio.url;
            this.bgAudio.volume = audio.volume;
            this.bgAudio.loop = audio.loop;
            this.bgAudio.play().catch(() => {});
            return;
        }
        const el = new Audio(audio.url);
        el.volume = audio.volume;
        el.loop = audio.loop;
        el.play().catch(() => {});
        this.bgAudio = el;
    }

    private stopBackgroundAudio() {
        if (this.bgAudio) {
            this.bgAudio.pause();
            this.bgAudio.src = '';
            this.bgAudio = null;
        }
    }

    // -------------------------------------------------------------------
    // Per-frame
    // -------------------------------------------------------------------

    update(input: XrInputState, dt: number) {
        this.checkRayAnnotation(input);

        // Dismiss panel on B button or grip.
        if (this.panelVisible && (input.bButton.justPressed || input.grip.justPressed)) {
            this.hidePanel();
        }

        // Auto-hide after timeout.
        if (this.panelVisible) {
            this.panelTimer -= dt;
            if (this.panelTimer <= 0) this.hidePanel();
        }
    }

    // -------------------------------------------------------------------
    // Annotation ray detection
    // -------------------------------------------------------------------

    private checkRayAnnotation(_input: XrInputState) {
        if (this.panelVisible) return; // don't re-pick while panel open
        if (!this.app.xr?.session) return;

        // Use the dominant (right) hand ray.
        const sources = this.app.xr.input?.inputSources as XrInputSource[] | undefined;
        if (!sources || sources.length === 0) return;

        const right = sources.find(s => s.handedness === 'right');
        if (!right) return;

        const origin = right.getOrigin();
        const dir = right.getDirection();
        if (!origin || !dir) return;

        const ray = new Ray(origin, dir);
        let closestPerpDist = Infinity;
        let closestAnn: XrAnnotation | null = null;

        const dirNorm = dir.clone().normalize();
        for (const ann of this.annotations) {
            const target = new Vec3(ann.anchorX, ann.anchorY, ann.anchorZ);
            // Perpendicular distance from the anchor to the ray. Pick the
            // closest anchor to the ray (not to the origin) so the player can
            // aim at distant annotations.
            const toAnchor = target.clone().sub(origin);
            const t = toAnchor.dot(dirNorm);
            if (t < 0) continue; // behind the hand
            const perpDist = toAnchor.clone()
                .sub(dirNorm.clone().mulScalar(t))
                .length();
            if (perpDist < HIT_RADIUS && perpDist < closestPerpDist) {
                closestPerpDist = perpDist;
                closestAnn = ann;
            }
        }

        if (closestAnn && right.gamepad?.buttons[0]?.pressed) {
            this.selected = closestAnn;
            this.showPanel(closestAnn);
        }
    }

    // -------------------------------------------------------------------
    // Media panel
    // -------------------------------------------------------------------

    private showPanel(ann: XrAnnotation) {
        this.panelVisible = true;
        this.panelTimer = PANEL_TIMEOUT;
        this.ensurePanelEntity();
        this.populatePanel(ann);
        this.panelEntity!.enabled = true;
    }

    private hidePanel() {
        this.panelVisible = false;
        this.selected = null;
        if (this.panelEntity) this.panelEntity.enabled = false;
    }

    /** Lazily create the world-space panel under XRUiRoot. */
    private ensurePanelEntity() {
        if (this.panelEntity) return;

        // --- Screen entity ---
        this.panelEntity = new Entity('AnnotationPanel');
        this.panelEntity.addComponent('screen', {
            screenSpace: false,
            resolution: new Vec2(1000, 600),
            scaleMode: 'none',
            referenceResolution: new Vec2(1000, 600),
        } as never);

        // Position in front of the camera, at eye height.
        const camPos = this.camera.getPosition();
        const camDir = new Vec3();
        const fwd = new Vec3();
        this.camera.getWorldTransform().getZ(fwd).mulScalar(-1); // -Z forward
        camDir.copy(fwd);
        camDir.y = 0;
        camDir.normalize();

        const panelPos = new Vec3(
            camPos.x + camDir.x * PANEL_DISTANCE,
            camPos.y,
            camPos.z + camDir.z * PANEL_DISTANCE,
        );
        this.panelEntity.setPosition(panelPos);

        // Face the camera (horizontal).
        const lookDir = new Vec3();
        lookDir.copy(this.camera.getPosition()).sub(panelPos);
        lookDir.y = 0;
        lookDir.normalize();
        const yaw = Math.atan2(lookDir.x, lookDir.z) * (180 / Math.PI);
        this.panelEntity.setEulerAngles(0, yaw, 0);

        // --- Background ---
        const bg = new Entity('PanelBg');
        this.panelEntity.addChild(bg);
        bg.addComponent('element', {
            type: 'image',
            anchor: new Vec4(0, 0, 1, 1),
            pivot: new Vec2(0, 0),
            width: 1000,
            height: 600,
            color: new Color(0.1, 0.1, 0.1, 0.85),
        } as never);

        // --- Title ---
        const titleEntity = new Entity('PanelTitle');
        this.panelEntity.addChild(titleEntity);
        titleEntity.addComponent('element', {
            type: 'text',
            anchor: new Vec4(0, 1, 1, 1),
            pivot: new Vec2(0, 1),
            width: 900,
            height: 80,
            color: new Color(1, 1, 1, 1),
            text: 'Annotation',
            fontSize: 36,
        } as never);

        // --- Body ---
        const bodyEntity = new Entity('PanelBody');
        this.panelEntity.addChild(bodyEntity);
        bodyEntity.addComponent('element', {
            type: 'text',
            anchor: new Vec4(0, 0, 1, 1),
            pivot: new Vec2(0, 0),
            width: 900,
            height: 480,
            margin: new Vec4(50, 80, 0, 0),
            color: new Color(0.9, 0.9, 0.9, 1),
            text: '',
            fontSize: 24,
        } as never);

        // --- Close hint ---
        const hint = new Entity('PanelHint');
        this.panelEntity.addChild(hint);
        hint.addComponent('element', {
            type: 'text',
            anchor: new Vec4(1, 0, 1, 0),
            pivot: new Vec2(1, 0),
            width: 400,
            height: 40,
            margin: new Vec4(0, 0, 20, 20),
            color: new Color(0.5, 0.5, 0.5, 1),
            text: 'B / Grip to close',
            fontSize: 16,
        } as never);

        this.uiRoot.addChild(this.panelEntity);
        this.panelEntity.enabled = false;
    }

    private populatePanel(ann: XrAnnotation) {
        if (!this.panelEntity) return;
        const title = (this.panelEntity.findByName('PanelTitle') as Entity)?.element as ElementComponent | undefined;
        const body = (this.panelEntity.findByName('PanelBody') as Entity)?.element as ElementComponent | undefined;
        if (title) title.text = ann.title || 'Annotation';
        if (body) body.text = ann.textContent || ann.description || '';
    }

    destroy() {
        this.stopBackgroundAudio();
        if (this.panelEntity) this.panelEntity.destroy();
    }
}