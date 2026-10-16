# GS-NEXT-06 Building 原始 PLY 重新上传与新旧场景对照

## 结论摘要

本实验在隔离 staging 数据库中创建了唯一一个新场景 `Building-Reupload-Control`，使用与历史 Building 相同的原始 PLY，完成了真实分块上传、断点恢复、官方 SplatTransform 转换、LOD 构建、发布和官方 Viewer 取证。

**结论：重新上传没有实质改善远距离鸟瞰、底部大面积模糊 Gaussian 或空间离群点。** A/B 在相同固定相机、相同 Viewer 设置下的四组画面基本相同；B 的默认打开视角仍由官方 `frameScene()` 取景而很远。B 保存正式 authored initialCamera 后，刷新场景能够进入主体附近的有效视角，因此远距离鸟瞰属于默认取景策略问题，不能通过重复转换解决。

底部伪影在 A、B 的侧面/底部画面中位置和形状基本一致，未执行任何滤点、裁剪、opacity 过滤、floaters 删除、缩放、旋转或重新训练。下一步应在官方 SuperSplat Editor 中进行非破坏性选区、手动裁剪和质量对照；本任务没有执行正式清理。

有一项必须单独标记的执行缺口：转换后段资源日志记录到四个未能归属到 staging Worker 的 GPU0 Python 进程。监控只记录资源，没有在未知进程出现时触发停止门禁；直到事后汇总才发现，进程已经退出，无法补齐父进程归属链。**资源门禁验收未通过，不能将本轮标记为全部授权条件均通过。** 已完成的真实画面和发布结果予以保留；发现后停止新增 GPU 实验，没有终止外部进程、使用 GPU1 或重新执行转换。

## 1. 环境与历史资产核验

- 核验提交：`aaa7455f5d62b9892300e941c44a6eea2a873584`；`main` 与 `origin/main` 一致；工作区在实验前干净。
- staging 数据库：`gsplatform_vr00_20261011`；上传限制实测为 5 GiB，API 单块上限 64 MiB。
- 上传前磁盘可用 `489,189,658,624` bytes；staging Worker 的 active/reserved/scheduled 均为空，`gsplatform` 只有 staging publish Worker 消费，GPU compute-process 查询为空。这是启动时的快照，不代表后续全程独占。
- staging HTTPS Viewer 根地址：`https://grade-physics-secrets-williams.trycloudflare.com`。
- 实验前阅读：`docs/GSPlatform_WebXR_VR_Master_Plan.md`、`docs/reports/VR_01D_GAUSSIAN_CLEANUP.md`、`docs/operations/VR_01D_CLEANUP_WORKFLOW.md`、`docs/reports/GS_NEXT_02_INITIAL_CAMERA_FIX.md`。
- 历史场景 A：slug `u-06924576399e`，scene UUID `e2f54542-40a1-494f-b260-ad8fd28156e6`，SceneVersion `01c63c7c-8eb5-498e-bcc0-77215e92ca12`，AssetVersion `da7bf4207044`，状态 `PUBLISHED/PUBLIC`。
- 历史原始 PLY 已确认存在；原始路径不写入 Git。文件大小 `3,246,401,885` bytes，完整 SHA256：`8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764`。
- 原始 PLY 为 binary little-endian，header `1533` bytes，62 个 float 属性，SH bands `3`，Gaussian `13,090,324`；全量属性均为有限值。A 与 B 的上传源 SHA、大小和 Gaussian 数量完全一致。

源文件只读审计观察值：原始 bounds 为 `x[-573.665588,327.345367]`、`y[-36.201385,539.327148]`、`z[-275.317566,784.279541]`；P01-P99 为 `x[-273.257775,118.049759]`、`y[11.393956,43.127471]`、`z[-122.675824,435.816275]`。`opacity` sigmoid 小于 `0.01/0.05/0.1` 的数量分别为 `2,913,422/4,978,694/5,831,459`；最大线性 Gaussian scale 为 `83.387279`，大于 2/5/10/20 的数量为 `186,731/12,900/3,697/530`。这些是分布观察值，不是未经批准的废点分类规则。

上述全量与稳健 bounds 是 A/B 共同源 PLY 的 Gaussian 中心坐标分布；没有对编码后的 SOG 逐 Gaussian 解码重算分位数。Viewer 的 bounds 还包含 Gaussian 尺度和各 LOD 的聚合范围，不能与源中心 bounds 混同。源坐标到 Viewer 的既有约定为 `(-x,-y,z)`；源 y 尾部对应 runtime y<-50 的数量为 7,227，y<-100 为 1,952。

