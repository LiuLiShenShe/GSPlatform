# GS-NEXT-08 — 知天下视角对照与官方 Floater 过滤实验

日期：2026-10-18

## 结论摘要

- **实验 A（知天下视角对照）：`BLOCKED_ACCESS_REQUIRED`。** 本机不存在知天下的授权浏览器会话、页面地址或场景链接；公开检索无法唯一确认该平台域名。本轮未访问、未上传、未绕过登录，也未伪造任何对照结果。**问题 1 目前答案：证据不足**，无法判断知天下更干净是视角、渲染/LOD 还是 Gaussian 过滤。
- **实验 B（官方 `filter-floaters`）：完成 4 个候选真实执行，结论 `NO_VISUAL_IMPROVEMENT`。** 官方默认参数 `0.05` 在完整 13M 场景上**无法运行**（真实工具硬限制 `BlockIndexMap capacity 3423623870 exceeds the typed hash-table limit`）。三个官方可行参数全部跑通并产出可核验候选（0.5 / 0.25 / 0.1，删除率 0.52% / 1.12% / 2.30%），保留行在 62 字段上逐位一致且保持原始行序。**四视角同位姿官方 Editor A/B 显示：伪影与主体都几乎无变化，模糊色雾、强亮拖线、空间离群点均未减少，也未见误伤有效主体。**
- **关键机制发现**：官方 `filter-floaters` 删除的是"对任何实体素都没有贡献"的**孤立点**，而 GS-NEXT-07D 已证明产生底部色雾的那一行（最大线性尺度 `83.39`、opacity sigmoid `0.999995`、源行 `11183581`）**被三个候选全部保留**。该伪影不是 "floater"，而是尺度极大、不透明且紧贴场景内部的过长条 Gaussian。
- **三个候选全部 `HOLD_NOT_APPROVED`**，未发布、未切 `current`、未修改任何历史场景与原始 PLY。

---

## 1. 环境与资产基线

- 起始 `git status` 干净；HEAD 与 `origin/main` 同为 `6c356990ed1bbdd2f16d870b62359f275523c561`，`git log -5 --oneline` 与任务书一致（`6c35699` / `4f3b293` / `a80b64b` / `30290fa` / `6d3a6c4`）。
- 实验前阅读：`GS_NEXT_06_BUILDING_REUPLOAD_AB.md`、`GS_NEXT_07_EDITOR_CLEANUP_PILOT.md`、`GS_NEXT_07B_EDITOR_IMPORT_FIX.md`、`GS_NEXT_07C_EDITOR_ROUNDTRIP.md`、`GS_NEXT_07D_VISUAL_ABLATION.md`、`VR_01D_CLEANUP_WORKFLOW.md`。
- 原始 PLY（只读）：`3,246,401,885` bytes、Gaussian `13,090,324`、62 个 float 属性、SH bands 3、header `1533` bytes、binary little-endian。实验前后重算 SHA256 均为 `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764`，与 GS-NEXT-06/07C 记录一致。
- 本机 Split-Gaussian 组件存在；本轮为 CPU + 官方 GPU CLI/Editor，**未启动、未配置 GPU 划分**。
- 本轮所有实验均在仓库外独立证据目录：
  `/home/test/.local/state/gsplatform-vr00-20261011/gsnext08-run-20261018/`
  原始 PLY **未被写入**，全部实验使用哈希核验后的逐位副本（副本 SHA256 与原文件一致）。

---

## 2. 实验 A：知天下视角对照 —— `BLOCKED_ACCESS_REQUIRED`

任务书要求：优先使用用户已上传到知天下的同一份 Building；不得绕过登录、猜测凭据或擅自重新上传。

### 2.1 已执行的检查（全部落空）

| 检查项 | 结果 |
| --- | --- |
| Chrome 浏览器历史（`~/.config/google-chrome/Default/History`） | 无任何知天下 URL；最近记录为 GitHub/Context7/Firecrawl，2026-07-20 后无新访问 |
| 仓库内检索（`docs/`, `scripts/`, `workers/`, `scenes/`） | 仅在 `docs/GSPlatform_WebXR_VR_Master_Plan.md` 第 491 行出现一次，且被标注为"产品体验参考（仅参考体验，不复制其代码、不假定其内部实现公开、不引入其托管依赖）" |
| 私有证据目录检索（`~/.local/state/gsplatform-vr00-20261011/`） | 无知天下页面地址、账号、Cookie、token 或已保存会话 |
| Claude 会话历史/粘贴缓存检索 | 仅出现本任务的指令文本本身，无平台 URL |
| 公开检索（open-websearch: bing / baidu / startpage） | 无法唯一确认"知天下 3DGS 平台"的官方域名；检索结果多为"知网""知乎""知末"等无关站点 |
| 本机 Playwright 浏览器 profile / 持久化 storage state | 无该平台的登录态 |

### 2.2 结论与所需输入

**状态：`BLOCKED_ACCESS_REQUIRED`。**

