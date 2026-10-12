# VR-01D — 官方 Gaussian 清理实验与候选保真评估

**日期：2026-10-12。状态：PARTIAL / WAITING FOR USER REVIEW。**

已真实执行完整源统计、官方Box连续ROI提取、官方Floater Pilot、八张官方Viewer同camera截图和软件测试。**没有完整13M过滤、没有发布、没有PICO帧率结论。**

## 1. Git 与边界

- Starting HEAD / origin/main：`925fb15f506188bcb045d53b7d7af9c5e2c5d603`，分支main，项目`/fj/GSPlatform`。
- 用户原89 tracked文档删除与未跟踪`docs/GSPlatform_WebXR_VR_Master_Plan.md`保留，不恢复、不清理、不提交。
- 无reset/clean/force push，无消费者重启，无正式数据库写入，无Publish/Collision/reconstruction job启动。
- 新模块只做显式实验，默认上传管线及官方Renderer/LOD算法未改；依赖与lockfile未升级。

## 2. 历史源与正式资产

| 项目 | 验证值 |
| --- | --- |
| Scene | `u-06924576399e` |
| SceneVersion/current_version_id | `01c63c7c-8eb5-498e-bcc0-77215e92ca12` |
| AssetVersion | `da7bf4207044` |
| Source Gaussian count | **13,090,324** |
| Source PLY bytes | **3,246,401,885** |
| Source SHA256 | `8e49f56ba29208eebcef4cba6c2d74d5ee7be50e45c27482533fd04ff108e764` |
| Format/recipe | streamed-sog / Recipe v2 |
| LOD0/1/2 | 13,090,324 / 3,927,097 / 1,309,032 |
| Chunks/files | 259 / 2,076 |
| Scene状态/权限 | PUBLIC / PUBLISHED；未修改 |

只读源：`/home/test/gsplatform-data/published/e2f54542-40a1-494f-b260-ad8fd28156e6/.workdir-da7bf4207044/raw-input.ply`。没有输入副本或覆写，原始文件作为CONTROL_ORIGINAL。全文件SHA先完整校验；发布树2,076文件先保存SHA map。开始Scene版本1个、Collision记录0个；隔离DB全局历史PUBLISH/SUCCEEDED 7个，该Scene关联job行0个；结束复核见第18节。

## 3. 官方能力依据

实际命令输出：`splat-transform v3.3.3 (d092ae9)`。本地固定包路径`node_modules/.pnpm/@playcanvas+splat-transform@3.3.3_playcanvas@2.22.0/node_modules/@playcanvas/splat-transform/bin/cli.mjs`。

本轮调用固定`--version`、`--help`、`--list-gpus`；Context7先resolve `/playcanvas/splat-transform`，再抓docs，另核对固定包源码与v3.3.3 README，不将main的新接口用于固定版。Viewer Context7出现新版stochastic/splatSource字段时未采用，截图使用本地1.35.0公开类型和docs。

权威来源（直接HTTPS抓取并保存在私有`official/`）：

- https://developer.playcanvas.com/user-manual/splat-transform/cli-reference/
- https://developer.playcanvas.com/user-manual/supersplat/editor/editing-splats/
- https://github.com/playcanvas/splat-transform/tree/v3.3.3
- https://github.com/playcanvas/supersplat
- 本地`@playcanvas/supersplat-viewer/docs/api.md`、`dist/viewer.d.ts`、Engine2.22.4。

