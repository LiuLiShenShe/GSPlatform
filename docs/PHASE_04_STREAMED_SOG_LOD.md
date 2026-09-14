# Phase 04：Streamed SOG、LOD 与网络分片

## 阶段目标

在 SuperSplat Viewer fork 的既有 SOG 能力上实现真实 Streamed SOG 加载：资产可按上游支持的流式格式或字节范围获取，Viewer 根据相机、屏幕贡献、设备能力和近期性能选择 LOD，优先呈现可用内容并按需细化；同时建立缓存、取消、重试、完整性与可观测性基线。

## 前置条件

- [ ] `docs/reports/PHASE_03_REPORT.md` 存在且状态为 `PASS`。
- [ ] 真实进度状态机、Poster、low 首帧和高质量降级已稳定。
- [ ] 已锁定并记录 SuperSplat Viewer、PlayCanvas Engine、splat-transform 版本。
- [ ] 已通过当前版本的帮助与上游源码确认 Streamed SOG 的真实输入格式和 API。
- [ ] 已准备 small、medium、large 三个来源合法的性能测试场景。
- [ ] 已记录 Phase 04 开始前 commit。

## 禁止事项

- 禁止自行发明与当前 Viewer 不兼容的“Streamed SOG”二进制格式。
- 禁止把三个完整 SOG 文件顺序下载冒充按需流式加载。
- 禁止预取全部高质量分片后才显示 low。
- 禁止仅用 URL 数量或定时器计算进度。
- 禁止无限缓存 GPU/内存对象或忽略取消后的响应。
- 禁止把测试资产和分片提交进 Git。
- 禁止为提升指标降低到不可辨识质量而不在 UI 告知。
- 禁止自动 push。

## 纯文本架构草图

```text
                         camera / viewport / device
                                   |
                                   v
+--------------------+    +-------------------------+
| LOD selector       |--->| Stream scheduler        |
| screen contribution|    | priority / cancel/retry |
| FPS / memory       |    | concurrency / budget    |
+--------------------+    +------------+------------+
                                      |
                         HTTP Range or upstream
                         supported chunk requests
                                      |
                                      v
+--------------------+    +-------------------------+
| Nginx/static origin|--->| Streamed SOG asset      |
| Range + cache      |    | index + chunks / ranges |
+--------------------+    +-------------------------+
                                      |
                                      v
+--------------------+    +-------------------------+
| CPU cache          |--->| decode / GPU upload     |
| bounded LRU        |    | frame-boundary apply    |
+--------------------+    +-------------------------+
```

### Viewer 流式状态

```text
+----------------------------------------------------------------------------------------+
| 场景标题                                 低清可用 · 流式细化 73% · 网络 4.8 MB/s      |
|                                                                                        |
|      [近处区域 high]                                                                  |
|             +--------------------+                                                     |
|             | 清晰高斯           |        [远处区域 low / 类似点云]                    |
|             +--------------------+                                                     |
|                                                                                        |
|                                                                  +------------------+  |
|                                                                  | 作者             |  |
|                                                                  | 收藏             |  |
|                                                                  | 分享             |  |
|                                                                  | 问 AI            |  |
|                                                                  | 详情             |  |
|                                                                  +------------------+  |
| +------------------------------------------------------------------------------------+ |
| | Reset | Orbit/Fly | Performance: FPS/内存/网络 | Quality: 自动/省流/高质量 | Help | |
| +------------------------------------------------------------------------------------+ |
+----------------------------------------------------------------------------------------+
```

## 详细 Checklist

### A. 格式与转换能力确认

- [x] 执行当前 `splat-transform --help` 并记录版本与可用参数。
- [x] 阅读当前 Viewer fork 的 Streamed SOG 加载入口并记录准确模块路径。
- [x] 确定使用上游原生分片、索引或 HTTP Range 中的哪一种真实机制。
- [x] 在 ADR 中记录格式选择、版本兼容范围和回退方案。
- [x] 不修改上游二进制格式；项目 manifest 仅包装业务元数据。

### B. 构建与发布脚本

- [x] `scripts/build_streamed_sog.sh` 从归一化输入生成真实流式资产。
- [x] 脚本使用锁定版本，启动时验证工具存在与版本。
- [x] 生成过程失败时非零退出，不留下可被发布器误认的完整标记。
- [x] 输出写入临时目录，校验成功后原子改名到发布目录。
- [x] 生成 manifest、索引/分片、Poster、校验和清单和构建元数据。
- [x] `scripts/verify_streamed_sog.sh` 能验证缺片、长度、哈希、索引边界和路径安全。
- [x] 对同一输入与相同参数执行两次，结构与元数据可解释地一致。

