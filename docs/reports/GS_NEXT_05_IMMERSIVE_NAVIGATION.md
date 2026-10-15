# GS-NEXT-05 —— 官方 XR Menu + 沉浸式导览点切换

> 日期：2026-10-15
> 状态：**SOFTWARE VERIFIED / HARDWARE PENDING**
> （软件门禁全绿；真实 PICO Neo3 的 immersive-vr 会话内显示、手柄输入与舒适度**没有**证据，全部标 HARDWARE PENDING）
> 依赖：锁定 `playcanvas@2.22.4` + `@playcanvas/supersplat-viewer@1.35.0`（tag `329a80aaec593da234635e68055d7b38a8e836e4`，本轮**未升级任何依赖**）
> 前序：[GS-NEXT-03 观察点](./GS_NEXT_03_VIEWPOINT.md)、[GS-NEXT-04A 标注导览审计](./GS_NEXT_04A_ANNOTATION_AUDIT.md)、[GS-NEXT-04 实施](./GS_NEXT_04_ANNOTATION_NAVIGATION.md)、[VR-03 PlayCanvas 标注复用](./VR_03_PLAYCANVAS_ANNOTATION_REUSE.md)

---

## 0. 证据边界（先说清楚什么是没验的）

本机**没有** PICO Neo3、没有 OpenXR runtime、没有 adb。headless Chrome +
SwiftShader 下 `navigator.xr.isSessionSupported('immersive-vr')` 恒为 `false`，因此：

- 本报告里的一切 = 真实浏览器 + 真实 API + 真实数据库 + 锁定版官方 viewer/引擎，
  验证到「官方菜单真的装上了、真的建出了按钮/文字/字形、真的能被官方事件驱动、
  Rig 数学精确落位、地板传送确实关着」这一层。
- 「**菜单在头显里看得见、手柄射线打得中、按钮点得动、0.4 秒黑纱不闪、切换后不眩晕**」
  —— 一条都没有证据，**全部 HARDWARE PENDING**（§7 给了逐条的真机取证步骤）。
- 本轮**没有新增后端接口、没有新增数据模型、没有动 Gaussian / LOD / 渲染**。
  历史 13M SceneVersion 与其 PLY 完全未触碰；`apps/api` 生产代码一行未改
  （只跑了门禁）。

隔离环境：API `:8001`（dev 身份）+ vite `:5173`（`GS_API_PROXY_TARGET=http://127.0.0.1:8001`）
+ 夹具场景 `fix02-semantics`（authored 初始相机 `[2.5,1.8,6] / [0,0.6,0] / fov47`、
1 个观察点、3 个各带独立 authored camera 的标注）。

---

## 1. 本轮做了什么（一句话）

**在官方 XR Rig 上装官方 `XrMenu`，用它把用户在不退出 immersive-vr 的情况下，在
「初始观察位置 / 已保存观察点 / 导览点」之间切换**；传送只移动官方 XR Camera 的
**父 Rig**，坐标换算与 GS-NEXT-03 的出生对齐**共用同一份数学**；并把官方
`XrNavigation` 的**地面传送**按产品门禁关掉，杜绝「点一下菜单被弹到 Y=0 平面」。
**0 行自绘 UI**（菜单本体、按钮、文字、射线拾取全部是官方 `XrMenu`；黑纱只用官方
Screen+Element 原语拼一块全屏面）。

---

## 2. 官方 `XrMenu`（`playcanvas@2.22.4`）的逐条核验

任务要求"不得假设新版 PlayCanvas API 在当前固定版本中存在"，所以以下全部**读源码核对**，
文件为 `node_modules/.pnpm/playcanvas@2.22.4/node_modules/playcanvas/scripts/esm/xr/xr-menu.mjs`
（1622 行），**未修改**。

