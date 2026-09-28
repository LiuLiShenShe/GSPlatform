# SSV_00_REPORT：SuperSplat Viewer 迁移 · 架构冻结与基线审计

- 日期：2026-09-28
- 阶段：SSV-00 — Architecture Freeze
- 分支：`main`

---

## RESULT

**PASS**

SSV-00 仅做审计 / 架构决策 / 依赖冻结 / 文档 / 命名修正，未做任何 Viewer 功能迁移。全部产出与基线记录见下。

---

## HEAD

```
74ce3a9 fix(xr): auto-frame scene from bounding box to fix black viewer
（main 分支，工作区干净，origin/main 一致，无未提交改动引入）
```

审计期间新增的改动：`apps/web/package.json` 依赖精确化（仅改 `^` → 精确版本，不升级）、`pnpm-lock.yaml` 同步、README 命名修正、`docs/adr/`、`docs/SSV_MIGRATION_PLAN.md`、`docs/reports/SSV_00_REPORT.md`。

---

## OFFICIAL VIEWER VERSION

`@playcanvas/supersplat-viewer@1.35.0`（精确锁定，原 `^1.35.0`）

- 安装版本（`apps/web/node_modules`）：`1.35.0`
- lockfile 解析：`@playcanvas/supersplat-viewer@1.35.0(playcanvas@2.22.4)`
- 直接依赖方：`@gsplatform/web@0.1.0`（`pnpm why` 确认唯一）
- peer 要求：`playcanvas@^2.22.1` ✓ 满足
- WebXR 软件层验证版本：**1.35.0**（页面输出 `SuperSplat Viewer v1.35.0 | Engine v2.22.4`；133 项自动化测试 + Playwright 页面验证通过）
- 真实头显硬件验证：**未执行**（环境无 Quest/PICO/OpenXR；`WEBXR_REPAIR_REPORT.md` 诚实记录 PARTIAL，不伪造 PASS）

## PLAYCANVAS VERSION

- 生产依赖（`apps/web`）：`playcanvas@2.22.4`（精确锁定，原 `^2.22.4`）
- 传递依赖：supersplat-viewer 同级解析到 `2.22.4`（单版本，`pnpm why playcanvas` 确认唯一）
- 其他版本（legacy，仅 `apps/xr-viewer` 与 `splat-transform` peer 使用）：`playcanvas@2.22.0` —— 不属于生产 runtime 路径，SSV-09 随 legacy 清理评估

**迁移期间禁止升级**：SSV-00 ～ SSV-10 完成前，`@playcanvas/supersplat-viewer` 与 `playcanvas` 锁死（`ADR_SUPERSPLAT_RUNTIME.md`「固定版本」行）。

---

## CURRENT VIEWER ARCHITECTURE

三套 Runtime 并存，能力大面积重复：

| Runtime | 位置 | 渲染 | 说明 |
|---|---|---|---|
| Legacy fork | `apps/viewer` | WebGPU-only（`deviceTypes:['webgpu']`、`xrCompatible:false`） | SuperSplat **Editor** 派生；Desktop 场景页 iframe 加载 |
| Legacy standalone | `apps/xr-viewer` | PlayCanvas Engine 直写 + WebXR（`playcanvas@2.22.0`，无 supersplat） | 自带 collision / locomotion / annotation / audio / viewpoint |
| **官方（生产）** | `apps/web/src/xr/` + `apps/web` | WebGPU Desktop · **WebGL XR**（强制 `renderer:'webgl'`） | `@playcanvas/supersplat-viewer@1.35.0`；`XRViewerRuntime.ts` 是 SSV-02 基线 |

### 功能分布表

