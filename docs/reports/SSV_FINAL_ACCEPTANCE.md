# SSV_FINAL_ACCEPTANCE：SuperSplat Runtime 迁移最终验收

- 日期：2026-09-29
- 阶段：SSV-10 — Production Acceptance and Deployment Closure
- 前置：SSV-00 ～ SSV-09 全部完成（最近提交 e8b0d7f）
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（本阶段未升级）

---

## OVERALL RESULT

**PASS** —— 全部 Production blocking 项通过；无阻塞遗留。遗留项均为环境性
（真实 Quest/PICO 实机、真实域名 HTTPS 站点属部署 runbook，本环境未执行，如实记录）。

迁移闭环：**GSPlatform → SceneRuntimeDescriptor → ExperienceSettings v2 →
@playcanvas/supersplat-viewer → Desktop / XR**，legacy 引用 = 0，质量门全绿。

## ARCHITECTURE

```text
GSPlatform
  → SceneRuntimeDescriptor          （apps/web/src/scene-runtime：DB runtime contract / manifest 回退）
  → ExperienceSettings v2           （descriptor.presentation + annotations/collision 适配）
  → @playcanvas/supersplat-viewer   （官方 runtime，锁定 1.35.0 + playcanvas 2.22.4）
  → Desktop（WebGPU，官方自动回退 WebGL） / XR（强制 WebGL）
```

- 决策：`docs/adr/ADR_SUPERSPLAT_RUNTIME.md`（FROZEN，SSV-10 已闭环）。
- 计划：`docs/SSV_MIGRATION_PLAN.md`（SSV-00 ～ SSV-10 全部完成）。
- 架构文档：`docs/DEVELOPMENT_PLAN.md` §2（已更新为最终链路）、根 `README.md`。
- 护栏：`apps/web/src/__tests__/no-legacy-viewer-references.test.ts`（生产 Web 对
  apps/viewer 零引用，本轮验证通过）。

## FEATURE MATRIX（§4，逐项验证）

| # | 功能 | 验证证据（真实执行） | 结果 |
|---|---|---|---|
| 1 | Login | API `test_auth.py`（login success / wrong password / unknown email / session）+ `test_e2e_phase8.test_register_login_favoriate_share_revoke`（register→login→/me） | ✅ |
| 2 | Browse works | web `home-grid` / `home-search` / `works` / `states` 测试 + API scene list | ✅ |
| 3 | Upload | web `upload.test.tsx`（校验/草稿/恢复/对象URL 释放）+ API `test_uploads.py`（create/resume/complete） | ✅ |
| 4 | Scene open | web `viewer.test.tsx`（官方挂载、无 iframe、进度、按钮、destroy）+ e2e | ✅ |
| 5 | SOG | e2e `ssv08-streaming` 单文件（`format=sog`、gsplats>1M）+ `descriptor-resolver.test` | ✅ |
| 6 | LOD scene | e2e `ssv08-streaming` LOD（`format=lod-meta`、contentUrl=lod-meta.json、Range chunk 流式、gsplats>0） | ✅ |
| 7 | Orbit | web `viewer.test`「Orbit/Fly 分段写入官方 state.cameraMode」+ e2e diag cameraMode=orbit | ✅ |
| 8 | Fly | 同上（Fly → state.cameraMode=fly） | ✅ |
| 9 | Fullscreen | web `viewer.test`「Fullscreen 调用官方 requestFullscreen」 | ✅ |
| 10 | Initial camera | `super-splat-runtime.test`「映射 background color 与 initial camera」+「无 initial camera 保留官方 default」 | ✅ |
| 11 | Background color | `super-splat-runtime.test` background color 映射 + API `test_scene_runtime` presentation | ✅ |
| 12 | Skybox | `super-splat-runtime.test`「映射 … postEffects / skybox」+「非 equirectangular 背景不写 skyboxUrl」 | ✅ |
| 13 | Post effects | `super-splat-runtime.test`「越界 clamp 进官方 POST_EFFECT_RANGES」+ API `post_effect_out_of_range_rejected` | ✅ |
| 14 | Text annotation | e2e `ssv06-authoring` + `ssv06-media` + `annotation-media-overlay.test` + `super-splat-runtime`（annotations 映射/sanitize/数量 cap） | ✅ |
| 15 | Image annotation | e2e `ssv06-media`（Image 媒体 Overlay） | ✅ |
| 16 | Video annotation | e2e `ssv06-media`（VIDEO 切换自动更新 Overlay） | ✅ |
| 17 | Audio annotation | e2e `ssv06-media`（AUDIO）+ `ssv06-audio` | ✅ |
| 18 | Panorama annotation | e2e `ssv06-media`（PANORAMA 切换） | ✅ |
| 19 | Background sound | e2e `ssv06-audio` + `super-splat-runtime`（enabled → 官方 soundUrl 绝对 URL） | ✅ |
| 20 | Collision | e2e `ssv07-collision`（walkAllowed、碰撞阻止穿出 voxel 网格；XR 官方消费 collision）+ API collision | ✅ |
| 21 | Walk | e2e `ssv07-collision`（进入 Walk → 移动 → 碰撞阻挡 → 退出恢复） | ✅ |
| 22 | Performance mode | web `viewer.test`「Performance 按钮写入官方 state.performanceMode」 | ✅ |
| 23 | XR page | e2e `ssv08-streaming` XR（renderer=webgl2、gsplats>0）+ `ssv06-media` XR hotspot + `ssv07-collision` XR + `xr-pages.test`（unsupported/错误/路由/descriptor 同一） | ✅ |
| 24 | Enter VR | `xr-pages.test` Test 4「点击 Enter VR → 真实 startXR('vr') → xrMode=vr → ACTIVE」（官方 handle 契约；沉浸式会话需实机/模拟器） | ✅（单元级） |
| 25 | Exit VR | `xr-pages.test` Test 7「Exit VR 按钮 → runtime.endXR()」+ Test 5 系统退出 | ✅ |
| 26 | Re-enter VR | `xr-pages.test` Test 6「退出后重新进入，状态恢复正常」 | ✅ |
| 27 | Share/public scene | API `test_shares.py`（token/URL、public 免 token、expiry、resolve、invalid token 404）+ `test_e2e_phase8` share/revoke | ✅ |
| 28 | Private scene auth | API `test_scenes_owner.test_edit_other_owner_forbidden`、`test_favorites`（其他 owner 私有 404）、`scene-runtime.test`（401/403 → UNAUTHORIZED/FORBIDDEN）、`test_shares.test_create_other_owner_forbidden` | ✅ |

