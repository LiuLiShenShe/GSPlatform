# FIX-UPLOAD-01.3 执行围栏（Execution Fencing）、租约心跳与派发失败安全报告

日期：2026-10-09
基线：`4ba7ed5`（本修复起点，前次 01.2 提交）；分支 `main`；提交见 §16。
本报告不修改 FIX-UPLOAD-01 / 01.1 / 01.2 的既有结论。

## 1. 目标与范围（对照 FIX-UPLOAD-01.3 任务书）

任务书把碰撞链路剩余三类缺陷全部落在**执行期安全性**与**派发回调安全性**上：

| 编号 | 缺陷 | 层级 | 修复落点 |
| --- | --- | --- | --- |
| A | 长任务无真实租约心跳（只把 TTL 从 300s 改长不算修复）；无单调执行代次；崩溃后无自动回收 | 构建（worker 侧） | PART A |
| B | `_record_broker_failure` 可能把 RUNNING/SUCCEEDED 翻成 FAILED；网络错误 ≠ broker 没收到的“不确定结局”被当确定性失败；手动/自动路径派发契约不统一 | 派发（API 侧） | PART B |
| C | 01.2 遗留恒真断言 `assert ... != stale or True` | 测试 | PART C |
| D | 真实 PostgreSQL 并发 / 真实长运行 / 真实 CLI 全链路 / 全部 gate | 验证 | PART D |
| E | 内部字段不可被 HTTP 设置；路径服务端生成；无秘密泄露；心跳不泄漏连接 | 安全 | PART E |

范围之外（禁止项，均未动）：SuperSplat Viewer、PlayCanvas、WebXR runtime、PICO Neo3 运行时、
PLY 校验、PLY→SOG 转换、LOD 生成、Gaussian 渲染器、SceneVersion 发布格式、注释系统、媒体
overlay、场景 VFX；未升级 torch / gsplat / splat-transform / PlayCanvas / SuperSplat；未重写
上传系统；无 UI 改动。允许的小范围修改仅：`apps/api/app/services/collision.py`、
`workers/tasks/build_collision.py`、`workers/tasks/publish_scene.py`、Job 模型 + 迁移 +
心跳实现 + 周期协调 + 测试 + 文档。**PART F 约束全部满足。**

## 2. 三个已确认缺陷（RED-first）与修复落点

- **RED-1（长任务双重执行）**：探针把一个“已运行 301s、仍存活”的构建交给重投递的 worker B，
  旧代码凭 `started_at`（永不复新）判定“已过期”而重新执行 → 生成器被调用 **2 次**。修复：
  真实租约心跳（§4）+ 执行代次（§3），存活构建永不被夺走（A-01 已锁行为 GREEN）。
- **RED-2（旧代次失败杀死共享 Job）**：探针让旧代次 A 的晚期失败落到“已被新代次接管的同一
  Job”→ 旧代码把 Job 翻成 FAILED。修复：代次围栏，旧代次对同一 Job 的失败/最终化一律
  `OLD_EXECUTION_SUPERSEDED` 且零写入（A-04/A-05/A-07，§6）。
- **RED-3（晚期 broker 失败覆盖完成状态）**：B-01 在真实 DB 上让 broker 已接收、worker 正
  RUNNING 的 Job 收到晚期失败回调 → 旧 `_record_broker_failure` 返回 True 并把它翻成 FAILED。
  修复：回调状态机（§8），RUNNING/SUCCEEDED 永不被晚期失败触碰（B-01/B-02 真实 DB 转态验证）。

三个 RED 均在未修复代码上先行捕获（`/tmp/red_probe_worker.py` + B-01 断言），然后实现到 GREEN。

## 3. PART A —— 执行代次（Execution Generation）

- **代次语义独立于 `Job.attempt`**：`attempt` 是既有的“派发重试计数器”（API 重派发时 +1，
  亦被 PUBLISH/RECONSTRUCT 使用），复用它会把“重派发”与“一次实际执行”两种语义混淆，甚至
  在未发生真实 claim 时推进代次。因此新增专属单调列 `execution_generation`
  （`BigInteger, default=0, server_default="0", CheckConstraint(>= 0)`）+ 租约列
  `lease_expires_at`（`DateTime(timezone=True), nullable`），并经 Alembic 迁移（§13）。
