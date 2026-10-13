# PICO Neo3 真机验收指南（VR-01C 指南 · GS-NEXT-01 修订）

> 适用任务：**GS-NEXT-01**（真实 PICO Neo3 WebXR 验收准备）
> 修订基线：`7000a8a`（以执行时最新 `main` 为准）
> 本文是**唯一**真机操作指南的迭代版本，不另立第二套。

## 目的与安全边界

这是一组可重复的 PICO Neo3 `immersive-vr` 对照，**不是**桌面浏览器性能测试。

**安全**：不要在楼梯、道路、设备边缘或狭窄空间快速移动；不要启用 Walk/碰撞；摇杆移动与转向仅做正常小幅操作。若出现明显卡死或设备过热，**立即停止该组测试并退出 XR**。

**数据**：历史 13M 场景只做**只读**压力测试；不重转、不覆盖、不清理、不发布。测试不会上传任何诊断 JSON 到服务器。

---

## 0. 入口

- 启动时先运行：

  ```bash
  ./scripts/gsplatform-vr.sh status
  ./scripts/gsplatform-vr.sh urls
  ```

  确认 api / web / proxy / publish / cpu / gpu / maintenance / tunnel 均为 MANAGED，且 HTTPS 可打开。

- 本机当前 HTTPS 入口（**临时 Quick Tunnel，启动脚本输出为准**）：

  `https://argue-algorithm-agency-complications.trycloudflare.com`

- 若启动脚本换了 hostname，用 `./scripts/gsplatform-vr.sh urls` 的最新地址替换下方 URL。
  **不要把旧地址缓存为正式域名。**

| 用途 | URL |
| --- | --- |
| 小场景（A/C/E 基础） | `<HTTPS>/xr/u-a68b94d84538` |
| 小场景 + 诊断（推荐起点） | `<HTTPS>/xr/u-a68b94d84538?diagnostics=1` |
| 历史 13M 大场景（D 组） | `<HTTPS>/xr/u-06924576399e?diagnostics=1` |
| 工程自测页 | `<HTTPS>/xr/test` |
| Owner 创作页（B 组保存视角） | `<HTTPS>/model/edit/u-06924576399e` |

> **入口稳定性声明**：Quick Tunnel 是临时 hostname，**没有生产 SLA**，并发 chunk 请求也可能受影响。
> 它**只能**用于临时验收，**不得**标记为稳定生产入口。稳定 HTTPS 方案见文末。

---

## 测试前

1. 在电脑运行 `status` / `urls`，确认是隔离测试环境且 HTTPS 可打开。
2. PICO Browser 用普通窗口打开场景 URL；允许页面加载完成后再进入 WebXR。
3. **诊断面板只在进入 XR 前 / 退出 XR 后可操作**——沉浸视野内不显示 HTML 面板（GSPlatform 未请求 `dom-overlay`，这是设计而非缺陷）。
4. 导出文件名形如 `gsplatform-xr-diagnostics-<timestamp>.json`。**加载失败也要导出**，失败事件与 `unavailable` 字段同样有价值。
5. 不要发送包含 Cookie、分享 token 或敏感查询参数的 URL；导出前确认 JSON 无这些字段。

---

## 五组验收（逐组执行，逐组留证）

每组都要记录：**可用 URL、操作步骤、预期 UI 状态、JSON 导出方式、PASS/FAIL 判据**。

### A — 小场景基础验证

**URL**：`<HTTPS>/xr/u-a68b94d84538?diagnostics=1`

**步骤**

1. PICO 浏览器打开 URL，等待加载完成。
2. 进入前先点「开始新记录」（若要保留冷加载耗时，直接用刷新后的自动记录）。
3. 点击 **Enter VR**，进入 immersive-vr。
4. 头部转动并小幅前后移动，确认 6DoF。
5. 左摇杆前后左右移动；右摇杆左右转向。
6. 用系统菜单退出 XR → 回到网页 → 再次进入。**重复至少 3 次**。

**预期 UI 状态**

- 进入前：`ready`，显示 Enter VR。
- 沉浸中：双目立体，画面稳定，控制手柄可见（官方 `XrControllers`）。
- 退出后：`xr-ended`，显示「已退出 VR —— 可重新进入」。

