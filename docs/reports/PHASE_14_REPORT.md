# Phase 14 Report

## Result

PARTIAL

## Summary

Phase 14 implements XR navigation and viewpoint interaction for the PlayCanvas WebXR viewer. The PICO Neo 3 input mapping (left stick movement, right stick snap turn, A/B viewpoints, trigger annotations) is fully coded. A self-contained collision raycaster (Möller–Trumbore per-triangle raycast, no WASM dependency) is implemented. Viewpoint navigation (fade → move → fade-in with cooldown) and annotation panel rendering are complete.

A radians-vs-degrees bug in `Locomotion.applySnapTurn` was caught during automated unit testing and fixed — PlayCanvas 2.22's `Quat.setFromEulerAngles` takes degrees, not radians.

**Key limitation**: Real VR headset verification (PICO Neo 3 + PICO Connect) was not possible in this environment. All VR-session-dependent features (actual controller input reading, gravity/collision on device, annotation ray interaction, viewpoint transition rendering in headset) are implemented but not verified on hardware.

## Completed

- **XR Input Manager** — Wraps PlayCanvas WebXR input sources; reads PICO Neo 3 gamepad mapping (buttons 0–6, axes 2–3) with deadzone and rising-edge detection (`input-manager.ts`)
- **Locomotion module** — Head-relative movement (forward/strafe from camera orientation), snap turn (right stick X, cooldown), gravity (free fall), step-climb (step offset), wall collision sliding (`locomotion.ts`)
- **Snap turn radians bug fixed** — `setFromEulerAngles` takes degrees in PlayCanvas 2.22; corrected from radians conversion to degrees
- **Collision Raycaster** — Self-contained per-triangle Möller–Trumbore raycast against CollisionWorld mesh instances; AABB fast rejection; `castGround` / `castWall` APIs; no Ammo WASM dependency (`collision-raycaster.ts`)
- **Viewpoint Manager** — Loads enabled viewpoints sorted by orderIndex; next/previous with wraparound; 1.2 s cooldown; fade-out → move rig → fade-in transition state machine (`viewpoint-manager.ts`)
- **Fade Overlay** — World-space screen entity parented to camera; `setOpacity(0..1)` drives fade animation (`fade-overlay.ts`)
- **Interaction module** — Annotation ray detection (perpendicular ray-to-anchor distance test); world-space media panel (title/body/hint, CanvasFont for text, no external assets); background audio support (`interaction.ts`)
- **Data Loader** — Fetches viewpoints, annotations, and background audio from GSPlatform API or inline URL params; same shared data as desktop viewer (`data-loader.ts`)
- **XR App integration** — Registers ScreenComponentSystem + ElementComponentSystem; wires all modules; reads collision/profile from URL params; per-frame update loop during XR session; headless orbit fallback when `app.xr` is null (`xr-app.ts`)
- **Navigation profiles** — `INDOOR_PROFILE` / `OUTDOOR_PROFILE` constants with collision parameter overrides from URL/descriptor (`types.ts`)
- **Headless smoke test** — Dev server boots, scene loads (SOG), viewpoints filtered (2 of 3), annotations loaded (1), zero page errors (`scripts/smoke-test.mjs`)
- **Unit tests** — 7 passing tests: profile sanity, snap-turn degrees math, viewpoint wraparound, deadzone scaling, head-relative axis projection (`scripts/unit-test.mjs`)
- **TypeScript strict mode** — `tsc --noEmit` passes with no errors
- **Build** — Production build succeeds (`pnpm build`, ~1.58 MB gzipped ~419 KB)

## Not Completed

- **Real VR headset verification** — Requires PICO Neo 3 + PICO Connect hardware (not available in test environment)
- **Locomotion on device** — Left stick movement, gravity, collision wall/ground interaction not verified in headset
- **Snap turn on device** — Math verified in unit test but actual right-stick trigger not verified in headset
- **Viewpoint transition in VR** — Fade overlay rendering and rig teleport verified only at code level, not visually in headset
- **Annotation ray interaction** — Trigger-to-annotation ray detection not verified in headset
- **Media panel in VR** — World-space panel rendering not visually verified in headset
- **Background audio playback** — API URL wired but not verified in session (requires user gesture)
- **Collision raycast against real GLB** — No local GLB collision mesh available; raycaster code complete but not exercised against a real mesh

