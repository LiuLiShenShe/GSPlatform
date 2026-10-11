# VR-00 — Full Platform Deployment Baseline & WebXR Readiness

## 1. Scope, date and decision

- Acceptance date: 2026-10-11, Asia/Shanghai. This report covers **VR-00 only**.
- Acceptance environment: **ISOLATED_STAGING**, not the existing shared development
  deployment and not a production cutover.
- Final decision: **PASS — isolated staging software baseline**. Software,
  browser, security, actual lifecycle and final regression gates pass. This does
  not declare the old shared deployment or physical PICO acceptance current.
- Physical PICO Neo3 acceptance, binocular rendering, 6DoF, controller movement,
  teleport, large-scene performance and Collision Walk: **NOT EXECUTED**.
- No renderer, Viewer/Editor upstream source, SOG algorithm, LOD, collision default,
  navigation feature, agricultural module or dependency pin is changed.

## 2. Git baseline and authority

- Starting HEAD / initial `origin/main` / initial remote main:
  `5421879b78135dc8a312ff5929057f0da8f95022`; branch `main`.
- Starting worktree is **not clean**: 89 tracked documentation deletions and the
  untracked user-provided `docs/GSPlatform_WebXR_VR_Master_Plan.md`. These remain
  untouched and are not included in VR-00 commits.
- The master plan is read from that actual user file, not regenerated. This task
  executes its VR-00 scope; its broader sprint wording does not authorize VR-01.
- The requested architecture, roadmap, PC-INTEGRATION-02/03/03.1 reports and Editor
  operations guide are read from `git show <starting-HEAD>:<path>` because those
  tracked files are among the user's existing deletions.
- Deployment/systemd/scripts, configuration, Alembic, Vite, Celery, Editor pin and
  existing startup scripts are inspected before provisioning.
- Implementation commits:
  `7a2ce29ff4d6e1bee616bc0950251e4bd0d4f6c7` (isolated launcher/proxy and durable
  login), `bba193d06952ab77b7e4b110a81f23b026ee8513` (owner GET/share readiness),
  `4482ce64f5f6018cd069eb520233f7b9d19c73d5` (stable process identity).
- No reset, clean, force push, branch creation or staging of unrelated deletions.

## 3. Actual source and original runtime

- Source directory: `/fj/GSPlatform`. `/opt/gsplatform/current` is absent; no
  project systemd unit is managing this checkout.
- Original APIs remain on 8001 and 8011, with development identity bypass enabled.
  Their uptime predates the starting HEAD; Git HEAD alone is not runtime evidence.
- Original publish/CPU/GPU workers use shared Redis 6379. Original CPU and GPU
  workers share `celery@test`, producing a duplicate-nodename warning.
- Original Editor is an independent process on 18031. An old legacy XR static
  server on 5180 is left untouched and is **not used** by the accepted platform.
- The original tunnel to 5173 is unavailable and retained, not repurposed/stopped.
- Original shared database `gsplatform` is at `f6a7b8c9d0e1`, not the current head.
  It is **NOT MIGRATED** and its workers are **NOT RESTARTED**.
- Shared persisted jobs: 16,870 queued, 76 running, 427 failed, 975 succeeded.
  Actual worker active/reserved lists and broker queue lengths were empty at
  inspection. Persisted rows are not treated as permission to recover/clean them.
- Original infrastructure/service processes remain alive after staging shutdown.

## 4. Proven staging isolation and database identity

| Item | Actual value |
| --- | --- |
| Environment classification | ISOLATED_STAGING |
| Runtime code | `/fj/GSPlatform` |
| Private state | `/home/test/.local/state/gsplatform-vr00-20261011` |
| Runtime database / restricted role | `gsplatform_vr00_20261011` |
| Backend test database | `gsplatform_vr00_tests_20261011` |
| Worker / final backend test database | `gsplatform_vr00_workers_20261011` |
| Clean-checkout database | `gsplatform_vr00_clean_20261011` |
| Runtime storage | private state `storage/` |
| Authorized scene origin | private state `scene-origin/` |
| Broker / results / rate limiter | dedicated loopback Redis 16384, DB 0 / 1 / 2 |
| Native API / Vite / proxy | loopback 18001 / 5175 / 5174 |
| Runtime security mode | `GS_ENV=production`, identity bypass false |