### C. Stream scheduler

- [x] 请求队列按可见性、屏幕贡献、相机距离和当前 LOD 排序。
- [x] 低 LOD / 根节点始终优先于不可见高 LOD。
- [x] 相机快速移动时取消或降低过时高质量请求优先级。
- [x] 并发数、在途字节、解码队列和 GPU 上传有明确上限。
- [x] 请求支持 AbortSignal，取消后不写入当前 session。
- [x] 临时网络错误使用有上限的指数退避与抖动。
- [x] 404、校验失败和格式失败不进行无限重试。

### D. LOD 选择

- [x] 自动模式结合屏幕贡献、视锥、FPS、frame time 和内存预算。
- [x] 省流模式降低预取和最大质量，并在 UI 明确显示。
- [x] 高质量模式提高目标但仍受设备安全预算约束。
- [x] 为阈值增加迟滞，避免相机轻微移动时频繁升降级。
- [x] 相机静止后近处区域能逐步达到目标高质量。
- [ ] 远离或不可见区域能降级/回收，不无限累积。
- [x] Quality 面板显示当前模式、目标 LOD、已驻留量和待加载量。

### E. 缓存与内存

- [x] 网络响应进入有容量上限的 CPU LRU 缓存。
- [x] 解码结果和 GPU 资源分别设置预算与淘汰策略。
- [ ] 缓存 key 包含资产版本或内容哈希，避免发布后读到旧分片。
- [x] 同一分片的并发请求去重。
- [ ] 路由离开、sceneId 改变或 manifest 版本变化时正确失效。
- [x] 长时间移动相机不会使 JS heap 和 GPU 资源无界增长。
- [ ] 内存压力下优先保持低 LOD 可交互并回收不可见高 LOD。

### F. HTTP 与 Nginx 行为

- [x] 静态服务支持真实 Range 请求并返回正确 `206`、`Content-Range`、`Content-Length`。
- [x] 无效 Range 返回 `416`。
- [x] manifest 使用短缓存或版本化 URL；不可变分片使用内容哈希和长期 immutable 缓存。
- [ ] CORS 仅允许配置的前端来源与所需方法/请求头。
- [x] HEAD 请求或等价元数据请求能得到正确长度。
- [ ] 压缩配置不破坏 Range 与 SOG 二进制内容。
- [ ] MIME 类型稳定，浏览器不会把二进制内容当文本执行。

### G. 进度与可观测性

- [x] 总进度基于 manifest 中目标工作量和真实接收/解码/应用事件。
- [x] 相机导致目标集合变化时，UI 区分”初始就绪”与”后台细化”。
- [ ] 100% 的定义明确：初始视图目标集合全部应用，而非整个无限浏览空间全下载。
- [x] Performance 显示请求数、缓存命中、网络吞吐、解码队列、驻留 splat、FPS。
- [ ] 开发日志包含 session、asset version、chunk/range、耗时和错误码。
- [ ] 生产默认不输出高频逐帧日志。

### H. 测试与收尾

- [x] 单元测试覆盖优先级、迟滞、取消、重试、LRU 和进度集合变化。
- [ ] 集成测试覆盖 200/206/416、缺片、坏哈希、断网恢复。
- [ ] small、medium、large 三个场景在冷缓存和热缓存下实测。
- [ ] 限速和高延迟条件下，low 仍优先达到可交互。
- [ ] 相机快速往返时可观察到过时请求取消和缓存命中。
- [ ] 至少持续浏览 15 分钟，记录内存、FPS 和失败请求。
- [x] lint、typecheck、test、build 全部成功。
- [x] 生成 `docs/reports/PHASE_04_REPORT.md`。
- [ ] 执行三项 Git 自检并创建独立 commit。
- [ ] 未执行 push。

## 实现细节

### 使用上游真实格式

Streamed SOG 的准确命令行参数与加载 API 以仓库锁定版本为准。实现时先用 `--help`、源码和测试确认，不在脚本里猜测参数。仓库对开发者暴露稳定包装命令：

```text
build_streamed_sog.sh --input <normalized-input> --output <scene-dir> --profile <profile>
verify_streamed_sog.sh <scene-dir>/manifest.json
```

脚本内部记录实际调用、工具版本和参数到 `build-info.json`。