| 核验项 | 2.22.4 源码事实 | 出处 |
| --- | --- | --- |
| 导出 | 该路径**没有 `.d.ts`**（`exports` 的 `./scripts/*` 映射不带 types），必须自备 ambient 声明 | `playcanvas/package.json` exports |
| 类形状 | `class XrMenu extends Script`（**旧版 `Script` 基类**，不是 `ScriptType`）；`static scriptName = 'xrMenu'` | `xr-menu.mjs:88-89` |
| 菜单行模型 | `menuItems` 两种行：`{label, eventName}`（可交互，点击 → `app.fire(eventName)`，`xr-menu.mjs:916`）/ `{label}`（只读，靠 `setItemLabel` 更新） | `xr-menu.mjs:93-97` |
| 显示方式 | 手柄按键切换（`toggleButtonIndex = 4`，即左摇杆上推）`xr-menu.mjs:207/1424`；另有手势（掌心向上）与 `alwaysVisible` 调试 HUD 两种官方模式 | `xr-menu.mjs:20-31` |
| 输入事件 | **自己**做 XR 射线拾取（射线 vs 元素 `worldCorners` 包围盒）+ trigger（gamepad button 0）点击 + 手势指尖触碰；**不依赖** `ElementInput` 的 XR hover 事件 | `xr-menu.mjs` 头注释 |
| 文字渲染 | 用引擎 UI 系统（`Screen` / `Element` / `Button` 组件）+ `fontAsset` 属性 | `xr-menu.mjs:757/805/808-810` |
| 默认布局 | `buttonWidth = 0.075`（米）、`buttonHeight = 0.015`、`buttonSpacing = 0.0025`、`fontSize = 8`、`menuScale = 1.0`、`labelTextOpacity = 0.65` | `xr-menu.mjs:138/148/158/167/177/280` |
| 运行时改字 | `setItemLabel(index, text)`（新文字会写回 `menuItems`，重建后仍在）；另有 `setItemValue` / `setMenuScale` | `xr-menu.mjs:536/569/591` |
| 与导航仲裁 | 显隐变化时 `app.fire('xr:menu:active', visible)` —— **官方注释明确说是给导航脚本做协调用的** | `xr-menu.mjs:1027` |
| 指针态 | `get isPointerOverMenu()` | `xr-menu.mjs:607` |
| 生命周期 | 脚本 destroy 时自己摘掉 `xr` / `xr.input` 监听并销毁菜单实体 | 读源码确认 |

官方 `XrNavigation`（`xr-navigation.mjs`，同版本）：

| 核验项 | 事实 | 出处 |
| --- | --- | --- |
| 地面传送开关 | `enableTeleport = true`（默认开）；`groundHeight = 0`（**地面是 Y=0 平面**，无网格） | `:150` / `:244` |
| 点击为何会弹人 | `handleSelectEnd` 里 `if (this.enableTeleport) this.tryTeleport(...)` —— 官方注释里就写着这是为了防止「点 UI 也被贴到地面」 | `:471-479` |
| 传送做法 | 移动 `this.entity`（= 相机父 Rig），并按相机**世界 XZ 偏移**修正，让「头」而不是 rig 原点落在落点 | `:662-686` |
| 其余导航 | `enableMove = true`、`turnMode = 'snap'`、`rotateSpeed = 45`、`enableSnapVertical = true` —— 摇杆移动 / snap turn / 垂直 snap | `:156/176/184/302` |
| 官方如何装 XR 脚本 | `camera.parent.addComponent('script'); script.create(XrControllers); script.create(XrNavigation);` —— 菜单应挂在**同一实体** | `supersplat-viewer/dist/viewer.js:10363-10365` |

> **一条不读源码就一定会踩的坑**：官方 viewer 的 `App` 只注册了 5 个组件系统
> （`Camera` / `Light` / `Render` / `GSplat` / `Script`，`viewer.js:11-15`），
> **没有** `Element` / `Screen` / `Button`。`Entity.addComponent` 在系统缺失时
> **静默返回 `null`**（不抛错），于是 `XrMenu` 会"看起来装上了"却既不渲染也不响应。
> 这一条在任何官方文档里都没有写。

---

## 3. 新增的最小适配代码（为什么绕不过去，以及只用官方零件怎么绕）

新增 3 个纯前端文件 + 1 个 ambient 类型声明，**没有一行自绘渲染**：

### 3.1 `scene-runtime/xrMenu.ts` —— 官方菜单适配层（三处适配）

