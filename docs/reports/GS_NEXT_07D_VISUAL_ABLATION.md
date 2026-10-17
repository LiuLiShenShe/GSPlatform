# GS-NEXT-07D — Building 可疑 Gaussian 单点局部视觉消融

日期：2026-10-17

## 结论与授权边界

- **最终结论：`VISUAL_EFFECT_CONFIRMED`**。删除一个已准确定位的 Gaussian 后，四个固定观察位姿均出现可见的外围弥散色雾变化；侧面左下和底部观察位姿中的大块雾状区域减少，整体斜视右下和正面下沿也有变化。中央强亮拖线和其他大片伪影仍然存在，不能把完整 Building 的底部模糊全部归因于这一个点。
- **删除授权：`HOLD_NOT_APPROVED`**。本结论只确认该点在诊断集合中的视觉贡献，不构成用户批准，也没有生成正式清理版本。
- **测试删除数量：1**。没有自动扩展到其他 Gaussian；不使用源行 `13011461`，本轮唯一目标是源行 `11183581`（0-based）。
- **适用范围：有限**。实验输入是从完整 Building 提取的 106,283 点非连续诊断集合，不是完整 13,090,324 点场景。因此结果证明的是该子集中的视觉贡献，不能直接等价为完整场景删除后的画质结论。

## 1. 工作区、版本和证据基线

开始前检查了 Git、当前工作区以及以下历史报告：

- `docs/reports/GS_NEXT_06_BUILDING_REUPLOAD_AB.md`
- `docs/reports/GS_NEXT_07_EDITOR_CLEANUP_PILOT.md`
- `docs/reports/GS_NEXT_07B_EDITOR_IMPORT_FIX.md`
- `docs/reports/GS_NEXT_07C_EDITOR_ROUNDTRIP.md`

初始 Git 状态为 `main...origin/main`，HEAD 为
`4f3b29355001e04c5cf8b710c067450e670e51d1`。本轮开始时没有未提交修改。

复用了 GS-NEXT-07C 已验证的本地集合和映射，没有重新抽取全量场景，也没有运行 GPU 转换：

| 项目 | 值 |
| --- | --- |
| 支撑集合 | `support-aware-106283-original.ply` |
| 支撑集合 SHA256 | `97105429ef4a2c54bc19d2d85f815811b2d9b7fd7e521ce4d557ec11d7ad36e3` |
| 集合规模 | `106,283` Gaussian，`62` 个 Float32 字段 |
| 映射文件 | `source-row-index-reasons.csv` |
| 本轮源行 | `11183581`（0-based） |
| 支撑集合行 | `159`（0-based） |
| Editor resource row | `106274` |
| 原始源 PLY | `13,090,324` 行，SHA256 `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` |

目标点的最大线性尺度约为 `83.387279`，opacity sigmoid 约为
`0.999994902`。这些数值只用于定位和解释潜在影响范围，没有被用作废点判定。

## 2. 官方 Editor 与实验方法

使用本机固定的官方 SuperSplat Editor `v3.5.2`：

| 项目 | 值 |
| --- | --- |
| 本机地址 | `http://127.0.0.1:18031/gaussian-editor/` |
| 上游 commit | `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b` |
| 运行时日志 | SuperSplat 3.5.2 / SplatTransform 3.9.0 / Engine 2.23.0 / PCUI 6.1.4 |
| 浏览器 | 系统 Google Chrome 145.0.7632.116，真实 X11 headful `DISPLAY=:1` |
| WebGPU | 可用，NVIDIA，Ampere，secure context |
| 画布 | `1500 x 934`；完整页面截图为 `1508 x 987` |

操作使用官方菜单和官方选择/编辑路径：

