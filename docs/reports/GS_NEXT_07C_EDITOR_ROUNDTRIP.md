# GS-NEXT-07C — SuperSplat Editor 导出一致性与局部清理安全验证

日期：2026-10-16

## 结论与授权边界

- **技术验证：PASS**。94,747 个 Gaussian 的原样导入/未压缩 PLY 导出成功；59 个 Gaussian 核心 Float32 字段在唯一内容映射后全部逐位一致，SH3 完整；受控删除 1 个、撤销、重做、导出和重新导入成功，可以唯一定位被删除的原始源行。
- **完整 PLY schema 原样保存：否**。普通 PLY 导出重排行，省略输入中全为零的 `nx/ny/nz`；不是文件级或 62 字段 schema 的原样复制。该差异已解释，不能用输出行号直接对应输入行号。
- **真实清理候选：HOLD_NOT_APPROVED**。106,283 个 Gaussian 的支撑范围感知集合已成功加载，并保存一个未分类的审阅选区；删除数为 0。不能确认它是废点，不建议直接删除。
- **完整 LOD0 回写：NOT_PROVEN_SAFE / NOT_AUTHORIZED**。本轮没有生成完整 13M 修改版本，没有将局部导出合并回源文件。PASS 不代表主体画质已获批准，也不代表已证明完整模型可安全修改。

## 1. Git、版本和工作流基线

开始时 `main`、`origin/main` 同为
`a80b64b67b1d9bc2e2bc8cbfc599d2b29fd1efad`，工作区干净，无需要保留的未授权修改。
本轮阅读 GS-NEXT-06、07、07B 报告、`VR_01D_CLEANUP_WORKFLOW.md`、
`apps/editor/editor-version.json`，并核对 `apps/editor/editor.py` 和固定版本相关源码。
本轮仓库交付仅此报告，无算法、UI、官方 Editor 或发布代码修改。

使用自部署 `http://127.0.0.1:18031/gaussian-editor/`，未使用公共 Editor。
固定构建身份如下，未重新构建、Fork、升级或打补丁：

| 项目 | 核验值 |
| --- | --- |
| SuperSplat | `v3.5.2` |
| 上游 commit | `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b` |
| package-lock SHA256 | `5cc025bfdaa565bcd80a1ee13d29607f2c1ab0903aa76914ad83ae0a6cfd8b2d` |
| LICENSE SHA256 | `42fa51ddd556be151a29f381fb97ee975825dcc454e805ea3ea9c079cca04d34` |
| artifact SHA256 | `e994c6c327c5e4d3898d25c0ff649ecf3d1cd16efc625faecb9a904a7db188ab` |
| 浏览器运行时版本日志 | SuperSplat 3.5.2 / SplatTransform 3.9.0 / Engine 2.23.0 / PCUI 6.1.4 |

`python3 apps/editor/editor.py verify`、`health --port 18031` 均通过；
缓存上游 checkout 的 HEAD 与固定 commit 一致且工作区干净。
健康检查与 UI 启动不作为 PLY 成功加载的替代证据，数据核验见下文。

### 浏览器操作的实际含义

原样实验另外在**真实 X11 桌面 `DISPLAY=:1` 的系统 Google Chrome
145.0.7632.116、headful 模式**重复验证。操作由 Playwright 驱动官方菜单和
本机文件 input，并非真人手动操作/人工签署，也不是 headless 渲染结果。

为了使用已验证的本地 input/download 后备路径，测试 context 隐藏
`showOpenFilePicker`、`showDirectoryPicker` 两个可选浏览器接口；随后点击
官方 `File → Import...`，向 `#file-selector` 提供本机文件，导出由浏览器下载
保存到新的隔离文件。没有调用 Editor 内部对象来注入 Gaussian、选择结果或导出数据。
官方源码和构建资源未改变。使用 Chrome 的 Vulkan/WebGPU 启动参数及临时测试
context，不能将该环境等同于任意默认浏览器都已通过。

真实桌面 context 记录到安全上下文、可用 WebGPU adapter，vendor `nvidia`、
architecture `ampere`，`maxBufferSize=4294967296`、
`maxStorageBufferBindingSize=4294967292`。这是浏览器查看实验，不是服务器
GPU 转换。请求限制为本地同源和 `blob:/data:`；PLY 从本机文件读取，没有第三方上传、
私有 URL 代理或 HTTP Range 数据加载依赖。

