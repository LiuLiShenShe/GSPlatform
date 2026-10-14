# GS-NEXT-04A — Annotation / Hotspot 导览能力审计

> 日期：2026-10-14｜基线 HEAD：`4454f31`（GS-NEXT-03 之后的 main）
> 性质：**纯审计**。未新增数据模型、未改 CameraManager、未开发任何 UI、未改生产代码。
> 本文件是决定 GS-NEXT-04 范围的前置依据。

## 0. 证据边界

官方能力以**仓库锁定的安装包**为准（与 `docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md`
§1 的版本边界一致）：`@playcanvas/supersplat-viewer@1.35.0`（tag `329a80a`）的
`dist/settings.d.ts` / `dist/viewer.d.ts` / `dist/settings.js`。本文所有"官方行为"
论断均可在 `apps/web/node_modules/@playcanvas/supersplat-viewer/` 内直接核对，未凭记忆。
数据现状取自 dev 库 `gsplatform` 的**只读**查询。

---

## 1. 五个问题的直接回答

### Q1. 当前 SuperSplat 官方 Annotation 是否已经被加载？ → **是，已完整加载并渲染热点**

链路是通的，不存在"只存了数据没喂给官方"的情况：

```text
SceneAnnotation(DB) → SceneRuntimeService._build_annotations()
  → SceneRuntimeDescriptorV1.annotations[]
  → buildExperienceSettings() → buildAnnotations() → settings.annotations[]
  → createViewer({ settings, ui: true })        ← ui:true 才建官方热点层
  → 官方 initUI 投影 .sse-annotation-hotspot
  → 用户点击热点 → 官方 selectAnnotation(index) + CameraManager 过渡
  → onSelectedAnnotationChanged → extras.gsplatform.annotationId → GSPlatform 解析
```

- `useSuperSplatDesktop.ts:216` 与 `useSuperSplatXR.ts:275` 都传 `ui: true`
  （`SuperSplatRuntime.ts:1144-1147` 说明：`ui:true` 是官方热点/tooltip 的前提）。
- `superSplatUiCompatibility.ts:42-43` 只隐藏 `.sse-ui`（官方冗余控件）、
  保留 `.sse-sceneLayer`（标注层）—— 热点**没有被**屏蔽。
- 选中回流：`SuperSplatRuntime.ts:334-347` 读 `extras.gsplatform.annotationId`，
  **不用数组 index 当数据库 ID**（设计正确）。

### Q2. 当前 ExperienceSettings 是否包含 annotation 数据？ → **包含，但有 4 个字段是死数据**

`settings.annotations[]` 由 `experienceAdapter.ts:215-278` 生成，每条含：

| 官方字段 | 来源 | 状态 |
| --- | --- | --- |
| `position` | `a.anchor` 经世界变换换算（`:246`） | 已映射 |
| `title` | `a.title`，sanitize + 截断 60（`:242`） | 已映射 |
| `text` | `a.textContent`，sanitize + 截断 280（`:243`） | 已映射 |
| `extras` | `{ gsplatform: { annotationId, contentType } }`（`:274`） | 已映射 |
| `camera.initial` | 该标注自己的 `cameraPosition/Target/Fov`，否则回落场景初始相机（`:253-267`） | 已映射 |

**未映射的已有字段**（DB 里有、描述符里有、但官方 `Annotation` 类型
（`settings.d.ts:33-39`）根本没有对应项，因此永远不会被渲染）：

- `style`（`LEADER_TEXT` / `NUMBER_POPUP` / `HIDDEN`）
- `textColor`、`textSize`
- `description`（只在 `AnnotationMediaOverlay.tsx:162` 的媒体分支里显示；TEXT 标注看不到）

**从未使用的官方字段**：`startMode`（官方 `default | animTrack | annotation`）
全仓库无任何引用 —— 即当前**没有"默认导览点"这个概念**。

### Q3. 当前 GSPlatform 是否已有 marker/hotspot 数据模型？ → **有，且相当完整**

- 表 `scene_annotations`（`apps/api/app/db/models/scene_annotation.py:18-89`）：
  标题/描述/锚点/样式/内容类型/文本/媒体外键/颜色/字号/fov/**9 列自有相机 pose**/
  order_index/enabled。
- DTO `schemas/scene_annotation.py`（Out/Create/Update/Reorder）。
- 路由 `api/v1/scene_presentation.py:355-460`：list / create / reorder / patch /
  delete / **媒体上传与带鉴权分发**。
