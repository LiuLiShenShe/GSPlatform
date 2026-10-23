# GS-DESKTOP-01 —— 加载完成后相机自动拉远修复（真实浏览器取证）

> 任务：GS-DESKTOP-01｜日期：2026-10-23｜基线 HEAD：`46c7cdf`
> 用户 P0：在电脑浏览器查看 Gaussian 场景时，加载期间的主体构图很好；加载一结束，
> 视角突然退到远处，显示整个 Gaussian 场景和废点。
>
> **结论：根因是平台代码在 Viewer loaded 后无条件调用官方 `frameScene()`（整个 AABB
> 取景）。修复后加载路径只执行一次 `applyWorldTransform() + resetCamera()`，
> Desktop / 创作预览 / XR 共用同一份策略；加载完成后 6–8 秒观察期内相机位移
> = 0.000000。** 加载期间看到的「好构图」是 **poster（2D 封面图）**，不是实时相机。

---

## 1. 验收标志

| 标志 | 判定 | 依据 |
| --- | --- | --- |
| `LOADING_CAMERA_JUMP_FIXED` | **PASS** | 修复前后真实 Chromium 数字证据：`[0,2,0] → [3.2433,1.7331,3.3158]`（4.65 单位）→ `[0,2,0] → [0,2,0]`（0.000000） |
| `AUTHORED_CAMERA_PRIORITY` | **PASS** | authored 场景加载即精确落在 `settings.cameras[0].initial`（位移 0.000000）；刷新、版本切换、非恒等 W 均一致 |
| `UNAUTHORED_CAMERA_SAFE` | **PASS** | 无 authored → 官方 `defaultSettings('environment')` 默认相机 `[0,2,0]` / fov 85；**不**取景 AABB |
| `AUTHORING_VIEWER_CONSISTENCY` | **PASS** | 创作预览与 `/scene` 相机数值一致（`< 0.05`），同一 `applyInitialCameraPolicy` |
| `XR_INITIAL_POSE_NOT_REGRESSED` | **PASS（软件）** | XR 页面进入 VR 前构图 == authored 相机；`xrInitialCamera` 逻辑未改。真机仍需复测 |
| `REAL_BROWSER_E2E` | **PASS** | 13 条真实 Chromium 用例 14.7 分钟全通过（非 mock Viewer） |

---

## 2. 根因（实际调用栈）

### 2.1 修复前的加载路径

```text
官方 Viewer 触发 loaded（state.loaded = true，progress = 100）
  → useSuperSplatDesktop.initialize()                 // Desktop
     / SceneAuthoringPage.syncLoaded()                // 创作预览
     / useSuperSplatXR.syncReady()                    // XR
  → applyWorldTransform()
  → if (shouldFrameSceneOnLoad(desc)) runtime.frameScene()
    else runtime.resetCamera()
```

`shouldFrameSceneOnLoad(desc)` 的旧实现是 `!hasAuthoredInitialCamera(desc)` —— 即
**没有保存过初始视角的场景，每次加载完成都会自动 `frameScene()`**。

### 2.2 `frameScene()` 做了什么（官方 1.35.0 实测源码）

`apps/web/node_modules/@playcanvas/supersplat-viewer/dist/viewer.js`：

```js
frameScene() {                       // L11051
  this.requireLoaded('frameScene');
  this.global.events.fire('inputEvent', 'frame');
}

case 'frame':                        // inputEvent 处理，L6305
  events.fire('orbitTarget:clear');
  state.cameraMode = 'orbit';
  controllers.orbit.goto(frameCamera);
  startTransition();                 // 1 秒缓动过渡
  break;
```

```js
const createFrameCamera = (bbox, fov) => {              // L6135
  const sceneSize = bbox.halfExtents.length();
  const distance = sceneSize / Math.sin((fov / 180) * Math.PI * 0.5);
  return createCamera(new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
                      bbox.center, fov);
};
```

即：**把整个场景包围盒（含离群 Gaussian / 废点）塞进画面**，并在 1 秒内把相机
从初始位姿过渡到这个远景。这正是用户看到的「加载一结束视角突然退到远处」。

### 2.3 官方加载路径本来就不会这样

官方 `CameraManager` 构造（L6161）：

```js
const camera0 = settings.cameras[0]?.initial;
const resetCamera = camera0
    ? createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov)
    : frameCamera;
...
this.camera.copy(resetCamera);       // L6211
```