通过的浏览器实验未记录到未处理 page exception、GPU device lost、浏览器关闭或
请求失败。**Console 并非全空**：保留了现有 CSP 拦截 index.html 第 15 行 inline
script 的 error，应用外部脚本正常工作；没有为了消除此日志放宽 CSP 或修改上游。
不能把此已知非阻断 CSP 日志写成“零 Console error”。

## 2. 原样导入/导出实验

### 2.1 输入与操作

输入为 GS-NEXT-07 已验证的 94,747-row 连续 Box ROI；保留原件，只读导入。
其源仍是历史 13,090,324-row Building PLY，不是 LOD2。

1. 新建空 Editor context，经官方 `File → Import...` 导入本机 ROI。
2. 等待状态栏为 `Splats 94,747 / Selected 0 / Locked 0 / Deleted 0`。
3. 不选择、不删除、不做相机缩放/旋转或场景变换，直接
   `File → Export → PLY (.ply)...`。
4. `Compress PLY` 关闭，`SH Bands=3`，下载保存新文件。
5. CPU 解码并精确核验后，独立真实桌面 context 重复上述不编辑实验。

原样实验未为了截图聚焦相机，因此其默认视角可以只见网格/黑色背景。
`40/41/42` 截图主要证明加载计数、零编辑状态和导出设置，不能冒充完整 ROI
可视画面；导出文件中全部 Gaussian 的解析与匹配是独立的数据证据。
后续受控实验才允许聚焦相机并实际观察 ROI。

### 2.2 数量、文件和 schema

| 文件角色 | 行数 | 字段数 / 每行 bytes | 文件 bytes | SHA256 |
| --- | ---: | ---: | ---: | --- |
| 历史全精度源 | 13,090,324 | 62 / 248 | 3,246,401,885 | `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` |
| 原版 ROI | 94,747 | 62 / 248 | 23,498,786 | `bfdcbc08aa184337e45f526fa8f2381af42f05831ed575d2d19d181ff1aee4e2` |
| 首次原样导出 | 94,747 | 59 / 236 | 22,361,768 | `d533a42a2d4650185f4c7c4ff12c457a9a1a1de769f38cae1b168b0065344ef5` |
| 真实桌面独立复核导出 | 94,747 | 59 / 236 | 22,361,768 | `d533a42a2d4650185f4c7c4ff12c457a9a1a1de769f38cae1b168b0065344ef5` |

输入和输出均为合法 binary little-endian PLY，实际文件长度与 header 的行数、
属性类型和 stride 一致。ROI header 1,530 bytes、普通导出 header 1,476 bytes。
两个独立原样导出文件 SHA 相同，文件字节一致；它们与输入 SHA 不同不是损坏证据。

| 字段组 | 属性 | 原样导出结果（精确行对齐后） |
| --- | --- | --- |
| position | `x/y/z` | 每字段 94,747/94,747 Float32 位模式相同 |
| rotation | `rot_0..3` | 同上；没有改用归一化/等价四元数来解释差异 |
| scale | `scale_0..2` | 同上；保留原始 log scale，不写回 exp 值 |
| opacity | `opacity` | 同上；保留原始 logit，不写回 sigmoid 值 |
| SH0/DC | `f_dc_0..2` | 同上 |
| SH1–SH3 | `f_rest_0..44` | 同上，SH3 完整，没有量化或截断 |
| normals | `nx/ny/nz` | **省略**；输入各列均为 0，原件保留，未向导出伪造回填 |

共享的 59 个属性名称、类型、相对字段顺序保持；行顺序不保持。
全部已对齐核心字段 `differentValues=0`、`maxAbsDiff=0`，无非有限值，
没有需要用数值容差或等价变换解释的核心属性变化。输入 normals 的零值省略
属于已解释 schema 差异，仍不允许宣称“所有输入属性原封不动导出”。

固定源码 `src/splat-serialize.ts` 的普通导出路径使用 `SuperSplatChunkSource`，
`extraColumns: []`；它与保留静态资源附加字段的项目保存路径不同。
同文件 `writeResourceFile` 的注释说明 loader 通常保留 Morton permutation。
因此当前导出重排与实现相符，但没有把某种排序规则当作稳定外部契约。