The role is not superuser and cannot create databases or roles. Database names,
storage root and broker are checked against the private isolation receipt before
startup. Credentials live only in owned mode-600 environment/account/session files
inside the mode-700 state directory. Test suites use separate database/storage and
broker settings, not the shared application database. A Redis rate-limit unit test
uses isolated transient keys in shared Redis DB 15 and removes its own keys.

## 5. Database migration and recoverability

- PostgreSQL 16.13 is reachable on the existing server/container; dedicated role
  and actual `current_database()` are verified, not inferred from configuration.
- Each new database has a pre-migration `pg_dump` backup outside Git before
  `alembic upgrade head`; no shared schema/data is upgraded.
- Single continuous repository head: **`cd03ef05ab06`**.
- Relevant chain: `f6a7b8c9d0e1` → `ab02cd03ef04` → `bc03de04fa05` →
  `cd03ef05ab06`. Current equals head in the staging/test databases.
- Staging retained rows after smoke: 5 users, 2 scenes, 2 SceneVersions, 1 Job,
  1 UploadSession. Its only persisted job is a successful PUBLISH.
- A populated custom-format runtime snapshot is also saved after smoke outside
  Git; `pg_restore --list` validates the 67,072-byte snapshot without restoring it.
- Original shared counts remain unchanged: users 6,295; scenes 21,911;
  SceneVersions 19,104; jobs 18,348; UploadSessions 260.
- No database drop/truncate, user-asset deletion, shared upload cleanup, historical
  current-version change or restore is performed.

## 6. Redis, queues, workers and maintenance

- Dedicated `gsplatform-vr00-redis-20261011`: loopback 16384, persistent AOF volume,
  restart policy `unless-stopped`; PING succeeds. Shared Redis 6379 is unchanged.
- `vr00-publish@test`: queue `gsplatform`; `vr00-cpu@test`: queue `cpu`;
  `vr00-gpu@test`: queue `gpu`. All reply to inspection with distinct nodenames.
- Registered `tasks.publish_scene` and `tasks.build_collision` are confirmed.
  Routes remain authoritative from `workers/celery_app.py`:
  publish/cleanup/recovery → `gsplatform`; collision/CPU stages/finish → `cpu`;
  training → `gpu`. Registering all tasks does not mean all queues are consumed by
  every worker; actual active queues are inspected separately.
- Active and reserved lists are empty at idle lifecycle checkpoints. Workers'
  PID, cwd, database, broker, security flags and build version are inspected from
  `/proc`, without logging passwords or full connection strings.
- One managed Beat schedules existing `tasks.cleanup_expired_uploads` every
  21,600 seconds on `gsplatform`; no second scheduler is started on repeat `up`.
- Actual isolated maintenance task succeeds: expired 0, edited exports cleaned 0,
  scenes checked 2, collisions ensured 0. Before dispatch, automatic collision
  policies/enabled collisions are confirmed absent. No shared cleanup is run.
- Collision remains **MANUAL_ONLY**. CPU collision consumption is ready but no
  acceptance collision build is enqueued; missing collision does not block XR.

## 7. Official SplatTransform and reconstruction capability

- Locked official CLI: **`@playcanvas/splat-transform 3.3.3`**; actual CLI reports
  `splat-transform v3.3.3 (d092ae9)`. CPU/GPU runtime discovery resolves this pin.
- Installed contract: torch `2.14.0+cu126`, gsplat `1.5.3`, CUDA runtime `12.6`;
  driver `590.48.01`; two NVIDIA RTX A6000 devices.