**导出**：退出 XR 后点「停止」→「下载诊断 JSON」，标记 `A_basic`。

**PASS 判据**

- 成功进入 immersive-vr，**双目**显示正确。
- 6DoF 正常：转动头部画面跟随、无画面撕裂或冻结。
- 左摇杆前后左右方向符合预期；右摇杆一次触发一次转向（`turnMode='snap'`，官方默认 45°）。
- 至少 3 次退出/重入无持续黑屏、无不可恢复崩溃、无输入卡死。
- `runtime.xr.active=true`、`referenceSpace='local-floor'`、`renderedGaussians>0`。

**FAIL 判据**：无法进入 immersive-vr；单目或画面错位；头部追踪丢失；摇杆无响应；任一次重入黑屏不恢复。

---

### B — 初始视角

**URL**：创作页 `<HTTPS>/model/edit/u-06924576399e` → 保存后回到 `<HTTPS>/xr/u-06924576399e?diagnostics=1`

**步骤**

1. 在电脑登录该场景 Owner，打开创作页。
2. 把相机移动到**安全、能观察主体**的位置和方向。
3. 点击「保存当前视角」，等待成功提示。
4. 刷新 `/xr/u-06924576399e?diagnostics=1`，确认 Desktop 构图 = 刚保存的视角。
5. 进入 VR（先「开始新记录」再进入）。
6. 核对实际落点、**水平朝向**，并确认头部俯仰/roll 仍由真实头显驱动。

**预期 UI 状态**：Desktop 点击 Reset / 刷新后应回到 authored 构图，不被 `frameScene()` 覆盖。

**导出**：标记 `B_authored_spawn`。

**PASS 判据**

- Desktop：`resetCamera()` 后相机 = 保存值（位置/FOV）。
- PICO：出生点接近保存位置，**水平朝向**与保存的 target 方向一致。
- 头部俯仰/roll 自由，未被保存的相机倾斜强制覆盖。
- `runtime.xr.spawnStatus` 为 `applied`（已应用一次性 Rig 对齐）。

**FAIL 判据**：出生点远离保存位置；朝向错误；头部姿态被锁死；`spawnStatus` 长期停留在 `pending`。

> ⚠️ **已知边界**：官方 `xr.start` 在进入 XR 时把 Rig 的 Y 强制为 `0`（`parent.setPosition(x, 0, z)`），
> 之后由头显首个 tracked pose 驱动相机。**因此"进入 XR 前桌面相机正确"不能证明头显出生点正确**，
> 必须用本组真机核对。历史 13M 场景当前 `initialCamera` 仍为 `null`，本组开始前必须由 Owner 实际保存。
> **Agent 不得自行猜测或伪造默认出生点。**

---

### C — 性能模式

**URL**：`<HTTPS>/xr/u-a68b94d84538?diagnostics=1`（同一场景、尽量相同视角）

**步骤**

1. 进入前把面板切到 **性能 OFF**，开始新记录，进入 XR，在任何距离观察 30–60 秒，退出并导出 `C_OFF`。
2. 重新打开同一场景，切 **性能 ON**，保持相同或尽量相同的视线距离，重复相同观察时长，导出 `C_ON`。
3. 记录两组的时间间隔、Gaussian 数量、加载耗时与**视觉差异**。

**预期 UI 状态**：面板显示 `Performance Mode: ON/OFF`；切换仅本次 Runtime 生效并保留官方原偏好。

**PASS 判据**

- ON/OFF 均可切换并生效。
- 记录到 ON/OFF 各自的帧时间 P50/P95 与 `renderedGaussians`。
- 得出**基于真机数据**的结论（是否改善、视觉代价），而非桌面推测。

**FAIL 判据**：无法切换；切换后崩溃；用桌面数字冒充 PICO 收益。

> ⚠️ **不要把桌面 SwiftShader 的帧间隔当作 PICO GPU 性能。** 诊断中的 FPS estimate 只是 `XRSession.requestAnimationFrame` 的 JS 时间间隔。

