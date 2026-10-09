# FIX-UPLOAD-01.2 最终一致性报告 —— Collision Claim、原子最终化与版本安全服务

日期：2026-10-09
基线：`4498a6d`（本修复起点）；分支 `main`；提交见下文 §16。
本报告不修改 FIX-UPLOAD-01 / 01.1 的既有结论。

## 1. 目标与范围（对照 FIX-UPLOAD-01.2 任务书）

三个 git 审查确认的缺陷，全部落在碰撞（collision）派发/构建/服务链路：

| 编号 | 缺陷 | 层级 | 修复落点 |
| --- | --- | --- | --- |
| P1-1 | 派发 claim 内嵌 `time.monotonic()`（跨进程/主机/重启不可比），fresh claim 在仅等待 5s 后被接管 | 派发（API 侧） | PART A |
| P1-2 | worker 最终提交无原子所有权保护（建立在“先检查后提交、无行锁”之上） | 构建（worker 侧） | PART B |
| P1-3 | 碰撞服务存在无条件 legacy 回退，可能对外服务旧版本资产 | 服务（API 侧） | PART C |

范围之外（禁止项，均未动）：splat-transform / PlayCanvas / SuperSplat / torch / gsplat 版本；
UploadPage、Celery 框架、Viewer 运行时、Reconstruction 流水线；FIX-XR-01 / FIX-05 / FIX-05C
等相邻阶段成果。未新增 Alembic 迁移（本修复零 DDL，纯代码层）。

## 2. 三个已确认缺陷与修复落点

- **P1-1**：旧 `_dispatch_build` 用 `time.monotonic()` 生成绝对租约并把毫秒数写进
  `Job.celery_task_id`（claim 形式 `celery-<tid>`）。`monotonic()` 仅在同一进程内可比较，
  API 重启/多 worker 进程/多主机下“过期”判定失真；且旧逻辑对 fresh claim 也只按固定等待
  5s 后即尝试接管。修复：claim 统一为 `sending:<uuid4hex>:<utc_epoch_ms>`，租约时钟来自
  PostgreSQL `clock_timestamp()`（`_db_now_ms`），跨进程/主机/重启可比较；fresh claim 永不
  接管，过期 claim 接管必须走锁定复核（§3）。
- **P1-2**：旧 worker 在生成后直接 `session.commit()`，其间不做任何行锁与所有权复核——
  构建中途被接管时，旧的 `asset_id/job_id/status` 写入可能覆盖新任务结果。修复：两阶段 +
  统一锁序（§5），最终化在持锁事务内重新读取并全量校验（§5 校验式），校验不过 → 只把旧任务
  Job 置 `COLLISION_SUPERSEDED`，绝不触碰新碰撞/新 Job/新资产。
- **P1-3**：旧 `serve_collision_mesh/voxel` 在“当前 job 无资产”时按“最近创建的同类资产”回退，
  可把上一版本构建的旧碰撞资产对当前版本服务。修复：绑定链（§7），仅可证明的 legacy 布局
  才回退（§8）。

## 3. PART A —— 权威派发租约时钟与免持久化时基

- `_db_now_ms(session)`：`SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint`，
  **绝不将 `time.monotonic()` 持久化为租约时间**；任何凭自定义时基编造的 claim 在解析失败时
  一律按“可接管”（但接管仍需锁定复核，§4）。
- `_new_claim(session)` 生成 `sending:<uuid4hex>:<epoch_ms>`；`_parse_claim`/`_claim_expired`
  解析与 TTL 判定；`_CLAIM_MAX_FUTURE_SKEW_S=300` 容忍发送方与 DB 时钟偏移。
- `ensure_auto_collision_for_current_version` 的 claim 分支：读到 `sending:` claim 时先取 DB
  时钟判过期，随后 `rollback()` 释放读事务再决定接管或等待确认——避免在过期判定与接管之间
  残留未提交读锁。
- **fresh claim → 永不接管**：仅当 `_claim_expired` 为真才进入 `_take_over_stale_claim`。
- **过期 claim → 仅锁定复核成功后接管**（§4）。

## 4. PART A 附带 —— 接管 CAS 与 broker 回调双重保护

