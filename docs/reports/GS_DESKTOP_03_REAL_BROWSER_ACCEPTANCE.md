# GS-DESKTOP-03 —— 电脑端真实浏览器体验 / 操作 / 截图验收

> 任务：GS-DESKTOP-03｜执行日期：2026-10-24｜基线 HEAD：`05ded2c`（`git status` 干净）
> 目标：在**真实浏览器 + 真实 GPU** 下独立验收桌面端体验（不修改产品代码），
> 重点是把上一轮（GS-DESKTOP-02）用 headless SwiftShader 拍不出 Gaussian 画面的问题解决掉。

## 0. 结论速览

| 验收项 | 判定 | 关键证据 |
|---|---|---|
| `REAL_GAUSSIAN_VISIBLE` | **PASS** | headful Chrome + NVIDIA RTX A6000（ANGLE Vulkan），13,090,324 splats 场景实测 **1,969,072 splats 同时渲染**；官方 `captureFrame()` 出图非黑（meanLum 79.1、coloredRatio 0.50）；`26/27/28/29/30-gaussian-*.webp` |
| `CAMERA_LOAD_STABILITY` | **PASS** | 场景 A：加载完成后 0→2s→8s 相机**位移 0.000000**；场景 B（streamed-sog）同样 0；无 `frameScene()`/`resetCamera()` 之外的自动取景 |
| `OFFICIAL_VIEWER_UI` | **PASS** | Orbit/Fly/Settings/Info/Fullscreen/AnnotationNav/hotspot 全部可见 + 中心点命中测试未被宿主遮挡；宿主重复控件 8 个 testid 全部 count=0；Info 面板显示 `SuperSplat Viewer v1.35.0` |
| `PCUI_VISUAL_QUALITY` | **PARTIAL** | 1920×1080 与 1280×720 均无横向滚动、无重复标题/输入框、0 个禁用的"看得见点不动"按钮；**但**：`gs-props__hint` 提示文字被截断（1 处）、相机属性面板未跟随页面滚动（需滚动才看到「将当前视角设为初始视角」）、属性区 FOV 是 PCUI 文本输入框而非数值步进器 |
| `CAMERA_SAVE_RESET_SAME_SESSION` | **FAIL（P1）** | 保存 B 后**不刷新**：宿主「定位到已保存视角」与官方 Reset 都回到旧视角 A（误差 **3.8248 m**）；**刷新后**才回到 B（误差 4.5e-5）。即任务 §6 明令判 FAIL 的"刷新后才正确"模式，真实复现 |
| `WALK_SAFETY_ALL_ENTRY_PATHS` | **PASS** | 未校准场景：官方 `.sse-fpsCamera` 被官方自身标记 `sse-hidden`；键盘 `3` / `w` / `a` 与宿主 `toggleWalk()` **均无法进入 walk**（官方 `walkAllowed=false` 内部拦截，不依赖宿主 CSS） |
| `ANNOTATION_AUTHORING_FLOW` | **PASS** | 拾取模式 → 点击真实画布 → 落库（3→4）→ 改名 → 浏览页 4 个官方 hotspot → 官方导览 4 个标题全部可达 → 隐藏/删除后 hotspot 数同步回 3 |
| `STREAMED_SOG_VISUAL` | **PASS** | 场景 B `lod-meta`：13 个分块请求（meta/means_l/quats/…），3 级 LOD；13M 场景 10 秒内 131k → 1,958,710 splats 渐进流入，464 个 chunk 请求、0 失败 |
| `DESKTOP_PRODUCT_READY` | **FAIL** | 真实 Gaussian 可见（这一项已过关），但"保存视角后立即 Reset"这一核心交互确认为 P1 缺陷（§5.5），按任务 §13 的判定标准不能给 PASS。除该缺陷外，其余 8 项均 PASS/PARTIAL |

---

## 1. 环境与方法（为什么这次能拍到真实画面）

| 项 | 本轮（GS-DESKTOP-03） | 上一轮（GS-DESKTOP-02） |
|---|---|---|
| 浏览器 | Google Chrome 145.0.7632.116，`channel: 'chrome'` | 同 |
| 模式 | **headful**（`headless:false`） | headless |
| 显示 | Xvfb `:98`（1920×1080×24，隔离，不影响其他用户） | 无 |
| 渲染 | **ANGLE + Vulkan → NVIDIA RTX A6000**（`nvidia-smi pmon` 显示 `playwrig C+G` 进程，GPU0 利用率 17%） | SwiftShader（软件） |
| 截图能否含 3D 画面 | **能**（compositor 合成 canvas） | 不能（上一轮报告 §5 已声明） |
| WebGPU | `WebgpuGraphicsDevice` + `WEBGPU (nvidia / ampere)` 官方日志 | SwiftShader |

关键参数（`apps/web/e2e/gsdesktop03/common.mjs`）：

```
--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --enable-unsafe-webgpu
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion
```

后三个是**必需**的：Xvfb 里没有窗口管理器遮挡概念，Chrome 会把窗口判为
occluded 并冻结渲染循环（实测 `rAF` 掉到 0/s，画面停在第一帧）。

