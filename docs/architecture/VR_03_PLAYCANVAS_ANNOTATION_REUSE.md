# VR-03 — PlayCanvas Annotation reuse pre-audit

Date: 2026-10-12. Status: **research/design only; no VR-03 implementation**.
Repository baseline: `62aacd771e3bd34a57f7559d331a953018c26d2e`.

## 1. Evidence and version boundary

Required official sources were fetched and read on 2026-10-12:

- https://developer.playcanvas.com/user-manual/supersplat/studio/annotations/
- https://developer.playcanvas.com/user-manual/supersplat/studio/cameras/
- https://developer.playcanvas.com/user-manual/supersplat/studio/experience-settings/
- https://github.com/playcanvas/supersplat-viewer
- https://github.com/playcanvas/engine

Context7 resolved `/playcanvas/supersplat-viewer` and fetched the createViewer,
selectAnnotation, XR and settings contract. A follow-up Engine query returned no
matching documentation; conclusions about Engine navigation therefore use the
installed package and the matching official tag, not remembered API signatures.
Bocha search returned HTTP 403, insufficient balance/package quota. Official
pages, GitHub tag metadata and raw source retrieval succeeded. This is not a
claim that a general web search succeeded.

The authority for what GSPlatform can use **today** is:

| Dependency | Installed pin | Official tag commit |
| --- | --- | --- |
| `@playcanvas/supersplat-viewer` | `1.35.0` | `329a80aaec593da234635e68055d7b38a8e836e4` |
| `playcanvas` | `2.22.4` | `b5b983982a9860d21e0c1dafb2f85f72e2c01afb` |

Viewer source was extracted from the installed `dist/viewer.js.map` and compared
with official `v1.35.0` source. Engine navigation was read from the installed
`scripts/esm/xr/xr-navigation.mjs` and compared with `v2.22.4`. These source files
match the official tags. Do not substitute `main` or current Studio behavior for
the locked package contract. No dependency upgrade is proposed in this task.

Pinned evidence:

- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/viewer.ts
- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/camera-manager.ts
- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/xr.ts
- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/ui/annotations.ts
- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/ui/annotation-controls.ts
- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/picker.ts
- https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/src/input/app/nav-interaction.ts
- https://github.com/playcanvas/engine/blob/v2.22.4/scripts/esm/xr/xr-navigation.mjs
- https://github.com/playcanvas/engine/blob/v2.22.4/src/framework/xr/xr-manager.js

## 2. Official capability matrix

| Capability | Official 1.35.0 / 2.22.4 evidence | Reuse decision |
| --- | --- | --- |
| World hotspot position, title, text, camera, extras | Settings `Annotation` | Direct mapping from SceneAnnotation |
| Marker projection, selection, overlay | `ui/annotations.ts`, `ui/annotation.ts` | Reuse desktop Viewer UI |
| Smooth camera transition | `CameraManager.selectAnnotation()` | Reuse; never implement interpolation |
| Previous / Next, wrap-around | `ui/annotation-controls.ts` | Reuse desktop Annotation Navigator |
| Guided-tour start | Settings `startMode: 'annotation'` | First settings annotation; arbitrary default ID requires small host mapping |
| Settings v2 validation / v1 import | `defaultSettings`, `validateSettings`, `importSettings` | Keep official schema as runtime authority |
| Initial camera | `cameras[0].initial` | Direct mapping; no native multi-viewpoint CRUD |
| Start/end immersive VR | `ViewerHandle.startXR('vr')`, `endXR()` | Already reused; WebGL2 on PICO |
| Tracked controllers and head pose | `initXr`, Engine XR components | Already reused |
| Stick movement, snap/smooth turning, vertical snaps | Engine `XrNavigation` | Already installed by official Viewer |
| Ballistic floor teleport | `XrNavigation.tryTeleport(inputSource)` and `castRay` | Reuse only with appropriate floor semantics |
| Teleport to an arbitrary stored annotation pose | No Viewer handle method; no `teleportToPose` in pinned helper | Small public Engine rig-transform adapter; hardware gate |
| Immersive controller-selectable annotation UI | Desktop annotation UI uses DOM mouse listeners | Not supplied by the desktop UI; thin world-space XR UI needed |
| Accurate host authoring pick | Internal Picker has `pickSurface`; no corresponding ViewerHandle method | Do not claim public precise pick API |

