# GS-DESKTOP-02 —— 官方 Viewer 原生 UI 与官方 PCUI 创作工作区迁移

> 任务：GS-DESKTOP-02｜日期：2026-10-24｜基线 HEAD：`6a62f16`
> 用户诉求：电脑浏览器里的 Viewer 必须显示 SuperSplat **官方原生 UI**，创作页必须用
> 官方 **PlayCanvas PCUI** 工作区，而不是平台自绘的第二套工具条/面板。
>
> **结论：浏览页恢复 `@playcanvas/supersplat-viewer@1.35.0` 的完整原生 UI（相机模式、
> Reset/Frame、设置、性能、标注显隐、帮助、全屏、标注导览与 hotspot 全部由官方 DOM
> 与官方事件驱动）；创作页改为官方 `@playcanvas/pcui@6.1.4` 工作区；宿主自绘的 8 个
> 创作面板 + 2 个 Viewer 工具条被删除。官方 Viewer 版本与源码未改动，未引入旧版 fork，
> 未复制 Studio 私有页面，未接 superspl.at 账号流程。**

---

## 1. 验收标志

| 标志 | 判定 | 依据 |
| --- | --- | --- |
| `OFFICIAL_VIEWER_UI_RESTORED` | **PASS** | `/scene/:id` 的 `.sse-controlsWrap` / Orbit / Fly / Settings / Info / Fullscreen / annotationNav / hotspot 全部 `isVisible()` 且有命中尺寸（>8×8） |
| `NO_DUPLICATE_TOOLBAR` | **PASS** | 旧宿主 `ov-frame` / `ov-reset` / `ov-walk` / `ov-performance` / `ov-annotations` / `ov-fullscreen` / `ov-exit-fullscreen` / `ov-camera-mode` 全部 `toHaveCount(0)`；平台布局的全屏按钮也已移除 |
| `OFFICIAL_UI_INTERACTIVE` | **PASS** | 官方 Reset 真实回到 authored 初始视角；Frame 只在用户点击时取景；Orbit↔Fly 切换写官方 `state.cameraMode`；Annotations 行翻转 `state.showAnnotations`；标注导览 Next/Prev 真实切换 |
| `PCUI_AUTHORING_WORKSPACE` | **PASS** | 创作页 45 个 `.pcui-element`、3 个 PCUI `Panel`、25 个 PCUI 按钮、1 个 canvas；左分组 / 中间官方 Viewer / 右属性三栏真实可见 |
| `ANNOTATION_PICK_E2E` | **PASS** | 点击「＋ 添加标注」进入拾取模式 → 点击真实 Gaussian 画布 → 数据库 3→4 条标注（含相机 pose）→ 官方 hotspot 数量跟随 |
| `AUTHORED_CAMERA_ROUNDTRIP` | **PASS** | 编辑相机 → 保存 → 关闭重开：`[1.161,1.157,2.786]` 与保存值距离 `0.00051` |
| `NO_AUTO_FRAME_ON_LOAD` | **PASS** | 加载完成后 6 秒空闲漂移 `0`（GS-DESKTOP-01 回归） |
| `STREAMED_AND_SINGLE_FILE` | **PASS** | `lod-meta`（streamed）与 `sog`（单文件）各跑一次官方 UI 主流程，Reset 都不静默失败 |
| `NO_CONTEXT_LEAK` | **PASS** | 进出创作模式 3 次，canvas 数 `1 → 1` |
| `UNIT_TYPE_LINT` | **PASS** | Vitest 381/381、`tsc -b --noEmit` 0 错误、`oxlint src` 0 告警 |
| `XR_UNCHANGED` | **PASS（软件）** | XR 路径未改；桌面/XR 共用同一官方 runtime。真机仍需复测（无 PICO 设备） |
| `OFFICIAL_STUDIO_SOURCE_REUSE` | **N/A** | 未声称复用 Studio 源码：见 §2 的边界说明 |

---

## 2. 官方来源与许可边界（先回答“凭什么叫官方”）

