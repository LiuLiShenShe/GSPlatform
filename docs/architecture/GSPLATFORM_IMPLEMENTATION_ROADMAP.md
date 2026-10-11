# GSPlatform PlayCanvas-First Implementation Roadmap

**Roadmap:** PC-INTEGRATION-01
**Date:** 2026-10-11
**Authority:** Companion execution plan for `docs/architecture/GSPLATFORM_PLAYCANVAS_INTEGRATION.md`
**Current state:** Phase 1 documentation complete; Phases 2–5 are not started.
**Repository baseline:** `b14d1ab8e2747197749af82b676e12bd69ce0d38`

## How to Use This Roadmap

This document is the implementation contract after Phase 1 review. It is intentionally concrete enough to turn into unambiguous work prompts, but it does not authorize implementation by itself. A later phase must be explicitly approved before its files are changed.

The roadmap follows four rules:

1. Use PlayCanvas OSS for generic 3DGS algorithms and runtime behavior.
2. Keep GSPlatform’s storage, identity, authorization, versioning, jobs, recovery, and agriculture domain independent.
3. Introduce new immutable artifacts and compatibility gates instead of rewriting user assets in place.
4. Keep software acceptance, performance acceptance, and PICO hardware acceptance as separate claims.

## Phase Dependency Graph

```text
Phase 1: Audit and boundary definition (complete)
    |
    +--> Phase 2: 3DGS foundation closure
              |
              +--> Phase 3: Standalone official Editor integration
              |
              +--> Phase 4: Agriculture domain and spatial bindings
              |
              +--> Phase 5: Desktop / WebXR / PICO acceptance
```

Phase 3 may begin after Phase 2’s asset/version contract is stable. Phase 4 may begin with the existing Viewer, but must use the descriptor and SceneVersion boundaries stabilized in Phase 2. Phase 5 may run software checks in parallel with late Phase 4 work, but PICO hardware acceptance must use a frozen candidate build and real agricultural assets.

## Global Invariants

Every phase must preserve these invariants:

- `SceneVersion` is immutable and content-addressed.
- The `current` scene pointer changes only through the existing publication transaction.
- Published asset URLs remain authorized and version-aware.
- A failed conversion or collision build never corrupts a previously published version.
- A late Celery callback cannot finalize an obsolete job generation or newer scene version.
- `collision_enabled`, `sourceVersion`, and `worldTransformHash` remain meaningful and backward compatible.
- Existing `PLY`, `SPLAT`, `SOG`, Streamed SOG, and supported ZIP assets remain viewable.
- The official Viewer remains the only production renderer and XR runtime.
- Agriculture data is stored in platform APIs/database tables, not in Gaussian binary or Viewer settings fields.
- No hosted Studio, Manage, or Publish API becomes a required dependency for self-hosted deployment.

## Phase 1 — Architecture Audit and Integration Plan

### Goal

Define the PlayCanvas-first boundary, document evidence, and produce an executable plan without modifying runtime behavior.

### Scope

- Verify Git/worktree baseline.
- Read current frontend, API, models, workers, tests, and large-scene report.
- Read official Viewer, Editor, SplatTransform, Engine, Viewer embedding, Experience Settings, Streamed SOG, collision, Studio, Manage, and API integration material.
- Distinguish open-source self-hosted components from hosted `superspl.at` services.
- Record locked project versions and upstream reference commits without upgrading.
- Produce the architecture document and this roadmap.

### Files

**Created in Phase 1:**

- `docs/architecture/GSPLATFORM_PLAYCANVAS_INTEGRATION.md`
- `docs/architecture/GSPLATFORM_IMPLEMENTATION_ROADMAP.md`

**Read but not modified:**

- `apps/web/src/scene-runtime/`
- `apps/web/src/features/authoring/`
- `apps/web/src/features/viewer-official/`
- `apps/web/src/pages/SceneViewerPage.tsx`
- `apps/web/src/pages/SceneAuthoringPage.tsx`
- `apps/web/src/pages/XRViewerPage.tsx`
- `apps/web/src/pages/UploadPage.tsx`
- `apps/web/src/pages/MyWorksPage.tsx`
- `apps/api/app/services/scene_runtime.py`
- `apps/api/app/services/publish_service.py`
- `apps/api/app/services/upload_service.py`
- `apps/api/app/services/collision.py`
- `apps/api/app/services/scene_access.py`
- `apps/api/app/db/models/scene.py`
- `apps/api/app/db/models/job.py`
- `apps/api/app/db/models/scene_presentation.py`
- `apps/api/app/db/models/asset.py`
- `apps/api/app/db/models/collision_asset.py`
- `workers/pipeline/convert_scene.py`
- `workers/pipeline/validate_scene.py`
- `workers/pipeline/verify_publish.py`
- `workers/collision/splat.py`
- `workers/tasks/publish_scene.py`
- `workers/tasks/build_collision.py`
- `workers/reconstruction/`
- `apps/viewer/UPSTREAM.md`
- `docs/reports/FIX_CONVERT_01_LARGE_SCENE_SOG.md`
- `docs/reports/SSV_FINAL_ACCEPTANCE.md`

