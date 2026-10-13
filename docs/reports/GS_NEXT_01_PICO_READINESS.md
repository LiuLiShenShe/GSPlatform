# GS-NEXT-01 — PICO Neo3 WebXR 真机验收准备

> 任务编号：**GS-NEXT-01**
> 日期：2026-10-13
> 仓库：`/fj/GSPlatform` · [GitHub](https://github.com/LiuLiShenShe/GSPlatform)
> 参考/起始 HEAD：`7000a8aebe29a34c1f3ab2f17d1777f2071008eb`（`main` == `origin/main`，工作树 clean）
>
> **最终状态：`READY FOR PICO TEST`**
> 软件侧条件已具备并可复现；**未获得任何 PICO 实机证据**，因此本报告不出现任何 `HARDWARE PASS`。

---

## 1. 当前 HEAD

| 项目 | 值 |
| --- | --- |
| 起始 HEAD | `7000a8aebe29a34c1f3ab2f17d1777f2071008eb` |
| 分支 | `main`，与 `origin/main` 同步（已 `git fetch` 核对） |
| 起始工作树 | clean（`git status --short` 空） |
| 本轮改动 | `docs/operations/VR_01C_PICO_TEST_GUIDE.md`（修订为五组验收）、新增本报告 |
| 危险操作 | **无** `reset --hard`、**无** `git clean`、**无** force push |

### 1.1 预检文档与代码一致性

已阅读 `docs/GSPlatform_WebXR_VR_Master_Plan.md`（V2.0）、`docs/reports/GS_NEXT_00_BASELINE_REPORT.md`、
`docs/reports/VR_01C_PICO_PERFORMANCE.md`、`docs/operations/VR_01C_PICO_TEST_GUIDE.md`、
`docs/architecture/VR_03_PLAYCANVAS_ANNOTATION_REUSE.md`，并**逐项对照真实代码**（见 §4、§5、§6）。

核对结论：**文档与当前代码一致**。三处需要用固定版源码二次确认的声明（`XrNavigation` 已装载、
`setMoveInput` 不是 XR 摇杆、官方 XR 起点 Y 强制为 0）**全部为真**（见 §5）。

---

## 2. 环境与服务状态

`./scripts/gsplatform-vr.sh status` → **EXIT 0**，8 个服务全部 MANAGED：

| 服务 | PID | 状态 |
| --- | --- | --- |
| api | 1271806 | MANAGED，`/health/live` `{"status":"ok"}`，`/health/ready` `{"status":"ready"}` |
| web | 2469162 | MANAGED（vite `127.0.0.1:5175`，经 nginx 5174 暴露） |
| proxy | 2469498 | MANAGED |
| publish | 2468640 | MANAGED |
| cpu | 2468744 | MANAGED |
| gpu | 2468846 | MANAGED |
| maintenance | 2468922 | MANAGED |
| tunnel | 2469685 | MANAGED |
| editor | — | `EDITOR_HTTP_HEALTH=PASS` |

**版本一致性**：API 进程 cwd = `/fj/GSPlatform/apps/api`，Web 进程 cwd = `/fj/GSPlatform/apps/web`，
两者均直接从当前工作树运行 → **API 与前端同为 `7000a8a`**，不存在"GitHub 最新但服务器旧进程"的错配。

隔离环境变量文件 `~/.local/state/gsplatform-vr00-20261011/runtime.env` 权限为本用户 `600`，
**未读取、未输出任何密钥值**（仅列出变量名做检查）。

**资源授权**：私有场景 `u-3b48959f67fd` 经 HTTPS 入口返回 **401**；公开场景返回 200。授权链路正常。

### 2.1 机器负载（性能基准前置条件，按任务要求记录）

| 指标 | 值 | 判定 |
| --- | --- | --- |
| load average | **74.23 / 79.74 / 75.48**（64 核） | ❌ 严重争用 |
| CPU | us 79%，idle 15%，**steal 0%** | ❌ 高占用 |
| 内存 | 77 GB / 125 GB 已用，available 48 GB | ⚠️ 偏紧 |
| GPU0 (A6000) | **99%**，21,698 / 49,140 MiB | ❌ 外部任务占用 |
| GPU1 (A6000) | **81%**，1,586 / 49,140 MiB | ❌ 外部任务占用 |

**判定：本机当前不适合做性能基准测试。** 依据任务要求
（"如果机器明显被外部任务占用，必须标记环境不适合性能基准测试，不得强行重复多轮重负载任务"），
本轮**没有**重复执行 GS-NEXT-00 已 `LIMIT REACHED` 的 13M 重负载 Playwright 用例，
**没有**放宽超时、删除断言或跳过失败项。

---

## 3. HTTPS 入口及其稳定性

| 项目 | 值 |
| --- | --- |
| URL | `https://argue-algorithm-agency-complications.trycloudflare.com` |
| 类型 | **Quick Tunnel（临时，非稳定生产入口）** |
| 证书 | `CN=trycloudflare.com`，签发 Google Trust Services `WE1`，有效期至 **2027-01-03** |
| TLS 校验 | `ssl_verify_result=0`（**可通过**，公开可信 CA） |
| 根路径 | 200 |
| `/xr/test` | 200 |
| `/xr/u-a68b94d84538` | 200 |
| 同源 `/api/v1/scenes/.../runtime`（公开） | 200 |
| 同源 `/api/v1/scenes/<private>/runtime` | **401**（授权正确） |

**结论**：

- HTTPS 入口**当前可用**，TLS 有效，同源 API 与资源鉴权正常，满足 WebXR 的 secure-context 要求。
- 但它是 **Quick Tunnel = 临时 hostname，无生产 SLA**，并发 chunk 请求可能受影响。
  **不得**标记为稳定生产入口，**不得**当作 PICO 长期性能结论的依据。
- 稳定入口需由域名管理员配置命名 tunnel 或受控 LAN HTTPS（方案见验收指南文末）。
  本轮**未修改**任何正式 DNS / Cloudflare 配置 / 生产凭据。

---

## 4. 初始视角软件验证

**结论：`SOFTWARE VERIFIED`（软件契约完整）。未为增加代码量而改写任何实现。**

### 4.1 实际链路（逐点核对代码）

| # | 链路环节 | 实现位置 | 结论 |
| --- | --- | --- | --- |
| 1 | 创作页获取当前 camera pose | `SceneAuthoringPage.tsx:229-244` `getCurrentPose()` | ✅ |
| 2 | Runtime→Scene 逆变换 | 同上，`runtime.worldTransform.runtimeToSceneCamera(...)` | ✅ |
| 3 | 保存 `initialCamera.position/target/fov` | `useSceneAuthoring.ts:138-146` `setInitialView()` | ✅ |
| 4 | 重新加载 Runtime Descriptor | `descriptorResolver` + `buildExperienceSettings` | ✅ |
| 5 | Desktop 使用官方 `resetCamera()` | `useSuperSplatXR.ts` `syncReady()`（authored 分支） | ✅ |
| 6 | XR 使用一次性 Rig 对齐 | `SuperSplatRuntime.ts:422-460` `prepareXRSpawn()` | ✅ |
| 7 | 退出/重入清理状态 | `finally { cancel() }` + `xr.on('end')` + `destroy()` | ✅ |

### 4.2 重点项逐条验证

| 重点项 | 结论 | 依据 |
| --- | --- | --- |
| 未设置视角时用官方 fallback | ✅ | `initialCameraPolicy.ts:25` `shouldFrameSceneOnLoad()`；descriptor 无 authored → `frameScene()` |
| 设置视角后不被 `frameScene()` 覆盖 | ✅ | 同一分支二选一（`syncReady()` 内 `initialized` 单次守卫） |
| 官方默认动画不让 authored 相机漂移 | ✅ | 加载后一次 `resetCamera()` 恢复 authored 姿态（VR-01C 已 root-cause） |
| XR 不持续改写 HMD 位姿 | ✅ | `prepareXRSpawn` 仅在一次 `xr.update` 中写 rig，`finally` 注销订阅；从不写 head camera |
| 世界变换后仍用正确坐标 | ✅ | `experienceAdapter.ts:169` `sceneToRuntimeCamera()` 施加 W 后写入 `cameras[0].initial` |
| 进入 VR 的实际高度不能仅由 Desktop pose 推断 | ✅ **已确认是真实约束** | 官方 `xr.start` 把 Rig Y 强制为 `0`（见 §5.3）。故该高度**必须**真机核对，标记 `HARDWARE PENDING` |

### 4.3 运行的实测证据

```bash
cd apps/web && npx playwright test e2e/fix02-semantics.spec.ts --reporter=list
→ 6 passed (1.2m) / EXIT 0
```

6 项覆盖：Desktop authored 初始相机加载（`[2.5,1.8,6]`/fov47，与 DB 一致、未被覆盖）、
frameScene 与 reset 严格数值、已保存 Viewpoint 消费（`[3,2,7]`/fov52）、
3 条标注各自相机互不相同、World Transform `rotation y=90` 统一换算、
XR 页（强制 WebGL）加载后 camera pose 与 DB authored initial 一致。

Web 单元测试同时覆盖：`initial-camera-policy.test.ts`（6 例）、
`super-splat-runtime.test.ts`（含 authored 经 W 变换的首次 XR eye、无 authored fallback、destroy/failed-start 清理）。

### 4.4 未验收项

| 项 | 状态 |
| --- | --- |
| 真实 PICO `local-floor` 出生位置与首个 tracked eye | **`HARDWARE PENDING`** |
| 真机头部俯仰/roll 是否被 rig 放置覆盖 | **`HARDWARE PENDING`**（软件已证只写一次 rig） |
| 历史 13M 场景实际出生点 | **未设置**——实测其 descriptor `initialCamera` 仍全为 `null`，且无 viewpoints/annotations/collision，当前只能走 `frameScene()` fallback |

---

## 5. 官方 XR 控制组件核验

依据**固定版本实际安装源码**：`@playcanvas/supersplat-viewer@1.35.0`、`playcanvas@2.22.4`。

### 5.1 `XrNavigation` 与 `XrControllers` 是否实际挂载 —— ✅ 是

```js
// node_modules/@playcanvas/supersplat-viewer/dist/viewer.js （initXr）
parent.addComponent('script');
parent.script.create(XrControllers);
parent.script.create(XrNavigation);
```

两者都创建在**相机父实体（XR Rig）**上，且**未配置任何 script 属性** `→ 全部走官方默认值`。

### 5.2 控制器输入如何进入官方 XR navigation —— ✅ 链路清晰

| 环节 | 源码事实 |
| --- | --- |
| 输入源收集 | `this._inputSources.add(inputSource)` |
| 轴读取 | `gamepad.axes[2]`（X）/ `axes[3]`（Y）；前置条件 `gamepad.axes.length >= 4` |
| 左手 | `handedness === 'left'` → `_handleMovement()`（相机相对平移，作用于 Rig） |
| 右手 | `handedness === 'right'` → `_handleSnapTurning()` / `_handleSmoothTurning()` |
| 死区 | `movementThreshold = 0.1`，`if (length <= threshold) return` |
| Snap 边沿检测 | `rotateThreshold=0.5` / `rotateResetThreshold=0.25` 迟滞，一次偏转只触发一次 |
| 会话 | `xr.start(camera.camera, 'immersive-vr', 'local-floor', {...})` |

**官方默认值核实**（决定真机手感）：

```text
turnMode = 'snap'          rotateSpeed = 45（度/次）
enableMove = true          movementSpeed = 1.5
enableTeleport = true      maxTeleportDistance = 10      groundHeight = 0
```

`turnMode='snap'` 与主计划承诺的"右摇杆 Snap Turn"**一致**；45° 转向角亦与"30°/45° 舒适转向"一致。

### 5.3 官方 XR 起点行为 —— 确认会丢弃保存高度

```js
const started = xr.on('start', () => {
    parent.setPosition(cameraPosition.x, 0, cameraPosition.z);  // ← Y 强制为 0
    parent.setEulerAngles(0, angles.y, 0);                       // ← 只搬 yaw
});
```

这是"进入 XR 前桌面相机正确 **≠** 头显出生点正确"的**源码级证据**，
也是 GSPlatform 需要一次性 Rig 对齐的根本原因。

### 5.4 GSPlatform 是否有 CSS/Overlay/React/事件拦截 —— ✅ 未发现拦截

| 检查项 | 结论 |
| --- | --- |
| GSPlatform 是否调用 `setMoveInput` | **否**。`SuperSplatRuntime.ts:489` 仅为透传包装，**生产源码零调用点**（仅测试引用） |
| 是否存在第二套 gamepad / thumbstick / axes / inputSource 处理 | **否**。全仓库 `src/` 搜索：**零命中** |
| 是否请求 `dom-overlay` | **否**。GSPlatform 未申请任何 DOM overlay 特性 |
| ⇒ 后果 | 沉浸 VR 内 GSPlatform 的 HTML UI（顶栏 / 面板 / 诊断）**不可见也不可交互**，因此**不可能**拦截控制器射线。这是官方能力的直接结果，不是缺陷 |
| 是否有 `visibilitychange` 之类可意外终止 XR 的处理器 | **否**，零命中 |
| React 生命周期是否会重建 viewer 干扰 XR | 有 `cancelled` 守卫 + `reloadKey` 控制重建；测试覆盖"卸载后晚到事件不重建 viewer"（`xr-pages` Test 6） |

### 5.5 XR Session 退出后是否残留异常输入状态

- 官方 `xr.on('end')` 恢复 `parent` 与 `camera` 的进入前变换，`app.autoRender=false`。
- GSPlatform 侧：`prepareXRSpawn` 的 `cancelXRSpawn` 订阅在 `xr.on('end')` 上注销；
  每次 `startVR()` 前再次 `cancelXRSpawn?.()`；`destroy()` 清空全部 `unsubscribers`。
- 页面状态机由官方 `onXRModeChanged` 驱动 `xr-active` → `xr-ended`；
  `xr-pages` 测试覆盖 Test 5（系统退出）、Test 6（重入）、Test 7（Exit VR 按钮）。

**✅ 软件侧未发现残留输入状态。真机重入手感仍需 E 组验收。**

### 5.6 结论

**未发现任何有明确复现证据的 GSPlatform 集成错误。** 故**未做任何代码修改**
（遵守"仅在发现明确复现证据的集成错误时才允许最小修复"及"不允许为增加代码量而改写"）。

`XrNavigation` / `XrControllers` / Snap Turn / Teleport / 头显追踪 **全部为官方组件**，
未新增第二套控制器、Fly、Snap Turn 或 Teleport 系统。

---

## 6. 现有性能诊断功能验证

**结论：诊断能力完整，`SOFTWARE VERIFIED`。**

### 6.1 实现位置

- `apps/web/src/scene-runtime/RuntimePerformanceDiagnostics.ts`
- `apps/web/src/features/viewer-official/XRPerformancePanel.tsx`
- 入口：开发构建或 `VITE_XR_PERFORMANCE_DIAGNOSTICS=true` + URL 含 `?diagnostics=1`

### 6.2 实测（小场景真实 SOG，隔离入口）

```bash
npx playwright test e2e/vr01c-pico.spec.ts:44 :70 :81   # 跳过重负载的 :104
→ 3 passed (23.2s) / EXIT 0
```

| 用例 | 结果 |
| --- | --- |
| 小真实 SOG：官方 Performance Mode A/B + 偏好保留 + 本地 JSON 导出 | ✅ |
| 私有场景拒绝（401）且加载失败仍能导出本地证据 | ✅ |
| 真实小 Viewer：authored 变换相机不被 frame（descriptor fixture），`spawnStatus='not-entered'` | ✅ |

**导出 JSON 无 Cookie / token / Authorization / 敏感 URL**（用例内断言）。

### 6.3 诊断 JSON 字段与验收指南的一致性（已核对源码）

| 指南要求字段 | 源码是否导出 | 位置 |
| --- | --- | --- |
| `schemaVersion` / `assetVersion` / `lodCounts` | ✅ | `:260-263` |
| `browser` / `network` | ✅ | `:262-263` |
| `timing.timeToFirstGaussianFrameObservedMs` / `timeToLoadedMs` / `timeToXRSessionStartMs` / `xrEnterDurationMs` | ✅ | `:264-267` |
| `samples[].frames[source='xr-session-callback']` | ✅ | `FrameSource` 类型 + `xrMode` 分流 `:5,71-72,125` |
| `runtime.renderedGaussians` / `renderer` / `performanceMode` | ✅ | `readRuntime()` |
| `resourceSummary.completedRequests` / `chunkResourceRequests` / `observedTransferBytes` / `stallsOver1000Ms` / `observedHttpErrors` | ✅ | `resourceSummary()` |
| `runtime.xr`（`active`/`referenceSpace`/`spawnStatus`/`rigPosition`/`headLocalPosition`/`headWorldPosition`） | ✅ | `getXRState()` |

**诚实的 `unavailable` 字段**（浏览器不暴露，禁止补填）：`gpuMemoryBytes`、`inFlightRequests`、`decodeMs`、`textureUploadMs`；
以及 `gpuFPS`。诊断自身声明 `frameSource` 与 `cpuSource` 语义，**不把桌面帧间隔冒充 PICO GPU 性能**。

### 6.4 大场景（13M）诊断

**本轮未重跑。** 依据 §2.1 的环境判定，13M 重负载用例在 GS-NEXT-00 已连续 `LIMIT REACHED`
（load 45→107、GPU 93–100%、CPU steal 26–59%，页面仍正常渲染 597,389 Gaussian）。
在同等争用下重复只会在无新信息的情况下消耗资源。**该用例的状态保持 `ENVIRONMENT BLOCKED`（性能基准层面），
其功能正确性此前记录为 `SOFTWARE VERIFIED`（`f95f5aa`）。**

### 6.5 场景清单（真机验收可用性，实测）

| 规模 | Scene | 资产 | 说明 |
| --- | --- | --- | --- |
| 小 | `u-a68b94d84538` | 常规 SOG，`21c371259407`，1,788 Gaussian | A / C / E 组基础场景 |
| 小（streamed） | `u-90c5a107f65e` | `lod-meta`，`b98021ea426c` | 备选 |
| 大 | `u-06924576399e` | Streamed SOG，`da7bf4207044`，LOD `[13090324, 3927097, 1309032]`，259 chunks | D 组只读压力测试 |
| **中（0.5–1M）** | **不存在** | — | ⚠️ **缺口，见 §9** |

---

## 7. 软件测试结果

| # | 门禁 | 命令 | 结果 | Exit |
| --- | --- | --- | --- | --- |
| 1 | Web 单元 | `npx vitest run` | **30 files / 283 tests passed** | 0 |
| 2 | Playwright FIX-02（初始视角） | `npx playwright test e2e/fix02-semantics.spec.ts` | **6 passed** | 0 |
| 3 | Playwright VR-01C（小场景 + 诊断） | `npx playwright test e2e/vr01c-pico.spec.ts:44 :70 :81` | **3 passed** | 0 |
| 4 | 服务状态 | `./scripts/gsplatform-vr.sh status` | 8 服务 MANAGED + editor health PASS | 0 |
| 5 | 入口与授权 | HTTPS 根/`/xr/test`/`/xr/:id` = 200；私有 = 401 | 通过 | — |

本轮**仅改动一个文档**（验收指南），未改任何生产代码，故 backend / workers / ruff / mypy 无新变更需要重跑；
其最近一次全绿记录见 `docs/reports/GS_NEXT_00_BASELINE_REPORT.md` §8（含 clean-checkout gate `EXIT 0`）。

### 7.1 跳过与未执行项（诚实记录）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| Playwright `vr01c-pico.spec.ts:104`（13M 有界加载） | **未执行** | 机器严重争用，按任务要求不强行重复重负载 |
| Playwright `vr01a-public-xr.spec.ts` | **未执行** | 需显式配置 live public/private scene 环境变量（按设计 SKIP） |
| 中型场景正常加载确认 | **未执行** | 环境内**没有**中型场景资产（§6.5） |
| 全部真机项（A–E） | **未执行** | 无真实 PICO Neo3 接入 |

---

## 8. 真机人工测试操作与证据要求

验收指南已就地修订为五组（不另立第二套）：
**`docs/operations/VR_01C_PICO_TEST_GUIDE.md`**

| 组 | 主题 | 场景 URL | 关键 PASS 判据 |
| --- | --- | --- | --- |
| **A** | 小场景基础验证 | `<HTTPS>/xr/u-a68b94d84538?diagnostics=1` | 进入 immersive-vr、双目、6DoF、左右摇杆、≥3 次退出重入无持续黑屏 |
| **B** | 初始视角 | 创作页保存 → `<HTTPS>/xr/u-06924576399e?diagnostics=1` | Desktop reset = 保存值；PICO 出生点接近保存位置、水平朝向一致；`spawnStatus='applied'` |
| **C** | 性能模式 | `<HTTPS>/xr/u-a68b94d84538?diagnostics=1` | ON/OFF 均可切换；记录各自帧时间/Gaussian 数/加载耗时与视觉差异；结论基于真机 |
| **D** | 大场景流式加载 | `<HTTPS>/xr/u-06924576399e?diagnostics=1` | 分块动态加载；三类卡顿各有真机判定；**卡死/过热立即停止** |
| **E** | 会话恢复 | 同 A | 退出后桌面相机恢复；重入后 6DoF/摇杆/控制器正常、无残留输入 |

每组均已在指南中给出：**可用 URL、操作步骤、预期 UI 状态、JSON 导出方式、PASS/FAIL 判据**，
以及回传字段清单（§6.3 已确认这些字段确实被导出）。

### 8.1 诊断导出方式

退出 XR（系统菜单）→ 回到网页 → 面板「停止」→「下载诊断 JSON」→ 文件名
`gsplatform-xr-diagnostics-<timestamp>.json`。**加载失败也要导出**。
面板在沉浸视野内不可操作（未请求 `dom-overlay`），这是设计而非缺陷。

### 8.2 已知官方默认行为风险（真机必须观察，取自固定版源码，均未验证）

| # | 事项 | 源码事实 | 需观察 |
| --- | --- | --- | --- |
| **R1** | **地面传送默认开启** | `enableTeleport=true`、`maxTeleportDistance=10`、`groundHeight=0` | 未标定米制的 Gaussian 场景中，按官方传送扳机会把用户送到 **Y=0 平面**，该平面**未必**与场景地面重合（13M 场景 runtime 稳健 Y 区间约 `[-43,-11]`，Y=0 在其**上方**）。观察是否"掉到场景外" |
| R2 | 摇杆轴映射 | 读 `axes[2]/[3]`，要求 `axes.length>=4`，按 `handedness` 分左右手 | Neo3 手柄是否提供 ≥4 轴；左右手判定；方向是否符合直觉 |
| R3 | Snap Turn | `turnMode='snap'`、`rotateSpeed=45` | 一次偏转恰好转一次、无连转；45° 是否舒适 |
| R4 | 参考空间 | `'local-floor'` | 是否正确进入 local-floor；出生高度是否合理 |
| R5 | 速度/死区 | `movementSpeed=1.5`、`movementThreshold=0.1` | 速度是否过快/过慢；死区是否有残余漂移 |

> **R1 是本次最需判定的行为**（可能在用户第一次按扳机时造成困惑）。
> 本任务**不**在没有硬件证据的情况下擅自修改官方默认行为；是否需要在官方脚本配置层关闭该路径，
> 应在取得真机证据后单独评审（见 §9）。

---

## 9. 当前阻塞项与下一步动作

### 9.1 阻塞项

| # | 阻塞 | 类型 | 影响 |
| --- | --- | --- | --- |
| B1 | **无真实 PICO Neo3 接入** | `HARDWARE PENDING` | A–E 全部真机项无法执行；无法产生任何 `HARDWARE PASS/FAIL` |
| B2 | **HTTPS 入口是 Quick Tunnel** | 需运维 | 临时 hostname、无 SLA，不宜作为长期/性能结论入口 |
| B3 | **机器严重争用**（load 74–80 / 64 核，GPU 81–99%） | `ENVIRONMENT BLOCKED`（性能基准） | 大场景性能基准不可测；13M 重负载用例不宜重跑 |
| B4 | **缺少中型场景（0.5–1M）** | 资产缺口 | 无法验证"中型场景正常加载"，只能测 1.8K 与 13M 两个极端 |
| B5 | **历史 13M 无 authored 初始相机** | Owner 动作 | B 组开始前必须由 Owner 实际保存；Agent 不得猜测默认出生点 |
| B6 | **R1 官方传送默认行为未经真机判定** | 待判定 | 可能造成首次体验困惑；需硬件证据后再决定是否调整 |

### 9.2 下一步动作（按优先级）

1. **接入 PICO Neo3 并执行 A 组**（最高优先）。这是唯一能推动 `HARDWARE PENDING → PASS/FAIL` 的动作。
2. **由 Owner 保存 13M 场景的 authored 初始视角**（B5），随后执行 B 组。
3. **准备稳定 HTTPS 入口**（B2）：由域名管理员配置命名 tunnel 或受控 LAN HTTPS；凭据不入 Git，
   不自动改正式域名。
4. **执行 C / D / E 组**，回传诊断 JSON。D 组若出现卡死/过热立即停止。
5. **在性能基准前确认机器空闲**（B3），否则把性能结论标记为环境受限。
6. （可选）**上传一份中型真实 PLY（0.5–1M）**（B4），补齐中档验证。
7. 取得真机证据后，**单独评审 R1**（官方传送默认行为）是否需要调整。

### 9.3 明确不在本任务范围

不提前开发预设导览点、VR 菜单、碰撞/Walk；不重启 13M 转换；不清理/覆盖/发布历史 Gaussian 资产；
不新增第二套 Viewer / 相机控制 / XR Rig / 控制器系统；不修改官方 Viewer 源码；不开发任何行业定制功能。

---

## 10. 最终状态

```text
GS-NEXT-01
=========================================
ENVIRONMENT (services / HTTPS / authz / version) : SOFTWARE VERIFIED
INITIAL VIEW CONTRACT                            : SOFTWARE VERIFIED
OFFICIAL XR CONTROL INTEGRATION (source-level)   : SOFTWARE VERIFIED
PERFORMANCE DIAGNOSTICS                          : SOFTWARE VERIFIED
SWIFT UI / TEST GATES (283 unit + 3 + 6 e2e)     : PASS

PICO NEO3 HARDWARE ACCEPTANCE (A–E)              : HARDWARE PENDING
LARGE-SCENE PERFORMANCE BENCHMARK                : ENVIRONMENT BLOCKED
STABLE HTTPS ENTRY                               : NOT IMPLEMENTED (Quick Tunnel only)

=> READY FOR PICO TEST
```

**本任务未完成整个 GS-NEXT-01 验收**——因为没有真实 PICO 证据。
本任务交付的是**让用户能够真正开始 PICO 实机验收所需的全部准备**：
服务与入口可用、软件契约可复现、官方组件集成经源码核验、诊断字段与验收指南一一对应。

**只有实际获得并核验 PICO 实机证据，才可写 `HARDWARE PASS`。**