服务拓扑（全部为**已有进程 + 本轮新增的隔离实例**，未杀任何共享服务）：

| 组件 | 地址 | 用途 |
|---|---|---|
| 开发库 API（已有） | 127.0.0.1:8001 | 场景 A/B 的运行时描述、创作页读写 |
| Vite（已有） | 127.0.0.1:5173 | 场景 A/B 页面 |
| **只读 API（新增）** | 127.0.0.1:18098 | 连历史库 `gsplatform_vr00_20261011` + `storage/`，只为展示 13M 历史场景 |
| **隔离 Vite（新增）** | 127.0.0.1:5188 | 代理到 18098，避免污染 5173 的代理目标 |

> 13M 场景 `u-c71ec45417a0`（Building-Reupload-Control）的真实资产在
> `storage/published/a21bcddb-…/versions/5cd79d2c9641`（1.2 GB，373 chunk）。
> 它**只读**：本轮只发 GET，未写 DB、未改相机/版本/标注。

复现命令见 §10。

---

## 2. 测试场景（都来自现有夹具，未新建）

| 场景 | slug | 格式 | splats | 初始相机 | 标注 | 视角 | 说明 |
|---|---|---|---|---|---|---|---|
| **A** | `fix02-semantics` | `sog`（单文件） | 59,400 | `[2.5,1.8,6] → [0,0.6,0]`, fov 47 | 3（标注A/B/C，各自带相机） | 1（正门视角） | 官方 UI / 相机 / 标注 / Walk 全流程 |
| **B** | `gsdesktop01-versions` | `lod-meta`（streamed-sog） | 179/536/1788（3 级 LOD） | `[3,1.8,6] → [0,0.6,0]`, fov 47 | 0 | 0 | LOD 渐进加载 + 分块请求 |
| **13M** | `u-c71ec45417a0` | `lod-meta`（7 级 LOD） | 13,090,324（实测同时渲染 ~1.97M） | `[240,80,400] → [34.7,-50.7,88.9]`, fov 60 | 0 | 0 | 只读视觉观感 |

测试前后对 A 做了数据快照，测试后**已恢复**（§11）。

---

## 3. 测试 1 —— 加载完成时的相机（`01`–`04`，`camera-timeline.json`）

两个场景各走一遍真实加载，逐阶段记录：

| 阶段 | 场景 A | 场景 B |
|---|---|---|
| 首帧有内容 | 2.43 s（progress 0→100） | 2.78 s |
| `loaded=true` 时相机 | `[2.5, 1.8, 6]`，fov 47 | `[3, 1.8, 6]`，fov 47 |
| gsplats @loaded | 59,400 | 0（LOD 首帧未到） |
| gsplats @+2s | 59,400 | 179 |
| gsplats @+8s | 59,400 | 179 |
| **loaded → +8s 相机位移** | **0.000000** | **0.000000** |
| target 漂移 | 0.000000 | 0.000000 |
| cameraMode | orbit（全程） | orbit（全程） |

- 场景 A 无 poster（`posterUrl=null`，`01-loading-poster.webp` 即首屏过渡态）。
- 场景 B 有**真实分块加载**：`lod-meta.json` → `2_0/meta.json` → `2_0/means_l.webp`
  → `quats.webp` … 共 13 个请求（见 `camera-timeline.json` 的 `chunkRequests`）。
- 两个场景在加载完成后**都没有**任何未经用户触发的相机位移；没有调用
  `frameScene()`，官方 `resetCamera()` 只在首帧策略里执行一次（沿用 GS-DESKTOP-01 的
  "加载完成后不再自动 frameScene" 修复）。

**`CAMERA_LOAD_STABILITY` = PASS。**

海报与初始相机：场景 A/B 都没有封面图，所以不存在"把海报当成相机"的问题；
13M 场景有 authored 相机 `[240,80,400]`，加载完成后也精确停在那里（见 §7）。

---

## 4. 测试 2 —— 官方 Viewer 原生界面（`05`–`09`，`ui-interactions.json`）

### 4.1 可见性 + 命中测试

| 官方控件 | 数量 | 可见 | 命中尺寸 | 中心点命中 |
|---|---|---|---|---|
| `.sse-controlsWrap` | 1 | ✅ | 1568×34 | — |
| `.sse-orbitCamera` | 1 | ✅ | 34×34 | `svg`，在控件内 ✅ |
| `.sse-flyCamera` | 1 | ✅ | 34×34 | `use`，在控件内 ✅ |
| `.sse-settings` | 1 | ✅ | 34×34 | `svg`，在控件内 ✅ |
| `.sse-info` | 1 | ✅ | 34×34 | `use`，在控件内 ✅ |
| `.sse-enterFullscreen` | 1 | ✅ | 34×34 | `svg`，在控件内 ✅ |
| `.sse-annotationNav` | 1 | ✅ | 368×34 | `sse-annotationNavTitle` ✅ |
| `.sse-annotation-hotspot` | 3 | ✅ | 26×26 | — |

