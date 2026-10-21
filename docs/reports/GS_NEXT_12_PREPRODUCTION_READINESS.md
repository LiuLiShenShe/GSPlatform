# GS-NEXT-12 · 生产前加固：空间配置重新授权、版本一致性、部署/HTTPS/服务/备份就绪

> 执行日期：2026-10-21
> 基线：`main` = `2536c45`（`eedaefa` 之后的工作区；GS-NEXT-11 = `2536c45`）
> 新增迁移：`d4f5a6b7c8d9`（GS-NEXT-12：逐特性版本绑定）
> 隔离环境：staging 库 `gsplatform_vr00_20261011` + 开发态库 `gsplatform_vr00_tests_20261011`
> （API `127.0.0.1:8001` / vite `127.0.0.1:5173` / Redis 容器 `127.0.0.1:16384`）
> 临时生产栈：生产模式 API `127.0.0.1:18002` + 发布版 Nginx 站点文件
> （容器内 `nginx/1.31.6`，host-network 443/80，自签 `localhost.test` 证书）
> 恢复演练：临时 PostgreSQL 16 容器 `127.0.0.1:55433`（全新空库）
>
> **边界（本轮严格遵守）**：未切换任何现有生产环境；未修改真实域名/DNS；
> 未停止任何共享服务（gofast-postgres / redis / milvus 等均未触碰）；未修改历史
> 13M Gaussian 资产；未安装 systemd 单元到宿主机、未做宿主机重启；未进行正式
> HTTPS 证书签发（无合法域名与管理员权限）；未进行生产切流。所有破坏性演练
> （DROP DATABASE / 恢复 / 别名重建）只在**隔离副本**上执行。

---

## 0. 结论摘要

| 验收标志 | 结论 | 证据 |
| --- | --- | --- |
| `SPATIAL_REAUTHORING_READY` | **PASS** | §1：逐特性版本绑定 + 13 个新后端用例 + 真实浏览器 A→B→重存 B 相机→重开 Web/XR E2E |
| `VERSION_STORAGE_CONSISTENCY_READY` | **PASS** | §2：原子别名替换、提交失败补偿、一致性检查器 + 安全自愈；并发/断链/崩溃窗口用例 |
| `DEPLOY_PREFLIGHT_READY` | **PASS（配置与隔离执行层）/ 外部前提 BLOCKED** | §3：宿主机审计 + `preflight.sh` 实跑 8 passed / 0 failed / 11 warnings；域名/证书/root 缺失 |
| `HTTPS_STABLE_READY` | **BLOCKED_EXTERNAL_PREREQUISITE** | §4：发布版 Nginx 站点文件在隔离前缀中 `nginx -t` 通过并完成真实 HTTP 行为验证；但**无合法域名/证书/80·443 公网暴露**，不能声称已部署 HTTPS |
| `SERVICE_PERSISTENCE_READY` | **PARTIAL** | §5：单元文件语法/依赖/队列/ExecStart 校验 + user-manager 探针验证 restart-on-failure / SIGTERM / env / cwd；**未安装到宿主机、未验证整机重启** |
| `BACKUP_RESTORE_READY` | **PASS（隔离副本）** | §6：加密备份 → 空 PostgreSQL 16 恢复（3.1s）→ 表数/关键行数与源库逐项相等；发布资产解包后 156 个文件逐字节一致 |
| `PICO_HARDWARE_READY` | **HARDWARE PENDING** | 本轮无 PICO 设备；XR 只在桌面 Chromium/SwiftShader 下验证 |
| `PRODUCTION_CUTOVER_READY` | **BLOCKED** | 外部前提缺失，且任务书要求**不自动切流**；本报告不构成切流批准 |

**一句话结论**：P1（版本切换后空间配置永久 STALE、重新保存初始相机仍被屏蔽）已在
软件层闭环并有真实浏览器证据；版本/存储一致性、备份恢复、Nginx 站点行为均已在隔离
环境验证。真正阻塞上线的是**域名、DNS、证书、管理员权限与 PICO 真机**，不是代码。

