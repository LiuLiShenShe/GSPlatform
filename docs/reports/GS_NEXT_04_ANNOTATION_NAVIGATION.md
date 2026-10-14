# GS-NEXT-04 —— 官方标注导览（Desktop）+ XR 出生导览点

> 日期：2026-10-14
> 状态：**SOFTWARE VERIFIED / HARDWARE PENDING**（真机 `/xr/:sceneId` 的 immersive-vr 出生点仍待 PICO Neo3 实测）
> 依据：[GS-NEXT-04A 审计报告](./GS_NEXT_04A_ANNOTATION_AUDIT.md)（只读审计，未改生产代码）
> 前序：[GS-NEXT-03 视点快速切换](./GS_NEXT_03_VIEWPOINT.md)、[GS-NEXT-02 初始视角](./GS_NEXT_02_INITIAL_CAMERA_FIX.md)

---

## 0. 证据边界

本轮**没有真机**（PICO Neo3）证据。以下全部是软件证据：真实浏览器（headless Chrome +
SwiftShader）、真实 API、真实数据库、锁定的官方 `@playcanvas/supersplat-viewer@1.35.0`
（tag `329a80aaec593da234635e68055d7b38a8e836e4`，未升级依赖）。

隔离环境：独立库 `gsplatform_gsnext04`（已迁移到 head `cd03ef05ab06`）+ API `:18004` +
vite `:5173`。

> **2026-10-14 补充**：本轮后半段按用户要求「都修复」，对**共享开发库** `gsplatform`
> 做了三处修复（迁移到 head、修复 `fix02-semantics` 夹具漂移、按新策略重写 SSV-07
> 碰撞契约），详见 §10。§6.2 / §6.4 描述的正是这些问题的成因，现已修复而非仅登记。

GS-NEXT-04A 审计提出的硬门禁（不加数据模型 / 不改 CameraManager / 不自绘等价 UI /
不新建 VR UI 系统）本轮全部遵守，逐条对照见 §4。

---

## 1. 本轮做了什么（一句话）

**Desktop：把官方现成的标注导览器 `.sse-annotationNav` 从"整层隐藏"里放出来**（0 行自绘
UI）；**XR：进入 VR 前的出生位姿选择器增加一个「导览点」分组**，其 pose 直接取官方
`annotations[i].camera.initial`（不新增任何数据模型、不新增后端接口）。

---

## 2. 复用的官方能力（为什么不需要自绘）

GS-NEXT-04A 的结论是：官方标注 UI 在 1.35.0 里**逻辑完整、只是被我们的作用域 CSS 一起
藏掉了**。锁定版的 `.sse-annotationNav` 已经自带：

| 官方已具备 | 官方行为 |
| --- | --- |
| 循环导航 | `(i±1+n)%n`，Next/Prev 两向回绕 |
| 少于 2 条时隐藏 | 官方自行判断，不显示 |
| 按钮自动 disable | 依赖官方 `state.selectedAnnotation` |
| 序号 + 标题 | `.sse-annotationNavNumber` / `.sse-annotationNavTitle` |
| 相机过渡 | 走官方 CameraManager `selectAnnotation()` → 与 GS-NEXT-02/03 同一条动画路径 |
| 显隐跟随 | 跟随官方 `state.showAnnotations`（= GSPlatform 工具栏的 Annotations 开关） |

按"能用官方就直接用、自己写的肯定没有官方好看"的原则，Desktop 端**没有任何新增 DOM 或
CSS 组件**，只有一条作用域选择器从 `.sse-ui { display:none }` 变成
`.sse-ui > *:not(.sse-annotationNav) { display:none }`。

---

## 3. 变更清单（代码位置）

### 3.1 Desktop：放行官方导览器