| 功能 | 当前实现位置 | 是否重复官方 Viewer | 迁移阶段 | 最终去留 |
|---|---|---|---|---|
| Desktop rendering | `apps/viewer` fork（WebGPU）；`apps/web/src/platform/ViewerAdapter.ts`（iframe+postMessage）；`apps/web/src/features/viewer/useViewerLifecycle.ts` | 重复 | SSV-03 | 官方 runtime（`ViewerAdapter` 退役） |
| XR | 官方：`apps/web/src/xr/XRViewerRuntime.ts`（`createViewer({renderer:'webgl',ui:false})`）+ `XRViewerPage` / `XRTestPage`；legacy：`apps/xr-viewer` | 部分重复（legacy 路径） | SSV-04 | 官方 runtime 唯一 |
| camera | fork `apps/viewer/src/camera.ts`（orbit/fly）；官方 `frameScene()`/`createFrameCamera(bbox)` 已在 XR 页使用 | 重复 | SSV-03 / SSV-05 | 官方 camera |
| fullscreen | `apps/web/src/layouts/ViewerLayout.tsx`（`requestFullscreen()`）+「进入 VR」→ `/xr/:sceneId`；`ViewerBottomToolbar` 全屏按钮 | 不重复（web 层 UI，非渲染能力） | SSV-04（VR 入口统一） | 保留（web 层） |
| annotation | authoring：`apps/web/src/features/authoring/AnnotationPanel.tsx` + `services/annotationApi.ts` + API `scene_annotation`；runtime：legacy `apps/xr-viewer/src/interaction.ts`；官方路径当前传空 `annotations:[]` | 重复（legacy runtime vs 官方 annotation runtime） | SSV-06 | 官方 runtime；Annotation 数据留 GSPlatform |
| background | authoring：`BackgroundPanel.tsx` + `presentationApi` `/presentation/background`；Desktop：`ViewerAdapter.setBackground` → fork `equirect-renderer.ts`；XR 页固定黑背景 | 重复 | SSV-05 | 官方 settings（Experience Settings v2） |
| skybox | fork `apps/viewer/src/equirect-renderer.ts`（等距柱状背景）；官方 `skybox` 符号存在但未接线 | 重复 | SSV-05 | 官方 skybox |
| audio | authoring：`BackgroundMusicPanel.tsx` + `presentationApi`（`backgroundAudio*`）；runtime：legacy `apps/xr-viewer/src/{data-loader,interaction,xr-app}.ts`；fork `pc-app.ts` Audio 全注释 | 重复 | SSV-06 | 官方 audio runtime；数据留 GSPlatform |
| collision | 数据/API：`apps/api/app/services/collision.py`、`api/v1/collision.py`、`models/collision_asset.py` + authoring `CollisionPanel.tsx`；runtime：legacy `apps/xr-viewer/src/collision-raycaster.ts`；fork `embed.ts` 仅记录状态（无物理） | 重复 | SSV-07 | 官方 collision runtime；数据留 GSPlatform |
| walk | legacy `apps/xr-viewer/src/locomotion.ts`（walk/teleport/gravity）；fork camera 仅 fly；官方 `toggleWalk` 存在未接线 | 重复 | SSV-07 | 官方 walk |
| LOD | fork `apps/viewer/src/platform/loading/LodSwitcher.ts` / `LodSelector.ts`（progressive loading）；官方 `lod-*` 未接线；XR 页拒绝流式 | 重复 | SSV-08 | 官方 LOD runtime |
| streaming | fork `apps/viewer/src/platform/streaming/StreamedSogLoader.ts` / `ResidencyManager.ts` / `StreamScheduler.ts`；API / `ADR-0001-streamed-sog-format.md`；官方 `streamedSog` 未接线 | 重复 | SSV-08 | 官方 streamed SOG runtime |
| splat budget | fork `apps/viewer/src/projected-splat-renderer.ts` 等；官方 `splatBudget` 未接线 | 重复 | SSV-08 | 官方 splat budget |
| performance mode | `apps/web/src/features/viewer/PerformancePanel.tsx` + `QualityPanel.tsx`（调 fork 质量参数） | 重复 | SSV-05 / SSV-08 | 官方 perf settings + web UI 保留 |

关键结构事实（均经源码确认）：

- `apps/viewer` 无任何 XR 能力：`main.ts:129,133` 与 `embed.ts:109,113` 硬编码 `deviceTypes:['webgpu']` / `xrCompatible:false`；`pc-app.ts` 中 `XrManager`、Audio 系统全部注释。
- 官方 viewer 的 `dist/viewer.js` 确认存在 `startXR` / `toggleWalk` / `collision` / `splatBudget` / `skybox` / `audio` / `lod-*` / `streamedSog` —— 即仓库 fork 中重复实现的能力官方全部内置。
- 官方 XR 强制 WebGL 的理由（源码确认）：WebGPU 下 `startXR` 抛 `startXR: reload with WebGL to start this session`。

