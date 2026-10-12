# VR-01C — PICO Neo3 真机测试指南

## 目的与安全边界

这是一组可重复的 PICO Neo3 `immersive-vr` 对照，不是桌面浏览器性能测试。不要在楼梯、道路、设备边缘或狭窄空间快速移动；不要启用 Walk/碰撞；摇杆移动和转向仅按正常小幅操作验证。历史 13M 场景不被重新转换，测试不会上传诊断 JSON。

## 入口

- HTTPS 基础入口（临时 Quick Tunnel，启动脚本输出为准）：`https://argue-algorithm-agency-complications.trycloudflare.com`
- 小模型：`https://argue-algorithm-agency-complications.trycloudflare.com/xr/u-a68b94d84538?diagnostics=1`
- 历史大模型：`https://argue-algorithm-agency-complications.trycloudflare.com/xr/u-06924576399e?diagnostics=1`
- 正式无诊断场景：`https://argue-algorithm-agency-complications.trycloudflare.com/xr/u-06924576399e`
- Owner 创作页：`https://argue-algorithm-agency-complications.trycloudflare.com/model/edit/u-06924576399e`
- 若启动脚本换了 hostname，使用 `./scripts/gsplatform-vr.sh urls` 的最新 HTTPS 地址替换以上 URL；不要把旧地址缓存为正式域名。

## 测试前

1. 在电脑运行 `./scripts/gsplatform-vr.sh status` 与 `./scripts/gsplatform-vr.sh urls`，确认 API/web/proxy/tunnel 均为隔离测试环境且 HTTPS 可打开。
2. PICO Browser 使用普通窗口先打开场景 URL；允许页面加载完成后再进入 WebXR。诊断面板只在进入前/退出后可操作。
3. 下载文件名为 `gsplatform-xr-diagnostics-<timestamp>.json`。若加载失败，仍点击导出；失败事件和 `unavailable` 字段也有价值。
4. 不发送包含 Cookie、分享 token 或带敏感查询参数的 URL；导出前检查 JSON 没有这些字段。

## A/B 操作

对历史大场景执行以下组合，每次记录观察距离、是否静止、是否靠近后才出现卡顿：

### A — 远距离 / Performance Mode ON

- 进入 URL，等待首个 Gaussian 可见。
- 面板选择 `性能 ON`，开始新记录，退出面板视野范围前不要进入 XR。
- 从远距离观察约 30–60 秒，再按一次正常移动。
- 用系统菜单退出 XR，点击停止/下载，标记此文件为 `A_far_ON`；若要保留加载耗时，从刷新后的自动记录开始，不要重新开始记录来代替冷加载。

### B — 近距离 / Performance Mode ON

- 在同一会话或重新进入后靠近主体；不要快速穿过模型。
- 记录是否在新细节出现时卡顿、是否随后稳定。
- 退出 XR 后导出 JSON。
- 如果同一记录包含 A→B，手工记录开始靠近的大致秒数；否则导出为 `B_near_ON`。

### C — 相同位置 / Performance Mode OFF

- 重新打开同一场景，保存相同或尽量相同的视线距离。
- 进入前选择 `性能 OFF`，重复 B 的观察时间。
- 不要把“细节更多”单独当成性能改善；同时记录 rendered Gaussian、XR frame interval、chunk requests。
- C 必须与 B 的相机和距离一致；建议在同一网页先退出到桌面、切 OFF、开始新记录再进入，从而利用官方恢复的桌面 pose。每次输出 `C_near_OFF`，记录热缓存差异；若重载后位置改变，应先保存/恢复相同初始视角，不能称作严格配对。

### D — authored 起点

- 在电脑登录场景 Owner，打开 `/model/edit/<sceneId>`。
- 移动到安全、可观察主体的位置和方向，点击 `保存当前视角`，等待成功提示。
- 刷新正式 `/xr/<sceneId>?diagnostics=1`，先记录再进入 VR。
- 观察是否在保存位置附近；不要以 Bounds 中心或神秘坐标作为替代。
- 该历史大场景本轮开始时没有 authored 初始相机，本轮不替 Owner 选择位置。保存只改变 presentation，不改变 Gaussian 版本。朝向验收重点是水平方向；头部俯仰/roll 保持真实 6DoF，不被保存相机强制覆盖。