| 文件 | 变更 |
| --- | --- |
| `apps/web/src/scene-runtime/superSplatUiCompatibility.ts:35` | 新增 `OFFICIAL_ANNOTATION_NAV_CLASS = 'sse-annotationNav'` |
| 同上 `:69` | 隐藏规则由 `.sse-ui { display:none !important }` 改为 `.sse-ui > *:not(.sse-annotationNav) { display:none !important }` |
| 同上 `:105,128-137` | `UiCompatibilityReport` 新增 `annotationNav: boolean`；`validateUiCompatibility` 校验导览器**是 `.sse-ui` 的直接子元素**（层级一变就放不出来，必须暴露） |
| `apps/web/src/scene-runtime/SuperSplatRuntime.ts:530` | 新增 `selectGsplatformAnnotation(annotationId)` —— 按**数据库 ID**（不是数组下标）选中标注并走官方过渡 |
| 同上 `:620-626` | `selectViewpoint()` 在切换观察点前先 `selectAnnotation(null)`，清掉官方标注选中态 |
| 同上 `:689,700` | 新增 `annotationRuntimePose(annotationId)` 与 `annotationIndexById(annotationId)` |

### 3.2 XR：出生导览点

| 文件 | 变更 |
| --- | --- |
| `apps/web/src/scene-runtime/guidePoints.ts`（新） | `eligibleGuidePoints()` / `isEligibleGuidePoint()` —— 导览点准入规则（纯函数） |
| `apps/web/src/features/viewer-official/useSuperSplatXR.ts:112,118,184,492,588` | 新增 `guidePoints` / `selectedGuidePointId` / `selectGuidePoint()`；与 `selectedViewpointId` **互斥**；boot 与"回到初始视角"都复位 |
| `apps/web/src/pages/XRViewerPage.tsx:134-190,240-245` | 现有"出生位置"选择器分为「观察点」/「导览点」两组；诊断增加 `selectedGuidePointId` / `guidePointCount` |
| `apps/web/src/index.css` | 新增 `.gs-xr__viewpoints-group`（分组标题） |

### 3.3 测试

| 文件 | 内容 |
| --- | --- |
| `apps/web/e2e/gsnext04-annotation-nav.spec.ts`（新） | 4 个真实浏览器用例：官方导览器导航 / chrome 仍隐藏且不挡 canvas / XR 导览点出生位姿与互斥 / 无自有相机的标注不得进分组 |
| `apps/web/src/__tests__/guide-points.test.ts`（新） | 6 个准入规则用例 |
| `apps/web/src/__tests__/super-splat-ui-compatibility.test.ts` | 重写：新增"导览器改为放行（不隐藏）"组 + 4 个 FAIL 条件 |
| `apps/web/src/__tests__/super-splat-runtime.test.ts` | 3 处调用序断言改为新契约 + 新增 6 个 GS-NEXT-04 用例 |
| `apps/web/e2e/ssv06-authoring.spec.ts` | 契约改为新的一层（见 §5.2） |
| `apps/web/e2e/ssv06-media.spec.ts` | 同步移除过时的 `.sse-ui` 整体不可见断言 |

---

## 4. 关键设计决策（每条都有理由，不只是结论）

### 4.1 为什么用 `> *:not(...)` 白名单，而不是逐个枚举黑名单

隐藏的是"`.sse-ui` 的所有直接子元素，但导览器除外"。官方将来新增 chrome 会被**自动**
隐藏，我们不必再改这一层。逐个枚举（`.sse-controlsWrap/.sse-settingsPanel/...`）在官方
新增控件时会漏放 —— 那是一个看不见的、随依赖升级出现的回归口。

### 4.2 为什么**不能**给 `.sse-annotationNav` 自身写 `display`

官方靠 `sse-hidden` / `sse-desktop` / `sse-touch` 三个类控制显隐与布局（只有 `.sse-desktop`
才给 `display:flex`）。我们一旦对它写死 display，就会破坏"少于 2 条自动隐藏""按输入模式换
布局"这些官方逻辑。所以作用域层**只让 `.sse-ui` 本身可见**，不碰导览器本身。

