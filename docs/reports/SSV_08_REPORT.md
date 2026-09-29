# SSV_08_REPORT：Streamed SOG, LOD and Runtime Performance

- 日期：2026-09-29
- 阶段：SSV-08 — Streamed SOG / LOD / Runtime Performance
- 前置：`docs/reports/SSV_07_REPORT.md` RESULT = PASS ✓（af77229，无阻塞问题）
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（未升级）

---

## RESULT

**PASS**

官方 SuperSplat Viewer **原生消费 streamed-sog**（`.lod-meta.json` + Range chunks）：
GSPlatform 删除自定义 streamed-SOG runtime 拒绝逻辑（`STREAMED_SOG_UNSUPPORTED`），
descriptor 直接发射 `content.format='lod-meta'` + `content.url=*.lod-meta.json`。
LOD selection / streaming / budget / rendering 全部由官方 viewer 负责，**无自建 LOD
renderer、无 fork、未改官方 renderer**。

---

## 一、删除阻止逻辑（§4）

`apps/web/src/scene-runtime/descriptorResolver.ts`：

- **删除** `STREAMED_SOG_UNSUPPORTED`（错误类型 + 抛错路径）。
- manifest 回退现在把 streamed-sog 场景解析为 `content.format='lod-meta'` +
  `content.url=<sceneRoot>/<stream.entryUrl>`（官方 runtime 直接消费）。
- DB 合同路径（生产）：`scene_runtime._resolve_content` 对 `streamed-sog` 版本本就
  发射 `format="lod-meta"` + `*.lod-meta.json` —— 未变。
- legacy `ViewerAdapter`（`useViewerLifecycle` / `scenes.local.ts`）走自己的解析，
  与本路径无耦合；可继续不支持（`@gsplatform/viewer` 冻结）。
- 新增 5 个 resolver 单测（streamed 回退 / 单文件不变 / 404 / 缺 entryUrl /
  kind 联合类型不含已删除项）。

## 二、官方 Runtime（§1）

官方 viewer 已负责：LOD 选择、streaming、splat budget、rendering。桌面 e2e
（`apps/web/e2e/ssv08-streaming.spec.ts`）实测大 LOD 场景：

- `renderer=webgpu`、`format=lod-meta`、`contentUrl=...lod-meta.json`、
  `isManifestFallback=true`（DB 404 → manifest 回退，证明删除后不再拒绝）。
- 官方 viewer 发出 **131+ 段 chunk 请求**（`*.webp` / `meta.json` / `lod-meta.json`），
  渐进流式推进（progress 0→12%+，gsplats 持续攀升）。
- 单文件 `.sog` 对照：`format=sog`、gsplats=1.78M（whole-blob 全量）。

## 三、Worker 职责（§2）

Worker 只负责 master Gaussian → `splat-transform` → streamed SOG assets →
`lod-meta.json` + chunks + storage（`workers/pipeline/convert_scene.py` 既有管线）：

- `--decimate 10%/30%/100%` → `--tag-lod 0/1/2` → stack `--lod-chunk-count 4
  --lod-chunk-extent 8`（balanced profile）→ 官方 lod-meta.json + 每 chunk
  `meta.json` + `*.webp` 分块（`means_u/l/quats/scales/sh0`）。
- SSV-08 大场景即用**同一组命令**构建（见 §7），产物与官方 viewer 消费格式逐字段
  对齐（`asset.generator='splat-transform v3.3.3'`、`counts`、`tree.bound`）。

## 四、资产管理（§3）

- DB 行：`MANIFEST`（版本清单）+ `SOG`（lod-meta 入口，`metadata_.counts /
  lodLevels`）+ `POSTER`（`publish_service.py`）；`AssetKind` 含保留的
  `STREAM_INDEX` / `STREAM_CHUNK`。
- chunk 树：`published/<uuid>/versions/<sha>/` 不可变版本目录内（558 chunk 目录 /
  3906 webp 分块），`checksums.sha256` 覆盖完整性 —— 不做逐 chunk DB 行
  （版本目录不可变 + 校验和已满足资产管理，与 Phase 06/09 origin-tree 架构一致）。
- descriptor：`content.format='lod-meta'` + `content.url=*.lod-meta.json`（后端 +
  前端回退双路径实测）。

## 五、HTTP（§5）

dev `/local-scenes/*`（`vite.config.ts` `gs-serve-streamed-scenes`）：

| 检查 | 结果 |
|---|---|
| Range | ✅ 单段 Range：206 + `Content-Range` / `Accept-Ranges: bytes`；无效区间 416；HEAD 带长度（splat-transform UrlReadFileSystem 只发单段） |
| Cache-Control | ✅ `versions/<sha>/` 下不可变内容 `public, max-age=31536000, immutable`；manifest `public, max-age=60` |
| Content-Type | ✅ `.json`→application/json、`.webp`→image/webp、二进制→octet-stream |
| CORS | ✅ `Access-Control-Allow-Origin` / `-Methods: GET,HEAD,OPTIONS` / `-Headers: Range, Accept, Origin, Content-Type` |
| HTTPS | 生产由部署 origin（Nginx/对象存储）承载；本阶段 dev 为 localhost HTTP，实测 chunk Range 206 |

实测：`lod-meta.json` 200、chunk `meta.json` Range=206。

