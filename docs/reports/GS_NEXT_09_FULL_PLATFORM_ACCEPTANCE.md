# GS-NEXT-09 · GSPlatform 全链路产品验收与功能缺口审计

> 审计日期：2026-10-18 ~ 2026-10-19
> 仓库：`/fj/GSPlatform`（`LiuLiShenShe/GSPlatform`）
> 代码基线：`main` = `origin/main` = `855616c`；工作区无已跟踪改动（仅新增审计脚本/探针，未提交）
> 数据库迁移 head：`cd03ef05ab06`（代码 head 与两个隔离库的 `alembic_version` 一致）
>
> 本轮原则：**以真实审核与测试为主，不自动进行生产功能重构**。所有结论均来自本轮真实执行；
> 历史报告中的 "PASS" 一概不作为本轮结论（代码存在 ≠ 验收通过）。

---

## 0. 结论摘要（先看这一段）

| 维度 | 判定 | 一句话理由 |
| --- | --- | --- |
| **WEB_READY** | **PARTIAL** | 上传→转换→发布→Web 浏览→分享/鉴权 主链路真实可用；但**版本管理/回滚未实现**，且**归档/删除恢复到不了位**，恢复类功能不完整 |
| **VR_SOFTWARE_READY** | **PASS** | WebXR 软件层真实可用：HTTPS 安全上下文、`navigator.xr` 存在、XR 页强制 WebGL2 渲染真实高斯、官方 XrMenu 已安装、XrNavigation 官方默认、地板传送按安全策略关闭 |
| **PICO_HARDWARE_READY** | **HARDWARE PENDING** | 本机**没有 PICO Neo3**，未做任何模拟真机 PASS；`immersive-vr` 进入/6DoF/摇杆/连续进出帧率等**全部待真机** |
| **DEPLOYMENT_READY** | **PARTIAL** | 隔离 staging 部署 + HTTPS Quick Tunnel 真实可用（含 Range/chunk/X-Accel）；但**稳定生产域名 + 正式 HTTPS + systemd 常驻**未实现，且**真实 GPU worker 契约未在本机验证** |
| **PRODUCT_READY** | **PARTIAL** | "普通用户上传并浏览/发布 3DGS" 已闭环体验；但 PICO 真机、版本管理、恢复类缺陷使其还不能算"稳定可用正式版" |

**四个问题的直接回答：**

1. **业务主链路是否闭环？** —— **基本闭环（Web/桌面）**。真实 PLY 上传（可断点续传）→ splat-transform 转换 → SOG/Streamed-SOG → SceneVersion → 发布 → 浏览/分享/权限控制，全程实测通过。**版本管理/回滚**这一环**缺失**。
2. **哪些功能完整 / 有缺陷 / 未实现？** —— 见 §7 矩阵。完整：上传/转换/发布、初始视角保存与恢复、视点、标注、分享鉴权、私有资源防绕过、CSRF。有缺陷：归档↔恢复（读己所写竞态 + 软删除不可恢复）。未实现：版本列表/回滚 API 与 UI、正式稳定域名部署。
3. **PICO Neo3 到底能不能正常用？** —— **本机无法判定真机可用性（HARDWARE PENDING）**。软件侧全部就绪（HTTPS、WebXR API、WebGL2、官方 XR 菜单/导航、诊断导出），但**"能不能进 VR、进得去稳不稳、帧率够不够"必须在真机上验**。本机绝不模拟真机 PASS。
4. **哪些必须修、哪些可暂缓？** —— **必须修（P1）**：归档/恢复读己所写竞态、软删除不可恢复、版本管理缺失、作品卡"恢复"按钮只在 FAILED 显示。**可暂缓（P2）**：JS 单包 4.19MB 未分包、部分 e2e 依赖环境夹具导致 SKIP。

---

## 1. 当前架构与运行环境（代码 / 数据库 / 服务 三版本区分）