- **代次只在 worker 的 FOR UPDATE claim 事务内推进**：`_claim_execution_rights` 锁行
  （`with_for_update` + `populate_existing=True` 击穿 ORM 恒等缓存）后，仅在
  QUEUED / RUNNING+过期租约 / legacy 无租约无 started_at 三种情形 +1；RUNNING+存活租约 →
  `BUSY`（心跳在续租，任何时长的构建都不可被夺走）；RUNNING+无租约但有 started_at
  （迁移前状态、过期不可证）→ `BUSY`（没有过期证据绝不双跑）。
- **claim 返回值**从裸字符串改为 `ExecutionClaim(decision, generation, status)`，覆盖
  `EXECUTE/BUSY/TERMINAL/MISSING`；对外 `build_collision` 结果契约（`ok/duplicate/
  job_status/error/superseded`）保持兼容，既有 worker 测试不受影响。
- **每代次独立输出目录**：`collision/<sid>/versions/<asset_version>/jobs/<job_id>/
  attempts/<generation>/`；资产行 `metadata_["executionGeneration"]` + build_params 记录代次，
  两个代次的文件绝不互写（A-02/A-06）。

## 4. PART A —— 租约心跳（真实心跳，不是 TTL 拉长）

- `LeaseHeartbeat(job_id, generation, ...)`：后台线程名 `collision-lease-<jobId>`，每
  `_HEARTBEAT_INTERVAL_S=30.0` 通过**独立短生命周期 Session**执行
  `UPDATE jobs SET lease_expires_at = <db_now + TTL> WHERE id=? AND execution_generation=?
  AND status='RUNNING'`（代次 + 状态围栏的 WHERE）。TTL 300s 只约束“崩溃回收”，存活的任何
  时长的构建由心跳持续续租。
- **DB 时钟为唯一权威**：续租用 `clock_timestamp()`（`_db_now`），跨进程/主机/重启可比；
  绝不持久化 `time.monotonic()`（01.2 已立此规，本处沿用）。
- **失败有界**：单次续租异常指数退避重试（1→2→4→8s），超过 `_HEARTBEAT_MAX_RETRIES=3`
  → `lost=True` 并停止。`lost` 后 worker 不再持有租约承诺 → `_finalize_build` 的租约校验
  （§6）拒绝其提交（A-08：DB 死亡 → 有界放弃，线程不泄漏）。
- **正常结束必 stop**：生成成功/异常两条路径都在 `finally` 里 `stop()`（join 幂等），
  A-09 断言任务结束后无 `collision-lease-*` 存活线程；每次心跳独立 Session，`close()` 于
  `finally`，不打开无限连接（PART E）。
- 真正心跳被调用的实证：A-01 用 0.15s 间隔观察到租约**持续推进**（> 首次租约）后，301s
  龄的存活构建重投递被拒（`duplicate`），随后 A 正常 SUCCEEDED、代次仍为 1。

## 5. PART A —— 崩溃回收接入既有周期协调（孤儿 RUNNING 不再靠 Celery 重投递）

- 回收**真实挂接**在既有 systemd 定时器链路：`tasks.cleanup_expired_uploads`（systemd
  timer）→ `CollisionService.reconcile_auto_collision()` → `ensure_auto_collision_for_
  current_version`（01.1 已建立的入口）。本修复在该入口新增孤儿租约分支：RUNNING + 租约
  过期 → 重新 QUEUED + 清租约 + `sending:` claim + 走 `_dispatch_build` 重派**同一 Job**
  （worker 代次围栏使重复投递安全，不叠第二个 Job 行）。
- **回收上限** `_MAX_AUTO_RECOVERY_ATTEMPTS=3`：`execution_generation >= 3` 的孤儿不再自动
  复活，碰撞行置 FAILED（“请手动重建”），手动 `rebuild` 始终可用（A-12）。
