# GS-NEXT-07 — Official SuperSplat Editor Local Cleanup Pilot

Date: 2026-10-16

Final status: **BLOCKED**

Candidate status: **HOLD_NOT_APPROVED** / ROI-only control candidate

This report records a non-destructive pilot. It does not approve a cleaned
scene, does not modify a SceneVersion, and does not publish or replace any
asset.

## 1. Scope and preflight

The following documents were read before execution:

- `docs/GSPlatform_WebXR_VR_Master_Plan.md`
- `docs/reports/GS_NEXT_06_BUILDING_REUPLOAD_AB.md`
- `docs/reports/VR_01D_GAUSSIAN_CLEANUP.md`
- `docs/operations/VR_01D_CLEANUP_WORKFLOW.md`

The initial Git state was clean and matched `origin/main`:

- HEAD: `6d3a6c42d4bb39d9f4a6bc425e702114cc3276c4`
- Branch: `main...origin/main`
- Historical source SHA256: `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764`
- Historical source: `13,090,324` Gaussian rows, `3,246,401,885` bytes

The historical scene `u-06924576399e` was not modified. The new scene
`u-c71ec45417a0` was used only as an observation reference. No source PLY,
SceneVersion, current pointer, collision asset, or published version was
changed.

The external evidence root is:

`/home/test/.local/state/gsplatform-vr00-20261011/gsnext07-run-20261016/`

The 13M source remains outside the repository at:

`/home/test/gsplatform-data/published/e2f54542-40a1-494f-b260-ad8fd28156e6/.workdir-da7bf4207044/raw-input.ply`

## 2. Official Editor verification

The live official Editor was used at `https://superspl.at/editor`; the
standalone application was also loaded directly at
`https://superspl.at/editor-standalone/`. The observed build identified
itself as:

- SuperSplat `v3.5.2`
- SplatTransform `v3.9.0`
- PlayCanvas Engine `v2.23.0`
- PCUI `v6.1.4`

The empty official Editor started and rendered its scene grid and UI. The
observed UI exposed File/Open, selection-operation controls, selection
footprint/depth and overlay controls, orbit/fly/frame/reset camera controls,
and undo/redo buttons. The undo/redo buttons were disabled while the scene
was empty.

The official editing documentation describes Picker Select, Lasso, Polygon,
Brush, and Sphere selection; selected splats are deleted with Delete. The
official Save/Save As path writes PLY, while compressed export is a separate
lossy/SH-omitting path and was not used.

### Load attempts

| Check | Result | Evidence |
| --- | --- | --- |
| Official Editor startup | PASS | `editor/standalone-route-load.png` and `editor/official-ui-introspect.png` |
| LOD2 complete load | **NOT PROVEN** | LOD2 has `3,272,581` rows, below the stated 5M limit. The official loader read byte ranges `0-0`, `0-131071`, and `1532-260048379`, then the browser page closed before a non-zero splat count appeared. |
| ROI complete load | FAIL | The official Editor showed `ERROR LOADING FILE`: `Cannot read properties of null (reading '_enabled') while loading 'candidate.ply'`; splat count remained `0`. See `editor/standalone-route-load.png`. |
| Box/Lasso/Brush/Delete/Undo on data | NOT EXECUTED | No loaded scene was available, so no destructive operation was attempted. UI/documentation availability is not evidence of a successful data edit. |
| Side/bottom observation in Editor | NOT EXECUTED | The Editor never reached a loaded scene. GS-NEXT-06 side/bottom screenshots remain the visual baseline. |
| Browser context/resource safety | BLOCKED | No application-level “context lost” message was observed. One Vulkan attempt emitted Chromium shared-image errors and exited; the stable OpenGL attempt reproduced the ROI load error. This is not a successful capacity result. |

The direct standalone `load` query path was confirmed from the official
application source. A local browser-route response was used for the ROI
attempt so the test did not upload the source or expose it publicly. The
first local HTTP attempt was not treated as evidence because the browser
proxy path did not deliver the request to the local server.

The nominal 5M limit therefore remains unverified in practice. In
particular, this run must not be summarized as either “LOD2 loads safely” or
“the 5M limit is too low”.

## 3. Artifact region and selection rationale

