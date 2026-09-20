# Phase 11：Spatial Annotation & Media

## 阶段目标

实现基于真实 Gaussian 表面的空间注解系统，支持用户双击场景位置创建三维热点，并配置：

```text
线段 + 文字
数字 + 点击文字
隐藏标记
```

内容类型支持：

```text
文字
图片
视频
音频
全景照片
```

同时支持场景背景音乐。

本阶段不实现碰撞和 XR。

## 前置条件

- [ ] Phase 10 `PASS`。
- [ ] World Transform 已稳定。
- [ ] Asset Upload 可复用。
- [ ] Viewer 可以返回拾取点世界坐标。

## 禁止事项

- 禁止用屏幕二维坐标保存注解。
- 禁止把注解 position 绑定原始 Canvas pixel。
- 禁止另外创建一套图片/视频上传系统。
- 禁止让背景音乐绕过浏览器 autoplay 限制。
- 禁止把 Annotation 当 Viewpoint。

## 纯文本架构草图

```text
Double Click
     |
     v
Gaussian Picker
     |
     v
World Position
     |
     v
SceneAnnotation
     |
+----+-------------------+
| style                  |
| content type           |
| media                  |
| title / description    |
+------------------------+
```

## 详细 Checklist

### A. Gaussian Picking

- [ ] 双击 Canvas 获取真实 3D 点。
- [ ] 无命中时不给出假坐标。
- [ ] 坐标使用统一 World Coordinate。
- [ ] World Transform 改变后 annotation 仍正确。
- [ ] annotation anchor 不依赖 camera。

### B. 注解样式

- [ ] `LEADER_TEXT`
- [ ] `NUMBER_POPUP`
- [ ] `HIDDEN`
- [ ] 文本颜色。
- [ ] 文本字号。
- [ ] FOV / 可见距离。
- [ ] 注解列表与场景状态同步。

### C. 内容类型

- [ ] TEXT。
- [ ] IMAGE。
- [ ] VIDEO。
- [ ] AUDIO。
- [ ] PANORAMA。
- [ ] 每种类型有严格 DTO。

### D. 编辑

- [ ] 标题。
- [ ] 内容。
- [ ] 样式。
- [ ] 删除。
- [ ] 排序。
- [ ] 重新拾取 anchor。
- [ ] 保存后刷新恢复。

### E. 背景音乐

- [ ] 上传 Audio Asset。
- [ ] volume。
- [ ] loop。
- [ ] enable / disable。
- [ ] 用户首次交互后开始播放。
- [ ] 页面销毁时停止并释放 Audio。

## 数据模型

```text
SceneAnnotation

id
scene_id
title
anchor_x/y/z
style
content_type
text_content
media_asset_id
text_color
text_size
fov
order_index
enabled
```

ScenePresentation 增加：

```text
background_audio_asset_id
background_audio_volume
background_audio_loop
```

## 验收标准

Building 场景创建：

```text
2 x 线段文字
2 x 数字热点
1 x 隐藏热点
```

至少覆盖：

```text
Text
Image
Video
Audio
Panorama
```

刷新、发布 Viewer 后全部正确。

---