| 参数 | 固定版语义/默认 | GPU/单位/SH/流式 |
| --- | --- | --- |
| `--filter-floaters` | 不能贡献到solid voxel的Gaussian删除；size0.05、opacity0.1、contribution实际1/255（help四舍五入0.004） | GPU voxelization，桥接完整DataTable/BVH，不是端到端streaming；size依赖坐标单位；保留行不改SH |
| `--filter-box` | 保留中心在min/max角内，边界包含 | CPU streaming；使用CLI Runtime坐标，影响数量、不改保留SH；不包含完整Gaussian支撑范围 |
| `--filter-cluster` | 保留seed所在连通solid voxel cluster重叠Gaussian；1.0/0.999/0.1 | GPU、全表/BVH，单位相关；可能丢合法不连续对象；无可靠seed未执行 |
| `--seed-pos` | 官方默认0,0,0 | seed用Runtime坐标；平台必须显式源空间seed并转换，拒绝隐式默认 |
| `--filter-nan` | 删除NaN、多数Inf与零范数rotation；源码允许opacity±Inf及scale−Inf | CPU streaming；改变数量，不改SH；此源无非有限值，因此未套过滤 |
| `--filter-value` | 真实列lt/lte/gt/gte/eq/neq；opacity阈值必须严格0..1、scale用线性单位比较 | CPU streaming；不能把低opacity/大scale自动认作废点；未在真实源套用 |
| `--stats json` | 完整列min/max/mean/stddev/nonfinite，近似median/histogram与fillRatio | streaming只读CPU；不是屏幕实测GPU overdraw |
| `--info json` | 格式、数量、LOD、SH、extra columns结构 | 对PLY无需完整decode，只读CPU |

官方操作依次执行、不具有交换性；Box改变邻域后Floater结果可能改变。输入/输出格式PLY支持，输出不自动覆盖；本轮保持未压缩PLY，未再编码SOG、未截SH、未scale/rotate Gaussian。GPU0/1为RTX A6000、adapter2为llvmpipe；Pilot实际telemetry为NVIDIA ampere WebGPU。

## 4. 全量13M只读统计

不是低LOD/随机样本。`gaussian_quality.py`使用完整binary float PLY只读memmap，131072行块扫描；一维完整列精确P01/P05/P50/P95/P99，32³中心直方图不是聚类/过滤算法。耗时29.856s，进程峰值RSS3,723,564KiB（含映射页，不是私有heap测量）。

源坐标中心bounds：X[-573.665588,327.345367]、Y[-36.201385,539.327148]、Z[-275.317566,784.279541]。

精确源P01–P99：X[-273.257775,118.049759]、Y[11.393956,43.127471]、Z[-122.675824,435.816275]。

源码/官方PLY convention与当前identity世界变换：Runtime=`(-sourceX,-sourceY,sourceZ)`（Z180），不是只翻Y。Runtime全bounds：X[-327.345367,573.665588]、Y[-539.327148,36.201385]、Z同源；Runtime robust：X[-118.049759,273.257775]、Y[-43.127471,-11.393956]、Z同源。不自动worldScale，不宣称米制、不把bounds中心当合法出生点。

| 分布 | P01 | P05 | P50 | P95 | P99 |
| --- | --- | --- | --- | --- | --- |
| sigmoid opacity | .00307038 | .00380834 | .17176772 | .99992745 | .99999193 |
| exp(scale0) | .00032418 | .00189197 | .07515101 | 1.00416234 | 1.71117359 |
| exp(scale1) | .00012300 | .00060661 | .01600846 | .35432144 | .99880999 |
| exp(scale2) | .00044802 | .00257432 | .07643405 | 1.11467540 | 1.91404939 |
| max exp(scale) | .03697416 | .06560760 | .34887209 | 1.41817512 | 2.18929478 |

opacity<.01：2,913,422；<.05：4,978,694；<.1：5,831,459。max linear scale>2：186,731；>5：12,900；>10：3,697；>20：530；最大83.387279。以上只是统计，不是删除名单。

全部62个存储float列NaN=0、Inf=0。SH为degree3（45个rest +3个DC，16个系数/通道），未去掉SH。DC系数P50(R/G/B)=.192141/.190919/−.401902，DC-only未clip RGB P50=.554202/.553857/.386626；不是实际受SH方向/色调映射影响的屏幕颜色。完整各色分位数在`analysis/source-quality.json`。

P01/P99同框32³中心grid：32,768格，11,853格占用，12,310,842中心落入框；占用格中位59、P95 5856.8、最大30684。不判断连通簇、不自动去噪。

## 5. 疑似废点与过绘制风险

Runtime Y<−50：**7,227 / 0.0552087%**；Y<−100：**1,952 / 0.0149118%**。全量替代VR-01C稀疏尾部样本：Y<−50 opacity P50=.300927、max scale P50=8.393382/P95=20.931488；不能沿用旧113样本的.7453估计。位置统计不等于废点分类。

