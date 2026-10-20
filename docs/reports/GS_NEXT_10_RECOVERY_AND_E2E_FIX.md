# GS-NEXT-10 · 场景恢复缺陷修复与关键 E2E 回归

> 执行日期：2026-10-20
> 仓库：`/fj/GSPlatform`，基线 `main` = `a301ef8`（GS-NEXT-09 审计报告）
> 迁移 head：`b7c1d2e3f4a5`（两个隔离库 `alembic_version` 均已同步）
> 隔离环境：staging 库 `gsplatform_vr00_20261011` + 开发态库 `gsplatform_vr00_tests_20261011`
> （API `127.0.0.1:8001` / vite `127.0.0.1:5199` / Redis `127.0.0.1:16384`）
>
> **边界（本轮严格遵守）**：所有写入只发生在上述隔离库；历史 Building、原始 PLY、
> 已发布资产、`scene_versions`、`scenes.current_version_id` 一律**未修改**（§5.4 有断言）；
> 未开发版本回滚、未更换官方 Viewer（`@playcanvas/supersplat-viewer@1.35.0` 文件系统
> 层零改动，`git status` 无 `node_modules` 变更）、未触碰 Gaussian / LOD / XR 渲染链路。

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 归档 → **立即**恢复 | **已修复**。根因：请求级 Session 在 FastAPI 依赖 teardown（响应之后）才 commit |
| 软删除 → 恢复 | **已修复**。`deleted_at` 标记可被授权接口清除，资产与 SceneVersion 原样保留 |
| 恢复后的业务语义 | **已修复**。新增 `scenes.archived_from_status`，恢复回到归档前状态（READY 不会被抬成 PUBLISHED） |
| 回收站入口 | **已补齐**。`GET /me/scenes?status=DELETED` / `?includeDeleted=true` + 作品页「回收站」标签 |
| 作品卡操作与真实后端状态对齐 | **已修复**。ARCHIVED 不再伪装成「失败」；恢复入口按真实状态显示；已删除作品不再给「删除」死按钮 |
| `fix02-semantics` E2E | **6/6 通过**（修复前 2/6） |
| `gsnext03-viewpoint` E2E | **5/5 通过**（27.2m；修复前 1/5）。根因见 §4.2，全部是测试夹具/环境问题 |
| `ssv08-streaming` E2E | **3/3 通过** |
| 归档/删除/恢复能否完整执行 | **能**（真实 API + 真实浏览器双重复核，§1.4 / §5.4） |
| 是否存在新回归 | **否**。后端 587（582 passed / 5 个既有环境失败）、前端 379、Worker 190，均与基线一致（§5 / §6.5） |
| 是否具备进入 GS-NEXT-11（版本管理）条件 | **是** |

---

## 1. 归档 / 恢复：根因与修复

### 1.1 根因（真实复现，非推测）

GS-NEXT-09 记录的现象：`POST /archive` 返回 200，紧接着 `POST /restore` 返回 409。

本轮在隔离 staging 上逐毫秒测量：

```
POST /archive   → 200  (t = 0.105s)
POST /restore   → 409   ← 客户端下一条请求读到的仍是旧行
POST /restore   → 200   （隔 ~50ms 后再发同一条请求即成功）
```

**机制**：`apps/api/app/db/session.py` 的 `get_db_session()` 是
`yield session` 之后才 `session.commit()`。FastAPI 的依赖 teardown 在**响应发出之后**才执行
（`app/main.py` 还挂了 `BaseHTTPMiddleware`，把 teardown 进一步推到响应之后）。于是
`SceneService.archive_scene()` 里的 `flush()` 只把改动写进**尚未提交的事务**，而客户端紧接着
发起的 `restore` 在**另一个**请求/会话里读到的还是 `status=PUBLISHED`，撞上
`restore_scene` 的 `status != ARCHIVED` 判定 → 409。

这与 GS-NEXT-02/03 修过的 presentation / viewpoint「读己所写」是同一类竞态，只是那里恰好
发生在**同一请求内**回读，跨请求的 archive → restore 才把它暴露出来。

### 1.2 修复

`apps/api/app/services/scenes.py`（+ `repositories/scenes.py` 新增 `commit()` 包装）：