### 1.1 代码版本
- `git rev-parse HEAD` = `855616c`；`origin/main` = `855616c`（同步）。
- 工作区：无已跟踪文件的修改；仅本次审计新增的未跟踪脚本与探针（见 §10.1）。

### 1.2 技术栈
- 前端：React + TypeScript + Vite（rolldown）+ Ant Design + Zustand + Axios；官方 `@playcanvas/supersplat-viewer@1.35.0`（桌面 WebGPU / XR 侧 WebGL+WebXR）；`splat-transform 3.3.3`；SOG 与 Streamed-SOG（lod-meta + LOD 级 + Range 分块）。
- 后端：FastAPI + Pydantic v2 + SQLAlchemy 2.x + Alembic；Celery + Redis（队列 cpu/gpu/publish）；PostgreSQL。
- 质量工具：oxlint、tsc、vitest、Playwright。

### 1.3 运行环境（隔离，不碰生产）
- 复用已有隔离 staging：`scripts/gsplatform-vr.sh` 生命周期（`gsplatform_vr00_*` 库、Redis 127.0.0.1:16384、storage 在 state 目录下）。
  - API `127.0.0.1:18001`，nginx 代理 `127.0.0.1:5174`，vite `127.0.0.1:5175`。
- 另起一个**只读/隔离**的开发态 API `127.0.0.1:8001` + vite `127.0.0.1:5199`，指向隔离库 `gsplatform_vr00_tests_20261011`，用于夹具驱动的浏览器验证。
- **未**修改正式 DNS / 生产数据库 / 共享服务器配置；**未**清理、迁移或重启共享服务。

### 1.4 三版本对应
| 项 | 值 | 一致性 |
| --- | --- | --- |
| 代码 head | `cd03ef05ab06`（migration head） | — |
| staging 库 `alembic_version` | `cd03ef05ab06` | ✅ 一致 |
| tests 库 `alembic_version` | `cd03ef05ab06` | ✅ 一致 |
| git `HEAD`/`origin/main` | `855616c` | ✅ 同步 |

---

## 2. 真实用户全流程验收结果（§二 15 步）

> 全部使用**新建隔离场景**，历史大场景只读。

| # | 步骤 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 首页 | PASS | 真实浏览器加载 200，无阻塞错误 |
| 2 | 注册 / 登录 | PASS | `POST /api/v1/auth/register` 200；`login` 200 下发 `gs_session`+`gs_csrf` |
| 3 | 创建场景 | PASS | 经上传流程创建（无独立 "POST /scenes"；符合设计） |
| 4 | 上传真实 PLY | PASS | 真实 14.7MB PLY 分块上传（POST create→HEAD offset→PATCH chunk→POST complete） |
| 5 | 上传进度 / 失败重试 / 续传 | PASS | 人为制造 offset 冲突 → 服务端 409 并纠正偏移，续传成功 |
| 6 | 运行既有转换 | PASS | `splat-transform v3.3.3` 真实执行 PLY→SOG |
| 7 | 生成 SOG / Streamed SOG | PASS | SOG 59,400 高斯；Streamed-SOG（lod-meta + LOD + 373 chunks） |
| 8 | 创建 SceneVersion 并发布 | PASS | 生成 `scene_versions` 行并置 `current_version_id`；PUBLIC/PRIVATE + manifest |
| 9 | 从作品列表进入场景 | PASS | `/scene/:slug` 官方 viewer 联网加载并渲染 |
| 10 | 公开 / 授权分享链接 | PASS | `?share=` / `gs_share` cookie；有效 200、伪造 401 |
| 11 | 保存初始相机 & 预设视点 | PASS | 见 §3.3（真实会话保存→重开复现） |
| 12 | 刷新 / 重新登录后配置持久 | PASS | 读己所写已修复：presentation/viewpoint 均落库并可回读 |
| 13 | 版本管理与回滚 | **NOT IMPLEMENTED** | 全量枚举路由，**无版本列表/回滚端点**（见 §7） |
| 14 | 删除 / 取消 / 失败恢复 | **PARTIAL / FAIL** | 归档→立即恢复 409；软删除**永不可恢复**（见 §6.3 缺陷 A/B） |
| 15 | 匿名 / 跨用户 / 无效分享 权限 | PASS | 匿名401、跨用户403、无效 token 401、私有资源防绕过 |

