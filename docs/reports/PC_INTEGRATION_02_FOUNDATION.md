# PC-INTEGRATION-02 — PlayCanvas-First 3DGS Foundation Consolidation

Date: 2026-10-11 (Asia/Shanghai). Starting HEAD: `ea3b800bfa1ef52a72977efc39d4c2ba711c56e0`.
Initial `main` worktree clean; `HEAD == origin/main`. Phase 2 only is authorized.

## Execution plan and stage gates

1. P2-A: independent constrained processing settings, scale assumptions, ACL/CSRF,
   upload declaration and additive migration. PostgreSQL compatibility/negative tests before P2-B.
2. P2-B: extract finite policy and pinned CLI process adapter; share artifact checks,
   preserve recipe v2 and facade. Real small official CLI and recovery tests before P2-C.
3. P2-C: centralized new-work admission, preserve existing job recovery/fencing,
   explicit manual test assumptions, server-authoritative upload and authoring UI status.
   PostgreSQL concurrency and frontend targeted tests before P2-D.
4. P2-D: isolated end-to-end upload/publication/manual collision; read-only historical
   integrity; complete backend/worker/web/Playwright/clean-archive gates; normal commits/push.

Risks: native 3.3.3 exit hangs; unsafe default test database; legacy jobs; scale is
not meters; recipe drift. Mitigations: owned process groups/finite timeout, dedicated
new PostgreSQL database and `/tmp` storage, no production job changes, fail-closed
calibration, unchanged canonical recipe identity. Each stage has a separate commit.

## 1. Environment and live-task safety

Live API/Celery/PostgreSQL/Redis processes were inspected read-only. Production DB
had historical QUEUED/RUNNING jobs (including 76 RUNNING collision rows); none were
cancelled, retried, dispatched or reset. No worker was restarted. All writing tests
use a newly created `gsplatform_pc02_*` PostgreSQL database and isolated storage.
The supplied `/home/test/.codex/RTK.md` does not exist. No CodeGraph/graphify index
exists; no index was created. Phase 1 integration/roadmap and FIX-CONVERT-01 report read.

## 2. Official references and pinned execution basis

Bocha search HTTP 403 (unavailable), explicitly recorded. Context7 library/docs
resolved official SplatTransform and Viewer; direct official pages were fetched.
No API credentials are stored in this report or Git. Source references:

- https://github.com/playcanvas/splat-transform
- https://developer.playcanvas.com/user-manual/splat-transform/cli-reference/
- https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/
- https://developer.playcanvas.com/user-manual/splat-transform/collision/
- https://github.com/playcanvas/supersplat-viewer
- https://developer.playcanvas.com/user-manual/supersplat/viewer/embedding/
- https://developer.playcanvas.com/user-manual/supersplat/studio/experience-settings/

Installed CLI `--version` and `--help`: `3.3.3 (d092ae9)`; only chunk count/extent,
never `--lod-chunk-min`. Viewer 1.35.0 / production Engine 2.22.4 remain pinned.

## 3. P2-A — processing policy

PASS. Independent one-to-one `SceneProcessingSettings`; no reuse or expansion
of `Scene.category`. Legacy defaults resolved without writing: UNSPECIFIED/balanced/
MANUAL_ONLY/UNVERIFIED. Upload declarations store scene type/profile until the existing
completion transaction creates a Scene; no premature scene ID or state-machine change.

Scale assumptions bind server-side to the current asset version and transform identity;
source/transform changes make the effective state UNVERIFIED. World scale alone never
proves meters. Public PATCH accepts only UNVERIFIED/ASSUMED and rejects VERIFIED or
injected internal fields. VERIFIED is reserved for trusted measured evidence with
reference, positive finite scale/value, version/transform and provenance/hash/verifier;
no Phase 4 verification workflow is implemented. No automatic reconversion on edits.

Migration `ab02cd03ef04` tested on isolated real PostgreSQL: empty database upgraded
through all existing revisions; previous head upgraded with existing fixture rows;
downgrade/re-upgrade and `current == head` succeeded. Exact old Scene/SceneVersion/
Asset/CollisionAsset/Job row snapshots were unchanged. Production migration NOT RUN.
Backend ruff and mypy (88 files) PASS. Targeted settings/upload/ACL tests PASS
(69 tests, 27.01s, including the additional session-CSRF test).
Directly dependent files outside the suggested list: upload repository transports
finite declared fields; v1 router registers the authorized processing routes.

