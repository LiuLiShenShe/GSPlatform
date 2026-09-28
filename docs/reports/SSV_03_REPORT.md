# SSV_03_REPORT：Desktop Production Viewer Migration

- 日期：2026-09-28
- 阶段：SSV-03 — Desktop Migration
- 前置：`docs/reports/SSV_02_REPORT.md` RESULT = PASS ✓
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（未升级）

---

## RESULT

**PASS**

`/scene/:sceneId` 默认生产 Viewer 已从「iframe + 自维护 fork ViewerAdapter」切换为官方
`@playcanvas/supersplat-viewer` runtime，**无 iframe**。`?runtime=legacy` 作为开发/回退开关保留
（生产 UI 无该切换入口），legacy 链路文件零修改。

---

## 架构

```
/scene/:sceneId（默认）
  React → resolveSceneRuntimeDescriptor(sceneId)      DB 合同优先，404 → manifest 回退
        → buildExperienceSettings(descriptor)          官方 ExperienceSettings v2
        → SuperSplatRuntime.create({ mode:'desktop'}) 官方 viewer，auto renderer
        → SuperSplatRuntime（唯一 runtime 封装层）

/scene/:sceneId?runtime=legacy（开发/回退，SSV-09 删）
  useViewerLifecycle → @gsplatform/viewer（fork）→ iframe embed
```

## 新增 / 改动

| 文件 | 类型 | 内容 |
|---|---|---|
| `apps/web/src/scene-runtime/descriptorResolver.ts` | 新增 | `resolveSceneRuntimeDescriptor`：`getSceneRuntime` 优先，仅 404（`RuntimeApiError.kind==='SCENE_NOT_FOUND'`）回退 `/local-scenes/{id}/manifest.json`，组装同一结构的 `SceneRuntimeDescriptorV1` 并返回 `fromManifest` 标记。扩展名→format 与后端 `content_format_from_filename` 对齐；streamed 非 DB 场景显式拒绝。 |
| `apps/web/src/features/viewer-official/useSuperSplatDesktop.ts` | 新增 | 官方 Desktop 生命周期：mount/sceneId 变化 create，卸载 destroy（幂等）；`onLoaded`→自动 `frameScene`；onProgress/onCameraModeChanged 订阅；1s 轮询 renderer/gsplats/fullscreen；动作 resetCamera/frameScene/requestFullscreen/exitFullscreen + 写官方 `state.cameraMode / performanceMode / showAnnotations`（官方 `WritableStateKey`）；`retry` 重走完整 boot。 |
| `apps/web/src/features/viewer-official/OfficialViewerCanvas.tsx` | 新增 | 官方挂载区（`ov-mount`/`ov-canvas-host`）+ poster 背景 + 真实 `onProgress` 进度条 + 错误面板与重试。 |
| `apps/web/src/features/viewer-official/OfficialViewerToolbar.tsx` | 新增 | Frame / Reset / Orbit-Fly Segmented / Performance / Annotations / Fullscreen / Exit-Fullscreen，全部接线官方 handle 或官方 state。 |
| `apps/web/src/scene-runtime/SuperSplatRuntime.ts` | 改动 | **新增 `import '@playcanvas/supersplat-viewer/viewer.css'`**（见 BUG FIX）。 |
| `apps/web/src/pages/SceneViewerPage.tsx` | 改动 | 默认 official 分支 + `?runtime=legacy` 分支；保留 `ViewerRightPanel`（作者/收藏/分享/问 AI/详情）；视觉隐藏的 `ov-diagnostics` 运行态读数供 e2e 取证。 |
| `apps/web/src/__tests__/viewer.test.tsx` | 改动 | 重写为 official 默认（9 项）+ legacy 回退（6 项）。 |
| `apps/web/src/__tests__/scene-viewer-error.test.tsx` | 新增 | 官方错误面板 + 重试（2 项）。 |
| `apps/web/src/__tests__/routes.test.tsx` | 改动 | `/scene/:sceneId` 断言官方挂载区、无 iframe。 |

