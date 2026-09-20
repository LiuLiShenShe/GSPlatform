# Phase 10：Scene Authoring Core

## 阶段目标

在现有上传、发布和 Scene Viewer 基础上建立平台自有的场景创作能力，使用户能够在真实 SOG / Streamed SOG 场景中完成：

- 上传后预览；
- 调整世界朝向；
- 设置初始观察位置；
- 设置 FOV；
- 保存多个固定观察点；
- 将当前画面设置为封面；
- 上传自定义封面；
- 设置背景颜色；
- 设置全景天空盒；
- 保存场景表现配置并在发布 Viewer 中恢复。

本阶段解决“场景怎么被布置和展示”，不实现空间注解、媒体热点、碰撞或 XR。

## 前置条件

- [ ] `docs/reports/PHASE_09_REPORT.md` 存在且状态为 `PASS`，或已有批准的 dependency override ADR。
- [ ] 现有 Scene、SceneVersion、Asset 数据模型稳定。
- [ ] `/upload`、`/model/edit/:id`、`/scene/:id` 可正常访问。
- [ ] ViewerAdapter 已支持读取和设置相机位姿。
- [ ] 测试 SOG 场景来源和 SHA-256 可追踪。
- [ ] 已记录 Phase 10 开始前 commit。

## 禁止事项

- 禁止直接修改原始 Gaussian 文件来保存世界朝向。
- 禁止把封面截图当作真实 Viewer 内容。
- 禁止把 Viewpoint 和 Annotation 混成同一数据类型。
- 禁止复制第三方平台 Logo、品牌、图标组合或专有 UI。
- 禁止把 Phase 11 注解功能提前塞入本阶段。
- 禁止修改 `apps/viewer` 的 Gaussian renderer。
- 禁止自动 push。

## 纯文本架构草图

```text
/model/edit/:sceneId
        |
        v
+------------------------------+
| Scene Authoring Page         |
| - Initial View               |
| - World Transform            |
| - Cover                      |
| - Background                 |
| - Viewpoints                 |
+---------------+--------------+
                |
                v
+------------------------------+
| Scene Presentation API       |
| initial camera / FOV         |
| transform / cover / bg       |
| viewpoints                   |
+---------------+--------------+
                |
                v
+------------------------------+
| Scene / SceneVersion         |
| ScenePresentation            |
| SceneViewpoint[]             |
+------------------------------+
```

## 详细 Checklist

### A. 上传预览

- [x] SOG 上传完成后可直接进入真实 Viewer 预览。
- [x] 预览使用已经上传的 Asset，不重新上传文件。
- [x] 预览支持 Orbit / Fly。
- [x] 可读取当前 camera pose。
- [x] 点击”设为初始视角”保存 position / target / FOV。
- [x] 页面刷新后初始视角完全恢复。

### B. 世界方向

- [x] Viewer 中增加 World Root。
- [x] 支持 rotation 调整。
- [x] 支持必要的 uniform scale。
- [x] 支持 position correction。
- [x] 保存后不修改原始 SOG。
- [x] Desktop Viewer 重载后恢复同一 World Transform。

### C. 初始视角与 FOV

- [x] 支持 position。
- [x] 支持 target。
- [x] 支持 FOV。
- [x] FOV 有合理 min/max。
- [x] Reset Camera 使用持久化初始视角。
- [x] 初始视角与 Viewer 自动取景有明确优先级。

### D. 固定观察点

- [x] 支持新增 Viewpoint。
- [x] 支持删除。
- [x] 支持重命名。
- [x] 支持排序。
- [x] 支持把当前相机保存为 Viewpoint。
- [ ] Previous / Next 能依顺序切换。
- [x] Viewpoint 与 Initial View 数据独立。

### E. 封面

- [x] 上传 JPG / PNG。
- [x] 将当前 Viewer 画面截图设为封面。
- [x] 封面进入现有 Asset 生命周期。
- [x] 替换封面不会残留孤儿资产。
- [ ] 卡片页和详情页正确显示封面。

### F. 背景

- [x] 支持纯色背景。
- [x] 支持 Equirectangular Panorama。
- [x] 全景文件进入 Asset 管理。
- [x] 保存经纬度元数据的接口预留。
- [ ] Scene Viewer 正确恢复背景。

## 实现细节

建议增加：

```text
ScenePresentation

scene_id
world_position
world_rotation
world_scale
initial_camera_position
initial_camera_target
initial_camera_fov
background_type
background_color
background_asset_id
cover_asset_id
```

Viewpoint 独立：

```text
SceneViewpoint

id
scene_id
name
position
target
fov
order_index
enabled
```

不要写成：

```text
annotations[] + type=viewpoint
```

这是不同概念。

## 关键目录 / 文件

```text
apps/web/src/features/authoring/
|-- InitialViewPanel.tsx
|-- WorldTransformPanel.tsx
|-- CoverPanel.tsx
|-- BackgroundPanel.tsx
|-- ViewpointPanel.tsx
`-- useSceneAuthoring.ts

apps/api/
|-- models/scene_presentation.py
|-- models/scene_viewpoint.py
|-- routes/scene_presentation.py
`-- schemas/scene_presentation.py

apps/viewer/src/platform/
|-- ViewerAdapter.ts
`-- CameraPose.ts
```

## 验收标准

使用 Mill19 Building SOG：

```text
加载
→ 调整世界方向
→ 设置初始视角
→ FOV=指定值
→ 新建 5 个 Viewpoint
→ 设置封面
→ 设置背景
→ 保存
→ 刷新
```

所有状态恢复。

## 必须产物

- ScenePresentation 数据模型。
- SceneViewpoint 数据模型。
- 场景创作编辑页。
- Initial View / World Transform / Cover / Background / Viewpoints。
- `docs/reports/PHASE_10_REPORT.md`。
- Phase 10 独立 commit。
- 不 push。

---