- COLMAP `3.9.1`, FFmpeg/ffprobe `6.1.1` are detected.
- Existing `verify_reconstruction_runtime.py --allow-no-gpu` exits 0: imports,
  exact versions, trainer `--help`, CUDA availability and real tiny gsplat CUDA
  rasterization pass. Fresh-venv contract verification also runs in clean checkout.
- GPU worker is online on `gpu`; **no full reconstruction/training job is run**.
  Capability/queue readiness is not a claim that a production training workload
  has completed. Viewer readiness does not depend unconditionally on that workload.
- No PlayCanvas, Viewer, Editor or SplatTransform version is upgraded.

## 8. FastAPI and real HTTP readiness repairs

- Actual `/health/live` and `/health/ready` return 200 locally and through HTTPS.
  Readiness performs a PostgreSQL round-trip; a listening socket alone is not PASS.
- Scene, owner works, upload/resume/status, runtime descriptor, processing policy,
  authorized immutable chunks and Editor session/source APIs are exercised.
- Three genuine deployment defects are reproduced and repaired narrowly:
  1. Login/register returned cookies before the database session committed; the
     immediately following real `/auth/me` could return 401. Sessions now commit
     before cookie issuance; two independent-transaction tests cover both routes.
  2. Read-only `/me/scenes` and owner job GETs incorrectly required a mutation
     CSRF header while the browser intentionally sends it only for mutations.
     These GETs use authenticated owner identity; mutating routes still require
     CSRF. Two real-session GET tests cover the correction.
  3. Share create/revoke returned success before persistence. A real immediately
     opened share returned 404; revocation could remain temporarily readable.
     Those endpoints now commit before returning; two independent-transaction
     regression tests cover creation and revocation.
- Test failures are recorded before fixes; no retries or disabled access policy
  are used to disguise those defects.

## 9. Web and one official Viewer runtime

- React/Vite uses relative `/api/v1`, not headset `http://localhost:8001`.
- `@playcanvas/supersplat-viewer 1.35.0`, Web PlayCanvas `2.22.4`, official
  `SuperSplatRuntime` and existing Experience Settings v2 adapter are retained.
- Real HTTPS browser UI login, `/`, `/upload`, `/works`, desktop scene, `/xr/test`
  and the formal uploaded-scene XR route pass. The upload form and published
  work card are actually present; HTML status alone is not sufficient evidence.
- Desktop and XR use the same immutable content URL/version and official runtime.
  The tested browser renders `webgl2`, with real Gaussian counts greater than zero.
- No second Viewer, old `apps/viewer` or removed `apps/xr-viewer` is reintroduced.

## 10. Official SuperSplat Editor deployment

- Existing independent Editor on 18031 is borrowed, not rebuilt or algorithmically
  modified. `editor.sh verify` and `editor.sh health` pass against the real cache.
- Fixed tag: `v3.5.2`; fixed SHA:
  `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`.
- Build receipt timestamp: `2026-10-11T08:00:57.323374+00:00`; Node `24.16.0`;
  npm `11.13.0`; artifact SHA256:
  `e994c6c327c5e4d3898d25c0ff649ecf3d1cd16efc625faecb9a904a7db188ab`.
- Pinned package-lock/license digests, MIT license files, complete recorded static
  artifacts and HTML/JS/CSS/WASM health pass. HTTPS browser loads the real Editor
  application and canvas, rather than merely rendering a launch link.
- Owner browser read-only import also passes: the genuine same-origin Editor
  source session imports selected LOD 0 and displays **1,788 splats**, without
  edits/export/publish, external network requests or uncaught page errors.
- This pinned Editor requires a **WebGPU-capable desktop browser**. A WebGL-only
  SwiftShader test initially showed a startup failure; the existing Vulkan/WebGPU
  browser profile succeeds. The base canvas check alone was not counted as this
  functional import evidence. PICO's WebGL Viewer is not required to run Editor.
- Real owner source-info/session/download returns 200/201/206. Anonymous and other
  users are denied; a viewer share grant never grants Editor private downloads.
