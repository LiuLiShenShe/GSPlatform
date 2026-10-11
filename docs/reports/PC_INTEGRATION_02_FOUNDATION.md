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

Real agricultural fixture conversion (17,820 Gaussians; existing official subset)
produced counts 17,820 / 5,346 / 1,782, asset `41314bbc11fb`; actual NVIDIA RTX A6000
WebGPU observations recorded. Optional poster hit the existing 90s timeout, honestly
SKIPPED (publication remains valid). Real plain SOG → Streamed SOG → ZIP passthrough
round-trip passed (256/77/26). Existing 1M tree read-only validated:
1,006,948 / 302,084 / 100,695. No 13M source processing.

## 5. P2-C — collision admission and UI

NOT STARTED.

## 6. P2-D — regression and architecture acceptance

NOT STARTED.

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

## 8. NOT EXECUTED / limits

13M conversion, 13M collision retry, PICO Neo3 hardware, production deployment and
production migration are intentionally NOT EXECUTED. No assets copied into Git.

## 9. Git delivery and final gates

PENDING stage evidence. Do not infer PASS from planned work.