1. 点击官方 `File -> Import...`，导入已有 106,283 点 PLY。
2. 从 07C 保存项目的完整 target/相机距离与已记录观察方向重建四视角校准，使用未修改官方运行时的 `window.scene.camera` / `setPoseOverride` 固定完整 position、rotation、FOV、near/far。校准不是从两位小数直接猜测对齐，也没有修改磁盘上的相机配置。
3. 记录 A 原始集合截图、相机状态和状态栏计数；用重复 A 检查渲染稳定性。
4. 根据已验证映射选中唯一目标，确认选中项目映射回源行 `11183581`。
5. 在同一个隔离临时会话中只删除这一个 Gaussian，记录 B 截图。
6. 保持相机、FOV、SH、背景和渲染设置不变，记录四个 B 视角。
7. 执行官方撤销；分别验证“目标仍选中”和“中性未选中”状态。
8. 关闭浏览器并丢弃当前临时编辑状态。导出的 `.ssproj` 仅作为 Git 外私有审计证据，不是发布结果。

原始截图、审计项目和运行日志位于 Git 外：

`/home/test/.local/state/gsplatform-vr00-20261011/gsnext07d-run-20261017-experiment-08/`

便于人工审阅的对照页：

`/home/test/.local/state/gsplatform-vr00-20261011/gsnext07d-run-20261017-experiment-08/GS_NEXT_07D/index.html`

页面提供四视角并排 A/B、同位姿滑块、未经修图的完整页面原图、canvas 原图、撤销原图和派生差异热图。
`raw/` 中的 34 个 PNG 是原始截图的逐字节副本。`camera-poses.json` 保存完整相机/渲染状态，
`camera-audit.json` 保存同位姿核验，`project-audits.json` 保存映射审计，
`derived/metrics.json` 保存像素结果，`manifest.json` 保存原图 SHA256。

## 3. 相机一致性

共同 target 为：
`[68.04119873046874, -132.47932156920433, 324.1020736694336]`。

实际运行时读取的完整位置如下；报告中的两位小数是 Editor 显示值，不能替代这些实际记录：

| 视角 | 实际 Camera Position | 实际 rotation quaternion `[x,y,z,w]` | 显示值 |
| --- | --- | --- | --- |
| 整体斜视 | `[-157.2646026611328, -76.2961654663086, 549.4078979492188]` | `[-0.08052140881310554,-0.38122720627566886,-0.03335305927452848,0.9203638918140102]` | `[-157.26,-76.30,549.41]` |
| 侧面 | `[391.58709716796875, -132.4793243408203, 324.1020812988281]` | `[0,0.7071067811865475,0,0.7071067811865475]` | `[391.59,-132.48,324.10]` |
| 底部 | `[68.04119873046875, -456.0252380371094, 324.1020812988281]` | `[0.7071067811865475,0,0,0.7071067811865475]` | `[68.04,-456.03,324.10]` |
| 正面 | `[68.04119873046875, -132.4793243408203, 647.6480102539062]` | `[0,0,0,1]` | `[68.04,-132.48,647.65]` |

所有视角固定为 near `1`、far `542.1303597004459`、FOV `85`、aspect ratio
`1.6059957173447537`、tonemapping `linear`、SH3、黑背景；视图设置保留
`shBands=3`、`centersSize=2`、grid/bound/camera-info 与历史基线一致。A、B 和撤销阶段每个视角记录的 position、rotation、world transform、view matrix、projection matrix、near/far/FOV 完全一致，记录值的最大差为 `0`。

## 4. 目标定位和撤销审计

| 阶段 | Gaussian 数量 | 选中 | 删除 | 映射/审计结果 |
| --- | ---: | ---: | ---: | --- |
| 导入 A | 106,283 | 0 | 0 | 官方状态栏通过 |
| 目标选中、未删除 | 106,283 | 1 | 0 | selected sample row `[159]`，对应 source row `11183581`、resource row `[106274]` |
| B：删除目标 | 106,282 | 0 | 1 | missing sample row `[159]`；其余 62 字段逐位一致 |
| 撤销后目标选中 | 106,283 | 1 | 0 | target row 恢复，审计 PASS |
| 撤销后中性状态 | 106,283 | 0 | 0 | target row 恢复，审计 PASS |