---

## 1. §A 空间配置重新授权（P1）

### 1.1 复现与根因

GS-NEXT-11 的契约是“切换版本 → 整个空间配置 STALE”，但**没有任何重新确认入口**：

1. `SceneVersionService.activate` → `_invalidate_spatial()` 只把
   `scene_spatial_states.state` 写成 `STALE`（`apps/api/app/services/scene_versions.py`）；
2. `SceneRuntimeService` 在 STALE 时**无条件**清空 `initialCamera` /
   `worldTransform` / `viewpoints` / `annotations` / `collision`；
3. 用户在创作页重新保存初始相机只会写 `scene_presentations` 的相机字段，
   **不改变**全局 STALE 记录，于是描述符仍然屏蔽它 —— 即“永久 STALE”。

### 1.2 方案：逐特性版本绑定（最小列，不新增表）

新增迁移 `d4f5a6b7c8d9`：

| 表 | 新列 | 语义 |
| --- | --- | --- |
| `scene_spatial_states` | `revision INTEGER NOT NULL DEFAULT 0` | 单调失效计数，碰撞构建记录它 |
| `scene_presentations` | `initial_camera_version_id`、`world_transform_version_id` | 最近一次保存所针对的 `SceneVersion` |
| `scene_viewpoints` | `source_version_id` | 最近一次创建/显式更新所针对的版本 |
| `scene_annotations` | `source_version_id` | 同上 |

外键均 `ON DELETE SET NULL`；**不做数据回填**：`NULL` 精确表示旧的“未确认历史数据”。

核心规则（`apps/api/app/services/spatial_binding.py`）：

- 场景**没有** `scene_spatial_states` 行 → 从未失效 → 全部信任（与 GS-NEXT-11 之前完全一致，零回归）；
- 存在显式 `STALE` 行（或行的 `source_version_id != current_version_id`）→ 只有
  **绑定到当前版本**的健全特性才被信任；历史行保留原绑定，不被删除；
- `is_stale` **只认显式 `STALE`**，不会把历史遗留的其它状态串（如 `VERIFIED`）误判为失效；
- 保存初始相机只确认 `initialCamera`；保存世界变换只确认 `worldTransform`；
  创建/显式修改观察点、标注只确认各自记录 —— **保存相机绝不会连带恢复旧观察点/标注**；
- 碰撞与尺度标定保持**独立闸门**：碰撞构建记录 `spatialRevision`（`collision.py`），
  标定使用已有的 `calibration_source_version`；任何相机保存都不会重新启用行走；
- **不把全局 `SceneSpatialState` 翻成 `VALID`**：该行是历史失效记录，`API` 在存在记录时
  `spatial.state` 仍报告 `STALE`，而 `requiresConfirmation` 由“尚待确认的特性”决定；
- 描述符/列表中额外输出 `revision`、`pendingFeatures`、`confirmedFeatures`。

运行时（`scene_runtime.py`）：

- `_apply_spatial_bindings` 仅在失效时清空未绑定当前版本的相机/世界变换；
- `_build_viewpoints` / `_build_annotations` 仅在失效时按 `source_version_id` 过滤；
- `_build_collision` 在失效时要求 `build_params.spatialRevision == 当前 revision`，
  旧构建（无该字段）一律视为待重建，`enabled=false`。

### 1.3 真实浏览器 E2E（任务书指定的主链路）

`apps/web/e2e/gsnext12-spatial-reauthor.spec.ts`（真实资产夹具
`gsnext11-versions`：A=streamed SOG，B=单文件 SOG；Playwright `chromium` + SwiftShader）：

1. 在 A 保存初始相机 `CAM_A`、观察点、标注；
2. 切换到 B：描述符中相机为空、观察点/标注为空，但 DB 行仍在；
   `spatial.pendingFeatures` 含 `initialCamera/viewpoints/annotations`；