## 2. A 原场景只读排查

- A 的 SceneVersion 格式为 `streamed-sog`，Runtime Descriptor 的 `content.format` 为 `lod-meta`，入口为 `da7bf4207044/lod-meta.json`。
- `presentation.initialCamera.position/target/fov` 均为 `null`；空间状态没有 STALE 行。历史 Scene、SceneVersion、Presentation、Spatial 状态在实验前后 JSON 快照完全相同。
- 通过实际运行时方法记录到加载完成后调用 `frameScene()`；没有调用 `resetCamera()`。最终默认 Camera Pose 为 position `[890.5724,141.9909,1023.6108]`、FOV `85`，远离主体。
- A Runtime bounds：min `[-364.7285,-546.4846,-302.9990]`，max `[591.4539,53.2567,795.8012]`，horizontal extent `1098.8002`。该数值为未标定单位，不称为米。
- A 页面诊断的默认渲染设置：Performance Mode `ON`、splat budget `2,000,000`、LOD mode `distance`、alpha clip `1/255`、minimum contribution `1`、ACES、黑色背景、high precision `false`、post effects `null`。

这区分了两个问题：A 的默认视角远，是因为没有 authored initialCamera 后走了官方自动取景；这本身不等价于 Gaussian 数据已经损坏。

## 3. B 正式上传、转换与发布

- 新场景名称：`Building-Reupload-Control`。
- scene slug：`u-c71ec45417a0`；scene UUID：`a21bcddb-303f-4762-9ada-7f50b27329a6`。
- Upload session：`4d7e344d-f008-4a64-9761-7248ca554ca9`，状态 `SUCCEEDED`，最终 offset `3,246,401,885`。
- Publish Job：`7ee24c1f-8a63-4bf5-b251-e51d0492d75a`，状态 `SUCCEEDED`，progress `100`；Celery task `1ea36782-c281-4638-ad77-6a3d15ae4184`。
- 新 SceneVersion：`c26e0dbb-489c-4679-b784-8ff957d84338`；AssetVersion：`5cd79d2c9641`。
- 上传通过 `POST /api/v1/uploads`、`PATCH /api/v1/uploads/{id}`、`POST /api/v1/uploads/{id}/complete` 完成，使用合法 staging 登录、CSRF 和 Secure cookies。传输按 16 MiB 流式读取，没有把 3.25 GB 文件一次读入内存。
- 实际断点恢复：客户端在两个分块后断开，新的合法认证会话从服务端 offset `33,554,432` 继续；全程 194 个成功块，最后一块 `8,399,197` bytes。
- 时间均为 2026-10-16 北京时间：上传开始 `09:33:55`、客户端完成 `09:48:20`，发布 Job 完成 `11:17:09`。平台没有单独的上传 Job 实体，上述 Upload session 是正式上传记录，Publish Job 是后续转换发布任务。
- B 发布地址：`https://grade-physics-secrets-williams.trycloudflare.com/scene/u-c71ec45417a0`。
- A 发布地址：`https://grade-physics-secrets-williams.trycloudflare.com/scene/u-06924576399e`。

转换工具为官方 SplatTransform `3.3.3`，实际 CLI 观测为 WebGPU / NVIDIA RTX A6000；Worker 环境使用 `GS_CONVERT_GPU=0`，CLI 参数为 `-g 0`，没有 CPU fallback 或 GPU1 fallback。B 的 7 次实际 CLI 执行均以 exit code `0` 完成，并记录到同一 NVIDIA adapter。

### A/B 转换与资产对照

| 指标 | A 历史 Building | B Re-upload Control |
|---|---:|---:|
| 源 Gaussian | 13,090,324 | 13,090,324 |
| 源 SHA256 | `8e49f56b...108e764` | `8e49f56b...108e764` |
| 工具 | SplatTransform 3.3.3 | SplatTransform 3.3.3 |
| Recipe | v2 balanced | v3 balanced streamed-sog |
| LOD 数量 | 3 | 7 |
| LOD counts | 13,090,324 / 3,927,097 / 1,309,032 | 13,090,324 / 6,545,162 / 3,272,581 / 1,636,291 / 818,145 / 409,073 / 204,536 |
| LOD ratios | 100% / 30% / 10% | 100% / 50% / 25% / 12.5% / 6.25% / 3.125% / 1.5625% |
| Chunk 总数 | 259 | 373 |
| 每 LOD chunks | 180 / 59 / 20 | 180 / 95 / 49 / 25 / 13 / 7 / 4 |
| 发布文件 | 2,076 | 2,988 |
| 发布文件总字节 | 845,826,640 | 1,208,980,405 |
| lod-meta SHA256 | `df735f57...8fa75ab` | `785e2497...bdef429f` |
| 内容清单 SHA256 | `0eb4899c...e18712` | `c167bbd6...f74277b0` |
| Runtime bounds min | `[-364.7285,-546.4846,-302.9990]` | `[-364.7285,-575.5405,-302.9990]` |
| Runtime bounds max | `[591.4539,53.25668,795.8012]` | `[591.4539,53.30679,795.8012]` |
| Runtime aggregate bounds | vertical `599.74128`，horizontal `1098.8002` | vertical `628.84729`，horizontal `1098.8002` |