- **存活租约绝不回收**：A-11 断言活心跳的 RUNNING 不被 reconcile 触碰、零重派发。
- 真实调度验证：A-10 在真实 DB 上做“worker 已 claim（generation=1）+ 租约过期”状态，调用
  与定时器相同的 `reconcile_auto_collision()` → 同一 Job 被重新 QUEUED + 清租约 + 重派
  1 次、不叠 Job；这证明回收逻辑真的挂在被调度的入口上（PART H 条件 3）。

## 6. PART A —— 代次 + 租约围栏的最终化 / 失败 / 取代（原子单事务）

- `_finalize_build(..., generation=)`：开头 `rollback()` 清边界 → 统一锁序
  `Scene(of=Scene) → CollisionAsset → Job`（沿用 `of=Scene` + `populate_existing=True`，
  绝不用 naive JOIN 锁）→ 新鲜读取 → 校验：版本未变、`coll.job_id==job_id`、
  `job.scene_id==scene_id`、`job.status==RUNNING`、**`job.execution_generation==generation`**
  、**租约仍有效**（`lease_expires_at > db_now`）、“sourceVersionId”（若有）== 钉扎版本。
  任一不过 → `_mark_superseded`（§7）；全过 → 资产行 + 碰撞行 + Job 行**同一 COMMIT**。
  因此“心跳无法保证租约 → worker 丧失提交权”（任务书原话）被精确执行。
- `_mark_superseded(..., generation=)`：同一锁序内区分三种情形 ——
  ① 同 Job 已被**更新代次** RUNNING 持有或已终态 → `OLD_EXECUTION_SUPERSEDED`，**零写入**
  （旧代次不得 FAIL 新代次的 Job / 碰撞 / 文件；A-04/A-07）；
  ② 版本移动或另一 Job 接管碰撞 → 本 Job 才是真陈旧 → FAIL 本 Job
  （`COLLISION_SUPERSEDED`）+ 仅当碰撞仍属本 Job 时 FAIL 碰撞（A/B 01.2 既有语义保持）。
- `_fail_build(..., generation=)`：失败路径同样重新加锁 + 新鲜读取；`generation=None`
  （从未赢得 claim）或 Job 已进入更新代次 / 终态 → **零写入**；仅当代次仍归本执行时才 FAIL
  Job（`COLLISION_BUILD_FAILED`）+（若碰撞仍属本 Job）FAIL 碰撞（A-05/B-04/B-05 语义）。
- `_still_owned` 廉价预检增加代次 + 状态 + 租约检查（生成前的快速失败，权威判定仍在最终化）。

## 7. PART A 既有兼容路径

- **legacy 直接调用**（pre-01.3 手动置 RUNNING、`started_at=None`）→ 视为无租约执行，
  采纳（mint 代次 + 新鲜租约）后照常构建（`test_collision_concurrency._new_job_and_collision`
  全套 GREEN）。
- **pre-01.3 5 参任务**（无 `source_version`）→ 回退当前版本构建（A-12 worker、01.1 §D
  语义保持）。
- **旧平面输出目录**（`.../jobs/<jobId>/` 无 `attempts/`）的 legacy 测试已升级为 per-attempt
  断言；`test_legacy_single_build_layout_still_serves` 的服务端回退路径未动。

## 8. PART B —— broker 回调安全状态机（`_record_broker_failure`）

新契约（真实 DB 状态机，B-01..B-10）：
1. claim 已被接管/替换 → `False`，不写任何东西（B-03/B-04）。
2. Job 为 RUNNING（worker 正构建）或终态（SUCCEEDED/FAILED/CANCELLED）→ `False`，**永不
   翻转**（B-01 RUNNING 保持 RUNNING；B-02 SUCCEEDED 保持 SUCCEEDED；B-07 旧发送方晚期失败
   不触碰新版本 Job/碰撞）。
3. Job 仍 QUEUED → 结局**不确定**（网络错误 ≠ broker 拒绝；accepted-but-lost-reply 真实存
   在）→ 清 claim + 清错误码 + 保持 QUEUED（**可恢复的 dispatch-incomplete**），让周期协调
   重派同一 Job；**绝不置 FAILED**（B-05：QUEUED 保持 QUEUED、claim 清空、`error_code`
   非 `COLLISION_DISPATCH_FAILED`、碰撞非 FAILED）。