- 描述符输出 `schemas/scene_runtime.py:110-135`。
- 作者面板 `features/authoring/AnnotationPanel.tsx`（增/改标题文本/启用停用/删除）。

**但数据现实必须说清楚**（dev 库只读查询）：

| 指标 | 值 |
| --- | --- |
| 标注总数 | 2,364 |
| 覆盖场景 | 2,007（且这 2,007 个场景全部 PUBLISHED） |
| 带自有相机 | 473 |
| 带媒体资产 | 812 |
| 标题种类 | 仅 `水井` / `入口` / `媒体标注` / `标注` 等少数几种 |
| 锚点取值 | 几乎全是 `±1.0` |
| 带相机标注的标题种类 | **4** |

结论：这 2,364 行**全部是种子/演示数据**（用于契约与权限测试），**没有任何一条是真实
用户作者化的**。因此"Annotation 能力是否被真实使用过"的答案是**否** —— 这决定了
GS-NEXT-04 的价值不在"补数据通路"，而在"补 XR 交互入口"。

### Q4. Viewpoint 是否可以直接作为 Annotation 的 camera target？ → **结构上完全可以，但当前没有任何链接**

现状（三处都断开）：

1. 数据层：`SceneAnnotation` 与 `SceneViewpoint` **没有任何字段或外键互指**。
2. 适配层：`buildAnnotations()` 只读标注自己的 `camera*` 列，**从不查 viewpoints**
   （`experienceAdapter.ts:253-267`）；没有相机时逐条回落到**场景初始相机**。
3. 运行时：视点导航走的是 `navigateToPose()` 注入的**隐藏 pose 标注**
   （`SuperSplatRuntime.ts:772-807`），与作者标注是两套条目。

**但是**：两者形状完全一致（position/target/fov），并且**已经共用同一个
`SceneTransformAdapter` 换算**。所以存在一条**零新增数据模型**的路径 ——
新增一个作者动作「用视角 X 的相机」，把该 viewpoint 的 pose **复制**进标注
**已有的** `camera_position_*` / `camera_target_*` / `camera_fov` 九列。
不需要迁移、不需要新列、不需要第二套数据。

> 另一条"直接把 viewpoint 当 target"的运行时捷径被明确排除：它会让标注相机变成
> 隐式猜测（跟着 viewpoint 改名/删除而漂移），与 GS-NEXT-02 记录的
> "绝不共用默认值猜测" 原则冲突。

### Q5. Desktop 和 XR 是否可以复用同一 Annotation 数据？ → **数据已经完全共用；交互层在 XR 不可用**

**共用部分（已成立，无需任何改动）**：两个 hook 走同一个 `getSceneRuntime()` 描述符 →
同一个 `buildExperienceSettings()` → 同一份 `settings.annotations` → 都传 `ui:true`
→ 都订阅 `selectedGsplatformAnnotation` → 都挂载同一个 `AnnotationMediaOverlay`。
这正是任务要求的"同一份数据"。

**断掉的部分（三条，都要真机才能验）**：

1. **官方热点是 DOM + 鼠标监听**。immersive VR 会话里 DOM overlay 不可见、鼠标不可用
   → 头显内**没有任何可点击的热点**。这与 GS-NEXT-03 §四 是同一个已知限制。
2. **`.sse-ui` 被本项目隐藏**（`superSplatUiCompatibility.ts:42`）→ 官方自带的
   Annotation Navigator（Prev/Next 导览器）**在 Desktop 也看不到**。GSPlatform 工具栏
   只有"显示/隐藏热点"开关（`OfficialViewerToolbar.tsx:145-153`），**没有导览列表**。
3. **即使能在 VR 里点到热点，`selectAnnotation` 也不会移动 XR Rig**（VR-03 §8 已验证：
   `app.xr.active` 时官方跳过桌面相机管理器）。写桌面相机 pose ≠ XR 传送。

---

## 2. 当前代码位置（审计索引）

### 后端
| 位置 | 职责 |
| --- | --- |
| `apps/api/app/db/models/scene_annotation.py:18-89` | 标注表（含 9 列自有相机 pose） |
| `apps/api/app/schemas/scene_annotation.py:15-88` | 标注 DTO（Out/Create/Update/Reorder） |
| `apps/api/app/schemas/scene_runtime.py:110-135` | `RuntimeAnnotation` 描述符块 |
| `apps/api/app/schemas/scene_runtime.py:190-191` | 描述符里的 `viewpoints` / `annotations` |
| `apps/api/app/api/v1/scene_presentation.py:355-460` | 标注 CRUD + reorder + 媒体上传/分发 |
| `apps/api/app/services/scene_runtime.py:355, 437-484` | 描述符组装；`:365` **STALE 时整表抑制** |
| `apps/api/app/db/models/scene_viewpoint.py` | 视点表（无标注关联） |

