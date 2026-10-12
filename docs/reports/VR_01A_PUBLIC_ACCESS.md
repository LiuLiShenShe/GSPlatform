# VR-01A — public formal XR scene acceptance

Date: 2026-10-12 (Asia/Shanghai). Scope: isolated VR-00 staging only.
This report records runtime database changes separately from committed source.

## Git baseline and worktree

- Initial HEAD and origin/main: `62aacd771e3bd34a57f7559d331a953018c26d2e`.
- Worktree: `/fj/GSPlatform`, existing main checkout; no new branch/worktree,
  reset, force push or user-file cleanup.
- Existing user deletions of historical documentation and untracked
  `docs/GSPlatform_WebXR_VR_Master_Plan.md` are excluded from this task's commits.
- Source commit, deployed build identity, normal push and clean-source gate are
  recorded in the final acceptance update below. No source hash is substituted
  for proof of the database visibility mutation.

## Environment and authorization baseline

Verified live managed API (loopback 18001), Vite 5175, isolated Nginx 5174,
publish/CPU/GPU workers, Beat and Quick Tunnel. Dedicated runtime database:
`gsplatform_vr00_20261011`, dedicated role of the same name, PostgreSQL server
`172.19.0.10:5432`. Production-mode settings do not make this shared production:
the mode-600 runtime.env and isolation.json prove ISOLATED_STAGING, dedicated
storage and broker `redis://127.0.0.1:16384/0`. Shared production DB is never
connected for writing, and shared services/files are not stopped or modified.

Baseline API process build is the starting HEAD. Proxy/tunnel process receipts
were older, which is recorded rather than misreported as a newly deployed API.
The startup script sets `GS_BUILD_VERSION` from the actual committed HEAD.

Existing legitimate Owner session from the protected external state directory
successfully resolves `GET /api/v1/auth/me` to:
`8b65607e-e602-494c-ab4e-828fa51ce4c6`. It is the scene Owner, not a developer
identity bypass. Another real session resolves to a different user. Session
cookies remain Secure / SameSite=Lax; gs_session is HttpOnly. No cookie, password
or CSRF value is copied into Git. Mutation uses the matching readable gs_csrf
cookie and X-CSRF-Token, plus expectedUpdatedAt from Owner GET.

## Current scene: genuine database evidence

| Field | Before | After |
| --- | --- | --- |
| scene.id | `5f10e536-e86b-44f7-bdec-5e3a667eebc7` | unchanged |
| slug | `u-a68b94d84538` | unchanged |
| owner_id | `8b65607e-e602-494c-ab4e-828fa51ce4c6` | unchanged |
| visibility | PRIVATE | PUBLIC |
| status | PUBLISHED | PUBLISHED |
| current_version_id | `68cb9e7b-11a5-44d8-9070-e146b9e55aba` | unchanged |
| SceneVersion.asset_version | `c10c127b4574` | unchanged |
| deleted_at | NULL | NULL |
| updated_at | `2026-10-11T14:39:16.631482+00:00` | `2026-10-12T02:36:11.668533+00:00` |

`PATCH /api/v1/scenes/u-a68b94d84538` with visibility PUBLIC and observed
expectedUpdatedAt returns 200 through the existing Owner API. No SQL UPDATE,
PUBLISHED fabrication, authorization override, share-as-owner trick or re-publish
is used. An immediate anonymous follow-up was non-200; the verification stopped
there and resumed **read-only** after PostgreSQL showed committed PUBLIC. No
duplicate PATCH or visibility flip was performed. Later anonymous detail/runtime
both return 200. The original mutation status was checked, while full subsequent
verification has a saved receipt; no claim of an uninterrupted first run.

