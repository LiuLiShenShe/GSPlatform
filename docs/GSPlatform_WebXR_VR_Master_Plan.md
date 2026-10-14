# GSPlatform：通用 3D Gaussian Splatting Web + PICO VR 平台 —— 四阶段开发主计划

> 版本：V2.1｜2026-10-14
> 项目：[`LiuLiShenShe/GSPlatform`](https://github.com/LiuLiShenShe/GSPlatform)
> 本次修订基线：`93083af4ab2f1eade24637ed15a88272799af3b3`
> 目标设备：**PICO Neo3**；第一交付形式：**头显浏览器直接访问自有 HTTPS 网站并进入 WebXR**。
> 决策属性：**主计划 / 后续开发阶段的需求权威来源**。实际施工以当时最新 HEAD、锁定的官方依赖和真实 PICO 验收为准。
> 本次修订依据：[`docs/reports/GS_NEXT_00_BASELINE_REPORT.md`](../reports/GS_NEXT_00_BASELINE_REPORT.md)（GS-NEXT-00 开发基线收口）、[`docs/reports/GS_NEXT_01_PICO_READINESS.md`](../reports/GS_NEXT_01_PICO_READINESS.md)（GS-NEXT-01 PICO 就绪度）、[`docs/reports/GS_NEXT_02_INITIAL_CAMERA_FIX.md`](../reports/GS_NEXT_02_INITIAL_CAMERA_FIX.md)（GS-NEXT-02 初始视角修复与默认性能模式）、[`docs/reports/GS_NEXT_03_VIEWPOINT.md`](../reports/GS_NEXT_03_VIEWPOINT.md)（GS-NEXT-03 官方 Viewpoint 快速切换）、[`docs/reports/GS_NEXT_04A_ANNOTATION_AUDIT.md`](../reports/GS_NEXT_04A_ANNOTATION_AUDIT.md)（GS-NEXT-04A 标注导览只读审计）、[`docs/reports/GS_NEXT_04_ANNOTATION_NAVIGATION.md`](../reports/GS_NEXT_04_ANNOTATION_NAVIGATION.md)（GS-NEXT-04 官方标注导览 + XR 出生导览点）。

---

## 0. 项目定位（唯一定位，冲突时以此条为准）

**GSPlatform 是独立部署的通用 3D Gaussian Splatting（3DGS）Web + VR 平台。不是农业、温室、植物表型或数字孪生平台。**

用户上传已经重建完成的 Gaussian PLY，平台调用官方 SplatTransform 生成 SOG / Streamed SOG（分块 + LOD），由官方 SuperSplat Viewer 在 PC 浏览器高画质显示、在 PICO Neo3 上经 WebXR 显示。

**平台负责**：上传、权限、场景目录、版本、资源服务、部署、分享。
**平台尽量薄**：Gaussian 解码/压缩/LOD/渲染/编辑/体素碰撞/相机动画/摇杆导航/传送 —— 全部优先复用 PlayCanvas 官方组件，平台只做调度、校验、鉴权与薄适配。

**不新增第五阶段。不开发任何行业定制功能。**

### 0.1 已删除的旧业务要求（本版正式作废）

以下内容在 V1.0 中作为项目目标出现，**本版全部删除，不再是任何阶段的开发要求**：

| 已删除项 | 处置 |
| --- | --- |
| `AGRI-01` 农业数字孪生阶段（单株/作物行/温室管理、植物实例、测量数据、表型、多时相模型绑定） | **删除**。不再是阶段、不再是验收项、不排期 |
| "农业业务最后扩展""农业数字孪生业务"作为后续路线 | **删除**。不是"后续"，是不做 |
| 农业/温室相关 PASS 判据与产品定义 | **删除** |
| 官方 SuperSplat Studio 托管产品对标（含其账号、发布、计费、托管存储） | **仅作体验参考**，不复制、不作为依赖 |

### 0.2 历史农业场景资产的处置

历史场景 `u-06924576399e`（13,090,324 Gaussian / `streamed-sog` / Recipe v2）**保留为历史测试资产与压力测试样本**，理由是它已经被冻结为不可变 SceneVersion，且是当前唯一的真实大场景 XR 负载证据来源。

**但它不是产品目标、不是演示要求、不是行业样例。** 对它的任何操作（重新转换、重新发布、覆盖、清理推广）都需要单独授权，见 [§5.4](#54-gaussian-清理边界)。

---

## 1. 四阶段开发路线

四阶段是**唯一**开发路线。阶段之间是依赖顺序，不是并行建议。

```mermaid
flowchart LR
    P1[阶段 1<br/>平台基础] --> P2[阶段 2<br/>官方组件整合]
    P2 --> P3[阶段 3<br/>WebXR / PICO 真实体验]
    P3 --> P4[阶段 4<br/>Web+VR 共用体验优化]
```

### 状态标签定义（全文统一，不得混用）

| 标签 | 含义 |
| --- | --- |
| `IMPLEMENTED` | 代码存在且逻辑完整。**不代表任何验收通过** |
| `SOFTWARE VERIFIED` | 有自动化测试/隔离浏览器证据支持 |
| `HARDWARE PENDING` | 必须在真实 PICO Neo3 上验收，当前无真机证据 |
| `NOT IMPLEMENTED` | 尚未开发 |

**铁律：代码存在 ≠ PICO 验收通过。** 任何状态标记都不允许从"代码写了"推断"真机通过"。

---

### 阶段 1：平台基础

**目标**：自有的账号、权限、场景目录、上传处理管线、版本与资源服务可以稳定支撑后续 XR 工作。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 断点续传、PLY/SOG 校验、上传状态机 | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 已有 FastAPI/Celery/Redis 实现与并发/幂等回归 |
| 官方 SplatTransform 调用、SOG / Streamed SOG / LOD | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 锁定 `splat-transform 3.3.3`；13M 场景已产出 259 chunk |
| 不可变 SceneVersion + `content.url` 发布 | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 已有版本不复用/不覆盖回归 |
| 场景编辑会话（官方 Editor 接入） | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 过期、并发 CAS、所有权隔离已覆盖 |
| SceneAccessPolicy / 私有 / 分享 / CSRF | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 匿名访问私有资源必须 401/403 |
| COLMAP / gsplat 云端重建 | `IMPLEMENTED`（可选能力） | 保留，不阻塞主线 |
| 正式域名 + 生产 HTTPS + 一键部署 | `NOT IMPLEMENTED`（部分） | 有 `deploy/` 脚本与回滚；固定域名与生产实机验收未完成 |

**阶段 1 出口条件**：新用户能上传一份真实 Gaussian PLY，系统自动完成转换/分块/LOD/发布，且桌面 Viewer 能加载。软件门禁已覆盖；生产部署状态见 §6。

---

### 阶段 2：PlayCanvas 官方组件整合

**目标**：把 GSPlatform 做成官方组件的**薄适配层**，杜绝重复实现。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 唯一生产 Viewer：`@playcanvas/supersplat-viewer@1.35.0` | `IMPLEMENTED` + `SOFTWARE VERIFIED` | `apps/xr-viewer` 已删除，`apps/viewer` 冻结 |
| 唯一 Runtime Descriptor + ExperienceSettings v2 编译 | `IMPLEMENTED` + `SOFTWARE VERIFIED` | Desktop / XR 共用同一 descriptor |
| SceneVersion 作为唯一真相源 | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 桌面与 XR 只消费当前版本统一 `content.url` |
| SceneTransformAdapter（Scene↔Runtime 世界变换） | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 场景坐标为权威，Runtime 坐标不落库 |
| 官方 LOD / Streaming / 渲染预算 / Performance Mode | `IMPLEMENTED`（官方） | 平台只读官方 state，不自研 |
| 官方 Voxel / GLB 碰撞生成（CLI 薄适配） | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 小场景真实 CLI 已跑通；默认 `MANUAL_ONLY` |
| Annotation → 官方 annotation 协议映射 | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 热点复用官方 marker/tooltip/相机过渡 |
| 官方 `XrControllers` / `XrNavigation` 随 Viewer 自动装载 | `IMPLEMENTED`（官方，**未经真机验收**） | 见 [§3.1](#31-关于-xr-navigation-与-setmoveinput-的更正) |

**阶段 2 出口条件**：任何渲染、LOD、相机动画、编辑器、碰撞算法都不是平台自研。代码审计可验证。

---

### 阶段 3：WebXR / PICO VR 真实体验

**目标**：真实 PICO Neo3 头显中完成上传场景的 WebXR 闭环。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `/xr/:sceneId` 产品页（进入/退出 VR、加载、错误） | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 强制 WebGL + WebXR，同一 runtime |
| XR 有界性能诊断（导出 JSON） | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 仅开发构建或显式开关 + `?diagnostics=1` |
| **PICO 真机 immersive-vr / 6DoF 验收** | **`HARDWARE PENDING`** | 无真机证据。历史 `local-garden` 曾在真机进入过 immersive VR，但当前新链路未验收 |
| **PICO 真机 Gaussian 预算档位** | **`HARDWARE PENDING`** | 官方通用预算（移动端 1M/2M）**不是** PICO Neo3 实测值 |
| **PICO 真机退出/重入、黑屏、掉帧** | **`HARDWARE PENDING`** | 软件桌面证据不可替代 |
| **PICO 摇杆移动 / Snap Turn 实机手感** | **`HARDWARE PENDING`** | 官方 `XrNavigation` 已装载；**未实测** |
| 稳定生产域名 + HTTPS（真机入口） | `NOT IMPLEMENTED` | 现仅有临时 Quick Tunnel，不是生产方案 |

**阶段 3 出口条件**：真实 PICO Neo3 经自有 HTTPS 打开 `/xr/:sceneId`，进入 immersive-vr，双目显示、6DoF 正常、≥3 次退出重入无持续黑屏。**当前未满足。**

真机验收方法见 [`docs/operations/VR_01C_PICO_TEST_GUIDE.md`](../operations/VR_01C_PICO_TEST_GUIDE.md)。

---

### 阶段 4：Web + VR 共用场景体验优化

**目标**：让同一个场景在桌面和头显里都好用。**统一实施顺序见 §5，顺序不可跳步。**

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 初始视角（authored initial camera）保存/恢复/XR 起点 | `IMPLEMENTED` + `SOFTWARE VERIFIED` + XR 段 `HARDWARE PENDING` | 见 [§5.1](#51-初始视角) |
| Gaussian 清理（非破坏性实验管线） | `IMPLEMENTED`（工具）+ 候选 `NOT APPROVED` | 见 [§5.2](#52-gaussian-清理) |
| 预设视点（SceneViewpoint）桌面导航 | `IMPLEMENTED` + `SOFTWARE VERIFIED` | 缺排序 UI 与"更新为当前视角"面板动作 |
| 快速切换（导览点 + XR 传送） | `NOT IMPLEMENTED` | 设计已预审，见 `docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md` |
| 热点（Annotation）在沉浸 VR 内的呈现 | `NOT IMPLEMENTED` | 桌面热点可用；沉浸内需要世界空间面板 |
| VR 内交互（VR 菜单、射线选择） | `NOT IMPLEMENTED` | 需世界空间 UI |
| XR 导航点跳转（A/B 切点、淡出→跳转→淡入） | `NOT IMPLEMENTED` | 同"快速切换" |

---

## 2. 平台与 PlayCanvas 的责任边界

| 领域 | 责任方 | 说明 |
| --- | --- | --- |
| Gaussian 解码、压缩、SOG、Decimate、LOD/分块 | **官方 SplatTransform** | 平台只调用、校验、调度、保存结果 |
| Gaussian 渲染、流式 LOD、渲染预算 | **官方 SuperSplat Viewer + Engine** | 平台薄适配，不 fork 渲染器 |
| Gaussian 选择、裁剪、清理、导出 | **自部署官方 SuperSplat Editor** | 已接入，不重新发明编辑工具 |
| Voxel / GLB 生成 | **官方 SplatTransform** | 平台管理触发、seed、预算、Job、校验 |
| 相机动画、annotation 相机过渡、标记投影、Prev/Next 导航器 | **官方 Viewer** | 禁止自研插值/缓动 |
| 摇杆移动、Snap Turn、弹道传送、手柄渲染、WebXR 会话生命周期 | **官方 Engine `XrNavigation` / `XrControllers`** | 见 §3.1 |
| 账号、场景、权限、分享、版本、Job、数据安全 | **GSPlatform** | 自有域名、自有数据库 |
| 初始视角、导览点、路线、热点元数据、VR 菜单配置 | **GSPlatform 业务 + 官方 UI/输入基础** | 自有配置与薄交互 |
| 导览点的 Rig 放置 | **薄适配（一次性公开 Entity 变换）** | 不重写导航引擎 |

### 2.1 不可协商的架构约束

1. **唯一 Viewer** —— 生产渲染只有 `@playcanvas/supersplat-viewer`。`apps/viewer` 冻结不参与 dev/build/deploy/acceptance；`apps/xr-viewer` 已删除，不得复活。
2. **唯一 Runtime Descriptor** —— 桌面与 XR 从同一个 `SceneRuntimeDescriptor` 渲染，差异只在 renderer / 性能 / 交互模式。
3. **唯一授权资产服务** —— 所有 Gaussian 字节经 SceneAccessPolicy 鉴权后由 Nginx `X-Accel-Redirect` 下发，不存在公开旁路。
4. **SceneVersion 唯一真相源** —— 桌面和 XR 只消费当前版本的统一 `content.url`；桌面相机切换不等于 XR Rig 传送。

---

## 3. 本版对 VR-03 预审的更正

### 3.1 关于 `XrNavigation` 与 `setMoveInput` 的更正

V1.0 主计划 §5/§2 存在两处**与固定版本官方源码不符**的表述，本版正式更正：

**已核对固定版本（`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`）的实际源码：**

1. **官方 `XrNavigation` 已经存在并且已经装载。** 官方 Viewer 的 XR 初始化把 `XrControllers` 和 `XrNavigation` 都 `create()` 到相机父实体上：

   ```js
   // node_modules/@playcanvas/supersplat-viewer/dist/viewer.js（1.35.0，initXr）
   parent.script.create(XrControllers);
   parent.script.create(XrNavigation);
   ```

   因此 V1.0 中"需要把官方 `xr-navigation.mjs` 塞进现有 Viewer、其兼容性未知"的表述**不成立**——它已经在那儿了。XR 下的左摇杆移动、右摇杆 Snap Turn、弹道传送由官方组件提供。

2. **XR 下 `setMoveInput` 不是摇杆控制的替代品。** `setMoveInput` 是桌面 fly/walk 的相机相对移动输入，在 immersive XR 中被忽略。**绝不能用"调用了 `setMoveInput`"或"桌面上 `setMoveInput` 正常"来宣称 PICO 摇杆支持完成。** 摇杆支持的真实验收只能在真实 PICO 上进行。

3. **官方 XR 起点会丢弃已保存的相机高度。** 官方 `xr.on('start')` 中：

   ```js
   parent.setPosition(cameraPosition.x, 0, cameraPosition.z);  // Y 被强制为 0
   parent.setEulerAngles(0, angles.y, 0);
   ```

   官方只搬 X/Z 与 yaw，**把 Y 置 0**，随后由头显首个 tracked pose 驱动相机。所以"进入 XR 前桌面相机是对的"**不能**证明头显出生点是对的。这就是阶段 4 初始视角需要一次性 Rig 放置的根本原因，也是为什么它必须标记 `HARDWARE PENDING`。

4. **官方 `selectAnnotation` 不会移动 XR Rig。** 官方在 `app.xr.active` 时跳过桌面相机管理器，`selectAnnotation` 只在桌面相机上编排过渡。因此"Web 端点一下就能在 VR 里传送"是**错的**。

### 3.2 更正后的官方能力判定

| 能力 | 官方是否已提供 | 平台还需要做什么 |
| --- | --- | --- |
| XR 会话生命周期、双目、6DoF | 是 | 无（需真机验收） |
| 摇杆移动、右摇杆 Snap Turn | **是（`XrNavigation`）** | 只做真机调参与验收 |
| 弹道地面传送 | **是（`XrNavigation.tryTeleport`）** | 需要安全的地面/尺度准入；未标定场景不得声称可安全落地 |
| 导览点跳转到**任意已存 eye pose** | **否** | 需要一个薄的一次性 Rig 放置适配 + 准入校验 |
| 沉浸 VR 内的热点/菜单 UI | **否**（桌面 UI 是 DOM + 鼠标监听） | 需要世界空间 UI，共享同一批 DB ID |
| XR 状态退出恢复 | 是 | 只做回归验证 |

---

## 4. 官方组件复用清单（采购/实现决策表）

**规则：清单内的能力禁止自研。**

| 能力 | 官方来源 | 锁定版本 | GSPlatform 现状 |
| --- | --- | --- | --- |
| 场景渲染 / Gaussian raster | SuperSplat Viewer | 1.35.0 | 已接入（唯一 Viewer） |
| SOG 编解码 / LOD / 分块 / voxel 碰撞 | SplatTransform CLI | 3.3.3 | 已接入（薄适配 + 校验） |
| WebXR / XR 管理 / 手柄 | PlayCanvas Engine `xr-manager` | 2.22.4 | 官方自动装载 |
| 摇杆移动 / Snap Turn / 弹道传送 | Engine `xr-navigation.mjs` | 2.22.4 | 官方自动装载，**未真机验收** |
| XR 菜单 / 手柄管理 | Engine `xr-menu.mjs` / `xr-manipulation.mjs` | 2.22.4 | 可用，未接入 |
| XR 控制器可视化 | Engine `xr-controllers.mjs` | 2.22.4 | 官方自动装载 |
| 相机动画 / orbit / 相机过渡 | Viewer `camera-manager` / `selectAnnotation` | 1.35.0 | 已复用 |
| Gaussian 编辑 / 裁剪 / 选择 | 官方 SuperSplat Editor | 自部署 | 已接入 |
| 深度拾取 splat 表面 | Viewer 内部 `Picker.pickSurface` | 1.35.0 | **非公开 API**，不得声称可用 |
| 渲染预算 / Performance Mode | Viewer `state.performanceMode` | 1.35.0 | 已接入（薄封装，不建第二个 Viewer） |
| GPU 光栅化 / 排序 / LOD 选择 | Viewer + Engine | 1.35.0 / 2.22.4 | 官方，未 fork |

---

## 5. 阶段 4 统一实施顺序（**不可跳步**）

四项体验优化有严格依赖关系。**必须按 5.1 → 5.2 → 5.3 → 5.4 → 5.5 顺序推进**；前置项未验收通过时，后置项不得开工。

### 5.1 初始视角（先做）

理由：它是唯一同时影响桌面构图、XR 出生点和后续导览点坐标基准的能力；坐标基准错了，后面全部偏移。

必须满足：

- 保存时执行 Runtime→Scene 逆变换落库；Scene 坐标是权威。
- Desktop：有 authored camera → `resetCamera()`（恢复 `cameras[0].initial`）；无 authored → 官方 `frameScene()` fallback。
- XR：有 authored camera → 一次性 Rig 放置（对齐水平 yaw，反推 rig 位置），**不得覆盖 HMD 6DoF**；无 authored → 官方 fallback。
- 官方默认相机动画不得造成视角自动漂移。
- 无 authored camera 的历史场景必须保持官方 fallback，不得偷偷塞一个"猜的"出生点。

当前状态与未验收项见 [`docs/reports/GS_NEXT_00_BASELINE_REPORT.md`](../reports/GS_NEXT_00_BASELINE_REPORT.md) §4。

### 5.2 Gaussian 清理（次做，且需人工批准）

**边界（硬约束）**：

1. **不重新转换、不覆盖、不删除、不发布**历史 13M Gaussian 资产。`da7bf4207044` 与其 2,076 个发布文件是不可变的。
2. **不得**把 Pilot 参数自动推广到完整场景。
3. 清理候选未经过**人工质量批准**前，一律维持 `HOLD_NOT_APPROVED`。
4. 不在本阶段启动新的完整大规模过滤。
5. 唯一实际滤点算法必须来自官方 CLI/Editor，平台只做白名单薄适配。

理由：清理收益依赖 PICO 实测帧时间，而当前没有该证据；过早推广参数有不可逆损伤风险。

### 5.3 预设视点与快速切换

视点（`SceneViewpoint`）与导览点（Annotation）语义分离：视点是纯观察视角、无标记；导览点是带标记的到达节点。

- 补齐视点排序与"更新为当前视角"面板动作（`ViewpointPanel` 已知缺口）。
- 快速切换的官方复用边界见 §3.2：桌面用官方 `selectAnnotation` + 官方导航器；XR 侧需要一次性 Rig 放置适配。
- 不得新增第二套相机控制、第二套 Viewer 或自研 XR Rig 系统。

### 5.4 XR 导航

在 5.1 与 5.3 完成后进行。官方 `XrNavigation` 已在运行，本阶段只做：真机调参、导览点传送准入、淡出→跳转→淡入、退出/重入状态清理。

未标定米制、无合规碰撞的场景必须明确标注为**自由飞行巡览**，不得声称可安全地面行走。

### 5.5 热点与 VR 内交互

热点元数据复用现有 Annotation，不新建第三套数据模型。沉浸 VR 内需要世界空间 UI（桌面 DOM Overlay 在 immersive 下不可见，这是已确认的产品限制）。

---

## 6. 验收边界与门禁规则

### 6.1 软件门禁 ≠ 真机验收

| 验收项 | 软件可验 | 必须真机 | 满足条件 |
|---|---|---|---|
| PLY→SOG→SceneVersion | 是 | 否 | 格式/LOD/校验和正确，Viewer 加载成功 |
| 真实上传场景进入 XR | 辅助 | **是** | 真进 immersive-vr，双目，6DoF |
| 大场景流式加载 | 是 | **是** | 分块动态加载，无持续黑屏/卡死 |
| PICO 渲染预算档位 | 是 | **是** | 实测三档帧时间后确定默认值 |
| 初始视角保存/恢复 | 是 | **是** | 桌面构图正确 + 头显出生点正确 |
| 摇杆移动 / Snap Turn | 仅数学 | **是** | 方向正确、无漂移、无连转 |
| 导览点跳转 | 单元/浏览器 | **是** | ≥5 节点、连续 20 次准确切换 |
| 碰撞生成 | 真实 CLI | 否 | 产物有效、版本绑定、授权访问 |
| 碰撞 Walk | 辅助 | **是** | 已标定场景合理；未标定安全禁用 |
| VR 内菜单/热点 | 辅助 | **是** | 沉浸态实际可见可操作 |
| 私有作品/分享 | 是 | **是** | 未授权 401/403/404 |
| HTTPS 生产部署 | 是 | **是** | 稳定域名真实可访问 |

**门禁规则**：软件测试通过不能代替真实头显 PASS。不得把未实现的手柄控制、导航点、VR 菜单或碰撞传送列为已完成。

### 6.2 当前验收总状态

| 维度 | 状态 |
| --- | --- |
| 软件门禁（Backend / Workers / Web / 静态检查） | 见基线报告 §8 |
| PICO Neo3 真机验收 | **`HARDWARE PENDING` —— 尚无任何真机回传数据** |
| 生产域名 HTTPS | **`NOT IMPLEMENTED`** |

---

## 7. 不做的事（防止再次跑偏）

1. **不开发任何行业定制功能**（农业、温室、植物表型、数字孪生）。这不是"后续扩展"，是不做。
2. 不自研 Gaussian 编码、SOG、LOD Tree、Renderer、Voxel 体素化、Gaussian 编辑器。
3. 不复活 `apps/xr-viewer`，不开第二套 Viewer、第二套相机控制、第二套 XR Rig 系统。
4. 不用 `setMoveInput` 或桌面模拟宣称 PICO 摇杆/6DoF/传送已完成。
5. 不因为碰撞失败就阻止 Fly、节点跳转或场景 XR 加载。
6. 不把 SuperSplat Studio 的托管生成按钮理解为免费自部署后端 API；自部署只用官方开源 CLI。
7. 未授权不修改历史 13M Gaussian SceneVersion，不自动重复转换大文件，不自动推广清理参数。
8. 不直接操作 WebXR HMD Camera 位姿；Rig/导航按官方公开接口实现。
9. 不认为"WebGL/XR 画面能出来"就等于具备摇杆、导览点、VR 菜单。
10. 不凭官方通用 1M/2M 预算推断 PICO Neo3 跑得流畅；以实测为准。
11. 不把生产部署当成 Git push 的自然结果；迁移、服务启动、真机验收独立进行。

---

## 8. 开发时推荐的检查入口

| 领域 | GSPlatform 入口 |
| --- | --- |
| WebXR 正式页 | `apps/web/src/pages/XRViewerPage.tsx` |
| XR 状态与生命周期 | `apps/web/src/features/viewer-official/useSuperSplatXR.ts` |
| 官方 Viewer 薄适配 | `apps/web/src/scene-runtime/SuperSplatRuntime.ts`（`startVR` / `endXR` / `setMoveInput` / `selectViewpoint` / `prepareXRSpawn`） |
| 初始视角策略 | `apps/web/src/scene-runtime/initialCameraPolicy.ts`、`apps/web/src/features/authoring/InitialViewPanel.tsx`、`apps/web/src/pages/SceneAuthoringPage.tsx` |
| 场景坐标 ↔ Runtime 变换 | `apps/web/src/scene-runtime/SceneTransformAdapter.ts`、`apps/web/src/scene-runtime/experienceAdapter.ts` |
| 场景内容 URL / 碰撞 URL | `apps/api/app/services/scene_runtime.py`、`apps/web/src/scene-runtime/descriptorResolver.ts` |
| 转换与发布 | `workers/pipeline/convert_scene.py`、`splat_transform_adapter.py`、`artifact_validator.py`、`workers/tasks/publish_scene.py` |
| 官方碰撞 | `workers/collision/splat.py`、`workers/tasks/build_collision.py`、`apps/api/app/services/collision_policy.py` |
| 清理实验（只读/未批准） | `workers/pipeline/gaussian_quality.py`、`workers/pipeline/cleanup_experiment.py` |
| 导览点/热点预审（**设计，非实现**） | `docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md` |
| PICO 真机验收方法 | `docs/operations/VR_01C_PICO_TEST_GUIDE.md`、`docs/operations/VR_01D_CLEANUP_WORKFLOW.md` |
| 当前的基线与缺口 | `docs/reports/GS_NEXT_00_BASELINE_REPORT.md` |
| PICO 就绪度 | `docs/reports/GS_NEXT_01_PICO_READINESS.md` |
| 初始视角修复与默认性能模式 | `docs/reports/GS_NEXT_02_INITIAL_CAMERA_FIX.md` |
| 视点快速切换（官方能力编排） | `docs/reports/GS_NEXT_03_VIEWPOINT.md` |
| 标注导览（Desktop 官方导览器 + XR 出生导览点） | `docs/reports/GS_NEXT_04_ANNOTATION_NAVIGATION.md` |
| XR 出生视点/导览点选择 | `apps/web/src/features/viewer-official/useSuperSplatXR.ts`、`apps/web/src/pages/XRViewerPage.tsx` |
| 导览点准入规则 | `apps/web/src/scene-runtime/guidePoints.ts` |
| 官方 UI 作用域兼容层（放行导览器） | `apps/web/src/scene-runtime/superSplatUiCompatibility.ts` |
| 性能模式默认策略 | `apps/web/src/scene-runtime/performanceModePolicy.ts` |

---

## 9. 下一任务边界

当前基线的真实缺口、失败原因与后续任务的建议实施边界，记录在
[GS-NEXT-00](../reports/GS_NEXT_00_BASELINE_REPORT.md)（基线收口）
与 [GS-NEXT-01](../reports/GS_NEXT_01_PICO_READINESS.md)（PICO 就绪度）。

**GS-NEXT-02（2026-10-13，SOFTWARE VERIFIED / HARDWARE PENDING）**：初始视角修复与
Performance Mode 默认 ON，见 [报告](../reports/GS_NEXT_02_INITIAL_CAMERA_FIX.md)。
根因是保存侧而非恢复侧 —— (1) PATCH 返回后事务尚未提交导致创作页预览立刻读到旧值
（已改为返回前 `commit()`）；(2) 乐观更新在保存失败时不回滚、且失败被静默吞掉，
形成「从未持久化的假保存」（已改回滚 + 显式报错 + 保存后回读描述符验证）；
(3) STALE 场景下描述符有意丢弃 initialCamera 而面板仍显示"已保存"
（如实告警，不再谎称成功）；(4) XR 一次性 Rig 对齐必须等首个有效 tracked head pose
（修复前在零值位姿上对齐后永不修正）。全库统计：dev 库 555 个 `u-*` 用户场景
100% 无 authored 视角；163 个历史相机全部是 `workers/pipeline/convert_scene.py:300`
的硬编码常量，不能用作"自动推荐"（因此平台有意不发明任何自动推荐来源）。

**GS-NEXT-03（2026-10-14，SOFTWARE VERIFIED / HARDWARE PENDING）**：基于官方
SuperSplat Runtime 的 Viewpoint 快速切换，见 [报告](../reports/GS_NEXT_03_VIEWPOINT.md)。
核对后确认**大部分能力早已存在**（SceneViewpoint 模型、Backend CRUD、Desktop Saved
Views 下拉、作者侧「保存当前视角」面板、官方 CameraManager 过渡），本任务没有重写
其中任何一项。真正的缺口有两处：(1) 视点的增/改/删/重排只 `flush()` 不 `commit()`
—— 与 GS-NEXT-02 同一类 yield 依赖 teardown 竞态，表现为「刚建的视点不出现 / 点了
切换没反应」（已改为返回前 `commit()`，4 个后端用例锁定）；(2) XR 侧没有「进入 VR
前选择出生视点」的入口（新增 `SuperSplatRuntime.viewpointRuntimePose()` /
`setXRInitialCamera()`，XR 页复用既有进入前图层加选择器，**未新建任何 VR UI 系统**）。
出生点优先级：用户显式选择 > authored 初始视角 > 官方 Y=0。四个 Case 全部在真实
浏览器 + 真实 API 上验证（过渡轨迹 104–120 样本、单帧位移约 6% 全程 → 平滑无跳飞、
不离开邻域 → 无鸟瞰；落位误差 < 0.05）。**真机出生点仍为 HARDWARE PENDING。**

主计划的下一阶段是**阶段 3 的真机闭环**：在真实 PICO Neo3 上完成 `/xr/:sceneId` 的
immersive-vr 验收并回传诊断 JSON。**软件代码里已经没有可以"顺手做掉"的阶段 3 内容**——
剩下的全部是真机证据；若真机上仍回退到鸟瞰，页面会显示 `initial-view-runtime-mismatch`
告警并回传诊断 JSON。

**GS-NEXT-04（2026-10-14，SOFTWARE VERIFIED / HARDWARE PENDING）**：官方标注导览
（Desktop）+ XR 出生导览点，见 [审计](../reports/GS_NEXT_04A_ANNOTATION_AUDIT.md) 与
[实施报告](../reports/GS_NEXT_04_ANNOTATION_NAVIGATION.md)。先只读审计、再动手，结论是
**官方标注 UI（hotspot / tooltip / Prev-Next 导览器）在锁定版 1.35.0 里逻辑已完整，只是被
GSPlatform 的作用域 CSS 连同其余 chrome 一起藏掉了**。按"能用官方就直接用"的原则：

1. **Desktop 新增 0 行 UI 代码** —— 隐藏规则从 `.sse-ui { display:none }` 改为
   `.sse-ui > *:not(.sse-annotationNav) { display:none }`（白名单，官方将来新增 chrome 会
   自动隐藏）。循环导航 / 少于 2 条隐藏 / 按钮 disable / 序号标题跟随 / 显隐跟随官方
   `showAnnotations` 全部由官方提供。刻意**不给导览器自身写 display**（那会破坏官方
   `sse-hidden` / `sse-desktop` / `sse-touch` 三态）；放行导览器后其余 chrome 仍必须隐藏，
   否则全宽 `.sse-controlsWrap` 会吃掉 canvas 拖拽（已用真实拖拽用例锁定）。
2. **XR 新增 0 个数据模型** —— "导览点"= 带作者化相机的标注，并进 GS-NEXT-03 已有的
   "出生位置"选择器（同一批数据库 ID，与 Desktop 官方热点同源），与观察点互斥。
   pose 直接取官方 `annotations[i].camera.initial`（**已由 experienceAdapter 换算到 RUNTIME
   空间，绝不再换算一次**）。准入规则 `guidePoints.ts` 排除"无自有相机、官方会回落成场景
   初始相机"的老热点 —— 否则就是一个不报错的假承诺。
3. 放行官方 UI 暴露出的连带修复：`selectViewpoint()` 切换观察点前先清官方标注选中态
   （tooltip / 媒体 Overlay / 导览器序号读的是同一个官方状态）。

验证：GS-NEXT-04 专项 4 用例全过（导览器序号 1→2→3→回绕、相机落到各标注作者化相机、
其余 chrome 可见数 0、canvas 拖拽仍生效；XR 导览点 `gp=3`、选中后出生位姿 = 标注相机、
与观察点互斥）；GS-NEXT-04+02+03 串行 **16 passed**（未回归）；SSV-06 三件套更新到新契约
**5 passed**；vitest 326、tsc 0 error、ruff/mypy 全过、后端 566 + workers 189。
**真机出生点仍为 HARDWARE PENDING。**

另登记两处与代码无关的**跑法陷阱**（详见实施报告 §6）：(a)
`apps/web/src/services/http.ts` 的默认 `baseURL` 是绝对地址 `:8001`，不走 vite 代理，
与 `GS_API_PROXY_TARGET` 指向的库会**脑裂**（页面与 spec 打两个不同的库）—— 已在
gitignored 的 `apps/web/.env.development.local` 用 `VITE_API_BASE_URL=/api/v1` 消除；
(b) 后端 pytest 用的是**开发库**而非测试库，开发库迁移滞后即大面积报
`UndefinedColumn` —— 本轮把隔离库 `gsplatform_test` 迁到 head 后跑全绿，**未动共享开发库**。
共享开发库 `gsplatform` 随后也已按用户指示修复（见 [实施报告 §10](../reports/GS_NEXT_04_ANNOTATION_NAVIGATION.md)）：
迁到 head `cd03ef05ab06`（此前落后 4 个迁移，workers 因 `upload_sessions.scene_type`
缺失而失败；DBA 注意：迁移被 4 个泄漏 3 天的 `idle in transaction` 会话卡住）；
`fix02-semantics` 夹具的初始相机恢复为 `[2.5,1.8,6] / [0,0.6,0]`、删除 4 条残骸视点
（该 spec 随即 6 passed）；`ssv07-collision.spec.ts` 按**当前真实契约**重写 ——
未校准场景 walk 被诚实拒绝，而不是伪造一条 VERIFIED 校准（**物理行走+碰撞在浏览器层
的覆盖缺口已明确登记**）；描述符与作品列表的 `posterUrl` 恒 404 修好（封面实际在
`/presentation/cover`，此前全站封面都是裂图），修后公网 HTTPS 实测整页 0 条 4xx/5xx。

实机（PICO Neo3）验收的**准备**已完成并写入 [实施报告 §9](../reports/GS_NEXT_04_ANNOTATION_NAVIGATION.md)：
本机无头显 / 无 OpenXR runtime / 无 adb，immersive-vr 会话只能在真机上验证；
除该次会话外的全部链路已在**真实公网 HTTPS** 上实测通过（secure context、
navigator.xr、官方 WebGL2 runtime、authored 初始视角、观察点 1 / 导览点 3、0 条 4xx）。

---

## 10. 官方资料

1. PlayCanvas — [SuperSplat Viewer](https://developer.playcanvas.com/user-manual/supersplat/viewer/)
2. PlayCanvas — [SuperSplat Viewer API（v1.35.0）](https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/docs/api.md)
3. PlayCanvas — [Streaming & Performance](https://developer.playcanvas.com/user-manual/supersplat/streaming/)
4. PlayCanvas — [SplatTransform CLI Reference](https://developer.playcanvas.com/user-manual/splat-transform/cli-reference/)
5. PlayCanvas — [Collision Mesh Generation](https://developer.playcanvas.com/user-manual/splat-transform/collision/)
6. PlayCanvas — [Generating Streamed SOG](https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/)
7. PlayCanvas — [XR Navigation Engine Script (v2.22.4)](https://github.com/playcanvas/engine/blob/v2.22.4/scripts/esm/xr/xr-navigation.mjs)
8. PlayCanvas — [WebXR](https://developer.playcanvas.com/user-manual/xr/using-webxr/)
9. PlayCanvas — [Web Components XR](https://developer.playcanvas.com/user-manual/web-components/xr/)
10. GSPlatform — [GitHub](https://github.com/LiuLiShenShe/GSPlatform)：代码事实以仓库最新 HEAD 为准。

**产品体验参考**（仅参考体验，不复制其代码、不假定其内部实现公开、不引入其托管依赖）：
知天下 3DGS 平台。

---

## 11. 产品验收定义（Definition of Done）

一个第一次使用 GSPlatform 的用户应当能够：

1. 用自己的账号上传一份已经训练好的 Gaussian PLY。
2. 无需手工运行命令，等待官方 SplatTransform 完成压缩、Streamed SOG / LOD 构建和版本发布。
3. 在 PC 网页中查看高质量模型，**保存一个安全的初始视角**和若干视点。
4. 戴上 PICO Neo3，打开同一个作品的 HTTPS XR 链接，点击进入 VR。
5. 在 XR 中获得 6DoF 双目沉浸体验，**出现在自己保存的初始视角**；大场景按需加载 LOD。
6. 用手柄左摇杆自由移动、右摇杆舒适转向。
7. 通过菜单或按键在导览点之间切换；在头显内打开热点说明或 VR 菜单。
8. 退出 XR、重新进入，或返回作品列表选择下一个场景。
9. 用户的场景、权限、导览点和资源保存在自己的 GSPlatform 服务器上。

**达到这九步，阶段 4 才算完成。** 其中第 4–7 步的每一步都必须有真实 PICO Neo3 证据，软件测试不能替代。