- 未访问知天下，未上传任何文件到第三方，未绕过任何登录，**未编造任何对照截图或结论**。
- 需要用户提供二者之一才能继续：
  1. 知天下上该 Building 的**场景页面地址**（并确认该会话已登录），或
  2. 该场景在知天下的**截图/录屏**（并要求包含其默认视角、缩放与任何可用的渲染/LOD 设置信息）。
- 在拿到上述输入前，**问题 1"知天下是否只是视角更好"只能回答：证据不足**。

### 2.3 拿到访问权后的建议做法（尚未执行）

沿用 GS-NEXT-06 已验证的四组固定相机几何（整体 `[240,80,400]→[75,-25,150]` FOV 60；正面 `[400,30,180]`；侧面/底部 `[400,-100,180]`；近景 `[100,-15,175]` FOV 55），在知天下侧尽量对齐相机、FOV、背景、分辨率与观察范围，再判定属于四类中的哪一类。对齐相机是**判定的必要条件**：GS-NEXT-06 已证明"远距离鸟瞰"本身足以让主体显得干净、让伪影出现在屏幕边缘之外。

---

## 3. 实验 B：官方 SplatTransform `filter-floaters`

### 3.1 版本与参数契约（先复核，再执行）

- 仓库锁定：`splat-transform v3.3.3 (d092ae9)`，路径 `node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs`。本轮全部 4 次执行前均通过 `splat_transform_adapter.validate_cli` 复核版本字符串。
- Editor 运行时报告的 `SplatTransform v3.9.0` 来自 SuperSplat Editor 自身构建（`SuperSplat v3.5.2 | SplatTransform v3.9.0 (435b972)`），**与仓库 CLI 是两个不同安装**。本轮**未混用**：所有滤点均使用锁定 3.3.3，Editor 仅用于最终同位姿 A/B 渲染。
- 官方 CLI `--help` 与官方类型定义 `dist/lib/voxel/filter-floaters.d.ts` 一致：
  - `-F, --filter-floaters [size,op,min]  Remove Gaussians not contributing to any solid voxel. Default: 0.05,0.1,0.004`
  - 源码默认值 `voxelResolution=0.05, opacityCutoff=0.1, minContribution=1/255`。
  - 语义："GPU 体素化场景 → 对每个 Gaussian，求其在 AABB 范围内各**实体素中心**的贡献；若在**每个**实体素上的贡献都低于 `minContribution` 则删除"。对象是"不贡献于任何实体素的浮动点"。
- 历史 VR-01D Pilot 的准确命令/参数已复核（`filter-config.json`）：`voxelSize=0.25, opacityCutoff=0.1, minContribution=1/255≈0.00392156862745098`，`gpu='0'`，被拒的对比项 `gpu='cpu'`（官方拒绝）。该轮 ROI 内删除率 0.807413%，输入为 94,747 行 Box ROI，**未执行全场景**。**本轮未把 0.8% 当目标值**，也未沿用 `minimum_retained_fraction=0.9` 之外的放宽规则（本轮未使用 `run_cleanup_experiment`，见 §3.2）。

### 3.2 为什么未沿用 `workers/pipeline/cleanup_experiment.py`

该模块对 >1M 行的输入**硬性禁止**除单一 Box 之外的任何过滤（`raise ValueError("Large-scene filtering is disabled until separately reviewed full-scene full-scene preflight")`），即完整 13M 的 `filter-floaters` 路径在代码中仍未开放。

本轮的处理方式：**不修改该模块、不放宽该门禁**；使用仓库内**唯一**的 CLI 进程管理器 `splat_transform_adapter.run_cli_command`（同一进程组所有权、TERM/KILL 清理、device telemetry、`--max-workers 0`），并自建一个独立驱动器记录完整参数、哈希与校验。因此本轮的证据不能与历史 `cleanup_experiment` 证据混列为"同一平台管道产物"，须视为**经同一 CLI 管理器执行、但独立记录**的实验。

新增脚本（均可独立审查）：

| 文件 | 作用 |
| --- | --- |
| `scripts/gsnext08_floater_filter.py` | 候选生成驱动器：SHA256 前后校验、官方 CLI 调用、输出 schema/有限值/有序子序列校验 |
| `scripts/gsnext08_removed_analysis.py` | 反查每个候选删除了哪些源行、属性分布 |
| `scripts/gsnext08_ab_editor.mjs` | 官方 Editor 同位姿四视角 A/B 渲染 |
| `scripts/gsnext08_monitor.sh` | 只读资源时间线（不发送信号） |
| `scripts/gsnext08_ab_render.py` | 官方 CLI 光栅器 A/B 驱动（**本轮未产出有效结果**，见 §5.1） |

### 3.3 候选 B：官方默认参数 —— 真实失败，工具硬限制

命令（完整参数记录在 `candidates/B-official-default/cli-execution.json`）：

```text
--gpu 0 <original-copy.ply> --filter-floaters 0.05,0.1,0.0039215686274509803
--info json --stats json candidate.ply --no-tty --memory --max-workers 0
```

结果：`exitCode 1`，耗时 `592.78s`，峰值 `cpu=37.42GB gpu=823.0MB`。官方日志原文：

