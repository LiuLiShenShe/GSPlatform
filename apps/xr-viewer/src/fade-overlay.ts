/**
 * FadeOverlay — full-viewport black overlay used for viewpoint transitions.
 *
 * A world-space screen attached to the camera (so it follows the HMD) with a
 * single black image element.  `setOpacity` animates the alpha; callers drive
 * the animation externally (see ViewpointManager).
 *
 * The overlay deliberately sits a short distance in front of the camera so it
 * covers the view even inside an active XR session without touching the HMD
 * camera transform.
 */

import {
    AppBase,
    Color,
    ElementComponent,
    Entity,
    ScreenComponent,
    Vec2,
    Vec4,
} from 'playcanvas';

export class FadeOverlay {
    private entity: Entity;
    private image: ElementComponent;

    constructor(app: AppBase, camera: Entity) {
        // World-space screen parented to the camera. World-space screens in
        // PlayCanvas map 1 "pixel" = 1 world unit with SCALEMODE_NONE, so we
        // use a 10×10 quad a couple of metres in front of the eyes.
        this.entity = new Entity('FadeScreen');
        camera.addChild(this.entity);

        this.entity.addComponent('screen', {
            screenSpace: false,
            resolution: new Vec2(10, 10),
            scaleMode: 'none',
            referenceResolution: new Vec2(10, 10),
        } as never);
        const screen = this.entity.screen as ScreenComponent;

        const quad = new Entity('FadeQuad');
        this.entity.addChild(quad);
        quad.addComponent('element', {
            type: 'image',
            anchor: new Vec4(0, 0, 1, 1),
            pivot: new Vec2(0.5, 0.5),
            width: 10,
            height: 10,
            color: new Color(0, 0, 0, 0),
        } as never);
        this.image = quad.element as ElementComponent;

        // ~2.2m in front of the camera, matching the quad size.
        this.entity.setLocalPosition(0, 0, -2.2);
        screen.scale = 1;
    }

    /** Current opacity 0..1. */
    get opacity(): number {
        return this.image.color.a;
    }

    setOpacity(value: number) {
        const c = this.image.color.clone();
        c.a = Math.max(0, Math.min(1, value));
        this.image.color = c;
    }

    destroy() {
        this.entity.destroy();
    }
}