### Dependencies

- Access to the current repository checkout.
- Official PlayCanvas documentation and repositories.
- No running service or user data access is required.

### Tasks

- Record the initial worktree and current HEAD.
- Confirm the current Viewer and SplatTransform lockfile versions.
- Trace the production Viewer call graph from pages to `createViewer`.
- Trace the upload → validation → conversion → verification → publication → collision flow.
- Confirm the large-scene report’s SOG success, collision timeout, scale warning, and absent PICO run.
- Classify current modules as `KEEP`, `DELEGATE`, `THIN_ADAPTER`, `SIMPLIFY`, `FREEZE`, `REMOVE_LATER`, or `BUILD_AGRICULTURE`.
- Document exactly one Editor integration recommendation.
- Define Phase 2–5 file-level tasks and regression gates.

### Acceptance Criteria

- The two architecture Markdown files exist.
- The main document names the current HEAD and locked package versions.
- Official OSS/hosted boundaries are explicit.
- The Viewer call graph identifies the official runtime as the only production path.
- Conversion and collision responsibilities are separated.
- Editor options are compared and standalone self-hosted deployment is the only recommendation.
- The 13M case is represented as publication success plus independent collision timeout, not as overall conversion failure.
- Agriculture entities are identified as future platform work, with no Phase 1 migration.

### Regression Gates

- `git diff --check`.
- Markdown link/path checks.
- Confirm only the two requested Markdown files are new.
- Confirm no lockfile, source, migration, asset, log, secret, or runtime state changed.
- Cross-check the main document and roadmap for contradictory Editor, collision, version, or ownership decisions.

### Rollback

Delete or revert only the Phase 1 documentation commit. Do not reset or clean the worktree and do not alter code or data.

### Do Not Touch

- Application source, migrations, package manifests, lockfiles, services, workers, queues, databases, storage, or user assets.
- Celery jobs, collision tasks, conversion tasks, staging directories, and published artifacts.

### Definition of Done

- Both documents are reviewed, committed, and pushed normally.
- Phase 2 is not started automatically.
- The next action is human review of this roadmap.

## Phase 2 — 3DGS Foundation Closure

### Implementation Status (PC-INTEGRATION-02, 2026-10-11)

P2-A/P2-B/P2-C/P2-D complete: PASS. Backend458 / workers106 / Web261 / real
Playwright3 tests pass; clean-checkout GATE_EXIT=0 and historical 13M read-only
integrity pass. Phase 3 is ready for user review, not started automatically.
See `docs/reports/PC_INTEGRATION_02_FOUNDATION.md` for actual evidence and limitations.
Independent `SceneProcessingSettings` preserves the original display category and
immutable SceneVersion. Recipe v2 and locked 3.3.3 parameters remain unchanged.
Automatic collision is default-off and calibration/budget-aware across publish and
recovery; explicit nonphysical manual builds remain available without enabling Walk.
Measured VERIFIED ingestion and nonunit/nonidentity collision normalization are not
invented in Phase 2: without a trusted measurement source they remain fail-closed and
are deferred to Phase 4. No Phase 3 implementation or production deployment is implied.

### Goal

Make SplatTransform the sole general-purpose conversion and collision engine while retaining GSPlatform’s platform reliability, asset lifecycle, versioning, permissions, and failure recovery.

### Scope

1. Separate conversion policy from SplatTransform execution.
2. Reduce arbitrary low-level conversion controls to finite, tested product profiles.
3. Keep a versioned recipe and immutable artifact identity.
4. Keep validation, manifest verification, staging isolation, timeout handling, atomic promotion, idempotency, and recovery.
5. Make collision generation scene-type-, calibration-, and resource-aware.
6. Preserve existing SOG/PLY/SPLAT/ZIP compatibility and published SceneVersions.
7. Keep the official Viewer runtime unchanged except for narrowly isolated compatibility fixes.

### Files

**Likely modified files:**

- `workers/pipeline/convert_scene.py`
- `workers/pipeline/validate_scene.py` only if a validator seam is needed; do not weaken checks
- `workers/pipeline/verify_publish.py`
- `workers/tasks/publish_scene.py`
- `workers/collision/splat.py`
- `workers/tasks/build_collision.py`
- `apps/api/app/services/collision.py`
- `apps/api/app/services/scene_runtime.py` only for explicit policy/status projection
- `apps/web/src/features/authoring/CollisionPanel.tsx`
- `apps/web/src/scene-runtime/sceneScale.ts`
- `apps/web/src/scene-runtime/SuperSplatRuntime.ts` only for compatibility isolation