### 4.3 为什么隐藏其余 chrome 是必需的（不是洁癖）

`.sse-ui` 自身是 `pointer-events:none`，不挡 canvas；但 `.sse-ui *` 统一
`pointer-events:auto`，而 `.sse-controlsWrap` 横跨容器宽度、`.sse-infoPanel` 是全屏毛玻璃。
放行它们会直接吃掉 canvas 上的拖拽。§5.2 的用例专门验证"放行导览器后拖拽仍然生效"。

### 4.4 为什么 XR 侧 pose 直接读 `annotations[i].camera.initial`，不再换算一次

该值**已经**由 `experienceAdapter.buildAnnotations()`（`apps/web/src/scene-runtime/experienceAdapter.ts:215-278`）
经 `SceneTransformAdapter` 换算到 **RUNTIME** 空间。再换算一次就是两套数学，必然漂移。
这与 GS-NEXT-03 的 `viewpointRuntimePose()`（视点来自描述符，**需要** wrapper 换算）正好相反
—— 两条路径的差异已写进方法注释，避免后人"顺手统一"。

### 4.5 为什么必须做导览点准入（`guidePoints.ts`）

老场景里大量标注**没有作者化相机**，官方 adapter 会把它们的 `camera.initial` **逐条回落到
场景初始相机**。若不过滤，用户点"导览点"却被放到初始视角 —— 一个不报错的假承诺。
准入规则：`enabled !== false && cameraPosition && cameraTarget`（`cameraFov` 可缺，adapter
会兜底；位置与目标才是导览点的本质）。§5.1 用例 ④ 用真实 API 建一条无相机标注，验证它
确实存在于场景中、但不出现在导览点分组里。

### 4.6 为什么按数据库 ID 而不是官方数组下标选中

`viewer.d.ts:199` 的 `annotations` 是只读的；我们不能改官方数组，只能调 `selectAnnotation(i)`。
下标会随"停用某条标注"整体错位，而 GSPlatform 手里稳定的是数据库 ID。
`annotationIndexById()` 通过官方 `extras.gsplatform.annotationId` 协议（SSV-06 已建立）
做 ID → 下标映射；找不到返回 -1，**不做任何事**。

### 4.7 为什么 `selectViewpoint()` 要先清官方选中态

观察点与导览点共用同一个"当前停在哪里"的语义：官方 tooltip、媒体 Overlay、导览器序号
都读 `state.selectedAnnotation`。不清的话，相机已经到观察点了，导览器却还显示上一个
导览点的标题。GS-NEXT-03 原本没有这个问题（那时导览器是隐藏的），GS-NEXT-04 放行之后
就暴露了 —— 这是放行官方 UI 后**必须**跟着修的一处，不修就是不一致的假状态。

---

## 5. 测试结果

### 5.1 GS-NEXT-04 专项（真实浏览器 + 真实 API，隔离库）

```
$ npx playwright test e2e/gsnext04-annotation-nav.spec.ts --workers=1
  4 passed
```

关键读数（用例日志原文）：

| 断言 | 读数 |
| --- | --- |
| 导览器初始态 | `{"visible":true,"number":"1","title":"标注A"}` |
| Next 一次后 | `{"visible":true,"number":"2","title":"标注B"}`，相机 `[-2, 1.5, 5]` = 标注B 的作者化相机（误差 < 0.06） |
| 三条相机互不相同 | `dist(cam0, cam1) > 0.5`（排除"原地不动"） |
| 双向往返回绕 | 第 3 条 → Next → 第 1 条；第 1 条 → Prev → 第 3 条 |
| 其余官方 chrome | `.sse-ui > *:not(.sse-annotationNav)` 可见数 = **0** |
| canvas 拖拽 | 放行导览器后仍能驱动官方相机（位移 > 0.05） |
| XR 出生导览点 | `gp = 3`；选中标注B 后相机 `[-2, 1.5, 5]` / fov 50，`selectedGuidePointId` = 该标注 ID，`xrSpawnStatus ≠ not-authored` |
| 与观察点互斥 | 改选观察点后 `selectedGuidePointId = null`，按钮 `aria-pressed=false` |
| 复位 | 点「初始视角」两者都回 null |
| 无相机标注 | 确实在场景里，但导览点分组中 `toHaveCount(0)`，且 `guidePointCount` = 合格数 |