### 前端 runtime 层
| 位置 | 职责 |
| --- | --- |
| `apps/web/src/scene-runtime/types.ts:125-148` | `RuntimeAnnotation` 前端类型（含"锚点是近似值"告警） |
| `apps/web/src/scene-runtime/experienceAdapter.ts:195` | `settings.annotations = buildAnnotations(...)` |
| `apps/web/src/scene-runtime/experienceAdapter.ts:215-278` | 官方标注编译（filter → cap 25 → sanitize → 换算 → extras → camera） |
| `apps/web/src/scene-runtime/SuperSplatRuntime.ts:148` | `readonly annotations`（官方数组，只读） |
| `.../SuperSplatRuntime.ts:334-347` | `selectedGsplatformAnnotation`（extras → DB ID） |
| `.../SuperSplatRuntime.ts:514-520` | `selectAnnotation()` / `clearAnnotation()` 转发官方 |
| `.../SuperSplatRuntime.ts:588-590, 772-807` | 视点导航用**注入的隐藏 pose 标注**（非作者标注） |
| `.../SuperSplatRuntime.ts:905` | `onSelectedAnnotationChanged()` |
| `.../SuperSplatRuntime.ts:1144-1147` | `ui` 开关透传 |
| `apps/web/src/scene-runtime/superSplatUiCompatibility.ts:23-43` | 隐藏 `.sse-ui`（连带隐藏官方 Navigator） |

### 页面 / UI
| 位置 | 职责 |
| --- | --- |
| `apps/web/src/pages/SceneAuthoringPage.tsx:176-223` | 拾取建标注（**单击**）+ 捕获当前相机 |
| `.../SceneAuthoringPage.tsx:108, 155` | `ui:true`；`annotationRevision` 变化即重建预览 runtime |
| `apps/web/src/features/authoring/AnnotationPanel.tsx` | 列表/编辑/停用/删除（无 reorder、无 limits 提示） |
| `apps/web/src/features/viewer-official/OfficialViewerToolbar.tsx:145-153` | **仅**显示/隐藏热点开关 |
| `.../OfficialViewerToolbar.tsx` | Saved Views 下拉（视点，非标注） |
| `apps/web/src/pages/SceneViewerPage.tsx:93-99` | Desktop 媒体 Overlay |
| `apps/web/src/pages/XRViewerPage.tsx:171-175` | XR 页**也**挂了同一 Overlay（但 immersive 内不可见） |
| `apps/web/src/features/viewer-official/AnnotationMediaOverlay.tsx` | IMAGE/VIDEO/AUDIO/PANORAMA 渲染 |

### 官方契约（锁定 1.35.0）
| 位置 | 事实 |
| --- | --- |
| `dist/settings.d.ts:33-39` | `Annotation = { position, title, text, extras?, camera }` —— **无 style/color/size** |
| `dist/settings.d.ts:78-85` | `ExperienceSettings` 另有 `startMode` |
| `dist/settings.js` | `ANNOTATION_LIMITS = { maxCount: 25, titleMax: 60, textMax: 280 }` |
| `dist/viewer.d.ts:199-200, 233-239` | `annotations` 只读；`selectAnnotation(index|null)` 无完成 Promise |

### 既有文档
- `docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md` —— 2026-10-12 的详尽预审。
  **本审计复核了其中 §3/§4/§7/§8/§9 的结论，全部仍然成立**；唯 §8 里
  "XR rig 放置尚不存在"一条**已被 GS-NEXT-02/03 改变**（见 §5）。

---

## 3. 已存在能力

1. **完整数据模型**：`SceneAnnotation` 表 + DTO + 索引 + 带鉴权的媒体上传/分发。
2. **完整 CRUD**：list / create / update / delete / reorder（API + 作者面板）。
3. **官方热点已上线**：desktop 与 XR 两页都 `ui:true`，官方 marker 正常投影、
   可点、官方相机过渡生效。
4. **稳定的 ID 协议**：`extras.gsplatform.{annotationId, contentType}`，
   全链路**从不用数组 index 当数据库 ID**（这是 VR-03 §4 点名的好设计，应保留）。
