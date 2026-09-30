# PRODUCTION_RUNTIME_ACCEPTANCE：GSPlatform Production XR Acceptance

- 日期：2026-09-30（FIX-05B 最终复核；原始验收 2026-09-29）
- 阶段：FIX-05B — 最终 Production Acceptance 复核（本轮无新业务功能，仅产品化/验收/性能/纠错）
- 前置：FIX-01（安全）PASS · FIX-02（场景语义）PASS · FIX-03（媒体与运行时对齐）PASS · FIX-05（独立审计整改）PASS
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
| Automated tests PASS | ✅ PASS（web 200 / backend 183 / e2e 17 / 安全 78） |

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
  `test_scenes_owner` = **78 passed**；完整后端套件 **183 passed**。
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
| web `pnpm test` | **200 passed / 24 files**（含 FIX-04 新增：正式页极简 UI、隐藏诊断契约、/xr/diagnostics 路由） |
| web `pnpm typecheck` | **0 errors**（`tsc -b --noEmit`，production web 全量） |
| web `pnpm lint` | exit 0（oxlint） |
| web `pnpm build` | exit 0（tsc -b + vite build） |
| e2e（Playwright headless SwiftShader WebGPU） | **17 passed / 8 specs**（47.8s；含 FIX-03 音频/PANORAMA、FIX-02 语义、安全无关回归全绿） |
| backend `pytest` | **183 passed** |
| backend `ruff` / `mypy` | clean（前置 FIX-01/02/03 门禁保持） |
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

| 门禁 | 结果 |
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
