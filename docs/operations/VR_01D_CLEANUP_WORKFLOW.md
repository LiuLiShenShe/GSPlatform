# VR-01D — 非破坏性 Gaussian 清理实验操作

日期：2026-10-12。此入口不是上传默认流程、不是发布 API，也不是 Celery 任务。

## 1. 安全边界

- 默认 `PLY → SOG` 上传/发布与 MANUAL_ONLY Collision 策略完全不变。
- 官方 SplatTransform 3.3.3 执行过滤；GSPlatform 仅验证配置、运行 CLI、测量差异和保存证据。
- 只接受官方未压缩 binary little-endian float PLY。输出必须是新的仓库外目录；拒绝输入目录、已有目录、symlink 路径及 `published/versions/quarantine/.staging` 路径。
- 不接受任意 CLI 字符串，不传 shell，不传 `--overwrite`、decimate、SH 截断或 transform。
- 每次验证完整源 SHA256；CLI 结束后重新验证。磁盘至少为输入大小三倍加显式安全余量（默认 2GiB）；这只是磁盘门禁，不替代 GPU/内存预检。
- 复用唯一 `splat_transform_adapter.run_cli_command`：固定版本、进程组 ownership、有限超时、TERM/KILL 清理、16MiB 磁盘日志与64KiB尾部。没有第二套 CLI 进程管理器。
- 配置默认为最多600秒，可设1..7200秒。长实验前必须检查活跃任务；不能重启消费者或终止其他人的进程。
- 此最小入口禁止 >1M 输入的 Floater/Cluster/Value 等过滤，仅允许单一 Box 用来提取连续 Pilot。完整13M过滤需要另外审核资源与保真前置条件，本轮未开放此路径。

## 2. 坐标与参数契约

`OfficialFilter` 的 Box 与 Seed 配置一律使用 **源 PLY 原始坐标**。固定官方CLI读取PLY时带 Z180，空间操作在其 Runtime 坐标 `(-sourceX,-sourceY,sourceZ)` 下执行。适配器只转换参数，不修改顶点或 worldScale。

源 Box `[xmin,ymin,zmin,xmax,ymax,zmax]` → CLI Box `[-xmax,-ymax,zmin,-xmin,-ymin,zmax]`；源 seed `(x,y,z)` → CLI seed `(-x,-y,z)`。官方写出 `.ply` 恢复PLY约定。已用不对称真实CLI用例验证，不依靠对称Box掩盖翻转。

过滤顺序按 `filters` tuple 保留，不能假设可交换。Box截邻域可能改变Floater结果，必须有halo、边界评估和多个真实视图。ROI提取不是正式场景裁剪审批。

白名单：

| kind | 显式配置 | 门禁 |
| --- | --- | --- |
| `box` | 6个有限数、每轴min<max | 源空间，必须说明保留区域依据 |
| `floaters` | `(voxelSize,opacityCutoff,minContribution)` | size>0、opacity0..1、contribution≥0、显式GPU |
| `cluster` | 同上，另加seed | 必须显式有限seed、在源bounds内；仍需人工证明连通簇，不允许默认零种子 |
| `nan` | 无参数 | 官方规则接受部分Inf，平台候选校验更保守：所有存储值必须有限 |
| `value` | column/comparison/一个有限值 | 列必须真实存在、比较符白名单；不支持x/y/z单轴裁剪，避免混淆源/Runtime |

Floaters/Cluster需要官方GPU voxelization，`gpu='cpu'`被拒绝。软件GPU adapter可显式指定但不可冒称硬件GPU。设备以CLI telemetry结果为准。单位未标定，不把0.05认定为5cm真实距离。

## 3. 先分析，再生成候选

在项目根目录执行，输出均在仓库外。不要将私有 runtime.env 内容、账号、Cookie或日志提交Git。

```python
import json
from pathlib import Path
from workers.pipeline.gaussian_quality import analyze_gaussian_ply

source = Path('/absolute/read-only/source.ply')
analysis = analyze_gaussian_ply(source)
Path('/absolute/isolated/analysis.json').write_text(json.dumps(analysis, indent=2))
```