```text
scene: 996m x 735m x 1.18km, grid: 19928 x 14700 x 23548 voxels (6.9T) @ 5cm
✗ Error: BlockIndexMap capacity 3423623870 exceeds the typed hash-table limit
    at new BlockIndexMap (.../dist/index.mjs)
    at buildBlockLookup (...)
    at filterFloaters (...)
```

判定：**这不是参数写错，而是 v3.3.3 的真实上限**。`BlockIndexMap` 的上限为 `cap > 0x80000000`（2³¹）即抛错，而默认 0.05 体素 + block=4×0.05=0.2 需要在约 `108.0e9` 个块上建表。

按官方源码 `blockSize = 4 * voxelResolution` 推算上限（同一公式复算，非估计）：

| voxelSize | block | 块数（本场景 996×735×1180） | BlockIndexMap cap | 判定 |
| ---: | ---: | ---: | ---: | --- |
| 0.05（默认） | 0.2 | 107,978,850,000 | 274,877,906,944 | **超出** |
| 0.1 | 0.4 | 13,501,029,000 | 34,359,738,368 | 超网格，实际可行（见 C3） |
| 0.25 | 1.0 | 863,830,800 | 2,147,483,648 | 可行 |
| 0.5 | 2.0 | 108,125,760 | 268,435,456 | 可行 |

`BlockIndexMap` 的容量提示是**实际占用的块数**而非总网格块数，因此 0.1 仍可通过（实际占用块 `435M`，`4.35e8 < 2.147e9`）。**推论：仅靠 0.05 默认参数无法在完整 13M 上运行；降到 0.1 及更粗才可行。** 这不等于"0.05 一定能带来更好效果"，也未验证。

### 3.4 三个成功候选（只用官方 `--filter-floaters`）

统一约束：单一 `filter-floaters`；不叠加 `filter-cluster` / Box / opacity 阈值；不改 SH、位置、旋转、尺度、不透明度；输入为哈希核验副本；输出到全新目录。`opacityCutoff=0.1`、`minContribution=1/255` 保持官方默认，仅调节 `voxelSize`。

| 候选 | voxelSize | 源 Gaussians | 输出 Gaussians | 删除数 | 删除率 | 输出 SHA256 | 输出 bytes |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| A（对照） | — | 13,090,324 | 13,090,324 | 0 | — | `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` | 3,246,401,885 |
| **C1 保守** | 0.5 | 13,090,324 | 13,021,681 | 68,643 | **0.524%** | `c4019d771eb52a6a5976de6c28fdf5c613f8f5dd2529b6f9469969256de1810e` | 3,229,378,421 |
| **C2 中等** | 0.25 | 13,090,324 | 12,943,340 | 146,984 | **1.123%** | `81eb6f6940917a816885049f0f7b23561b56dbc178b16e01c9fea521aa730cc1` | — |
| **C3 较细** | 0.1 | 13,090,324 | 12,788,872 | 301,452 | **2.303%** | `8180f5cd66e5caccc2352013d193fe316f61c85c58207144668ee956d775e25c` | 3,171,641,789 |

运行时记录（来自官方 `--memory` telemetry）：

| 候选 | GPU/设备 | 体素化 | 峰值 | 总耗时 |
| --- | --- | ---: | ---: | ---: |
| C1 | `webgpu / nvidia-rtx-a6000` | 17.08s | cpu 12.08GB / gpu 823.9MB | 172.4s |
| C2 | `webgpu / nvidia-rtx-a6000` | 39.13s | cpu 11.92GB / gpu 823.0MB | 286.8s |
| C3 | `webgpu / nvidia-rtx-a6000` | 84.25s | cpu 20.02GB / gpu 823.0MB | 2,734.7s |

官方日志中的占用块统计：C1 `3.86M (3.12M solid, 744K mixed)`；C2 `29M (25.8M solid, 3.23M mixed)`；C3 `435M (413M solid, 22.1M mixed)`。

**属性完整性与字段差异（已逐项核验）**：三个候选的字段**集合**与源文件完全相同（62 个 `property float`，无增删）；官方写出器会**重排属性顺序**（源为 `x,y,z,nx,ny,nz,...`，输出为 `x,y,z,rot_0..3,scale_*,opacity,f_dc_*,f_rest_*,nx,ny,nz`）。这是官方 PLY writer 的既有行为，已在 C1 上用字段名归一化后逐行确认，**不等于数据损坏**，也**不能**宣称"62 字段按原顺序原样保留"。全部候选无 NaN/Inf。

**保留行保真（逐位）**：用字段名归一化后按 62 字段打包为 248-byte 内容 key，做保序子序列扫描：

| 候选 | 候选行数 | 保序匹配行数 | 匹配率 | 结论 |
| --- | ---: | ---: | ---: | --- |
| C1 | 13,021,681 | 13,021,681 | **100%** | 保序子序列，保留行逐位一致 |
| C2 | 12,943,340 | 12,943,340 | **100%** | 同上 |
| C3 | 12,788,872 | 12,788,872 | **100%** | 同上 |

即：**所有被保留的 Gaussian 在 62 个字段上与源逐位相同，且行序未被改变。**本轮为全量扫描（非"≤2M 才逐位"的历史限制），对 13M 规模同样成立。