最大的scale0 Gaussian源中心(-131.882828,250.727249,427.436523)，Runtime中心(131.882828,−250.727249,427.436523)，scale0=83.387279，opacity约.999995。它可能扩大support bounds并造成大投影，但单点是否为真实背景残留仍未确认；不在本Pilot ROI内。

官方完整`--stats json`实际55.484s，child peak RSS377,004KiB；CPU、NaN/Inf0、**fillRatio=51.319794**。源码定义：所有Gaussian两大linear scale的1σ椭圆面积和 / P01–P99中心范围平均截面积；median/robust边界内部用近似直方图。不依赖当前camera、不代表双目屏幕真实overdraw，也不是GPU profiler。真实GPU overdraw/time=`unavailable`；Gaussian-weighted visual bounds=`unavailable`。

极端少量点对全bounds影响明显，但0.055%点减少不能推出显著VR加速。高opacity大scale残留可能通过solid voxel而不被Floater删；Pilot证实底部大扩散影像仍在。不把加载、GPU及透明overlap瓶颈预先统一归因于废点。

## 6. 连续ROI选择与官方Box控制组

源空间20-unit XZ尾部中心直方图的最密cell[-60,-40]×[300,320]含244个Y>50点。加10-unit lateral halo与源Y15..110形成Box `(-70,15,290,-30,110,330)`，94,747中心（502个Y>50、9个Y>100），同时含真实地面/细草与疑似底部残留。不是随机稀疏采样。

第一次将源Box误当官方Runtime参数，仅产生1点，被删除率安全门禁判FAILED，证据保留`pilot/CONTROL_ROI_WITH_HALO/`，没有进入候选。发现固定版PLY读取的Z180后修复薄适配，增加不对称真实CLI回归；没有改官方代码。

正确CLI Box=`30,-110,290,70,-15,330`。生成`CONTROL_ROI_SOURCE_SPACE/candidate.ply` **94,747点，23,498,786bytes**，SHA `bfdcbc08aa184337e45f526fa8f2381af42f05831ed575d2d19d181ff1aee4e2`，25.790s（含两次源hash）。与完整源对应中心行的**全部62列逐位相同**。Box只是Pilot抽取，不是删除99.276%的正式候选，不能用于发布。

## 7. 官方Floater真实Pilot

输入为上述完整连续ROI；输出`candidates/CANDIDATE_FLOATERS_PILOT/candidate.ply`。参数**0.25,0.1,1/255**：局部max scale P50=.175465/P95=1.154774，选择0.25个未标定源单位作保守资源实验；opacity/contribution取实际官方默认。默认size.05的相同support extent会使总grid约125倍，未执行默认.05Pilot，更未照搬到13M。

CLI实际support extent104×115×127，grid416×464×508（约98.1M voxels），occupied blocks约75.7K。0.25不是新的Floater判别算法，仅官方参数；没有把日志中的m/cm单位当作真实场景标定。

结果：**94,747→93,982，删除765 / 0.807413427%**。output23,309,066bytes、SHA `2a1850294075ab0adbf54a0a86d049c5199abd118cc2685caf329c4e10b96da0`。wrapper6.095s，CLI4.125s，peak CPU440.5MB / GPU17.8MB为官方工具自身观测；独立child peak451,092KiB。不是整张GPU显存变化测量。telemetry明确NVIDIA RTX A6000/ampere、WebGPU。

输出有限、同62列schema、SH3；保留行多重集逐位相同，源ROI hash前后相同。无SOG压缩、无decimate、无尺度修改。

## 8. 数量、空间与属性对比

- 源ROI X/Z极值不变；源Y[29.957111,108.509598]→[30.762619,104.838867]，不是坐标原点迁移。
- 原/候选max scale P50 .175465→.174812、P95 1.154774→1.139086、P99 2.450331→2.410720，最大20.288972仍保留。
- opacity P50 .450635→.456868、P05 .017120→.017683；保留点的opacity/scale/SH没有改值，只是总体分布因删除改变。
- 同一**原ROI**P01/P99 grid：占用7198→7044、154格新增空格、0格数量增加。新增空格不是自动判定孔洞。
- 765被删中心中193在内层review core X(-60,-40),Z(300,320)；并非全部边界点。被删opacity P50=.052023、P99=.099974；max scale P50=.280871、P95=2.671297。薄结构可能低opacity，不能据此安全。
- 尾部Y>50只删67，502→435；Y>100只删4，9→5。绝大多数被删中心在主体高度附近；高opacity底部残留仍可能保留。
- 文件小189,720bytes；官方fillRatio45.114467→44.113216（−2.21936%）。此几何proxy不是实际GPU/VR改善百分比。