关键项目文件 SHA256：

- 选中未删除：`f05853a1d789e75c464a4ddfe4640a13b63fb91d9fa6568bdac8951120080546`
- 删除后 B：`05bbfcfe541fbbbeb7d27ad2e22a6b5bee91f3142511903cd405661f248ad8e5`
- 撤销后中性：`6df180c184f53f5e6a4a758779c073a4ea069a55e1b8ce0e8ad6aa7b3a010e7b`

## 5. 四视角视觉结果

### 5.1 直接查看原图的视觉判断

以下判断来自当前模型直接查看真实原始 A/B/撤销截图及派生热图；未调用外部识图或绘图 API，也未代替用户人工审阅签署：

1. **是否形成明显模糊区域：是。** 目标点贡献了一层宽范围、低频的灰绿/青灰/棕色雾状覆盖；变化不只出现在选中轮廓或计数文字上。它不是中央所有强亮细长拖线的唯一来源，这些拖线在 B 中继续存在。
2. **底部/侧面模糊色块是否减少：是。** 侧面画面的左下灰绿色雾块消退，整体斜视右下的青灰色雾块消退，正面下沿的棕灰色雾块减少。从底部观察时，该点投影在画面上方及右侧，对应雾层消退后网格更清楚。观察位姿叫“底部”不等于变化一定处于屏幕下方。
3. **是否暴露有效结构：未能可靠确认。** 雾状区域减少后更多显示黑色背景、已有网格和已有细线；没有清晰、可独立确认的新建筑结构显露。
4. **是否产生新的空洞、颜色异常或主体损失：未看到明确新增的建筑轮廓破损。** 雾层处变暗或回到黑背景，不能直接称为“修复有效结构”，也不能由本集合保证它不含真实地表/背景信息；完整 Building 的主体安全性仍未证明。
5. **是否只在少数视角可见：不是。** 四个视角均有稳定且能定位的 A/B 差异；侧面和底部最容易识别，正面和整体斜视主要表现为外围雾层变化。
6. **撤销是否恢复：是。** 官方撤销恢复数量、选中状态和目标映射；排除固定 UI 区域后，A/撤销的最大通道差依次为 `0、1、2、1`，四个视角在阈值 ≥4 下的差异像素均为 0。

### 5.2 真实像素指标

以下完整指标来自未经修改的 `1500 x 934` canvas 区域截图，包含覆盖在画布上的官方 DOM UI。
`changed>=4` 表示 8-bit RGB 任一通道绝对差至少为 4；包围框为该阈值下的 `x1,y1,x2,y2`。
指标用于定位和复核，**不单独作为删除合理性的判据**。

| 视角 | A/B MAE | A/B RMSE | changed>=4 | A/B 变化包围框 | A/重复A MAE | A/撤销 MAE |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| 整体斜视 | 1.624081 | 8.577910 | 8.1665% | `[348,19,1480,933]` | 0 | 0.265433 |
| 侧面 | 3.373648 | 11.511401 | 13.9014% | `[118,502,730,933]` | 0 | 0.108358 |
| 底部 | 2.567849 | 8.126417 | 16.7820% | `[348,0,1499,901]` | 0.000004 | 0.108363 |
| 正面 | 1.860325 | 7.443731 | 10.7739% | `[348,706,1499,933]` | 0 | 0.108359 |

原图中的工具按钮高亮及右上视图图标也有变化，尤其使整体斜视的完整包围框扩展到右上。
因此另算排除固定 UI 矩形后的画面指标，不修改 A/B 原图，也不把 UI 变化归因于 Gaussian。
矩形定义公开保存在脚本与 `derived/metrics.json` 中；保留的 `1,144,811` 个像素包含场景、网格和包围框。

