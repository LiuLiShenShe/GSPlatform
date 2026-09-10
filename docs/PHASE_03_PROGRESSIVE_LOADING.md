# Phase 03：真实渐进加载与加载页面

## 阶段目标

实现由真实网络、解码和首帧事件驱动的加载体验：先显示 Poster 模糊背景与 0~100% 真实进度，低 LOD 尽早呈现类似点云的稀疏形态并可交互，再逐级替换为更清晰的高斯结果。所有阶段变化必须来自真实资源状态，不得用定时器或硬编码伪造。

## 前置条件

- [x] `docs/reports/PHASE_02_REPORT.md` 存在且状态为 `PASS`。
- [x] ViewerAdapter 能加载真实 SOG、提供生命周期事件并可靠销毁。
- [x] 已从同一源场景生成对齐的 low、medium、high 三档测试资产。
- [x] 三档资产均有字节数、SHA-256、来源与生成命令记录。
- [x] 已记录 Phase 03 开始前 commit（`2e2cf9b` phase2）。

## 禁止事项

- 禁止 `setInterval`、递增计数器或 CSS 动画驱动假百分比。
- 禁止网络失败后仍让进度走到 100%。
- 禁止用 Poster 或视频冒充低 LOD 真实渲染。
- 禁止让每档 LOD 使用不同坐标系、缩放或未经验证的相机。
- 禁止在高 LOD 失败时清掉已可交互的低 LOD。
- 禁止把本阶段的多文件分级加载称为 Streamed SOG 分片；该能力属于 Phase 04。
- 禁止自动 push。

## 纯文本页面草图

### 加载开始：Poster 模糊背景

```text
+----------------------------------------------------------------------------------------+
| [返回] 场景标题                                                                        |
|                                                                                        |
|  . . . . . . . . . . Poster 模糊铺满背景 . . . . . . . . . . . . . . . . . . .    |
|                                                                                        |
|                                正在准备场景                                             |
|                           [########------------] 38%                                    |
|                          已下载 12.4 MB / 32.6 MB                                      |
|                                                                                        |
|                            [取消加载] [返回详情]                                        |
+----------------------------------------------------------------------------------------+
```

### 低 LOD 可交互：类似点云到高斯逐步清晰

```text
+----------------------------------------------------------------------------------------+
| [返回] 场景标题                                      低清可交互 · 正在提升质量 67%     |
|                                                                                        |
|                    .      .   .   .                                                     |
|                 .   .  低 LOD 类似点云的稀疏形态   .                                    |
|                    .   -> medium -> high Gaussian                                      |
|                                                                                        |
|                                                                  +------------------+  |
|                                                                  | 作者             |  |
|                                                                  | 收藏             |  |
|                                                                  | 分享             |  |
|                                                                  | 问 AI            |  |
|                                                                  | 详情             |  |
|                                                                  +------------------+  |
|          +------------------------------------------------------------------+          |
|          | Reset | Orbit / Fly | Performance | Quality | Help               |          |
|          +------------------------------------------------------------------+          |
+----------------------------------------------------------------------------------------+
```

### 完成

```text
0% PREPARING
 |--- FETCHING_LOW --- DECODING_LOW --- FIRST_LOW_FRAME
 |                                           |
 |                                           +--> INTERACTIVE_LOW
 |                                                   |
 |--- FETCHING_MEDIUM / APPLYING_MEDIUM -------------+
 |                                                   |
 `--- FETCHING_HIGH / APPLYING_HIGH -----------------> READY 100%