### 5.2 SSV-06 契约更新（`.sse-ui` 从"整体隐藏"改为"逐子元素隐藏"）

```
$ npx playwright test e2e/ssv06-authoring.spec.ts e2e/ssv06-media.spec.ts e2e/ssv06-audio.spec.ts --workers=1
  5 passed
```
读数：热点 5 个仍在（SSV-06 没被回归掉）；`.sse-ui > .sse-annotationNav` 数量 = 1；
其余直接子元素可见数 = 0。

### 5.3 GS-NEXT-02 / 03 未回归

```
$ npx playwright test e2e/gsnext04-annotation-nav.spec.ts \
                   e2e/gsnext02-initial-camera.spec.ts \
                   e2e/gsnext03-viewpoint.spec.ts --workers=1
  16 passed (1.9m)
```
GS-NEXT-03 的过渡轨迹仍然平滑（107/108/100 样本，单帧最大位移 0.22–0.29，占全程 6–8%）。

### 5.4 其余 e2e（共享开发库，vite 指向 `:8001`）

```
$ npx playwright test e2e/ssv07-collision.spec.ts e2e/ssv08-streaming.spec.ts \
                   e2e/vr01a-public-xr.spec.ts e2e/vr01b-sog.spec.ts \
                   e2e/pc-integration02-foundation.spec.ts \
                   e2e/pc-integration03-editor.spec.ts e2e/fix-upload01-viewer.spec.ts \
                   --workers=1
  7 passed, 15 skipped
```
跳过项是环境门禁（需要真机 / 生产形态 / GPU 的用例），与本轮无关。

### 5.5 静态与后端门禁

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | 0 error |
| 前端单测 | `npx vitest run` | 32 文件 / **326 passed** |
| 前端 lint | `npx oxlint src` | 0 问题 |
| 后端 lint | `apps/api/.venv/bin/ruff check .` | All checks passed |
| 后端类型 | `apps/api/.venv/bin/python -m mypy app` | Success，94 files |
| 后端 pytest | `pytest tests`（隔离库 `gsplatform_test`，已迁到 head） | **566 passed** |
| workers pytest | `workers/pytest tests`（同上） | **189 passed, 1 skipped** |

---

## 6. 跑法陷阱（踩过的坑，记录以免复现）

### 6.1 `VITE_API_BASE_URL` 与 `GS_API_PROXY_TARGET` 不一致会造成"脑裂"

`apps/web/src/services/http.ts` 的 `baseURL` 默认是**绝对地址**
`http://localhost:8001/api/v1`，**不走** vite 的 `/api` 代理。于是：

- spec 里的 `request`（Playwright baseURL = `http://localhost:5173`）→ 代理 → `:18004`
- 页面里的 `httpClient` → 直连 `:8001`

**两个不同的库**。症状极具迷惑性：API 手动 `curl` 明明能读到刚建的视点，页面下拉里就是没有；
`viewpoints` 计数对不上；e2e 大面积失败而后端"看起来没问题"。GS-NEXT-03 有 4 个用例曾因此
连续失败一轮。

修复：在 `apps/web/.env.development.local`（**已被 `.gitignore` 忽略**，不进版本库）里写
`VITE_API_BASE_URL=/api/v1`，让页面走同源代理，与 `GS_API_PROXY_TARGET` 指向同一个后端。
默认值不变（不设该文件时行为与以前一致），只是消除脑裂。

### 6.2 后端 pytest 会打到**开发库**，不是测试库

