# GS-RECON-02：两个重建算法选项

日期：2026-11-14。代码已完成并在本机验证；未部署生产服务。本次增加算法选择，不是 3DGS 与 2DGS 的质量对照实验。

## 用户界面

「免费计算 → 参数确认 → 重建算法」提供且仅提供两项：

- **通用重建（gsplat / 3DGS）**：常规物体、室内外场景。
- **薄物体、植株重建（2DGS）**：叶片、植株等薄表面。

默认选择通用重建、标准质量（30,000 次）。草稿明确标为快速预览（1,200 次）。算法与质量、SAM3 分割模式独立；任务详情和刷新恢复均展示持久化的算法。既有成功发布后进入 Edit 尺寸标定的路由保持适用于两种算法。

## 后端接线

- 请求只接受 `algorithm=gsplat|2dgs`，旧请求省略算法仍兼容 gsplat。
- 复用 Job 的 JSON 参数，无数据库迁移。算法参与重建幂等，并由 CPU、GPU、发布三个 Celery 阶段分别读取。
- gsplat 调用原有 `train_gsplat_script`；2dgs 调用 `train_2dgs_script`，使用已有 `/data/fj/F2DMAS/2d-gaussian-splatting-main/venv/bin/python`，复用该仓库原生训练循环、surfel 光栅器、SSIM 及植物掩膜损失。未修改外部 2DGS 仓库。
- 训练、检查点身份包含算法；2DGS 额外包含相关原生 Python 源文件的 SHA-256。切换算法或改变原生源码不会错误复用训练完成标记或检查点。
- 2DGS 环境缺失明确返回 `2DGS_UNAVAILABLE`，不退回 3DGS。部署可通过 `GS_2DGS_REPO`、`GS_2DGS_PYTHON` 配置。

## 真实运行证据

证据目录：`/fj/GSPlatform-evidence/GS_RECON_02`。输入复用 GS-RECON-01 标准任务的 43 个已注册视角、COLMAP 模型和 SAM3 提示词掩膜；原输入与已发布资产未改动。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 掩膜 2DGS CUDA 训练 | 1,200 次，SH 二阶，输入下采样 4 倍；6,987 个稀疏点经前景过滤保留 5,581 个，输出 43,714 个 surfel | `masked-training.log`、`masked/training-stats.json` |
| 原生模型导出 | 保存双切向尺度 PLY，使用原生 2DGS 训练器 | `masked/checkpoints/2dgs/point_cloud/iteration_1200/point_cloud.ply` |
| 编辑器兼容导出 | 输出 43,714 个高斯，原位置、旋转、颜色、两切向尺度保留；附加有限法向厚度 | `masked/final.ply` |
| 真实 SOG 转换 | 官方 splat-transform 3.3.3、CPU 编码成功；43,714 个高斯，885,283 字节，版本 `8e2fbdd1109d` | `conversion-result.json`、`conversion.log` |
| 完整场景 2DGS | 不传掩膜，30 次小规模接线验证成功，输出 6,987 个 surfel | `off-training.log` |
| 真实检查点恢复 | 保留第 20 次检查点，重新运行，实际继续完成剩余 10 次并导出 | `resume-training.log` |

SOG SHA-256：`d1c12fac337f97c24fd46e2eb201916592ed4a992744175bdb0538276cb76422`。原生 2DGS Python 源身份：`d75082be694343a9700ef9b29dcda42c98372232fc87fc673c59b8476197e21c`。

本次训练验证有意使用较小预算；**没有把 1,200 次接线验证声称为 30,000 次完整质量验收**。标准/高精度任务实际仍向所选训练器传入 30,000 次，已有自动化测试覆盖。

## 自动检查

- 前端完整测试：45 个测试文件、508 项通过，包含两项算法选择、提交载荷、刷新后的算法展示与发布后 Edit 导航。
- 前端 typecheck、lint、生产 build：通过。
- API 重建/标定合同测试：隔离数据库运行 7 项通过，覆盖非法算法拒绝、两种算法持久化/查询、相同请求幂等、不同算法创建不同 GPU 任务。
- Worker 全量测试：隔离数据库运行 203 项通过；随后增加三个 Celery 阶段参数传递测试，最后相关定向测试共 16 项通过。
- 修改的四个 API 模块定向 mypy：通过；修改模块 ruff、`git diff --check`：通过。
- 额外在仓库根目录执行全量 API mypy，报告 16 处未改动模块的类型问题和外部库类型桩缺失（例如 shares、scene_processing、yaml、gsplat）；见 `api-mypy.log`。本次未扩大范围修复。

最初未设置验收数据库环境的 Worker 全量检查已终止；上述 203 项结果来自明确设置独立数据库 `gsrecon02_tests` 和独立存储目录后的运行。

## 适用范围与限制

- 2DGS 训练使用真实 surfel 算法。共享 SOG/Editor 仍是三维高斯渲染器，发布时采用薄椭球近似：法向尺度为较小切向尺度的 1/1000，并设数值下界；原生双尺度 PLY 保留，世界坐标不变。
- 沿用本地 2DGS 参数，`lambda_normal=0.05`，`lambda_dist=0.0`；未宣称启用了原论文所有几何约束。
- 本轮没有重做浏览器内 2DGS 官方 Edit 标定、导出、回传的完整人工拾取往返。已有标定接口、编辑路由测试通过，尺度功能沿用前轮已验证的公共流程。
- 没有据此次较小预算的验证判定 2DGS 优于 3DGS；两项适用说明遵循本次产品要求。

使用说明与部署参数见 `docs/reconstruction-backends.md`、`deploy/env/production.env.example`。开发依赖新增 `plyfile==1.1.3`，锁文件同步；2DGS 运行时仍使用其独立已有环境。