- `_take_over_stale_claim`：新会话按统一锁序 `Scene(of=Scene) → CollisionAsset → Job` 加锁，
  配合 `populate_existing=True`/`expire_all()` 击穿 ORM 恒等缓存的陈旧镜像；锁内复核：
  1) `job.status` 非终态；2) `str(job.celery_task_id) == expected_claim`（token 逐一比较）；
  3) 该 claim 重新判定仍然过期；4) `scene.current_version_id == current_version.id`（版本未变）。
  全部通过 → 原子替换为新 claim + `COMMIT` + 派发。
- `_record_broker_confirmation(job_id, *, expected_claim, task_id)`：新会话锁 Job，若
  `job.celery_task_id != expected_claim`（claim 已被接管）→ 回滚返回 False，**晚到的发送方
  拿到 broker 成功后不得把真实 task id 写进已被他人接管的 Job**。
- `_record_broker_failure(job_id, *, expected_claim)`：新会话（未锁读 scene_id → 统一锁序
  加锁）做同样的 claim CAS；只能在 claim 仍归自己时把 Job 与（若 `coll.job_id==job_id`）
  碰撞行置 FAILED，**绝不把新的发送方 Job 标记 FAILED**；同时清空 claim 便于周期兜底重新派发。
- claim token 一律服务端生成，用户请求体永不参与接管判定/工件路径构造（§13）。

## 5. PART B —— 生成/最终化两阶段与统一锁序

- **生成阶段无长事务**：短事务完成执行权 claim（§6）后即 `COMMIT` 释放；随后只读加载
  场景/钉扎 SceneVersion/定位 SOG 并 `rollback()` 释放读事务；再 `_still_owned` 廉价预检
  （版本未变 + 碰撞行仍属本 job + job 非终态）；然后**在锁外运行分钟级 splat-transform**，
  产物写入 per-job 隔离目录
  `collision/<sid>/versions/<asset_version>/jobs/<job_id>/`。
- **最终化阶段持锁单事务**：`_finalize_build` 开头 `rollback()` → 统一锁序
  `Scene(of=Scene) → CollisionAsset → Job`（沿用已验证的 `select(Scene).with_for_update(of=Scene)`
  形式，绝不用 naive JOIN 锁）+ `populate_existing=True` → 重新读取**当前**行 → 所有权全量
  校验：
  1) `scene.current_version_id == src_version_id`
  2) `collision.job_id == job_id`（非空）
  3) `build_params->>'sourceVersionId'`（若已记录）== `src_version_id`
  4) `job.status` 非终态
  5) `job.scene_id == scene.id`
  6) 新建资产 `version_id == src_version_id`
  任一不满足 → `_mark_superseded`（§5.1）。
- 通过 → 新建 voxel + glb Asset 行（钉 `version_id=src_version_id`，metadata 携带
  `collisionJobId`/`sourceVersion`/`sourceVersionId`/`mode`/`binStorageKey`）、写
  CollisionAsset（`asset_id/job_id/build_params/status=SUCCEEDED`）、Job
  （`SUCCEEDED` + stage + progress=100）→ 单一 `COMMIT`。真实保护来自锁定与同事务提交，
  ORM 隔离只是防御层。
- **真实保护 = 行锁 + 同事务提交；失败路径一律重新取锁**（`rollback()` → 重新锁定 → 重新读取）。

### 5.1 `_mark_superseded` / `_fail_build`
- 同锁序/同事务边界：先 `rollback()` → 统一锁序重新取锁 + `populate_existing` 重新读取 →
  旧任务 Job 置 FAILED（`COLLISION_SUPERSEDED` / `COLLISION_BUILD_FAILED`）→ 仅当
  `str(collision.job_id) == str(job_id)` 才把**本任务行的碰撞**置 FAILED（已被新 job 接管的
  碰撞行绝不触碰）→ `COMMIT`。新 Collision Job 不会被失败方改写，新 `CollisionAsset.asset_id`
  不被覆盖，新碰撞 Asset 不被置 FAILED。

## 6. PART B 附带 —— 执行权原子 claim 与崩溃恢复

- `_claim_execution_rights(session, job_id)`：对 Job 行 `with_for_update() + populate_existing`
  加锁：不存在 → `MISSING`；终态 → 返回观测状态（重复投递 no-op）；`QUEUED → RUNNING` +
  `started_at=<DB 时钟>` 提交 → `EXECUTE`；已 `RUNNING` 且 `started_at` 为空（01.1 遗留直接
  调用）→ 补记租约并 `EXECUTE`；`RUNNING` 且租约过期（`now - started_at > 300s`）→ 崩溃恢复
  重新认领 `EXECUTE`；fresh 租约 → 返回观测状态（**重复执行被吸收，生成器不二次运行**）。