## TEST MATRIX（§3，全部真实执行）

| 门禁 | 结果 |
|---|---|
| `pnpm test`（web） | **145 passed / 18 files**（exit 0） |
| e2e（Playwright，headless SwiftShader WebGPU） | **11 passed / 5 specs**（SSV-06 authoring/media/audio、SSV-07 collision、SSV-08 streaming；47.7s） |
| `pnpm lint` | exit 0（oxlint，0 生产路径告警） |
| `pnpm typecheck` | **exit 0 / 0 errors**（SSV-00 记录的 6 个 authoring 基线 TS6133 已在 SSV-10 解决） |
| `pnpm build` | **exit 0**（tsc -b + vite build，4458 modules） |
| backend ruff | exit 0（All checks passed） |
| backend mypy | **exit 0（81 source files, no issues）**（16 个历史错误已解决） |
| backend pytest | **132 passed**（exit 0） |

## DEVICE MATRIX（§5）

| 设备 | 结果 | 说明（如实） |
|---|---|---|
| Windows Chrome Desktop | **NOT EXECUTED** | 本环境为 Linux 无 Windows 主机 |
| Desktop WebGPU | **EXECUTED** | headless Chrome + SwiftShader 软件 WebGPU；e2e 全绿、性能实测 `renderer=webgpu` |
| Desktop WebGL fallback | **EXECUTED** | `--disable-features=WebGPU` 启动实测：官方 viewer 自动回退 `webgl2` 并完整渲染 1.8M gaussians（gsplats=1,779,543） |
| Immersive Web Emulator | **PARTIAL** | XR 页面（WebGL2 renderer、gsplats、官方 hotspot、碰撞 walk、流式）全部实测；浏览器沉浸式会话模拟器本环境无 —— Enter/Exit/Re-enter VR 以官方 handle 契约单元级验证（`xr-pages.test` Test 4/6/7） |
| Quest/PICO 实机 | **NOT EXECUTED** | 本环境无硬件，绝不伪造 |

## PERFORMANCE（§7，至少三档）

探测方法：真实页面加载 → 官方 runtime 首帧/流式 → 6s 采样（headless SwiftShader
**软件**渲染，非生产 GPU；数值为环境真实值，不代表硬件性能）。

| 场景 | 档位 | 首帧 | 驻留 gsplats | FPS(avg) | 峰值堆内存 | 请求/字节 |
|---|---|---|---|---|---|---|
| `local-garden`（18.8KB SOG） | **Small** | 1.78 s（loaded） | 500 | 45.7 | 92.9 MB | 5 req / 0.02 MB |
| `ssv08-single`（1.8M whole-blob SOG，4.8MB） | **Medium** | 2.53 s（loaded，1.78M 全量） | 1,779,543 | 0*（软件解码期；SSV-08 稳定态 12） | 168.8 MB | 3 req / 4.79 MB |
| `ssv08-large`（1.8M streamed LOD，36.7MB/4466 文件） | **Large LOD** | 流式激活 3.6 s；软件渲染下全量首帧不可达 | 224,828（6s 窗口内攀升） | 0* | 117.3 MB | 443 req / 4.56 MB（流式窗口） |