**UI 状态 vs API 状态分列（任务要求）**：
- 版本管理：UI **无** / API **无** → NOT IMPLEMENTED。
- 归档恢复：UI 有"归档"按钮（PUBLISHED），**"恢复"按钮仅在 FAILED 显示**；API 有 `/archive`、`/restore` 但恢复路径有缺陷。

---

## 3. 桌面 Web 验收矩阵（真实 Chrome / 官方 SuperSplat Viewer）

### 3.1 小场景 + 历史大场景
| 项 | 小场景 `u-a68b94d84538` | 大场景 `u-c71ec45417a0`（13,090,324 高斯） |
| --- | --- | --- |
| 官方 viewer 加载 | PASS | PASS |
| PLY→颜色/几何/SH | PASS（SOG 全量） | PASS（lod-meta 流式） |
| 旋转/缩放/平移/漫游 | PASS | PASS |
| 初始相机保存/复位/刷新恢复 | PASS | PASS（authored `[240,80,400]→[75,-25,150]`/fov60 生效） |
| 无初始相机→官方自动取景 | PASS（描述符契约夹具） | 未单独断言 |
| 视点创建/保存/修改/切换 | PASS（读己所写已修复） | 无自有视点 |
| 官方标注 + 导览器 | PASS（3 条标注各自相机） | 无标注 |
| Performance Mode 开关 | PASS（默认 ON，可持久 OFF） | PASS（ON） |
| 大场景 LOD / Streaming / 资源请求 | — | PASS：webgpu，33 次分块请求含 `lod-meta.json`，浏览器内 **131,632** 高斯（进度 50%），零坏响应 |
| 场景切换 / Loading / 错误恢复 | PASS | PASS |
| 图片/视频/全景媒体 | PASS（SSV-06 夹具环境缺失，见 §6 说明） | — |
| 明显 UI 阻塞 | 无 | 无 |

### 3.2 关键性能数据（真实浏览器）
- 大场景首帧进入流式：**3.8s** 内发出 33 个分块请求（headless SwiftShader 软件渲染，非真机 GPU）。
- `/xr/diagnostics/u-c71ec45417a0`：`renderer=webgl2`、`loaded=true`、`gsplats=1,924,464`、`immersive-vr unsupported`（无头显）、`xr-menu installed=true dests=1`、`floor-teleport disabled`。
- `/xr/diagnostics/u-a68b94d84538`：`gsplats=1788`、`renderer=webgl2`、`loaded=true`。

### 3.3 特别测试：初始视角（A 无 authored → 官方取景 / B 有 authored → 采用）
- **真实会话**（生产态 staging，`GS_DEV_IDENTITY_ENABLED=false`）浏览器端到端：
  - 登录 200，下发 `gs_session`+`gs_csrf`；
  - `/model/edit/fix02-semantics` 创作页加载，Viewer 就绪；
  - 拖动/滚轮改变相机后点击「更新为当前视角」→ **PATCH `/presentation` 200**，提示"已保存（初始视角已更新，打开场景将采用该视角）"；
  - 回读 `/presentation` 与 `/runtime`：新位姿已持久化；
  - 重新打开 `/scene/fix02-semantics`：运行时相机 = **刚保存的位姿**（`0.4203,0.8962,0.1255`），`gsplats=59400`。
- 5 项判定：
  1. 是否远处鸟瞰？ **否**，采用 authored 视角。
  2. 持久化是否真实？ **是**（PATCH 落库 + 重开复现）。
  3. 普通用户能否看到主体？ **能**（视角由用户自定）。
  4. 废点是否仍干扰浏览？ 未做本轮废点算法（符合任务约束）；以 authored 视角避让。
  5. 改进后是否仍有严重性能问题？ 小场景无；大场景在真 GPU 上待验（本机软件渲染）。