## 4. P2-B — conversion seams

PASS (targeted gate). `conversion_policy.py` contains the exact old recipe-v2
functions and fixed 64K/32, 512K/32, 64K/16 profiles; `convert_scene.py` re-exports
its historical facade/identifiers. Same source/recipe identity is compared directly
against starting-HEAD code for all profiles and CPU/GPU selections. The publish
task now consumes the scene's finite conversion profile, defaulting to balanced.

`splat_transform_adapter.py` validates real `--version`, owns argv/cwd/env/process
group/timeouts, caps disk logs at 16 MiB and in-memory tails at 64 KiB, and preserves
nonzero exits. Default conversion/Celery limits are unchanged. A small Node preload
records actual device-request observations and adapter identity, not configured GPU
intent; unknown is retained when telemetry is unavailable. It never changes official
CLI algorithms/source. On Node versions with `process.execve`, an explicit upstream
`process.exit(code)` hands its exact code to a clean Node process, avoiding native
teardown deadlocks. It does NOT infer success from logs/output or kill unfinished
work as success. Older Node versions retain normal finite timeout failure semantics.
Official Node reference: https://nodejs.org/docs/latest-v24.x/api/process.html .

`artifact_validator.py` is the single implementation behind `verify_publish.py`;
checksums, path containment, counts/order, chunk payloads/tree references, BuildInfo,
source and recipe/actual-command consistency remain checked. Real streamed ZIP/SOG
passthrough validates without CLI. Incomplete empty test containers were corrected,
not safety checks weakened. Validated decimation reuse/flock/staging/promote/fencing
remain in the compatibility facade/task/service; no publication state-machine rewrite.

Evidence: first run 59 PASS / 2 native-exit timeout FAIL (275.55s); subsequent runs
recorded 69 PASS / 1 incomplete mock artifact FAIL and 69 PASS / 3 native timeout FAIL.
Module-completion launcher also failed one native timeout and was removed. Exact-code
exit adapter gate: **73 PASS / 0 SKIP / 0 FAIL, 53.65s**, actual official CLI installed.
Adapter-focused tests: 9 PASS; verifier/source suite: 28 PASS. Additional tree checks
then passed 7 targeted tests and read-only small/1M artifact validation.
Final repeated conversion gate after tree checks: 73 PASS, 54.01s.

Real agricultural fixture conversion (17,820 Gaussians; existing official subset)
produced counts 17,820 / 5,346 / 1,782, asset `41314bbc11fb`; actual NVIDIA RTX A6000
WebGPU observations recorded. Optional poster hit the existing 90s timeout, honestly
SKIPPED (publication remains valid). Real plain SOG → Streamed SOG → ZIP passthrough
round-trip passed (256/77/26). Existing 1M tree read-only validated:
1,006,948 / 302,084 / 100,695. No 13M source processing.

## 5. P2-C — collision admission and UI

PASS (targeted gate). One `resolve_collision_decision` governs new publish,
duplicate delivery, periodic reconciliation and manual build/rebuild admission.
All four scene types default MANUAL_ONLY. AUTO requires current measured calibration,
identity transform / normalized meter units, explicit policy and approved count/source-
byte budget. UNVERIFIED, ASSUMED, stale, unknown/oversize cost never auto-admit.
Stable reason codes are policy results, not fabricated Celery/Job states.

No trusted measurement workflow exists in Phase 2: public PATCH cannot record VERIFIED.
No fake VERIFIED fixtures were inserted. Real positive calibrated automatic admission
is deferred to a provenance-verifying calibration workflow; Phase 2 is deliberately
fail-closed. Nonidentity transforms/nonunit verified scales also fail closed because
the existing collision generator does not normalize them; no algorithm was added.
Default operator limits are 1M Gaussians / 256 MiB source, configurable only server-side
by `GS_COLLISION_MAX_GAUSSIANS` / `GS_COLLISION_MAX_SOURCE_BYTES`. These are conservative
admission bounds, not assertions of peak memory or execution time.

