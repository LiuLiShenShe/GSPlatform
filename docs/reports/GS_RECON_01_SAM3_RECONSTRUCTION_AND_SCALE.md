# GS-RECON-01：SAM3 提示词重建与官方尺度标定验收

最终结果：真实照片上传 → SAM3 提示词掩膜 → COLMAP → 掩膜约束 30,000 次 3DGS → SOG 发布 → 自动 Edit → 官方 Measure 统一缩放 → PLY 回传 → 独立新版本 → 重新拾取复测已完成。20 mm 标定边复测为 **19.8866299 mm**，绝对误差 **0.1133701 mm**，相对误差 **0.5668504%**。尺度记录为 **ASSUMED**；未伪造 VERIFIED，未启用物理 Walk。

本报告的 PASS 对应本机隔离环境的实际验收，不表示已部署到生产，也不表示官方编辑器提供了签名测量证明。

## Git 与隔离范围

| 项目 | 身份 |
| --- | --- |
| 初始 main HEAD | `1144b361d940a1afb5cd915543f1a4033768b8e4`，初始工作区干净 |
| A：SAM3、训练与参数持久化 | `e1ea28048ae3999c888974f77b446ae83845df7b` |
| B：Compute 与自动 Edit | `48ff8b92989b1f28a2aa903ae982c47d25d52c9e` |
| C：官方标定闭环及部署修复，最终代码提交 | `406c3306783ad4424e69c96772cc5bc4ae8e97b0` |
| 报告补记提交 | 紧随 C 的文档提交；完整交付 HEAD 保存在证据目录 `delivery-receipt.json` |

工作目录 `/fj/GSPlatform`。正式真实验收数据库为 `gsrecon01_acceptance`，回归使用 `gsrecon01_test` 与新建的 `gsrecon01_finaltests`；Redis 为独立 `127.0.0.1:18042`。证据根目录为 [/fj/GSPlatform-evidence/GS_RECON_01](/fj/GSPlatform-evidence/GS_RECON_01)。未清空共享任务队列，未改写历史 13M Building 资产。只使用 GPU0，未终止或修改其他用户的 GPU1 任务。

## 模型与官方组件身份

| 项目 | 实际身份 |
| --- | --- |
| SAM3 源码 | `/data/fj/Pheno-MCMC/repos/sam3` |
| 官方 commit | `6dbb02bd38288df755dfa1378000a861e65b84f6`，无跟踪修改 |
| checkpoint | `/data/fj/F2DMAS/sam3/sam3.pt` |
| checkpoint SHA-256 | `9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e` |
| SAM3 Python | `/home/test/.venvs/sam3/bin/python`，3.12.3 |
| SAM3 PyTorch / CUDA | `2.10.0+cu128` / 12.8 |
| 训练 Python | `/fj/GSPlatform/apps/api/.venv/bin/python`，3.11.15 |
| gsplat / PyTorch | `1.5.3` / `2.14.0+cu126`，未修改官方库源码 |
| 最近邻初始化 | SciPy `1.16.1`，requirements / pyproject / uv.lock 锁定 |
| SuperSplat Editor | v3.5.2，commit `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`，官方源码未修改 |
| Editor 构建身份 | `e994c6c327c5e4d3898d25c0ff649ecf3d1cd16efc625faecb9a904a7db188ab` |
| SOG 转换 | 既有固定官方 splat-transform `3.3.3`，保留全部 Gaussian 与 SH2 |
| 浏览器 | headed Chrome `145.0.7632.116`，隔离 Xvfb，实际 WebGPU |
| 物理 GPU | NVIDIA RTX A6000 GPU0，PCI `0000:18:00.0` |

SAM3 使用本机官方 `build_sam3_image_model` / `Sam3Processor.set_image` / `set_text_prompt`。独立 Python 子进程通过磁盘传递真实掩膜，未将 SAM3 强行安装进 gsplat 环境，也未升级既有模型。

2DGS 已找到并验证现有扩展导入：`/data/fj/F2DMAS/2d-gaussian-splatting-main`，Python 3.12.3、PyTorch `2.5.1+cu121` / CUDA 12.1，`diff_surfel_rasterization`、`simple_knn._C` 可用，已有掩膜损失。修正后的 3DGS 已取得清晰原生视角输出并完成标定；**本次未切换到 2DGS，也未声称已经集成该后端**。

