# FIX_06_2_PRODUCTION_ACCEPTANCE_SCRIPT_CLOSURE：生产验收脚本最终收口整改报告

- 日期：2026-10-06
- 阶段：FIX-06.2 —— Production Acceptance Script Final Closure
  （**非新 Phase；无业务功能；不重构 SuperSplat/Viewer/XR/Quest-PICO/LOD/Gaussian
  渲染器/streamed-SOG schema/业务 DB schema；无新增 Alembic 迁移** —— 纯生产验收脚本收口）
- 前置：FIX-01..06、FIX-06.1 全部 PASS（软件侧）；Quest/PICO 真机为唯一剩余 blocker
- 基线：`74814629339db1d27f4f6f466c39110add85675a`（`test(fix061)`，工作区 clean）
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（**未升级**）；
  torch `2.14.0+cu126` / gsplat `1.5.3`（FIX-06.1 合同，**未变**）

---

## RESULT

**PASS（软件侧，两个已确认软件 blocker + 文档同步全部关闭）** ——
smoke 改走真实 GET（不再 HEAD 假面）、preflight 拆 host/release 双模式
（全新主机可先于首次部署完成预检）、系统化 env-file 安全共享、runbook 同步。
**NOT EXECUTED（如实标注，不伪造）**：真实生产主机部署（无生产主机/域名）；
Quest/PICO 真机验收（无硬件）。

```text
FIX-06.2 (acceptance-script closure): PASS
Software blockers:                  NONE
Hardware acceptance:                PENDING (Quest/PICO 真机，唯一剩余 blocker)
Production host deploy:             NOT EXECUTED (requires production host)
```

---

## 1. BASELINE

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 基线 commit | `74814629339db1d27f4f6f466c39110add85675a`（FIX-06.1 收尾） |
| 工作区 | clean（提交前 `git status --porcelain` 为空，diff --check 干净） |
| 提交（本阶段，2 个） | `fix(deploy): close production smoke and preflight gaps`（bfd104d）＋ `test(fix062): lock first-deploy and GET smoke contracts`（最新 HEAD，含本报告），见 §13b |

## 2. CONFIRMED SOFTWARE BLOCKERS（两个正式 blocker，§二）

- **A. Smoke 对 GET-only 资产接口用了 HEAD**：`scene_runtime.py` 只有
  `@router.get("/{scene_id}/assets/{asset_path:path}")`，**没有 HEAD 路由**。
  `smoke_test.sh` 却用 `curl -sI`（HEAD）去取 Cache-Control / Content-Range —
  测的是产品不存在的表面，且**从不经过 X-Accel→Nginx 的 GET body 路径**。
  修复：资产段统一用 `g()`/`hdr()` 一次真实 GET 同时取状态+头+body；
  验证 Viewer GET → FastAPI 授权 → X-Accel-Redirect → Nginx 内部文件 →
  HTTP 响应的完整链路。**不给资产接口新加 HEAD 路由**（产品不需要）。
- **B. Preflight 混跑 host 与 release 检查**：`preflight.sh` 在全新主机上就检查
  `/opt/gsplatform/current`（venv/dist/torch/gsplat），首次部署无从通过。
  修复：拆 `--mode host`（部署前主机就绪：OS 命令/文件系统/磁盘/env 文件/
  pg_isready/redis-cli/NVIDIA/限流配置，**绝不碰 /current**）与
  `--mode release`（已装 release 完整性：current 符号链接+元数据/web dist/
  storage 包/API venv 导入/celery/systemd ExecStart/torch/gsplat/CUDA/
  alembic current==head/nginx）。默认模式 = host，旧调用不破坏。

## 3. SMOKE REAL-GET CONTRACT（A，§10-§12）

- `g <url> <body> [args…]` 输出状态码，把响应头写进 `$ASSET_HDRS`；
  `hdr <name>` 按名取回上一次 `g()` 的响应头（大小写不敏感）。
- 资产段每个状态码均来自 `$(g …)`：current/manifest 200 + `public, no-cache`；
  versions/<ver>/manifest.json 200 + `public, max-age=31536000, immutable`；
  versions/<ver>/<entry-file> 200；Range `bytes=0-1023` → 206 + Content-Range
  + body ≤1024；非法 Range → 416。