Manual requests require current publication, ACL/CSRF, mode and budget; unverified
scale additionally needs a strict explicit nonphysical acknowledgement. Admission
metadata survives atomic worker finalization; runtime never enables physical Walk
from such a result. Existing collision URLs/assets and persisted collision_enabled
are retained; effective physical Walk is disabled without valid calibration.
Already admitted current-version jobs keep lease/claim recovery independently of
new-work policy. An orphan row or old-version job cannot bypass MANUAL_ONLY to create
a new job. Version-safe asset serving and all fencing generations remain unchanged.

Upload status exposes `collisionRequired` and `collisionPolicyReason`; only actual
current-version bound jobs provide collision status/ID. Completed publication with
collision not required stops polling and displays “碰撞未启用，可按需生成”. Required
work continues to terminal state; failures remain independent from publication.
5-minute observation cap, backoff, stale-response guard, re-query and cleanup remain.
CollisionPanel shows server policy/type/scale, permission-gated manual controls and
explicit nonphysical acknowledgement, not a new editor/calibration UI.

Targeted PostgreSQL reliability gate: **178 PASS, 250.85s**; final policy/security/
worker supplement **55 PASS, 55.00s**. Focused Web **34 PASS, 9.08s**, typecheck/lint,
backend ruff and correctly scoped mypy (89 files) PASS. Earlier runs found 2 policy
interaction failures (missing-job and stale claim), corrected by distinguishing
current existing work from new admission; original recovery assertions retained.
A concurrent test run exposed global test-admission cross-talk, corrected by
restricting the legacy nonphysical admission fixture to its own unconfigured scenes;
database gates are serial thereafter. Security injection tests now require 422,
not silently ignored internal fields, and retain version-pinning verification.
Legacy claim/concurrency suites explicitly admit nonphysical work in their scoped
fixture, preserving their reliability assertions without pretending to have VERIFIED
scale. Running mypy from repository root produced 2 unrelated unused-ignore errors;
the required `apps/api` invocation succeeds unchanged.

Real 17,820-Gaussian official collision CLI generated voxel JSON/bin and GLB:
29,724 nodes, 22,698 leaves, no warnings. Observed voxel backend: WebGPU / NVIDIA RTX
A6000; observed GLB backend: CPU (not inferred from `-g 0`). Both CLI exits 0.
`workers/collision/splat.py` uses the same pinned bounded process adapter for device
enumeration and execution; its official voxel/floor-fill/mesh parameters and 600s
timeout are unchanged. This direct dependency is within collision safety scope.

## 6. P2-D — regression and architecture acceptance

IN PROGRESS: clean-checkout and fresh serial full backend gate still pending.

### Real isolated end-to-end acceptance

Dedicated PostgreSQL `gsplatform_pc02_e2e_*`, dedicated Redis container on loopback
16382, temporary API 18022/Vite 15173 and Celery solo worker `pc02-isolated` were used.
No production worker/broker was restarted or given test messages. Real session
authentication/CSRF, HTTP chunk upload, Celery conversion/publication and official
Viewer run without mocks. Private environment/token files remain outside Git.

Opt-in `pc-integration02-foundation.spec.ts`: **3 PASS, 2.3 minutes**. Real small PLY
published as `41314bbc11fb`, PUBLISHED/SUCCEEDED with exactly one publish job and no
collision job; server-authoritative not-required UI stops requests and offers Viewer.
Desktop diagnostics: official runtime, WebGPU, loaded=true, progress=100, gsplats=1782
(selected streamed LOD), no manifest fallback/errors. XR software route: official
runtime, WebGL2, loaded=true, progress=100; immersive VR unavailable in headless
browser, so no hardware/immersive-session PASS claim. No physical Walk allowed.

Separate acknowledged nonphysical small Streamed ZIP published as `dc8398d56196`;
manual build without acknowledgement rejected 409. Approved build AND rebuild use
real official CLI, succeed with distinct fenced job IDs, and serve current-version
voxel JSON/bin and GLB (glTF magic) through owner authorization; anonymous asset
access rejected 401. Descriptor carries current voxel URL, stale=false, enabled=false;
Viewer still loads and Walk remains disabled. Admission `physicalScaleVerified=false`
persists after finalization. ZIP passthrough does not run decimation/stack.

Initial browser attempts exposed test assumptions, not application defects: ambiguous
category selector; too-short wait for optional poster timeout; absent collision is
null in the existing descriptor; official renderer reports webgl2; collision build
response uses historical `job_id`; login must await committed identity before the next
request. All corrected against actual contracts; no security assertion was weakened.
Manual-focused final sequence passed independently (16.4s) before full 3-test PASS.