配套统一：
- `_dispatch_build`（自动 + 接管共用）失败分支：`status="QUEUED"`、message
  “派发未确认（将自动重试）”，调用上述状态机（`_take_over_stale_claim` 分支同改）。
- **手动路径契约唯一化**：`create_and_build` / `rebuild` 不再各自内联 send/except，改为
  与自动路径同一 `_dispatch_build`（新 Job 带 `sending:` claim 于同一事务，commit 后派发，
  claim 守卫确认/可恢复失败）。B-08（手动 create 晚期超时 → 全链路保持 QUEUED 可恢复，
  随后 worker 成功成立）/ B-09（手动 rebuild 同契约）/ B-10（重复回收不叠 Job 不风暴）。
- `_dispatch_build` 的 `current_version` 允许 `None`（未发布场景手动构建：不写版本绑定，
  worker 回退当前版本）。
- 三个旧断言 FAILED 语义的测试（01.0 ×2、01.1 ×1）已改为新“可恢复”契约（§12 C1/C2）。

## 9. PART C —— 移除恒真断言并强化真实断言

- 01.2 遗留的 `assert _job_claim(db, job.id) != stale or True`（恒真）已移除，替换为
  A-09 语义的真实 CAS 断言：旧 claim 必须被原子替换（`!= stale`），且新 claim 要么是已确认
  broker id、要么是格式合法的 `sending:` claim，**原始陈旧 token 不可再恢复**（否则旧版本
  仍可从该 Job 被派发）。
- 扫描相关测试：未发现其它 `or True` / `assert True` 恒真断言（本项目仅修本处，不做全局
  清理，符合任务书 PART C 范围）。

## 10. PART D —— 真实验证证据

- **真实 PostgreSQL 并发**：A-03 两线程竞夺同一过期租约（`build_collision.apply(...).get()`，
  各自独立 SessionLocal）→ 恰好一个赢家（generation=2）、另一为 duplicate、生成器只跑一次；
  B-04/B-10 覆盖 claim 替换与重复回收。全部线程 + 显式超时（无 301s 睡眠，时基由编辑持久化
  租约推进）。
- **真实长运行控制流**：A-01 真实心跳（0.15s 间隔观察租约推进）+ 301s 龄存活构建重投递被拒
  （无需真实 300s 等待，时基由 `_age_started_at` 编辑持久化状态推进，心跳为真实线程）。
- **真实 CLI 全链路**：`/tmp/gs_e2e_upload01.py` 对**新代码**（本会话重启的 8011 API + 真实
  Celery `gsplatform,cpu` worker + 真实 PostgreSQL + 真实 splat-transform CLI）完成
  PLY(14.7MB, 59,400 高斯) → 上传 → 发布 → SOG → 自动碰撞 OUTDOOR → `collisionStatus=
  SUCCEEDED` → 真实 voxel.json(663B)/.bin(205KB)/.glb(1.43MB) 以 200 被服务；随后 DB 复核：
  `execution_generation=1`、资产键含 `attempts/1/`、`metadata_["executionGeneration"]=1`。
- **workers pytest 全绿**：`55 passed`（含真实 CLI 构建用例 `test_real_cli_collision_build_
  produces_artifacts`，node_modules 在场非 skip）。
- **backend pytest 全绿**：`tests` 全套退出码 0（含 fix0621 部署前检在迁移提交后通过）。
- **web**：typecheck ✓ / oxlint ✓ / 254 单测 ✓ / build ✓。
- **Playwright**：`fix-upload01-viewer.spec.ts`（真实 viewer 加载流式 SOG，51 chunk 请求，
  gsplats>0 渲染）+ `ssv07-collision.spec.ts` 3/3（walk 碰撞阻止穿出 voxel 网格、退出恢复、
  无碰撞场景 walkAllowed=false、XR 消费碰撞数据）→ 4/4 GREEN。