`tests/conftest.py` 只设 `GS_ENV=development`，于是 `app/db/session.py` 用的是
`settings.database_url`（即 `gsplatform` 开发库）。开发库停在 `f6a7b8c9d0e1`，
head 是 `cd03ef05ab06` → `upload_sessions.scene_type` 列不存在 → workers 4 个用例报
`UndefinedColumn`。本轮的做法是把 `gsplatform_test` 迁到 head 后跑（566 + 189 全绿），
随后**按用户指示把共享开发库也迁到 head**（`f6a7b8c9d0e1` → `cd03ef05ab06`），
此后直接对开发库跑：后端 **570 passed**、workers **189 passed / 1 skipped**，
与隔离库一致。

迁移前它被 4 个 `idle in transaction` 会话卡住 DDL（最早一个已泄漏 3 天，
`application_name=gsplatform-api`），`pg_terminate_backend` 掉之后立即通过。
这个"泄漏事务"本身是一个值得后续跟进的信号（本轮只登记，未定位来源）。

### 6.3 ruff 必须用项目 venv 的版本

系统 `ruff`（仓库根目录下运行）会报 27 个 error 并要求重排 95 个文件；
`apps/api/.venv/bin/ruff`（0.16.6，带 `pyproject.toml` 配置）`check` 全过。
`verify_release_source.sh` 用的是后者。

### 6.4 共享开发库里 `fix02-semantics` 夹具已漂移（**非本轮引入，待处理**）

`fix02-semantics.spec.ts` 有 5 个用例在**干净 HEAD 上以完全相同的报错失败**（已用
`git stash` 对照验证），与 GS-NEXT-04 无关。根因是共享开发库的数据漂移，不是代码：

| | spec 里硬编码的常量 | 开发库实际值 |
| --- | --- | --- |
| authored 初始相机 position | `[2.5, 1.8, 6.0]` | `[-0.327, 0.495, -0.598]` |
| authored 初始相机 target | `[0.0, 0.6, 0.0]` | `[-1.261, -0.240, -0.820]` |
| 视点数量 | 1（`正门视角`） | 5（多 4 条 `GS-NEXT-03 视点A` 残骸） |

那 4 条 `GS-NEXT-03 视点A` 是我早前调试 GS-NEXT-03 时误打到 `:8001` 留下的（失败用例在
`created.push()` 之前挂掉，`afterEach` 清不到）；而初始相机被改成了一组像**归一化方向向量**
的值，与 `[2.5,1.8,6]` 完全不是一回事 —— 这一条的来源不明，需要所有者确认。

隔离库 `gsplatform_gsnext04`（从开发库克隆后按 GS-NEXT-02 规格重建）的值与 spec 常量
**完全一致**，所以 GS-NEXT-02/03/04 的 16 个用例全绿。

**已按用户指示修复（§10）**：经 `PATCH /presentation` 把初始相机恢复为
`[2.5,1.8,6] / target [0,0.6,0] / fov 47`，并删掉 4 条 `GS-NEXT-03 视点A` 残骸。
`fix02-semantics.spec.ts` 随即从 **5 失败 / 1 通过** 变为 **6 passed**。

值得记录的根因线索：那个「像归一化方向向量」的初始相机，与 4 条残骸视点的坐标，
量级都恰好 ≈1 —— 特征上像是从**没有真实场景内容时**的官方相机读数保存下来的。
本轮未能确定具体写入路径（`fix02-semantics` 的 SOG 资产实测可正常服务、
18809 字节），故登记为待查项而非结论。

### 6.5 Playwright 默认并行跑**文件**，而这些 spec 共用同一个夹具场景

必须 `--workers=1`，否则互相改数据（GS-NEXT-03 报告 §4.3(c) 已记录，本轮再次确认）。

---

## 7. 未验证 / 明确不做