- Source responses are `private, no-store`; version mismatch is denied. CSP retains
  `connect-src 'self' blob:` and self-hosted scripts; `/api/id` is disabled (404).
  No file transfer to `superspl.at` is observed. The existing inline-service-worker
  CSP warning does not authorize relaxing CSP.
- Full Editor edit/export/republish E2E: **NOT EXECUTED**, not required by this task.

## 11. HTTPS, same-origin proxy and actual URLs

**Temporary acceptance origin, not a production domain:**
`https://residence-criterion-primarily-dee.trycloudflare.com`

| Entry | Actual address |
| --- | --- |
| Local Web | `http://localhost:5174` |
| HTTPS | `https://residence-criterion-primarily-dee.trycloudflare.com` |
| Upload | `https://residence-criterion-primarily-dee.trycloudflare.com/upload` |
| Works | `https://residence-criterion-primarily-dee.trycloudflare.com/works` |
| XR diagnostics | `https://residence-criterion-primarily-dee.trycloudflare.com/xr/test` |
| Real uploaded scene XR (owner login) | `https://residence-criterion-primarily-dee.trycloudflare.com/xr/u-a68b94d84538` |
| Historical read-only scene XR entry | `https://residence-criterion-primarily-dee.trycloudflare.com/xr/u-06924576399e` |
| Official Editor | `https://residence-criterion-primarily-dee.trycloudflare.com/gaussian-editor/` |

- Quick Tunnel forwards only to staging Nginx 5174. Repeated `up` preserves its
  managed PID; a real down/up changes hostname and requires redistributing URLs.
- Nginx proxies API 18001, Editor 18031 and Vite 5175. Its internal scene-origin
  location materializes authorized `X-Accel-Redirect`; a Vite-only production API
  proxy would incorrectly return an empty successful asset response.
- The dedicated Nginx configuration/container does not overwrite production
  Nginx/systemd. Published files are read-only mounts; no public private-file alias.
- TLS verification is enabled; browser `isSecureContext=true`. Session cookies:
  Secure, HttpOnly, SameSite=Lax. CSRF cookie: Secure, JS-readable, SameSite=Lax;
  matching headers are still mandatory on mutations. Share cookie is Secure/HttpOnly.
- Browser observes no mixed-content request or API request to headset localhost.
  WebSocket upgrade forwarding is configured for Vite HMR. Authorized chunk Range
  returns 206 and correct Content-Range; same-origin relative chunk paths work.
- Quick Tunnel availability is **not** permanent-domain/SLA or 13M concurrency and
  performance acceptance. No stable production hostname was provisioned.

## 12. Existing scenes and 13M strictly read-only verification

- `local-garden`: real browser official Viewer loaded, `webgl2`, 500 Gaussians;
  only this repository sample is allowlisted on `/local-scenes/` for `/xr/test`.
- Historical scene: `u-06924576399e`; scene UUID
  `e2f54542-40a1-494f-b260-ad8fd28156e6`; current SceneVersion UUID
  `01c63c7c-8eb5-498e-bcc0-77215e92ca12`; asset `da7bf4207044`.
- Content: `/api/v1/scenes/u-06924576399e/assets/versions/da7bf4207044/lod-meta.json`.
  Counts: **13,090,324 / 3,927,097 / 1,309,032**; all 259 chunk metadata files and
  all 1,813 referenced texture files exist. Metadata HTTP 200/Range 206 works.
- Original DB current-version/manifest/asset identity matches before/after snapshot;
  canonical manifest SHA256:
  `cb8e286e24e8596f52995f091a4868bf5e252c96ffedde29cbcc389f95ee622e`.
- The staging catalog contains a new **read-only reference** to the existing public
  immutable files: new isolated metadata, inactive owner and read-only Nginx bind.
  This is not a new publish, conversion, copied SOG upload or original DB update.
- No 13M conversion, collision build, historical file deletion or current-version
  update. Full 13M browser/PICO performance rendering: **NOT EXECUTED**.

## 13. Small real Gaussian upload smoke

