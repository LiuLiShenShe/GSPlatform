# GS-NEXT-00 — 开发基线收口、路线锁定及现有测试阻塞修复

> 任务编号：**GS-NEXT-00**
> 日期：2026-10-13
> 仓库：`/fj/GSPlatform` · [GitHub](https://github.com/LiuLiShenShe/GSPlatform)
> 起始 HEAD：`93083af4ab2f1eade24637ed15a88272799af3b3`（`main` == `origin/main`，工作树 clean）
> 本报告结论：**软件适用门禁通过；PICO 真机验收仍为 `HARDWARE PENDING`。**

---

## 1. 当前 HEAD 与仓库状态

| 项目 | 值 |
| --- | --- |
| 起始 HEAD | `93083af4ab2f1eade24637ed15a88272799af3b3` |
| 分支 | `main`，与 `origin/main` 同步 |
| 起始工作树 | clean（`git status --short` 空） |
| 本轮修改文件 | `apps/api/tests/test_editor_publication.py`、`docs/GSPlatform_WebXR_VR_Master_Plan.md`、新增本报告 |
| 危险操作 | **无** `reset --hard`、**无** `git clean`、**无** force push |
| 其他工作者未提交变更 | 未处理、未覆盖（起始即为 clean，无他人改动） |

### 1.1 预检读取的真实文档

`docs/GSPlatform_WebXR_VR_Master_Plan.md`、`docs/reports/VR_01C_PICO_PERFORMANCE.md`、
`docs/reports/VR_01D_GAUSSIAN_CLEANUP.md`、`docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md`、
`docs/operations/VR_01C_PICO_TEST_GUIDE.md`、`README.md`。
均**同时核对了真实代码**（见 §4、§5、§7），未只依据报告结论。

### 1.2 基线中发现的两个仓库级事实（如实记录，非本任务引入）

1. **VR-01D 的代码与报告实际已进入 HEAD，与 VR-01D 报告"无交付 commit"的陈述不符。**
   VR-01D 报告 §21 声明"无交付 commit、无 push（软件失败门禁阻止）"，但其三个新文件
   （`workers/pipeline/gaussian_quality.py`、`workers/pipeline/cleanup_experiment.py`、
   `workers/tests/test_cleanup_experiment.py`）连同 `docs/reports/VR_01D_GAUSSIAN_CLEANUP.md`
   已随 `93083af` 一并提交。该 commit 同时删除了 89 个旧文档（18,830 行）。
   **结论**：VR-01D 的软件门禁当时是失败的（26 个日期夹具失败），但产物已被提交。
   这正是本任务第 3 步要解除的阻塞。

2. **`README.md` 存在 5 处失效链接**（指向 `93083af` 中一并删除的文档）：
   `docs/SSV_09_REPORT.md`、`docs/adr/ADR_SUPERSPLAT_RUNTIME.md`、`docs/SSV_MIGRATION_PLAN.md`、
   `docs/reports/SSV_FINAL_ACCEPTANCE.md`、`docs/reports/PRODUCTION_RUNTIME_ACCEPTANCE.md` 全部不存在。
   这是用户自有文档删除的延续，**本任务不恢复、不清理**，仅记录待后续单独处理。

---

## 2. 四阶段开发路线及被删除的旧业务要求

主计划已重写为 V2.0（`docs/GSPlatform_WebXR_VR_Master_Plan.md`），正式锁定**四阶段**：

| 阶段 | 名称 | 定位 |
| --- | --- | --- |
| 1 | 平台基础 | 上传/权限/版本/资源/部署 |
| 2 | PlayCanvas 官方组件整合 | 薄适配，杜绝重复实现 |
| 3 | WebXR / PICO VR 真实体验 | 真机闭环（当前卡在硬件） |
| 4 | Web + VR 共用场景体验优化 | 初始视角 / 清理 / 视点 / 快速切换 / 热点 / VR 内交互 |

### 2.1 被删除的旧业务要求

| 删除项 | 处置 |
| --- | --- |
| `AGRI-01` 农业数字孪生阶段（单株/作物行/温室、植物实例、测量数据、表型、多时相绑定） | **删除**：不再是阶段、不是验收项、不排期 |
| V1.0 中"农业业务最后扩展""农业数字孪生业务"的后续路线表述 | **删除** |
| 农业/温室相关 PASS 判据与产品定义 | **删除** |
| 官方 SuperSplat Studio 托管产品（账号/发布/计费/托管存储） | 降级为**仅体验参考** |

### 2.2 历史业务场景的处置

历史场景 `u-06924576399e`（13,090,324 Gaussian / `streamed-sog` / Recipe v2）
**保留为历史测试资产与压力测试样本**，理由：已被冻结为不可变 SceneVersion，
且是当前唯一的真实大场景 XR 负载证据来源。

**但它不再是产品目标、不是演示要求、不是行业样例。** 任何重新转换/覆盖/发布/清理推广都需单独授权。

### 2.3 统一实施顺序

阶段 4 的四项有严格依赖，主计划已固定顺序（不可跳步）：
**初始视角 → Gaussian 清理 → 预设视点与快速切换 → XR 导航 → 热点与 VR 内交互。**
理由：初始视角是唯一同时影响桌面构图、XR 出生点和后续导览点坐标基准的能力，坐标基准错了后面全部偏移。

### 2.4 状态标记

全文统一 `IMPLEMENTED` / `SOFTWARE VERIFIED` / `HARDWARE PENDING` / `NOT IMPLEMENTED`，
并明示铁律：**代码存在 ≠ PICO 验收通过**。

---

## 3. 官方组件复用清单

已交叉核对**固定版本的实际安装源码**（非记忆、非 `main` 文档）：

| 能力 | 官方来源 | 锁定版本 | 平台现状 |
| --- | --- | --- | --- |
| 场景渲染 / Gaussian raster | SuperSplat Viewer | `1.35.0` | 已接入（唯一 Viewer） |
| SOG / LOD / 分块 / voxel 碰撞 | SplatTransform CLI | `3.3.3` | 薄适配 + 校验 |
| WebXR / XR manager / 手柄 | PlayCanvas Engine | `2.22.4` | 官方自动装载 |
| **摇杆移动 / Snap Turn / 弹道传送** | Engine `xr-navigation.mjs` | `2.22.4` | **官方自动装载，未真机验收** |
| XR 菜单 / 手柄操作 | Engine `xr-menu.mjs` / `xr-manipulation.mjs` | `2.22.4` | 可用，未接入 |
| 相机动画 / 相机过渡 / annotation 导航器 | Viewer `camera-manager` | `1.35.0` | 已复用 |
| Gaussian 编辑 / 裁剪 | 官方 SuperSplat Editor | 自部署 | 已接入 |
| 渲染预算 / Performance Mode | Viewer `state.performanceMode` | `1.35.0` | 薄封装 |
| 深度拾取 splat 表面 | Viewer 内部 `Picker.pickSurface` | `1.35.0` | **非公开 API，不得声称可用** |

### 3.1 主计划与 VR-03 预审的差异修正（本任务要求项）

任务明确要求修正"官方 XrNavigation 已经存在，XR 下 `setMoveInput` 不是摇杆控制替代品"。
已用固定版本源码核实并写入主计划 §3：

```js
// node_modules/@playcanvas/supersplat-viewer/dist/viewer.js（1.35.0, initXr）
parent.script.create(XrControllers);
parent.script.create(XrNavigation);
```

- 官方 `XrNavigation` **已存在且已装载**——VR-03 预审中"需要验证其能否合法接入"的问题**实际不成立**。
- `setMoveInput` 是桌面 fly/walk 输入，**在 immersive XR 中被忽略**，不是摇杆控制替代品。
- 官方 XR 起点表达式 `parent.setPosition(cameraPosition.x, 0, cameraPosition.z)` 会**丢弃已保存相机高度**（Y 强制 0）——
  这正是"进入 XR 前桌面相机正确 ≠ 头显出生点正确"的源码级证据。
- 官方 `selectAnnotation` 在 `app.xr.active` 时不移动 XR Rig，故"Web 端点一下即 VR 传送"是错的。

### 3.2 架构要求保留

主计划保留并强化：**唯一 Viewer**、**唯一 Runtime Descriptor**、**唯一授权资产服务**、
**SceneVersion 唯一真相源**（§2.1 四条不可协商约束）。

---

## 4. 初始视角的真实现状与未验收项

### 4.1 逐项核查（对照真实代码）

| 核查项 | 结论 | 证据 |
| --- | --- | --- |
| 保存当前视角是否真实持久化 | **是** | `SceneAuthoringPage.tsx:229-244` `getCurrentPose()` 经 `runtime.worldTransform.runtimeToSceneCamera` 做 **Runtime→Scene 逆变换**；`useSceneAuthoring.ts:138-146` `setInitialView()` 乐观更新 + `saveExperience(patch)` 落库 |
| Desktop 是否正确恢复 authored camera | **是** | `initialCameraPolicy.ts:25` `shouldFrameSceneOnLoad()`；`useSuperSplatXR` 等 `syncReady()` 中 scaled 到 `runtime.resetCamera()` |
| 无 authored camera 时是否采用官方 fallback | **是** | 同一分支 `runtime.frameScene()` |
| 是否有官方默认动画导致视角自动漂移 | **已定位并缓解** | 官方 `CameraManager` 无显式 track 时仍生成 orbit/figure-8；加载后一次 `resetCamera()` 恢复 authored 姿态（VR-01C §2 root cause） |
| 坐标变换 Scene→Runtime→XR Rig 是否一致 | **是** | `experienceAdapter.ts:169` `adapter.sceneToRuntimeCamera()` 生成 `cameras[0].initial`；`xrInitialCamera` 复用同一 runtime pose（`useSuperSplatXR.ts:257`） |
| XR 首次定位是否只执行一次、不覆盖 HMD 6DoF | **是** | `SuperSplatRuntime.ts:422-460` `prepareXRSpawn()` 在 `finally { cancel() }` 中注销订阅 → 一次性；仅写 rig，不写 head camera |
| 返回和重新进入 XR 是否有状态泄漏 | **是（已处理）** | 每次 `startVR()` 前 `cancelXRSpawn?.()`；`xr.on('end')` 订阅清理；`destroy()` 清空 `unsubscribers` |

### 4.2 运行的真实 Playwright 证据（`fix02-semantics.spec.ts`，只读 GET）

命令：`cd apps/web && npx playwright test e2e/fix02-semantics.spec.ts --reporter=list`
结果：**6 passed / EXIT=0（43.3s）**，直接验证初始视角全链路：

- 加载即用 authored Initial Camera（`[2.5,1.8,6]` / fov 47，与 DB 一致，未被 frameScene 覆盖）
- Frame Scene 取景全场景；Reset 严格恢复 authored Initial
- 已保存 Viewpoint 被消费（相机过渡到 `[3,2,7]` / fov 52）
- 3 条标注各自相机互不相同（A→A / B→B / C→C）
- World Transform `rotation y=90` 实体/相机/包围盒统一换算
- XR 页（强制 WebGL）加载后 camera pose 与 DB authored initial 一致

Web 单元测试同时覆盖策略层：`src/__tests__/initial-camera-policy.test.ts`（6 例，
含 `position=[0,0,0]` 不被零值猜测）、`super-splat-runtime.test.ts`（含 authored 经 W 变换的首次 XR eye）。

### 4.3 未验收项（诚实边界）

| 未验收项 | 状态 |
| --- | --- |
| 真实 PICO `local-floor` 出生位置与首个 tracked eye | **`HARDWARE PENDING`** |
| 真机头部 6DoF 是否被 rig 放置覆盖 | **`HARDWARE PENDING`**（软件已证只写一次 rig，不写 head） |
| 历史 13M 场景的 authored 出生点 | **未设置**。实测该场景 descriptor `initialCamera` 仍全为 `null`、无 viewpoints/annotations/collision，因此当前只能走官方 `frameScene()` fallback |
| 摇杆移动 / Snap Turn 真机手感 | **`HARDWARE PENDING`** |

**未做任何相机新增实现**：复用官方 `resetCamera` / `frameScene` / `selectAnnotation`，
未新增第二套相机控制、独立 Viewer 或自研 XR Rig。

---

## 5. VR-01C PICO 真机待验收项

VR-01C 签署的只是**软件门禁**与诊断/官方开关/初始相机路径，**不签署 PICO 帧率、真实起点或加载时限**。

| 待真机项 | 状态 |
| --- | --- |
| `immersive-vr` 真实进入、双目立体 | `HARDWARE PENDING` |
| 6DoF 与退出/重入（≥3 次） | `HARDWARE PENDING` |
| PICO Neo3 实际渲染预算档位（25万/50万/100万 实验档） | `HARDWARE PENDING` |
| 大场景流式分块在真机的持续加载与近景卡顿 | `HARDWARE PENDING` |
| Performance Mode ON/OFF 真机收益 | `HARDWARE PENDING`（桌面证据不可移植） |
| 摇杆移动 / 右摇杆 Snap Turn | `HARDWARE PENDING` |
| authored 起点在真机的实际落点 | `HARDWARE PENDING` |

**待回传字段**（按 `docs/operations/VR_01C_PICO_TEST_GUIDE.md` §必须回传）：
`browser`、`network`、`timing.timeToFirstGaussianFrameObservedMs`、`timeToLoadedMs`、
`timeToXRSessionStartMs`、`xrEnterDurationMs`、`samples[].frames[xr-session-callback]` 的 P50/P95/FPS/stall、
`runtime.renderedGaussians`、`resourceSummary`、`runtime.xr` rig/head 状态、Performance Mode ON/OFF、观察距离与三类卡顿判定。

**本任务未伪造任何真机数字**：诊断 JSON 中 PICO 不提供的字段保持 `unavailable`。

---

## 6. VR-01D 清理 Pilot 状态

### 6.1 工具与证据仍存在（只读核对）

| 项目 | 核对结果 |
| --- | --- |
| `workers/pipeline/gaussian_quality.py` | 存在（149 行），只读 `np.memmap`，`CHUNK_ROWS=131072`，与报告一致 |
| `workers/pipeline/cleanup_experiment.py` | 存在（204 行），文件头声明 "No database, queue, or publishing path" |
| `workers/tests/test_cleanup_experiment.py` | 存在（282 行），`pytest` 37 passed |
| 证据根 `~/.local/state/gsplatform-vr00-20261011/vr01d/` | 存在（56M），含 analysis/pilot/candidates/comparisons/official/reports |

### 6.2 Pilot 候选状态（直接读取 `candidate-manifest.json`）

```text
experimentId:   CANDIDATE_FLOATERS_PILOT
status:         WAITING_FOR_APPROVAL
visualReview:   PENDING
qualityReview:  HOLD_NOT_APPROVED / ROI_ONLY
publishingEnabled: False
filters:        floaters(0.25, 0.1, 0.0039215686)
input → output: 94,747 → 93,982（删除 765 / 0.8074134273380662%）
officialToolVersion: 3.3.3
sourceUnchanged: True
sharedGridNewlyEmptyCells: 154 ; removedInInteriorReviewCore: 193 ; fullSceneSafetyProven: False
```

**维持 `HOLD_NOT_APPROVED / ROI_ONLY`。** 与 VR-01D 报告逐值一致。

### 6.3 边界遵守情况

- **未**重新转换、覆盖、删除、发布历史 13M Gaussian 资产（见 §6.4 完整性复核）。
- **未**把 Pilot 参数推广到完整场景；`cleanup_experiment.py` 对 `>1_000_000` 行输入仅在**单一 `box`（抽取）**时放行，
  其余大规模过滤直接拒绝。
- **未**启动新的完整大规模过滤。
- 工具仅白名单官方 CLI 参数，含 source↔runtime 坐标转换（Z180: `-x,-y,z`）、源 SHA 校验、
  输出目录隔离（必须新建、在 repo/storage 之外、非符号链接），无 DB / 无 Celery / 无 publish 路径。

### 6.4 历史资产完整性复核（本任务实测，只读）

| 复核项 | 结果 |
| --- | --- |
| 源 PLY `raw-input.ply` 字节数 | `3,246,401,885`（与报告一致） |
| 源 PLY SHA-256 | `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` — **与已知源 SHA 一致** |
| `da7bf4207044` 发布树全部文件 | **2,076 / 2,076 文件 SHA-256 逐项一致，CHANGED=0，MISSING=0** |
| `lod-meta.json` 可服务性 | HTTP 200，1,758,379 bytes，16ms |

**历史 13M 资产未被本轮任何操作触碰。**

---

## 7. 日期夹具修复（或不复现的证据）

### 7.1 独立复现：当前 HEAD **仍存在问题**

在隔离环境（独立 DB `gsplatform_next00_tests`，Alembic 至 `cd03ef05ab06`；独立 storage）
定向运行 `apps/api/tests/test_editor_publication.py`：

```text
37 collected → 26 FAILED
FAILED ... test_existing_valid_spatial_binding_is_invalidated_atomically[VALID|VERIFIED]
FAILED ... test_completed_publication_replay_is_read_only[current|advanced|expired]
FAILED ... test_same_content_new_session_does_not_invalidate_spatial_state[None|VALID|VERIFIED|STALE]
FAILED ... test_consecutive_edits_preserve_original_binding_and_latest_invalidation[VALID|STALE]
FAILED ... test_reusing_historical_version_is_a_real_geometry_change
FAILED ... test_publication_failure_rolls_back_all_database_changes[...×6]
FAILED ... test_completed_session_cannot_be_retargeted[version|sha|manifest]
FAILED ... test_spatial_invalidation_does_not_grant_editor_write_access[anonymous|share|other]
FAILED ... test_two_sessions_final_scene_lock_and_cas_prevent_lost_update[False|True]
```

**与 VR-01D 报告的 26 例完全吻合。结论：当前 HEAD 仍复现。**

### 7.2 根因

```text
psycopg2.errors.CheckViolation: new row for relation "scene_edit_sessions"
  violates check constraint "ck_scene_edit_sessions_expiry_valid"
[SQL: UPDATE scene_edit_sessions SET ... expires_at=%(expires_at)s ...]
[parameters: {'expires_at': datetime(2026, 10, 12, 12, 0, tzinfo=UTC), ...}]
```

夹具 `publication_clock` 冻结在 **2026-10-11 12:00 UTC**，
`publication_edit()` 把 `expires_at` 设为 `clock.instant + 1day` = **2026-10-12 12:00 UTC**。

而 `SceneEditSession.created_at` 使用 `server_default=func.now()`，
即**数据库真实墙钟时间**（运行日为 2026-10-13）。于是
`expires_at(10-12 12:00) < created_at(10-13)` 违反生产约束
`CheckConstraint("expires_at > created_at", name="expiry_valid")`。

这不是"软件 bug"，而是**测试夹具时间源不一致**：服务时钟被冻结，数据库时间没有。

### 7.3 修复（测试侧最小修复，符合约束）

`apps/api/tests/test_editor_publication.py` `publication_edit()` 中，
让 `created_at` 与 `expires_at` **来自同一个可控时钟**：

```python
# created_at and expires_at must come from the SAME controllable clock. The
# column defaults to database now(), so leaving created_at on wall-clock time
# makes the frozen publication clock expire the row in the past once real
# time passes the fixture instant, and ck_scene_edit_sessions_expiry_valid
# (expires_at > created_at) rejects it. The constraint is production
# behaviour and stays intact; only the fixture time source is controlled.
edit.created_at = clock.instant
edit.expires_at = clock.instant + timedelta(days=1)
```

**未**修改生产数据库约束、**未**关闭验证、**未**修改系统或 DB 时钟、**未** skip 任何测试。
与 `tests/test_editor_sessions.py:156-158` 已有的同类夹具（同时设置 `created_at` 与 `expires_at`）保持一致。
夹具因此**与真实日期无关，永久可复现**。

### 7.4 修复后

```text
apps/api/tests/test_editor_publication.py → 37 passed / 0 failed / EXIT=0
```

---

## 8. 测试结果与最终 Gate 结论

所有命令均在**隔离环境**执行，未触碰用户 dev DB（`gsplatform`）或 `/home/test/gsplatform-data`：

```bash
# 隔离测试环境（独立 DB gsplatform_next00_tests，Alembic head cd03ef05ab06；独立 storage）
GS_DATABASE_URL=postgresql+psycopg2://postgres:postgres@127.0.0.1:5432/gsplatform_next00_tests
GS_STORAGE_ROOT=/home/test/gsplatform-next00-storage
GS_SCENE_ORIGIN_ROOT=/home/test/gsplatform-next00-storage/origin
GS_ENV=development  GS_DEV_IDENTITY_ENABLED=true
```

| # | 门禁 | 命令 | 结果 | Exit |
| --- | --- | --- | --- | --- |
| 1 | Backend 定向 | `apps/api: python -m pytest tests/test_editor_publication.py -q` | **37 passed / 0 failed** | 0 |
| 2 | Backend 全量 | `apps/api: python -m pytest tests -q` | **560 passed / 0 failed / 0 skipped** | 0 |
| 3 | Backend ruff | `python -m ruff check app tests` | All checks passed | 0 |
| 4 | Backend mypy | `python -m mypy app` | no issues in 94 source files | 0 |
| 5 | Workers 全量 | `workers: python -m pytest tests -q` | **189 passed / 1 skipped** | 0 |
| 6 | Web 单元 | `pnpm --filter @gsplatform/web test` (vitest) | **30 files / 283 tests passed** | 0 |
| 7 | Web typecheck | `pnpm run typecheck` (`tsc -b --noEmit`) | 通过 | 0 |
| 8 | Web lint | `pnpm run lint` (`oxlint src`) | 通过 | 0 |
| 9 | Web build | `pnpm run build` | 通过（既有 large chunk warning） | 0 |
| 10 | Playwright VR-01C | `npx playwright test e2e/vr01c-pico.spec.ts`（隔离入口 `127.0.0.1:5174`） | **3 passed / 1 failed** | 1 |
| 11 | Playwright FIX-02 | `npx playwright test e2e/fix02-semantics.spec.ts` | **6 passed** | 0 |
| 12 | Clean checkout | `./deploy/scripts/verify_release_source.sh --from-commit 77300fe` | **PASS** | 0 |

### 8.1 Clean checkout（仓库现有安全脚本）明细

以临时 `GIT_INDEX_FILE` + `commit-tree` 构造 source-only 快照 `77300fe7eab8875c24b4af43eba43f96208923f7`
（**不 checkout、不移动 main、不改变用户 index**），对该快照运行仓库既有脚本：

```text
[1] Source integrity        PASS（无 .git/.env/.venv/node_modules；tracked storage/ 包存在）
[2] Fresh venv              PASS（pip install -e apps/api[dev]，独立 venv）
[3] Import closure          IMPORT_OK（API + storage + workers.celery_app + 3 个 task）
[4] ruff                    PASS
[5] mypy                    PASS（94 files）
[6] backend pytest          552 passed / 9 skipped / 0 failed
[7] workers pytest          155 passed / 35 skipped / 0 failed
[8] reconstruction runtime  PASS（torch/gsplat pinned；CUDA 可用；真实 gsplat CUDA rasterization 69 lit pixels / 8 splats）
RESULT: PASS — clean checkout → fresh deps → imports → lint/type/tests all green  (EXIT 0)
```

**对照 VR-01D**：同一脚本在修复前为 `EXIT 1`（backend 526 passed / **26 failed** / 8 skipped，
后续 archive Workers/reconstruction/Web 阶段 **NOT REACHED**）。本轮**全部阶段到达并通过**，
`GATE_EXIT=0`。这是"历史阻塞已被解除"的最强证据。

> 注：本轮未加 `--with-web-build`（该脚本的 fresh pnpm install + build 阶段）；
> Web 构建已在工作树独立验证（行 9，EXIT 0），二者不混作同一次收据。

### 8.2 跳过项说明（诚实记录，不当作已执行）

| 跳过项 | 数量 | 原因 |
| --- | --- | --- |
| Clean checkout backend | 9 | source archive 无 node/CLI/训练环境，属既有设计 |
| Clean checkout workers | 35 | 同上 |
| Workers 工作树 | 1 | `test_splat_transform_adapter.py:93` 的 `skipif(not Path(".git").is_dir())` 因 cwd 相对路径在 `workers/` 下误判跳过；从仓库根运行该用例 **1 passed**（已实测）。属既有测试作用域问题，非门禁失败，本任务未修改 |
| Playwright VR-01A | 全部 | 需显式配置 live public/private scene 环境变量，未配置 → 按设计 SKIP |

### 8.3 Playwright VR-01C 的 1 个失败：诚实判定 = `LIMIT REACHED`（环境性），非代码回归

```text
e2e/vr01c-pico.spec.ts:104 historical 13M real descriptor and bounded desktop WebGL2 A/B
  → expect.poll(loaded).toBe(true)  Timeout 100000ms exceeded
```

**判定：`LIMIT REACHED`，不纳入功能 PASS，也不隐藏。**

| 证据 | 说明 |
| --- | --- |
| 前端代码自 VR-01C 绿测以来**未变** | 本轮唯一代码改动是 Python 测试夹具；`f95f5aa` 之后仅有文档提交 |
| 页面**功能正常**，非报错 | 失败时页面快照显示 `Performance Mode: ON · Gaussian: 597389`（正在渲染 59.7 万 Gaussian） |
| 资源服务**正常** | `lod-meta.json` 200 / 1,758,379 B / **16 ms** |
| 机器**极度争用** | load average **45 → 90 → 107**；64 核；两张 RTX A6000 分别 93–100% / 99%，由外部任务占用；`vmstat` 显示 CPU steal 26–59% |
| 该用例本就**临界** | VR-01C 记录的三次 `/xr` loaded = 75,228.9 ms / 74,046.3 ms / 79,042.9 ms，对 **100,000 ms** 上限仅约 21–25% 余量 |

SwiftShader 软件光栅是 **CPU 密集**的；在高争用下 843 MB 流式资产的 LOD 激活长尾超过 100s 是**预期的环境后果**，
与 VR-01C 已记录的"加载/LOD 激活长尾"同源。**未**放宽测试上限、**未** skip、**未**改断言使其通过。

同一 spec 的其余 3 项（小 SOG A/B + 偏好/导出、私有场景拒绝、authored 变换相机）**全部通过**，
且 FIX-02 的 6 项初始视角浏览器验证**全部通过**。

### 8.4 最终 Gate 结论

```text
GS-NEXT-00 SOFTWARE GATES: PASS
  BACKEND 560 passed / WORKERS 189 passed / WEB 283 passed
  RUFF + MYPY + WEB TYPECHECK/LINT/BUILD: PASS
  CLEAN CHECKOUT GATE: PASS (EXIT 0)   ← 历史 26 例阻塞已解除
  PLAYWRIGHT FIX-02 (initial view): 6 passed
  PLAYWRIGHT VR-01C: 3 passed / 1 LIMIT REACHED (environmental, 13M bounded load)
PICO NEO3 HARDWARE ACCEPTANCE: PENDING
VR-01D CLEANUP CANDIDATE: HOLD_NOT_APPROVED / ROI_ONLY (unchanged)
HISTORICAL 13M ASSETS: VERIFIED UNCHANGED (source SHA + 2,076 files)
```

**适用软件门禁通过 → 允许提交并正常 push 本任务自身改动。**
（唯一未绿者为 §8.3 的环境性 `LIMIT REACHED`，已如实记录，不冒充 PASS，也不构成"关键门禁失败"。）

---

## 9. 下一任务 GS-NEXT-01 的建议实施边界

### 9.1 首要目标：把阶段 3 的真机闭环变成现实

当前**软件里已经没有可以"顺手做掉"的阶段 3 内容**——剩下的全部是真机证据。建议 GS-NEXT-01：

1. **准备稳定 HTTPS 入口**（不是 Quick Tunnel）。按 `docs/operations/VR_01C_PICO_TEST_GUIDE.md` §稳定 HTTPS 配置方案，
   由域名管理员配置命名 tunnel 或受控 LAN HTTPS；凭据不入 Git。
2. **真实 PICO Neo3 执行 A/B/C/D/E 五组对照**并回传诊断 JSON。
3. **由 Owner 为历史 13M 场景保存一个安全的 authored 初始视角**
   （当前该场景 `initialCamera` 仍为 `null`，只能走 frameScene fallback）。
4. 记录真实 FPS/帧时间/renderedGaussian/chunk/stall，**确定 PICO Neo3 可用默认预算档位**。

**允许**：部署、真机测试、证据收集、必要的薄适配修正。
**不允许**：开发导览点、碰撞、新清理算法（见 9.2）。

### 9.2 明确排除（本任务最终原则的延续）

- ❌ 不提前开发导览点 / XR 传送（阶段 4 §5.3-5.4）
- ❌ 不提前开发碰撞 / Walk（阶段 4）
- ❌ 不启动任何新的清理算法或完整 13M 过滤（阶段 4 §5.2，需人工批准）
- ❌ 不新增 Viewer / 相机控制 / XR Rig 系统
- ❌ 不开发任何行业定制功能

### 9.3 建议的 GS-NEXT-01 判定

```text
GS-NEXT-01 = 阶段 3 真机验收闭环
入口技能 = 稳定 HTTPS 部署（运维）+ PICO 真机测试（人工）
出口判据 = /xr/:sceneId 真机 immersive-vr + 双目 + 6DoF + ≥3 次退出重入无持续黑屏
           + 回传完整诊断 JSON + 确定预算档位
```

若真机闭环无法在下一轮完成（例如缺少可用头显或稳定域名），
**应继续停留在阶段 3**，而不是提前开启阶段 4 的开发。

---

## 10. 任务边界声明

- 本任务**只完成 GS-NEXT-00**：基线收口、路线锁定、日期夹具阻塞修复、初始视角审计、清理现状审计、测试与交付。
- **未**开发导览点、碰撞或新清理算法。
- **未**修改生产数据库约束、**未**关闭验证、**未**修改系统时间、**未** skip 失败测试。
- **未**处理其他工作者未提交变更（起始即 clean）；**未** `reset --hard` / `git clean` / force push。
- **未**破坏用户数据、工作树或现有服务：全部测试在隔离 DB + 隔离 storage 中进行；
  历史 13M 资产、源 PLY、2,076 发布文件经完整 SHA 复核**未变**；
  用户 dev DB（`gsplatform`）与 `/home/test/gsplatform-data` 未被测试写入；
  隔离环境（API 18001 / 入口 5174）保持原状未重启。
- 所有"真机/性能/出生点"结论保持 `HARDWARE PENDING`，**不凭代码存在或桌面模拟宣称 PICO 验收通过**。
