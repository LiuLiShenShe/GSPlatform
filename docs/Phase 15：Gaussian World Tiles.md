# Phase 15：Gaussian World Tiles

## 阶段目标

把“一个 Scene = 一个 Gaussian”升级为：

```text
一个 World = 多个可独立管理的 Gaussian Tile
```

为后续农业局部更新建立数据底座。

本阶段只建立 Tile 数据架构，不做自动重建。

## 前置条件

- [ ] Phase 14 `PASS`。
- [ ] Desktop / XR 均支持多个 Gaussian Component。
- [ ] Scene Experience Manifest 稳定。

## 重要定义

一定区分：

```text
Render Chunk
!=
Digital Twin Tile
```

Chunk 是 Streaming / LOD 技术概念。

Tile 是：

```text
Building
Road
Wheat_A
Wheat_B
Greenhouse
```

这种具有业务和版本语义的区域。

## 数据模型

```text
SceneTile

id
scene_id
name
role
bounds
transform
current_version_id
enabled
```

```text
TileVersion

id
tile_id
version
asset_id
created_at
status
metadata
```

role：

```text
STATIC
PERIODIC
DYNAMIC_BACKGROUND
```

## World Manifest

```json
{
  "worldId": "agri_01",
  "revision": 1,
  "tiles": [
    {
      "id": "building",
      "version": "base",
      "assetUrl": "..."
    },
    {
      "id": "wheat_a",
      "version": "T0",
      "assetUrl": "..."
    }
  ]
}
```

## Checklist

- [ ] Multi-Tile Desktop。
- [ ] Multi-Tile XR。
- [ ] independent Transform。
- [ ] independent enable。
- [ ] bounds。
- [ ] manifest。
- [ ] API。
- [ ] version reference。
- [ ] failure isolation。
- [ ] one Tile asset failure 不导致整个世界挂掉。

## PASS

至少同时加载 4 个 Tile。

关闭任意一个：

```text
其他 3 个位置
Transform
版本
状态
```

完全不变。

---