1. **补装官方 UI 组件系统**（`ensureXrUiSystems`）：把官方 `ScreenComponentSystem` /
   `ElementComponentSystem` / `ButtonComponentSystem` 注册进官方 App。幂等（按系统名
   判重），不改 viewer 配置、不 fork viewer。
2. **提供字体**（`createXrMenuFont`）：用官方 `CanvasFont` + **系统字体栈**（`fontSize 48`、
   512×512）注册一个 font asset。**不打包字体二进制** —— 打包一份 CJK 子集实测 2.79 MB，
   而 `CanvasFont` 直接过浏览器 Canvas2D，中英文都显示（PICO 的 Android 系统浏览器自带
   CJK 字体），零字节成本。
   *坑*：官方 `CanvasFont` 首次填充只能用 `createTextures()`；`updateTextures()` 内部直接
   读 `this.data.chars`，而全新实例的 `data` 还是 `{}` → `Cannot read properties of
   undefined`。所以 `ensureGlyphs()` 按"有没有图集"分流。
3. **舒适过渡**（`createComfortVeil` / `createComfortFade`）：锁定版引擎**没有** camera fade
   （`CameraComponent.fadeIn/fadeOut` 在 2.22.4 已不存在），官方 XR 脚本里也没有 blackout
   工具。于是用**与 `XrMenu` 完全相同的官方 UI 原语**（Screen + Element）做一块 0.2 m 处的
   全屏黑纱（900×900 px，`scaleMode=NONE` → 物理尺寸只由实体缩放决定），平时
   `enabled = false` 零开销；状态机只订阅**一次** `app.on('update')`，0.14 s 淡出 →
   全黑那一帧执行定位 → 0.24 s 淡入。过渡中的新请求**丢弃不排队**（0.4 秒里用户看不清
   下一个位置，排队只会让传送滞后于按键）。

行尺寸（`MENU_LAYOUT`）按**官方属性**放大而非自绘：`buttonWidth 0.16`（默认 0.075，
默认折算下按钮只有约 9 个字宽，中文标签会被挤掉）、`buttonHeight 0.026`、
`buttonSpacing 0.006`、`fontSize 14`、`toggleButtonIndex 4`（官方默认）。

菜单行（`buildXrMenuItems`）是最小集：
`[当前目的地（只读标签）] + [上一个] + [下一个] + [返回初始位置] + [退出 VR]`；
只有 1 个目的地时退化为「当前 + 退出 VR」，没有 authored 初始相机时**不提供**
「返回初始位置」（点了无处可回 = 假按钮）。
按任务要求"若官方菜单能安全支持动态列表再显示名称列表"：2.22.4 的 `XrMenu` 没有
"按数据重建菜单"的官方路径（只有 `setItemLabel` 改某一行的字），所以**不做名称列表**，
只做稳定的上一点/下一点 —— 与 GS-NEXT-04 的结论一致：能不动官方列表结构就不动。

### 3.2 `scene-runtime/xrDestinations.ts` —— 目的地规则（纯函数，无引擎代码）

目的地 = `[初始视角（有 authored initial camera 才有）] + [观察点 enabled!==false] +
[导览点]`，与进入 VR 前那个「出生位置」选择器**同一批数据库 ID**。
一律用 `${kind}:${id}` 的字符串 key，**不用数组下标**（下标在列表变化时会错位）。
「上一个/下一个」环形（`(i±1+n)%n`，与官方 Desktop 标注导览器同语义）。
运行期第二道门禁：目的地必须能解析出 RUNTIME 空间 pose，否则整条跳过。

### 3.3 `scene-runtime/xrRigPose.ts` —— Rig 定位数学（**单一实现**）

GS-NEXT-03 的出生对齐与会话内传送**共用这一份**（两处各写一份必然漂移，且漂移
方向相反时极难察觉：出生点差 0.5 m、传送后差一个身位都不会报错）。
三条关键语义（读官方 `tryTeleport` + 官方 viewer 的 XR start 逻辑核对后固定）：

1. **只移动官方 XR Camera 的父 Rig**，绝不写头显 Camera 自身 —— 后者每帧被 WebXR
   tracking pose 覆盖，写了也留不住。
2. 目标是**保存的 eye position**：`rigPos = target − rigRot · headLocal`（官方
   `tryTeleport` 的 "correct under rig yaw" 同一招）。