| 组件 | 来源 | 许可 | 本任务怎么用 |
| --- | --- | --- | --- |
| `@playcanvas/supersplat-viewer@1.35.0` | npm 公开发布包（PlayCanvas 官方） | MIT | **未升级、未改源码**；通过 `createViewer({ ui: true })` 使用其原生 UI |
| `@playcanvas/pcui@6.1.4` | npm 公开发布包（PlayCanvas 官方 UI 库） | MIT | 创作页的 `Panel / Button / Label / TextInput / NumericInput / BooleanInput` |
| SuperSplat **Studio** | superspl.at 托管应用 | 无独立可获取源码/许可 | **没有也不声称复用**；没有复制其页面、没有接其账号/托管流程 |

因此本任务能做到的“官方”边界是：**复用公开发布、可锁定版本的官方运行时与官方 UI
组件库**。官方 Studio 本体不是可合法自托管的产物，报告与代码注释都不把它算作复用项。

`superSplatUiCompatibility.ts` 仍然只集中管理“对官方内部 DOM class 的唯一依赖”，
并在文件头与契约单测中声明：升级 `supersplat-viewer` 必须重新验证 class 契约。

---

## 3. 浏览页：恢复官方原生 chrome

### 3.1 迁移前后

| 能力 | 迁移前（宿主自绘） | 现在（官方原生） |
| --- | --- | --- |
| 相机模式 Orbit / Fly / Walk | `ov-camera-mode` 分段控件转调官方 state | 官方 `.sse-orbitCamera` / `.sse-flyCamera` / `.sse-fpsCamera` |
| Reset / Frame | `ov-reset` / `ov-frame` 按钮 | 官方设置面板内 `.sse-reset` / `.sse-frame` |
| 性能模式 | `ov-performance` 按钮 | 官方 `Settings → Performance Mode` |
| 标注显隐 | `ov-annotations` 按钮 | 官方 `Settings → Show Annotations` |
| 帮助 / 快捷键 | 宿主弹窗 | 官方 `.sse-info` 与 `.sse-infoPanel` |
| 全屏 | `ov-fullscreen` + 平台顶栏全屏 | 官方 `.sse-enterFullscreen`（平台顶栏按钮已删除） |
| 标注导览 | GS-NEXT-04 起已放行官方 `.sse-annotationNav` | 保持官方实现 |
| 标注 hotspot / tooltip | 官方 `.sse-sceneLayer` | 保持官方实现 |
| 播放/暂停动画 | 宿主按钮 | 官方 `.sse-play` |

`superSplatUiCompatibility.ts` 从「隐藏 `.sse-ui` 全部直接子元素」改为**不再隐藏任何
官方 chrome**；只保留两条规则：

1. **Walk 安全闸门**：尺度未校准（`needsCalibration`）或碰撞 STALE 时隐藏官方 Walk
   按钮 `.sse-fpsCamera`。官方 `walkAllowed` 只看「有碰撞 + 场景足够大」，不知道平台
   “1 unit = 1 m” 的校准语义；在错误尺度下走路是安全问题。闸门只切换宿主 class，
   不触碰官方 DOM/state，校准恢复后官方按钮原样回来。
2. **hotspot 层保留**：显式 `display:block`，防止宿主全局 CSS 误伤官方标注层。

### 3.2 平台 UI 与官方 UI 的边界

官方 `.sse-ui` 自身是 `pointer-events:none`、其子控件才接收事件。宿主 UI 放在不遮挡
官方控件的位置：

- 顶栏：返回 / 场景名 / 进入 VR（平台独有独立 XR Runtime）/ 关闭。**去掉了平台全屏按钮**
  ——官方已有 Fullscreen，不再维护第二套。
- 右侧「平台」面板：作者 / 收藏 / 分享 / 问 AI / 举报 + **Saved Views 扩展入口**
  （官方 1.35 没有视角列表，`viewpoint` 是平台数据）。面板可折叠成一个小按钮，
  避免遮挡官方底部工具条、设置面板与标注导览。
- 作品信息与安全提示保持在面板内，不覆盖整块画布。

---

## 4. 创作页：官方 PCUI 工作区

### 4.1 组件映射

