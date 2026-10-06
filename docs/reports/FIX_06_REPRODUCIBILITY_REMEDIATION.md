# FIX_06_REPRODUCIBILITY_REMEDIATION：软件可复现性与生产完整性整改报告

- 日期：2026-10-06
- 阶段：FIX-06 —— Software Reproducibility & Production Integrity Remediation
  （**无新业务功能**；P0/P1 全项软件整改 + clean-checkout 门禁 + 报告）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体/运行时对齐）PASS ·
  FIX-04（生产验收，软件项）PASS · FIX-05（独立审计整改）PASS · FIX-05B（Vite 收尾）PASS ·
  FIX-05C / FIX-05C.1（缓存策略收口）PASS
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（**未升级**）

---

## RESULT

**PASS（软件侧）** —— 部署只信 tracked 源码、依赖闭包、共享 worker venv、媒体鉴权、
上传状态机与幂等、派发失败恢复、Redis 限流、clean-checkout 门禁全部关闭。
**Hardware / 生产主机项不伪造**：Quest/PICO 真机验收未执行（PENDING）；`deploy_release.sh`
未在真实生产主机上执行（本环境无生产主机/域名，如实标注 NOT EXECUTED）。

## ROOT CAUSES（investigation 阶段实测确认）

1. **storage 包 untracked**：`.gitignore` 第 70 行裸 `storage/`（未锚定根目录）把
   `apps/api/app/storage/` 4 个源码文件全部排除出 git —— `git archive HEAD` 产出的部署包
   不含 storage 包，发布即 ImportError。
2. **生产依赖未闭包**：`apps/api/pyproject.toml` `[project.dependencies]` 只声明
   fastapi/uvicorn/pydantic/sqlalchemy/alembic/psycopg2，而代码实际 import
   `celery`、`argon2_cffi`、`httpx`、`python-multipart`（UploadFile/File）、`redis`、
   `yaml`/`numpy`（workers）—— 现有 `.venv` 里这些包"碰巧存在"掩盖了闭包缺失。
3. **worker venv 不存在**：3 个 systemd 单元 ExecStart 指向 `/opt/gsplatform/current/workers/.venv/bin/celery`，
   而 `deploy_release.sh` 从未创建 `workers/.venv`（只建 `apps/api/.venv`）→ 部署后 worker 起不来。
4. **媒体路由绕过鉴权**：cover/background/background-audio/annotation-media 4 条 GET serve
   路由标注"No auth required (public)"，私有/分享场景的媒体可匿名直达。
5. **coverUrl 用 UUID**：`_presentation_out` 拼 `pres.scene_id`（UUID），serve 路由只按 slug
   查询 —— URL 与路由语义不一致。
6. **上传缺少 CSRF**：uploads POST/PATCH/DELETE、compute POST /reconstruct、/jobs/{id}/cancel
   只用 `get_current_user`，session 模式可被跨站写。
7. **上传状态机失控**：`append_chunk` 不查状态（UPLOADED/QUEUED 后可继续写）；
   `cancel` 无条件删文件（QUEUED/SUCCEEDED 也删）。
8. **complete 非幂等**：重复 complete 会再建 Scene + Job；slug `u-<sha12>` 确定性 → 唯一约束冲突 500。
9. **派发失败留孤儿**：commit QUEUED 后 `send_task` 抛错 → 孤儿 QUEUED + 500（publish complete 与 reconstruct submit 都有）。
10. **publish worker 破坏性幂等**：`promote_staging_to_version` 对已存在版本目录先 `delete` 再 rename
    （违反版本不可变契约）；`commit_version` 无条件新建 SceneVersion+Assets → 重试撞唯一索引。
11. **deploy 复制工作区 + 全 fail-open**：`cp -a "$DEPLOY_SOURCE"` 复制整棵工作树（含 .env/.venv/node_modules/
    未跟踪文件）；pip/build/迁移/场景同步/重启全部 `|| echo ⚠` 继续。