宿主重复工具条：`ov-frame` / `ov-reset` / `ov-walk` / `ov-performance` /
`ov-annotations` / `ov-fullscreen` / `ov-exit-fullscreen` / `ov-camera-mode`
**全部 `count = 0`**。

### 4.2 真实点击与运行态变化

| 操作 | 运行态结果 |
|---|---|
| 点 Fly | `cameraMode orbit → fly`（真实状态，非 DOM 猜测） |
| 点 Orbit | `cameraMode fly → orbit` |
| 点 Settings | `.sse-settingsPanel` 可见（166×162），Frame/Reset/Performance/Annotations 行可见 |
| 点 Frame | 相机 `[2.5,1.8,6] → [5.4796,2.8536,5.57]`（位移 3.19，用户主动取景） |
| 点 Annotations 行 ×2 | `showAnnotations true → false → true` |
| 点 Performance 行 | `performanceMode true → false` |
| 点 Reset | 回到 authored 相机（收敛过程见 §4.4） |
| 点 Info | `.sse-infoPanel` 可见，文案 `SuperSplat Viewer v1.35.0 / WebGPU nvidia / ampere / PlayCanvas Engine v2.22.4` + 完整快捷键表 |
| 点 Fullscreen | `document.fullscreenElement.className === 'sse-viewer'`；Esc 后回到正常布局 |
| 点 Annotation Next ×2 → Prev | 相机依次落到三个不同标注相机（`2.45,1.80,5.99` → `-0.92,1.48,5.55` → `-0.75,1.46,5.70`） |
| 画布中心拖动 120,40 | 相机位移 3.18 —— **官方 chrome 没有拦截画布拖拽** |

### 4.3 未发现的问题

- 没有官方/平台重复工具栏（上方计数为 0）。
- 平台右侧面板（作者/收藏/分享/问 AI/详情）**没有**遮挡官方底部控件
  （`.sse-controlsWrap` 在 y=950，面板在右侧但高度不重叠；命中测试也全部通过）。
- 设置面板可关闭（再点一次 Settings 即收起）。
- 没有透明遮罩吞点击（`elementFromPoint` 都命中控件自身）。
- 官方 hotspot 不挡拖拽（画布拖动实测生效）。
- 英文提示位置正常，无错位。

### 4.4 一个需要解释的测量值（不是缺陷）

phase 2 里点 Reset 后等 4 s 记录到相机 `[2.7621,1.8927,5.9622]`，
与 authored `[2.5,1.8,6]` 差 0.28 m。**这是官方过渡动画没跑完**：

| Reset 后时间 | 相机位置 |
|---|---|
| 1 s | `[2.7619, 1.8926, 5.9622]` |
| 2 s | `[2.5302, 1.8107, 5.9956]` |
| 4 s | `[2.5, 1.8, 6.0]` ✅ |
| 8 s / 12 s | `[2.5, 1.8, 6.0]` |

（实测记录 `reset-convergence.json`。）官方 Reset 是带 ease 的相机过渡，
4 s 后精确收敛。断言"Reset 回到 authored 相机"时必须等过渡结束，
否则会误判成位置错误。

**`OFFICIAL_VIEWER_UI` = PASS。**

---

## 5. 测试 3 —— 保存初始视角后立即 Reset（`10`–`14`，`camera-save-reset.json`）

这是本轮重点。**真实鼠标操作**，隔离场景 A，测试前已快照、测试后已恢复（§11）。

### 5.1 三个相机

| 点 | 相机 position | target | fov |
|---|---|---|---|
| **A**（authored，页面刚打开） | `[2.5, 1.8, 6.0]` | `[-0.0157, 0.5925, -0.0377]` | 47 |
| **B**（鼠标拖动 + 滚轮后） | `[3.7083, 0.7145, 2.5372]` | `[0.0009, 0.6000, 0.0006]` | 47 |
| **C**（再拖动后） | `[1.2420, 1.7603, 4.1609]` | `[-0.0237, 0.5779, -0.0793]` | 47 |

A→B 位移 3.82，B→C 位移 3.13（说明两次拖拽都真的落在画布上）。

### 5.2 保存 B

点击创作页「将当前视角设为初始视角」→ antd Modal 反馈
`已保存（初始视角已更新，打开场景将采用该视角）`，随后：

- `GET /presentation` → `initialCameraPosition = {3.7083, 0.7145, 2.5372}`（与 B 完全一致）
- `GET /runtime` 描述符 → `initialCamera = {3.7083, 0.7145, 2.5372}`（**数据库与运行时一致**）

### 5.3 不刷新，Reset

| 操作 | 结果相机 | 到 B 误差 | 到 A 误差 |
|---|---|---|---|
| 创作页「定位到已保存视角」 | `[2.5, 1.8, 6.0]` | 3.82 | **0.000000** |
| 官方 Viewer「重置相机」 | `[2.5, 1.8, 6.0]` | 3.82 | **0.000000** |

**FAIL**（按任务 §6 的判定标准）。

### 5.4 刷新后，Reset

