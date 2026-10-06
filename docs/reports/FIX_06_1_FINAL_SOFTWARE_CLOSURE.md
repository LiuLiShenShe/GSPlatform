# FIX_06_1_FINAL_SOFTWARE_CLOSURE：最终软件收口整改报告

- 日期：2026-10-06
- 阶段：FIX-06.1 —— Final Software Closure
  （**非新 Phase；无业务功能；不重构 SuperSplat/Viewer/XR/LOD** —— 纯生产运行时收口）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体/运行时对齐）PASS ·
  FIX-04（生产验收，软件项）PASS · FIX-05/05B/05C/05C.1（审计+缓存收口）PASS ·
  FIX-06（可复现性与生产完整性）PASS
- 基线：`1fbdea14ec391d59aae7334edbd9842836cd8531`（工作区 clean）
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（**未升级**）

---

## RESULT

**PASS（软件侧，全部四项正式问题 A–D 关闭）** —— GPU 重建运行时依赖闭包、
生产 Redis 限流强制激活、生产 smoke 真实校验版本缓存与 Range、并发/CSRF 回归测试补齐。
**NOT EXECUTED（如实标注，不伪造）**：真实生产主机部署（本环境无生产主机/域名）；
Quest/PICO 真机验收（无硬件）。

```text
FIX-06.1 (software closure): PASS
Software blockers:            NONE
Hardware acceptance:          PENDING (Quest/PICO 真机，唯一剩余 blocker)
Production host deploy:       NOT EXECUTED (requires production host)
```

---

## 1. BASELINE

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 基线 commit | `1fbdea14ec391d59aae7334edbd9842836cd8531`（FIX-06 收尾） |
| 工作区 | clean（提交前 `git status --porcelain` 为空） |
| 提交（本阶段） | `fix(platform): close production runtime reproducibility gaps`（见 GIT 节） |

## 2. AUDIT FINDINGS（四项正式问题，§二）

- **A. GPU 重建依赖未闭包**：生产 GPU worker 从 `apps/api/.venv` 启动
  （`gsplatform-celery-gpu.service` ExecStart），而
  `workers/reconstruction/train_gsplat_script.py` 顶部就 `import torch` 与
  `from gsplat import DefaultStrategy, export_splats, rasterization`；
  orchestrator 以 `sys.executable -m workers.reconstruction.train_gsplat_script`
  运行训练。FIX-06 只证明了 `workers.celery_app` 可导入，**从未证明
  `reconstruct_train` 真机可执行**。部署脚本也未安装任何 torch/gsplat。
- **B. 生产 Redis 限流未激活**：`rate_limit_backend: str = "memory"` 为默认；
  `deploy/env/production.env.example` 没有 `GS_RATE_LIMIT_BACKEND`；
  无生产配置守卫。多 uvicorn worker 各自内存计数，Nginx 负载下限流形同虚设。
- **C. 生产 smoke 未真实验证缓存契约**：`smoke_test.sh` 用
  `manifest.get("entryUrl")` 顶层解析 —— 契约是
  `{"stream": {"entryUrl": "versions/<ver>/lod-meta.json"}}`，真实发布清单永远
  解析为空 → 版本化 immutable 与版本化 Range 检查**静默从未执行**；且
  `--public-scene` 缺省时直接跳过；deploy 从不传 `--public-scene`。
- **D. 并发/CSRF 回归不完整**：complete 幂等仅在单会话串行下测过，**无两会话并发
  竞态测试**；CSRF 只测了 uploads POST 与 compute cancel，**未覆盖 PATCH /
  complete / DELETE 与 POST /compute/reconstruct**。

## 3. GPU DEPENDENCY ROOT CAUSE（A）

问题链：`gsplatform-celery-gpu.service` → 共享 venv `apps/api/.venv` →
`orchestrator._stage_training` → `sys.executable -m
workers.reconstruction.train_gsplat_script` → 模块级 `import torch / from gsplat
import ...` → **任一缺失/版本漂移都让训练任务首行即崩**。而：
- FIX-06 的依赖闭包只覆盖 celery/argon2/httpx/multipart/yaml/redis/numpy
  （pyproject `[project.dependencies]`），torch/gsplat 不在其中；
