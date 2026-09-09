# Phase 07：FFmpeg、COLMAP 与 gsplat 异步重建

## 阶段目标

实现从视频或照片序列到可发布 3D Gaussian Splatting 场景的真实异步流水线：素材探测与抽帧、COLMAP 特征/匹配/稀疏重建、gsplat 训练、splat-transform 转换、Streamed SOG 校验与原子发布。免费计算页显示真实队列、阶段、进度、日志摘要、取消和失败建议。

## 前置条件

- [ ] `docs/reports/PHASE_06_REPORT.md` 存在且状态为 `PASS`。
- [ ] 上传会话、Celery job、原子发布与 Viewer 闭环可复现。
- [ ] 已安装并记录 FFmpeg、COLMAP、gsplat、splat-transform 的锁定版本。
- [ ] GPU、驱动、CUDA、显存和磁盘满足所选 gsplat 配置。
- [ ] 已准备有使用权、可公开记录摘要的真实视频和照片序列测试集。
- [ ] 已定义 CPU 队列与 GPU 队列以及 worker 并发上限。
- [ ] 已记录 Phase 07 开始前 commit。

## 禁止事项

- 禁止在 Web/API 请求进程中直接执行重建。
- 禁止把用户参数直接拼接成 shell 字符串。
- 禁止用定时器、预录日志或固定百分比冒充计算进度。
- 禁止 COLMAP 失败后仍启动训练并标记成功。
- 禁止用空模型、旧任务产物或示例模型替换当前任务结果。
- 禁止让不同用户任务共享可写工作目录。
- 禁止在日志/API 响应中泄露用户文件内容、绝对路径和敏感命令参数。
- 禁止无资源上限地并发运行 GPU 训练。
- 禁止无法真实训练时把阶段标为 PASS。
- 禁止自动 push。

## 纯文本架构草图

```text
ComputePage -> upload input -> Reconstruction Job
                                  |
                                  v
+-------------------- CPU queue ---------------------+
| PROBING -> EXTRACTING -> PRECHECK                  |
| FFprobe     FFmpeg       image count/quality       |
+-----------------------------+-----------------------+
                              |
                              v
+-------------------- CPU/GPU queue -----------------+
| FEATURES -> MATCHING -> MAPPING                    |
|              COLMAP                                |
+-----------------------------+-----------------------+
                              |
                              v
+-------------------- GPU queue ---------------------+
| TRAINING                                             |
| gsplat checkpoints / metrics / bounded resources   |
+-----------------------------+-----------------------+
                              |
                              v
+-------------------- publish pipeline --------------+
| CONVERTING -> VERIFYING -> PUBLISHING              |
| splat-transform -> Streamed SOG -> atomic version  |
+-----------------------------+-----------------------+
                              |
                              v
                     My Works -> Viewer
```

### 免费计算任务页

```text
+----------------------------------------------------------------------------------------+
| 免费计算                                                                               |
| 1 上传素材  --------  2 参数确认  --------  3 排队与计算                               |
|                                                                                        |
| 任务 #短编号                  状态：训练中                                              |
| [################---------] 61%   当前阶段：gsplat TRAINING                            |
| 已用 00:34:12   最近更新 3 秒前   队列/GPU：gpu-standard                              |
|                                                                                        |
| 阶段                                                                                   |
| [x] 素材探测  [x] 抽帧  [x] 特征  [x] 匹配  [x] 稀疏重建  [ ] 训练  [ ] 转换  [ ] 发布 |
|                                                                                        |
| 安全日志摘要                                                                           |
| 10:32 已注册 182 / 190 张图像                                                          |
| 10:41 训练迭代真实进度 ...                                                             |
|                                                           [请求取消] [关闭页面]        |
+----------------------------------------------------------------------------------------+
```

## 详细 Checklist

### A. 工具与运行环境

- [ ] 实际运行 `ffmpeg -version`、`ffprobe -version`、COLMAP、gsplat、splat-transform 版本命令。
- [ ] 在报告中记录 GPU、驱动、CUDA、显存和可用磁盘。
- [ ] worker 启动时执行 capability check，不满足时不消费对应队列。
- [ ] gsplat 集成版本由 Python lock/commit 固定，不依赖浮动分支。
- [ ] 外部工具路径来自可信配置，生产不搜索用户可写目录。
- [ ] 每个任务记录工具版本、profile、输入摘要和可复现参数。

### B. 输入与预检