### 业务 manifest 建议

项目 manifest 不能替代上游流式索引，只负责连接平台元数据与上游入口：

```json
{
  "schemaVersion": 1,
  "sceneId": "stream-test",
  "assetVersion": "sha256-prefix",
  "format": "streamed-sog",
  "stream": {
    "entryUrl": "/scenes/stream-test/versions/sha256-prefix/scene.sog",
    "byteLength": 123456789,
    "sha256": "<真实值>",
    "transport": "range"
  },
  "poster": {
    "url": "/scenes/stream-test/versions/sha256-prefix/poster.webp",
    "width": 1600,
    "height": 900
  },
  "camera": {
    "position": [0, 1.2, 3.5],
    "target": [0, 0.8, 0],
    "fov": 55
  }
}
```

如果锁定版本使用独立索引和分片，则 `entryUrl` 指向上游索引入口，校验脚本遍历其真实引用。不要为了匹配示例而改变上游格式。

### LOD 评分

LOD 决策可使用以下输入：

```text
priority = visible
         * projectedScreenContribution
         * qualityModeWeight
         * motionStability
         * missingDetail
         / estimatedCost
```

评分只是排序依据，最终仍受并发、网络、CPU、GPU 与内存预算控制。阈值必须通过三类场景和多种设备实测，不硬编码为不可解释的魔法数字。

### 初始就绪与完成

- `interactive-ready`：根/低 LOD 的首帧真实呈现，控制可用。
- `initial-view-ready`：初始相机可见区域达到自动质量目标，可显示 100%。
- `background-refining`：用户改变相机后新目标集合继续加载，使用独立状态而不是把主进度倒退。

### Nginx 验证重点

配置文件应显式覆盖流式资产路径。使用 curl 验证 Range 行为，而不是只检查配置语法。不可变内容路径包含版本或内容哈希；manifest 更新后引用新版本目录，旧版本按保留策略清理。

## 关键目录 / 文件

```text
apps/viewer/src/platform/streaming/
|-- StreamedSogLoader.ts
|-- StreamScheduler.ts
|-- LodSelector.ts
|-- RequestQueue.ts
|-- ResidencyManager.ts
|-- BoundedLru.ts
|-- StreamingMetrics.ts
`-- types.ts

apps/web/src/features/viewer/
|-- QualityPanel.tsx
|-- PerformancePanel.tsx
`-- StreamingStatus.tsx

scripts/
|-- build_streamed_sog.sh
|-- verify_streamed_sog.sh
`-- benchmark_streaming.sh

deploy/nginx/
`-- scenes-streaming.conf

scenes/<scene-id>/versions/<asset-version>/    Git 忽略
|-- manifest.json
|-- build-info.json
|-- checksums.sha256
`-- <上游 Streamed SOG 产物>
```

## 运行命令

```bash
splat-transform --version
splat-transform --help
./scripts/build_streamed_sog.sh \
  --input /data/scenes/normalized/scene.ply \
  --output scenes/stream-test \
  --profile balanced
./scripts/verify_streamed_sog.sh scenes/stream-test/current/manifest.json
```

启动静态 origin 与应用后验证 Range；以下 URL 按真实 manifest 替换：

```bash
curl -I http://localhost:8080/scenes/stream-test/current/scene.sog
curl -i -H "Range: bytes=0-1023" \
  http://localhost:8080/scenes/stream-test/current/scene.sog
curl -i -H "Range: bytes=999999999999-" \
  http://localhost:8080/scenes/stream-test/current/scene.sog