- `smoke_manifest.py` CLI 改为输出**两行稳定机器输出**：`versions/<ver>` 与
  `stream.entryUrl` 的**真实文件名**。smoke 用 `$VER_PATH/$ENTRY_FILE` 拼接，
  **绝不重新硬编码 lod-meta.json** —— 契约漂移（新文件名）会真实流入而非静默错位。
- 全脚本仅存两处 `C -sI`：SPA 路由与根安全头（静态 Nginx 文件，HEAD 合法，
  非场景资产）；`test_fix062.py::TestSmokeUsesRealGet` 静态锁死该面。
- **回归测试**（`TestAssetGetRoutes`，真实 FastAPI + `dependency_overrides` 匿名
  身份 + 真实场景 origin 树）：current manifest/version manifest/Range 206/416
  四态全部 200/206/416 且缓存头精确匹配 FIX-05C 契约。

## 4. PREFLIGHT HOST/RELEASE SPLIT（B，§13-§21）

### 4.1 host 模式（部署前，默认）

| 段 | 检查 | 生产 severity |
|---|---|---|
| [A] | nginx/python3/node/pnpm/ffmpeg(opt) + 目录 + 磁盘(≥10GB) + env 文件存在 | env 缺失 → FAIL |
| [B] | `pg_isready -d "$LIBPQ_URL"`（`${GS_DATABASE_URL//+psycopg2/}` 去驱动后缀，libpq 不认 `+psycopg2`；**URI 永不回显**） | 不可达 → FAIL |
| [C] | `redis-cli -u "$GS_REDIS_URL" PING` → PONG（**URL/密码永不输出**） | 不可达/缺 redis-cli → FAIL |
| [D] | `GS_RATE_LIMIT_BACKEND == redis`（**host 起步即拦，不等 uvicorn 启动守卫**）；`GS_DEV_IDENTITY_ENABLED != true` | 不满足 → FAIL |
| [E] | NVIDIA 主机探针 `nvidia-smi --query-gpu=count` ≥ 1（**只探测主机运行时**；torch/gsplat 属 release venv） | GPU 单元存在但不可见 → FAIL |

### 4.2 release 模式（部署后，要求 /current 存在）

[F] current 符号链接 + `.git-commit-hash`（40 hex）；[G] web dist + API main +
nginx/systemd 配置 + **tracked storage 包**（FIX-06 §1）；[H] `nginx -t`；
[I] 共享 venv 全量导入闭包（fastapi/sqlalchemy/pydantic/uvicorn/celery/argon2/
httpx/multipart/yaml/redis/numpy + app.storage + app.main + **workers.celery_app**）
+ celery 可执行文件；[J] 4 个 systemd 单元 ExecStart 存在并解析到 current 下；
[K] **reconstruction runtime**（GPU 单元存在时 BLOCKING：torch/gsplat 精确版本 +
trainer `--help` + CUDA + gsplat rasterization 实跑）；[L] `alembic current == head`。

### 4.3 部署联动（§21）

`deploy_release.sh` 新增 **6b 步**：原子切换 current 后立即对**新 current** 跑
`preflight.sh --mode release`（fail-closed）—— 失败则把符号链接回滚到
`$PREV_RELEASE` 并中止部署，**绝不把未验证 release 留在 current**。

## 5. SAFE ENV-FILE SHARING（§24/§25）

- **`deploy/scripts/lib_env.sh`**（新，tracked）：安全加载 `$GS_ENV_FILE`
  （默认 `/etc/gsplatform/env`）—— 逐行解析 `KEY=value`（跳过纯注释行，**不剥
  行内 `#`** 以保密码原样）、**不做任何 shell 展开**（`$` 原样保留）、可选去引号、
  `export` 后 `GS_ENV_LOADED=1` 去重。被 `preflight.sh` 与 `deploy_release.sh`
  共用 → 主机预检/部署脚本/systemd units 读**同一份 env**。
- 任何路径**不做 `source`**；密码/URI 永不打印（`test_fix062.py` 断言
  `pa$$word$with$dollars` 原样保留且不出现在输出）。
