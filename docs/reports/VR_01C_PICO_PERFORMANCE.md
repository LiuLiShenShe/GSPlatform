# VR-01C — PICO Neo3 大场景 WebXR 性能诊断与初始位置

**日期：** 2026-10-12

**范围：** 只读验证历史 13M Streamed SOG；接入官方 Viewer 1.35.0 Performance Mode；增加有界本地诊断 JSON；修复 authored initial camera 的 XR 首帧起点路径。**不删除 Gaussian、不重转历史资产、不改官方 Viewer。**

## 1. Starting HEAD 与工作边界

- Starting HEAD：`b63205b885d275c80e0646aa6a9931f25fca20a0`；`origin/main` 在本轮开始时相同。
- 运行环境：隔离 `gsplatform_vr00_20261011`，独立数据库、Storage、Redis broker；队列核验为空后才重启隔离服务。
- 用户已有 89 个 tracked 文档删除和未跟踪文件均未恢复、未清理、未加入本轮变更。
- 本轮没有 `git reset --hard`、`git clean -fd`、force push、生产 DNS 修改或生产数据库写入。

## 2. 固定版本官方能力核验

本轮以固定依赖与 pinned source 为准：

- `@playcanvas/supersplat-viewer` `1.35.0`。
- `playcanvas` `2.22.4`。
- `@playcanvas/splat-transform` `3.3.3`。
- 公开可用能力已核对：`viewer.state.performanceMode` 可读写；`frameScene()`、`resetCamera()`、`startXR('vr')`、`endXR()`；`viewer.app`、`viewer.events`。
- 官方 Viewer 的 Performance Mode 预算是平台参考策略：移动端约 `1M` ON、`2M` OFF；非移动端约 `2M` ON、`4M` OFF。它不是 PICO Neo3 的实测承载保证。
- 固定 Viewer 的 Performance Mode 改变官方 state，并由官方偏好逻辑写入 origin localStorage。XR 页面 A/B 使用薄封装的 `{ persist: false }`，切换后恢复用户原有 `performanceMode` 偏好，不新建 Viewer。
- 官方源码在非 XR resize 路径会将 ON 的 canvas 分辨率缩放为约 `0.5`；XR 激活时由 Engine/XR framebuffer 接管，诊断不把这个桌面行为冒充为 PICO 的实际 GPU 分辨率收益。
- 官方 CameraManager 即使没有显式 anim track 也会为默认体验生成 orbit/figure-8 动画。`cameras[0].initial` 决定起始姿态，但并不自动禁止随后的动画。真实小 SOG 的 authored 位置测试先捕获了自动漂移，随后通过 loaded 时一次官方 `resetCamera()` 恢复 authored 初始姿态并转入 orbit，验证了 root cause；没有修改官方 CameraManager。
- 未实现自定义每帧 Gaussian 选择器、私有 LOD 访问、分辨率算法或渲染器 fork。

官方资料：

