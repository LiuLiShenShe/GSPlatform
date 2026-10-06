# FIX_06_2_1_FINAL_DEPLOY_PATH_CLOSURE：最终部署路径收口整改报告

- 日期：2026-10-06
- 阶段：FIX-06.2.1 —— Final Deploy-Path Closure
  （FIX-06.2 的极小修正；**非新 Phase / 无新功能 / 不重构
  SuperSplat/Viewer/SceneViewerPage/XR/WebXR/Quest-PICO/LOD/Gaussian 渲染器/
  streamed-SOG schema/缓存语义/上传状态机/publish worker/重建算法/
  torch/gsplat 版本/DB schema/Alembic migration/UI/业务接口**）
- 前置：FIX-01..06、FIX-06.1、FIX-06.2 全部 PASS（软件侧）
- 基线：`57170a5312cb532019ee07949463eb65697918bb`（FIX-06.2，工作区 clean）
- 本轮只闭合三项：A（release preflight cwd 依赖，P1 blocker）、
  B（first-deploy rollback 未撤销 current，P1 blocker）、C（production smoke
  默认 curl -k，验收加固）

---

## RESULT

**PASS（软件侧）—— A/B 两个 P1 软件 blocker + C 生产 TLS 加固全部关闭。**
**NOT EXECUTED（如实标注）**：真实生产主机部署（无生产主机/域名/Let's Encrypt/
systemd/公网 Nginx）；Quest/PICO 真机验收（无头显）。

```text
FIX-06.2.1 (final deploy-path closure): PASS
Software acceptance:    PASS
Software blockers:      NONE
Production host deploy: NOT EXECUTED (requires a real production host)
Hardware acceptance:    PENDING (Quest/PICO real device only)
```

---

## 1. BASELINE

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 基线 commit | `57170a5312cb532019ee07949463eb65697918bb`（FIX-06.2 收尾） |
| 工作区 | clean（提交前 `git status --porcelain` 为空，diff --check 干净） |
| 提交（本阶段，2 个） | `fix(deploy): close final release-path rollback gaps`（e9e4150）＋ `test(fix0621): lock deploy cwd rollback and TLS contracts`（最新 HEAD，含本报告） |

## 2. A — RELEASE PREFLIGHT CWD 依赖（P1 blocker）

### 2.1 根因

`deploy_release.sh` step 5（Alembic）`cd "${RELEASE_DIR}/apps/api"` 后**没有回到
release root**；step 6b 继承该 cwd 调用 `preflight.sh --mode release`。而
`apps/api/pyproject.toml` 的 wheel 只打包 `packages = ["app"]` —— `workers` **不在
wheel 里**，`import workers.celery_app` 只能从 **repo root cwd** 解析
（`workers/celery_app.py` 自身把 repo root / workers 目录插入 sys.path，但第一步
`import workers.celery_app` 必须先能被找到）。systemd units 用
`WorkingDirectory=/opt/gsplatform/current` 就是这一契约的证据。

### 2.2 真实复现（clean tree + fresh venv，§四）

```bash
TMP=$(mktemp -d); git archive HEAD | tar -x -C "$TMP"
python3 -m venv "$TMP/apps/api/.venv"
"$TMP/apps/api/.venv/bin/pip" install -e "$TMP/apps/api"
cd "$TMP/apps/api"
env -u PYTHONPATH "$TMP/apps/api/.venv/bin/python" -c "import workers.celery_app"
```

实测：**`ModuleNotFoundError: No module named 'workers'`**（从 `<release>/apps/api`
cwd、PYTHONPATH 移除时）。同一 venv 从 release root 运行 → `WORKERS_IMPORT_OK`。
复现 old preflight `--mode release`（cwd=apps/api）→ `[I]` 段
`workers.celery_app import failed in shared venv`，release 预检 FAIL —— 即使 release
本身完全有效，**首次部署必然被 step 6b 拒绝**。

### 2.3 修复

- **preflight.sh**：进入 release mode 后解析一次
  `CURRENT_ROOT="$(readlink -f "${DEPLOY_ROOT}/current")"`；`[I]` 段的完整导入闭包
  （deps + app.storage + app.main + workers.celery_app +
  workers.tasks.publish_scene/reconstruct_scene/build_collision）在子 shell
  `( cd "$CURRENT_ROOT" && ... )` 内执行。**release preflight 不依赖调用方 cwd、
  不依赖 PYTHONPATH、自己建立 repo-root import context**。
