# GS-BROWSER-CAL-04：2DGS 浏览器尺寸标定验收

2026-11-14，Asia/Shanghai。结论：在当前提交 `d4d5098` 的独立运行环境中，完成了真实 2DGS 模型的 Edit → 官方 Measure 两点拾取 → 整体等比例缩放 → PLY 导出 → 平台上传、转换及新版本发布 → 独立新会话重新拾取 → 保存记录、刷新及 Viewer 检查。

已知参考边输入 **20 mm**，新版本独立复测 **19.826661947 mm**，差值 **0.173338053 mm**，相对误差 **0.866690264%**。这验证了当前模型的标定往返一致性，不是对重建几何绝对精度的计量认证。

## 运行版本与输入边界

“未部署”指上一轮没有更新原有运行入口的服务进程，不代表功能没有实现。本轮以当前提交另启 API `127.0.0.1:18064`、Web `127.0.0.1:18063` 和独立发布 worker，使用新建测试数据库、独立存储与 Redis 数据库；没有替换原有服务或修改既有作品。

Chrome **145.0.7632.116**，真实 WebGPU，官方 SuperSplat Editor **v3.5.2**，固定源码 `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`。使用专用验收浏览器，不操作个人浏览器标签页。

输入复用 GS-RECON-02 已实际训练 **1,200 次**的掩膜 2DGS 产物，43,714 个高斯，原 SOG SHA-256：`d1c12fac337f97c24fd46e2eb201916592ed4a992744175bdb0538276cb76422`。通过现有 PublishService 克隆到独立私有场景作为验收起点；本轮没有重新执行图片上传、SAM3 或训练，也没有把 1,200 次产物称为 30,000 次训练。

独立场景：`browsercal04-2dgs-b737b3`，UUID `de1a2eaf-941b-43f7-a7cc-ad16bbf71bcb`。预先设置平台世界缩放 `(2, 2, 2)`，专门检查旧缩放残留问题。

## 实际操作和读数

1. 通过页面登录，进入 Edit 尺度工作区，填写蓝色方块参考边、真实长度 20 和单位 mm，从页面打开授权官方 Editor。
2. 加载真实 2DGS SOG。通过官方文件导入载入已有 COLMAP `images.txt` 相机，仅用于取景；再用双击、滚轮靠近蓝色方块。未修改官方源码或注入测量端点。
3. 点击 Measure，再实际点击两个表面端点。异步拾取完成后，只读获取原距离 **0.327141015476938** 个场景单位。[原始测量截图](gs-browser-cal04-evidence/07-original-measurement.webp)、[原始点和矩阵](gs-browser-cal04-evidence/original-measurement.json)。
4. 从官方 File → Export → PLY 导出缩放前文件。实际在 Measure 长度框输入 **0.02 m**，按 Enter，使整个 Splat 等比例缩放，实际倍率 **0.0611357167363**。再次通过官方导出获得未压缩 PLY，大小 **6,645,479 字节**。
5. 在平台页面选择导出文件、点击提交，实际执行断点上传、校验、官方 SOG 转换和发布。WebGPU 编码耗时约 **7.294 秒**；发布任务总耗时约 **9.51 秒**。
6. 新版本 UUID：`ffcd0086-d6e8-4d55-b4bb-11297a62975a`；资产版本：`13b54c9dd0d4`。源版本仍保留，版本数为 2，全部 **43,714** 个高斯保留。
7. 从平台点击「打开新版本进行独立复测」，新编辑会话 `304018d0-ebad-4551-9a02-1e805c2f48c8` 初始测量点为 `[]`。[初始状态](gs-browser-cal04-evidence/independent-before-picking.json)。只导入按缩放后坐标计算的相机文件，不传入测量点；实际重新点击同一条可见边两端 `(725,448)`、`(751,699)`。
8. 独立读数 **0.019826661947133506 m**。[复测截图](gs-browser-cal04-evidence/12-independent-remeasurement.webp)、[复测端点、矩阵和误差](gs-browser-cal04-evidence/independent-remeasurement.json)。误差来自新会话实际拾取结果，没有以长度框中输入的 0.02 代替复测。
9. 通过平台表单填写实际读数和证据说明，点击「保存标定与复测记录」，再重复保存一次、刷新页面。记录保持 **ASSUMED**、`metersPerSceneUnit=1`、`stale=false`、`physicalWalkAllowed=false`。[保存截图](gs-browser-cal04-evidence/13-calibration-saved.webp)、[第一次保存](gs-browser-cal04-evidence/calibration-saved.json)、[重复保存](gs-browser-cal04-evidence/calibration-saved-twice.json)。