## 3. 精确一对一映射方法与结果

不使用位置近似、最近邻、浮点容差或“第 N 行还是第 N 行”的假设：

1. 按属性名读取并规范为固定的 59 核心字段顺序，保持原始 little-endian
   Float32 位模式；每行形成 236-byte 精确内容 key。
2. 输入/输出分别检查完整 key 的唯一性；出现重复即停止，不能通过字典覆盖
   或随意分配重复行来伪造唯一映射。
3. 用完整字节 key 查找每个输出行对应的 ROI 行；未知 key、重复映射或字段变化
   都使验证失败。这里不是只比较摘要哈希，也不是只用 xyz。
4. 通过 GS-NEXT-07 已验证的 `roi-source-row-index-map.json` 将 ROI 行转换成
   历史 13M 源行，并按对应行再次逐字段比较 uint32 位模式。
5. 保存输出行 → ROI 行 `.npy` 和输出行 → 完整源行 `.json`；所有索引为
   **从 0 开始**，且绑定历史源 SHA256。

| 核验 | 原样导出 | 真实桌面复核 | 受控删除后导出 |
| --- | ---: | ---: | ---: |
| 输入唯一核心行 | 94,747 | 94,747 | 94,747 |
| 输出唯一核心行 | 94,747 | 94,747 | 94,746 |
| 唯一匹配的输出行 | 94,747 | 94,747 | 94,746 |
| 输出行映射成功率 | 100% | 100% | 100% |
| 重复/未知/模糊匹配 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| 核心字段逐位一致 | 是 | 是 | 是（全部保留行） |
| 输入行顺序保持 | 否 | 否 | 否 |
| 仍位于原 ordinal 的行数 | 0 | 0 | 0 |
| 缺少的输入核心行 | 0 | 0 | 1 |

本映射是**已测试子集内**的可靠映射，不是完整 13M 的全局唯一性证明。
首次按 ordinal 比较看到的大量差异只代表行被重排；最终结论使用对齐后的审计，
没有拿早期未对齐差值当作属性损坏。

## 4. 少量受控删除、撤销、重做及重新导入

仅在原样导出的精确匹配已验证后，对独立测试 context 进行工具机制实验。
该实验不把选中的 Gaussian 分类为废点。

通过官方深度拾取在画面像素 `[670,420]` 选择 1 个 Gaussian，使用键盘
`Delete`、`Ctrl+Z`、`Ctrl+Shift+Z`；相机在这一组操作中保持不变。

| 步骤 | Splats | Selected | Deleted | 真实截图（私有证据目录） |
| --- | ---: | ---: | ---: | --- |
| 聚焦原版 ROI | 94,747 | 0 | 0 | `10-roi-focused-before-controlled-test.png` |
| 官方拾取 | 94,747 | 1 | 0 | `11-controlled-selected.png` |
| 删除 | 94,746 | 0 | 1 | `12-controlled-deleted.png` |
| 撤销删除 | 94,747 | 1 | 0 | `13-controlled-delete-undo.png` |
| 重做删除 | 94,746 | 0 | 1 | `14-controlled-delete-redo.png` |
| 导出未压缩 PLY | 94,746 | 0 | 1 | `15-controlled-exported.png` |
| 新空场景重新本机导入 | 94,746 | 0 | 0 | `16-controlled-export-reimported.png` |

导出文件 `exports/roi-controlled-deletion-test-only.ply` 的 SHA256 为
`7b7f7d36a2d4be693a3ebde50245201a9ddf289e18134459c54e2f44dcace95b`。
重新导入有非零精确计数和可视 ROI，没有未处理浏览器异常。
少了 1 行，即原 ROI 的约 **0.00105544%**；该比例不用于证明质量改善。

精确集合差只得到以下一行，全部其余 94,746 行核心字段逐位不变：

| 项目 | 值 |
| --- | --- |
| ROI row（0-based） | `89761` |
| 完整源 row（0-based） | `13011461`（1-based 为 `13011462`） |
| 源 position | `[-34.9775543, 62.2578545, 328.7344360]` |
| Runtime position | `[34.9775543, -62.2578545, 328.7344360]` |
| 原始 log scale | `[-2.84925985, 1.72474480, 2.16790724]` |
| 线性 scale（仅统计） | `[0.05788715, 5.61108888, 8.73997420]` |
| 原始 opacity logit / sigmoid（仅统计） | `13.17320824` / `0.99999810` |