| 步骤 | 结果 |
|---|---|
| 刷新打开 `/scene/fix02-semantics` | 相机 `[3.7083, 0.7145, 2.5372]` = **B** ✅ |
| 点官方「重置相机」 | 相机 `[3.7083, 0.7145, 2.5372]` = B，误差 **4.5e-5** ✅ |

### 5.5 根因

保存只写 `scene_presentations`，**没有重建 Viewer**（这是 GS-DESKTOP-02 的设计：
保存不销毁/重建官方 runtime）。官方 Viewer 的 `settings.cameras[0].initial`
是在 `createViewer` 时从 Experience Settings 快照的，保存后那份快照仍是 A。

- 创作页「定位到已保存视角」调 `runtime.resetCamera()` → 官方回到**启动时快照**的 A。
- 刷新后 `resolveSceneRuntimeDescriptor` 重新读到 B → 官方 runtime 用 B 初始化 → Reset 回到 B。

也就是说：**"刷新后才能回到 B" 这个失败模式在本轮真实复现。**

复现步骤（已写入报告，**未修改产品代码**，按任务要求留给下一轮修复）：

1. 用开发身份打开 `/model/edit/fix02-semantics`（或任意有 authored 初始相机的场景）。
2. 拖动画布到明显不同的构图。
3. 点「将当前视角设为初始视角」→ 出现"已保存"提示。
4. **不刷新**，再拖动到别处。
5. 点「定位到已保存视角」（或画布右下 Settings → 重置相机）。
6. 相机回到保存前的旧视角 A，而不是刚保存的 B；刷新页面后才回到 B。

严重级：**P1**（功能正确性）。用户体感："我保存了视角，点定位却回不去；
刷新一下又对了"，会直接怀疑保存失败。

建议修法（下一轮）：保存成功后把新的 authored 相机同步进已存在的 runtime
（官方 `state` 的相机由 settings 驱动，需要重建 settings 或调用
`createViewer` 等价路径；也可以让「定位到已保存视角」读 DB 里最新保存值后
用 `setCameraPose()` 直接定位，而不是走 `resetCamera()`）。

**`CAMERA_SAVE_RESET_SAME_SESSION` = FAIL（P1，已复现，未修复）**

---

## 6. 测试 4 —— Walk 安全闸门绕过（`15`/`16`，`walk-safety.json`）

### 6.1 前置条件（真实夹具）

场景 A 的 `scene_processing_settings.calibration`：

```
state = UNVERIFIED, metersPerSceneUnit = null, physicalWalkAllowed = false
```

运行时描述符 `collision = null`（未开启碰撞的场景不注入 collisionUrl），
因此官方 `state.walkAllowed = false`、`hasCollision = false`。
官方 `isWalkAllowed(bbox, collision)` = `!!collision && 水平范围 >= 5` ——
本场景没有碰撞数据，官方自身就拒绝 walk。

宿主尺度诊断：`horizontalExtent = 4.794 m`（`sceneScale.status = 'ok'`），
所以宿主 class 闸门 `gs-walk-blocked` **未启用**（尺度本身是米级，不需要闸门）——
这一轮官方按钮隐藏靠的是**官方自己的** `sse-hidden` class。

### 6.2 测试矩阵

| 入口 | 操作 | 结果 |
|---|---|---|
| 官方 Walk 按钮 | 初始态 | `.sse-fpsCamera` 已存在，`display: none`，class 含 `sse-hidden`；**不可见不可点** |
| 键盘 `2`（控制组） | 画布中心点击后按 | `orbit → fly` ✅ 证明按键没被宿主吞掉 |
| 键盘 `1`（控制组） | 同上 | `fly → orbit` ✅ |
| 键盘 `3`（Walk 快捷键） | 同上 | `orbit → orbit` —— **未进入 walk** |
| 键盘 `w` / `a`（WASD） | 同上 | `w` 触发 `requestFirstPerson` → `fly`（无碰撞时 fly 是官方设计的合法降级）；`a` 保持 `fly`。**均未进入 walk** |
| 宿主 `toggleWalk()` API | `window.__gsruntime.toggleWalk()` | 无变化（`fly → fly`） |
| 官方 Info 面板 | 快捷键表 | Walk 行走条目按官方策略隐藏（`walkShortcutInInfo = true` 表示 info 面板文本存在行走说明条目，但本场景未展示可进入 walk 的入口） |

最终运行态：`cameraMode = fly`、`walkAllowed = false`、`hasCollision = false`、
`collisionStale = false`、`inputEnabled = true`。

### 6.3 结论

**未校准场景下，无论按钮、键盘还是 API，都无法真正进入 walk。**
关键点是：拦截发生在**官方内部**（`state.walkAllowed` 为 false 时
`toggleWalk` / 快捷键 3 / WASD 全部 no-op 或降级到 fly），不是靠宿主的 CSS。
宿主 `gs-walk-blocked` class 是**第二道**防线（尺度未校准时隐藏按钮），
本轮因尺度为米级而未启用 —— 这条路径由契约单测
`super-splat-ui-compatibility.test.ts` 与 GS-DESKTOP-02 的 E2E 覆盖。

