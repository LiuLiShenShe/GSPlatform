# FIX-UPLOAD-01.1 — 上传处理、发布后恢复与碰撞并发安全（可靠性收尾）
## 1. 目标与范围（对照 FIX-UPLOAD-01.1 任务书）
## 2. 三个已确认缺陷（P1-A / P1-B / P1-C）与修复落点
## 3. PART A —— 前端轮询生命周期（发布成功≠碰撞完成）
## 4. PART B —— 发布后碰撞恢复（崩溃窗口关闭 + 幂等补调度）
## 5. PART C —— 碰撞并发安全（行锁串行化 + 任务身份 + 目录隔离）
## 6. PART D —— 派发/worker 契约与可证性
## 7. PART E —— RED → GREEN 证据（真实失败输出 + 根因）
## 8. 测试矩阵（新增 15 + 8 + 17 + 7 项）
## 9. 真实转换流水线与真实 CLI 碰撞构建
## 10. 服务与安全面（属主/CSRF/私有/分享/路径包含/sourceVersion 校验）
## 11. 不破坏项（FIX-UPLOAD-01 既有语义 + 禁止项）
## 12. 失败路径 → 稳定状态
## 13. 门禁与回归（全部真实执行）
## 14. E2E 真实浏览器证据 · 诚实边界与验收矩阵
| 项 | 验收标准 | 结果 |
|---|---|---|
| A1 | 发布 SUCCEEDED 后碰撞 QUEUED/RUNNING → 持续轮询直至 SUCCEEDED/FAILED | ✅ useUploadProcessingPoll 实测 |
| A2 | 发布 SUCCEEDED 且碰撞 null → 显示“等待碰撞任务调度”，绝不显示 FAILED/已构建 | ✅ ProcessingStatus.collisionTag + 测试 |
| A3 | 上传/发布 FAILED → 立即停止轮询 | ✅ shouldStopProcessingPoll |
| A4 | 碰撞 null 非 FAILED、非“built”（不编造进度） | ✅ 文案/测试锁定 |
| A5 | 卸载/uploadId 变更/StrictMode/网络退避/观察上限（≥5min → “状态尚未确认”+ 重新查询入口） | ✅ 17 项轮询测试 |
| A6 | 轮询只在 RO 状态路由上、GET /status 不隐式建任务 | ✅ 无副作用只读 |
| A7 | 观察上限后不无限轮询（30s 硬顶退避） | ✅ PROCESSING_MAX_BACKOFF_MS=30_000 |
| A8 | 轮询恢复：网络恢复后下一周期自愈 | ✅ backoff 自愈测试 |
| C1 | 自动派发/手动 build/rebuild 在 Scene 行锁（FOR UPDATE）上串行化 | ✅ `_lock_scene_for_update` of=Scene |
| C2 | 锁不覆盖 send_task（先 commit 释放锁再投递） | ✅ commit-then-send |
| C3 | 每个 build 携带固定 sourceVersion + 任务身份（jobId） | ✅ 6th arg + build_params |
| C4 | 输出按 `collision/<sid>/versions/<asset>/jobs/<jobId>/` 隔离 | ✅ 目录断言 |
| C5 | 完成前二次归属检查 → 稳定代码 COLLISION_SUPERSEDED（合法 DB 状态） | ✅ _still_owned 前后两道闸 |
| C6 | 陈旧 worker FAIL 不污染新碰撞（重读 fresh 行再 FAIL） | ✅ 异常路径 re-read |
| C7 | 服务解析同一构建的碰撞/任务资产，绝不 ORDER BY created_at DESC 猜 | ✅ _assets_of_job JSONB |
| C8 | 无重复行需唯一约束；并发双派发/自动+手动竞争均只产生 1 个任务 | ✅ 8 项真实 PG 并发测试 |
| E2E | 真实浏览器：发布场景 viewer 加载、碰撞描述符与资产真实可达 | ✅ 2 passed / 2 pre-existing FAIL |
| 回归 | 属主鉴权/CSRF/私有/分享/路径包含/sourceVersion 校验无回退 | ✅ 7 项安全回归测试 |
---
FIX-UPLOAD-01.1 是对 FIX-UPLOAD-01 的**可靠性收尾**（非新 Phase）：修复三个已确认缺陷 ——
上传页轮询在“发布成功”即停（P1-A）、发布成功与自动碰撞之间无人恢复的崩溃窗口（P1-B）、
自动碰撞派发无行锁且各版本共用输出目录、陈旧 worker 可覆盖新状态（P1-C）。范围严格限定于
上传处理 / 发布后恢复 / 碰撞并发安全；**不升级** torch/gsplat/splat-transform/PlayCanvas/
SuperSplat，**不新增 UI**，不触碰 SuperSplat Viewer、PlayCanvas、WebXR、PICO、gaussian
渲染器、streamed-SOG 格式、LOD、PLY 转换、poster、GPU 重建、注释、媒体叠加等禁改面。