3. 只对齐**水平 yaw**（`rigYaw = 目标yaw − 头显自身yaw`）；头显的 pitch/roll/局部位置
   原样保留 ⇒ **6DoF 与左右摇杆、snap turn 全部不受影响**。
4. 位姿必须可信才写：坐标全有限，且头部位姿**非零**（`local-floor` 下 tracking 原点
   未定时头部位姿为 0，在它上面算朝向会得到错误出生朝向）。

> 顺带记一条官方行为（读 `viewer.js:10366-10372` 得到）：`xr.on('start')` 时官方 viewer 会
> 把 Rig 改写成「相机位置 + yaw」。所以进入 VR 前设的位姿**一定会被官方覆盖**，
> GS-NEXT-02/03 的 `prepareXRSpawn()`（等首个 tracked head pose 后再施加一次）是必需的，
> 而会话内传送发生在 `start` 之后，不会被这次覆盖冲掉。

### 3.4 `types/playcanvas-xr-scripts.d.ts`

官方 `./scripts/*` 没有类型声明。`XrMenu` 的 ambient 声明是**逐行对着 2.22.4 源码写的**
（不是按新版 PlayCanvas 的印象编的），文件头显式声明了这一点。

### 3.5 接线（`SuperSplatRuntime` / `useSuperSplatXR` / 两个 XR 页面）

- 只有 `mode === 'xr'` 才装菜单（Desktop 路径**零改动、零回归**，§6 用例锁定）。
- 订阅一次：`prev/next/home/exit` → 切换/回初始/退出（退出走**现有** `handle.endXR()`，
  不自建会话控制）；`xr:menu:active` → 地板传送仲裁；`xr.on('end')` → 撤销黑纱 + 复位
  菜单态 + 复位传送策略；`xr.on('available')` → 重试安装（`if (this.xrMenu) return`
  保证不重复装）。
- 目的地变化经 `onXRDestinationChanged` 广播，hook 把 `selectedViewpointId` /
  `selectedGuidePointId` 同步过去 —— 会话内用手柄换点后，PC 页面上的 DOM 选中态不能
  停在旧值（假状态）。
- 诊断口：`ov-xr-diagnostics` 增加 `xrMenu` / `xrRuntimeState`，新增隐藏 span
  `diag-xr-menu-state|-installed|-destinations|-current`、`diag-xr-floor-teleport`、
  `diag-xr-rig`（真机核对落点用），`/xr/test` 页面加 3 行同样的读数；
  DEV-only `window.__gsxrruntime`（与 Desktop 的 `__gsruntime` 同一做法，生产构建不输出）。

---

## 4. Rig 定位 + 输入仲裁方案

### 4.1 传送链

```
官方 XrMenu 按钮 → app.fire('gsplatform:xr-menu:next')
   → SuperSplatRuntime.stepXrDestination(+1)
   → 环形算出下一个 destination key（按 ID，不按下标）
   → destinationPose(dest)  ← SceneViewpoint / 官方 annotations[i].camera.initial / authored 初始相机
   → 已在 immersive-vr？
        是：xrFade.run(() => applyRigPose(rigNodes, pose))   ← 全黑那一帧才移动 Rig
        否：只登记 setXRInitialCamera()（供进入 VR 前出生用，不动官方相机）
   → notifyXRDestination() → 页面选中态 + 菜单第 0 行标签同步
```

`destinationPose()` 返回的已经是 **RUNTIME 空间**的 pose（导览点由
`experienceAdapter`/`SceneTransformAdapter` 换算过一次），本层**不再换算**。

### 4.2 输入仲裁

