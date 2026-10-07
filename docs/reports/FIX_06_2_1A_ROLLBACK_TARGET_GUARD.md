# FIX_06_2_1A_ROLLBACK_TARGET_GUARD：Rollback 目标所有权收口报告

- 日期：2026-10-07
- 阶段：FIX-06.2.1a —— Rollback Target Guard（FIX-06.2.1 的极小补丁；
  **非新 Phase / 无新功能 / 非新软件审计**；收口后**立即停止软件整改**）
- 前置：FIX-01..06、FIX-06.1、FIX-06.2、FIX-06.2.1 全部 PASS（软件侧）
- 基线：`49321d4c4a1eae05ce8fab1d6903261a4974651c`（FIX-06.2.1，工作区 clean）

---

## RESULT

**PASS（软件侧）—— `rollback_current` 的 upgrade 分支缺少共同目标所有权校验已关闭。**
**NOT EXECUTED（如实标注）**：真实生产主机部署（无生产主机/域名/证书/systemd/公网
Nginx）；Quest/PICO 真机验收（无头显）。

```text
FIX-06.2.1a (rollback target guard): PASS
Rollback target ownership guard:      PASS
Software acceptance:                  PASS
Software blockers:                    NONE
Production host deploy:               NOT EXECUTED
Hardware acceptance:                  PENDING (Quest/PICO real device only)
```

---

## 1. BASELINE

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 基线 commit | `49321d4c4a1eae05ce8fab1d6903261a4974651c`（FIX-06.2.1 收尾） |
| 工作区 | clean（提交前 `git status --porcelain` 为空，diff --check 干净） |
| 提交（本阶段，1 个） | `fix(deploy): guard rollback against stale current target` |

## 2. ROOT CAUSE

### 2.1 old upgrade behavior

`lib_rollback.sh::rollback_current`（FIX-06.2.1 实现）的分支顺序：

```bash
if [[ -n "$previous" && -d "$previous" ]]; then     # CASE 1 在前
    ln -sfn "$previous" "$next"
    mv -Tf "$next" "$link"                          # ← 未先校验 current
    return 0
fi
```

### 2.2 missing guard

**upgrade 分支发生任何 ownership 校验之前**。若 `current` 已不再指向本次失败的
release（例如另一 operator 刚切换过 current，或 step 6 的 switch 从未发生），
upgrade 分支仍会把 previous **覆盖到真实 current 上** —— 静默破坏现场。

另一个暴露：`previous` 提供但路径缺失时 `-d` 为假，CASE 1 跳过，**落进 CASE 2
（first-deploy）删掉 current** —— 把「previous 配置错误」错误当成「首次部署」。

### 2.3 RED reproduction（修改实现前，真实临时目录 + 真实 symlink + 真实 lib）

```text
# case D — upgrade / current=unrelated / prev=valid
rc=0   ✓ current restored → .../PREV
       before: current → UNREL     after: current → PREV   ← BUG: 覆盖了无关 current

# case E — upgrade / current=new / prev=MISSING
rc=0   ✓ current removed (first deploy...)
       before: current → NEW       after: current 被删除     ← BUG: previous 缺失被当成首次部署
```

`apps/api/tests/test_fix0621.py` 新增 2 项回归，修改实现前运行：

```text
2 failed in 0.44s
FAILED TestRollbackFailClosed::test_upgrade_refuses_when_current_no_longer_points_to_failed_release
FAILED TestRollbackFailClosed::test_upgrade_refuses_missing_previous_release
```

## 3. COMMON OWNERSHIP GUARD（FIX）

`rollback_current` 重构为 **validate ownership first → then select rollback action**：

- **failed release**：`readlink -f "$new_release"` 解析，失败 → REFUSE。
- **current target**：`readlink -f "$link"` 解析；gate 要求 `current` 是 symlink
  **且** canonical target **精确等于** failed release，否则 **REFUSE**（非零，零改动）。
- **validation occurs before**：任何 mutate（upgrade 的 ln/mv 与 first-deploy 的
  rm）之前；两个分支共用同一 gate。
- **previous validation**：`previous` 非空 → 必须能 canonicalize 且是有效目录；
  否则 **REFUSE**（绝不降级成 first-deploy unlink，绝不误删 current）。
- 措辞按任务要求：**compare-before-mutate guard**（非 lock-free CAS；真正并发
  deploy 应由 deploy lock/flock 序列化，**本轮不引入**）。

## 4. ROLLBACK MATRIX（真实 symlink，零 mock）

| # | 场景 | 结果 |
|---|---|---|
| 1 | First deploy / current=new / prev=`""` | `current` 被移除（`rm -f` 已验证 symlink），release 目录保留 |
| 2 | First deploy / current=unrelated / prev=`""` | **REFUSE** rc=1，current 保持 unrelated |
| 3 | Upgrade / current=new / prev=valid | `current` 原子恢复 → previous（`ln -sfn` + `mv -Tf`） |
| 4 | Upgrade / current=unrelated / prev=valid | **REFUSE** rc=1，current 保持 unrelated，previous 不被覆盖上去 |
| 5 | Upgrade / current=new / prev=missing | **REFUSE** rc=1，current 保持 new（绝不 unlink） |
| 6 | failed new release 目录 | 始终保留（诊断用，永不删除） |
| 7 | previous release 目录 | 始终保留 |
| 8 | unrelated release 目录 | 始终保留（未被触碰） |

## 5. SAFETY