它并非低 opacity 点，不能因为本次测试被删除过就列为真实清理候选。
测试输出标为 `TEST_ONLY / HOLD_NOT_APPROVED`，原版 ROI 和源 PLY 均保留。
“主体未受损”只能说保留 Gaussian 的属性未变；不能说这一个测试删除的可见贡献
已经获人工批准，也没有证明建筑/真实地面完全无损。

## 5. 106,283-row 支撑范围感知实验

### 5.1 构造与适用范围

复用 GS-NEXT-07 定义，CPU 只读扫描源行，构造新的诊断集合：

- 中心位于源 Box `min[-70,15,290] / max[-30,110,330]`：94,747 行。
- 中心在 Box 外、但保守支撑包络与 Box 相交：11,536 行。
- 不重叠合计：**106,283 个唯一源行**。
- Runtime 坐标约定为 `(-x,-y,z)`，Box 变为
  `min[30,-110,290] / max[70,-15,330]`；单位未经标定，不称为米。

精确复现先前计数所用的包络为：令 `r=3*max(exp(scale_0..2))`，每个轴上
Gaussian 中心到 Box 的距离均不大于 r。即轴对齐**立方包络**相交，不是球与 Box
精确相交，也不是投影可见范围。球/Box 替代判定只得到 106,102 行，立方包络
多保留 181 行。这些是保守有限诊断近似；Gaussian 本身没有严格的有限支撑，
不能据此声称所有屏幕贡献都已穷尽。

输出 `support-aware/support-aware-106283-original.ply` SHA256：
`97105429ef4a2c54bc19d2d85f815811b2d9b7fd7e521ce4d557ec11d7ad36e3`。
直接按源行复制 248-byte record，没有重编码属性、降采样或删除源数据。
落盘后独立检查全部 106,283 行与原行的 62 个 Float32 字段逐位相同，SH3 和
normals 保留，源索引唯一，中心内部集合与既有 ROI 映射一致。

`source-row-index-reasons.csv` 为每行保存 sample/source row、入选原因、
源/Runtime position、线性尺度和 opacity；原因区分中心内部与外部包络相交。
完整定义和验证结果分别为 `manifest.json`、`analysis/support-disk-verification.json`。
这是**非连续空间诊断采样**，不是完整场景的有效裁剪结果，不得作为合并补丁。
CPU 扫描支撑范围并复制此集合是本轮明确允许的只读诊断，不是全量 13M 滤点或转换作业。

| 中心分组 | 行数 | 最大线性 scale 范围 | sigmoid opacity 范围 | opacity < 0.01 |
| --- | ---: | --- | --- | ---: |
| Box 内 | 94,747 | 0.00201045–20.28897 | 0.00140606–0.999999987 | 3,483 |
| Box 外且包络相交 | 11,536 | 0.01648973–83.38728 | 0.00159748–0.999999982 | 2,108 |

统计不能替代废点标注：大尺度不等于无效，低 opacity 不等于没有真实细节。

### 5.2 官方 Editor 加载与四视角证据

通过相同本机 `File → Import` 流程加载，状态为
`106,283 / Selected 0 / Locked 0 / Deleted 0`。可以旋转、缩放和从底部观察。
相机由官方 view cube/滚轮控制，不改 Gaussian 或实体变换。

以下是真实截图，已直接查看，不是外部识图 API 或生成图。全部保存于隔离目录，
不提交 Git；P/T 为画面相机叠层读数，保留两位小数的显示精度，不冒充完整精度 pose。
共同 target 为 `[68.04,-132.48,324.10]`。

| 观察目的 | Camera P（Runtime） | 截图 |
| --- | --- | --- |
| 集合整体斜视 | `[-157.26,-76.30,549.41]` | `30-support-review-overall.png` |
| 侧面（+X） | `[391.59,-132.48,324.10]` | `31-support-true-positive-x-side.png` |
| 底部（-Y） | `[68.04,-456.03,324.10]` | `32-support-confirmed-bottom.png` |
| 正面审阅基准 | `[68.04,-132.48,647.65]` | `33-support-review-before-selection.png` |
| 真实桌面近景 | `[68.04,-132.48,479.40]` | `43-support-real-desktop-front-close.png` |