---

### D — 大场景流式加载

**URL**：`<HTTPS>/xr/u-06924576399e?diagnostics=1`（**只读**压力测试）

**步骤**

1. 进入前开始新记录，进入 XR。
2. 从**远距离**观察主体，等待首个 Gaussian 可见。
3. 缓慢靠近主体，观察新细节出现时的表现。
4. 保持静止，观察 30 秒以上。
5. **若明显卡死或设备过热，立即停止本组并退出 XR。**
6. 退出后导出，标记 `D_streamed`。

**预期 UI 状态**：加载中 `loading` + 进度百分比 → 逐步渲染；`runtime.renderedGaussians` 随 LOD 激活上升。

**PASS 判据**

- 分块动态加载，**不一次性绘制全部源 Gaussian**。
- 记录 `lodCounts`（预期 `[13090324, 3927097, 1309032]`）、`chunkResourceRequests`、`observedTransferBytes`、`stallsOver1000Ms`。
- 三类卡顿分别给出**真机**判定：加载卡顿 / 靠近瞬时卡顿 / 静止持续卡顿。

**FAIL 判据**：持续黑屏不恢复；设备过热；长时间不可恢复卡死。

> ⚠️ 本组**只读**。**禁止**在本任务重转、清理、覆盖或发布完整 13M Gaussian 资产。

---

### E — 会话恢复

**URL**：同 A 组

**步骤**

1. 进入 XR，移动一段距离并转动视角。
2. 用系统菜单退出 XR，回到网页。
3. 确认桌面相机恢复、页面为 `xr-ended`。
4. 再次进入 XR。
5. 检查相机位置、控制器、头部追踪与资源缓存。

**预期 UI 状态**：退出 → `xr-ended`；重入 → `xr-active`，可再次进入。

**导出**：标记 `E_reentry`。

**PASS 判据**

- 退出后桌面相机恢复到进入前状态（官方恢复逻辑）。
- 重入后 6DoF、摇杆、控制器均正常，无残留输入状态。
- 诊断 JSON 中 XR 事件的 request/session-start/enter/end 序列完整。

**FAIL 判据**：退出后相机错位；重入后摇杆持续漂移或输入卡死；监听/资源泄漏导致重入失败。

---

## 每组必须回传的 JSON 字段

导出 JSON 后至少核对（字段已确认由 `RuntimePerformanceDiagnostics.ts` 实际导出）：

- `schemaVersion`、`assetVersion`、`lodCounts`、`browser`、`network`
- `timing.timeToFirstGaussianFrameObservedMs`、`timing.timeToLoadedMs`、`timing.timeToXRSessionStartMs`、`timing.xrEnterDurationMs`
- `samples[].frames` 中 `source='xr-session-callback'` 的 frame-time P50/P95、FPS estimate、stall 计数
- `runtime.renderedGaussians`、`runtime.renderer`、`runtime.performanceMode`
- `resourceSummary.completedRequests`、`chunkResourceRequests`、`observedTransferBytes`、`stallsOver1000Ms`、`observedHttpErrors`
- `runtime.xr` 的 `active` / `referenceSpace` / `spawnStatus` / `rigPosition` / `headLocalPosition` / `headWorldPosition`

**PICO 不提供或浏览器不暴露的字段必须保持 `unavailable`，不允许补填桌面数字。** 已知恒为 `unavailable`：`gpuMemoryBytes`、`inFlightRequests`、`decodeMs`、`textureUploadMs`。

---

## 结果记录模板

```text
组合：A/B/C/D/E
设备：PICO Neo3
浏览器 UA：见 JSON
网络：Quick Tunnel / Stable Tunnel / Local HTTPS
Performance Mode：ON/OFF
距离：远/近（相对主体）
time_to_first_frame：
time_to_loaded：
xr_enter_duration：
xr frame P50/P95（source=xr-session-callback）：
FPS estimate：
rendered_gaussians：
chunk requests / bytes / stalls：
rig/head state（spawnStatus / rigPosition / headWorldPosition）：
加载卡顿：是/否/不确定
靠近瞬时卡顿：是/否/不确定
静止持续卡顿：是/否/不确定
初始位置：正确/偏远/不确定
6DoF：正常/异常/未观察
摇杆移动/转向：正常/异常/未观察
退出/重入次数与结果：
备注：
```