运行环境：`PYTHONPATH=apps/api:. apps/api/.venv/bin/python <script>`。统计使用只读memmap、131072行块扫描、完整列精确percentile、32³中心占用直方图；这些不是去噪/聚类。读取logit opacity与log scale时只为统计转换为sigmoid/exp，不写回。

连续ROI Pilot：先官方Box提取包含完整局部结构与足够halo的控制组，再官方Floater处理控制组。禁止随机稀疏采样代替邻域测试。本轮源Box `(-70,15,290,-30,110,330)` 仅为试验包络，不是推荐裁剪边界。

```python
from workers.pipeline.cleanup_experiment import CleanupConfig, OfficialFilter, run_cleanup_experiment

config = CleanupConfig(
    experiment_id='CANDIDATE_FLOATERS_PILOT',
    filters=(OfficialFilter('floaters', (0.25, 0.1, 1 / 255)),),
    rationale='Reviewed continuous ROI, 10-unit lateral halo; ROI_ONLY, not full scene approval',
    gpu='0',
    timeout_seconds=300,
)
result = run_cleanup_experiment(
    Path('/absolute/isolated/control.ply'),
    Path('/absolute/new-isolated/CANDIDATE_FLOATERS_PILOT'),
    '<verified-64-character-lowercase-source-sha256>',
    config,
)
```

这些参数仅对应本轮Pilot；不得直接复用于其他模型或全场景。已有实验目录不可重跑覆盖，应使用新编号以保存失败证据。

## 4. 候选状态与审阅

输出：`candidate.ply`、`candidate-manifest.json`、`source-checksum.json`、`filter-config.json`、`cli-execution.json`、`quality-comparison.json`。

- CLI失败/超时/异常删除率/NaN或Inf/schema变化/保留行值改变 → `FAILED`。
- 显式记录主体损坏 `visual_review='REJECTED'` → `REJECTED`。
- 通过数值门禁但尚未人工批准 → **`WAITING_FOR_APPROVAL`**，不是保真PASS。
- 不接受 `APPROVED` 配置，不自动登记SceneVersion、切current version、重建Collision或触发发布。
- 删除率门槛默认最多10%，可为明确ROI提取显式调整；这不证明删除点都是废点。
- ≤2M行原/候选对比检查保留行多重集逐位一致（包含SH）；更大输入标 `unavailable`，不得冒称逐位验证。
- 同一源P01/P99范围32³占用格统计新增空格；不是孔洞自动判定器。视觉审批仍需保护植物细叶、草地、道路、玻璃和多对象结构。

四视角必须相同camera/target/FOV、world transform、exposure/tonemapping、分辨率和renderer；禁用官方默认animation，校验实际camera。若GPU CLI渲染失败，保留失败日志，使用相同官方Viewer/Engine；软件SwiftShader不得冒充RTX/PICO性能。

## 5. 本轮证据与下一步

私有根：`~/.local/state/gsplatform-vr00-20261011/vr01d/`，包含analysis/pilot/candidates/comparisons/reports/official。八张真实固定camera截图和contact sheet在`comparisons/`；CLI GPU渲染两次超时证据保留。模型不提交Git、不放公开HTTP目录；浏览器实验仅绑定127.0.0.1、结束后关闭。

本轮候选94,747→93,982、删除765（0.807413%），**HOLD_NOT_APPROVED / ROI_ONLY**。底部大残留仍在，193个被删中心位于内层review core，需Owner判断真实细草/叶片。未生成完整13M候选：`FULL_SCENE_CANDIDATE_NOT_EXECUTED`。

2026-10-13先按VR-01C指南收集PICO原场景A/B诊断JSON。Owner审阅截图后再决定是否另行证明全场景Floater、Editor手动裁剪或明确ROI。即使未来批准，也只能用清理源生成**新不可变版本**，保留原SceneVersion；本轮不实现这一发布步骤。

Backend存在既有2026-10-11日期夹具与2026-10-12实际创建时间冲突，全部门禁尚未通过，不提交/push交付分支。详见`docs/reports/VR_01D_GAUSSIAN_CLEANUP.md`。