GS-NEXT-06 showed the persistent bottom/side blur and colored stretched
Gaussian region in `B-side-bottom.png`, while `B-detail.png`, `B-front.png`,
and `B-overall.png` showed the building, ground, road, and peripheral detail
that must be protected. The existing cleanup workflow explicitly labels this
box as an experimental envelope, not a recommended crop boundary.

The selected source-space envelope was:

```text
source PLY:  [-70, 15, 290] .. [-30, 110, 330]
runtime:     [ 30,-110, 290] .. [ 70, -15, 330]
```

The conversion is the established `Runtime=(-sourceX,-sourceY,sourceZ)`
with the official PLY Z180 convention. The box was chosen to cover the
observed bottom/side candidate area plus spatial margin, not by a Y-height
threshold and not by opacity or scale alone.

The content classification is deliberately conservative:

| Content | Pilot decision |
| --- | --- |
| Real building/facade/roof structure | Treat as protected mixed content; no deletion rule was applied. |
| Road, grass, ground, vegetation | Treat as protected mixed content; no deletion rule was applied. |
| Fine structures or thin geometry | Presence cannot be safely excluded; preserve. |
| Suspected invalid Gaussian | Candidate visual region only; no manual selection was made because the Editor did not load it. |

This is important: the ROI is not an artifact-only mask. The official
Editor failure prevents the required side and underside inspection, so no
Gaussian was classified as definitely invalid in this run.

## 4. CPU ROI extraction and numerical evidence

The existing safety adapter and official SplatTransform CLI `v3.3.3` were
used with `--gpu cpu`. The source-space box was translated to the official
CLI runtime box `30,-110,290,70,-15,330`. No server GPU conversion, GPU
floater operation, or full-scene render was started.

Output:

`/home/test/.local/state/gsplatform-vr00-20261011/gsnext07-run-20261016/roi-source-box/candidate.ply`

| Statistic | Value |
| --- | ---: |
| Source Gaussian count | 13,090,324 |
| ROI Gaussian count | 94,747 |
| Source rows outside ROI | 12,995,577 |
| ROI size | 23,498,786 bytes |
| ROI removal relative to full source | 99.2762058449% (ROI extraction only, not cleanup) |
| ROI SHA256 | `bfdcbc08aa184337e45f526fa8f2381af42f05831ed575d2d19d181ff1aee4e2` |
| Source changed | `false` |
| SH | SH3; all 45 `f_rest_*` columns retained |
| Non-finite values | 0 |

The ROI distribution was:

| Measurement | Result |
| --- | --- |
| Source bounds | x `[-69.999374, -30.002165]`, y `[29.957111, 108.509598]`, z `[290.000793, 329.999939]` |
| Runtime bounds | x `[30.002165, 69.999374]`, y `[-108.509598, -29.957111]`, z `[290.000793, 329.999939]` |
| Opacity sigmoid `<0.01 / <0.05 / <0.1` | `3,483 / 9,407 / 15,318` |
| Opacity sigmoid P01 / P50 / P95 / P99 | `0.003873 / 0.450635 / 0.999983 / 0.999997` |
| Maximum linear scale P01 / P50 / P95 / P99 | `0.025429 / 0.175465 / 1.154774 / 2.450331` |
| Maximum linear scale maximum | `20.288972` |
| Count with max scale `>2 / >5 / >10 / >20` | `1,685 / 170 / 35 / 4` |

These distributions are observations only. They are not deletion rules.

### Spatial-support gate

The full-source diagnostic tested whether a conservative sphere with radius
`3 * max(exp(scale_0), exp(scale_1), exp(scale_2))` intersects the selected
box. Rotation is intentionally ignored, so this is a diagnostic upper bound,
not a physical Gaussian renderer model.

- Centers inside the box: `94,747`
- Conservative support intersections: `106,283`
- Centers outside the box whose conservative support intersects it: `11,536`
- Outside-center support with max scale `>5`: `663`
- Outside-center support with max scale `>10`: `334`
- Outside-center support max linear scale maximum: `83.387279`
- Outside-center support opacity sigmoid median: `0.184100`

A read-only exploratory bounding-box calculation around all support-intersecting
centers contains approximately `3.7M` centers, which exceeds the 1M pilot
target. This means the current 94,747-center Box cannot be claimed to cover
all conservative spatial influence. Expanding it to that diagnostic envelope
would violate the pilot size gate and would still not be a safe deletion
rule. The run therefore stops before manual editing.