`defaultSettings(fit)` **始终**提供 `cameras: [{ initial: defaultCameraPose(fit) }]`
（`settings.js` L72），environment 形态为 `position [0,2,0] / target [2,2,0] / fov 85`
（`settings.js` L18-21）。官方文档同样写明：相机定义「visitor lands on」的起始视角，
`startMode: 'default'` = 从 `cameras` 的第一个相机开始
（https://developer.playcanvas.com/user-manual/supersplat/studio/cameras/ ，
https://developer.playcanvas.com/user-manual/supersplat/studio/experience-settings/ ）。

**官方加载路径从不调用 `frameScene()`** —— 它是工具栏 `Frame` 按钮的用户主动操作。

### 2.4 为什么修复后仍要调用 `resetCamera()`

官方在 `getAnimTrack()` 中，即使 `animTracks` 为空也会合成 figure-8 / rotate 轨道
（object experience 用 rotate，其余用 figure-8），因此 `state.hasAnimation = true`、
初始 `cameraMode = 'anim'`；`firstFrame` 时 `state.animationPaused = false`（L10779）。
如果只删掉 `frameScene()` 而不做任何事，相机会在加载后沿官方动画轨道自行漂移。
`resetCamera()`（官方 `inputEvent 'reset'`）会切到 orbit 并收敛到
`settings.cameras[0].initial`，这正是「一次性、可重复、用户也可再触发」的官方语义。

---

## 3. 加载画面究竟是 poster 还是真实 Canvas

**是 poster（2D 封面图），不是实时相机。**

`OfficialViewerCanvas.tsx` L21-35：加载期（`status === 'loading' && !loaded`）渲染
`ov-loading` 遮罩，其中 `<img data-testid="ov-poster">` 使用 `descriptor.scene.posterUrl`；
CSS 为 `filter: blur(8px) saturate(0.9)`（`index.css` L548-554）。

真实浏览器探针（`before-evidence.json` / `after-evidence.json`）显示：

```text
t=9373..9923    loaded=false progress=100 poster=true   camera.position=[0,0,0] fov=45
                                                       ← 官方 CameraManager 尚未初始化，
                                                         此刻看到的只是这条 2D 封面 + 进度条
t=10063         loaded=true  progress=100 poster=false  camera.position=[0,2,0] fov=85
                                                       ← 真实首帧；遮罩在同一采样点消失
```

因此：

- 加载期间「主体构图很好」= 封面图（poster），**不能**据此反推或持久化 3D pose；
- 加载结束后的真实相机从 `[0,2,0]` 开始，修复前被 `frameScene()` 在 42ms 内拉走；
- 若场景没有 poster，加载期只有进度条（无图可看），行为同样是「加载后不自动取景」。

---

## 4. 修改内容（相机生命周期只有一个权威来源）

### 4.1 单一策略

`apps/web/src/scene-runtime/initialCameraPolicy.ts`：

- **删除** `shouldFrameSceneOnLoad()`（旧契约：无 authored 必须自动 frameScene）。
- **新增** `applyInitialCameraPolicy(runtime, descriptor)`：

```ts
export function applyInitialCameraPolicy(runtime, descriptor) {
  runtime.applyWorldTransform();   // 世界变换（幂等）
  runtime.resetCamera();           // 官方 reset：回到 cameras[0].initial
  return initialCameraSource(descriptor); // 'authored' | 'official-default'
}
```

结构类型 `InitialCameraRuntime` 只暴露这两个方法——调用点**在类型上**就拿不到
`frameScene()`，从接口层面杜绝再次写回自动取景。

### 4.2 三个入口统一

| 入口 | 文件 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `/scene/:sceneId` | `useSuperSplatDesktop.ts` | `frameScene` / `resetCamera` 二选一 | `applyInitialCameraPolicy`（one-shot） |
| `/model/edit/:sceneId` | `SceneAuthoringPage.tsx` | 同上（重复实现） | 同一函数（one-shot） |
| `/xr/:sceneId` | `useSuperSplatXR.ts` | 同上 | 同一函数（one-shot） |

一次性门闩仍在调用点（`initialized`），不会因 progress / React 重渲染 / resize 重放；
用户手动旋转、平移、缩放后，没有任何后续事件会把相机拉回默认构图。

### 4.3 保留的官方能力