12. **smoke 断言过时**：`current/manifest.json` 断言 `max-age=60`（FIX-05C.1 已改为 `public, no-cache`）。
13. **限流 XFF 可伪造 + 进程内计数**：`_client_ip` 读原始 `X-Forwarded-For` 首值；`_windows` 为进程内 dict，
    `--workers 4` 下不共享；Nginx 用 `$proxy_add_x_forwarded_for`（追加可伪造值）。

## FIX

| # | 修复 | 文件 |
|---|---|---|
| P0-1 | `.gitignore` `storage/` → `/storage/`；storage 4 文件 tracked | `.gitignore` |
| P0-2 | pyproject 补齐 celery/argon2-cffi/httpx/python-multipart/PyYAML/redis/numpy | `apps/api/pyproject.toml` |
| P0-3 | 3 个 systemd 单元 ExecStart → `/opt/gsplatform/current/apps/api/.venv/bin/celery`（共享 venv） | `deploy/systemd/*.service` |
| P0-4 | `deploy_release.sh`：`git archive HEAD` + clean 检查 + 元数据取自源仓库 + 全 fail-closed | `deploy/scripts/deploy_release.sh` |
| P1 | 4 条媒体 serve 路由接入 `SceneAccessPolicy` + scope-aware Cache-Control + `_share_grant` | `app/api/v1/scene_presentation.py`、`app/services/authoring.py` |
| P1 | coverUrl 锚定 `scene.slug` | `app/services/authoring.py` |
| P1 | uploads/compute 写路由加 `require_csrf` | `app/api/v1/uploads.py`、`app/api/v1/compute.py` |
| P1 | append/cancel/complete 状态机守卫；`complete` 行锁 + 幂等重放/FAILED 重试；派发失败→Job FAILED(安全文案)+503+upload 回 UPLOADED | `app/services/upload_service.py`、`app/repositories/uploads.py`、`app/core/errors.py` |
| P1 | reconstruct submit 派发失败恢复 + 场景复用 | `app/services/reconstruction_service.py` |
| P1 | publish worker：SUCCEEDED 重复投递早退；promote 校验复用不删除；commit_version 复用 SceneVersion/Asset 去重 | `workers/tasks/publish_scene.py`、`app/services/publish_service.py` |
| P1 | preflight 扩展（发布完整性/import 闭包/worker celery/systemd 路径/alembic current==head） | `deploy/scripts/preflight.sh` |
| P2 | smoke `current/manifest` → `public, no-cache`；versions/<ver> immutable（解析 entryUrl） | `deploy/scripts/smoke_test.sh` |
| P1 | `_client_ip` → `request.client.host`；Nginx XFF → `$remote_addr`；Redis 限流器 + 内存回退 | `app/core/rate_limit.py`、`app/api/v1/auth.py`、`app/services/auth_service.py`、`deploy/nginx/proxy-params.conf` |
| §17 | clean-checkout 门禁脚本 | `deploy/scripts/verify_release_source.sh` |

## TESTS（真实计数）

| 门禁 | 命令 | 结果 |
|---|---|---|
| backend 全量 | `.venv/bin/python -m pytest tests` | **278 passed**（+30 FIX-06） |
| FIX-06 targeted | `pytest tests/test_fix06.py` | **30 passed** |
| backend ruff | `.venv/bin/python -m ruff check .` | **All checks passed** |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| workers | `python -m pytest tests`（workers/tests） | **13 passed** |
| web | `pnpm vitest run` / `typecheck` / `lint` / `build` | 未改动，保持 228 / 0 errors / exit 0 / exit 0 |
| nginx | `/home/test/bin/nginx -t`（harness） | syntax ok / test successful |
| Alembic | `alembic heads` / `alembic current` | 单 head `c1d2e3f4a5b6`；PostgreSQL `current == head`（实测） |
| clean venv | `python3 -m venv /tmp/... && pip install -e apps/api` | `CLEAN_IMPORT_OK`（celery/argon2/httpx/multipart/yaml/redis/numpy + app.main + app.storage + workers.celery_app） |