## 复用的链路与最小连接层

复用既有断点上传、Job、CPU/GPU Celery、COLMAP、gsplat rasterization、转换校验发布、SceneVersion、授权 Editor Session、官方 Viewer。没有建立第二套上传、训练、发布或表面拾取工具。

- `apps/api/app/db/models/job.py` 与迁移 `e6a701000001_reconstruction_parameters.py`：既有 Job 增加 JSONB 参数，持久化上传身份与分割设置。
- `apps/api/app/schemas/compute.py`、`services/reconstruction_service.py`：旧请求默认 OFF；严格验证非空提示词、上传所有权、活动任务复用。首次场景创建使用数据库原子插入，避免并发唯一键冲突。
- `workers/reconstruction/segmentation.py`、`sam3_infer.py`：本机官方推理、所有匹配实例并集、模型及帧/掩膜哈希、预览、真实统计、可恢复清单。
- `state_machine.py`、`orchestrator.py`、`tasks/reconstruct_scene.py`、profiles：MAPPING 后进入可观察、可恢复的 SEGMENTING；CPU→GPU→CPU 调度保留。实际训练串行于 SAM3 之后，不同时驻留两套模型。
- `masked_training.py`、`train_gsplat_script.py`：EXIF 转正；RGB / 掩膜共同畸变校正；前景 RGB、前景 alpha、背景透明约束；多视角筛选初始化高斯。
- `command_runner.py`：输出读取线程自行关闭流，避免进度回调与 stdout 提前关闭竞争。
- Jobs API / service：所有者真实预览；解析已发布版本、slug 与受控资源，成功只对应发布完成。
- `ComputePage.tsx`、`computeApi.ts`：模式、提示词、数量、档位、进度、实际预览、恢复与成功后自动进入对应 Edit。上传最多三个并发会话。
- `GaussianEditorPanel.tsx`、`AuthoringWorkspace.tsx`、`SceneAuthoringPage.tsx`、`editorApi.ts`：尺度入口、官方会话、PLY 回传、新版本独立复测和测量记录。草稿绑定源版本及会话，防止误用别的模型的读数。
- Editor calibration schema / endpoint / service：结果必须是该会话完成发布且仍为当前的独立版本；绑定源/结果、导出哈希、用户/时间、世界变换、误差、证据哈希。统一米制，`metersPerSceneUnit=1`，不叠加 WorldScale。
- `repositories/authoring.py`：首次 presentation 原子创建，修复实际并发浏览器请求触发的 500。
- `apps/editor/editor.py` / README / browser gate / Nginx：独立官方 Editor 的 CSP 修复及真实数字变换回归；官方源码和构建未改变。

所有文件可通过 `git show --stat` 查看 A/B/C 的完整清单。

## 真实输入、SAM3 与掩膜证据

原始照片来自 `/data/fj/Pheno-MCMC/data/01-FFmepg/XianKeLai1`，每五帧选一张，共上传 50 张，内容去重后 49 张。已知标定长度依据本机 `/data/fj/Pheno-MCMC/data/XianKeLai1/marker/detections.json` 中 `true_side_mm: 20.0`。

实际提示词 `potted plant; blue cube`。多个概念以分号或换行分隔，逐概念调用官方 SAM3 并合并所有匹配实例。单独不合适的提示没有有效输出时明确失败，没有静默改成 OFF。COLMAP 使用完整图像，SAM3 放在相机重建之后，训练真正读取其前景掩膜。

标准任务实际 SAM3 推理 48.02358 秒，49/49 有效掩膜，1280 宽度，峰值分配显存 5,468,738,560 字节。草稿独立推理 311.757 秒。每帧输出包含名称、尺寸、前景像素、置信信息、模型和图像/掩膜哈希。恢复时必须精确匹配。

掩膜、原图、预览在 `storage/jobs/5a1ecdf9-b4d2-4f3f-b758-e68b876d13ba/attempt-1/segmentation/`；[真实页面掩膜与训练进度](/fj/GSPlatform-evidence/GS_RECON_01/30k-masks-and-progress.png)。canonical PNG 已物理应用 EXIF 方向；COLMAP、SAM3 使用相同文件，训练使用相同相机映射共同校正 RGB 与掩膜。