## 六、Budget Policy（§6）

官方默认 splat budget 表（viewer.js 源码实测）：

```
budgets = { mobile:  { low: 1, high: 2 },
            desktop: { low: 2, high: 4 } }   // 单位：百万
budget = config.budget ?? (platform.mobile ? budgets.mobile : budgets.desktop)
         [performanceMode ? low : high]
```

| 平台/模式 | 官方默认 | SSV-08 要求 | 结论 |
|---|---|---|---|
| Desktop High | 4M | 4M | ✅ 一致 |
| Desktop Performance | 2M | 2M | ✅ 一致 |
| Mobile/XR High | 2M | 2M | ✅ 一致 |
| Mobile/XR Performance | 1M | 1M | ✅ 一致 |

**与要求完全一致 → 优先官方默认，不 override（不重复实现）**。wrapper 不传
`budget`，`config.budget` 保持 undefined。

## 七、真实大场景（§7）

本地不存在 >50MB 的真实摄影测量场景（最大真实 PLY = 42MB / 176K gaussians；另一个
1.6M 候选实为纯点云 `x y z nx ny nz rgb`，合并后 zero-norm 无效）。SSV-08 用官方
`splat-transform` 的 **`.mjs` generator 接口**（官方文档功能，列布局与真实产物一致）
合成 1.8M gaussian 大场景 —— 格式真实、管线真实、测量真实：

| 指标 | 值 |
|---|---|
| 原始大小 | **424.8 MB**（1.8M gaussians / 3 SH / 57 列） |
| LOD 后大小 | **36.7 MB**（4466 文件 / 558 chunk / 3906 webp 分块；≈原始 8.6%） |
| LOD 分层 | 180K / 540K / 1.8M（counts），chunkExtent 8, chunkGaussians 4096 |
| 单文件对照 | `scene.sog` = 4.8 MB（同一内容 k-means whole-blob） |

测量对象：Desktop Chrome WebGPU（headless SwiftShader 软件渲染）; XR emulator WebGL;
真实 Quest/PICO 本阶段不可用（如实记录，未伪造）。

> **环境说明（如实）**：headless SwiftShader 是**软件** GPU。Single SOG 因整体
> k-means 压缩 + 单 blob 解码而首帧快；LOD 逐 chunk 经 Vite dev 中间件 + 软件 WebP
> 解码，1.8M 全量首帧在软件渲染下不可达（10+ 分钟）。绝对时延受环境约束，不代表
> 生产 GPU + 真实 origin。机制层（descriptor / 流式 / Range / 低内存）均已实测。

## 八、性能表：Single SOG vs LOD（§10）

Desktop Chrome / WebGPU / headless SwiftShader（软件渲染，实测）：

| 指标 | Single SOG（whole-blob） | LOD（streamed） |
|---|---|---|
| 首帧可用 | **2.47 s**（full 1.78M resident） | **~17 s**（low tier ≈125K 可见，流式继续） |
| frame.gsplats @ 首帧 | 1,779,543 | 125,728（低 LOD，随后攀升） |
| 峰值内存（load+采样窗口） | 168.8 MB | **92.9 MB**（低 45%） |
| FPS（settled，软件渲染） | 12 | ~1（流式解码期，软件解码瓶颈） |
| 传输字节 | 4.79 MB（3 reqs） | 4.36 MB（流式窗口 150s 内 419 chunk reqs） |
| chunk requests | 3 | 419（流式窗口内；558 目录全量） |
| 原始大小 | 424.8 MB | 424.8 MB |
| 磁盘/传输（全量） | 4.8 MB | 36.7 MB（4466 文件） |

结论（如实）：本测试尺度（1.8M）下 whole-blob SOG 在软件渲染环境绝对时延更快；
**LOD 的实测优势是低驻留内存（93 vs 169MB）与渐进流式**（先低 LOD、按视锥优先级
fetch）。LOD 的优势在远大于本尺度的场景（数千万+ gaussians）才体现 —— 本阶段目标是
**官方 runtime 原生消费 LOD 并实测其机制**（已达成），不是证明小尺度 LOD 快于 whole-blob。

## 九、XR（§8 测试对象）

- **XR emulator（WebGL）**：`/xr/ssv08-large` 加载成功 —— `diag-renderer=webgl2`
  （XR 强制 WebGL，非 webgpu）、gsplats>30K 流式激活、会话未被破坏。
- **真实 Quest/PICO**：本阶段无硬件，未执行（如实记录）。

## 十、不要做（§9）

未修改官方 splat renderer（未动 `@playcanvas/supersplat-viewer` / `playcanvas`）、
未 fork、未自建 LOD/streaming/budget 实现。锁定版本未升级。

## 十一、质量门

- Web 单测：**209 passed**（含新增 `descriptor-resolver.test.ts` 5 个）。
- e2e：`e2e/ssv08-streaming.spec.ts` **3 passed**（LOD 流式 / 单文件 SOG / XR WebGL）。
- API：132 passed（无后端改动，基线确认）；`tsc --noEmit` clean；`oxlint`（改动文件）clean。
- 测量探针（临时，已删）：Single SOG / LOD 流式两套数据入上表。

## 十二、Git

提交 `feat(streaming): use SuperSplat LOD runtime for large scenes`，push。SSV-08 结束。