Studio is an official hosted authoring product, not a local GSPlatform component.
Reuse its published settings contract and the open-source Viewer/Engine. Do not
copy its account, publishing, billing, hosted storage or other hosted business.

## 3. Fixed-version API evidence

Local contracts are in
`apps/web/node_modules/@playcanvas/supersplat-viewer/dist/viewer.d.ts` and
`dist/settings.d.ts`:

- `createViewer(options: CreateViewerOptions): Promise<ViewerHandle>`.
- Handle exposes `app`, observable `state`, `events`, `annotations`,
  `selectAnnotation(index: number | null)`, `startXR`, `endXR`, `resetCamera`,
  `frameScene`, `captureFrame` and `setMoveInput`.
- `annotations` is `readonly Readonly<Annotation>[]`; its contract explicitly
  says editing entries is unsupported. It is not a supported live CRUD API.
- `selectAnnotation` requires loaded state and a valid index, or `null` to clear
  selection. Re-selecting the same index navigates again. It does not return an
  animation-completion promise.
- `cameraManager` is internal to Viewer, **not** an exported handle property.
  Handle has no public arbitrary `setCameraPose`, precise pick or XR-pose API.
- `setMoveInput` is fly/walk input and is ignored in XR; it is not a replacement
  for the official XR stick controls.
- Settings v2 Annotation is `{ position, title, text, extras?, camera: { initial:
  { position, target, fov } } }`. Camera FOV limits are 10–120 degrees.
- Authoring limits are 25 annotations, title length 60 and text length 280.
  GSPlatform DB permits larger text: expose limits in creation UI instead of
  silently making authors believe the whole description is visible.
- Official Prev/Next appears only with at least two annotations and wraps around
  settings order. A single-point tour still has a hotspot, not a two-button tour.

The current manual documents a Studio-wide lens setting; the pinned Viewer
schema still carries FOV per saved camera. Do not infer extra runtime APIs from
current Studio controls.

## 4. Current GSPlatform data and authoring capability

### Viewpoint

`scene_viewpoints` already stores name, position, target, FOV, order and enabled.
`authoring.py`, presentation routes and `useSceneAuthoring.ts` implement list,
create, update, delete and reorder. Backend update can change the camera pose.

`ViewpointPanel.tsx` currently exposes create-from-current-pose, rename, delete,
enabled toggle and desktop locate. Despite its introductory comment it has no
reorder control. Updating a saved pose from the current camera and setting a
default viewpoint are not wired as explicit panel actions. There is no title +
description hotspot model in Viewpoint.

### Annotation

`scene_annotations` already stores title, description, text_content, anchor,
optional per-annotation camera position/target/FOV, order_index and enabled,
plus media/style fields. API supports CRUD, pose/anchor update and reorder.

`AnnotationPanel.tsx` provides create-pick mode, title/textContent editing,
enabled toggle and delete. Its comment mentions reorder but no reorder action is
implemented. `description` exists in DB/API, but this panel edits `textContent`;
the runtime also uses `textContent` as official text. A user-facing description
editor must deliberately map to that field, not maintain two inconsistent bodies.
Position re-pick, capture/replace camera pose and default-guide selection are
missing user actions, not missing navigation algorithms.

### Existing official adapter

`experienceAdapter.ts` maps enabled annotations into official settings, maps
title/text, carries `{ gsplatform: { annotationId, contentType } }` in extras,
and converts both anchors and saved camera poses from SCENE to RUNTIME space.
IDs are stable DB IDs; indices are only runtime lookup indices. Missing old camera
poses fall back to the scene's initial camera / official defaults. Those are
legacy text hotspots, not verified XR destinations.