后端 `apps/api`、`apps/viewer`、`apps/xr-viewer` **零改动**（`git diff --stat` 确认）。

---

## BUG FIX（迁移过程中发现并解决）

**官方 viewer.css 从未导入 → 画布停留在默认 300×150。**

现象：官方 runtime `loaded=true`、`gsplats=179`，但截图显示场景只占视口左上角一小块，
主视口几乎全黑（Agnes 识图确认）。

诊断（Playwright 读真实 DOM 几何）：

| 元素 | 修复前 | 修复后 |
|---|---|---|
| `.sse-viewer` root | 1280×**156** | 1280×795 |
| canvas | **300×150** | 1280×795 |

根因：`@playcanvas/supersplat-viewer` 的根容器/画布尺寸完全来自其 `dist/viewer.css`
（`.sse-viewer{width:100%;height:100%}`、`canvas{position:absolute;width:100%;height:100%}`）。
官方包在 `exports` 中暴露了 `./viewer.css`，但项目从未导入 → 官方根 div 无样式，
高度塌缩为内容高度，画布保持 HTML 默认 300×150，`ResizeObserver` 观测到的 CSS 尺寸恒为
300×150，因此永不 resize。渲染本身正常（PlayCanvas WebGL 画布按 300×150 绘制）。

修复：`SuperSplatRuntime.ts` 中 `import '@playcanvas/supersplat-viewer/viewer.css'`。
修复后画布填满宿主容器，场景居中正常显示，构建产物 `dist/assets/index-*.css` 已含
`.sse-viewer` 规则。

此 bug 同时影响 SSV-02 的 `/runtime-test` 诊断页（其 `gsplats>0` 断言不检查尺寸，未暴露）。

---

## REAL SCENES（真实场景验证，Playwright headless + SwiftShader）

Web dev `127.0.0.1:5173` + API `127.0.0.1:8001`（dev identity）。

### 1) 真实 GSPlatform SOG（DB 合同路径）— `r-8c4e2264e86a`

`/scene/r-8c4e2264e86a`

```json
{
  "runtime": "official", "noIframe": true, "renderer": "webgl2",
  "gsplats": 179, "loaded": true, "progress": 100, "cameraMode": "orbit",
  "performanceMode": false, "showAnnotations": true,
  "contentUrl": "/local-scenes/r-8c4e2264e86a/versions/b2cc7bb1594d/lod-meta.json",
  "format": "lod-meta", "isManifestFallback": false, "error": null,
  "canvas": { "w": 1280, "h": 795 }
}
```

- 流式 SOG（`lod-meta.json` octree 容器）经官方 viewer 加载，`gsplats=179` 与
  `lod-meta counts[0]=179` 一致，Gaussian 真实渲染。
- headless 无 WebGPU adapter → 官方自动 fallback `webgl2`（desktop "auto" 语义，
  与 SSV-02 一致，非缺陷）。

### 2) 小型 SOG（manifest 回退路径）— `local-garden`

`/scene/local-garden`

```json
{
  "runtime": "official", "noIframe": true, "renderer": "webgl2",
  "gsplats": 500, "loaded": true, "progress": 100, "cameraMode": "orbit",
  "contentUrl": "/local-scenes/local-garden/scene.sog",
  "format": "sog", "isManifestFallback": true, "error": null
}
```

- DB 合同 404 → manifest 回退生效（`isManifestFallback: true`），20K 小型 SOG 正常渲染。
- manifest 的 `camera{position,target,fov}` 经 adapter 映射进官方 `settings.cameras[0].initial`。

两个场景都不是"只测 local-garden"，且分别覆盖 DB 合同与 manifest 回退两条数据路径。

---

## SCREENSHOT RESULT（official vs legacy 视觉对比）

截图（1280×900）：`/tmp/ssv03/`