- **deploy_release.sh**：step 5 之后 `cd "$RELEASE_DIR"` 归一化自身 cwd
  （双保险）。

### 2.4 回归（§六/§七/§二十八）

`apps/api/tests/test_fix0621.py::TestReleasePreflightCwd`（5 项），fixture 从
`git archive HEAD` 构建 **clean tracked release tree**（绝非开发工作树）+ 真共享
venv（recon 契约）+ 真 web dist；所有 subprocess **显式 `env.pop("PYTHONPATH")`**
且 cwd 分别为 release root / `<release>/apps/api` / `/tmp` / deploy 真实 cwd 链
（step5 → step6 → step6b），全部 `--mode release` **PASS**。实测 **64 passed**
（§8），其中该组 5 项全绿。

## 3. B — FIRST-DEPLOY ROLLBACK（P1 blocker）

### 3.1 根因

old step 6b 回滚只处理「有旧版本」分支
（`if [[ -n "$PREV_RELEASE" && -d "$PREV_RELEASE" ]]`）；**首次部署
`PREV_RELEASE=""` 时跳过回滚** → preflight FAIL 后 `current` 仍指向失败的
新 release，然后 exit 1 —— **不是 fail-closed**。

### 3.2 修复（`deploy/scripts/lib_rollback.sh`，新）

极小 helper `rollback_current <failed_new_release> <previous_release_or_empty>`：

- **CASE 1 — upgrade**：`ln -sfn $previous` + `mv -Tf` 原子恢复 `current → previous`。
- **CASE 2 — first deploy（无 previous）**：仅当 `current` 是 symlink 且
  `readlink -f(current) == readlink -f(failed_new_release)` 时 `rm -f` 撤销
  `current`。**失败 release 目录保留用于诊断（绝不被删除）**。
- **默认 — unknown target**：current 不解析到失败 release → **REFUSE**，不做任何
  破坏性操作，返回非零（防误删真实目录 / 误删其他 operator 刚切换的 current）。

`deploy_release.sh` step 6b 改为调用 `rollback_current` 后无条件 `exit 1`。

### 3.3 回归（§十二/§十三/§十四）

`TestRollbackFailClosed`（4 项）：真实 temp 目录 + 真实 symlink + 真实
`lib_rollback.sh`（ln/mv/readlink/rm **零 mock**）——

- first-deploy preflight 失败 → `current` **被移除**，失败 release 目录仍存在；
- upgrade preflight 失败 → `current` 恢复为 previous（`readlink -f` 断言）；
- rollback **绝不删除 release 目录**（build-artifact 保留）；
- unknown current target → 拒绝（非零退出，symlink 原封不动）。

## 4. C — PRODUCTION SMOKE TLS（验收加固）

### 4.1 问题

`C() { curl -sk ...; }` 全局 `-k` → production smoke 跳过 HTTPS 证书校验。

### 4.2 修复（`smoke_test.sh`）

- **默认严格 TLS**：`CURL_TLS_ARGS=()`，`C() { curl -sS "${CURL_TLS_ARGS[@]}" "${RESOLVE_ARGS[@]}" "$@"; }`（`--resolve` 改数组防 word-splitting）；`-k` 仅当
  `--insecure` 显式给出（`CURL_TLS_ARGS=(-k)`）。
- **`--insecure` 显式 opt-in，生产禁止**：arg 解析新增 `--insecure`；
  `ENVIRONMENT == production && INSECURE == 1` → **exit 1**（"forbidden in
  production"），生产验收无法无意绕过证书。
- `deploy_release.sh` step 9：`SMOKE_INSECURE=1`（仅 staging）才向 smoke 追加
  `--insecure`；生产永不传。
- **行为**：证书过期 / 主机名不匹配 / 未知 CA / 链断裂 → curl 非零 → smoke FAIL，
  不吞错误。
- **GET 无回归**（§二十四）：资产段保持 `g()`/`hdr()` 真实 GET，无
  `curl -I/-sI/--head` 重新引入（`TestSmokeAssetStillGet` + test_fix062 静态断言
  保持 `C -sI` 恰 2 处=SPA+安全头）。

### 4.3 回归（§二十一）