- **真机 PENDING**：导览点作为 XR 出生位姿只在桌面软件路径上验证过。`/xr/:sceneId`
  的 immersive-vr 实测仍需在 PICO Neo3 上做，判据与 GS-NEXT-02/03 相同（诊断 JSON 回传）。
- **不新增数据模型**：没有新的表 / 字段 / 接口。导览点就是"有作者化相机的标注"。
- **不碰官方 CameraManager**：所有导航仍走官方 `selectAnnotation()`。
- **不重写官方 hotspot 层**：`.sse-sceneLayer` 的显示规则与 SSV-06 完全一致。
- **不做 VR 内菜单**：选择器是进入 VR 前的 DOM overlay，复用 GS-NEXT-03 已有的图层。
- **VR-03 的编辑能力**（官方 `annotations` 是只读的，编辑受限）不在本轮范围内。

---

## 8. 结论

GS-NEXT-04A 提出的推荐（"放行官方导览器 + XR 复用既有出生点选择器"）已实现并验证：
**Desktop 新增 0 行 UI 代码**，只是把官方现成模块从作用域 CSS 里放出来；
**XR 新增 0 个数据模型**，只是把"带作者化相机的标注"并进 GS-NEXT-03 已有的出生位置选择器，
两者互斥、共用同一套官方相机过渡。GS-NEXT-02 / GS-NEXT-03 未回归（16 passed），
后端与前端门禁全绿。真机部分与共享开发库夹具漂移分别登记在 §7 与 §6.4。
---

## 9. 实机（PICO Neo3）验收 —— 已就绪，等设备

### 9.1 为什么这一步在本机无法完成

本机**没有任何头显、没有 OpenXR runtime、没有 adb**（实测：无 `/dev/video*`、`lsusb` 无
VR 设备、无 `monado`、`/usr/share/openxr` 不存在、无 `adb`）。因此
`navigator.xr.isSessionSupported('immersive-vr')` 在本机恒为 `false` ——
**immersive-vr 会话本身只能在真机上验证，这里不宣称任何真机结论。**

### 9.2 已经替真机验完的部分（真实公网 HTTPS，非 localhost）

按 FIX-04 §15 的既定做法起了 dev 隧道（`GS_ENABLE_DEV_TUNNEL=1` +
`XR_DEV_PUBLIC_SCENES=fix02-semantics,local-garden`，非白名单场景实测 403），
从**公网 HTTPS 源**上实测：

| 检查 | 结果 |
| --- | --- |
| `window.isSecureContext`（WebXR 的硬前提） | **true** |
| `navigator.xr` 存在 | **true** |
| `navigator.xr.isSessionSupported('immersive-vr')` | false —— 本机无头显（预期） |
| `/xr/fix02-semantics` 加载官方 WebGL2 runtime | loaded=true |
| 进入 VR 前相机 = authored 初始视角 | `[2.5, 1.8, 6]` fov 47 |
| `xrSpawnStatus` | `not-entered`（出生位姿已配置、尚未进入） |
| 观察点 / 导览点数量 | `viewpoints=1` / `guidePoints=3` |
| 整个加载过程的 4xx/5xx | **0 条** |

也就是说：**除了"头显里的那次 immersive-vr 会话"，其余链路已经在真实公网 HTTPS 上跑通。**

### 9.3 请在 PICO 上做的（约 5 分钟）

打开 PICO Neo3 自带浏览器（需与运行 dev 隧道的机器同网或走公网），依次访问：

**(1) 先看诊断页**（正式页面不显示工程面板，诊断页才是取证口）：

```
https://<tunnel>/xr/diagnostics/fix02-semantics
```

期望读数（逐行核对）：

| 行 | 期望 |
| --- | --- |
| Secure Context | `true` |
| navigator.xr | `true` |
| Immersive VR | **`supported`**    ← 这一行是本次实机测试的核心 |
| renderer | `webgl2`（XR 强制 WebGL） |
| state.loaded | `true` |
| canStartVR | `true` |
| Camera (pre-XR) | `2.5, 1.8, 6 / … / 47` ± 小误差 |
| gsplats | > 0 |

