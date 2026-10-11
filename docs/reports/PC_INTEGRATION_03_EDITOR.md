# PC-INTEGRATION-03 — Official SuperSplat Editor

Date: 2026-10-11 (Asia/Shanghai). Starting HEAD:
`5ed93dad07e12705f144df666bf7736f73510065`; `main`, initially clean,
`HEAD == origin/main`. Production deployment is not authorized.

## Execution plan

1. **P3-A, independent Editor (first gate):** pin and build official source,
   retain notices, serve `/gaussian-editor/`, test real WebGPU import, navigation,
   selection, deletion, undo/redo and PLY export before touching publication.
   Files: `apps/editor/`, independent browser gate and deployment runbook.
   Estimate: tens of minutes, dependent on network and browser compatibility.
2. **P3-B, authorized session:** audit existing auth/upload/version models;
   additive migration and owner-only version-pinned expiring source download.
   Real isolated PostgreSQL and cookie-authenticated browser tests precede P3-C.
   Files: API model/schema/service/routes/migration/tests. Estimate: hours.
3. **P3-C, existing-scene publication:** reuse chunk upload and official conversion;
   preserve immutable assets, recipe identity, provenance and final locked CAS.
   Real edited PLY, conflict/replay/failure tests precede frontend completion.
   Files: upload/publication seams, worker orchestration and tests. Estimate: hours.
4. **P3-D, UI and acceptance:** authoring launch/return/upload status, official
   Viewer verification, full backend/worker/web/clean-checkout gates, documentation
   and normal Git push. Estimate: hours including real CLI/browser tests.

Risks: browser WebGPU compatibility, upstream third-party Publish UI, relative
multi-file source paths, missing original PLY, LOD downgrade, concurrent publication,
unsafe shared test DB. Mitigation: gated execution, fixed upstream source, enforced
egress policy, owner/session ACL, explicit source kind, isolated storage/database
and final transactional expected-current check. No production job or service restart.
No destructive tests on `u-06924576399e` / `da7bf4207044`.

## Source evidence

Bocha search returned HTTP 403 (quota unavailable); it is not treated as evidence.
Context7 and directly fetched official source/docs are the implementation authority.
Context7's stale Node >=18 snippet conflicts with the locked source: the actual
README and package.json require Node >=20.19.0. The supplied RTK file is absent.
No CodeGraph/graphify index exists; no index was created.

- https://github.com/playcanvas/supersplat/tree/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b
- https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/README.md
- https://developer.playcanvas.com/user-manual/supersplat/editor/import-export/
- https://developer.playcanvas.com/user-manual/supersplat/editor/managing-projects/
- https://github.com/playcanvas/supersplat-viewer
- https://github.com/playcanvas/splat-transform

GitHub metadata checked live: release v3.5.2 published 2026-10-05 15:16:03 UTC;
main and annotated release tag resolve to the fixed SHA above. Build uses
`npm ci --no-audit --no-fund` and `BASE_HREF=/gaussian-editor/ npm run build`;
official Rollup supports BASE_HREF without source patches. Editor dependencies
are isolated from the platform's Viewer1.35.0 / Engine2.22.4 / Transform3.3.3.

## 1. Git and gate chronology

Initial implementation candidate: `27d6019006bf52b3b2adf5dd6f8fb2968bb68a0b`.
Final executable-code candidate: `d40c56857894a46e8c491b88ddd2ac7900d553e7`;
the response-before-commit fix is `e3db10240d198f85ed26a62454486c1161e44513`.
No reset/clean/force push, dependency upgrade or production restart was performed.
The final release includes the commit-visibility, stale-collision and bounded-SOG
regression fixes and this
acceptance document; its authoritative Final HEAD is `git rev-parse HEAD` in the
checkout containing this report (recorded with the matching origin SHA in the
final handoff). A commit cannot embed its own full SHA inside its tracked contents.

