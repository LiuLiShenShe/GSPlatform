# Phase 12：Walkable Collision

## 阶段目标

建立 Gaussian 场景的隐藏碰撞代理，使用户能够在视觉仍由 Gaussian 渲染的情况下获得：

- 地面高度；
- 重力；
- 不穿地；
- 不穿主要建筑；
- 台阶；
- 坡度限制；
- 室内 / 户外两类碰撞模式。

本阶段只构建物理代理，不实现 WebXR。

## 前置条件

- [ ] Phase 11 `PASS`。
- [ ] World Transform 不再随意改变。
- [ ] 重建任务可访问必要的点云 / camera / depth 数据。
- [ ] Asset 系统支持 GLB。

## 禁止事项

- 禁止把 Gaussian 本身直接当 Triangle Mesh Collider。
- 禁止把视觉 splat 简单转换成数百万三角形然后全部碰撞。
- 禁止宣称任意外部 SOG 都能完美恢复室内碰撞。
- 禁止碰撞 Mesh 直接可见。

## 两种模式

```text
INDOOR
OUTDOOR
```

### Outdoor

目标：

```text
农业园区
停车场
道路
大田
```

流程：

```text
Gaussian means
   ↓
filter
   ↓
voxel downsample
   ↓
ground extraction
   ↓
terrain / mesh
   ↓
simplification
   ↓
collision.glb
```

### Indoor

优先：

```text
camera + depth
   ↓
TSDF / fusion
   ↓
mesh
   ↓
simplify
   ↓
collision.glb
```

外部只有 SOG 时允许：

```text
Upload Collision GLB
```

## Checklist

- [ ] Outdoor build job。
- [ ] Indoor build job。
- [ ] CollisionAsset 数据模型。
- [ ] Celery job 状态。
- [ ] Viewer 加载 invisible collision。
- [ ] gravity。
- [ ] slope limit。
- [ ] step offset。
- [ ] player height。
- [ ] build failure 可恢复。
- [ ] collision 可重建。

## PASS

Building / outdoor 场景分别至少验证一种：

```text
地面正常
不能掉地下
主要障碍不能穿
不卡死
不影响 Gaussian 渲染
```

---