5. **世界变换正确**：锚点与相机都经同一个 `SceneTransformAdapter` 换算到 RUNTIME 空间。
6. **媒体 Overlay 统一**：IMAGE/VIDEO/AUDIO/PANORAMA 由 GSPlatform 自绘组件渲染，
   TEXT 交给官方 tooltip，媒体播放时 duck 背景音频。
7. **官方限值已 clamp**：25 条 / 标题 60 / 正文 280，`validateSettings(limits:true)` 兜底。
8. **XR rig 一次性放置已经存在**（GS-NEXT-02/03 的成果）：
   `setXRInitialCamera()` + `prepareXRSpawn()` + `isTrackedHeadPose()` 门控，
   已能把**任意 viewpoint 的 pose** 写成 XR 出生位姿。

## 4. 缺失能力

| # | 缺口 | 位置/证据 | 影响 |
| --- | --- | --- | --- |
| M1 | **XR 内无可交互热点入口** | 官方热点 = DOM + 鼠标；`XRViewerPage` 无任何标注入口 | 导览在 VR 中完全不可用（阶段 3 核心缺口） |
| M2 | **官方 Annotation Navigator 被隐藏** | `superSplatUiCompatibility.ts:42` 整层隐藏 `.sse-ui`，而官方导览器就在其中（见 §6.1） | Desktop 也缺 Prev/Next 导览器 —— **这是可以直接拿回来的官方 UI** |
| M3 | 标注↔视点无关联 | 两张表无互指；`buildAnnotations` 不查 viewpoints | 无法"用视角当导览点相机" |
| M4 | `style`/`textColor`/`textSize`/`description` 是死数据 | 官方 `Annotation` 无对应字段 | 作者以为可配，实际不生效 |
| M5 | 官方限值**静默截断**，作者界面无提示 | `experienceAdapter.ts:242-243` 直接 `.slice` | 作者写 1000 字正文以为全可见 |
| M6 | 拾取是近似 bbox 深度，非表面命中 | `pickApproximateWorldPosition`（FIX-05 §29；UI 已标"近似锚点"） | 标记可能悬空/穿模 |
| M7 | 面板文案写"双击"，实际绑的是单击 | `SceneAuthoringPage.tsx:176` `onClick` | 与官方双击聚焦冲突（VR-03 §6） |
| M8 | 无"默认导览点" | `startMode` 全仓库未使用 | 每次进入都从初始视角开始 |
| M9 | STALE 场景标注全被抑制 | `scene_runtime.py:365` | 与 viewpoints 同一策略（几何变更后需重新作者化） |
| M10 | 无 reorder 控件 | `AnnotationPanel` 注释提到但未实现 | 导览顺序只能靠后端改 |
| M11 | 无 XR 标注测试 | 现有 e2e 只覆盖 authoring/media/audio | XR 路径零覆盖 |

## 5. 需要修订的既有结论（VR-03，2026-10-12）

VR-03 §8 写道"XR rig 放置需要未来做一个薄适配"。**这一条已经过期**：
GS-NEXT-02 落地了 `prepareXRSpawn()`（等首个有效 tracked head pose 再一次性写 Rig），
GS-NEXT-03 又把它泛化成 `setXRInitialCamera()`，使其可接受**任意 viewpoint 的 pose**。

这改变了 GS-NEXT-04 的成本结构：**从零到"任意已存位姿的 XR 放置"这一步已经付过了**，
剩下的只是"把哪个位姿喂给它"的选择权（viewpoint 已有；annotation 需要映射）。

VR-03 §4 另一条**仍然成立且重要**：`ensurePoseAnnotation()` 把官方 `readonly` 数组
转成可变并追加条目，违反官方公开契约（`viewer.d.ts:199-200` 明确说 editing unsupported），
且会污染 Navigator 的长度/下标假设。**新增能力不应继续依赖它**（视点现状是"已存在的
兼容行为，隔离看待"，不是可扩展的公共 API）。

---

## 6. 推荐下一步

### 6.0 前置原则：能用官方 UI 就不用自绘的

> **项目原则（用户明确要求，2026-10-14）**：前端 UI **凡是官方已有的，一律直接复用官方**；
> 自绘的观感不可能优于官方，且会分叉出第二套样式与交互。
> 本报告 §6.1 是按这条原则重新审视后的结论 —— 它把 GS-NEXT-04 的首选从
> "自绘导览 UI" 改成了 "把被隐藏的官方导览器放行"。