固定设置：FOV `85`、tonemapping `linear`、SH3、黑背景；测试 viewport
`1500×967`、主 canvas `1500×934`、full-page PNG `1508×987`，未重采样截图。
保存的项目包含相机/视图设置。Editor 不是 GS-NEXT-06 Runtime Viewer，
未用其 Performance Mode；没有将 Editor 画面冒充 ACES/Runtime LOD 模式对照。

直接观察可见大片模糊色块、长条拉丝和少量细节纹理；近景仍有强烈遮挡，不能从
这些非连续集合截图可靠区分建筑、道路、地面、草叶等真实结构归属。
整体/近景指此诊断集合，不是完整 Building 主体全景验收。
**没有正式清理后的四视角 A/B**，所以不宣称底部伪影减少、颜色/透明度改善、无空洞
或主体无损。下一轮必须在用户确认选区后做同 pose/同渲染设置的前后对照。

## 6. 真实疑似区域与审阅选择建议

建议先联合检查上述 Runtime Box 的底部与侧面长条模糊贡献，不能只按 Y 阈值选点，
也不能把所有包络相交或大尺度 Gaussian 直接列入删除集。

在支撑集合的正面基准视角，官方深度拾取屏幕像素 `[500,760]` 得到一个
**未分类、仅供审阅**的外部中心 Gaussian。保存前后 `Deleted=0`：

| 项目 | 值 |
| --- | --- |
| 唯一完整源 row（0-based） | `11183581` |
| 支撑集合 sample row（0-based） | `159` |
| 保存项目 resource/instance row（本项目，0-based） | `106274` / `106274` |
| 入选原因 | `center_outside_conservative_3sigma_intersection` |
| 源 position | `[-131.8828278,250.7272491,427.4365234]` |
| Runtime position | `[131.8828278,-250.7272491,427.4365234]` |
| 原始 log scale | `[4.42349577,3.81857276,2.82257080]` |
| 线性 scale（仅统计） | `[83.38727915,45.53916658,16.82003610]` |
| opacity logit / sigmoid（仅统计） | `12.18658924` / `0.99999490` |
| 审阅选择数量 / 实际删除数量 | `1 / 0` |
| 本轮建议正式删除数量 | **0；无法可靠分类，保持不删** |
| 风险 | 可能参与真实建筑、道路/地面或细小结构的长程贡献；仅凭尺度和选中高亮无法排除 |
| 状态 | **HOLD_NOT_APPROVED，NOT a deletion recommendation** |

保留删除前基准图 `33-support-review-before-selection.png`，以及选择状态的
`34-support-review-selection-front.png`、`35-support-review-selection-side.png`、
`36-support-review-selection-bottom.png`。选中高亮不是删除后的效果，不用于画质 A/B。
保存 `exports/support-review-only-NOT_APPROVED.ssproj`，SHA256 为
`f687dd661d8808c49c0306841e9e1f13fa33e8663b9450d67ca92c53b906af2b`。

对项目文件只读解包：静态 PLY 含完整 62 字段，字段顺序与输入不同；按字段名
规范化后，106,283 行全部唯一精确映射，属性位模式不变。按固定版本
`src/doc.ts`、`src/doc-instances.ts` 解码 `sourceRow/flags`，唯一定位到上述行。
项目会压紧/重排资源，不能把项目 resource ordinal 当成源 PLY ordinal。
项目内资源是未压缩 PLY，不应把 `.ssproj` 容器与普通 `.ply` 导出的 schema 混同。

这给出了可以复核的审阅选择，而不是一个已经确认的废点清单。该高 opacity、
大尺度的外部中心实例恰好说明不能仅看中心坐标或 3σ 相交就删除。
用户确认真实可删除贡献之前，不执行正式清理、不生成真正清理候选。

## 7. 局部机制验证不等于完整 LOD0 合并批准

本轮证明：对当前 ROI，在无变换、无调色、SH3 未压缩导出条件下，可以用唯一的
完整核心属性内容恢复源行，受控删除的源行也可唯一确定；局部输出可在隔离目录
生成而不覆盖原件。保存项目还可追踪审阅选择的实例与静态资源对应。