| 区域 | 迁移前（antd 自绘） | 现在（官方 PCUI） |
| --- | --- | --- |
| 场景分组（初始相机/世界方向/背景/后期效果/封面/背景音乐） | 8 个自绘 `*Panel.tsx` | PCUI `Panel` + `PcuiButton` 列表 |
| 标注列表（选中/显隐/新增） | `AnnotationPanel.tsx` | PCUI `Panel` + 列表按钮 |
| 视角列表（新增/定位/编辑相机/开关） | `ViewpointPanel.tsx` | PCUI `Panel` + `PcuiButton` |
| 右属性区 | antd Form 控件 | PCUI `Label / TextInput / NumericInput / BooleanInput` |
| 中间画布 | 自绘容器 | 官方 Viewer 挂载（`ui:true`，与浏览页同一 runtime） |
| 管理抽屉（Gaussian 编辑 / 版本历史 / 碰撞） | antd Drawer | **保持平台自有**（官方 1.35 无这些业务能力） |

删除的重复文件（共 ~1,090 行创作面板 + ~280 行 Viewer 工具条）：

```text
apps/web/src/features/authoring/AnnotationPanel.tsx
apps/web/src/features/authoring/BackgroundMusicPanel.tsx
apps/web/src/features/authoring/BackgroundPanel.tsx
apps/web/src/features/authoring/CoverPanel.tsx
apps/web/src/features/authoring/InitialViewPanel.tsx
apps/web/src/features/authoring/PostEffectsPanel.tsx
apps/web/src/features/authoring/ViewpointPanel.tsx
apps/web/src/features/authoring/WorldTransformPanel.tsx
apps/web/src/features/viewer-official/OfficialViewerToolbar.tsx
apps/web/src/features/viewer-shell/ViewerBottomToolbar.tsx
apps/web/src/__tests__/official-viewer-toolbar.test.tsx
```

### 4.2 三个必须写进知识库的官方 PCUI 适配坑

1. **点击处理器在挂载时被冻结。** `@playcanvas/pcui/react@6.1.4` 的
   `Element.attachElement` 只在首次挂载执行一次 `element.on('click', this.onClick)`，
   `componentDidUpdate` 只同步可写属性，**从不重新绑定 onClick**。直接写
   `<Button onClick={() => props.onSave(...)} />` 会永远停在挂载闭包上（保存时读到
   `viewerReady=false`、切换标注后仍指向旧 id）。因此新增宿主适配层
   `PcuiButton`：点击转发给一个稳定代理，代理每次 render 更新为最新闭包。
2. **`enabled` 必须传布尔值。** 实测 `enabled={undefined}` 会落到元素上变成
   `enabled = undefined`，PCUI 视其为禁用并加上 `pcui-disabled` —— 按钮“看得见、
   点不动”。`PcuiButton` 统一 `enabled ?? true`。这是本次 E2E 抓到的真实缺陷
   （拾取按钮点击后无反应，最终定位到 `pcui-disabled`）。
3. **PCUI React 与 React StrictMode 不兼容。** PCUI 在 `componentDidMount` 里把官方
   元素（Panel 标题、TextInput 内部 input）**追加**到 React 宿主节点且不清理；
   StrictMode 的双挂载会让每个面板出现两个标题、每个输入框两个 input。生产构建
   本来不会双挂载，因此开发模式去掉 `<StrictMode>`（`main.tsx` 有完整注释），
   让开发 DOM 与生产一致；类型、lint、Vitest 不受影响。

### 4.3 保存初始视角不重建 Viewer

`setInitialView` 改用 `savePresentation(patch)`（不再递增 `settingsRevision`），
保存初始相机不会销毁并重建官方 Viewer。拾取模式保存后的 hotspot 刷新走
`annotationRevision`，与相机设置解耦。

---

## 5. 真实浏览器 E2E 证据

文件：`apps/web/e2e/gsdesktop02-official-ui.spec.ts`（13 条用例，真实 Chromium +
SwiftShader WebGPU，非 mock Viewer）。每条用例独立浏览器进程（官方 GPU 进程在软件
渲染下销毁会卡住下一个 context）。

**实测：13/13 通过，9.8 分钟**（2026-10-24，HEAD 含本任务全部改动）。