Protected external evidence directory:
`/home/test/.local/state/gsplatform-vr00-20261011/vr01a/`.
`database-before.json` / `database-after.json` contain PostgreSQL to_jsonb snapshots;
`public-access.json` contains authorization, HTTP and immutable-data checks.
Snapshot comparison proves only visibility and updated_at changed on the scene;
all SceneVersion rows, CollisionAsset rows, SceneProcessingSettings rows and
30 published file SHA-256 hashes are unchanged. The only existing PUBLISH Job
remains SUCCEEDED. Other historical private scenes are not mass-updated.

## HTTP and asset evidence

| Actual request | Before | After |
| --- | --- | --- |
| Anonymous scene detail | 401 | 200 |
| Anonymous formal runtime | 401 | 200 |
| Owner detail/runtime | 200 | 200 |
| Other user detail/runtime | 403 | PUBLIC read allowed |
| Owner mutation without CSRF | 403 | 403 |
| Other-user mutation with valid own CSRF | 403 | 403 |
| Direct internal scene-origin path | not a public route | 404 |

Official descriptor content is:
`/api/v1/scenes/u-a68b94d84538/assets/versions/c10c127b4574/lod-meta.json`,
format `lod-meta`, schemaVersion 1, scene ID from the database. Descriptor before
and after the visibility-only operation is identical.

Actual anonymous asset reads:

- lod-meta.json: 200; counts `[1788, 536, 179]`, total LOD storage count 2503.
- Real `0_0/meta.json`: 200; LOD0 Gaussian count 1788.
- Real `0_0/means_l.webp`: 200; 5526 bytes; SHA-256
  `0a057badc0758d3a5155a889a6694b28c470c1e6409de39cb5348652b6921a54`.
- `Range: bytes=0-31`: 206, exactly 32 matching bytes,
  `Content-Range: bytes 0-31/5526`.
- Out-of-bounds Range: 416.
- Immutable asset cache: public, max-age=31536000, immutable, as permitted for
  PUBLIC + PUBLISHED. Private assets remain policy-gated and privately cached.
- Streamed SOG chunks in this version are meta.json plus WebP payloads, not an
  invented `.sog` file. Every requested URL is derived from runtime/LOD metadata.

Nginx `/_scene-origin/` remains internal X-Accel-Redirect; no public disk alias
was added to bypass SceneAccessPolicy.

## Default visibility and reconstruction audit

`GS_DEFAULT_UPLOAD_VISIBILITY` accepts only PUBLIC / PRIVATE / UNLISTED; an
unconfigured API stays PRIVATE. This default is evaluated when constructing
CreateUploadRequest / CreateReconstructionRequest and **never overrides an
explicit client choice**. Explicit PRIVATE remains PRIVATE even in public staging;
explicit PUBLIC remains PUBLIC in safe-private configuration; explicit UNLISTED
remains UNLISTED. Invalid configured or request values are rejected.

The staging runtime.env is explicitly configured PUBLIC in the deployment
checkpoint. Tracked production env examples explicitly retain PRIVATE.
UploadPage stays PUBLIC by default and adds:
“公开场景可被任何获得地址的人查看。” Private remains selectable and drafts preserve it.

PLY/SOG publication takes visibility from the persisted UploadSession.
Reconstruction references/validates owned complete UploadSessions for input, but
its output Scene metadata is declared by CreateReconstructionRequest rather than
inheriting the first input's privacy. Both omitted-request defaults now use the
same setting. ComputePage output selection is aligned to PUBLIC with the same
warning and explicit Private regression; its raw photo/video UploadSessions stay
explicitly PRIVATE. Same-scene Editor uploads explicitly inherit the existing
scene.visibility, so a private historical edit is not made public by the default.
No reconstruction worker, job dispatch, conversion or collision behavior changed.

## Permission regression

New `apps/api/tests/test_vr01a_public_access.py` has 36 tests, using real sessions
for HTTP security rather than anonymous-as-dev-owner fixtures:

- PUBLIC + PUBLISHED anonymous 200; PUBLIC + PROCESSING anonymous 401.
- PRIVATE Owner 200; anonymous 401; other real user 403, including denied assets.
- Deleted scene 404 on detail, runtime and assets for every actor.
- Upload missing visibility uses environment default; explicit visibility wins;
  PUBLISH and RECONSTRUCT UploadSessions persist correct declarations.