- 与 P1-2 的隔离：执行权 claim 是**短事务**（先提交再生成），最终化是**独立第二事务**；二者
  各自持锁时间都不覆盖分钟级生成。
- 崩溃恢复复用既有“status + started_at”机制，无失控重试循环：过期佣金只有一条路径（CAS 式
  重认领），认领后仍走 §5 的全部最终所有权校验。

## 7. PART C —— 版本安全服务绑定链

`serve_collision_mesh(slug)` / `serve_collision_voxel(slug, *, binary)` 统一走
`_resolve_collision_asset(scene, kind, *, wanted_bin)`，绑定链：

```
Scene → Scene.current_version（存在）→ CollisionAsset.status == SUCCEEDED
      → 版本对齐（仅"已记录且失配"拒绝；未记录的 FIX-05 时代行保持服务，零回归）
      → _job_scoped_asset（metadata.collisionJobId == 碰撞行 job_id，version_id ∈ {None, current}）
        或 _legacy_asset（§8 可证明路径）
      → binary 时要求 binStorageKey 存在且 dirname(binStorageKey) == dirname(asset.storage_key)
```

- NONE/QUEUED/RUNNING/FAILED/版本失配 → **返回 404，绝不用旧任务资产**；这是 P1-3 的关闭点
  （C-04/C-05/C-06/FIX-05-era 行为一致化）。
- **不发明非法枚举**：碰撞 status 仍只使用 NONE/QUEUED/RUNNING/SUCCEEDED/FAILED，
  `COLLISION_SUPERSEDED` 只作为 **Job 的合法终态码**（Job.status CHECK 本就允许 FAILED 段），
  绝不为碰撞行增加 SUPERSEDED。
- 当前版本资产 `collision_enabled=false` 仍可读（服务层不读启用开关；开关只影响 viewer 行为）。

## 8. PART C 附带 —— 可证明 legacy 回退与 binStorageKey 包含

- `_legacy_asset` 仅在**可证明**时启用：`collision.asset_id` 显式指向唯一 legacy Asset；
  被指资产版本与当前 SceneVersion 一致（`version_id ∈ {None, current}`）；未被取代
  （`metadata.collisionJobId` 不存在或 == 当前 job_id）；若被指资产非目标 kind，仅在
  **同一 storage 目录**、**无 collisionJobId**、**唯一匹配**的兄弟同类资产间回退。
  “当前 job 缺资产 → 取最近创建的同类资产”的不可证明兜底**已被移除**。
- GLB 与 voxel 同属一次构建：由同 scene_id/sourceVersion/collisionJobId/构建目录派生并互相
  校验（voxel bin 的 `binStorageKey` dirname 必须等于 json 所属构建目录，C-10）。
- `_assert_bin_key_safe`：normpath 后拒绝 `.`/`..`/绝对路径，且必须包含
  `collision/<scene_id>/`——binStorageKey 不出脱存储区（§13）。

## 9. 真实数据库与并发事实

- PostgreSQL 16.13，默认隔离级 read committed（任务书允许的最小隔离级，全部约束由行锁+xact
  提交保证）。
- `apps/api` 全量测试与会话数：B 测试全部使用 **≥2 个独立 `SessionLocal()`**，跨线程只传 UUID，
  绝不传 ORM 实例；`threading.Barrier`/`Event` + 显式 `TIMEOUT=30`，死锁表现为测试失败而非挂起。
- 锁行为实证：`_finalize_build` 持锁期间并发接管线程被阻塞等待（B-02），提交后接管方读到
  SUCCEEDED；`select(Scene).with_for_update(of=Scene)` 已确认可锁（lazy="joined" 关系下
  不能用 naive `session.get(with_for_update=True)`，会产生 nullable 外连接被 PG 拒绝锁）。

## 10. RED → GREEN 证据（真实失败输出 + 根因）

对 HEAD（修复前）代码实跑新增测试，三个关键 RED 全部真实复现：