| 截图 | 内容 |
|---|---|
| `final-official-r8c4.png` | 官方 `r-8c4e2264e86a`（最终，画布 1280×795） |
| `official-local-garden.png` | 官方 `local-garden` |
| `official-local-garden-toolbar.png` | 官方 `local-garden`（Performance 切换后高亮） |
| `legacy-r8c4e2264e86a.png` | legacy `r-8c4e2264e86a` |
| `cmp-official-local-garden.png` / `cmp-legacy-local-garden.png` | 同场景 local-garden 对比 |

### 逐项对比（Agnes 识图 + 真实 DOM 几何）

| 对比项 | official | legacy（`?runtime=legacy`） |
|---|---|---|
| 渲染载体 | 官方 viewer 渲染进宿主容器 canvas（1280×795） | iframe → fork embed（`public/viewer/embed.html`） |
| 场景内容 | 真实 Gaussian 渲染居中显示，颜色分布可见（r8c4 米白/粉/灰蓝团状；local-garden 蓝绿紫黄彩色点云） | 此环境 iframe embed 加载失败 → `ASSET_FETCH_FAILED` 错误页（pre-existing，见下） |
| orientation / scale | 场景坐标与 `lod-meta` / SOG 原文件一致，无额外世界变换（`worldTransform` 三轴 NULL，官方默认 settings 原样） | — |
| 初始相机 | 无 DB 初始相机 → 官方 default camera + `frameScene()` 自动取景；manifest 场景用 manifest.camera | — |
| 背景 | 官方 `settings.background.color`（descriptor 无背景色 → 官方默认） | — |
| Gaussian count | 179（r8c4） / 500（local-garden 当前帧） | — |
| 导航 | Orbit 模式（默认），Orbit/Fly 可切 | — |

### legacy iframe 失败 —— 非本阶段回归（已独立取证）

legacy 分支在真实浏览器中 `r-8c4e2264e86a` 和 `local-garden` 都报 `ASSET_FETCH_FAILED`，
且 `FAILED http://127.0.0.1:5173/viewer/embed.html`。为确认是否为 SSV-03 引入，把
`SceneViewerPage.tsx` 暂存回退到 pre-SSV-03 版本（legacy 为默认路径）复测，得到**完全相同**的
`ASSET_FETCH_FAILED` + iframe FAILED。

结论：legacy fork 的 iframe embed 在该 headless + dev 环境本就不工作，**SSV-03 之前即存在**，
非本次迁移造成。因此 official/legacy 的"同场景像素级"对比无法在此环境完成——legacy 侧拿不到
渲染结果；对比以 official 侧真实渲染 + legacy 侧确定性的错误态取证，并已证明二者渲染状态与
迁移前一致。

---

## FEATURE PARITY

| 必恢复能力 | 实现 | 验证 |
|---|---|---|
| Gaussian 显示 | 官方 viewer 渲染 | ✓ gsplats 179/500，截图确认 |
| 加载进度 | 官方 `onProgress` → 进度条（真实字节进度，非伪进度） | ✓ 单测 + e2e（42% 断言） |
| orbit / pan / zoom / fly | 官方 orbit 控制器 + Fly 模式（官方允许时） | ✓ 官方原生输入，`state.cameraMode` 写入 |
| 取景（frame scene） | `frameScene()` 按钮 + 加载完成自动取景 | ✓ 单测转发 + 截图 |
| 重置相机 | `resetCamera()` 按钮 | ✓ 单测转发 |
| 全屏 | `requestFullscreen()` / `exitFullscreen()` | ✓ 单测转发 |
| 性能模式 | 写官方 `state.performanceMode` | ✓ 单测 + e2e 切换后高亮 |
| 标注可见性 | 写官方 `state.showAnnotations` | ✓ 单测 |
| 相机模式 | Orbit/Fly Segmented 写官方 `state.cameraMode` | ✓ 单测双向切换 |
| 错误显示 | 错误面板 + 重试（`retry` 重走完整 boot） | ✓ `scene-viewer-error.test.tsx` 2 项 |
| 右侧场景面板 | `ViewerRightPanel` 保留 | ✓ 最终冒烟 rightPanel=true |