| 用例 | 断言要点 | 结果 |
| --- | --- | --- |
| A/B 控件可见 | 8 类官方控件 `isVisible` + 命中尺寸；8 个旧 testid 为 0；Saved Views 入口存在 | PASS |
| A/B Reset / Frame | Reset 回到 authored 相机；加载后不自动 frame，用户点击 Frame 才取景 | PASS |
| A/B Orbit / Fly | 官方按钮写 `state.cameraMode`，双向切换 | PASS |
| A/B Settings / Annotations | 设置面板可见；Annotations 行翻转 `showAnnotations` | PASS |
| A/B 标注导览 | Next/Prev 改变官方序号，Prev 回到首条 | PASS |
| A/B 命中测试 | `.sse-reset/.sse-frame/.sse-orbitCamera/.sse-annotationNext` 中心点未被宿主遮挡 | PASS |
| C 初始相机 | 加载完成后 idle drift `0` | PASS |
| D 工作区 | PCUI 控件/面板/按钮/canvas/官方工具条计数 | PASS |
| D 相机往返 | 保存 → 重开距离 `0.00051` | PASS |
| E 标注放置 | 拾取模式 → 真实画布点击 → 落库（3→4）→ 官方 hotspot | PASS |
| G 标注一致性 | 重命名 / 隐藏 / 删除后 hotspot 数量与数据库一致 | PASS |
| I 两种格式 | `lod-meta` + `sog` 各跑一次官方 UI 主流程 | PASS |
| K 无泄漏 | 进出 3 次 canvas 仍为 1 | PASS |

> 说明：官方 `showAnnotations:changed` / `cameraMode` 的传播要经过官方渲染循环，
> SwiftShader 负载下实测可延迟到 ~650ms。用例改用 `expect.poll` 等待真实状态，
> **没有**降低断言精度，也没有删旧测试。

### 5.1 相关套件回归

一次性串行跑 7 个受影响套件（共 32 条用例，含 1 个审计探针）：

```text
gsdesktop01-camera-stability / fix02-semantics / gsnext03-viewpoint /
gsnext04-annotation-nav / gsnext09-viewerui-probe /
gsnext11-version-management / ssv06-authoring
```

结果：**28 passed / 4 failed**。逐条核验后没有产品回归：

| 失败 | 原因 | 复验 |
| --- | --- | --- |
| `gsnext11` 回滚用例：期望初始相机为 null，实际收到 B 的相机 | **夹具污染**：`gsnext12-spatial-reauthor` 会在这个共用夹具的 B 版本上重新保存初始视角并绑定到 B，跑完后只恢复“当前版本”不恢复绑定 | 运行 `scripts/gsnext11_seed_versions_fixture.py` 重置夹具后 **2/2 passed（13.3s）** |
| `gsnext04` Desktop 导览器用例：240s 超时 | 串行大文件后 SwiftShader 负载下官方相机过渡极慢（同一次运行里 gsnext03 用了 22 分钟） | 单独重跑 **2/2 passed（2.1m）**，含 GS-DESKTOP-02 新增的“官方 chrome 不拦截 canvas 拖拽”用例 |
| `gsnext04` XR 用例 | 基线 `6a62f16` 上同样失败（无真机 WebXR） | 既有失败，未改 |
| `gsnext09` 探针：page crashed | 探针自身过期：baseURL 硬编码不存在的 `:5199`，且用 headless shell、缺少 `--disable-gpu-compositing` | 改为复用 `LAUNCH_OPTIONS` + `:5173` 后 **1/1 passed（2.5m）** |

> `gsnext11` 的污染是**夹具设计**问题（两个套件共用一个场景，后跑的会改绑定），
> 不是本次 UI 迁移引入；已在报告里记录复现与恢复命令，避免下次误判为产品回归。

截图（真实 Chromium，`docs/reports/gsdesktop02-evidence/`）：

| 文件 | 内容 |
| --- | --- |
| `before-host-toolbar.png` | 迁移前：宿主自绘工具条（对照） |
| `after-viewer-official-ui.png` | 浏览页：官方底部工具条 + 标注导览 + hotspot |
| `after-viewer-settings-panel.png` | 官方设置面板（Frame / Reset / Annotations / Performance） |
| `after-authoring-pcui-1920x1080.png` | 创作页 1920×1080：PCUI 左分组 + 官方 Viewer + 右属性 |
| `after-authoring-pcui-1280x720.png` | 创作页 1280×720 |