**Candidate new files:**

- `workers/pipeline/conversion_policy.py`
- `workers/pipeline/splat_transform_adapter.py`
- `workers/pipeline/artifact_validator.py`
- `workers/pipeline/collision_policy.py` if policy is not appropriately owned by the API service
- focused fixtures under `workers/tests/fixtures/` only if they do not contain user assets

**Tests to extend or add:**

- `workers/tests/test_convert_scene_formats.py`
- `workers/tests/test_convert_scene_lod_recipe.py`
- `workers/tests/test_convert_safety.py`
- `workers/tests/test_verify_publish.py`
- `workers/tests/test_validate_scene.py`
- `workers/tests/test_publish_conversion_recovery.py`
- `workers/tests/test_collision_concurrency.py`
- `workers/tests/test_collision_execution_fencing.py`
- `workers/tests/test_build_collision_version.py`
- `workers/tests/test_collision_atomic_finalize.py`
- frontend/runtime tests covering settings, scale, collision state, and Viewer compatibility

**Frozen files:**

- `apps/viewer/*` remains a frozen legacy fork and is not promoted.

**Removal candidates, only after proof:**

- `workers/collision/indoor.py`
- `workers/collision/outdoor.py`

### Dependencies

- Phase 1 approval.
- Existing pinned SplatTransform `3.3.3` behavior and its current CLI path.
- A non-production fixture corpus covering valid and invalid PLY/SPLAT/SOG/ZIP inputs.
- A representative large-scene benchmark or recorded artifact metadata; do not re-convert the 13M source without explicit approval.
- Agreement on finite conversion profiles and scene-type collision policy.

### Tasks

#### 2.1 Define conversion policy

- Define a typed request containing source format, target format, scene category, requested profile, calibration state, and resource budget.
- Preserve the current recipe fields: tool version, recipe version, profile, LOD ratios, chunk count/extent, SH iterations, backend, and output ordering.
- Reject unsupported combinations before starting a worker process.
- Keep old recipe readers for already published manifests.
- Do not expose raw chunk/LOD knobs to normal product callers unless a profile explicitly owns them.

#### 2.2 Extract the SplatTransform adapter

- Move CLI path resolution, Node command construction, environment setup, process-group creation, stdout/stderr tailing, timeout, and exit-status handling behind one adapter.
- Record the exact SplatTransform version and compute backend in the build metadata.
- Keep CPU fallback behavior explicit; do not silently claim GPU execution.
- Treat non-zero exit, timeout, signal termination, missing output, and partial output as separate failure reasons.

#### 2.3 Extract artifact validation

- Validate output format, manifest schema, LOD order/counts, chunk non-emptiness, total counts, hashes, and checksums before promotion.
- Keep source validation before any expensive conversion.
- Keep archive extraction limits and path traversal protection.
- Ensure incomplete output cannot be reused by a later job.

#### 2.4 Preserve publication semantics

- Continue writing only to version-scoped staging.
- Continue using `PublishService` for atomic promotion and DB transaction ordering.
- Continue treating same source/recipe/checksum as idempotent reuse and different content under the same identity as a conflict.
- Continue isolating source quarantine and cleanup by version/job.

#### 2.5 Introduce collision policy

- Add explicit policy inputs for `PLANT_OBJECT`, `GREENHOUSE_SCENE`, and `FIELD_SCENE`.
- Default collision off for uncalibrated uploads.
- Require calibration or an explicit manual assumption before meter-based voxel generation.
- Keep indoor carve and outdoor floor-fill as official SplatTransform policy arguments.
- Keep mesh fallback and voxel artifact validation.
- Keep collision failure independent from publication success.

#### 2.6 Preserve collision fencing

- Do not remove `sourceVersion`, `sourceVersionId`, `worldTransformHash`, execution generation, lease, heartbeat, or atomic finalization.
- Add tests for policy changes racing with a running job.
- Confirm a newer SceneVersion cannot receive an old collision callback.

#### 2.7 Isolate Viewer compatibility

- Keep `SuperSplatRuntime` as the only frontend entry point.
- Move `handle.app`, `findByName('gsplat')`, statistics, internal CSS, and pose workaround access into a version-gated compatibility module if practical.
- Do not replace the official Viewer with `apps/viewer`.

### Acceptance Criteria