---

## DUPLICATED FEATURES

上表 14 项中，**10 项与官方 Viewer 重复**（Desktop rendering、camera、annotation runtime、background、skybox、audio、collision、walk、LOD、streaming、splat budget、performance mode —— 其中 background/performance 为配置面）。fullscreen 属 web 层 UI 不重复；XR 官方路径为正确基线。

---

## FROZEN DIRECTORIES

| 目录 | 状态 | 依据 |
|---|---|---|
| `apps/viewer` | **LEGACY / FROZEN**（不删除） | `ADR_SUPERSPLAT_RUNTIME.md` |
| `apps/xr-viewer` | **LEGACY / FROZEN**（不删除） | `ADR_SUPERSPLAT_RUNTIME.md` |

冻结范围：不新增生产 Viewer 功能；允许维持现状构建；SSV-09 前不清理。

---

## ADR

创建：`docs/adr/ADR_SUPERSPLAT_RUNTIME.md`

要点：
- `@playcanvas/supersplat-viewer` = 唯一生产 Scene Runtime（职责边界表）。
- `apps/viewer` / `apps/xr-viewer` = LEGACY / FROZEN。
- Desktop 与 XR 均用官方 runtime，XR 强制 WebGL。
- Authoring 数据流唯一方向：Authoring UI → GSPlatform DB → Experience Adapter → Experience Settings v2 → Viewer。
- 禁止 fork 实现 XR / walk / collision / annotation / LOD / skybox（除非新 ADR）。

迁移总计划：`docs/SSV_MIGRATION_PLAN.md`（SSV-00 ～ SSV-10 顺序 FROZEN）。

---

## TESTS

执行（`apps/web`）：

| 命令 | 结果 |
|---|---|
| `pnpm --filter @gsplatform/web test` | **PASS** — 13 files / **133 tests** |
| `pnpm --filter @gsplatform/web lint` | **PASS** — 0 error（仅 warning，预存在 authoring 文件） |
| `pnpm --filter @gsplatform/web build` | **BLOCKED（预存在基线，非本阶段引入）** — `tsc -b` 阶段 13 error，vite 未运行 |
| `cd apps/web && npx vite build`（单独验证打包） | **PASS** — built in 3.16s，supersplat-viewer 正确打包（仅 chunk-size warning） |
| `pnpm --filter @gsplatform/web typecheck` | **13 error / 6 files，全部预存在**（与 `WEBXR_REPAIR_REPORT.md` 记录一致） |

## KNOWN BASELINE ERRORS

typecheck 基线 **13 errors / 6 files**（全部与 SSV-00 无关，按规则禁止本阶段修复）：

| 文件 | 数量 | 类型 |
|---|---|---|
| `src/__tests__/progressive-loading.test.ts` | 2 | TS2739 mock `ViewerHandle` 缺 `pickWorldPosition`/`getCollisionState` |
| `src/__tests__/viewer.test.tsx` | 2 | TS2739 / TS1360 mock `ViewerHandle` 缺成员 |
| `src/features/authoring/AnnotationPanel.tsx` | 4 | TS6133 未使用导入/参数 |
| `src/features/authoring/BackgroundMusicPanel.tsx` | 3 | TS6133 / TS2607 / TS2786 `Text` JSX 组件 |
| `src/features/authoring/CollisionPanel.tsx` | 1 | TS6133 `Link` 未使用 |
| `src/pages/SceneAuthoringPage.tsx` | 1 | TS6133 `handleBackgroundMusicUpdated` 未使用 |

影响：`pnpm build`（`tsc -b && vite build`）被阻塞；`npx vite build` 单独可过。这些错误分别归属 SSV-03（`ViewerHandle` mock）与 SSV-05/06（authoring 面板）处理。

## NEXT PHASE

**SSV-01 — Runtime Contract**：定义官方 runtime 契约（GSPlatform → Viewer settings/commands 面），契约类型定义 + 单元测试。

禁止进入 SSV-01 之前对 Viewer 做任何功能迁移。顺序见 `docs/SSV_MIGRATION_PLAN.md`。