- 部署脚本从不安装它们 —— 生产真机 venv 里"碰巧有"不可作为合同。

## 4. EXACT RUNTIME VERSIONS（合同锁定）

按「先读真实 Phase-07 环境，禁止盲目装最新」原则实测本机 venv
`apps/api/.venv`（Phase-07 训练真跑过的环境）：

| 包 | 版本 | 依据 |
|---|---|---|
| torch | **2.14.0+cu126** | venv 实测；CUDA 12.6 构建，`torch.cuda.is_available()=True` |
| gsplat | **1.5.3** | venv 实测；**与 `PHASE_07_REPORT.md` 记录一致** |
| torchvision | 0.29.0+cu126 | venv 附带（训练未 import，不作为合同项） |
| numpy | 2.4.6 | pyproject `>=1.26,<3.0` 已覆盖 |

**不升级原则**：系统 python（3.13.12）有 torch 2.9.1+cu128 / gsplat 1.6.0，
但 Phase-07 合同记录 gsplat 1.5.3 —— 以**已验证组合**为生产运行时合同，
不追新。torch 2.14.0+cu126 轮子仅存在于官方 cu126 index
（`https://download.pytorch.org/whl/cu126`，已实测可解析，pip 缓存命中）。

## 5. PRODUCTION INSTALL MECHANISM

- **合同文件（tracked）**：`deploy/requirements-reconstruction.txt` ——
  `--extra-index-url https://download.pytorch.org/whl/cu126` +
  `--extra-index-url https://pypi.org/simple`，锁定 `torch==2.14.0+cu126`、
  `gsplat==1.5.3`。独立可解析（不依赖主机 pip 配置）。
- **deploy_release.sh 第 3b 步（fail-closed）**：在共享 venv
  `apps/api/.venv`（GPU worker 同一 venv）内
  `pip install -r deploy/requirements-reconstruction.txt` → 然后运行
  `verify_reconstruction_runtime.py`；任一失败 → 中止部署。
  缺文件/缺脚本 → 拒绝部署（GPU 重建是产品组成部分）。
- **verify_release_source.sh §8（clean-checkout 门禁内）**：新建**全新** venv →
  `pip install -e apps/api` → `pip install -r deploy/requirements-reconstruction.txt`
  → `verify_reconstruction_runtime.py --allow-no-gpu`。GPU 缺失的机器证明
  1–3 项并打印 `SKIPPED_NO_GPU`；**绝不把「只装了没跑」当作 GPU PASS**。

## 6. GPU RUNTIME VERIFICATION（真实执行）

`deploy/scripts/verify_reconstruction_runtime.py` 六项检查，任何失败 exit≠0，
无 try/except 吞错：

1. `import torch` + 版本 `== 2.14.0+cu126`；
2. `import gsplat` + 版本 `== 1.5.3`；
3. `python -m workers.reconstruction.train_gsplat_script --help` exit 0（真实入口）；
4. `torch.cuda.is_available()` + device ≥ 1；
5. **gsplat 1.5.3 API 的最小 CUDA rasterization 实跑**
   （`opacities` 为 `(N,)`、`viewmats`/`Ks` —— 与 trainer 同构调用，非旧版
   `full_proj_mats`）；断言图像形状 + 有可见 splat。

**实测（本机 2× NVIDIA RTX A6000，driver 590.48.01，CUDA 13.1）：**

| 环境 | torch | gsplat | CUDA | rasterization | 结果 |
|---|---|---|---|---|---|
| 现有 `apps/api/.venv` | 2.14.0+cu126 | 1.5.3 | 可用（2 设备） | OK（106 px） | **PASS** |
| 全新 venv（`/tmp/recon-gate`，经合同文件安装） | 2.14.0+cu126 | 1.5.3 | 可用（2 设备） | OK（gsplat CUDA 扩展 JIT 构建 148.6s 后 106 px） | **PASS** |

## 7. REDIS PRODUCTION CONFIG（B）

- **`deploy/env/production.env.example`**：新增
  `GS_RATE_LIMIT_BACKEND=redis` + 准确注释（memory 仅开发/测试；
  Redis 故障时降级为进程内窗口，恢复后自动回弹；启动拒绝生产非 redis）。