### Exact extraction mapping

The adapter output property order differs from the historical source order,
but a separate row-mapping verification matched all `94,747` candidate rows
to unique source rows:

- all Gaussian fields, including SH3, were byte-equal after semantic field
  alignment;
- candidate order matched the source-row-index order;
- the first mapped source indices were `12634731, 12634734, 12634739,
  12634750, ...`;
- the complete 0-based mapping is in
  `analysis/roi-source-row-index-map.json`;
- the source and candidate hashes are recorded in that file and in
  `roi-source-box/candidate-manifest.json`.

The default large-input comparison correctly reports retained-row bitwise
preservation as unavailable for the 13M source. The custom mapping above is
the evidence used for this small ROI; it does not imply that an Editor export
will preserve the mapping.

## 5. Manual Editor cleanup

No manual cleanup was performed.

| Item | Result |
| --- | --- |
| Selection | Not started |
| Deleted Gaussian count | `0` |
| Undo verification | Not exercised on data |
| Original ROI retained | Yes; untouched control file remains available |
| Uncompressed Editor export | Not produced |
| Cleaned-candidate SHA256 | Not applicable |
| Visual approval | `PENDING` |
| Candidate disposition | `HOLD_NOT_APPROVED` |

There is no honest four-view GS-NEXT-07 before/after comparison because the
official Editor never produced a loaded ROI or LOD2 scene. The real GS-NEXT-06
baseline screenshots remain available for the four requested visual contexts:

- overall: `../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-overall.png`
- building near view: `../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-detail.png`
- side/bottom: `../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-side-bottom.png`
- bottom/blur region: `../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-side-bottom.png`

They are baseline evidence, not a claim of GS-NEXT-07 improvement. No claim
of reduced artifact, preserved subject, detail preservation, opacity change,
or hole absence is made.

## 6. Full-scene LOD0 mapping decision

The local CPU Box extraction has a verified source-row mapping, but the
required Editor export mapping was not obtained. The following remain
unverified:

- whether Editor export preserves original Gaussian row order;
- whether Editor export rewrites position, SH, scale, rotation, or opacity;
- whether selected rows can be mapped back after manual selection/deletion;
- whether every ROI-outside row can be proven byte-identical;
- whether the result can be applied to the full 13,090,324-row LOD0.

The LOD2 file is not used as an LOD0 substitute. No local result is merged
back into the full source, and no full-scene candidate is generated.

## 7. GPU and resource safety

- The SplatTransform ROI operation recorded `GS_SPLAT_DEVICE
  {"backend":"cpu","adapter":null}` and completed in `33.165` seconds.
- No server GPU conversion, GPU floater, or full-scene rendering job was
  started by this run.
- GPU1 was not used.
- Pre-existing external GPU processes remained running. They were not
  terminated or restarted. Final observation showed GPU0 UUID
  `GPU-db3ec610-630b-fa4f-66f2-b69f269ca856` with an external Python process
  using approximately `9364 MiB`, and GPU1 UUID
  `GPU-6836f890-98b2-5891-07ef-675c25199c65` with approximately `388 MiB`
  in compute processes.
- The temporary browser processes used for the official Editor checks were
  stopped after the attempts. No external process was killed.

## 8. Tests and disposition

Relevant CPU/adapter tests completed successfully:

```text
PYTHONPATH=apps/api:. apps/api/.venv/bin/pytest \
  workers/tests/test_splat_transform_adapter.py \
  workers/tests/test_cleanup_experiment.py -q
49 passed in 8.91s
```

Final disposition: **BLOCKED**.

The pilot proves that the official Editor UI starts and exposes the expected
editing surface, and it proves that the official CPU Box adapter can create a
full-precision, source-mapped ROI without changing the source. It does not
prove that the current official Editor can safely load this ROI or LOD2 in
the present browser environment, and it does not prove that a manual Editor
export can be mapped back to LOD0. No cleanup candidate is approved.

## Official sources

- [SuperSplat Editor](https://superspl.at/editor)
- [SuperSplat Editing Scenes](https://github.com/playcanvas/supersplat/wiki/Editing-Scenes)
- [SplatTransform processing actions](https://github.com/playcanvas/splat-transform/blob/main/_autodocs/api-reference/processing-actions.md)