`SuperSplatRuntime.selectAnnotation()` delegates to official selection.
`selectViewpoint()` is **not a second camera interpolation implementation**:
it uses the existing official selection path through a synthetic camera-pose
annotation. However, `ensurePoseAnnotation()` casts the readonly array mutable
and appends/replaces entries after UI creation. That violates the documented
public handle contract and can contaminate navigator length/index assumptions.
Quarantine this existing compatibility behavior; do not build VR-03 on it or
claim it is a public pose setter. No new synthetic annotations should be written
at runtime for guide nodes. Pure viewpoints remain existing legacy features until
a separately reviewed official pose API / compatibility strategy is available.

## 5. Screenshot/request correspondence

No user screenshot or image attachment is present in this task. The following
mapping is from the supplied textual workflow, **not** an invented image reading.

| Requested user function | Existing / official equivalent | Remaining work |
| --- | --- | --- |
| Add guide point | Annotation with saved camera | Rename/streamline GSPlatform creation UI |
| Double-click grass to place marker | Annotation world position | Correct event binding; honest pick precision |
| Title and description | Official title/text | Unified textContent editor and limit feedback |
| Click hotspot, smooth move | Official marker + selectAnnotation | Already available on desktop |
| Previous / Next | Official Annotation Navigator | Enable only its existing UI region |
| Sort / hide / delete | DB order/enabled + existing endpoints | Small authoring controls |
| Default guide point | Official first annotation start mode / host ID selection | Nullable ScenePresentation reference |
| XR select point / next / previous | Same Annotation IDs and ordered records | XR UI/input + one rig-placement adapter |

## 6. Double-click and picking audit

The panel says “双击场景拾取位置…”, but `SceneAuthoringPage.tsx` binds
`onClick={handleAnnotationPickClick}` on its viewer container. The first single
click creates the annotation. This is not a real double-click implementation.
The official Viewer also has double-click/focus behavior, so a future authoring
pick gesture must avoid conflicting focus/navigation actions and double creates.

`pickApproximateWorldPosition()` builds a view ray and takes a point at the
bounding-box-center focus depth. It is neither a splat intersection nor a floor
hit. It can put a grass marker behind/in front of grass, and ray/FOV handling
requires review on wide viewports. “Near the visible grass” cannot be represented
as a guaranteed physical surface landing point.

The official pinned internal `Picker.pickSurface()` does rendered-scene depth
picking, and `NavInteraction` uses it or collision for navigation. It is not in
ViewerHandle. Prefer requesting a supported upstream pick hook; meanwhile keep
the UI explicitly approximate, permit marker correction, and never reuse bbox
depth as proof of a safe XR landing. Do not copy the GPU picking algorithm.

The active pick handler **does capture current camera pose** and converts it
back to SCENE coordinates before creating the annotation. It saves immediately
after the click; the title/text are edited later. The unused panel `onCreate`
wiring creates only an anchor. A guided creation draft must capture the pose at
the declared step and submit anchor + pose + title/text together only on Save;
cancel must not leave empty persisted records.

## 7. Official desktop UI versus immersive XR UI

GSPlatform uses `ui: true` to get official markers, but
`superSplatUiCompatibility.ts` hides all `.sse-ui` and retains `.sse-sceneLayer`.
This also hides the official Annotation Navigator. Restore a narrowly scoped
official annotation-controls region on desktop and avoid duplicating it in a
GSPlatform Next/Previous React widget. Internal CSS selectors must stay in that
one pinned compatibility module with browser and contract tests.

Official markers/navigation are DOM UI with mouse listeners. Desktop DOM working
over the canvas does not establish that those controls appear in, or accept
controller rays in, immersive VR. The Viewer installs XrControllers and
XrNavigation, but does not connect their select events to annotation DOM markers.
Keep desktop UI separate from a minimal XR world-space guide chooser backed by
the same IDs, title/text and order. Use Engine XR input events/rays, not a new
WebXR controller runtime. Reuse existing GSPlatform media overlays where valid;
do not promise DOM media overlays are visible in the immersive headset.