3. 在 B **只**重新保存初始相机 `CAM_B`；
4. 关闭页面 → 重新打开 `/scene/gsnext11-versions`；
5. Web 诊断：相机位置等于 `CAM_B`，视线方向点积 > 0.995（viewer 的 target 是
   `position + forward * focusDistance`，因此断言方向而非绝对 target），`contentUrl` 含 B 版本；
6. XR 诊断 `/xr/gsnext11-versions`：同一视角、同一 `contentUrl`，`viewpointCount = 0`
   —— A 的旧观察点没有被错误重新启用；
7. 版本列表：`pendingFeatures` 不含 `initialCamera`，`confirmedFeatures` 含 `initialCamera`，
   仍含 `viewpoints/annotations` 待确认；
8. 清理本轮创建的行，并把当前版本恢复为用例开始时的版本，避免污染共享夹具。

**结果：1 passed（真实浏览器，真实资产）。**

### 1.4 后端用例（6 个）

`apps/api/tests/test_gsnext12_spatial_rebinding.py`：

| 用例 | 证明 |
| --- | --- |
| `test_resaved_initial_camera_is_served_on_the_new_version` | P1 闭环：重存后当前版本立即下发新相机 |
| `test_recreated_records_bind_to_current_version_only` | 新建观察点/标注只绑定当前版本；改名/更新不越界 |
| `test_saving_camera_never_restores_transform_or_collision` | 只存相机不会恢复世界变换/碰撞 |
| `test_b_rows_do_not_survive_switching_back_to_a` | B 行在 A 下不可见，切回 B 仍可见 |
| `test_legacy_unbound_rows_stay_disabled_after_round_trip` | 历史 NULL 行 A→B→A 后仍停用 |
| `test_collision_revision_gate` | 碰撞必须用当前 revision 重建；含合法标定证据 |

---

## 2. §B 版本激活一致性与存储

### 2.1 审计结论

| 组件 | 结论 |
| --- | --- |
| `SceneVersionService.activate` | 先写文件系统入口、后提交 DB 指针；DB 提交失败会**补偿**（回指旧版本），不会留下“DB 指向 B、入口仍服务 A”的危险状态 |
| `bridge_scene_origin` | 旧实现 `unlink + symlink` 存在瞬时 ENOENT 窗口，已改为**同目录临时链接 + `os.replace` + 目录 fsync** |
| `versions/<ver>` 链接 | 同样使用原子替换；真实目录（legacy/seed 布局）**永不删除或替换** |
| `verify_scene_origin_alias` | 要求相对链接 `versions/<ver>` 且版本目录存在 |
| `SceneAssetService` | 可信根包含场景自身 `published/<scene.id>`；越界/兄弟场景符号链接 → 404 |
| `publish_service._complete_edit_publication` | 发布完成时递增 `spatial.revision` |
| Nginx | `/_scene-origin/` 为 `internal`，仅接受 API 的 X-Accel-Redirect |

### 2.2 新增可重复检查器与安全自愈

`apps/api/app/services/version_consistency.py` +
`deploy/scripts/check_scene_version_consistency.py`：

- 默认**只读**（退出码 0=一致 / 2=存在不一致 / 1=检查器无法运行）；
- 检查：版本行、物理目录、入口文件、manifest 身份（`assetVersion`/`format`）、
  `current` 别名、`versions/<ver>` 链接、残留临时链接；
- `--repair` **只重指可变别名**；版本目录/入口缺失时拒绝并标记
  `manual_intervention_required`；**绝不删除、覆盖不可变版本**。

### 2.3 用例（7 个）

`apps/api/tests/test_gsnext12_version_consistency.py`：

- 100 次切换 + 并发读者：**从不出现别名缺失**（原子替换）；
- bridge 失败：返回 503，DB 指针与别名均不变；
- DB 提交失败：补偿别名；
- 一致场景 `ok`；损坏别名可检测并安全修复（不可变字节不变）；
- 版本目录缺失时**拒绝修复**；默认 `check_scenes` 只读。