| 冲突 | 处理 | 依据 |
| --- | --- | --- |
| 菜单点击（select/selectend）触发官方地面传送 | `enableTeleport = false`（`XR_FLOOR_TELEPORT_ALLOWED = false` 常量） | 官方 `handleSelectEnd` 只在 `enableTeleport` 为真时 `tryTeleport`，其源码注释本身就说明这是为了避免"点 UI 也被贴到地面" |
| 为什么不只在菜单打开时关 | 官方 `enableTeleport` 是持续开关，不做逐帧仲裁 | 打开/关闭的**竞态窗口**不可靠；而"未校准场景根本不该有地面传送"是产品事实（见下） |
| 摇杆移动 / snap turn | 一个都不碰（`enableMove=true` / `turnMode='snap'` / `enableSnapVertical=true` 保持官方默认） | §4 要求 |
| 菜单与导航的官方协调 | 仍监听官方 `xr:menu:active` + `isPointerOverMenu` 做仲裁（常量打开即生效） | 官方 JSDoc 明确提供 |

**为什么地面传送在本产品里恒为关**（三条都是产品事实，不是省事）：

1. 官方地面是 `groundHeight = 0` 的**平面**，没有地面网格、没有尺度校准时点一下菜单就会
   被弹到 Y=0（掉出场景或半埋进去）。
2. 后端已有一条同向门禁：迁移 `ab02cd03ef04` 之后 `physicalWalkAllowed` 要求
   `calibration.state == VERIFIED` **且** `metersPerSceneUnit ≈ 1` **且**
   `transformIdentity == identity`，而 `SceneProcessingPatch.calibration` **不接受**
   VERIFIED —— 今天没有任何场景能证明自己的地面可信。
3. 运行时描述符里根本没有 calibration 字段，XR 页面拿不到可信度证据；与其猜，不如关。

将来若描述符真的带上可信校准，改这一个常量即可（仲裁代码已就位）。

---

## 5. 测试结果

### 5.1 门禁（全绿）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| web 类型 | `npx tsc --noEmit -p tsconfig.app.json` | **0 error** |
| web lint | `npx oxlint src` | **0 问题** |
| web 单测 | `npx vitest run` | **36 files / 374 tests passed** |
| web e2e | `npx playwright test --workers=1` | **38 passed / 3 failed / 19 skipped**（失败项见 §5.4） |
| api lint | `apps/api/.venv/bin/ruff check .` | **All checks passed** |
| api 类型 | `apps/api/.venv/bin/python -m mypy app` | **no issues in 94 source files** |
| api 单测 | `apps/api/.venv/bin/python -m pytest tests -q` | **通过（exit 0）**（本轮后端未改代码） |

### 5.2 GS-NEXT-05 专项单测（48 例，4 个新文件）

| 文件 | 例数 | 覆盖 |
| --- | --- | --- |
| `src/__tests__/xr-destinations.test.ts` | 10 | 准入规则（停用/无名/无初始相机）、环形步进、key↔下标 |
| `src/__tests__/xr-rig-pose.test.ts` | 8 | **真实 `Entity`**：eye 落位（用户在 rig 内偏移 0.4 m 也能精确落）、只对齐 yaw、6DoF 保留、零位姿/NaN 拒绝、**连续 20 次无累积漂移** |
| `src/__tests__/xr-menu.test.ts` | 12 | UI 系统注册幂等、菜单行形状、字形源、`XR_FLOOR_TELEPORT_ALLOWED === false`、舒适过渡状态机（out→midpoint→in、忙时丢弃、单次订阅、midpoint 抛错不卡死、reset/destroy） |
| `src/__tests__/xr-menu-wiring.test.ts` | 18 | 装到官方 Rig、行序、无初始相机无 home、空目的地不给菜单、地板传送关且不碰其它开关、目的地准入、菜单事件→淡出→Rig 移动的顺序、A→B→C→初始环形、home 回 authored 相机、未入会话只登记、退出走 `handle.endXR`、`xr end` 复位、destroy 后事件失效、反复开关/available 不重复安装 |

### 5.3 GS-NEXT-05 专项 e2e（7 例，真实浏览器 + 真实 API/DB）

`e2e/gsnext05-xr-menu.spec.ts` —— 通过 DEV 把柄 `window.__gsxrruntime` 直接读**官方引擎
状态**（不是读我们自己的标志位）：

1. **菜单真的装上了**：组件系统 `{element, screen, button}` 齐备；Rig 上
   `scriptNames` 含 `xrNavigation` 与 `xrMenu`；**5 行菜单**、**4 个可交互按钮各带 element**
   （能渲染也能被射线拾取）、**5 个 text 元素**且文字正是
   `初始位置 / 上一个 / 下一个 / 返回初始位置 / 退出 VR`；font 资产存在且**已生成 30 个字形**；
   UI 层存在；黑纱实体在；目的地 5 个。