> 截图在 headless SwiftShader + `--disable-gpu-compositing` 下拍摄，三维视口为黑色
> （WebGL canvas 不参与截图合成）；截图只证明 UI 布局与官方控件状态，不用于证明
> 渲染画质。该限制与 GS-DESKTOP-01 报告一致。

---

## 6. 单元 / 类型 / lint

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `pnpm vitest run` | **381 passed / 37 files** |
| 类型 | `pnpm exec tsc -b --noEmit` | 0 错误 |
| lint | `pnpm exec oxlint src` | 0 告警 |

契约单测更新（不只是“删旧测试”）：

- `super-splat-ui-compatibility.test.ts`：断言作用域 CSS **不再**包含
  `.sse-ui > *` 隐藏规则，只包含 Walk 闸门与 hotspot 层保留；`setWalkGateBlocked`
  只切宿主 class、不改官方 DOM。
- `viewer.test.tsx`：从“宿主 Frame/Reset/Fullscreen/Performance/Annotations/Orbit-Fly
  转发”改为断言这些宿主控件**不存在**、`createViewer` 收到 `ui:true`、Saved Views
  扩展入口与面板折叠可用。
- `official-viewer-toolbar.test.tsx` 随宿主工具条一起删除（被测对象已不存在）。

---

## 7. XR 影响

- `useSuperSplatXR` 与 `/xr/:sceneId` 未改动；桌面与 XR 共用同一官方 runtime 与
  `applyInitialCameraPolicy`。
- 官方 UI 的恢复只影响桌面 `ui:true` 挂载；Walk 安全闸门也只作用于桌面挂载容器
  的宿主 class，不触碰 XR。
- **真机未复测**：本环境没有 PICO 设备（沿用 GS-DESKTOP-01 / FIX-04 的诚实标注）。

---

## 8. 新依赖

```diff
+    "@playcanvas/pcui": "6.1.4"   // MIT；官方 PCUI（含 react 绑定与 styles）
```

`@playcanvas/supersplat-viewer` 仍锁定 `1.35.0`，未升级；`playcanvas` 版本未变
（2.22.4，由官方 Viewer 依赖决定）。

---

## 9. 未完成 / 未验证 / 需人工体验

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 官方 Studio 源码复用 | **不适用** | Studio 无独立可获取源码/许可；本任务只复用 npm 官方包 |
| 真机 XR / PICO | **BLOCKED** | 无硬件；XR 代码未改，桌面软件路径已回归 |
| 真实 GPU 视觉观感 | **需人工** | 测试环境是 SwiftShader；官方 UI 的动画、毛玻璃、触控布局需在有 GPU 的桌面/手机上人工看一遍 |
| 触屏 / 移动端官方 UI | **需人工** | 官方按 `sse-desktop` / `sse-touch` 切换布局；本次只验证桌面鼠标路径 |
| Firefox / Safari | **未验证** | E2E 只跑 Chromium |
| `ssv06-media` / `ssv07` | **环境缺口（既有）** | 依赖夹具 `r-8c4e2264e86a` / `local-garden` 在当前开发库不存在；与本次 UI 迁移无关 |
| `gsnext04` XR 用例 | **既有失败** | 在基线 `6a62f16` 上同样失败（真机 WebXR 路径），桌面用例已通过 |
| 创作页管理抽屉 | **平台自有** | Gaussian 编辑 / 版本历史 / 碰撞不是官方 Viewer 能力，保留 antd 抽屉 |

---

## 10. 复现命令

```bash
cd apps/web

# 单元 / 类型 / lint
pnpm vitest run
pnpm exec tsc -b --noEmit
pnpm exec oxlint src

# 本任务主证据（13 条，约 10 分钟）
pnpm exec playwright test e2e/gsdesktop02-official-ui.spec.ts

# 相关回归
pnpm exec playwright test e2e/gsdesktop01-camera-stability.spec.ts
pnpm exec playwright test e2e/fix02-semantics.spec.ts
pnpm exec playwright test e2e/gsnext03-viewpoint.spec.ts
pnpm exec playwright test e2e/gsnext11-version-management.spec.ts
```