- [SuperSplat Viewer 1.35.0 API](https://github.com/playcanvas/supersplat-viewer/blob/v1.35.0/docs/api.md)
- [SuperSplat Streaming](https://developer.playcanvas.com/user-manual/supersplat/streaming/)
- [SuperSplat Cameras](https://developer.playcanvas.com/user-manual/supersplat/studio/cameras/)
- [Experience Settings](https://developer.playcanvas.com/user-manual/supersplat/studio/experience-settings/)
- [Viewer Embedding](https://developer.playcanvas.com/user-manual/supersplat/viewer/embedding/)
- [PlayCanvas WebXR](https://developer.playcanvas.com/user-manual/xr/using-webxr/)
- [splat-transform v3.3.3](https://github.com/playcanvas/splat-transform/tree/v3.3.3)

## 3. 历史大场景资产

- Scene：`u-06924576399e`。
- SceneVersion：`01c63c7c-8eb5-498e-bcc0-77215e92ca12`。
- AssetVersion：`da7bf4207044`。
- Source：`13,090,324` Gaussian；只读源 PLY `3,246,401,885` bytes；SHA-256 `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764`。
- Format：`streamed-sog`，Recipe v2，`splat-transform 3.3.3`，balanced，LOD ratio `100%/30%/10%`，chunk target `64`，extent `32`，WebGPU conversion backend。
- LOD counts：`13,090,324 / 3,927,097 / 1,309,032`。
- `lod-meta.json`：`1,758,379` bytes；其中列出 `259` 个 chunk；发布目录总文件 `2,076`，chunk 资源（含 chunk meta）约 `843,890,595` bytes。
- 已通过 published-version validation；当前 `PUBLISH/SUCCEEDED` 历史记录为 `7`，本轮未启动 Publish Job。
- 发布目录 2,076 个文件逐项 SHA-256 与 VR-01B 保存的 before map 完全一致；SceneVersion、AssetVersion、源 SHA 不变。

控制组：`u-a68b94d84538`，AssetVersion `21c371259407`，普通 SOG `1,788` Gaussian。

## 4. 性能诊断实现

调试入口仅在开发构建或 `VITE_XR_PERFORMANCE_DIAGNOSTICS=true` 且 URL 含 `?diagnostics=1` 时启用：

`/xr/<sceneId>?diagnostics=1`

实现位置：`apps/web/src/scene-runtime/RuntimePerformanceDiagnostics.ts`、`apps/web/src/features/viewer-official/XRPerformancePanel.tsx`。

- 自动开始加载记录；面板可开始新记录、停止、切换官方 Performance Mode ON/OFF、退出 XR 后下载 JSON。
- 面板在 immersive XR 激活时隐藏；用户应从系统菜单退出后操作下载，不依赖沉浸视野内不可触达的 HTML 按钮。
- 记录上限：5 分钟、301 个每秒样本、128 个事件、2,048 个资源记录、每个 frame source 240 个帧间隔；超限计入 dropped，不无限增长。
- 记录字段：Scene/Asset/LOD、renderer、脱敏 UA、network entry、XR mode、Performance Mode、Engine Gaussian count、相机/rig/世界变换、首次 Gaussian 帧、loaded、XR request/session-start/enter/end、资源请求/字节/HTTP status/慢资源、每秒 frame time P50/P95、stall、JS frameupdate→frameend elapsed。
- `gpuFPS`、GPU time、CPU submission、decode time、texture upload、in-flight 请求、GPU memory 在浏览器没有可信公开值时均写 `unavailable`。
- `app.stats.frame.gsplats` 被标为 Engine 当前统计，不宣称唯一 Gaussian 数或双眼合计数；资源按同源已授权内容路径过滤，导出只含安全的路径 basename/chunk identity，不含 Cookie、JWT、Authorization、share token、完整 URL、数据库密钥。
- PerformanceObserver 是浏览器资源计时，不拦截 fetch，不上传服务器，不逐帧打 Console。
- 调试开销有界：每秒读取/聚合一次、每帧仅统计时间和有界数组，不开启 GPU profiler；为了读取 LOD counts，诊断额外最多请求一次已授权 `lod-meta.json`（15s timeout，内容限制 4MiB，优先浏览器 cache）。实际 96 秒 JSON 约 366KiB，不是常驻内存实测；每帧成本及 observer 开销没有独立 profiler 测量，不能填为零。

## 5. 真实软件诊断结果

证据来自 HTTPS Quick Tunnel + Chromium SwiftShader WebGL2，有界测试不是 PICO 结果：`apps/web/test-results/` 的 JSON 在测试结束前保存。以下 A/B 详细数字对应首次全通过 HTTPS 三项回归的 `https-large.json`；最终四项 HTTPS 回归 `final-bounded-large-diagnostics.json` 同样通过，有独立摘要，不混作同一次测量。

### 小模型

- 加载成功，`1,788` Gaussian，LOD `[1788]`，AssetVersion `21c371259407`。
- 官方 ON/OFF 可切换；ON/OFF 的 transient 诊断切换保留原 `localStorage performanceMode=false`。
- JSON 导出成功；GPU FPS 为 `unavailable`。

### 历史 13M

- Descriptor 200；LOD metadata 200；counts `[13090324,3927097,1309032]`；`259` chunk 名称通过校验。
- 本次 HTTPS Chromium 在 `/xr` 的非 immersive 桌面页面有界加载：`actualHeadset=false`，renderer `webgl2`，未超过 `256 MiB`/`1,200` requests/`145 s` route guard，abort `0`。这不是 PICO 双眼渲染；没有浏览器自动化无条件读完 843.9MB 资源。
- Diagnostics：hook boot → first Gaussian frame `2,006 ms`；`loaded=true` `75,228.9 ms`。该冷页面 document navigation → 首个 Engine Gaussian 观察约 `6,308.2 ms`、loaded 约 `79,531.1 ms`，包含此前 bundle/React 启动。JSON 同时标注 hook 与 navigation 时间来源；若 SPA 路由复用旧 document，navigation 数值不能代表本次路由打开。
- 资源计时：完成请求 `178`，其中 chunk resource requests `176`；observed transfer `69,874,310` bytes，decoded `72,832,862` bytes；HTTP error `0`；资源 >1s `4`；decode/upload 不可用。
- 最终 Engine `renderedGaussians=1,309,032`，renderer `webgl2`；全场景 Bounds（runtime，默认 W）`min[-364.7285,-546.4846,-302.999]`、`max[591.4539,53.25668,795.8012]`。
- 该浏览器控制台的 1 秒 frame interval 是 `window-raf-estimate`，不是 GPU FPS。加载期间出现明显间隔长尾，并与 chunk 持续请求重叠；这支持“加载/激活压力”与网络/解码/上传/渲染共同相关，但不能将长尾单独归因 GPU。
- 加载前 75 秒内观察 `561` 个有效 window RAF 回调间隔，其中 `190` 个 >50ms；1 秒窗口 P95 的最大值约 `799.9ms`。这些是回调间隔的长尾，不能当作 Gaussian draw 的 GPU 时间。
- 在该次桌面序列的最终稳定窗口，ON 约 `480×360`、OFF 约 `960×720`；这证明官方桌面分支的 canvas 行为，不证明 XR framebuffer 收益。ON/OFF 在本次桌面采样均落在约 `1.309M` 当前 Engine count；没有 PICO 实测，不能宣称 Performance Mode 已改善近景帧率。
- 完成资源计时的 chunk meta 来自 `22` 个不同 chunk（不是 176 个 chunk）；`chunkResourceRequests` 含每个 chunk 的 meta/WebP。Playwright 独立网络 guard 的 `179` requests / `63,117,664` bytes 仅是 response Content-Length 累加，与 ResourceTiming transfer/decompressed/body/cached 语义不同，不相互替代。
- 同一稳定 camera 的样本：ON t=90/91/92s 与 OFF t=95/96s 的 1 秒 P50/P95 均约 `16.7ms`（FPS median estimate ~59.88）；JS frameupdate→frameend 的 sample median 约 `0.3ms`。普通 on-demand 桌面 RAF 可包含 idle tick，因此此数字不能证明实际持续绘制 60FPS，也不能作为 ON/OFF 性能改善幅度。
- 最终 HTTPS 四项回归（2026-10-12 18:39 起）：13M first Engine Gaussian observation `2,709.9ms` / loaded `74,046.3ms`（hook）；document-nav 来源 `7,194.8ms` / `78,531.2ms`；178 completed/176 chunk resource requests，transfer `69,970,772` / decoded `72,929,476` bytes，HTTP errors `0`，慢资源 `14`；179 guard requests、Content-Length 合计 `61,766,480` bytes，abort `0`；Engine final `1,309,032`。较前次慢资源增加说明临时入口时延会波动，不可据此推算 PICO GPU 改善。
- 四项回归的 authored 软件 fixture 使用真实小 SOG + 截获的 Descriptor（不修改 staging DB）：Scene eye `[1,2,3]`，W translation `[3,4,5]`/yaw90/scale2，最终官方 Viewer camera `[9,8,3]`、fov60、mode `orbit`；该测试标注 `descriptorFixture=true/actualHeadset=false`。真实 API 保存另外由 Backend owner/session/CSRF 回归验证，两者不能合并宣称 PICO 生效。
- 交付版新增 `timeToXRSessionStartMs` 的最后一轮 HTTPS 四项回归（18:54 起，`delivery-bounded-large-diagnostics.json`）：first Gaussian `2,113.3ms` / loaded `79,042.9ms`（hook）；document-nav `6,305ms` / `83,234.6ms`；178 completed /176 chunk resource requests；transfer `69,874,270` / decoded `72,832,862` bytes，HTTP errors0，>1s resources3；guard179 req/`63,304,672` bytes/abort0；最终 Engine count1,309,032。session start/enter 均 `unavailable`，因为没有真实 headset，而非伪造 0ms。
- **额外常规 `/scene` 探针：未签署加载 PASS。** 同机 Local HTTP（软件 only）、同样有界资源、Performance ON，在 `100s` wait limit 内从 first Gaussian 增至 Engine `663,544`，98 req / `28,320,007` response Content-Length bytes，abort0，但 `loaded=false`，camera仍默认 `[0,2,0]` / mode `anim`。该 probe 的 JSON 明确 `timedOut=true`；前两个无最终 JSON 的尝试也超时，未掩盖。这个未 authored 的普通桌面加载限时结果与 `/xr` 79 秒完成不能合并冒充一次测试，更不能归咎于 PICO GPU。当前 `/xr` 软件门禁通过不代表所有 Desktop 打开方式都在 100s 内就绪；后续需要在正常 GPU/稳定 HTTPS 与 Owner authored camera 下量化，不为完成 gate 无限读取全资产。

### 三类卡顿判断

1. **加载卡顿：证据明确。** 13M 历史 v2 不是即时首屏；资源请求、持续 LOD 激活与长 frame interval 同时出现。`loaded` 不能等同 first visible Gaussian。
2. **靠近模型瞬时卡顿：软件证据部分支持。** 运行中请求/激活 chunk、Gaussian count 从低 LOD 逐步上升至 `1,309,032`；需要 PICO 走远/近 A/B 才能确认头显体验中的对应峰值。
3. **静止持续卡顿：尚未证明。** 桌面 SwiftShader 不能代表 PICO 双目 GPU；必须依靠 PICO XR-session callback 样本、真实浏览器与 headset 观察。

因此本轮结论是：当前能量化的首要问题是大场景加载/LOD 激活长尾；PICO 近景持续卡顿与 ON/OFF 收益仍是 hardware pending，不能只归因网络。

## 6. 初始相机与 XR 起点

### 原因

历史大场景当前 descriptor 的 `initialCamera.position/target/fov` 全为 `null`，worldTransform 三项为 `null`（运行时 identity），没有 views/annotations/collision。按固定策略：无 authored camera → loaded 后 `frameScene()`；因此旧资产没有可恢复的作者出生点，自动 frame 的相机可能远离实际主体。

官方 Viewer 1.35.0 的 XR 路径使用 `local-floor`，进入 start 时会把桌面相机的 X/Z 和 yaw 写到 XR parent，但官方固定源码将 parent Y 设为 `0`，之后由头显首个 tracked pose 驱动 camera。因此仅读取进入 XR 前桌面相机不能证明 head pose 已正确对齐。

### 修复

- 继续复用 `SceneAuthoringPage.tsx` 的 `getCurrentPose()`、`setInitialView()`；保存前执行 Runtime→Scene 坐标逆变换。
- `useSuperSplatXR` 只在 authored `initialCamera.position + target` 成对存在时传入 `xrInitialCamera`；无 authored 仍保持官方 `frameScene()` fallback。Desktop/XR/Authoring 在 loaded 时都只初始化一次：authored → 官方 `resetCamera()`（不 frame 全场景，停止默认起始动画）；无 authored → 官方 `frameScene()`。
- `SuperSplatRuntime.startVR()` 仍在用户手势调用官方 `startXR('vr')`；首个公开 `app.xr` `update` 且有 `immersive-vr` camera/rig 时，将 authored Scene pose 转换后的 runtime eye 对齐到 rig。只写一次：根据水平 target 计算 yaw，抵消首个头部 yaw；以 head local position 反推 rig position；不持续锁定头部，不覆盖头部 6DoF。XR end/destroy/失败会移除监听。
- 退出 XR 仍由官方 Viewer 恢复其缓存的桌面相机/parent；本层不改官方 controller、移动摇杆或转向输入。
- authored 的水平朝向通过 rig yaw 对齐；pitch/roll 始终来自真实 HMD，不把保存的相机倾斜强加到头部。不能将软件 Entity 数学测试当作头显 local-floor/重新居中行为的验证。
- 坐标约定：作者与 Descriptor 使用 Scene 空间；worldTransform `W` 将 Scene→Runtime；XR 起点只接收已转换的 Runtime pose；不改 worldScale、不启用 Walk、不把未标定单位宣称为米。

软件回归覆盖：无 authored fallback、有 authored 不 frame、保存 descriptor、W 下坐标、XR re-entry/end/destroy、相机 6DoF 保持、Performance Mode 不创建第二 Viewer、私有场景 owner/CSRF、原始版本不变。真实头部 6DoF、摇杆移动/转向与实际出生位置仍需 PICO 硬件确认。

## 7. Bounds 与废点只读评估

分析脚本只读 memmap 源 PLY，未生成输出 Gaussian 文件：`/home/test/.local/state/gsplatform-vr00-20261011/vr01c/bounds.json`。

- Source XYZ center bounds：X `[-573.6656,327.3454]`，Y `[-36.2014,539.3271]`，Z `[-275.3176,784.2795]`。
- Runtime full XYZ center bounds（官方 baked Z180、W identity）：X `[-327.3454,573.6656]`，Y `[-539.3271,36.2014]`，Z `[-275.3176,784.2795]`。这与 metadata 的 Gaussian-support bounds（包含尺度）不同；Scene 空间已经遵循 baked axes，`W(Scene)` 是之后的 runtime 变换，不再重复 Z180。
- 采样 `201,390` 点（stride 近似 percentile，不是完整稳健分位数）：P1–P99 约 X `[-117.9975,273.7660]`，Y `[-43.1097,-11.4026]`，Z `[-123.0152,435.7031]`。
- 低处代理统计：runtime Y<-50 为 `7,227`（`0.0552%`）；Y<-100 为 `1,952`（`0.0149%`）。这些点 tail sample 的 opacity/scale 分布偏高，但只有空间阈值代理，不能命名为废点、floater 或背景残留。
- Opacity 使用源 PLY logit 的 sigmoid；scale 使用源 log-scale 的 exp，再取最大轴。整体样本 opacity median `0.17043`、P95 `0.999926`；最大轴 scale median `0.3474`、P95 `1.4164`、P99 `2.1736`（未标定单位）。Y<-50 的 112 个样本 opacity median `0.7453`、最大轴 scale median `9.4644` / P95 `21.6685`；Y<-100 只有 19 个样本，统计置信度很低。较大低处 Gaussian 可能扩大投影/过绘制，但不能由这些数值算出 GPU 成本。
- 约 `99.756%` 点位于 runtime Y<-10、`77.421%` 位于 Y<-20；这说明不能把 Y=0 当作“底部废点”裁剪线。Gaussian 单位未标定，bounds 中心也不能直接成为合法出生点。
- 全量 Gaussian-weighted visual bounds、孤立 floater 分类、真实过绘制 GPU cost 均 `unavailable`；本轮不删除、不改 PLY/SOG、不改 Bounds。

### VR-01D 建议（未执行）

先备份原始版本与校验和，再用固定 `splat-transform 3.3.3` 的 `--stats json` 观察 fill/overdraw；候选只读实验可分别评估 `--filter-floaters`、`--filter-box`、`--filter-cluster --seed-pos` 或 SuperSplat Editor 手工裁剪。必须以主体可见性、opacity/scale、空间连通性和 PICO A/B 为准，不能直接套默认阈值；不得覆盖 `da7bf4207044`。

固定 3.3.3 CLI help 确认：`--filter-floaters [size,op,min]` 默认 `0.05,0.1,0.004`；`--filter-box <x,y,z,X,Y,Z>`；`--filter-cluster [res,op,min]` 默认 `1.0,0.999,0.1` 并支持 `--seed-pos`；floaters/cluster 属 GPU voxelization 路径。仅执行 help/version 与只读统计，**没有执行任何 filter**。Editor 手工裁剪属于官方编辑能力，不是 CLI flag。

## 8. 网络入口

本轮软件验证使用 `Quick Tunnel`，实际入口由启动脚本生成：

`https://argue-algorithm-agency-complications.trycloudflare.com`

已把隔离环境 transport 固定为 `http2` 以规避当前测试网络的 QUIC 不稳定；仍然是临时 hostname、非稳定生产域名。Quick Tunnel 仅作连通性/软件测试入口，不能作为 PICO 长时间性能结论。官方限制与建议见 [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) 和 [cloudflared run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)。

旧 Quick Tunnel `referral-tips-unlike-wants` 在本轮出现 HTTP 530/QUIC timeout，属于入口网络故障而不是 PICO GPU；确认无 active/reserved jobs 后仅重启隔离环境。现行 tunnel 官方 CLI 使用 `--protocol http2`，健康与匿名授权资源 200 已验证。Quick Tunnel 的 200 个 in-flight 限制不能从本次累计 179 个请求推断曾触发；本次没有证据证明触发该限制。稳定通道配置方案见操作指南。

## 9. 门禁与证据

- Backend `ruff check app tests`：PASS。
- Backend `mypy app`：PASS，94 files。
- Backend `pytest tests -q`：最终串行 `560 passed`，`921.25s`，EXIT=0。一次错误地将 checkout gate 与本机 gate 共用测试 DB 的并行运行触发既有 dev-upload 清理器，导致 concurrent-complete 用例缺失会话；中止临时测试进程后，该用例单独 PASS，完整串行 PASS。不修改业务代码掩盖该测试隔离错误。
- Workers `pytest workers/tests -q`：PASS，`153 passed`，`169.51s`，EXIT=0；测试包含仓库既有小资产 CLI/worker 回归，不是历史 13M 转换。
- Web typecheck/lint：PASS；Web Vitest 最终 `30 files / 283 tests PASS`；build PASS（现有 large chunk warning）。
- Playwright VR-01C：交付代码最后一次 HTTPS Quick Tunnel 有界测试 `4 passed (2.5m)`：small real SOG A/B；private denied/error export；authored/W real Viewer fixture；历史 13M real descriptor/assets WebGL2 A/B；均 `actualHeadset=false`。18:39 版本也为 `4 passed (2.4m)`；本机三项旧配置通过 `3 passed (2.0m)`；并行 browser runs 曾覆盖共用 test-results，故该次 local JSON未保存，不用它宣称网络差异。
- Clean checkout：交付源候选 `01d843231da80e587981e079769195750b5dc0ee` 按 `./deploy/scripts/verify_release_source.sh --from-commit <candidate> --with-web-build` **PASS / EXIT=0**。source archive/import closure、ruff、mypy94files、Backend552 passed/8 skipped、Workers120 passed/33 skipped、fresh reconstruction runtime（torch/gsplat pinned版本、trainer help、CUDA可用、8-splat真实 rasterization）、frozen Web install/build全部通过。fresh archive在 Web依赖安装前执行 Backend/Workers，因此部分可选节点/CLI/训练环境用例跳过；工作树独立完整运行则 Backend560/Workers153全部通过，不把 skipped 说成执行过。前一轮 `7153c9bd7f484eefa3101b4bf4c53c08ebdbe319` 同样 PASS。候选通过 temporary index + commit-tree 构造，没有 checkout/reset/branch，不修改用户 index/deletions；候选代码 blob 与 source/test HEAD `f95f5aa`完全一致，最终后续变更仅此证据文档。
- `GATE_EXIT=0`：正式适用软件门禁完成。额外 ordinary Desktop 限时 probe 为 `LIMIT REACHED`，不纳入功能 PASS、不隐藏；软件门禁通过不是大场景性能优化成功。

## 10. 待填写真机数据

PICO 导出 JSON 后填写：`browser.pico/android/browser`、`network`、`timing.timeToFirstGaussianFrameObservedMs`、`timeToLoadedMs`、`timeToXRSessionStartMs`、`xrEnterDurationMs`、`samples[].frames[source=xr-session-callback]` 的 P50/P95/FPS estimate/stall、`runtime.renderedGaussians`、`resourceSummary`、`runtime.xr` rig/head state、Performance Mode ON/OFF、观察距离和是否静止卡顿。

这些字段若 PICO 不提供或浏览器不暴露必须保留 `unavailable`，不能补填桌面数字。

## 11. 当前判定

- 软件实现目标：诊断模式、官方 Performance Mode A/B、历史资产只读验证、初始相机保存/坐标转换路径已实现。
- 软件性能结论：加载/LOD 激活有可测长尾；真实 PICO FPS、GPU time、双目稳定近景承载量未测。
- XR 起点结论：authored pose 的软件路径与回退策略已覆盖；真实 PICO local-floor 起点与首个 tracked eye 必须硬件复核。
- 已知软件测试限制：额外普通 Desktop `/scene` probe 达到加载时限，不能将其写为 PASS；本阶段不擅自修改 Viewer 的 first-frame/LOD 工作流来隐藏此结果。
- 依赖链未升级，官方 Viewer 未 fork，历史 Gaussian 资产未改变。
- **VR-01D ready for review only**：可据实测 JSON 决定清理或重建新 LOD，不在 VR-01C 自动执行。

**Final source/test HEAD：** `f95f5aab497b4538f2c7b8640dd16b71463c8ad4`。实现提交：`68bd108`（diagnostics）、`516dd36`（official controls/startup pose）、`f95f5aa`（bounded browser tests）。最后文档收据提交的 Final HEAD 由最终回复和 `git rev-parse HEAD` 提供；Git commit hash 不能在其本身文件中自我嵌入，本报告不伪造 self-referential hash。

## 12. D/G 验收矩阵

| 项目 | 软件证据与边界 | 状态 |
| --- | --- | --- |
| D01 无 authored fallback | initial-camera-policy + XR loaded/iframe-free 既有回归 | SOFTWARE PASS |
| D02 authored 不错误 frame | 真实小 SOG + transformed Descriptor fixture；官方 reset 初始姿态 | SOFTWARE PASS |
| D03 保存 Descriptor 返回 | 真实 API session/CSRF/owner regression，在独立测试 DB | SOFTWARE PASS |
| D04 Scene/Runtime 世界变换 | existing SceneTransformAdapter tests + W-transformed XR eye Entity math | SOFTWARE PASS |
| D05 XR 重入起点 | 两次 start/update/end 的监听和 rig math；真实 PICO location 未测 | SOFTWARE PASS / HARDWARE PENDING |
| D06 退出桌面相机 | 保留固定版本官方恢复代码，入口/end unit regression | SOFTWARE PATH VERIFIED / HARDWARE PENDING |
| D07 头部 6DoF | 一次定位后不再改 rig/head；Entity math 仅软件 | PICO HARDWARE PENDING |
| D08 摇杆移动/转向 | 无 upstream controller/navigation 改动 | PICO HARDWARE PENDING |
| D09 非 Owner/无 CSRF | PRIVATE scene/initial camera/asset authorization regression | SOFTWARE PASS |
| D10 历史资产 | 全 2,076 文件 SHA + SceneVersion/AssetVersion/source SHA | PASS |
| G01 Performance Mode | real Viewer ON/OFF + wrapper read/write | PASS |
| G02 不创建第二 Viewer | wrapper mock create count + real live switch | PASS |
| G03 无监听增长 | destroy/end/reentry/recorder cleanup 测试 | PASS |
| G04 XR 重进入口 | 页面 enter/end/retry tests，真实 HMD 路径未模拟 PASS | SOFTWARE PASS |
| G05 采样有界 | duration/samples/events/resources/frame cap regression | PASS |
| G06 导出无 Cookie/Token | secret resource URL filtering + browser JSON export assertions | PASS |
| G07 保存权限 | owner/session/CSRF regression | PASS |
| G08 相机变换 | adapter + authored real Viewer fixture + first-eye math | PASS |
| G09 Viewpoint/Annotation | 全量 Web 与 Backend 原有门禁 | PASS |
| G10 13M 版本不变 | 只读校验与 DB snapshot | PASS |
| G11 私有鉴权 | failed private route still 401；诊断 query 不提权 | PASS |
| G12 Collision 默认 | conversion/publish 策略未改，MANUAL_ONLY 原有门禁 | PASS |
| G13 WebGL2 XR | XR renderer 强制官方 WebGL，真实 browser WebGL2 | PASS |
| G14 官方未升级/fork | package/lock 无变更，只有薄适配 | PASS |

软件矩阵不等于 PICO 性能与出生点验收。fresh checkout 已有完成收据；物理头显验收仍 pending。

## 13. 七个性能判定问题

1. **卡顿主要发生在哪里？** 当前软件数据证实加载/LOD 激活长尾。PICO 靠近主体时“持续 vs 瞬时”未测，仍需真实 JSON。
2. **PICO 近景实际绘制数？** `unavailable`；桌面最后约 1,309,032 不可移植为 PICO 结论。
3. **ON 能改善多少？** PICO 改善百分比 `unavailable`；已验证开关/偏好/桌面分辨率路径，没有性能优化 PASS。
4. **Chunk 峰值？** 桌面窗口有累积请求阶跃和 4 个 >1s resource；对应 camera 接近的 XR 峰值尚未测。
5. **低帧率与网络相关？** 桌面加载有时间重叠，资源已停后仍可有帧长尾；相关不等于因果，decode/upload/GPU 分离数据 unavailable。
6. **初始位置是否经保存修复？** 保存权限/Descriptor/W/首 eye 软件路径已验证；历史大场景仍未由 Owner 保存实际安全相机，真实 PICO 验收 pending。
7. **是否应重建更多 LOD？** 旧 v2 最低 LOD 仍 1.309M，可能限制更低预算；现在没有 PICO A/B 证据支持立即重转。先收集数据，再决定新版本，不能覆盖原版本。

## 14. 权威核查与未执行项目

强制阅读的 services `apps/api/app/services/scene_presentation.py` 不存在；真实实现是 `app/services/authoring.py` 与 `app/api/v1/scene_presentation.py`，已检查，未创建同名替代文件。必读的 Runtime/Adapter/InitialCamera/XR/三页面/API schema/runtime/conversion policy/convert 与四份基线文档已审查。

Context7 Viewer 文档返回新版 foveation/standalone 说明时没有用于 1.35.0；以固定 source map 与 API 声明复核。Bocha 检索服务本轮 403，未拿其搜索摘要当事实；官方文档直接 HTTPS 抓取与本地固定源提供可复核依据。

NOT EXECUTED：真实 PICO FPS/GPU 计时、硬件 6DoF/摇杆重测、13M reconversion、自动清理 Gaussian、Navigation teleport、worldScale 自动修改、Collision 重建、任何生产 DNS/DB 修改。

## 15. 交付与最终边界

```text
VR-01C SOFTWARE: PASS
OFFICIAL VIEWER PERFORMANCE CONTROLS VERIFIED
XR DIAGNOSTICS READY
INITIAL SPAWN SOFTWARE PATH VERIFIED
13M HISTORICAL ASSETS PRESERVED
PICO NEO3 HARDWARE ACCEPTANCE: PENDING
```

此 PASS 只签署正式软件门禁、诊断/官方开关/初始相机路径；不签署 PICO 帧率、真实起点或普通 Desktop probe 的加载时限。实际历史 Scene 仍无 authored camera，Owner需要按指南保存并在 PICO确认。不要宣称 `VR-01C FULL PASS`，不要开始 VR-01D清理、VR-03导航、VR-04碰撞或 Agriculture Digital Twin。

额外只读完整性复核：源 quarantine/upload.bin 与 raw-input.ply各 `3,246,401,885` bytes，最终SHA均与sourceSHA `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764`一致。最终确认2,076 published files全哈希与before一致，SceneVersion/AssetVersion/current指向未改变，历史7个成功publish job数未增加。

测试收据保存在隔离主机私有 `~/.local/state/gsplatform-vr00-20261011/vr01c/`；不提交 raw logs、accounts、Cookie、数据库备份、PLY、chunk、video或session文件。公开报告只含脱敏必要统计与安全入口，用户原89 tracked deletions与未跟踪Master Plan保留。