`TestSmokeTls`（3 项）：production 默认严格（文本断言无 `curl -sk` / 无全局
`--insecure` / `CURL_TLS_ARGS=()`）；`production --insecure` → 非零 + forbidden；
`staging --insecure` → 被接受（显式 opt-in，仅因目标不可达而 FAIL）。

## 5. DOCS（§二十三/§四十）

- `DEPLOYMENT_RUNBOOK.md` §5：production smoke 严格验证真实 TLS 证书链与主机名；
  `--insecure` 仅限 staging/local 显式诊断、生产拒绝；内部 CA 走系统 trust。
- `PRODUCTION_RUNTIME_ACCEPTANCE.md`：新增 FIX-06.2.1 节。

## 6. TESTS（FIX-06.2.1 组，13 项）

| 类 | 项数 | 内容 |
|---|---|---|
| `TestReleasePreflightCwd` | 5 | release root / apps/api / /tmp / deploy 真实 cwd 链 全部 PASS（PYTHONPATH unset）；static：preflight `[I]` 以 CURRENT_ROOT 为 cwd、无全局 PYTHONPATH 注入 |
| `TestRollbackFailClosed` | 4 | first-deploy 移除 current、release 目录保留、upgrade 恢复 previous、unknown REFUSE（真实 symlink，零 mock） |
| `TestSmokeTls` | 3 | 生产严格 TLS、生产拒 --insecure、staging 接受 --insecure |
| `TestSmokeAssetStillGet` | 1 | TLS 重构后资产段仍为真实 GET |

## 7. GATES（真实运行值）

| 门禁 | 命令 | 结果 |
|---|---|---|
| FIX-06.1+06.2+06.2.1 targeted | `pytest tests/test_fix061.py tests/test_fix062.py tests/test_fix0621.py` | **64 passed**（31 + 20 + 13） |
| backend 全量 | `.venv/bin/python -m pytest tests` | **342 passed**（329 + 13） |
| backend ruff | `.venv/bin/python -m ruff check app tests` | **All checks passed** |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| workers | `python -m pytest tests`（workers/tests） | **13 passed** |
| web typecheck | `pnpm typecheck`（tsc -b --noEmit） | **exit 0（0 errors）** |
| web lint | `pnpm lint`（oxlint） | **exit 0** |
| web test | `pnpm test`（vitest run） | **228 passed / 26 files** |
| web build | `pnpm build` | **exit 0** |
| clean-checkout 门禁 | `verify_release_source.sh`（提交后执行，新 HEAD） | **GATE_EXIT=0**（归档 342 收集 / 338 passed + 4 有意 skip；fresh venv + fresh recon venv PASS） |
| GPU runtime | `verify_reconstruction_runtime.py`（真 venv，**无 --allow-no-gpu**） | **PASS**：torch 2.14.0+cu126 / gsplat 1.5.3 / trainer --help / CUDA 2× A6000 / gsplat rasterization（64 lit px） |
| shell 语法 | `find deploy -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n` | 全部 OK（含新 lib_rollback.sh） |
| nginx | `nginx -t` | **syntax is ok / test successful** |

## 8. NOT EXECUTED（如实标注）

1. **真实生产主机部署**：无 Ubuntu production host / 真实域名 / Let's Encrypt 证书 /
   systemd 生效 / 公网 Nginx 实跑 —— 脚本经 bash -n + nginx harness `-t` + 本机
   clean release 仿真（release preflight 三 cwd + deploy 真实 cwd 链）真实跑通。
   **不得写作 production deployment PASS。**
2. **Quest/PICO 真机验收**：无头显；6DoF / 视差 / 沉浸内交互 / LOD 全量首帧真实
   GPU 复核待真机执行 —— 唯一剩余 blocker，与软件无关。

## 9. FINAL ACCEPTANCE STATUS

```text
FIX-06.2.1 (final deploy-path closure): PASS
  A release preflight cwd independence: PASS (CURRENT_ROOT subshell + 3-cwd +
     deploy-chain regression; PYTHONPATH never injected)
  B first-deploy rollback fail-closed:  PASS (current removed on first-deploy
     failure; upgrade restores previous; unknown target refused; release dir kept)
  C production smoke strict TLS:        PASS (no default -k; --insecure staging
     opt-in only; production rejects it; GET assets unchanged)
Software acceptance:    PASS
Software blockers:      NONE
Production host deploy: NOT EXECUTED
Hardware acceptance:    PENDING (Quest/PICO real-device only)
```

**READY FOR HARDWARE ACCEPTANCE**