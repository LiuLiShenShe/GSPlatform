/**
 * XR Input Manager — wraps PlayCanvas WebXR input sources (PICO controllers)
 * and produces a unified, per-frame polled input state.
 *
 * Button / axis mapping follows the PICO Neo 3 WebXR xr-standard profile
 * (verified against the immersive-web/webxr-input-profiles registry):
 *
 *   buttons[0] = trigger   (primary select)
 *   buttons[1] = squeeze   (grip)
 *   buttons[3] = thumbstick press
 *   buttons[4] = X (left) / A (right)
 *   buttons[5] = Y (left) / B (right)
 *   axes[2]    = thumbstick X
 *   axes[3]    = thumbstick Y
 *
 * The manager tracks rising edges (`justPressed`) so callers never need to
 * worry about a held button firing dozens of times per frame.
 */

import { AppBase, XrInputSource } from 'playcanvas';
import type { XrInputState, XrButtonState, XrStickInput } from './types';

/** Joystick value below this magnitude is treated as neutral. */
const DEADZONE = 0.2;

function deadzoned(v: number): number {
    const mag = Math.abs(v);
    if (mag < DEADZONE) return 0;
    // Re-scale remaining range so 0..deadzone stays 0 and 1 stays 1.
    const scaled = (mag - DEADZONE) / (1 - DEADZONE);
    return Math.sign(v) * scaled;
}

function readStick(x: number, y: number): XrStickInput {
    return { x: deadzoned(x), y: deadzoned(y) };
}

export class XrInputManager {
    private app: AppBase;
    private left: XrInputSource | null = null;
    private right: XrInputSource | null = null;

    /** Index of buttons whose rising edge was already consumed. */
    private leftHandled = new Set<number>();
    private rightHandled = new Set<number>();

    private state: XrInputState = {
        leftStick: { x: 0, y: 0 },
        rightStick: { x: 0, y: 0 },
        trigger: { pressed: false, justPressed: false, value: 0 },
        grip: { pressed: false, justPressed: false, value: 0 },
        aButton: { pressed: false, justPressed: false, value: 0 },
        bButton: { pressed: false, justPressed: false, value: 0 },
        menuButton: { pressed: false, justPressed: false, value: 0 },
        leftPresent: false,
        rightPresent: false,
    };

    constructor(app: AppBase) {
        this.app = app;

        // Track live input sources as they connect / disconnect.
        if (this.app.xr?.input) {
            this.app.xr.input.on('add', (source: XrInputSource) => {
                if (source.handedness === 'left') {
                    this.left = source;
                } else if (source.handedness === 'right') {
                    this.right = source;
                }
            });
            this.app.xr.input.on('remove', (source: XrInputSource) => {
                if (this.left === source) this.left = null;
                if (this.right === source) this.right = null;
            });
        }
    }

    /**
     * Should be called every frame while an XR session is active.
     * Returns a fresh unified input state.
     */
    update(_dt: number): XrInputState {
        const s = this.state;
        s.leftPresent = this.left?.gamepad != null;
        s.rightPresent = this.right?.gamepad != null;

        s.leftStick = this.left?.gamepad
            ? readStick(
                this.left.gamepad.axes[2] ?? 0,
                this.left.gamepad.axes[3] ?? 0,
            )
            : { x: 0, y: 0 };

        s.rightStick = this.right?.gamepad
            ? readStick(
                this.right.gamepad.axes[2] ?? 0,
                this.right.gamepad.axes[3] ?? 0,
            )
            : { x: 0, y: 0 };

        // Right-hand buttons (A/B) are index 4/5 on PICO.
        this.readButtons(
            this.right?.gamepad,
            this.rightHandled,
            s.trigger,
            s.aButton,
            s.bButton,
        );

        // Grip + menu are read from whichever hand has them; PICO reports
        // squeeze on both hands, menu (`home`) on the left controller.
        this.readGrip(this.left?.gamepad, this.leftHandled, s.grip);
        this.readMenu(this.left?.gamepad, this.leftHandled, s.menuButton);

        return s;
    }

    /** Map trigger/select events emitted by PlayCanvas into our trigger state. */
    private readButtons(
        gp: Gamepad | null | undefined,
        handled: Set<number>,
        trigger: XrButtonState,
        a: XrButtonState,
        b: XrButtonState,
    ) {
        this.fillButton(gp, 0, handled, trigger);
        this.fillButton(gp, 4, handled, a);
        this.fillButton(gp, 5, handled, b);
    }

    private readGrip(gp: Gamepad | null | undefined, handled: Set<number>, grip: XrButtonState) {
        this.fillButton(gp, 1, handled, grip);
    }

    private readMenu(gp: Gamepad | null | undefined, handled: Set<number>, menu: XrButtonState) {
        // PICO exposes the menu/home button on the left controller.
        this.fillButton(gp, 6, handled, menu);
    }

    private fillButton(
        gp: Gamepad | null | undefined,
        index: number,
        handled: Set<number>,
        out: XrButtonState,
    ) {
        const btn = gp?.buttons[index];
        const pressed = btn?.pressed ?? false;
        const value = btn?.value ?? 0;

        let justPressed = false;
        if (pressed && !handled.has(index)) {
            handled.add(index);
            justPressed = true;
        } else if (!pressed) {
            handled.delete(index);
        }

        out.pressed = pressed;
        out.justPressed = justPressed;
        out.value = value;
    }

    /** Dispose listeners. */
    destroy() {
        // PlayCanvas removes listeners automatically on app destroy for
        // handlers bound to app events; nothing further needed here.
    }
}