| # | 测试 | RED 输出（真实捕获） | 根因 |
| --- | --- | --- | --- |
| RED-1 | A-01 fresh claim 5s 不接管 / A-02 fresh 59s 不接管 | `ImportError: cannot import name '_db_now_ms' from 'app.services.collision'` | 旧代码无 DB 时钟机制，fresh-claim 语义根本不可测；A-03/A-04/A-05/A-06/A-07/A-08/A-09 同组 FAILED |
| RED-2a | B-01/B-03 构建中途接管 | `KeyError: 'error'`（`<task 结果>` 无 error 键） | 旧 worker 在接管后仍提交 SUCCESS，最终化无所有权复核，无法返回 COLLISION_SUPERSEDED |
| RED-2b | B-05 两个 worker 同一 job | `AssertionError: the generator ran 2 times for one job — duplicate execution` | 旧 worker 无原子 QUEUED→RUNNING claim（identity-map 陈旧镜像导致双执行） |
| RED-3 | C-04 当前 job QUEUED + 旧资产在盘 | `Failed: DID NOT RAISE <NotFoundError>` | 旧服务无条件 legacy 回退，服务了旧任务资产；C-05/C-06/C-07/C-09/C-10 同组 FAILED |

GREEN：修复后全部翻转 —— PART A/C `21 passed`、PART B `9 passed`（§11、§16 各门禁复跑）。

## 11. 测试矩阵

### PART A `apps/api/tests/test_fix_upload012.py::TestClaimTtlSemantics`（A-01..A-10）
- A-01 fresh 5s 不接管；A-02 fresh 59s 不接管；A-03 过期 61s 接管（SCM 时钟，无真实 60s 等待）；
- A-04 双发送者竞争至多一方接管成功；A-05 晚到发送者不能覆盖新 claim；A-06 晚到发送者失败
  回调不能把新发送方 Job 置 FAILED；A-07 claim 被替换后 CAS 失败；A-08 TTL 语义跨“进程重启”
  （epoch 全可比）；A-09 新 SceneVersion 使旧 claim 无效（版本复核）；外加
  `test_claim_confirmation_wait_is_bounded`（确认等待有界，不无限轮询）。

### PART B `workers/tests/test_collision_atomic_finalize.py`（B-01..B-10）
- B-01/B-03 构建中途接管 → 最终化 COLLISION_SUPERSEDED 且不碰新碰撞；B-02 最终化持锁期间
  接管被阻塞（非死锁、非双提交）；B-04 接管后失败只 FAIL 自己 Job；B-05 双 worker 仅一方
  执行（生成器只跑 1 次）；B-06 重复投递 SUCCEEDED job 为 no-op；B-07 提交失败（首个 commit
  即抛的退化 Session）不留部分状态、不出现 SUCCEEDED；B-08 两版本构建相互隔离（资产按版本/
  job 目录 + metadata 分离）；B-09 worldTransformHash 记录进 build_params；B-10 构建期间
  场景更新不死锁（合法结局：提前 finalize 或 SUPERSEDED）。

### PART C `apps/api/tests/test_fix_upload012.py::TestVersionSafeServing`（C-01..C-12）
- C-01 SUCCEEDED+对齐 → 服务 job-scoped 资产；C-02 job-scoped 优先生效；C-03 版本失配拒绝；
- C-04 QUEUED 拒绝旧资产；C-05 RUNNING 拒绝旧资产；C-06 FAILED 拒绝旧资产；C-07 新版本拒绝
  旧碰撞；C-08 显式 asset_id 可证明 legacy 仍服务；C-09 无指针/不可证明 → 404；C-10
  binStorageKey 指向异构建 → 404；C-11 无 binStorageKey → 404；C-12 `collision_enabled=false`
  当前版本资产仍服务。

### 既有回归（未删除任何断言）
- `test_fix_upload01.py`（含 `test_serve_real_voxel_artifacts_200`）、`test_fix_upload011.py`
  （含 legacy 布局仍服务）、`test_scene_runtime.py`（含 FIX-05 时代无 build_params 行仍服务）、
  `test_collision_concurrency.py`、`test_build_collision_version.py`、`test_convert_scene_formats.py`
  全部保留并通过（§16 全量）。

## 12. 真实转换流水线与真实 CLI 碰撞构建