### FIX-06 测试组（§18）

- `TestStorageTracked`（3）：git ls-files / check-ignore / gitignore 锚定 —— storage 包永不被忽略。
- `TestMediaAuthorization`（7）：公开/私有/他人/属主/share/吊销/删除 × 4 媒体路由 + scope-aware cache 头。
- `TestCoverUrlRoundTrip`（1）：上传封面 → presentation.coverUrl == slug 锚定 → GET 字节一致。
- `TestUploadStateMachine`（5）：complete 后 append 409 / cancel 后 append 404 / 未传完 complete 409 /
  部分上传 complete 409 / queued 后 cancel 409。
- `TestCompleteIdempotency`（1）：complete 两次 → 同一 Job、1 Scene、仅 1 次派发；FAILED 重试 → 新 Job 同 Scene。
- `TestDispatchFailureRecovery`（2）：send_task 抛错 → 503 SERVICE_UNAVAILABLE（无 broker 原文）、
  Job FAILED `TASK_DISPATCH_FAILED`、无孤儿 QUEUED、upload 回 UPLOADED；重试成功且仅 1 Scene。
- `TestPublishIdempotency`（3）：commit_version 两次 → 1 SceneVersion / 3 Assets 无重复、current_version_id 一致；
  promote 复用不删除；内容不一致 → ConflictError 且版本目录不变。
- `TestUploadCsrf`（3）/ `TestComputeCsrf`（3）：session 模式无 CSRF 403、错 token 403、正确 token 通过。
- `TestRateLimiterRedis`（2）：Redis 计数/超限/TTL；Redis 不可达 → 内存回退仍计数。

## FILES CHANGED

- `.gitignore`（`/storage/`）
- `apps/api/pyproject.toml`（依赖闭包）
- `apps/api/app/api/v1/{uploads,compute,scene_presentation,auth,assistant,shares}.py`
- `apps/api/app/services/{upload_service,reconstruction_service,publish_service,authoring,auth_service}.py`
- `apps/api/app/repositories/uploads.py`、`app/core/{rate_limit,errors,config}.py`
- `workers/tasks/publish_scene.py`
- `deploy/scripts/{deploy_release,preflight,smoke_test,verify_release_source}.sh`
- `deploy/systemd/gsplatform-{celery-cpu,celery-gpu,cleanup}.service`
- `deploy/nginx/proxy-params.conf`
- `apps/api/tests/test_fix06.py`（新，30 项）
- `docs/reports/PRODUCTION_RUNTIME_ACCEPTANCE.md`（FIX-06 段 + 计数统一）

未改动：SuperSplat runtime / Viewer / XR 交互 / Gaussian renderer / LOD / streamed SOG 协议 /
Scene DB schema（无新迁移）。

## HONEST STATUS

- **NOT EXECUTED —— 生产主机部署**：本环境无生产主机/真实域名；`deploy_release.sh`、`preflight.sh`、
  systemd 生效、nginx 真实站点均未在真机执行（脚本经 `bash -n` 语法校验 + 本地 nginx harness `-t`）。
- **NOT EXECUTED —— Quest/PICO 真机验收**：唯一剩余 blocker（与软件无关）。
- 测试计数为本环境真实运行值，无伪造；clean-checkout 门禁在提交后执行并记录（见 GIT）。

## FINAL STATUS

```text
SuperSplat migration:   PASS
FIX-05B/05C/05C.1:      PASS
FIX-06 (software):      PASS
Software blockers:      NONE
Hardware acceptance:    PENDING
Production host deploy: NOT EXECUTED (requires production host)
```

**Remaining blocker：Quest/PICO real-device acceptance only**。

## NEXT STEP

Quest/PICO 真机 + 真实大场景 + LOD + XR interaction 验收（本阶段不自动开始）。