### 2.4 真实数据演练（隔离库，只读 + 一次安全自愈）

对隔离库 7397 个场景运行检查器：

- 322 个完全一致；主要问题为开发库历史场景缺少 scene-origin 目录（6799）与版本目录（6798）、
  276 个 PUBLISHED 场景没有 current 版本（历史遗留），以及 **2 个别名形态问题**；
- `fix02-semantics`：`current` 是**绝对路径**符号链接（旧代码产物）→ 自愈后变为
  相对链接 `versions/f2f055c5bd87`，复查 `ok: true`；
- `gsnext10-recovery`：`current` 是**真实目录**（legacy 布局）→ 修复**拒绝删除真实目录**，
  返回 `alias_repair_failed` 并保持原状。这正是“安全自愈”的预期行为。

> 说明：检查器报告的是开发库的真实历史状态，不是本轮改动造成的回归；生产首检应以
> 发布库为准，运行 `check_scene_version_consistency.py --limit N` 先采样再全量。

---

## 3. §C 宿主机审计与部署准备

### 3.1 真实主机（只读审计）

| 项 | 实测 |
| --- | --- |
| OS / 内核 | Ubuntu 24.04.4 LTS / Linux 6.17.0-40-generic |
| 当前用户 | `test` (uid 1000)，属组含 `sudo`，但 **`sudo` 需要密码（无免密 root）** |
| Nginx | `/home/test/bin/nginx` 是 **容器包装脚本**（输出 docker entrypoint），并非宿主机二进制；**无 `/etc/nginx`** |
| systemd | systemd 255；宿主机未安装任何 `gsplatform*` 单元 |
| PostgreSQL | 共享 `gofast-postgres` 容器（16-alpine，`0.0.0.0:5432`）；本轮仅使用隔离库 |
| Redis | 隔离 `gsplatform-vr00-redis-20261011`（`127.0.0.1:16384`） |
| GPU | 2 × NVIDIA RTX A6000（49140 MiB）；未占用/未终止其他用户任务 |
| 磁盘 | `/` 1.9T，已用 70%，可用 538G |
| 证书 / DNS | **无 `/etc/letsencrypt/live`；无可用域名解析** |
| 端口 | 审计时 80/443 无监听；仅开发端口 8001/5173/5199/18099 等绑定 127.0.0.1 |

### 3.2 交付的部署模板（已写入仓库）

- `deploy/systemd/gsplatform-api.service`
- `deploy/systemd/gsplatform-celery-cpu.service`（`-Q cpu`）
- `deploy/systemd/gsplatform-celery-gpu.service`（`-Q gpu`）
- `deploy/systemd/gsplatform-celery-publish.service`（**新增**，`-Q gsplatform`，
  承载 `tasks.publish_scene` / `cleanup_expired_uploads`）
- `deploy/systemd/gsplatform-cleanup.{service,timer}`
- `deploy/env/production.env.example`（新增 `CELERY_PUBLISH_CONCURRENCY=1` 及理由）
- `deploy/nginx/gsplatform.conf` + `proxy-params.conf` + `scenes-streaming.conf`
- `deploy/scripts/preflight.sh`、`deploy_release.sh`、`rollback.sh`、`backup.sh`、
  `restore_drill.sh`、`check_nginx_site.sh`、`check_scene_version_consistency.py`

### 3.3 `preflight.sh` 实跑（隔离环境，host 模式）

```
[A] Host & filesystem          8 passed
[B] PostgreSQL                 pg_isready 不存在 → 跳过（非生产非阻塞）
[C] Redis                      redis-cli 不存在 → 跳过
[D] Production configuration   ✓ 策略仅在生产强制执行
[E] NVIDIA                     2 devices
RESULT: PASS — 8 passed, 0 failed, 11 warnings
```