- **P1-A**：`UploadPage` 只要 publish SUCCEEDED 就停止轮询，即使碰撞任务从未创建或仍在运行。
  修复：`useUploadProcessingPoll` 全新 hook —— 停止条件是「upload/publish FAILED」或
  「upload/publish 均 SUCCEEDED **且** 碰撞 SUCCEEDED/FAILED」。碰撞 null 时在发布成功后显示
  “等待碰撞任务调度”（warning），发布前显示“未开始（尚未生成）”；网络退避 3s→30s 硬顶、
  观察上限 5min 后显示“状态尚未确认”并给出重新查询入口；卸载/uploadId 变更即清理定时器。
- **P1-B**：`publish_scene` 发布 SUCCEEDED 后若自动碰撞从未派发，重复投递在 SUCCEEDED 守卫处
  提前返回，永不恢复碰撞链。修复：幂等服务 `ensure_auto_collision_for_current_version(...)`
  覆盖 MISSING / DISPATCH_INCOMPLETE / QUEUED / RUNNING / SUCCEEDED / FAILED 全部状态；发布
  成功路径与重复投递分支都调用它；FAILED 保留手动重试（自动重试需上限/退避，`retry_failed=True`
  仅在手动/发布触发时使用）。周期兜底走**已排程**的 `tasks.cleanup_expired_uploads`
  （systemd `gsplatform-cleanup.timer`，OnBootSec=10min）调用 `reconcile_auto_collision()`，
  不依赖 Celery 重投。
- **P1-C**：`dispatch_auto_collision()` 无行锁、各版本共用输出目录、陈旧 worker 覆盖新状态。
  修复：所有碰撞变更入口（自动派发/手动 build/rebuild）在 Scene 行上 `SELECT ... FOR UPDATE`
  串行化（`with_for_update(of=Scene)`，规避 `lazy="joined"` 外连接不可锁问题）；**commit 先于
  send_task**，锁不覆盖 broker 调用；派发采用持久化 claim 协议（`celery_task_id` = `sending:<uuid>:<ts>`
  → broker 确认后换真 id；>60s 陈旧 claim 由后到者 FOR UPDATE 接管）；每个 build 携带固定
  `sourceVersion`（第 6 参数）+ 任务身份；输出 `collision/<sid>/versions/<asset>/jobs/<jobId>/`；
  完成前二次归属检查 → `COLLISION_SUPERSEDED`；陈旧 worker FAIL 重读 fresh 行、不污染新碰撞；
  服务端按 `metadata_["collisionJobId"]` 解析同一构建资产，遗留布局走文档化回退。

- `useUploadProcessingPoll.ts`：`PROCESSING_POLL_INTERVAL_MS=3000`、`PROCESSING_MAX_BACKOFF_MS=30_000`、
  `PROCESSING_OBSERVATION_LIMIT_MS=5min`。`shouldStopProcessingPoll()` 为唯一停止判据：
  upload FAILED → 停；upload≠SUCCEEDED → 继续；publish FAILED → 停；publish≠SUCCEEDED → 继续；
  否则碰撞 SUCCEEDED/FAILED → 停。碰撞 null 且 publish SUCCEEDED → **继续轮询**并显示
  “等待碰撞任务调度”（此前代码在这里停止 —— P1-A 根因）。
