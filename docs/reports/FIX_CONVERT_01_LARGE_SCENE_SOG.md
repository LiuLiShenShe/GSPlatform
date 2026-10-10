# FIX-CONVERT-01 — Large Gaussian PLY to Streamed SOG

Date: 2026-10-10, Asia/Shanghai. **PARTIAL: conversion/publication/desktop
loading verified; automatic collision timed out; clean-source gate pending**.

## 1. Starting HEAD and worktree

HEAD/origin/main: `01ad89479bab881a42eb3661dce747997113df2a`.
The incoming worktree was NOT clean: converter, publisher, reconstruction
adapter, format tests, recipe tests and this report were already modified.
They were preserved and audited; incoming patch/untracked files were copied
outside Git. No reset, clean, force push or production database rebuild.

## 2. Original running job safety

Scene `u-06924576399e`, UUID `e2f54542-40a1-494f-b260-ad8fd28156e6`;
upload `73d8349f-712b-4188-87a1-1ba3b439bc35`.
Jobs `6b44e573-a63e-4e69-b22a-d6de9f7664c2` and
`816dee38-0a37-418d-95b3-a257bb0b03e7` were already FAILED at continuation.
Worker537140/537209 remained healthy; no original CLI subprocess remained.
The original worker was not stopped/restarted. Historical actual argv in
`/tmp/celery-gsplatform2.log`: low/med/high tagged0/1/2, chunk4/extent8,
CPU and `--tty`. Stack timed out at14400s on October10 at17:11:28;
the failure handler quarantined the source and duplicate invocation failed
at the old missing storage key. This was not a manual state reset.
No valid SceneVersion existed for this scene. Old artifacts were not reused
or deleted by this continuation; the old failure handler had cleaned its own
staging before continuation. No safety of already-deleted files is fabricated.

Audit resources:488GiB free disk,~75GiB available RAM, almost-full swap.
Benchmarks use nice10/idle I/O/CPU40–55; formal worker CPU16–39/private queue.

## 3. Original source integrity

**3,246,401,885 bytes; 13,090,324 Gaussians**. Read-only SHA256 recomputed
and matched to original record:

```text
8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764
```

Original quarantine source inode124398598, mtime2026-10-10 10:07:19 unchanged.
No backup copy of3.2GB was made. Formal in-memory converter made one
extension-correct input copy; final code hard-links source PLY on the same
filesystem (copy fallback), never writes to that link, preserves source mode.

## 4. Real RED-01 LOD evidence

Baseline converter loaded directly from Git and run against real59,400 PLY
using actual3.3.3. Official info: **5940/17820/59400**. LOD0=10%,LOD2=100%
is genuinely wrong. The artifact stays isolated and is never promoted.
New verifier rejects increasing counts, not merely bad command strings.

## 5. Correct LOD hierarchy

LOD0=original100%; LOD1=official30%; LOD2=official10%; tags0/1/2.
Small official counts **59400/17820/5940**. Million real scene official counts
**1006948/302084/100695**. Differences at lower levels are integer rounding.
No SH filter is used to accelerate conversion by removing source quality.

## 6. Removing 100% Decimate

No PLY conversion runs `--decimate 100%`. Non-PLY formats still recode full
detail to PLY because pinned3.3.3 tagged LOD output requires local PLY inputs.
SOG/ZIP streamed passthrough remains CLI-free; extension is allowlisted from
declared validated format, not upload.bin/client path. No re-upload needed.

## 7. Official documentation and CLI definitions

Fetched/read sources:

- https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/
- https://developer.playcanvas.com/user-manual/splat-transform/cli-reference/
- https://github.com/playcanvas/splat-transform
- https://github.com/playcanvas/splat-transform/issues/187
- Installed3.3.3 help/package/source (`splat-transform v3.3.3 (d092ae9)`).

Context7 `/playcanvas/splat-transform` library/docs succeeded. Bocha returned
HTTP403; no Bocha results were available. Official pages/GitHub issue/comments
were read via curl. No dependency or lockfile upgrade.

Chunk target is **K=1024**, not chunk count. 4=4096;64=65536;512=524288.
Extent is world units, not calibrated meters.3.3.3 accepts noTTY/max-workers0
but rejects newer `--lod-chunk-min` (real exit1/unknown-option). Metadata min
is null, never a fabricated default8. Issue187 refers to1.9.2 and mixes
different input/SH/camera settings; it is a risk report, not proof for3.3.3.

## 8. Actual Gaussian bounds