- **clean-checkout gate**：`verify_release_source.sh` → `GATE_EXIT=0`（§16）。
- **迁移验证**：`upgrade head` 幂等、`current == head == f6a7b8c9d0e1`、单 head；
  既有数据抽查：PUBLISH(692)/RECONSTRUCT(167) 行 `execution_generation=0` 且 `lease_expires_at`
  IS NULL（**其它 JobKind 完全不受影响**）；场景/版本/资产/碰撞行数量保持；BUILD_COLLISION
  历史 RUNNING 行租约为空 → 按 §4 legacy 分支处理（不误杀）。部署顺序：迁移 → 新 worker
  代码，见 §13。

## 11. PART E —— 安全与资源约束

- **内部字段不可由 HTTP 设置**：schema 层零暴露 `execution_generation/executionGeneration/
  lease_expires_at/leaseExpires/celery_task_id/sending:`（`app/schemas/` 与 `app/api/` 全查
  无字段）；claim 一律服务端生成；request body 任何字段不参与接管判定与工件路径构造。
- **路径服务端生成**：输出相对路径由 worker 依 `<jobId>/attempts/<generation>` 构造，
  版本绑定只来自 DB 当前 SceneVersion；HTTP 请求体无法注入路径段。
- **无秘密泄露**：本报告/日志/测试不出现 broker 口令、DB 口令、secret key、用户私文件；
  错误消息截断至 1000 字符且不附 broker 细节。
- **心跳连接受控**：每拍独立 SessionLocal，`finally close()`；A-08 证明 DB 死亡时有界放弃，
  A-09 证明无线程泄漏；未打开无限连接。
- 所有者鉴权 / CSRF / SceneAccessPolicy / 私有场景 / share / 存储隔离 / Cache-Control 均未
  改动，保持 01.2 既有测试全绿。

## 12. 测试清单（RED → GREEN）

- **workers/tests/test_collision_execution_fencing.py（新增，10 用例）**：A-01 心跳保活长构建；
  A-02 过期租约回收新代次；A-03 单赢家竞夺；A-04 旧代次晚期成功被拒；A-05 旧代次晚期失败
  不 FAIL 新代次；A-06 代次目录隔离；A-07 已提交构建不被旧代次污染；A-08 心跳 DB 死亡有界
  放弃；A-09 正常结束无泄漏；A-12 legacy 5 参任务回退当前版本。
- **apps/api/tests/test_fix_upload013.py（新增，13 用例）**：B-01..B-10 回调状态机
  （B-01/B-02/B-08/B-09 走真实 DB 转态）；A-10/A-11/A-12 调度回收（含上限与手动重建）。
- **更新（3 处旧语义）**：`test_fix_upload01.py`×2、`test_fix_upload011.py`×1 的派发失败
  断言改为可恢复 QUEUED 契约；`test_fix_upload012.py` 恒真断言替换为真实 CAS 断言（§9）；
  `test_fix_upload011_security.py` 手动 build 桩对齐统一 `_dispatch_build` 签名。
- **更新（per-attempt 目录）**：`workers/tests/test_collision_concurrency.py`（fake 写入
  worker 传出的代次目录）、`workers/tests/test_build_collision_version.py`（同）。
- 既有 `test_collision_atomic_finalize.py`（9）/ `test_collision_concurrency.py`（8）/
  `test_build_collision_version.py` / `test_collision_stale.py` 全绿，无 skip/xfail/弱化。

## 13. 迁移（Alembic）

`apps/api/migrations/versions/f6a7b8c9d0e1_fixupload013_collision_execution_lease.py`，
revision `f6a7b8c9d0e1`，down_revision `c1d2e3f4a5b6`：
- `upgrade`：加 `execution_generation`（BigInteger NOT NULL `server_default=0` +
  `execution_generation_non_negative` CHECK）、`lease_expires_at`（timestamptz NULL）；
  `downgrade` 反向删除。
- **存量安全**：历史行 `execution_generation=0`、`lease_expires_at=NULL`；RUNNING 旧行按
  §4 legacy 分支（`started_at IS NULL` → 采纳；否则 BUSY 不双跑）。零数据重写，幂等。
- **部署顺序**：先 `alembic upgrade head`（API 停写窗口内），再部署新 worker 代码；
  旧 API + 新 worker / 新 API + 旧 worker 的组合在代次列存在时均不破坏既有行为。