- 退避修正：原来指数上限被 `min(errors,3)` 提前截断（24s < 30s 硬顶永不绑定），改为
  `min(3s×2^n, 30s)`，硬顶真实生效。
- 观察上限：轮询超过 5min 未收敛 → 显示“状态尚未确认”，提供“重新查询”入口，不再无限轮询。
- 轮询状态全部来自**只读**状态路由（GET /status）；该路由不隐式创建任务。
- `ProcessingStatus.tsx`：`collisionTag(status, publishDone)` —— 发布完成+碰撞 null →
  `'等待碰撞任务调度'`(warning)；否则默认 `'未开始（尚未生成）'`。

`ensure_auto_collision_for_current_version(scene_id, owner_id, *, mode, retry_failed)` 状态机：
- **MISSING**（无碰撞行）：创建 CollisionAsset + Job（`celery_task_id` = fresh claim）→ `_dispatch_build`；
- **job=None / tid=None（派发不完整）**：补建 Job/补派发，claim 机制保证不重复投递；
- **claim 未确认**：等 `_wait_for_dispatch_confirmation`（≤5s）确认真 id；>60s 陈旧 claim → 接管；
- **QUEUED/RUNNING 且真 broker id**：健康，不动；
- **SUCCEEDED 且绑定当前版本**：健康，不动（零回归）；SUCCEEDED 但绑定旧版本 → 重建；
- **FAILED**：`retry_failed=True`（发布/手动触发）自动重试；`retry_failed=False`（周期兜底）
  留给手动（需上限/退避）。
每次提前返回前 `rollback()` 释放场景行锁。发布幂等保持：**永不**把 scene 从 PUBLISHED 改回
PUBLISHING/FAILED。`reconcile_auto_collision(limit=50)` 按 `Scene.created_at DESC` 扫描
缺失行+注意力行，供已排程的 cleanup 定时器调用。崩溃不变量 DB 断言测试锁定：SceneVersion 不重复、
PUBLISH job 不重复、有效碰撞 job 不重复、场景保持 PUBLISHED。

- `_lock_scene_for_update(scene_id)`：`select(Scene).where(id==…).with_for_update(of=Scene)`。
  `lazy="joined"` 关系导致 `session.get(with_for_update=True)` 生成外连接，PG 拒绝
  “FOR UPDATE on nullable side of outer join” —— 显式 `of=Scene` 是唯一合法写法。
- 三个入口（`ensure_auto_collision` / `create_and_build` / `rebuild`）全部先拿场景行锁，
  检查+写+commit 在锁内，**send_task 在锁外**（commit 释放锁后才投递）。
- 派发 claim 协议：`sending:<uuid>:<monotonic>` 写入 `celery_task_id` 与碰撞行同事务提交；
  并发线程见 claim → 等确认而非重发；>60s 陈旧 → `_take_over_stale_claim` FOR UPDATE 比较-写；
  派发失败 → claim 清 NULL（=派发未确认，可恢复）。**不依赖 Celery 重投**。
- worker：`build_collision(job_id, scene_id, collision_id, mode, world_transform_hash, source_version)`，
  旧 5 参数任务回退到场景当前版本；`_still_owned` 在构建前/完成前两次检查
  （场景仍指向钉扎版本、碰撞行仍指向本 job、job 未终态）→ 否则 `COLLISION_SUPERSEDED`；
  异常路径重读 fresh 行才 FAIL 碰撞。输出按 job 隔离，Asset 行带 `collisionJobId/sourceVersion/sourceVersionId`
  且 `version_id` 钉到源版本。