## 8. XR rig: what the source actually proves

Pinned `src/xr.ts` attaches official `XrControllers` and `XrNavigation` scripts
to the camera's parent entity. On session start it copies desktop camera X/Z and
yaw into that parent; the parent's Y is set to zero. On exit it restores cached
parent and camera transforms. This can lose a desktop saved camera elevation on
entry; it is not a generic saved-pose spawn contract.

Pinned `src/viewer.ts` application-update handler explicitly returns immediately
when `app.xr.active`. Desktop camera-manager update/applyCamera is skipped.
`selectAnnotation()` still selects the record and schedules an orbit transition,
but **does not move the active XR rig**. The engine updates the camera's local
position/rotation from the headset's reference-space pose each XR frame.
Writing the desktop camera pose is not XR teleportation.

The supported Engine boundary is `app.xr.camera` (camera Entity), its `parent`
(rig), ordinary public Entity transforms, and XR input APIs. No internal
cameraManager or fake session object is needed.

Official Engine `XrNavigation` provides:

- Left stick camera-relative movement; right stick snap/smooth turning; vertical
  snap options; default floor teleport and configurable `castRay` detection.
- `tryTeleport(inputSource)` consumes its current/cached arc hit. It is not
  `teleport(position, yaw)`, not a saved-annotation destination API.
- Its floor teleport subtracts **world-space head X/Z offset** from destination
  and adjusts rig Y by change in floor height. This remains correct after rig
  yaw; raw local head-offset subtraction is insufficient.
- Default ground is a plane at Y=0 and max teleport distance defaults to 10.
  It does not prove the plane coincides with a Gaussian scene's grass/floor.
  The Viewer does not install a GSPlatform-safe node/floor `castRay` policy.

Future thin adapter requirements, not implementation in this task:

1. Resolve enabled, non-STALE Annotation by ID. Require authored camera position
   and target; old camera-less hotspots cannot silently become XR teleport nodes.
2. Convert the authored camera through the existing SCENE→RUNTIME transform.
   Treat the saved camera position as an **eye pose**, not the marker or floor.
3. Derive desired yaw from the horizontal position→target direction; reject
   degenerate heading. Preserve natural headset pitch/roll and tracked height.
4. Calculate rig yaw relative to current tracked head yaw. For eye-pose placement,
   the required rig translation is destination eye position minus the rotated
   tracked head offset. Use current same-frame XR pose; respect parent transforms.
   Do not replace Engine tracking. Floor landing would need a different, explicitly
   calibrated floor contract, not blind subtraction of a guessed player height.
5. Reject non-finite, out-of-bounds, stale and unauthorized destinations. Content
   bounds are only a coarse outside-scene guard, not a physical collision test.
   When calibrated collision is available, validate landing clearance and support.
6. Apply a one-shot public rig transform, with a small comfort/fade UI if approved.
   Leave stick movement, turn/pivot/head-offset handling to official XrNavigation.
   Do not manipulate its private cached arc hits or `_currentGroundY` to forge a
   `tryTeleport` call. Arbitrary eye placement and helper ground-state semantics
   need PICO validation; disable its floor-teleport path in uncalibrated free-flight
   mode rather than claiming a safe grounded state.
7. During node select, prevent the same trigger release from also invoking the
   helper's floor teleport. Use supported enableTeleport/input ownership gates.
   Preserve XrNavigation's original configuration on cancellation/exit.
8. Validate next frame, later tracking updates, stick movement after placement,
   and session exit restoration. Desktop transition success is not this gate.

Uncalibrated scenes without physical collision retain **free-flight scene
inspection** semantics, not walkable/grounded navigation or safety. Gaussian
geometry alone does not provide physical boundaries, a metric scale or a floor.
PICO room boundaries remain the user's safety boundary. Node jumps must be
described accordingly; no invented collision or metric calibration.