一个诚实备注：`w` 会进入 **fly** 而非 walk。这是官方在无碰撞场景下的既定降级
（`requestFirstPerson` → `walkAllowed ? 'walk' : 'fly'`），不是平台放行了不安全模式；
fly 模式有官方碰撞检测但不需要碰撞数据，不涉及"在错误尺度上走路"。

**`WALK_SAFETY_ALL_ENTRY_PATHS` = PASS。**

---

## 7. 测试 5 —— PCUI 创作工作区（`17`–`21`，`pcui-visual.json`）

### 7.1 量化结果（真实 DOM 测量）

| 指标 | 1920×1080 | 1280×720 |
|---|---|---|
| 页面横向滚动 | 无（scrollWidth 1912 < 1920） | 无（1272 < 1280） |
| 需要横向滚动的容器 | 0 | 0 |
| PCUI `Panel` 数 | 3（场景 / 标注 / 视角） | 3 |
| 面板标题重复 | **0** | **0** |
| `<input>` 数 / 重复 | 3 / 1 | 3 / 1 |
| 按钮数 | 55 | 55 |
| `pcui-disabled`（看得见点不动） | **0** | **0** |
| 文字溢出（scrollWidth > clientWidth） | **1 处** | **1 处** |
| 官方底部控件位置 | y=1002（视口内，未被右栏遮挡） | y=642（同样未被遮挡） |
| 右侧属性面板遮挡官方控件 | 否 | 否 |
| 保存状态 | 顶栏「Viewer 就绪」/「保存中…」 | 同 |

### 7.2 逐项核对（对应任务清单）

| 区域 | 结果 |
|---|---|
| 左侧场景分组 | 初始相机 / 世界方向 / 背景 / 后期效果 / 封面 / 背景音乐 ✅ 6 项 |
| 初始相机 | 属性区显示已保存位置 `(2.50, 1.80, 6.00)`、Lens (FOV) 47、定位到已保存视角 / 编辑相机 / 将当前视角设为初始视角 ✅ |
| 世界方向 / 背景 / 后期 / 封面 / 背景音乐 | PCUI 面板 + 上传按钮均渲染 ✅ |
| 标注列表 | `＋ 添加标注` + 标注A/B/C + 每行 ◉/○ 启用开关 ✅ |
| 视角列表 | 视角名称输入 + 保存当前视角 + 正门视角 + ◉/○ ✅ |
| 中间官方 Viewer | 同一个 `ui:true` runtime，官方底部工具条与 hotspot 都在画布内 ✅ |
| 右侧属性面板 | 标注属性（标题/正文/样式/内容类型/媒体资产 ID/文字颜色/文字大小/标注相机 FOV/启用 + 保存修改/用当前视角作为标注相机/上移/下移/定位/删除）✅ |
| 顶部 | 返回 / 场景名 / Viewer 就绪 / 保存初始视角 / 预览 / Gaussian 编辑 / 版本历史 / 碰撞 ✅ |
| 保存状态清晰 | ✅ 顶栏「Viewer 就绪」常驻，保存中按钮变「保存中…」 |
| 操作反馈 | 保存成功/失败、拾取成功/失败都有 antd Modal 文案（本轮实测 3 条）✅ |

### 7.3 发现的问题（均为 P2 UI 微调，不阻塞）

1. **`gs-props__hint` 提示文字被截断**：初始相机面板底部
   "编辑模式下可直接在 Viewer 中 Orbit / Pan / Zoom 取景，再…"
   `scrollWidth > clientWidth`，句尾被裁掉（两种分辨率都有）。
   → 建议 PCUI `Label` 换行或缩短文案。
2. **相机属性面板需要滚动才看完**：「将当前视角设为初始视角」在视口下方，
   1080p 下第一次看不到（见 `19-authoring-camera-properties.webp`：该按钮在折叠位置下方）。
   → 建议把主操作按钮放到面板顶部，或让右栏独立滚动。
3. **FOV 是文本输入框**：`Lens (FOV)` 用 `TextInput`，没有数值步进/范围限制，
   可以输入非数字（保存时才报错）。
   → 建议换 `NumericInput`（PCUI 有，`PcuiField` 已支持）。
4. **`inputDuplicateCount = 1`**：3 个 input 中有一对 id/name/placeholder 完全相同。
   实测不是"一个输入框渲染两份"（面板标题 0 重复、按钮 0 禁用），
   而是两个不同字段用了相同占位符（`media asset id`）。→ 低优先。

**`PCUI_VISUAL_QUALITY` = PARTIAL（可用，有 4 处 P2 微调）**

---

## 8. 测试 6 —— 标注真实交互（`22`–`25`，`annotation-flow.json`）

