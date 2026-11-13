# GS-RECON-01 implementation and acceptance plan

Baseline: `1144b361d940a1afb5cd915543f1a4033768b8e4`, clean `main` at start.
The authoritative requirements are the user's GS-RECON-01 specification. Completion
requires real local SAM3 inference, masked training, publication, official Editor
measurement/rescale, a new immutable version, and browser evidence, not mocks.

## Dependencies and boundaries

- Discover and identify the existing SAM3 source, checkpoint and Python environment.
  Run it in a separate process; retain the pinned reconstruction environment.
- Verify the pinned official Editor's measurement/rescale capability. Upgrade only
  to a verified official release in a separate cache if required, without modifying
  upstream Editor source.
- Keep existing upload, CPU/GPU Celery queues, COLMAP, gsplat and publication.
- Use GPU0 only after checking free resources. Never clear queues or touch Building.
- Preserve existing versions and author data. Keep unsafe physical Walk disabled.

## Implementation sequence

1. **Discovery and contracts** (estimate: 30–60 minutes). Inspect SAM3, Editor,
   existing datasets, runtime and persistence. Fetch current official documentation.
   Record model/Editor identity and dataset provenance. Verify the actual model
   text API and upstream Measure implementation before adapting either interface.
2. **A: segmentation and masked training** (estimate: 2–4 hours). Extend the existing
   Job with durable reconstruction parameters using a minimal migration. Add a
   recoverable SEGMENTING stage, official SAM3 subprocess adapter, masks/previews/
   statistics and identity hashes. Extend the current trainer with aligned masks,
   foreground RGB loss, background alpha loss and multiview initialization filtering.
   Test prompt validation, OFF compatibility, retry identities, empty masks,
   alignment and loss gradients. Run real SAM3 and real gsplat on isolated data.
3. **B: Compute experience** (estimate: 1–2 hours). Add reconstruction target mode,
   keep prompt, counts, actual segmentation previews, stage progress and durable
   task recovery. Navigate only after resolving the actual published scene/version
   and available assets; open `/model/edit/:sceneId` at scale calibration. Test
   validation, failed segmentation, job recovery, correct identity and navigation.
4. **C: official Editor calibration round trip** (estimate: 2–4 hours). Reuse the
   authorized Editor Session, import, PLY return and publication. Add a visible
   scale workspace and a completion operation binding source/result versions,
   measurement details, unit conversion, uniform factor, actor/time and evidence
   hash. Record ASSUMED when upstream cannot expose trustworthy measurement
   evidence; never manufacture VERIFIED or apply WorldScale a second time. Test
   ownership/CSRF, stale versions, evidence validation and spatial invalidation.
5. **Real acceptance and regressions** (estimate: 2–4 hours). Upload a real multi-view
   set and run both OFF and prompted tasks through publication and Viewer. Capture
   actual masks, output, auto-entry, upstream Measure, uniform rescale, PLY export,
   re-publication and independent remeasurement; calculate absolute/relative error.
   Check immutable old assets, rollback, spatial rebinding and Walk gates. Run API
   pytest, Worker pytest, TypeScript, Vitest, Oxlint, production build and relevant
   Editor/Viewer E2E. Keep exact commands/logs and final scene/version IDs.
6. **Delivery**. Write `docs/reports/GS_RECON_01_SAM3_RECONSTRUCTION_AND_SCALE.md`
   with all ten specified readiness gates, evidence links, limitations, GPU usage
   and final commit IDs. Commit the three logical implementation groups. Do not
   claim the goal complete until every explicit acceptance item has evidence.

## Risks and verification

- Missing/incompatible SAM3 dependencies: isolate environment, preserve original
  installation; report actual inference failures without fallback fake masks.
- Image EXIF/distortion/size mismatch: canonicalize before COLMAP, use exact frame
  names and dimensions, and undistort RGB/masks together for the rasterizer.
- Weak reconstruction/background Gaussians: inspect actual multiview mask overlays,
  registered cameras, filtered point counts and rendered RGB/alpha, not only loss.
- Editor lacks measurement evidence API: use official UI for geometric rescale,
  retain user evidence as ASSUMED, and verify exported geometry independently.
- Long-running GPU tasks: run segmentation and training sequentially in child
  processes, observe live handles, check GPU0 use, retain resumable artifacts.
- Existing tests write to shared development DB: use an isolated database/storage
  for write tests and end-to-end scenes; never let test bootstrap prune user uploads.
