# SSV_05_REPORT：Experience Settings v2 Integration

- 日期：2026-09-28
- 阶段：SSV-05 — Experience Settings
- 前置：`docs/reports/SSV_04_REPORT.md` RESULT = PASS ✓
- 分支：`main`
- 锁定版本：`@playcanvas/supersplat-viewer@1.35.0` + `playcanvas@2.22.4`（未升级）

---

## RESULT

**PASS**

Experience Settings v2 全链路落地（**Authoring UI → DB → Adapter → Viewer**）：
ScenePresentation 的渲染字段（initial camera / FOV / background color / skybox / tonemapping /
high precision / post effects）经官方 `defaultSettings()` + `validateSettings()` 唯一 runtime schema
映射进官方 `ExperienceSettings` v2。旧场景始终经由 default 产出合法 settings；编辑页预览已切到官方
SuperSplatRuntime，保存的 settings 刷新后保持，Desktop / XR 读取同一 descriptor（skybox 等两侧
构造性一致）。

---

## 一、官方 Schema 是唯一 Runtime Schema（version 2）

未新建 `ViewerSettingsV3` / `XRSettings` / `DesktopSettings`。唯一 schema 仍是官方：

```
ExperienceSettings { version: 2, tonemapping, highPrecisionRendering, soundUrl?,
                     background: { color, skyboxUrl? }, postEffectSettings, animTracks,
                     cameras: [{ initial: { position, target, fov } }], annotations, startMode }
```

前端 `buildExperienceSettings(descriptor)`（`experienceAdapter.ts`）始终从官方
`defaultSettings(fit)` 起底，再覆盖映射字段，末尾执行官方 `validateSettings(settings, { limits: true })`；
任何旧/残缺数据都不会产出非法 settings。

## 二、ScenePresentation → Settings v2 映射

| ScenePresentation 字段 | 官方 ExperienceSettings v2 | 说明 |
|---|---|---|
| `initialCameraPosition/Target/Fov` | `cameras[0].initial.{position,target,fov}` | 三字段齐备才映射；fov clamp 进 `CAMERA_FOV_RANGE`(10–120) |
| `backgroundColor` | `background.color`（0..1 归一化 RGB 三元组） | 存在时覆盖官方默认 `[0,0,0]` |
| equirectangular 全景资产 | `background.skyboxUrl` | `backgroundType=='equirectangular'` 且 url 存在 → 写入服务地址 |
| `tonemapping`（enum） | `tonemapping` | 未知/缺失留在官方默认 `'linear'` |
| `highPrecisionRendering` | `highPrecisionRendering` | 布尔直映 |
| `postEffects`（单一 JSONB） | `postEffectSettings` | 见下节 |

### Post Effects：单一结构化 JSONB + 明确 Pydantic schema

- **不拆十几个 DB 列**。新增**一个** `post_effects JSONB` 列（迁移 `c2d3e4f5a6b7`），文档形状即官方
  `postEffectSettings`：`sharpness / bloom / grading / vignette / fringing`，每 effect 独立 `enabled`。
- `apps/api/app/schemas/scene_presentation.py` 用明确 Pydantic schema 校验，**数值界与官方
  `POST_EFFECT_RANGES` 逐字段对齐**（本阶段核对官方运行时常量后修复过一次初稿偏差）：

| 字段 | 官方界 | 备注 |
|---|---|---|
| sharpness.amount | 0 – 1 | |
| bloom.intensity | 0 – 0.1 | blurLevel 1 – 16 |
| grading.brightness | 0 – 3 | contrast 0.5 – 1.5；saturation 0 – 2；tint 0..1 |
| vignette.intensity | 0 – 1 | inner/outer 0 – 3；curvature 0.01 – 10 |
| fringing.intensity | 0 – 100 | |

- 越界值在 API 边界 422 拒绝；正常保存后，runtime 归一化（`_post_effects_json`）会以官方默认补齐
  缺失 effect 字段并强制 `tint=[1,1,1]`；前端 adapter 再对每个数值 clamp 进 `POST_EFFECT_RANGES`
  —— 双保险保证 `validateSettings({limits:true})` 恒通过。

## 三、Authoring UI（场景编辑页，官方 runtime 实时预览）

- **预览 Viewer 迁移到官方 SuperSplatRuntime**（`SceneAuthoringPage.tsx`）：
  `resolveSceneRuntimeDescriptor → buildExperienceSettings → SuperSplatRuntime.create(mode='desktop')`，
  与 `/scene`、`/xr` 同一条链路，**不再经旧 fork Viewer 创建第二套预览**。`onLoaded` 后
  `frameScene()`（与 `/scene` 页一致）。