| 步骤 | 结果 |
|---|---|
| 点「＋ 添加标注」 | 进入拾取模式（`22-annotation-pick-mode.webp`） |
| 点击真实 Gaussian 画布 | 创建成功，Modal：`标注已创建（锚点为近似位置，可在属性区继续编辑）` |
| 数据库 | 标注 3 → 4，新 id `95e3218b-ad38-41c5-968d-fddc4c049360`，带 `cameraPosition` |
| 改名 + 保存修改 | 标题 → `GS-DESKTOP-03 测试标注`，DB 已更新 |
| 关闭创作页，打开浏览页 | 官方 hotspot **4** 个（`1/2/3/4`），`annotations = [标注A, 标注B, 标注C, GS-DESKTOP-03 测试标注]` |
| 点击 hotspot | 官方 tooltip 显示 `标注A标注A`，`selectedAnnotation = 0` |
| 官方导览 0→1→2→3 | `selectAnnotation(i)` 后 selected 与 title 全部对应正确 |
| 隐藏（`enabled=false`） | 重载后 hotspot **4 → 3** ✅ |
| 删除测试标注 | 重载后 hotspot 3，数据库回到 3 条原始标注 ✅ |

数据库 ID / Annotation Camera / Runtime Descriptor 三者一致
（新建标注的 `cameraPosition` 就是创建时作者的 Viewer 相机，SCENE 空间）。

未触碰其他用户的标注（只操作了自己创建的 id，最后删除）。

**`ANNOTATION_AUTHORING_FLOW` = PASS。**

---

## 9. 测试 7 —— 实际视觉观感（`26`–`30`，`visual-quality.json`）

> 用只读的 13M 历史场景（`u-c71ec45417a0`）拍真实画质。
> 纯 3D 画面来自**官方 `captureFrame()`**（无 UI）；带 UI 的整页截图另存
> `*-page.png`。二者在文件名上明确区分。

### 9.1 加载

| 指标 | 值 |
|---|---|
| 首次 `loaded=true` | 3.83 s |
| 格式 | `lod-meta`（streamed-sog，7 级 LOD） |
| renderer | `webgpu` |
| 同时渲染 splats（loaded 时） | 1,915,493 |
| 同时渲染 splats（+10 s） | **1,958,710** |
| chunk 请求数 | **464**，0 失败 |
| LOD 渐进 | 131,632 → 1,958,710 splats（10 s 内持续流入） |
| 场景包围盒 | x[-364.7, 591.5] y[-575.5, 53.3] z[-303.0, 795.8] |

### 9.2 六张画质图 + 像素统计（防止"黑画布冒充"）

统计量：`meanLum` 平均亮度、`stdLum` 对比度、`darkRatio` 近黑像素比例、
`coloredRatio` 有彩色内容的像素比例。

| 截图 | 相机 | gsplats | meanLum | stdLum | darkRatio | coloredRatio |
|---|---|---|---|---|---|---|
| `26-gaussian-initial.webp` | authored `[240,80,400]` | 1,969,072 | 79.10 | 68.05 | 0.308 | 0.495 |
| `27-gaussian-close.webp` | 靠近主体 65% | 1,872,936 | 90.22 | 57.77 | 0.005 | 0.690 |
| `28-gaussian-side.webp` | 绕目标 +60° | 1,963,567 | 75.07 | 66.37 | 0.296 | 0.548 |
| `28b-gaussian-far.webp` | 后退 2.6× | 1,970,851 | 29.44 | 56.53 | 0.732 | 0.180 |
| `29-gaussian-frame.webp` | 官方 Frame | 1,968,818 | 9.85 | 34.92 | 0.901 | 0.055 |
| `30-gaussian-reset.webp` | 官方 Reset | 1,969,072 | 79.10 | 68.06 | 0.308 | 0.495 |

`26` 与 `30` 统计量几乎相同 —— Reset 精确回到 authored 构图（位置误差 < 0.5）。
`26`/`27`/`28` 都有 50%± 的彩色像素，**不是黑屏、不是单色背景**。

### 9.3 观感判断（人工看图）

- **清晰度**：太阳能屋顶的板阵列、停车场地面标线、道路纹理、车辆都清晰可辨
  （`27-gaussian-close.webp`）。
- **高斯边缘废点**：画面边缘（`26` 的左侧与上缘）有可见的飞散 splat 拖影，
  这是摄影测量数据的常见现象，不影响主体判读；`29-gaussian-frame.webp`
  拉到全景后这些飞散点在黑底上更明显。
- **残影/错位**：未发现整块模型错位或拖影残留；旋转 60° 后几何一致。
- **相机跳跃**：未发现。加载完成后相机不动（§3），Reset 是平滑过渡（§4.4）。
- **LOD**：`28b`（远景）与 `26`（authored） splat 数都在 1.97M，
  说明该场景 LOD 基本全量流入；`27`（近景）略降到 1.87M 是距离 LOD 的正常剔除。
- **帧率/加载异常**：无 console error、无 page error、0 失败请求。

**`REAL_GAUSSIAN_VISIBLE` = PASS；`STREAMED_SOG_VISUAL` = PASS。**

---

## 10. 复现命令