本轮**没有证明**：

1. 完整 13,090,324 行的核心 key 全局唯一，或任意重复行可以无歧义追溯。
2. 做过旋转、缩放、调色/透明度编辑后，普通导出仍可用完全相同的 key 匹配。
3. 普通导出保留额外属性/header/原始行顺序；已实测不是如此。
4. 支撑集合覆盖所有视觉贡献，或已识别的任何一行确实不属于真实结构。
5. 任何实际合并写入器能保证 ROI 外所有 Gaussian、字段与原始字节不变。

**禁止用 Editor PLY 替换完整源文件，禁止按导出 ordinal 删除完整源行，禁止用
LOD2 结果替代 LOD0。** 本轮没有实现或执行完整源合并器。

若未来获单独授权，安全研究方向应是：把已验证的精确源行删除集合视为独立补丁，
在新隔离输出中顺序复制原始 PLY 的保留行，保留原始 schema/字段字节，只重写必要
的 vertex count；不能把 Editor 的重排数据回填成源属性。此前必须先完成有重复行、
字段重排/缺失、未知/变化 key 的小型拒绝夹具测试，并逐位验证所有保留行及 ROI 外
行不变，再经四视角真人审阅。这里仅是后续验证约束，不是已经验证的实现。

下一轮具备**继续人工审阅与局部可撤销试验的数据机制**；尚不具备直接正式清理、
自动回写或发布完整场景的条件。主体画质批准仍待用户，不以技术 PASS 代替。

## 8. 资源安全与历史资产不变性

- 未启动服务器 GPU 转换、Floater、全量渲染或全量 13M 滤点；只做 CPU 只读
  分析/子集复制，以及本机桌面浏览器 WebGPU 查看。未使用 GPU1、终止外部进程，
  或改变其他用户资源。
- `17:27:43 +08:00` 只读资源快照：RAM 125 GiB、可用约 56 GiB；swap 8 GiB
  基本满；磁盘可用约 444 GiB。GPU0 使用 16,272 MiB，GPU1 14 MiB/0%。
  GPU0 已有外部 Python 进程占约 15,942 MiB，未归入本任务、未干预。该快照不能
  修复 GS-NEXT-06 的历史归属监控缺口，也不构成服务器 GPU 作业授权。
- 最终 CPU 重算完整源/ROI SHA256，与第 2 节基线一致。
- 对照 GS-NEXT-06 ledger 核验 A 的 **2,076** 个、B 的 **2,988** 个发布文件：
  文件集合无增减，每个文件 bytes/SHA256/mtime 均不变。
- 数据库仅以 `SET TRANSACTION READ ONLY` 查询，并确认 `transaction_read_only=on`。
  A 的 Scene/SceneVersion/Presentation/Spatial 四组快照与 GS-NEXT-06 final 相同；
  B 的 Scene/SceneVersion 与发布快照相同，已 authored initialCamera 保持
  position `[240,80,400]`、target `[75,-25,150]`、FOV `60`。
- current SceneVersion：A `01c63c7c-8eb5-498e-bcc0-77215e92ca12`，
  B `c26e0dbb-489c-4679-b784-8ff957d84338`，均未切换。
- 不上传模型、不发布、不创建 SceneVersion，不覆盖任何历史 PLY/ROI。
  PLY、项目、完整截图和私有浏览器原始日志均在仓库外，不进入 Git。

## 9. 回归测试与保留的失败探索

```bash
python3 apps/editor/editor.py verify
python3 apps/editor/editor.py health --port 18031
PYTHONPATH=apps/api:. apps/api/.venv/bin/python -m pytest \
  workers/tests/test_splat_transform_adapter.py \
  workers/tests/test_cleanup_experiment.py \
  workers/tests/test_editor_export_validation.py -q
npm --prefix apps/web run test -- src/__tests__/editor.test.tsx
```

- 固定构建校验与 HTTP health：PASS。
- Python 相关回归：**68 passed**（9.16 s）。
- Editor 前端编排回归：**6 passed**（8.12 s），不是完整前后端全量测试声明。
- 提交前再次复跑：Python **68 passed**（9.31 s），Editor 前端 **6 passed**（6.64 s）；固定构建与 HTTP health 再次 PASS，`git diff --check` 通过。
- 现有平台导出校验器接受两个原样导出与受控删除导出；SH3 和精确属性另由本轮
  字段审计证明，不用基础 schema 校验冒充完整一致性证明。