- `archive_scene` / `restore_scene` / `soft_delete_scene` 改为**显式 `commit()`**，在响应序列化
  之前落库。这与仓库既有写法一致（`authoring.py`、`upload_service.py`、`editor_session.py`、
  `auth.py`、`shares.py` 都已显式 commit），**不改变其它 API 的提交行为**：
  `get_db_session()` 的 teardown commit 仍在，重复 commit 幂等。
- `archive_scene` 先记 `archived_from_status = scene.status` 再置 `ARCHIVED`；
  已软删除的场景拒绝归档（409），避免产生「既删除又归档」的歧义状态。
- `restore_scene`：
  - `deleted_at is not None` → 清空标记，**保留原 status**（删除前是 PUBLISHED 就回到 PUBLISHED）；
  - 归档态 → 恢复为 `archived_from_status`（缺省 PUBLISHED），**不再一律 PUBLISHED**；
  - 两者都不是 → 409（保持幂等安全，重复恢复不会误清别的标记）。
- `soft_delete_scene`：只写 `deleted_at`，**不删除任何行/资产**；重复删除幂等成功（不再重复查作业）。

### 1.3 迁移

`apps/api/migrations/versions/b7c1d2e3f4a5_gsnext10_scene_archived_from_status.py`
新增可空列 `scenes.archived_from_status VARCHAR(20)`；`down_revision = cd03ef05ab06`。
两个隔离库已 `alembic upgrade head`。

### 1.4 后端验证（真实 HTTP + 独立会话回读）

`apps/api/tests/test_gsnext10_recovery.py` —— **17 passed**（无 sleep、无重试、无放宽）：

- 归档后**立即**恢复 → 200，状态回到 PUBLISHED，`archived_from_status` 归零；
- `READY` 场景归档 → 恢复 → 仍是 `READY`（不强制 PUBLISHED）；
- 对既未归档也未删除的场景恢复 → 409；重复归档 → 409；
- 跨用户归档/恢复 → 403；非所有者看不到已删除场景；
- 软删除 → 恢复：`deleted_at` 清空、status 保留；
- 软删除 → 恢复后 `scene_versions` 列表与 `current_version_id` **逐行不变**；
- 已删除场景：默认列表不可见、`?status=DELETED` 与 `?includeDeleted=true` 可见（`isDeleted=true`）；
- 已删除场景对所有者 detail 404，恢复后 200 且 `isDeleted=false`；
- **分享链接**：删除后 resolve 404（资产不外露）→ 恢复后同一 token 再次 200（链接未被销毁）；
- **归档同理**：归档后 resolve 403 → 恢复后 200；
- 公开目录：归档后移出公开列表，恢复后按原 visibility/status 回到公开列表；
- 有 RUNNING 作业时删除被拒（409）且 `deleted_at` 未置位。

---

## 2. 软删除恢复闭环与回收站入口

| 环节 | 实现 |
| --- | --- |
| 删除语义 | 只写 `scenes.deleted_at`；`scene_versions` / 资产 / `current_version_id` 一律保留 |
| 恢复接口 | `POST /scenes/{slug}/restore`（owner-only，`require_csrf`）—— 归档态与删除态共用 |
| 用户找回入口 | `GET /me/scenes?status=DELETED`（只回回收站）与 `?includeDeleted=true`（与正常作品一起回） |
| 列表语义 | 默认**不含**已删除；`includeDeleted=true` 才带出，且带 `isDeleted: true` |
| 可见性 | 已删除场景对**所有人**（含所有者）详情 404 —— 与 FIX-01「删除即不可见」契约一致；只有回收站列表与 restore 两个口子 |
| 永久删除 | **未实现、也未新增**（本轮明确不做物理清理） |

前端（`apps/web`）：

- `services/worksApi.ts`：`isDeleted → status: 'DELETED'`；`ARCHIVED → 'ARCHIVED'`（不再伪装 FAILED）；
  `sceneId` 只对 PUBLISHED / ARCHIVED 暴露（已删除的打开必然 404，不给死按钮）；
- `pages/MyWorksPage.tsx`：新增「已归档 / 回收站」两个标签，列表请求带 `includeDeleted=true`，
  「全部」不含回收站内容；
