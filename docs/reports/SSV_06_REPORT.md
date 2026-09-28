# SSV_06_REPORT：Annotations, Media Extensions and Audio

- 日期：2026-09-28
- 阶段：SSV-06 — Annotation / Media / Audio
- 前置：`docs/reports/SSV_05_REPORT.md` RESULT = PASS ✓
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（未升级）

---

## RESULT

**PASS**

标准 3D 标注交由官方 SuperSplat Viewer 处理（TEXT 直接显示在官方 annotation
panel，媒体标注使用官方 hotspot + camera navigation），GSPlatform 只扩展媒体：
IMAGE / VIDEO / AUDIO / PANORAMA 经 `extras` 固定协议映射，点击热点 →
GSPlatform React `AnnotationMediaOverlay`。背景音频走官方 `soundUrl`（唯一播放
来源，不建第二套音频）。**Viewer 内核零 fork**。

---

## 一、Annotation 映射（全部 → 官方 `ExperienceSettings.annotations[]`）

后端 runtime descriptor 的 `annotations[]`（`scene_runtime._build_annotations`）
在 SSV-06 起填充真实 `mediaAssetUrl`；前端 adapter（`experienceAdapter.ts`
`buildAnnotations`）把每条 annotation 映射为官方 `Annotation`：

| 官方字段 | 来源 | 说明 |
|---|---|---|
| `position` | `anchor.{x,y,z}` | Gaussian 锚点 |
| `title` | `title` | HTML sanitize + 截断进 `ANNOTATION_LIMITS.titleMax`(60) |
| `text` | `textContent` | HTML sanitize + 截断进 `textMax`(280)；默认空串 |
| `extras` | 固定协议 | `{ gsplatform: { annotationId, contentType } }` |
| `camera` | 场景初始相机 | 复用 `settings.cameras[0].initial` 构图，fov 用标注自身值（clamp） |

约束落实：

- **enabled 过滤 + 数量 cap**：`filter(enabled !== false)` + `slice(0, maxCount)`(25)。
- **HTML sanitize（三）**：`sanitizeAnnotationText` 剥离 `<script>/<style>/<!-- -->/标签`，
  官方 tooltip 本身用 `textContent`，双保险后 TEXT 内容到渲染层不可能执行 HTML。
- **extras 协议（二）**：`annotationId` 是数据库 UUID；页面（Desktop/XR/Authoring）
  一律经 `extras.gsplatform.annotationId` 解析，**不用官方数组 index 当 DB ID**
  （index 仅用于事件定位）。

## 二、官方 hotspot + camera navigation（四）

- 关键发现：官方 annotation hotspots / tooltip（`Annotations` 类）只在官方 UI 层
  （`initUI`，`config.ui === true`）内构建 —— SSV-05 硬编码 `ui:false` 时热点层
  根本不存在。SSV-06 为 `SuperSplatRuntime` 增加 opt-in `ui` 选项，Desktop/XR/
  Authoring 全部开启。
- 开启 `ui:true` 后官方会把控件栏/海报/加载条/annotation 导航/设置面板全部注入，
  与宿主自绘 UI 重复。本层注入**作用域 CSS**（容器 class `gs-supersplat-host` +
  `display:none` 隐藏 `.sse-ui`），**只保留 `.sse-sceneLayer`（热点 + tooltip）与
  canvas** —— 不 fork viewer，也不暴露重复官方 chrome。
- 点击热点 → 官方 `selectAnnotation(i)` → `state.selectedAnnotation`（触发
  `selectedAnnotation:changed`）+ 官方 `cameraManager.selectAnnotation` 相机过渡
  （官方 camera navigation，保持启用）。
- `SuperSplatRuntime.selectedGsplatformAnnotation` getter 读取
  `annotations[index].extras.gsplatform.annotationId`；Desktop/XR hook 订阅
  `onSelectedAnnotationChanged` 并对外暴露引用。

## 三、AnnotationMediaOverlay（五）

`apps/web/src/features/viewer-official/AnnotationMediaOverlay.tsx` 统一组件：

- 数据源：选中引用 → `descriptor.annotations.find(id === annotationId)` → 取
  `mediaAssetUrl`（经 `resolveRuntimeAssetUrl` 解析为绝对 URL）/title/description。