A 与 B 使用了同一官方工具版本和同一源文件，但不是严格相同的 Recipe：A 是历史 Recipe v2，B 是当前正式默认 Recipe v3。因此不能把任何细节差异简单归因于“重新上传”本身；这项实验回答的是“用当前正式上传/发布管线重新发布相同原始 PLY 是否消除问题”，答案是否定的。

共同参数：`lodChunkCount=64`、`lodChunkExtent=32`、`lodChunkMin=null`、`shIterations=10`、`computeBackend=webgpu`、SH3。B 当前默认新增 `encoding=official-sog-v2`、`sourceModel=default`、`streamingThreshold=1000000`、`minLodGaussians=125000`、`maxLodLevels=8`；实际 CLI 为 `--max-workers 0`，没有传入过滤、裁剪或坐标变换参数。LOD0 保留全部源 Gaussian，下游按正式默认 Recipe 生成简化 LOD。A/B 完整 Recipe 和实际 B CLI 参数分别保存在证据目录的 `A-build-summary.json`、`B-build-summary.json`。

所有 A/B manifest 引用和 WebP headers 均通过校验，官方 Viewer 两个场景均返回 HTTP 200，LOD 入口 Range 请求返回 HTTP 206。Viewer 实际绘制数量是当前屏幕 LOD/预算结果，不是源 PLY 总 Gaussian 数量。

### 发布阶段

A 的历史内容已发布，历史 poster 为空。B 的 COPYING、DECIMATE_LOD1-6、STACK、VERIFYING、PUBLISHING 均完成；可选 POSTER 阶段出现真实错误：`WebGPU device lost: reason=unknown, message=vkQueueSubmit failed with VK_ERROR_DEVICE_LOST`。既有发布管线将 POSTER 标记为 `SKIPPED`，没有写入损坏 poster，随后仍完成 VERIFYING 和 PUBLISHING；B 的 `posterUrl` 为 `null`。没有重试 poster、重启 GPU 或重建发布资产。

## 4. Viewer A/B 画面对照

取证浏览器为官方 SuperSplat Viewer 1.35.0 场景路由，Viewer 引擎 PlayCanvas 2.22.4，WebGL2 SwiftShader，viewport `1280x800`，官方 `captureFrame` 输出 `1280x720` PNG。A、B 使用相同背景、ACES、Performance Mode、LOD mode、splat budget、alpha clip 和 minimum contribution。固定相机设置 `animationPaused=true`，将官方有界相机过渡同步推进至结束，再确认相机采样稳定、`frame:ready=true`、loading=0 和资产请求清空后截图；四组固定视角的 forward direction dot product 均大于 `0.999999`，没有把过渡动画中的不同帧当作对照。

未修图截图和脱敏 JSON 收据在仓库外的 `GSPlatform-evidence/GS_NEXT_06/`，入口为该目录的 `index.html`。四组固定相机参数为：整体 `[240,80,400] -> [75,-25,150]`, FOV 60；正面 `[400,30,180] -> [75,-25,150]`, FOV 60；侧面/底部 `[400,-100,180] -> [75,-25,150]`, FOV 60；近景 `[100,-15,175] -> [75,-25,150]`, FOV 55。

以下为部署机本地证据链接；GitHub 克隆不包含这些 PNG。[并排对照页](../../../GSPlatform-evidence/GS_NEXT_06/index.html)共包含 11 张官方截图，`evidence-sha256.json` 记录每个文件的完整哈希。

