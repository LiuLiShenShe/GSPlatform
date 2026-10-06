# PRODUCTION_RUNTIME_ACCEPTANCE：GSPlatform Production XR Acceptance

- 日期：2026-10-06（FIX-06.2.1 最终部署路径收口；FIX-06.2 生产验收脚本收口；FIX-06.1 最终软件收口；FIX-06 复核 2026-10-06；FIX-05C 最终复核 2026-10-01）
- 阶段：FIX-06.2.1 — 最终部署路径收口（release preflight cwd 独立、first-deploy
  rollback fail-closed、production smoke 严格 TLS；**非新 Phase、无业务功能**）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体与运行时对齐）PASS ·
  FIX-05（独立审计整改）PASS · FIX-05B（Vite 收尾）PASS · FIX-05C（缓存策略收口）PASS
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4` + `@photo-sphere-viewer/core@5.15.1` + `three@0.185.1`
- 说明：SSV_FINAL_ACCEPTANCE.md 的 PASS 为软件迁移范围结论，**已被本报告纠正/接续**
  （该历史报告顶部已加 FIX-04 纠正声明）。

---

## OVERALL RESULT

**BLOCKED — XR HARDWARE ACCEPTANCE NOT EXECUTED**

本环境（Linux 无头服务器）**无 Quest/PICO 头显**，也未安装 Immersive Web Emulator，
因此按 §7/§21/§24 规则：**不得写作 PRODUCTION PASS**。全部可在本环境验证的软件、
自动化、桌面（headless WebGPU/WebGL）、真实场景性能项均已执行（如下），真实设备项
**待用户在有头显的环境中执行**（Test Deployment URL 已备，见 DEPLOYMENT）。

| 必备项（§21） | 状态 |
|---|---|
| Security PASS | ✅ PASS（78 项安全回归 + 全套后端测试 + 实测 Range/416/traversal） |
| Desktop PASS | ✅ PASS（headless WebGPU-first + WebGL2 回退 + 全功能矩阵自动化） |
| Real Scene PASS | ✅ PASS（A/B/C 三档真实场景实测加载/渲染，B=真实 1.8M LOD 场景） |
| LOD PASS | 🟡 PARTIAL（流式 chunk 加载/157K 渲染/331 请求实测；**全量首帧在软件渲染下不可达** —— 需真实 GPU 复核） |
| Quest/PICO real XR PASS | ❌ **NOT EXECUTED**（无硬件 → BLOCKER） |
| Production Web typecheck | ✅ 0 errors（web 全量 tsc -b） |
| Automated tests PASS | ✅ PASS（web 228 / backend 342（FIX-06.2.1 最终）/ workers 13 / e2e 17 / 安全 78） |

**Blocker**：`XR HARDWARE ACCEPTANCE NOT EXECUTED` —— 需要 Quest 或 PICO 头显
（含 6DoF、左右眼视差、Enter/Exit/Re-enter、TEXT/IMAGE hotspot、碰撞不破坏 XR 等
真机项，见 REAL DEVICE RESULT 清单）。

---

## ARCHITECTURE RESULT

**单一 runtime（§4，再次确认）：**

```text
GSPlatform
  → SceneRuntimeDescriptor          （DB runtime contract / manifest 回退）
  → ExperienceSettings v2           （experienceAdapter，与 FIX-02/03 同一代码路径）
  → @playcanvas/supersplat-viewer@1.35.0
      Desktop：SuperSplatRuntime.create({ mode:'desktop' })  → WebGPU-first（官方自动回退 WebGL）
      XR：    SuperSplatRuntime.create({ mode:'xr' })        → renderer 强制 'webgl'