### 6.1 官方 Annotation UI 的完整清单（锁定 1.35.0，已逐条核对 DOM）

官方 `uiHtml` 的容器结构（`dist/viewer.js:4193`，SVG 已折叠）：

```html
<div class="sse-sceneLayer"></div>          ← 标注层（GSPlatform 已保留）
<div class="sse-ui">                       ← 官方 chrome（GSPlatform 整层隐藏）
    <div class="sse-controlsWrap">…</div>       官方工具条（GSPlatform 用 React 自绘替代）
    <div class="sse-joystickBase">…</div>
    <div class="sse-annotationNav sse-hidden">  ★ 官方导览器（被隐藏）
        <button class="sse-annotationPrev"></button>
        <div class="sse-annotationInfo">
          <span class="sse-annotationNavNumber"></span>
          <span class="sse-annotationNavTitle"></span>
        </div>
        <button class="sse-annotationNext"></button>
    </div>
    <div class="sse-controlsHint">…</div>
    <div class="sse-settingsPanel">…</div>
    <div class="sse-infoPanel">…</div>
    <div class="sse-tooltip"></div>            官方标注 tooltip（被隐藏）
</div>
```

| 官方 UI | 所在容器 | GSPlatform 现状 | 能否直接复用 |
| --- | --- | --- | --- |
| 标注热点 `.sse-annotation-hotspots` | **`.sse-sceneLayer`**（`viewer.js:2963` 显式 append） | ✅ 可见、可点 | 已在用 |
| 导览器 `.sse-annotationNav`（Prev/Next + 序号 + 标题） | `.sse-ui`（`initAnnotationControls`，`viewer.js:2658-2700`） | ❌ 被整层隐藏 | **可放行**：逻辑全由官方 `selectAnnotation` 驱动，零自研 |
| 标注 tooltip `.sse-tooltip` | `.sse-ui` | ❌ 被隐藏 | 可评估放行 |
| 工具条 `controlsWrap` / 设置面板 / infoPanel / 快捷键提示 | `.sse-ui` | ❌ 有意隐藏（React 自绘替代） | 不恢复 |

官方导览器的行为**全部现成**（`viewer.js:2668-2698`）：
- `annotations.length < 2` 时自动 `sse-hidden` 且按钮 disabled；
- 循环切换 `(i±1 + n) % n`；
- 序号 = `i+1`、标题 = `annotations[i].title`，随 `state.selectedAnnotation` 自动更新；
- 未选中时 `sse-unselected` 置灰，点击信息区即选中；
- 显隐跟随 `state.showAnnotations` —— **与 GSPlatform 工具栏的 Annotations 开关天然联动**。

**结论：Desktop 侧的"导览点切换 UI"根本不需要写。** 只需要把
`superSplatUiCompatibility.ts:42` 的整层 `.sse-ui { display:none }` 改成
**按具体官方模块隐藏**（保留 `.sse-annotationNav`），即拿到官方外观 + 官方序号 +
官方循环导航 + 官方相机过渡。

**必须如实说明的风险**：
- `.sse-*` 是官方**内部 class**，`superSplatUiCompatibility.ts:6-7` 自己就写明
  「官方不保证稳定公开 API」。该层已固定 pin 在 1.35.0，升级依赖时必须重跑这层测试。
- 官方导览器默认 `sse-hidden`，靠官方 `initUI` 的状态订阅才显示；GSPlatform 若隐藏其
  父层，恢复后需实测是否正常显现。
- 布局可能与 GSPlatform 自绘的 `OfficialViewerToolbar` 抢占位置/层级，需真实浏览器核对。

### 6.2 推荐：GS-NEXT-04 = Desktop 先拿回官方导览器，XR 再补进入前选择

**理由**：
- 唯一真正的产品缺口仍是 M1（VR 内没有入口）；M2 现在有零自研的官方解法。
- Desktop 侧按 6.1 改一处 CSS 作用域即可拿到官方导览体验 —— 属于「用官方 UI」而非「自绘 UI」。
- XR 侧官方**没有**可复用的世界空间 UI（官方 UI 全部是 DOM），因此那里的选择器属于
  「官方确实没有」的例外，只能薄薄一层，且应与 GS-NEXT-03 的 viewpoint picker 同构。

**建议范围（供决策，本任务不实施）**：