- 新增 **渲染（Experience Settings v2）面板**（`PostEffectsPanel.tsx`）：Tonemapping 下拉、高精度
  开关、五个 effect 的开关 + 参数滑块；滑块数值范围/步进直接读官方 `POST_EFFECT_RANGES`，释放时提交，
  避免拖拽期间反复重建。
- **实时预览 + 刷新后保持**：体验设置字段（初始视角/背景/tonemapping/high precision/post effects）
  每次保存成功 → `useSceneAuthoring.settingsRevision++` → 页面以最新官方 settings 重建预览 runtime
  （splat 同源 URL，浏览器缓存命中重载快）；保存即持久化，刷新后由后端重新下发。
- **Skybox**：复用既有 `BackgroundPanel` 等距柱状上传（jpg/png/webp，≤10MB），显示"已设置全景
  背景"状态；上传成功 `backgroundType='equirectangular'` → runtime descriptor 带 url → adapter 映射
  `settings.background.skyboxUrl`。
- 顺带修复两个**预存阻断 bug**（不修则编辑页实时预览/面板不可达）：
  1. `.gs-authoring` 布局无任何 CSS，预览容器高度 0 → 画布 0×0 → 永远黑屏（旧 fork Viewer 同样如此）；
     补 inline flex 布局 + 真实高度。
  2. `BackgroundMusicPanel` 误用 DOM 全局 `Text`（`<Text label="音量" />`），运行期抛
     *"Failed to construct 'Text'"* 使整个编辑页崩溃；改为 antd `Typography.Text`。

## 四、保存初始相机（经 SuperSplatRuntime 封装，页面不碰 PlayCanvas app）

- `SuperSplatRuntime` 新增封装方法（`getCameraPose / setCameraPose / pickWorldPosition / captureScreenshot`）：
  - `getCameraPose()`：position/fov 直接读引擎相机实体（`app.root.findByName('camera')`，官方固定命名）；
    target 沿真实 forward、深度取「相机→gsplat 包围盒中心」距离（等价官方 `calcFocusPoint` 语义；
    引擎不暴露内部 orbit distance，重建 distance 只影响重载后的 orbit 半径，视角方向完全一致）。
  - `setCameraPose()`：`position + lookAt(target) + fov(clamp)`，用于观察点定位。
  - 页面只调这些方法，`app` 不进组件。
- Debug 佐证：官方自身 `captureCameraState`（`window.getCameraState`，debug 面板曝光）也读
  position + 由内部 distance 重建 —— 我们没有更低层路径，方法语义一致且完全封装。

## 五、Skybox 真实验证（Desktop / XR 两侧一致）

- 生成**真实 2048×1024 等距柱状 PNG**（标准经纬棋盘/色带，非占位符），经
  `POST /presentation/background` 上传 → `backgroundType='equirectangular'` + assetId 落库。
- `GET /runtime` → `background.url = /api/v1/scenes/r-8c4e2264e86a/presentation/background`；
  服务端 `GET` 该 URL → **HTTP 200 image/png，2048×1024 像素，PNG 校验通过**。
- **Desktop/XR parity（构造性 + 实测定点）**：Desktop(`/scene`) 与 XR(`/xr`) 经**同一**
  `resolveSceneRuntimeDescriptor` + `buildExperienceSettings`（SSV-04 已证两页同 contentUrl/settings），
  因此 skybox url 在 settings v2 中两侧必然一致；本阶段再用真实描述做实跑断言（见第八节）。
- 浏览器真实渲染：Playwright headless + SwiftShader，`/model/edit/r-8c4e2264e86a` 预览区经
  `frameScene` 后**真实渲染出该场景 splat**；无法在无头环境断言像素级天空贴图颜色，留待
  SSV-10 生产验收（诚实声明，不伪称）。

## 六、默认值（旧场景恒合法）

- 数据库列默认：`tonemapping='aces'`（迁移 server_default）、`high_precision_rendering=false`、
  `post_effects=NULL`。旧场景 → runtime descriptor 带 `tonemapping:'aces'`、`postEffects:null`。
- adapter 对 `postEffects:null` / 未知 tonemapping / 缺失 camera 一律落在 `defaultSettings()`，
  最终 `validateSettings({limits:true})` 不抛错（单元测试 + 真实场景实测）。
- 说明（有意为之）：旧场景显示为 GSPlatform 既定曲线 `aces`（合法值）；未作者化的全新场景仍是官方
  默认 `linear`。

