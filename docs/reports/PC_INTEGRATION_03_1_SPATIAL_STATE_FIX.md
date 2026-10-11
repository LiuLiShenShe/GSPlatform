# PC-INTEGRATION-03.1 — Spatial State Invalidation & Provenance Consistency Fix

Date: 2026-10-11, Asia/Shanghai. Scope: Phase 3 spatial-state consistency only.
No Phase 4 development, production deployment, production database migration or
official PlayCanvas component modification is authorized or performed.

## 1. Git baseline and source authority

- Starting HEAD and starting `origin/main`:
  `fba83ee2473c691ddf32452c6389e5f50f8b78d9`.
- Branch: `main`. Initial worktree: clean. The four required initial Git commands
  were executed; a later `git fetch origin main` confirmed the same remote baseline.
- Tested implementation commit:
  `91d380d31518a69a841649d097c47c4ccecd673d`,
  `fix(editor): consistently invalidate spatial state after versioned edits`.
- Precommit source tree: `31f9c09d50c82f1471a617b1056ca36e8269ed13`.
  The code/test tree was archived and verified before the implementation commit.
- Final release HEAD is the checkout commit containing this report, resolved by
  `git rev-parse HEAD`; the final handoff and private `git-final-receipt.json`
  record its full SHA and equality with `origin/main`. A tracked report cannot
  embed its own commit SHA without changing that SHA. The fixed implementation
  SHA above identifies all executable changes; the following report commit is
  documentation-only.

All eight required baseline files were read in full, including the Phase 3 report,
spatial migration, edit-session model and runtime. Additional evidence includes
Scene/SceneVersion models, upload completion, Worker publication and test fixtures.
The supplied `/home/test/.codex/RTK.md` is absent. No CodeGraph/graphify index exists;
no index, branch or additional worktree was created.

Bocha retrieval returned HTTP 403 and is not used as evidence. Context7 resolved
`/websites/sqlalchemy_en_20` and fetched current primary documentation for Session
flush/rollback, `after_flush` and ORM refresh/identity-map behavior:

- https://docs.sqlalchemy.org/en/20/orm/events.html
- https://docs.sqlalchemy.org/en/20/tutorial/orm_data_manipulation.html
- https://docs.sqlalchemy.org/en/20/orm/session_basics.html

The repository and actual PostgreSQL/browser executions, not search snippets or
training-data assumptions, establish this report's application-specific claims.
Raw logs, receipts, test XML and temporary validation utilities are outside Git in
`/tmp/gsplatform-pc031-evidence`.

## 2. Defect and genuine RED chronology

Previously `_complete_edit_publication()` inserted STALE only when the scene had
no spatial row. An existing VALID, VERIFIED or STALE row was never updated. Thus
the first two states could expose old spatial settings after edited geometry;
an already-STALE row retained the wrong latest-event timestamp.

The existing-version branch also completed an edit unconditionally, including
same-current-content submissions. Naively adding an unconditional existing-row
update would create false invalidation events. Conversely, a completed edit
redelivery was rejected by source CAS or expiry before reaching version reuse.

Before the corresponding changes, actual PostgreSQL RED runs recorded:

1. `red-existing-valid.log`: 1 failure, exit 1, `VALID != STALE` after successful
   version publication. Only then was the existing-row update added; 1 GREEN.
2. `red-provenance.log`: 1 failure, exit 1,
   `KeyError: invalidatedFromVersionId`. The audit fields were added; 2 GREEN.
3. `red-completed-replay.log`: 3 failures, exit 1. Current/advanced replays raised
   `EDIT_BASE_VERSION_CHANGED`; expired replay raised `EDIT_SESSION_INVALID`.
   The completion-identity guard was added; all 3 GREEN.
4. `red-identical-content.log`: 4 failures, exit 1. Same-content submissions
   created a false STALE row, replaced VALID/VERIFIED or refreshed STALE time.
   Geometry-change detection was added; all 4 GREEN.

An additional negative-control run used a clean archive of the original HEAD,
with only the finished test file copied into it. Its publisher SHA256 matched
`git show fba83ee:apps/api/app/services/publish_service.py`:
`05a2e9f484df420f3693afa7de84502cb0fa9206c701d3456df89cd5d50322c0`.
It produced **17 failed / 20 passed**, exit 1. This later negative control is not
misrepresented as an additional pre-implementation RED run.

## 3. `source_version_id` data semantics

Evidence:

- `SceneSpatialState` is described as conservative validity for existing spatial
  authoring records; `source_version_id` is a non-null SceneVersion foreign key.
