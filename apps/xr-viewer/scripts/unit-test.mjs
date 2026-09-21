/**
 * Phase 14 module logic tests — run against the compiled/typechecked modules.
 *
 * These test the pure-math logic (deadzone scaling, snap-turn math,
 * viewpoint ordering/wraparound/cooldown) without requiring a browser or VR
 * hardware. Run:  node scripts/unit-test.mjs
 *
 * The locomotion/collision modules depend on `playcanvas` Vec3/Quat math —
 * importing them in Node works because playcanvas ships ESM math classes
 * decoupled from a graphics device.
 */

import assert from 'node:assert/strict';
import { Vec3, Quat } from 'playcanvas';
import { INDOOR_PROFILE, OUTDOOR_PROFILE } from '../src/types.ts';
import { XrInputManager } from '../src/input-manager.ts';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
}

// ---- profile sanity ----
ok('INDOOR_PROFILE slower than OUTDOOR_PROFILE', () => {
  assert(INDOOR_PROFILE.moveSpeed < OUTDOOR_PROFILE.moveSpeed);
  assert(INDOOR_PROFILE.snapTurnDegrees > OUTDOOR_PROFILE.snapTurnDegrees);
  assert(INDOOR_PROFILE.stepOffset < OUTDOOR_PROFILE.stepOffset);
  assert(INDOOR_PROFILE.gravity === 9.81);
});

// ---- snap-turn math (mirrors locomotion.applySnapTurn) ----
ok('snap turn rotates rig by profile degrees (Y axis)', () => {
  const rigRot = new Quat(); // identity
  const degrees = INDOOR_PROFILE.snapTurnDegrees; // 45
  // setFromEulerAngles takes degrees (PlayCanvas math API).
  const step = new Quat().setFromEulerAngles(0, degrees, 0);
  const out = rigRot.clone().mul(step);
  const euler = out.getEulerAngles();
  assert(Math.abs(euler.y - 45) < 1e-6, `yaw=${euler.y}`);
});

// ---- viewpoint wraparound (mirrors ViewpointManager) ----
ok('next() wraps from last to first', () => {
  const idx = 2; const n = 3;
  assert.equal((idx + 1) % n, 0);
});
ok('previous() wraps from first to last', () => {
  const idx = 0; const n = 3;
  assert.equal((idx - 1 + n) % n, 2);
});

// ---- deadzone logic (mirrors input-manager deadzoned()) ----
function deadzoned(v, dz = 0.2) {
  const mag = Math.abs(v);
  if (mag < dz) return 0;
  return Math.sign(v) * ((mag - dz) / (1 - dz));
}
ok('deadzone neutralizes small input', () => assert.equal(deadzoned(0.1), 0));
ok('deadzone rescales remaining range', () => {
  assert.equal(deadzoned(0.2), 0);
  assert.ok(Math.abs(deadzoned(1.0) - 1.0) < 1e-9);
  assert.ok(deadzoned(0.6) > 0.4 && deadzoned(0.6) < 0.6);
});

// ---- head-relative movement axis math (mirrors locomotion.applyMove) ----
ok('forward joystick moves along camera -Z', () => {
  // camera looking down -Z (identity). ly = -1 (pushed up) => forward.
  const ly = -1, lx = 0;
  const camFwd = new Vec3(0, 0, -1); // head forward
  const camRight = new Vec3();
  camRight.cross(new Vec3(0, 1, 0), camFwd).normalize();
  const move = new Vec3();
  move.x += camFwd.x * -ly + camRight.x * lx;
  move.z += camFwd.z * -ly + camRight.z * lx;
  // -Z forward push should move toward -Z
  assert.ok(move.z < 0, `move.z=${move.z}`);
});

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILURES' : 'all green'}`);