## 七、测试

### 单元 / 集成（vitest，web 全量 **173 passed**）

- **Experience Adapter v2**（`super-splat-runtime.test.ts` 新增 6 项）：产物过官方
  validateSettings(limits)；tonemapping/highPrecision/postEffects/skybox 完整映射；越界数值全部
  clamp 到官方 `POST_EFFECT_RANGES` 边界（amount→1、bloom→0.1/16、grading→3/0.5/2、tint→[1,1,1]、
  vignette→1/3/0/0.01、fringing→100）；旧场景（null postEffects/未知 tonemapping）→ 官方默认；
  非 equirectangular 不写 skyboxUrl。
- **SuperSplatRuntime 相机/截图/拾取封装**（新增 7 项）：`getCameraPose` 读实体 position/fov +
  forward×bbox 中心深度 target；实体缺失 → null；fov clamp；`setCameraPose` 摆放+clamp；
  `pickWorldPosition` 中心 NDC → 相机正前方焦点；`captureScreenshot` 未 loaded 不调官方
  captureFrame；官方 RGBA base64 → 浏览器可解码 dataURL（并转发尺寸/supersample）。
- **后端（122 passed）**：`TestExperienceSettings` 6 项 —— 旧场景默认、DB 序列化（neutral/high
  precision/完整 post_effects 含 blurLevel 浮点规范化）、部分文档归一化（vignette-only）、PATCH
  保存+重载（hejl/bloom）、非法 tonemapping→422、越界→422。

### 真实场景（API 级 + 浏览器级，场景 `r-8c4e2264e86a`）

1. **保存/重载往返**：PATCH tonemapping=hejl + highPrecision=true + 完整 postEffects → GET /runtime
   原样返回（tint 归一化为 [1,1,1]、缺失 effect 补官方默认）。
2. **旧场景**：初始（无任何 settings）→ descriptor 带 aces/false/null，用法合法。
3. **Skybox**：上传真实全景 PNG → descriptor url → 服务 HTTP 200 真 PNG（见第五节）。
4. **描述→官方 settings 实跑**：临时 vitest 拉取真实 `/runtime`，`buildExperienceSettings` 产物过
   官方 validateSettings(limits) 且 skyboxUrl/tonemapping/postEffects 与描述一致（验证后删除）。
5. **浏览器渲染**：Playwright headless + SwiftShader，`/scene/r-8c4e2264e86a` 加载真场景
   （Loaded，WebGPU-SwiftShader）；`/model/edit/r-8c4e2264e86a` 官方 runtime 就绪 + 「渲染
   （Experience Settings v2）」面板 + 预览区真实渲染 splat。截图 + Agnes 识图确认（无错误遮罩）。
   存证：`/tmp/ssv05/scene-r8c4.png`、`/tmp/ssv05/authoring-frame.png`。
6. 测试后已将场景设置还原（tonemapping=aces / highPrecision=false / 全 effect 关闭 /
   backgroundType=color）。

### 质量门禁

- web 全量：**173 passed**（15 文件；SSV-04 161 → 新增 adapter/runtime 封装测试）
- `lint`：0 error（新文件 0 warning）
- `typecheck`：**10**（≤ SSV-00 基线 13 且全部位于未触碰历史文件；本阶段新文件 0；顺带消除
  BackgroundMusicPanel 2 个 Text 崩溃相关错误）
- `npx vite build`：**PASS**
- `pnpm --filter @gsplatform/viewer build`：**PASS**（FROZEN 包保持可构建）
- `apps/api`：**122 passed**，`alembic heads = c2d3e4f5a6b7`（SSV-05 迁移为 head）

## 八、已知差异 / 后续

- 实时预览采用「保存成功后按最新 settings 重建 runtime」；官方 viewer 无运行期 settings 热更 API，
  重建是唯一忠实方式（splat 同源缓存，编辑器场景可接受）。单个 effect 滑块在释放时才提交。
- 全景天空贴图在无头 SwiftShader 下无法像素级比对（反照率/米白色场景上肉眼接近），视觉验收
  留待 SSV-10；Desktop/XR 数据一致性已由同一 descriptor + 实测描述映射保证。
- 编辑器内的标签拾取（`pickWorldPosition`）为「相机射线 × 场景包围盒深度」近似，非 GPU 级表面
  拾取；SSV-06 标注迁移按需增强。

## NEXT PHASE

**SSV-06 — Annotation / Media / Audio**（Annotation runtime、Media、Background Audio 迁移到官方
runtime）。顺序见 `docs/SSV_MIGRATION_PLAN.md`。