- 工具栏 **Frame** → `runtime.frameScene()`（用户主动取景 AABB，未被移除）；
- 工具栏 **Reset** → `runtime.resetCamera()`（回到有效初始相机，未被移除）；
- 视点 / 标注 / 导览点导航仍走官方 `CameraManager` 过渡，未被本任务改写；
- XR 出生位姿 `xrInitialCamera` 逻辑未改：仅在有 authored 相机时传入。

### 4.4 创作页的「设为初始视角」入口

- 顶栏按钮文案改为 **「将当前视角设为初始视角」**（`data-testid="save-current-view-as-initial"`），
  不需要用户输入三维坐标；保存走既有 `AuthoringService` + Scene→Runtime 逆变换 +
  GS-NEXT-12 的逐版本绑定。
- 未设置初始视角时显示明确提示（`data-testid="initial-view-not-authored"`）：
  打开场景使用官方默认相机，**封面图不是相机视角**。
- `InitialViewPanel` 未设置态同样提示并提供同一个按钮。
- 保存后 `verifyInitialViewUsed()` 独立回读 `/runtime` 描述符，只有运行时真的采用
  才提示成功；否则明确报错（避免「库里写了、运行时忽略」的假成功）。

---

## 5. 修改前后的相机数据（真实 Chromium / 真实官方 Viewer）

夹具 `fix02-semantics`（59400 splats，DB），拦截 `/runtime` 把 `initialCamera` 置空
（即「未保存初始视角」的真实形状），加载期注入一张可辨识的 poster。

| 阶段 | 修复前 | 修复后 |
| --- | --- | --- |
| 加载遮罩可见（poster） | `[0,0,0]` / fov 45（CameraManager 尚未初始化） | 同左 |
| 首个 `loaded=true` 采样 | **`[0,2,0]` / fov 85** | **`[0,2,0]` / fov 85** |
| 加载后 46ms | `[1.6232, 1.8664, 1.6595]` ← frameScene 过渡中 | `[0,2,0]` |
| 加载后 1.8s | `[3.2433, 1.7331, 3.3158]`（AABB 取景完成） | `[0,2,0]` |
| 加载后 6s | `[3.2433, 1.7331, 3.3158]` | `[0,2,0]` |
| 加载后位移 | **4.646 单位**（`[0,2,0] → [3.2433,1.7331,3.3158]`） | **0.000000** |
| 初始化调用 | `applyWorldTransform` → `frameScene` | `applyWorldTransform` → `resetCamera` |
| cameraMode | `orbit`（frameScene 强制切换） | `orbit`（resetCamera 切换） |

原始 JSON：`docs/reports/gsdesktop01-evidence/before-evidence.json`、
`docs/reports/gsdesktop01-evidence/after-evidence.json`（含 50ms 采样的完整时间线）。

### 5.1 有 authored 初始相机

夹具 `fix02-semantics` 的 DB 值 `position [2.5,1.8,6] / fov 47`：

| 检查 | 结果 |
| --- | --- |
| 加载后相机 | `[2.5, 1.8, 6]` / fov 47 |
| 加载后 6s 位移 | `0.000000` |
| 初始化调用 | `applyWorldTransform` → `resetCamera`（无 `frameScene`） |
| 用户 Frame | `[5.279, 2.783, 5.599]`（明显离开 authored，官方能力有效） |
| 用户 Reset | `[2.536, 1.813, 5.995]`（回到 authored，误差 < 0.05） |

### 5.2 无 authored 初始相机

停在官方 `defaultSettings('environment')` 的 `[0,2,0]` / fov 85，6s 位移 0.000000；
明确不等于旧 `frameScene` 产物 `[3.2433,1.7331,3.3158]`（距离 4.65）。

### 5.3 非恒等世界变换

`worldRotation = {0,90,0}`、authored `[1.5,1.6,2.5]/fov 65` → 运行时
`[2.5, 1.6, -1.5]` / fov 65（Ry90° 正确换算），6s 位移 0.000000，无 `frameScene`。

### 5.4 Streamed SOG / 版本切换

`gsdesktop01-versions` 夹具（A=streamed-sog，B=sog）：

- authored + streamed：`contentUrl` 含 `lod-meta`，相机 `[3,1.8,6]/fov 47` 稳定；
- 切到历史版本（sog）→ 空间配置按设计 STALE，描述符 `initialCamera = null`；
- 在真实创作预览重新保存视角 → `/presentation` 与 `/runtime` 独立回读一致；
- 重新打开：采用新视角（`[1.1031,2.1092,0.2153]`），6s 位移 0.000000，无 `frameScene`。