### 3.5 删除行的构成（反查到源行）

`removed-analysis.json` 记录了每个候选删除的源行集合及其分布：

| 候选 | 删除行 opacity sigmoid（中位/最大） | opacity<0.01 | 最大线性尺度>2 | >10 | 删除源行 y 中位 |
| --- | --- | ---: | ---: | ---: | ---: |
| C1 | 0.02458 / 0.10494 | 21,162 | 7,106 | 224 | 21.95 |
| C2 | 0.02418 / 0.10526 | 47,328 | 8,615 | 216 | 21.50 |
| C3 | 0.01717 / 0.13760 | 121,836 | 10,102 | 211 | 21.38 |

三个候选删除的行的 opacity **最大值都只有约 0.105**，即**全部低不透明度点**；`voxelSize` 越小只是把同类低 opacity 点删得更多（1.12% → 2.30% 时 opacity<0.01 的删除数从 4.7 万增至 12.2 万）。

---

## 4. GPU 资源门禁（本轮先于任何 GPU 实验执行）

GS-NEXT-06 的历史缺口（四个无法归属的 GPU0 `python3.13` 进程）必须先关闭。本轮采用**可归属**的连续监控。

### 4.1 实验前快照

- GPU0：UUID `GPU-db3ec610-630b-fa4f-66f2-b69f269ca856`、PCI `00000000:18:00.0`、NVIDIA RTX A6000 49140MiB、占用 341MiB、Util 4%。
- GPU1：UUID `GPU-6836f890-98b2-5891-07ef-675c25199c65`、PCI `00000000:D8:00.0`、占用 14MiB、Util 0%（**背景占用，全程未使用**）。
- `--query-compute-apps` 返回**空**：无任何计算进程。
- GPU0 上仅 4 个 graphics 进程，全部可归属：`Xorg`（PID 257958）、`gnome-shell`（258436）、`xdg-desktop-portal-gnome`（259444）、`nautilus`（1810949），启动时间 2026-10-14/15（远早于本轮），用户均为 `test`，命令行与桌面会话一致。
- Celery 队列长度（`gsplatform`/`cpu`/`gpu`/`default`）**全部为 0**；无活跃 publish/conversion 任务。
- 门禁判定：**通过，允许在 GPU0 上执行本轮实验。** 未终止任何外部进程，未改用 GPU1。

### 4.2 实验期连续监控

只读采样脚本每 3 秒记录一次 `nvidia-smi` GPU/显存/利用率 + compute-apps + 内存/load，共 **3,026 个采样**，覆盖全部 4 次过滤、全部 A/B 渲染。

- GPU0 峰值显存 `8,145 MiB`（`nvidia-smi` 口径），出现在 C3；官方 CLI 自报 `gpu=823.0MB` 为其自身缓冲区口径。两者的差来自 Chrome/Editor WebGPU 上下文与本机 Xorg 基线，均属本会话。
- **1,383 个采样记录到了 GPU compute 进程，全部可归属到本会话**：类型为 `/home/test/bin/node`（官方 CLI，由 `splat_transform_adapter.run_cli_command` 启动，带 `--import splat_device_telemetry.mjs`）与 `/opt/google/chrome/chrome --type=gpu-process`（本会话 Playwright/Editor 浏览器进程，独立 profile 目录、PPid 链可追溯到本脚本 PID）。**未发现任何无法归属的进程；未发现其他用户的 GPU1 活动。**
- 全部 GPU 作业均运行在 `systemd-run --user --scope -p MemoryMax=48G -p MemorySwapMax=0`（或 46G）内存 cgroup 下，防止 13M 进程失控影响机器上其他用户的 79GB 常驻负载（交换分区已 100% 满，风险真实存在）。

### 4.3 实验结束状态

GPU0 `523 MiB / 0%`，GPU1 `14 MiB / 0%`，无 compute 进程；`snapshots/postflight.txt` 已记录。

---

## 5. 五：相同视角的画质对照

### **5.1 官方 CLI 光栅器 A/B —— 无法产出有效结果（工具故障）**

曾尝试用官方 CLI 自带的 `.webp` GPU 光栅器做同相机 A/B（`--projection pinhole --camera-pos/--camera-target/--camera-fov --resolution --background`）。**在原始 13M、C2 13M 与 C2 的 1.8M 子集上均稳定复现：**

```text
✗ WebGPU device lost: reason=unknown, message=vkQueueSubmit failed with VK_ERROR_DEVICE_LOST
at CheckVkSuccessImpl (.../dawn/native/vulkan/VulkanError.cpp:104)
— aborting (a corrupted GPU result must not be written)
```

失败时显存仅 `816.8MB`（非 OOM），重试两次均同样失败，且与是否同时运行其他 GPU 任务无关。这与 GS-NEXT-06 中 POSTER 阶段的 `vkQueueSubmit failed with VK_ERROR_DEVICE_LOST` 是同一类故障。**结论：官方 CLI 光栅器在本环境对全尺寸模型不可用，`scripts/gsnext08_ab_render.py` 未产出任何 A/B 输出，本报告不据此判定画质。**