- Input is an existing real gsplat-trained Gaussian PLY, read only; **not a copied
  SOG**. 1,788 Gaussians, 100,488 bytes; SHA256:
  `b2cc7bb1594d33ffe496481f5c992ffca83b1d14b259839da3389b7224663db3`.
- Real isolated account registration/login → resumable UploadSession → two binary
  PATCH chunks → HEAD offset → SHA validation/complete → real Celery publish →
  official SplatTransform 3.3.3 → Streamed SOG → immutable SceneVersion.
- Upload: `a09fedab-6cce-498a-8967-eb4b37b127c6`; actual successful publish job:
  `50e9d6a7-6158-402c-bf86-82dcb6a9a62d`.
- Scene: `u-a68b94d84538`; scene UUID
  `5f10e536-e86b-44f7-bdec-5e3a667eebc7`; SceneVersion UUID
  `68cb9e7b-11a5-44d8-9070-e146b9e55aba`; asset **`c10c127b4574`**.
- Streamed counts: 1,788 / 536 / 179. Desktop renders official `webgl2`, format
  `lod-meta`, no manifest fallback and no error. The first origin's probe reports
  1,788 Gaussians; final-origin first-frame evidence reports **179** (coarsest LOD).
  Both are real positive rendered counts, not an assertion that every frame loads
  LOD 0. Formal XR at the final origin reports **1,788**.
- Upload and publish status SUCCEEDED; exactly one persisted PUBLISH job and no
  COLLISION job. Policy MANUAL_ONLY; calibration UNVERIFIED; collision optional.
- Upload protocol is real HTTP software E2E; the browser upload form is separately
  verified. This is not the VR-01 three-size performance campaign or PICO acceptance.

## 14. Formal XR software and security regression

- `/xr/test`: secure context true, loaded true, official `webgl2`, 500 Gaussians,
  Enter VR control present.
- **Formal `/xr/u-a68b94d84538`**: ready/loaded, 1,788 Gaussians, `webgl2`, exact
  uploaded SceneVersion content URL shared with Desktop, `lod-meta`, no fallback,
  Enter VR control present. Collision absent and Walk false do **not** block loading.
- Desktop headless browser has no headset: immersive-vr unsupported, canStartVR
  false and Enter VR disabled. This expected capability result is not a PICO PASS.
- Real HTTPS security checks: anonymous private descriptor/assets/textures 401;
  other user 403; owner descriptor/chunks 200 and texture Range 206.
- Private static shortcuts 403; internal-origin direct requests 404; unknown version
  and published `source.ply` 404; real staging `upload.bin` and private environment
  via Vite `/@fs/` 403. HTML SPA fallbacks are not mistaken for leaked file bytes.
- Owner Editor source 206; anonymous 401, other user 403, cross-version 404. Share
  grants permit authorized scene reads but never Editor downloads; after revocation
  descriptor and texture reads immediately return 401. Mutation without CSRF is 403.
- Browser page errors: none; insecure HTTP asset/API requests: none. Private source
  is not moved into a public static directory for headset convenience.

## 15. Backend / workers / web regression gates

| Gate | Actual status / evidence |
| --- | --- |
| Backend `ruff check app tests` | PASS, exit 0 |
| Backend `mypy app` | PASS — 94 source files, exit 0 |
| Backend `pytest tests -q` | PASS — 519 tests, 0 failures, 0 skips, 1,323.302 seconds |
| Workers `pytest workers/tests -q` | PASS — final source 125 tests, 0 failures, 0 skips, 188.23 seconds |
| Web `pnpm typecheck` | PASS, exit 0 |
| Web `pnpm lint` | PASS, exit 0 |
| Web `pnpm test` | PASS — 28 files / 267 tests, exit 0 |
| Web `pnpm build` | PASS, exit 0; existing large-chunk warning |
| Editor receipt/static/browser/private source | PASS; full editing E2E NOT EXECUTED |
| Browser software / security | PASS at acceptance origin; physical tests NOT EXECUTED |
| Actual up/up/down/down/up/up lifecycle | PASS after process-title repair |