---

## 6. 截图（真实 Chromium）

目录：`docs/reports/gsdesktop01-evidence/`

| 文件 | 内容 |
| --- | --- |
| `before-loading-poster.png` | 修复前：加载遮罩（场景加载中… 0%）+ 模糊的 poster 背景 |
| `before-loaded-immediate.png` | 修复前：loaded 瞬间（HUD 显示相机已开始被拉走） |
| `before-loaded-6s.png` | 修复前：AABB 远景（HUD 实测 `[3.243,1.733,3.316]`，`frameScene`） |
| `after-loading-poster.png` | 修复后：同一加载遮罩 + poster |
| `after-loaded-immediate.png` | 修复后：loaded 瞬间 `[0,2,0]` |
| `after-loaded-6s.png` | 修复后：6 秒后仍是 `[0,2,0]`（HUD 实测），`resetCamera` |

截图左上角的黑色 HUD 是**取证脚本临时注入的 DOM**（不属于产品代码），
把 `loaded / progress / cameraMode / camera.position / camera.fov / init calls`
直接画在页面上，避免「看黑视口猜相机」。已用视觉识别逐字核对：
修复前 HUD 读到 `camera.position [3.243, 1.733, 3.316]`、
`init calls ["applyWorldTransform@10077", "frameScene@10077"]`；
修复后 HUD 读到 `camera.position [0, 2, 0]`、
`init calls ["applyWorldTransform@10071", "resetCamera@10071"]`。

**诚实说明（测试环境限制，不是产品缺陷）**：本机 e2e 使用 headless Chromium +
SwiftShader WebGPU，并带 `--disable-gpu-compositing`（GS-NEXT-10 记录：不开该
flag 时官方 on-demand 渲染会让 rAF 冻结、相机过渡永远走不完）。该组合下
`page.screenshot` **不会把 WebGL canvas 合成进截图**，三维视口在截图中为黑色。
因此截图只用于证明「加载遮罩 = poster、loaded 时消失」与 UI/按钮状态；相机是否
移动由 50ms 采样的**真实 pose 数字**证明（见 §5），不靠看图猜测。

本机 GPU0 正被其他服务占用（92% 利用率），GPU1 按任务约束不得触碰，因此未改用
GPU 渲染补图。

---

## 7. 测试结果

### 7.1 新增真实浏览器 E2E

`apps/web/e2e/gsdesktop01-camera-stability.spec.ts`（13 用例，真实 Chromium）：
**13 passed / 14.7m**。

覆盖：authored SOG、无 authored、Streamed SOG、保存视角后刷新、Authoring→Viewer、
历史版本切换后重新保存、非恒等世界变换、poster 有/无、loaded 后 6–8s 稳定观察、
用户主动 Frame/Reset、刷新、前进后退（无第二个 viewer/camera 控制器）、XR 进入 VR 前构图、
manifest 回退场景。

核心断言（每条用例都执行）：
- `loaded=true / progress=100` 之后所有采样位移 `< 0.01`；
- 加载路径 `frameScene` 调用数 = 0；
- 初始化调用序列 = `['applyWorldTransform', 'resetCamera']`；
- 页面 `.sse-viewer` / canvas 数 = 1。

### 7.2 回归

| 项 | 结果 |
| --- | --- |
| Web Vitest（全量） | **389 passed / 38 files** |
| Web typecheck (`tsc -b --noEmit`) | **PASS** |
| Web lint (`oxlint src`) | **PASS** |
| Web build (`tsc -b && vite build`) | **PASS** |
| 后端相关 pytest（隔离库） | **65 passed / 0 failed**（`test_gsnext02_initial_camera`、`test_scene_runtime`、`test_gsnext12_spatial_rebinding`、`test_vr01c_initial_camera`、`test_gsnext03_viewpoint`、`test_gsnext12_version_consistency`） |
| `gsnext02-initial-camera.spec.ts` + `gsnext03-viewpoint.spec.ts` | **见下方 §7.3** |
| `gsnext12-spatial-reauthor.spec.ts` | **见下方 §7.3** |