P3-A completed real official editing/export **before** SceneVersion publication
changes. P3-B completed real cookie-authenticated private loading **before** export
publication. P3-C then exercised the actual resulting file, official CLI and same
Scene version transaction. P3-D adds UI, replay/conflict security and release gates.
The existing release-preflight tests archive HEAD. Before the candidate commit,
four tests failed only because that archive lacked the new migration while its
isolated DB was at the new head. Candidate code was committed to enable the real
tracked-tree gate; no failed candidate was pushed as a completed release.

## 2. Fixed upstream, license and build

Official repository: https://github.com/playcanvas/supersplat. Release v3.5.2,
commit `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`, MIT. `editor-version.json` records
upstream/tag/SHA, Node >=20.19, official commands, license and lockfile hashes.
Actual Node24.16.0/npm11.13.0; `npm ci --no-audit --no-fund`, then
`BASE_HREF=/gaussian-editor/ npm run build` (official Rollup BASE_HREF option).
No upstream files were modified. Receipt includes build timestamp/Node/npm;
artifact keeps MIT LICENSE, UPSTREAM.txt, dependency inventory/notices and checksums.
Artifact identity `e994c6c327c5e4d3898d25c0ff649ecf3d1cd16efc625faecb9a904a7db188ab`
was reproduced by the independent clean tracked-source build. Original receipt
timestamp `2026-10-11T08:00:57.323374+00:00`; clean build timestamp
`2026-10-11T09:39:02.795835+00:00` is receipt-only, not Gaussian/version identity.

Editor uses its own Engine2.23/Transform3.9/PCUI dependencies. Platform Viewer1.35.0,
Transform3.3.3 and Engine2.22.4 and their lockfile stay unchanged. No upstream source,
node_modules, generated Gaussian, static bundle, DB backup or credentials enter Git.

## 3. Independent deployment and startup

Separate static application `/gaussian-editor/`, not React bundle/iframe, not
`apps/viewer`. `apps/editor/editor.sh` supplies build/verify/start/stop/health,
managing only its owned loopback process. HTML/JS/CSS/locales/WebP WASM/license/
receipt URLs actually return valid files under the subpath. Health is explicitly
HTTP-only. No pre-existing one-click platform launcher exists, so none was invented.
The runbook supplies HTTPS Nginx proxy, same-origin dev proxy, deployment order,
configuration, gates and rollback. No production deployment or DB migration.

## 4. Locked URL-load behavior and authentication

Locked `main.ts`, `file-handler.ts` and `asset-loader.ts` were audited, not inferred
from newer docs. Public `?load=` is supported; the server URL-encodes only a controlled
same-origin session/version path. Locked reader resolves relative chunk URLs from
the entry URL directory. Real Chromium requested private PLY and Streamed SOG chunks
through those exact paths with the HttpOnly login cookie, appropriate content types
and Range206. No CORS credential-sharing or source redirects were required.
Source endpoints reuse SceneAccessPolicy and existing contained/versioned asset
resolution, Range and X-Accel behavior. Source replies are private/no-store,
nosniff/no-referrer. No private file is copied into public/local-scenes directories.
There is no backend remote URL proxy and no source token/JWT/API key in URLs; a
session UUID is only a locator and cannot be replayed by another user or anonymous
browser. Public/share viewing does not confer edit/download permission.

## 5. Streamed and ordinary SOG sources

Only trustworthy persisted current-version PLY/SOG is treated as full-resolution.
Historical UploadSession is not proof that the raw original still exists. If the
current asset is Streamed SOG with no trusted persistent full-resolution source,
source kind is SELECTED_STREAMED_LOD: select and acknowledge one LOD and its count.
This pin's official picker defaults to the coarsest LOD, not a merged original.
The UI and submitted acknowledgement must match the picker selection. Server
bounds the actual output count by the chosen source count; it does not reconstruct
missing detail or cryptographically infer a user's GUI choices from PLY bytes.

Real owner-authenticated Streamed test selected LOD1: 27,160 visible points; official
selection/deletion/undo/redo and PLY export produced 27,159. Official SOG export
contained **27,076** (`meta.json.count`, generator Transform3.9, format version2).
Do not claim all visible PLY points survive SOG encoding. Pinned platform Transform
3.3.3 really decoded/repacked it to counts `[27076,8123,2708]`. The platform records
actual count/format/hash, not an assumed full-resolution count. Ordinary SOG browser
import/navigation loaded 27,076 points through the same cookie/session ACL.

