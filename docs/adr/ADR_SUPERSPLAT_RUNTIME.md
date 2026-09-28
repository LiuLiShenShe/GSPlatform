# ADR_SUPERSPLAT_RUNTIME：GSPlatform 生产 Scene Runtime 冻结为官方 SuperSplat Viewer

- 状态：ACCEPTED（FROZEN — 不接受重新讨论）
- 日期：2026-09-28
- 阶段：SSV-00（SuperSplat Viewer 迁移 · 架构冻结与基线审计）
- 决策人：项目负责人
- 固定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（SSV-00～SSV-10 完成前禁止升级）

---

## Decision

`@playcanvas/supersplat-viewer` 是 GSPlatform **唯一的生产 Scene Runtime**。

### 目录状态

| 目录 | 状态 | 说明 |
|---|---|---|
| `apps/viewer` | **LEGACY / FROZEN** | SuperSplat **Editor** 派生 fork（WebGPU-only）。不得继续增加任何生产 Viewer 功能。本阶段不删除。 |
| `apps/xr-viewer` | **LEGACY / FROZEN** | 基于 PlayCanvas Engine 直接构建的独立 WebXR viewer（`playcanvas@2.22.0` 直接依赖，不使用 supersplat-viewer）。同样冻结。本阶段不删除。 |

两个目录在 **SSV-09 Legacy Cleanup** 才允许清理；SSV-00～SSV-08 期间只允许维持现状（构建 / 修复阻断性缺陷），不允许新增功能。

### 渲染路径

- **Desktop** → 官方 SuperSplat Viewer（WebGPU 优先，官方自行回退 WebGL）。
- **XR** → **同一个**官方 SuperSplat Viewer，**强制 WebGL**。
  理由（已由源码确认，见 `docs/reports/WEBXR_REPAIR_REPORT.md` §2）：官方 supersplat-viewer 的 `createViewer()` 在 `useWebGPU` 时设 `deviceTypes:['webgpu']`，且 `startXR` 在 WebGPU 下抛 `startXR: reload with WebGL to start this session`。因此 XR 路径必须以 `renderer: 'webgl'` 创建 runtime。
  现状实现：`apps/web/src/xr/XRViewerRuntime.ts`（`createViewer({ renderer: 'webgl', ui: false, settings })`）—— 这是 SSV-02 官方 wrapper 的基线，保留并继续演进。

### Authoring 数据流（唯一方向）

```text
GSPlatform Authoring UI
  → GSPlatform DB
  → Experience Adapter
  → Experience Settings v2
  → Viewer（官方 supersplat-viewer settings）
```

GSPlatform 侧只负责业务数据与配置产出；渲染层的能力（相机、annotation、skybox、collision、LOD 等）由官方 Viewer 解释 Experience Settings v2 后自行执行。GSPlatform **不得**在 iframe / fork 内实现渲染行为。

### 职责边界

| 归属 GSPlatform | 归属官方 SuperSplat Viewer |
|---|---|
| 用户 | Gaussian rendering |
| 登录 / 权限 | WebGPU Desktop |
| 上传 | WebGL |
| Scene | WebXR |
| Works | camera |
| Reconstruction | orbit / fly / walk |
| Assets | annotation runtime |
| Presentation | animation |
| Annotation 数据 | skybox |
| Collision 数据 | post effects |
| Background Audio | collision runtime |
| Share | streamed SOG / LOD runtime |
| 农业数字孪生业务 | splat budget |
| Authoring UI | |
| API | |
| Storage / CDN | |

注意「Annotation 数据 / Collision 数据」归 GSPlatform（数据与 authoring），而「annotation runtime / collision runtime」归官方 Viewer（渲染与交互执行）。

---

## 背景