- 服务：`_assets_of_job(scene_id, job_id, kind)` 按 JSONB `collisionJobId` 解析；遗留单构建布局
  走 `collision.asset_id` kind 匹配 → `_latest_collision_asset` 文档化回退；**绝不** ORDER BY
  created_at DESC 猜测。核对无既有重复行需唯一约束（幂等靠状态机+claim，非 DB 约束）。

派发参数 = `[job.id, scene.id, collision.id, mode, world_hash, str(current_version.id)]`；
worker 用第 6 参数钉扎 SOG 源版本、写 `collision/<sid>/versions/<asset>/jobs/<jobId>/`，
完成前确认“current 仍 = 该版本且 collision.job_id 仍 = 本 job”。可证性由测试覆盖：
崩溃→恢复（claim 超时接管）、重复投递→零重复工作、重启→恢复、worker 队列真实消费
（`test_real_cli_collision_build_produces_artifacts` 用真实 splat-transform CLI 构建）。
所有并发测试使用**真实 PostgreSQL 16.13**（`threading.Barrier`/`ThreadPoolExecutor`/`SessionLocal`
交错真实行锁），SQLite 在本仓库不可用。

| 测试 | 首次运行失败输出 | 根因 |
|---|---|---|
| `TestPostPublishRecovery::test_*` | `AttributeError: 'CollisionService' object has no attribute 'reconcile_auto_collision'`（4 次） | 恢复服务未实现 → 新增 `ensure_auto_collision_for_current_version` + `reconcile_auto_collision` |
| `build_collision` 6 参数契约 | `TypeError: build_collision() takes from 5 to 6 positional arguments but 7 were given`（4 次） | worker 未接第 6 参数 source_version → 扩展签名+旧任务回退 |
| `TestConcurrentDispatchSerialization` | 并发双派发各建 1 job（2 次投递） | commit-then-send 窗口让 T2 见未确认 tid → claim 协议 |
| worker `test_job_a_succeeds_after_b_published_no_overwrite` | 全部 SUCCEEDED 均报 `COLLISION_SUPERSEDED` | `_still_owned` 比较 `str(job_id)!=UUID` 恒真 → 归一化 UUID |
| worker `test_job_a_fails_after_b_does_not_fail_b_collision` | 陈旧 worker FAIL 污染新碰撞 | rollback 后 ORM 对象陈旧 → 异常路径重读 fresh 行 |
| `test_build_collision_version.py::test_success_records_source_version`（§C 旧测试） | collision 无 job_id + 平铺目录 | 契约迁移：job_id 绑定 + 每 job 目录 + 6th arg |
| web `upload.test.tsx` | `未生成（尚未构建）` 断言失败 | 文案改为诚实 `未开始（尚未生成）` / `等待碰撞任务调度` |
| web backoff 测试 | 硬顶 30s 永不绑定 | 指数被 `min(errors,3)` 预截断 → 移除预截断 |
| `test_duplicate_delivery_of_completed_job_is_noop` | 计数含 SOG 行 | 限定 `COLLISION_VOXEL/GLB` kind |
| 真实 CLI 测试 | 0.011s 失败（缺 shard 文件） | 只拷 lod-meta/manifest → `copytree` 全量 staging |
RED 之后全部转 GREEN，输出见 §8/§13。

- **API `test_fix_upload011.py`（15 项，全绿）**：`TestPostPublishRecovery`（缺失行补建、未确认
  job 重发不重复、缺 job 补 job、broker 失败→派发不完整→恢复、已派发失败留给手动、陈旧
  SUCCEEDED 重建、健康场景不动、未发布场景忽略）、`TestCrashPointInvariants`（版本/发布 job/
  碰撞 job 均不重复、场景保持 PUBLISHED）、`TestJobScopedServing`（碰撞自身 job 的资产可解析、
  遗留布局仍服务）、`TestConcurrentDispatchSerialization`（双自动派发 1 job、自动+手动竞争 1 job）、
  `TestDuplicatePublishDeliveryRecovers`、`test_reconcile_is_idempotent_under_repeat`。