```bash
# 0) 隔离显示 + 只读 13M 环境（一次性）
Xvfb :98 -screen 0 1920x1080x24 &
cd apps/api && env GS_ENV=development \
  GS_DATABASE_URL='postgresql+psycopg2://…@127.0.0.1:5432/gsplatform_vr00_20261011' \
  GS_STORAGE_ROOT=~/.local/state/gsplatform-vr00-20261011/storage \
  .venv/bin/python -m uvicorn app.main:app --port 18098 --no-access-log &
cd apps/web && GS_API_PROXY_TARGET=http://127.0.0.1:18098 \
  node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5188 --strictPort &

# 1) 相机时间线（场景 A/B）
cd apps/web && node e2e/gsdesktop03/run.mjs 1

# 2) 官方 Viewer UI 交互
node e2e/gsdesktop03/run.mjs 2

# 3) 保存初始视角 → Reset（会改 fix02-semantics 的初始相机，跑完按 §11 恢复）
node e2e/gsdesktop03/run.mjs 3

# 4) Walk 安全闸门
node e2e/gsdesktop03/run.mjs 4

# 5) PCUI 创作工作区（两种分辨率）
node e2e/gsdesktop03/run.mjs 5

# 6) 标注全流程（会新增再删除一条标注）
node e2e/gsdesktop03/run.mjs 6

# 7) 13M 场景视觉观感（走 5188）
node e2e/gsdesktop03/run.mjs 7
```

证据目录：`docs/reports/gsdesktop03-evidence/`（2.3 MB，55 个文件）。

> **截图格式说明**：证据图统一为 **WebP q85（1600×1000）**，由本轮真实截图近无损转码，
> **未裁切、未修改内容、未后期合成**。原始 PNG 单张 0.5–4 MB，原样入库会让证据目录
> 达到 32 MB（仓库当前仅 23 MB），因此按任务 §11「证据目录过大 → 保留轻量截图与 JSON 入库」
> 处理。纯 3D 画面（官方 `captureFrame()`）与整页截图（含 UI）仍然分开命名：
> `26/27/28/29/30-gaussian-*.webp` 是纯渲染，`*-page.webp` 是整页。

---

## 11. 数据快照与恢复

测试 3 / 6 会改 `fix02-semantics` 的初始相机与标注。测试后已恢复并核对：

| 项 | 测试前 | 测试后 |
|---|---|---|
| `initialCameraPosition` | `{2.5, 1.8, 6.0}` | `{2.5, 1.8, 6.0}` ✅ |
| `initialCameraTarget` | `{0.0, 0.6, 0.0}` | `{0.0, 0.6, 0.0}` ✅ |
| `initialCameraFov` | 47 | 47 ✅ |
| 标注 | 3（标注A/B/C） | 3（同 id，同 enabled） ✅ |
| 视角 | 1（正门视角） | 1 ✅ |

13M 场景全程只读，未写库（用只读用途的独立 API 实例 + 只发 GET 验证）。

---

## 12. 未完成 / 无法获得 / 需人工

| 项 | 状态 | 说明 |
|---|---|---|
| 30 张指定截图 | **全部 30 张已获得**（`01`–`30`，另加 B 场景对照与远景补充共 8 张） | 见 §12.1 |
| 短视频 | **未录** | 未出现需要动态复现的故障；Reset 过渡动画的时序用 `reset-convergence.json` 量化代替 |
| Playwright Trace ZIP | **未录** | 本轮用 DOM/运行态 JSON + 截图取证，未启用 trace（会显著增大目录） |
| 触屏 / 移动端官方 UI | **未测** | 本轮只验证桌面鼠标路径；官方按 `sse-desktop` / `sse-touch` 切换布局，需要真实触屏设备 |
| Firefox / Safari | **未测** | 环境只有 Chrome/Firefox；官方 Viewer 需要 WebGPU，Firefox 支持仍不完整 |
| 真机 VR / PICO | **未测**（无硬件） | XR 代码本轮未改，沿用 FIX-04 的 BLOCKED 标注 |
| 性能模式下的帧率 | **未量化** | 只记录 `performanceMode` 状态翻转，未测 FPS 曲线 |
| `CAMERA_SAVE_RESET_SAME_SESSION` | **FAIL（P1）** | 见 §5.5，**未修复**（按任务要求不得自行改产品代码） |

### 12.1 截图清单（30/30 全部获得）