警告均为预期：`/opt/gsplatform`、`/srv/gsplatform-data` 尚未创建；无 `/etc/gsplatform/env`；
无宿主 `pg_isready/redis-cli`。**这些是“尚未部署”而不是“检查失败”。**

### 3.4 外部前提（BLOCKED）

要完成真正部署，用户必须提供：

1. 一个可控域名及 DNS A/AAAA 记录（当前无解析）；
2. 宿主机 root / 免密 sudo（当前 `sudo` 需密码）；
3. HTTPS 证书签发权限（certbot / ACME 或已有证书）；
4. 生产数据库、Redis、对象存储/磁盘的最终凭据与路径；
5. PICO 真机（WebXR）。

在此之前，本报告只能声明“配置已生成、隔离环境已验证”，**不能声明生产已部署**。

---

## 4. §D Nginx / HTTPS 行为验证

### 4.1 验证方式

把**发布版** `deploy/nginx/gsplatform.conf` 渲染到一次性前缀（自签
`localhost.test` 证书、真实 Web dist、真实 streamed SOG origin），用
`nginx:alpine`（1.31.6）以 443/80 运行，后端为 **生产模式** API
`127.0.0.1:18002`（`GS_ENV=production`，因此走 X-Accel-Redirect）。
这不是公网部署，但请求路径与配置是发布版本身。

### 4.2 实测结果

| 检查 | 请求 | 结果 |
| --- | --- | --- |
| SPA | `GET /`、`GET /works` | 200 `text/html` |
| Viewer | `GET /scene/gsnext11-versions` | 200 |
| XR | `GET /xr/gsnext11-versions` | 200 |
| FastAPI | `GET /health/ready` | 200 JSON |
| 大资产 Range | `Range: bytes=0-31` on `lod-meta.json` | **206**，32 字节，`Content-Range: bytes 0-31/476` |
| 真实 LOD chunk Range | `Range: bytes=0-63` on `0_0/means_l.webp` | **206**，64 字节，`bytes 0-63/754` |
| 越界 Range | `bytes=999999-1000000` | **416** |
| X-Accel 私有入口 | `GET /_scene-origin/...` 直连 | **404**（`internal`） |
| 私有场景匿名 | `GET /api/v1/scenes/<private>/assets/...` | **401**；runtime 401 |
| 上传方法穿透 | `HEAD /api/v1/uploads/x`、`PATCH`、`POST` | 401（**未被 Nginx 405**） |
| 上传体积/超时 | `client_max_body_size 6g`、`client_body_timeout 300s` | 生效配置已确认 |
| 安全头 | 文档/SPA 响应 | HSTS、nosniff、X-Frame DENY、Referrer-Policy、CSP、Permissions-Policy 全部存在 |
| 安全头（资产） | X-Accel 二进制响应 | 修复后 **HSTS + nosniff 存在**（见 §4.3） |
| CORS | `OPTIONS`（`Origin: https://localhost.test`） | 200，`ACAO` 正确；未授权 Origin 不回 `ACAO` |
| `/local-scenes` | 任意子路径 | 修复后 **404**（见 §4.3） |
| 禁止命名空间 | `/.env`、`/.git/config`、`/staging/*`、`/logs/*` | 404 |
| HTTP→HTTPS | `http://.../works` | 301 |
| 站点文件语法 | `nginx -t`（隔离前缀） | **syntax ok / test successful** |

### 4.3 审计中发现并修复的两个真实缺口

1. **`/local-scenes` 由 SPA fallback 返回 200**：虽然没有泄漏资产（返回 index.html），
   但“可达”本身就是误导，且违反“开发路径不得对外可达”。已在发布版配置中显式
   `location /local-scenes/ { return 404; }`。
2. **X-Accel 资产响应丢失安全头**：Nginx 的 `add_header` 一旦在 location 内出现就
   **不再继承** server 级列表，导致二进制资产没有 HSTS/nosniff。已在
   `scenes-streaming.conf` 内补齐 HSTS 与 `X-Content-Type-Options: nosniff`。