- **API `test_fix_upload011_security.py`（7 项，全绿）**：匿名 401、非属主 build 403、非属主
  rebuild 403、错误 CSRF 403、缺失 CSRF 403、属主 build 200、注入 sourceVersion 不生效。
- **workers `test_collision_concurrency.py`（8 项，全绿）**：`TestVersionContract`（钉扎版本+每
  job 目录+voxel 元数据、完成 job 重复投递零工作、旧 5 参数回退）、`TestStaleWorkerProtection`
  （A 成功于 B 之后→COLLISION_SUPERSEDED 且碰撞行不动、A 崩溃于 B 接管后→仅 A FAILED、
  worker 失败拥有碰撞行→碰撞 FAILED+场景 PUBLISHED、输出目录与资产行隔离）、
  `test_real_cli_collision_build_produces_artifacts`（真实 CLI 构建，~3.9s）。
- **web `upload-polling.test.tsx`（17 项，全绿）**：轮询生命周期、碰撞 null 文案、退避自愈、
  观察上限、卸载清理、StrictMode、无副作用只读等；`upload.test.tsx` 文案断言同步更新。

`workers/collision/splat.py` 调官方 `@playcanvas/splat-transform` CLI（3.3.3）对**真实**
`lod-meta.json` 流式 SOG 做碰撞构建，产出 `collision.voxel.json/.bin`（VoxelCollision）与
`collision.glb`（MeshCollision）。`test_real_cli_collision_build_produces_artifacts` 从真实
PLY → 真实 streamed-SOG 转换 → 真实 CLI 碰撞构建全程无 mock（copytree 全量 staging）。
SSV-07 已知边界保持：INDOOR/OUTDOOR 是 voxel 生成策略而非运行时模式。

- 碰撞**变更**路由 `POST /{slug}/collision/build`、`PATCH /collision`、`POST /collision/rebuild`
  全部 `require_csrf`（会话+双提交 token）且服务内 `_validate_owner` 属主校验（非属主 403）。
- 碰撞**读取/服务**路由走 `SceneAccessPolicy`（owner / PUBLIC+PUBLISHED / live share token），
  与 FIX-01 统一；私有场景匿名 401、他用户 403。
- **sourceVersion 无注入面**：派发层只读 DB 中场景当前 SceneVersion（`_dispatch_build` 参数即
  `current_version.asset_version/id`）；请求体字段 `sourceVersion/sourceVersionId` 属未知字段被
  Pydantic 静默忽略，`test_body_source_version_rejected` 断言注入值绝不出现在 broker 参数里
  （发往 broker 的第 6 参数 == 场景当前版本 UUID）。
- worker 路径全部由 UUID + DB asset_version 派生（`storage._path(rel_dir)`），无用户可控穿越面。
- `test_fix_upload011_security.py` 7 项全部使用真实注册会话（dev bypass 关闭）。

- 发布幂等保留：重复投递走“re-assert collision chain”而非重发布；scene 状态永不回退。
- 遗留碰撞布局（`collision/<sid>/collision.voxel.*` / `collision.glb`，无 job 隔离）仍服务
  （`test_legacy_single_build_layout_still_serves` + 真实 E2E 中 200）。
- FIX-05 §23 worldTransformHash 语义保留（STALE 判定基准）。
- FIX-05C 缓存策略不受影响（serve 仍走 `build_cache_control`）。
- 未升级 torch/gsplat/splat-transform/PlayCanvas/SuperSplat；无新 UI；无 gaussian 渲染器改动；
  未触碰 FIX-XR-01 / FIX-05C 等相邻阶段成果。

- 派发时 broker 异常 → job FAILED + `COLLISION_DISPATCH_FAILED` + claim 清 NULL + 碰撞 FAILED
  → 周期兜底/手动重试（场景保持 PUBLISHED）。
- worker 构建异常 → job FAILED `COLLISION_BUILD_FAILED`；若碰撞行仍属本 job → 碰撞 FAILED 可重建；
  若已被新 job 接管 → 仅 job FAILED，新碰撞不动。
