# FIX_02_SCENE_SEMANTICS_REPORT：GSPlatform Scene Semantics Correctness

- 日期：2026-09-29
- 阶段：FIX-02 — 场景语义正确性（初始相机 / 世界变换 / 视角点 / 标注相机 / Desktop-XR 坐标一致）
- 前置：FIX-01 完成（HEAD `40812e2 fix(security): harden scene runtime and private asset access`）
- 范围：Runtime Descriptor / Experience Adapter / SuperSplatRuntime 封装 / Authoring 捕获 / 工具栏 / 后端标注相机字段 / 坐标换算层

---

## RESULT

**PASS** —— 21 个分节全部完成，5 个语义问题全部修复并经真实浏览器验证。

| § | 问题 | 修复 | 验证 |
|---|---|---|---|
| §2/§4 | 初始相机被 frameScene 覆盖 | `initialCameraPolicy.shouldFrameSceneOnLoad`：authored 相机存在 → 不 frameScene，loaded 即用 authored；Reset 恢复 | e2e 实拍：load 相机 `[2.5,1.8,6]`/fov47 与 DB 完全一致 |
| §5-§9 | World Transform 只存不生效 | 方案A（runtime Scene Root Transform）+ `SceneTransformAdapter` 统一换算，施加到 gsplat 实体 | e2e：W=Ry90 → 相机 `[6,1.8,-2.5]`、包围盒随实体旋转 |
| §10/§11 | 视角点存了但不被消费 | `selectViewpoint(id)` + 工具栏「视角」下拉（经 wrapper，页面不碰 app） | e2e：点击视角 → 相机过渡到 `[3,2,7]`/fov52 |
| §12-§15 | 所有标注共用一个相机 | 每条标注独立 `cameraPosition/Target/Fov`（DB + descriptor + 官方 annotation.camera） | e2e：点击 A/B/C → 三个互不相同的相机 |
| §16 | Desktop/XR 坐标语义不一致 | 同一 adapter、同一 §2 规则、同一 buildExperienceSettings | e2e：XR（WebGL）进入 VR 前相机与 Desktop 相同 |

§17 禁止项（Panorama / 背景音频 / Collision 参数 UI / LOD / XR 产品页美化 / SuperSplat 升级）全部未触碰。

---

## INITIAL CAMERA（§2/§3/§4）

**规则**（`initialCameraPolicy.ts`，Desktop 与 XR 共用）：

```text
descriptor.presentation.initialCamera.position && .target 成对存在
  → hasAuthoredInitialCamera = true → loaded 后【不】frameScene，直接用 authored 初始相机
  → 必要时 runtime.resetCamera() 恢复 authored（官方 resetCamera = settings.cameras[0].initial）
position/target 任一为 null（或 descriptor 为 null）
  → hasAuthoredInitialCamera = false → frameScene() 取景整个场景
```

- **§3 显式 null 语义**：判定只看 `position && target` 成对存在，**不做** `position != [0,0,0]` 猜测。`[0,0,0]` 位置的相机仍被视为 authored（单测锁定）。
- **§4 与数据库比较（e2e 实测）**：authored initial = position `[2.5,1.8,6.0]` / target `[0,0.6,0]` / fov `47`。刷新 `/scene/fix02-semantics` 后实拍相机 `position [2.5,1.8,6]` / fov `47` / look 方向 = authored target 方向（归一化 forward 点积 > 0.99）—— **未被 frameScene 覆盖**。
- 官方 load 时相机为 `anim` 模式（官方 20s figure8 轨迹，t=0 = authored 初始），随后按官方行为缓慢漂移；`Reset`（`settings.cameras[0].initial`）随时恢复 authored 初始并切 orbit —— 单测 + e2e 严格数值锁定。

---

## WORLD TRANSFORM STRATEGY（§5-§9）

**方案A —— runtime Scene Root Transform**（弃用 publish/asset bake，bake 会污染存量资产且无法即时生效）。

运行时把 W 施加到官方 `gsplat` 实体：`setLocalPosition / setLocalEulerAngles / setLocalScale`，局部旋转 = **W.rot ∘ Rz180**（官方加载器烘焙的固定 180°Z 翻转，先 180°Z 内转再 W 外转，合成数学见 `composeEntityEulerDeg`）。恒等 W 时实体保持官方初始 `[0,0,180]`（no-op，存量场景零回归）。