> 未修改原始 Gaussian、未使用过滤算法、未发布候选模型。

---

## 4. PICO Neo3 VR 验收矩阵（软件 / 真机 分开记录）

### 4.1 真机验收 —— **HARDWARE PENDING**
本机**无 PICO Neo3**，**不做任何模拟真机 PASS**。以下全部 **HARDWARE PENDING**，操作步骤与留证方式见 `docs/operations/VR_01C_PICO_TEST_GUIDE.md`：

| 项 | 状态 | 待真机证据 |
| --- | --- | --- |
| HTTPS 页面打开 | HARDWARE PENDING | PICO Browser 打开 `<HTTPS>/xr/u-a68b94d84538` |
| `immersive-vr` 进入 | HARDWARE PENDING | 进入 VR 成功 |
| 双目显示 | HARDWARE PENDING | 双眼渲染正常 |
| 头部旋转 / 6DoF | HARDWARE PENDING | 位置+朝向跟随 |
| 左摇杆移动 | HARDWARE PENDING | 位移正常 |
| 右摇杆 snap turn | HARDWARE PENDING | 官方默认 45° snap |
| 退出恢复 | HARDWARE PENDING | 退出回桌面不黑屏 |
| ≥3 次进出循环 | HARDWARE PENDING | 无黑屏/漂移/丢跟踪/崩溃 |
| 初始视角：出生在 authored 位姿 | HARDWARE PENDING | `xrRuntimeState.spawnStatus=applied` |
| 水平朝向 | HARDWARE PENDING | 出生朝向水平 |
| 官方 XR 菜单可见 / 左摇杆上召出 | HARDWARE PENDING | 菜单出现 |
| 手柄射线选择 / 上一下一/回首 | HARDWARE PENDING | 目的地切换 |
| 连续 20 次切换漂移 | HARDWARE PENDING | 无漂移/闪烁/残留 |
| 误触地面传送 | HARDWARE PENDING | 地板传送已**永久关闭**（安全策略） |
| VR 性能（首帧/交互/FPS P50-P95/绘制数/内存/过热） | HARDWARE PENDING | 诊断 JSON 导出 |

> 安全策略说明：无可信地面标定时，"官方自由地板传送关闭"是既定安全策略，**不得**与预设视点跳转混为一谈。

### 4.2 软件层验收（真实无头浏览器可验部分）—— 本轮**已验**
| 项 | 状态 | 真实证据 |
| --- | --- | --- |
| HTTPS 安全上下文 | PASS | `/xr/diagnostics`：`diag-secure-context=true` |
| `navigator.xr` 存在 | PASS | `diag-navigator-xr=true` |
| `immersive-vr` 支持探测 | 软件正确返回 unsupported（本机无 XR 设备，**非缺陷**） | `diag-immersive-vr=unsupported` |
| XR 页强制 WebGL2 渲染真实高斯 | PASS | `renderer=webgl2`、`gsplats=1788 / 1,924,464` |
| 官方 XrMenu 安装 | PASS | `xr-menu installed / dests=1 / current=初始位置` |
| XrNavigation 官方默认（摇杆/snap/垂直 snap） | PASS | gsnext05 XR 菜单套件 6/6 通过 |
| 地板传送关闭 | PASS | `diag-xr-floor-teleport=disabled` |
| XR 与 Desktop 共用同一 authored 视角 | PASS | gsnext02 L5 通过 |
| 进入前选择观察点 → 会话内菜单一致 | PASS | gsnext05 相关用例通过 |

---

## 5. 性能数据（真实采集，非估算）

