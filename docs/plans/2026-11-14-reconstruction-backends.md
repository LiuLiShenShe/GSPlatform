# Reconstruction backend selection

Add two choices to Compute: 通用重建（gsplat / 3DGS） and 薄物体、植株重建（2DGS）. Keep quality and prompt segmentation independent. Existing requests default to gsplat.

1. Add the validated algorithm field to the request, durable job parameters, job response and Compute UI. Verify default, both choices, reload and invalid values with contract/UI tests. Estimated implementation: 10 minutes.
2. Dispatch the selected trainer and include the algorithm in training/cache/checkpoint identity. Reuse the local 2DGS repository and its Python environment, align COLMAP images and masks, preserve native 2DGS output and adapt the exported PLY for the existing SOG/editor pipeline. Missing 2DGS must fail explicitly. Estimated implementation: 25 minutes.
3. Test task propagation, backend dispatch, checkpoint isolation and export compatibility; run frontend typecheck/lint/build and targeted API/worker tests. Run a bounded real CUDA 2DGS job through training and SOG conversion using existing captured inputs. Record measured results and remaining limits without calling a smoke run a 30,000-iteration acceptance. Estimated verification: 15 minutes.

Dependencies: existing COLMAP/SAM3 pipeline, `/data/fj/F2DMAS/2d-gaussian-splatting-main`, working CUDA extensions. Deployment paths remain configurable.

Risks: 2DGS uses surface splats with two scales; the shared editor needs a documented finite thin third scale. Its camera loader requires undistorted, centered pinhole images. Both RGB and masks must undergo identical transforms. Native checkpoints and progress must remain compatible with cancellation and retries.

## Completion

- Step 1 complete: two UI options, validated durable algorithm, refresh recovery; UI defaults to standard 30,000 iterations.
- Step 2 complete: native local 2DGS dispatch, aligned cameras/masks, isolated checkpoints, native PLY preservation and SOG compatibility export.
- Step 3 complete: 508 frontend tests, 7 API contracts, 203 worker regression tests, final 16 targeted worker checks; real masked/off/resumed 2DGS and official SOG conversion passed. Production deployment and a new browser calibration roundtrip were outside this change.
- Evidence and exact limits: `docs/reports/GS_RECON_02_BACKEND_SELECTION.md`.