pnpm --filter @gsplatform/web dev --host 0.0.0.0 --port 5173
```

## 验收标准

- 浏览器网络记录证明按上游真实流式机制进行分片或 Range 请求，而非先下载完整高质量文件。
- 冷缓存下 low / 根 LOD 优先形成可交互首帧；近处和高屏幕贡献区域随后细化。
- 相机快速移动会取消或降低过时请求，停止后当前视图能达到目标质量。
- 省流、自动、高质量三种模式的真实请求量和驻留质量有可测差异。
- Range 返回 206 和正确 Content-Range，无效范围返回 416。
- 断网、缺片、坏哈希时保留可用 LOD并给出可重试错误。
- 连续 15 分钟浏览无无界内存增长，报告包含 small/medium/large 冷热缓存指标。
- 进度来自真实目标集合、接收、解码和应用事件。

## 自测命令

```bash
./scripts/verify_streamed_sog.sh scenes/stream-test/current/manifest.json
./scripts/benchmark_streaming.sh --scene stream-test --profile cold
./scripts/benchmark_streaming.sh --scene stream-test --profile warm
nginx -t -c "$PWD/deploy/nginx/nginx.dev.conf"
pnpm --filter @gsplatform/viewer lint
pnpm --filter @gsplatform/viewer typecheck
pnpm --filter @gsplatform/viewer test --run
pnpm --filter @gsplatform/viewer build
pnpm --filter @gsplatform/web test --run
pnpm --filter @gsplatform/web build
pnpm --filter @gsplatform/web test:e2e --grep "streamed sog"
git status
git diff --stat
git diff
```

## 必须产物

- Streamed SOG 格式与传输选择 ADR。
- 可复现、失败安全的构建与校验脚本。
- Stream scheduler、LOD selector、有界缓存和驻留管理。
- Range 与缓存配置及自动验证。
- small/medium/large、冷热缓存、限速和 15 分钟稳定性报告。
- `docs/reports/PHASE_04_REPORT.md`。
- 一个仅包含 Phase 04 的本地 commit；不得 push。

## Known Issues 记录区

| ID | 未完成 Checklist | 场景 / 网络 / 命令 | 实际结果 | 原因 | 下一步 | 负责人 |
|---|---|---|---|---|---|---|
| P04-001 |  |  |  |  |  |  |

## Phase Report 模板

复制到 `docs/reports/PHASE_04_REPORT.md`：

```markdown
# Phase 04 Report

- 状态：PASS / FAIL / BLOCKED
- 开始 / 结束时间：
- 执行人 / Agent：
- Commit before / after：
- Viewer / PlayCanvas / splat-transform 版本：
- 格式 ADR：

## Checklist 统计

- 必做总数：
- 已验证 `[x]`：
- 未完成 `[ ]`：

## HTTP / Range 验证

| 检查 | 预期 | 实际 | 结果 |
|---|---|---|---|
| HEAD length | 正确长度 |  | PASS/FAIL |
| Range | 206 + Content-Range |  | PASS/FAIL |
| Invalid Range | 416 |  | PASS/FAIL |

## 场景性能

| 场景 | 缓存 | 首个可交互帧 | 初始视图就绪 | 下载量 | 峰值内存 | 稳定 FPS |
|---|---|---:|---:|---:|---:|---:|
| small | cold/warm |  |  |  |  |  |
| medium | cold/warm |  |  |  |  |  |
| large | cold/warm |  |  |  |  |  |

## 取消、重试、缓存与 15 分钟稳定性

## 自动测试命令与结果

## Git 自检

- git status：
- git diff --stat：
- git diff 已审阅：是 / 否
- 是否 push：否

## Known Issues

## 结论与 Phase 05 门禁
```

## 独立 Agent 执行提示词

```text
你是 GSPlatform Phase 04 的独立执行 Agent。完整阅读 docs/00_GLOBAL_RULES.md、docs/DEVELOPMENT_PLAN.md、docs/PHASE_04_STREAMED_SOG_LOD.md，确认 docs/reports/PHASE_03_REPORT.md 为 PASS；否则不得开始。

先根据锁定版本执行 splat-transform --help，并阅读 Viewer fork 中真实 Streamed SOG 入口。记录格式/传输 ADR，不猜命令参数，不发明不兼容格式。实现可复现的 build_streamed_sog.sh 与 verify_streamed_sog.sh、优先 low 的 StreamScheduler、基于可见性/屏幕贡献/FPS/内存的 LodSelector、有界 CPU/GPU 缓存、请求去重、取消与有限重试。Nginx/static origin 必须真实支持所选机制；若使用 Range，验证 206、Content-Range 与 416。

用 small/medium/large 三个合法真实场景验证冷缓存、热缓存、限速、高延迟、断网、缺片、坏哈希和相机快速移动。网络记录必须证明是按需分片或 Range，不是依次下载完整文件。Performance 显示真实请求、缓存、吞吐、解码、驻留和 FPS；Quality 提供省流/自动/高质量且有实测差异。

只有真实运行与测试成功后才改 [ ] 为 [x]。失败或无法验证保持 [ ] 并写 Known Issues。生成 docs/reports/PHASE_04_REPORT.md，执行 git status、git diff --stat、git diff。PASS 后创建独立 Phase 04 commit，不 push。最终给出格式选择、网络证据、性能表、稳定性、未完成项、报告路径和 commit hash。
```