- IMAGE / PANORAMA → `<img>`（PANORAMA 显示"360° 全景"徽标）；VIDEO → `<video
  controls autoplay muted>`；AUDIO → `<audio controls autoplay>`。
- **关闭不删 selection**：Overlay 只在页面本地 `overlayOpen` 关闭，不清空官方
  selection（不调 `clearAnnotation`）；官方选中态（`.sse-active` 热点）保留。
- **切换自动更新**：`selectedGsplatformAnnotation` 变化 → 页面重渲染，组件按
  `annotationId` 重新解析（`data-content-type` 切换），测试覆盖 VIDEO→AUDIO→PANORAMA。
- TEXT 不经过 Overlay（官方 panel 直接显示，见三）。

## 四、Background Audio → soundUrl（六）

- `buildExperienceSettings`：`backgroundAudio.enabled && url` → `settings.soundUrl`
  （经 `resolveRuntimeAssetUrl` 解析为绝对 URL，开发跨源时相对路径会 404）。
- **唯一播放来源**：官方 viewer 内部 `new Audio(soundUrl)` + 一次性根点击解锁
  （autoplay-policy 合规，不绕过浏览器权限）；GSPlatform **不再创建第二套**同时
  播放的 background audio。浏览器实测 patch `window.Audio`：只实例化 **1 个**
  Audio，src 指向 `/api/v1/scenes/r-8c4e2264e86a/presentation/background-audio`。
- 说明：官方 soundUrl 不支持 volume/loop 控制（无官方 API），GSPlatform 的
  volume/loop 字段留作播放策略未来接入，不在本阶段伪造音量实现。

## 五、Annotation Authoring（七）

- 现有创建 UI 保留；预览 viewer 开启 `ui:true` → 官方 hotspot 出现。
- 创建流程：`pickWorldPosition` 点击 Gaussian 世界位置 → 保存 SceneAnnotation →
  `annotationRevision++` → 预览 runtime 用最新 descriptor 重建 → 官方 annotation
  出现（浏览器实测 authoring 预览 5 个官方热点，`.sse-ui` 隐藏）。
- 更新/删除同样递增 `annotationRevision` 重建预览。

## 六、后端媒体上传 / 服务（支撑）

- `AssetKind.ANNOTATION_MEDIA` 新增；`AuthoringService.set_annotation_media` /
  `serve_annotation_media`：按 content_type 白名单（IMAGE/PANORAMA: jpg/png/webp，
  VIDEO: mp4/webm/quicktime，AUDIO: mp3/wav/ogg/mp4/aac），50MB 上限，storage key
  `annotations/{scene_id}/{annotation_id}`（重传即替换），TEXT 拒绝上传。
- 路由：`POST/GET /{slug}/annotations/{annotation_id}/media`（写需 CSRF，读公开）。
- `scene_runtime._build_annotations` 填充 `mediaAssetUrl`（enabled 时）。

## 七、测试

### 单元 / 集成（vitest，web 全量 **189 passed**）

- **Adapter（super-splat-runtime.test.ts 新增）**：annotations→官方（extras 协议 /
  position / camera.fov clamp）；HTML sanitize（脚本/标签剥离）；title/text 截断进
  ANNOTATION_LIMITS；disabled 过滤 + 数量 cap 25；backgroundAudio enabled→soundUrl
  （绝对 URL），禁用/无 url → 不写。
- **Runtime（新增）**：`ui:true` 透传官方 + 容器 `gs-supersplat-host` class +
  scoped CSS 注入（.sse-ui 隐藏 / .sse-sceneLayer 保留）；`selectedGsplatformAnnotation`
  读取 extras（含非 GSPlatform 标注 → null、清选 → null）。
- **Overlay 组件（annotation-media-overlay.test.tsx 新增 7 项）**：IMAGE img + 绝对
  src；VIDEO/AUDIO 元素；PANORAMA 徽标；TEXT 不渲染；null 不渲染；关闭回调；缺媒体提示。
- **后端（apps/api 129 passed）**：`TestAnnotationMedia` 7 项 —— 上传+serve 字节一致
  + runtime descriptor mediaAssetUrl；重传替换 asset；VIDEO 接受；MIME 不匹配 409；
  TEXT 拒绝 409；超 50MB 422；无媒体 404。`ruff` clean。