旧单测契约变更：`shouldFrameSceneOnLoad()` 的旧断言（无 authored → frameScene）已被
**证明与官方加载行为冲突**后改写为 `applyInitialCameraPolicy()` 契约（只 reset、
绝不 frame），并非删除测试。
`xr-pages.test.tsx` 的 XR 用例同样改为断言 `resetCamera` 被调用、`frameScene` 为 0。

### 7.3 相关 E2E 回归（真实浏览器）

| 套件 | 结果 |
| --- | --- |
| `gsnext02-initial-camera.spec.ts` + `gsnext03-viewpoint.spec.ts` | **12 passed / 22.7m**（视点切换、XR 视点/出生位姿、保存视角后重开） |
| `gsnext12-spatial-reauthor.spec.ts` | **1 passed / 34.3s**（A→B→在 B 重新保存→Web/XR 采用新视角） |
| `gsnext04-annotation-nav.spec.ts` | **2 passed / 2 failed** — 2 个失败在**未修改的基线代码**（`46c7cdf`，同一命令、同一夹具）上**同样失败**，属既有问题，与本轮改动无关 |

`gsnext04` 的两个失败用例是相机过渡等待（20s / 25s）超时，发生在
「官方 Prev/Next 导览器」与「XR 导览点出生位姿」；用 `git stash` 回到基线后
复跑得到**完全相同的 2 failed / 2 passed**，因此不是本轮引入的回归。

`gsnext12` 首次失败原因是测试库中一个 **2026-10-21 遗留的孤立任务**
（`jobs.status=QUEUED`，`BUILD_COLLISION`，`celery_task_id=celery-37`，队列已空、
两天未派发）触发了版本切换守卫；将该**夹具遗留任务**标记为
`FAILED / ORPHANED_STALE_FIXTURE` 后复跑通过。该操作只发生在隔离测试库，
未修改任何场景数据或产品代码。

---

## 8. 手动复现（用户可自行验证）

1. 打开一个**尚未保存初始视角**的场景：`/scene/<slug>`；
   加载期间看到的是封面图/进度条；加载结束后相机不再突然拉远。
2. 打开 `/model/edit/<slug>`，在真实 Gaussian 预览里滚轮推近、拖拽到满意的构图；
3. 点击顶栏 **「将当前视角设为初始视角」**；
4. 看到「已保存（初始视角已更新，打开场景将采用该视角）」；
5. 重新打开 `/scene/<slug>`（或刷新）——相机直接落在刚保存的视角，并在
   稳定观察期内不再移动；
6. 手动点 **Frame**（取景整个场景）与 **Reset**（回到初始视角），两者仍然有效。

---

## 9. 存量场景是否仍需手工保存初始视角

**需要。** 修复解决的是「加载完成自动拉远」；它不会、也不应该伪造一个近距离视角：

- 已有 authored 初始视角的场景 → 直接采用，无需任何操作；
- 没有 authored 初始视角的场景 → 使用官方默认相机 `[0,2,0] / fov 85`
  （不再被 AABB 取景拉远），但默认构图是否理想取决于场景本身；
- 想要「打开即近距离主体」的场景，请在创作页用一次
  「将当前视角设为初始视角」保存。这是有意的产品边界：不根据离群 Gaussian 猜测、
  不硬编码缩放系数、不用 2D 封面反推 3D pose。

---

## 10. 安全边界

- 未修改任何真实场景的 `initialCamera` / `currentVersionId` / `SceneVersion`
  来掩盖代码问题；e2e 写入只发生在隔离测试库（`gsplatform_vr00_tests_20261011`），
  且每个用例结束恢复原值；
- 原始 Building / 13M Gaussian PLY 与历史发布资产只读，未重新转换/发布/覆盖；
- 未升级锁定的官方 Viewer / PlayCanvas / SplatTransform；
- 未触碰 GPU1 与其他共享服务；未使用 `git reset --hard` / `git clean` / force push。

---

## 11. 已知限制 / 后续

- 截图中的三维视口为黑：headless SwiftShader + `--disable-gpu-compositing` 不合成
  WebGL 到 `page.screenshot`（§6 已说明）。相机证据以真实 pose 数字为准。
- XR 结论为软件路径（入口构图 + 出生位姿逻辑未变）；真实 PICO Neo3 复测仍需单独执行。
- 旧报告（GS-NEXT-01/02/00）中的「无 authored → 自动 frameScene」描述已被本任务
  取代，保留为历史记录。