## 9. Data model, defaults and STALE compatibility

Recommended meanings:

- **导览节点** = SceneAnnotation, with marker, title/text and optional authored
  camera pose. New guide nodes require the pose; old annotations remain valid
  textual hotspots with conservative desktop fallback.
- **观察点** = SceneViewpoint, a pure saved view without a visible marker.
- No third NavigationNode table, no duplicate rows representing the same stop,
  no synchronization between a shadow Viewpoint and Annotation.

Use existing order_index and enabled. Hidden tour stop means enabled=false and
is excluded from runtime settings. The existing `style='HIDDEN'` is not mapped
to an official per-marker visibility switch by the current adapter: do not
promise an invisible-but-selectable marker simply by changing style.

For an arbitrary default guide point, propose nullable
`ScenePresentation.default_annotation_id`, same-scene/enabled validation and
delete-safe clearing. It references the Annotation; it must not duplicate its
camera in another row. Preserve authored tour ordering and resolve the ID to the
compiled index after loaded, then call official selectAnnotation once on desktop.
If choosing the official startMode annotation path, it selects the first entry;
do not silently reorder the tour just to implement a different default ID.
Initial-camera and tour-default are separate, explicit start choices.

Existing publication invalidation is already conservative:

- `PublishService` marks `SceneSpatialState` STALE when a same-scene Editor
  publication changes the SceneVersion, preserving old spatial records.
- `SceneRuntimeService` clears runtime world transform/initial camera, suppresses
  viewpoints/annotations and disables/stales collision for STALE scenes.
- The existing transform adapter keeps SCENE coordinates canonical; do not write
  XR/RUNTIME coordinates directly into Annotation or Viewpoint rows.

Do not delete or auto-reproject old records. A future re-authoring/version
confirmation flow must explicitly validate which records are suitable for the
new version. Editing one title must not blanket-mark all old anchors/poses valid.
Current authoring CRUD does not itself provide such a scene-wide STALE repair
workflow. Newly saved records in a stale scene must not bypass suppression by an
ad-hoc client marker list.

## 10. The single recommended implementation

**Annotation-backed guide nodes + official desktop annotation UI/navigation +
existing official XR locomotion + a small public Engine rig-placement/UI bridge.**

Build new guide nodes directly in existing Annotation CRUD. UI adds a draft
creation/edit workflow, real double-click binding, limits, order, hide and default
reference. Compile the descriptor once through existing experienceAdapter and
recreate the Viewer on saved-settings changes, as the authoring page already does;
do not mutate readonly handle annotations. On desktop enable official Annotation
Navigator and selectAnnotation. For XR, a small chooser shares those same DB IDs
and validates authored destinations before one-shot rig placement. Retain
XrNavigation for free movement and turning. Its floor teleport remains subject
to scale/floor/collision admission, not conflated with guide-node eye placement.

Implement only after user authorizes VR-03 and PICO retesting of VR-01A completes.
No navigation engine, animation system, third data model, dependency upgrade or
XR-runtime rewrite is justified by this audit.

## 11. Future concrete change list (not changed this round)