## 整体缩放与持久化检查

对官方 Editor 导出的前后 PLY，逐个高斯验证坐标和尺度，而非只检查 UI 文本：

| 检查 | 实测 |
| --- | --- |
| 前后高斯数 | 43,714 → 43,714 |
| 坐标仿射拟合的三个奇异值 | 0.061135716996 / 0.061135716368 / 0.061135716088 |
| 最大位置残差 | 2.392 × 10⁻⁷ |
| 三个 log-scale 的最大误差 | 3.835 × 10⁻⁷ / 3.835 × 10⁻⁷ / 5.702 × 10⁻⁷ |
| opacity / 旋转 | 保持一致 |
| 原 SOG 字节 | 哈希保持不变 |
| 导出 SHA-256、会话记录、结果版本源哈希 | 三者一致 |
| 平台旧世界缩放 | `(2,2,2)` 清除，当前恒等；原变换快照保留 |
| 重复保存 | 保留原始 2 倍缩放快照，不再次改变几何 |

[整体缩放计算结果](gs-browser-cal04-evidence/uniform-scale-validation.json)、[数据库及文件核查](gs-browser-cal04-evidence/persistence-check.json)。导出 PLY SHA-256：`59b8fc0bafaa67df04d6e644916e31b5845b4f7eaaafdfdafc338e5a150449ff`；发布 SOG SHA-256：`13515e9cb276863a6f895ad25417c55aa5b9bfb6a949aa403f166d2dae7dd43b`。

## 刷新、取景和 Viewer

新几何发布会使旧空间相机绑定失效。没有初始视角时，本次小模型的默认相机未对准模型，第一次 Viewer 截图为空；不能把它当作可见画面验收通过。为检查最终 Viewer，通过现有、受授权的 presentation 接口显式保存了按新坐标设置的初始相机，然后重新加载。此步骤没有更改高斯或世界缩放，也没有注入 Measure 点。[显式相机重绑记录](gs-browser-cal04-evidence/explicit-camera-rebinding.json)。

最终 Viewer 真实显示植株和蓝色方块，诊断为 WebGPU、`loaded=true`、`gsplats=43714`、`error=null`、世界变换恒等。[最终画面](gs-browser-cal04-evidence/16-final-viewer-with-current-camera.webp)、[Viewer 诊断](gs-browser-cal04-evidence/final-viewer-diagnostics.json)、[刷新后标定状态](gs-browser-cal04-evidence/processing-final.json)。浏览器 pageerror 为 **0**。

Viewer 的 `Scene scale needs calibration` 提示仍由小场景范围和行走限制产生，当前水平范围约 0.197 m、垂直范围约 0.256 m；它没有否定已执行的几何缩放。保存的是用户转录的 ASSUMED 证据，没有伪造 VERIFIED 或开启物理 Walk。标定后仍应重新设置适合新坐标的初始视角。

首次临时 Web/API 进程曾被执行会话回收，产生 `ERR_CONNECTION_REFUSED`；改为持久启动后重新选择文件、重试真实上传成功。首次将不受官方导入支持的 `cameras.txt` 一并导入也出现过错误弹窗，关闭后仅导入官方支持的 `images.txt`。这些中间错误没有作为成功结果，也未改动官方逻辑绕过。

## 验收范围

**通过：** 当前真实 2DGS 产物的浏览器测距、整模缩放、导出、上传发布、独立复测、标定保存与刷新、旧缩放清除、重复保存及最终 Viewer 显示。

**仍未覆盖：** 2DGS 新的 30,000 次完整训练、与 3DGS 的同预算画质/性能对照、原生 2DGS 渲染与薄椭球 SOG 渲染的系统比较。当前 1,200 次模型边缘仍模糊，不能把 0.87% 的往返复测差值解释成真实几何的计量精度。

完整原始截图、PLY、服务日志、相机导入文件及核查脚本位于 `/fj/GSPlatform-evidence/GS_BROWSER_CAL_04`。可评审的主要 JSON 和截图已复制到本报告的 `gs-browser-cal04-evidence/`，未复制账号凭据或环境文件。[总验收收据](gs-browser-cal04-evidence/receipt.json)。

信息依据为本机实际浏览器操作、直接查看截图、固定版本源码、产物和数据库核查。博查搜索本轮返回 HTTP 403，没有使用搜索摘要或训练数据代替实测。