The final installed-runtime backend gate covers committed implementation
`4482ce64f5f6018cd069eb520233f7b9d19c73d5`; all three exit codes are 0.
Initial Web tests were run with the deployment-only `VITE_API_BASE_URL=/api/v1`
exported; one annotation test expects its default localhost API URL and failed.
Rerun with that variable unset passes all 267 tests. The deployment build retains
relative API configuration; no unrelated test expectation is rewritten. Earlier
backend 512/514-test passes and red/green readiness tests are retained as history,
not substituted for the final source gate. Starlette deprecation and bundle-size
warnings are disclosed, not treated as new unrelated fixes.

## 16. Clean-checkout gate and evidence receipts

- Exact existing `./deploy/scripts/verify_release_source.sh` is run on committed
  source, with dedicated test database/storage and no shared database operations.
- Prior gate on `7a2ce29…`: PASS, exit 0, including fresh dependency install,
  imports, ruff/mypy, backend tests, workers 106 PASS / 19 SKIP and fresh CUDA
  rasterization. Skip results are not labelled executed passes.
- Final source clean-checkout on
  `4482ce64f5f6018cd069eb520233f7b9d19c73d5`: **PASS**, exit 0. Fresh imports,
  ruff/mypy, backend/worker tests and the separate fresh reconstruction venv with
  real CUDA rasterization pass.
- The clean archive explicitly reports **8 backend SKIP** (3 missing Git worktree,
  1 reconstruction contract tested in its separate venv, 4 missing Web dist) and
  **106 worker PASS / 19 SKIP** (missing archive CLI/node_modules/Git history).
  Installed-runtime backend **519 PASS / 0 SKIP** and workers **125 PASS / 0 SKIP**
  separately cover those available dependencies; archive skips are not relabelled.
- Gate aggregate **`GATE_EXIT=0`**. The final report commit changes documentation
  only; it is not falsely represented as a second source-code clean gate.
- Raw evidence is outside Git in the private state directory: separate API/Web/
  Worker/Beat/proxy/tunnel logs, JUnit backend/worker receipts, runtime/database
  snapshots, original-scene before/after, `smoke.json`, `browser.json`,
  `security.json`, `history.json`, `maintenance.json`, lifecycle and gate exit files.
  Account/cookie files are private and are not attached to this report.

## 17. Lifecycle, ownership and operational commands

```bash
cd /fj/GSPlatform
./scripts/gsplatform-vr.sh up
./scripts/gsplatform-vr.sh status
./scripts/gsplatform-vr.sh urls
./scripts/gsplatform-vr.sh logs
./scripts/gsplatform-vr.sh down
```

- Reuses Uvicorn, Vite, Celery, official Editor health/verify and Nginx/cloudflared;
  no generic production process framework or competitive production Worker group.
- `flock` serializes lifecycle operations. `up` retains owned services and refuses
  unproven isolation, foreign worker receipts or occupied unmanaged application ports.
- Receipts check UID, PID start-time and executable device/inode. pidfd SIGTERM
  avoids numeric PID reuse. A process-title change cannot identify a different PID;
  a new regression reproduces Vite-style mutable command-line titles. Legacy
  receipts retain strict command-digest verification until safely replaced.
- The initial actual shutdown failed closed after Vite changed title; it did not
  kill a foreign process. After the narrow repair, full real repeated startup,
  idle inspection, shutdown/repeated shutdown and startup pass.
- `down` refuses active/reserved or unavailable Worker inspection, sends no force
  kill, and leaves slow draining explicit. Shared PostgreSQL/Redis/Editor/workers/
  original tunnel are untouched; staging Redis remains up. API/Web/worker logs are
  separate. API/Nginx access logging is off so share/session capabilities are not
  copied into access logs.
- See `docs/operations/VR_00_STARTUP.md`. This is temporary managed development
  staging, not systemd boot supervision or a production deployment claim.

## 18. PICO next-step checklist — NOT EXECUTED here