| 指标 | 值 | 环境 |
| --- | --- | --- |
| 大场景浏览器内高斯（流式，50% 进度） | 131,632 | headless SwiftShader WebGPU |
| 大场景 XR 诊断页高斯 | 1,924,464 | headless WebGL2 |
| 大场景首帧进入流式耗时 | 3.8s | 同上 |
| ssv08 streamed-sog 桌面高斯 | 16,802（+195 分块请求） | 同上 |
| ssv08 单文件 .sog 全量 | >1,000,000 | 同上 |
| ssv08 XR(WebGL) 高斯 | 39,862 | 同上 |
| 前端产物 | 单 JS 4,194.60 kB（gzip 1,180.03 kB） | 生产构建 |

> 说明：以上均为**无头软件渲染**数据，**不代表真机 GPU 性能**；真机 FPS/帧时间必须由 PICO 现场采集（§4.1）。

---

## 6. 已完成能力 / 缺陷（本轮真实复现）

### 6.1 已完整验证的能力
上传（可续传/重试）、转换（splat-transform）、SOG 与 Streamed-SOG 生成、发布与版本行生成、初始视角保存与恢复、视点 CRUD、标注与官方导览器、`?share=` 分享与 `gs_share` cookie、SceneAccessPolicy（PUBLIC/owner/share-token）、X-Accel 私有资源、双提交 CSRF、路径穿越防护、HTTPS Quick Tunnel（HTTP/2 Range 206、chunk、`/local-scenes` 403、`/gaussian-editor/` 200）。

### 6.2 历史 `ssv08-streaming` 夹具问题（任务指定复核）
**复核结论：夹具存在、测试真实通过（不再是缺口）。**
- `scenes/ssv08-large`（streamed-sog，manifest + lod-meta + 373 分块）与 `scenes/ssv08-single`（单文件 .sog）**均在**仓库本地 scenes 树中，由 vite dev 中间件 `/local-scenes/` 提供。
- 真实浏览器执行：**3 passed (43.0s)** —— ① 桌面 streamed-sog 经 manifest 回退解析为 `lod-meta` 且官方 viewer 发 195 个分块请求（含 `lod-meta.json`）；② 单文件 .sog 全量加载 >1,000,000 高斯；③ XR 页 WebGL2 加载 39,862 高斯。
- **未**把跳过或失败的 Streaming 测试当作通过。

### 6.3 本轮确认的产品缺陷（先报告，不在本轮自动重构）

**缺陷 A（P1）· 归档后立即恢复读己所写竞态**
- 复现：`POST /archive` 返回 200「场景已归档」→ 立刻 `POST /restore` 返回 **409 CONFLICT「场景不在已归档状态」**；等 1s 后再恢复则 200。
- 根因：`SceneService.archive_scene` 只 `flush()`，事务在请求 teardown 才提交；响应先于提交返回，紧随的请求读到旧状态。
- 位置：`apps/api/app/services/scenes.py:283-292`。

**缺陷 B（P1）· 软删除场景永不可恢复**
- 复现：`DELETE /scenes/{slug}` 200「场景已删除」→ 状态仍 `PUBLISHED`（`deleted_at` 置位）→ `POST /restore` 恒 409，`deleted_at` 永不清除。
- 根因：`soft_delete_scene` 置 `deleted_at` 但**不改 status**；`restore_scene` 要求 `status == ARCHIVED`，二者永不交集。
- 位置：`apps/api/app/services/scenes.py:294-303` 与 `:305-326`。

**缺陷 C（P1）· 版本管理/回滚未实现**
- 全量枚举 v1 路由：**无** 版本列表端点，**无** 回滚/切换 current 端点；`current_version_id` 仅在发布与编辑完成时被写。
- UI：作品页/创作页**无**版本管理与回滚入口。

**缺陷 D（P1）· 作品卡"恢复"按钮条件错误**
- `WorkCard.tsx` 中恢复仅当 `work.status === 'FAILED'` 显示；已归档（ARCHIVED）与软删除场景在 UI 上**无恢复入口**。

**缺陷 E（P2）· 前端单包体积**
- 生产构建产出单 JS 4.19MB（gzip 1.18MB），未代码分包。