### E — 退出/重入

- 从系统菜单退出 XR，等页面回到可操作状态后再次进入。
- 记录退出后桌面相机是否恢复、第二次进入是否仍在 authored 起点、头部旋转是否自由。

## 必须回传

每个组合尽量提供一份 JSON，至少包括：

- `sceneId`、`assetVersion`、`lodCounts`、`browser`、`network`。
- `timing.timeToFirstGaussianFrameObservedMs`、`timeToLoadedMs`、`timeToXRSessionStartMs`、`xrEnterDurationMs`。
- `samples[].frames` 中 `xr-session-callback` 的 frame-time P50/P95、FPS estimate、stall count；若为 `unavailable` 原样保留。
- `runtime.renderedGaussians`、`resourceSummary.completedRequests`、`chunkResourceRequests`、字节、慢资源和错误。
- `runtime.xr` 的 `active/referenceSpace/spawnStatus/rigPosition/headLocalPosition/headWorldPosition`。
- 实际距离（远/近）、ON/OFF、是否加载时卡、靠近瞬时卡、静止持续卡。

诊断中的 FPS estimate 只表示 `XRSession.requestAnimationFrame` 或普通 window RAF 的 JS 时间间隔；网页没有 GPU timer 时不要称其为真实 GPU FPS。

## 结果记录模板

```text
组合：A/B/C/D/E
设备：PICO Neo3
浏览器 UA：见 JSON
网络：Quick Tunnel / Stable Tunnel / Local HTTPS
Performance Mode：ON/OFF
距离：远/近（描述相对主体）
time_to_first_frame：
time_to_loaded：
xr_enter_duration：
xr frame P50/P95：
FPS estimate：
rendered_gaussians：
chunk requests / bytes / stalls：
rig/head state：
加载卡顿：是/否/不确定
靠近瞬时卡顿：是/否/不确定
静止持续卡顿：是/否/不确定
初始位置：正确/偏远/不确定
6DoF：正常/异常/未观察
摇杆移动/转向：正常/异常/未观察
备注：
```

## 临时入口限制

Quick Tunnel 不是稳定域名，没有生产 SLA；并发 chunk 请求还可能受临时入口影响。若 A/B 需要排除网络瓶颈，应使用稳定 HTTPS tunnel 或受控本地 HTTPS，而不是关闭 TLS、改正式 DNS 或把 Quick Tunnel 失败归因于 PICO GPU。

### 稳定 HTTPS 配置方案（未自动执行）

1. **已有 Cloudflare Named Tunnel：** 由域名管理员为专用测试 hostname 配置 tunnel ingress `service: http://127.0.0.1:5174`；保持浏览器端 HTTPS、Secure cookies；按官方文档用管理员已有 tunnel credentials 运行。凭据留在服务器，不写 Git；需要 DNS 的步骤必须管理员确认，不自动改正式域名。连接 QUIC 不稳定时可选官方 `--protocol http2`。
2. **受控 Local HTTPS：** 由运维用头显信任的证书在专用 LAN hostname 反代 `127.0.0.1:5174`，PICO 与主机在同一网络；保持同源 `/api` 与 private asset 鉴权。自签名未被头显信任的证书不能用来签署 WebXR验收，不以 HTTP 绕过 secure-context。
3. 软件 JSON 自动将 `.trycloudflare.com` 标为 `Quick Tunnel`；其他 HTTPS 入口无法仅凭 hostname 判断 tunnel 类型，标为 unavailable/unknown。测试者必须随反馈注明 `Stable Tunnel` 或 `Local HTTPS`、Wi-Fi/有线回源和缓存冷/热情况，不发送密钥。

本轮 `scripts/gsplatform-vr.sh` 仅新增可选 `GS_VR00_TUNNEL_PROTOCOL` 参数，默认 `auto`；隔离私有环境选择 `http2`。不降低 HTTPS。

官方配置资料：[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)、[cloudflared run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)。

## 不在本轮做

不自动清除底部点、不重转 13M、不修改历史 SOG/PLY、不创建 VRSpawnPoint 表、不启用 Walk/真实碰撞、不实现传送导航。把 JSON 和观察反馈交回后，再决定 VR-01D 是过滤实验、稳定 LOD 新版本，还是仅保留当前资产。