- [ ] 视频通过 ffprobe 真实读取编码、时长、分辨率、帧率、旋转和音轨信息。
- [ ] 照片序列验证数量、格式、尺寸、损坏文件和元数据方向。
- [ ] 拒绝时长、像素、帧数、文件数或总字节超限的输入。
- [ ] 输入只读挂载/访问，所有派生产物写入 job 专属目录。
- [ ] 预检报告给出可处理、警告或拒绝及稳定错误码。
- [ ] 低质量输入不得静默产生“成功”空场景。

### C. FFmpeg 抽帧

- [ ] 视频按 quality profile 选择可解释的抽帧率/最大帧数。
- [ ] 正确应用视频旋转和像素格式，保留纵横比。
- [ ] 输出文件使用服务端连续编号，不使用媒体原始文件名。
- [ ] 抽帧后验证实际图片数、尺寸、可读性和总大小。
- [ ] 可选的模糊/重复过滤必须记录阈值与保留数量。
- [ ] 进度来自 FFmpeg 可解析的真实时间/帧输出。
- [ ] 取消可终止 FFmpeg 子进程及其子进程组。

### D. COLMAP

- [ ] 为照片数量/类型选择明确的特征提取与匹配策略。
- [ ] COLMAP 数据库和 sparse 输出位于 job 专属目录。
- [ ] 特征提取、匹配、mapping 每步检查非零退出码和预期产物。
- [ ] 校验已注册图像数、点数、reprojection error 和相机模型。
- [ ] 注册率或几何质量低于阈值时安全失败并给出建议。
- [ ] COLMAP GPU/CPU 参数与可用设备一致，不盲目启用不存在的 GPU。
- [ ] 实际命令以当前版本 `-h/--help` 验证，并通过 argv 执行。
- [ ] 取消或超时能终止 COLMAP 并保存安全诊断摘要。

### E. gsplat 训练

- [ ] 将 COLMAP 输出转换为锁定 gsplat 训练入口所需结构。
- [ ] profile 明确 iterations、分辨率、评估间隔、保存间隔和资源预算。
- [ ] 训练脚本使用 job ID 独立输出目录和随机种子记录。
- [ ] 进度来自真实迭代、loss/metric 和 checkpoint 事件。
- [ ] 训练定期保存 checkpoint，写入采用临时文件后原子改名。
- [ ] 支持在兼容版本和参数下从最近有效 checkpoint 恢复。
- [ ] 检测 NaN/Inf、显存不足、设备错误和磁盘不足并分类失败。
- [ ] 最终导出真实 splat 产物，校验 splat 数、bounds 和有限数值。
- [ ] 取消在安全点停止，保存或删除 checkpoint 由明确策略决定。

### F. 转换、校验与发布

- [ ] 使用锁定的 splat-transform/Phase 04 脚本生成真实 Streamed SOG。
- [ ] 生成 Poster、manifest、build-info 和 checksums。
- [ ] 验证所有索引/分片、哈希、bounds、初始相机和 low 首帧。
- [ ] 使用 Phase 06 的不可变版本与原子发布服务。
- [ ] 数据库只在资产完整后指向新 current version。
- [ ] 发布成功后 Scene 状态与 Job 状态在同一可恢复工作流中更新。
- [ ] Viewer smoke test 真实加载新版本，而不是旧缓存版本。

### G. Celery 编排与幂等

- [ ] CPU 与 GPU 队列分离，路由规则和并发数受配置控制。
- [ ] 每个阶段可重入或通过完成标记安全跳过已验证产物。
- [ ] 完成标记包含输入哈希、参数哈希、工具版本和产物哈希。
- [ ] task 重试只针对可重试错误，业务输入错误不重试。
- [ ] worker lost、超时和重复投递不会并行写同一阶段目录。
- [ ] job 状态转换使用条件更新/锁防止倒退。
- [ ] 取消请求在每个阶段边界和长任务进度回调中检查。
- [ ] 失败重跑创建新 attempt 并保留关联，不覆盖原诊断。

### H. Web 任务体验

- [ ] 免费计算页从服务端能力获取格式、配额和可用 profile。
- [ ] 用户确认素材权利后才能真实提交。
- [ ] 队列位置如无法准确提供则不显示伪数字。
- [ ] 展示真实 job stage、0~100% 或阶段型不确定进度。
- [ ] 刷新、离开、重连后从 API 恢复同一 job 状态。
- [ ] 安全日志摘要只展示允许字段，不直接透传原始 stderr。
- [ ] 取消是请求状态，并在 worker 确认后显示 CANCELLED。
- [ ] 成功后可进入“我的作品”和 Viewer；失败给出对应修复建议。

### I. 安全、配额与清理