- Every production conversion reaches SplatTransform through one adapter path.
- At least three finite conversion profiles are documented and tested, or the product deliberately supports fewer with an explicit decision.
- Existing valid PLY/SPLAT/SOG/ZIP flows continue to produce valid artifacts.
- A conversion timeout leaves no published partial version and preserves a previously published version.
- Replaying the same source and recipe is idempotent.
- A changed recipe creates a new immutable asset version rather than mutating an old one.
- Artifact verification rejects missing chunks, altered checksums, invalid manifest ordering, and incomplete output.
- A 13M-scale conversion has an admission/resource estimate and does not trigger an unconditional collision build before calibration.
- Collision failure leaves the SceneVersion published and marks the collision job honestly failed.
- A collision result cannot be served when its source version or world transform is stale.
- Existing Viewer desktop/XR tests remain green without legacy fork activation.

### Regression Gates

- `workers/tests/test_convert_scene_formats.py` passes for each supported input/output.
- `workers/tests/test_convert_scene_lod_recipe.py` passes for recipe identity, LOD counts, ordering, and profile stability.
- `workers/tests/test_convert_safety.py`, `test_validate_scene.py`, and `test_verify_publish.py` pass for malformed input and output tampering.
- `workers/tests/test_publish_conversion_recovery.py` passes for timeout, retry, crash recovery, and idempotent publication.
- `workers/tests/test_collision_concurrency.py`, `test_collision_execution_fencing.py`, `test_build_collision_version.py`, and `test_collision_atomic_finalize.py` pass.
- Descriptor tests confirm collision URLs are served only for valid, current artifacts.
- A measured benchmark records wall time, peak memory, scratch disk, backend, and output size for a representative large scene.
- `git diff --check` and package/lockfile review confirm no accidental dependency upgrade.

### Rollback

- Keep the old orchestration entry point available behind the same job contract until the new adapter passes the full suite.
- Roll back by selecting the previous conversion recipe/adapter implementation for new jobs; never rewrite existing published assets.
- If collision policy misbehaves, set new automatic policy to disabled/manual while retaining already valid collision assets and the existing fencing path.
- Revert only the Phase 2 code commit(s); do not delete staged or published assets during rollback.

### Do Not Touch

- Do not change `SceneVersion` semantics or migrate existing rows.
- Do not upgrade SplatTransform, Viewer, Engine, Node, or Python dependencies in the same change.
- Do not re-convert the 13M PLY or rerun its collision job as a validation shortcut.
- Do not increase the 600-second collision timeout without a measured benchmark and explicit resource decision.
- Do not delete the legacy collision modules until the reference/output audit is complete.
- Do not change the production Viewer route or reinstate the frozen fork.

### Definition of Done

- Conversion policy, adapter, and validation responsibilities are independently testable.
- All existing reliability tests pass.
- Large-scene behavior is documented with measured resource limits.
- Collision trigger policy is explicit for all three scene categories.
- Existing assets remain accessible and no in-place migration occurred.
- A release note records the exact tool/recipe compatibility behavior.

## Phase 3 — Official SuperSplat Editor Integration

### Goal

Allow users to edit Gaussian content using the official SuperSplat Editor while GSPlatform remains the authority for identity, authorization, asset transfer, versioning, provenance, and publication.

### Scope

- Deploy the official Editor as a separate static application.
- Launch it from a platform-authorized editing session.
- Transfer files through short-lived, permission-checked download/upload endpoints.
- Produce a new immutable SceneVersion from an exported file.
- Keep SceneAuthoringPage for platform presentation, metadata, annotations, viewpoints, calibration, and agriculture context.
- Do not embed the Editor source in the existing React bundle.

### Files

**Likely modified files:**

- `apps/web/src/pages/SceneAuthoringPage.tsx` — add “Open Gaussian Editor” session action, status, and return flow.
- `apps/web/src/features/authoring/authoringTypes.ts` — add editor session state only if needed.
- `apps/web/src/features/authoring/useSceneAuthoring.ts` — session lifecycle if it belongs with authoring state.
- `apps/api/app/services/scene_access.py` — reuse, not bypass, the existing access policy.
- `apps/api/app/services/upload_service.py` — reuse or extend secure upload primitives.
- `apps/api/app/services/publish_service.py` — create a new version through the existing publication path.
- `apps/api/app/db/models/asset.py` — only if editor provenance cannot be represented by existing metadata.
- `apps/api/app/db/models/upload_session.py` — only if a distinct export/session kind is required.
- API route modules that own scene/asset/upload endpoints.

**Candidate new files/deployment units:**

- `apps/editor/` or an equivalent separately built static deployment directory for the official Editor source/build.
- `apps/web/src/features/editor/EditorSessionPanel.tsx`.
- `apps/api/app/services/editor_session.py`.
- `apps/api/app/schemas/editor_session.py`.
- `apps/api/app/routes/editor_session.py`.
- Editor transfer/session tests and an operator deployment runbook.