- `components/WorkCard.tsx`：`RESTORABLE = {ARCHIVED, DELETED}` 显示「恢复」；
  已删除作品不显示查看/编辑/任务/删除；删除提示语改为「已移入回收站，可随时恢复」。

---

## 3. 作品卡操作与实际后端状态对齐

修复前的错配（GS-NEXT-09 已记录，本轮确认并修掉）：

| 问题 | 修复 |
| --- | --- |
| `ARCHIVED` 被映射成 `FAILED`，卡片显示「失败」 | 映射为 `ARCHIVED`，标签「已归档」（warning 色） |
| 「恢复」按钮只在 `FAILED` 出现 —— 而后端 `restore` 对 FAILED 场景返回 409，是**点了必失败的按钮** | 只在真正可恢复的 `ARCHIVED`/`DELETED` 显示；FAILED 不再显示死按钮 |
| 已删除作品仍显示「查看/编辑」—— 后端 detail/PATCH 对已删除一律 404 | 已删除作品只保留「恢复」 |
| 已删除作品仍显示「删除」 | 不再显示 |
| 删除提示语暗示存在延迟物理清理 | 改为「已移入回收站，可随时恢复」，与「本轮不做永久删除」一致 |

单测：`apps/web/src/__tests__/works-recovery.test.tsx`（5 passed）+ 既有 `works.test.tsx` 断言同步更新。

---

## 4. 关键 E2E 失败根因

### 4.1 三个 spec 的结论总览

| spec | 本轮结果 | 判定 |
| --- | --- | --- |
| `fix02-semantics`（6 用例） | **6 passed** | 修复前 2/6；失败原因 = 测试夹具过时 + 测试环境 rAF 冻结（见 4.3） |
| `gsnext03-viewpoint`（5 用例） | **5 passed**（27.2m） | 修复前 1/5；失败根因 = 测试夹具 rAF 冻结 + 阻尼过渡收敛预算（4.2），非产品缺陷 |
| `ssv08-streaming`（3 用例） | **3 passed** | 与 GS-NEXT-09 一致，夹具无缺失 |

### 4.2 关键 E2E ①②：初始相机 / Viewpoint —— 根因分类

按任务要求逐项归类（1 真实产品缺陷 / 2 断言过时 / 3 异步时序 / 4 SwiftShader-浏览器崩溃 / 5 夹具不完整）：

| # | 现象 | 根因分类 | 证据 |
| --- | --- | --- | --- |
| E-1 | fix02「Frame/Reset」失败（相机不动） | **4**（浏览器/渲染进程） | `chromium_headless_shell` 在官方 viewer 切到按需渲染（`app.autoRender=false`, `progress=100`）后**冻结 `requestAnimationFrame`**：实测 `rAF = 0/s`、`app.frame` 不前进 ⇒ 官方 `CameraManager` 过渡一帧都不跑。改用完整 Chromium（`channel: 'chromium'`）+ `--disable-gpu-compositing` 后 `rAF ≈ 58/s`，同一断言通过 |
| E-2 | fix02 world-transform 断言失败 | **2**（断言过时） | 断言里硬编码了旧的资产包围盒常量（±1）；夹具资产重新生成后为 ±2.397/±1.413/±1.750。改为读当前夹具的恒等包围盒再断言 Ry90 的 x↔z 交换（契约不变） |
| E-3 | gsnext03 Case 1 `page.reload()` → `net::ERR_ABORTED; frame detached` | **3**（异步时序） | dev server 首屏大 chunk 仍在下载时 reload 会被新模块打断。改为 `goto(..., {waitUntil:'domcontentloaded'})` + 显式等待（同等强度，未降低断言） |
| E-4 | gsnext03 Case 2 轨迹断言全过，但「精确落位」超时 | **3+环境**（收敛预算，非产品缺陷） | 官方 `selectAnnotation` 是**阻尼式**过渡（`OrbitController` damping 0.95/帧；官方 `duration` 1.2–2.4s 只在真 GPU 成立）。软件渲染下收敛是长尾：实测 `A→B` 单调收敛 d: 3.499 → 0.003 用 60s、无跳变。断言（`<0.05`）未放宽，只把「等过渡完成」从固定 sleep 改为轮询 + 长预算；**最终 5/5 通过** |
| E-5 | gsnext03 Case 4 XR 页相机落位超时 | **3+环境** | 同 E-4（该用例移动距离 4.5，收敛更久）。加长预算后通过：`XR after = [0.9012,1.5002,1.8031]` vs 目标 `[0.9,1.5,1.8]`；未-authored 的 Case 4 用近距离视点（正门视角，实测落位 0.049 < 0.05）本就通过 |
| E-6 | gsnext03 Case 1 最终超时 | **3+环境**（预算） | 该用例要跑**两次完整 Viewer 加载**（创作页 + 消费页）再等一次落位；软件渲染 + 高负载机器下 >600s。断言不变，落位等待预算 420s / 用例预算 1500s 后通过 |
| E-7 | ssv08 | — | 无失败；`manifest` 回退 → `lod-meta`、83 个分段 chunk 请求、XR 页 webgl2 21k gaussians 全部符合契约 |