Complete read-only source scan:

```text
min [-573.6655884,-36.2013855,-275.3175659]
max [327.3453674,539.3271484,784.2795410]
extent [901.0109558,575.5285339,1059.5971069]
diagonal 1505.2574082 (uncalibrated world units)
```

## 9. Representative data and measurements

Real small fixture59,400. Existing304,427/1,006,948 subsets come from the
same original agricultural scene; their30/10% tiers are official decimations.
Additional official2%/8% decimations generate **261806/1047226** source PLYs
(CPU subset creation1043.753/~989s), with official30/10% tiers. No uniform
synthetic-only selection. No13M combinatorial sweep. Per-command GNU time-v
records elapsed/RSS/CPU/disk block counters/exit; real files/meta count bytes.
Measurements share a busy host, not claimed as exclusive-machine timings.

## 10. Small/Medium and candidate results

Small CPU, extent32; exits0/info valid; counts59400/17820/5940:

| K | Stack s | Chunks | Files | Bytes | RSS KiB |
|---:|---:|---:|---:|---:|---:|
|4|40.911|17|137|757991|316092|
|64|10.135|3|25|551184|388928|
|128|10.393|3|25|550261|387216|
|256|9.937|3|25|550261|350792|
|512|10.838|3|25|550261|384612|

Small30/10% decimate3.472/4.174s.
Identical real304427/91328/30443 inputs; GPU0, all complete/exit0:

| K/extent | Stack s | Chunks | Files | Bytes | RSS KiB | Leaves |
|---|---:|---:|---:|---:|---:|---:|
|4/8|351.861|105|841|23142516|833116|1948|
|64/32|55.811|8|65|20047801|991304|934|
|128/32|43.859|5|41|15208917|993076|934|
|256/32|41.008|4|33|12788234|982644|934|
|512/32|34.291|3|25|11533736|994624|934|
|64/16|62.803|8|65|20215397|978404|1522|

At32 all934 leaves have all3 populated LODs, zero missing entries, maxdepth11.
This checks structural coverage, not visual perfection. Bin targets can be
slightly exceeded when appending a leaf.1M realGPU64/32:190.540s,23chunks,
185 asset files/68,285,721 bytes,counts1006948/302084/100695, official info
AND project verifier passed. Additional official261806 subset with final
serial encoder:47.470s,RSS804676KiB,7chunks/57files/16,566,284bytes,
counts261806/78542/26181; exit0/info/verifier valid. Official1,047,226 subset
LOD decimations63.265/72.777s; redundant CPU Stack sweep was not completed.

## 11. Selected profiles

Balanced **64K/32**, quality **64K/16**, eco **512K/32**; identical ratios/SH.
64K balances first-request payload/PICO budget and compression palette size;
reduces actual representative files841→65.32 reduces sparse tree overhead
without measured missing LOD coverage.512 was faster but not automatically
selected as default; eco trades fewer/larger requests, quality finer spatial
partitioning. No blanket CPU speedup: larger SH palettes can be much slower.

## 12. CPU/GPU analysis

User history60K=CPU40/GPU45s;1M=561/617s retained, not assumed same SH/input.
Fresh same real304K/64/32 CPU **2357s** vsGPU0 **55.811s** (~42x observed,
shared-host, not full-scene extrapolation). CPU SH k-means scales with rows
AND palette size. Default remainsCPU; formal run explicitlyGPU0 only after
this real evidence. No torch/CUDA/Gaussian-training change.

## 13. Time limits, logs and subprocess resources

Both old and dedicated formal worker `/proc/environ` confirm CLI14400s,
Celery hard18000s/soft17400s. Single CLI allowance is not pipeline allowance.
stdout/stderr to workdir logfile; errors retain only64KiB tail, actual exit
codes preserved. Timeout/interruption reaps only its own CLI group.
Background noTTY. Intermittent small CPU CLI exit hangs remain reproducible:
the log printed done but the process remained in futex wait. Three full workers
runs failed one120s CLI timeout each; another full run92tests passed46.60s.
Serial-worker0 reduces encoder fanout but is NOT claimed to cure the native
exit issue (one isolated repetition also hung). Only owned test subprocesses
were reaped. No dependency patch/upgrade, no false TTY diagnosis. Process
groups, finite timeouts and complete markers make retry safe, not fake success.
Running formal process was never changed.

## 14. Recipe-based immutable identity