**Do not modify for embedding:**

- Do not copy the Editor source into `apps/web/src/`.
- Do not turn `apps/viewer` into the Editor.
- Do not rely on undocumented internal Editor state or CSS.

### Dependencies

- Phase 2’s immutable conversion/publication contract.
- An approved Editor source commit and license/notice procedure.
- A deployment host/domain strategy for the standalone Editor.
- Secure same-origin or cross-origin session design with strict origin checks.
- A test asset large enough to expose browser memory and transfer problems, without using private production data.

### Tasks

#### 3.1 Define the edit session

- Session input: scene ID, source `SceneVersion`, requested output formats, expiry, user, and return target.
- Check owner/editor permission through `SceneAccess`.
- Issue a short-lived, one-time download authorization scoped to the source version.
- Never return storage keys or unrestricted bucket credentials.
- Record session creation, expiry, download, upload, validation, and cancellation events.

#### 3.2 Deploy the official Editor separately

- Build and serve the selected upstream Editor commit as a static application.
- Preserve MIT notice and upstream attribution in the deployment artifact.
- Configure a GSPlatform launch URL/session token without patching Editor behavior unless a future upstream contribution is accepted.
- Keep the Viewer and Editor release versions recorded separately.

#### 3.3 Receive the export

- Accept only supported Gaussian file formats and bounded sizes.
- Write exports into version/session-scoped staging.
- Validate file magic, structure, size, hash, and archive paths before creating a SceneVersion.
- Use `PublishService` to create a new immutable version; do not mutate the source version.
- Record source version, editor commit, user, output hash, and conversion recipe/provenance.

#### 3.4 Return to authoring/runtime

- Mark the new version as processing/published using the existing state machine.
- Refresh the scene descriptor only after publication succeeds.
- Keep presentation metadata and agriculture bindings attached according to explicit version rules; do not silently copy incompatible data.
- Show collision as pending/stale after a new Gaussian version until a policy-approved build exists.

#### 3.5 Handle failure and expiry

- Expired session: reject download/upload and leave no published artifact.
- Upload failure: retain only quarantined, version-scoped staging subject to cleanup policy.
- Validation failure: explain format/limit failure without creating a SceneVersion.
- Duplicate export: idempotently reuse the same content-addressed result when provenance and checksums match.
- Browser close/cancel: never block the source version.

### Acceptance Criteria

- A user with edit permission can open the standalone Editor for an authorized SceneVersion.
- A user without permission cannot download the source or upload into another user’s session.
- The Editor is independently deployable and can be updated without rebuilding the main React app.
- An export creates a new immutable SceneVersion and never overwrites the source.
- SceneVersion provenance identifies the source version, Editor build/commit, output hash, and publication recipe.
- Existing Viewer and SceneAuthoringPage presentation features continue to work.
- A failed/expired/cancelled session creates no visible published asset.
- Large exports do not pass through React component state or base64 JSON payloads.
- No undocumented Editor iframe/internal API is required for the core flow.

### Regression Gates

- Existing upload, publication, descriptor, ACL, and Viewer tests pass.
- Editor session tests cover owner, collaborator if supported, anonymous, expired, replayed, wrong-scene, and wrong-version requests.
- Asset transfer tests cover range/streaming behavior, size limits, checksum mismatch, interrupted upload, and retry.
- SceneVersion tests prove source immutability and atomic current-pointer behavior.
- Viewer regression loads the newly published export in desktop mode.
- License/notice check scans the standalone deployment output.
- Security review confirms no token appears in logs, URLs with excessive lifetime, or client-accessible storage configuration.

### Rollback

- Disable the Editor launch action and session endpoint while keeping existing Viewer and upload flows active.
- Preserve already-created immutable versions; do not delete them as part of a code rollback.
- Revert the standalone Editor deployment to the previous approved commit or take it offline.
- Any partially uploaded export remains quarantined and follows the existing cleanup policy.

### Do Not Touch

- Do not embed or fork the Editor into `SceneAuthoringPage`.
- Do not make Studio, Manage, or the Publish API a required path.
- Do not rewrite existing SceneVersions or automatically regenerate all collision assets.
- Do not copy platform agriculture data into Editor files without an explicit export contract.

### Definition of Done

- Standalone Editor deployment is reproducible and attributed.
- End-to-end authorized edit → export → new SceneVersion → Viewer preview works.
- Source versions, ACLs, staging, checksums, failure recovery, and audit records are covered by tests.
- The main web app contains only a session/launch/return integration, not Editor implementation code.

## Phase 4 — Agriculture Business Layer

### Goal

Build an agriculture domain model and API that binds plants, phenotypes, calibration, and time-series observations to scenes and versions without coupling the data model to Gaussian encoding.