| 编号 | 文件 | 内容 | 来源页面 |
|---|---|---|---|
| 01 | `01-loading-poster.webp` | 场景 A 首屏加载态（该夹具无 poster） | `/scene/fix02-semantics` |
| 02 | `02-first-gaussian-frame.webp` | 首帧真实 Gaussian（59,400 splats） | 同上 |
| 03 | `03-loaded-stable-2s.webp` | loaded + 2 s，相机未动 | 同上 |
| 04 | `04-loaded-stable-8s.webp` | loaded + 8 s，相机未动 | 同上 |
| 05 | `05-viewer-official-ui.webp` | 官方原生 UI 全貌 | 同上 |
| 06 | `06-viewer-settings.webp` | 官方设置面板（Frame/Reset/Performance/Annotations） | 同上 |
| 07 | `07-viewer-info.webp` | 官方 Info 面板（v1.35.0 / WebGPU nvidia） | 同上 |
| 08 | `08-viewer-fullscreen.webp` | 官方全屏态 | 同上 |
| 09 | `09-viewer-annotation-navigation.webp` | 官方标注导览跳转后 | 同上 |
| 10 | `10-camera-before-edit.webp` | 创作页初始相机 A `[2.5,1.8,6]` | `/model/edit/fix02-semantics` |
| 11 | `11-camera-position-b.webp` | 鼠标拖到 B `[3.708,0.714,2.537]` | 同上 |
| 12 | `12-camera-saved-b.webp` | 保存后（DB 与运行时均为 B） | 同上 |
| 13 | `13-camera-reset-without-reload.webp` | **不刷新 Reset → 回到 A**（缺陷现场：右侧显示已保存 B） | 同上 |
| 14 | `14-camera-reset-after-reload.webp` | 刷新后 Reset → 正确回到 B | `/scene/fix02-semantics` |
| 15 | `15-walk-blocked-ui.webp` | Walk 入口不可用（官方 `sse-hidden`） | 同上 |
| 16 | `16-walk-keyboard-test.webp` | 键盘 `3`/`W`/`A` 测试后的状态 | 同上 |
| 17 | `17-authoring-1920x1080.webp` | PCUI 工作区 1920×1080 | `/model/edit/fix02-semantics` |
| 18 | `18-authoring-1280x720.webp` | PCUI 工作区 1280×720 | 同上 |
| 19 | `19-authoring-camera-properties.webp` | 初始相机属性面板 | 同上 |
| 20 | `20-authoring-annotation-properties.webp` | 标注属性面板 | 同上 |
| 21 | `21-authoring-viewpoint-properties.webp` | 观察点属性面板 | 同上 |
| 22 | `22-annotation-pick-mode.webp` | 拾取模式（＋添加标注后） | 同上 |
| 23 | `23-annotation-created.webp` | 标注已创建并改名 | 同上 |
| 24 | `24-annotation-hotspot.webp` | 浏览页 4 个官方 hotspot | `/scene/fix02-semantics` |
| 25 | `25-annotation-navigation.webp` | 官方导览跳转 | 同上 |
| 26 | `26-gaussian-initial.webp` | 13M 场景 authored 视角（1,969,072 splats） | `/scene/u-c71ec45417a0` |
| 27 | `27-gaussian-close.webp` | 靠近主体 | 同上 |
| 28 | `28-gaussian-side.webp` | 侧面（绕 60°） | 同上 |
| 29 | `29-gaussian-frame.webp` | 官方 Frame 后的全景（含高处漂浮点） | 同上 |
| 30 | `30-gaussian-reset.webp` | 官方 Reset 回到 authored 视角 | 同上 |

补充（不属于 30 张编号，供对照/取证）：

- `01b`–`04b`：场景 B（streamed-sog）同四个阶段；
- `02b/04b-*-render.webp`：场景 B 的纯渲染图（179 splats，LOD 首级）；
- `19b/20b/21b-*-1280x720.webp`：三块属性面板在 720p 下的对照；
- `26-gaussian-initial-page.webp`、`29-gaussian-frame-page.webp`：含 UI 的整页截图。

---

## 13. 问题清单与优先级

### P1（建议下一轮专门修复，本轮只记录未改代码）

1. **保存初始视角后，同一会话内的 Reset 回到旧视角**
   - 复现：§5.5 的 6 步。
   - 影响：用户保存视角后点「定位到已保存视角」/官方 Reset 得到旧构图，必须刷新才对。
   - 根因：保存只写 `scene_presentations`，官方 runtime 的 `settings.cameras[0].initial`
     仍是 `createViewer` 时的快照。
   - 证据：`camera-save-reset.json`（`errorToBWithoutReload = 3.8248`，
     `errorToBAfterReload = 4.5e-5`）。

### P2（UI 微调，可暂缓）

2. 相机属性面板的 `gs-props__hint` 文案被截断（两种分辨率）。
3. 「将当前视角设为初始视角」在 1080p 下需要滚动才可见。
4. `Lens (FOV)` 是 `TextInput`，无数值校验/步进。
5. 两个字段共用占位符 `media asset id`（视觉上易混，非功能性 bug）。

### 观察项（不算缺陷）

6. 无碰撞场景按 `w` 会进入 **fly**（官方既定降级，不是平台放行 walk）。
7. 官方 Reset 是 ~4 s 的过渡动画；断言/测试必须等它收敛（`reset-convergence.json`）。

---

## 14. 本轮改动的文件

```
apps/web/e2e/gsdesktop03/common.mjs   # headful + NVIDIA 启动参数、取证工具
apps/web/e2e/gsdesktop03/run.mjs      # 7 个阶段的验收脚本
docs/reports/GS_DESKTOP_03_REAL_BROWSER_ACCEPTANCE.md
docs/reports/gsdesktop03-evidence/    # 55 个证据文件（2.3 MB）
```

**未修改任何产品功能代码**（`git status` 中 `src/` 无改动）。

最终 Git commit SHA：`05ded2c`（本轮验收基线；本轮只新增测试脚本与报告，
提交 SHA 见任务交付回复）。