- 前置门禁：`pnpm test` 189 passed、`pnpm lint` 0 error、`npx vite build` PASS、
  `pnpm --filter @gsplatform/viewer build` PASS、API `python -m pytest` 129 passed、
  `alembic heads = c2d3e4f5a6b7`（无新迁移；`AssetKind` 是 String(30) 列值，无 DDL）。

### 真实场景（浏览器级，场景 `r-8c4e2264e86a`，Playwright + SwiftShader）

1. **5 种真实 annotation**：TEXT（含 `<script>/<em>` 注入文本）、IMAGE（真实
   640×360 PNG）、VIDEO（ffmpeg 640×360 MP4）、AUDIO（ffmpeg WAV）、PANORAMA
   （真实 2048×1024 等距 PNG）—— 全部经 API 创建 + `POST /annotations/{id}/media`
   上传；`GET .../media` 逐一返回 **HTTP 200 且字节与原文件一致**（cmp 通过）。
2. **Desktop**：官方 5 热点可见；`.sse-ui` 隐藏（官方 chrome 不重复）；TEXT 热点 →
   官方 tooltip 直接显示 **sanitize 后正文**（无媒体 Overlay）；IMAGE 热点 → Overlay
   打开且 `data-content-type=IMAGE`、图片加载；关闭 Overlay → 官方选中态 `.sse-active`
   仍保留（关闭不清 selection）；再点另一热点（AUDIO）→ Overlay 重新打开并更新。
3. **切换标注自动更新**：VIDEO → AUDIO → PANORAMA 逐一自动更新 Overlay 内容。
4. **XR**：`/xr/r-8c4e2264e86a` 同样 5 热点、state.loaded 后点 IMAGE → Overlay 渲染。
5. **Authoring**：`/model/edit/r-8c4e2264e86a` 预览区官方 5 热点 + chrome 隐藏。
6. **Background audio**：patch `window.Audio` 断言官方只创建 1 个 Audio 实例，src
   为背景音频 URL（官方 soundUrl 能力 + autoplay 解锁策略）。
7. 截图存证（Agnes 识图确认，无错误遮罩）：
   `/tmp/ssv06/desktop-hotspots.png`、`/tmp/ssv06/desktop-image-overlay.png`、
   `/tmp/ssv06/desktop-panorama-overlay.png`。
8. e2e 回归规格：`e2e/ssv06-media.spec.ts`（Desktop/XR/切换/关闭保持选择）、
   `e2e/ssv06-authoring.spec.ts`、`e2e/ssv06-audio.spec.ts` —— 全部 PASS。

### 质量门禁（SSV-06 增量）

- web 全量：**189 passed**（16 文件；SSV-05 173 → 新增 adapter/runtime/overlay 测试）
- `lint`：0 error（新文件 0 warning）
- `typecheck`：**10**（= SSV-05 基线，全部位于未触碰历史文件；本阶段新文件 0）
- `npx vite build`：**PASS**；`pnpm --filter @gsplatform/viewer build`：**PASS**
- `apps/api`：**129 passed**，ruff clean

## 八、已知差异 / 后续

- 官方 hotspot 点击对**同一个已选热点**再次点击不会重发 `selectedAnnotation:changed`
  （官方 Observable 仅值变化发事件）；因此"关闭 Overlay 后重开同一标注"需点另一热点
  或先清选。此行为属官方 viewer 语义，GSPlatform 不 fork 干预；关闭 Overlay 不清除
  selection 的要求已满足（选中态保留）。
- 官方 soundUrl 无 volume/loop API，GSPlatform volume/loop 字段暂不生效（如实记录，
  未伪造音量）。
- 遗留 e2e（`progressive-loading.spec.ts` / `streamed-sog.spec.ts`）引用旧 fork
  Viewer 的 test id（`progressive-overlay`/`viewer-canvas-host`），SSV-03 起默认走
  官方 runtime 后已失效 —— 与 SSV-06 无关，属 SSV-09 清理范围，本阶段不触碰。

## NEXT PHASE

**SSV-07 — Collision / Walk**（碰撞网格 runtime、walk/teleport 迁移到官方 runtime）。
顺序见 `docs/SSV_MIGRATION_PLAN.md`。