### Scope

Candidate entities, subject to domain review and existing-model search:

- `Project`
- `Acquisition`
- `PlantInstance`
- `PhenotypeMeasurement`
- `ScenePlantBinding`
- `Calibration`
- `ObservationTimepoint`

Required measurement concepts include plant number, species/cultivar, acquisition time, plant height, canopy width, leaf length, leaf width, measurement method, unit, source/operator, scene instance binding, and multiple observation timepoints.

No equivalent agriculture-domain model was found in the Phase 1 repository scan. That is evidence for a new domain layer, not permission to add tables during Phase 1.

### Files

**Likely new backend files:**

- `apps/api/app/db/models/project.py`
- `apps/api/app/db/models/acquisition.py`
- `apps/api/app/db/models/plant_instance.py`
- `apps/api/app/db/models/phenotype_measurement.py`
- `apps/api/app/db/models/scene_plant_binding.py`
- `apps/api/app/db/models/calibration.py`
- `apps/api/app/db/models/observation_timepoint.py`
- corresponding schemas, services, route modules, permissions, and migrations

Names are candidates, not final schema decisions. A domain-model review must confirm aggregates, ownership, cardinality, units, and naming before files are created.

**Likely modified platform files:**

- `apps/api/app/services/scene_access.py` — agriculture resource permissions, preserving existing scene ACLs.
- `apps/api/app/services/scene_runtime.py` — expose only the minimal version/binding data needed by the frontend, not raw agriculture tables.
- `apps/web/src/pages/SceneAuthoringPage.tsx` — add agriculture context entry points, not Gaussian editing controls.
- new `apps/web/src/features/agriculture/` components and hooks.
- `apps/web/src/scene-runtime/ScenePickingAdapter.ts` only if approximate placement is explicitly labelled and confirmed sufficient.

**Tests and documents:**

- database migration tests and downgrade/rollback checks;
- API permission and validation tests;
- unit normalization and measurement provenance tests;
- scene/version binding tests;
- multi-timepoint query tests;
- agriculture authoring UI tests;
- domain glossary and measurement-method documentation.

### Dependencies

- Phase 1 domain boundary approval.
- Phase 2 stable SceneVersion and descriptor semantics.
- A signed-off agriculture vocabulary: species, cultivar, plant number, units, methods, uncertainty, missingness, and observation identity.
- A decision on whether `Project` already maps to `Scene` or is a higher-level aggregate.
- A calibration policy for units/meters and coordinate frames.

### Tasks

#### 4.1 Model the domain before migrating

- Identify aggregate roots and ownership.
- Decide whether one Project contains many Acquisitions and Scenes.
- Define immutable or append-only semantics for observations and measurements.
- Define controlled vocabularies for measurement methods and units.
- Define correction/quality flags rather than overwriting historical measurements.
- Define the relation between a plant instance and a specific SceneVersion/timepoint.

#### 4.2 Build spatial binding

- Store a platform-owned binding from `PlantInstance` to a Scene/SceneVersion and local/world coordinate representation.
- Record calibration identity, transform version, placement confidence, and source method.
- Never encode plant IDs, phenotype values, or time-series data into the SOG/PLY binary.
- Keep Viewer annotations as optional presentation, not the source of truth.

#### 4.3 Build measurement and time-series APIs

- Create append-only observation timepoints.
- Store value, unit, method, operator/source, timestamp, quality, and optional uncertainty.
- Validate conversions explicitly; never silently convert incompatible units.
- Support querying one plant across time and one timepoint across a scene.

#### 4.4 Integrate the frontend

- Add agriculture panels/tabs around the official Viewer.
- Allow selecting a known plant/binding without claiming exact surface picking if only approximate picking is available.
- Keep 3D navigation and rendering in the official Viewer.
- Keep forms, tables, filters, units, and data export in platform UI.

#### 4.5 Permissions and audit

- Reuse scene/project ownership and share rules.
- Define whether shared scene viewers may see agriculture measurements.
- Add audit records for measurement create/update/correction/export.
- Ensure private agriculture data is not exposed by a public scene descriptor.

### Acceptance Criteria

- Domain terms and relationships are approved before migration.
- A plant instance can be linked to a specific scene/version and calibration without modifying Gaussian files.
- A measurement records value, unit, method, timepoint, provenance, and quality state.
- Multiple observations for one plant are queryable in temporal order.
- Unit validation rejects incompatible values and records conversions.
- Scene and agriculture ACLs are enforced independently and jointly where required.
- Viewer can display platform context without becoming the agriculture data store.
- New SceneVersions do not silently detach or incorrectly remap historical plant bindings.
- Existing non-agriculture scenes continue to load without new required fields.