| 视角 | 排除 UI 的 A/B MAE | A/B RMSE | changed>=4（占保留像素） | 画面变化包围框 | A/重复A MAE | A/撤销 MAE |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| 整体斜视 | 1.574005 | 6.196622 | 9.1300% | `[804,527,1307,933]` | 0 | 0 |
| 侧面 | 3.584288 | 11.249349 | 15.4294% | `[118,502,730,933]` | 0 | 0.000000874 |
| 底部 | 2.902767 | 7.780756 | 19.2729% | `[357,0,1499,334]` | 0 | 0.000009609 |
| 正面 | 1.811983 | 6.232140 | 11.4598% | `[370,706,1499,933]` | 0 | 0.000004950 |

重复 A 的像素差为零或接近零，说明同一视角在本次会话中稳定。A/撤销的完整截图差异主要来自工具按钮和视图图标；排除这些固定 UI 后只剩最多 2 级通道差。项目审计、状态栏和画面恢复三者共同通过。

## 6. 资源安全与未修改项

- 只使用官方 Editor 本地浏览器工作流；没有启动服务器 GPU 转换、GPU Floater、完整 13M 渲染或发布流程。
- 没有使用 GPU1 执行任务。实验期间 GPU1 保持约 `14 MiB`，GPU0 约 `335–611 MiB`；GPU0 上的 `nvidia-smi` compute 记录属于本次 Chrome WebGPU GPU process，并按父进程链排除，未发现外部 compute 进程。
- 没有终止任何外部进程。现有本地 Editor 静态服务保持运行。
- 没有修改原始 PLY、SceneVersion、数据库、相机配置、发布文件或官方 Editor 源码/版本。
- 结束后核验支撑 PLY、07C 原项目和 Editor 版本文件的大小、inode、mtime、ctime、SHA256 均与基线相同；完整源 PLY 的大小、inode、mtime、ctime 未变，重新只读计算的 SHA256 与历史值一致。官方源码 checkout 仍为固定 commit 且工作区干净。
- 浏览器实验状态为 `PASS`，没有 page exception、失败请求或 WebGPU device lost。官方页面保留一条既有 CSP 对静态 inline script 的拦截日志；外部应用脚本和实验流程正常，不以“零 Console error”表述。
- 运行结束后浏览器已关闭，当前编辑状态丢弃；私有 `.ssproj`、原始截图和日志均不进入 Git。

## 7. 交付和复现脚本

Git 内只保留报告和小型 CPU/浏览器复现脚本：

- `scripts/gsnext07d_visual_ablation.mjs`：固定 Editor、相机、单点选择、删除、撤销和截图流程；要求显式传入已有输入、映射和相机基线。
- `scripts/gsnext07d_evidence.py`：CPU-only 的 62 字段、源行映射、selected/missing row 和 `.ssproj` 审计。
- `scripts/gsnext07d_analyze.py`：从真实截图生成 SHA256 清单、A/B/A-repeat/undo 像素指标和派生差异热图。

官方参考：

- [官方 Import and Export 指南](https://developer.playcanvas.com/user-manual/supersplat/editor/import-export/)
- [固定 SuperSplat 源码](https://github.com/playcanvas/supersplat/tree/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b)
- [固定实例映射格式](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/doc-instances.ts)

本轮完成的是**人工审阅前的真实视觉消融证据**，不是正式 Gaussian 清理。任何后续批量候选仍必须保持 `HOLD_NOT_APPROVED`，等待用户明确确认。

## 8. 回归验证

| 检查 | 结果 |
| --- | --- |
| `python3 apps/editor/editor.py verify` | PASS，固定构建身份与 artifact hash 一致 |
| `python3 apps/editor/editor.py health --port 18031` | PASS（独立于真实浏览器视觉门禁） |
| `workers/tests/test_splat_transform_adapter.py`、`test_cleanup_experiment.py`、`test_editor_export_validation.py` | `68 passed` |
| Web `src/__tests__/editor.test.tsx` | `6 passed` |
| 两个 Python 证据脚本编译、浏览器脚本 `node --check`、`git diff --check` | PASS |

原始 PNG、PLY、`.ssproj`、私有运行日志和对照页均留在 Git 外；本次提交不包含大型模型或私有截图原件。