12hex SHA256(sourceSHA+canonical recipe), schema2/tool3.3.3/ratios/order/
profile/count/extent/min-null/SHiterations10/CPU-vs-WebGPU. Timeouts, paths,
logs and adapter index excluded. Source SHA separately retained as provenance.
Same source different recipe/different source same recipe → distinct version.
Same recipe reuses fully verified published bytes instead of stochastic
reencoding. PublishService compares whole file hashes, rejects changed chunks
hidden by equal manifest, and rejects DB provenance/manifest collision.
Atomic immutable promotion and current-version DB transaction remain intact.
Source hash stays on SceneVersion/manifest provenance; SOG Asset hash is the
lod-meta output hash, not the source hash. Scene splatCount is LOD0, not the
sum of overlapping LODs. Both defects had observed RED and focused GREEN.
An idempotent service commit corrected these DB metadata fields for the
formal version after its worker had loaded the earlier module; no file,
version identity or Job state was modified and no duplicate version created.

## 15. Isolation and failure recovery

Staging `.staging-<job>-<generation>/<ver>`; old staging never cleaned by new
job. Exclusive source/recipe flock protects reusable workdir. Publish reuses
existing execution-claim/heartbeat mechanics; final generation checked under
row lock. Collision algorithms unchanged. Completed markers require source,
recipe,ratio,count,size,hash and complete binary payload; atomic marker write.
Failure keeps validated LODs/logs and source; quarantined historical source
is read/revalidated through server-owned upload directory without moving it.
No CLI process-level resume is claimed. New job comes from existing service
complete retry, NOT manual status reset. Generation roots prevent stale cleanup.

## 16. Real13M formal conversion

Legitimate new job **b5a7f009-b674-49f8-8e00-0a222ce52362**;
Celery b50cfb3e-b6bc-4133-9349-5eb1da454102; private fix-convert01 worker
PID2840834/generation1. Start October10 19:01:50 local.
Actual recipe assetVersion **da7bf4207044** (WebGPU). COPYING1.431s;
LOD1 **224.034s**, LOD2 **269.490s**. Actual complete PLY counts:
**13090324/3927097/1309032**. Stack start19:10:21; actual `/proc` argv
original→tag0/lod1→tag1/lod2→tag2,64/32/SH10/GPU0/noTTY.
This process loaded before serial-worker/hard-link tuning, so final tuning
is NOT retroactively claimed for its artifacts. Stack **2268.507s**, CLI exit0;
POSTER **54.757s/SKIPPED**, WebGPU `VK_ERROR_DEVICE_LOST`, not hidden as PASS.
VERIFYING **2.545s**; atomic PUBLISHING **0.056s**. Task SUCCEEDED at19:49:10,
elapsed **2839.314s**; conversion metadata duration2818.371s. Build-info has
true stage start/end/status; verification/publish timestamps are worker logs.
Monitor maximum sampled RSS5,392,824KiB (LOD2), stack1,598,328KiB; sampled
disk writesLOD1=780161024,LOD2=324665344,Stack=848404480bytes. LOD1 monitor
started late, so these are observed values, not claimed full-lifetime peaks.
Source SHA256 rechecked after completion: exact original match.

| Metric | Original | New |
|---|---|---|
| LOD order |10/30/100|100/30/10|
| Full100% decimate |yes|none for PLY|
| Target/extent |4K/8|64K/32|
| Decimate |historical timings unavailable|224.034+269.490s|
| Full Stack |FAILED at14400s timeout|2268.507s complete|
| Chunks/files |no valid complete artifact|259/2076|
| Output bytes |unavailable|845826640|
| Desktop |no valid version|hardware WebGPU load verified|

No full-scene speedup ratio is fabricated from the old timeout. Candidate
GPU304K Stack improved351.861→55.811s,6.30x on that exact input/configuration;
small CPU4→64 target40.911→10.135s,4.04x; CPU SH3 large-target can be slower.

## 17. Official info and verifier

Small/million real files pass actual official info and project validator.
Verifier checks the provided tree itself (not old sibling version), descending
counts, entry length/hash, chunk payload existence/nonempty/total counts,
complete checksums and recipe source/LOD0 count. Full13M official3.3.3 info
exit0: **13090324,3927097,1309032**,3SHbands. Project verifier independently
passed on the exact published tree/checksums.259chunks (LOD0=180,LOD1=59,
LOD2=20),2076files,845826640bytes. Tree5009leaves/maxdepth17; all leaves
have all three populated LODs. Chunk Gaussians min1121/median68772/max90284
(whole-leaf append can exceed target). Structural coverage is not visual proof.