**没有发现新的产品逻辑缺陷（分类 1）**；也没有为了通过而删除测试、放宽核心断言或改 SKIP。

原始日志见 `docs/reports/gsnext10-evidence/`：

- `vp-landing-probe.log` —— 落位精度实测（`A→B` 单调收敛 3.499 → 0.003，耗时 60s，
  逐 3s 采样，无跳变）；同时记录 `raf/s = 58`；
- `gsnext03-viewpoint.final.log` —— `gsnext03-viewpoint` 5/5 通过（27.2m）的完整运行日志；
- `workers-pytest.log` —— Worker 189 passed / 1 skipped。

### 4.3 一个被证实是「测试环境」而非产品的问题：headless shell 的 rAF 冻结

官方 viewer 在加载完成后把 `app.autoRender` 置 false，改为按需渲染。Playwright 默认的
`chromium_headless_shell` 在没有合成需求时会停止调度 `requestAnimationFrame`；而官方
`CameraManager.update()`（推进 `transitionTimer`、做阻尼插值）挂在 app 的帧循环上，
于是**所有相机过渡（frame / reset / 已保存视角 / 标注）静默失效**——相机不动、断言超时，
但产品逻辑本身没问题。这是测试夹具缺陷，修复方式是换用完整 Chromium 构建（见
`apps/web/e2e/fresh-browser.ts` 的 `LAUNCH_OPTIONS`），**不是**放宽相机断言。

---

## 5. 全量回归

### 5.1 后端

| 项 | 命令 | 结果 |
| --- | --- | --- |
| ruff | `ruff check app tests migrations` | **All checks passed** |
| mypy（strict） | `mypy app` | **Success: no issues found in 94 source files** |
| pytest | `pytest -q`（隔离库，587 collected） | **582 passed / 5 failed**，5 个失败全部与本次改动无关（见 §6.5） |

### 5.2 前端

| 项 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `tsc -b --noEmit` | **通过** |
| lint | `oxlint src` | **通过** |
| vitest | `vitest run` | **379 passed / 37 test files**（含本轮新增的 `works-recovery.test.tsx` 5 例） |
| 生产构建 | `pnpm --filter @gsplatform/web build` | **成功**（`built in 6.21s`，JS 4.20 MB / gzip 1.18 MB） |

### 5.3 Worker

| 项 | 命令 | 结果 |
| --- | --- | --- |
| pytest | `pytest -q tests`（隔离库） | **189 passed / 1 skipped** |

### 5.4 恢复链路端到端（真实浏览器）

`apps/web/e2e/gsnext10-recovery-viewer.spec.ts`（夹具由
`scripts/gsnext10_seed_recovery_fixture.py` 播种到隔离库，自带 scene-origin 根）：

1. descriptor 基线：记录 `content`（current 版本资产 URL/格式）与视角 ID 集合；
2. 软删除 200，重复删除幂等 200；
3. 删除后：所有者 detail 404、`/runtime` 404，回收站列表可见且 `isDeleted=true`；
4. 恢复 200，**紧接着**的第一次 detail 读取就 200（读己所写已无竞态）；
5. 恢复后 descriptor 与删除前**逐字节一致**（current 指针/版本/视角未被改动）；
6. 恢复后 Web Viewer 用真实 SOG 正常加载：`loaded=true, gsplats=59400, format=sog`。

