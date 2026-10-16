# GS-NEXT-07B — Official SuperSplat Editor Import Fault Diagnosis

Date: 2026-10-16

Final status: **PASS** for the official local `File -> Import` workflow.

Candidate status: `HOLD_NOT_APPROVED`. This run did not edit, export, publish,
or merge any Gaussian data.

## 1. Scope and baseline

The question in this run was whether the pinned official Editor can import the
94,747-Gaussian Building ROI through its normal local-file workflow. No cleanup
or delete operation was performed. No source PLY, Building scene, SceneVersion,
current pointer, or published asset was written.

At start, Git was clean on `main`, at `30290fa026b23137fb31008f0ad9378c42b3a056`
(`docs(gsnext07): record official editor cleanup pilot`), matching
`origin/main`.

The historical 13,090,324-row source PLY was re-hashed on CPU:

| Asset | Rows | Bytes | SHA256 |
| --- | ---: | ---: | --- |
| Historical Building source PLY | 13,090,324 | 3,246,401,885 | `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` |
| Historical small Editor test PLY | 59,400 | 14,732,730 | `f68200c27c6346cf9e617954cdd6c4cbdf554126f80911125511078293940223` |
| Existing 94,747-row ROI | 94,747 | 23,498,786 | `bfdcbc08aa184337e45f526fa8f2381af42f05831ed575d2d19d181ff1aee4e2` |

The small test PLY is `scenes/progressive-test/source.ply`. The source and ROI
remain outside this report's Git diff; all matrix PLY files and browser receipts
are under the isolated external evidence directory listed in Section 8.

## 2. Pinned Editor and local service

This run used the self-deployed Editor at
`http://127.0.0.1:18031/gaussian-editor/`, not the public SuperSplat site.
The pre-existing server was left running. Its route was served locally and the
PLYs were selected from local disk through the browser file chooser; test PLY
bytes were not sent to a third party.

The fixed, unmodified build verified successfully:

| Identity | Value |
| --- | --- |
| SuperSplat tag / commit | `v3.5.2` / `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b` |
| `package-lock.json` SHA256 | `5cc025bfdaa565bcd80a1ee13d29607f2c1ab0903aa76914ad83ae0a6cfd8b2d` |
| License SHA256 | `42fa51ddd556be151a29f381fb97ee975825dcc454e805ea3ea9c079cca04d34` |
| Built artifact SHA256 | `e994c6c327c5e4d3898d25c0ff649ecf3d1cd16efc625faecb9a904a7db188ab` |
| Build/runtime identification | SuperSplat 3.5.2, SplatTransform 3.9.0, Engine 2.23.0, PCUI 6.1.4 |

`apps/editor/editor.sh verify --cache apps/editor/.cache` passed. The artifact
checksum file matches the pinned artifact hash, the pinned source checkout is
clean at the recorded commit, and `apps/editor/editor.sh health --port 18031`
returned `EDITOR_HTTP_HEALTH=PASS`. The local index response was HTTP 200. The
health result alone is not treated as import evidence; the browser gates below
were run separately.

## 3. Failure diagnosis

GS-NEXT-07 recorded the popup
`Cannot read properties of null (reading '_enabled') while loading 'candidate.ply'`
with a zero splat count. That run used the standalone `load` query/private URL
route rather than the Editor's normal local `File -> Import` flow. Its complete
Console stack and a reliable end-to-end request receipt were not preserved. One
earlier local proxy attempt was also observed not to reach the local server.
Therefore the original popup cannot now be assigned to a specific parser,
network, GPU, or upstream defect with certainty.

The pinned v3.5.2 source clarifies the relevant path distinction:

1. `File -> Import` invokes `scene.import`, takes a local `File` from the
   browser picker, and adds it to `MappedReadFileSystem`.
2. `BlobReadFileSystem` reads the local `Blob`; this route does not depend on a
   private URL proxy or HTTP Range handling.
3. SplatTransform parses the PLY, `EditorSplatResource.create` uploads its
   fields to the WebGPU device, and `scene.add` attaches the resource.

In the pinned source, the only `_enabled` read found is
`device.gpuProfiler._enabled` in `Scene.onPostRender` (`src/scene.ts:676`),
after a render. This is a possible location for a null profiler-related error,
not proof that it caused the earlier popup: the old exception had no retained
stack, and it did not recur in the supported import tests. PLY parsing and the
GPU upload path both completed for all test sizes below.