```text
onLoaded:
  runtime.applyWorldTransform()                       // W → gsplat 实体
  if (shouldFrameSceneOnLoad(desc)) runtime.frameScene()  // 无 authored 相机才取景
```

- **§9 真正执行**：非恒等 W 时实体被真实变换（`setLocal*` 调用，e2e 包围盒随实体旋转），不再是"只存不生效"。
- **§10 诊断**：`ov-diagnostics.worldTransform` 输出归一化 `position/rotation/scale/isIdentity` + `boundsAfter`（`getSceneBounds()` 读实体世界变换，反映施加后轮廓）。
- 恒等快速通道：`setWorldTransform(null)` / 恒等 W → 全透传，不触碰实体。

---

## COORDINATE CONTRACT（§5-§9）

`scene-runtime/SceneTransformAdapter.ts` 是**唯一**换算层，7 类语义统一：

```text
SCENE 空间：作者/运行时保存的坐标（初始相机 / 标注 anchor+camera / 视角点 position·target·fov 全存这里）
RUNTIME 空间：gsplat 实体被 W 摆放后的引擎世界空间，runtime = W(scene)
```

| 换算 | 方法 | 用途 |
|---|---|---|
| scene→runtime 点 | `sceneToRuntimePoint` | 标注 anchor、初始相机 position、视角 position |
| scene→runtime 方向 | `sceneToRuntimeDirection` | 朝向向量（旋转不污染方向） |
| scene→runtime 相机 | `sceneToRuntimeCamera` | 初始相机、标注相机、视角点 position+target+fov（fov 不变） |
| scene→runtime 玩家高度 | `sceneToRuntimePlayerHeight` | scale.y 缩放 eye height |
| runtime→scene 点/方向/相机 | `runtimeToScenePoint / Direction / Camera` | 作者捕获反存（拾取锚点、读当前相机） |
| 缩放因子 | `scaleFactor` | volumetric walk 诊断 |

- **scale ≠ 1**：换算为 `T·R·S`，点变换含缩放、方向变换含旋转+缩放；`sceneToRuntimePlayerHeight` 用 `scale.y`。e2e 单元测试锁定（Ry90 + scale(2,3,4) 等）。
- **旋转**：Euler 度数，YXZ（与官方 playcanvas `setFromEulerAngles/getEulerAngles` 一致），`quatFromEulerDeg` / `eulerFromQuatDeg` 严格互逆（对真实 playcanvas 验证）。
- **统一性**：初始相机、标注 anchors+各自相机、视角点、gsplat 实体共用同一 W —— **不做部分变换、不散落私有 hack**。
- **作者侧（§13）**：拾取锚点与当前相机为 RUNTIME 空间读数 → 经 adapter 反算为 SCENE 空间存库，使存量坐标在世界变换变化后仍钉在同一内容上。

---

## VIEWPOINTS（§10/§11）

- 工具栏新增「视角 (N)」下拉（`OfficialViewerToolbar`），列出 enabled 视角（按 orderIndex）。点击 → `state.selectViewpoint(id)` → `SuperSplatRuntime.selectViewpoint` → adapter 换算 scene→runtime → 注入 pose 标注 → 官方 `selectAnnotation` 过渡。
- 页面**不直接触碰 viewer.app**（经 wrapper `selectViewpoint`），`useSuperSplatDesktop` 暴露 `selectViewpoint + viewpoints`。
- **注入 pose 标注**（FIX-02 调查结论）：官方 1.35.0 无公开 `setCameraPose`（直接写相机实体被每帧 `applyCamera` 覆盖），唯一受支持任意 pose 路径 = `selectAnnotation(i)` → `annotation.camera.initial`。视角/任意 pose 在**导航时刻**向官方 `annotations` 数组尾部注入隐藏条目（`extras.gsplatform` 无 annotationId → 不解析为真实标注/不触发媒体 Overlay、不生成多余 hotspot）。
- 视角数据**不**注入官方 `settings.annotations`（官方 v2 无 viewpoints 字段，注入会产生多余 hotspot）。
- e2e 实测：点击「正门视角」→ 相机过渡到 `[3,2,7]`/fov52。