结果：**1 passed**（13.3s / 13.2s 连续两次运行均通过，夹具无需重新播种即可重复执行）。
删除前后对比用 descriptor 而不是靠「先打开一次 Viewer」，是为了把删除放在任何
碰撞构建作业之前 —— `soft_delete` 在存在活动作业时按设计返回 409，顺序颠倒会让
用例受作业状态影响。

### 5.5 明确未改动的东西（安全边界）

- `node_modules/**`（含官方 `@playcanvas/supersplat-viewer@1.35.0`）：`git status` 零变更；
- 历史 `scene_versions` 行、`scenes.current_version_id`：§1.4 与 §5.4 都有逐行断言；
- 原始 PLY / 已发布 SOG 资产：未删除、未重写；
- 生产库（`:5432/gsplatform`）未被写入：所有测试都显式指向隔离库。

---

## 6. 未解决事项 / 遗留

1. **`gsnext03-viewpoint` 的通过依赖很长的等待预算**（软件渲染：一次长距离落位收敛到
   0.05 实测可达 ~100s；Case 1 要跑两次完整 Viewer 加载）。断言仍是 `< 0.05`，没有被放松；
   预算由 `GS_CAMERA_SETTLE_MS`（默认 420s）与用例超时（1500s）控制。真机/真 GPU（官方
   `transition duration` 1.2–2.4s）下不需要这些余量，CI 应使用 GPU runner。
2. **PICO 真机**依旧 HARDWARE PENDING（本机无设备），与 GS-NEXT-09 结论一致。
3. 已删除场景如果**同时**处于归档态，恢复只清 `deleted_at`，场景仍是 ARCHIVED，需要再点
   一次「恢复」才回到 `archived_from_status`。这是刻意的两步语义（一次恢复只撤销一个状态
   位），已在代码注释中说明；如需一步到位可在 GS-NEXT-11 与版本管理一起设计。
4. dev 栈里创作页加载时会打出若干 `403/404` 控制台错误 —— 来自未启动的编辑器代理
   （`GS_EDITOR_PROXY_TARGET`）与封面回退，**不影响任何用例断言**，属于隔离环境未起全套服务。
5. **后端 587 个用例中 5 个失败，全部与本轮改动无关**（已用 `git worktree` 在基线
   `a301ef8` 上复现同样的失败）：
   - `tests/test_fix0621.py::TestReleasePreflightCwd` × 4 —— 部署预检脚本要调用本机
     nginx，而本机没有 `/etc/nginx/nginx.conf`
     （`nginx: [emerg] open() "/etc/nginx/nginx.conf" failed`）。该用例只在 `apps/web/dist`
     存在时才运行（否则 skip）—— 本轮跑过生产构建后它才开始运行。预检脚本本身本轮无改动
     （`git diff --stat` 无 `deploy/**`）。
   - `tests/test_editor_publication.py::test_export_retention_preserves_current_and_history`
     —— `cleanup_exports()` 返回 0（期望 1）；在基线 worktree 上**同样失败**。
6. 本机负载极高（load average 50–100，磁盘 WAL 同步单次 commit 曾达 ~10s），软件渲染 E2E
   的绝对耗时随负载剧烈波动；CI 上应使用 GPU runner。

---

## 7. 是否具备进入 GS-NEXT-11（版本管理）

**具备。** 理由：

- 恢复链路（归档/删除/恢复/回收站）语义明确、有真实接口、有独立会话回读的集成测试，
  且**不破坏历史版本与 current 指针**——这正是版本管理的前置契约；
- `scene_versions` / `current_version_id` 的读写路径已在本轮被逐行断言「恢复不动它们」，
  版本管理可以安全地在这之上构建；
- E2E 基线可信且全绿：fix02 = 6/6、gsnext03 = 5/5、ssv08 = 3/3、恢复链路 = 1/1；
- 唯一需要带入下一轮的是 §6.3 的「删除 + 归档叠加」状态位语义。