- **§25**：`production.env.example` 新增注释 —— systemd `EnvironmentFile=` **不
  做 shell 展开**，`CELERY_BROKER_URL=${…}` 只作文档展示；worker 实际读取的是
  `GS_CELERY_BROKER_URL` / `GS_CELERY_RESULT_BACKEND`（`workers/celery_app.py`，
  经 pydantic Settings 消费），已核实 `celery_client.py` 同源。

## 6. RUNBOOK SYNC（§26/§27）

`docs/operations/DEPLOYMENT_RUNBOOK.md`：
- §2 base 包新增 `postgresql-client`（pg_isready）与 `redis-tools`（redis-cli）；
- §4 首次部署改 `--mode host` → deploy（内部 release preflight）→ 可选 `--mode
  release` 复查；文档写明 GS_ENV_FILE 语义；
- §5 手动 smoke 必须 `--public-scene <slug>`（场景须 **PUBLIC+PUBLISHED+未删除+
  有 current 版本**，已发布场景必有 current）；`deploy_release.sh` 自动传入
  `--public-scene`（`SMOKE_PUBLIC_SCENE_SLUG` 或确定性 DB 查询），查不到合格
  公开场景 → **中止部署而非静默跳过**。

## 7. TEST SUITE（test_fix062.py，20 项；test_fix061.py 同步）

| 类 | 项数 | 内容 |
|---|---|---|
| `TestAssetGetRoutes` | 4 | 真实 GET 面：current 200+no-cache、version 200+immutable、Range 206+Content-Range+body、非法 Range 416 |
| `TestSmokeUsesRealGet` | 3 | 资产块无 `curl -I/-sI/--head`、全脚本 `C -sI` 恰 2 处、`$(g ` ≥4 + hdr(cache-control/content-range) |
| `TestSmokeManifestFilename` | 3 | 解析器返回真实文件名、CLI 两行输出、smoke 用 `$VER_PATH/$ENTRY_FILE` |
| `TestPreflightModes` | 6 | host 全新机无 current 亦 PASS；默认 host；release 无 current FAIL；生产拒 memory 限流/收 redis；host 探针为 pg_isready/redis-cli（无 SQLAlchemy/python-redis）；release 完整性标记保留；`+psycopg2` 剥后缀 |
| `TestEnvFileLoading` | 2 | preflight 读 GS_ENV_FILE 并驱动限流门禁；lib_env.sh 不展开 `$`、不泄密 |

`test_fix061.py::TestSmokeManifestParser::test_cli_prints_version_path` 改为断言
两行输出 `["versions/abc123", "lod-meta.json"]`。

## 8. TEST COUNTS（真实运行值）

| 门禁 | 命令 | 结果 |
|---|---|---|
| FIX-06.1+06.2 targeted | `pytest tests/test_fix061.py tests/test_fix062.py` | **51 passed**（31 + 20） |
| backend 全量 | `.venv/bin/python -m pytest tests` | **329 passed**（FIX-06.1 309 → +20） |
| backend ruff | `.venv/bin/python -m ruff check app tests` | **All checks passed** |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| workers | `python -m pytest tests`（workers/tests） | **13 passed** |
| web typecheck | `pnpm typecheck`（tsc -b --noEmit） | **exit 0（0 errors）** |
| web lint | `pnpm lint`（oxlint） | **exit 0** |
| web test | `pnpm test`（vitest run） | **228 passed / 26 files** |
| web build | `pnpm build` | **exit 0** |
| nginx | `nginx -t`（/home/test/bin + PATH 同一前端） | **syntax is ok / test successful** |
| bash 语法 | `bash -n` 全部 tracked .sh（16）+ 新增 lib_env.sh | 全部 OK |
| GPU 门禁（真 venv） | `verify_reconstruction_runtime.py`（**无 --allow-no-gpu**） | **PASS**：torch 2.14.0+cu126 / gsplat 1.5.3 / trainer --help / CUDA 2×A6000 / gsplat rasterization（109 lit px） |
| first-deploy 仿真（/tmp） | 全新主机 + PATH 桩 pg_isready/redis-cli + 生产 env 文件 → `--mode host` | **PASS**（19 passed / 0 failed / exit 0） |
| release 仿真（/tmp） | git archive HEAD → current + 真 venv + 真 web dist → `--mode release` | **PASS**（28 passed / 0 failed / 11 非阻塞 warn / exit 0；recon [K] 实跑 PASS） |
| clean-checkout 门禁 | `verify_release_source.sh`（提交后执行，新 HEAD） | §13 |