- 已在测试/开发库执行：`upgrade head` 幂等 → `current==head`；其它 JobKind 抽查见 §10。

## 14. 诚实边界（不夸大）

- 心跳间隔、TTL、回收上限是运维参数（30s/300s/3 次）；极端情况下“心跳进程存活但 DB 写失败
  超过 8s×3”仍会 `lost` 并在最终化被拒 —— 这正是设计意图（无法保证租约就无权提交）。
- 回收上限到顶后的手动 `rebuild` 是唯一出路（A-12 验证可用），无自动无限重试。
- PICO Neo3 农业场景真机测试由用户执行，本报告不声称硬件验收通过。
- 若 `GATE_EXIT` 非 0，本修复按 PARTIAL 处理并在 §16 记录，不得写全 PASS。

## 15. Git 卫生

- 两枚提交：`fix(collision): fence long-running executions and broker callbacks`、
  `test(collision): verify lease recovery and late callback races`；推送后 `HEAD == origin/main`；
  无 force push / 无 reset --hard；工作树干净；无 node_modules/.venv/生成二进制/
  上传文件/秘密进入提交（`verify_release_source.sh` §1 亦复核归档无 `.git/.env/.venv/
  node_modules`）。

## 16. 提交与门禁结果

- 提交（本修复两枚，`main`，基线 `4ba7ed5`）：
  1. `fix(collision): fence long-running executions and broker callbacks` —— 实现 +
     迁移 `f6a7b8c9d0e1`（Job 模型、API 派发/回调状态机、worker 代次+心跳+per-attempt+围栏）。
  2. `test(collision): verify lease recovery and late callback races` —— 全部新旧测试
     （A/B 用例、旧语义更新、per-attempt 目录迁移、01.2 恒真断言替换、A-02 竞态修复），
     并收录本报告 `docs/reports/FIX_UPLOAD_01_3_EXECUTION_FENCING.md`。
- `verify_release_source.sh` → **GATE_EXIT=0**（exit 0，`RESULT: PASS`）：fresh venv 干净检出
  上源码完整性、依赖安装、API+storage+workers import closure、ruff、mypy、backend pytest 全套、
  workers pytest（51 passed + 4 skipped——CLI 用例因归档无 node_modules 诚实跳过）、重建运行时
  契约（torch 2.14.0+cu126 / gsplat 1.5.3 / CUDA 光栅化 PASS）全绿。
- **诚实边界修正记录**：01.2 遗留的 `test_a02_fresh_claim_59s_...`（59s claim vs 60s TTL，仅 1s
  余量）在本机复现为 ~15% 概率的竞态失败（ensure 路径自身 DB 开销偶尔 >1s 使 claim 越界）；
  该测试存在于基线 `4ba7ed5`、本修复未改 TTL/`_claim_expired`，属既有 flake。已改为 30s
  （断言仍为“fresh claim 不被接管”），TTL 边界由 A-03（61s→接管）确定性证明；6/6 稳定通过。

## 17. 结论

**FIX-UPLOAD-01.3: PASS**

11 项前提条件逐一可证：①代次单调且只在 claim 事务内推进；②心跳真实续租（A-01 观察推进、
A-08 有界放弃）；③回收挂接在既有调度入口（§5 真实路径 + A-10）；④最终化/失败/取代全围栏
（A-04/05/06/07）；⑤旧代次零写入（A-04/A-07）；⑥晚期回调不翻转 RUNNING/SUCCEEDED
（B-01/B-02 真实转态）；⑦不确定结局可恢复而非 FAILED（B-05/B-08/B-09）；⑧手动/自动同一
派发契约（B-08/B-09 + 三处旧测试更新）；⑨per-attempt 输出目录 + 代次元数据（A-06 + 真实
E2E DB 复核）；⑩内部字段零 HTTP 暴露 + 服务端路径（§11）；⑪无秘密泄露 + 心跳连接受控
（§11/A-08/A-09）。任务书禁止项全部未触碰（PART F）。

**UPLOAD → STREAMED SOG → AUTO COLLISION: SOFTWARE RELIABILITY ACCEPTED**
**READY FOR AGRICULTURAL SCENE HARDWARE TEST**