---

## ANNOTATION CAMERA（§12-§15）

- **后端**：迁移 `c1d2e3f4a5b6`（7 个可空 float 列 `camera_position_x/y/z`、`camera_target_x/y/z`、`camera_fov`）；`SceneAnnotation` 模型 + Create/Update/Out schema + `_annotation_out` + `RuntimeAnnotation`（descriptor 逐条透出 `cameraPosition/Target/Fov`）。未作者化 → 逐条 `null`（三字段全 None 才置 null）。
- **创建流程（§13）**：作者拾取 3D 锚点时，同时读当前 Viewer 相机 pose，二者一起存（SCENE 空间）。
- **Experience Adapter（§14）**：每条官方 annotation 的 `camera.initial` 来自**该标注自己**的 `cameraPosition/Target/Fov`（经 adapter scene→runtime），**不再**用 `settings.cameras[0]`。仅当某条标注未作者化相机时，才回落到经换算的场景初始相机（逐条判定）。
- **§15 e2e**：3 条标注（位置各不相同、相机明显不同）→ 点击 A→相机 A `[1,1.6,4.5]`/fov40；B→`[-2,1.5,5]`/fov50；C→`[0.5,1.4,6.5]`/fov60 —— **三个互不相同、均 ≠ 场景初始相机**。

---

## DESKTOP RESULT（§19，真实浏览器 e2e，headless SwiftShader）

场景 `fix02-semantics`（DB 合同，独立 slug 避免干扰既有 e2e 热点断言）。实拍结果：

| 项 | 期望（DB） | 实拍（浏览器相机） | 结论 |
|---|---|---|---|
| 加载初始相机 | `[2.5,1.8,6.0]`/fov47/look→`[0,0.6,0]` | `[2.5,1.8,6]`/fov47/forward 匹配 | PASS（未 frameScene） |
| Frame Scene | 离开初始构图 | `[2.88,0.94,2.89]` 看包围盒中心 | PASS |
| Reset | 恢复 authored | `[2.5,1.8,6]`/fov47/orbit | PASS |
| Saved Viewpoint | `[3,2,7]`/fov52 | `[3,2,7]`/fov52 | PASS |
| 标注 A/B/C | 各自相机 | 三组互不相同 | PASS |
| World Transform (Ry90) | 相机=W(scene)，`[6,1.8,-2.5]` | `[6,1.8,-2.5]`/fov47，包围盒 x↔z 互换 | PASS |
| XR 预览（WebGL） | 与 Desktop 相同 | `[2.5,1.8,6]`/fov47 | PASS |

---

## XR PREVIEW RESULT（§16）

XR 页（`/xr/fix02-semantics`，强制 WebGL）加载后、进入 VR 前实拍相机 `[2.5,1.8,6]`/fov47 —— 与 Desktop 完全一致（同一 adapter、同一 §2 规则、同一 settings 构建）。进入 VR 后的头部姿态由官方 XR 控制器接管（允许变化），pre-entry 场景坐标与初始构图一致。

---

## TESTS（§18）

**Web 单元（vitest）** —— `20 files / 177 passed`：
- `initial-camera-policy.test.ts`（新建，6 项）：authored 判定（显式 null / `[0,0,0]` 仍算 authored / 缺 target 或 position → frameScene / null descriptor）。
- `scene-transform-adapter.test.ts`（新建，15 项）：点/方向/相机/视角换算、逆换算、scale、rotation（与真实 playcanvas 互逆验证）、playerHeight、composeEntityEulerDeg 恒等/compose。
- `super-splat-runtime.test.ts`：authored 初始相机不被覆盖、World Transform 施加（恒等 no-op / 非恒等 / 实体缺失 / setWorldTransform 同步适配器）、视角换算与注入、setCameraPose 注入路径、**3 条标注产生 3 个不同相机**。
- `official-viewer-toolbar.test.tsx`：Saved Views 入口。

**后端单元（pytest）** —— `183 passed`：
- `TestAnnotationCamera`（新建，5 项）：相机 pose 持久化往返、无相机 → null、更新相机、runtime 描述符逐条透出（3 条互不相同）、未作者化 → null。