Admission cap defaults to 5M Gaussian; >1M needs memory acknowledgement. It is a
conservative input limit, not a guarantee of every device's available GPU memory.
No browser stress test on the production 13M Scene was attempted. The browser SHA
submission cap is 1GiB; server upload byte limits remain authoritative.

## 6. EditSession and audit

Additive `scene_edit_sessions` includes Scene/owner/source Version/asset version,
source kind/entry/counts/selected LOD, fixed Editor commit/build identity, lifecycle
timestamps/expiry, linked UploadSession/Job, result Version/SHA, safe error/provenance.
Default expiry4h. Upload/Job states are reused rather than a parallel transfer
protocol. Source remains pinned if Scene.current changes. Changed deployment build
identity rejects reopening the old source. A response-before-commit race was caught
by immediate real upload creation: creation now commits **before returning**; a
second PostgreSQL connection verifies visibility before request teardown.

Creation/status/cancel/upload/source enforce real owner identity; even enabled
development bypass is refused by the editor service. Anonymous, real share-grant
readers, other PUBLIC viewers, other users, wrong Scene/version, unsafe paths,
untrusted fields and expired/cancelled sessions are tested. Mutations use existing
double-submit CSRF. Cancellation is idempotent, completion single-result/idempotent;
completed sessions cannot be cancelled or used for another export.

## 7. Export/upload and version-safe publication

Official File → Export → PLY (uncompressed) or verified SOG saves to the browser;
return to GSPlatform and submit. `.ssproj` is a ZIP editor project/state, never a
publishable Gaussian or Streamed stack. No postMessage/private Window object/event
bus/export hook or hosted API is used. Selection/crop/delete/undo/export encoding
are upstream, not new GSPlatform algorithms. Editor alone never saves platform DB.

One linked existing UploadSession reuses HEAD/PATCH offsets/chunks/limits/SHA/private
staging/quarantine/Celery/official Adapter/artifact validation. Generic complete
detects that link **before** its ordinary create-new-Scene branch. Strict export PLY
checks magic, 64KiB bounded ASCII header, float Gaussian properties, positive bounded
vertex count, duplicate elements/properties, little-endian layout and exact payload
length. Existing SOG ZIP safety/magic/size/hash checks apply; bundled v2 metadata is
bounded to256KiB and its strict integer point count is checked against the selected
source **before** CLI decoding. Duplicate ZIP members/Streamed ZIP are not accepted
as official Editor SOG exports. Chunk request bodies
are bounded while streaming, not only after allocating an oversized request.

Final worker holds its unchanged fenced Job execution rights, then locks Scene,
rechecks source CAS and edit ownership/expiry/cancel **before** immutable promotion.
PublishService repeats these checks in the same transaction, inserts/reuses
SceneVersion/Assets, updates current and completes the audit atomically. Old version
bytes never change. Recipe-v2 source hash + unchanged conversion recipe determines
asset identity; provenance/timestamps stay outside Gaussian computation and identity.

## 8. Genuine final acceptance dataset and results

Public official engine guitar fixture (90,854 Gaussian, approximately1.5MiB), not
the original re-uploaded as a fake edit. Final acceptance uses its own PostgreSQL,
storage, real API/Celery/Redis and Chromium153.0.8010.12; no dev identity. Regression
DBs are separate. All private raw evidence stays in `/tmp/gsplatform-p3-evidence`.

Scene `pc03-final-source`: `93f5c1ac-fe2a-43ca-b585-1097574a48ed`.