The first browser attempt in this diagnosis was also invalid as a PLY test:
system Chrome had no usable display/Vulkan instance and logged
`A valid external Instance reference no longer exists`, followed by device
creation failure and “SuperSplat failed to start”. This was corrected by using
an active X11 desktop or headful Xvfb and verifying WebGPU before importing.
It was an environment setup failure, not evidence of a malformed PLY.

**Conclusion:** the verified import blockage was in the test path/environment,
not a reproducible failure of the 94,747-row PLY in official `File -> Import`.
The exact historical `_enabled` throw remains unattributed; no claim is made
that the standalone query/URL path was repaired or that an upstream v3.5.2 bug
was found. No upstream source or project Editor version was changed.

## 4. PLY matrix and file integrity

The matrix was built outside the repository by copying complete raw row bytes
from the ROI. Subset files changed only the PLY vertex count/header; payload
rows were not decoded, reordered, re-encoded, simplified, or downsampled.
All files are `binary_little_endian`, 248 bytes per Gaussian, with 62 float
properties including `f_dc_0..2` and `f_rest_0..44` (SH3), position, rotation,
scale, opacity, and normals. Header/property ordering differs between the
historical sample and ROI; both were accepted by the parser.

| Test file | Gaussian count | Bytes | SHA256 | Payload rows used |
| --- | ---: | ---: | --- | --- |
| Historical `source.ply` | 59,400 | 14,732,730 | `f68200c27c6346cf9e617954cdd6c4cbdf554126f80911125511078293940223` | Existing control file |
| `roi-1000.ply` | 1,000 | 249,529 | `d1792f557735b5e9b61b0d80682c00fb64f0c2c0f8b02aa97ab50bd7cf227909` | ROI rows 0–999 |
| `roi-10000.ply` | 10,000 | 2,481,530 | `751adaf3f1ac0a75d1b8d8ae032f1f6ae20014498f11f4639e6fb834e4db9c1b` | ROI rows 0–9,999 |
| `roi-94747.ply` | 94,747 | 23,498,786 | `bfdcbc08aa184337e45f526fa8f2381af42f05831ed575d2d19d181ff1aee4e2` | Full ROI, rows 0–94,746 |

The 94,747-row test is byte-identical to the existing ROI. File lengths agree
with header length plus `count * 248`; no partial/trailing payload was found.
Each PLY was opened through the official `File -> Import...` menu and the
native browser file chooser, not by a URL query or a proxy.

## 5. Browser and functional results

| Browser/session | Test result | Functional evidence |
| --- | --- | --- |
| Google Chrome 145.0.7632.116, headful Xvfb | 4/4 PASS | Editor initialization, import/parse/GPU upload/scene attach, camera navigation, rectangle selection and undo for all four PLYs |
| Google Chrome 145.0.7632.116, active X11 desktop `:1` | PASS for 94,747 | Native file chooser; loaded count 94,747; drag/wheel navigation retained count; selection reached 529 and undo returned to 0 selected |
| Playwright Chromium 153.0.8010.12, headful Xvfb | 4/4 PASS after timing recheck | All counts and navigation passed; selection/undo passed for ROI sizes; historical sample passed when the test waited for undo state rather than using a fixed 400 ms delay |

All browsers had a secure local context, `navigator.gpu`, a created WebGPU
device, and compute support before their import result was accepted. On Chrome
145 the adapter reported `maxBufferSize=4,294,967,296`,
`maxStorageBufferBindingSize=4,294,967,292`; browser-reported
`hardwareConcurrency=64` and `deviceMemory=8` are included as browser values,
not host RAM measurements. The actual X11 desktop test independently repeated
the 94,747 import and interaction gates.

Per-file result details from the Chrome matrix:

| PLY | Loaded count | Selected by rectangle | After undo | Navigation |
| --- | ---: | ---: | ---: | --- |
| Historical sample | 59,400 | 56,914 | 0 selected; 59,400 remain | PASS |
| ROI 1,000 | 1,000 | 975 | 0 selected; 1,000 remain | PASS |
| ROI 10,000 | 10,000 | 61 | 0 selected; 10,000 remain | PASS |
| ROI 94,747 | 94,747 | 524 | 0 selected; 94,747 remain | PASS |

The Chromium historical test initially reported a false selection/undo failure
because its fixed 400 ms check ran before the UI reflected the undo. A separate
recheck waited on the actual selected-count state and passed (selected 56,757,
then 0; total stayed 59,400). The ROI matrix was not affected. No delete action
was invoked; selection was non-destructive and undoable.