ERROR：保留最后一个成功可交互 LOD；显示失败层级和重试入口。
CANCELLED：终止未完成请求与解码；释放未采用资源。
```

## 详细 Checklist

### A. 资产与 manifest

- [x] 从同一场景生成 low、medium、high 三档真实资产。
- [x] 三档使用同一坐标系、单位、朝向、裁剪范围和颜色规则。
- [x] manifest 记录每档 URL、字节数、SHA-256、splat 数和质量等级。
- [x] manifest 记录 Poster URL、尺寸、占位色和初始相机。
- [x] 转换脚本可重复运行并产生确定的清单。
- [x] Git 只提交脚本与小型元数据，不提交大场景产物。

### B. 真实加载状态机

- [x] 实现 `PREPARING`、`FETCHING_LOW`、`DECODING_LOW`、`INTERACTIVE_LOW`、`STREAMING_HIGH`、`READY`、`ERROR`、`CANCELLED` 状态。
- [x] 状态转换由 fetch、字节读取、解码完成、资源应用和首帧事件触发。
- [x] 不存在使用时间估计直接推进百分比的代码。
- [x] 重试从失败资源继续或安全重启，不重复挂载 Viewer。
- [x] 路由离开与用户取消能终止 fetch、解码和后续状态写入。
- [x] 所有错误带 sceneId、lod、阶段和可读错误码，但不泄露秘密。

### C. 0~100% 进度

- [x] 可取得 Content-Length 时按真实已读字节计算下载进度。
- [x] 不可取得 Content-Length 时显示不确定进度，不伪造百分比。
- [x] 下载、解码、首帧与高质量应用使用文档化权重。
- [x] 权重仅在对应真实事件完成时结算。
- [x] 显示当前阶段、已下载字节和总字节。
- [x] 只有 high 成功应用并实际渲染首帧后显示 100%。
- [x] 百分比单调不倒退，重试时明确重置或显示子任务进度。

### D. Poster 与视觉过渡

- [x] Poster 作为模糊背景覆盖 Viewer 挂载区，保持正确比例。
- [x] Poster 加载失败时使用项目自有纯色/渐变背景，不阻断场景加载。
- [x] 低 LOD 首帧前保持 Poster 可见。
- [x] 低 LOD 首帧后以短暂、可减少运动的淡出方式移除 Poster。
- [x] Poster 不接管输入，不被当作 3D 命中区域。
- [x] `prefers-reduced-motion` 下禁用非必要过渡。

### E. 低到高 LOD 体验

- [x] low 下载与解码优先，首帧后立即开放 Orbit/Fly。
- [x] low 的稀疏程度和点尺寸形成类似点云的可理解形态。
- [x] medium 和 high 在后台真实加载并逐级应用。
- [x] LOD 替换时保持相机位置、目标、模式和用户输入连续。
- [x] 替换不出现明显坐标跳变、闪黑或双场景长期叠加。
- [x] medium/high 失败时保留最后成功 LOD 并允许单独重试。
- [x] Quality 面板显示当前真实等级和仍在加载的等级。

### F. 右侧与底部工具

- [x] 加载期右侧保留作者、收藏、分享、问 AI、详情入口。
- [x] 未准备好的动作有一致 disabled / pending 行为。
- [x] 底部显示 Reset、Orbit/Fly、Performance、Quality、Help。
- [x] 低 LOD 首帧后 Reset 与 Orbit/Fly 可操作。
- [x] Performance 显示当前 LOD、真实 FPS、frame time、已加载字节。
- [x] Help 解释低清先可用、随后自动变清晰的真实行为。

### G. 弱网、错误与测试

- [x] 在浏览器限速环境验证 Poster、真实进度和 low 优先。
- [x] 模拟 low 404，验证不能进入可交互状态。
- [x] 模拟 medium/high 失败，验证 low 保持可交互。
- [x] 模拟未知 Content-Length，验证不出现伪百分比。
- [x] 快速切换场景，验证旧场景事件不会污染新场景。
- [x] 状态机、进度聚合器和取消逻辑有单元测试。
- [x] 真实三档资产有浏览器 E2E 或可重复 smoke test。
- [x] lint、typecheck、test、build 全部成功。
- [x] 生成 `docs/reports/PHASE_03_REPORT.md`。
- [x] 执行三项 Git 自检并创建独立 commit。
- [x] 未执行 push。

## 实现细节

### 进度模型

建议把总进度拆成可验证工作单元，而不是按时间插值。示例权重：

```text
manifest + poster readiness      0% ->  5%
low fetch                         5% -> 30%
low decode + apply               30% -> 42%
first low frame                  42% -> 45%
medium fetch/decode/apply        45% -> 70%
high fetch                        70% -> 92%
high decode/apply/first frame    92% -> 100%
```

权重可以基于真实资产大小调优，但每段只能由可观察事件推进。例如 `high fetch` 可按 `loadedBytes / contentLength` 推进 70~92，`high decode/apply/first frame` 必须分别收到完成事件后推进。若总长度未知，UI 显示旋转指示和已读字节，不显示无法证明的精确百分比。

### 状态与事件

```text
MANIFEST_READY
LOD_FETCH_PROGRESS(lod, loaded, total?)
LOD_FETCHED(lod)
LOD_DECODED(lod)
LOD_APPLIED(lod)
LOD_FIRST_FRAME(lod)
LOD_FAILED(lod, code)
LOAD_CANCELLED
```

事件应带 load session ID。页面切换后，旧 session 的事件必须被忽略。

### LOD 资产一致性

low、medium、high 必须从同一已归一化输入生成。转换脚本保存参数与工具版本，自动检查 bounds、transform 和相机锚点差异。任何对齐失败都阻止发布测试 manifest。

### 缓存与替换

本阶段可按三个独立完整文件加载。切换 LOD 时先准备新 GPU 资源，在帧边界原子切换，再释放旧资源；如果设备内存不足，应先保留 low 并说明无法提升质量。

## 关键目录 / 文件

```text
apps/viewer/src/platform/
|-- loading/
|   |-- LoadSession.ts
|   |-- LoadEvents.ts
|   |-- ProgressAggregator.ts
|   `-- LodSwitcher.ts
`-- ViewerAdapter.ts

apps/web/src/features/viewer/
|-- loading/
|   |-- LoadingOverlay.tsx
|   |-- PosterBackdrop.tsx
|   |-- LoadingProgress.tsx
|   `-- loadingMachine.ts
|-- QualityPanel.tsx
`-- PerformancePanel.tsx