| Version | Asset | Gaussian count | Source/export SHA256 |
| --- | --- | ---: | --- |
| `dd8d3221-9187-4287-81a0-6d1054433232` | `p3guitar0001` | 90,854 | `04f61b72166394fdfb393dd589b0cb5a8b1b018820c73722278ddcdc2ffedc0f` |
| `630f722f-c85b-4a53-892e-91dafc66ecd6` | `d07919b7a014` | 90,533 | `bf0d3687cc430850955503507f744f30f6f9b4483f02fed0894da75a404ea015` |
| `a612f5d3-5f53-48e2-b42b-aad03a01a722` | `b4fcca41779f` | 27,076 (explicit LOD1 SOG) | `034d2f17c59afbb7d815e3c486fd62bf2389fea14aed798ecdabe606486778ee` |

Actual platform launch created session `7943e39a-242e-4298-90c4-34bca32ec412` pinned
to A. Official UI selected321/delete321/undo/redo; PLY5,070,209bytes, 90,533 vertices.
Real platform file input/ResumableUploader/worker published B in this same Scene.
Official Viewer WebGPU rendered90,533, not a manifest fallback or Editor object.
Second session `bd9576a9-356e-47eb-a9e8-429d695e5bcc` pinned B/LOD1, officially
edited/exported both PLY1,521,265bytes and SOG375,061bytes, then real UI uploaded SOG
and published C. Viewer rendered27,076; initial A SHA unchanged; no collision jobs.
Refreshing Viewer still loaded the authorized new immutable version. Anonymous
requests to its actual content URL returned401.

## 9. Provenance, conflicts, replay and retention

Audit records source Scene/Version/asset, Editor SHA/build/session, submitter/time,
export format/SHA/actual count, unchanged conversion recipe, result version and
spatial/collision decisions. Gaussian content, recipe identity and edit provenance
remain distinct. No annotations/phenotypes/business secrets are baked into files.

Real PostgreSQL two-connection lock/CAS test and real Worker two-session race both
passed: E1 based A publishes B; E2 based A reaches final publication and fails
EDIT_BASE_VERSION_CHANGED. Retrying E2 complete returns409, only2 versions exist,
current remains E1, valid E2 export SHA is retained in private quarantine, collision
jobs0. Same-session complete replay keeps the same Job. A **new session** resubmitting
the identical genuine SOG on final Scene reuses C: still3 versions, no fourth version
or collision. No force-current endpoint is provided. Failed conversion can retry
the same immutable export from quarantine; cancelled/expired sessions cannot retry.
The final-code API/worker repeated this real SOG upload after the metadata/count
guard was added: the result remains C, three versions and zero collision jobs.

Retention defaults7days after edit expiry, scheduled by existing cleanup. It skips
queued/running Jobs, cleans only linked private staging/quarantine and keeps the
audit and published versions. Explicit cancellation also cannot publish during
conversion; final locked check is mandatory.

## 10. Spatial settings, calibration and Collision

Scene metadata/owner/visibility/presentation and historical spatial records remain.
Additive `scene_spatial_states` marks bindings STALE against their old source Version.
Runtime omits stale camera/world transform/viewpoints/annotations; no guessed
coordinate migration or loss of stored records. New current is framed using its
actual content bounds. Existing calibration's source-version mismatch remains
UNVERIFIED/stale, never upgraded to VERIFIED. Existing collision source mismatch
remains STALE/disabled. Publication explicitly sets MANUAL_ONLY, audits the previous
policy and does not dispatch/reconcile automatic work for an edited publish.
Even a newly matching collision asset is withheld while spatial bindings are STALE:
the runtime cannot assume its old world transform matches the default frame.
Collision worker fencing/lease/heartbeat/version-serving and voxel algorithm stay
unchanged. Manual recovery/admission tests still run in their isolated regression DB.

## 11. Frontend

SceneAuthoringPage retains its official Viewer and existing platform panels and adds
GaussianEditorPanel: trusted current version/count/source, session ID/build/auth/
expiry, controlled launch, manual export explanation, local locator refresh recovery,
file/SHA/resumable upload/pause/retry/cancel, distinct uploaded/validating/converting/
publishing states and successful new-version Viewer navigation. Popup blocking is
visible and a second user gesture opens the already authorized session. No source
is opened before authorization. Unmount stops local transfer without deleting the
valid server export; remaining polling timers are cleaned up. A bounded409 offset
resync prevents expired/cancelled sessions from creating an infinite uploader loop.