### Software gates and migration

Workers full gate: **106 PASS, 80.95s**, including real PLY/SPLAT/SOG/ZIP and exact
upstream nonzero-exit tests. Prior full workers run: 104 PASS, 84.70s, before adding
two exit-code tests. Web: typecheck/lint PASS; **261 PASS / 27 files, 10.09s**;
production build PASS (8.74s), existing large-bundle warning retained.
Backend ruff (including migrations) / mypy (89 files) PASS. First full backend found
worker import path and release fixture hard-coding the production database (still
at old migration head); fixtures now use explicit isolated GS_TEST_DATABASE_URL and
correct worker path. A subsequent overlapping test run deleted its sibling run's
UploadSession, yielding 457 PASS/1 test-fixture FAIL; stopped only the overlapping
private pytest and created a fresh independent database for final serial acceptance.
No application state machine was relaxed to hide these failures.

Fresh isolated E2E/final/worker PostgreSQL databases upgraded all existing migrations
to `ab02cd03ef04`; `alembic current == heads`. Existing-data upgrade/downgrade snapshot
compatibility was already verified in P2-A. Production remains unmigrated/undeployed.

### Ownership and scope audit

Official SuperSplat Viewer/createViewer, PlayCanvas rendering/LOD/Walk/WebXR/settings
and official SplatTransform decimation/chunk/encoding/voxel/mesh remain the sole
production Gaussian paths. GSPlatform retains users/ACL/CSRF, uploads, finite policies,
immutable SceneVersion/provenance/assets, validated publication, jobs/recovery/leases/
claims/fencing and its platform business. No package manifest or lockfile changes.
No `apps/viewer` activation/deletion, renderer copy, Gaussian algorithm, XR runtime,
Editor integration, reconstruction dependency or agriculture phenotype schema change.
Remaining `workers/collision/indoor.py` / `outdoor.py` are untouched future candidates;
existing reconstruction COLMAP/gsplat is outside Phase 2 conversion scope.
Direct test dependencies outside suggested files: release preflight fixture consumes
the migration head on the correct test DB; opt-in browser acceptance verifies the
real existing official Viewer paths; build_collision preserves admission metadata.

Deferred: measured-calibration ingestion and meter/transform normalization (Phase 4),
resource-cost benchmarking beyond conservative admission bounds, optional poster
headless rendering issue, removal of unused legacy implementations after independent
consumer review. No new agricultural measurement system or Gaussian algorithm added.

## 7. Historical compatibility baseline

Read-only 13M Scene `u-06924576399e`: category `architecture`, PUBLISHED,
current SceneVersion `01c63c7c-8eb5-498e-bcc0-77215e92ca12`, asset `da7bf4207044`.
Initial metadata SHA256:

| File | SHA256 |
|---|---|
| manifest.json | 523ee0a915e3d7d861cf03446064e1daf0099777e99ecb86702779f1c24df857 |
| build-info.json | b6b5f31aa3ca37f8beaa81ad9bf351edca00661afcb332e95452a9745cc8cec2 |
| lod-meta.json | df735f57c853a77c5b5a758a6c19c5b7e76654581e9f8aba13521f7088fa75ab |
| checksums.sha256 | 8f5c92b1f2617657c0a149bb30f1e30c8084b4f645ad6005e1a7e227f379a1f4 |

Read-only full artifact verification passed 13,090,324 / 3,927,097 / 1,309,032 LODs
and all recorded checksum payloads. After implementation, exact Scene/SceneVersion
database fields (including manifest) and all four file hashes/sizes/mtime_ns remain
identical. Existing production API runtime and authorized immutable manifest GET
both return HTTP 200; response manifest SHA256 equals the original above. No source
file conversion, collision retry, current pointer change, session reset or asset copy
to Git occurred. Existing collision success/old-job and private serving semantics are
covered by PostgreSQL regression, independent of this scene's historical timeout.

## 8. NOT EXECUTED / limits

13M conversion, 13M collision retry, PICO Neo3 hardware, production deployment and
production migration are intentionally NOT EXECUTED. No assets copied into Git.

## 9. Git delivery and final gates

PENDING stage evidence. Do not infer PASS from planned work.