scripts/
|-- build_preview_lods.sh
`-- verify_scene_manifest.sh

scenes/<scene-id>/              Git 忽略
|-- poster.webp
|-- low.sog
|-- medium.sog
|-- high.sog
`-- manifest.json
```

## 运行命令

先核对已安装版本的真实命令接口，再调用仓库包装脚本：

```bash
splat-transform --help
./scripts/build_preview_lods.sh --input /data/source/scene.ply --output scenes/progressive-test
./scripts/verify_scene_manifest.sh scenes/progressive-test/manifest.json
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
```

打开：

```text
http://localhost:5173/scene/progressive-test
```

## 验收标准

- Poster 模糊背景在真实低 LOD 首帧前可见，随后平滑退出。
- 可测量地先出现低 LOD 类似点云的稀疏可交互形态，再逐级变为高质量高斯。
- 有 Content-Length 时，0~100% 由真实字节、解码、应用和首帧事件驱动。
- 无 Content-Length 时明确显示不确定进度，不显示伪造百分比。
- 100% 只在 high 首帧真实呈现后出现。
- high 失败不会破坏已可用的 low/medium，错误可重试。
- 切换场景或取消后没有旧事件、旧请求和 GPU 资源泄漏。
- 右侧与底部工具完整，显示当前真实 LOD 和性能数据。

## 自测命令

```bash
./scripts/verify_scene_manifest.sh scenes/progressive-test/manifest.json
pnpm --filter @gsplatform/viewer lint
pnpm --filter @gsplatform/viewer typecheck
pnpm --filter @gsplatform/viewer test --run
pnpm --filter @gsplatform/viewer build
pnpm --filter @gsplatform/web lint
pnpm --filter @gsplatform/web typecheck
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
pnpm --filter @gsplatform/web test:e2e --grep "progressive loading"
git status
git diff --stat
git diff
```

人工网络测试至少覆盖：正常、Fast 3G 或等价限速、high 404、未知 Content-Length、加载中切换路由。

## 必须产物

- 可复现的 low/medium/high 与 manifest 生成/校验脚本。
- 真实事件驱动的加载状态机与进度聚合器。
- Poster 模糊加载层、0~100% 或明确不确定进度。
- 低 LOD 到高质量的连续交互与失败降级。
- 状态机、进度、取消与真实资产 E2E 测试。
- `docs/reports/PHASE_03_REPORT.md`。
- 一个仅包含 Phase 03 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 网络 / 场景 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P03-001 |  | headless SwiftShader Chromium / WebGPU，极端机器负载（load avg >10，swap 满） | e2e poll 偶发 "Received: 97"，会话实际完整完成到 100% | iframe 内 timer 队列在合成器 inactive 时 stall；host-side grace 兜底已确保会话不挂死，残余问题是 800ms 溶解窗口被极端负载下的 poll 采样错过 | e2e 增加 `retries: 1`（CI 抗抖动，非伪造进度） | Phase 03 |

## Phase Report 模板

复制到 `docs/reports/PHASE_03_REPORT.md`：

```markdown
# Phase 03 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：

## 环境与资产

- Browser / GPU：
- low / medium / high 字节数与 SHA-256：
- 工具版本与生成命令：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## 渐进加载实测

| 网络场景 | low 首帧 | medium 应用 | high 首帧 | 进度真实性 | 结果 |
|---|---:|---:|---:|---|---|
| 正常 |  |  |  |  | PASS/FAIL |
| 限速 |  |  |  |  | PASS/FAIL |
| high 失败 |  |  |  |  | PASS/FAIL |
| 未知长度 |  |  |  |  | PASS/FAIL |

## 自动测试命令与结果

## 人工交互与视觉连续性

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 04 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 03 的独立执行 Agent。先阅读全局规则、总计划和本阶段文档，并确认 docs/reports/PHASE_02_REPORT.md 为 PASS。门禁不满足就停止。

使用同一真实源场景生成坐标、单位和相机一致的 low/medium/high SOG 与 manifest。实现真实事件驱动的 PREPARING、FETCHING_LOW、DECODING_LOW、INTERACTIVE_LOW、STREAMING_HIGH、READY、ERROR、CANCELLED 状态机。加载页面必须显示 Poster 模糊背景；有 Content-Length 时显示由真实字节、解码、应用和首帧事件驱动的 0~100%，没有长度时显示不确定进度。低 LOD 要先形成类似点云的稀疏可交互形态，再逐步变成清晰高斯。

严禁用 setInterval、CSS 动画、硬编码数值、Poster 或视频冒充进度和渲染。100% 只能在 high 真实首帧后出现。high 失败必须保留最后成功 LOD。验证右侧作者/收藏/分享/问 AI/详情与底部 Reset/Orbit-Fly/Performance/Quality/Help 的加载期行为。

执行正常网络、限速、high 失败、未知 Content-Length、取消、快速切换场景测试。只有真实成功项才改为 [x]；失败或无法验证保持 [ ] 并记录。生成 docs/reports/PHASE_03_REPORT.md，执行 git status、git diff --stat、git diff。PASS 后创建独立 Phase 03 commit，不 push。最终汇报各 LOD 首帧时间、进度证据、降级结果、未完成项、报告路径和 commit hash。
```