### Console, network, and render state

- `pageerror`: zero in every passing run; no unhandled JavaScript exception.
- Failed requests and HTTP responses >=400: zero.
- The sole Console error was the local server's CSP blocking the static inline
  script at `/gaussian-editor/` line 15. It was consistent across files and
  browsers, did not prevent initialization/import, and is not a PLY error.
- The pinned Editor logged its expected version string. No `_enabled` exception,
  GPU device-lost event, browser crash, or context-loss message occurred.
- Screenshots show the ROI in the scene and the correct `Splats 94,747` status;
  the navigation captures differ after camera movement. Selection/undo captures
  show `Selected 0`, `Deleted 0` after undo.

## 6. Resource safety and asset integrity

The 94,747-row test ran in an interactive browser using WebGPU for display and
Editor resource creation. No server-side conversion, GPU floater, full-scene
render, 13M filter, upload, publish, SceneVersion switch, or LOD0 rewrite was
started. GPU1 was not used by a conversion job. The observed GPU compute process
on GPU0 (PID `1337037`) was external and was left untouched; no process was
terminated. At the post-test resource snapshot, host RAM showed 58 GiB
available, swap was full, `/dev/shm` had 63 GiB available, GPU0 had 32,263 MiB
free, and GPU1 showed 14 MiB used. No OOM, WebGPU device loss, or browser
termination occurred during the successful local import sessions.

The historical source SHA256 matched the prior GS-NEXT-07 record. The existing
ROI hash also matched its matrix copy. All generated matrix files and receipts
remain in the external evidence directory; no test data was staged in Git.
The original scene `u-06924576399e`, observation scene `u-c71ec45417a0`, and
published assets were not addressed by any write/publish operation in this
run.

## 7. Readiness for cleanup

The narrow import gate is now reproducible in the pinned official Editor:
94,747 Gaussians load, can be viewed by camera navigation, and support a
non-destructive selection/undo. This removes the prior load blocker for a
carefully supervised manual cleanup experiment.

This does **not** approve cleanup or full-scene writeback. No Gaussian was
deleted or exported. Editor export row-order preservation, stable source-row
mapping after Editor edits, transform/SH/scale/rotation/opacity rewrite behavior,
and bitwise preservation of every ROI-outside LOD0 row remain unverified.
Until a separate test proves those properties, a local Editor result must not
be merged into the 13,090,324-row source. LOD2 is not a substitute for LOD0.
Candidate remains `HOLD_NOT_APPROVED` pending human review.

## 8. Evidence and regression

External evidence root:

`/home/test/.local/state/gsplatform-vr00-20261011/gsnext07b-run-20261016/`

Key receipts and genuine browser screenshots:

- `matrix-manifest.json` (PLY schemas, byte lengths, hashes, row ranges)
- `editor/file-import-matrix-final.json` (Chrome 145 four-file matrix)
- `editor/chromium-153-file-import-matrix.json` and
  `editor/chromium-153-historical-undo-recheck.json`
- `editor/local-gui-x11-receipt.json`
- `editor/local-gui-x11-roi-94747-loaded.png`
- `editor/local-gui-x11-roi-94747-navigation.png`
- `editor/local-gui-x11-roi-94747-selection-undo.png`
- Matching per-file Chrome and Chromium screenshots in `editor/`

Official source references are pinned to commit
`f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b` in
[SuperSplat](https://github.com/playcanvas/supersplat/tree/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b),
including `src/file-handler.ts`, `src/io/read/file-systems.ts`,
`src/io/read/loader.ts`, `src/asset-loader.ts`,
`src/editor-splat-resource.ts`, and `src/scene.ts`. Current official import
guidance was also retrieved with Context7 from the PlayCanvas SuperSplat
documentation.

Regression and integrity checks:

| Check | Result |
| --- | --- |
| `PYTHONPATH=apps/api:. apps/api/.venv/bin/pytest workers/tests/test_splat_transform_adapter.py workers/tests/test_cleanup_experiment.py -q` | PASS, 49 passed in 9.26 s |
| `apps/editor/editor.sh verify --cache apps/editor/.cache` | PASS; pinned build and every artifact checksum verified |
| `apps/editor/editor.sh health --port 18031` | PASS, HTTP health only; browser functional gates are separately recorded above |
| `git diff --check` | PASS |
| Source PLY, ROI, and historical test PLY SHA256 recheck | Matches Section 1 |

No official Editor source was modified, no package was upgraded, and no patch
was applied to suppress the prior error.
