# VR-01B — Official SuperSplat Policy Alignment & Gaussian Fidelity Verification

日期：2026-10-12，Asia/Shanghai。结论：**VR-01B: PASS（软件侧）**。

本轮完成服务器端输出策略、不可变普通 SOG 发布、真实 CLI / PostgreSQL / 浏览器验证。没有替换官方 Viewer、升级 PlayCanvas、开发导航、改写 Gaussian 算法或重跑 13M 场景。**PICO Neo3 双目画质、真实尺寸和帧率仍待用户验收。**

## 1. Git baseline、工作区与版本

- Starting HEAD / starting `origin/main`：`88fb7adf16a8078b72b3956c135e5f7b7e0757b7`。
- 实现提交：`8552702fb4ec862d5743adcf97a625708ee2d82c`，`feat(convert): align official automatic SOG policy and immutable publication`。
- 测试及匿名观看修复提交：`70f77075f5285e2e23a3e167fa0ff42a0b8a2623`，`test(vr01b): verify regular SOG E2E and preserve anonymous desktop access`。
- 末审兼容修复提交：`fa4ef0b420e17e69792df8a3636b41246480df8b`，`fix(convert): preserve validated legacy SOG containers`，增加官方 legacy V1 的容器直通验证。
- 完整回归、clean archive 和最终运行态代码版本为 `fa4ef0b420e17e69792df8a3636b41246480df8b`。之前 `70f77075...` 的完整回归和同源视觉证据也保留；最后修改不改变当前V2输出字节或渲染器。之后的验收文档提交不改变应用代码。
- 工作目录 `/fj/GSPlatform`，原 `main` 分支，无新 worktree。保留 **89 项用户原有 tracked 文档删除**及未跟踪 `docs/GSPlatform_WebXR_VR_Master_Plan.md`，不恢复、不删除、不提交。
- 只按本任务明确路径提交。原始 PLY、大型 SOG、数据库备份、运行配置、登录密码、Cookie 和 `node_modules` 不进入 Git。

## 2. PlayCanvas 官方规则与固定版本证据

2026-10-12 实际读取：