- [ ] 每用户并发数、每日任务数、输入字节、GPU 时长有服务端约束。
- [ ] 路由、文件目录、Celery task、job 查询均校验 owner。
- [ ] 子进程限制运行时、CPU、内存、打开文件数和输出日志大小。
- [ ] 训练 worker 使用非特权账户，任务目录不能访问秘密目录。
- [ ] 失败/取消/过期任务按保留策略清理输入、中间文件与 checkpoint。
- [ ] 已发布当前版本不会被中间文件清理任务删除。
- [ ] 清理操作有 dry-run、精确根目录校验与审计日志。

### J. 真实验收与收尾

- [ ] 使用真实视频完整跑通到 Viewer。
- [ ] 使用真实照片序列完整跑通到 Viewer。
- [ ] 记录各阶段耗时、峰值 CPU/RAM/VRAM/磁盘和输出大小。
- [ ] 真实测试取消、worker 中断恢复、坏输入、COLMAP 低注册率、GPU OOM。
- [ ] API、worker、Web、Viewer 的测试和构建全部成功。
- [ ] 生成 `docs/reports/PHASE_07_REPORT.md`。
- [ ] 执行三项 Git 自检并创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### 任务状态机

```text
QUEUED
  -> PROBING
  -> EXTRACTING
  -> PRECHECK
  -> FEATURES
  -> MATCHING
  -> MAPPING
  -> TRAINING
  -> CONVERTING
  -> VERIFYING
  -> PUBLISHING
  -> SUCCEEDED

任意活动阶段 -> CANCEL_REQUESTED -> CANCELLED
任意活动阶段 -> FAILED(error_code, safe_message, retryable)
```

### 进度聚合

不同阶段权重由 profile 版本化配置。阶段内部只有在能从工具获得可信工作量时才给精确百分比：

- FFmpeg：已处理媒体时间 / 总时长或帧数。
- COLMAP：可解析的已处理图像/匹配对；不可确定的 mapping 显示阶段型进度。
- gsplat：当前真实 iteration / 配置 iterations。
- 转换：实际读取/写入与分片校验进度。
- 发布：每个原子步骤完成事件。

如果某工具版本无法提供可信分母，UI 必须显示“不确定进度 + 已运行时长”，不能填造百分比。

### 子进程执行器

实现统一 `CommandRunner`：

```text
executable allowlist
argv list only
working directory fixed to job root
sanitized environment
timeout + terminate + kill grace period
bounded stdout/stderr capture
structured progress parser
exit code and artifact checks
```

### 工作目录

```text
/srv/gsplatform-data/jobs/<job-id>/attempt-<n>/
|-- input/          只读或受控输入
|-- frames/
|-- colmap/
|   |-- database.db
|   `-- sparse/
|-- gsplat/
|   |-- checkpoints/
|   `-- export/
|-- streamed-sog/
|-- logs/           限长、权限受控
`-- stage-state/    原子完成标记
```

### 质量 profile

建议以版本化配置提供 `draft`、`standard`、`high`，每个 profile 明确最大输入、抽帧策略、COLMAP 策略、训练 iterations、资源上限和输出目标。不得在 UI 宣称“免费高质量”但后端实际使用未记录的降质配置。

## 关键目录 / 文件

```text
workers/
|-- celery_app.py
|-- routing.py
|-- tasks/reconstruct_scene.py
|-- reconstruction/
|   |-- orchestrator.py
|   |-- state_machine.py
|   |-- command_runner.py
|   |-- probe.py
|   |-- extract_frames.py
|   |-- colmap_pipeline.py
|   |-- train_gsplat.py
|   |-- convert_streamed_sog.py
|   |-- quality_gate.py
|   |-- progress.py
|   `-- profiles/
|       |-- draft.yaml
|       |-- standard.yaml
|       `-- high.yaml
`-- tests/

apps/api/app/api/v1/compute.py
apps/api/app/services/reconstruction_service.py
apps/web/src/features/compute/
scripts/reconstruct_scene.sh
scripts/check_reconstruction_capabilities.sh
```

## 运行命令

先真实检查工具能力：

```bash
ffmpeg -version
ffprobe -version
colmap -h
splat-transform --version
./scripts/check_reconstruction_capabilities.sh
```

启动独立队列：

```bash
python -m celery -A workers.celery_app worker -Q cpu --loglevel=INFO --concurrency=2
python -m celery -A workers.celery_app worker -Q gpu --loglevel=INFO --concurrency=1
```

命令行执行一次真实重建：

```bash
./scripts/reconstruct_scene.sh \
  --input /data/authorized/sample-video.mp4 \
  --scene-id reconstruction-test \
  --profile standard
```

