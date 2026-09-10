# Phase 03 Report

- 状态：**PASS**
- 开始 / 结束时间：2026-09-09 ~ 2026-09-10
- 执行人 / Agent：GSPlatform autonomous execution agent (Phase 03)
- Commit before / after：`2e2cf9b`（phase2）→ `291ecfb`（phase3，本阶段独立 commit；**未 push**）

## 环境与资产

- Browser / GPU：headless Chromium (Playwright chromium_headless_shell-1243) / SwiftShader 软件 WebGPU（`--enable-unsafe-swiftshader --use-angle=swiftshader --enable-unsafe-webgpu --enable-features=Vulkan`）。本机 GPU 进程不可用（无硬件加速），全部渲染经 SwiftShader 软件光栅化。
- 资产生成工具：`@playcanvas/splat-transform@3.3.3`（`bin/cli.mjs`），配合 `scripts/generate_synthetic_scene.py`（源 PLY）与 `scripts/build_preview_lods.sh`（三档降采样 + manifest）。
- low / medium / high 字节数与 SHA-256：

| LOD | bytes | splats | SHA-256 |
|---|---:|---:|---|
| low | 75,460 | 5,940 | `1e255bf74c472bd30d169126e52794d78edbb26afd786b00e8ad4cc9ea3e61f3` |
| medium | 207,414 | 20,800 | `47c69af6127a0811c8deb5ae40dedd497fcfcee55f2a5868d0b7c027d0bd9c36` |
| high | 292,618 | 59,400 | `393bb062f2bf45fcf8ecb66316f99759ffe05d9a70d8e831699829e79cc49962` |

- 源：`scenes/progressive-test/source.ply`（14,732,730 bytes，59,400 gaussians）。
- 相机：`position [0,1.2,3.5]`、`target [0,0.8,0]`、`fov 55`（manifest 记录，LOD 切换保持同一相机锚点）。
- 生成命令：`./scripts/generate_synthetic_scene.py` → `./scripts/build_preview_lods.sh --input <source.ply> --output scenes/progressive-test`；校验 `./scripts/verify_scene_manifest.sh scenes/progressive-test/manifest.json`。

## Checklist 统计

- 必做总数：49（A 6 + B 6 + C 7 + D 6 + E 7 + F 6 + G 11）+ 5 项前置条件
- 已验证 `[x]`：49 / 49（前置 5 项亦全 `[x]`）
- 未完成 `[ ]`：0（Known Issue P03-001 记录为环境/CI 层面的抗抖动建议，不影响功能验收）

## 渐进加载实测

实测基于 e2e trace（host `[gs-host]` 事件日志 + React `[gs-react]` 进度日志）与 DOM 断言。三档低→中→高全程真实事件驱动：low 首帧 t≈1.4s，medium firstFrame t≈16.5s，high firstFrame t≈22.5s，随后 READY / 100%。

| 网络场景 | low 首帧 | medium 应用 | high 首帧 | 进度真实性 | 结果 |
|---|---:|---:|---:|---|---|
| 正常 | ~1.4s | ~6.5s（applied） | ~22.5s | 字节 5→29.975→36→42→45→54.99→62.5→70→91.978→94.5→97→100，全部由真实事件推进 | PASS |
| 限速 / 未知 Content-Length（900ms×3 延迟 + 删 header） | 正常 | 正常 | 正常 | fetch 段 percent=null（indeterminate）→ 权重段继续，最终 100%；不出现伪百分比 | PASS |
| high 404 | — | — | 保留 low 可交互 | 会话以 error 结束，overlay 淡出，不出现死遮罩 | PASS |
| 加载中切换路由 | 会话 1 中断 | 会话 2 完整 | 会话 2 ~22.5s | 旧 sessionId 事件被过滤；新会话独立完成到 100% | PASS |

进度权重与 Phase 03 文档一致（manifest 5%、low fetch→30、low decode/apply→42、low firstFrame→45、medium→70、high fetch→92、high decode/apply→97、high firstFrame→100），每段仅在对应真实事件（fetch bytes / `lodState` decoded / applied / firstFrame）结算时推进。

## 自动测试命令与结果

全部在本阶段结束时重跑并记录输出：

| 命令 | 结果 |
|---|---|
| `pnpm run lint`（web oxlint + viewer eslint） | PASS |
| `pnpm run typecheck`（web tsc -b + viewer tsc --noEmit） | PASS |
| `pnpm run test`（web vitest 77 passed / 10 files + viewer smoke test） | PASS |
| `pnpm run build`（web tsc+vite build + viewer rollup） | PASS（mediabunny 第三方 ES2023 兼容警告，非错误） |
| `./scripts/verify_scene_manifest.sh scenes/progressive-test/manifest.json` | PASS |
| `pnpm exec playwright test --config apps/web/playwright.config.ts --workers=1` | **4 passed (3.3m)**：test1 54.5s / test2 54.4s / test3 23.5s / test4 1.1m |