| 实验画面 | A 原图 | B 原图 |
|---|---|---|
| 默认打开，未设置人工相机 | [A 默认](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/A-default.png) | [B 默认](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-default.png) |
| 固定：整体鸟瞰 | [A 整体](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/A-overall.png) | [B 整体](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-overall.png) |
| 固定：主体正面 | [A 正面](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/A-front.png) | [B 正面](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-front.png) |
| 固定：侧面和底部 | [A 底部](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/A-side-bottom.png) | [B 底部](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-side-bottom.png) |
| 固定：有效主体近景 | [A 近景](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/A-detail.png) | [B 近景](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-detail.png) |
| B 保存相机并重新打开 | — | [B authored](../../../GSPlatform-evidence/GS_NEXT_06/screenshots/B-authored-default.png) |

默认打开实验没有人工 setCameraPose；实际最终读数如下，target 为运行时沿真实 forward 推导的观测点：

| 默认实际 Camera Pose | A | B 保存相机前 |
|---|---|---|
| position | `[890.572388,141.990891,1023.610779]` | `[896.152649,130.278137,1029.191040]` |
| observed target | `[113.362702,-246.613952,246.401094]` | `[113.362700,-261.116837,246.401091]` |
| FOV / loaded 后调用 | `85 / frameScene` | `85 / frameScene` |

四组固定视角的实际 position、FOV 和渲染设置逐项相等；目标方向点积接近 1。A/B 实际屏幕绘制数分别为：整体 `1,966,103/1,955,424`、正面 `1,954,153/1,960,211`、底部 `1,955,287/1,959,175`、近景 `1,937,492/1,930,660`。这些仅是相同预算下的屏幕 LOD 数量。完整实际 Camera Pose、请求 target、稳定前后读数在 `A-viewer.json`、`B-viewer.json` 和 `camera-validation.json` 中。

观察结果：

1. 默认打开：A、B 都是远距离鸟瞰，主体只占画面较小区域；主体下方均有大块扩散模糊 Gaussian，周围均可见孤立彩色/亮色离群点。B 没有改善默认 frameScene 结果。
2. 整体鸟瞰：建筑、道路和场地均能加载；外围存在相同类型的模糊边界和孤立伪影，未见 B 有实质质量提升。
3. 主体正面：屋顶、立面和地面结构可辨认，但主体上方/外围和前景仍有明显模糊拉伸；A/B 视觉结构相同。
4. 侧面和底部：A/B 均出现大面积近距离模糊 Gaussian，位置和色块形状高度相似；重新上传没有清除底部伪影。
5. 主体近景：屋顶、钢结构、楼梯和道路细节可辨认，但局部仍有拉伸和模糊；没有观察到足以支持“重新上传修复”的差异。

## 5. 初始相机单独验证

仅对 B 使用正式作者接口 `PATCH /api/v1/scenes/u-c71ec45417a0/presentation` 保存：

```json
{
  "initialCameraPosition": {"x": 240, "y": 80, "z": 400},
  "initialCameraTarget": {"x": 75, "y": -25, "z": 150},
  "initialCameraFov": 60
}
```

PATCH 于 2026-10-16 北京时间 `11:32:39` 返回 HTTP 200；重新读取 Runtime Descriptor 后，position、target、FOV 与保存值一致。刷新 B 后实际 Camera position 为 `[240,80,400]`、FOV `60`，调用记录为 `resetCamera()`，没有调用 `frameScene()`。运行时 `getCameraPose()` 的 target 是沿真实 forward、按 bounds 中心距离推导的观测 target，因此使用 position、FOV 和 forward direction 验证渲染姿态，同时以 Runtime Descriptor 验证保存的精确 target。刷新后的 observed target 为 `[34.689924,-50.651867,88.924127]`，与请求 target 位于同一观察射线上，方向点积为 `1.0`；不能宣称两个 target 数值逐项相等。

A 的 authored initialCamera 保持 `null`，没有调用任何 A 的 Presentation 写接口；A 的历史默认相机和 SceneVersion 均保持原样。

## 6. GPU、Worker 与恢复状态