## 30,000 次训练、质量问题与发布结果

之前展示的模糊结果实际为 **1,200 次草稿**。原标准档为 8,000 次，只有高档为 30,000 次。核查还发现旧训练器使用不合理的共同基准学习率、缺少位置衰减、初始高斯尺度过小；增加计数本身不能修复这些问题。

训练器版本 3 对照锁定版官方 gsplat 示例，使用位置学习率 `0.00016 * scene_scale` 并衰减到初值 1%，scales 0.005、quaternions 0.001、opacity 0.05、SH0 0.0025、SHN 0.000125、Adam eps 1e-15；尺度由三个最近邻的距离 RMS 初始化，SH 每 1,000 次逐级启用。去除每迭代清空 CUDA cache。标准档已改为完整 30,000 次，profile/trainer hash 升级，不能复用旧训练身份。

| 项目 | SAM3 标准 | OFF 标准 |
| --- | --- | --- |
| Job | `5a1ecdf9-b4d2-4f3f-b758-e68b876d13ba` | `47a2b593-62c1-4152-9c3b-c0610f307d2f` |
| 状态 | SUCCEEDED | SUCCEEDED |
| 注册相机 / 训练视角 | 43 / 43 | 43 / 43 |
| 实际完成训练迭代 | 30,000 | 30,000 |
| COLMAP → 训练初始点 | 6,987 → 5,576 | 7,035 → 7,035 |
| 最终 Gaussian | 537,442 | 655,631 |
| 最终 loss | 0.0129628377 | 0.0131838145 |
| 训练耗时 | 1278.9845 s | 1280.4998 s |
| 训练峰值分配显存 | 864,336,384 bytes | 974,005,248 bytes |
| 发布版本 UUID | `91492031-ab6a-4808-bd89-4d0e614acc05` | `b5593aed-456a-460b-ae40-70c90a25f21e` |
| 资产版本 | `49e7e9ed2467` | `97300826878c` |
| SOG 字节 | 9,004,970 | 10,014,063 |

Masked loss 分量：foreground RGB 0.0090734661、foreground alpha 0.0008793940、background alpha 0.0185674652。真实 checkpoint 最后索引 29999，对应 **30,000 次完成**，不是只修改配置数字。

三个原生训练视角的前景 PSNR 为 31.54 / 28.78 / 30.16 dB，alpha IoU 为 0.950 / 0.933 / 0.934；这些是训练视角的质量诊断，不能解释成独立测试集泛化指标。已直接查看原图/渲染/alpha 并排图：[视角 0](/fj/GSPlatform-evidence/GS_RECON_01/standard-v3-final-render-0.png)、[视角 14](/fj/GSPlatform-evidence/GS_RECON_01/standard-v3-final-render-14.png)。叶片纹理和标定块边界明显改善；极近距离放大会暴露图像分辨率及高斯表面误差，不能承诺任意放大仍如真实照片。

SOG CPU SH 编码曾连续超过 Celery 3300 秒软时限，训练产物完整保留。修复重建阶段未透传既有 `GS_CONVERT_GPU` 配置后，仅从 CONVERTING 恢复，官方 WebGPU 编码约 13.877 秒；全部高斯与 SH2 保留，SH iterations 仍为 10，未为提速截断 SH 或降采样。完成标记包含实际后端身份。默认仍是 CPU，GPU 编码需要部署方明确保留设备资源。

CPU worker 的 Vulkan 使用 NVIDIA ICD 与 `DRI_PRIME=pci-0000_18_00_0!` 限定 GPU0，不能用 `CUDA_VISIBLE_DEVICES` 代替 WebGPU 设备选择。转换 build-info 保存实际 `webgpu` / NVIDIA adapter 记录。GPU1 的其他用户进程未触碰。

[官方 Editor 中的 OFF 全场景](/fj/GSPlatform-evidence/GS_RECON_01/off-standard-30000-official.png) 包含背景；[masked 官方画面](/fj/GSPlatform-evidence/GS_RECON_01/standard-official-colmap.png) 仅保留植物、花盆与蓝色块，少量边缘残影仍可见。旧 OFF / masked 草稿也实际成功发布，旧资产保持。