- Migration `cd03ef05ab06` explicitly preserves authoring while invalidating edited
  geometry bindings. It defines no "latest invalidated source" field or contract.
- The only production writer is `_complete_edit_publication()`: its old insert
  stores the edit's **pre-publication** source version, never the result version.
- `EditorSessionService.source_info()` reads the spatial state; Runtime gates on
  `state == STALE`. Neither caller redefines or overwrites its source version.
- `SceneEditSession` separately stores direct source and result version IDs and
  JSONB provenance, making each publication edge independently auditable.
- The Phase 3 report says bindings remain against their old source Version.

Therefore the spatial row's source is the geometry on which its retained binding
was established, not the most recent edit's direct source. A→B→C keeps binding
source **A**, while the second session records **B→C**. No conflicting caller or
data-contract evidence was found. No model/schema change or migration is needed.

## 4. Final invalidation contract and changes

Only these tracked files change:

- `apps/api/app/services/publish_service.py`: `commit_version()` at line 132,
  `check_edit_publication()` at line 226 and `_complete_edit_publication()` at 246.
- `apps/api/tests/test_editor_publication.py`: real PostgreSQL regression cases,
  controlled clock, complete historical snapshots and an isolated viewer bridge.
- `docs/reports/PC_INTEGRATION_03_1_SPATIAL_STATE_FIX.md`: this report.

For an authorized active edit, `version.id != edit.source_version_id` determines
an actual geometry transition after the locked CAS check:

- Missing spatial row: create STALE with the direct pre-edit source.
- Existing row: set STALE and update `stale_at`, preserving its original source.
- Every real transition, including STALE→STALE, gets the event's UTC timestamp.
- Completion and spatial invalidation use the same captured timestamp.
- Preserve existing provenance and `resultVersionId`; add camelCase
  `invalidatedFromVersionId`, `publishedVersionId` and `spatialInvalidationReason`.
- Actual transitions use reason `GAUSSIAN_GEOMETRY_CHANGED`, audit STALE and set
  collision policy MANUAL_ONLY without scheduling collision work.
- Same-current-version content reuse completes the new audit but does not create
  or change spatial state or collision policy. Its invalidation source/reason are
  null; `publishedVersionId` still identifies the reused result.

Reusing an older historical version when the current geometry differs is **not**
a no-op: C→B invalidates against C even if B's immutable row already exists.
This distinction is tested; an "existing row means no change" shortcut is unsafe.

For completed redelivery, ownership/deletion checks still run. `commit_version()`
requires the original completed result ID, matching content SHA and manifest, then
returns immediately: no new assets, current flip, bridge update, completion rewrite
or spatial event. It remains read-only after expiry and after another edit made C
current. Retargeting a completed session to another version/content is rejected.

## 5. Transactions, CAS and rollback

The unchanged Scene row `FOR UPDATE` and refreshed edit-row lock serialize current
publication. Active sessions must still match `Scene.current_version_id` to their
direct source; identical target content cannot bypass that CAS. Worker promotion
checks and execution fencing are unchanged.

SceneVersion/Assets, current pointer, completion/provenance, policy and spatial state
are all written in the caller's existing Session transaction. No new commit,
separate transaction, async invalidation task or post-success spatial write exists.

Two real PostgreSQL connections test E1 and E2 based on A. E2 blocks on the Scene
lock; E1 publishes B at controlled 12:00 UTC. The clock advances to 13:00 before
E1 releases the lock. E2 then raises `EDIT_BASE_VERSION_CHANGED`, for both distinct
and identical content. Current remains B, latest stale time remains 12:00, and
E1 provenance is unchanged; E2 remains uncompleted with its original provenance.

Six rollback combinations use absent/VALID/STALE initial state and failures after
the spatial SQL flush or before final commit. A second connection cannot see the
uncommitted version, completion or spatial update. Rollback restores current A,
PUBLISHING edit, null completion/result, original provenance/policy/spatial state,
one version and all historical rows/bytes. The filesystem bridge is an existing
non-transactional behavior; these tests isolate it in temporary storage and do not
introduce any new filesystem guarantees or change user assets.

## 6. Test matrix: RED versus GREEN

Final focused run: **49 passed**, zero skips, exit 0: 37 publication cases plus
12 existing owner/session ACL cases. No skip/xfail or unconditional assertion was
added. All new state/time checks run against PostgreSQL, not SQLite or a fake DB.