## Checklist

### Navigation

- [ ] 左摇杆。（implemented — input reads axes 2/3; movement requires device verification）
- [x] deadzone。（unit tested: <0.2 → 0, linear rescale 0.2→1 verified）
- [ ] movement speed。（profile constants wired; actual movement not device-verified）
- [ ] head-relative movement。（math unit-tested for axis projection; actual movement not device-verified）
- [ ] snap turn。（radians-vs-degrees bug found and fixed; unit math verified; right-stick trigger not device-verified）
- [ ] gravity。（implemented; free-fall and ground-snap logic coded but not device-verified）
- [ ] collision。（implemented per-triangle raycast; no real GLB to exercise against）
- [x] indoor/outdoor profile。（INDOOR/OUTDOOR constants unit-tested; profile selection from URL param verified）

### Viewpoints

- [ ] Next。（implemented with wraparound + cooldown; requires A-button in VR）
- [ ] Previous。（implemented with wraparound + cooldown; requires B-button in VR）
- [ ] cooldown。（1.2 s cooldown coded; not verified with held button in VR）
- [ ] Fade out。（FadeOverlay.setOpacity coded; rendering not verified in headset）
- [ ] move rig。（applyViewpoint positions rig + sets yaw; not verified in headset）
- [ ] Fade in。（fade-in transition coded; not verified in headset）
- [ ] target orientation。（atan2 yaw computation coded; not verified in headset）
- [x] wraparound。（next→first and prev→last unit-tested with index modulo)

### Interaction

- [ ] XR ray。（perpendicular ray-to-anchor test coded; not verified in headset）
- [ ] annotation select。（trigger press + ray hit coded; not verified in headset）
- [ ] media panel。（world-space screen panel created; CanvasFont text rendering coded; not visually verified in headset）
- [ ] close panel。（B button / grip dismiss; coded; not device-verified）
- [ ] audio。（background audio URL wired; playback requires user gesture — not verified in session）

**Checklist: 4 / 21 completed**

## Files Changed

- `apps/xr-viewer/src/types.ts` — Added XrViewpoint, XrAnnotation, XrNavigationProfile, XrInputState, INDOOR/OUTDOOR_PROFILE, XrBackgroundAudio
- `apps/xr-viewer/src/input-manager.ts` — **New**: XrInputManager wrapping PICO Neo 3 gamepad mapping
- `apps/xr-viewer/src/collision-raycaster.ts` — **New**: Self-contained Möller–Trumbore per-triangle raycaster
- `apps/xr-viewer/src/locomotion.ts` — **New**: Head-relative movement + snap turn + gravity
- `apps/xr-viewer/src/fade-overlay.ts` — **New**: World-space fade overlay for viewpoint transitions
- `apps/xr-viewer/src/viewpoint-manager.ts` — **New**: Viewpoint navigation with fade transition state machine
- `apps/xr-viewer/src/interaction.ts` — **New**: Annotation ray detection + media panel + background audio
- `apps/xr-viewer/src/data-loader.ts` — **New**: Shared Phase 10/11/12 data fetcher
- `apps/xr-viewer/src/xr-app.ts` — Rewritten: System registration, module wiring, headless fallback
- `apps/xr-viewer/scripts/smoke-test.mjs` — **New**: Headless Playwright smoke test with inline data
- `apps/xr-viewer/scripts/unit-test.mjs` — **New**: 7 unit tests for math/profile logic

## Dependencies Added

- `playcanvas` 2.22.0 (existing, no new dependencies)

## Commands Executed

```bash
pnpm --filter @gsplatform/xr-viewer typecheck        # PASS
pnpm --filter @gsplatform/xr-viewer build            # PASS (~1.58 MB / gzip ~419 KB)
node apps/xr-viewer/scripts/unit-test.mjs            # 7 passed, 0 failed
node apps/xr-viewer/scripts/smoke-test.mjs           # status OK, VPs:2, Annot:1, 0 page errors
```