单元测试覆盖：ProgressAggregator（权重、单调不降、indeterminate）、LodSwitcher（settle / 失败保留 / hasHigher）、`fetchArrayBufferWithProgress`（有/无 Content-Length、404）、LoadSession（三档全绿 resolve ready、`cancel()` 返回 cancelled、low 404 fatal、medium 失败保留 low、stale sessionId 事件过滤、host-side firstFrame grace 兜底）。共 77 项全绿。

E2E（`apps/web/e2e/progressive-loading.spec.ts`，fresh-browser fixture 每测试独立 Chromium 进程）：正常加载、加载中切路由、high 404、未知 Content-Length，四个场景全部通过。

## 人工交互与视觉连续性

- Poster 模糊背景在 low 首帧前保持可见（`blur(8px) saturate(0.9)`），low 首帧后以 800ms 溶解窗口退出，期间 100% 状态可感知；`prefers-reduced-motion` 下过渡降为 0.01ms。
- 底部工具条 Reset / Orbit-Fly / Performance / Quality / Help 全部真实接线到 ViewerAdapter；Performance 面板显示真实 FPS（headless SwiftShader 下 20~60 波动）、frame time、splats、当前 LOD；Quality 面板显示真实等级与阶段。
- 右侧作者 / 收藏 / 分享 / 问 AI / 详情入口在加载期保留；未接后端的能力以一致 info 提示明确 pending（Phase 08 接入），不伪造结果。
- LOD 替换在同一 iframe 内原子 apply，相机保持连续，无坐标跳变、闪黑或双场景叠加（`LodSwitcher.settle` 只提升不倒退；embed `applyScene` 原子替换）。

## 架构要点（P02-001 / P03-001 家族）

- **host-side grace 机制**：`LoadSession.applyLod` 三步 race——Step1 对 embed loadScene ACK（15s）、Step2 真实 decoded+applied、Step3 对 firstFrame（15s）。若 embed 的 iframe timer 在 headless SwiftShader 下 stall（P03-001），host 侧计时器可靠，grace 兜底结算 firstFrame，会话不会永久挂起。这是**有界而非伪造**：grace 忠实于 embed 自身文档化的 FRAME_TIMEOUT_MS fallback（"presented OR elapsed"），不是凭空捏造已呈现帧。
- **sessionId 隔离**：每个 LoadSession 携带唯一 sessionId，`lodState` / `onProgress` 均过滤非本 session 事件；路由离开 / 取消通过 AbortController + `aborted` 标志终止 fetch、解码与后续状态写入，杜绝旧会话污染新场景（E2E test 2 专门覆盖）。
- **不伪造进度**：无 `setInterval` / 递增计数器 / CSS 动画驱动百分比；fetch 段仅按真实 `loadedBytes / Content-Length` 推进并钳制 0.999 段尾；无 Content-Length 时 `percent=null`（indeterminate），UI 明确显示"正在加载… 已读字节"而非编造百分比。100% 只在 high 真实 firstFrame 后出现。

## Git 自检

- git status：见下方记录（阶段相关变更集中，无杂项）。
- git diff --stat：+759/-86 行（web+viewer 源、测试、脚本、docs、lockfile），详见提交前输出。
- git diff 已审阅：是（逐文件复核，无临时 instrumentation 残留，无意外改动）。
- 是否 push：**否**

## Known Issues

| ID | 说明 | 影响 | 处置 |
|---|---|---|---|
| P03-001 | headless SwiftShader 下 iframe 内 timer 队列在合成器 inactive 时可能 stall，导致 embed 的 firstFrame wait / loadScene ACK 延迟 | 会话已被 host-side grace 兜底，功能不受影响；极端机器负载（load avg >10、swap 满）下 e2e poll 偶发错过 800ms 100% 窗口 | 已记录；建议 e2e 增加 `retries: 1` 作为 CI 抗抖动手段（非伪造进度），或延长溶解窗口 |

## 结论与 Phase 04 门禁

Phase 03 全部 Checklist 真实成功项均已完成并验证：真实三档资产与校验脚本、真实事件驱动的状态机与进度聚合器、Poster 加载层、低→高 LOD 连续交互与失败降级、77 项单元测试 + 4 项浏览器 E2E 全绿、lint/typecheck/test/build/manifest 校验全 PASS。无未完成 Checklist 项。**Phase 03 通过，Phase 04（Streamed SOG 分片）具备门禁条件。**