```

- **禁止第二套 XR runtime**：`/xr/*` 与 `/scene/*` 共用同一 `useSuperSplatXR` /
  `useSuperSplatDesktop` → 同一 `SuperSplatRuntime`。自动化验证：`xr-pages.test.tsx`
  （Desktop 与 XR 同一 descriptor → 同一 contentUrl/settings）+ `no-legacy-viewer-references.test.ts`。
- 实测（headless）：Desktop renderer=`webgpu`；`--disable-features=WebGPU` 强制下官方自动
  回退 `webgl2` 并完成渲染；XR 页 renderer=`webgl2`。

## SECURITY RESULT

- FIX-01 回归全绿：`test_scene_access` / `test_scene_assets` / `test_shares` /
  `test_scenes_owner` = **78 passed**；完整后端套件 **248 passed**（FIX-05C.1 最终）。
- 实测（dev origin，语义与生产 nginx 同源）：`Range: bytes=0-99` → **206**
  `Content-Range: bytes 0-99/476`；越界 → **416**；路径穿越（`../` 编码）→ **404**。
- 私有/公开/删除场景、READY vs PUBLISHED 公开、Share token：自动化测试覆盖
  （test_shares / test_scene_access），未回归。
- 注：本环境 dev API 以 `GS_DEV_IDENTITY_ENABLED=true` 运行（FIX-02 dev 身份绕过），
  匿名访问私有场景返回 200 属 dev 行为；强制鉴权路径由自动化测试锁定。

## DESKTOP RESULT

- 正式 Desktop viewer（`/scene/:sceneId`，官方 runtime 唯一路径）：e2e 17/17（相机/
  视角/标注/碰撞/Walk/LOD/媒体）全部通过。
- 渲染器：默认 `webgpu`（WebGPU-first）；WebGPU 禁用时官方自动回退 `webgl2`（实测）。
- 功能矩阵：见下方 FEATURE MATRIX（全项 PASS/NOT EXECUTED 如实标注）。
- Walk：`ssv07-collision` 完整验收（进入 Walk → 移动 → 碰撞阻挡 → 退出恢复）。

## XR RESULT

- 正式 XR 页 `/xr/:sceneId`（FIX-04 §2 产品化）：**Viewer 铺满 100vw/100vh**；UI 仅保留
  Scene Name / Enter VR / Exit VR（会话中）/ Back / Loading / Error / 进入前极简说明。
- 工程诊断（Secure Context / navigator.xr / Immersive VR / UA / renderer / gsplats /
  runtime state / asset URL / collision / walk / 进入前相机）**全部迁至** `/xr/test` 与
  `/xr/diagnostics/:sceneId`（§3）；正式页只以视觉隐藏 span 暴露运行态（e2e 取证契约保留）。
- Enter/Exit/Re-enter：`xr-pages.test`（14 项）自动化验证 startXR('vr') / endXR /
  系统退出 → xr-ended / 重新进入。
- **WebXR 沉浸会话未真机执行**（无硬件）。浏览器侧 `navigator.xr` / canStartVR 读数
  headless WebGL 环境如实暴露（不可用/unsupported 时页面显示明确错误）。

## REAL DEVICE RESULT

**BLOCKED — 未执行。** 无 Quest/PICO 硬件。真机清单（供设备到手后执行，§8/§9/§11）：

1. 头显浏览器打开 Test Deployment URL `https://<tunnel>.trycloudflare.com/xr/<sceneId>`
   （需 vite 以 `GS_ENABLE_DEV_TUNNEL=1` 启动，或生产 Nginx 部署；Secure Context = true）。
2. 确认 Secure Context / WebXR available / canStartVR / scene loaded。
3. 点击 Enter VR → 确认 XR mode = `vr`。
4. 6DoF：头部旋转 / 前后 / 左右 / 上下移动无固定头、无错误视差、左右眼无异常、非单眼、非黑屏。
5. 初始相机/初始位置合理；世界变换正确；scale 合理；标注在正确坐标；碰撞对齐 Gaussian。
6. Annotation：TEXT hotspot 与 IMAGE hotspot 真机检查（官方标注层为 DOM overlay，
   **沉浸会话内 HTML 不进入头显视野** —— 产品行为 = 退出沉浸后用 2D Overlay；不得声称
   不支持的 HTML overlay 已在 VR 实现）。
7. Collision/Walk：VR 中不加自研 locomotion；只验证碰撞资产不导致 XR 渲染错误。
   “VR 摇杆行走”登记为下一阶段需求（官方未公开接入时禁止临时手写）。

## SCENE SEMANTICS

- Initial Camera：FIX-02 §19/§16 e2e —— Desktop/XR 进入 VR 前相机 = DB authored initial
  （`2.5,1.8,6 / fov47`，严格数值）。
- World Transform：非恒等 W 真实执行（Ry90 → 相机 `[6,1.8,-2.5]`、包围盒随实体旋转，e2e）。
- Scale：SSV-07 scale 校准/告警 e2e；XR 加载碰撞资产不破坏会话（ssv07 §8）。
- Annotation 坐标：每条标注独立相机 A/B/C 互不相同（e2e）；hotspot 位置经世界变换换算。
- Collision 对齐 Gaussian：voxel 网格 walk 阻挡穿出（e2e）。

## MEDIA

- TEXT：官方 annotation panel（sanitize）—— e2e。
- IMAGE / VIDEO / AUDIO / PANORAMA：统一 2D 媒体 Overlay（SSV-06 + FIX-03 真实 360° PSV
  渲染器 canvas 实挂载）—— e2e + 单测。
- Background audio：GSPlatform 控制器（volume/loop/gesture/ducking/切场景 teardown）——
  e2e `ssv06-audio`。
- **VR 中媒体行为（产品定义）**：HTML 媒体 Overlay 与官方 annotation tooltip 均为 DOM
  层，**不会出现在沉浸 WebXR 视野内**。产品行为 = 退出沉浸/2D 模式使用 Overlay；沉浸内
  查看标注/媒体为后续需求，本阶段不声称已实现。

## COLLISION

- Desktop Walk 完整验收（官方固定物理，voxel 阻挡）；CollisionPanel 仅真实能力
  （FIX-03 §9/§10：物理参数已移除，不可配置）。
- XR：碰撞资产加载不破坏 XR（e2e hasCollision/walkAllowed=true）；VR 内不新增 locomotion。

## LOD

- Desktop：`ssv08-streaming` e2e —— lod-meta 路由、Range chunk 流式、单文件 SOG 对照。
- 实测（软件渲染，环境真实值）：见 PERFORMANCE。**全量首帧在 SwiftShader 软件渲染下
  不可达**（SSV-08 已记录基线）；真实 GPU 上预期显著改善 —— 标记 PARTIAL，需真实设备复核。

## PERFORMANCE

方法：headless Chromium（SwiftShader 软件 WebGPU）+ 5s rAF FPS 采样 + `performance.memory`
+ resource entries；数值为环境真实值，**不代表生产 GPU**（如实标注）。

| 档位 | 场景 | 首帧(loaded) | frame.gsplats | FPS(avg) | 峰值堆 | 网络请求 |
|---|---|---|---|---|---|---|
| A 小场景 | `fix02-semantics`（SOG，500 splats） | 1.88 s | 500 | 28 | 111 MB | 2 req |
| B 真实 GSPlatform 场景 | `r-8c4e2264e86a`（用户上传 1.8M LOD，5 标注 + 碰撞 + 背景音频） | 2.20 s | 179* | 41 | 117 MB | 14 req |
| C 大场景/LOD | `ssv08-large`（1.8M streamed，4466 chunks） | **不可达*** | 157,001（流式攀升） | 1 | 104 MB | 331 req / 4 MB |

\* B 的 gsplats=179 为初始相机下 LOD 最低档 + 视锥裁剪后的当前帧渲染数（LOD 层级
随相机移动流式提升）；C 全量 loaded 在软件渲染下不可达（渲染已激活：157K 高斯 + 331
chunk 请求），真实 GPU 复核见 KNOWN LIMITATIONS。

## TESTS

| 门禁 | 结果 |
|---|---|
| web `pnpm test` | **228 passed / 26 files**（FIX-05C.1 最终） |
| web `pnpm typecheck` | **0 errors**（`tsc -b --noEmit`，production web 全量） |
| web `pnpm lint` | exit 0（oxlint） |
| web `pnpm build` | exit 0（tsc -b + vite build） |
| e2e（Playwright headless SwiftShader WebGPU） | **17 passed / 8 specs**（47.8s；含 FIX-03 音频/PANORAMA、FIX-02 语义、安全无关回归全绿） |
| backend `pytest` | **278 passed**（FIX-06 最终，含 cache 矩阵 53 + FIX-06 生产完整性 30） |
| backend `ruff` / `mypy` | clean（All checks passed / Success，84 files） |
| workers pytest | **13 passed**（FIX-05C 最终） |
| FIX-01 安全回归 | **78 passed**（scene_access / scene_assets / shares / scenes_owner） |

## KNOWN LIMITATIONS

1. **Quest/PICO 真机未执行**（BLOCKER，本环境无硬件）；6DoF/视差/沉浸内交互待真机复核。
2. **Immersive Web Emulator** 未安装；Enter/Exit/Re-enter 以官方 handle 契约自动化验证。
3. **真实域名 HTTPS 未验证**：Cloudflare Quick Tunnel 仅作开发/临时验收
   （当前 `https://barcelona-academic-glen-still.trycloudflare.com` 处于主机闸门后，
   需 `GS_ENABLE_DEV_TUNNEL=1` 启动 vite 才放行）—— 标为 **Test Deployment**，
   非 Production Domain。生产 = Nginx + 真实域名 + certbot（`deploy/nginx`，未部署）。
4. **LOD 全量首帧在软件渲染下不可达**（SwiftShader 基线）；需真实 GPU/设备复核。
5. 性能数值为软件渲染（SwiftShader），只作机制与相对量级参考。
6. VR 内 HTML 媒体 Overlay / 官方 annotation tooltip 不可见（DOM 层）—— 产品行为已定义
   （退出沉浸后用 2D Overlay），沉浸内查看为后续需求。
7. dev API 以身份绕过运行（GS_DEV_IDENTITY_ENABLED），匿名访问私有场景返回 200 为
   dev 行为；强制鉴权由自动化测试锁定。

## FIX-05：软件 Blocker vs 硬件 Blocker（§31/§38）

> 以下为 **FIX-05 时点历史快照**；当前权威测试计数以本文档顶部表格与 FIX-05C 段为准。

**软件 Blocker —— 全部已清（FIX-05 PASS）**

独立生产审计（FIX-05）确认的 9 项软件问题已全部修复并验证（详见
`FIX_05_AUDIT_REMEDIATION_REPORT.md`）：dev 隧道暴露、`current/*` 错误 immutable、
私有/分享资产错误 `public`、世界变换恒等无法复位、碰撞与变换未同步（STALE 语义）、
发布信任根过宽、publish bridge repo root、setCameraPose 隐藏标注增长、拾取近似标记。
软件门禁：backend `pytest` **208 passed** / `mypy` Success；web `typecheck` 0 errors /
`vitest` **213 passed** / lint clean；workers 13 passed；`nginx -t` syntax ok。

**硬件 Blocker —— 仍未执行（保持不变）**

`XR HARDWARE ACCEPTANCE NOT EXECUTED`：无 Quest/PICO 头显。硬件项（6DoF、左右眼视差、
Enter/Exit/Re-enter、TEXT/IMAGE hotspot 真机、碰撞不破坏 XR、LOD 全量首帧真实 GPU 复核）
待真机环境执行 —— 这是**唯一剩余 blocker**，与软件无关。

## FIX-05B：最终复核（2026-09-30）

- **Acceptance Stage**：**FIX-05B**（Vite Dev Asset / Cache / Trust Boundary 最终整改 +
  本报告同步）。详见 `FIX_05B_FINAL_REMEDIATION_REPORT.md`；FIX-05 报告顶部已加
  Post-audit note（Vite 中间件为 FIX-05 漏网之鱼），历史结论未改写。
- **Software blockers**：**NONE**（FIX-05 9 项 + FIX-05B 4 项 + 1 项门禁复核全部关闭；
  无 P0/P1 遗留）。
- **Hardware blockers**：`XR HARDWARE ACCEPTANCE NOT EXECUTED` —— 无 Quest/PICO 头显
  （6DoF、左右眼视差、Enter/Exit/Re-enter、TEXT/IMAGE hotspot 真机、碰撞不破坏 XR、
  LOD 全量首帧真实 GPU 复核待真机执行）。这是**唯一剩余 blocker**，与软件无关。

| 门禁 | 结果（FIX-05B 时点快照；FIX-05C 最终计数见本文档顶部） |
|---|---|
| Frontend tests（web vitest） | **227 passed / 26 files** |
| Frontend typecheck | **0 errors**（`tsc -b --noEmit`） |
| Backend tests（pytest） | **208 passed**（ruff All checks passed；mypy Success / 84 files） |
| Worker tests | **13 passed** |
| 仓库 `pnpm test` / `pnpm lint` / `pnpm api:check` | 227 / exit 0 / clean |

各子系统状态（FIX-05B 之后）：

- **Security** ✅ PASS —— dev 隧道白名单（`GS_ENABLE_DEV_TUNNEL=1` + `XR_DEV_PUBLIC_SCENES`）、
  Vite `/local-scenes` Plan A 不再跟随 `storage/published`、真实场景级 published 根
  （API）、slug 语法 / 单次解码 / realpath containment / Range/416 全部保留且实测
  （traversal 400/403、跨场景 symlink 403、隧道非白名单 403）。
- **Cache** ✅ PASS —— `current/*` 一律 `no-cache`、`versions/<ver>/*` 不可变，
  **API（Nginx map 兜底 + API scope-aware 头权威）与 Vite 开发中间件（路径语义纯函数
  `buildDevSceneCacheControl`）两侧一致**；私有/分享永不 `public`。
- **World Transform** ✅ PASS —— 恒等复位（`baseGsplatTransform` 恢复）、`W ∘ base`
  合成（FIX-05，本阶段未动）。
- **Collision stale** ✅ PASS —— `worldTransformHash` 记录/比对、`stale` 语义、
  walk 禁用门禁（FIX-05，本阶段未动）。
- **Picking** ✅ PASS —— 近似拾取语义文档化：`RuntimeAnnotation` 注释已修正为
  「不保证落在 Gaussian 表面」，approximate 与 future exact surface
  （`ScenePickingAdapter` 预留接口）明确区分，不伪造精确。

## FIX-05C：最终缓存策略收口（2026-10-01）

- **Acceptance Stage**：**FIX-05C**（Cache-Control 优先级收口）。详见
  `FIX_05C_CACHE_POLICY_REMEDIATION.md`。软件侧最后一项缓存问题已关闭：
  `SceneAssetService.build_cache_control()` 此前「文件名特例（manifest/poster）
  优先于 scope/路径语义」，导致 `current/manifest.json` 60s、`current/poster.webp` 1d、
  `versions/<v>/manifest.json` 60s、`SHARE + poster.webp` 长缓存。现优先级修正为
  **SHARE → current/* → versions/* → 顶层 manifest/poster → default**，并与
  Nginx fallback map（新增 `current/* → no-cache` 规则）一致；scope-aware 权威值
  仍由 Backend response 决定。
- **Software blockers**：**NONE**。
- **Hardware blockers**：`XR HARDWARE ACCEPTANCE NOT EXECUTED`（唯一剩余 blocker，
  与软件无关）。
- **FIX-05C 最终门禁**：cache 矩阵 targeted 53 passed（含 FIX-05C.1 嵌套路径回归）；
  backend 全量 **248 passed**；web **228 passed / 26 files**；workers **13 passed**；
  ruff All checks passed；mypy Success（84 files）；`nginx -t` syntax ok。
  mypy Success（84 files）；`nginx -t` syntax ok。test counts 已全文档统一（见顶部）。

## FIX-06：软件可复现性与生产完整性（2026-10-06）

- **Acceptance Stage**：**FIX-06**（Software Reproducibility & Production Integrity）。
  详见 `FIX_06_REPRODUCIBILITY_REMEDIATION.md`。软件侧最后一个"部署可复现性/生产完整性"
  整改完成；**无新业务功能、无 XR/渲染/LOD/流式协议改动**。
- **Software blockers**：**NONE**（P0/P1 全项已关闭，见下方矩阵）。
- **Hardware blockers**：`XR HARDWARE ACCEPTANCE NOT EXECUTED`（唯一剩余 blocker，与软件无关）。

**整改矩阵（全部 PASS，除标注"NOT EXECUTED"的生产主机项）：**

| 项 | 状态 | 说明 |
|---|---|---|
| storage 包 tracked（P0-1） | ✅ PASS | `.gitignore` 裸 `storage/` → `/storage/`；`git ls-files` 含 4 个文件（测试锁定） |
| Python 生产依赖闭包（P0） | ✅ PASS | pyproject 声明 celery/argon2/httpx/multipart/PyYAML/redis/numpy；**clean venv `pip install -e apps/api` → import 闭包 CLEAN_IMPORT_OK** |
| worker venv 统一（P0） | ✅ PASS | 3 个 systemd 单元 ExecStart 改指共享 `apps/api/.venv/bin/celery`；`workers.celery_app` clean-venv 可导入（模块级无 torch/gsplat） |
| 私有媒体鉴权（P0/P1） | ✅ PASS | cover/background/background-audio/annotation-media 4 条 serve 路由接入 `SceneAccessPolicy`（匿名 401 / 非属主 403 / 删除 404 / share token 可读）；Cache-Control scope-aware |
| coverUrl UUID→slug（P0/P1） | ✅ PASS | `_presentation_out` 用 `scene.slug` 锚定；上传封面 → GET presentation → GET coverUrl → 200 字节一致（e2e 测试） |
| uploads/compute CSRF（P1） | ✅ PASS | uploads POST/PATCH/DELETE + compute POST /reconstruct、/cancel 全加 `require_csrf`；session 模式无 CSRF 403 / 错 token 403 / 正确 201（测试） |
| 上传状态机（P1） | ✅ PASS | append 仅 {CREATED,UPLOADING}；cancel 仅 {CREATED,UPLOADING,UPLOADED} 否则 409；complete 需 UPLOADED（测试） |
| complete 幂等（P1） | ✅ PASS | 行锁 `with_for_update`；重放返回既有 Job、FAILED 重试新 Job；**1 Scene / 1 Job 不重复**（测试） |
| 派发失败恢复（P1） | ✅ PASS | send_task 抛错 → Job FAILED `TASK_DISPATCH_FAILED`（安全文案，不泄 broker 异常原文）+ 503，upload 回 UPLOADED 可重试；重建 submit 同款 + 场景复用（测试） |
| publish worker 幂等（P1） | ✅ PASS | SUCCEEDED 重复投递早退不篡改；`promote_staging_to_version` 校验复用、**删除旧版本改为冲突**；`commit_version` 复用 SceneVersion、Asset 去重（测试） |
| deploy 仅 tracked 源码（P0） | ✅ PASS | `git archive HEAD`（不再 `cp -a` 工作区）+ 工作区 clean 检查；元数据取自源仓库；pip/build/迁移/场景同步/重启/smoke 全 fail-closed |
| preflight 扩展（P1） | ✅ PASS | 发布完整性（.git-commit-hash + storage 文件）、全依赖 import 闭包、worker celery 可执行 + `workers.celery_app`、systemd ExecStart 路径、alembic current==head |
| smoke Cache-Control 修正（P2） | ✅ PASS | `current/manifest.json` → `public, no-cache`（不再 max-age=60）；versions/<ver>/manifest → immutable（解析 entryUrl）；Range 206/416 保留 |
| 限流 XFF 信任 + Redis（P1） | ✅ PASS | `_client_ip` 改用 `request.client.host`（uvicorn trusted proxy）；Nginx XFF 改 `$remote_addr`；Redis 限流器 + 内存回退（计数/TTL/超限/宕机回退测试） |
| clean checkout 门禁（§17） | ✅ PASS | `verify_release_source.sh`：git archive → 无 .git/.env/.venv/node_modules → fresh venv → import → ruff/mypy/pytest/workers 全绿（提交后执行） |
| Alembic 迁移 | ✅ PASS | 单 head（`c1d2e3f4a5b6`）；PostgreSQL `current == head`（本地 dev DB 实测，无需新迁移） |
| 生产主机部署 | **NOT EXECUTED** | 本环境无生产主机/域名；`deploy_release.sh`/`preflight.sh` 未在真机执行（如实标注，不伪造） |

**FIX-06 最终门禁**：backend **278 passed**（含 FIX-06 新增 30）；workers **13 passed**；
ruff All checks passed；mypy Success（84 files）；`nginx -t` ok（proxy-params XFF `$remote_addr`）；
web 228 / typecheck 0 errors / lint / build 未改动保持。

## FIX-06.1：最终软件收口（2026-10-06）

- **Acceptance Stage**：**FIX-06.1**（Final Software Closure —— 非新 Phase，无业务功能，
  不重构 SuperSplat/Viewer/XR/LOD）。详见 `FIX_06_1_FINAL_SOFTWARE_CLOSURE.md`。
- **Software blockers**：**NONE**（四项正式问题 A–D 全部关闭）。
- **Hardware blockers**：`XR HARDWARE ACCEPTANCE NOT EXECUTED`（唯一剩余 blocker，与软件无关）。

| 项 | 状态 | 说明 |
|---|---|---|
| GPU 重建运行时闭包（A） | ✅ PASS | `deploy/requirements-reconstruction.txt` 锁定 torch **2.14.0+cu126** + gsplat **1.5.3**（Phase-07 合同版本，未追新）；`deploy_release.sh` §3b 在 GPU worker 同一 `apps/api/.venv` 安装并 verify；`verify_reconstruction_runtime.py` 六项检查（imports+版本+trainer `--help`+CUDA+最小 rasterization，exit≠0 无吞错）—— 本机 2× A6000 实跑 **PASS**（现有 venv 与全新 venv 双验证；全新 venv gsplat CUDA 扩展 JIT 构建 148.6s） |
| 生产 Redis 限流激活（B） | ✅ PASS | `production.env.example` 增 `GS_RATE_LIMIT_BACKEND=redis` + 注释；`app/main.py` 生产守卫（env==production 且非 redis → RuntimeError，无 secret）；`preflight.sh` 生产 Redis 不可达 → **FAIL**；fallback 文档（Redis 故障→进程内窗口，恢复回弹） |
| 生产 smoke 真实缓存/Range（C） | ✅ PASS | `smoke_manifest.py` 共享解析器按 `stream.entryUrl` 契约解析；`--public-scene` 时 entryUrl 缺失/非法 → **FAIL**；版本化 manifest **200 + 精确 `public, max-age=31536000, immutable`** 真实验证；版本化 entry 200；deploy 传 `--public-scene`（`SMOKE_PUBLIC_SCENE_SLUG` 或确定性 DB 查询，无合格场景 → 中止） |
| 并发/CSRF 回归（D） | ✅ PASS | 两会话 `threading.Barrier` 并发 complete（真实 PostgreSQL）→ **1 Scene/1 Job/1 dispatch/同一 jobId**；PATCH/complete/DELETE CSRF 矩阵（无 403/错 403/对 通过）；POST /compute/reconstruct 正确 token 到达业务校验（404 而非 403，`require_csrf` 不 mock） |
| 全量门禁 | ✅ PASS | backend **309 passed**（278+31）；FIX-06.1 targeted **31 passed**；workers **13 passed**；ruff clean；mypy Success（84 files）；web 228 / typecheck 0 errors / lint / build exit 0；`nginx -t` ok；alembic 单 head + current==head |

**FIX-06.1 最终门禁**：backend **309 passed**（含 FIX-06.1 新增 31）；workers **13 passed**；
ruff All checks passed；mypy Success（84 files）；web **228 passed / 26 files** / typecheck 0 errors /
lint exit 0 / build exit 0；`nginx -t` ok；Alembic 单 head `c1d2e3f4a5b6` + current==head；
clean-checkout 门禁（提交后执行并记录，见 FIX_06_1 报告 GIT 节）。

## FIX-06.2：生产验收脚本最终收口（2026-10-06）

- **Acceptance Stage**：**FIX-06.2**（Production Acceptance Script Final Closure —— 非新 Phase，
  无业务功能，不重构 SuperSplat/Viewer/XR/Quest-PICO/LOD/Gaussian 渲染器/streamed-SOG/business
  schema，无新增 Alembic 迁移）。详见 `FIX_06_2_PRODUCTION_ACCEPTANCE_SCRIPT_CLOSURE.md`。
- **Software blockers**：**NONE**（两个已确认 blocker 关闭）。
- **Hardware blockers**：`XR HARDWARE ACCEPTANCE NOT EXECUTED`（唯一剩余 blocker，与软件无关）。

| 项 | 状态 | 说明 |
|---|---|---|
| Smoke 真实 GET 资产面（A） | ✅ PASS | 资产接口 GET-only（`scene_runtime.py` 无 HEAD 路由）；smoke 资产段改 `g()`/`hdr()` 一次真实 GET 取状态+头+body，覆盖 X-Accel→Nginx body 链路；全脚本仅剩 2 处 SPA `curl -sI`（合法静态文件）；`smoke_manifest.py` CLI 双行输出（versions/<ver> + 真实 entry 文件名），smoke 不再硬编码 lod-meta.json |
| Preflight host/release 拆模（B） | ✅ PASS | `--mode host`（默认）＝部署前主机就绪（命令/文件系统/磁盘/env 文件/pg_isready/redis-cli/生产限流门禁/NVIDIA nvidia-smi），全新主机可先行预检；`--mode release`＝已装 release 完整性（current+元数据/web dist/storage 包/venv 导入/celery/systemd ExecStart/torch/gsplat/CUDA/alembic current==head/nginx -t）；`deploy_release.sh` §6b 对新 current 跑 release 预检，失败回滚符号链接并中止 |
| 安全 env 共享（C） | ✅ PASS | `lib_env.sh` 安全加载 `$GS_ENV_FILE`（无 `source` 任意路径、无 shell 展开、`$` 原样、密文不回显）；preflight/deploy/systemd 同一来源；`production.env.example` 注明 systemd `EnvironmentFile=` 不展开，`GS_CELERY_BROKER_URL`/`GS_CELERY_RESULT_BACKEND` 才是实际消费项 |
| Runbook 同步（D） | ✅ PASS | `DEPLOYMENT_RUNBOOK.md`：base 包补 `postgresql-client`/`redis-tools`；首次部署 `--mode host` → deploy → `--mode release` 复查；smoke 需 `--public-scene`（PUBLIC+PUBLISHED+未删除+有 current），deploy 自动传入、无合格场景中止部署；GS_ENV_FILE 语义 |
| 全量门禁 | ✅ PASS | backend **329 passed**（309+20）；FIX-06.1+06.2 targeted **51 passed**（31+20）；workers **13 passed**；ruff clean；mypy Success（84 files）；web 228/26 + typecheck 0 errors + lint + build exit 0；`nginx -t` ok；bash -n 全绿；GPU 门禁（真 venv，无 --allow-no-gpu，2× A6000）**PASS**；first-deploy 仿真（/tmp，host 生产 19/0）与 release 仿真（/tmp，28/0）**PASS**；clean-checkout 门禁（新 HEAD）**GATE_EXIT=0** |

## FIX-06.2.1：最终部署路径收口（2026-10-06）

- **Acceptance Stage**：**FIX-06.2.1**（Final Deploy-Path Closure —— FIX-06.2 的极小修正；
  非新 Phase、无业务功能、不重构 SuperSplat/Viewer/XR/Quest-PICO/LOD/Gaussian/streamed-SOG/
  cache/upload/publish/reconstruction/DB schema；无 Alembic migration）。
  详见 `FIX_06_2_1_FINAL_DEPLOY_PATH_CLOSURE.md`。
- **Software blockers**：**NONE**（A/B 两个 P1 blocker + C 加固全部关闭）。
- **Hardware blockers**：`XR HARDWARE ACCEPTANCE NOT EXECUTED`（唯一剩余 blocker，与软件无关）。

| 项 | 状态 | 说明 |
|---|---|---|
| Release preflight cwd 独立（A） | ✅ PASS | wheel 只打包 `["app"]`，`workers` 仅从 repo root 解析；deploy step 5 遗留 cwd=apps/api 让 `import workers.celery_app` 失败（clean tree 真复现 `ModuleNotFoundError`）。修复：preflight `[I]` 在 `( cd "$CURRENT_ROOT" )` 子 shell 跑完整导入闭包（deps+app.main+workers.celery_app+tasks），不依赖调用方 cwd/PYTHONPATH；deploy step5 后归一化 `cd $RELEASE_DIR`。回归：git-archive clean release 三 cwd（root / apps/api / /tmp）+ deploy 真实 cwd 链，PYTHONPATH 全 unset → 全 PASS |
| First-deploy rollback fail-closed（B） | ✅ PASS | old 6b 只回滚「有旧版本」，first deploy 失败时 current 残留失败 release。新增 `lib_rollback.sh::rollback_current`：upgrade 恢复 previous；first deploy 仅当 current 解析到失败 release 时 `rm -f` 撤销（目录保留诊断）；unknown target → REFUSE 非零。真实 symlink 回归 4 项零 mock |
| Production smoke 严格 TLS（C） | ✅ PASS | `C()` 不再默认 `-k`（`CURL_TLS_ARGS` 数组，`--resolve` 改数组）；`--insecure` 显式 staging/local opt-in，production 拒绝（exit 1）；deploy 仅 staging+`SMOKE_INSECURE=1` 才传；证书过期/主机名不匹配/未知 CA/链断裂 → curl 非零 → smoke FAIL；场景资产仍为真实 GET（无 `curl -I/-sI/--head` 回归） |
| 全量门禁 | ✅ PASS | backend **342 passed**（329+13）；FIX-06.1+06.2+06.2.1 targeted **64 passed**（31+20+13）；workers **13 passed**；ruff clean；mypy Success（84 files）；web 228/26 + typecheck 0 errors + lint + build exit 0；`nginx -t` ok；`find deploy -name '*.sh' bash -n` 全绿；GPU 门禁（真 venv，无 --allow-no-gpu，2× A6000）**PASS**；clean-checkout 门禁（新 HEAD）**GATE_EXIT=0** |

## DEPLOYMENT

- **Test Deployment（当前可用）**：Cloudflare Quick Tunnel → `https://barcelona-academic-glen-still.trycloudflare.com`
  （指向 `http://localhost:5173`；vite `allowedHosts` 需 `GS_ENABLE_DEV_TUNNEL=1` 启动才放行 trycloudflare 主机 —— FIX-01 P0-2 安全闸门）。**真机验收前**需注意：远端头显访问时应用 API 走
  `http://localhost:8001`（dev 默认）会失败 —— 真机/隧道验收需以 `VITE_API_BASE_URL=/api/v1`
  构建并经同源 `/api` 反代（vite dev proxy 已具备 / 生产 nginx 同源），否则仅能在本机浏览器验证。
- **Production**：Nginx + 真实域名 + certbot（`deploy/nginx/gsplatform.conf` +
  `scenes-streaming.conf`；Range/Cache/CSP/`Permissions-Policy: xr-spatial-tracking=(self)`）—— 本环境无域名，未部署。
- 部署 runbook：`deploy/deploy_release.sh`（`pnpm build` 仅 apps/web）。

## GIT

- 本阶段改动：正式 XR 页产品化（`XRViewerPage` 全屏极简 UI + 隐藏诊断）、诊断迁移
  （`/xr/test` + 新增 `/xr/diagnostics/:sceneId`、`XRTestPage` 补齐 UA/collision/walk/
  camera）、`xr-pages.test` 新增产品化契约（+3）、历史报告纠正
  （`SSV_FINAL_ACCEPTANCE.md` 顶部 FIX-04 纠正声明）、本报告、README 能力声明更新。
- 提交：`chore(runtime): complete production SuperSplat acceptance`，push，工作区 clean。
- 历史纠正：SSV-10 报告 OVERALL PASS 已标注为「软件迁移范围」，生产级结论以本报告为准。