### Regression Gates

- Migration up/down or forward-only policy is explicitly tested according to repository standards.
- Existing scene, upload, publication, descriptor, share, and Viewer tests pass.
- Permission matrix covers owner, collaborator, public viewer, share token, and unauthenticated access.
- Temporal query tests cover out-of-order ingestion, duplicate observation IDs, missing values, corrections, and timezone normalization.
- Spatial tests cover scale calibration, transform changes, version binding, and stale placement.
- API contract tests verify agriculture fields never appear in unauthorised public descriptors.

### Rollback

- Disable agriculture routes/UI with feature flags while preserving existing scene runtime.
- Roll back migrations only according to the database migration policy; never drop data casually.
- Keep append-only measurement tables and mark a feature rollout disabled rather than deleting historical observations.
- Revert frontend bindings without altering Gaussian assets or SceneVersions.

### Do Not Touch

- Do not add phenotype columns to `SceneVersion`, SOG, PLY, or Viewer settings.
- Do not repurpose Viewer annotation text as a database substitute.
- Do not make exact plant placement depend on undocumented Viewer internals.
- Do not infer agricultural scale from an uncalibrated Gaussian scene.

### Definition of Done

- Approved domain model, migration plan, API contract, and permission matrix exist.
- At least one complete flow works: acquisition → plant instance → calibrated scene binding → phenotype measurement → timepoint query.
- Existing scenes and Viewer paths regress cleanly.
- Documentation states units, provenance, correction, ACL, and version-binding rules.

## Phase 5 — Desktop and PICO Neo3 Acceptance

### Goal

Prove the integrated platform on real agricultural assets across desktop rendering, WebXR, real-scale calibration, large-scene streaming, access control, and a real PICO Neo3 device.

### Scope

Separate acceptance tracks:

```text
Software PASS
  - desktop WebGPU
  - browser WebGL WebXR path
  - Viewer settings/annotations/audio/collision behavior
  - asset streaming and permissions

Hardware PASS
  - PICO Neo3 real device
  - HTTPS deployment
  - 6DoF tracking
  - enter/exit VR
  - controller/input behavior
  - calibrated scale and Walk
  - performance and thermal observation
```

### Files

**Likely modified or added documentation/runbook files:**

- `docs/reports/` acceptance report for the candidate release.
- `docs/runbooks/` PICO setup, HTTPS, asset preparation, rollback, and evidence collection.
- test fixtures/configuration for desktop/XR acceptance, only after approval.

**Likely test locations:**

- existing web/runtime test locations for Viewer and settings regression;
- browser E2E suite for desktop and WebXR software checks;
- a separate hardware test record, not a simulated browser result.

**Potential deployment files, only if the release requires them:**

- HTTPS/reverse-proxy configuration;
- static Editor deployment configuration;
- storage/CORS policy for authorized asset delivery.

These deployment changes are future work and are not part of Phase 1.

### Dependencies

- Phase 2 stable conversion/collision policy.
- Phase 3 standalone Editor only if the test scenario includes edited assets.
- Phase 4 calibration and plant-binding semantics if agriculture acceptance is included.
- Real PICO Neo3 hardware, supported browser/runtime, USB/network procedure, and a secure HTTPS environment.
- A representative small plant object, greenhouse, and large field/scene asset set.

### Tasks

#### 5.1 Desktop WebGPU software pass

- Load a small, medium, and large Streamed SOG.
- Verify progress, chunk streaming, camera framing, settings, annotations, audio, and private access.
- Record renderer, browser, GPU, memory, load time, and errors.
- Confirm the 13M acceptance evidence is not represented as a hardware result.

#### 5.2 WebGL WebXR software pass

- Confirm the XR route selects WebGL and uses the official Viewer XR methods.
- Test user-gesture entry, system exit, resize, lost-session behavior, and cleanup.
- Exercise collision/Walk only with a calibrated test asset.
- Run browser/emulator checks but label them software-only.

#### 5.3 PICO Neo3 hardware pass

- Deploy over trusted HTTPS accessible from the headset.
- Open a private authorized scene and confirm denial for a non-authorized scene.
- Enter/exit VR on the physical headset.
- Confirm 6DoF tracking, controller input, camera scale, and Walk/collision behavior.
- Record device firmware/browser/runtime, network, asset, scene version, FPS/latency observations, and failures.
- Repeat with a large scene only after the small/medium gate passes.

#### 5.4 Large-scene and streaming budget

- Define load-time, memory, chunk, and frame-time budgets by device class.
- Use the existing 13M report as baseline evidence, not as a new conversion instruction.
- Verify that no failed collision build blocks visual viewing.
- Record fallback behavior if GPU or WebGPU is unavailable.

#### 5.5 Release and rollback