1. [SuperSplat streaming](https://developer.playcanvas.com/user-manual/supersplat/streaming/)：托管上传 `<1 million` 默认单个 SOG；`>=1 million` 默认多级 Streamed SOG，每层 Gaussian 约减半，空间分块加载。托管 UI 可覆盖选择，预构建流式归档保持流式。
2. [SplatTransform Streamed SOG](https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/)：官方 decimation、LOD tagging 和 chunk writer；不是安装 CLI 就获得托管调度服务。
3. [CLI reference](https://developer.playcanvas.com/user-manual/splat-transform/cli-reference/)：必须与本机 `--help` 对照，不能直接搬用最新参数。
4. [SplatTransform v3.3.3](https://github.com/playcanvas/splat-transform/tree/v3.3.3)，本机 `--version` 为 `splat-transform v3.3.3`，revision `d092ae9`。
5. [SuperSplat Viewer v1.35.0](https://github.com/playcanvas/supersplat-viewer/tree/v1.35.0)，本机 `docs/api.md`、`dist/viewer.js` 和 `createViewer` 实际浏览器调用。

执行过 Context7 resolve / docs，选择 `/playcanvas/splat-transform` 与 `/playcanvas/supersplat-viewer`。Bocha 搜索实际返回 **HTTP 403 / 额度或余额不足**，没有假称搜索成功；直接抓取上述官方页面、本机锁定源码及帮助作为执行依据。官方资料快照在本机证据目录，未把文档托管业务复制到项目。

固定依赖：SplatTransform **3.3.3**、SuperSplat Viewer **1.35.0**，Web PlayCanvas **2.22.4**；本机 CLI 的既有 lock peer 为 **2.22.0**。这些依赖未升级。CLI 3.3.3 支持 `--info json`、`--stats json null`、普通 `.sog`、`meta.json`、`lod-meta.json`、`--decimate`、`--tag-lod`、`--lod-chunk-count`、`--lod-chunk-extent`；不支持 `--lod-chunk-min`，本轮没有使用它。

## 3. 隔离环境与安全部署

实际核验，见 [closure.json](vr01b-evidence/closure.json)：

| 项目 | 实际值 / 证据 |
| --- | --- |
| Runtime PostgreSQL | `172.19.0.10:5432 / gsplatform_vr00_20261011` |
| DB role | `gsplatform_vr00_20261011`，`rolsuper=false` |
| API / Workers / clean test DB | 分别 `gsplatform_vr00_tests_20261011` / `gsplatform_vr00_workers_20261011` / `gsplatform_vr00_clean_20261011`；同一专用非超级用户拥有，均非共享生产 DB |
| 可写资产 | `/home/test/.local/state/gsplatform-vr00-20261011/storage` |
| 专用 Redis | `gsplatform-vr00-redis-20261011`，仅 `127.0.0.1:16384`；运行 broker/results/rate-limit 分别 DB 0/1/2 |
| Nginx | `gsplatform-vr00-nginx-20261011`；隔离配置，内部授权 origin；共享历史 published mount 只读 |
| API / Web / proxy | `18001 / 5175 / 5174` |
| 最终代码进程 | API、Web、publish、cpu、gpu、maintenance 的 `GS_BUILD_VERSION` 均为 `fa4ef0b420e17e69792df8a3636b41246480df8b` |
| HTTPS | `https://referral-tips-unlike-wants.trycloudflare.com` |

更新前检查数据库中全部任务已完成，现有安全脚本再检查 Celery active/reserved，使用 `./scripts/gsplatform-vr.sh down` / `up`，没有重启正在执行任务的 Worker，也没有重复 Worker。共享 PostgreSQL、Redis、Editor 和历史服务没有重启。第一次前序部署遇到已经退出的 Web PID，安全脚本拒绝继续；再次使用原脚本完成停止，没有绕过 PID guard。

最终 2026-10-12 15:02:59 +08:00 查询：**7 个 PUBLISH / SUCCEEDED，0 个 Collision job**。没有清空 Redis、重建 DB 或修改共享生产数据。Quick Tunnel 地址已按最新 tunnel log 更新并重新验证，不再使用此前 `instructor-feof-nylon-tournaments...`、`personality-marijuana-standard-machines...` 或 VR-00 原地址。

## 4. 1788 Gaussian 输入的真实来源与身份

场景 `u-a68b94d84538` / UUID `5f10e536-e86b-44f7-bdec-5e3a667eebc7`。

```text
Source file:
/home/test/gsplatform-data/jobs/89822b47-b6a5-45c4-8674-e06cfe2bf883/attempt-1/gsplat/final.ply

Bytes: 100488
Gaussian count: 1788
SHA256: b2cc7bb1594d33ffe496481f5c992ffca83b1d14b259839da3389b7224663db3
Original upload: a09fedab-6cce-498a-8967-eb4b37b127c6
Old assetVersion: c10c127b4574
Old SceneVersion: 68cb9e7b-11a5-44d8-9070-e146b9e55aba
Old counts: 1788 / 536 / 179
```

不仅核对标题：本机 VR-00 `smoke.py` 显式读取上述源文件；原 upload 的 `declared_sha256`、`total_size=100488`、`upload_format=ply`、服务端保留上传、旧 Manifest / BuildInfo / 实际 PLY 哈希相符。原 upload 声明 PRIVATE，VR-01A 后该场景是 PUBLIC，这两条历史事实不矛盾。

源文件来自已有重建 job `89822b47-...` 的 `attempt-1`，`logs/pipeline.log` 记录 draft；`gsplat/params.json` 为 **1200 iterations、SH degree 0、lr 0.01、densify=true、seed=42**，使用该 attempt 的 COLMAP / frames。它是 **VR-00 小型 smoke 重建输出**。没有证据证明它就是用户期望的农业场景，更不能用标题冒充用户农业资产。

13M 源哈希、场景 UUID、Gaussian 数量和目录均不同，见第 16 节。

## 5. 原始 PLY、SH、Opacity、尺度与数值检查

使用锁定 CLI 的真实 `--info json --stats json null`；另从 binary PLY 的原始 float32 独立统计。CLI stats 中展示 scale / opacity / DC 时会转换数值空间；本报告明确使用 `exp(log_scale)`、`sigmoid(opacity_logit)` 和 `0.5 + 0.2820947918 * f_dc`，避免把 logit 当透明度、把 log scale 当长度。完整原始/解码统计见 [fidelity-stats.json](vr01b-evidence/fidelity-stats.json)。

| 项目 | 原始 PLY |
| --- | --- |
| Model | 官方识别 `gaussian=true, model=default`，非普通 XYZ 点云 |
| Count / SH | `1788 / shBands=0`；没有 `f_rest_*`，不是转换后丢失 SH |
| NaN / Inf | 全部 14 个字段均为 0 |
| XYZ min | `[-3.375741243, -1.748815179, 7.567113400]` |
| XYZ max | `[4.148230553, 1.243186712, 14.323014259]` |
| XYZ extent | `[7.523971558, 2.992002010, 6.755900860]` |
| Linear scale median | `[0.060084671, 0.038354408, 0.019234067]` |
| Linear scale min | `[0.001278572, 0.002990438, 0.001004852]` |
| Linear scale max | `[0.839732766, 0.774332881, 0.752739072]` |
| Opacity min / median / max / mean | `0.001098590 / 0.999265909 / 0.999996066 / 0.797591746` |
| Raw f_dc mean | `[0.561184943, 0.521508753, 0.301681548]` |
| DC RGB mean | `[0.658307850, 0.647114336, 0.585103035]` |

单位尚未标定为米。坐标与 Gaussian scale 保持源模型单位，没有自动放大、缩小、改 Opacity、改颜色、滤波或重建。原始模型已经是低饱和灰白、局部浅粉色、模糊且细节贫乏的小型重建，不能由转换策略凭空恢复农业纹理。

## 6. 同视角真实截图：原始 / 旧 LOD0 / 旧 LOD2 / 新普通 SOG

PART A Gate 在修改产品代码之前完成源身份和原始/旧输出对照。完成发布后，再用当前真实 `scene.sog` 重跑相同官方 Viewer 对照；没有改 Viewer 源码。

固定设置：960×720、DPR 1、WebGL2 / SwiftShader、无自动动画、关闭 post effects / AA；背景 `[0.05,0.05,0.05]`，ACES，grading brightness=1 且禁用；相机 `position=[4.495,2.8424,14.9418]`、`target=[0.0149,0.5283,10.3137]`、FOV **85**。全部使用相同官方模型坐标处理和 GSPlatform identity world transform。

- [原始 PLY 截图](vr01b-evidence/original.png)：1788。
- [旧 Streamed SOG LOD0 截图](vr01b-evidence/old-lod0.png)：1788，直接读旧 `0_0/meta.json`。
- [旧 Streamed SOG LOD2 截图](vr01b-evidence/old-lod2.png)：179，直接读旧 `2_0/meta.json`。
- [当前已发布 Regular SOG 截图](vr01b-evidence/regular.png)：1788，实际 `21c371259407/scene.sog`。
- [四格对照](vr01b-evidence/comparison-grid.png)及 [固定设置 / 实际帧计数](vr01b-evidence/comparison.json)。

图片内容由 **Agnes API（HTTP 200）识别**：原始已灰白模糊，179 点版缺失细节，完整 SOG 没有明显颜色或比例变化。其部分“新版本更锐利”的主观描述**不采信为优化证据**：机器结果证明旧 LOD0 和新 Regular SOG 的截图完全相同。

| 与原始截图比较（8-bit RGB） | MAE（0–255） | RMSE（0–255） |
| --- | --- | --- |
| 旧 LOD0 | 0.187278646 | 0.744078670 |
| 旧 LOD2 | 6.984331115 | 19.597903772 |
| 新 Regular SOG | 0.187278646 | 0.744078670 |

表中数值是在 0–255 像素空间的误差，并非已除以 255。见 [pixel-comparison.json](vr01b-evidence/pixel-comparison.json)。本轮不是“颜色增强”：避免不必要的低 LOD 才是实质改变。原始与完整 SOG 的低误差是此固定视角/设置下的结果，不保证任意模型/视角像素相同。

## 7. 原始与解码 SOG 的几何、颜色、尺度保真

用官方 CLI 把已发布 `.sog` 解码为 PLY（只在本机证据目录），1788 个点做 XYZ 最近邻对应，**1788 个唯一匹配**。量化误差及透明点边界详见 [published-fidelity-errors.json](vr01b-evidence/published-fidelity-errors.json) / [color-outliers.json](vr01b-evidence/color-outliers.json)。

| 测量 | 结果 |
| --- | --- |
| 原始 / 发布 / 解码 / 渲染 Gaussian | `1788 / 1788 / 1788 / 1788` |
| 解码 XYZ min/max/extent | 与原始 float32 bounds 一致 |
| XYZ 点误差 max / mean / P99 | `0.000244340 / 0.000103113 / 0.000207721`，源坐标单位 |
| RGB absolute error mean | `[0.001500549, 0.001445927, 0.001150577]`，0–1 空间 |
| RGB error P99 | `[0.001209899, 0.000955616, 0.000914739]` |
| Scale relative mean error | `[0.488118%, 0.456769%, 0.482160%]` |
| Scale relative P99 | `[1.430441%, 1.250938%, 1.409162%]` |
| 解码 opacity mean / median / max | `0.794716358 / 0.996078432 / 0.996078432` |

不能隐瞒尾部误差：13 个源透明度约 `0.0011–0.0038` 的点，官方 8-bit alpha 量化成零，解码 opacity 被夹到约 `1e-6`；透明 texel RGB 对应误差最大 `[0.225368,0.222179,0.179524]`。CLI 3.3.3 writer 的 `Uint8Array(sigmoid(opacity)*255)`、WebP 和 decoder 的 alpha clamp 可以解释这一边界；这些点不是被 GSPlatform 自行删除。低透明度像素的颜色变化不等价于可见主体整体变白。

官方 SOG 是有损编码，旋转/尺度/颜色 codebook 和 alpha 均有量化。这里确认无额外 SH 丢弃、过滤、坐标缩放或几何偏移；**不声称参数逐位相同或转换器修复了源质量。**另有真实 SH1 PLY→SOG 测试，证明非零 `f_rest` / `shBands=1` 保留。

官方 Viewer 1.35.0 的 load 分支固定 `entity.setLocalEulerAngles(0,0,180)`；本机 SplatTransform 的 `Transform.PLY` 同样定义这一约定。因此 runtime 观察到 X/Y bounds 的符号与原始 PLY 坐标不同，是原始/普通/流式共享的官方轴约定，不是本轮缩放或漂移。GSPlatform world transform 仍为位置/旋转 0、scale 1。

## 8. RED → GREEN 的实际证据

| Gate | 基线真实 RED | 修复后 |
| --- | --- | --- |
| RED-01 | 1788 实际 CLI 转换得到 `format=streamed-sog`；旧实际 counts `1788/536/179`；期望普通 SOG 的断言失败 | `format=sog`，仅 `[1788]` |
| RED-02 | Validator 抛出 `ValueError: 不支持的 format: sog` | 普通与流式各自严格验证 |
| RED-03 | 给基线 PublishService 普通 SOG Manifest 后，真实 PostgreSQL 记录使 runtime 返回 `format=lod-meta, .../lod-meta.json` | DB format sog → 正确 `.sog` URL |
| RED-04 | 同一基线事务注册 `SceneVersion.format=streamed-sog`、`AssetKind.SOG.storage_key=.../lod-meta.json` | sog SceneVersion 与真实 scene.sog Asset |

修复前测试日志：workers **6 failed / 2 passed，exit 1**，API **1 failed，exit 1**。为独立证实 RED-03/04，使用 `git show 88fb7ad...:publish_service.py` 加载**真实基线代码**，在专用 worker test PostgreSQL 创建测试事务，输出错误 format / key / URL 后 rollback，预期断言 exit 1；没有修改运行场景或伪造状态。见 [red-publication-runtime.json](vr01b-evidence/red-publication-runtime.json) / [red-workers.txt](vr01b-evidence/red-workers.txt)。

精确定位：**Runtime resolver 原来已有普通 SOG 分支**；RED-03 的根因是发布器登记错 format，不能编造“resolver 完全不支持 SOG”。本轮没有重写 resolver。

浏览器还实际捕获 Desktop 匿名 `/auth/me` 401 导致自动跳登录的失败；仅 GET session probe 不重定向，其他 PRIVATE / upload 401 行为保持。增加 5 个 Web 安全回归测试，之后真实匿名 Desktop 通过。

## 9. 服务器端精确阈值与输出模式

`workers/pipeline/conversion_policy.py` 使用服务端官方工具识别后的实际 Gaussian count，不接受客户端自报数量作为决策权威：

| 输入 | 默认模式 | 测试方式 |
| --- | --- | --- |
| 1788 / 60000 / 300000 / 999999 | `regular-sog` | 1788 真实 CLI；其余严格 mock 官方 count 的策略测试 |
| 1000000 / 1000001 | `streamed-sog` | 严格 mock 官方 count 的精确边界测试 |
| 合法普通 SOG | `regular-sog` + encoding `passthrough` | 严格容器/官方解码验证后逐字节直通，不重复压缩 |
| 合法 Streamed SOG ZIP | `streamed-passthrough` | 原有 Recipe v2 passthrough 和安全解包保留 |

`mode` 是转换策略身份；数据库/Manifest 格式仍用既有 **`sog` / `streamed-sog`**，runtime 用既有 **`sog` / `lod-meta`**，没有增加冲突格式枚举。没有伪造 `lod-meta.json` 来包装普通 SOG。

## 10. 新大场景的 LOD ladder 与 measured profiles

仅新生成的流式 Recipe v3：`100%, 50%, 25%, 12.5%, ...`，下一层预计 count 小于 **125000** 时停止，最多 **8 层（含 LOD0）**。这两个限制是 GSPlatform 的有限服务器预算，不假称官方托管内部阈值，也不无限追加无意义低 LOD。

- 1M：`[100%,50%,25%,12.5%]`。
- 13,090,324 如果是**新上传**会按规则生成 7 层至 1.5625%；本轮没有对历史 13M 实际执行此规则。
- 保留 measured profiles：balanced `64K / extent32`，eco `512K / extent32`，quality `64K / extent16`。
- LOD0 复用有效 PLY 全量源；每一减量层仍由官方 `--decimate` 产生，空间 Chunk 仍由官方 writer 产生。
- 不改官方 Viewer 的动态 LOD 选择和 Gaussian budget，不自创渲染预算算法。

## 11. Conversion Recipe 与不可变版本身份

旧 `conversion_recipe()` / `_source_recipe()` 的 Recipe **v2** 字段和 version-id 规则保留；旧 `100/30/10` 输出不重新编码、不改 Manifest。预构建 Streamed ZIP 继续原 v2 passthrough。

新自动生成 Recipe **v3** 包含实际输出 mode、source count / SH / model、官方工具版本、单层或 bounded ladder、chunk profile、SH iterations、CPU/WebGPU encoding backend。`version_id_for` 仍为 **source SHA256 + canonical semantic recipe** 的稳定 12-hex 身份。

Timeout、日志路径、进程 PID、工作目录、最大 Worker 数、GPU adapter index 不进入身份；CPU vs WebGPU 可能改变编码结果，仍属于语义身份。普通 SOG 不因 balanced/quality/eco 的无效 chunk 参数生成重复版本。

真实新普通版本 `21c371259407` 与旧 `c10c127b4574` 同源但不同 Recipe，可共存。当前发布包 SHA256 为 `a9b7b5ef5ac4c882434a3cf6b16a976963bca18ec46953684dce2a304ceead18`；早期 CLI probe 为 `109d3803...`。**仅 ZIP timestamp 不同，6 个内部资源完全相同**，详见 [published-encoding-comparison.json](vr01b-evidence/published-encoding-comparison.json)。ZIP 运行时间不进入版本身份，实际输出哈希单独记录并验证。重试复用既有不可变产物，不再次有损压缩。

## 12. 普通 SOG 的正式格式、Manifest 与安全校验

选择 **bundled `scene.sog`**，不用非捆绑 `meta.json` 作为新正式输出。普通 version tree 只有真实 `scene.sog`、`manifest.json`、`build-info.json`、`checksums.sha256`，无假的 LOD metadata。

Manifest `format=sog`，`assetUrl` 与 `content.entryUrl` 为 `versions/<assetVersion>/scene.sog`，content count `[1788]`、真实长度与 SHA256；BuildInfo 记录原始 SHA / Gaussian count / SH、Recipe、官方识别、命令、观察设备、退出码和耗时。

`sog_container.py`：ZIP member 唯一、root meta、版本/count、有界展开与 metadata size、禁止 traversal / absolute / backslash / encrypted / symlink、完整 referenced resource 集合、RIFF/WEBP payload、ZIP CRC，之后官方 decode/stats 校验。不是只检查 ZIP magic。SHN 资源按真实 metadata 验证。V2读取 `count`；官方 legacy V1没有 `version` 字段，读取合法 `means.shape=[count,3]`，禁止把无效的 `version=1` 当成官方V1。两者都必须由固定CLI完整识别和解码。

末审真实 RED：一个使用实际WebP构造、固定CLI能解码的64点legacy V1容器，在原新Validator因缺 `count/version` 被拒绝；先执行失败测试（1 failed），再增加独立合法shape解析，真实CLI→byte-identical passthrough→artifact validation GREEN。该格式兼容夹具不是用于源1788保真视觉对照，没有新增编码器或转换算法。

`artifact_validator.py` 普通分支：version directory containment、真实 entry/count/bytes/source/output SHA、source+recipe 身份、BuildInfo 和 checksums 全覆盖；编码命令不允许减量、过滤或额外 transform，passthrough 必须与源 hash 一致。缺失、损坏、recipe 不一致、checksum 不符、symlink escape 都拒绝发布。

原有流式 Chunk、LOD metadata、资源、Checksum、Containment 校验保留，并对 v3 核对 source count / LOD count。进程 ownership、GPU/CPU、版本校验、bounded log、Timeout / kill owned process group、失败清理、锁、marker 恢复仍使用原单一 adapter，没有第二套调用器。

## 13. PublishService、SceneVersion、Asset 与权限

普通格式经过校验后原子 promote→DB transaction；PublishService 登记 `SceneVersion.format=sog`，`AssetKind.SOG` 的 storage key 是真实 `scene.sog`，字节数和 output SHA 正确；旧流式仍登记 `lod-meta.json`。

不新增表或格式迁移。existing-version 幂等/CAS、source SHA / manifest 一致性、scene row lock 保留；不同 Recipe 不覆盖目录，不让 current 指向不存在入口。新增真实 PostgreSQL 测试同时保留旧版并登记新版 / asset / runtime。

`SceneAccessPolicy`、Owner login、CSRF、Share read-only、Upload authorization、PRIVATE / Deleted / PROCESSING 检查没有关闭。Nginx 源资产仍通过授权 API 的内部 origin，Private 不获得公开静态旁路。普通 resource 支持既有缓存与 Range 契约。

## 14. 当前场景的合法版本迁移及真实运行态更新

使用原有真实测试 Owner `8b65607e-e602-494c-ab4e-828fa51ce4c6` 的正常密码登录会话和 CSRF，在既有 edit-session / upload / complete / publication CAS 流程提交**同一原始 PLY 字节**；没有伪造 Owner、直接更新 SceneVersion 或绕过 publish job。

| 字段 | Before | After |
| --- | --- | --- |
| visibility / status | PUBLIC / PUBLISHED | PUBLIC / PUBLISHED |
| SceneVersion UUID | `68cb9e7b-11a5-44d8-9070-e146b9e55aba` | `ef369c74-a9ea-4459-af88-4d8148a85ace` |
| Asset version / format | `c10c127b4574 / streamed-sog` | `21c371259407 / sog` |
| Count | `1788/536/179` | `[1788]` |
| Source SHA | `b2cc7bb1...` | 完全相同 |

Edit ID `4b893f56-9670-44ec-ad47-999025e893d1`，upload `2a5a5337-5d24-4acf-84ed-b63c4c1d9931`，真实结果 COMPLETED / SUCCEEDED。这一步是**合法同源格式迁移**，不冒充真正 Editor 导出的证据；真正 Editor export 单独见第 17 节。数据库更新不在 Git 中，合法 API 响应和最终 DB 只读查询见 [current-upgrade.json](vr01b-evidence/current-upgrade.json) / [closure.json](vr01b-evidence/closure.json)。

## 15. 正式 Runtime / Desktop / XR 软件加载

匿名真实 HTTP：Scene **200**、Runtime **200**、scene.sog **200**（36760 bytes / SHA 已核对）、`Range: bytes=0-31` **206**，`Content-Range: bytes 0-31/36760`。

```json
{
  "content": {
    "format": "sog",
    "url": "/api/v1/scenes/u-a68b94d84538/assets/versions/21c371259407/scene.sog"
  }
}
```

匿名 `/scene/u-a68b94d84538`、`/xr/u-a68b94d84538`、`/xr/diagnostics/u-a68b94d84538` 真实浏览器加载，无本地 manifest 回退，无 asset 401/403，`isManifestFallback=false`。每条正式路径 4×2 秒持续采样 **1788**，XR 强制 **WebGL2**。Desktop 此无头环境实际使用官方 WebGL2 fallback，官方 WebGPU 默认选择未修改。

实际 Desktop `performanceMode=false`，identity world transform，自动取景相机首次样本 `[4.8168,2.8543,16.1481]→[-0.3862,0.2528,10.9451]` / FOV85；XR 首次样本 `[4.7916,2.8499,16.0636]→[-0.3560,0.2708,10.9056]` / FOV85。没有 author initial pose；官方自动动画使后续姿态可变化，因此这些不是第 6 节的固定对照镜头。见 [live-browser.json](vr01b-evidence/live-browser.json)、[Desktop 截图](vr01b-evidence/desktop.png)、[正式 XR 截图](vr01b-evidence/formal-xr.png)。

诊断无头 Chromium `canStartVR=false, immersiveVrSupported=false`，但 secureContext、资源及 WebGL2 软件加载通过。未把它算作进入 immersive-vr 或 PICO 帧率测试。缺失 poster 返回 404 是既有非必需缩略图缺失，不是 Gaussian 资源错误。

官方文档预算参考：Performance Mode on/off 时 Desktop **2M/4M**、Mobile/XR **1M/2M**。这些是官方动态预算上限而非PICO Neo3已验证性能；本机正式XR软件页不是头显immersive session，没有据此推断PICO可以稳定画到百万点。

## 16. 旧 Streamed SOG 与 13M 资产保护

旧小场景 `c10c127b4574` 全部 **22 文件**在更新后再次哈希核对，逐字节不变，原 Manifest / Recipe v2 / counts `[1788,536,179]` 不变。直接实际请求旧 API entry，用 pinned official Viewer 加载成功；旧包通过原 Validator。

“XR 当前是179还是1788”必须区分瞬间与最终状态：此前 VR-01A 首次诊断采到179；本轮固定相机官方 streamed Viewer 60秒及移动后均采到 **1788**，真实请求先读 LOD2、再读 LOD0，因此不能宣称旧版本永远卡在179。新普通 SOG 没有这个 LOD 选择问题，持续1788。见 [old-stream-timing.json](vr01b-evidence/old-stream-timing.json)。

| 历史 13M 只读事实 | 实际值 |
| --- | --- |
| Scene | `u-06924576399e / e2f54542-40a1-494f-b260-ad8fd28156e6` |
| Current SceneVersion | `01c63c7c-8eb5-498e-bcc0-77215e92ca12` |
| Asset version | `da7bf4207044`，streamed-sog |
| Source SHA256 | `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` |
| Original source size | `3246401885 bytes`，约3.2GB，来自历史 catalog 元数据 |
| LOD counts | `[13090324,3927097,1309032]` |
| Chunk metadata / WebP / all files | `259 / 1813 / 2076` |
| 全树严格验证 | 7.082秒，通过；最终2076文件全部hash未变 |
| 匿名 descriptor / metadata / sample chunk | 200 / 200 / 200 |

隔离 catalog 原本已有只读公开历史版本引用；只读访问共享已发布目录，不改共享 DB、权限、current_version_id 或文件，不重跑 13M 转换/碰撞。没有用此元数据检查宣称 PICO 可流畅加载整个13M模型。

## 17. 编辑、SourceVersion CAS、Spatial STALE 与 Collision

真正的 Editor 验证使用已有官方 **SuperSplat Editor v3.5.2** 部署；浏览器 WebGPU / NVIDIA。Owner 在普通 SOG 私有场景 `u-3b48959f67fd` 通过正式编辑页打开源，官方 Editor 读取1788，菜单导出 PLY **100488 bytes** / SHA `282015f4c82a52f781227abe9848f428ac310da011cce6c2debb2c5d57de5144`，上传真实导出文件，正式 publish COMPLETED，新 `SceneVersion=afc81533-69b6-4ab0-b8f5-2442a4e7cd38 / assetVersion=3d2fb2b33822`。场景保持 PRIVATE。见 [editor-roundtrip.json](vr01b-evidence/editor-roundtrip.json)及 Editor 截图索引。

官方 export 的 SHA 改变反映读取有损 SOG 再导出 PLY，不假称原始训练 PLY 逐字节回转。旧流式编辑入口仍允许披露并选择 LOD0，已有流式 source / admission / Owner 权限测试保留。

SourceVersion row lock / CAS、过期编辑、其他用户拒绝、结果私有隔离、Provenance 和空间绑定规则没有绕过。现有规则按 `new version UUID != source version UUID` 保守标记 **STALE**；当前同源格式迁移和真正 Editor export 都遵循这一规则，不能因同源 SHA 擅自保留旧空间标定。普通 SOG 的 source count 从 `content.counts` 读取，旧流式从 `stream.counts` 读取。

运行场景 CollisionPolicy 仍 **MANUAL_ONLY**，未自动触发任何 Collision。手动构建仅将源 entry resolver 从固定 lod-meta 扩展为真实 `.sog` / `lod-meta.json`，原 voxel 算法、sourceVersion、fencing、execution generation、lease heartbeat、CAS、atomic finalize 不变。专用 PostgreSQL Worker tests 对两种源格式实际执行官方 Collision CLI，通过；这不是对当前场景或13M生成碰撞。

## 18. 真实上传、格式直通和 Private 回归

正常 Owner 上传相同1788源 PLY：

- 省略 visibility → staging PUBLIC，`u-9be04c2a9fac`，普通 SOG，上传到发布9.309秒。
- 明确 PRIVATE → `u-3b48959f67fd`，普通 SOG，匿名 Runtime/asset 均401，Owner Range206。后续真正编辑发布仍 PRIVATE。
- 普通 `.sog` 再上传 → `u-2b08ce941569 / ade42bbf1302`，6.954秒；输出与输入**逐字节相同**，没有重新有损压缩；另外保留固定CLI支持的legacy V1逐字节直通回归。
- 将旧小场景预构建流式目录打成安全 ZIP，再正常上传 → `u-90c5a107f65e / b98021ea426c`，5.525秒，Recipe v2 streamed-passthrough，保留 `[1788,536,179]` 和真实 entry bytes，未改原旧目录。

后三类资产都由正式认证 API / Celery / PublishService 登记，不直接注入数据库。SOG passthrough 与旧 Streamed passthrough 的 Desktop / 正式 XR 路径各做8×2秒采样，最终均 **1788 / WebGL2 / no fallback / no errors**。流式正式 XR 确实到 LOD0，不仅是桌面相机成功。见 [live-upload.json](vr01b-evidence/live-upload.json)、[live-prebuilt.json](vr01b-evidence/live-prebuilt.json)、[prebuilt-browser.json](vr01b-evidence/prebuilt-browser.json)。

真实 SPLAT binary64点→普通 SOG64点、真正 SH1 源→普通 SOG保留 SH1、安全 ZIP passthrough / 不合法容器拒绝在 installed CLI Worker suite 中执行。没有要求用户转回 PLY。

## 19. 真实官方 CLI 命令、产物和耗时

CLI 路径来自锁定 pnpm 包：

```bash
CLI=node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs
node "$CLI" --version
node "$CLI" --help
node "$CLI" "$SOURCE" --info json --stats json null
node "$CLI" -g cpu "$SOURCE" "$PROBE/scene.sog" --sh-iterations 10 --no-tty --max-workers 0
node "$CLI" "$PUBLISHED/scene.sog" --info json --stats json null
node "$CLI" "$PUBLISHED/scene.sog" "$EVIDENCE/published-decoded.ply" --overwrite --no-tty
```

第一次直接普通转换耗时 **2.025秒**，36760 bytes；正式当前 publish BuildInfo 编码 **3.126秒**，转换总计 **3.385秒**，CPU，exit0，full count1788，没有 decimation 命令。真实 BuildInfo / Manifest 见证据目录对应 JSON。

为验证新四层 writer 的真实文件格式，使用内部显式 fixture Recipe（1788同源，仅验证encoder，**不改变生产1M策略、不把它称作1M真实源转换**）：

```bash
node "$CLI" -g cpu raw-input.ply --decimate 50% lod1.ply --overwrite --no-tty --max-workers 0
node "$CLI" -g cpu raw-input.ply --decimate 25% lod2.ply --overwrite --no-tty --max-workers 0
node "$CLI" -g cpu raw-input.ply --decimate 12.5% lod3.ply --overwrite --no-tty --max-workers 0
node "$CLI" -g cpu raw-input.ply --tag-lod 0 lod1.ply --tag-lod 1 lod2.ply --tag-lod 2 lod3.ply --tag-lod 3 lod-meta.json --lod-chunk-count 64 --lod-chunk-extent 32 --sh-iterations 10 --overwrite --no-tty --max-workers 0
node "$CLI" "$STREAMED/lod-meta.json" --info json --stats json null
```

真实 output `89985d1552ed / lod-meta.json`，官方 `format=lod, numLods=4, lodCounts=[1788,894,447,224]`；严格 Artifact Validator 通过。产物 BuildInfo 总计 **9.913秒**（已验证 decimation marker 复用，STACK 8.452秒），再次调用含产物复用和检查 **10.478秒**，证据 [real-streamed-cli.json](vr01b-evidence/real-streamed-cli.json) / [real-streamed-info.txt](vr01b-evidence/real-streamed-info.txt)。此夹具仅放专用本机证据目录，不作为当前场景发布。原小场景按默认策略始终输出普通 SOG。

## 20. 完整回归结果与门禁

所有数据库/事务测试使用专用真实 PostgreSQL，不是 SQLite 或仅 mock transaction。installed 工作区的主回归均无 SKIP。

| 命令 | 实际最终结果 |
| --- | --- |
| `cd apps/api; .venv/bin/python -m ruff check app tests` | exit0，All checks passed |
| `.venv/bin/python -m mypy app` | exit0，94 source files |
| `.venv/bin/python -m pytest tests -q -o addopts=''` | **558 passed / 0 skipped，858.42秒，exit0** |
| `apps/api/.venv/bin/python -m pytest workers/tests -q -o addopts=''` | **153 passed / 0 skipped，172.32秒，exit0**，含末审legacy V1直通兼容 |
| `pnpm typecheck` / `pnpm lint` | exit0 / exit0 |
| `pnpm test` | **29 files / 274 tests passed，11.88秒，exit0** |
| `pnpm build` | exit0，Vite 14.60秒；既有 >500KB chunk / worker externalization warnings，不作为消失的问题报告 |
| `pnpm --filter @gsplatform/web exec playwright test -c playwright.vr01b.config.ts` | **7 passed，最终新HTTPS下1.1分钟，exit0**；真实 public/private/regular3routes/旧version/13M资源，无 mocked Gaussian |
| 官方 Editor 实际浏览器脚本 | import1788→真实export→publish COMPLETED，PASS |
| 额外预构建格式实际浏览器脚本 | SOG和Streamed ZIP各 Desktop / XR，4路径全通过 |

初次新增 API fixture 因在同一 ORM transaction 同时设置循环外键导致 CircularDependencyError；修正测试 fixture 的事务建立顺序，focused3和完整558通过，不改产品DB关系。保留真实 RED 日志，不把中间失败藏成一次全部成功。

## 21. Clean checkout 与 SKIP 的边界

在最终代码 HEAD `fa4ef0b420e17e69792df8a3636b41246480df8b` 使用专用 clean DB / storage / rate-limit env 运行原 `./deploy/scripts/verify_release_source.sh`，真实 `git archive HEAD`、fresh Python deps、imports、Ruff、Mypy、tests、fresh recon runtime，**GATE_EXIT=0**。见 [clean-closure.txt](vr01b-evidence/clean-closure.txt) / [clean-closure-exit.txt](vr01b-evidence/clean-closure-exit.txt)。

该脚本默认不执行Web构建，须使用 `--with-web-build`；不把末次默认调用伪装成执行了Web阶段。之前70f代码的 `--with-web-build` 完整归档验证为GATE_EXIT=0（[clean-final.txt](vr01b-evidence/clean-final.txt)）；最后legacy修改后，另外用 `git archive fa4ef0b...` 创建全新目录，执行 frozen pnpm install / typecheck / lint / test / build，作为最终独立干净Web门禁：**274 tests通过、build5.27秒、CLEAN_WEB_EXIT=0**，见 [clean-web-closure.txt](vr01b-evidence/clean-web-closure.txt) / [clean-web-exit.txt](vr01b-evidence/clean-web-exit.txt)。

必须单独列出而不能算 PASS：

- clean Backend：**550 执行通过 / 8 SKIP**（3个 `.git` tracking 测试：archive 没 `.git`；1个API-only venv没有torch/gsplat；4个 release cwd fixture：该阶段尚未构建 web dist）。
- clean Workers：**120 passed / 33 skipped**：31个需要 pinned CLI（workers测试发生在 pnpm install 之前），2个需要 Git history（archive无`.git`）。另外实际 collection 审计记录每类 skip marker 的数量，见证据目录 `worker-skip-audit.json`。此前70f版本为120/32，新增一个legacy CLI测试后为120/33。
- 所有对应 installed 环境测试均已另行真实执行：Backend558、Workers153（含legacy兼容），无SKIP；CLI大小两种格式均有真实转换证据。
- clean重建运行时另起fresh venv，实际 torch `2.14.0+cu126`、gsplat `1.5.3`、两张RTX A6000，最终8个测试Gaussian产生106个lit pixels，PASS。这是tiny runtime gate，不是13M重建。

文档闭环提交只新增报告、日志、截图与去敏证据，应用代码和上述tested HEAD一致；不因文档提交擅自重跑用户大型作业。

## 22. T01–T24 验收矩阵

| ID | 验收 | 证据 / 结果 |
| --- | --- | --- |
| T01 | 1788→Regular SOG | 实际源CLI、liveUpload、当前version PASS |
| T02 | 999999→Regular SOG | 严格服务端inspection mock PASS |
| T03 | 1000000→Streamed SOG | 精确边界mock PASS |
| T04 | 1000001→Streamed SOG | 精确边界mock PASS |
| T05 | 全量有效Gaussian | 源/解码/发布/实际帧1788 PASS |
| T06 | 普通SOG Desktop | 真匿名DB descriptor、持续1788 PASS |
| T07 | 普通SOG正式XR | 真DB descriptor、WebGL2、持续1788 PASS（非immersive） |
| T08 | 旧流式版兼容 | c10实际API+officialViewer；预构建旧包正式XR LOD0 PASS |
| T09 | SourceSHA+Recipe身份 | v2/v3/backend/index/env/retry tests PASS |
| T10 | 两格式互不覆盖 | 同一scene两version+旧22文件hash不变 PASS |
| T11 | StreamedZIP passthrough | 真上传、entry一致、Desktop/XR PASS |
| T12 | SOG上传安全 | 真SOG逐字节直通+容器安全tests PASS |
| T13 | SPLAT | binary64→SOG64真CLI PASS |
| T14 | Editor导出新版 | 未修改官方Editor真WebGPU→导出PLY→private新version PASS |
| T15 | SourceVersion CAS | PostgreSQL并发/Owner/editor regression PASS |
| T16 | Spatial STALE | 保留旧失效规则；current及editor均STALE PASS |
| T17 | MANUAL_ONLY | 运行0collisionJob；手动两源格式CLI tests PASS |
| T18 | ACL | Anonymous public200、private401、Owner、other403、share/CSRF regression PASS |
| T19 | 无效SOG拒绝 | traversal/invalidWebP/duplicate/container tests PASS |
| T20 | 损坏禁止发布 | missing/corrupt/recipe/checksum/escape tests PASS |
| T21 | 颜色/几何同源对照 | 固定相机PNG、误差JSON、透明量化边界 PASS |
| T22 | 失败/超时/幂等 | owned subprocess timeout reaping、bounded log、marker/lock/reuse PASS |
| T23 | 13M只读完整 | unchanged2076hash、259metadata、sample resources PASS；未全场景头显性能测试 |
| T24 | 匿名PUBLIC打开 | 真HTTPS Desktop/XR/diagnostics PASS |

## 23. 画质限制、PICO复测与最终 HEAD

画质根因：**源 PLY 本身是1788点、SH0、1200步draft灰白模糊重建；旧强制3级LOD进一步减少初始细节。**新普通 SOG保证这个小源不被不必要LOD减量，但不会凭空变成农业场景，也没有“修复白色颜色”的虚假后处理。SOG官方量化误差、源物理单位未标定、大场景预算/性能仍有边界。

PICO Neo3 复测：

1. 确认本机 `./scripts/gsplatform-vr.sh status` / `urls`，Quick Tunnel可能再次变化。
2. 不需要Owner登录，在头显打开 [正式场景 XR](https://referral-tips-unlike-wants.trycloudflare.com/xr/u-a68b94d84538)。
3. 在 [正式诊断入口](https://referral-tips-unlike-wants.trycloudflare.com/xr/diagnostics/u-a68b94d84538) 核对 `.sog / 21c371259407`、loaded=true、gsplats=1788、WebGL2，而不是本地manifest。
4. 手动点击进入VR；观察双目形状/灰白低质量源特征，测试头部跟踪与既有摇杆移动转向，记录眼前尺寸、帧率/卡顿。没有物理标定或碰撞，不把自由移动称为物理walk安全保证。
5. 若期望的是农业场景，请提供正确源模型身份；本轮没有把13M或其他源冒充1788测试源。

Final tested/deployed application HEAD：**`fa4ef0b420e17e69792df8a3636b41246480df8b`**。本报告的Git文档闭环提交可用以下命令精确定位（文档不包含自引用commit SHA，避免伪造循环身份）：

```bash
git log -1 --format='%H %s' -- docs/reports/VR_01B_OFFICIAL_SOG_POLICY_AND_FIDELITY.md
git rev-parse HEAD
git rev-parse origin/main
```

最终提交/push验证的全长SHA在任务最终回复提供。完成后停止，不开始VR-02/03/04；等待用户PICO Neo3物理验收。

**VR-01B: PASS — OFFICIAL SUPERSPLAT POLICY ALIGNED / REGULAR SOG VERIFIED / STREAMED SOG PRESERVED / GAUSSIAN FIDELITY VERIFIED / READY FOR PICO NEO3 RETEST.**

## 证据索引与保留位置

- Git小型证据：[vr01b-evidence](vr01b-evidence/README.md)，仅真实截图、诊断/统计JSON、CLI/测试输出；没有PLY或SOG资源文件。
- 完整本机日志、脚本、只读对照输入和临时产物：`/home/test/.local/state/gsplatform-vr00-20261011/vr01b`；源用户文件仍在原目录，未删除。
- 官方Web资料原文、Context7结果用于研究；实现以本机3.3.3 / 1.35.0实际帮助与源码为准。