## 9. 四视角真实对照（ROI_ONLY）

先尝试固定官方CLI lossless WebP image：GPU0 960×540/120s、GPU1 640×360/90s，均停在Cull阶段超时；owned process group安全退出，不改/升级官方Rasterizer、不捏造截图。原因未证实，不能仅归因外部GPU任务。

替代：锁定**SuperSplat Viewer1.35.0 / Engine2.22.4**，相同Chromium WebGL2 SwiftShader、960×540、PerformanceMode OFF、toneMapping none、background .05、无额外post effects、identity world transform。只绑定127.0.0.1的临时实验服务，完成后关闭，不变成私有资产公开旁路。软件GPU必须如实标注，非RTX/PICO渲染性能。

第一轮发现官方默认camera animation使各截图pose不同，废弃该轮比较（证据仍保留）；第二轮`noanim=true`并断言实际camera与settings误差<.001。最终八张截图各camera/FOV/renderer逐项匹配，viewer.loaded=true且实际统计94,747/93,982。

| View | Runtime position→target | FOV | RGB MAE /255字节域 | 像素max差>2比例 |
| --- | --- | --- | --- | --- |
| A 局部整体 | (100,−50,370)→(50,−50,310) | 60 | .062593 | .859761% |
| B 底部残留 | (75,−95,350)→(50,−85,310) | 60 | .001872 | .036458% |
| C 草地/主体细节 | (62,−28,340)→(50,−34,315) | 60 | .273920 | 4.684221% |
| D Pilot大scale区 | (92,−75,320)→(50,−75,310) | 60 | .038064 | .576775% |

截图真实路径：私有`comparisons/{A_overall,B_bottom,C_detail,D_large_scale}_{original,filtered}_fixed_camera.png`与`roi-fixed-camera-contact-sheet.png`。直接查看图像（模型自身视觉），没有调用外部vision；C视图地面、草状细结构仍在，未看到明确大块主体消失，但细节像素变化与154空格/193内层点需Owner判别。A/B/D大扩散残留仍明显。**不签署全场景保真PASS，也不将细叶安全推断为真。**

## 10. 候选判定与Box/Cluster适用性

`CANDIDATE_FLOATERS_PILOT`数值完整性通过，状态WAITING_FOR_APPROVAL；quality review **HOLD_NOT_APPROVED / ROI_ONLY**。没有明确主体严重丢失证据，但也没有充分证据确认765点都是无效点。若Owner发现真实细叶/草地/玻璃损失，立即REJECTED，停止该参数推广。

全场景Box：没有可靠多角度确认的保留区域，未生成CANDIDATE_ROI。此次Box仅抽取测试包络，绝不能将其保留区域用于正式场景。Cluster：多合法不连续对象、无可靠seed/连通簇证据，未执行。Editor手动选区/裁剪可用于后续Owner审阅；本轮不自动应用任何一种。

## 11. 完整13M候选决定

**FULL_SCENE_CANDIDATE_NOT_EXECUTED。保留全场景的13M清理候选生成次数=0、候选发布计数=0；官方Box扫描完整源仅用于连续ROI抽取。**

源SHA与隔离目录条件满足，剩余约49GiB开始/45GiB中途；内存125GiB、available67GiB开始，但swap7.9/8GiB；RTX A6000两块可见。开始GPU0/1利用率69%/100%，外部agri_disaster Python训练占用，不终止它们。隔离publish/cpu/gpu active/reserved均0，消费者未重启。

只在GPU瞬时降到1%/0%时运行6秒有界Pilot；外部任务仍可能反复活跃，完整GPU/voxel需求未证明。最重要：Pilot没有通过薄结构保真安全审批，且底部大残留仍在。默认.05grid开销与全场景support extent未验证。**条件D3(资源无争用、Pilot安全、可靠资源预算)未全部满足，不能为了生成一个完整文件强行继续。**