- Safe-private configuration and invalid environment/request values.
- Anonymous upload/mutation denied; Owner writes require CSRF; non-owner denied.
- Owner visibility update retains status/version; stale optimistic update 409.
- Share grant/revocation and mutation CSRF remain effective.

Existing access/asset/cache/editor/publication/auth regressions also run in the
full API suite. No SceneAccessPolicy rule is loosened.

## Test gates and checkpoints

All tests use dedicated test databases/storage, never the shared production DB.

| Gate | Initial result / follow-up |
| --- | --- |
| Backend Ruff | exit 0 |
| Backend Mypy | initial stale incremental-cache error; `--no-incremental` succeeds; standard rerun exit 0, 94 source files |
| Backend Pytest | exit 0; 555 tests |
| New backend targeted suite | exit 0; 36 tests |
| Workers Pytest | exit 0; 124 passed / 1 skipped |
| Web Typecheck / Lint / Build | initial exits 0; final rerun recorded below |
| Web Vitest | initial 268 passed; reconstruction default test increases final count |
| Live Private-scene Playwright | exit 0, 1 test, before Owner publication |
| Live anonymous formal XR Playwright | pending final post-deploy checkpoint |
| Clean checkout release-source gate | pending committed-source checkpoint |

The initial Mypy cache classified local worker modules as untyped installed
packages; a non-incremental run then the exact standard command both passed.
No unrelated worker typing patch or relaxed Mypy settings was made.
Workers' optional integration skip reason and exact final clean-gate exits are
recorded after the last checkpoint, not concealed as a full hardware PASS.

## Software load versus PICO hardware

Formal browser gates target `/xr/diagnostics/u-a68b94d84538` and
`/xr/u-a68b94d84538` with an anonymous new context. Assertions require the DB
runtime 200, authorized real versioned payload requests, no 401/403 assets, loaded
state, WebGL2, positive frame Gaussian count and no local-manifest fallback.
These software gates do not claim immersive-vr hardware support in headless
Chromium. `/xr/test` is not a substitute for the formal uploaded scene.

After deployment, obtain the current URL with `./scripts/gsplatform-vr.sh urls`;
Quick Tunnel names can change. PICO Neo3 retest instructions:

1. Open the final HTTPS `/xr/u-a68b94d84538` address in the headset browser,
   without Owner login. If already logged in, use a fresh/private browser session.
2. Confirm the scene loads without “该场景不可见或未发布”.
3. Enter VR; check Gaussian visibility, head tracking, joystick movement and turn.
4. Report headset browser version, exact URL, any error and whether entry succeeds.

Not executed: PICO hardware, immersive guide-node teleport, new VR-03 UI/runtime,
13M Gaussian reconversion, collision generation or historical private publication.
No VR-03 implementation begins after these gates.

## VR-03 pre-audit result

See `docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md` for official fixed-pin
API/source evidence, capability matrix, current CRUD, text/pose/order/default gaps,
double-click/pick defects, readonly annotation mutation risk, desktop versus XR
UI boundaries, STALE handling, one recommended thin reuse design and future gates.
Pinned Viewer returns early from desktop camera updates while XR is active:
selectAnnotation cannot be asserted to teleport the active rig. Official Engine
XrNavigation is already installed, but tryTeleport is arc-hit/floor navigation,
not a public stored-pose teleport method.

Sources: live PostgreSQL/API/resource evidence saved outside Git, repository
tests and the official URLs in the linked research report. Bocha returned quota
403; direct official retrieval and Context7 Viewer docs succeeded.

## Final acceptance update

Pending: exact committed source, managed deployment/HTTPS, anonymous browser,
clean archive verification, final regression exits and normal push. No final PASS
is claimed in this interim document until those checkpoints are complete.