## 自动 Edit 与官方 Measure 闭环

真实标准任务发布后，Compute 自动导航至 `/model/edit/r-226ffa0fc2e1?workspace=calibration&version=91492031-ab6a-4808-bd89-4d0e614acc05`，见 [截图](/fj/GSPlatform-evidence/GS_RECON_01/standard-30000-auto-edit.png) 与同名 JSON。重建 Scene UUID、公开 slug、发布版本 UUID 通过后端结果解析，未猜路由，未把 TRAINING 完成当发布成功。

1. 平台创建源版本 `49e7e9ed2467` 的授权官方 Editor Session `3b80aa13-79d2-4ea8-a382-efa52845affb`，加载完整 537,442 个高斯。
2. 在官方 Measure 中实际两次鼠标点击蓝色立方体可见面的左边，原距离 **0.227807467770239 个场景单位**。端点和世界矩阵以只读 CDP 诊断导出；没有注入测量端点或修改官方运行逻辑。
3. 官方长度框输入 **0.02 m**，围绕两点中点对整个 Splat 统一缩放，实际倍率约 **0.0877934345**。
4. 从官方菜单导出未压缩 PLY，81,692,136 字节，SHA-256 `4219ce0104a5a2b4a508a2d266ff4aa19915fa40ff49424300226e1ca750cb3f`。
5. 通过平台既有编辑上传会话回传、校验、转换与原子发布，新版本 UUID **`d444c490-209f-4f93-9387-542228b888f4`**，资产版本 **`ca7c7b872da6`**。
6. 从平台点击「打开新版本进行独立复测」，新会话 `b893c519-1fb4-4962-80a8-689b788f4998` 初始测量点为空。仅导入变换后的相机取景记录，未传入原测量点；重新两次实际点击 `(521,557)` 与 `(679,855)`。
7. 独立读数 **0.019886629916097905 m**；误差为 **0.00011337008390209513 m / 0.5668504195%**。没有以输入框等于 0.02 替代独立复测。

[原始测量](/fj/GSPlatform-evidence/GS_RECON_01/standard-original-measure-final.png)、[实际整体缩放](/fj/GSPlatform-evidence/GS_RECON_01/standard-scaled-measure-final.png)、[新版本独立复测](/fj/GSPlatform-evidence/GS_RECON_01/standard-independent-remeasure.png)、[平台保存标定](/fj/GSPlatform-evidence/GS_RECON_01/standard-calibration-saved.png)。同目录 JSON 保存实际三维点与矩阵，读数精度高于官方界面两位小数显示。

完整高斯数值验证见 [standard-uniform-scale-validation.json](/fj/GSPlatform-evidence/GS_RECON_01/standard-uniform-scale-validation.json)：前后均 537,442 个，高斯位置仿射拟合三个奇异值为 0.08779343248 / 0.08779343217 / 0.08779343136，最大位置残差 2.395e-7，三个 log-scale 的最大差值误差均 6.911e-7，opacity 保持一致。没有单轴拉伸，也没有再叠加一次平台 WorldScale。

### 实测发现并修复的 CSP 阻塞

最初 Editor 服务 CSP 只允许 `wasm-unsafe-eval`；官方 PCUI NumericInput 使用 `Function()` 解析经过限制的算术字符串。输入真实长度会被静默恢复，实际几何未缩放。该次未缩放导出没有作为成功证据，测试发布已回滚，文件改名为 `csp-blocked-unscaled-export.ply` 保留诊断。

仅独立 Editor 页面允许 `unsafe-eval`，仍限制脚本源为 self、第三方连接被 connect-src 阻止。主应用 CSP 保持原策略。生产 Nginx 新增独立 Editor 路由，避免叠加主应用 CSP；已通过隔离 `nginx -t`。官方源码与构建不变。浏览器 gate 增加实际数值缩放及恢复检查；真实 OFF 版本也执行了 0.9 → 1 的数字输入回归，见 `official-numeric-input-regression.json`。

## 标定证据、版本与空间安全