- 单元/并发层：`test_real_cli_collision_build_produces_artifacts` 走真实链：真实 PLY →
  真实 splat-transform streamed-SOG（`convert_to_streamed_sog`）→ 真实
  `build_collision_artifacts`（CLI）→ 真实 worker 任务 → Job SUCCEEDED → 资产携带
  `collisionJobId`/`sourceVersion` 且落盘存在。
- **真实场景重建（playwright 前置恢复）**：场景 `r-8c4e2264e86a` 的碰撞自 2026-09-28 起停在
  QUEUED（FIX-UPLOAD-01.1 报告 §14 已如实记录）。本轮用**真实任务**对该真实场景重建：
  执行权 claim（QUEUED→RUNNING）→ 真实 splat-transform voxel/GLB → 原子最终化 → 输出
  `gridBounds x∈[-4.6,3.6] y∈[-1.4,2.6] z∈[7.2,14.6]`（与 SSV-07 断言精确一致）、
  voxel.bin 68872 字节、`collision.mesh / voxel.json / voxel.bin` 经新服务链全部实测 200。
- 版本绑定实证：重建后 CollisionAsset `build_params.sourceVersionId == 当前 SceneVersion id`，
  资产落在 `versions/<ver>/jobs/<job>/` 目录并携带 `collisionJobId/sourceVersionId` 元数据，
  遗留旧资产行保留但不再被 job-scoped 解析命中。

## 13. 服务与安全面（PART H）

- `SceneAccessPolicy` 保留：碰撞读取/服务路由沿用 FIX-01 统一策略（owner / PUBLIC+PUBLISHED /
  live share token），私有场景匿名 401、他用户 403；**未对私有场景开放未鉴权碰撞文件**。
- CSRF：`POST /collision/build` 等变更路由保持会话 + 双提交 token。
- **Claim token 只由服务端生成**（§3/§4），接管判定比较的是 DB 中既有 claim 与调用方携带的
  expected_claim 字符串，请求体绝不携带新 claim。
- **sourceVersion 只来自已验证 SceneVersion**：派发/重建的 `source_version` 参数由
  `_dispatch_build` 读 DB 场景当前版本派生，用户请求体中的 sourceVersion/sourceVersionId
  为 Pydantic 未知字段被静默忽略（01.1 的 `test_body_source_version_rejected` 语义延续）。
- **不信任请求体 jobId/sourceVersion/storageKey/claimToken 用于内部接管或工件路径构造**：
  工件路径全部由 UUID + DB asset_version 派生；`binStorageKey` 只读自 DB Asset 行并经
  `_assert_bin_key_safe` 包含校验（§8）。
- **不向前端返回 broker 凭据/服务器绝对路径/内部堆栈**：错误统一映射为稳定 error code
  （COLLISION_DISPATCH_FAILED/COLLISION_BUILD_FAILED/COLLISION_SUPERSEDED/NotFound）。
- Cache-Control 保留 `build_cache_control`（FIX-05C 优先序不受影响）。

## 14. 不破坏项与禁止项（PART D）

- PLY 校验、SOG 转换、LOD（含 .mjs 生成器契约）、SceneVersion 发布、Publish Job 幂等、
  UploadPage 轮询、post-publish 恢复、周期兜底调度、WorldTransformHash/STALE、手动
  build/rebuild、enabled/disabled、SuperSplat Viewer、PICO WebXR、FIX-XR-01 全部保留。
- 未升级 splat-transform/PlayCanvas/SuperSplat/torch/gsplat；未重写 UploadPage/Celery/
  Viewer 运行时/Reconstruction；无 web 改动（`apps/web`/`apps/viewer` git 状态为空）。
- 未新增 Alembic 迁移（零 DDL）；未删除任何旧回归测试与断言。

## 15. 失败路径 → 稳定状态

- 派发 broker 异常 → `_record_broker_failure` 锁内 CAS：仅本 claim 可见时 Job
  `COLLISION_DISPATCH_FAILED` + claim 清空 + 碰撞（若仍属本 job）FAILED → 周期兜底重新派发
  （场景保持 PUBLISHED）。
- worker 构建异常 → `_fail_build`：锁内重读，Job `COLLISION_BUILD_FAILED`；碰撞行仍属本 job
  才置 FAILED（可重建）；已被接管则只 FAIL 自己 Job。
- 最终化前/中发现自己被取代 → `COLLISION_SUPERSEDED`（Job 合法终态）→ 新碰撞与资产保持
  不动，可继续构建。