---

## 已知官方默认行为（真机必须观察的风险项）

以下来自固定版本 `@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4` 源码，
均**未经真机验证**，请在测试中特别观察并回传：

| # | 事项 | 源码事实 | 需观察什么 |
| --- | --- | --- | --- |
| R1 | **地面传送默认开启** | `XrNavigation.enableTeleport=true`、`maxTeleportDistance=10`、`groundHeight=0` | 在**未标定米制**的 Gaussian 场景中，触发官方传送会把用户送到 **Y=0 平面**，该平面**未必**与场景地面重合。观察传送后是否落到主体附近还是"掉到场景外"。若体验不可接受，是否需要在官方脚本配置层关闭该路径由硬件证据决定 |
| R2 | 摇杆轴映射 | 官方读 `gamepad.axes[2]/[3]`，要求 `axes.length>=4`，按 `handedness` 区分左右手 | PICO Neo3 手柄是否提供 `axes.length>=4`；左右手判定是否正确；前进/后退/横移方向是否符合直觉 |
| R3 | Snap Turn 角度 | `turnMode='snap'`、`rotateSpeed=45`、`rotateThreshold=0.5`、`rotateResetThreshold=0.25` | 一次触发是否恰好转一次、无连转；45° 是否舒适 |
| R4 | 参考空间 | 官方 `xr.start(..., 'local-floor', ...)` | PICO 是否正确进入 local-floor；出生高度是否合理 |
| R5 | 移动速度/死区 | `movementSpeed=1.5`、`movementThreshold=0.1` | 移动速度是否过快/过慢；死区是否有残余漂移 |

**R1 是本次真机验收中最需要判定的行为**，因为它可能在用户第一次按扳机时就造成困惑。
本任务**不**在没有硬件证据的情况下擅自修改官方默认行为；如确需调整，应在取得证据后单独评审。

---

## 临时入口限制与稳定 HTTPS 配置方案（未自动执行）

Quick Tunnel 不是稳定域名，没有生产 SLA；并发 chunk 请求还可能受临时入口影响。若 A/B 需要排除网络瓶颈，应使用稳定 HTTPS tunnel 或受控本地 HTTPS，而不是关闭 TLS、改正式 DNS 或把 Quick Tunnel 失败归因于 PICO GPU。

1. **已有 Cloudflare Named Tunnel**：由域名管理员为专用测试 hostname 配置 tunnel ingress `service: http://127.0.0.1:5174`；保持浏览器端 HTTPS、Secure cookies；按官方文档用管理员已有 tunnel credentials 运行。凭据留在服务器，不写 Git；需要 DNS 的步骤必须管理员确认，**不自动改正式域名**。连接 QUIC 不稳定时可选官方 `--protocol http2`。
2. **受控 Local HTTPS**：由运维用头显信任的证书在专用 LAN hostname 反代 `127.0.0.1:5174`，PICO 与主机在同一网络；保持同源 `/api` 与 private asset 鉴权。自签名且未被头显信任的证书**不能**用来签署 WebXR 验收，不以 HTTP 绕过 secure-context。
3. 软件 JSON 自动将 `.trycloudflare.com` 标为 `Quick Tunnel`；其他 HTTPS 入口无法仅凭 hostname 判断 tunnel 类型，标为 `unavailable/unknown`。测试者必须随反馈注明 `Stable Tunnel` 或 `Local HTTPS`、Wi-Fi/有线回源和缓存冷/热情况，**不发送密钥**。

官方配置资料：[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)、[cloudflared run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)。

---

## 不在本轮做

不自动清除底部点、不重转 13M、不修改历史 SOG/PLY、不创建 VRSpawnPoint 表、不启用 Walk/真实碰撞、不实现传送导航、不提前开发预设导览点或 VR 菜单。

把 JSON 和观察反馈交回后，再决定后续是清理实验、稳定 LOD 新版本，还是仅保留当前资产。