1. 仓库当前同时存在**三套** Scene Runtime，能力大面积重复：
   - `apps/viewer`：SuperSplat Editor fork，WebGPU-only，XR 被显式关闭（`apps/viewer/src/main.ts:129,133` 与 `apps/viewer/src/embed.ts:109,113`：`deviceTypes:['webgpu']`、`xrCompatible:false`；`pc-app.ts` 的 `XrManager` / Audio 系统全部注释）。
   - `apps/xr-viewer`：PlayCanvas Engine 直写的独立 XR viewer，自带 collision raycaster、locomotion、annotation 交互、audio、viewpoint。
   - `apps/web/src/xr`：官方 supersplat-viewer 的 WebGL XR wrapper（Phase 13/14 + WebXR 修复轮的正确产物）。
2. 官方 supersplat-viewer@1.35.0 已内置本项目重复实现的全部能力（已在安装的 `dist/viewer.js` 中确认符号存在）：`startXR`、`toggleWalk`、`collision`、`splatBudget`、`skybox`、`audio`、`lod-*`、`streamedSog`。继续维护 fork 属于纯粹的技术债，且已导致「Desktop 无法 XR」这类结构性缺陷（fork 路径被裁剪成 WebGPU-only）。
3. 官方 viewer 的 WebXR 支持在软件层已验证可用（`SuperSplat Viewer v1.35.0 | Engine v2.22.4`，页面状态机 / `xrMode` 同步 / 场景自动取景均通过测试与 Playwright 验证）。真实头显硬件验证因环境无 Quest / PICO / OpenXR runtime 尚未执行（见 `docs/reports/WEBXR_REPAIR_REPORT.md` §6、§8，诚实记录 PARTIAL，不伪造 PASS）。

---

## 明确禁止事项

除非官方明确无法提供所需能力**且**经过新的 ADR 批准，**禁止**未来重新 fork Viewer（`apps/viewer` 或任何 supersplat 副本）来实现以下任何一项：

- XR
- walk
- collision
- annotation
- LOD
- skybox

同样禁止把渲染能力实现在 iframe / postMessage 层或 `apps/web` 侧的自研渲染代码中。

---

## 后果

**正面**
- 三套 runtime 收敛为一套，渲染行为与官方一致，减少分叉维护。
- 官方升级（SSV-10 之后）可直接获得 XR / walk / collision / LOD / splat budget 的修复。
- 农业数字孪生业务特性全部留在 GSPlatform 侧，边界清晰。

**负面 / 风险**
- 迁移期（SSV-00～SSV-08）Desktop 仍需同时维护 legacy fork 路径，直到 SSV-03 完成。
- 现有 `ViewerAdapter` 的 iframe + postMessage 契约（`apps/web/src/platform/ViewerAdapter.ts`）在 SSV-03 被官方 runtime 取代，接口会变；依赖该契约的测试（`viewer.test.tsx`、`progressive-loading.test.ts`）需在 SSV-03 一并重写。
- 官方 settings（Experience Settings v2）表达能力与现有 `SceneDescriptor` 不同步，是 SSV-05 的主要工作量。
- 官方 supersplat-viewer 尚不支持（或需额外配置）GSPlatform 现有的部分 streamed-sog 约定，`docs/decisions/ADR-0001-streamed-sog-format.md` 与官方 streaming runtime 的对接是 SSV-08 的风险点。

**版本冻结**
- SSV-00～SSV-10 全部完成前，禁止升级 `@playcanvas/supersplat-viewer` 与 `playcanvas`。
- `apps/web/package.json` 中这两个依赖已改为精确版本（`1.35.0` / `2.22.4`），`pnpm-lock.yaml` 同步，CI `--frozen-lockfile` 不会静默漂移。
- 任何版本变更必须先更新本 ADR 的「固定版本」行。

---

## 参考

- `docs/SSV_MIGRATION_PLAN.md` — SSV-00 ～ SSV-10 迁移总计划（顺序固定）
- `docs/reports/SSV_00_REPORT.md` — SSV-00 阶段报告与基线
- `docs/reports/WEBXR_REPAIR_REPORT.md` — 官方 viewer WebXR 路径来源审计
- `docs/decisions/ADR-0001-streamed-sog-format.md` — 流式 SOG 格式决策