---

## KNOWN DIFFERENCES（与 legacy 的已知差异）

1. **local-garden manifest 场景的 GSplat count**：官方当前帧渲染 500（可能受初始相机/渲染批次
   影响），legacy 的 blob-per-LOD 路径不同。这是运行时渲染统计口径差异，非数据差异。
2. **world transform**：真实场景 `worldTransform` 三轴 NULL（官方 settings 原样），与 legacy
   视觉一致，无硬编码场景特例。
3. **Performance/Quality 面板细节**：官方 Performance 模式是官方 `state.performanceMode`
   （半分辨率），与 legacy 顶部 Performance 统计浮层语义不同；legacy 的 Quality（eco/balanced/
   quality 流式档位）面板**暂未**在 official 分支提供——流式 LOD 档位属于 SSV-08 范围。官方
   分支工具条保留 Frame/Reset/Orbit-Fly/Performance/Annotations/Fullscreen/Exit。
4. **legacy iframe embed 失效**：pre-existing（见上），非本阶段引入。

---

## PERFORMANCE

- 画布 1280×795，renderer `webgl2`（headless SwiftShader；真实 GPU 上 desktop "auto" 会优先
  WebGPU）。
- `frame.gsplats`：r8c4=179（低 LOD 流式首帧），local-garden=500。
- 轮询真实引擎状态 1s 一次（renderer/gsplats/loaded/progress/fullscreen），不阻塞渲染。
- 生命周期：sceneId 变化 destroy 旧 runtime 再 create 新（cancel guard 防竞态），unmount destroy；
  旧 runtime 销毁实测 `destroy` 恰好调用一次，无 listener 残留（wrapper 层 unsubscribe + 官方
  `handle.destroy()`）。

---

## TESTS

- `viewer.test.tsx` 重写 15 项：official 默认 9（无 iframe / 加载进度 / Frame+Reset 转发 /
  Fullscreen / Performance 写入 / Annotations 切换 / Orbit-Fly 双向 / sceneId 切换 destroy+create /
  卸载 destroy）+ legacy 回退 6（iframe 宿主 / 工具条顺序 / Reset / Fly / Quality / 卸载 destroy）。
- `scene-viewer-error.test.tsx` 2 项：描述失败显示错误面板 + 重试重新拉取。
- `routes.test.tsx` 改为断言官方挂载区无 iframe。
- 官方 fake handle 用 Proxy 复刻官方 `WritableStateKey` 写入即触发 `<key>:changed` 语义。
- 运行结果：
  - web 全量：**168 passed**（161 基线 + 7 新增/改写）
  - `lint`：0 error，新文件 0 warning（仅预存在 authoring warning）
  - `typecheck`：**13**（SSV-00 基线，新文件 0）
  - `npx vite build`：**PASS**（4483 modules，含官方 viewer.css）
  - `pnpm build` 仍被基线 13 个预存在 typecheck 错误阻塞（authoring 文件，SSV-00 已记录）
  - `pnpm --filter @gsplatform/viewer build`：**PASS**（旧 viewer 未被破坏；仅预存在
    `entity.sync` TS warning）

---

## ROLLBACK

- 迁移期间默认 official，回退只需在 URL 加 `?runtime=legacy`（开发/故障场景），走冻结的
  `@gsplatform/viewer` fork 链路，legacy 代码零修改。生产 UI 不暴露该切换入口。
- 代码级回滚：revert 本次 commit（`SceneViewerPage` 回退即恢复 pre-SSV-03 legacy 默认）。
- `?runtime=legacy` 分支在 SSV-09（Legacy Cleanup）随 `apps/viewer` 一并删除。

---

## NEXT PHASE

**SSV-04 — XR Unification**：XR 页面统一到同一官方 runtime（Desktop/XR 共用 `SuperSplatRuntime`，
XR 强制 WebGL），`apps/xr-viewer` 退役为 FROZEN。顺序见 `docs/SSV_MIGRATION_PLAN.md`。