证据绑定源/结果版本、官方编辑会话、导出 SHA-256、Editor commit/build、标定用户和 UTC 时间、真实单位/长度、原距离、统一倍率、独立复测值、误差、世界变换身份与证据 SHA-256。最新持久化证据见 [standard-calibration-final.json](/fj/GSPlatform-evidence/GS_RECON_01/standard-calibration-final.json)。普通页面转录没有官方公开 attestation，因此诚实保存 `USER_TRANSCRIBED_OFFICIAL_EDITOR / ASSUMED`。

`metersPerSceneUnit=1`，`transformIdentity=identity`，`physicalWalkAllowed=false`，`collisionPolicy=MANUAL_ONLY`；Collision 没有自动构建。Viewer 对物体级小场景仍显示既有的小尺度提示，地面行走不可用；该提示不能解释成 PLY 没有缩放，也不代表已有 VERIFIED 物理尺度。

真实缩放前创建初始相机、Viewpoint、Annotation。发布后作者行全部保留，但版本状态 STALE，三个功能在 pendingFeatures 中，runtime 相机置空、视角/标注列表为空。之后按缩放后的坐标通过既有作者接口显式重建绑定，运行态才重新显示。最终作者数据无删除、无旧坐标静默启用。相关记录：`standard-authoring-before.json`、`standard-authoring-after.json`、`standard-spatial-rebinding.json`。

真实执行新版本 → 原 30,000 次版本 → 新标定版本的回滚与恢复，源版本资产哈希与训练输出一致：

- masked 源 SOG：`5bc1a8d7c877b0b2ee86373c77c8c6591a2d2a56318c5cc59e96d5932ba040b9`。
- OFF 源 SOG：`42cf648329c05033926d19da72d03772792c3b9a859a97b7bde489cc547f6320`。

见 `standard-rollback-validation.json` 与 `standard-jobs-and-immutable-sources.json`。本次隔离 masked 场景已改为 PRIVATE：无缓存匿名新请求/API 直连 401，其他用户资产/版本/编辑会话 403，缺 CSRF 的写入 403。初始 PUBLIC 资产此前可能已缓存，不能撤回已公开分发的字节；权限检查使用新请求，详见 `standard-permissions.json`。

最终 [正式 Viewer](/fj/GSPlatform-evidence/GS_RECON_01/standard-final-viewer-whole.png) 与 [Edit](/fj/GSPlatform-evidence/GS_RECON_01/standard-final-edit.png) 使用新版本 `ca7c7b872da6`。实际 WebGPU 加载 537,442 个高斯，无 Viewer 错误；世界变换为 identity，Walk disabled。证据浏览器无 pageerror，见 `final-browser-identity.json`。

## 回归与真实验收证据

| 检查 | 实际结果 / 日志 |
| --- | --- |
| API 全量 | `api-full-30k.log`：636 passed / 4 failed；4 项因发布检查脚本归档旧 HEAD，不是新迁移。提交 A 后单独复跑 `release-preflight-final.log`，5 passed，exit 0；不将两次运行伪写成一次全绿 |
| 最终 API / Editor / 相机 / 空间专项 | 全新迁移的 `gsrecon01_finaltests`，65 项全部 PASSED；`api-editor-final-fresh.log`。旧重复使用测试库中的 retention 用例曾受积累的过期记录影响，因此最终换全新隔离库复核 |
| Worker 全量 | `workers-convert-final-isolated.log`：196 passed，121.79 s；非隔离配置的首次误运行因旧 schema 缺列失败，不纳入通过结果 |
| TypeScript | `typecheck-30k.log`，exit 0 |
| 全量 Vitest | `vitest-30k.log`，45 files / 506 passed |
| Compute / Editor 专项 | `editor-compute-30k.log`，20 passed |
| Oxlint | `oxlint-30k.log`，exit 0 |
| Ruff | `ruff-calibration-final.log`，All checks passed |
| 前端生产构建 | `build-30k.log`，exit 0；已知 bundle 大小提示 |
| Nginx Editor CSP 路由 | `nginx-editor-csp.log`，独立临时前缀 `nginx -t` 通过；未重启生产 Nginx |
| 官方 Editor 数字框 | 真实 0.9 → 1 输入恢复与真正 Measure 缩放、PLY 几何比较均通过 |
| 浏览器闭环 | 两条真实 30,000 次重建、发布、自动 Edit、官方 Measure、PLY 上传、新版本独立重新点击、回滚、权限/CSRF、空间重绑定实际执行 |