## 12. Official browser and visual evidence

Real Editor tests manipulate only official visible controls/keyboard; public browser
File System Access is disabled to exercise upstream download fallback (documented).
Chromium153/Vulkan on the existing A6000 passed WebGPU rendering, navigation,
selection/delete/undo/redo/export. Chrome145 failed requestDevice with "A valid
external Instance reference no longer exists" and was **not** counted as PASS.
The 17,820 fixture initially loaded but its visual result was not sufficient proof;
final functional acceptance uses the visibly rendered official guitar instead.
Screenshots were reviewed through Agnes: **图片内容由 Agnes API 识别**. It confirms
visible guitar in Editor, platform completion and official Viewer, not empty backgrounds.

Evidence receipts: `final-editor/receipt.json`, `final-streamed/receipt.json`,
`sog-import/receipt.json`, `final-frontend.log`, `final-sog-frontend.log`,
`final-version-integrity.json`, `real-conflict-receipt.json`,
`real-idempotency-receipt.json`, `migration-receipt.json`, `historical-read-only.json`.
SOG import-only receipt is explicitly not an editing/export gate: its optional fixed
rectangle selection initially timed out (no points hit). PLY and Streamed full
edit gates passed independently. No Mock Editor substituted for these operations.

## 13. Security acceptance E01–E22

| Gates | Evidence/result |
| --- | --- |
| E01–E03 | Real cookie owner creation; anonymous403/401 boundary; real valid share grant Viewer-readable but editor/source denied |
| E04/E07/E20 | Other PUBLIC/PRIVATE user source denied; wrong Scene/version/traversal/untrusted URL rejected; actual anonymous Viewer asset401 |
| E05/E06/E16 | Expired/cancelled source and both generic/edit completion denied; failed/cancelled pointer unchanged |
| E08/E09 | Actual official WebGPU private load, deletion, Undo/Redo and genuine PLY/SOG downloads |
| E10–E15 | Real UI chunk/SHA submission, real3.3.3 CLI, same Scene A/B/C, unchanged A hash, current CAS and official Viewer90,533/27,076 |
| E17 | Real PostgreSQL blocked concurrent Scene lock and real two-Job late CAS conflict409, valid export retained |
| E18 | Real same-session replay and new-session same SOG reuse, no fourth version |
| E19 | Final independent acceptance and race both collision Job count0/MANUAL_ONLY; regression policy/fencing unchanged |
| E21 | Real Streamed picker LOD1/count27,160 and explicit downgraded result; ordinary SOG import27,076 |
| E22 | UI refresh locator/terminal states/poll cleanup, actual Viewer refresh; close Editor is not save/cancel; server expiry/cancel guards |

Enforced CSP `connect-src 'self' blob:` actually generated a native browser
securitypolicyviolation (`connect-src`, superspl.at) for a payload-free no-CORS probe;
it is not merely an assumed CORS failure. Hosted identity `/api/id` is absent404;
forms/frames are forbidden; no hosted credential is installed. Publish UI remains
visible with a clear user warning. This is enforced deployment/network policy,
not a CSS/DOM hack or DRM: users can manually export and move their own files.
CSP intentionally blocks upstream's inline origin-wide service-worker cleanup;
its console warning is expected, protecting other same-origin platform workers.

## 14. Migration, complete regression and clean tracked source

Isolated PostgreSQL upgraded to `cd03ef05ab06` (single head). Separate old-head
fixture snapshot for Scene/SceneVersion/Asset/Job/UploadSession remained byte-for-byte
JSONB-identical through upgrade → downgrade → upgrade. Only two new tables were
introduced; production old rows/DB were untouched.

Required commands run with explicit isolated database/storage:

- Backend: ruff app/tests PASS; mypy app PASS (94files); final full pytest
 479PASS, zero skips, 19 upstream deprecation warnings, 599.92s/GATE_EXIT0
 (including tracked-release migration/preflight tests).