**(2) 再进正式页面**：

```
https://<tunnel>/xr/fix02-semantics
```

在「出生位置」里分别选 **初始视角 / 观察点「正门视角」/ 导览点（标注 A/B/C）**，
每次都应看到桌面相机用官方过渡动画移过去；然后点**进入 VR**。

期望（本次要闭环的三条 HARDWARE PENDING）：

| 验收项 | 期望 |
| --- | --- |
| GS-NEXT-02 初始视角 | 进入 VR 后的出生位姿 = 选中项（不再是官方 Y=0 / 鸟瞰） |
| GS-NEXT-03 观察点 | 选「正门视角」→ 出生位姿 = 该视点 |
| GS-NEXT-04 导览点 | 选某条标注 → 出生位姿 = 该标注的作者化相机（fov 也一致） |
| GS-NEXT-04 Desktop | 退出 VR 后在 `/scene/fix02-semantics` 上看官方 Prev/Next 导览器：序号/标题跟随、相机切换、绕回 |

**(3) 回传**：诊断页整屏截图 + 一张进入 VR 后的头显内截图（或录屏），
以及「实际落点 vs 期望落点」的主观描述（是否仍在鸟瞰 / 是否落在地面下方）。

### 9.4 失败时怎么判读

| 症状 | 指向 |
| --- | --- |
| Immersive VR = `unsupported` | 设备/浏览器侧（PICO 系统浏览器版本、未开启 WebXR），与本平台无关 |
| 页面显示「当前浏览器不支持 WebXR」 | 同上；正式页用 `canStartVR` 门控 |
| 进入后仍在鸟瞰 | 出生位姿未被官方消费 → 看诊断页 `xrSpawnStatus`；页面会同时显示 `initial-view-runtime-mismatch` 告警 |
| 进入后落在地面下方 / 飘走 | 官方 `XrNavigation` 的 `groundHeight=0` 平面语义（见已记录的官方默认值），需要真机数据才能定标 |
| 导览器不出现 | 场景需 ≥2 条 enabled 且带相机的标注；`fix02-semantics` 有 3 条 |

### 9.5 通道开关

```bash
# 开（本轮已开，隧道是临时的，随进程退出失效）
cd apps/web && GS_ENABLE_DEV_TUNNEL=1 XR_DEV_PUBLIC_SCENES=fix02-semantics,local-garden \
  GS_API_PROXY_TARGET=http://127.0.0.1:8001 npx vite --port 5173 --strictPort
cloudflared tunnel --url http://127.0.0.1:5173 --no-autoupdate

# 关
pkill -f "cloudflared tunnel --url"; pkill -f "vite --port 5173"
```

**注意**：该隧道会把 dev 源暴露到公网。白名单只有上面两个场景，非白名单场景实测 403；
但隧道 URL 本身是公开可猜的，测完请立即关掉（或改用只在本机可达的方式）。

---

## 10. 附：2026-10-14 后续修复（用户指示「都修复就行」）

GS-NEXT-04 收口后又发现并修掉了 4 个问题，其中 2 个与 GS-NEXT-04 直接相关。

### 10.1 共享开发库 `gsplatform` 从 `f6a7b8c9d0e1` 迁到 head `cd03ef05ab06`

影响面比看上去大：开发库落后 4 个迁移，导致
`upload_sessions.scene_type` 不存在、workers 4 个用例报 `UndefinedColumn`，
后端 8 个用例失败。迁移后对开发库直接跑：**后端 570 passed / workers 189 passed**。

DBA 注意事项：迁移被 4 个 `idle in transaction` 会话卡住（最早泄漏 3 天，
`application_name=gsplatform-api`），`pg_terminate_backend` 后立即通过。
**泄漏事务本身是另一个待查信号** —— 一个 HTTP 请求不该把事务敞开三天。