2. **地板传送关、其余导航不动**：`enableTeleport=false`、`enableMove=true`、
   `turnMode='snap'`、`enableSnapVertical=true`；产品诊断同步显示 `disabled`。
3. **产品层诊断**：`state=installed`、`menuInstalled=true`、
   `destinationCount = viewpointCount + guidePointCount + 1`（含 authored 初始视角）、
   `currentDestination = initial:xr-initial`。
4. **环形切换 + 出生位姿同步**：下一个 → 第 1 个观察点（页面 `selectedViewpointId`
   同步、菜单标签含其名字、出生位姿不再是 `not-authored`）；再下一个 → 第 1 个导览点；
   **返回初始位置** → 回到 `initial:xr-initial`、相机回到 authored 位置（**不是**"上一个
   目的地"—— 这是测试抓到的真实 bug，见 §6.2）；上一个 ×3 环形回绕不越界。
5. **进入前在 DOM 选观察点** → 会话内菜单的"当前目的地"已经对上（同一份数据）。
6. 菜单装上时**不阻断主链路**：本机无头显 ⇒ `canStartVR=false`（浏览器能力决定，与菜单
   无关），但菜单状态仍是 `installed`。
7. **Desktop 零回归**：`/scene/:id` 上**没有** `xrMenu`（只有官方本来就有的 `xrNavigation`）。

### 5.4 失败项（如实记录，非本任务引入）

3 条 e2e 失败全部在 `e2e/ssv08-streaming.spec.ts`（SSV-08 streamed-sog / LOD），
与本轮改动无关，根因是**本地夹具缺失**：该 spec 依赖 git-ignored 的
`apps/web/scenes/ssv08-large`、`ssv08-single`（1.8M gaussians LOD 树），
当前机器上 `apps/web/scenes/` **整个目录不存在**（`ls` 无该目录，
`GET /local-scenes/ssv08-large/versions/b/lod-meta.json` → **403**），于是 180 s
流式断言超时。桌面 LOD 那两条同样因场景不存在而拿不到 `ov-diagnostics`。
本轮未触碰 SSV-08 相关代码；已知的 SwiftShader 软件渲染首帧不可达问题见
[SSV-08 记忆/报告]。19 条 skipped 是原本就按环境条件跳过的（GPU/私有性/正式描述符）。

---

## 6. 验收项逐条状态（任务书 §5 的 10 条）

| # | 验收项 | 软件证据 | 状态 |
| --- | --- | --- | --- |
| 1 | 进入 VR 后官方菜单可见可用 | 菜单装在官方 Rig、按钮/文字/字形建出、可被官方事件驱动 | SOFTWARE（**显示本身 HARDWARE PENDING**） |
| 2 | 导览点 A→B→C | e2e 用例 4 + wiring 用例「初始 → vp → ann → 初始」 | SOFTWARE VERIFIED |
| 3 | 从 C 返回 A | e2e 用例 4 的 `home` + 三次 `prev` 环形 | SOFTWARE VERIFIED |
| 4 | 观察点与 Annotation 导览点坐标正确 | `xr-rig-pose`（eye 精确落位到 mm 级、含 rig 内偏移）与 e2e 逐点落位 | SOFTWARE VERIFIED（落点观感 HARDWARE PENDING） |
| 5 | 连续切换 20 次不累积漂移 | `xr-rig-pose` 真实 Entity 跑 20 次并断言第 21 次与第 1 次逐位相同 | SOFTWARE VERIFIED |
| 6 | 每次切换后头部追踪、左右摇杆仍正常 | 只移动父 Rig、头显局部姿态不变（单测断言）；官方 `enableMove`/snap turn 未被碰（e2e） | SOFTWARE（手感 HARDWARE PENDING） |
| 7 | 菜单选择不触发地面传送 | `enableTeleport=false`（e2e 直读官方脚本）+ 仲裁单测 | SOFTWARE VERIFIED |
| 8 | 退出并重新进入 VR 3 次状态正确 | `xr.on('end')` 复位黑纱/菜单态/传送策略；destroy 后事件失效；`available` 重试不重复安装（单测） | SOFTWARE（真实重入 HARDWARE PENDING） |
| 9 | 删除/禁用/STALE/无 authored camera 的目的地不被提供 | `xr-destinations`（停用、无名、无初始相机）+ wiring（标注在官方数组里查不到 → 2 个而非 3 个） | SOFTWARE VERIFIED |
| 10 | Desktop 官方 Annotation Navigator 不回归 | e2e 用例 7（Desktop 无 xrMenu）；GS-NEXT-04 的 4 条官方导览器用例仍在全量 e2e 里通过 | SOFTWARE VERIFIED |