### 5.2 官方 SuperSplat Editor 同位姿 A/B —— 有效产出

改用本机 pinned 官方 SuperSplat Editor `v3.5.2`（上游 commit `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`，运行时 `SuperSplat 3.5.2 / SplatTransform 3.9.0 / Engine 2.23.0 / PCUI 6.1.4`）做同位姿渲染。它是本环境唯一能稳定渲染 13M 的官方渲染器。

**方法**：每个文件经官方 `文件 → 导入...` 单独载入；**每个候选前先用 `新建` 重置为空场景**并强制校验状态栏 `高斯点 = 0`（否则 Editor 会把多个 PLY **合并**进同一场景——这个坑第一轮真实踩到并纠正，见 §8）；相机位姿在 **A 原始模型上捕获**，之后用官方 `setPoseOverride` **强制套用**到每个候选，并逐项断言 `position / rotation / fov / near / far` 与 A 完全一致（误差 ≤1e-4）后才截图。截图含整页 PNG 与裸 canvas PNG。

**确证每个文件载入的是正确数据**（状态栏 Splats）：

| 文件 | 状态栏高斯点 | 期望 | 结果 |
| --- | ---: | ---: | --- |
| A-original | 13,090,324 | 13,090,324 | 一致 |
| C1-voxel0.5 | 13,021,681 | 13,021,681 | 一致 |
| C2-voxel0.25 | 12,943,340 | 12,943,340 | 一致 |
| C3-voxel0.1 | 12,788,872 | 12,788,872 | 一致 |

**四个共享位姿**（A 上捕获后强制套用，FOV `85`、near `1`、far `1866.66`、tonemapping `linear`、SH3、黑背景、viewport `1500×967`、canvas `1500×934`）：

| 视角 | position | rotation `[x,y,z,w]` |
| --- | --- | --- |
| 整体斜视 | `[-647.3651, -19.9427, 1025.0061]` | `[-0.096572, -0.380587, -0.040001, 0.918818]` |
| 侧面 | `[1237.1915, -251.5629, 254.4810]` | `[0, 0.707107, 0, 0.707107]` |
| 底部 | `[123.1601, -1348.6697, 447.9305]` | `[0.642788, 0, 0, 0.766044]` |
| 正面 | `[123.1601, -251.5629, 1368.5123]` | `[0, 0, 0, 1]` |

完整 pose 与渲染状态每视角逐项相等的记录在 `render/ab-editor/ab-editor-result.json`；运行期间 `pageerror` 为空、无 failed request。

**渲染稳定性基线（关键）**：另起一个独立会话只渲染 A，得到 A vs A' ：

| 视角 | A/A' MAE | A/A' RMSE | changed≥4 |
| --- | ---: | ---: | ---: |
| 整体斜视 | 0.0002 | 0.0338 | 0.0011% |
| 侧面 | 0.0001 | 0.0164 | 0.0005% |
| 底部 | 0.0002 | 0.0193 | 0.0009% |
| 正面 | 0.0001 | 0.0219 | 0.0005% |

即渲染噪声接近零，**下面的 A/B 差异是真实差异，不是重复渲染抖动**。

**A vs 候选（四个视角 × 三个候选）**：

| 视角 | 指标 | C1 (删0.52%) | C2 (删1.12%) | C3 (删2.30%) |
| --- | --- | ---: | ---: | ---: |
| 整体斜视 | MAE / changed≥4 | 0.5956 / 0.745% | 0.5988 / 0.760% | 0.5998 / 0.774% |
| 侧面 | MAE / changed≥4 | 0.7155 / 0.617% | 0.7156 / 0.616% | 0.7154 / 0.614% |
| 底部 | MAE / changed≥4 | 0.6813 / 0.614% | 0.6816 / 0.616% | 0.6815 / 0.616% |
| 正面 | MAE / changed≥4 | 0.7704 / 0.546% | 0.7704 / 0.545% | 0.7705 / 0.546% |

（完整 MAE/RMSE/changed%/bbox 见 `render/ab-editor/ab-metrics.json`；派生差异热图 ×6 见 `render/diffs/`。）

**决定性观察：四个视角上，三个候选的差异量与删除率几乎完全脱钩。** 删除率相差 4.4 倍（0.52% → 2.30%），而 MAE / changed% 几乎相同（例如侧面 MAE 恒为 `0.7155`、底部恒为 `0.6815`）。这说明画面变化来自极少数**孤立点消失**这一共同子集，而不是更细的体素清理到更多伪影。

**视觉复核（Agnes 3.0 Flash 识图，按 agent 配置走 `apihub.agnes-ai.cn`）**：对 `A-original` 与 `C3-voxel0.1` 的 bottom / side / front / overall 四组同位姿对比，四个视角的一致结论是——

- **底部模糊色雾：无明显减少**。位置、扩散范围基本一致。
- **中央强亮拖线：完全保留**。亮度、长度、位置未变。
- **空间离群点：主要孤立光点仍可见**，未见可归因于过滤的减少。
- **未出现新的空洞或主体结构缺失**；四个视角主体均完整。