*FPS=0 为该 6s 窗口正处于软件解码/上传期；SSV-08 稳定态实测 Single SOG 12 FPS、
LOD 低档 ~1 FPS（软件 WebP 解码瓶颈）。本环境无真实中档摄影测量场景（~100K-500K），
Medium 档取同一 1.8M 内容的 whole-blob 对照（与 Large LOD 同尺度直接对比，见 SSV-08）。

## KNOWN LIMITATIONS

- **Quest/PICO 实机未执行**（无硬件）；Enter/Exit/Re-enter VR 为官方 handle 契约
  单元验证。部署到实机前需在 Quest/PICO 上复测 WebXR 会话与碰撞 walk（部署 runbook）。
- **真实域名 HTTPS 站点未在本环境 curl 验证**（无域名/证书）：nginx 配置结构审查 +
  本地 origin 的 Range(206/416)/Cache-Control(60s/immutable)/Content-Type/CORS/
  `Permissions-Policy: xr-spatial-tracking=(self)` 全部实测。部署 runbook
  （`deploy/`）负责真实域名 + certbot + nginx 安装。
- **Immersive Web Emulator**（浏览器扩展）本环境无；XR 页以 headless WebGL 实测。
- **性能数值为软件渲染**（SwiftShader）：只作机制与相对量级参考，不代表生产 GPU。
- **legacy `apps/viewer` 自身残留 1 个预存 typecheck 错误**（`embed.ts:679`
  `Entity.sync`，冻结包，未修复、未参与生产）；**Production Web = 0 errors**。
- 本环境无中档真实场景；LOD 全量首帧在软件渲染下不可达（真实 GPU 上预期显著改善）。

## LEGACY STATUS

- `apps/xr-viewer`：**已删除**（SSV-09）。目录、workspace、root 脚本、README 引用全清。
- `apps/viewer`：**LEGACY / DEPRECATED / FROZEN**。README 明示 "Not used by production
  scene viewing."；不参与 dev/build/deploy/acceptance；`legacy:viewer:*` 显式独立脚本
  保留（standalone build）。生产 Web 引用 = 0（护栏测试强制）。
- **SSV-09 遗漏在本阶段补齐**：`e2e/progressive-loading.spec.ts` 与
  `e2e/streamed-sog.spec.ts` 测试的是 SSV-09 已删除的 legacy 加载 Overlay
  （`progressive-overlay`），已删除（SSV-09 §7 范围，SSV-10 完成）。删除后 e2e 全绿。

## DEPLOYMENT

- 生产 Nginx（`deploy/nginx/gsplatform.conf` + `scenes-streaming.conf`）：HTTPS 443、
  HSTS、CSP（`wasm-unsafe-eval`）、`Permissions-Policy: xr-spatial-tracking=(self)`
  （Quest/PICO WebXR 必需）、`/assets/` immutable、`/local-scenes/` Range 流式（206/416 +
  内容哈希 immutable cache + manifest 60s + CORS allowlist）。
- `deploy_release.sh`：`pnpm build` 现仅构建 `apps/web`（viewer 已退出部署）。
- **Cloudflare Quick Tunnel 不是正式部署**：仅 dev 环境用于 Quest/PICO 真机调试
  （vite `allowedHosts: ['.trycloudflare.com']`）；生产一律走 Nginx + 真实域名 + certbot。
- 本环境 curl 实测（dev origin，语义与生产 nginx 一致）：
  `Range: bytes=0-99` → **206** `Content-Range: bytes 0-99/10882`；越界 → **416**
  `bytes */10882`；`manifest.json` → `Cache-Control: max-age=60`；versioned
  `lod-meta.json`/chunk → `max-age=31536000, immutable`；CORS
  `Allow-Headers: Range, Accept, Origin, Content-Type`。

## GIT

- 本阶段改动：6 个 authoring 基线 TS6133 修复（web typecheck 归零）、16 个 API mypy
  历史错误修复（mypy 归零）、删除 2 个 legacy e2e 规格、性能/设备实测、最终架构文档
  （README / DEVELOPMENT_PLAN / SSV_MIGRATION_PLAN / ADR）、本报告。
- 最终提交：`chore(viewer): complete SuperSplat runtime migration`，push 后工作区 clean。
- 迁移提交链（SSV-00 基线 → SSV-10 验收）：`8c2365d … e8b0d7f` + 本提交，共 13 个阶段提交。