## Tests

| Test | Command | Result |
|---|---|---|
| TypeScript strict mode | `tsc --noEmit` | PASS |
| Production build | `pnpm build` | PASS |
| Unit: profile sanity | `node scripts/unit-test.mjs` | PASS (3 assertions) |
| Unit: snap-turn degrees | `node scripts/unit-test.mjs` | PASS (radians bug caught and fixed) |
| Unit: viewpoint wraparound | `node scripts/unit-test.mjs` | PASS (next/prev modulo) |
| Unit: deadzone | `node scripts/unit-test.mjs` | PASS (neutralize + rescale) |
| Unit: head-relative axis | `node scripts/unit-test.mjs` | PASS (-Z forward) |
| Headless smoke: viewer boot | `node scripts/smoke-test.mjs` | PASS (PlayCanvas init, WebGL2 fallback) |
| Headless smoke: data pipeline | `node scripts/smoke-test.mjs` | PASS (2 VPs + 1 Annot loaded) |
| Headless smoke: zero page errors | `node scripts/smoke-test.mjs` | PASS |

## Runtime Verification

- Headless Chromium (no GPU): Viewer boots with WebGL2 fallback; `WebXR manager unavailable (headless)` shown in status bar; scene.sog loads from local-scenes middleware; inline viewpoints parsed and filtered (3→2 enabled); inline annotations parsed (1); zero page errors; all module constructors instantiate without error.

## Known Issues

- **Real VR headset verification unavailable** — PICO Neo 3 + PICO Connect not present in test environment; all VR-session-dependent features (locomotion, snap turn, annotation ray, panel rendering) implemented but unverified on hardware
- **No local GLB collision mesh** — `collision-raycaster.ts` code complete and typechecks, but not exercised against a real mesh in tests; requires a Phase 12 collision GLB to validate
- **PlayCanvas 2.22 removed `LIGHTTYPE_AMBIENT`** — Removed ambient light entity (Gaussian splats use their own shader); no scene light needed
- **Background audio requires user gesture** — `HTMLAudioElement.play()` called in `Interaction` after XR session starts; in headless, no session means no play; requires real device with audio permission

## Fixes Outside Current Phase

- **Snap turn radians-vs-degrees bug** — `Locomotion.applySnapTurn` in `locomotion.ts` used `setFromEulerAngles(0, radians, 0)` but PlayCanvas 2.22's API takes degrees. Fixed to pass degrees directly. Bug discovered via unit test asserting `euler.y === 45`.

## Git Status Before Commit

```
 M docs/MasterPrompt.md                    # user edit — NOT committed
 M apps/xr-viewer/src/types.ts             # Phase 14
 M apps/xr-viewer/src/xr-app.ts            # Phase 14
 M apps/xr-viewer/src/locomotion.ts        # Phase 14 (bug fix)
 M apps/xr-viewer/src/collision-raycaster.ts # Phase 14 (rewrite)
 M apps/xr-viewer/src/interaction.ts       # Phase 14 (bug fix + improvements)
 M apps/xr-viewer/src/input-manager.ts     # Phase 14
 M apps/xr-viewer/src/fade-overlay.ts      # Phase 14
 M apps/xr-viewer/src/viewpoint-manager.ts # Phase 14
 M apps/xr-viewer/src/data-loader.ts       # Phase 14
?? apps/xr-viewer/scripts/                 # Phase 14 (smoke test + unit test)
?? docs/decisions/ADR-0002-phase13-dependency-override.md  # ADR from previous session
```

## Commit

`docs/MasterPrompt.md` and `docs/decisions/ADR-0002-phase13-dependency-override.md` are excluded from this commit (user edit / prior ADR).

## Branch

`main`

## Push Result

`NOT EXECUTED` (§5.5: commit only, no push)

## Next Phase Readiness

NOT READY — requires real PICO Neo 3 VR headset verification before PASS.
