# GS-AUTO-CAL-05：自动整体尺度标定与编辑顺序锁定

2026-11-14（Asia/Shanghai）。已通过真实浏览器、后台发布任务和独立几何核查。只填写模型中的参考长度、实际长度和单位即可提交；服务自动缩放所有 Gaussian、转换、校验和发布新版本，Edit 自动加载结果。无需导出或重新上传文件。测距仍通过「Gaussian 编辑」中的官方 Measure 工具读取，读取时保留原尺寸。

## 业务行为

- 未编辑的重建结果进入 Edit 时优先打开「第 1 步：尺度标定」。倍率为实际长度（米）÷ 模型原测量长度。
- 标定进行时禁止保存其他编辑；同样的请求复用已排队的任务，避免重复缩放。
- 完成标定，或者先保存相机、视角点、标注、世界变换等其他编辑后，标定永久锁定。删除视角点、重置相机、清空尺度假设或切换版本不会解除。场景级 `calibration_locked_at` 独立保存这一状态；迁移为已有编辑的场景补锁。
- 后端锁定与版本比较控制并发；手动 Gaussian 编辑发布也参与顺序保护。发布失败保留原版本；任务执行受现有 worker 租约和代次约束。
- 坐标乘以倍率，Gaussian 的三个 log-scale 加上倍率的自然对数，其他属性保留。世界显示变换保持恒等，避免二次缩放。当前观察位置与目标一起缩放，随后可正常保存初始视角。
- 真实尺寸由用户提供，记录为 ASSUMED，不冒充计量认证；本次未验收 VR。

## 浏览器实测

使用独立 Chrome 145.0.7632.116 和现有真实 2DGS SOG（43,714 个 Gaussian），通过页面真实登录。输入原长度 0.25、实际长度 20 mm，倍率 0.08；这些是验证自动化流程的示例输入，不是新增实物测量。

1. 仅输入尺寸即可点击提交，POST 返回 202；浏览器没有提交文件上传请求。[尺寸提交截图](gs-auto-cal05-evidence/dimensions-enabled.webp)。
2. 实际后台任务执行整体缩放及现有 SOG 发布流水线，结果仍为 43,714 个 Gaussian。Edit 自动请求新版本资产并渲染。[完成后的模型](gs-auto-cal05-evidence/camera-01-completed.webp)。
3. 当前相机的 position / target 以相同倍率转换，保持观察构图；通过页面「保存初始视角」后刷新，模型仍正常显示。[保存并刷新截图](gs-auto-cal05-evidence/camera-02-saved-reloaded.webp)。
4. 刷新后再次打开标定入口，尺寸输入和提交均禁用，直接 POST 也返回 409。[重复标定锁定](gs-auto-cal05-evidence/camera-03-locked.webp)。
5. 另一个未标定的模型先通过页面保存初始视角，再刷新，标定入口显示「已保存其他编辑操作，尺度标定已锁定」。[先编辑后的锁定](gs-auto-cal05-evidence/authoring-locked.webp)。

完成模型：`autocal05-3615f9`，结果版本 `621016d2-6a31-4d35-accc-3f7cc6f280e2`，资产版本 `49565c23b622`。保留一份未标定模型供继续操作：`autocal05-a7317b`。页面入口为 `http://localhost:18063/model/edit/<slug>`，使用已有预览账号。

此前调试截图出现过旧相机坐标导致的黑画面，未作为通过证据；补上当前相机等比例转换后重新使用新场景完整验收，上述完成、保存及刷新截图均直接查看过。

## 独立核查与测试

独立脚本重新解码原始 SOG，逐项比较缩放后的 PLY，验证全部 43,714 个 Gaussian 的 38 个属性。位置最大误差 `1.4305114759416426e-08` 场景单位；三个 log-scale 均符合预期，其余属性保留。源 SOG SHA-256 仍为 `d1c12fac337f97c24fd46e2eb201916592ed4a992744175bdb0538276cb76422`。[几何核查](gs-auto-cal05-evidence/independent-geometry.json)、[总收据](gs-auto-cal05-evidence/receipt.json)。

- 后端、真实 CLI 与相邻回归测试 **112 passed**：覆盖 CSRF、幂等排队、标定期间拒绝其他保存、已编辑锁定、删除/重置后仍锁定、错误尺寸、过期基准版本、队列失败、编辑发布和版本切换。[测试日志](gs-auto-cal05-evidence/backend-tests.txt)。使用新建隔离 PostgreSQL，按旧回归夹具要求启用测试环境开发身份；自动标定测试自身强制真实登录。
- 前端 **13 passed**：尺寸独立即可提交、锁定、刷新恢复轮询、原 Gaussian 编辑和登录错误提示。[测试日志](gs-auto-cal05-evidence/frontend-tests.txt)。
- TypeScript 检查、前端 lint、新增 Python 模块检查和 mypy 通过；生产前端构建通过，保留现有大 JS 包提示。[构建日志](gs-auto-cal05-evidence/build.txt)。
- 浏览器 pageerror 为 0。原始日志、验证脚本和 PLY 保存在 `/fj/GSPlatform-evidence/GS_AUTO_CAL_05`；评审目录未包含账号凭据或环境文件。

本轮复用已有 1,200 次训练的模型，未重新执行上传、分割或 30,000 次训练，不宣称改善重建清晰度。缩放工具固定为官方 SplatTransform 3.3.3；[上游文档](https://github.com/playcanvas/splat-transform)与本机固定版本 CLI 帮助已核对。博查搜索返回 HTTP 403，以上结论来源于实际代码、浏览器、数据库和几何产物。