| File / area | Bounded future responsibility |
| --- | --- |
| `apps/web/src/features/authoring/AnnotationPanel.tsx` | Guide draft/edit fields, order/hide/default actions, limits |
| `apps/web/src/pages/SceneAuthoringPage.tsx` | Real double-click draft capture, cancel/save, re-pick and pose update |
| `apps/web/src/features/authoring/ViewpointPanel.tsx` | Keep pure viewpoints; small missing order/pose actions only |
| `apps/web/src/features/authoring/useSceneAuthoring.ts` | Existing CRUD/reorder/default reference wiring |
| `apps/web/src/services/annotationApi.ts` | Existing endpoint DTOs and reordered IDs, no new navigation API |
| `apps/web/src/scene-runtime/experienceAdapter.ts` | Annotation/default-ID mapping, limits, stable ID/index mapping |
| `apps/web/src/scene-runtime/superSplatUiCompatibility.ts` | Show only official desktop Annotation Navigator; pinned DOM gate |
| `apps/web/src/scene-runtime/SuperSplatRuntime.ts` | Small capability boundary, no new readonly-array mutation |
| Possible `apps/web/src/scene-runtime/XrAnnotationNavigationAdapter.ts` | One-shot public rig transforms/admission/lifecycle only |
| `apps/web/src/pages/XRViewerPage.tsx` + one small XR chooser | Engine input ownership and world-space node controls |
| `apps/api/app/db/models/scene_presentation.py` + one migration | Nullable default Annotation reference if approved |
| `apps/api/app/schemas/scene_annotation.py`, `scene_presentation.py`, `scene_runtime.py` | Bounded pose/default/version DTO extension |
| `apps/api/app/services/authoring.py`, `scene_runtime.py` | Same-scene validation, default deletion, STALE gate |
| Existing web unit / authoring E2E / API suites | Draft, ID/order, limits, permissions, transform and STALE regression |

`scene_annotation.py` / `scene_viewpoint.py` are existing models; no third table.
No Gaussian conversion, collision build or historical data migration is needed
just to create editable guide metadata. Any later calibration is a separate task.

## 12. Future VR-03 acceptance matrix

| Gate | Expected | Verification |
| --- | --- | --- |
| Add guide point | Current authored pose + chosen anchor + title/text saved once | Unit + real browser |
| Gesture | Single click does not save; genuine double click drafts once | Browser, cancel and drag cases |
| Pick honesty | Approximate mode labeled; no surface/collision guarantee | UI + source contract |
| Modify / delete / order / hide | Existing IDs, no shadow records; hidden excluded | API + browser |
| Arbitrary default | Valid same-scene enabled ID; deletion clears it | API + load browser |
| Desktop hotspot | Official marker selects correct DB Annotation | Browser |
| Smooth travel / previous / next | Official camera transition and navigator | Browser; 0/1/many nodes |
| Text limits / legacy no-pose | Honest truncation limits; legacy not XR destination | Unit + browser |
| Scene world transform | Marker/camera align under nonidentity W | Existing transform tests + browser |
| SceneVersion change | STALE suppresses old nodes/collision, no data destruction | API/publication tests |
| Private/share/owner/CSRF | Same authority as formal scene/asset reads | API + anonymous browser |
| XR controller selection | Correct ID, no simultaneous floor teleport | PICO Neo3 only |
| XR pose after head offset/yaw | Effective eye position/head yaw correct after room movement and rig turning | PICO + same-frame diagnostics |
| XR movement after jump | Official stick/turn remains functional, no snap back | PICO Neo3 |
| Invalid/outside/stale landing | Refused, no rig update | Unit + PICO |
| No metric scale/collision | Clearly free-flight; floor teleport not falsely safe | PICO + admission tests |
| Session exit/re-entry | Official restoration intact; listeners/config cleaned | PICO Neo3 |

Desktop Chromium cannot certify immersive controller interaction or PICO rig
placement. The present task does not implement or execute these XR node gates.

## 13. Explicitly prohibited reimplementations

- Official orbit/fly camera controllers, interpolation/easing and transition timing.
- Official desktop Annotation marker projection, tooltip and Prev/Next navigator.
- GPU/depth splat picking, SOG streaming/LOD selection and sorting algorithms.
- WebXR session lifecycle, headset tracking, controller rendering, joystick motion,
  ballistic arc and snap/smooth turning.
- A new XR runtime, navigation engine or NavigationNode persistence system.
- Studio hosted publishing/account/storage business copied into the application.
- A fake saved-pose teleport via desktop camera writes, private navigation caches,
  fabricated reference-space pose, or a local manifest masquerading as DB runtime.

Sources: official URLs in sections 1–3, installed pinned source and the named
GSPlatform files. No screenshot content was inferred; no PICO success is claimed.