### 10.2 `fix02-semantics` 夹具漂移修复（§6.4）

`PATCH /presentation` 恢复 authored 初始相机 + 删除 4 条残骸视点。
`fix02-semantics.spec.ts`：5 失败 → **6 passed**。

### 10.3 SSV-07 碰撞 e2e 按**当前真实契约**重写（不是伪造 VERIFIED）

开发库迁到 head 后，`ssv07-collision.spec.ts` 的 2 个用例开始失败
（`walkAllowed` 期望 true、实际 false）。这不是回归，而是产品策略落地：

迁移 `ab02cd03ef04` 之后 `physicalWalkAllowed` 要求
`calibration.state == "VERIFIED"` **且** `metersPerSceneUnit ≈ 1.0` **且**
`transformIdentity == "identity"`；而 `SceneProcessingPatch.calibration` 只接受
`UNVERIFIED | ASSUMED` —— **VERIFIED 不能由 API 自称**
（`apps/api/tests/test_collision_policy.py` 的标题就是 "no fake VERIFIED fixture"）。
夹具 `r-8c4e2264e86a` 从未校准，因此 walk 被诚实拒绝是**正确行为**。

要让它重新变绿只有一条路：伪造一条 VERIFIED 校准 —— 正是本仓明令禁止的事。
因此改写为断言当前真实契约：资产已构建（描述符仍带 voxel +
`gridBounds` 完整）+ walk 被拒绝（`enabled=false` → 不注入 collisionUrl →
官方 `hasCollision=false`、Walk 按钮禁用）+ 尺度评估仍为 `ok`。
 XR 侧断言与桌面同一门控（不在 XR 上另开例外）。

**明确记录的覆盖缺口**：**「物理行走 + 碰撞阻止穿墙」目前在浏览器层没有任何诚实
e2e 覆盖**。恢复它需要产品侧先有能产出 VERIFIED 的真实校准工作流；
后端侧的策略正确性由 `tests/test_collision_policy.py` 覆盖。

### 10.4 描述符/列表的 `posterUrl` 恒为 404（真机链路上的实锤）

在公网 HTTPS 上跑 `/xr/fix02-semantics` 时，控制台留下一条
`404 .../assets/poster.webp`。追下去发现问题比预想的大：
**这个 URL 对任何场景都不存在**。

- 作者上传的封面（`presentations.cover_asset_id`，全库 474 个）存在
  `presentation/<scene>/cover`，由 `/{slug}/presentation/cover` 服务（实测匿名 200）；
- 只有发布清单自带的 poster 才走 `assets/poster.webp`（全库仅 2 个，且这两个场景
  的存储目录已被清理，实测同样 404）。

而 `SceneRuntimeService.get_descriptor` 与 `SceneService._summary_from_scene`
都**无条件**拼出 `assets/poster.webp`。后果：桌面/XR 每次加载一条红色 404，
作品列表里是裂图（`<img src={scene.poster}>` 没有 `onError` 兜底）。

修法（`app/services/scenes.py::resolve_poster_url`，两处共用同一份实现）：
有作者封面 → `/{slug}/presentation/cover`；否则当前版本有 POSTER 资产 →
`assets/poster.webp`；都没有 → `None`（前端对 `null` 已有一致兜底：
`?? fallbackPoster(...)` 与 `posterUrl && <img/>`，无需改前端）。
新增 4 个后端用例锁住三种分支。修后公网复测：**整个加载过程 0 条 4xx/5xx**。

### 10.5 修复后的全量门禁

| 门禁 | 结果 |
| --- | --- |
| e2e（53 个 spec，`--workers=1`） | **34 passed / 19 skipped / 0 failed** |
| 后端 pytest（对共享开发库） | **570 passed**（含新增 4 个 posterUrl 用例） |
| workers pytest | **189 passed / 1 skipped** |
| 前端 vitest | 326 passed |
| tsc / oxlint / ruff / mypy app | 全部通过 |