| 项 | 做法 | 是否需新增代码 |
| --- | --- | --- |
| Desktop 导览器 | 按 §6.1 把 `.sse-ui` 改成按模块隐藏，放行 `.sse-annotationNav` | 改 `superSplatUiCompatibility.ts` 一处 + 浏览器/契约测试 |
| XR 进入前导览点选择 | 与 viewpoint picker 同构；选项来自 `descriptor.annotations`（仅带 authored camera 的） | 少量前端（官方无对应物，属例外） |
| 标注 pose → 出生位姿 | `worldTransform.sceneToRuntimeCamera()` → `setXRInitialCamera()`（GS-NEXT-03 已有） | 几乎零新增 |
| 数据模型 | **不动** | 无 |
| M5 限值提示 | 作者面板显示官方 25/60/280 | 少量 UI |
| M4 死数据 | **不建议**补 `style`/color —— 官方无对应字段，只能自绘热点（等于自研热点系统）。应在 UI 上**如实说明不支持** | 少量 UI 文案 |
| M7 双击绑定 | 若要做，改真双击并避免与官方聚焦冲突 | 需验证 |

**不建议现在做**（与 VR-03 §13 一致）：XR 内的世界空间菜单/3D 热点球、自研热点
投影与 tooltip、自研 Prev/Next（官方已有，直接放行即可）、自研导航/传送、
把 annotation 相机变成隐式跟随 viewpoint 的猜测。

### 6.3 必须在 GS-NEXT-04 验收里保留的硬门禁
- 真机 PICO Neo3：进入 VR 前选定的导览点 = 出生位姿（软件只能证明到
  `xrSpawnStatus`，**真机出生点是 PENDING**）。
- 不退化官方导航：放置后摇杆移动/转向仍然正常、退出重入官方恢复完好。
- 同一批 annotation ID 在 Desktop 与 XR 两侧解析一致（不得为 VR 复制一份数据）。
- 官方导览器恢复后：`showAnnotations` 开关、序号/标题、循环导航、相机过渡全部正常。

---

## 7. 是否需要新增代码

**分场景回答（GS-NEXT-04A 本身：不需要，已交付本报告）**：

| 目标 | 是否需要新增代码 |
| --- | --- |
| 只做审计 | **否**（本报告） |
| 让 Desktop 标注可用 | **否** —— 已经是官方热点 + 官方过渡在工作 |
| 让 Desktop 有导览点切换 UI | **否** —— 官方导览器现成，改一处 CSS 作用域放行即可（§6.1） |
| 让 XR 有导览入口 | **是（少量）** —— 官方 UI 全是 DOM、immersive 内不可用，属"官方确实没有"的例外 |
| 让标注相机 = 某个 viewpoint | **是（少量，且零新列）** —— 一个作者动作，把 viewpoint pose 复制进标注已有的 `camera_*` 列 |
| 做 XR 内的世界空间热点/菜单 | **是（很大）** —— 等于自研 VR UI 系统，**明确不建议** |

**明确不需要新增数据模型。** `SceneAnnotation` 与 `SceneViewpoint` 现有列已经能表达
GS-NEXT-04 的全部需求；任何"第三张导航表"都属于重复建设。

> 按 §6.0 的「能用官方就不用自绘」原则，Desktop 侧的预期新增代码量是 **0 行**——
> 官方导览器、序号、标题、循环导航、相机过渡全都是现成的。

---

## 8. 结论

GSPlatform 的 Annotation 能力**远比预想的完整**：模型、CRUD、官方热点、官方相机过渡、
媒体 Overlay、世界变换换算、官方限值全部到位，Desktop 今天就能点。

按「能用官方就直接用」这条原则重新审视后，缺口进一步缩小：

- **Desktop**：连导览点切换 UI 都不需要写 —— 官方 `.sse-annotationNav`（Prev/Next +
  序号 + 标题 + 循环 + 官方过渡）是现成的，只是被本项目整层隐藏了，放行即可。
- **XR**：官方 UI 全是 DOM、immersive 内不可用，"进入前选择" 才是真正需要薄薄一层的
  地方；而 GS-NEXT-03 刚铺好的出生位姿通路，让它的成本从「从零实现 XR 放置」降到了
  「加一个进入前选择器」。

因此 GS-NEXT-04 的边界可以定得很窄：**Desktop 放行官方导览器（零自绘）；
XR 复用同一批 Annotation ID 走 GS-NEXT-03 的 `setXRInitialCamera`；
不加数据模型、不做 VR UI 系统。** 是否做、以什么顺序做，交给下一步决策。