| Contract | Original implementation / negative control | Final result |
| --- | --- | --- |
| T01: missing record | Creation worked, new provenance assertion genuinely failed | New STALE/source A; exact clock/completion time and audit verified |
| T02: VALID/VERIFIED record | Remained VALID/VERIFIED; both fail | Both become STALE; old Runtime settings withheld, history retained |
| T03: A→B→C | VALID path fails state; STALE path fails latest time | Both sessions complete; current C; source A; audits A→B and B→C |
| T04: Runtime at C | Existing standalone STALE projection already passed; publication-to-projection chain failed upstream | Camera/Transform empty, viewpoints/annotations empty, collision disabled/no URL |
| T05: completed replay | Current/advanced CAS errors and expiry error | 3 read-only replay cases; no timestamp, provenance, current or collision changes |
| T06: concurrent CAS | CAS rejection already worked, but E1 spatial-result assertion failed | 2 two-connection cases; E2 cannot refresh time or overwrite E1 audit |
| T07: rollback | 4 combinations already passed; existing-row spatial hooks were never reached in 2 cases | All 6 failure/rollback combinations pass, including actual spatial SQL |
| T08: already STALE | Latest-event timestamp not updated | Real second edit refreshes time, keeps A and never restores collision |
| T09: ordinary publication | 3 cases already passed | All 3 still pass; no edit/spatial/policy mutation; full ordinary worker paths also pass |
| T10: permissions | Existing owner/anonymous/share/other boundaries already passed | 3 new spatial-flow denial cases and existing ACL suite pass |
| Same-content new session | 4 false state/timestamp events | Absent/VALID/VERIFIED/STALE unchanged; no new immutable version |
| Historical version reuse | Old spatial record never updated | C→B is audited and invalidated without a fourth immutable row |
| Completed retarget | Conflict already prevented writes | 3 conflict cases preserve pointer, time, versions and original audit |

## 7. Actual controlled A→B→C records

One final focused PostgreSQL run (`spatial-green.log`, VALID initial binding):

| Role | UUID / timestamp |
| --- | --- |
| Scene | `c7546380-b35f-4253-9686-e6951b6c0092` |
| A: original source/binding | `0ac9f3a7-550a-4607-9f8c-163834553ad8` |
| B: first edited version | `96a9b3dc-9379-445a-9b31-d5b4e3e2aeeb` |
| C: current second edited version | `03a36e5d-0aab-4e42-9ffa-4338bcefe29c` |
| First event | `2026-10-11T12:00:00+00:00` |
| Latest event | `2026-10-11T13:00:00+00:00` |
| Spatial source after both edits | A, not B |

The separate initially-STALE chain also passes. Test time is explicitly controlled;
no short sleep is used to establish event ordering. Historical comparisons include
every mapped presentation/viewpoint/annotation/collision column, source-version and
source-asset rows, source file SHA256 and collision bytes, including A and B history.

## 8. Real browser, API, Worker and version records

Existing `apps/web/e2e/pc-integration03-editor.spec.ts` was executed three times with
`PC03_E2E=1`: **3 passed, zero skips**, each exit 0. These are actual cookie-auth
UI uploads, real isolated Redis/Celery, pinned official CLI and official Viewer
WebGPU loads, not a mocked editor/publisher or manifest fallback.

The small genuine Phase 3 exports were reused; official Editor source was not
rebuilt and selection/export GUI was not re-executed. Public guitar source is
1,479,876 bytes; genuine edited PLY is 5,070,209 bytes; genuine edited SOG is
375,061 bytes. No large user PLY was converted.

Scene: `ed1273bb-b77b-4ec8-9d63-2d9146d992b7` / `pc031-spatial-e2e`.

| Version | Immutable asset | Actual count |
| --- | --- | ---: |
| A `51f5fcee-5fd1-4506-a3ed-2b24d108d79b` | `pc031guitar001` | 90,854 |
| B `21f65043-df0e-4816-a3b7-5fb8edaed8d6` | `d07919b7a014` | 90,533 |
| C `22a90bb8-dbe5-48eb-b33a-eb556c7aaccc` | `b4fcca41779f` | 27,076 |

The second edit explicitly selected LOD1, with source counts `[90533,27160,9053]`.
Third session `f5685ba1-b94a-4985-9f86-a389ad67e850` selected LOD0 and resubmitted
the same genuine SOG: result/current remain C, exactly three versions exist.
The binding source remains A. First stale time is
`2026-10-11T12:25:21.261434+00:00`; latest is
`2026-10-11T12:30:41.655469+00:00`, unchanged by the third session.
New-session completion has null invalidation source/reason, preserving the first
two audits. Existing spatial records/bytes remain intact and collision jobs stay 0.