- Freeze the Viewer/SplatTransform/Engine tuple for the candidate release.
- Publish a candidate SceneVersion rather than altering an existing accepted version.
- Prepare a previous-version rollback and access-policy rollback.

### Acceptance Criteria

- Desktop WebGPU software PASS is documented with reproducible asset/version/browser/GPU details.
- WebXR WebGL software PASS is documented separately.
- PICO Neo3 hardware PASS includes physical entry/exit, 6DoF, input, scale, and private-scene checks.
- Real-scale calibration is complete for any scene on which Walk/collision is claimed.
- Large-scene streaming behavior has measured load/memory/performance results.
- Private scene access is tested on the deployed domain, not only localhost.
- A collision timeout or failure does not prevent viewing a successfully published SceneVersion.
- A release can roll back to the prior immutable SceneVersion and software tuple.

### Regression Gates

- Existing Viewer/settings/annotation/collision/XR tests pass.
- Browser automation and hardware records are stored separately.
- No “PICO PASS” appears in a report without a device ID/session date/evidence record.
- The access matrix passes on the real HTTPS deployment.
- The large-scene budget is compared with the documented 13M baseline.
- Upgrade checks confirm the tested package versions match the lockfile.

### Rollback

- Repoint the scene to the previous immutable `SceneVersion` through the supported publication path.
- Disable Walk/collision for a scene if calibration or hardware behavior fails; retain visual viewing.
- Roll back static Viewer/Editor deployment to the previously accepted artifact.
- Do not delete the failed candidate asset; retain it for diagnosis or mark it unavailable through normal lifecycle state.

### Do Not Touch

- Do not claim hardware acceptance from Chrome desktop, WebXR emulator, or PICO browser inspection alone.
- Do not alter a production asset to make a performance number pass.
- Do not weaken private access to simplify headset testing.
- Do not run an unbounded large-scene conversion or collision job without resource approval.

### Definition of Done

- Software and hardware reports are separate and complete.
- Tested package/asset/domain/device matrix is recorded.
- Real-scale and collision policy are demonstrated on approved assets.
- Private-scene security, streaming, rollback, and regression evidence are attached.
- The release owner can state exactly which capabilities passed and which remain unsupported.

## Cross-Phase File Ownership Summary

| Area | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|---|
| Official Viewer runtime | Compatibility isolation only | Regression | Agriculture context around it | Software/hardware acceptance |
| SplatTransform | Adapter/policy/validation | Reuse for exported asset processing | Reuse for agriculture assets | Freeze tested tuple |
| SceneVersion/assets | Preserve and test | New version per Editor export | Bind agriculture data to version | Candidate/rollback versions |
| Collision | Policy/fencing/benchmark | Rebuild only when required | Calibration-aware binding | Real device acceptance |
| Upload/access | Preserve | Secure Editor sessions | Extend agriculture ACLs | Real deployment security |
| `apps/viewer` fork | Freeze | Freeze | Freeze | Never production renderer |
| Agriculture schema | No change | Provenance only if needed | Build | Validate in scenes |

## Global Release Gates

Before any phase is marked complete, verify:

1. `git diff --check` passes.
2. Only intended files changed.
3. No lockfile or dependency drift unless explicitly in the phase scope.
4. No database migration ran without the phase’s migration plan and backup/rollback evidence.
5. No live job, staging directory, or user asset was deleted or silently modified.
6. Existing immutable versions remain readable.
7. Production route still uses the official Viewer.
8. Official OSS license notices remain present in any distributed build.
9. Documentation states `VERIFIED`, `DOCUMENTED`, `PROPOSED`, and `NOT VERIFIED` claims accurately.
10. The next phase is not started automatically after a successful gate.

## Explicit Stop Conditions

Stop and request review rather than improvising if any of the following occurs:

- the current Viewer locked version lacks a capability assumed by an upstream example;
- an adapter requires undocumented internal Editor control to proceed;
- a proposed conversion simplification changes an existing manifest or checksum unexpectedly;
- a collision callback can no longer prove its source version and transform hash;
- an agriculture entity duplicates an existing model not found in the Phase 1 scan;
- a PICO result conflicts with desktop/browser results;
- a hosted PlayCanvas service becomes a hidden runtime dependency;
- a change would require rewriting or deleting a user asset.

## Phase 2 Readiness Checklist

Phase 2 may begin only after the user reviews and accepts the Phase 1 documents and confirms:

- the finite conversion profiles;
- the no-default-collision policy for uncalibrated uploads;
- the SceneVersion/asset compatibility rule;
- the standalone Editor direction for Phase 3;
- the test corpus and resource budget for large scenes.

Until those decisions are approved, the correct action is to stop after Phase 1 documentation and make no program changes.