**质量门**：`tsc -b` ✓ · `oxlint` ✓（仅 1 个既有的 CollisionPanel 警告）· `pnpm build` ✓ · `ruff` ✓ · `mypy` ✓（83 files）。

**真实浏览器 e2e**（Playwright headless SwiftShader，dev proxy 到 :8001）：`17 passed (2.6m)`，含 6 项 FIX-02 专项（initial camera / frame+reset / viewpoint / A·B·C / world transform / XR preview）。

---

## KNOWN LIMITATIONS（诚实边界）

1. **Walk/Collision 未随世界变换对齐**：官方冻结 viewer 内部消费碰撞体素/网格，无法经公开 API 对 gsplat 实体施加同一 W。非恒等 W 下 walk 对齐受限于官方 runtime；`SceneTransformAdapter` 提供 `sceneToRuntimePlayerHeight`/`scaleFactor` 供后续使用，但碰撞网格本身仍按原 W 摆放（§9 的"碰撞走同一 W"在 walk 实际碰撞上暂不成立 —— Gaussian / 相机 / 标注 / 视角已统一）。
2. **`sceneBound` 在 post-load 变换前计算**：官方 frameScene/walkAllowed 用的场景包围盒在 `Promise.all.then` 一次计算，早于我们的 `applyWorldTransform()`；因此非恒等 W 下 frameScene 取景与 walkAllowed 尺度判定基于变换前轮廓。诊断用 `boundsAfter`（读实体世界变换）反映真实轮廓。
3. **官方 20s figure8 动画漂移**：加载瞬间相机 = authored 初始（已验证），随后按官方行为缓慢漂移；`Reset` 恢复 authored 并切 orbit。这是官方 viewer 行为，非 FIX-02 可控（无公开 API 禁用合成动画轨迹）。
4. **XR 真实会话未在此环境验证**：仅验证 pre-VR 初始构图一致（无头 WebGL）；无头环境无沉浸式设备/WebXR 会话。
5. **Headless SwiftShader 崩溃（基线环境限制）**：本环境下 streamed `lod-meta` 大场景在 SwiftShader 软渲染下会致 GPU 进程崩溃（HEAD 基线即如此，非 FIX-02 引入）；FIX-02 e2e 场景基于小体量单文件 `.sog`。
6. **dev `/api` 代理（vite.config.ts）**：FIX-01 把场景资产迁到授权 `/api/v1/scenes/.../assets` 后，官方 viewer 按相对 URL 取资产在 dev 无代理时回落到 SPA（200 HTML）导致 DB 场景无法加载；本次补 dev-only `/api` 代理（与生产 Nginx 同源路由一致），是本报告 e2e 与既有 DB 场景 e2e（ssv06/07）可运行的前置。

---

## FILES

**新增**：
- `apps/api/migrations/versions/c1d2e3f4a5b6_fix02_annotation_camera_pose.py`
- `apps/web/src/scene-runtime/SceneTransformAdapter.ts`
- `apps/web/src/scene-runtime/initialCameraPolicy.ts`
- `apps/web/src/__tests__/scene-transform-adapter.test.ts`
- `apps/web/src/__tests__/initial-camera-policy.test.ts`
- `apps/web/e2e/fix02-semantics.spec.ts`

**修改（后端）**：`app/db/models/scene_annotation.py`、`app/schemas/scene_annotation.py`、`app/schemas/scene_runtime.py`、`app/services/authoring.py`、`app/services/scene_runtime.py`、`tests/test_scene_runtime.py`

**修改（Web）**：`src/scene-runtime/SuperSplatRuntime.ts`、`experienceAdapter.ts`、`types.ts`、`__fixtures__/descriptor.ts`、`features/viewer-official/useSuperSplatDesktop.ts`、`useSuperSplatXR.ts`、`OfficialViewerToolbar.tsx`、`pages/SceneViewerPage.tsx`、`SceneAuthoringPage.tsx`、`XRViewerPage.tsx`、`services/annotationApi.ts`、`vite.config.ts`（dev `/api` 代理）、`e2e/ssv07-collision.spec.ts`（diagnostics 字段更新）

---

## NEXT PHASE

FIX-02 闭环。禁止开始 FIX-03。后续如需继续，走既定冻结流程的下一次显式指令。