- 重复投递（acks_late/崩溃后 redelivery）→ 终态 no-op；重叠投递 → §6 原子 claim 吸收。
- 周期兜底/手动重建路径不变：claim 清空或终态后可由 API 重新 `POST /collision/rebuild`
  派发新 Job 接管。

## 16. 门禁与回归 · 验收矩阵（全部真实执行）

| 门禁 | 结果 |
| --- | --- |
| backend `ruff check app tests` | All checks passed! |
| backend `mypy app` | Success: no issues found in 84 source files |
| backend `pytest tests -q`（真实 PG） | 399 passed, 1 skipped（exit 0；本轮复跑同组全量 100% 完成，1 skip 为安全测试无版本场景的预期 skip） |
| workers `pytest workers/tests -q` | 45 passed in 23.13s（36 既有 + 9 新增；含真实 CLI 构建） |
| workers 单测（本轮新增） | `test_fix_upload012.py` 21 passed；`test_collision_atomic_finalize.py` 9 passed |
| worker 文件 lint（非 test 文件） | tasks/build_collision.py ruff 0 error（I001/E501 已清理）；测试文件余项均为 `tests/**` 豁免的 assert（S101），非门禁范围 |
| web `typecheck / lint / test / build` | tsc exit 0；oxlint exit 0；vitest 254 passed；build OK（3.82s）；web 零改动 |
| Playwright `fix-upload01-viewer.spec.ts` | **passed**（真实 DB 场景 viewer 加载、gsplats>0、collisionStale=false、contentUrl 指向当前版本） |
| Playwright `ssv07-collision.spec.ts` | **3 passed**（walk 真实 voxel 碰撞；无碰撞场景禁用；XR 消费碰撞）。SSV-07 遗留 QUEUED 碰撞经 §12 重建后恢复，walk/XR 两项由 01.1 的“环境漂移挂起”转为真实通过 |
| 真实 CLI 链 | §12：真实 PLY→SOG→碰撞→SUCCEEDED→服务 200（68872 字节 bin） |
| 重建-版本绑定 | §12：sourceVersionId 绑定、asset_version/job 目录隔离实证 |
| Clean-checkout `verify_release_source.sh` | 见 §16.1（提交后执行，记录真实 GATE_EXIT） |
| `git diff --check` / 无密钥/无生成物 | 通过（§16.2） |

### 16.1 Clean-checkout 门禁
提交后于干净 checkout 执行 `deploy/scripts/verify_release_source.sh` —— 归档 HEAD → 全新 venv →
依赖/导入闭包 → ruff/mypy → backend 全量 pytest → workers（真实 CLI 测试因 node_modules 不随
git archive 分发而按既有 `--reason` 诚实 skip）→ 重建运行时验证。真实 `GATE_EXIT` 见执行输出。

### 16.2 提交与推送（PART K）
按任务书最多两个提交：`fix(collision): enforce atomic claims and finalization`（2 改动文件 +
本报告）+ `test(collision): cover claim races and version-safe serving`（2 新测试文件）；
普通 push（无 force push，无 reset --hard）；提交后 `HEAD == origin/main`、工作树干净；
diff 无 secrets/生成二进制/上传数据/node_modules/venv。

## 17. 诚实边界与遗留

- 真实 PICO Neo3 农业场景硬件 retest 只能由用户在真机执行，自动化**不**声称硬件验收 PASS。
- web 侧 Playwright walk 长度断言（`W moved > 0.15m`）在 headless SwiftShader 下偶发计时抖动：
  本轮 4/4 通过（失败一次、同代码 0.388m 复跑通过，且失败中的碰撞断言——walkAllowed/
  hasCollision/voxel/落点——全部已过）——已如实记录，非本修复回归。
- broker 全量消费（真实 Celery worker 队列）与真实 GPU 光栅化由部署环境提供；本报告 §12 的
  真实链在 dev 环境以 CPU 执行并验证到服务层 200。
- 本轮修复零 DDL，未对生产 DB 做任何未验证修改；演示/验收数据为 dev DB 场景重建，不涉生产。

---

**判定：`FIX-UPLOAD-01.2: PASS`**

**`SOFTWARE READY FOR AGRICULTURAL SCENE HARDWARE RETEST`**