## 12. 可复现调用与输出

命令以下以`CLI`指固定3.3.3；源/输出均为绝对路径。每次经既有adapter版本校验、telemetry、timeout，不传`-w`。

```text
node CLI --version
node CLI --help
node CLI --list-gpus
CLI -g cpu SOURCE --info json null --no-tty --memory --max-workers 0
CLI -g cpu SOURCE --stats json null --no-tty --memory --max-workers 0
CLI --gpu cpu SOURCE --filter-box 30,-110,290,70,-15,330 --info json --stats json CONTROL_ROI.ply --no-tty --memory --max-workers 0
CLI --gpu 0 CONTROL_ROI.ply --filter-floaters 0.25,0.1,0.00392156862745098 --info json --stats json PILOT_CANDIDATE.ply --no-tty --memory --max-workers 0
```

证据根`~/.local/state/gsplatform-vr00-20261011/vr01d/`：analysis（完整源/official stats/DB与hashmap）、pilot（含失败与成功控制组）、candidates（未批准ROI）、comparisons（逐位/空间/截图/像素差）、reports（测试与full-scene decision）、official（官方help/version/docs）。candidate-manifest、source-checksum、filter-config、cli-execution、quality-comparison齐备；大型文件全部在Git之外，未放published。

## 13. 平台最小处理契约

新增`workers/pipeline/gaussian_quality.py`（只读统计/差异）与`workers/pipeline/cleanup_experiment.py`（官方CLI白名单薄适配）。不新增DB表/Celery任务/API/上传钩子、不修改`convert_scene.py`/`conversion_policy.py`/SplatTransform/Viewer。唯一实际滤点算法仍来自官方包。

显式rationale/filters/seed/gpu/timeout/retention要求，完整hash验证，隔离目录与磁盘安全余量，失败可追踪、不覆盖、count/schema/finite/retained-row/SH校验。即便全部数值门禁成功也只能WAITING_FOR_APPROVAL。主体损坏REJECTED；绝无自动SceneVersion、Collision或current切换。详见操作指南。

## 14. 针对性软件测试

新增`workers/tests/test_cleanup_experiment.py`，最终37例：SHA错误、覆写/目录/符号链逃逸、非法参数/ROI/seed/GPU/unsupported、filter顺序与坐标转换、磁盘不足、CLI非零/timeout、owned child group退出、异常数量/NaN/schema/颜色改变、视觉REJECTED不合格、默认不发布、>1M完整过滤禁止、真实固定CLI Box与不对称坐标、只读统计/bitwise对比。

真实大型源Box与真实GPU Floater在本环境单独完成，不用mock证明实际清理/帧率；没有SKIP这两组实测。Archive缺CLI时真实fixture用例会如实SKIP，不能等于已执行。

## 15. Backend/Workers/Web与Playwright

- Backend ruff app/tests：PASS；mypy app94files：PASS。
- Backend全量pytest：**FAIL / EXIT1**，收集560例，26个既有`test_editor_publication.py`失败，其余534例通过。根因见第16节。
- Workers最终全量：**190 passed / EXIT0**，120.02s；新增37例全部通过，真实Box fixture未跳过。focused最终37 passed / EXIT0。前一轮189 passed为增加完整场景禁用测试前，不混作同一收据。
- Web typecheck/lint/test/build：EXIT0；30文件、283 tests；已有bundle体积warning，不新增未配置formatter。
- Playwright现有VR-01C四项：**4 passed / EXIT0**，local隔离入口http://127.0.0.1:5174（此回归不是PICO HTTPS验收）。真实小SOG ON/OFF+JSON、private拒绝、authored camera fixture、历史13M有界desktop A/B；不加载整套13M，不假装硬件。
- JSON导出/初始视角/鉴权仍正常；未改变XR代码、手柄/6DoF没有真机复测。聚合**GATE_EXIT=1**（Backend与Clean checkout失败），不能以局部门禁覆盖总失败。

## 16. 阻塞门禁：既有日期夹具