### 6.1 未做 / 明确不做

- **不做**动态目的地列表（2.22.4 的 `XrMenu` 没有官方"按数据重建菜单"路径，见 §3.1）。
- **不做**地面/射线传送（`enableTeleport` 恒关，理由见 §4.2）。
- **不做**手柄自研输入系统、不 fork viewer/engine、不改官方包源码、不新建渲染器/
  CameraManager/导航系统。

### 6.2 本轮被测试抓到的两个真实 bug（已修）

1. **`destinationPose('initial')` 用了可变的 `xrInitialCamera`** ⇒ 每次传送都会覆盖它，
   于是「返回初始位置」悄悄变成"回到上一个目的地"。改为读**不可变**的
   `authoredInitialCamera`，并在代码里注释锁死。
2. **会话内切换后 PC 页面选中态停留在旧值**（假状态）。补 `onXRDestinationChanged`
   广播 + hook 同步 `selectedViewpointId` / `selectedGuidePointId`。

---

## 7. PICO Neo3 人工验收步骤（**全部 HARDWARE PENDING**）

准备：走生产/预览 HTTPS（`XR` 需要 secure context）；用带 **观察点 ≥1、导览点 ≥1**
的场景；确认头盔与手柄电量、`adb` 可用则先 `adb logcat -c`。

| 步 | 操作 | 期望 | 取证 |
| --- | --- | --- | --- |
| 1 | 进入 `/xr/:sceneId`，点「进入 VR」 | 进得去、双手渲染正常、出生在 authored 初始视角 | `/xr/diagnostics` JSON 的 `xrRuntimeState.spawnStatus = applied` |
| 2 | 按**左摇杆上推**（手柄 Y / button 4） | 官方菜单在控制器旁弹出，5 行字能看清、能读出中文 | 目视；`xrMenu.menuVisible = true` |
| 3 | 射线指向「下一个」，扣扳机 | 切到下一个目的地；**不**被弹到 Y=0；菜单标签与所在位置一致 | `diag-xr-menu-current` 变化、`diag-xr-rig` 的 `rigPosition` = 目标点 |
| 4 | 连续点「下一个」直到转一圈 | 5 个目的地循环、回得到起点、不越界 | 逐次记录 `xrMenu.currentDestination` |
| 5 | 点「返回初始位置」 | 回到 authored 初始相机 | `rigPosition` ≈ `[2.5,1.8,6]` |
| 6 | **连续切换 20 次** | 无累积漂移、无卡顿、无黑纱残留 | 记录 20 组的 `rigPosition` 与返回起点的误差 |
| 7 | 每次切换后用摇杆走一圈、snap turn 两次 | 6DoF 正常、移动/转向正常、方向无反 | 目视 + 目视 |
| 8 | 切换瞬间盯住黑纱 | 0.14 s 淡出 → 定位 → 0.24 s 淡入，**无闪白、无残影、无眩晕** | 目视（舒适度只能主观评） |
| 9 | 退出 VR（菜单里的「退出 VR」）→ 再进 → 重复 3 次 | 每次都能进、菜单可再次打开、状态无残留、无多重响应（按一次只跳一个） | 三轮记录 `xrMenu.state` |
| 10 | 菜单打开状态下扣扳机选按钮 | 只点中菜单，不发生任何传送 | 目视 |
| 11 | Desktop `/scene/:id` 同场景 | 官方标注 Navigator 行为不变、无新增 UI | 目视 |