- `rm -rf` 存在：**无**（仅 `rm -f` 作用于已验证的 current symlink）。
- failed release 被删：**无**（目录保留）。
- previous 被删：**无**。
- unrelated release 被改动：**无**（REFUSE 路径零破坏）。
- atomic upgrade restore：**保持** `ln -sfn` + `mv -Tf` staging 链接（`current`
  永不出现暂时缺失的窗口；不改成 rm+ln）。

## 6. TESTS / GATES（本轮真实运行值，未沿用旧结果）

| 门禁 | 命令 | 结果 |
|---|---|---|
| test_fix0621 | `.venv/bin/python -m pytest tests/test_fix0621.py` | **15 passed**（13 + 2 新增） |
| FIX-06.1+06.2+06.2.1a targeted | `pytest tests/test_fix061.py tests/test_fix062.py tests/test_fix0621.py` | **66 passed**（31 + 20 + 15） |
| backend 全量 | `.venv/bin/python -m pytest tests` | **344 passed**（329 + 15） |
| backend ruff | `.venv/bin/python -m ruff check app tests`（venv 0.16.6） | **All checks passed**（本轮 diff 文件 ruff-clean；系统旧 ruff 0.8.4 对 `scene_runtime.py` 的 3 条 UP038 属基线既有、与本轮 diff 无关、按 §二 不在范围） |
| backend mypy | `.venv/bin/python -m mypy app` | **Success**（84 files） |
| workers | `.venv/bin/python -m pytest tests`（workers） | **13 passed** |
| web typecheck | `pnpm typecheck`（tsc -b --noEmit） | **exit 0（0 errors）** |
| web lint | `pnpm lint`（oxlint） | **exit 0** |
| web tests | `pnpm test`（vitest run） | **228 passed / 26 files** |
| web build | `pnpm build` | **exit 0** |
| clean-checkout 门禁 | `deploy/scripts/verify_release_source.sh`（提交后执行，新 HEAD） | **GATE_EXIT=0** |
| GPU runtime | `.venv/bin/python deploy/scripts/verify_reconstruction_runtime.py`（真 venv，**无 --allow-no-gpu**） | **PASS**：torch 2.14.0+cu126 / gsplat 1.5.3 / trainer --help / CUDA 2× A6000 / gsplat rasterization |
| shell 语法 | `find deploy -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n` | 全部 OK（含 lib_rollback.sh / deploy_release.sh / preflight.sh / smoke_test.sh） |
| nginx | `nginx -t` | **syntax is ok / test successful** |
| 人工演练（§26） | /tmp 真实 symlink 5 场景（A/B/C/D/E），`readlink -f current` 前后记录 | 新旧实现对照符合矩阵（见下） |

### 人工 shell 演练记录（/tmp，真实目录/symlink，零 mock）

```text
OLD (e9e4150):  D upgrade/current=unrelated  rc=0  current UNREL → PREV    ✗ 覆盖
               E upgrade/current=new/prev=missing rc=0 current 被删         ✗ 误删
NEW (fix):      A first-deploy/new     rc=0  current 移除 ✓
               B first-deploy/unrelated rc=1 REFUSE current 不变 ✓
               C upgrade/new→prev      rc=0  current → PREV ✓
               D upgrade/unrelated     rc=1 REFUSE current 不变 ✓
               E upgrade/prev=missing  rc=1 REFUSE current 不变 ✓
```

## 7. SCOPE（§2/§31 人工 diff 审核）

- 本轮改动文件仅：`deploy/scripts/lib_rollback.sh`（函数 + 头注释）、
  `apps/api/tests/test_fix0621.py`（新增 2 项回归）、两份报告
  （`FIX_06_2_1A_ROLLBACK_TARGET_GUARD.md` 新增；`FIX_06_2_1_FINAL_DEPLOY_PATH_CLOSURE.md`
  post-audit note；`PRODUCTION_RUNTIME_ACCEPTANCE.md` 追加 FIX-06.2.1a 节）。
- **未改动**：preflight cwd 逻辑（CURRENT_ROOT 子 shell）、deploy step5 后 `cd "$RELEASE_DIR"`、
  production 严格 TLS、`--insecure` 生产拒绝、scene asset GET smoke、SuperSplat / Viewer /
  XR / WebXR / LOD / Gaussian / cache 策略 / scene assets / upload 状态机 / publish worker /
  DB schema / Alembic migrations / UI / 业务 API。无 `rm -rf`、无 secrets。
- deploy_release.sh：**未改**。step 6b `rollback_current` 返回 1（REFUSE）时仍
  无条件 `exit 1` —— rollback REFUSE **不会**让部署成功（§15 已确认）。

## 8. NOT EXECUTED（如实标注）

1. **真实生产主机部署**：无 Ubuntu production host / 真实域名 / Let's Encrypt 证书 /
   systemd 生效 / 公网 Nginx 实跑。**不得写作 production deployment PASS。**
2. **Quest/PICO 真机验收**：无头显；6DoF / 视差 / 沉浸内交互 / LOD 全量首帧真实
   GPU 复核待真机执行 —— 唯一剩余 blocker，与软件无关。

## 9. FINAL ACCEPTANCE STATUS

```text
FIX-06.2.1a (rollback target guard): PASS
  Rollback target ownership guard: PASS (compare-before-mutate gate before BOTH
     branches; upgrade unknown target REFUSE; invalid previous REFUSE (never
     degrades to first-deploy unlink); atomic upgrade restore kept)
Software acceptance:    PASS
Software blockers:      NONE
Production host deploy: NOT EXECUTED
Hardware acceptance:    PENDING (Quest/PICO real-device only)
```

**READY FOR HARDWARE ACCEPTANCE**