### 4.4 未验证 / 不可声称

- **未签发真实证书、未对公网开放 80/443、未做真实域名 HTTPS 访问**；
- 未验证 ACME 自动续期（需要合法域名与 root）；
- 未做 5GB 级真实上传（只验证了方法穿透与配置值）；大文件断点续传的行为由既有
  API 测试覆盖。

---

## 5. §E systemd 稳定运行

### 5.1 单元审计

| 单元 | 队列 | 依赖 | 关键属性 |
| --- | --- | --- | --- |
| `gsplatform-api` | — | PG / Redis / 存储挂载 | `Restart=on-failure`、`KillSignal=SIGTERM`、`TimeoutStopSec=120`、`ProtectSystem=full`、`PrivateTmp`、`NoNewPrivileges` |
| `gsplatform-celery-cpu` | `cpu` | Redis、API | `--max-tasks-per-child=100`、`TimeoutStopSec=3600` |
| `gsplatform-celery-gpu` | `gpu` | Redis、API | `--concurrency=${CELERY_GPU_CONCURRENCY}`、`max-tasks-per-child=10` |
| `gsplatform-celery-publish` | `gsplatform` | Redis、API | 发布/清理队列；`--without-gossip --without-mingle` |
| `gsplatform-cleanup.timer` | — | — | 每 6 小时触发 cleanup |

队列路由与 `workers/celery_app.py` 的 `task_routes` 一致：
`publish_scene` / `cleanup_expired_uploads` → `gsplatform`，`build_collision` →
`cpu`，`reconstruct_train` → `gpu`。

`systemd-analyze verify`：把 ExecStart 指向宿主机真实二进制后**无任何告警**；
对未安装的 release 路径则只报告预期的 “ExecStart not executable”（不是单元语义错误）。

### 5.2 运行时行为探针（隔离 user manager，不影响宿主机服务）

用 transient user unit 复刻发布单元的关键属性（`Restart=on-failure`、
`WorkingDirectory`、环境变量、SIGTERM 处理）：

- 第 1 次运行 `exit 1` → systemd **自动重启**（`NRestarts=1`，`ActiveState=active`）；
- 第 2 次运行读到正确的 `cwd` 与 `GS_PROBE=ok`；
- `systemctl --user stop` → 进程收到 **SIGTERM** 并优雅退出（trap 记录）。

### 5.3 未验证（如实声明）

- **未把单元安装到宿主机**，未以真实 `gsplatform` 用户启动 API/CPU/GPU/Publish；
- **未做整机重启恢复**（任务书允许在不可安全重启时使用受控隔离环境并明确说明；
  本机承载其他用户任务，因此没有重启）；
- 未验证 Redis/PG 断连后的真实重连行为（只有单元层 `After=`/重启策略）。

---

## 6. §F 备份与恢复演练（隔离副本）

### 6.1 备份脚本缺陷修复

`deploy/scripts/backup.sh` 在 `set -u` 下第 164 行先使用 `BACKUP_KEEP_N`、后赋值，
导致保留策略步骤报 `unbound variable`。已把默认值赋值移到使用之前；重跑备份
完整结束（退出 0）。

### 6.2 备份实测（隔离库 + 开发存储）

```
[1] pg_dump → 4.2M，AES-256-CBC（pbkdf2）加密，sha256 校验
[2] published assets → 344K（tar.zst）
[3] config snapshot → 无 /etc/gsplatform，按预期跳过
[4] backup-manifest.json 写入
[5] 未配置 BACKUP_PUSH_CMD → 本地备份（已在 runbook 说明 off-host 配置）
[6] retention: keep 14 days ✓
```

### 6.3 恢复演练（严格隔离）

- 目标：**全新临时 PostgreSQL 16 容器**（`127.0.0.1:55433`，空库 drilldb），
  与共享 PG 完全隔离；