- 浏览器原样导出、受控操作、支撑集合加载/观察均有独立 receipt 和真实截图。
- 完整源/ROI SHA、发布文件及数据库只读核验：PASS。

探索记录未删除：首次按中心选择没有命中，随后使用官方深度拾取命中 1 行；
早期逐 ordinal 属性比较和项目字段顺序比较不适用，最终均改为按属性名及完整字节
内容精确匹配。一次外部校验脚本误把 SH bands `3` 作为 `maximum_count`，更正为
94,747 后通过；一次快照脚本误给无 `id` 的 spatial 表排序，事务只读回滚后更正；
前端命令误用根目录 npm workspace，改为上面的 `--prefix` 命令后通过。
这些均为实验工具调用/审计脚本修正，不是 Editor 异常或任何数据改写；保留相应证据，
不把失败尝试隐藏成一次性全通过。

## 10. 私有证据索引与来源

本轮证据根目录（仅本机私有存储）：

```text
/home/test/.local/state/gsplatform-vr00-20261011/gsnext07c-run-20261016/
```

| 相对路径 | 用途 |
| --- | --- |
| `analysis/verify_exact_row_mapping.py`、`original-export-audit.json` | 核心字段位级比较、重复/未知拒绝及原样导出审计 |
| `analysis/desktop-original-export-audit.json` | 真实桌面独立复核 |
| `analysis/controlled-delete-audit.json` | 唯一缺少源行与全部保留行核验 |
| `analysis/*-to-roi-row.npy`、`*-to-source-row.json` | 导出行到 ROI/13M 源行精确映射 |
| `analysis/build_support_set.py`、`support-aware/manifest.json` | 106,283-row 集合构造与近似定义 |
| `support-aware/source-row-index-reasons.csv` | 每行源索引、入选原因和属性统计 |
| `analysis/support-disk-verification.json` | 支撑集合落盘后的 62 字段独立核验 |
| `analysis/map_review_selection.py`、`review-selection-map.json` | 项目实例/资源/源行对应和审阅选区 |
| `analysis/final-integrity-audit.json`、`published-file-set-audit.json` | 源、历史发布文件和只读数据库核验 |
| `analysis/platform-export-contract-validation.json` | 现有平台导出合同校验 |
| `logs/*-browser.json`、`editor/*.mjs` | 实际菜单动作、计数、相机叠层、Console/Network 与复现脚本 |
| `logs/regression-pytest.txt`、`regression-editor-web-corrected.txt` | 68+6 项相关测试输出 |
| `screenshots/` | 原始截图，核心文件名见第 2、4、5、6 节 |
| `exports/` | 原样 PLY、受控删除 TEST_ONLY PLY、未删除的审阅项目 |

旧 ROI 和它的原始行映射保留于同级 `gsnext07-run-20261016/`，没有覆盖。
本报告记录 SHA 与路径；私有证据未随 Git 传输，在其他机器需由 Owner 安全取得。

外部来源核查于 2026-10-16：已执行 Bocha 搜索（泛检索结果未用作属性一致性证据），
并使用 Context7 先 resolve `/playcanvas/supersplat` 再查询官方导入/导出文档。
Context7 部分摘要仍指旧版菜单，因此以实际固定构建源码、操作截图和 CPU 解码为准，
另抓取当前官方指南正文验证本地导入、Compress PLY、SH Bands 与下载后备路径：

- [官方 Import and Export 指南](https://developer.playcanvas.com/user-manual/supersplat/editor/import-export/)
- [固定 SuperSplat 源码](https://github.com/playcanvas/supersplat/tree/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b)
- [固定普通导出/资源保存实现](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/splat-serialize.ts)
- [固定项目文档保存](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/doc.ts)
- [固定实例映射格式](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/doc-instances.ts)

**最终：PASS（局部原样导出、唯一映射、受控删除机制）；HOLD_NOT_APPROVED
（所有清理候选/审阅选区）；完整 LOD0 回写与发布未执行、未获授权。**