判定规则：**这 11 步全部通过之前，本功能不得写成硬件通过**；任一步失败就把
`/xr/diagnostics` 的完整 JSON 回传（`xrMenu` / `xrRuntimeState` 已在里面）。

---

## 8. 后续：VR 热点射线交互是否需要？

**现在不需要做，且这一轮明确不做。** 理由：

- 桌面侧热点交互已是官方实现（GS-NEXT-04 放行 `.sse-annotationNav`，0 自绘 UI），
  同一批热点在 VR 里只是"走过去看"，而**"走过去"这一步本轮用导览菜单解决了**。
- VR 内热点射线交互（射线选中 3D 热点 → tooltip/媒体）是**另一个交互维度**：
  官方 `XrMenu` 已经证明 XR 射线拾取这条路是通的（它自己就做射线 vs 元素包围盒），
  但要落到官方热点实体上，需要额外回答：热点标签在 immersive 下的遮挡/深度、
  媒体 Overlay 在头显里的排版、以及触发射线与官方导航射线的手势冲突。
- 这些问题的答案**依赖真机观察**（尤其遮挡与手势冲突），在没有 PICO 证据前动手
  等于猜。建议在 §7 的 11 步通过之后另立任务（可命名为 GS-NEXT-06），并继续遵守
  "能用官方 UI 就不用自绘"。

---

## 9. 跑法陷阱（本轮踩到，记录以免复现）

1. `CanvasFont.updateTextures()` 对全新实例会抛
   `Cannot read properties of undefined`（必须先 `createTextures()`）。
2. `playcanvas/scripts/*` 在 2.22.4 **没有类型**；`XrMenu` 继承旧版 `Script`，
   `scriptComponent.create()` 的 TS 签名要 `ScriptType` —— 显式断言一次并在注释里
   写明原因，不要在声明里谎报类型。
3. `app.systems.add()` 对重名会抛 ⇒ 注册官方 UI 组件系统必须先判重。
4. PlayCanvas 的 `Entity.addComponent` 在**组件系统缺失时静默返回 null**，不抛错 ——
   "菜单建出来但不响应"通常就是系统没注册。
5. 官方 `viewer.js` 在 `xr.on('start')` 会重写 Rig 位姿 ⇒ 进入 VR 前设置的位姿必须
   在会话内再施加一次（`prepareXRSpawn`），否则等于没设。
6. UI 平面的法线是实体局部 +Z、相机前向是 -Z ⇒ 自建 UI 面要绕 Y 转 180°；
   且 `ScreenComponent` 默认 `scaleMode = NONE` ⇒ `scale` 恒为 1，物理尺寸只由实体缩放决定。

---

## 10. 变更清单

**新增**

- `apps/web/src/scene-runtime/xrMenu.ts`
- `apps/web/src/scene-runtime/xrDestinations.ts`
- `apps/web/src/scene-runtime/xrRigPose.ts`
- `apps/web/src/types/playcanvas-xr-scripts.d.ts`
- `apps/web/src/__tests__/{xr-destinations,xr-rig-pose,xr-menu,xr-menu-wiring}.test.ts`
- `apps/web/e2e/gsnext05-xr-menu.spec.ts`
- `docs/reports/GS_NEXT_05_IMMERSIVE_NAVIGATION.md`（本文件）

**修改**

- `apps/web/src/scene-runtime/SuperSplatRuntime.ts`（菜单安装 / 目的地 / 仲裁 /
  舒适过渡 / 出生对齐复用 `xrRigPose` / `getXRState` 增加 `xrMenu`）
- `apps/web/src/features/viewer-official/useSuperSplatXR.ts`（`guidePoints` 传入、
  诊断读数、目的地广播同步、DEV 把柄）
- `apps/web/src/pages/XRViewerPage.tsx`、`apps/web/src/pages/XRTestPage.tsx`（诊断口）
- `docs/GSPlatform_WebXR_VR_Master_Plan.md`（§9 补 GS-NEXT-05）

**未触碰**：`apps/api` 生产代码、官方依赖版本、`playcanvas` / `supersplat-viewer`
包源码、历史 13M SceneVersion 及其 PLY、Gaussian / LOD / 渲染路径。