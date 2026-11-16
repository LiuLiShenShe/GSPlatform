# GS-ASSET-01 实施计划

只转换已有 Mesh，不改训练、提取、原 PLY、MeshModel ID 或 SceneVersion。沿用现有部署。

1. 核对 Trimesh、glTF 规范、官方 Validator、Three.js 当前文档和源坐标链路。COLMAP 不含重力约定，采用用户确认的刚体方向；未知单位保留 scene，不能输出冒充米制的资产。
2. MeshAssetVariant 关联表与迁移，唯一 recipe fingerprint（原 SHA + 旋转 + 转换/坐标规则版本），CPU 后台任务、generation/lease、原子不可变发布、失败重试和鉴权接口。原模型及 PLY 接口保留。
3. 成熟 Trimesh 导出，process=False，完整索引、顶点、颜色/法线；刚体矩阵 + BOTTOM_CENTER 平移烘焙，无缩放。独立解析数值检查、Khronos Validator 0 error 才发布。单位 m 才可标准 GLB 转换。
4. 模型库 GLB 状态、最小方向确认预览、PLY/GLB 切换、标准尺寸/元数据、鉴权下载。标准 GLB 预览直接加载，不补变换。历史批量提交 CLI 默认计划模式。
5. 隔离 DB 权限/幂等/重试/竞态测试，真实已标定 NKSR 与 TSDF、非对称样本及历史数据完整转换。浏览器、独立 Three.js 地面预览、下载解析、PLY 与 building 不变性验收。记录截图、矩阵、误差、版本与限制；提交正式 main，停止于 ASSET-01。

风险：不能从相机向上推断物理向上；不能把 scene 单位当米。颜色以 PLY sRGB 到 glTF linear COLOR_0 转换；法线用旋转，不反射，不简化、不删除面。完整大模型后台串行使用 CPU，禁用 CUDA，不触及 GPU1。