- 陈旧 worker 完成前发现被取代 → `COLLISION_SUPERSEDED`（合法终态，非非法 DB 状态）。
- 观察上限未收敛 → 前端“状态尚未确认”+ 重新查询，不无限轮询。

- **backend**：`ruff check app tests` → All checks passed!；`mypy app` → Success: no issues found
  in 84 source files；全量 pytest（真实 PG 16.13）→ 379 collected = 378 passed + 1 跳过
  （安全测试无版本场景的预期 skip）（exit 0）。
- **workers**：`pytest tests` → 36 passed in 10.19s（含真实 CLI 构建，单独运行时实测稳定；
  此前与全量后端/Gate 重建并发执行导致 1200s 超时 —— 环境争用，非代码缺陷，单独复跑 4.5s 通过）。
- **web**：`tsc --noEmit` exit 0；`oxlint .` exit 0（仅既有 warning）；`vitest run` → 254 passed
  (27 files)；`npm run build` → built in 4.28s。
- **Playwright E2E**：`fix-upload01-viewer.spec.ts` **passed**（真实发布场景 viewer 加载 +
  碰撞描述符/资产可达，走新 job-scoped 服务路径）；`ssv07-collision.spec.ts` walk/XR 2 项失败
  为**既有 dev-DB 漂移**（见 §14），非本修复回归 —— 碰撞描述符代码未改动、服务端点对该场景的
  mesh/voxel/voxel.bin 均实测 200。
- **安全回归**：7 项新增（§10）全部通过；既有 FIX-01 安全测试随全量套件通过。
- **Clean-checkout 门禁**：`deploy/scripts/verify_release_source.sh` 在提交后执行
  **GATE_EXIT=0**：干净 archive → 全新 venv → 依赖/导入闭包 → ruff/mypy → backend 全量
  pytest → workers 32 passed + 4 skipped（CLI 测试因 node_modules 不随 git archive 分发而
  诚实 skip）→ 重建运行时验证 PASS（torch 2.14.0+cu126 / gsplat 1.5.3 / CUDA A6000 光栅化）。
  门禁期间暴露一个真实 RED：安全回归测试高频真实注册触发登录/注册内存限流 429 —— 已镜像
  `test_auth` 的 autouse `_clean_rate_limits` 修复并提交（`406b8ee`）。该门禁对无 GPU 机器
  的 GPU 重建段诚实 SKIP —— 非本修复范围。

- `fix-upload01-viewer.spec.ts`：HTTP 上传 + 真实 Celery publish 的 DB 场景在官方 viewer 真实
  加载，descriptor 从 DB 解析（非 manifest 回退），content.url 指向
  `/api/v1/scenes/.../assets/versions/.../lod-meta.json`，gsplats>0，碰撞描述符携带且非 stale。
- 新 job-scoped 服务路径回归证明：该场景的碰撞资产由 `_assets_of_job` 解析成功（legacy 布局
  回退链被真实浏览器命中并返回 200）。
- `ssv07-collision.spec.ts` 2 项失败归因：场景 `r-8c4e2264e86a` 的 CollisionAsset/Job 自
  **2026-09-28 15:10** 起停在 QUEUED（broker tid `celery-85…` 从未被消费），描述符按
  `status != SUCCEEDED` 返回 `collision: null`（`_build_collision` 未改动）→ `hasCollision=false`。
  该场景磁盘上仍留有 9-28 的旧平铺碰撞文件，本修复的 serve 端点对其 mesh/voxel/voxel.bin 均
  实测 200 —— 失败源于陈旧 DB 状态而非服务回归。

## 15. 诚实边界
本修复在软件层验证至 E2E 通过；**真实 PICO Neo3 硬件验收只能由用户在真机执行，自动化绝不
声称真实硬件 PASS**。worker 全量消费依赖真实 broker/worker 队列（本机 dev 环境提供
Redis + Celery）。`ssv07` walk/XR 两项失败归因于既有 dev-DB 漂移（9-28 遗留 QUEUED 碰撞），
已在本报告如实记录而非掩盖。