识图结论与本机直接查看原图、以及与 §3.7 的源行级证据三者一致。

### 5.3 未完成的部分（明确声明）

- **未做完整 Recipe 转换与发布 A/B**：本轮未对候选跑 `convert_scene`（streamed-sog / LOD / chunk），因此**没有** `转换 Recipe、LOD 和 Chunk 数量` 的对照数据。这不是遗漏而是按任务书"不重建不相关资产"未扩大范围；同时也因 §4 的资源门禁与 §5.1 的工具故障，未把候选发布成新 SceneVersion。
- **因此本轮只能报告过滤数据统计 + 官方 Editor 同位姿渲染对照，不能宣称"已发布画质改善"。**

---

## 6. 判定

### 6.1 为什么没有变化：删除的到底是什么

把 C3 删除的 301,452 行映射回源行，做 32³ 占用格统计（同一 P01/P99 源空间网格，与 GS-NEXT-06 同一方法）：

- 全体 11,853 个被占用格中，删除占比中位数仅 **0.64%**。
- 删除占比 **100%** 的格，其 Gaussian 总数只有 **1–2 个**。
- 换句话说，官方 `filter-floaters` 在完整场景上做的是：**把"孤立的 1–2 点小格"整格删掉，对密集区域几乎不动**（密集格最多只删 0.6% 上下）。

补充的源行 y 分布直方图显示，删除集中在源 y≈`[-7.4, 21.4]` 两个主带（各约 15 万行）与 y>100 的长尾稀疏区；这与"删孤点"的机制相符。

### 6.2 决定性证据：伪影生成点被保留

GS-NEXT-07D 已用**单点删除 A/B** 确证：源行 `11183581`（`max linear scale = 83.387279`、`opacity sigmoid = 0.999994902`、源 position `[-131.8828278, 250.7272491, 427.4365234]`）在四个视角产生可见的外围弥散色雾，删除后左下/底部雾状区域明显消退。

本轮反查三个候选：

| 候选 | 源行 `11183581` 是否被删除 |
| --- | --- |
| C1 / voxel 0.5 | **否（保留）** |
| C2 / voxel 0.25 | **否（保留）** |
| C3 / voxel 0.1 | **否（保留）** |

同样，GS-NEXT-07C 的受控测试行 `13011461` 三个候选也都保留。

**这就是"过滤无效"的机制性解释**：官方 `filter-floaters` 的判据是"对任何实体素中心是否有贡献"。这个 83 倍尺度的 Gaussian **尺度极大、几乎不透明，必然大量命中实体素中心**，所以它**不是 floater**，被完整保留。底部的"模糊色雾"与"强亮拖线"来自这类**过长条、极高 opacity** 的 Gaussian，而不是孤立点；官方 floater 过滤在原理上就不针对它们。

（作为对照，全场景 `max scale > 10 且 opacity > 0.99` 的行共 1,357 条——这才是与已确证伪影点同类的目标集合，本轮**没有**删除它们，也未把它们归为废点。）

### 6.3 三个问题的答案

**问题 1：知天下是否只是视角更好？**
**答案：证据不足（BLOCKED_ACCESS_REQUIRED）。** 本机没有该平台的会话、地址或截图（§2.1 全部检查落空），未编造对照。**无法**在四类原因中做区分。附带一条已确立的相关事实：GS-NEXT-06 已证明 GSPlatform 的"远距离鸟瞰"纯粹源于历史场景缺少 authored `initialCamera` 而走了官方 `frameScene()`，保存正式相机后即恢复正常——所以"视角/取景"这一因素在本平台的贡献是已被单独证明的，**但它不能外推为知天下更干净的原因**。

**问题 2：官方 `filter-floaters` 是否有效？**
**答案：否 —— `NO_VISUAL_IMPROVEMENT`。** 按判定标准（同相机条件下伪影明显减少且有效主体无明显损伤）：
- 伪影**没有**减少：四个同位姿视角下底部模糊色雾、中央强亮拖线、主要空间离群点均无明显变化（§5.2 视觉复核 + 像素指标）。
- 有效主体**没有**明显损伤：四视角无新空洞、无结构缺失；保留行 62 字段逐位一致。
- 只减少了 Gaussian 数量（0.52%–2.30%）而画面未改善——**按判定规则不能判成功**。
- 另有一条独立结论：**官方默认参数 `0.05` 在完整 13M 上根本无法运行**（`BlockIndexMap` 2³¹ 上限），所以"默认推荐设置"对本场景不可用。

**问题 3：下一步该怎么办？**
按任务书的判定树，落入：**"过滤无效但知天下画面明显更好"**（知天下这一半待访问权确认）。因此优先方向是**继续核查渲染、LOD 与上传处理差异**，同时针对已确证的机制做非 floater 路线的验证：