## 18. Metadata and publishing

Build-info/manifest use actual recipe/counts/settings, unsupported min-null,
source SHA/count, backend/device, durations and phase timestamps/status.
No sensitive source path. SceneVersion **01c63c7c-8eb5-498e-bcc0-77215e92ca12**,
current assetVersion **da7bf4207044**,PUBLISHED; no old valid version existed,
legacy id8e49f56ba292 differs from new recipe. Published checksums cover all
files; immutable assets did not change during DB metadata correction.
Entry SHA256 `df735f57c853a77c5b5a758a6c19c5b7e76654581e9f8aba13521f7088fa75ab`.
Versioned texture Range returns206/128bytes with correct content-range,
Cache-Control public/max-age31536000/immutable. Source provenance retained.

## 19. Collision regression

Existing collision ownership/version/fencing/heartbeat/late-callback tests
and real small CLI collision execute successfully. Automatic chain remains
bound to committed SceneVersion.13M job **9430e75e-83a7-40db-9b30-4d1fbbb8293e**
was actually auto-dispatched; **FAILED** at19:59:12 after existing600s CLI
timeout (task602.373s). Actual target is versions/da7bf4207044, generation1;
no old Collision masquerades as new, no collision asset claimed available.
Uncalibrated units remain a limitation; voxel0.05/floor-fill1.6 were unchanged.
No timeout extension/algorithm change/repeated expensive collision retry was
used to force a PASS. Published scene remains intact and viewable.

## 20. Desktop Viewer/network

Viewer/WebXR/PICO code untouched. Real route `/scene/u-06924576399e` resolved
DB runtime (isManifestFallback=false), versioned API URL, official SuperSplat
WebGPU renderer. SwiftShader first run only streamed into a loading overlay;
second timed out waiting loaded, so those runs FAILED, not false PASS from
gsplats>0. Native Vulkan/WebGPU repeat **loaded=true/progress100**; initial
1,191,624 rendered Gaussians,near3,875,711,far3,900,493.913versioned HTTP
responses, WebP chunks200; Frame/scroll changed actual orbit camera poses.
Counts include transient streaming residency, so near/far counts alone do
not establish monotonic visual quality. Agnes API recognized the final screenshot
as a visible 3D scene with no loading overlay, but identified significant blur
and calibration warning; this visual-quality concern is NOT a PASS. Image
content was identified by Agnes API, not guessed by the text model. A brief
camera move/residency change is not a complete close/far visual-quality audit.
One optional missing poster404 follows the recorded POSTER failure. Runtime
sceneScale=too-large; Walk disabled/collision disabled. No PICO hardware PASS.

## 21. RED → GREEN

RED01 real baseline5940/17820/59400 →59400/17820/5940.
RED02 measured real GPU4/8=351.861s/841files vs64/32=55.811s/65files;
64K CPU was slower, explicitly reported. Old13M Stack failed14400s; no
complete old full-scene speedup can be computed. RED03 source-only identity
fixed by recipe, immutable reuse/conflict tests. RED04 baseline requested
quality but recorded balanced/4/8; actual recipe metadata now tested.
Additional observed REDs for invalid markers, unbounded output, reversed
counts and hidden changed chunks were each run failing before their fixes.

## 22. Test gates and limitations

DB-writing suites use a NEW independent test DB/isolated storage, never the
original upload owner's production sessions. Production DB not rebuilt.
Backend ruff PASS; mypy PASS84files; backend415PASS/1SKIP (416collected),
483.34s and final metadata-only rerun exit0. Workers92PASS46.60s on one run;
latest rerun91PASS/1FAIL164.01s (real SPLAT decimate exit timeout). The gate is
not unconditionally GREEN; intermittent CLI failures are recorded in section13.
Web typecheck/lint/test/build PASS;27files/254tests. Build retains preexisting
oversized-chunk warning. Real CLI small/304K/1M/full13M conversion PASS;
full scenario remains PARTIAL because automatic Collision failed.
Clean checkout gate must run after commit; currently PENDING.
No all-GPU/all-CPU acceleration or visual/hardware PASS inferred from tests.

## 23. Final HEAD

Checkpoint report; executable gates/normal push results will be appended.
Report commit resolves with `git log -1 -- docs/reports/FIX_CONVERT_01_LARGE_SCENE_SOG.md`.
No PLY/SOG/GLB/private data/log credentials are included in Git.