## 9. CLEAN ARCHIVE RESULT（§36）

`deploy/scripts/verify_release_source.sh`（git archive HEAD → 无 .git/.env/.venv/
node_modules → storage 4 文件 + pyproject + workers.celery_app 在 → 全新 venv
`pip install -e apps/api[dev]` → import 闭包 → ruff → mypy → backend pytest →
workers pytest → 全新 recon venv 安装合同并 verify）。门禁在**代码最终态 HEAD** 执行：
自门禁目标至最终 HEAD 仅新增 docs（本报告 + PRODUCTION_RUNTIME_ACCEPTANCE.md），
不触碰任何被测路径，GATE_EXIT=0 对最终态成立。

| 步 | 结果 |
|---|---|
| archive + 完整性 | ✅ archived HEAD |
| fresh venv deps + import 闭包 | ✅ IMPORT_OK |
| ruff / mypy | ✅ All checks passed / Success |
| backend pytest | ✅ 收集 **329**；passed + 4 有意 skip（3 项 FIX-06 storage-tracking 需 git 工作树——归档无 .git；1 项 recon-runtime 测试在无 torch 的 API 专用 venv 内按设计跳过）——与 FIX-06.1 §12 同款 skip 语义 |
| workers pytest | ✅ **13 passed** |
| §8 重建运行时（全新 recon-venv） | ✅ torch 2.14.0+cu126 / gsplat 1.5.3 / trainer `--help` / CUDA（2× A6000）/ gsplat CUDA rasterization（**70 lit pixels, 8 splats**） |
| **退出码** | ✅ **GATE_EXIT=0** |

（更新于门禁跑完后的实测行 —— 见 §13。）

## 10. NOT EXECUTED（如实标注）

1. **生产主机部署**：本环境无生产主机/真实域名；`deploy_release.sh` / systemd
   生效 / nginx 真实站点 **未在真机执行**（脚本经 `bash -n` + nginx harness `-t`
   + 本机仿真：host 预检仿真、release 预检仿真在 /tmp 真实跑通）。
2. **Quest/PICO 真机验收**：无头显；6DoF / 视差 / 沉浸内交互 / LOD 全量首帧
   真实 GPU 复核待真机执行 —— 唯一剩余 blocker，与软件无关。

## 11. FINAL ACCEPTANCE STATUS

```text
FIX-06.2 acceptance-script closure: PASS
  A GET-only smoke (no HEAD):        PASS (g()/hdr() real GET + 4-state asset tests)
  B preflight host/release split:    PASS (host passes on fresh host; release requires current;
                                        deploy step 6b fail-closed + symlink rollback)
  C safe env-file sharing:           PASS (lib_env.sh no expansion/no secrets; systemd docs)
  D runbook sync:                    PASS (packages, mode split, --public-scene, GS_ENV_FILE)
Software blockers:                   NONE
Hardware acceptance:                 PENDING (Quest/PICO real-device only)
```

**READY FOR HARDWARE ACCEPTANCE**

## 13b. GIT

| 提交 | commit | 内容 |
|---|---|---|
| fix | `bfd104d fix(deploy): close production smoke and preflight gaps` | A 真实 GET smoke + 双行 entry 文件名；B preflight host/release 拆模 + deploy §6b release 预检/回滚；C lib_env.sh 安全 env 共享 + §25 systemd 说明；D runbook 同步 |
| test | `test(fix062): lock first-deploy and GET smoke contracts`（最新 HEAD，含本报告） | test_fix061 断言改双行 + 新增 test_fix062.py（20 项，§7）+ 本报告 + PRODUCTION_RUNTIME_ACCEPTANCE.md FIX-06.2 节 |

基线 `7481462..` `main`，正常 push（无 force-push / 无 rebase 已发布 main）。
工作区提交后 clean（`git status --porcelain` 为空）。