测试使用隔离服务与既有固定依赖；没有以 mock mask、进度文本或 HTTP 200 替代真实推理、训练及画面验收。

## Readiness gates

| Gate | 状态 | 证据 |
| --- | --- | --- |
| SAM3_ENVIRONMENT_READY | PASS | 官方本机源码/checkpoint/隔离 Python，真实文字推理 |
| PROMPT_SEGMENTATION_READY | PASS | 49 帧真实 mask / 预览 / 哈希，无 OFF 回退 |
| MASKED_GSPLAT_TRAINING_READY | PASS | 真正 30,000 次、43 视角、实际损失和 537,442 高斯、真实渲染 |
| RECONSTRUCTION_PUBLISH_READY | PASS | OFF 与 masked 均 SUCCEEDED，SOG 保留全部 Gaussian / SH2 |
| AUTO_ENTER_EDIT_READY | PASS | 标准任务真实发布后自动进入正确 slug 和版本的尺度工作区 |
| OFFICIAL_EDITOR_MEASURE_READY | PASS | 未修改官方 v3.5.2，真实两点拾取、输入和 PLY 导出；CSP 阻塞已修复 |
| METRIC_RESCALE_READY | PASS | 全体高斯均匀缩放验证，独立新版本重新拾取误差约 0.57% |
| CALIBRATION_EVIDENCE_READY | PASS | 完成会话、源/结果/导出哈希/用户/时间/变换/误差绑定，状态诚实为 ASSUMED |
| VERSION_AND_SPATIAL_SAFETY_READY | PASS | 旧资产不变、回滚、作者数据保留/失效/重绑、权限/CSRF、未启用 Walk |
| REAL_END_TO_END_READY | PASS | 真实照片至最终 Viewer 的完整路径已完成 |

## 操作复现与限制

1. 启动既有 API、CPU/GPU worker、官方 Editor 与 Web；应用数据库迁移到 head，设置 SAM3 三项本机路径。依赖固定值见 requirements 与锁文件。
2. Compute 上传多视角照片，选择提示词目标模式、填写保留目标提示词、选择标准档。若希望标定，提示词中必须包含实际标定物。
3. 观察真实 mask 预览和训练进度；发布后自动进入 Edit 的尺度标定工作区。
4. 打开官方 Editor，以 F 取景；使用 Measure 真实表面点击，记原距离，填真实米制长度；导出未压缩 PLY，回平台上传。
5. 新版本发布后使用独立复测入口，重新点击同一条边，将实际读数和来源转录保存。检查相机/视角点/标注，按新坐标显式重新确认。

本机隔离验收入口 `http://127.0.0.1:18043`，API `18041`，本次修复后的隔离 Editor 服务 `18032`；原有 `18031` 服务未替换。正式部署需要使用已提交的 Editor 服务/CSP/Nginx 路由配置。本次没有部署、合并远程 PR 或推送远端。

保留限制：无官方测量签名，因此不提供 VERIFIED / 物理 Walk；高斯仍可能有边缘残影，分辨率有限；2DGS 可用环境已定位但未集成。GPU 编码只可在明确预留资源的设备执行，默认 CPU 配置没有被自动改为 GPU。

## 信息来源

结论主要依据本机源代码、官方固定版本源码、实际任务统计、产物哈希、真实浏览器截图和上列测试日志。图片均直接查看，没有调用外部识图 API。Bocha 检索实际返回 HTTP 403；当前官方接口核查使用 Context7 与实际固定版本源码，没有把检索失败当成搜索成功。

- [官方 SAM3](https://github.com/facebookresearch/sam3)
- [锁定版 gsplat 训练示例](https://github.com/nerfstudio-project/gsplat/blob/v1.5.3/examples/simple_trainer.py)
- [官方 SuperSplat Measure and Rescale 文档](https://developer.playcanvas.com/user-manual/supersplat/editor/transform-measure-align/)
- [官方 splat-transform](https://github.com/playcanvas/splat-transform)