1. **先补知天下访问权**（页面地址或截图）再重启实验 A；在对齐相机前不得下任何结论。
2. **优先修默认取景策略**：GS-NEXT-06 已证明这是可立即落地的真实改进；对历史 Building 保存 authored initialCamera 需单独授权（本轮未触碰）。
3. **不要把 floater 过滤作为清理主线**。若要处理底部色雾/强亮拖线，方向应是**过长条 + 极高 opacity 的条状 Gaussian 的定向审阅**（GS-NEXT-07C/07D 的 Editor 选区 + 源行精确映射已具备该机制），且必须保持 `HOLD_NOT_APPROVED`。
4. **修复官方 CLI 光栅器故障或改用 Editor/Viewer 取证**——`VK_ERROR_DEVICE_LOST` 已影响两轮实验（GS-NEXT-06 POSTER、本轮全部 `.webp` 渲染），建议单独作为环境缺陷上报/排查，否则"同 Recipe 发布级 A/B"无法闭环。
5. **保留三个候选作为数据基线**（删除率 0.52%/1.12%/2.30% 的同参数可用上限参照），等待人工审阅；**不建议发布任何候选**。

---

## 7. 安全边界遵守情况

| 禁止项 | 状态 |
| --- | --- |
| 覆盖原始 PLY | **未发生**。实验前后 SHA256 均一致；全部实验使用独立副本 |
| 修改两个 Building 场景 | **未发生**。未调用任何 scene/presentation 写接口 |
| 修改 `current` SceneVersion 指针 | **未发生**。无数据库写操作 |
| 发布未经批准的清理候选 | **未发生**。未创建 SceneVersion、未触发 publish |
| 对完整 13M 执行未验证的批量删除 | **未发生**。删除全部来自官方 CLI 自身判定，且保留行逐位验证；未写回源文件 |
| 使用 GPU1 | **未发生**。GPU1 全程约 14MiB 背景占用，与本任务无关 |
| 终止外部 GPU 进程 | **未发生**。未发送任何信号给外部进程 |
| Fork 官方 Editor 或开发替代清理引擎 | **未发生**。仅使用 pinned 官方 Editor 与官方 CLI |
| 将测试结果冒充生产验收 | **未发生**。报告明确标注 Editor 同位姿渲染 ≠ 发布级 Viewer/LOD 验收 |

**候选状态：全部 `HOLD_NOT_APPROVED`。** 无 `APPROVED` 记录，无发布，无 `current` 切换。

---

## 8. 保留的失败与探索记录（未粉饰）

1. **候选 B 官方默认参数失败**（§3.3）：`BlockIndexMap capacity exceeds the typed hash-table limit`，`rc=1`，592.78s。保留完整日志与 manifest，未重试同参数、未改小后冒称默认。
2. **官方 CLI 光栅器 A/B 全数失败**（§5.1）：`VK_ERROR_DEVICE_LOST`，在 13M 原始、13M 候选、1.8M 子集上三次复现，显存仅 816MB。改用 Editor 完成 A/B，未把失败伪装成"无差异"。
3. **Editor A/B 第一轮数据无效（本报告最重要的失败）**：第一轮 4 文件连跑后，状态栏显示 C2/C3 也是 `13,021,681`——原因是官方 Editor 的"导入"是**合并进当前场景**而不是替换。第一轮的 C2/C3 截图因此全部作废，已删除重跑。修正方式为候选前 `新建` + 强制校验 `高斯点 = 0`。该轮截图**未**用于任何结论。
4. **驱动器 schema 校验过度严格**：初版用 `out_names == src_names`（顺序敏感）判 FAILED；实际官方 writer 会重排属性。改为按字段**集合**比较并在报告中如实写"顺序不保持"。
5. **保序子序列校验首次实现有 bug**：用 `a[ai:ai+win]` 消费时未按实际匹配数推进候选窗口，导致 `matchedInOrder = 131072`（恰好一个 chunk）。改为按匹配数推进后用暴力两指针对 3 万行小样例交叉验证，再全量扫描。
6. **首次尝试 `新建` 后读错元素**：状态栏四个 stat 中第一个才是高斯点；修正为显式解析 `stats[0]`，并加 `reload` 兜底。
7. **一次 `pkill -f gsnext08_monitor.sh` 误杀了自身 shell**（模式匹配到自己），后改用按 PID 停止。

---

## 9. 交付物

### Git 内（本轮提交）

- `docs/reports/GS_NEXT_08_VIEWPOINT_AND_FLOATER_FILTER.md`（本报告）
- `scripts/gsnext08_floater_filter.py` — 候选生成驱动器（CLI 调用、SHA 校验、schema/有限值/保序子序列校验）
- `scripts/gsnext08_removed_analysis.py` — 删除行反查与属性分布
- `scripts/gsnext08_ab_editor.mjs` — 官方 Editor 同位姿 A/B（含 GPU 门禁与场景重置校验）
- `scripts/gsnext08_ab_render.py` — 官方 CLI 光栅器 A/B 驱动（本轮未产出有效结果，保留供环境修复后复用）
- `scripts/gsnext08_monitor.sh` — 只读资源时间线（不发送信号）

### 仓库外证据目录

`/home/test/.local/state/gsplatform-vr00-20261011/gsnext08-run-20261018/`

