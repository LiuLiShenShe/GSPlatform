# SSV_02_REPORT：Official SuperSplat Runtime Wrapper

- 日期：2026-09-28
- 阶段：SSV-02 — Official Runtime Wrapper
- 前置：`docs/reports/SSV_01_REPORT.md` RESULT = PASS ✓
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0`（基于其真实 `viewer.d.ts` / `settings.d.ts` / package exports 实现，未 fork、未复制官方源码）

---

## RESULT

**PASS**

- `apps/web/src/scene-runtime/` 新增统一 `SuperSplatRuntime`（唯一官方 runtime 封装层），Desktop/XR 后续必须经过此层。
- 官方 API 用法全部来自锁定版本实际类型：`createViewer(options: CreateViewerOptions)`、`ViewerHandle`（state/events/frameScene/resetCamera/toggleWalk/selectAnnotation/setMoveInput/startXR/requestFullscreen/destroy）、`defaultSettings()` / `validateSettings()`（`@playcanvas/supersplat-viewer/settings`）。
- Renderer Policy 固定：`RuntimeMode='desktop'` → renderer 不传（官方默认 webgpu + 自动 fallback WebGL）；`RuntimeMode='xr'` → `renderer:'webgl'`。
- Experience Adapter V1：`buildExperienceSettings(descriptor)` 用官方 `defaultSettings()` 起底，最低映射 background color / initial camera（fov clamp 进官方 authoring 界），产物通过官方 `validateSettings(settings, { limits: true })`。
- 新增开发路由 `/runtime-test/:sceneId`；实测真实场景 Gaussian 可见（见下）。
- 测试：wrapper + adapter 18 项全过；web 全量 **161 passed**（143+18）；typecheck 保持基线 13（新文件 0）；vite build PASS。

## 新增文件

| 文件 | 内容 |
|---|---|
| `apps/web/src/scene-runtime/SuperSplatRuntime.ts` | 统一封装：`create/destroy`、`frameScene/resetCamera`、`requestFullscreen/exitFullscreen`、`startVR/startAR/endXR`、`toggleWalk`、`selectAnnotation/clearAnnotation`、`setMoveInput`、state getter 全集、`onLoaded/onProgress/onXRModeChanged/onSelectedAnnotationChanged/onCameraModeChanged`（均返回 unsubscribe）、`rendererForMode`、`runtimeRenderer`/`renderedSplatCount` 诊断助手 |
| `apps/web/src/scene-runtime/experienceAdapter.ts` | `buildExperienceSettings(descriptor)` + fov clamp（`CAMERA_FOV_RANGE`） |
| `apps/web/src/scene-runtime/runtimeErrors.ts` | `SuperSplatRuntimeError(kind: NOT_CREATED/DESTROYED/NOT_LOADED)` |
| `apps/web/src/pages/RuntimeTestPage.tsx` | `/runtime-test/:sceneId` smoke 页 |
| `apps/web/src/app/router.tsx` | 注册 `/runtime-test/:sceneId` |
| `apps/web/src/__tests__/super-splat-runtime.test.ts` | 18 项测试 |

## 关键实现事实（基于官方 1.35.0 类型）

- **createViewer 参数名**：`{ container, contentUrl, contentFilename?, settings, posterUrl?, collisionUrl?, renderer?, ui }` —— 全部对齐官方 `CreateViewerOptions`（`ViewerAssets & ViewerFlags`）。
- **Renderer Policy**：`rendererForMode('desktop') → undefined`（官方默认 `webgpu`，引擎在 WebGPU 不可用时自动 fallback WebGL —— 即任务要求的 “auto”）；`rendererForMode('xr') → 'webgl'`。XR 禁止默认走 WebGPU。
- **事件封装**：`subscribe(key)` 绑定官方 `<key>:changed`，返回 unsubscribe；`destroy()` 先摘掉本层全部 listener 再调官方 `handle.destroy()` —— 无残留。
- **官方 throw 原样传播**：`frameScene()` 等在 `state.loaded` 之前调用会抛官方错误（wrapper 不吞不包装）；wrapper 只负责 `DESTROYED` 状态错误。
- **类型注意**：`AppBase` / `CameraMode` 未从 `/viewer` 子路径导出，改用 `ViewerHandle['app']` / `ViewerState['cameraMode']` 推导，避免猜类型。

## Experience Adapter V1

- 基底：官方 `defaultSettings()`（返回新对象，可安全 mutate）。
- background color：descriptor.presentation.background.color（0..1 RGB）→ `settings.background.color`。
- initial camera：`presentation.initialCamera.{position,target,fov}` 同时存在才映射 → `settings.cameras[0].initial`；fov 用官方 `CAMERA_FOV_RANGE` clamp；否则保留官方 default 相机。
- 本阶段不映射：soundUrl / annotations / animTracks（保持官方默认）。
- collision 独立传递：`ViewerAssets.collisionUrl`（不进 settings）。
- 每个产物都过 `validateSettings(settings, { limits: true })`（测试证明）。

## Smoke 页实测（§十）

`/runtime-test/r-8c4e2264e86a`（真实场景，Playwright headless + SwiftShader，web dev :5173 + API :8001）：

```
sceneId     r-8c4e2264e86a
contentUrl  /local-scenes/r-8c4e2264e86a/versions/b2cc7bb1594d/lod-meta.json
format      lod-meta
renderer    webgl2          ← headless 无 WebGPU，官方自动 fallback（desktop “auto”）
loaded      true
progress    100%
gsplats     179             ← > 0，与 lod-meta counts[0]=179 一致，Gaussian 可见
cameraMode  orbit
```

- 网络取证：`lod-meta.json` + `2_0/*` + `0_0/*` 全部 HTTP 200，无 failed request。
- 控制台：`SuperSplat Viewer v1.35.0 | Engine v2.22.4`；headless 下 WebGPU “No available adapters” → 官方正确回退 WebGL2（即 desktop auto 语义被真实证明）。
- 截图存证：`/tmp/ssv02-runtime-test.png`。
- 注：流式低 LOD 首次进入渲染循环有少量延迟，轮询读到 0 是取样时机问题；稳定等待后读数 179。

## TESTS

- wrapper 测试 18 项（`super-splat-runtime.test.ts`）：
  - Experience settings valid（真实 `validateSettings({limits:true})`）
  - desktop 选择 auto（createViewer 的 renderer 为 undefined）
  - xr 选择 webgl
  - create 时 contentUrl/settings/collisionUrl/posterUrl/ui 正确传递
  - destroy 幂等（官方 destroy 仅一次）
  - destroy 后 state/动作抛 `SuperSplatRuntimeError(DESTROYED)`
  - unsubscribe 后不再收事件
  - destroy 后触发事件不回调（listener 不残留）
  - onProgress / onSelectedAnnotationChanged 用对应 key
  - frameScene 未加载时抛错（官方契约传播）、加载后可调用
  - selectAnnotation/clearAnnotation/toggleWalk/setMoveInput/startVR/startAR/endXR/requestFullscreen/exitFullscreen 转发
  - descriptor.content.url → contentUrl 映射
  - state 快照读取
- 运行结果：`pnpm --filter @gsplatform/web test super-splat-runtime` → **18 passed**；web 全量 → **161 passed**；`lint` → 0 error（仅预存在 warning）；`typecheck` → **13（SSV-00 基线，新文件 0）**；`npx vite build` → **PASS**（3.04s）。`pnpm build` 仍被基线 13 个预存在 typecheck 错误阻塞（authoring 文件，SSV-00 已记录，非本阶段引入）。

## NEXT PHASE

**SSV-03 — Desktop Migration**：Desktop 从 iframe fork 切到官方 runtime（以 `getSceneRuntime → buildExperienceSettings → SuperSplatRuntime` 为唯一数据/渲染路径；`ViewerAdapter` 退役）。

顺序见 `docs/SSV_MIGRATION_PLAN.md`。