A completed first Job was also really redelivered through the isolated broker.
Worker returned `{"ok":true,"duplicate":true,"version":"existing"}`; current C,
three versions, stale time, first provenance and zero collision jobs remained
unchanged. Repeating that completed session's HTTP completion returned 200 with
the original Job ID. Receipts: `e2e-final.json` and `e2e-redelivery.json`.

Viewer refresh and actual content URLs are checked by the existing E2E; anonymous
content requests return 401, `isManifestFallback=false`, walk remains false,
world transform is identity and stale collision is unavailable. Screenshots are
raw evidence only; no new image-recognition or visual-human-inspection claim is made.

## 9. Runtime safety and historical data

`scene_runtime.py` is unchanged because its STALE projection is already correct:
reset initial camera/FOV and world transform, omit viewpoints/annotations, disable
collision and remove its URL. Tests seed real nonempty authored data and verify
all of these projections while preserving database columns and file bytes.

No automatic STALE→VALID/VERIFIED transition, coordinate migration, camera/annotation
deletion, collision deletion/rebuild or physical-scale verification is introduced.
Existing unverified calibration never becomes a permission for physical walking.
The existing collision generation, policies for ordinary uploads and Worker fencing
continue to be exercised by the full worker/backend suites.

## 10. PostgreSQL isolation

Dedicated task-owned PostgreSQL **16.13** container `gsplatform-pc031-postgres`,
loopback port 16433. Separate fresh databases cover API, workers, original-code
negative control, precommit clean source, committed clean source and browser E2E.
All are migrated to the existing single head `cd03ef05ab06` only.

The browser uses a dedicated task-owned Redis container, loopback port 16384,
separate storage/origin and owned API/Worker/Vite processes. Test viewer bridging
uses temporary paths. No running production service or user version is repointed.

## 11. Full backend, Workers and Web gates

| Gate | Actual result |
| --- | --- |
| Backend `ruff check .` | PASS / exit 0 |
| Backend `mypy app` | PASS, 94 source files / exit 0 |
| Complete backend `pytest tests -vv -ra` | **507 passed**, zero skips, 19 upstream warnings, 489.54s / exit 0 |
| Complete `pytest workers/tests -vv -ra` | **125 passed**, zero skips, 66.89s / exit 0 |
| Web Typecheck | PASS / exit 0 |
| Web Lint | PASS / exit 0 |
| Web Vitest | **267 passed** in 28 files / exit 0 |
| Web Build | PASS / exit 0; existing chunk-size warning, not an error |
| Applicable real browser editor-publication/Viewer E2E | **3 passed**, zero skips / all exit 0 |

The entire Playwright suite was not executed; only the applicable PC03 real
publication/Viewer test was run in three scenarios. Optional poster rendering
was SKIPPED: pinned CLI reports `writeImage requires a createDevice function for
GPU rasterization`. Gaussian conversion, artifact verification and publication
passed; the poster skip is not relabeled as a poster PASS.

## 12. Clean-checkout reproducibility

Before commit: `./deploy/scripts/verify_release_source.sh --from-commit <source-tree> --keep`,
archive `/tmp/gsplatform-verify-OlMp7c`, **exit 0**. It contains the actual patch,
not merely the original HEAD. Source integrity, fresh dependencies/imports, Ruff
and Mypy pass. Backend: **499 passed / 8 skipped**; Workers: **106 passed / 19 skipped**.
These skips are not counted as passes. Optional archive-only prerequisites are
separately covered by the full local 507/125 zero-skip suites.

The fresh reconstruction environment passes exact torch/gsplat versions, trainer
entry, A6000 CUDA availability and actual gsplat rasterization: 74 lit pixels,
8 splats. No Gaussian training or production reconstruction was performed.

The requested no-argument `./deploy/scripts/verify_release_source.sh` also completed
against implementation HEAD `91d380d31518a69a841649d097c47c4ccecd673d`, with a separate
fresh PostgreSQL database and `PYTEST_ADDOPTS=-ra` for exact skip reasons:
**exit 0**, backend **499 passed / 8 skipped**, workers **106 passed / 19 skipped**.
Its default temporary archive `/tmp/gsplatform-verify-rYuz90` was removed by the
existing script, not by user-asset cleanup. `clean-head.log`, `clean-head-exit.txt`
and `clean-head-receipt.json` retain the executed command, commit, results and
per-test skip reasons. Fresh reconstruction verification passes all five checks,
including A6000 CUDA and actual rasterization: **43 lit pixels / 8 splats**.