```text
candidates/B-official-default/    cli.log + cli-execution.json + manifest.json（FAILED 证据）
candidates/C1-conservative-coarse/  candidate.ply, manifest.json, cli-execution.json,
                                    cli.log, removed-analysis.json (+ .removed.npy)
candidates/C2-finer-feasible/       同上
candidates/C3-finest-practical/     同上
render/ab-editor/                  4 文件 × 4 视角 = 32 张官方截图(整页 + 裸 canvas)
                                  ab-editor-result.json（含四视角完整 pose 与相等性断言）
                                  ab-metrics.json
render/ab-editor-A2/               A 的独立重渲染（稳定性基线）
render/diffs/                      四张 A+三候选差异热图(x6)
snapshots/preflight.txt / timeline.jsonl / postflight.txt（3026 个采样）
input/original-copy.ply            哈希核验副本
```

模型、截图、私有日志均**不进入 Git**。

---

## 10. 回归验证与历史资产不变性

- 源 PLY 前后 SHA256 一致：`8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764`，`3,246,401,885` bytes。
- GS-NEXT-07C 的 `support-aware-106283-original.ply` SHA256 一致：`97105429ef4a2c54bc19d2d85f815811b2d9b7fd7e521ce4d557ec11d7ad36e3`。
- 回归测试（`PYTHONPATH=apps/api:. apps/api/.venv/bin/python -m pytest`）：
  `workers/tests/test_splat_transform_adapter.py` + `test_cleanup_experiment.py` + `test_editor_export_validation.py` + `test_convert_safety.py` → **80 passed**（11.46s）。
- Editor 固定构建身份未变（`editor-version.json` 与 artifact hash 未动）；本机 Editor 静态服务保持运行，未修改上游源码。
- 数据库：仅只读查询（队列长度），无写操作；未触碰 A/B 两个 Building 的 Scene/Presentation/Spatial。
- 未提交 PLY、SOG、Cookie、Token 或私有路径；截图与大型证据均在 Git 外。

---

## 11. 最终结论

1. **知天下更干净的原因：目前无法判断（`BLOCKED_ACCESS_REQUIRED`）。** 本机无授权会话、无页面地址、无截图；公开检索无法唯一确认平台域名。已确立的相邻事实只是：GSPlatform 的"远距离鸟瞰"是可修的取景策略问题（GS-NEXT-06），**不能外推为知天下的原因**。需要用户提供知天下场景地址或截图。
2. **官方 `filter-floaters` 是否改善画面：没有（`NO_VISUAL_IMPROVEMENT`）。** 官方默认参数 0.05 在完整 13M 上无法运行（工具硬限制）；三个可行参数（0.5/0.25/0.1，删除 0.52%/1.12%/2.30%）在同位姿四视角官方 Editor A/B 中，模糊色雾、强亮拖线、空间离群点均无明显减少。
3. **是否误伤有效主体：本轮未观察到误伤。** 保留行在 62 个字段上逐位一致且保序；四视角无新空洞、无结构缺失。但这**不等于**已证明主体无损——删除行的语义归属（真实植被/草地 vs 噪点）仍需人工审阅。
4. **最值得人工审阅的候选：C1（`voxelSize=0.5`，删除 0.52%，SHA256 `c4019d771eb52a6a5976de6c28fdf5c613f8f5dd2529b6f9469969256de1810e`）。** 理由：删除最少、风险最低、且与更激进的候选画质差异几乎为零——如果目标是"最小改动地清孤点"，C1 的信息量最高。**但这不构成推荐删除**：所有候选 `HOLD_NOT_APPROVED`，且它们都不解决底部色雾与强亮拖线。
5. **是否具备进入下一阶段清理的条件：不具备。** 直接以 floater 过滤为主线的清理路线已被本轮数据否定（机制上不作用于已确证的 83 倍尺度伪影点）。下一阶段应改为：补齐知天下访问权 → 修复默认取景 → 针对过长条/极高 opacity 条状 Gaussian 的定向 Editor 审阅，并优先修复官方 CLI 光栅器的 `VK_ERROR_DEVICE_LOST` 环境缺陷。

---

## 12. 外部来源

- [官方 SplatTransform CLI Reference](https://developer.playcanvas.com/user-manual/splat-transform/cli-reference/)（`--filter-floaters [size,op,min]` 参数与默认值）
- [锁定 SplatTransform 源码 v3.3.3](https://github.com/playcanvas/splat-transform/tree/v3.3.3)（`filterFloaters` / `BlockIndexMap` / `isCenterInOccupiedVoxel` 实现）
- [官方 SuperSplat 源码](https://github.com/playcanvas/supersplat/tree/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b)（Editor 3.5.2 固定构建）
- 知天下平台：**未能确认官方域名或场景地址**（bing / baidu / startpage 检索均无唯一结果）
- 识图：Agnes 3.0 Flash（`https://apihub.agnes-ai.cn/v1/chat/completions`），用于 §5.2 的视觉复核初判；最终结论已由本机直接查看原图与源行级证据交叉确认

**本轮无任何基于训练数据的未核实断言；未搜索到的部分已标注"证据不足"或"未能确认"。**

【任务已结束】