- **`app/main.py` 生产配置守卫**（与 dev-identity 守卫同位置，启动即校验）：
  `if settings.env == "production" and settings.rate_limit_backend != "redis":
  raise RuntimeError("GS_RATE_LIMIT_BACKEND must be 'redis' in production ...")`
  —— 消息不含任何 secret/URL。
- **`preflight.sh`**：Redis 探活改为读 `GS_REDIS_URL`；`--environment production`
  且 Redis 不可达 → **FAIL（BLOCKING）**；非生产维持 warn。
- **outage-fallback 文档**：`rate_limit.py` docstring + env example 注释均写明
  「Redis 故障 → 内存滑动窗口降级（非 fail-open 全放行），恢复自动回弹」。
- 测试：`TestProductionConfigGuard`（production+memory → RuntimeError；
  production+redis → 正常启动；development+memory 默认仍可启动；env example 锁定 redis）。

## 8. SMOKE ENTRYURL FIX（C-1）

- **根因**：`manifest.get("entryUrl")` 顶层读取 —— 真实清单为
  `{"stream": {"entryUrl": ...}}`，永远取空 → 版本化检查从未运行。
- **修复**：抽出共享解析器 `deploy/scripts/smoke_manifest.py`
  （`parse_entry_url`，bash smoke 与 pytest 共用）：
  严格 `versions/<ver>/<file>` 三段、非空、无 `..`/`current`/路径分隔符；
  非法 → `ValueError`，CLI exit 1。bash 侧改为
  `VER_PATH=$(python3 $PARSE_MANIFEST --manifest ...)`。
- **--public-scene 提供时**：entryUrl 缺失/非法 → **FAIL**（不再 INFO+skip）。
- **版本化清单真实验证**：`versions/<ver>/manifest.json` → **必须 200 且
  Cache-Control 精确等于 `public, max-age=31536000, immutable`**；
  `versions/<ver>/lod-meta.json` → 必须 200。
- **保留**：`current/manifest.json` → `public, no-cache`（FIX-05C 政策未动）；
  Range 206/416 检查保留。
- 回归测试：`TestSmokeManifestParser` 17 项（合法/缺 stream/缺 entryUrl/空/
  非字符串/current/穿越/段数错/空版本/空文件/点号/CLI 成败）。

## 9. PUBLIC SCENE SMOKE WIRING（C-2）

`deploy_release.sh` step 9：
- `SMOKE_PUBLIC_SCENE_SLUG` 显式提供则用之；
- 否则用 release venv 跑**确定性 DB 查询**
  `SELECT slug FROM scenes WHERE status='PUBLISHED' AND visibility='PUBLIC'
  AND deleted_at IS NULL AND current_version_id IS NOT NULL
  ORDER BY updated_at DESC LIMIT 1`；
- 两者皆空 → **FAIL（中止部署）**，绝不静默跳过；
- smoke 调用传入 `--public-scene "$SMOKE_SCENE"`。

## 10. CONCURRENT COMPLETE RESULT（D-1）

`TestConcurrentComplete`（**真实 PostgreSQL**，非 SQLite）：

- 一个已完整上传的会话（真实字节）→ 两个**独立 `SessionLocal` 会话** +
  `threading.Barrier(2)` 同时进入 `UploadService.complete`；
- 断言：**1 Scene / 1 PUBLISH Job / 仅 1 次 dispatch / 两返回值同一 jobId**。

实测：**PASS**。行锁（`get_owned_for_update` / `SELECT ... FOR UPDATE`）串行化：
先到者建 Scene+Job+派发并提交；后到者拿锁后读到 `scene_id` 走幂等重放路径，
复用同一 Job，无重复 Scene/Job。

## 11. CSRF MATRIX（D-2）

会话模式（`dev_identity_enabled=false`，真实 session + double-submit cookie），
`require_csrf` **绝不 mock**：

| 端点 | 无 token | 错 token | 正确 token |
|---|---|---|---|
| uploads PATCH（append） | 403 | 403 | **200** |
| uploads POST complete | 403 | 403 | **200 + jobId** |
| uploads DELETE（cancel） | 403 | 403 | **200** |
| compute POST /reconstruct | 403 | 403 | **404（NOT_FOUND，业务校验）** —— 证明 CSRF 通过并到达业务层 |