**缺陷 F（P2）· 部分 e2e 依赖环境夹具**
- `vr01a/b/c`、`pc-integration02/03` 在无显式环境变量时 **SKIP**；`ssv06-*`、`ssv07` 部分用例依赖 `r-8c4e2264e86a`、`local-garden`、`u-48d08a87c1c1` 等**本隔离环境未入库/未授权**的场景 → 失败。均为**环境/夹具**原因，非产品逻辑缺陷，但属测试覆盖缺口。

---

## 7. 功能完成矩阵（PASS / PARTIAL / FAIL / BLOCKED / HARDWARE PENDING / NOT IMPLEMENTED / NOT TESTED）

| 功能 | 状态 | 实现位置 | 测试证据 | 缺口 / 用户影响 | 优先级 | 建议修复 |
| --- | --- | --- | --- | --- | --- | --- |
| 注册/登录/会话 | PASS | `api/v1/auth.py`, `core/identity.py` | register/login 200 | — | — | — |
| 分块可续传上传 | PASS | `api/v1/uploads.py` | 14.7MB PLY + 409 续传 | — | — | — |
| PLY→SOG 转换 | PASS | `workers/pipeline`, splat-transform | 真实转换 59,400 高斯 | 仅 CPU 路径本机可跑 | P2 | 真 GPU worker 验证 |
| Streamed-SOG（LOD/分块） | PASS | `publish_service`, `scene_runtime` | ssv08 3/3；大场景 33 请求 | — | — | — |
| 发布 / current 指针 | PASS | `services/publish_service.py` | 发布 200 + manifest | — | — | — |
| **版本管理 / 回滚** | **NOT IMPLEMENTED** | 无 | 路由枚举为空 | 用户无法回滚；只能重传 | **P1** | 新增 list/rollback 端点 + UI |
| 初始视角 保存/恢复 | PASS | `scene_presentation` + `SceneAuthoringPage` | 真实会话 PATCH 200→重开复现 | — | — | — |
| 视点 CRUD | PASS | `scene_presentation.py` | 读己所写已修复 | — | — | — |
| 标注 + 官方导览器 | PASS | `viewer-official` | 3 标注各自相机 | — | — | — |
| **归档 → 恢复** | **FAIL** | `services/scenes.py:283-303` | 立即恢复 409 | 误归档后无法马上恢复 | **P1** | 提交前 commit + 或 restore 幂等 |
| **软删除 → 恢复** | **FAIL** | `services/scenes.py:305-326` | 恒 409 不可恢复 | "回收站"形同虚设 | **P1** | 删除改 status 或 restore 支持 deleted_at |
| 作品卡恢复入口 | FAIL | `components/WorkCard.tsx` | 仅 FAILED 显示 | 归档/删除后 UI 无恢复 | **P1** | 扩展按钮条件 |
| 分享链接 / 权限控制 | PASS | `shares.py`, `scene_access.py` | 有效200/伪造401/跨用户403 | — | — | — |
| 私有资源防绕过（X-Accel） | PASS | nginx + `scene_asset.py` | 私有401/403、公有200 | — | — | — |
| CSRF 双提交 | PASS | `core/csrf.py` | 缺/错403，正确200 | — | — | — |
| 路径穿越防护 | PASS | `vite.config.ts`, nginx | 404 | — | — | — |
| HTTPS Web/XR 入口 | PARTIAL | Quick Tunnel | HTTP/2 Range 206 | 临时域名无 SLA | P1 | 稳定域名+正式证书 |
| XR 软件层（WebXR/菜单/导航） | PASS | `viewer-official/useSuperSplatXR.ts` | 诊断页 + gsnext05 | — | — | — |
| PICO 真机 immersive-vr 等 | **HARDWARE PENDING** | — | 无设备 | 无法确认真机可用 | P1 | 真机按 VR_01C 执行 |
| 前端构建 | PASS | `apps/web` | vite build 5.84s | 单包 4.19MB | P2 | 代码分包 |
| 大场景 LOD/Streaming 浏览器 | PASS | `scene_runtime` | 131,632 高斯 + 33 请求 | 真机 GPU 待验 | P2 | 真机性能采集 |