- 解密后 `pg_restore --no-owner --no-privileges --exit-on-error`：**3.1s**；
- 校验：

| 项 | 源库 | 恢复库 |
| --- | --- | --- |
| `alembic_version` | `d4f5a6b7c8d9` | `d4f5a6b7c8d9` |
| public 表数 | 18 | 18 |
| `scenes` | 7670 | 7670 |
| `scene_versions` | 8500 | 8500 |
| `users` | 3345 | 3345 |
| `scene_spatial_states` | 866 | 866 |

- 发布资产：解包后 **156 个文件**；与源 `published/` 逐文件 SHA-256 清单
  **完全一致（PUBLISHED_ASSETS_BYTE_IDENTICAL）**；
- 一致性检查器对“恢复库 + 恢复资产”运行：7397 个场景均可检查，无异常崩溃
  （问题分布与源库一致，源于开发库历史场景缺目录，而非恢复损坏）。

### 6.4 未做

- 未在生产库执行恢复（任务书禁止破坏性演练作用于历史数据）；
- 未演练 certbot/nginx 配置回滚与 release previous 切换的真实主机操作
  （已在 runbook 中给出步骤与回滚点）。

---

## 7. §G 回归矩阵

| 套件 | 结果 |
| --- | --- |
| 新增 GS-NEXT-12 后端 | **13 passed**（6 空间重绑定 + 7 一致性） |
| GS-NEXT-11 后端 | 28 passed（此前基线） |
| 后端全量 pytest | <!--FULL_API--> |
| Worker pytest | **189 passed / 1 skipped**（272.71s） |
| ruff / mypy | <!--LINT--> |
| 前端 typecheck / lint / vitest / build | typecheck ✓、lint ✓、vitest **385 passed / 38 files**、build ✓ |
| E2E GS-NEXT-12 空间重绑定 | **1 passed** |
| E2E GS-NEXT-10 恢复链路 | <!--E2E10--> |
| E2E GS-NEXT-11 版本管理 | <!--E2E11--> |
| E2E 初始相机 / 观察点 | <!--E2E0203--> |
| Nginx 站点文件 | `nginx -t` syntax ok / test successful |
| Nginx 实际 HTTP 行为 | §4.2 全部通过（隔离临时栈） |

### 7.1 GS-NEXT-11 遗留的 5 个后端失败

| 失败 | 本轮状态 |
| --- | --- |
| `test_fix0621.py::TestReleasePreflightCwd` ×4 | 根因是本机 `nginx` 是容器包装脚本且无 `/etc/nginx/nginx.conf`。本轮 `preflight.sh` 在无主配置时**降级为隔离前缀校验发布站点文件**，预期这 4 个用例转绿（提交后复跑验证，见 §7.2） |
| `test_editor_publication.py::test_export_retention_preserves_current_and_history` | 已知高负载环境抖动（`.limit(100)` 取不到本轮行）；单独运行通过，本轮未改该模块 |

**没有通过 SKIP 或放宽断言来制造绿色。**

<!--SECTION_7_2-->

---

## 8. 变更清单

### 8.1 新增

- `apps/api/app/services/spatial_binding.py` —— 逐特性版本绑定
- `apps/api/app/services/version_consistency.py` —— 一致性检查/安全自愈
- `apps/api/migrations/versions/d4f5a6b7c8d9_gsnext12_spatial_confirmations.py`
- `apps/api/tests/test_gsnext12_spatial_rebinding.py`（6）
- `apps/api/tests/test_gsnext12_version_consistency.py`（7）
- `apps/web/e2e/gsnext12-spatial-reauthor.spec.ts`
- `deploy/scripts/check_nginx_site.sh`
- `deploy/scripts/check_scene_version_consistency.py`
- `deploy/systemd/gsplatform-celery-publish.service`

### 8.2 修改