`TestComputeReconstructCsrf.test_post_correct_csrf_reaches_business_validation`：
正确 token + 不存在 upload → 404（`_verify_uploads` 的 NotFoundError），
**不是 403** —— 证明 CSRF 门禁真实通过，业务校验真实执行。

## 12. TEST COUNTS（真实运行值）

| 门禁 | 命令 | 结果 |
|---|---|---|
| backend 全量 | `.venv/bin/python -m pytest tests` | **309 passed**（278 + 新增 31） |
| FIX-06.1 targeted | `pytest tests/test_fix061.py` | **31 passed** |
| backend ruff | `.venv/bin/python -m ruff check app tests` | **All checks passed** |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| workers | `python -m pytest tests`（workers/tests） | **13 passed** |
| web typecheck | `pnpm typecheck`（tsc -b --noEmit） | **exit 0（0 errors）** |
| web lint | `pnpm lint`（oxlint） | **exit 0** |
| web test | `pnpm test`（vitest run） | **228 passed / 26 files** |
| web build | `pnpm build` | **exit 0** |
| nginx | `/home/test/bin/nginx -t` | **syntax ok / test successful** |
| Alembic | `alembic heads` / `alembic current` | 单 head `c1d2e3f4a5b6`；`current == head`（实测） |
| bash 语法 | `bash -n` 4 脚本 | 全部 OK |
| clean-checkout 门禁 | `verify_release_source.sh`（提交后执行） | 见 GIT 节 |

### FIX-06.1 测试组（31 项）

- `TestReconstructionRuntimeFile`（3）：合同文件 tracked + 精确 pin；
  verify 脚本契约（CUDA 真 rasterization、exit 1）；**真 venv 上 verify 实跑 PASS**。
- `TestSmokeManifestParser`（17）：解析器回归 + CLI 成败。
- `TestProductionConfigGuard`（4）：生产拒 memory / 收 redis / dev 默认可启 /
  env example 锁定 redis。
- `TestConcurrentComplete`（1）：两会话 + barrier 并发 complete。
- `TestUploadWriteCsrfMatrix`（3）：PATCH / complete / DELETE × 403/403/通过。
- `TestComputeReconstructCsrf`（3）：reconstruct × 403/403/到达业务校验（404）。

## 13. CLEAN ARCHIVE RESULT

`deploy/scripts/verify_release_source.sh`（git archive HEAD → 无 .git/.env/.venv/
node_modules → storage 文件在 → 全新 venv `pip install -e apps/api[dev]` →
import 闭包 → ruff → mypy → backend pytest → workers pytest → **§8 全新 recon venv
安装合同并 verify**）。提交后执行并记录（见 GIT）。

## 14. NOT EXECUTED（如实标注）

1. **生产主机部署**：本环境无生产主机/真实域名；`deploy_release.sh` /
   `preflight.sh` / systemd 生效 / nginx 真实站点**未在真机执行**（脚本经
   `bash -n` + nginx harness `-t` + 本机可重现实跑：recon venv 安装、verify、
   deploy 脚本逻辑）。
2. **Quest/PICO 真机验收**：无头显；6DoF / 视差 / 沉浸内交互 / LOD 全量首帧
   真实 GPU 复核待真机执行 —— 唯一剩余 blocker，与软件无关。

## 15. FINAL ACCEPTANCE STATUS

```text
FIX-06.1 final software closure:  PASS
  A GPU runtime closure:          PASS (contract file + deploy install + verify, real CUDA run)
  B Redis production activation:  PASS (env example + startup guard + preflight FAIL + fallback docs)
  C Production smoke:             PASS (stream.entryUrl parser + FAIL-not-skip + real immutable/Range + --public-scene)
  D Concurrency/CSRF:             PASS (concurrent complete real PG + full CSRF matrix, no mocks)
Software blockers:                NONE
Hardware acceptance:              PENDING (Quest/PICO real-device only)
```

**READY FOR HARDWARE ACCEPTANCE**