- Workers: final local suite125PASS, zero skips; clean fresh API-only environment
 106PASS/19SKIPPED (optional prebuilt binaries/GPU fixtures), explicitly not called PASS
 for those skipped cases. The local full suite covers them separately.
- Web: pnpm typecheck/lint/test/build; 267 unit tests PASS, six editor boundary tests.
- Real browser: full Editor/private source, actual PLY+SOG exports, two UI upload/
  publication/Viewer tests PASS; extra Streamed import/edit and ordinary SOG import.
- Editor tracked-source independent gate: PASS/GATE_EXIT0; official fixed SHA,
  lockfile install, build, MIT/notices/checksums, subpath files and start/stop.
- `verify_release_source.sh --from-commit d40c568 --keep`: PASS/GATE_EXIT0, fresh
  tracked archive/venvs/import/lint/types/tests, unchanged reconstruction contract,
  actual A6000 CUDA rasterization (85 lit pixels / 8 splats). No pre-existing
  failures are silently relabelled. Archive: `/tmp/gsplatform-verify-6sDWC5`.
- Independent Editor final-code archive: `/tmp/gsplatform-editor-verify-MnUrzy`,
  PASS/GATE_EXIT0; build timestamp `2026-10-11T10:15:06.144003+00:00`, same verified
  artifact identity `e994c6c327c5e4d3898d25c0ff649ecf3d1cd16efc625faecb9a904a7db188ab`.

Final full/clean gate recording: **PASS, GATE_EXIT=0** on executable-code
candidate `d40c56857894a46e8c491b88ddd2ac7900d553e7`. Final local logs:
`backend-code-final.log`, `workers-code-final.log`, `web-code-final.log`,
`editor-code-final.log`, `clean-code-final.log` and
`real-idempotency-code-final.log` in `/tmp/gsplatform-p3-evidence`.
The subsequent acceptance/roadmap commit changes documentation only, not tested
code, dependencies, scripts, migrations or recipes. Final HEAD/origin/push proof
is recorded in the final handoff and private `git-final-receipt.json`.

## 15. Compatibility, rollback, exclusions and final review

Read-only `u-06924576399e`: current still `01c63c7c-8eb5-498e-bcc0-77215e92ca12`,
asset `da7bf4207044`, 13,090,324 points,259chunks. Production DB snapshot and four
version metadata SHA/size/mtime match Phase2 evidence. No 3.2GiB conversion,
old collision restart, current pointer write, deletion or destructive browser edit.
Viewer1.35/Engine2.22.4/Transform3.3.3/LOD recipes, Viewer wrapper/Experience v2,
WebXR implementation, reconstruction/torch/gsplat/CUDA, Agriculture and voxel
algorithms were not changed. PICO Neo3 hardware remains NOT EXECUTED, not a PASS.

Rollback disables Editor launch, preserves audits/exports/immutable history and
reverts the independent artifact/compatible code. Do not downgrade populated audit
tables, overwrite old version files or directly repoint current. Production needs
explicit backup/migration/deployment approval in the documented order.
Pre-P3 API binaries are not compatible with pending linked exports or STALE edited
current versions: retain the P3-aware safety projections until a reviewed rollback.

Remaining limitations: original PLY may be absent; one declared Streamed LOD only;
manual export/return (no public stable auto-save API assumed); no 13M browser-memory
or PICO test; no automatic spatial revalidation; browser-specific native File System
Access dialog not automated; optional poster CLI was skipped without blocking the
valid Gaussian artifact. No production deployment, third-party Gaussian upload,
Viewer replacement, Editor algorithm fork or Phase4/agriculture implementation.

P3-A PASS; P3-B PASS; P3-C PASS; P3-D PASS. PC-INTEGRATION-03 PASS.
Official self-hosted Editor, owner-cookie private loading, genuine export → immutable
same-Scene versions and existing official Viewer are verified, with no implicit
third-party upload, concealed LOD downgrade, newer-version overwrite or auto collision.
Phase4 may start only after user Git/functionality review, never automatically.