1. Review this Git diff, report, current launcher status and actual HTTPS URL.
2. On PICO Neo3's browser, open the HTTPS root; log in with the isolated owner
   account from the local mode-600 `test-accounts.json` (do not send it in Git/chat).
3. Confirm `/works` and `/upload`; visit `/xr/test`, then the real uploaded-scene
   `/xr/u-a68b94d84538`, not only the diagnostic sample.
4. Record PICO/browser version, secure context, navigator.xr and immersive-vr
   capability before attempting Enter VR. Record binocular display, 6DoF, exit/
   re-entry separately in explicitly approved **VR-01**, with actual user feedback.
5. Do not enable collision, re-convert 13M, develop movement/teleport/menu or claim
   performance acceptance as part of VR-00. The test asset here has 1,788 Gaussians;
   it does not replace VR-01's planned small/medium/large hardware cases.

## 19. Blockers, limitations and final component matrix

| Component | Status / scope |
| --- | --- |
| Git | CURRENT implementation source; user worktree changes preserved |
| Database | CURRENT in isolated staging; shared original database NOT MIGRATED |
| PostgreSQL / Redis | READY for staging identities |
| FastAPI / Web | READY at staging origin |
| Celery Publish / Collision | READY queues/registration; publish actually completed |
| Celery GPU / CUDA | READY capability/queue; full training NOT EXECUTED |
| Scheduled Recovery | READY scheduler + real isolated maintenance proof |
| Official SplatTransform | READY, pinned 3.3.3, real conversion completed |
| SuperSplat Viewer / Editor | READY software/browser/static/source access |
| HTTPS / formal XR page | READY temporary origin, no physical-headset claim |

There are **no remaining required staging software blockers**. The shared original
environment needs a separately authorized backup/migration/drain/cutover;
it is not silently declared current. Quick Tunnel may change/expire and is not
qualified for 13M request concurrency. Processes are not production boot-supervised.
Pre-existing deleted docs leave the user's working tree dirty by design. No
physical PICO evidence is available. These limitations are not concealed as ALL
READY for production or as completed VR-01 acceptance.

The original PostgreSQL/Redis containers' existing wildcard host-port exposure is
unchanged, not reconfigured or certified as production network hardening by VR-00.
The new Redis and staging entry services are loopback-only behind the HTTPS tunnel.

## 20. Final Git identity, sources and stopping point

- Final tested implementation HEAD: `4482ce64f5f6018cd069eb520233f7b9d19c73d5`.
- Final report HEAD is the commit containing this document; resolve exactly with
  `git log -1 --format=%H -- docs/reports/VR_00_DEPLOYMENT_BASELINE.md`. A report
  cannot embed its own future Git object hash. The final CLI result and private
  final Git receipt contain the resolved exact HEAD and push outcome.
- Runtime API/Worker build identity is verified separately after final startup;
  pin receipts identify the unchanged official Editor artifact independently.
- Source authority: the supplied master plan, requested tracked project docs,
  current repository routes/migrations/locked packages and measured local/HTTPS
  process/database/browser results. Context7 official SuperSplat Viewer/Editor
  documentation was retrieved; Bocha search returned HTTP 403 (unavailable), not
  silently treated as a successful search or replaced with an invented result.
- Official upstream sources: https://github.com/playcanvas/supersplat-viewer and
  https://github.com/playcanvas/supersplat. Repository:
  https://github.com/LiuLiShenShe/GSPlatform.
- Stop at VR-00 software readiness. **Do not begin VR-01** until user review and
  actual PICO feedback; no headset PASS is claimed by this report.

**VR-00: PASS (ISOLATED_STAGING software)**

**GSPLATFORM RUNTIME READY**

**OFFICIAL PLAYCANVAS COMPONENTS READY**

**HTTPS WEBXR ENTRY READY — TEMPORARY TEST ORIGIN**

**READY FOR VR-01 PHYSICAL PICO ACCEPTANCE AFTER USER REVIEW**