`apps/api/tests/test_editor_publication.py`的PublicationClock固定**2026-10-11 12:00 UTC**，publication_edit将expires_at设成+1day即**2026-10-12 12:00 UTC**。本次数据库创建时间已到2026-10-12 13:32 UTC之后，违反既有`expires_at > created_at`约束，26例失败。VR-01C较早执行时未触发这一日期界限。

没有改系统/DB时钟、没有关约束、没有skip失败测试、没有改无关出版业务掩盖错误。测试都使用独立`gsplatform_vr00_clean_20261011`，未写实际场景DB；下一步需要单独修复日期夹具为一致的可控时钟，再完整重跑。因全部关键门禁未通过，**不得输出VR-01D SOFTWARE: PASS，不提交/push交付代码**。

## 17. Clean checkout

用临时Git index+commit-tree建立source-only测试快照`7df575655c24103aa2ed57c8bb96203f5a5d56f0`，不checkout、不移动main、不改变用户真实index，不包含用户删除/私有数据。实际运行`./deploy/scripts/verify_release_source.sh --from-commit <snapshot> --with-web-build`：**EXIT1**。archive/import/ruff/mypy通过；backend阶段526 passed / 26 failed / 8 skipped（source archive无node环境用例），复现同26例日期失败。后续archive Workers/reconstruction/Web阶段**NOT REACHED**，不能称PASS或把SKIP当执行。快照三个code/test blob与最终工作树逐项一致，后续仅新增证据文档。

## 18. 历史完整性与环境安全

结束完整复核耗时20.626s：**原PLY与quarantine/upload.bin均3,246,401,885bytes、完整SHA均等于已知源SHA；2,076发布文件全部SHA与before逐项一致；完整SceneVersion/权限/Collision/关联job DB snapshot与before完全一致**。隔离DB全局仍PUBLISH/SUCCEEDED 7条、无其他状态，未新增job；Scene关联job0、Collision0。每次CLI前后源hash不变，ROI控制组对应源62列bitwise一致。`reports/immutable-final.json`记录收据。未启动正式发布、未修改已有Recipe v2、多级LOD及SceneVersion，不自动裁剪底部。

环境仍全部MANAGED且API健康；临时127.0.0.1:18881对照服务已关闭，CLI超时后的owned渲染进程已退出。最终可用磁盘约40GiB，未擅自删除其他人的临时文件。GPU/CPU其他任务继续，不重启/终止外部任务。

## 19. 硬件/发布未执行

PICO FPS、近景/双目负担、候选PICO A/B、导航/teleport、完整13M过滤/再编码、多层LOD新版本、自动Gaussian清理、collision重建均**NOT EXECUTED**。无PICO实测FPS不声称改善；未做候选发布，更未替换历史版本。

## 20. 建议与最终边界

2026-10-13先完成VR-01C真机A/B，回传frame time、rendered count、resource stalls、camera/rig与体验反馈。Owner审阅ROI草地细节、193个内层被删点与底部高opacity残留，确定目标主体及安全保留范围。当前**不建议发布此Pilot**，也没有完整候选可发布；不能简单按Y或opacity切全场景。

若需要下一轮清理，先评估官方Editor明确手动选择/裁剪，或更完整halo/局部参数证据，再决定是否允许一组完整13M Floater。只有明确审批后的cleaned source才能用官方Recipe产生新不可变SceneVersion，本轮不实现发布。到WAITING FOR USER REVIEW即停止，不开发导航、碰撞或农业功能。

## 21. Final HEAD与状态

Final HEAD仍`925fb15f506188bcb045d53b7d7af9c5e2c5d603`；无交付commit、无push（软件失败门禁阻止）。临时commit-tree仅测试对象，不是main上的提交。

```text
VR-01D SOFTWARE: PARTIAL
OFFICIAL SPLATTRANSFORM PILOT CLEANUP EXECUTED
NON-DESTRUCTIVE CANDIDATE WORKFLOW IMPLEMENTED
FULL_SCENE_CANDIDATE_NOT_EXECUTED
CANDIDATE QUALITY: HOLD_NOT_APPROVED / ROI_ONLY
PICO CANDIDATE PERFORMANCE: PENDING
WAITING FOR USER REVIEW
```