- 模型/迁移兼容：`scene_spatial_state.py`、`scene_presentation.py`、
  `scene_viewpoint.py`、`scene_annotation.py`
- 运行时/服务：`scene_runtime.py`、`authoring.py`、`scene_versions.py`、
  `publish_service.py`（原子链接）、`collision.py`（revision）
- API Schema：`schemas/scene_version.py`（revision / pending / confirmed）
- 前端：`VersionPanel.tsx`（逐项待确认/已确认）、`versionApi.ts`、对应单测
- 部署：`preflight.sh`（`--nginx-conf`、无主配置降级）、`deploy_release.sh`、
  `rollback.sh`、`backup.sh`（保留策略变量顺序）、`production.env.example`、
  CPU/GPU 单元注释修正、`deploy/nginx/gsplatform.conf`（`/local-scenes` 404）、
  `deploy/nginx/scenes-streaming.conf`（资产安全头）

---

## 9. 上线前仍需用户提供 / 执行

1. **域名 + DNS**（A/AAAA 指向该主机）；
2. **root 或免密 sudo**（安装 systemd 单元、写 `/etc/nginx`、`/opt/gsplatform`、
   `/srv/gsplatform-data`、`/etc/gsplatform/env`）；
3. **证书**：`certbot --nginx -d <domain>` 或提供证书文件；`certbot.timer` 续期验证；
4. **生产 PG/Redis/存储凭据**，并执行一次：
   - `preflight.sh --environment production --mode host`
   - `alembic upgrade head`（先 `alembic current`/`heads` 对齐）
   - `check_scene_version_consistency.py --limit 200`（只读）→ 再全量
   - `backup.sh --environment production` → 在隔离副本 `restore_drill.sh`
5. **PICO 真机**：加载 `/xr/<slug>`，验证沉浸式会话、初始相机与观察点；
6. **正式切流**：由用户在维护窗口执行 `deploy_release.sh`，本报告不代为切流。

---

## 10. 明确未做 / 不可声称

- ❌ 未部署生产、未开启公网 443、未签发真实证书；
- ❌ 未做宿主机整机重启与真实多 worker 长稳；
- ❌ 未在 PICO 真机验证 WebXR；
- ❌ 未对历史 13M Gaussian 资产做任何修改或破坏性恢复；
- ❌ 未删除任何不可变 SceneVersion；未使用 `kill -9`、未清空 Redis 队列；
- ❌ 未把全局 `SceneSpatialState` 翻成 VALID 来“掩盖”问题；
- ❌ 未修改共享服务（gofast-postgres / redis / milvus 等）。

---

## 11. 复现命令（节选）

```bash
# 新增后端用例（隔离库）
cd apps/api
GS_DATABASE_URL='postgresql+psycopg2://gsplatform_vr00_20261011:***@127.0.0.1:5432/gsplatform_vr00_tests_20261011' \
  .venv/bin/python -m pytest tests/test_gsnext12_spatial_rebinding.py \
  tests/test_gsnext12_version_consistency.py -q

# 空间重绑定真实浏览器 E2E
cd apps/web
npx playwright test e2e/gsnext12-spatial-reauthor.spec.ts --workers=1 --reporter=line

# 版本一致性（只读 / 安全自愈）
PYTHONPATH=apps/api apps/api/.venv/bin/python \
  deploy/scripts/check_scene_version_consistency.py --json
PYTHONPATH=apps/api apps/api/.venv/bin/python \
  deploy/scripts/check_scene_version_consistency.py --scene <slug> --repair --json

# 发布版 Nginx 站点文件
bash deploy/scripts/check_nginx_site.sh deploy/nginx/gsplatform.conf

# 隔离备份 + 恢复
BACKUP_ROOT=/tmp/... BACKUP_KEYFILE=/tmp/... bash deploy/scripts/backup.sh --environment staging
bash deploy/scripts/restore_drill.sh --backup <dir> --restore-db <isolated_db>
```