- GPU0：UUID `GPU-db3ec610-630b-fa4f-66f2-b69f269ca856`，PCI `18:00.0`；B 成功转换子进程均以 `-g 0` 和 WebGPU NVIDIA RTX A6000 记录。
- GPU1：UUID `GPU-6836f890-98b2-5891-07ef-675c25199c65`，PCI `D8:00.0`；没有向 GPU1 调度任务。资源采样中的 GPU1 仅有约 14 MiB/最高 1% 背景占用。
- 转换监控 360 个采样中，物理 GPU0 总占用最高记录 2,408 MiB、100% 利用率；2026-10-16 北京时间 11:09:49、11:10:54、11:13:37、11:14:59 首次分别记录到 PID `14871/23216/41107/49408` 的 `python3.13` 进程。它们未被归属到本次 Worker，且没有留存父进程记录，不能推断全部都是本实验进程。监控只记录而未在当时触发停止，是本次执行缺口；GPU 隔离验收标记为 **NOT FULLY VALIDATED**。
- 发布后的只读核查还看到 GPU0 上 PID `99814` 执行 `python3.13 -I run_experiment.py`，工作目录在本仓库之外，占用约 15,942 MiB。发现后不再启动 GPU 操作，没有发送信号给外部进程。不能依据时间相邻就把 POSTER 的设备丢失归因于这些进程。
- 发布完成后只在空队列条件下受控停止 staging 专用 publish Worker，于 2026-10-16 北京时间 `11:37:41` 恢复原通用配置：`GS_CONVERT_GPU` 未设置，代码默认值为 CPU；新 publish PID `198407`，API PID `3934310`，运行版本均为 `aaa7455f5d62b9892300e941c44a6eea2a873584`。恢复默认配置不是本次转换的 CPU fallback。
- `gsplatform` 队列恢复为唯一消费者 `vr00-publish@test`；active/reserved/scheduled 均为空。没有重启共享 PostgreSQL、Redis、其他用户 Worker、CPU/GPU Worker 或其他实验进程。
- 恢复后 `/health/live`、`/health/ready` 均 HTTP 200；A/B Runtime、Viewer 和 Range 资产请求分别为 HTTP 200/200/206。最终可用空间约 `477,827,829,760` bytes。

## 7. 历史资产保护与测试

- A 的 Scene、SceneVersion、Presentation、Spatial 状态前后快照完全相同。
- A 的 2,076 个发布文件逐个比较 SHA256、大小和修改时间，前后完全相同；A 的 current version 没有替换。
- 原始 PLY 未修改，B 使用源 SHA 完全相同的文件。
- 没有提交 PLY、SOG、私有认证数据、Cookie、Token 或私有原始文件路径；截图和大型证据均在 Git 外。
- 本轮没有应用代码修改，仅新增本报告。实验前执行 `workers/tests/test_convert_safety.py`、`workers/tests/test_convert_scene_lod_recipe.py`、`workers/tests/test_splat_transform_adapter.py`、`workers/tests/test_publish_conversion_recovery.py`：`49 passed`，40.77 秒。
- 类型检查、Lint 和全套 E2E 回归未运行（无应用代码改动）。本次真实浏览器取证完成 A 默认+四视角、B 默认+四视角、B authored 刷新共 11 张截图；对应成功运行的页面错误和失败请求均为空。转换期间另一次 A 浏览器尝试曾在加载约 95% 超时，未作为有效截图；转换结束后的完整 A 运行成功，使用其最终收据。
- 文档通过 `git diff --check`；外部证据索引的 32 个文件逐个复核 SHA256 和大小一致。

## 8. 最终判定与后续

本实验属于“结果 1：A 与 B 基本相同”，并且同时证明了“结果 3：B 仍会远距离鸟瞰，但保存 authored initialCamera 后正常”。

因此：

- 重新上传不是解决底部模糊 Gaussian、孤立离群点或大尺度 Gaussian 伪影的有效方法。
- 远距离鸟瞰的直接原因是历史场景缺少 authored initialCamera，官方 Viewer 按策略调用 `frameScene()`；B 保存相机后已验证可修复默认入口。
- 源 PLY 的分布确实包含低 opacity、尺度长尾和坐标长尾，但这些统计不能单独证明每个点都是废点；A/B 同源重新发布后问题仍在，说明不能仅靠重复转换解决。
- 本次没有额外直接渲染完整原始 PLY 与 SOG 做逐 Gaussian 误差对照，不能声称已经排除所有官方编码或 LOD 的影响。现有证据不支持“只有历史发布损坏才产生这些伪影”，源数据质量问题是后续 Editor 质量对照应检验的方向。
- A/B Recipe 不同，不能据此推断 v2/v3 的全部质量差异；若要隔离 Recipe 因素，应另做经过批准的同 Recipe 对照，而不是修改历史场景。
- 下一步应使用官方 SuperSplat Editor 做非破坏性手动选区、裁剪和质量对照；不得自动发布全场景清理候选，也不得覆盖 A。
- 在新的 GPU 实验前，应先恢复可证明的 GPU0 独占或任务归属审计；本次报告中的 GPU 隔离缺口必须先关闭。