## 验收标准

- 一段真实视频与一组真实照片分别通过完整流水线并生成不同的当前 SceneVersion。
- FFmpeg、COLMAP、gsplat、splat-transform 均真实执行，有版本、参数和产物证据。
- 新 Streamed SOG 在 Viewer 冷缓存下实际加载且首帧可辨识。
- 进度和日志来自真实工具事件；未知工作量显示不确定进度。
- 取消、worker 中断恢复、重复投递不造成成功状态错误或目录并发破坏。
- 坏输入、COLMAP 低注册率、GPU OOM、磁盘不足产生正确错误码和安全建议。
- CPU/GPU/磁盘/时长配额真实生效；用户之间目录与 job 不可互访。
- 如果环境无法运行一次完整 gsplat 训练，本阶段必须保持未通过并记录 blocker。

## 自测命令

```bash
./scripts/check_reconstruction_capabilities.sh
python -m ruff check apps/api workers
python -m mypy apps/api/app workers
python -m pytest -q apps/api/tests workers/tests
pnpm --filter @gsplatform/web lint
pnpm --filter @gsplatform/web typecheck
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
pnpm --filter @gsplatform/web test:e2e --grep "free compute"
./scripts/reconstruct_scene.sh --input <真实测试视频> --scene-id e2e-video --profile draft
./scripts/reconstruct_scene.sh --input <真实照片目录> --scene-id e2e-images --profile draft
./scripts/verify_published_scene.sh <视频场景 manifest>
./scripts/verify_published_scene.sh <照片场景 manifest>
git status
git diff --stat
git diff
```

## 必须产物

- CPU/GPU 队列、能力检查和资源限制配置。
- 可恢复、幂等、可取消的重建状态机与 CommandRunner。
- FFmpeg、COLMAP、gsplat、splat-transform 完整实现及版本化 profiles。
- 免费计算页真实任务状态、进度、日志摘要和错误建议。
- 视频与照片两条真实端到端重建证据及资源测量。
- `docs/reports/PHASE_07_REPORT.md`。
- 一个仅包含 Phase 07 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 数据集 / 硬件 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P07-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_07_REPORT.md`：

```markdown
# Phase 07 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：

## 环境与工具

- OS / CPU / RAM / Disk：
- GPU / Driver / CUDA / VRAM：
- FFmpeg / COLMAP / gsplat / splat-transform：
- Worker queues / concurrency：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 真实视频重建

| 阶段 | 耗时 | 峰值资源 | 关键产物 / 指标 | PASS/FAIL |
|---|---:|---|---|---|
|  |  |  |  |  |

## 真实照片序列重建

| 阶段 | 耗时 | 峰值资源 | 关键产物 / 指标 | PASS/FAIL |
|---|---:|---|---|---|
|  |  |  |  |  |

## 取消、恢复、失败与配额测试

## Viewer 冷缓存验证

## 自动测试命令与结果

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 08 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 07 的独立执行 Agent。阅读全局规则、总计划、docs/PHASE_07_RECONSTRUCTION.md，确认 docs/reports/PHASE_06_REPORT.md 为 PASS。门禁失败立即停止。

严格实现异步重建：FFprobe/FFmpeg 探测与抽帧，COLMAP 特征/匹配/mapping，gsplat 真实训练，splat-transform 转换为 Streamed SOG，Phase 06 原子发布。使用 CPU/GPU 分队列、job 专属目录、固定 argv CommandRunner、资源/超时/日志上限、阶段完成标记、checkpoint、取消与幂等恢复。先执行各工具版本和能力检查，所有准确参数以锁定版本 --help 和测试为准。

进度只能来自 FFmpeg 时间/帧、COLMAP 可解析工作量、gsplat 真实 iteration、转换字节和发布事件；没有可信分母就显示不确定进度。不得用旧场景、空模型、定时器或预录日志冒充。使用有权素材的真实视频和照片序列各完整跑一次到 Viewer，并测试取消、worker 中断、坏输入、低注册率、GPU OOM、磁盘不足、重复投递和跨用户权限。

若 GPU/驱动/工具不足导致无法完成真实训练，保持相关项 [ ]，Report 标记 BLOCKED/FAIL，不能 PASS。成功项也只有真实验证后才改 [x]。生成 docs/reports/PHASE_07_REPORT.md，执行 git status、git diff --stat、git diff。仅 PASS 时创建 Phase 07 独立 commit，不 push。最终汇报两条流水线指标、资源峰值、Viewer 结果、失败测试、未完成项、报告路径和 commit hash。
```