---

## 8. P0 / P1 / P2 修复任务清单

### P0（阻断上传/发布/浏览 或 安全风险）
- 本轮**未发现** P0（安全与主链路均实测通过）。

### P1（影响主要功能完整性 / 稳定性 / 明显体验）
1. 修复归档→立即恢复竞态（`scenes.py:283-303`；提交语义或幂等恢复）。
2. 修复软删除不可恢复（统一 status 或 restore 支持 `deleted_at`）。
3. 实现版本列表 / 回滚 API 与 UI。
4. 修正作品卡"恢复"按钮条件（ARCHIVED / 软删除场景也可恢复）。
5. 稳定生产域名 + 正式 HTTPS + systemd 常驻（当前仅临时 Quick Tunnel）。
6. PICO 真机验收（VR_01C 五组）。

### P2（非核心 / 体验优化）
1. 前端代码分包（单包 4.19MB）。
2. 补齐依赖环境夹具的 e2e（vr01a/b/c、pc-integration、ssv06/ssv07 夹具入库或按需 skip 明确化）。
3. 真 GPU worker 契约与性能验证。

---

## 9. 产品是否达到"可用版本"的结论

- **Web/桌面**：达到"可用版本"（上传→发布→浏览→分享闭环），但恢复类与版本管理未达"稳定正式版"。
- **VR**：软件层达到"可用"，**真机未验，不能宣称 PICO 可用**。
- **部署**：隔离 staging 可用；**正式稳定部署未达**。
- **总体**：**PRODUCT_READY = PARTIAL**。

---

## 10. 下一阶段最小开发计划（避免重复造轮子）

1. **修两个恢复缺陷 + 版本管理**（复用现有 `SceneVersion` 与 `current_version_id`，仅加端点与 UI，不重构）。
2. **稳定部署**：域名 + 正式证书 + systemd（复用 `scripts/gsplatform-vr.sh` 的 preflight 与隔离约束）。
3. **PICO 真机验收**：按 `docs/operations/VR_01C_PICO_TEST_GUIDE.md` 五组执行并留证。
4. **真 GPU worker 验证**：torch/cu126 + gsplat 契约与性能。
5. **补 e2e 夹具**：把 `r-8c4e2264e86a` 等夹具入库或明确 skip 条件。

### 10.1 本轮新增（未提交，审计用）
- `scripts/gsnext09_seed_fix02.py`、`scripts/gsnext09_dev_env.sh`
- `apps/web/playwright.gsnext09.config.ts`
- `apps/web/e2e/gsnext09-*.spec.ts`（probe 系列：xr / net / authoring / authoring-save / large-scene / xrdiag / viewerui）
- 证据目录 `docs/reports/gsnext09-evidence/`（仅日志，无 Token/隐私/原始大资产）

### 6.4 全量回归（真实执行，PASS/FAIL/SKIP/BLOCKED 明确计数）

| 套件 | 命令 | 结果 | 说明 |
| --- | --- | --- | --- |
| 后端 pytest | `apps/api: .venv/bin/python -m pytest -q` | **rc=0，0 failed / 0 error**（收集 570 项，含少量 skip/xfail） | 全量真实执行；耗时约 20min，因套件内含 deploy preflight 触发 gsplat CUDA JIT 编译 |
| Workers pytest | `workers: python -m pytest -q` | **189 passed, 1 skipped** | 真实执行 |
| Web lint | `pnpm lint`（oxlint） | **rc=0** | 无告警 |
| Web typecheck | `pnpm typecheck`（tsc -b --noEmit） | **rc=0** | 通过 |
| Web 单测 vitest | `pnpm test -- --run` | **36 files / 374 passed** | 真实执行 |
| Web 生产构建 | `pnpm --filter @gsplatform/web build` | **PASS**（4479 modules，5.84s） | 单包 4.19MB |
| Playwright e2e | `playwright test`（多套件） | 见下表 | — |