Exact archive-only skip categories:

- Backend: 3 Git-worktree checks (`test_fix06`), 1 API-venv torch/gsplat check
  (`test_fix061`, separately verified by the reconstruction gate), and 4 release
  fixture checks requiring generated `apps/web/dist` (`test_fix0621`).
- Workers: pinned SplatTransform/node_modules absent from the source-only archive,
  and Git-history-dependent checks absent from `git archive`. The raw receipt
  lists all 19 skipped cases and their individual reasons.

These 27 archive skips are **not PASS**. All corresponding local backend/worker
tests ran in the complete 507/125 suites with zero skips. Web Typecheck/Lint/
Vitest/Build and actual official-CLI browser publication also ran separately.
The clean script itself passes; no skipped CLI capability is claimed verified
inside the source-only archive.

## 13. Protected historical SceneVersion: read-only verification

`u-06924576399e` still points to
`01c63c7c-8eb5-498e-bcc0-77215e92ca12` / `da7bf4207044`, 13,090,324 points.
Only explicit PostgreSQL `default_transaction_read_only=on` connections read it.
Before/after snapshots of Scene, all versions/assets and existing spatial tables
are identical. All **2,076** historical file sizes/mtime entries are identical;
the four version metadata SHA256/size/mtime values also match the Phase 3 receipt.

The new production spatial/edit tables are not deployed. An initial read utility
detected their absence; it was restricted to existing-table snapshots and the
unchanged read-only content projection/authorized path resolver, without migration.
Another utility invocation inherited isolated storage configuration; it was rerun
with explicit historical DB/storage roots and passed. Neither attempted writes.
Full new Runtime on the old production schema was **not run** or claimed compatible
before deployment of the already-required Phase 3 tables. New full Runtime behavior
is tested on migrated isolated PostgreSQL instead.

Immutable Viewer content format remains `lod-meta` with its existing version URL;
manifest/lod metadata/build info/checksums resolve read-only. Receipts are
`historical-before.json` / `historical-after.json`. No 13M browser stress test,
large conversion, user collision restart, deletion or current-pointer write occurs.

## 14. Scope exclusions

Unchanged: official SuperSplat Editor and its upstream/build identity, official
Viewer, Engine, SplatTransform, Gaussian/LOD algorithms, WebXR/PICO, collision
generation/Worker fencing, upload protocol, SceneVersion hash/recipe, agricultural
models, migrations, dependency locks and all Web/Worker source. No async spatial
task, new spatial-system architecture or Phase 4 implementation is added.

## 15. Limitations and deployment boundary

- No trustworthy metric calibration or automatic spatial revalidation is supplied;
  existing authoring needs explicit future revalidation, never guessed migration.
- No production deployment, production DB write or schema upgrade is performed.
  Production still needs the reviewed Phase 3 deployment/migration prerequisites.
- Old completed audits are not backfilled with the new fields, and old stale
  timestamps are not retroactively rewritten; genuine future changes update them.
- No new Editor GUI export acceptance, large-scene memory stress test or PICO
  hardware run is performed. Existing genuine small exports supply this regression.
- Poster rendering and archive-only prerequisite skips remain explicitly SKIPPED;
  all core publication/spatial tests and required local regressions pass.
- The existing filesystem bridge is not made transactional by this DB-only fix.

## 16. Final HEAD and disposition

Implementation HEAD: `91d380d31518a69a841649d097c47c4ccecd673d`.
Final release HEAD: the report-containing `main` commit, concretely recorded in
the final response and `/tmp/gsplatform-pc031-evidence/git-final-receipt.json`.
The last source change is the implementation commit; the later report commit adds
no executable changes. The final Git receipt/handoff record the normal push,
concrete release SHA, `HEAD == origin/main`, two commits and clean worktree.
No reset, force push, production restart or user-asset cleanup is used.

Technical disposition: **PC-INTEGRATION-03.1: PASS**. Both clean-source executions,
core PostgreSQL cases, complete required local regressions and applicable real
browser scenarios passed. Final delivery is gated on normal push and the Git
receipt; the final response gives its actual result, not an assumed push outcome.

SPATIAL STATE INVALIDATION CONSISTENT

EDIT VERSION PROVENANCE VERIFIED

HISTORICAL SPATIAL DATA PRESERVED

READY FOR PHASE 4 AFTER USER REVIEW

No Phase 4 development or automatic production deployment is performed. The owned
test API/Worker/Vite processes are stopped; isolated databases/storage and raw
receipts are retained for review. Production services and assets remain untouched.