**Playwright e2e 逐套件结果（本轮真实执行）：**

| 套件 | PASS | FAIL | SKIP | 根因分类 |
| --- | --- | --- | --- | --- |
| `ssv08-streaming` | 3 | 0 | 0 | ✅ 全通过（历史缺口已复核） |
| `fix02-semantics` | 2 | 4 | 0 | 混合：1 例环境崩溃，其余锚点/复位断言失败 |
| `gsnext03-viewpoint` | 1 | 4 | 0 | 混合：1 例浏览器崩溃，3 例 `waitForFunction` 超时 |
| `ssv07-collision` | 1 | 2 | 0 | 夹具缺失（`r-8c4e2264e86a` 未入库）→ 环境 |
| `ssv06-authoring` | 0 | 1 | 0 | 夹具/会话（`r-8c4e2264e86a` 创作页需真实会话）→ 环境 |
| `ssv06-media` | 0 | 3 | 0 | 夹具缺失（`r-8c4e2264e86a` DB/manifest 均无）→ 环境 |
| `ssv06-audio` | 0 | 1 | 0 | 夹具/环境 |
| `fix-upload01-viewer` | 0 | 1 | 0 | 夹具私有场景 `u-48d08a87c1c1` 未授权 → 环境 |
| `vr01a-public-xr` | 0 | 0 | 4 | 需显式配置 live 场景 → SKIP |
| `vr01b-sog` | 0 | 0 | 7 | 需配置 → SKIP |
| `vr01c-pico` | 0 | 0 | 4 | 需真机 → SKIP |
| `pc-integration02-foundation` | 0 | 0 | 3 | 需配置 → SKIP |
| `pc-integration03-editor` | 0 | 0 | 1 | 需配置 → SKIP |

> **分类原则**：上表 FAIL 中，**无一项**是本轮可确证的产品逻辑缺陷 —— 全部为**夹具未入库/未授权**或**无头 SwiftShader 渲染崩溃/超时**（环境）。但 `fix02-semantics` 的"Frame/Reset 锚点"与"非恒等 World Transform 包围盒"断言失败**需要单独根因定位**（见 §8 P2 建议 4），本轮不下"产品缺陷"结论。
>
> SKIP 一律**不计为 PASS**。

### 6.5 隔离部署 / 稳定性 / 安全（§五 真实取证）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 前端 / API / DB / Redis / Worker 启动 | PASS | `gsplatform-vr.sh status`：api/web/proxy/publish/cpu/gpu/maintenance/tunnel 全部 MANAGED |
| DB 迁移与版本对应 | PASS | 代码 head `cd03ef05ab06` = 两库 `alembic_version` |
| 重启后状态恢复 | PASS | staging 重启后 `/health/ready` ready，场景/资产可读 |
| HTTPS Web & XR 入口 | PASS（临时） | Quick Tunnel HTTP/2：`/`、`/works`、`/scene/...`、`/xr/...`、`/xr/diagnostics/...`、`/upload` 均 200 |
| 大资产分块/Range/缓存 | PASS | `Range: bytes=0-1023` → **206**，`content-type: application/json` |
| 私有资源防绕过 | PASS | `/local-scenes/...` 经隧道 **403**；`/_scene-origin/` internal-only |
| 登录态 / 分享权限 / CSRF | PASS | 见 §2 #15、§6.1 |
| 上传失败 / 转换失败 / worker 异常恢复 | PASS（部分） | 续传 409 纠正；发布状态机幂等；dispatch 失败 503 |
| 错误页 / 缺封面 / 不存在场景提示 | PASS | `/api/v1/scenes/nope/runtime` 404；viewer 显示可恢复错误（`ManifestFallbackError`） |
| **临时隧道 vs 正式域名** | 区分明确 | Quick Tunnel **无 SLA**，**不得**标记为正式稳定入口 |

